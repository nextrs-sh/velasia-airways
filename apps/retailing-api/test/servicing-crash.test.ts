import { orderResponseSchema, type Order } from '@velasia/contracts';
import { describe, expect, it } from 'vitest';
import type { CrashPoint } from '../src/crash';
import type { ProviderCharge, ProviderRefund, StoredOrder } from '../src/db/schema';
import { assertOrderInvariants } from '../src/orders/lifecycle';
import { AllocationLedger } from '../src/inventory/ledger';
import { newGuestToken, newKey } from './checkout-harness';
import {
  elapseWhileDown,
  inspect,
  killedBy,
  newDb,
  startServer,
  stop,
  useProcessHarness,
  type Server,
} from './process-harness';
import {
  changeQuote,
  confirmChange,
  confirmedBooking,
  confirmSeats,
  confirmCancellation,
  cancellationQuote,
  seatQuote,
  type Booking,
} from './servicing-harness';

/*
 * Milestone 6 fault injection with real processes: each test kills the API with SIGKILL at a
 * servicing boundary (no cleanup, like a power cut), starts a new process on the same TalaDB file,
 * and checks the durable state directly:
 *
 * - no confirmed booking is lost, and the original stays valid until a change is applied;
 * - no seat is held by two bookings, and no claim outlives its change;
 * - every successful charge or refund at the provider is reflected exactly once, and nothing
 *   succeeds that the provider didn't record;
 * - the order revision only moves forward, and every operation that completed has its revision.
 */

useProcessHarness();

const FLIGHT = 'NV501-20261215';
const CLASSIC = {
  legs: [{ itineraryId: FLIGHT, family: 'CLASSIC' as const }],
  seats: { [FLIGHT]: { ADT1: '14B' } },
};
const FLEX = {
  legs: [{ itineraryId: FLIGHT, family: 'FLEX' as const }],
  seats: { [FLIGHT]: { ADT1: '14B' } },
};

function expectConsistent(state: {
  orders: StoredOrder[];
  charges: ProviderCharge[];
  refunds: ProviderRefund[];
}) {
  const { orders, charges, refunds } = state;
  const now = Date.parse('2026-11-30T16:00:00Z');
  for (const order of orders) {
    assertOrderInvariants(order, 5);
    const attempts = [...order.attempts, ...order.servicing.flatMap((op) => op.attempts)];
    for (const charge of charges.filter(
      (c) => c.orderId === order.orderId && c.status === 'SUCCEEDED',
    )) {
      const attempt = attempts.find((a) => a.attemptId === charge.attemptId);
      // A charge the provider approved is never left undecided or failed once reconciled.
      expect(attempt?.status, `charge ${charge.reference}`).toBe('SUCCEEDED');
    }
    for (const attempt of attempts.filter((a) => a.status === 'SUCCEEDED')) {
      expect(
        charges.some((c) => c.attemptId === attempt.attemptId && c.status === 'SUCCEEDED'),
      ).toBe(true);
    }
    for (const refund of order.servicing
      .flatMap((op) => op.refunds)
      .filter((r) => r.status === 'SUCCEEDED')) {
      expect(
        refunds.filter((r) => r.refundId === refund.refundId && r.status === 'SUCCEEDED'),
      ).toHaveLength(1);
    }
  }
  expect(new Set(charges.map((c) => c.attemptId)).size).toBe(charges.length);
  expect(new Set(refunds.map((r) => r.refundId)).size).toBe(refunds.length);
  // No seat on any flight is held by two bookings.
  const ledger = new AllocationLedger(() => now);
  ledger.rebuild(orders);
  const holders = new Map<string, string>();
  for (const entry of ledger.snapshot()) {
    const [orderId, flightId, , , seats] = entry.split('|');
    for (const seat of seats ? seats.split(',') : []) {
      const key = `${flightId}|${seat}`;
      expect(holders.get(key) ?? orderId, key).toBe(orderId);
      holders.set(key, orderId!);
    }
  }
}

async function read(server: Server, booking: Booking): Promise<Order> {
  const response = await server.call(`/v1/orders/${booking.order.id}`, { token: booking.guest });
  expect(response.statusCode, response.body).toBe(200);
  return orderResponseSchema.parse(response.json()).data;
}

async function changeSetup(point: CrashPoint, outcome?: 'TIMEOUT') {
  const db = newDb();
  const server = await startServer(db);
  const booking = await confirmedBooking(server, CLASSIC, newGuestToken());
  const quote = await changeQuote(server, booking, 'outbound', '2026-12-15', 'NV503-20261215');
  const key = newKey();
  const request = confirmChange(server, booking, 'outbound', 'NV503-20261215', quote, {
    key,
    ...(outcome ? { outcome } : {}),
    options: { crash: point },
  });
  return { db, server, booking, quote, key, request };
}

describe('process killed during a flight change', { timeout: 120_000 }, () => {
  it('after the quote: nothing was written; the booking is unchanged', async () => {
    const db = newDb();
    const server = await startServer(db);
    const booking = await confirmedBooking(server, CLASSIC, newGuestToken());
    await killedBy(
      server,
      server.call(`/v1/orders/${booking.order.id}/change-quotes`, {
        method: 'POST',
        token: booking.guest,
        body: { direction: 'outbound', date: '2026-12-15' },
        crash: 'servicing:after-quote',
      }),
    );
    const state = await inspect(db);
    expectConsistent(state);
    const order = state.orders[0]!;
    expect(order.servicing).toEqual([]);
    expect(order.rev).toBe(booking.order.revision);
  });

  it('after the durable intent and replacement claim, before the provider: never charged, original kept, claim released later', async () => {
    const { db, server, booking, request } = await changeSetup('servicing:after-intent');
    await killedBy(server, request);
    const crashed = (await inspect(db)).orders[0]!;
    expect(crashed.servicing[0]).toMatchObject({
      status: 'AWAITING_PAYMENT',
      claim: { status: 'HELD' },
    });
    expect(crashed.servicing[0]!.attempts[0]!.status).toBe('PROCESSING');

    // Restart: the provider never saw the charge, so the attempt fails and nothing is charged.
    let next = await startServer(db);
    const order = await read(next, booking);
    expect(order.journeys[0]!.itinerary.id).toBe(FLIGHT);
    expect(order.seats).toMatchObject([{ seatId: '14B' }]);
    expect(order.servicing[0]!.payment!.attempts[0]).toMatchObject({ status: 'FAILED' });
    expect(order.servicing[0]!.payment!.attempts[0]!.failureReason).toMatch(/nothing was charged/);
    await stop(next);
    // Down for a day (real time): the claim has ended, startup releases it, the booking is as it was.
    await elapseWhileDown(db, 24 * 60 * 60_000);
    next = await startServer(db);
    await stop(next);
    const state = await inspect(db);
    expectConsistent(state);
    expect(state.orders[0]!.servicing[0]).toMatchObject({
      status: 'EXPIRED',
      claim: { status: 'EXPIRED' },
    });
    expect(state.charges.filter((c) => c.orderId === booking.order.id)).toHaveLength(1);
  });

  it('after the provider charged, before the order knew: recovery applies the change, charged once', async () => {
    const { db, server, booking, quote, key, request } =
      await changeSetup('payment:after-provider');
    await killedBy(server, request);
    const next = await startServer(db);
    const order = await read(next, booking);
    expect(order.journeys[0]!.itinerary.id).toBe('NV503-20261215');
    expect(order.servicing[0]!.status).toBe('COMPLETED');
    // The retry with the same key is answered from the record.
    const replay = await confirmChange(next, booking, 'outbound', 'NV503-20261215', quote, { key });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.replayed).toBe(true);
    await stop(next);
    const state = await inspect(db);
    expectConsistent(state);
    expect(
      state.charges.filter((c) => c.orderId === booking.order.id && c.status === 'SUCCEEDED'),
    ).toHaveLength(2);
  });

  it('after the change was applied, before the response: still applied once after restart', async () => {
    const { db, server, booking, quote, key, request } =
      await changeSetup('servicing:after-commit');
    await killedBy(server, request);
    const next = await startServer(db);
    const order = await read(next, booking);
    expect(order.journeys[0]!.itinerary.id).toBe('NV503-20261215');
    expect(order.servicing[0]!.newRevision).toBe(order.revision);
    const replay = await confirmChange(next, booking, 'outbound', 'NV503-20261215', quote, { key });
    expect(replay.json().data.replayed).toBe(true);
    await stop(next);
    expectConsistent(await inspect(db));
  });

  it('an uncertain payment (timeout), then a crash: recovery asks the provider, never invents success', async () => {
    const { db, server, booking, request } = await changeSetup('servicing:after-commit', 'TIMEOUT');
    await killedBy(server, request);
    const crashed = (await inspect(db)).orders[0]!;
    expect(crashed.servicing[0]!.attempts[0]!.status).toBe('UNKNOWN');
    const next = await startServer(db);
    const order = await read(next, booking);
    // The simulated timeout charged in the background: the provider's record decides it.
    expect(order.servicing[0]!.status).toBe('COMPLETED');
    expect(order.journeys[0]!.itinerary.id).toBe('NV503-20261215');
    await stop(next);
    expectConsistent(await inspect(db));
  });
});

describe('process killed during a seat change', { timeout: 120_000 }, () => {
  it('a paid seat change interrupted before payment keeps the original seat; after restart the new seat persists once paid', async () => {
    const db = newDb();
    let server = await startServer(db);
    const booking = await confirmedBooking(server, CLASSIC, newGuestToken());
    const changes = [{ travellerId: 'ADT1', flightId: FLIGHT, seatId: '8C' }];
    const quote = (await seatQuote(server, booking, changes)).json().data;
    await killedBy(
      server,
      confirmSeats(server, booking, changes, quote, {
        options: { crash: 'servicing:after-intent' },
      }),
    );
    server = await startServer(db);
    let order = await read(server, booking);
    expect(order.seats).toMatchObject([{ seatId: '14B' }]);
    const op = order.servicing[0]!;
    expect(op.status).toBe('AWAITING_PAYMENT');
    const paid = await server.call(`/v1/orders/${order.id}/servicing/${op.id}/payment-attempts`, {
      method: 'POST',
      token: booking.guest,
      body: { idempotencyKey: newKey(), method: 'DEMO_CARD' },
    });
    expect(paid.statusCode, paid.body).toBe(201);
    await stop(server);
    server = await startServer(db);
    order = await read(server, booking);
    expect(order.seats).toMatchObject([{ seatId: '8C' }]);
    const map = (
      await server.call(`/v1/orders/${order.id}/seatmaps/${FLIGHT}`, { token: booking.guest })
    ).json().data;
    expect(map.assignments).toMatchObject([{ seatId: '8C' }]);
    await stop(server);
    expectConsistent(await inspect(db));
  });
});

describe('process killed during a cancellation and its refund', { timeout: 120_000 }, () => {
  async function cancelSetup(point: CrashPoint) {
    const db = newDb();
    const server = await startServer(db);
    const booking = await confirmedBooking(server, FLEX, newGuestToken());
    const quote = (await cancellationQuote(server, booking)).json().data;
    const key = newKey();
    const request = confirmCancellation(server, booking, quote.refundMinor, {
      key,
      options: { crash: point },
    });
    return { db, server, booking, quote, key, request };
  }

  it('after the cancellation was written, before the refund was sent: recovery sends it once', async () => {
    const { db, server, booking, quote, request } = await cancelSetup('cancel:after-commit');
    await killedBy(server, request);
    const crashed = await inspect(db);
    expect(crashed.orders[0]).toMatchObject({
      status: 'BOOKING_CANCELLED',
      hold: { status: 'RELEASED' },
    });
    expect(crashed.orders[0]!.servicing[0]!.refunds[0]!.status).toBe('PROCESSING');
    expect(crashed.refunds).toHaveLength(0);
    const next = await startServer(db);
    const order = await read(next, booking);
    expect(order.financial).toMatchObject({
      refundedMinor: quote.refundMinor,
      refundPendingMinor: 0,
    });
    await stop(next);
    const state = await inspect(db);
    expectConsistent(state);
    expect(state.refunds).toHaveLength(1);
  });

  it('during the refund (the provider recorded it): applied from its record, not sent again', async () => {
    const { db, server, booking, quote, request } = await cancelSetup('refund:after-provider');
    await killedBy(server, request);
    expect((await inspect(db)).refunds).toHaveLength(1);
    const next = await startServer(db);
    const order = await read(next, booking);
    expect(order.status).toBe('BOOKING_CANCELLED');
    expect(order.financial.refundedMinor).toBe(quote.refundMinor);
    await stop(next);
    const state = await inspect(db);
    expectConsistent(state);
    expect(state.refunds).toHaveLength(1);
  });

  it('before the cancellation response: the retry is answered from the record; one refund', async () => {
    const { db, server, booking, quote, key, request } =
      await cancelSetup('cancel:before-response');
    await killedBy(server, request);
    const next = await startServer(db);
    const replay = await confirmCancellation(next, booking, quote.refundMinor, { key });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data).toMatchObject({
      replayed: true,
      order: { status: 'BOOKING_CANCELLED' },
    });
    // The seat is free for others again.
    const other = await confirmedBooking(next, FLEX, newGuestToken());
    expect(other.order.seats).toMatchObject([{ seatId: '14B' }]);
    await stop(next);
    const state = await inspect(db);
    expectConsistent(state);
    expect(state.refunds).toHaveLength(1);
  });
});

describe('restart keeps accounts and linked bookings', { timeout: 120_000 }, () => {
  it('a session, a linked booking, and a saved traveller survive a restart', async () => {
    const db = newDb();
    let server = await startServer(db);
    const booking = await confirmedBooking(server, CLASSIC, newGuestToken());
    const registered = await server.call('/v1/accounts', {
      method: 'POST',
      body: {
        email: 'restart@example.com',
        password: 'correct-horse-battery',
        givenName: 'Amihan',
        familyName: 'Testcase',
      },
    });
    const token = registered.json().data.session.token;
    await server.call('/v1/me/orders/link', {
      method: 'POST',
      account: token,
      token: booking.guest,
      body: { orderIds: [booking.order.id] },
    });
    await server.call('/v1/me/travellers', {
      method: 'POST',
      account: token,
      body: {
        idempotencyKey: newKey(),
        traveller: {
          givenName: 'Malaya',
          familyName: 'Testcase',
          dateOfBirth: '1992-05-05',
          nationality: 'PH',
        },
      },
    });
    await stop(server);
    server = await startServer(db);
    expect(
      (await server.call(`/v1/orders/${booking.order.id}`, { account: token })).statusCode,
    ).toBe(200);
    expect((await server.call('/v1/me/orders', { account: token })).json().meta.total).toBe(1);
    expect((await server.call('/v1/me/travellers', { account: token })).json().data).toHaveLength(
      1,
    );
    expect(
      (await server.call(`/v1/orders/${booking.order.id}`, { token: booking.guest })).statusCode,
    ).toBe(404);
    await stop(server);
    expectConsistent(await inspect(db));
  });
});
