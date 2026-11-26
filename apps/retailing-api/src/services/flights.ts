import {
  totalSeated,
  type AvailabilityResponse,
  type FareCalendarQuery,
  type FareCalendarResponse,
  type FlightSearchQuery,
  type FlightSearchResponse,
  type InventoryMeta,
  type ItineraryAvailability,
  type ItineraryQuery,
  type ItineraryResponse,
  type LegResult,
  type NetworkRoute,
  type RouteListQuery,
} from '@velasia/contracts';
import type { Clock } from '../clock';
import { AIRCRAFT, AIRCRAFT_BY_CODE } from '../fixtures/aircraft';
import { Inventory, cabinInventory, seatsAvailable } from '../inventory/inventory';
import type { AllocationLedger } from '../inventory/ledger';
import { PRICING_CURRENCY, priceItinerary } from '../pricing/pricing';
import { fareCalendar } from '../search/calendar';
import { SALES_CUTOFF_MINUTES, searchLeg } from '../search/flight-search';
import { resolveCandidate } from '../search/itineraries';
import { toItinerary } from '../serialization';

export interface FlightServiceOptions {
  clock: Clock;
  seed: string;
  horizonDays: number;
  /** Seats taken by orders; see `inventory/ledger.ts`. */
  ledger?: AllocationLedger;
}

/** Minimum time between the outbound landing and the inbound departing on a round trip. */
export const MIN_STAY_MINUTES = 120;
const ONE_ADULT = { adults: 1, children: 0, infants: 0 };

export type ServiceResult<T> =
  { ok: true; value: T } | { ok: false; status: 400 | 404; message: string; path?: string };

const fail = (status: 400 | 404, message: string, path?: string) =>
  ({ ok: false, status, message, path }) as const;

export type FlightService = ReturnType<typeof createFlightService>;

/**
 * Flight inventory, search, and pricing behind the HTTP routes. The inventory
 * is generated once per reference date (at startup, and again only when the
 * airline's calendar day changes) and reused by every request.
 */
export function createFlightService({ clock, seed, horizonDays, ledger }: FlightServiceOptions) {
  let inventory: Inventory | undefined;
  const lowestFareCache = new Map<string, number | null>();

  function current(): Inventory {
    const today = clock.today();
    if (inventory?.referenceDate !== today) {
      inventory = new Inventory({ referenceDate: today, seed, horizonDays, ledger });
    }
    return inventory;
  }

  function meta(inv = current()): InventoryMeta {
    return {
      currency: PRICING_CURRENCY,
      priceKind: 'indicative',
      referenceDate: inv.referenceDate,
      scheduleEndDate: inv.scheduleEndDate,
    };
  }

  return {
    current,
    meta,

    search(query: FlightSearchQuery): ServiceResult<FlightSearchResponse> {
      const inv = current();
      const now = clock.businessNow();
      const shared = {
        passengers: query.passengers,
        cabin: query.cabin,
        filters: query.filters,
        sort: query.sort,
        page: query.page,
        pageSize: query.pageSize,
      };

      let inboundNotBefore: number | undefined;
      if (query.outboundId) {
        const outbound = resolveCandidate(inv, query.outboundId);
        if (!outbound)
          return fail(404, 'The selected outbound flight no longer exists.', 'outboundId');
        const first = outbound.segments[0]!;
        const last = outbound.segments.at(-1)!;
        if (
          first.schedule.origin !== query.origin ||
          last.schedule.destination !== query.destination ||
          first.date !== query.departureDate
        ) {
          return fail(
            400,
            'outboundId does not match this route and departure date.',
            'outboundId',
          );
        }
        inboundNotBefore = last.arrivalUtc + MIN_STAY_MINUTES * 60_000;
      }

      const legs: LegResult[] = [];
      if (query.leg !== 'inbound') {
        legs.push(
          searchLeg(inv, now, {
            ...shared,
            direction: 'outbound',
            origin: query.origin,
            destination: query.destination,
            date: query.departureDate,
          }),
        );
      }
      if (query.returnDate && query.leg !== 'outbound') {
        legs.push(
          searchLeg(inv, now, {
            ...shared,
            direction: 'inbound',
            origin: query.destination,
            destination: query.origin,
            date: query.returnDate,
            notBeforeUtc: inboundNotBefore,
          }),
        );
      }
      return { ok: true, value: { data: { legs }, meta: meta(inv) } };
    },

    itinerary(id: string, query: ItineraryQuery): ServiceResult<ItineraryResponse> {
      const inv = current();
      const candidate = resolveCandidate(inv, id);
      if (!candidate) return fail(404, `No flight or itinerary found for "${id}".`);
      if (candidate.segments.some((segment) => !cabinInventory(segment, query.cabin))) {
        return fail(400, `This itinerary doesn't offer ${query.cabin} seats.`, 'cabin');
      }
      const itinerary = toItinerary(candidate, query.cabin, query.passengers);
      const first = candidate.segments[0]!;
      const minSeats = Math.min(...candidate.segments.map((s) => seatsAvailable(s, query.cabin)));
      let availability: ItineraryAvailability = 'available';
      if (candidate.segments.some((segment) => segment.status === 'cancelled')) {
        availability = 'cancelled';
      } else if (first.departureUtc < clock.businessNow() + SALES_CUTOFF_MINUTES * 60_000) {
        availability = 'departed';
      } else if (minSeats === 0) availability = 'sold-out';
      else if (minSeats < totalSeated(query.passengers)) availability = 'insufficient-seats';
      return { ok: true, value: { data: { ...itinerary, availability }, meta: meta(inv) } };
    },

    availability(id: string): ServiceResult<AvailabilityResponse> {
      const inv = current();
      const candidate = resolveCandidate(inv, id);
      if (!candidate) return fail(404, `No flight or itinerary found for "${id}".`);
      return {
        ok: true,
        value: {
          data: {
            id,
            segments: candidate.segments.map((segment) => {
              const aircraft = AIRCRAFT_BY_CODE.get(segment.schedule.aircraftCode)!;
              return {
                id: segment.id,
                flightNumber: segment.schedule.flightNumber,
                status: segment.status,
                aircraft: { code: aircraft.code, name: aircraft.name },
                cabins: segment.cabins.map((cabin) => ({
                  cabin: cabin.cabin,
                  capacity: cabin.capacity,
                  available: seatsAvailable(segment, cabin.cabin),
                })),
              };
            }),
          },
          meta: meta(inv),
        },
      };
    },

    calendar(query: FareCalendarQuery): FareCalendarResponse {
      const inv = current();
      return { data: fareCalendar(inv, clock.businessNow(), query), meta: meta(inv) };
    },

    routes(filter: RouteListQuery = {}): NetworkRoute[] {
      return current().routes.filter(
        (route) =>
          (filter.from === undefined || route.origin === filter.from) &&
          (filter.to === undefined || route.destination === filter.to),
      );
    },

    aircraft() {
      return [...AIRCRAFT];
    },

    /**
     * Lowest direct economy fare for one adult across the published schedule,
     * for marketing "from" prices. Memoised per inventory.
     */
    lowestFare(origin: string, destination: string): number | null {
      const inv = current();
      const key = `${inv.referenceDate}|${origin}|${destination}`;
      const cached = lowestFareCache.get(key);
      if (cached !== undefined) return cached;
      // Same rules as a one-adult, direct, economy search on each date — without
      // building full itineraries for every day of the horizon.
      const cutoff = clock.businessNow() + SALES_CUTOFF_MINUTES * 60_000;
      let lowest: number | null = null;
      for (const instance of inv.onRoute(origin, destination)) {
        if (instance.departureUtc < cutoff || seatsAvailable(instance, 'economy') < 1) continue;
        const price = priceItinerary([instance], 'economy', ONE_ADULT).perAdultMinor;
        if (lowest === null || price < lowest) lowest = price;
      }
      if (lowestFareCache.size > 500) lowestFareCache.clear();
      lowestFareCache.set(key, lowest);
      return lowest;
    },
  };
}
