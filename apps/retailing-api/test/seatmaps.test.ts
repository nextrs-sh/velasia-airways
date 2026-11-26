import { seatsOf, type SeatMap } from '@velasia/contracts';
import { describe, expect, it } from 'vitest';
import { buildSeatMap } from '../src/booking/seat-map';
import { seatPrice } from '../src/booking/booking';
import { AIRCRAFT } from '../src/fixtures/aircraft';
import { FARE_FAMILIES_BY_CODE } from '../src/fixtures/fare-families';
import { SEAT_LAYOUTS } from '../src/fixtures/seat-layouts';
import { seatsAvailable } from '../src/inventory/inventory';
import { SEED, clock, inventory } from './helpers';

const map = (flightId: string, takenSeatIds?: Set<string>): SeatMap =>
  buildSeatMap(inventory.getInstance(flightId)!, {
    seed: SEED,
    now: clock.businessNow(),
    takenSeatIds,
  });

describe('seat layouts', () => {
  it.each(AIRCRAFT.map((aircraft) => [aircraft.code, aircraft] as const))(
    '%s matches the fleet cabin by cabin',
    (code, aircraft) => {
      const layout = SEAT_LAYOUTS.get(code)!;
      expect(layout.cabins.map((cabin) => [cabin.cabin, cabin.capacity, cabin.layout])).toEqual(
        aircraft.cabins.map((cabin) => [cabin.cabin, cabin.seats, cabin.layout]),
      );
      expect(layout.seats.size).toBe(aircraft.totalSeats);
      const rows = layout.cabins.flatMap((cabin) => cabin.rows.map((row) => row.number));
      expect(rows).not.toContain(13);
      expect(new Set(rows).size).toBe(rows.length);
    },
  );

  it('gives each aircraft its own grid', () => {
    const grids = [...SEAT_LAYOUTS.values()].map((layout) =>
      layout.cabins.map((cabin) => `${cabin.layout}:${cabin.rows.length}`).join('|'),
    );
    expect(new Set(grids).size).toBe(grids.length);
    const a339 = SEAT_LAYOUTS.get('A339')!;
    expect(a339.cabins.map((cabin) => cabin.columns.filter((c) => c === null).length)).toEqual([
      2, 2, 2,
    ]);
    expect(a339.seats.get('1A')).toMatchObject({
      category: 'BUSINESS',
      position: 'window',
      features: expect.arrayContaining(['LIE_FLAT']),
    });
    expect(a339.seats.get('1E')!.position).toBe('aisle');
    // The rear of the A330-900 narrows to 2-3-2; the A321neo's last rows lose their windows.
    expect(a339.seats.has('38B')).toBe(false);
    expect(a339.seats.get('38C')!.position).toBe('aisle');
    expect(SEAT_LAYOUTS.get('A21N')!.seats.get('35B')!.position).toBe('window');
  });

  it('marks cabin boundaries, exit rows, bulkheads, and preferred rows', () => {
    const a21n = SEAT_LAYOUTS.get('A21N')!;
    expect(a21n.seats.get('3F')!.cabin).toBe('business');
    expect(a21n.seats.get('4A')!.cabin).toBe('premium-economy');
    expect(a21n.seats.get('8A')).toMatchObject({
      cabin: 'economy',
      category: 'EXTRA_LEGROOM',
      features: ['BULKHEAD', 'EXTRA_LEGROOM'],
    });
    expect(a21n.seats.get('9C')).toMatchObject({ category: 'PREFERRED', position: 'aisle' });
    expect(a21n.seats.get('24A')).toMatchObject({
      category: 'EXTRA_LEGROOM',
      restrictions: ['EXIT_ROW'],
    });
    expect(a21n.seats.get('23A')!.features).toContain('LIMITED_RECLINE');
    expect(a21n.seats.get('26B')).toMatchObject({
      category: 'STANDARD',
      position: 'middle',
      restrictions: [],
    });
  });
});

describe('seat availability', () => {
  it('agrees with the inventory on every flight of a day, for every cabin', () => {
    const day = [...inventory.allInstances()].filter((instance) => instance.date === '2026-12-15');
    expect(day.length).toBeGreaterThan(50);
    for (const instance of day) {
      const seatMap = buildSeatMap(instance, { seed: SEED, now: clock.businessNow() });
      for (const cabin of seatMap.cabins) {
        const seats = cabin.rows.flatMap((row) => row.seats.filter((seat) => seat !== null));
        expect(seats).toHaveLength(cabin.capacity);
        expect(seats.filter((seat) => seat.status === 'OCCUPIED')).toHaveLength(cabin.occupied);
        expect(cabin.occupied).toBe(instance.cabins.find((c) => c.cabin === cabin.cabin)!.sold);
        if (instance.status === 'scheduled') {
          expect(cabin.available + cabin.blocked).toBe(seatsAvailable(instance, cabin.cabin));
          // Plenty of inventory is never hidden: at most two airport holds.
          expect(cabin.blocked).toBeLessThanOrEqual(2);
        } else {
          expect(cabin.available).toBe(0);
        }
      }
    }
  });

  it('is deterministic and differs between flights', () => {
    const occupied = (m: SeatMap) =>
      seatsOf(m)
        .filter((s) => s.status === 'OCCUPIED')
        .map((s) => s.id);
    expect(occupied(map('NV501-20261215'))).toEqual(occupied(map('NV501-20261215')));
    expect(occupied(map('NV501-20261215'))).not.toEqual(occupied(map('NV501-20261216')));
  });

  it('moves, not adds, a seat taken by someone else', () => {
    const before = map('NV501-20261215');
    const free = seatsOf(before).find((s) => s.status === 'AVAILABLE' && s.cabin === 'economy')!;
    const after = map('NV501-20261215', new Set([free.id]));
    expect(seatsOf(after).find((s) => s.id === free.id)!.status).toBe('OCCUPIED');
    const economy = (m: SeatMap) => m.cabins.find((c) => c.cabin === 'economy')!;
    expect(economy(after).occupied).toBe(economy(before).occupied);
  });

  it('closes every free seat once online sales have closed', () => {
    const instance = inventory.getInstance('NV501-20261215')!;
    const closed = buildSeatMap(instance, { seed: SEED, now: instance.departureUtc });
    expect(seatsOf(closed).every((s) => s.status !== 'AVAILABLE')).toBe(true);
    expect(seatsOf(closed).some((s) => s.unavailableReason === 'flight-closed')).toBe(true);
  });
});

describe('seat prices', () => {
  const family = (code: 'LIGHT' | 'CLASSIC' | 'FLEX' | 'BUSINESS') =>
    FARE_FAMILIES_BY_CODE.get(code)!;

  it('follow the fare family’s included seats and never charge what is included', () => {
    expect(seatPrice('STANDARD', family('LIGHT'), 'short')).toEqual({
      category: 'STANDARD',
      priceMinor: 15_000,
      included: false,
    });
    expect(seatPrice('STANDARD', family('CLASSIC'), 'long')).toMatchObject({
      priceMinor: 0,
      included: true,
    });
    expect(seatPrice('PREFERRED', family('CLASSIC'), 'long')).toMatchObject({
      priceMinor: 85_000,
      included: false,
    });
    expect(seatPrice('PREFERRED', family('FLEX'), 'long')).toMatchObject({
      priceMinor: 0,
      included: true,
    });
    expect(seatPrice('EXTRA_LEGROOM', family('FLEX'), 'medium')).toMatchObject({
      priceMinor: 100_000,
      included: false,
    });
    expect(seatPrice('BUSINESS', family('BUSINESS'), 'long')).toMatchObject({
      priceMinor: 0,
      included: true,
    });
  });
});
