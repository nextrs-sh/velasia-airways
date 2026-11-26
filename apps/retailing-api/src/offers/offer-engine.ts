import { randomBytes } from 'node:crypto';
import {
  CABIN_LABELS,
  FARE_FAMILY_ORDER,
  totalSeated,
  type FamilyUnavailableReason,
  type ItineraryAvailability,
  type Offer,
  type OfferItinerary,
  type OfferPassengerPrice,
  type OfferPrice,
  type OfferStatus,
  type PassengerCounts,
} from '@velasia/contracts';
import { AIRCRAFT_BY_CODE } from '../fixtures/aircraft';
import { FARE_FAMILIES_BY_CODE, type FareFamilyDefinition } from '../fixtures/fare-families';
import { cabinInventory, seatsAvailable, type FlightInstance } from '../inventory/inventory';
import {
  MINOR_PER_PESO,
  PASSENGER_TYPES,
  PRICING_CURRENCY,
  pricePassengerType,
} from '../pricing/pricing';
import { SALES_CUTOFF_MINUTES } from '../search/flight-search';
import type { Candidate } from '../search/itineraries';
import { toItinerary } from '../serialization';

/*
 * The offer engine: which fare families can be sold on an itinerary, what each costs, and
 * the offer object that binds the two for a limited time. Pure functions of the inventory,
 * the reference time, and the pricing rules — the HTTP layer and the stores sit elsewhere.
 */

/**
 * Bumped whenever a pricing rule or a fare family component changes, so an offer priced under
 * old rules is never confused with a current one.
 */
export const PRICING_VERSION = '2026-11.m3';

/** Inventory snapshot an offer was priced against: the inventory is rebuilt once per day. */
export function inventoryVersionFor(referenceDate: string): string {
  return `inv-${referenceDate.replaceAll('-', '')}`;
}

/** Inputs that shape a price beyond the itinerary and the party. */
export interface PricingContext {
  /** Real time, epoch ms: offer validity and every timestamp (see `clock.ts`). */
  now: number;
  /** Business time, epoch ms: sales cut-off and departure rules (pinned by `VELASIA_TODAY`). */
  businessNow: number;
  inventoryVersion: string;
  /** Simulated demand change in bands (test scenarios only; 0 otherwise). */
  demandShift: number;
  /** Simulated sell-out of the selected flights (test scenarios only). */
  soldOut: boolean;
  /** Simulated: the session's chosen seats were taken by others (test scenarios only). */
  seatTaken?: boolean;
}

/** An offer as the API keeps it. Times are epoch milliseconds. */
export interface StoredOffer {
  id: string;
  itineraryId: string;
  flightIds: string[];
  family: FareFamilyDefinition;
  passengers: PassengerCounts;
  itinerary: OfferItinerary;
  price: OfferPrice;
  createdAt: number;
  expiresAt: number;
  inventoryVersion: string;
  pricingVersion: string;
}

export function newOfferId(): string {
  return `off_${randomBytes(16).toString('base64url')}`;
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export type Eligibility =
  { ok: true } | { ok: false; reason: FamilyUnavailableReason; message: string };

/** Whether the itinerary as a whole can still be sold (status and sales cut-off). */
export function itineraryProblem(
  candidate: Candidate,
  now: number,
): Exclude<ItineraryAvailability, 'available' | 'sold-out' | 'insufficient-seats'> | null {
  if (candidate.segments.some((segment) => segment.status === 'cancelled')) return 'cancelled';
  if (candidate.segments[0]!.departureUtc < now + SALES_CUTOFF_MINUTES * 60_000) return 'departed';
  return null;
}

const ITINERARY_MESSAGES = {
  cancelled: 'A flight in this journey has been cancelled.',
  departed: 'Online sales for this flight have closed.',
} as const;

function aircraftName(segment: FlightInstance) {
  return AIRCRAFT_BY_CODE.get(segment.schedule.aircraftCode)?.name ?? 'this aircraft';
}

/** Can this family be sold on this itinerary, now, for this party? */
export function familyEligibility(
  candidate: Candidate,
  family: FareFamilyDefinition,
  passengers: PassengerCounts,
  context: Pick<PricingContext, 'now' | 'businessNow' | 'soldOut'>,
): Eligibility {
  const problem = itineraryProblem(candidate, context.businessNow);
  if (problem) {
    return { ok: false, reason: 'itinerary-unavailable', message: ITINERARY_MESSAGES[problem] };
  }
  const cabin = CABIN_LABELS[family.cabin];
  const withoutCabin = candidate.segments.find((segment) => !cabinInventory(segment, family.cabin));
  if (withoutCabin) {
    return {
      ok: false,
      reason: 'cabin-not-offered',
      message:
        candidate.segments.length > 1
          ? `${family.name} needs a ${cabin} cabin on every flight; the ${aircraftName(withoutCabin)} on this journey doesn’t have one.`
          : `${family.name} isn’t offered on this flight: the ${aircraftName(withoutCabin)} has no ${cabin} cabin.`,
    };
  }
  const seats = context.soldOut
    ? 0
    : Math.min(...candidate.segments.map((segment) => seatsAvailable(segment, family.cabin)));
  const needed = totalSeated(passengers);
  if (seats < needed) {
    return {
      ok: false,
      reason: 'insufficient-seats',
      message:
        seats === 0
          ? `${cabin} is sold out on this flight.`
          : `Only ${seats} ${cabin} ${seats === 1 ? 'seat is' : 'seats are'} left, not enough for ${needed} travellers.`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * Price one fare family for an itinerary and a party. Every amount is an integer in minor
 * units; per-passenger amounts are rounded once (to ₱10 for fares, ₱1 for VAT) and then only
 * multiplied and added, so totals are exact and deterministic.
 */
export function priceOffer(
  segments: readonly FlightInstance[],
  family: FareFamilyDefinition,
  passengers: PassengerCounts,
  demandShift = 0,
): OfferPrice {
  const lines: OfferPassengerPrice[] = PASSENGER_TYPES.filter(([, key]) => passengers[key] > 0).map(
    ([type, key]) => {
      const priced = pricePassengerType(
        segments,
        family.cabin,
        type,
        family.component,
        demandShift,
      );
      const baseFareMinor = priced.baseFare * MINOR_PER_PESO;
      const fareFamilyMinor = priced.fareComponent * MINOR_PER_PESO;
      const taxesMinor = priced.charges.reduce((sum, charge) => sum + charge.amountMinor, 0);
      const unitTotalMinor = baseFareMinor + fareFamilyMinor + taxesMinor;
      return {
        passengerType: type,
        count: passengers[key],
        baseFareMinor,
        fareFamilyMinor,
        taxesMinor,
        taxes: priced.charges,
        unitTotalMinor,
        subtotalMinor: passengers[key] * unitTotalMinor,
      };
    },
  );
  const sum = (pick: (line: OfferPassengerPrice) => number) =>
    lines.reduce((total, line) => total + line.count * pick(line), 0);
  const price: OfferPrice = {
    currency: PRICING_CURRENCY,
    totalMinor: lines.reduce((total, line) => total + line.subtotalMinor, 0),
    perAdultMinor: lines.find((line) => line.passengerType === 'adult')?.unitTotalMinor ?? 0,
    totals: {
      baseFareMinor: sum((line) => line.baseFareMinor),
      fareFamilyMinor: sum((line) => line.fareFamilyMinor),
      taxesMinor: sum((line) => line.taxesMinor),
    },
    passengers: lines,
  };
  assertPriceInvariants(price);
  return price;
}

/** Guards the money rules: integers, never negative, components add up to the total. */
export function assertPriceInvariants(price: OfferPrice): void {
  const amounts = [
    price.totalMinor,
    price.perAdultMinor,
    ...Object.values(price.totals),
    ...price.passengers.flatMap((line) => [
      line.baseFareMinor,
      line.fareFamilyMinor,
      line.taxesMinor,
      line.unitTotalMinor,
      line.subtotalMinor,
    ]),
  ];
  if (amounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0)) {
    throw new Error('Offer price has a negative or non-integer amount.');
  }
  const { baseFareMinor, fareFamilyMinor, taxesMinor } = price.totals;
  if (baseFareMinor + fareFamilyMinor + taxesMinor !== price.totalMinor) {
    throw new Error('Offer price components do not add up to the total.');
  }
}

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

export function createOffer(
  candidate: Candidate,
  family: FareFamilyDefinition,
  passengers: PassengerCounts,
  context: PricingContext,
  validityMs: number,
): StoredOffer {
  return {
    id: newOfferId(),
    itineraryId: candidate.id,
    flightIds: candidate.segments.map((segment) => segment.id),
    family,
    passengers: { ...passengers },
    itinerary: offerItinerary(candidate, family.cabin, passengers),
    price: priceOffer(candidate.segments, family, passengers, context.demandShift),
    createdAt: context.now,
    expiresAt: context.now + validityMs,
    inventoryVersion: context.inventoryVersion,
    pricingVersion: PRICING_VERSION,
  };
}

export interface FamilyAvailability {
  /** Families that can be sold, in display order. */
  eligible: FareFamilyDefinition[];
  unavailable: { family: FareFamilyDefinition; reason: FamilyUnavailableReason; message: string }[];
  availability: ItineraryAvailability;
}

/** Every family in display order: which can be sold on this itinerary, and why not otherwise. */
export function evaluateFamilies(
  candidate: Candidate,
  passengers: PassengerCounts,
  context: Pick<PricingContext, 'now' | 'businessNow' | 'soldOut'>,
): FamilyAvailability {
  const result: FamilyAvailability = { eligible: [], unavailable: [], availability: 'available' };
  for (const code of FARE_FAMILY_ORDER) {
    const family = FARE_FAMILIES_BY_CODE.get(code)!;
    const eligibility = familyEligibility(candidate, family, passengers, context);
    if (eligibility.ok) result.eligible.push(family);
    else
      result.unavailable.push({ family, reason: eligibility.reason, message: eligibility.message });
  }
  if (result.eligible.length === 0) {
    // Seats left on the fullest flight, in whichever of its cabins has the most.
    const seatsLeft = context.soldOut
      ? 0
      : Math.min(
          ...candidate.segments.map((segment) =>
            Math.max(...segment.cabins.map((cabin) => seatsAvailable(segment, cabin.cabin))),
          ),
        );
    result.availability =
      itineraryProblem(candidate, context.businessNow) ??
      (seatsLeft === 0 ? 'sold-out' : 'insufficient-seats');
  }
  return result;
}

/** The itinerary as shown with offers: schedule and flights, without an indicative price. */
export function offerItinerary(
  candidate: Candidate,
  cabin: FareFamilyDefinition['cabin'],
  passengers: PassengerCounts,
): OfferItinerary {
  const { price: _indicative, ...itinerary } = toItinerary(candidate, cabin, passengers);
  return itinerary;
}

/** The offer's status at `now`. Offers are immutable; only their status is derived. */
export function offerStatus(
  offer: StoredOffer,
  candidate: Candidate | null,
  context: Pick<PricingContext, 'now' | 'businessNow' | 'soldOut' | 'inventoryVersion'>,
): OfferStatus {
  if (isExpired(offer, context)) return 'EXPIRED';
  if (!candidate) return 'UNAVAILABLE';
  return familyEligibility(candidate, offer.family, offer.passengers, context).ok
    ? 'AVAILABLE'
    : 'UNAVAILABLE';
}

/** Past its validity, or priced against an inventory snapshot that has since been replaced. */
export function isExpired(
  offer: Pick<StoredOffer, 'expiresAt' | 'inventoryVersion'>,
  context: Pick<PricingContext, 'now' | 'inventoryVersion'>,
): boolean {
  return context.now >= offer.expiresAt || offer.inventoryVersion !== context.inventoryVersion;
}

/** Public DTO. Internal pricing components never leave the API. */
export function toPublicOffer(offer: StoredOffer, status: OfferStatus): Offer {
  return {
    id: offer.id,
    itineraryId: offer.itineraryId,
    flightIds: offer.flightIds,
    family: offer.family.code,
    cabin: offer.family.cabin,
    passengers: offer.passengers,
    itinerary: offer.itinerary,
    services: offer.family.services,
    price: offer.price,
    status,
    createdAt: new Date(offer.createdAt).toISOString(),
    expiresAt: new Date(offer.expiresAt).toISOString(),
    inventoryVersion: offer.inventoryVersion,
    pricingVersion: offer.pricingVersion,
  };
}
