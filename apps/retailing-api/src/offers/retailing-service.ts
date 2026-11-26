import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  SEAT_PROBLEM_MESSAGES,
  ancillarySlotId,
  createFlightSearchSchema,
  requiredDirections,
  seatProblem,
  slotLabel,
  travellerIssues,
  type AncillaryChange,
  type BookingNotice,
  type BookingReview,
  type CompleteStepRequest,
  type Quote,
  type ReviewIssue,
  type ReviewResponse,
  type SeatMap,
  type SessionAncillaries,
  type SessionSeatMap,
  type Traveller,
  type Contact,
  type UpdateSeatsRequest,
  type ApiErrorCode,
  type Booking,
  type FlightSearch,
  type JourneyDirection,
  type OfferPriceCheckResponse,
  type OfferResponse,
  type OfferSearchQuery,
  type OfferSearchResponse,
  type OffersMeta,
  type RepriceOutcome,
  type RepriceResponse,
  type Selection,
  type SelectionStatus,
  type SelectOfferResponse,
  type ShoppingSession,
  type TravellerBaggage,
} from '@velasia/contracts';
import type { Clock } from '../clock';
import { AIRPORTS } from '../fixtures/airports';
import { FARE_FAMILIES, toPublicFareFamily } from '../fixtures/fare-families';
import { PRICING_CURRENCY } from '../pricing/pricing';
import { resolveCandidate, type Candidate } from '../search/itineraries';
import type { FlightService } from '../services/flights';
import {
  ANCILLARIES,
  ANCILLARIES_BY_ID,
  ANCILLARY_CATALOGUE_VERSION,
  toPublicProduct,
} from '../fixtures/ancillaries';
import { buildSeatMap, seatOn } from '../booking/seat-map';
import {
  ancillaryOffers,
  baggageAllowances,
  bookingIssues,
  findLeg,
  flightsReady,
  mealServiceFor,
  seatPricing,
  seatTravellers,
  travelDates,
  buildQuote,
  emptyBooking,
  extrasTotals,
  longestBand,
  offerIndex,
  publicAncillaries,
  publicSeats,
  reconcileBooking,
  slotsFor,
  stepStates,
  type StoredBooking,
  type Trip,
} from '../booking/booking';
import { BoundedStore, type StoreListener } from './bounded-store';
import {
  PRICING_VERSION,
  createOffer,
  familyEligibility,
  evaluateFamilies,
  inventoryVersionFor,
  isExpired,
  offerItinerary,
  offerStatus,
  toPublicOffer,
  type PricingContext,
  type StoredOffer,
} from './offer-engine';
import type { AllocationLedger } from '../inventory/ledger';
import { NO_SCENARIO, type Scenario } from './scenario';

export interface RetailingConfig {
  /** How long an offer can be selected after it is created. */
  offerValidityMs: number;
  /** Requests for the same itinerary and party within this window reuse the same offers. */
  offerReuseMs: number;
  maxOffers: number;
  /** A session expires after this much inactivity… */
  sessionIdleMs: number;
  /** …and never lives longer than this. */
  sessionMaxMs: number;
  maxSessions: number;
}

export const DEFAULT_RETAILING_CONFIG: RetailingConfig = {
  offerValidityMs: 15 * 60_000,
  offerReuseMs: 60_000,
  maxOffers: 20_000,
  sessionIdleMs: 30 * 60_000,
  sessionMaxMs: 3 * 60 * 60_000,
  maxSessions: 5_000,
};

/** Minimum time between the outbound landing and the inbound departing (as in search). */
const MIN_STAY_MS = 120 * 60_000;
/** Expired sessions and offers are remembered this long so callers get "expired", not "unknown". */
const EXPIRED_GRACE_MS = 30 * 60_000;

export type RetailingFailure = {
  ok: false;
  status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 503;
  code: ApiErrorCode;
  message: string;
  path?: string;
  /** Every field-level problem, when there are several (traveller details). */
  issues?: { path: string; message: string }[];
};
export type RetailingResult<T> = { ok: true; value: T } | RetailingFailure;

const fail = (
  status: RetailingFailure['status'],
  code: ApiErrorCode,
  message: string,
  path?: string,
): RetailingFailure => ({ ok: false, status, code, message, path });

export interface StoredSelection {
  direction: JourneyDirection;
  offer: StoredOffer;
  /** Stored status; `EXPIRED` is derived when the offer's validity has passed. */
  status: Exclude<SelectionStatus, 'EXPIRED'>;
  selectedAt: number;
  validatedAt: number | null;
  previous: Selection['previous'];
  pendingOffer: StoredOffer | null;
  lastCheck: {
    outcome: RepriceOutcome;
    at: number;
    previousTotalMinor: number;
    currentTotalMinor: number | null;
  } | null;
}

export interface StoredSession {
  id: string;
  tokenHash: Buffer;
  search: FlightSearch;
  selections: { outbound: StoredSelection | null; inbound: StoredSelection | null };
  /** Traveller details, seats, services, and the last review (Milestone 4). */
  booking: StoredBooking;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  version: number;
  /** Set once an order from this session is confirmed (Milestone 5): it can't be bought twice. */
  orderedOrderId: string | null;
}

const KNOWN_AIRPORTS: ReadonlySet<string> = new Set(AIRPORTS.map((airport) => airport.code));
const hashToken = (token: string) => createHash('sha256').update(token).digest();
const iso = (ms: number) => new Date(ms).toISOString();

export type RetailingService = ReturnType<typeof createRetailingService>;

/**
 * Offers and shopping sessions. Every method is synchronous: a session is read, checked, and
 * written without yielding to the event loop, so concurrent requests can't interleave inside
 * an update. (Durable, multi-instance storage arrives with TalaDB in a later milestone.)
 */
export function createRetailingService({
  flights,
  clock,
  config = DEFAULT_RETAILING_CONFIG,
  ledger,
}: {
  flights: FlightService;
  clock: Clock;
  config?: RetailingConfig;
  /** Seats held by orders (Milestone 5): a session never competes with its own pending hold. */
  ledger?: AllocationLedger;
}) {
  const offers = new BoundedStore<StoredOffer>({
    maxEntries: config.maxOffers,
    graceMs: EXPIRED_GRACE_MS,
    expiresAt: (offer) => offer.expiresAt,
  });
  /** Offer ids by itinerary and party, for reuse within `offerReuseMs`. */
  const recent = new BoundedStore<{ ids: string[]; createdAt: number }>({
    maxEntries: config.maxOffers,
    graceMs: 0,
    expiresAt: (entry) => entry.createdAt + config.offerReuseMs,
  });
  const sessions = new BoundedStore<StoredSession>({
    maxEntries: config.maxSessions,
    graceMs: EXPIRED_GRACE_MS,
    expiresAt: (session) => session.expiresAt,
  });

  function context(scenario: Scenario = NO_SCENARIO): PricingContext {
    const inventory = flights.current();
    return {
      // Scenarios simulate elapsed time, so they move both (as the unpinned clock would).
      now: clock.now() + scenario.clockOffsetMs,
      businessNow: clock.businessNow() + scenario.clockOffsetMs,
      inventoryVersion: inventoryVersionFor(inventory.referenceDate),
      demandShift: scenario.demandShift,
      soldOut: scenario.soldOut,
      seatTaken: scenario.seatTaken,
    };
  }

  function meta(ctx: PricingContext): OffersMeta {
    return {
      currency: PRICING_CURRENCY,
      referenceDate: flights.current().referenceDate,
      inventoryVersion: ctx.inventoryVersion,
      pricingVersion: PRICING_VERSION,
      offerValiditySeconds: Math.round(config.offerValidityMs / 1000),
      serverTime: iso(ctx.now),
    };
  }

  const candidateFor = (itineraryId: string): Candidate | null =>
    resolveCandidate(flights.current(), itineraryId);

  /**
   * Entries ever created (M9.3), for the benchmark gate. Store sizes alone cannot show them:
   * with real-time expiry a write also sweeps expired entries, so a store can stay the same
   * size while offers are created.
   */
  const created = { offers: 0, sessions: 0 };

  function storeOffer(offer: StoredOffer, now: number) {
    offers.set(offer.id, offer, now);
    created.offers += 1;
    return offer;
  }

  // -------------------------------------------------------------------------
  // Sessions: internal helpers
  // -------------------------------------------------------------------------

  function selectionStatus(selection: StoredSelection, ctx: PricingContext): SelectionStatus {
    if (
      (selection.status === 'SELECTED' || selection.status === 'VALIDATED') &&
      isExpired(selection.offer, ctx)
    ) {
      return 'EXPIRED';
    }
    return selection.status;
  }

  /** The trip as the booking steps see it: selected legs with their flights and fare. */
  function tripFor(session: StoredSession, ctx: PricingContext): Trip {
    const required = requiredDirections(session.search);
    const legs = required.flatMap((direction) => {
      const selection = session.selections[direction];
      if (!selection) return [];
      const segments = candidateFor(selection.offer.itineraryId)?.segments ?? [];
      return [
        {
          direction,
          offer: selection.offer,
          family: selection.offer.family,
          segments,
          status: selectionStatus(selection, ctx),
          validatedAt: selection.validatedAt,
          band: longestBand(segments),
        },
      ];
    });
    return {
      search: session.search,
      legs,
      complete: legs.length === required.length,
      slots: slotsFor(session.search),
    };
  }

  function toPublicBooking(session: StoredSession, trip: Trip): Booking {
    const { booking } = session;
    const seats = publicSeats(booking, trip);
    const ancillaries = publicAncillaries(booking, offerIndex(ancillaryOffers(trip)));
    const reviewCurrent = booking.review?.sessionVersion === session.version;
    return {
      slots: trip.slots,
      passengers: booking.passengers,
      contact: booking.contact,
      seats,
      ancillaries,
      steps: stepStates(booking, trip, reviewCurrent),
      notices: booking.notices,
      review: booking.review
        ? {
            status: booking.review.status,
            checkedAt: iso(booking.review.checkedAt),
            sessionVersion: booking.review.sessionVersion,
            current: reviewCurrent,
            totalMinor: booking.review.totalMinor,
            issues: booking.review.issues,
          }
        : null,
    };
  }

  function toPublicSession(session: StoredSession, ctx: PricingContext): ShoppingSession {
    const view = (selection: StoredSelection | null): Selection | null => {
      if (!selection) return null;
      const candidate = candidateFor(selection.offer.itineraryId);
      return {
        direction: selection.direction,
        status: selectionStatus(selection, ctx),
        offer: toPublicOffer(selection.offer, offerStatus(selection.offer, candidate, ctx)),
        selectedAt: iso(selection.selectedAt),
        validatedAt: selection.validatedAt === null ? null : iso(selection.validatedAt),
        previous: selection.previous,
        pendingOffer: selection.pendingOffer
          ? toPublicOffer(
              selection.pendingOffer,
              offerStatus(selection.pendingOffer, candidate, ctx),
            )
          : null,
        lastCheck: selection.lastCheck
          ? { ...selection.lastCheck, at: iso(selection.lastCheck.at) }
          : null,
      };
    };
    const outbound = view(session.selections.outbound);
    const inbound = view(session.selections.inbound);
    const required = requiredDirections(session.search).map((direction) =>
      direction === 'outbound' ? outbound : inbound,
    );
    const chosen = [outbound, inbound].filter((selection) => selection !== null);
    const sum = (pick: (selection: Selection) => number) =>
      chosen.reduce((total, selection) => total + pick(selection), 0);
    const complete = required.every((selection) => selection !== null);
    const booking = toPublicBooking(session, tripFor(session, ctx));
    const extras = extrasTotals(booking.seats, booking.ancillaries);
    const flightsTotalMinor = sum((selection) => selection.offer.price.totalMinor);
    return {
      id: session.id,
      search: session.search,
      selections: { outbound, inbound },
      summary: {
        currency: PRICING_CURRENCY,
        complete,
        readyToContinue:
          complete && required.every((selection) => selection!.status === 'VALIDATED'),
        totalMinor: flightsTotalMinor + extras.totalMinor,
        flightsTotalMinor,
        totals: {
          baseFareMinor: sum((selection) => selection.offer.price.totals.baseFareMinor),
          fareFamilyMinor: sum((selection) => selection.offer.price.totals.fareFamilyMinor),
          taxesMinor: sum((selection) => selection.offer.price.totals.taxesMinor),
          extrasMinor: extras.totalMinor,
        },
        extras,
        offersExpireAt:
          chosen.length > 0
            ? iso(Math.min(...chosen.map((selection) => Date.parse(selection.offer.expiresAt))))
            : null,
      },
      booking,
      createdAt: iso(session.createdAt),
      updatedAt: iso(session.updatedAt),
      expiresAt: iso(session.expiresAt),
      version: session.version,
      serverTime: iso(ctx.now),
    };
  }

  /** Find a session by id and token. A wrong token looks exactly like an unknown id. */
  function authorize(
    id: string,
    token: string | undefined,
    ctx: PricingContext,
  ): RetailingResult<StoredSession> {
    const session = sessions.get(id);
    const provided = token ? hashToken(token) : null;
    if (!session || !provided || !timingSafeEqual(provided, session.tokenHash)) {
      return fail(404, 'SESSION_NOT_FOUND', 'This shopping session doesn’t exist.');
    }
    if (ctx.now >= session.expiresAt) {
      return fail(410, 'SESSION_EXPIRED', 'This shopping session has expired.');
    }
    return { ok: true, value: session };
  }

  function touch(session: StoredSession, now: number) {
    session.updatedAt = now;
    session.expiresAt = Math.min(
      session.createdAt + config.sessionMaxMs,
      now + config.sessionIdleMs,
    );
    session.version += 1;
    sessions.set(session.id, session, now);
  }

  /** Why an offer can't be chosen for this direction of this session, or `null`. */
  function selectionProblem(
    session: StoredSession,
    direction: JourneyDirection,
    offer: StoredOffer,
  ): string | null {
    const { search } = session;
    if (direction === 'inbound' && search.tripType !== 'round-trip') {
      return 'This trip is one-way, so it has no return flight.';
    }
    const expected =
      direction === 'outbound'
        ? { origin: search.origin, destination: search.destination, date: search.departDate }
        : { origin: search.destination, destination: search.origin, date: search.returnDate };
    const { itinerary } = offer;
    if (
      itinerary.origin !== expected.origin ||
      itinerary.destination !== expected.destination ||
      itinerary.departure.date !== expected.date
    ) {
      return `This offer is for a different ${direction === 'outbound' ? 'departing' : 'return'} route or date.`;
    }
    const p = offer.passengers;
    const q = search.passengers;
    if (p.adults !== q.adults || p.children !== q.children || p.infants !== q.infants) {
      return 'This offer was priced for a different number of travellers.';
    }
    if (direction === 'inbound' && session.selections.outbound) {
      const landed = Date.parse(session.selections.outbound.offer.itinerary.arrival.at);
      if (Date.parse(itinerary.departure.at) < landed + MIN_STAY_MS) {
        return 'Your return flight must leave at least 2 hours after your departing flight lands.';
      }
    }
    return null;
  }

  /**
   * Re-validate selections against current inventory and rules (see `reprice`). Mutates the
   * session; the caller touches it.
   */
  function repriceSelections(
    session: StoredSession,
    ctx: PricingContext,
    directions: JourneyDirection[] | undefined,
  ): RepriceResponse['data']['outcomes'] {
    const outcomes: RepriceResponse['data']['outcomes'] = [];

    for (const direction of directions ?? (['outbound', 'inbound'] as const)) {
      const selection = session.selections[direction];
      if (!selection) continue;
      const previousTotalMinor = selection.offer.price.totalMinor;
      const record = (outcome: RepriceOutcome, currentTotalMinor: number | null) => {
        selection.lastCheck = { outcome, at: ctx.now, previousTotalMinor, currentTotalMinor };
        outcomes.push({ direction, outcome, previousTotalMinor, currentTotalMinor });
      };

      const candidate = candidateFor(selection.offer.itineraryId);
      const eligibility = candidate
        ? familyEligibility(candidate, selection.offer.family, selection.offer.passengers, ctx)
        : { ok: false as const };
      if (!candidate || !eligibility.ok) {
        selection.status = 'UNAVAILABLE';
        selection.pendingOffer = null;
        record('UNAVAILABLE', null);
        continue;
      }
      if (!isExpired(selection.offer, ctx)) {
        selection.status = 'VALIDATED';
        selection.validatedAt = ctx.now;
        selection.pendingOffer = null;
        record('VALIDATED', previousTotalMinor);
        continue;
      }
      // A price change already waiting for an answer stays as it is while it is valid.
      if (selection.pendingOffer && !isExpired(selection.pendingOffer, ctx)) {
        record('PRICE_CHANGED', selection.pendingOffer.price.totalMinor);
        continue;
      }
      const fresh = storeOffer(
        createOffer(
          candidate,
          selection.offer.family,
          selection.offer.passengers,
          ctx,
          config.offerValidityMs,
        ),
        ctx.now,
      );
      if (fresh.price.totalMinor === previousTotalMinor) {
        selection.offer = fresh;
        selection.status = 'VALIDATED';
        selection.validatedAt = ctx.now;
        selection.pendingOffer = null;
        record('REFRESHED', fresh.price.totalMinor);
      } else {
        selection.status = 'PRICE_CHANGED';
        selection.pendingOffer = fresh;
        record('PRICE_CHANGED', fresh.price.totalMinor);
      }
    }
    return outcomes;
  }

  /** Keep seats and services in line with a changed selection, and say what moved. */
  function afterSelectionChange(
    session: StoredSession,
    ctx: PricingContext,
    flightsChanged: boolean,
  ) {
    const { booking } = session;
    const notices = reconcileBooking(booking, tripFor(session, ctx));
    if (flightsChanged && (booking.progress.seats || booking.progress.extras)) {
      booking.progress = { seats: false, extras: false };
      notices.push({
        code: 'SEATS_RESET',
        message: 'Your flights changed, so please check your seats and extras again.',
      });
    }
    booking.notices = notices;
  }

  // -------------------------------------------------------------------------
  // Booking steps: internal helpers
  // -------------------------------------------------------------------------

  /** The seat map for a flight as this session sees it (scenarios included). */
  function seatMapFor(
    segment: Trip['legs'][number]['segments'][number],
    session: StoredSession,
    ctx: PricingContext,
  ): SeatMap {
    const taken = ctx.seatTaken
      ? new Set(
          session.booking.seats
            .filter((seat) => seat.flightId === segment.id)
            .map((seat) => seat.seatId),
        )
      : undefined;
    return buildSeatMap(segment, {
      seed: flights.current().seed,
      now: ctx.businessNow,
      takenSeatIds: taken,
    });
  }

  /**
   * Apply a booking change atomically: authorise, check the expected version, run `apply` on
   * the stored booking, and keep the change only if it succeeds. Everything is synchronous, so
   * no other request can interleave.
   */
  function mutateBooking<T>(
    id: string,
    token: string | undefined,
    expectedVersion: number | undefined,
    scenario: Scenario | undefined,
    apply: (session: StoredSession, trip: Trip, ctx: PricingContext) => RetailingFailure | T,
  ): RetailingResult<{ session: ShoppingSession; result: T }> {
    const ctx = context(scenario);
    const found = authorize(id, token, ctx);
    if (!found.ok) return found;
    const session = found.value;
    if (expectedVersion !== undefined && expectedVersion !== session.version) {
      return fail(
        409,
        'SESSION_CONFLICT',
        'Your trip was changed in another window or tab. We’ve loaded the latest version.',
      );
    }
    const before = structuredClone(session.booking);
    const outcome = apply(session, tripFor(session, ctx), ctx);
    if (isFailure(outcome)) {
      session.booking = before;
      return outcome;
    }
    touch(session, ctx.now);
    return { ok: true, value: { session: toPublicSession(session, ctx), result: outcome } };
  }

  const isFailure = (value: unknown): value is RetailingFailure =>
    typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;

  function requireFlights(trip: Trip): RetailingFailure | null {
    return flightsReady(trip)
      ? null
      : fail(
          409,
          'BOOKING_STEP_UNAVAILABLE',
          'Confirm your flights and fares on the trip summary first.',
        );
  }

  function requireTravellers(session: StoredSession, trip: Trip): RetailingFailure | null {
    return (
      requireFlights(trip) ??
      (session.booking.passengers
        ? null
        : fail(409, 'BOOKING_STEP_UNAVAILABLE', 'Add traveller details first.'))
    );
  }

  /** Why a change to one service can't be made, or the slot it fills. */
  function checkAncillaryChange(
    change: AncillaryChange,
    index: number,
    trip: Trip,
    offers: ReturnType<typeof offerIndex>,
  ): RetailingFailure | { slot: string; direction: JourneyDirection; flightId: string | null } {
    const at = (field: string) => `changes.${index}.${field}`;
    if (!trip.slots.some((slot) => slot.id === change.travellerId)) {
      return fail(
        422,
        'TRAVELLER_MISSING',
        'This traveller isn’t part of your booking.',
        at('travellerId'),
      );
    }
    if (change.quantity !== undefined && change.quantity !== 1) {
      return fail(
        422,
        'INVALID_QUANTITY',
        'Each service can be added once per traveller.',
        at('quantity'),
      );
    }
    let direction: JourneyDirection;
    let flightId: string | null = null;
    if (change.category === 'MEAL') {
      const found = findLeg(trip, change.flightId);
      if (!found) {
        return fail(
          422,
          'INVALID_SELECTION',
          'This flight isn’t part of your trip.',
          at('flightId'),
        );
      }
      direction = found.leg.direction;
      flightId = change.flightId;
    } else {
      if (!trip.legs.some((leg) => leg.direction === change.direction)) {
        return fail(
          422,
          'INVALID_SELECTION',
          'Your trip has no flight in this direction.',
          at('direction'),
        );
      }
      direction = change.direction;
    }
    const slot = ancillarySlotId({ ...change, direction, flightId });
    const productId = change.productId;
    if (productId === null) return { slot, direction, flightId };
    const product = ANCILLARIES_BY_ID.get(productId);
    if (!product || product.category !== change.category) {
      return fail(422, 'ANCILLARY_UNAVAILABLE', 'We don’t offer that service.', at('productId'));
    }
    const offered = offers.get(
      `${ancillarySlotId({ category: change.category, travellerId: change.travellerId, direction, flightId, productId })}|${productId}`,
    );
    if (!offered) {
      const leg = trip.legs.find((candidate) => candidate.direction === direction)!;
      const included = leg.family.services.some(
        (service) => service.code === productId && service.inclusion === 'included',
      );
      return fail(
        422,
        'ANCILLARY_UNAVAILABLE',
        included
          ? `${product.name} is already included with ${leg.family.name}.`
          : `${product.name} isn’t available for ${slotLabel(change.travellerId)} on this flight.`,
        at('productId'),
      );
    }
    return { slot, direction, flightId };
  }

  function publicReview(session: StoredSession): BookingReview | null {
    const review = session.booking.review;
    if (!review) return null;
    return {
      status: review.status,
      checkedAt: iso(review.checkedAt),
      sessionVersion: review.sessionVersion,
      current: review.sessionVersion === session.version,
      totalMinor: review.totalMinor,
      issues: review.issues,
    };
  }

  /**
   * The final pre-checkout check: re-price the offers, re-check every traveller, seat, and
   * service against current availability and rules, rebuild the quote, and record the result.
   * A seat taken meanwhile is released and the traveller is sent back to choose again.
   */
  function validateBooking(
    id: string,
    token: string | undefined,
    expectedVersion: number | undefined,
    scenario?: Scenario,
  ): RetailingResult<{ session: ShoppingSession; review: BookingReview; quote: Quote }> {
    const ctx = context(scenario);
    const found = authorize(id, token, ctx);
    if (!found.ok) return found;
    const session = found.value;
    if (expectedVersion !== undefined && expectedVersion !== session.version) {
      return fail(
        409,
        'SESSION_CONFLICT',
        'Your trip was changed in another window or tab. We’ve loaded the latest version.',
      );
    }
    if (!tripFor(session, ctx).complete) {
      return fail(409, 'BOOKING_STEP_UNAVAILABLE', 'Choose your flights and fares first.');
    }
    const outcomes = repriceSelections(session, ctx, undefined);
    const trip = tripFor(session, ctx);
    const { booking } = session;
    const notices: BookingNotice[] = [];
    // What is unfinished as the traveller left it, then what this check finds.
    const issues: ReviewIssue[] = bookingIssues(booking, trip);
    for (const outcome of outcomes) {
      if (outcome.outcome === 'REFRESHED') {
        notices.push({
          code: 'OFFER_REFRESHED',
          message: `The price hold on your ${outcome.direction === 'outbound' ? 'departing' : 'return'} flight had ended, so we checked it again: the price is the same.`,
        });
      }
    }
    for (const notice of reconcileBooking(booking, trip)) {
      notices.push(notice);
      const seat = notice.code === 'SEAT_REMOVED' || notice.code === 'SEATS_RESET';
      issues.push({
        code: seat ? 'SEAT_INELIGIBLE' : 'ANCILLARY_UNAVAILABLE',
        step: seat ? 'seats' : 'extras',
        message: notice.message,
        direction: null,
        travellerId: null,
        flightId: null,
      });
      if (seat) booking.progress.seats = false;
    }
    // Seats are provisional: check each one is still free right now.
    booking.seats = booking.seats.filter((assignment) => {
      const located = findLeg(trip, assignment.flightId);
      const seat = located && seatOn(seatMapFor(located.segment, session, ctx), assignment.seatId);
      if (seat?.status === 'AVAILABLE') return true;
      booking.progress.seats = false;
      const flight = located
        ? located.segment.schedule.flightNumber.replace(/^NV/, 'VEL ')
        : 'your flight';
      issues.push({
        code: 'SEAT_UNAVAILABLE',
        step: 'seats',
        message: `Seat ${assignment.seatId} on ${flight} is no longer available for ${slotLabel(assignment.travellerId)}. Please choose another seat.`,
        direction: located?.leg.direction ?? null,
        travellerId: assignment.travellerId,
        flightId: assignment.flightId,
      });
      return false;
    });
    touch(session, ctx.now);
    const view = toPublicSession(session, ctx);
    const quote = buildQuote(trip, view.booking.seats, view.booking.ancillaries, ctx.now);
    booking.review = {
      status: issues.length === 0 ? 'READY' : 'ACTION_REQUIRED',
      checkedAt: ctx.now,
      sessionVersion: session.version,
      totalMinor: quote.totals.totalMinor,
      issues,
    };
    booking.notices = notices;
    const latest = toPublicSession(session, ctx);
    return { ok: true, value: { session: latest, review: latest.booking.review!, quote } };
  }

  const service = {
    config,

    // -----------------------------------------------------------------------
    // Fare families and offers
    // -----------------------------------------------------------------------

    fareFamilies() {
      return FARE_FAMILIES.map(toPublicFareFamily);
    },

    searchOffers(
      query: OfferSearchQuery,
      scenario?: Scenario,
    ): RetailingResult<OfferSearchResponse> {
      const ctx = context(scenario);
      const candidate = candidateFor(query.itineraryId);
      if (!candidate) {
        return fail(404, 'NOT_FOUND', `No flight or itinerary found for "${query.itineraryId}".`);
      }
      const { adults, children, infants } = query.passengers;
      const key = [
        query.itineraryId,
        adults,
        children,
        infants,
        ctx.inventoryVersion,
        ctx.demandShift,
      ].join('|');
      const reused = recent.get(key);
      const reusable =
        reused && ctx.now - reused.createdAt < config.offerReuseMs && !ctx.soldOut
          ? reused.ids.map((id) => offers.get(id))
          : null;

      const families = evaluateFamilies(candidate, query.passengers, ctx);
      let stored: StoredOffer[];
      if (
        reusable &&
        reusable.every(Boolean) &&
        reusable.map((offer) => offer!.family.code).join() ===
          families.eligible.map((family) => family.code).join()
      ) {
        // Same itinerary and party moments ago: hand back the same offers, not new ids.
        stored = reusable as StoredOffer[];
      } else {
        stored = families.eligible.map((family) =>
          storeOffer(
            createOffer(candidate, family, query.passengers, ctx, config.offerValidityMs),
            ctx.now,
          ),
        );
        recent.set(key, { ids: stored.map((offer) => offer.id), createdAt: ctx.now }, ctx.now);
      }
      return {
        ok: true,
        value: {
          data: {
            itineraryId: candidate.id,
            // Every aircraft has an Economy cabin, so the itinerary can always be described.
            itinerary:
              stored[0]?.itinerary ?? offerItinerary(candidate, 'economy', query.passengers),
            availability: families.availability,
            offers: stored.map((offer) => toPublicOffer(offer, 'AVAILABLE')),
            unavailable: families.unavailable.map(({ family, reason, message }) => ({
              family: family.code,
              reason,
              message,
            })),
          },
          meta: meta(ctx),
        },
      };
    },

    getOffer(id: string, scenario?: Scenario): RetailingResult<OfferResponse> {
      const ctx = context(scenario);
      const offer = offers.get(id);
      if (!offer) return fail(404, 'OFFER_NOT_FOUND', 'This offer doesn’t exist.');
      const status = offerStatus(offer, candidateFor(offer.itineraryId), ctx);
      return { ok: true, value: { data: toPublicOffer(offer, status), meta: meta(ctx) } };
    },

    /** The offer's price against current inventory and rules. Creates nothing. */
    checkOfferPrice(id: string, scenario?: Scenario): RetailingResult<OfferPriceCheckResponse> {
      const ctx = context(scenario);
      const offer = offers.get(id);
      if (!offer) return fail(404, 'OFFER_NOT_FOUND', 'This offer doesn’t exist.');
      const candidate = candidateFor(offer.itineraryId);
      const status = offerStatus(offer, candidate, ctx);
      const sellable =
        candidate !== null && familyEligibility(candidate, offer.family, offer.passengers, ctx).ok;
      const current = sellable
        ? createOffer(candidate, offer.family, offer.passengers, ctx, config.offerValidityMs).price
            .totalMinor
        : null;
      return {
        ok: true,
        value: {
          data: {
            offerId: offer.id,
            status,
            currency: offer.price.currency,
            offerTotalMinor: offer.price.totalMinor,
            currentTotalMinor: current,
            priceChanged: current !== null && current !== offer.price.totalMinor,
          },
          meta: meta(ctx),
        },
      };
    },

    // -----------------------------------------------------------------------
    // Shopping sessions
    // -----------------------------------------------------------------------

    createSession(
      search: FlightSearch,
      scenario?: Scenario,
    ): RetailingResult<{ session: ShoppingSession; token: string }> {
      const ctx = context(scenario);
      const parsed = createFlightSearchSchema({
        today: flights.current().referenceDate,
        knownAirportCodes: KNOWN_AIRPORTS,
      }).safeParse({ ...search, returnDate: search.returnDate ?? '' });
      if (!parsed.success) {
        const first = parsed.error.issues[0]!;
        return fail(400, 'BAD_REQUEST', first.message, `search.${first.path.join('.')}`);
      }
      const token = randomBytes(32).toString('base64url');
      const session: StoredSession = {
        id: `ses_${randomBytes(16).toString('base64url')}`,
        tokenHash: hashToken(token),
        search: parsed.data,
        selections: { outbound: null, inbound: null },
        booking: emptyBooking(),
        createdAt: ctx.now,
        updatedAt: ctx.now,
        expiresAt: ctx.now + config.sessionIdleMs,
        version: 0,
        orderedOrderId: null,
      };
      sessions.set(session.id, session, ctx.now);
      created.sessions += 1;
      return { ok: true, value: { session: toPublicSession(session, ctx), token } };
    },

    getSession(id: string, token: string | undefined, scenario?: Scenario) {
      const ctx = context(scenario);
      const found = authorize(id, token, ctx);
      if (!found.ok) return found;
      return { ok: true, value: toPublicSession(found.value, ctx) } as const;
    },

    select(
      id: string,
      token: string | undefined,
      request: { direction: JourneyDirection; offerId: string },
      scenario?: Scenario,
    ): RetailingResult<SelectOfferResponse['data']> {
      const ctx = context(scenario);
      const found = authorize(id, token, ctx);
      if (!found.ok) return found;
      const session = found.value;
      const offer = offers.get(request.offerId);
      if (!offer) return fail(404, 'OFFER_NOT_FOUND', 'This offer doesn’t exist.', 'offerId');

      const problem = selectionProblem(session, request.direction, offer);
      if (problem) return fail(422, 'INVALID_SELECTION', problem, 'offerId');
      if (isExpired(offer, ctx)) {
        return fail(410, 'OFFER_EXPIRED', 'This offer has expired. Please check the latest price.');
      }
      const candidate = candidateFor(offer.itineraryId);
      const eligibility = candidate
        ? familyEligibility(candidate, offer.family, offer.passengers, ctx)
        : ({ ok: false, message: 'This flight no longer exists.' } as const);
      if (!eligibility.ok) return fail(409, 'OFFER_UNAVAILABLE', eligibility.message);

      const existing = session.selections[request.direction];
      if (existing?.offer.id === offer.id) {
        return {
          ok: true,
          value: { session: toPublicSession(session, ctx), inboundCleared: false },
        };
      }
      // Accepting a changed price: the pending offer was priced by the last check.
      const accepting = existing?.pendingOffer?.id === offer.id;
      session.selections[request.direction] = {
        direction: request.direction,
        offer,
        status: accepting ? 'VALIDATED' : 'SELECTED',
        selectedAt: ctx.now,
        validatedAt: accepting ? ctx.now : null,
        previous: existing
          ? {
              family: existing.offer.family.code,
              itineraryId: existing.offer.itineraryId,
              totalMinor: existing.offer.price.totalMinor,
            }
          : null,
        pendingOffer: null,
        lastCheck: null,
      };

      // A new departing flight may no longer leave time for the chosen return.
      let inboundCleared = false;
      const inbound = session.selections.inbound;
      if (
        request.direction === 'outbound' &&
        inbound &&
        Date.parse(inbound.offer.itinerary.departure.at) <
          Date.parse(offer.itinerary.arrival.at) + MIN_STAY_MS
      ) {
        session.selections.inbound = null;
        inboundCleared = true;
      }
      const flightsChanged =
        !existing || existing.offer.flightIds.join() !== offer.flightIds.join() || inboundCleared;
      afterSelectionChange(session, ctx, flightsChanged);
      touch(session, ctx.now);
      return { ok: true, value: { session: toPublicSession(session, ctx), inboundCleared } };
    },

    /**
     * Re-validate selections against current inventory and rules. A valid offer keeps its price
     * until it expires; an expired one is replaced by a fresh offer, and a different price is
     * never applied without the traveller accepting it.
     */
    reprice(
      id: string,
      token: string | undefined,
      directions: JourneyDirection[] | undefined,
      scenario?: Scenario,
    ): RetailingResult<RepriceResponse['data']> {
      const ctx = context(scenario);
      const found = authorize(id, token, ctx);
      if (!found.ok) return found;
      const session = found.value;
      const outcomes = repriceSelections(session, ctx, directions);
      touch(session, ctx.now);
      return { ok: true, value: { session: toPublicSession(session, ctx), outcomes } };
    },

    // -----------------------------------------------------------------------
    // Seat maps and the ancillary catalogue (public)
    // -----------------------------------------------------------------------

    seatMap(flightId: string, scenario?: Scenario): RetailingResult<SeatMap> {
      const ctx = context(scenario);
      const inventory = flights.current();
      const instance = inventory.getInstance(flightId);
      if (!instance) return fail(404, 'NOT_FOUND', 'There’s no seat map for this flight.');
      return {
        ok: true,
        value: buildSeatMap(instance, { seed: inventory.seed, now: ctx.businessNow }),
      };
    },

    ancillaryCatalogue() {
      return {
        data: ANCILLARIES.map(toPublicProduct),
        meta: { catalogueVersion: ANCILLARY_CATALOGUE_VERSION },
      };
    },

    ancillaryProduct(productId: string) {
      const product = ANCILLARIES_BY_ID.get(productId);
      return product ? toPublicProduct(product) : null;
    },

    // -----------------------------------------------------------------------
    // Booking steps (private to the session)
    // -----------------------------------------------------------------------

    sessionSeatMap(
      id: string,
      token: string | undefined,
      flightId: string,
      scenario?: Scenario,
    ): RetailingResult<SessionSeatMap> {
      const ctx = context(scenario);
      const found = authorize(id, token, ctx);
      if (!found.ok) return found;
      const session = found.value;
      const trip = tripFor(session, ctx);
      const located = findLeg(trip, flightId);
      if (!located) return fail(404, 'NOT_FOUND', 'This flight isn’t part of your trip.');
      const { leg, segment } = located;
      return {
        ok: true,
        value: {
          seatMap: seatMapFor(segment, session, ctx),
          direction: leg.direction,
          fare: { family: leg.family.code, cabin: leg.family.cabin },
          currency: PRICING_CURRENCY,
          pricing: seatPricing(leg, segment),
          travellers: seatTravellers(session.booking, trip.slots),
          assignments: publicSeats(session.booking, trip).filter(
            (seat) => seat.flightId === flightId,
          ),
        },
      };
    },

    sessionAncillaries(
      id: string,
      token: string | undefined,
      scenario?: Scenario,
    ): RetailingResult<SessionAncillaries> {
      const ctx = context(scenario);
      const found = authorize(id, token, ctx);
      if (!found.ok) return found;
      const trip = tripFor(found.value, ctx);
      return {
        ok: true,
        value: {
          currency: PRICING_CURRENCY,
          offers: ancillaryOffers(trip),
          allowances: baggageAllowances(trip, found.value.booking),
          mealService: trip.legs.flatMap((leg) =>
            leg.segments.map((segment) => mealServiceFor(segment, leg)),
          ),
          catalogueVersion: ANCILLARY_CATALOGUE_VERSION,
        },
      };
    },

    savePassengers(
      id: string,
      token: string | undefined,
      request: { expectedVersion?: number; passengers: Traveller[]; contact: Contact },
      scenario?: Scenario,
    ) {
      return mutateBooking(id, token, request.expectedVersion, scenario, (session, trip) => {
        const blocked = requireFlights(trip);
        if (blocked) return blocked;
        const issues = travellerIssues(request.passengers, {
          slots: trip.slots,
          ...travelDates(trip),
        });
        if (issues.length > 0) {
          const unknown = request.passengers.find(
            (passenger) => !trip.slots.some((slot) => slot.id === passenger.id),
          );
          return {
            ...fail(
              422,
              unknown ? 'TRAVELLER_MISSING' : 'PASSENGERS_INVALID',
              issues[0]!.message,
              issues[0]!.path.join('.'),
            ),
            issues: issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
          };
        }
        const { booking } = session;
        booking.passengers = request.passengers;
        booking.contact = request.contact;
        // A changed infant escort can make an exit row seat ineligible.
        booking.notices = reconcileBooking(booking, trip);
        return null;
      });
    },

    updateSeats(
      id: string,
      token: string | undefined,
      request: UpdateSeatsRequest,
      scenario?: Scenario,
    ) {
      return mutateBooking(id, token, request.expectedVersion, scenario, (session, trip, ctx) => {
        const blocked = requireTravellers(session, trip);
        if (blocked) return blocked;
        const { booking } = session;
        const travellers = new Map(seatTravellers(booking, trip.slots).map((t) => [t.id, t]));
        const seen = new Set<string>();
        for (const [index, change] of request.assignments.entries()) {
          const at = (field: string) => `assignments.${index}.${field}`;
          const traveller = travellers.get(change.travellerId);
          if (!traveller) {
            return fail(
              422,
              'TRAVELLER_MISSING',
              'This traveller isn’t part of your booking.',
              at('travellerId'),
            );
          }
          const located = findLeg(trip, change.flightId);
          if (!located) {
            return fail(
              422,
              'INVALID_SELECTION',
              'This flight isn’t part of your trip.',
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
          booking.seats = booking.seats.filter(
            (seat) =>
              !(seat.travellerId === change.travellerId && seat.flightId === change.flightId),
          );
          if (change.seatId === null) continue;
          const seat = seatOn(seatMapFor(located.segment, session, ctx), change.seatId);
          if (!seat) {
            return fail(
              422,
              'SEAT_INELIGIBLE',
              `There’s no seat ${change.seatId} on this aircraft.`,
              at('seatId'),
            );
          }
          const problem = seatProblem(seat, {
            fareCabin: located.leg.family.cabin,
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
          if (problem)
            return fail(422, 'SEAT_INELIGIBLE', SEAT_PROBLEM_MESSAGES[problem], at('seatId'));
          booking.seats.push({
            travellerId: change.travellerId,
            flightId: change.flightId,
            seatId: seat.id,
          });
        }
        // One traveller per seat, per flight, after every change is applied.
        const taken = new Set<string>();
        for (const seat of booking.seats) {
          const key = `${seat.flightId}|${seat.seatId}`;
          if (taken.has(key)) {
            return fail(
              409,
              'SEAT_UNAVAILABLE',
              `Someone else in your party already has seat ${seat.seatId}.`,
            );
          }
          taken.add(key);
        }
        booking.notices = [];
        return null;
      });
    },

    updateAncillaries(
      id: string,
      token: string | undefined,
      request: { expectedVersion?: number; changes: AncillaryChange[] },
      scenario?: Scenario,
    ) {
      return mutateBooking(id, token, request.expectedVersion, scenario, (session, trip) => {
        const blocked = requireTravellers(session, trip);
        if (blocked) return blocked;
        const { booking } = session;
        if (!booking.progress.seats && !booking.progress.extras) {
          return fail(409, 'BOOKING_STEP_UNAVAILABLE', 'Review your seats before adding extras.');
        }
        const offers = offerIndex(ancillaryOffers(trip));
        const seen = new Set<string>();
        for (const [index, change] of request.changes.entries()) {
          const checked = checkAncillaryChange(change, index, trip, offers);
          if (isFailure(checked)) return checked;
          if (seen.has(checked.slot)) {
            return fail(
              422,
              'INVALID_SELECTION',
              'Choose one option per traveller for each service.',
              `changes.${index}`,
            );
          }
          seen.add(checked.slot);
          booking.ancillaries = booking.ancillaries.filter(
            (selection) => ancillarySlotId(selection) !== checked.slot,
          );
          const add = change.category === 'PRIORITY' ? change.selected : change.productId !== null;
          if (add && change.productId) {
            booking.ancillaries.push({
              productId: change.productId,
              category: change.category,
              travellerId: change.travellerId,
              direction: checked.direction,
              flightId: checked.flightId,
            });
          }
        }
        booking.notices = [];
        return null;
      });
    },

    completeStep(
      id: string,
      token: string | undefined,
      request: CompleteStepRequest,
      scenario?: Scenario,
    ) {
      return mutateBooking(id, token, request.expectedVersion, scenario, (session, trip) => {
        const blocked = requireTravellers(session, trip);
        if (blocked) return blocked;
        const { booking } = session;
        if (request.step === 'extras' && !booking.progress.seats && !booking.progress.extras) {
          return fail(409, 'BOOKING_STEP_UNAVAILABLE', 'Review your seats first.');
        }
        booking.progress[request.step] = true;
        booking.notices = [];
        return null;
      });
    },

    /** The itemised quote and readiness, without re-pricing anything. */
    review(
      id: string,
      token: string | undefined,
      scenario?: Scenario,
    ): RetailingResult<ReviewResponse['data']> {
      const ctx = context(scenario);
      const found = authorize(id, token, ctx);
      if (!found.ok) return found;
      const session = found.value;
      const trip = tripFor(session, ctx);
      if (!trip.complete) {
        return fail(409, 'BOOKING_STEP_UNAVAILABLE', 'Choose your flights and fares first.');
      }
      const view = toPublicSession(session, ctx);
      const review = publicReview(session);
      const ready = review?.current === true && review.status === 'READY';
      return {
        ok: true,
        value: {
          session: view,
          quote: buildQuote(trip, view.booking.seats, view.booking.ancillaries, ctx.now),
          readiness: {
            status: ready ? 'READY' : 'ACTION_REQUIRED',
            issues: review?.current ? review.issues : bookingIssues(session.booking, trip),
          },
        },
      };
    },

    validateBooking,

    /**
     * The final check before an order is created (Milestone 5): the same validation as
     * `validateBooking`, plus what the order snapshot needs that the public session doesn't carry.
     * Synchronous, so the caller can run it inside an inventory exclusion (`AllocationLedger`).
     */
    checkoutCheck(
      id: string,
      token: string | undefined,
      scenario?: Scenario,
    ): RetailingResult<{
      session: ShoppingSession;
      review: BookingReview;
      quote: Quote;
      baggage: TravellerBaggage[];
      orderedOrderId: string | null;
    }> {
      const validated = validateBooking(id, token, undefined, scenario);
      if (!validated.ok) return validated;
      const stored = sessions.get(id)!;
      const ctx = context(scenario);
      return {
        ok: true,
        value: {
          ...validated.value,
          baggage: baggageAllowances(tripFor(stored, ctx), stored.booking),
          orderedOrderId: stored.orderedOrderId,
        },
      };
    },

    /** Remember that this session's trip was booked (no-op if the session is gone). */
    markOrdered(id: string, orderId: string): void {
      const session = sessions.get(id);
      if (!session) return;
      session.orderedOrderId = orderId;
      // Re-set so the change is written through to TalaDB (Milestone 7).
      sessions.set(id, session, clock.now());
    },

    orderedOrderId(id: string): string | null {
      return sessions.get(id)?.orderedOrderId ?? null;
    },

    /** Real time as a request sees it (scenarios shift it): expiry and timestamps. */
    now(scenario?: Scenario): number {
      return context(scenario).now;
    },

    /** Business time as a request sees it: departure-relative rules (see `clock.ts`). */
    businessNow(scenario?: Scenario): number {
      return context(scenario).businessNow;
    },

    /** Pricing inputs as a request sees them, for servicing quotes (Milestone 6). */
    pricingContext(scenario?: Scenario): PricingContext {
      return context(scenario);
    },

    offerValidityMs: config.offerValidityMs,

    deleteSession(id: string, token: string | undefined): RetailingResult<null> {
      const session = sessions.get(id);
      const provided = token ? hashToken(token) : null;
      if (!session || !provided || !timingSafeEqual(provided, session.tokenHash)) {
        return fail(404, 'SESSION_NOT_FOUND', 'This shopping session doesn’t exist.');
      }
      sessions.delete(id);
      return { ok: true, value: null };
    },

    /** For tests and diagnostics: how much is held in memory. */
    stats() {
      return {
        offers: offers.size,
        sessions: sessions.size,
        offersCreated: created.offers,
        sessionsCreated: created.sessions,
      };
    },

    // -----------------------------------------------------------------------
    // Milestone 7: durable shopping sessions
    // -----------------------------------------------------------------------

    /** Receive every session write and removal (the TalaDB write-through). */
    attachSessionListener(listener: StoreListener): void {
      sessions.listener = listener;
    },

    /** The stored form of a session, for writing it to TalaDB; `undefined` once it is gone. */
    storedSession(id: string): StoredSession | undefined {
      return sessions.get(id);
    },

    /**
     * Load sessions read back from TalaDB at startup, newest last, keeping at most
     * `maxSessions`. Returns how many were restored and which (oldest) ones didn't fit.
     */
    restoreSessions(stored: readonly StoredSession[]): { restored: number; dropped: string[] } {
      const ordered = [...stored].sort((a, b) => a.updatedAt - b.updatedAt);
      const keep = ordered.slice(-config.maxSessions);
      for (const session of keep) sessions.restore(session.id, session);
      return {
        restored: keep.length,
        dropped: ordered.slice(0, ordered.length - keep.length).map((session) => session.id),
      };
    },

    /** Drop sessions whose expiry and grace period have passed (the periodic sweep). */
    sweepSessions(now = clock.now()): void {
      sessions.sweep(now);
    },

    /** Sessions are remembered this long after expiry, to answer "expired" not "unknown". */
    sessionGraceMs: EXPIRED_GRACE_MS,
  };

  // Every session-scoped operation sees availability as other guests leave it: this session's
  // own pending checkout hold is excluded, so its own seats never look taken to it.
  if (ledger) {
    for (const name of SESSION_SCOPED_METHODS) {
      const original = service[name] as (...args: unknown[]) => unknown;
      (service as Record<string, unknown>)[name] = (...args: unknown[]) =>
        ledger.withExcludedSession(args[0] as string, () => original(...args));
    }
  }
  return service;
}

/** Methods whose first argument is a shopping session id. */
const SESSION_SCOPED_METHODS = [
  'getSession',
  'select',
  'reprice',
  'sessionSeatMap',
  'sessionAncillaries',
  'savePassengers',
  'updateSeats',
  'updateAncillaries',
  'completeStep',
  'review',
  'validateBooking',
  'checkoutCheck',
] as const;
