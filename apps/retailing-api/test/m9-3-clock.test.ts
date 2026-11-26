import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { createSessionResponseSchema, orderResponseSchema } from '@velasia/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createClock, type Clock } from '../src/clock';
import { DEFAULT_RETAILING_CONFIG } from '../src/offers/retailing-service';
import {
  FAST_PAYMENTS,
  MNL_SIN,
  OUTBOUND,
  newGuestToken,
  prepared,
  readyCheckout,
  startHarness,
} from './checkout-harness';
import { TODAY } from './helpers';

/*
 * Milestone 9.3: a pinned business date (VELASIA_TODAY) no longer freezes expiry.
 *
 * Every test pins the business date and drives REAL time through `createClock(TODAY, realNow)`
 * with a value the test moves: no sleeps, no fake timers. Before M9.3 a pinned clock returned
 * a constant `now()`, so none of these windows ever ended
 * (docs/deployment/known-issue-pinned-clock-offer-expiry.md).
 */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
/** An arbitrary real instant days before the pinned business date. */
const REAL_START = Date.parse('2026-11-26T04:00:00Z');
const BUSINESS_MIDNIGHT = Date.parse('2026-11-30T16:00:00Z'); // 2026-12-01 00:00 Manila

/** A pinned business date with a real-time source the test controls. */
function realTime(start = REAL_START) {
  let real = start;
  const clock: Clock = createClock(TODAY, () => real);
  return {
    clock,
    advance(ms: number) {
      real += ms;
    },
  };
}

const offersUrl = `/v1/offers?itineraryId=${OUTBOUND}&adults=1&cabin=economy`;
/** Flights on the pinned day itself: the ones closest to the sales cut-off. */
const flightsUrl = `/v1/flights?from=MNL&to=SIN&departureDate=${TODAY}`;

interface OffersBody {
  data: { offers: { id: string; expiresAt: string }[] };
  meta: { serverTime: string; referenceDate: string };
}
const offerIds = (body: OffersBody) => body.data.offers.map((offer) => offer.id);

async function appWith(clock: Clock, file?: string): Promise<FastifyInstance> {
  const app = buildApp({
    config: {
      today: TODAY,
      payments: FAST_PAYMENTS,
      retailing: DEFAULT_RETAILING_CONFIG,
      sessions: { durability: 'sync', flushMs: 1_000 },
      ...(file ? { persistence: { path: file } } : {}),
    },
    testHooks: { clock },
  });
  await app.ready();
  return app;
}

describe('the clock separates business time from real time', () => {
  it('pinned: the business date and instant stay fixed while real time moves', () => {
    const time = realTime();
    expect(time.clock.pinned).toBe(true);
    expect(time.clock.today()).toBe(TODAY);
    expect(time.clock.businessNow()).toBe(BUSINESS_MIDNIGHT);
    expect(time.clock.now()).toBe(REAL_START);
    time.advance(6 * 60 * MINUTE);
    expect(time.clock.today()).toBe(TODAY);
    expect(time.clock.businessNow()).toBe(BUSINESS_MIDNIGHT);
    expect(time.clock.now()).toBe(REAL_START + 6 * 60 * MINUTE);
  });

  it('unpinned: business time is real time, as before M9.3', () => {
    let real = Date.parse('2026-12-03T15:59:00Z'); // 23:59 in Manila
    const clock = createClock(undefined, () => real);
    expect(clock.pinned).toBe(false);
    expect(clock.businessNow()).toBe(real);
    expect(clock.now()).toBe(real);
    expect(clock.today()).toBe('2026-12-03');
    real += 2 * MINUTE; // past midnight in Manila
    expect(clock.today()).toBe('2026-12-04');
    expect(clock.businessNow()).toBe(clock.now());
  });

  it('defaults to the system clock for real time', () => {
    const before = Date.now();
    const clock = createClock(TODAY);
    expect(clock.now()).toBeGreaterThanOrEqual(before);
    expect(clock.now()).toBeLessThanOrEqual(Date.now());
    expect(clock.businessNow()).toBe(BUSINESS_MIDNIGHT);
  });
});

describe('pinned business date, real-time expiry (HTTP)', { timeout: 60_000 }, () => {
  it('keeps flight fixtures deterministic however much real time passes', async () => {
    const time = realTime();
    const app = await appWith(time.clock);
    try {
      const first = await app.inject({ url: flightsUrl });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json().data.legs[0].summary.availableItineraries).toBeGreaterThan(0);
      time.advance(10 * 60 * MINUTE); // a long benchmark series
      const later = await app.inject({ url: flightsUrl });
      // Same flights on the pinned day: none slipped past the sales cut-off in real time.
      expect(later.json()).toEqual(first.json());
      expect(later.json().meta.referenceDate).toBe(TODAY);
    } finally {
      await app.close();
    }
  });

  it('reuses offers inside the 60 s window and creates new ones after it', async () => {
    const time = realTime();
    const app = await appWith(time.clock);
    try {
      const first = (await app.inject({ url: offersUrl })).json() as OffersBody;
      expect(offerIds(first).length).toBeGreaterThan(0);
      // serverTime is real time; the business date stays pinned.
      expect(Date.parse(first.meta.serverTime)).toBe(REAL_START);
      expect(first.meta.referenceDate).toBe(TODAY);
      expect(Date.parse(first.data.offers[0]!.expiresAt)).toBe(REAL_START + 15 * MINUTE);

      time.advance(59 * SECOND);
      const reused = (await app.inject({ url: offersUrl })).json() as OffersBody;
      expect(offerIds(reused)).toEqual(offerIds(first));

      time.advance(2 * SECOND); // 61 s after the first search
      const fresh = (await app.inject({ url: offersUrl })).json() as OffersBody;
      expect(offerIds(fresh)).toHaveLength(offerIds(first).length);
      for (const id of offerIds(fresh)) expect(offerIds(first)).not.toContain(id);
      expect(Date.parse(fresh.meta.serverTime)).toBe(REAL_START + 61 * SECOND);
      // A new window starts from the new offers.
      time.advance(30 * SECOND);
      const again = (await app.inject({ url: offersUrl })).json() as OffersBody;
      expect(offerIds(again)).toEqual(offerIds(fresh));
    } finally {
      await app.close();
    }
  });

  it('expires offers after their validity in real time, and never reuses an expired one', async () => {
    const time = realTime();
    const app = await appWith(time.clock);
    try {
      const first = (await app.inject({ url: offersUrl })).json() as OffersBody;
      const id = offerIds(first)[0]!;
      const status = async () => (await app.inject({ url: `/v1/offers/${id}` })).json();

      time.advance(15 * MINUTE - 1);
      expect((await status()).data.status).toBe('AVAILABLE');
      time.advance(1);
      expect((await status()).data.status).toBe('EXPIRED');

      const after = (await app.inject({ url: offersUrl })).json() as OffersBody;
      expect(offerIds(after)).not.toContain(id);
      for (const offer of after.data.offers) {
        expect(Date.parse(offer.expiresAt)).toBe(time.clock.now() + 15 * MINUTE);
      }
    } finally {
      await app.close();
    }
  });

  it('counts created offers even when expired ones are swept (the benchmark gate needs this)', async () => {
    const time = realTime();
    const app = await appWith(time.clock);
    const metric = async (name: string, store: string) => {
      const text = (await app.inject({ url: '/metrics' })).body;
      const line = text.split('\n').find((l) => l.startsWith(`${name}{store="${store}"}`));
      return Number(line?.split(' ').at(-1));
    };
    try {
      const first = (await app.inject({ url: offersUrl })).json() as OffersBody;
      const n = offerIds(first).length;
      expect(await metric('velasia_memory_store_entries', 'offers')).toBe(n);
      expect(await metric('velasia_memory_store_created_total', 'offers')).toBe(n);

      // Past validity (15 min) plus the store's 30-minute grace: the next write sweeps them.
      time.advance(46 * MINUTE);
      await app.inject({ url: offersUrl });
      // The store is the same size, yet n more offers were created.
      expect(await metric('velasia_memory_store_entries', 'offers')).toBe(n);
      expect(await metric('velasia_memory_store_created_total', 'offers')).toBe(2 * n);

      // Reuse inside the window creates nothing.
      time.advance(10 * SECOND);
      await app.inject({ url: offersUrl });
      expect(await metric('velasia_memory_store_created_total', 'offers')).toBe(2 * n);
      expect(await metric('velasia_memory_store_created_total', 'sessions')).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('expires checkout holds in real time', async () => {
    const time = realTime();
    const h = await startHarness({ testHooks: { clock: time.clock } });
    try {
      const ready = await readyCheckout(h);
      const guest = newGuestToken();
      const order = await prepared(h, ready, guest);
      expect(Date.parse(order.hold.expiresAt)).toBe(time.clock.now() + 10 * MINUTE);

      time.advance(10 * MINUTE);
      const read = orderResponseSchema.parse(
        (await h.call(`/v1/orders/${order.id}`, { token: guest })).json(),
      ).data;
      expect(read).toMatchObject({ status: 'EXPIRED', hold: { status: 'EXPIRED' } });
    } finally {
      await h.close();
    }
  });
});

// --- Restarts ----------------------------------------------------------------------------------

setFlagsFromString('--expose_gc');
const gc = runInNewContext('gc') as () => void;
/** TalaDB 0.13 releases its file lock once a closed app is garbage-collected (see M7 tests). */
async function collect() {
  for (let i = 0; i < 6; i += 1) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const tempFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'velasia-m93-clock-'));
  dirs.push(dir);
  return join(dir, 'velasia.db');
};

describe('restarts with a pinned business date', { timeout: 60_000 }, () => {
  it('compare persisted expiry with real time, and carry no offer across a restart', async () => {
    const file = tempFile();
    const time = realTime();
    // Each "process" returns plain data only, so the closed app can be collected.
    async function run<T>(work: (app: FastifyInstance) => Promise<T>): Promise<T> {
      const app = await appWith(time.clock, file);
      try {
        return await work(app);
      } finally {
        await app.close();
      }
    }
    async function lifetime<T>(work: (app: FastifyInstance) => Promise<T>): Promise<T> {
      const result = await run(work);
      await collect();
      return result;
    }

    const first = await lifetime(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/shopping-sessions',
        payload: { search: MNL_SIN },
      });
      expect(response.statusCode, response.body).toBe(201);
      const { session, token } = createSessionResponseSchema.parse(response.json()).data;
      const offers = (await app.inject({ url: offersUrl })).json() as OffersBody;
      return { id: session.id, token, offerId: offerIds(offers)[0]! };
    });
    const getSession = (app: FastifyInstance) =>
      app.inject({
        url: `/v1/shopping-sessions/${first.id}`,
        headers: { authorization: `Bearer ${first.token}` },
      });

    // Restart within the idle window: the session is restored, offers are not (memory only).
    time.advance(5 * MINUTE);
    const restored = await lifetime(async (app) => ({
      session: (await getSession(app)).statusCode,
      offer: (await app.inject({ url: `/v1/offers/${first.offerId}` })).statusCode,
      reusedOffers: offerIds((await app.inject({ url: offersUrl })).json() as OffersBody),
    }));
    expect(restored.session).toBe(200);
    expect(restored.offer).toBe(404);
    expect(restored.reusedOffers).not.toContain(first.offerId);

    // 31 minutes idle in real time (the business date never moved): expired after a restart.
    time.advance(31 * MINUTE);
    const expired = await lifetime(async (app) => {
      const response = await getSession(app);
      return { status: response.statusCode, code: response.json().error?.code as string };
    });
    expect(expired).toEqual({ status: 410, code: 'SESSION_EXPIRED' });
  });
});
