import type { Seat, SeatMap, SeatMapCabin } from '@velasia/contracts';
import { AIRCRAFT_BY_CODE } from '../fixtures/aircraft';
import { LAYOUT_VERSION, SEAT_LAYOUTS, type SeatTemplate } from '../fixtures/seat-layouts';
import { hashToUnit } from '../inventory/hash';
import { cabinInventory, type FlightInstance } from '../inventory/inventory';
import { SALES_CUTOFF_MINUTES } from '../search/flight-search';

/*
 * Seat availability for one dated flight, derived from its inventory:
 *
 * - Exactly `sold` seats of each cabin are `OCCUPIED`, so the seat map and the inventory always
 *   agree. Which seats are taken is deterministic per flight (a seeded hash, biased towards the
 *   front, windows, and aisles, which sell first), so the map never changes between requests.
 * - On flights with plenty of room, two Economy seats are `UNAVAILABLE` because they are held
 *   for the airport to assign. They still count as seats left in the inventory: they are
 *   sellable, just not choosable in advance. Every other free seat is `AVAILABLE`.
 * - On a cancelled flight, or once online sales have closed, every free seat is `UNAVAILABLE`.
 *
 * - Seats held or committed by orders (Milestone 5, `inventory/ledger.ts`) are `OCCUPIED` too:
 *   a seat an order chose is always shown as taken, and seats held for travellers without a
 *   chosen seat take the least wanted free seats, so the map still matches the inventory.
 *
 * Choosing a seat during the booking steps never changes availability; only an order's hold
 * does (see `seatmaps.ts` in the contracts).
 */

/** Economy seats held for airport assignment, when at least `HOLD_THRESHOLD` are free. */
const AIRPORT_HOLDS = 2;
const HOLD_THRESHOLD = 24;

export interface SeatMapOptions {
  seed: string;
  /** Business time (`clock.businessNow()`): the seat map closes at the sales cut-off. */
  now: number;
  /** Test scenario: seats that other travellers have just taken (moved, not added). */
  takenSeatIds?: ReadonlySet<string>;
}

function demandScore(seat: SeatTemplate, rowIndex: number, rowCount: number, unit: number) {
  const front = 1 - rowIndex / Math.max(1, rowCount - 1);
  const position = seat.position === 'middle' ? 0 : 0.12;
  return unit * 0.7 + front * 0.18 + position;
}

export function buildSeatMap(instance: FlightInstance, options: SeatMapOptions): SeatMap {
  const { schedule } = instance;
  const layout = SEAT_LAYOUTS.get(schedule.aircraftCode)!;
  const aircraft = AIRCRAFT_BY_CODE.get(schedule.aircraftCode)!;
  const closed =
    instance.status !== 'scheduled' ||
    instance.departureUtc < options.now + SALES_CUTOFF_MINUTES * 60_000;
  const unit = (key: string) => hashToUnit(options.seed, `${instance.id}:seat:${key}`);

  const occupancy = instance.ledger?.occupancy(instance.id);
  const cabins = layout.cabins.map((cabin): SeatMapCabin => {
    // Seats chosen by orders in this cabin, and how many seats orders take here in total.
    const ordered = new Set(
      [...(occupancy?.seatIds ?? [])].filter((id) => layout.seats.get(id)?.cabin === cabin.cabin),
    );
    const orderedSeats = Math.max(ordered.size, occupancy?.seatsByCabin.get(cabin.cabin) ?? 0);
    const sold = Math.min(
      cabinInventory(instance, cabin.cabin)?.sold ?? 0,
      cabin.capacity - Math.min(orderedSeats, cabin.capacity),
    );
    const ranked = cabin.rows
      .flatMap((row, rowIndex) =>
        row.seats
          .filter((seat) => seat !== null)
          .map((seat) => ({
            seat,
            score: demandScore(seat, rowIndex, cabin.rows.length, unit(seat.id)),
          })),
      )
      .sort((a, b) => b.score - a.score || a.seat.id.localeCompare(b.seat.id));
    // Seeded demand takes the most wanted seats that no order has chosen.
    const occupied = new Set(
      ranked
        .filter(({ seat }) => !ordered.has(seat.id))
        .slice(0, sold)
        .map(({ seat }) => seat.id),
    );
    for (const id of ordered) occupied.add(id);
    // Travellers held without a chosen seat take the least wanted free seats.
    let unassigned = orderedSeats - ordered.size;
    for (const { seat } of [...ranked].reverse()) {
      if (unassigned <= 0) break;
      if (occupied.has(seat.id)) continue;
      occupied.add(seat.id);
      unassigned -= 1;
    }

    // A scenario seat "taken by someone else" swaps places with the least wanted occupied seat,
    // so the cabin's totals still match the inventory.
    for (const id of options.takenSeatIds ?? []) {
      if (!layout.seats.has(id) || layout.seats.get(id)!.cabin !== cabin.cabin) continue;
      if (occupied.has(id)) continue;
      const released = [...ranked]
        .reverse()
        .find(({ seat }) => occupied.has(seat.id) && !ordered.has(seat.id));
      if (released && !options.takenSeatIds!.has(released.seat.id)) {
        occupied.delete(released.seat.id);
      }
      occupied.add(id);
    }

    const free = ranked.filter(({ seat }) => !occupied.has(seat.id));
    const held = new Set(
      !closed && cabin.cabin === 'economy' && free.length >= HOLD_THRESHOLD
        ? free
            .filter(({ seat }) => seat.category === 'STANDARD')
            .sort((a, b) => unit(`hold:${a.seat.id}`) - unit(`hold:${b.seat.id}`))
            .slice(0, AIRPORT_HOLDS)
            .map(({ seat }) => seat.id)
        : [],
    );

    let available = 0;
    let blocked = 0;
    const rows = cabin.rows.map((row) => ({
      number: row.number,
      exitRow: row.exitRow,
      seats: row.seats.map((template): Seat | null => {
        if (!template) return null;
        if (occupied.has(template.id)) {
          return { ...template, status: 'OCCUPIED', unavailableReason: null };
        }
        if (closed || held.has(template.id)) {
          blocked += 1;
          return {
            ...template,
            status: 'UNAVAILABLE',
            unavailableReason: closed ? 'flight-closed' : 'held-for-airport',
          };
        }
        available += 1;
        return { ...template, status: 'AVAILABLE', unavailableReason: null };
      }),
    }));
    return {
      cabin: cabin.cabin,
      name: cabin.name,
      layout: cabin.layout,
      columns: cabin.columns,
      rows,
      capacity: cabin.capacity,
      available,
      occupied: occupied.size,
      blocked,
    };
  });

  return {
    flightId: instance.id,
    flightNumber: schedule.flightNumber,
    origin: schedule.origin,
    destination: schedule.destination,
    departureDate: instance.date,
    departureTime: schedule.departureTime,
    aircraft: { code: aircraft.code, name: aircraft.name, bodyType: aircraft.bodyType },
    cabins,
    layoutVersion: LAYOUT_VERSION,
  };
}

/** One seat's status on a map, or `undefined` when the aircraft has no such seat. */
export function seatOn(map: SeatMap, seatId: string): Seat | undefined {
  for (const cabin of map.cabins) {
    for (const row of cabin.rows) {
      for (const seat of row.seats) if (seat?.id === seatId) return seat;
    }
  }
  return undefined;
}
