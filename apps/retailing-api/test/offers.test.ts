import { offerSchema, SERVICE_ROWS, serviceFor, type PassengerCounts } from '@velasia/contracts';
import { describe, expect, it } from 'vitest';
import { FARE_FAMILIES, FARE_FAMILIES_BY_CODE } from '../src/fixtures/fare-families';
import { BoundedStore } from '../src/offers/bounded-store';
import {
  assertPriceInvariants,
  createOffer,
  evaluateFamilies,
  familyEligibility,
  inventoryVersionFor,
  isExpired,
  offerStatus,
  priceOffer,
  toPublicOffer,
  type PricingContext,
} from '../src/offers/offer-engine';
import { priceItinerary } from '../src/pricing/pricing';
import { resolveCandidate, type Candidate } from '../src/search/itineraries';
import { findSellable } from '../src/search/flight-search';
import { clock, inventory, TODAY } from './helpers';

const ONE_ADULT: PassengerCounts = { adults: 1, children: 0, infants: 0 };
const FAMILY = (code: 'LIGHT' | 'CLASSIC' | 'FLEX' | 'BUSINESS') =>
  FARE_FAMILIES_BY_CODE.get(code)!;
const VALIDITY = 15 * 60_000;
const ctx = (overrides: Partial<PricingContext> = {}): PricingContext => ({
  // Both start at the pinned business midnight; tests move one or the other.
  now: clock.businessNow(),
  businessNow: clock.businessNow(),
  inventoryVersion: inventoryVersionFor(TODAY),
  demandShift: 0,
  soldOut: false,
  ...overrides,
});
const candidate = (id: string): Candidate => {
  const found = resolveCandidate(inventory, id);
  if (!found) throw new Error(`no itinerary ${id}`);
  return found;
};

/** Fixtures from the deterministic test inventory (`SEED`, today 2026-12-01). */
const A21N_MNL_SIN = 'NV501-20261215'; // Business cabin
const A20N_MNL_CEB = 'NV103-20261215'; // Economy and Premium Economy only
const B38M_CRK_CEB = 'NV301-20261215'; // 8 Business seats
const DOMESTIC_A21N = 'NV101-20261215';

describe('fare families', () => {
  it('define four products in order, each listing every comparison row once', () => {
    expect(FARE_FAMILIES.map((family) => family.code)).toEqual([
      'LIGHT',
      'CLASSIC',
      'FLEX',
      'BUSINESS',
    ]);
    for (const family of FARE_FAMILIES) {
      expect(family.services.map((service) => service.code)).toEqual(
        SERVICE_ROWS.map((row) => row.code),
      );
    }
  });

  it('differ meaningfully: baggage, seats, flexibility, and cabin', () => {
    const value = (
      code: Parameters<typeof FAMILY>[0],
      row: (typeof SERVICE_ROWS)[number]['code'],
    ) => serviceFor(FAMILY(code).services, row)!;
    expect(value('LIGHT', 'CHECKED_BAGGAGE').inclusion).toBe('not-included');
    expect(value('CLASSIC', 'CHECKED_BAGGAGE').allowance).toEqual({ pieces: 1, maxWeightKg: 20 });
    expect(value('FLEX', 'CHECKED_BAGGAGE').allowance).toEqual({ pieces: 1, maxWeightKg: 30 });
    expect(value('BUSINESS', 'CHECKED_BAGGAGE').allowance).toEqual({ pieces: 2, maxWeightKg: 32 });
    expect(value('LIGHT', 'STANDARD_SEAT').inclusion).toBe('not-included');
    expect(value('CLASSIC', 'STANDARD_SEAT').inclusion).toBe('included');
    expect(value('FLEX', 'PREFERRED_SEAT').inclusion).toBe('included');
    // Changes always state their cost, never a vague "free changes".
    expect(value('LIGHT', 'FLIGHT_CHANGE')).toMatchObject({
      inclusion: 'fee',
      fee: { amountMinor: 250_000 },
    });
    expect(value('CLASSIC', 'FLIGHT_CHANGE')).toMatchObject({
      inclusion: 'fee',
      fee: { amountMinor: 120_000 },
    });
    expect(value('FLEX', 'FLIGHT_CHANGE').detail).toMatch(/fare difference applies/);
    expect(value('LIGHT', 'REFUND').summary).toBe('Non-refundable');
    expect(FAMILY('BUSINESS').cabin).toBe('business');
    expect(FARE_FAMILIES.filter((family) => family.cabin === 'economy')).toHaveLength(3);
  });

  it('only include a fee where the service is charged for', () => {
    for (const family of FARE_FAMILIES) {
      for (const service of family.services) {
        expect(service.fee !== null, `${family.code} ${service.code}`).toBe(
          service.inclusion === 'fee',
        );
      }
    }
  });
});

describe('fare family eligibility', () => {
  it('offers Business only where every aircraft has a Business cabin', () => {
    expect(
      familyEligibility(candidate(A21N_MNL_SIN), FAMILY('BUSINESS'), ONE_ADULT, ctx()).ok,
    ).toBe(true);
    const economyOnly = familyEligibility(
      candidate(A20N_MNL_CEB),
      FAMILY('BUSINESS'),
      ONE_ADULT,
      ctx(),
    );
    expect(economyOnly).toMatchObject({ ok: false, reason: 'cabin-not-offered' });
    expect(economyOnly.ok ? '' : economyOnly.message).toMatch(/A320neo has no Business cabin/);
    expect(familyEligibility(candidate(A20N_MNL_CEB), FAMILY('LIGHT'), ONE_ADULT, ctx()).ok).toBe(
      true,
    );
  });

  it('withholds a family when its cabin cannot seat the whole party', () => {
    const party = { adults: 9, children: 0, infants: 0 };
    const result = familyEligibility(candidate(B38M_CRK_CEB), FAMILY('BUSINESS'), party, ctx());
    expect(result).toMatchObject({ ok: false, reason: 'insufficient-seats' });
    expect(familyEligibility(candidate(B38M_CRK_CEB), FAMILY('CLASSIC'), party, ctx()).ok).toBe(
      true,
    );
  });

  it('lap infants need no seat', () => {
    const seats = candidate(B38M_CRK_CEB).segments[0]!.cabins.find((c) => c.cabin === 'business')!;
    const left = seats.capacity - seats.sold;
    const party = { adults: left, children: 0, infants: Math.min(left, 3) };
    expect(familyEligibility(candidate(B38M_CRK_CEB), FAMILY('BUSINESS'), party, ctx()).ok).toBe(
      true,
    );
  });

  it('makes nothing available once sales close or the flight is cancelled', () => {
    const flight = candidate(A21N_MNL_SIN);
    const closing = flight.segments[0]!.departureUtc - 30 * 60_000;
    const evaluated = evaluateFamilies(flight, ONE_ADULT, ctx({ businessNow: closing }));
    expect(evaluated.eligible).toEqual([]);
    expect(evaluated.availability).toBe('departed');
    expect(evaluated.unavailable.every((entry) => entry.reason === 'itinerary-unavailable')).toBe(
      true,
    );

    const cancelled = [...inventory.allInstances()].find(
      (instance) => instance.status === 'cancelled',
    )!;
    expect(
      evaluateFamilies({ id: cancelled.id, segments: [cancelled] }, ONE_ADULT, ctx()).availability,
    ).toBe('cancelled');
  });

  it('reports a sold-out itinerary', () => {
    const evaluated = evaluateFamilies(candidate(A21N_MNL_SIN), ONE_ADULT, ctx({ soldOut: true }));
    expect(evaluated.eligible).toEqual([]);
    expect(evaluated.availability).toBe('sold-out');
  });
});

describe('offer pricing', () => {
  it('prices Light exactly at the indicative search price, so "from" prices hold', () => {
    const sellable = findSellable(inventory, clock.businessNow(), {
      origin: 'DVO',
      destination: 'SIN',
      date: '2026-12-15',
      passengers: { adults: 2, children: 1, infants: 1 },
      cabin: 'economy',
    }).itineraries;
    const more = ['MNL-CEB', 'MNL-NRT', 'CEB-HKG'].flatMap((route) => {
      const [origin, destination] = route.split('-') as [string, string];
      return findSellable(inventory, clock.businessNow(), {
        origin,
        destination,
        date: '2026-12-18',
        passengers: ONE_ADULT,
        cabin: 'economy',
      }).itineraries;
    });
    expect(sellable.some((itinerary) => itinerary.stops === 1)).toBe(true);
    for (const itinerary of [...sellable, ...more]) {
      const segments = resolveCandidate(inventory, itinerary.id)!.segments;
      const passengers = itinerary.price.breakdown.reduce(
        (counts, item) => ({
          ...counts,
          [{ adult: 'adults', child: 'children', infant: 'infants' }[item.passengerType]]:
            item.count,
        }),
        { adults: 0, children: 0, infants: 0 },
      );
      const light = priceOffer(segments, FAMILY('LIGHT'), passengers);
      expect(light.totalMinor, itinerary.id).toBe(
        priceItinerary(segments, 'economy', passengers).totalMinor,
      );
      expect(light.perAdultMinor).toBe(itinerary.price.perAdultMinor);
    }
  });

  it('orders the economy families Light < Classic < Flex, with the difference in the family component', () => {
    for (const id of [A21N_MNL_SIN, A20N_MNL_CEB, DOMESTIC_A21N]) {
      const segments = candidate(id).segments;
      const [light, classic, flex] = (['LIGHT', 'CLASSIC', 'FLEX'] as const).map((code) =>
        priceOffer(segments, FAMILY(code), ONE_ADULT),
      );
      expect(light!.totalMinor).toBeLessThan(classic!.totalMinor);
      expect(classic!.totalMinor).toBeLessThan(flex!.totalMinor);
      expect(light!.totals.fareFamilyMinor).toBe(0);
      expect(classic!.totals.baseFareMinor).toBe(light!.totals.baseFareMinor);
    }
  });

  it('matches the documented formula for MNL → SIN Classic (international, no VAT)', () => {
    const price = priceOffer(candidate(A21N_MNL_SIN).segments, FAMILY('CLASSIC'), ONE_ADULT);
    const [adult] = price.passengers;
    // MNL–SIN is a medium-distance route: Classic = round10(base × 12% + ₱450).
    expect(adult!.baseFareMinor).toBe(614_000);
    expect(adult!.fareFamilyMinor).toBe(Math.round((6140 * 0.12 + 450) / 10) * 10 * 100);
    expect(adult!.taxes.map((tax) => tax.code)).toEqual(['PASSENGER_SERVICE', 'FUEL_SURCHARGE']);
    expect(adult!.taxesMinor).toBe(95_000 + 45_000);
    expect(price.totalMinor).toBe(
      adult!.baseFareMinor + adult!.fareFamilyMinor + adult!.taxesMinor,
    );
  });

  it('charges domestic VAT on the whole fare, including the family component', () => {
    const price = priceOffer(candidate(DOMESTIC_A21N).segments, FAMILY('FLEX'), ONE_ADULT);
    const [adult] = price.passengers;
    const vat = adult!.taxes.find((tax) => tax.code === 'VAT')!;
    const fare = (adult!.baseFareMinor + adult!.fareFamilyMinor) / 100;
    expect(vat.amountMinor).toBe(Math.round(fare * 0.12) * 100);
  });

  it('accounts for every passenger: children at 75%, lap infants at 10% with no charges', () => {
    const party = { adults: 2, children: 1, infants: 1 };
    const price = priceOffer(candidate(A21N_MNL_SIN).segments, FAMILY('CLASSIC'), party);
    const line = (type: string) => price.passengers.find((p) => p.passengerType === type)!;
    expect(price.passengers.map((p) => [p.passengerType, p.count])).toEqual([
      ['adult', 2],
      ['child', 1],
      ['infant', 1],
    ]);
    expect(line('child').baseFareMinor).toBe(Math.round((6140 * 0.75) / 10) * 10 * 100);
    expect(line('infant').taxesMinor).toBe(0);
    expect(line('infant').taxes).toEqual([]);
    expect(price.totalMinor).toBe(
      price.passengers.reduce((sum, p) => sum + p.count * p.unitTotalMinor, 0),
    );
    expect(price.totalMinor).toBe(
      price.totals.baseFareMinor + price.totals.fareFamilyMinor + price.totals.taxesMinor,
    );
  });

  it('rounds deterministically: fares to ₱10, everything in whole minor units', () => {
    for (const code of ['LIGHT', 'CLASSIC', 'FLEX', 'BUSINESS'] as const) {
      const price = priceOffer(candidate(A21N_MNL_SIN).segments, FAMILY(code), {
        adults: 3,
        children: 2,
        infants: 1,
      });
      for (const line of price.passengers) {
        expect(line.baseFareMinor % 1000).toBe(0);
        expect(line.fareFamilyMinor % 1000).toBe(0);
        expect(Number.isInteger(line.taxesMinor)).toBe(true);
      }
    }
  });

  it('is deterministic for the same inputs and changes only when demand does', () => {
    const segments = candidate(A21N_MNL_SIN).segments;
    const a = priceOffer(segments, FAMILY('FLEX'), ONE_ADULT);
    const b = priceOffer(segments, FAMILY('FLEX'), ONE_ADULT);
    expect(a).toEqual(b);
    const busier = priceOffer(segments, FAMILY('FLEX'), ONE_ADULT, 1);
    expect(busier.totalMinor).toBeGreaterThan(a.totalMinor);
  });

  it('round-trip totals are exactly the sum of the two directions', () => {
    const out = priceOffer(candidate(A21N_MNL_SIN).segments, FAMILY('CLASSIC'), ONE_ADULT);
    const back = priceOffer(candidate('NV502-20261220').segments, FAMILY('FLEX'), ONE_ADULT);
    // No per-booking charge exists, so nothing can be counted twice.
    expect(out.totalMinor + back.totalMinor).toBe(
      out.totals.baseFareMinor +
        out.totals.fareFamilyMinor +
        out.totals.taxesMinor +
        back.totals.baseFareMinor +
        back.totals.fareFamilyMinor +
        back.totals.taxesMinor,
    );
  });

  it('rejects impossible prices', () => {
    const price = priceOffer(candidate(A21N_MNL_SIN).segments, FAMILY('LIGHT'), ONE_ADULT);
    expect(() => assertPriceInvariants({ ...price, totalMinor: -1 })).toThrow(/negative/);
    expect(() => assertPriceInvariants({ ...price, totalMinor: price.totalMinor + 1 })).toThrow(
      /add up/,
    );
    expect(() => assertPriceInvariants({ ...price, perAdultMinor: 10.5 })).toThrow();
  });
});

describe('offer lifecycle', () => {
  const offer = () =>
    createOffer(candidate(A21N_MNL_SIN), FAMILY('CLASSIC'), ONE_ADULT, ctx(), VALIDITY);

  it('creates an opaque, time-limited offer that matches the public contract', () => {
    const created = offer();
    expect(created.id).toMatch(/^off_[A-Za-z0-9_-]{22}$/);
    expect(created.id).not.toContain('NV501');
    expect(offer().id).not.toBe(created.id);
    expect(created.expiresAt - created.createdAt).toBe(VALIDITY);
    const dto = offerSchema.parse(toPublicOffer(created, 'AVAILABLE'));
    expect(dto).toMatchObject({ family: 'CLASSIC', cabin: 'economy', itineraryId: A21N_MNL_SIN });
    expect(dto.flightIds).toEqual([A21N_MNL_SIN]);
    expect(JSON.stringify(dto)).not.toMatch(/component|projectedLoad|"sold"|seed/);
  });

  it('moves AVAILABLE → EXPIRED at its expiry and when the inventory snapshot changes', () => {
    const created = offer();
    const flight = candidate(A21N_MNL_SIN);
    expect(offerStatus(created, flight, ctx())).toBe('AVAILABLE');
    expect(offerStatus(created, flight, ctx({ now: created.expiresAt - 1 }))).toBe('AVAILABLE');
    expect(offerStatus(created, flight, ctx({ now: created.expiresAt }))).toBe('EXPIRED');
    expect(isExpired(created, ctx({ inventoryVersion: inventoryVersionFor('2026-12-02') }))).toBe(
      true,
    );
  });

  it('becomes UNAVAILABLE when its flights can no longer be sold', () => {
    const created = offer();
    expect(offerStatus(created, candidate(A21N_MNL_SIN), ctx({ soldOut: true }))).toBe(
      'UNAVAILABLE',
    );
    expect(offerStatus(created, null, ctx())).toBe('UNAVAILABLE');
  });
});

describe('bounded store', () => {
  const store = () =>
    new BoundedStore<{ expiresAt: number }>({
      maxEntries: 3,
      graceMs: 100,
      expiresAt: (value) => value.expiresAt,
      sweepIntervalMs: 0,
    });

  it('never grows past its cap, evicting the least recently written', () => {
    const s = store();
    for (let i = 0; i < 10; i += 1) s.set(`k${i}`, { expiresAt: 1_000_000 }, 0);
    expect(s.size).toBe(3);
    expect(s.get('k0')).toBeUndefined();
    expect(s.get('k9')).toBeDefined();
  });

  it('drops expired entries after the grace period', () => {
    const s = store();
    s.set('old', { expiresAt: 1000 }, 0);
    s.set('new', { expiresAt: 5000 }, 1050);
    expect(s.get('old')).toBeDefined();
    s.set('newer', { expiresAt: 5000 }, 1100);
    expect(s.get('old')).toBeUndefined();
    expect(s.get('new')).toBeDefined();
  });
});
