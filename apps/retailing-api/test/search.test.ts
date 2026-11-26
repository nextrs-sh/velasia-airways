import { addDays, departureWindowFor } from '@velasia/contracts';
import { describe, expect, it } from 'vitest';
import { createClock } from '../src/clock';
import { seatsAvailable } from '../src/inventory/inventory';
import { findSellable, searchLeg, sortItineraries } from '../src/search/flight-search';
import {
  CONNECTION_RULES,
  buildCandidates,
  connectionProblem,
  resolveCandidate,
} from '../src/search/itineraries';
import { createFlightService } from '../src/services/flights';
import { SEED, TODAY, clock, inventory, query } from './helpers';

const now = clock.businessNow();
const leg = (overrides: Partial<Parameters<typeof searchLeg>[2]> = {}) =>
  searchLeg(inventory, now, {
    direction: 'outbound',
    origin: 'MNL',
    destination: 'SIN',
    date: '2026-12-15',
    passengers: { adults: 1, children: 0, infants: 0 },
    cabin: 'economy',
    filters: { departureWindows: [], aircraft: [] },
    sort: 'departure_asc',
    page: 1,
    pageSize: 10,
    ...overrides,
  });
const service = createFlightService({ clock, seed: SEED, horizonDays: 120 });

describe('one-way search', () => {
  it('returns only flights on the route and the requested local date', () => {
    const result = leg();
    expect(result.itineraries.length).toBeGreaterThan(0);
    for (const itinerary of result.itineraries) {
      expect(itinerary.origin).toBe('MNL');
      expect(itinerary.destination).toBe('SIN');
      expect(itinerary.departure.date).toBe('2026-12-15');
      expect(itinerary.segments[0]!.departure.airport).toBe('MNL');
      expect(itinerary.segments.at(-1)!.arrival.airport).toBe('SIN');
    }
    expect(result.summary.emptyReason).toBeNull();
  });

  it('reports local times with offsets, so nothing depends on the viewer’s time zone', () => {
    const [first] = leg().itineraries;
    expect(first!.departure).toMatchObject({ time: '08:15', utcOffset: '+08:00' });
    expect(first!.departure.at).toBe('2026-12-15T00:15:00.000Z');
    expect(first!.arrival.utcOffset).toBe('+08:00');
  });

  it('shows overnight arrivals on the next local date', () => {
    const result = leg({ destination: 'NRT', date: '2026-12-17' });
    const redEye = result.itineraries.find((it) => it.segments[0]!.flightNumber === 'NV555')!;
    expect(redEye.departure).toMatchObject({ date: '2026-12-17', time: '23:55' });
    expect(redEye.arrival.date).toBe('2026-12-18');
    expect(redEye.arrival.utcOffset).toBe('+09:00');
  });
});

describe('round-trip search', () => {
  it('returns outbound and inbound legs', () => {
    const result = service.search(
      query({ destination: 'NRT', departureDate: '2026-12-17', returnDate: '2026-12-22' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [outbound, inbound] = result.value.data.legs;
    expect(outbound!.direction).toBe('outbound');
    expect(inbound!).toMatchObject({
      direction: 'inbound',
      origin: 'NRT',
      destination: 'MNL',
      date: '2026-12-22',
    });
    expect(inbound!.itineraries.every((it) => it.departure.date === '2026-12-22')).toBe(true);
  });

  it('only offers returns that leave well after the chosen outbound lands', () => {
    const outboundId = 'NV501-20261215';
    const result = service.search(query({ returnDate: '2026-12-15', leg: 'inbound', outboundId }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const landed = inventory.getInstance(outboundId)!.arrivalUtc;
    const [inbound] = result.value.data.legs;
    expect(inbound!.direction).toBe('inbound');
    for (const itinerary of inbound!.itineraries) {
      expect(Date.parse(itinerary.departure.at)).toBeGreaterThanOrEqual(landed + 120 * 60_000);
    }
  });

  it('rejects an outbound selection that does not belong to the search', () => {
    const result = service.search(
      query({ returnDate: '2026-12-20', outboundId: 'NV101-20261215' }),
    );
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(
      service.search(query({ returnDate: '2026-12-20', outboundId: 'NV9999-20261215' })),
    ).toMatchObject({ ok: false, status: 404 });
  });
});

describe('cabins and capacity', () => {
  it('explains when no flight offers the cabin', () => {
    // Iloilo is served only by A320neos, which have no business cabin.
    expect(leg({ destination: 'ILO', cabin: 'business' }).summary.emptyReason).toBe(
      'cabin-not-offered',
    );
    expect(
      leg({ destination: 'ILO', cabin: 'premium-economy' }).itineraries.length,
    ).toBeGreaterThan(0);
  });

  it('only returns itineraries with a seat for every seated passenger', () => {
    const party = { adults: 6, children: 3, infants: 2 };
    for (const itinerary of leg({ passengers: party }).itineraries) {
      expect(itinerary.seatsAvailable).toBeGreaterThanOrEqual(9);
    }
  });

  it('reports insufficient seats when every flight is too full', () => {
    // Find a day on which no direct MNL→HKG business cabin can seat nine.
    const date = Array.from({ length: 10 }, (_, i) => addDays(TODAY, i)).find((d) => {
      const all = buildCandidates(inventory, 'MNL', 'HKG', d, 0);
      return all.length > 0 && all.every((c) => seatsAvailable(c.segments[0]!, 'business') < 9);
    });
    expect(date).toBeDefined();
    const result = leg({
      destination: 'HKG',
      date: date!,
      cabin: 'business',
      filters: { maxStops: 0, departureWindows: [], aircraft: [] },
      passengers: { adults: 9, children: 0, infants: 0 },
    });
    expect(result.itineraries).toHaveLength(0);
    expect(result.summary.emptyReason).toBe('insufficient-seats');
  });

  it('never sells cancelled flights', () => {
    const cancelled = [...inventory.allInstances()].find((i) => i.status === 'cancelled')!;
    const result = findSellable(inventory, now, {
      origin: cancelled.schedule.origin,
      destination: cancelled.schedule.destination,
      date: cancelled.date,
      cabin: 'economy',
      passengers: { adults: 1, children: 0, infants: 0 },
    });
    expect(result.itineraries.some((it) => it.segments.some((s) => s.id === cancelled.id))).toBe(
      false,
    );
  });

  it('stops selling flights that leave within the sales cutoff', () => {
    const midday = createClock(TODAY).businessNow() + 12 * 3_600_000;
    const result = findSellable(inventory, midday, {
      origin: 'MNL',
      destination: 'CEB',
      date: TODAY,
      cabin: 'economy',
      passengers: { adults: 1, children: 0, infants: 0 },
      maxStops: 0,
    });
    for (const itinerary of result.itineraries) {
      expect(Date.parse(itinerary.departure.at)).toBeGreaterThanOrEqual(midday + 60 * 60_000);
    }
  });
});

describe('empty results are explained', () => {
  it('distinguishes no route, beyond schedule, and no flights that day', () => {
    expect(leg({ origin: 'DPS', destination: 'CGK' }).summary.emptyReason).toBe('no-route');
    expect(leg({ date: addDays(TODAY, 150) }).summary.emptyReason).toBe('beyond-schedule');
    // MNL→DPS operates four days a week.
    const dps = Array.from({ length: 7 }, (_, i) => addDays(TODAY, i)).find(
      (date) => buildCandidates(inventory, 'MNL', 'DPS', date, 1).length === 0,
    )!;
    expect(leg({ destination: 'DPS', date: dps }).summary.emptyReason).toBe('no-flights-on-date');
  });

  it('says when filters removed everything', () => {
    const result = leg({ filters: { departureWindows: ['early-morning'], aircraft: [] } });
    expect(result.summary.emptyReason).toBe('filtered-out');
    expect(result.summary.availableItineraries).toBeGreaterThan(0);
    expect(result.summary.facets.departureWindows.length).toBeGreaterThan(0);
  });
});

describe('filters, sorting, and pagination', () => {
  const busy = { origin: 'ILO', destination: 'SIN', date: '2026-12-16' };

  it('filters by stops, departure window, price, and aircraft', () => {
    expect(leg({ ...busy }).itineraries.every((it) => it.stops === 1)).toBe(true);
    const direct = leg({
      destination: 'HKG',
      filters: { maxStops: 0, departureWindows: [], aircraft: [] },
    });
    expect(direct.itineraries.every((it) => it.stops === 0)).toBe(true);

    const morning = leg({
      destination: 'HKG',
      filters: { departureWindows: ['morning'], aircraft: [] },
    });
    expect(
      morning.itineraries.every((it) => departureWindowFor(it.departure.time) === 'morning'),
    ).toBe(true);

    const all = leg({ destination: 'HKG' });
    const cap = all.summary.facets.price!.minMinor;
    const cheap = leg({
      destination: 'HKG',
      filters: { departureWindows: [], aircraft: [], maxPriceMinor: cap },
    });
    expect(cheap.itineraries.length).toBeGreaterThan(0);
    expect(cheap.itineraries.every((it) => it.price.perAdultMinor <= cap)).toBe(true);

    const a330 = leg({ destination: 'HKG', filters: { departureWindows: [], aircraft: ['A339'] } });
    expect(a330.itineraries.length).toBeGreaterThan(0);
    expect(
      a330.itineraries.every((it) => it.segments.every((s) => s.aircraft.code === 'A339')),
    ).toBe(true);
  });

  it('computes facets before filters so options never disappear', () => {
    const filtered = leg({
      destination: 'HKG',
      filters: { maxStops: 0, departureWindows: ['evening'], aircraft: [] },
    });
    const unfiltered = leg({ destination: 'HKG' });
    expect(filtered.summary.facets).toEqual(unfiltered.summary.facets);
  });

  it('sorts by price, departure, and duration with a stable tie-break', () => {
    const base = leg({ destination: 'HKG', pageSize: 50 }).itineraries;
    const byPrice = sortItineraries(base, 'price_asc').map((it) => it.price.perAdultMinor);
    expect(byPrice).toEqual([...byPrice].sort((a, b) => a - b));
    const late = sortItineraries(base, 'departure_desc').map((it) => it.departure.at);
    expect(late).toEqual([...late].sort().reverse());
    const quick = sortItineraries(base, 'duration_asc').map((it) => it.durationMinutes);
    expect(quick).toEqual([...quick].sort((a, b) => a - b));
    expect(sortItineraries(base, 'price_asc')).toEqual(
      sortItineraries([...base].reverse(), 'price_asc'),
    );
  });

  it('paginates without overlap and reports totals', () => {
    const route = { origin: 'MNL', destination: 'HKG', date: '2026-12-18' };
    const all = leg({ ...route, pageSize: 50 });
    expect(all.pagination.totalItems).toBeGreaterThan(1);
    const first = leg({ ...route, pageSize: 1, page: 1 });
    const second = leg({ ...route, pageSize: 1, page: 2 });
    expect(first.pagination).toMatchObject({
      totalItems: all.pagination.totalItems,
      totalPages: all.pagination.totalItems,
    });
    expect(first.itineraries[0]!.id).not.toBe(second.itineraries[0]!.id);
    const beyond = leg({ ...route, pageSize: 10, page: 99 });
    expect(beyond.itineraries).toHaveLength(0);
    expect(beyond.summary.emptyReason).toBeNull();
  });
});

describe('one-stop connections', () => {
  const itineraries = leg({
    origin: 'DVO',
    destination: 'SIN',
    date: '2026-12-18',
    pageSize: 50,
  }).itineraries;

  it('connect at the same hub airport, in sequence', () => {
    expect(itineraries.length).toBeGreaterThan(0);
    for (const itinerary of itineraries) {
      expect(itinerary.stops).toBe(1);
      const [first, second] = itinerary.segments;
      expect(first!.arrival.airport).toBe(second!.departure.airport);
      expect(['MNL', 'CEB']).toContain(itinerary.connections[0]!.airport);
      expect(Date.parse(second!.departure.at)).toBeGreaterThan(Date.parse(first!.arrival.at));
    }
  });

  it('respect minimum and maximum connection times', () => {
    for (const itinerary of itineraries) {
      const layover = itinerary.connections[0]!.durationMinutes;
      expect(layover).toBeGreaterThanOrEqual(CONNECTION_RULES.minInternationalMinutes);
      expect(layover).toBeLessThanOrEqual(CONNECTION_RULES.maxMinutes);
    }
  });

  it('report the whole journey duration including the connection', () => {
    for (const itinerary of itineraries) {
      const flying = itinerary.segments.reduce((sum, s) => sum + s.durationMinutes, 0);
      expect(itinerary.durationMinutes).toBe(flying + itinerary.connections[0]!.durationMinutes);
    }
  });

  it('reject broken connections', () => {
    const a = inventory.getInstance('NV122-20261215')!; // DVO→MNL
    const intoSin = inventory.getInstance('NV501-20261215')!; // MNL→SIN 08:15, before DVO arrival
    const backToDvo = inventory.getInstance('NV121-20261216')!; // MNL→DVO
    const elsewhere = inventory.getInstance('NV202-20261215')!; // DVO→CEB
    expect(connectionProblem(a, intoSin)).toMatch(/minimum|long/);
    expect(connectionProblem(a, backToDvo)).toMatch(/origin/);
    expect(connectionProblem(a, elsewhere)).toMatch(/same airport/);
    expect(resolveCandidate(inventory, `${a.id}_${elsewhere.id}`)).toBeNull();
  });

  it('are not offered when a hub would mean a long detour', () => {
    // Bali to Jakarta via Manila would fly more than 4× the direct distance.
    expect(buildCandidates(inventory, 'DPS', 'CGK', '2026-12-15', 1)).toHaveLength(0);
  });
});
