import {
  SEAT_CATEGORY_LABELS,
  SEAT_PROBLEM_MESSAGES,
  ancillarySlotId,
  formatFlightNumber,
  seatProblem,
  slotLabel,
  totalSeated,
  type AncillaryPurchase,
  type AncillarySelection,
  type ApiErrorCode,
  type FinancialAdjustment,
  type JourneyDirection,
  type OrderAncillaries,
  type OrderItem,
  type OrderJourney,
  type SeatAssignment,
  type SeatChange,
  type SeatMap,
  type ServicingOperation,
  type ServicingQuote,
  type ServicingQuoteLine,
} from '@velasia/contracts';
import {
  ancillaryOffers,
  baggageAllowances,
  mealServiceFor,
  offerIndex,
  seatPrice,
  seatTravellers,
} from '../booking/booking';
import { buildSeatMap, seatOn } from '../booking/seat-map';
import type {
  StoredAllocation,
  StoredClaimAllocation,
  StoredCurrent,
  StoredOrder,
  StoredPlan,
  StoredServicingRequest,
} from '../db/schema';
import { ANCILLARIES_BY_ID, ANCILLARY_CATALOGUE_VERSION } from '../fixtures/ancillaries';
import type { FlightInstance, Inventory } from '../inventory/inventory';
import type { AllocationLedger } from '../inventory/ledger';
import { createOffer, familyEligibility, type PricingContext } from '../offers/offer-engine';
import type { RetailingFailure } from '../offers/retailing-service';
import { formatPesos } from '../orders/format';
import { PRICING_CURRENCY } from '../pricing/pricing';
import { SALES_CUTOFF_MINUTES } from '../search/flight-search';
import type { Candidate } from '../search/itineraries';
import { MIN_STAY_MINUTES } from '../services/flights';
import { legFor, type OrderLeg, type OrderTrip } from './order-trip';

/*
 * Servicing prices (Milestone 6). Pure functions of a booking, the live inventory, and the
 * clock: every amount a traveller is asked to pay, or told they'll get back, is computed here,
 * from the booking's own items and the M3/M4 pricing rules. Nothing comes from the request.
 *
 * The fictional policy, in short (docs/ARCHITECTURE.md, "Change pricing"):
 *
 * - Change flight: the fare family is kept. You pay the new fare, minus the value of the fare
 *   you hold, minus what you paid for seats and meals on the flights you leave (they're
 *   released and credited), plus the family's change fee per traveller (lap infants exempt).
 *   More to pay is charged; less is refunded with refundable fares (Flex, Business) and kept as
 *   travel credit otherwise (Light, Classic). Extra baggage and priority stay with the trip.
 * - Seats and services: what was already paid for the same traveller and slot counts towards
 *   the new choice; a cheaper choice is never refunded. Nothing included is charged.
 * - Cancel: each direction is refunded by its family's rules (full, less a fee, or unused taxes
 *   only); paid extras are refunded unless the fare is Light; change fees are kept.
 *
 * Every quote is plain integers in minor units, and its lines add up to its net amount.
 */

/** Seat changes close with online sales. */
export const SEAT_CHANGE_CUTOFF_MINUTES = SALES_CUTOFF_MINUTES;
/** Post-booking services close this long before departure (fictional). */
export const ANCILLARY_CUTOFF_HOURS = { BAGGAGE: 3, PRIORITY: 3, MEAL: 24 } as const;
/** How long a quote's price is shown as current; confirmation re-prices anyway. */
export const QUOTE_VALIDITY_MS = 15 * 60_000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface QuoteContext {
  /** Real time: quote validity, claims and timestamps (see `clock.ts`). */
  now: number;
  /** Business time: change, cancel, seat and extras windows relative to departure. */
  businessNow: number;
  pricing: PricingContext;
  inventory: Inventory;
  seed: string;
  offerValidityMs: number;
}

export interface QuoteFailure {
  ok: false;
  status: RetailingFailure['status'];
  code: ApiErrorCode;
  message: string;
  path?: string;
}

const fail = (
  status: QuoteFailure['status'],
  code: ApiErrorCode,
  message: string,
  path?: string,
): QuoteFailure => ({ ok: false, status, code, message, path });

export const isQuoteFailure = (value: unknown): value is QuoteFailure =>
  typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;

/** A priced operation: what the traveller is shown, and what confirming it would write. */
export interface Computed<Q extends ServicingQuote = ServicingQuote> {
  quote: Q;
  request: StoredServicingRequest;
  /** For the history, without personal data. */
  summary: string;
  /** The booking after the change (`null` for a cancellation). */
  plan: StoredPlan | null;
  /** Inventory the change needs that the booking doesn't hold yet. */
  claim: StoredClaimAllocation[];
}

const passengersOf = (order: StoredOrder) => order.snapshot.search.passengers;
/** Fees are per traveller with a seat: lap infants are exempt (fictional). */
const feeTravellers = (order: StoredOrder) =>
  passengersOf(order).adults + passengersOf(order).children;

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const itemsTotal = (items: readonly OrderItem[]) => sum(items.map((item) => item.amountMinor));

const flightLabel = (segment: Pick<FlightInstance, 'schedule'>) =>
  `${segment.schedule.origin} → ${segment.schedule.destination} · ${formatFlightNumber(segment.schedule.flightNumber)}`;

const directionWord = (direction: JourneyDirection) =>
  direction === 'outbound' ? 'Departing' : 'Return';

function hoursText(minutes: number) {
  return minutes % 60 === 0
    ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}`
    : `${minutes} minutes`;
}

function adjustmentFor(net: number, refundable: boolean): FinancialAdjustment {
  if (net > 0) return { kind: 'CHARGE', amountMinor: net };
  if (net === 0) return { kind: 'NONE', amountMinor: 0 };
  return { kind: refundable ? 'REFUND' : 'CREDIT', amountMinor: -net };
}

function quoteOf(
  operation: ServicingOperation,
  order: StoredOrder,
  ctx: QuoteContext,
  lines: ServicingQuoteLine[],
  {
    priceDifferenceMinor = 0,
    refundable = false,
    notes = [] as string[],
    net,
  }: { priceDifferenceMinor?: number; refundable?: boolean; notes?: string[]; net?: number } = {},
): ServicingQuote {
  // Lines add up to the net amount, except for a cancellation, whose lines also show what is
  // kept (positive) next to what is refunded (negative); its net is the refund alone.
  const netMinor = net ?? sum(lines.map((line) => line.amountMinor));
  const adjustment = adjustmentFor(netMinor, refundable);
  const money =
    adjustment.kind === 'CHARGE'
      ? `You pay ${formatPesos(adjustment.amountMinor)} (simulated payment).`
      : adjustment.kind === 'REFUND'
        ? `${formatPesos(adjustment.amountMinor)} is refunded to your original payment (simulated refund).`
        : adjustment.kind === 'CREDIT'
          ? `${formatPesos(adjustment.amountMinor)} is kept as travel credit for a later booking (fictional, no money moves).`
          : 'There is nothing to pay and nothing to refund.';
  return {
    operation,
    status: 'QUOTED',
    orderRevision: order.rev,
    currency: order.currency,
    lines,
    netMinor,
    priceDifferenceMinor,
    adjustment,
    notes: [...notes, money],
    quotedAt: new Date(ctx.now).toISOString(),
    validUntil: new Date(ctx.now + QUOTE_VALIDITY_MS).toISOString(),
  };
}

/** Shared refusals: only a confirmed booking with nothing in progress can be changed. */
export function modifiable(order: StoredOrder): QuoteFailure | null {
  if (order.status === 'BOOKING_CANCELLED') {
    return fail(409, 'ORDER_NOT_MODIFIABLE', 'This booking was cancelled, so it can’t be changed.');
  }
  if (order.status !== 'CONFIRMED') {
    return fail(409, 'ORDER_NOT_MODIFIABLE', 'Only a confirmed booking can be changed.');
  }
  if (order.servicing.some((op) => op.status === 'AWAITING_PAYMENT')) {
    return fail(
      409,
      'PAYMENT_PENDING',
      'Another change to this booking is waiting for its payment. Finish or discard it first.',
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Change flight
// ---------------------------------------------------------------------------

/** Whether a direction can be changed now, and why not. */
export function changeAvailability(leg: OrderLeg, now: number) {
  const { change } = leg.family.rules;
  const closesAt = leg.departsAt - change.cutoffMinutes * MINUTE;
  if (!change.allowed) {
    return { allowed: false, reason: `${leg.family.name} fares can’t be changed.`, closesAt };
  }
  if (!leg.live || now >= leg.departsAt) {
    return { allowed: false, reason: 'This flight has already departed.', closesAt };
  }
  if (now >= closesAt) {
    return {
      allowed: false,
      reason: `Changes to ${leg.family.name} fares close ${hoursText(change.cutoffMinutes)} before departure.`,
      closesAt,
    };
  }
  return { allowed: true, reason: null, closesAt };
}

function fareItems(journey: OrderJourney, familyName: string, detail: string): OrderItem[] {
  const label = { adult: 'Adult', child: 'Child', infant: 'Infant' } as const;
  return journey.price.passengers.map((line) => ({
    id: `flight-${journey.direction}-${line.passengerType}`,
    kind: 'FLIGHT',
    label: `${familyName} · ${label[line.passengerType]}`,
    detail,
    direction: journey.direction,
    travellerId: null,
    flightId: null,
    productCode: journey.family,
    quantity: line.count,
    unitPriceMinor: line.unitTotalMinor,
    amountMinor: line.subtotalMinor,
    included: false,
  }));
}

export function quoteChange(
  order: StoredOrder,
  trip: OrderTrip,
  direction: JourneyDirection,
  candidate: Candidate,
  ctx: QuoteContext,
): QuoteFailure | Computed {
  const refused = modifiable(order);
  if (refused) return refused;
  const leg = trip.legs.find((candidateLeg) => candidateLeg.direction === direction);
  if (!leg) {
    return fail(
      422,
      'CHANGE_NOT_ALLOWED',
      'This booking has no return flight to change.',
      'direction',
    );
  }
  const availability = changeAvailability(leg, ctx.businessNow);
  if (!availability.allowed) return fail(409, 'CHANGE_NOT_ALLOWED', availability.reason!);
  const first = candidate.segments[0]!;
  const last = candidate.segments.at(-1)!;
  const { itinerary } = leg.journey;
  if (
    first.schedule.origin !== itinerary.origin ||
    last.schedule.destination !== itinerary.destination
  ) {
    return fail(
      422,
      'CHANGE_NOT_ALLOWED',
      'A change must keep the same origin and destination.',
      'itineraryId',
    );
  }
  if (candidate.id === itinerary.id) {
    return fail(422, 'CHANGE_NOT_ALLOWED', 'That is the flight you already have.', 'itineraryId');
  }
  const passengers = passengersOf(order);
  const eligibility = familyEligibility(candidate, leg.family, passengers, ctx.pricing);
  if (!eligibility.ok)
    return fail(409, 'INVENTORY_UNAVAILABLE', eligibility.message, 'itineraryId');

  // The trip must stay possible: the return leaves at least two hours after the outbound lands.
  const other = trip.legs.find((candidateLeg) => candidateLeg.direction !== direction);
  if (other) {
    const stay = MIN_STAY_MINUTES * MINUTE;
    const outboundLands =
      direction === 'outbound' ? last.arrivalUtc : Date.parse(other.journey.itinerary.arrival.at);
    const inboundLeaves = direction === 'inbound' ? first.departureUtc : other.departsAt;
    if (inboundLeaves < outboundLands + stay) {
      return fail(
        422,
        'CHANGE_NOT_ALLOWED',
        direction === 'outbound'
          ? 'Your departing flight must land at least 2 hours before your return flight leaves.'
          : 'Your return flight must leave at least 2 hours after your departing flight lands.',
        'itineraryId',
      );
    }
  }

  const offer = createOffer(candidate, leg.family, passengers, ctx.pricing, ctx.offerValidityMs);
  const oldIds = itinerary.segments.map((segment) => segment.id);
  const newIds = candidate.segments.map((segment) => segment.id);
  const removed = new Set(oldIds.filter((id) => !newIds.includes(id)));
  const added = newIds.filter((id) => !oldIds.includes(id));
  const { current } = order;
  const currentFareItems = current.items.filter(
    (item) => item.kind === 'FLIGHT' && item.direction === direction,
  );
  const currentFare = itemsTotal(currentFareItems);
  const released = current.items.filter(
    (item) =>
      (item.kind === 'SEAT' || item.kind === 'MEAL') &&
      item.flightId !== null &&
      removed.has(item.flightId),
  );
  const fee = leg.family.rules.change.feePerTravellerMinor * feeTravellers(order);
  const newFare = offer.price.totalMinor;
  const newLabel = candidate.segments.map(flightLabel).join(' + ');
  const oldNumbers = itinerary.segments
    .map((segment) => formatFlightNumber(segment.flightNumber))
    .join(' + ');
  const newNumbers = candidate.segments
    .map((segment) => formatFlightNumber(segment.schedule.flightNumber))
    .join(' + ');

  const lines: ServicingQuoteLine[] = [
    {
      kind: 'NEW_FARE',
      label: `New fare · ${leg.family.name}`,
      detail: newLabel,
      amountMinor: newFare,
    },
    {
      kind: 'CURRENT_FARE',
      label: `Your current fare · ${leg.family.name}`,
      detail: itinerary.segments
        .map(
          (segment) =>
            `${segment.departure.airport} → ${segment.arrival.airport} · ${formatFlightNumber(segment.flightNumber)}`,
        )
        .join(' + '),
      amountMinor: -currentFare,
    },
    ...released
      .filter((item) => item.amountMinor > 0)
      .map((item) => ({
        kind: 'RELEASED_EXTRA' as const,
        label: `${item.label} (released)`,
        detail: item.detail,
        amountMinor: -item.amountMinor,
      })),
  ];
  if (fee > 0) {
    lines.push({
      kind: 'CHANGE_FEE',
      label: `Change fee · ${leg.family.name}`,
      detail: `${formatPesos(leg.family.rules.change.feePerTravellerMinor)} × ${feeTravellers(order)} traveller${feeTravellers(order) === 1 ? '' : 's'}`,
      amountMinor: fee,
    });
  }

  const newJourney: OrderJourney = {
    direction,
    offerId: offer.id,
    family: leg.family.code,
    familyName: leg.family.name,
    cabin: leg.family.cabin,
    itinerary: offer.itinerary,
    services: leg.family.services,
    price: offer.price,
  };
  const version = current.version + 1;
  const items: OrderItem[] = [
    ...current.items.filter((item) => !currentFareItems.includes(item) && !released.includes(item)),
    ...fareItems(newJourney, leg.family.name, newLabel),
  ];
  if (fee > 0) {
    items.push({
      id: `fee-${direction}-v${version}`,
      kind: 'CHANGE_FEE',
      label: `Change fee · ${leg.family.name}`,
      detail: `${directionWord(direction)} flight changed to ${newNumbers}`,
      direction,
      travellerId: null,
      flightId: null,
      productCode: leg.family.code,
      quantity: feeTravellers(order),
      unitPriceMinor: leg.family.rules.change.feePerTravellerMinor,
      amountMinor: fee,
      included: false,
    });
  }
  const next: StoredCurrent = {
    version,
    journeys: current.journeys.map((journey) =>
      journey.direction === direction ? newJourney : journey,
    ),
    seats: current.seats.filter((seat) => !removed.has(seat.flightId)),
    ancillaries: current.ancillaries.filter(
      (selection) =>
        !(selection.category === 'MEAL' && selection.flightId && removed.has(selection.flightId)),
    ),
    baggage: current.baggage,
    items,
  };
  const seats = totalSeated(passengers);
  const claim: StoredClaimAllocation[] = added.map((flightId) => ({
    flightId,
    cabin: leg.family.cabin,
    seats,
    seatIds: [],
  }));
  const allocations: StoredAllocation[] = [
    ...order.hold.allocations.filter((allocation) => !removed.has(allocation.flightId)),
    ...claim,
  ];
  const notes: string[] = [];
  if (current.seats.some((seat) => removed.has(seat.flightId))) {
    notes.push(
      'Seats chosen on the flights you leave are released. Choose new seats after the change.',
    );
  }
  if (released.some((item) => item.kind === 'MEAL')) {
    notes.push(
      'Meal pre-orders on the flights you leave are cancelled; their price is credited above.',
    );
  }
  if (
    current.ancillaries.some(
      (selection) => selection.direction === direction && selection.category !== 'MEAL',
    )
  ) {
    notes.push('Extra baggage and priority services stay with this direction of your trip.');
  }
  const refundable = leg.family.rules.refund.kind === 'FULL';
  return {
    quote: quoteOf('CHANGE_FLIGHT', order, ctx, lines, {
      priceDifferenceMinor: newFare - currentFare,
      refundable,
      notes,
    }),
    request: { operation: 'CHANGE_FLIGHT', direction, itineraryId: candidate.id },
    summary: `${directionWord(direction)} flight ${oldNumbers} on ${itinerary.departure.date} changed to ${newNumbers} on ${first.date}.`,
    plan: { baseVersion: current.version, current: next, allocations },
    claim,
  };
}

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

export const seatItemId = (travellerId: string, flightId: string) =>
  `seat-${travellerId}-${flightId}`;

export function seatClosesAt(segment: FlightInstance) {
  return segment.departureUtc - SEAT_CHANGE_CUTOFF_MINUTES * MINUTE;
}

/** A flight's seat map now, as the inventory and every active hold leave it. */
export function seatMapNow(segment: FlightInstance, ctx: QuoteContext): SeatMap {
  return buildSeatMap(segment, { seed: ctx.seed, now: ctx.businessNow });
}

export function quoteSeats(
  order: StoredOrder,
  trip: OrderTrip,
  changes: readonly SeatChange[],
  ctx: QuoteContext,
  ledger: AllocationLedger,
): QuoteFailure | Computed {
  const refused = modifiable(order);
  if (refused) return refused;
  const { current } = order;
  const travellers = new Map(
    seatTravellers({ passengers: order.snapshot.passengers }, trip.slots).map((t) => [t.id, t]),
  );
  const maps = new Map<string, SeatMap>();
  const seen = new Set<string>();
  const chosen = new Set<string>();
  const lines: ServicingQuoteLine[] = [];
  const notes: string[] = [];
  const nextSeats = current.seats.slice();
  const nextItems = current.items.slice();
  const claimByFlight = new Map<string, StoredClaimAllocation>();
  const moves: { flightId: string; from: string | null; to: string }[] = [];

  for (const [index, change] of changes.entries()) {
    const at = (field: string) => `changes.${index}.${field}`;
    const traveller = travellers.get(change.travellerId);
    if (!traveller) {
      return fail(
        422,
        'TRAVELLER_MISSING',
        'This traveller isn’t part of your booking.',
        at('travellerId'),
      );
    }
    if (!traveller.seatable) {
      return fail(422, 'SEAT_INELIGIBLE', SEAT_PROBLEM_MESSAGES['not-seatable'], at('travellerId'));
    }
    const located = legFor(trip, change.flightId);
    if (!located) {
      return fail(
        422,
        'INVALID_SELECTION',
        'This flight isn’t part of your booking.',
        at('flightId'),
      );
    }
    const { leg, segment } = located;
    const flight = formatFlightNumber(segment.schedule.flightNumber);
    if (ctx.businessNow >= seatClosesAt(segment)) {
      return fail(
        409,
        'CHANGE_NOT_ALLOWED',
        `Seat changes for ${flight} have closed.`,
        at('flightId'),
      );
    }
    const key = `${change.travellerId}|${change.flightId}`;
    if (seen.has(key)) {
      return fail(
        422,
        'INVALID_SELECTION',
        'Each traveller can have one seat per flight.',
        at('seatId'),
      );
    }
    seen.add(key);
    const existing = current.seats.find(
      (seat) => seat.travellerId === change.travellerId && seat.flightId === change.flightId,
    );
    if (existing?.seatId === change.seatId) {
      return fail(
        422,
        'INVALID_SELECTION',
        `${slotLabel(change.travellerId)} already has seat ${change.seatId}.`,
        at('seatId'),
      );
    }
    const seatKey = `${change.flightId}|${change.seatId}`;
    if (chosen.has(seatKey)) {
      return fail(409, 'SEAT_UNAVAILABLE', `Seat ${change.seatId} is chosen twice.`, at('seatId'));
    }
    chosen.add(seatKey);
    let map = maps.get(segment.id);
    if (!map) {
      map = seatMapNow(segment, ctx);
      maps.set(segment.id, map);
    }
    const seat = seatOn(map, change.seatId);
    if (!seat) {
      return fail(
        422,
        'SEAT_INELIGIBLE',
        `There’s no seat ${change.seatId} on this aircraft.`,
        at('seatId'),
      );
    }
    if (ledger.ownSeatIds(order.orderId, segment.id).has(seat.id)) {
      return fail(
        409,
        'SEAT_UNAVAILABLE',
        SEAT_PROBLEM_MESSAGES['taken-by-companion'],
        at('seatId'),
      );
    }
    const problem = seatProblem(seat, {
      fareCabin: leg.family.cabin,
      traveller,
      takenByOther: false,
    });
    if (problem === 'occupied' || problem === 'unavailable') {
      return fail(
        409,
        'SEAT_UNAVAILABLE',
        `Seat ${seat.id} is no longer available. Please choose another seat.`,
        at('seatId'),
      );
    }
    if (problem) return fail(422, 'SEAT_INELIGIBLE', SEAT_PROBLEM_MESSAGES[problem], at('seatId'));

    const price = seatPrice(seat.category, leg.family, segment.schedule.distanceBand);
    const itemId = seatItemId(change.travellerId, change.flightId);
    const paidItem = current.items.find((item) => item.id === itemId);
    const paid = paidItem?.amountMinor ?? 0;
    const charge = Math.max(0, price.priceMinor - paid);
    const value = paid + charge;
    const label = `Seat ${seat.id} · ${SEAT_CATEGORY_LABELS[seat.category]}`;
    const detail = `${slotLabel(change.travellerId)} · ${flightLabel(segment)}`;
    lines.push({ kind: 'SEAT', label, detail, amountMinor: price.priceMinor });
    if (paid > 0) {
      lines.push({
        kind: 'ALREADY_PAID',
        label: `Already paid · ${paidItem!.label}`,
        detail,
        amountMinor: -Math.min(paid, price.priceMinor),
      });
    }
    if (paid > price.priceMinor) {
      notes.push(
        `${slotLabel(change.travellerId)}’s new seat costs less than the one paid for; the difference isn’t refunded (fictional policy).`,
      );
    }
    const included = value === 0 && price.included;
    const assignment: SeatAssignment = {
      travellerId: change.travellerId,
      flightId: change.flightId,
      seatId: seat.id,
      category: seat.category,
      priceMinor: value,
      included,
    };
    const seatIndex = nextSeats.findIndex(
      (candidate) =>
        candidate.travellerId === change.travellerId && candidate.flightId === change.flightId,
    );
    if (seatIndex >= 0) nextSeats[seatIndex] = assignment;
    else nextSeats.push(assignment);
    const item: OrderItem = {
      id: itemId,
      kind: 'SEAT',
      label,
      detail,
      direction: leg.direction,
      travellerId: change.travellerId,
      flightId: change.flightId,
      productCode: seat.category,
      quantity: 1,
      unitPriceMinor: value,
      amountMinor: value,
      included,
    };
    const itemIndex = nextItems.findIndex((candidate) => candidate.id === itemId);
    if (itemIndex >= 0) nextItems[itemIndex] = item;
    else nextItems.push(item);
    const claim = claimByFlight.get(segment.id) ?? {
      flightId: segment.id,
      cabin: leg.family.cabin,
      seats: 0,
      seatIds: [],
    };
    claim.seats += 1;
    claim.seatIds.push(seat.id);
    claimByFlight.set(segment.id, claim);
    moves.push({ flightId: segment.id, from: existing?.seatId ?? null, to: seat.id });
  }

  const allocations = order.hold.allocations.map((allocation) => {
    const here = moves.filter((move) => move.flightId === allocation.flightId);
    if (here.length === 0) return allocation;
    const leaving = new Set(here.map((move) => move.from).filter((seat) => seat !== null));
    return {
      ...allocation,
      seatIds: [
        ...allocation.seatIds.filter((seat) => !leaving.has(seat)),
        ...here.map((move) => move.to),
      ].sort(),
    };
  });
  const summary = `Seats changed: ${changes
    .map(
      (change, index) =>
        `${slotLabel(change.travellerId)} ${moves[index]!.from ?? 'no seat'} → ${change.seatId}`,
    )
    .join(', ')}.`;
  return {
    quote: quoteOf('CHANGE_SEAT', order, ctx, lines, { notes }),
    request: { operation: 'CHANGE_SEAT', changes: changes.map((change) => ({ ...change })) },
    summary: summary.slice(0, 300),
    plan: {
      baseVersion: current.version,
      current: { ...current, version: current.version + 1, seats: nextSeats, items: nextItems },
      allocations,
    },
    claim: [...claimByFlight.values()].map((claim) => ({
      ...claim,
      seatIds: claim.seatIds.sort(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

const ancillaryItemId = (slotId: string, productId: string) => `${slotId}-${productId}`;

function ancillaryClosesAt(
  category: keyof typeof ANCILLARY_CUTOFF_HOURS,
  leg: OrderLeg,
  segment: FlightInstance | undefined,
) {
  const departs = category === 'MEAL' && segment ? segment.departureUtc : leg.departsAt;
  return departs - ANCILLARY_CUTOFF_HOURS[category] * HOUR;
}

/** What can still be added, priced against what each slot already paid. */
export function ancillaryView(
  order: StoredOrder,
  trip: OrderTrip,
  ctx: QuoteContext,
): OrderAncillaries {
  const liveTrip = { ...trip, legs: trip.legs.filter((leg) => leg.live) };
  const owned = new Map(order.current.ancillaries.map((selection) => [selection.id, selection]));
  const offers = ancillaryOffers(liveTrip).map((offer) => {
    const slot = ancillarySlotId(offer);
    const existing = owned.get(slot);
    const paid = existing
      ? (order.current.items.find((item) => item.id === ancillaryItemId(slot, existing.productId))
          ?.amountMinor ?? 0)
      : 0;
    const leg = liveTrip.legs.find((candidate) => candidate.direction === offer.direction)!;
    const segment = offer.flightId
      ? leg.segments.find((candidate) => candidate.id === offer.flightId)
      : undefined;
    let unavailableReason: string | null = null;
    if (existing?.productId === offer.productId) unavailableReason = 'Already added.';
    else if (
      existing &&
      offer.category === 'BAGGAGE' &&
      (ANCILLARIES_BY_ID.get(offer.productId)?.extraWeightKg ?? 0) <=
        (ANCILLARIES_BY_ID.get(existing.productId)?.extraWeightKg ?? 0)
    ) {
      unavailableReason = 'You already have this much extra baggage or more.';
    } else if (ctx.businessNow >= ancillaryClosesAt(offer.category, leg, segment)) {
      unavailableReason = `Closes ${ANCILLARY_CUTOFF_HOURS[offer.category]} hours before departure.`;
    }
    return {
      ...offer,
      payableMinor: Math.max(0, offer.priceMinor - paid),
      owned: existing?.productId === offer.productId,
      unavailableReason,
    };
  });
  return {
    currency: PRICING_CURRENCY,
    offers,
    allowances: order.current.baggage,
    mealService: liveTrip.legs.flatMap((leg) =>
      leg.segments.map((segment) => mealServiceFor(segment, leg)),
    ),
    cutoffs: {
      baggageHours: ANCILLARY_CUTOFF_HOURS.BAGGAGE,
      mealHours: ANCILLARY_CUTOFF_HOURS.MEAL,
      priorityHours: ANCILLARY_CUTOFF_HOURS.PRIORITY,
    },
    catalogueVersion: ANCILLARY_CATALOGUE_VERSION,
  };
}

export function quoteAncillaries(
  order: StoredOrder,
  trip: OrderTrip,
  changes: readonly AncillaryPurchase[],
  ctx: QuoteContext,
): QuoteFailure | Computed {
  const refused = modifiable(order);
  if (refused) return refused;
  const { current } = order;
  const liveTrip = { ...trip, legs: trip.legs.filter((leg) => leg.live) };
  const offers = offerIndex(ancillaryOffers(liveTrip));
  const slotIds = new Set(trip.slots.map((slot) => slot.id));
  const lines: ServicingQuoteLine[] = [];
  const notes: string[] = [];
  const nextAncillaries = current.ancillaries.slice();
  let nextItems = current.items.slice();
  const seenSlots = new Set<string>();
  const names: string[] = [];

  for (const [index, change] of changes.entries()) {
    const at = (field: string) => `changes.${index}.${field}`;
    if (!slotIds.has(change.travellerId)) {
      return fail(
        422,
        'TRAVELLER_MISSING',
        'This traveller isn’t part of your booking.',
        at('travellerId'),
      );
    }
    const product = ANCILLARIES_BY_ID.get(change.productId);
    if (!product || product.category !== change.category) {
      return fail(422, 'ANCILLARY_UNAVAILABLE', 'This service isn’t sold.', at('productId'));
    }
    const located =
      change.category === 'MEAL'
        ? legFor(liveTrip, change.flightId)
        : (() => {
            const leg = liveTrip.legs.find((candidate) => candidate.direction === change.direction);
            return leg ? { leg, segment: undefined } : null;
          })();
    if (!located) {
      return fail(
        422,
        'INVALID_SELECTION',
        'This flight isn’t part of your booking.',
        at(change.category === 'MEAL' ? 'flightId' : 'direction'),
      );
    }
    const { leg, segment } = located;
    const direction = leg.direction;
    const flightId = change.category === 'MEAL' ? change.flightId : null;
    const slot = ancillarySlotId({
      category: change.category,
      travellerId: change.travellerId,
      direction,
      flightId,
      productId: change.productId,
    });
    if (seenSlots.has(slot)) {
      return fail(
        422,
        'INVALID_SELECTION',
        'Each service can be added once per traveller.',
        at('productId'),
      );
    }
    seenSlots.add(slot);
    const offer = offers.get(`${slot}|${change.productId}`);
    if (!offer) {
      const included = leg.family.services.some(
        (service) => service.code === change.productId && service.inclusion === 'included',
      );
      return fail(
        422,
        'ANCILLARY_UNAVAILABLE',
        included
          ? `${product.name} is already included in your ${leg.family.name} fare.`
          : `${product.name} isn’t available for this traveller on this ${change.category === 'MEAL' ? 'flight' : 'trip'}.`,
        at('productId'),
      );
    }
    if (ctx.businessNow >= ancillaryClosesAt(change.category, leg, segment)) {
      return fail(
        409,
        'ANCILLARY_UNAVAILABLE',
        `${product.name} can be added until ${ANCILLARY_CUTOFF_HOURS[change.category]} hours before departure.`,
        at('productId'),
      );
    }
    const existing = current.ancillaries.find((selection) => selection.id === slot);
    if (existing?.productId === change.productId) {
      return fail(
        409,
        'ANCILLARY_UNAVAILABLE',
        `${product.name} is already part of your booking.`,
        at('productId'),
      );
    }
    if (
      existing &&
      change.category === 'BAGGAGE' &&
      (product.extraWeightKg ?? 0) <=
        (ANCILLARIES_BY_ID.get(existing.productId)?.extraWeightKg ?? 0)
    ) {
      return fail(
        422,
        'ANCILLARY_UNAVAILABLE',
        'You already have this much extra baggage or more.',
        at('productId'),
      );
    }
    const oldItemId = existing ? ancillaryItemId(slot, existing.productId) : null;
    const paid = oldItemId
      ? (current.items.find((item) => item.id === oldItemId)?.amountMinor ?? 0)
      : 0;
    const charge = Math.max(0, offer.priceMinor - paid);
    const value = paid + charge;
    const detail = `${slotLabel(change.travellerId)} · ${segment ? flightLabel(segment) : `${directionWord(direction)}, ${leg.journey.itinerary.origin} → ${leg.journey.itinerary.destination}`}`;
    lines.push({ kind: 'SERVICE', label: product.name, detail, amountMinor: offer.priceMinor });
    if (paid > 0) {
      const old = ANCILLARIES_BY_ID.get(existing!.productId)!;
      lines.push({
        kind: 'ALREADY_PAID',
        label: `Already paid · ${old.name}`,
        detail,
        amountMinor: -Math.min(paid, offer.priceMinor),
      });
      if (paid > offer.priceMinor)
        notes.push(
          `${product.name} costs less than ${old.name}; the difference isn’t refunded (fictional policy).`,
        );
    }
    if (offer.included) notes.push(`${product.name} is included in your fare: no charge.`);
    const included = offer.included && value === 0;
    const selection: AncillarySelection = {
      id: slot,
      productId: offer.productId,
      category: offer.category,
      travellerId: change.travellerId,
      direction,
      flightId,
      quantity: 1,
      priceMinor: value,
      included,
    };
    const selectionIndex = nextAncillaries.findIndex((candidate) => candidate.id === slot);
    if (selectionIndex >= 0) nextAncillaries[selectionIndex] = selection;
    else nextAncillaries.push(selection);
    nextItems = nextItems.filter((item) => item.id !== oldItemId);
    nextItems.push({
      id: ancillaryItemId(slot, offer.productId),
      kind: offer.category,
      label: product.name,
      detail,
      direction,
      travellerId: change.travellerId,
      flightId,
      productCode: offer.productId,
      quantity: 1,
      unitPriceMinor: value,
      amountMinor: value,
      included,
    });
    names.push(`${product.name} (${slotLabel(change.travellerId)})`);
  }

  const baggage = baggageAllowances(trip, { ancillaries: nextAncillaries });
  return {
    quote: quoteOf('ADD_ANCILLARY', order, ctx, lines, { notes }),
    request: {
      operation: 'ADD_ANCILLARY',
      changes: changes.map((change) => ({
        category: change.category,
        travellerId: change.travellerId,
        direction: change.category === 'MEAL' ? null : change.direction,
        flightId: change.category === 'MEAL' ? change.flightId : null,
        productId: change.productId,
      })),
    },
    summary: `Added ${names.join(', ')}.`.slice(0, 300),
    plan: {
      baseVersion: current.version,
      current: {
        ...current,
        version: current.version + 1,
        ancillaries: nextAncillaries,
        items: nextItems,
        baggage,
      },
      allocations: order.hold.allocations,
    },
    claim: [],
  };
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

export function cancelAvailability(order: StoredOrder, trip: OrderTrip, now: number) {
  const first = trip.legs[0]!;
  const closesAt = first.departsAt - first.family.rules.refund.cutoffMinutes * MINUTE;
  if (order.status === 'BOOKING_CANCELLED') {
    return { allowed: false, reason: 'This booking is already cancelled.', closesAt };
  }
  if (now >= first.departsAt || !first.live) {
    return {
      allowed: false,
      reason: 'Part of this trip has already departed, so it can’t be cancelled online.',
      closesAt,
    };
  }
  if (now >= closesAt) {
    return {
      allowed: false,
      reason: `Online cancellation closes ${hoursText(first.family.rules.refund.cutoffMinutes)} before departure.`,
      closesAt,
    };
  }
  return { allowed: true, reason: null, closesAt };
}

export interface CancellationComputed extends Computed {
  refundMinor: number;
  nonRefundableMinor: number;
  feeMinor: number;
}

export function quoteCancellation(
  order: StoredOrder,
  trip: OrderTrip,
  ctx: QuoteContext,
  /** What was paid and not yet refunded: the most any refund can return. */
  netPaidMinor: number,
  creditMinor: number,
): QuoteFailure | CancellationComputed {
  const refused = modifiable(order);
  if (refused) return refused;
  const availability = cancelAvailability(order, trip, ctx.businessNow);
  if (!availability.allowed) return fail(409, 'CHANGE_NOT_ALLOWED', availability.reason!);
  const travellers = feeTravellers(order);
  const lines: ServicingQuoteLine[] = [];
  let refund = 0;
  let kept = 0;
  let fees = 0;
  const legOf = (direction: JourneyDirection) =>
    trip.legs.find((leg) => leg.direction === direction)!;

  for (const leg of trip.legs) {
    const { refund: rules } = leg.family.rules;
    const fare = itemsTotal(
      order.current.items.filter(
        (item) => item.kind === 'FLIGHT' && item.direction === leg.direction,
      ),
    );
    const route = `${directionWord(leg.direction)}, ${leg.journey.itinerary.origin} → ${leg.journey.itinerary.destination}`;
    if (rules.kind === 'FULL') {
      lines.push({
        kind: 'REFUND',
        label: `Fare · ${leg.family.name}`,
        detail: route,
        amountMinor: -fare,
      });
      refund += fare;
    } else if (rules.kind === 'FEE') {
      const fee = Math.min(fare, rules.feePerTravellerMinor * travellers);
      lines.push({
        kind: 'REFUND',
        label: `Fare · ${leg.family.name}`,
        detail: route,
        amountMinor: -(fare - fee),
      });
      lines.push({
        kind: 'CANCELLATION_FEE',
        label: `Cancellation fee · ${leg.family.name}`,
        detail: `${formatPesos(rules.feePerTravellerMinor)} × ${travellers} traveller${travellers === 1 ? '' : 's'}`,
        amountMinor: fee,
      });
      refund += fare - fee;
      fees += fee;
    } else {
      const taxes = Math.min(fare, leg.journey.price.totals.taxesMinor);
      lines.push({
        kind: 'REFUND',
        label: 'Unused taxes and charges',
        detail: route,
        amountMinor: -taxes,
      });
      lines.push({
        kind: 'NON_REFUNDABLE',
        label: `Fare · ${leg.family.name} (non-refundable)`,
        detail: route,
        amountMinor: fare - taxes,
      });
      refund += taxes;
      kept += fare - taxes;
    }
  }
  for (const item of order.current.items) {
    if (item.kind === 'FLIGHT' || item.amountMinor === 0) continue;
    if (item.kind === 'CHANGE_FEE') {
      lines.push({
        kind: 'NON_REFUNDABLE',
        label: `${item.label} (non-refundable)`,
        detail: item.detail,
        amountMinor: item.amountMinor,
      });
      kept += item.amountMinor;
      continue;
    }
    if (legOf(item.direction).family.rules.refund.extrasRefundable) {
      lines.push({
        kind: 'REFUND',
        label: item.label,
        detail: item.detail,
        amountMinor: -item.amountMinor,
      });
      refund += item.amountMinor;
    } else {
      lines.push({
        kind: 'NON_REFUNDABLE',
        label: `${item.label} (non-refundable)`,
        detail: item.detail,
        amountMinor: item.amountMinor,
      });
      kept += item.amountMinor;
    }
  }
  const capped = Math.min(refund, Math.max(0, netPaidMinor));
  const notes = [
    'Your seats are released as soon as the booking is cancelled.',
    'The refund is processed separately and may take a moment; we show its status on your booking.',
  ];
  if (creditMinor > 0)
    notes.push(
      `Travel credit of ${formatPesos(creditMinor)} from an earlier change stays with this booking (fictional).`,
    );
  return {
    quote: quoteOf('CANCEL_ORDER', order, ctx, lines, { refundable: true, notes, net: -capped }),
    request: { operation: 'CANCEL_ORDER' },
    summary: `Booking cancelled; ${formatPesos(capped)} to refund.`,
    plan: null,
    claim: [],
    refundMinor: capped,
    nonRefundableMinor: kept,
    feeMinor: fees,
  };
}
