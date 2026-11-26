import { orderResponseSchema, seatsOf, sessionSeatMapResponseSchema } from '@velasia/contracts';
import { describe, expect, it } from 'vitest';
import type { ProviderCharge, StoredOrder } from '../src/db/schema';
import type { CrashPoint } from '../src/crash';
import {
  newGuestToken,
  newKey,
  pay,
  paymentOf,
  prepare,
  readyCheckout,
  type Caller,
  type ReadyCheckout,
} from './checkout-harness';
import {
  elapseWhileDown,
  inspect,
  killedBy,
  newDb,
  startServer,
  stop,
  useProcessHarness,
} from './process-harness';

/*
 * Fault injection with real processes. Each test runs the API as a child process on its own
 * TalaDB file, kills it with SIGKILL at a checkout boundary (no cleanup, like a power cut),
 * starts a new process on the same file, and checks the durable invariants:
 *
 * - no order is lost once its creation was acknowledged, and none appears that wasn't written;
 * - no payment is confirmed unless the provider recorded it as succeeded, and none twice;
 * - held seats are restored from durable state, and released when their hold has ended.
 */

useProcessHarness();

/** The invariants that must hold in any durable state. */
function expectConsistent({
  orders,
  charges,
}: {
  orders: StoredOrder[];
  charges: ProviderCharge[];
}) {
  for (const order of orders) {
    const succeeded = charges.filter(
      (c) => c.orderId === order.orderId && c.status === 'SUCCEEDED',
    );
    if (order.status === 'CONFIRMED') {
      expect(order.hold.status).toBe('COMMITTED');
      expect(order.attempts.filter((a) => a.status === 'SUCCEEDED')).toHaveLength(1);
      expect(succeeded).toHaveLength(1);
    } else {
      expect(order.attempts.some((a) => a.status === 'SUCCEEDED')).toBe(false);
    }
    expect(succeeded.length).toBeLessThanOrEqual(1);
  }
  // Each attempt was charged at most once.
  const attempts = charges.map((c) => c.attemptId);
  expect(new Set(attempts).size).toBe(attempts.length);
}

async function seatStatus(server: Caller, ready: ReadyCheckout, flightId: string, seatId: string) {
  const map = sessionSeatMapResponseSchema.parse(
    (
      await server.call(`/v1/shopping-sessions/${ready.id}/seatmaps/${flightId}`, {
        token: ready.token,
      })
    ).json(),
  ).data;
  return seatsOf(map.seatMap).find((seat) => seat.id === seatId)?.status;
}

const FLIGHT = 'NV501-20261215';

describe('restart', { timeout: 120_000 }, () => {
  it('keeps a confirmed order retrievable after a graceful stop and restart', async () => {
    const db = newDb();
    let server = await startServer(db);
    const ready = await readyCheckout(server);
    const guest = newGuestToken();
    const created = (await prepare(server, ready, guest)).json().data.order;
    const confirmed = paymentOf(await pay(server, created.id, guest, { outcome: 'SUCCESS' })).order;
    await stop(server);

    server = await startServer(db);
    const read = orderResponseSchema.parse(
      (await server.call(`/v1/orders/${created.id}`, { token: guest })).json(),
    ).data;
    expect({ ...read, serverTime: '' }).toEqual({ ...confirmed, serverTime: '' });
    const byReference = orderResponseSchema.parse(
      (await server.call(`/v1/orders/reference/${created.reference}`, { token: guest })).json(),
    ).data;
    expect(byReference.id).toBe(created.id);
    // Still private after the restart.
    expect(
      (await server.call(`/v1/orders/${created.id}`, { token: newGuestToken() })).statusCode,
    ).toBe(404);
    // Its seat is still taken for everyone else.
    const observer = await readyCheckout(server, { seats: 'none' });
    expect(await seatStatus(server, observer, FLIGHT, created.seats[0].seatId)).toBe('OCCUPIED');
    await stop(server);
    expectConsistent(await inspect(db));
  });

  it('restores held seats from TalaDB, and releases holds that ended while it was down', async () => {
    const db = newDb();
    let server = await startServer(db);
    const ready = await readyCheckout(server);
    const guest = newGuestToken();
    const order = (await prepare(server, ready, guest)).json().data.order;
    await stop(server);

    // Same day: the hold is restored and still blocks the seat.
    server = await startServer(db);
    const observer = await readyCheckout(server, { seats: 'none' });
    expect(await seatStatus(server, observer, FLIGHT, order.seats[0].seatId)).toBe('OCCUPIED');
    await stop(server);

    // Down for a day (real time): the hold has long ended, startup reconciliation releases it.
    await elapseWhileDown(db, 24 * 60 * 60_000);
    server = await startServer(db);
    expect(server.output()).not.toMatch(/error/i);
    await stop(server);
    const { orders } = await inspect(db);
    expect(orders.find((o) => o.orderId === order.id)).toMatchObject({
      status: 'EXPIRED',
      hold: { status: 'EXPIRED' },
    });
  });
});

describe('process killed at a checkout boundary', { timeout: 120_000 }, () => {
  async function crashDuringPrepare(point: CrashPoint) {
    const db = newDb();
    const server = await startServer(db);
    const ready = await readyCheckout(server);
    const seat = ready.session.booking.seats[0]!.seatId;
    await killedBy(server, prepare(server, ready, newGuestToken(), { crash: point }));
    return { db, seat };
  }

  it('before the order is written: nothing exists, nothing is held', async () => {
    const { db, seat } = await crashDuringPrepare('prepare:before-insert');
    const state = await inspect(db);
    expect(state.orders).toHaveLength(0);
    const server = await startServer(db);
    const observer = await readyCheckout(server, { seats: 'none' });
    expect(await seatStatus(server, observer, FLIGHT, seat)).toBe('AVAILABLE');
    await stop(server);
  });

  it('after the pending order and hold are written: both survive, the seat stays held, and it can be paid', async () => {
    const { db, seat } = await crashDuringPrepare('prepare:after-insert');
    const [order] = (await inspect(db)).orders;
    expect(order).toMatchObject({ status: 'PENDING_PAYMENT', hold: { status: 'HELD' } });
    expect(order!.hold.allocations[0]!.seatIds).toEqual([seat]);

    const server = await startServer(db);
    const observer = await readyCheckout(server, { seats: 'none' });
    expect(await seatStatus(server, observer, FLIGHT, seat)).toBe('OCCUPIED');
    await stop(server);
  });

  async function crashDuringPayment(
    point: CrashPoint,
    outcome: 'SUCCESS' | 'DECLINED' = 'SUCCESS',
  ) {
    const db = newDb();
    const server = await startServer(db);
    const ready = await readyCheckout(server);
    const guest = newGuestToken();
    const order = (await prepare(server, ready, guest)).json().data.order;
    const key = newKey();
    await killedBy(server, pay(server, order.id, guest, { outcome, key, crash: point }));
    return { db, order, guest, key };
  }

  it('after the attempt is recorded, before the provider is called: the attempt fails, nothing was charged', async () => {
    const { db, order, guest } = await crashDuringPayment('payment:after-attempt');
    const before = await inspect(db);
    expect(before.orders[0]!.attempts[0]!.status).toBe('PROCESSING');
    expect(before.charges).toHaveLength(0);

    const server = await startServer(db);
    const read = orderResponseSchema.parse(
      (await server.call(`/v1/orders/${order.id}`, { token: guest })).json(),
    ).data;
    expect(read).toMatchObject({ status: 'PENDING_PAYMENT', payment: { canPay: true } });
    expect(read.payment.attempts[0]).toMatchObject({ status: 'FAILED' });
    expect(read.payment.attempts[0]!.failureReason).toMatch(/nothing was charged/);
    // The guest can simply pay again.
    expect(paymentOf(await pay(server, order.id, guest, { outcome: 'SUCCESS' })).order.status).toBe(
      'CONFIRMED',
    );
    await stop(server);
    expectConsistent(await inspect(db));
  });

  it('after the provider charged, before the order knew: recovery confirms it, once', async () => {
    const { db, order, guest, key } = await crashDuringPayment('payment:after-provider');
    const before = await inspect(db);
    expect(before.orders[0]!.status).toBe('PENDING_PAYMENT');
    expect(before.charges.map((c) => c.status)).toEqual(['SUCCEEDED']);

    const server = await startServer(db);
    const read = orderResponseSchema.parse(
      (await server.call(`/v1/orders/${order.id}`, { token: guest })).json(),
    ).data;
    expect(read).toMatchObject({ status: 'CONFIRMED', hold: { status: 'COMMITTED' } });
    // The browser retries the same payment: it gets the result, not a second charge.
    const retry = await pay(server, order.id, guest, { outcome: 'SUCCESS', key });
    expect(retry.statusCode).toBe(200);
    expect(paymentOf(retry)).toMatchObject({ replayed: true, order: { status: 'CONFIRMED' } });
    await stop(server);
    const after = await inspect(db);
    expect(after.charges).toHaveLength(1);
    expect(after.orders[0]!.events.filter((e) => e.type === 'ORDER_CONFIRMED')).toHaveLength(1);
    expectConsistent(after);
  });

  it('after the provider declined, before the order knew: recovery records the decline', async () => {
    const { db, order, guest } = await crashDuringPayment('payment:after-provider', 'DECLINED');
    const server = await startServer(db);
    const read = orderResponseSchema.parse(
      (await server.call(`/v1/orders/${order.id}`, { token: guest })).json(),
    ).data;
    expect(read).toMatchObject({ status: 'PENDING_PAYMENT', payment: { canPay: true } });
    expect(read.payment.attempts[0]!.status).toBe('FAILED');
    await stop(server);
    expectConsistent(await inspect(db));
  });

  it('after the order was confirmed, before the answer was sent: nothing is redone', async () => {
    const { db, order, guest } = await crashDuringPayment('payment:after-confirm');
    const before = await inspect(db);
    expect(before.orders[0]).toMatchObject({ status: 'CONFIRMED', hold: { status: 'COMMITTED' } });

    const server = await startServer(db);
    const read = orderResponseSchema.parse(
      (await server.call(`/v1/orders/${order.id}`, { token: guest })).json(),
    ).data;
    expect(read.status).toBe('CONFIRMED');
    await stop(server);
    const after = await inspect(db);
    expect(after.orders[0]!.rev).toBe(before.orders[0]!.rev); // recovery changed nothing
    expect(after.charges).toHaveLength(1);
    expectConsistent(after);
  });

  it('with an uncertain (timed-out) result: recovery asks the provider instead of guessing', async () => {
    const db = newDb();
    let server = await startServer(db);
    const ready = await readyCheckout(server);
    const guest = newGuestToken();
    const order = (await prepare(server, ready, guest)).json().data.order;
    const response = await pay(server, order.id, guest, { outcome: 'TIMEOUT' });
    expect(response.statusCode).toBe(202);
    expect(paymentOf(response).attempt?.status).toBe('UNKNOWN');
    server.child.kill('SIGKILL');
    await server.exited;

    server = await startServer(db);
    const read = orderResponseSchema.parse(
      (await server.call(`/v1/orders/${order.id}`, { token: guest })).json(),
    ).data;
    expect(read.status).toBe('CONFIRMED');
    await stop(server);
    expectConsistent(await inspect(db));
  });
});
