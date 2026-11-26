import {
  apiErrorSchema,
  createSessionResponseSchema,
  fareFamiliesResponseSchema,
  offerPriceCheckResponseSchema,
  offerResponseSchema,
  offerSearchResponseSchema,
  repriceResponseSchema,
  selectOfferResponseSchema,
  shoppingSessionResponseSchema,
  type FlightSearch,
  type Offer,
} from '@velasia/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createClock } from '../src/clock';
import { createRetailingService, DEFAULT_RETAILING_CONFIG } from '../src/offers/retailing-service';
import { createFlightService } from '../src/services/flights';
import { SEED, TODAY } from './helpers';

let app: FastifyInstance;
beforeAll(async () => {
  app = buildApp({
    config: { today: TODAY, faults: { enabled: true, timeoutMs: 200 } },
  });
  await app.ready();
});
afterAll(() => app.close());

type Scenario = 'offer-expired' | 'price-increase' | 'sold-out' | 'session-expired';
interface Call {
  method?: 'GET' | 'POST' | 'DELETE';
  token?: string;
  body?: unknown;
  scenario?: Scenario;
  headers?: Record<string, string>;
}
const call = (url: string, { method = 'GET', token, body, scenario, headers = {} }: Call = {}) =>
  app.inject({
    method,
    url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(scenario ? { 'x-velasia-scenario': scenario } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { payload: body as object }),
  });

const ONE_WAY: FlightSearch = {
  tripType: 'one-way',
  origin: 'MNL',
  destination: 'SIN',
  departDate: '2026-12-15',
  passengers: { adults: 1, children: 0, infants: 0 },
  cabin: 'economy',
};
const ROUND_TRIP: FlightSearch = { ...ONE_WAY, tripType: 'round-trip', returnDate: '2026-12-20' };
const OUTBOUND = 'NV501-20261215';
const INBOUND = 'NV502-20261220';

async function offersFor(itineraryId: string, query = '', scenario?: Scenario) {
  const response = await call(`/v1/offers?itineraryId=${itineraryId}${query}`, { scenario });
  expect(response.statusCode, response.body).toBe(200);
  return offerSearchResponseSchema.parse(response.json());
}
async function offerFor(itineraryId: string, family: Offer['family'], query = '') {
  const offer = (await offersFor(itineraryId, query)).data.offers.find((o) => o.family === family);
  if (!offer) throw new Error(`no ${family} offer for ${itineraryId}`);
  return offer;
}
async function newSession(search: FlightSearch = ONE_WAY) {
  const response = await call('/v1/shopping-sessions', { method: 'POST', body: { search } });
  expect(response.statusCode, response.body).toBe(201);
  const { session, token } = createSessionResponseSchema.parse(response.json()).data;
  return { id: session.id, token, session };
}
async function select(
  session: { id: string; token: string },
  direction: 'outbound' | 'inbound',
  offerId: string,
  scenario?: Scenario,
) {
  return call(`/v1/shopping-sessions/${session.id}/select`, {
    method: 'POST',
    token: session.token,
    body: { direction, offerId },
    scenario,
  });
}
async function expectError(
  response: Awaited<ReturnType<typeof call>>,
  status: number,
  code: string,
) {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.headers['cache-control']).toContain('no-store');
  const body = apiErrorSchema.parse(response.json());
  expect(body.error.code).toBe(code);
  expect(response.body).not.toMatch(/at \w+ \(|node_modules|stack/i);
  return body;
}

describe('GET /v1/fare-families', () => {
  it('returns the four products with structured services, publicly cacheable', async () => {
    const response = await call('/v1/fare-families');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toMatch(/^public/);
    const body = fareFamiliesResponseSchema.parse(response.json());
    expect(body.data.map((family) => family.name)).toEqual([
      'Velasia Light',
      'Velasia Classic',
      'Velasia Flex',
      'Velasia Business',
    ]);
    expect(body.meta.disclaimer).toMatch(/fictional/);
    expect(response.body).not.toMatch(/component|"rate"/);
  });
});

describe('GET /v1/offers', () => {
  it('creates priced offers for a real itinerary, never cached', async () => {
    const response = await call(`/v1/offers?itineraryId=${OUTBOUND}&adults=2&children=1`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const body = offerSearchResponseSchema.parse(response.json());
    expect(body.data.offers.map((offer) => offer.family)).toEqual([
      'LIGHT',
      'CLASSIC',
      'FLEX',
      'BUSINESS',
    ]);
    expect(body.data.unavailable).toEqual([]);
    expect(body.data.offers.every((offer) => offer.passengers.children === 1)).toBe(true);
    expect(body.meta).toMatchObject({
      currency: 'PHP',
      referenceDate: TODAY,
      offerValiditySeconds: 900,
      inventoryVersion: 'inv-20261201',
    });
    const [first] = body.data.offers;
    expect(Date.parse(first!.expiresAt) - Date.parse(first!.createdAt)).toBe(15 * 60_000);
  });

  it('explains families it does not offer instead of substituting another', async () => {
    const body = await offersFor('NV103-20261215');
    expect(body.data.offers.map((offer) => offer.family)).toEqual(['LIGHT', 'CLASSIC', 'FLEX']);
    expect(body.data.unavailable).toEqual([
      expect.objectContaining({ family: 'BUSINESS', reason: 'cabin-not-offered' }),
    ]);
  });

  it('reuses the same offers for repeated requests moments apart', async () => {
    const a = await offersFor(OUTBOUND, '&adults=3');
    const b = await offersFor(OUTBOUND, '&adults=3');
    expect(b.data.offers.map((o) => o.id)).toEqual(a.data.offers.map((o) => o.id));
    const other = await offersFor(OUTBOUND, '&adults=2');
    expect(other.data.offers[0]!.id).not.toBe(a.data.offers[0]!.id);
  });

  it('is deterministic in price across app instances', async () => {
    const other = buildApp({ config: { today: TODAY } });
    const elsewhere = offerSearchResponseSchema.parse(
      (await other.inject(`/v1/offers?itineraryId=${OUTBOUND}&adults=2`)).json(),
    );
    const here = await offersFor(OUTBOUND, '&adults=2');
    expect(elsewhere.data.offers.map((o) => o.price)).toEqual(here.data.offers.map((o) => o.price));
    await other.close();
  });

  it.each([
    ['missing itinerary', '/v1/offers', 'itineraryId'],
    ['malformed itinerary', '/v1/offers?itineraryId=abc', 'itineraryId'],
    ['too many passengers', `/v1/offers?itineraryId=${OUTBOUND}&adults=9&children=1`, 'passengers'],
    ['infant without adult lap', `/v1/offers?itineraryId=${OUTBOUND}&infants=2`, 'passengers'],
    ['unsupported cabin', `/v1/offers?itineraryId=${OUTBOUND}&cabin=first`, 'cabin'],
  ])('rejects %s', async (_label, url, path) => {
    const body = await expectError(await call(url), 400, 'BAD_REQUEST');
    expect(body.error.issues?.map((issue) => issue.path)).toContain(path);
  });

  it('returns 404 for an itinerary that does not exist', async () => {
    await expectError(await call('/v1/offers?itineraryId=NV999-20261215'), 404, 'NOT_FOUND');
  });

  it('answers 503 and malformed bodies under simulated faults', async () => {
    await expectError(
      await call(`/v1/offers?itineraryId=${OUTBOUND}`, {
        headers: { 'x-velasia-fault': 'unavailable' },
      }),
      503,
      'SERVICE_UNAVAILABLE',
    );
    const malformed = await call(`/v1/offers?itineraryId=${OUTBOUND}`, {
      headers: { 'x-velasia-fault': 'malformed' },
    });
    expect(offerSearchResponseSchema.safeParse(malformed.json()).success).toBe(false);
  });
});

describe('GET /v1/offers/:offerId and /price', () => {
  it('reads an offer back with its derived status', async () => {
    const offer = await offerFor(OUTBOUND, 'FLEX');
    const response = await call(`/v1/offers/${offer.id}`);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(offerResponseSchema.parse(response.json()).data).toMatchObject({
      id: offer.id,
      status: 'AVAILABLE',
    });
    const later = offerResponseSchema.parse(
      (await call(`/v1/offers/${offer.id}`, { scenario: 'offer-expired' })).json(),
    );
    expect(later.data.status).toBe('EXPIRED');
    const soldOut = offerResponseSchema.parse(
      (await call(`/v1/offers/${offer.id}`, { scenario: 'sold-out' })).json(),
    );
    expect(soldOut.data.status).toBe('UNAVAILABLE');
  });

  it('rejects forged and unknown offer ids', async () => {
    await expectError(await call('/v1/offers/NV501-20261215'), 400, 'BAD_REQUEST');
    await expectError(await call('/v1/offers/off_AAAAAAAAAAAAAAAAAAAAAA'), 404, 'OFFER_NOT_FOUND');
  });

  it('checks the current price without creating anything', async () => {
    const offer = await offerFor(OUTBOUND, 'CLASSIC');
    const same = offerPriceCheckResponseSchema.parse(
      (await call(`/v1/offers/${offer.id}/price`)).json(),
    );
    expect(same.data).toMatchObject({
      offerTotalMinor: offer.price.totalMinor,
      currentTotalMinor: offer.price.totalMinor,
      priceChanged: false,
    });
    const higher = offerPriceCheckResponseSchema.parse(
      (await call(`/v1/offers/${offer.id}/price`, { scenario: 'price-increase' })).json(),
    );
    expect(higher.data.status).toBe('EXPIRED');
    expect(higher.data.priceChanged).toBe(true);
    expect(higher.data.currentTotalMinor).toBeGreaterThan(offer.price.totalMinor);
  });
});

describe('shopping sessions', () => {
  it('creates a session with an opaque id and a separate secret token', async () => {
    const { id, token, session } = await newSession();
    expect(id).toMatch(/^ses_/);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.search).toEqual(ONE_WAY);
    expect(session.summary).toMatchObject({
      complete: false,
      readyToContinue: false,
      totalMinor: 0,
    });
    expect(JSON.stringify(session)).not.toContain(token);
  });

  it('validates the search it is created for', async () => {
    await expectError(
      await call('/v1/shopping-sessions', {
        method: 'POST',
        body: { search: { ...ONE_WAY, departDate: '2026-11-01' } },
      }),
      400,
      'BAD_REQUEST',
    );
    await expectError(
      await call('/v1/shopping-sessions', {
        method: 'POST',
        body: { search: ONE_WAY, totalMinor: 1 },
      }),
      400,
      'BAD_REQUEST',
    );
  });

  it('only answers to its own token, and looks the same as an unknown session otherwise', async () => {
    const mine = await newSession();
    const theirs = await newSession();
    const ok = await call(`/v1/shopping-sessions/${mine.id}`, { token: mine.token });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('private, no-store');
    await expectError(await call(`/v1/shopping-sessions/${mine.id}`), 404, 'SESSION_NOT_FOUND');
    await expectError(
      await call(`/v1/shopping-sessions/${mine.id}`, { token: theirs.token }),
      404,
      'SESSION_NOT_FOUND',
    );
    const offer = await offerFor(OUTBOUND, 'CLASSIC');
    // Another guest can't change this session, even knowing its id.
    await expectError(
      await call(`/v1/shopping-sessions/${mine.id}/select`, {
        method: 'POST',
        token: theirs.token,
        body: { direction: 'outbound', offerId: offer.id },
      }),
      404,
      'SESSION_NOT_FOUND',
    );
    const unchanged = shoppingSessionResponseSchema.parse(
      (await call(`/v1/shopping-sessions/${mine.id}`, { token: mine.token })).json(),
    );
    expect(unchanged.data.selections.outbound).toBeNull();
    expect(unchanged.data.version).toBe(0);
  });

  it('selects an offer, prices the trip on the server, and changes fare family', async () => {
    const session = await newSession();
    const classic = await offerFor(OUTBOUND, 'CLASSIC');
    const first = selectOfferResponseSchema.parse(
      (await select(session, 'outbound', classic.id)).json(),
    ).data.session;
    expect(first.selections.outbound).toMatchObject({ status: 'SELECTED', previous: null });
    expect(first.summary).toMatchObject({
      complete: true,
      readyToContinue: false,
      totalMinor: classic.price.totalMinor,
    });

    const flex = await offerFor(OUTBOUND, 'FLEX');
    const changed = selectOfferResponseSchema.parse(
      (await select(session, 'outbound', flex.id)).json(),
    ).data.session;
    expect(changed.summary.totalMinor).toBe(flex.price.totalMinor);
    expect(changed.selections.outbound!.previous).toEqual({
      family: 'CLASSIC',
      itineraryId: OUTBOUND,
      totalMinor: classic.price.totalMinor,
    });
    expect(changed.version).toBe(2);
  });

  it('ignores any price sent by the client', async () => {
    const session = await newSession();
    const offer = await offerFor(OUTBOUND, 'LIGHT');
    const response = await call(`/v1/shopping-sessions/${session.id}/select`, {
      method: 'POST',
      token: session.token,
      body: { direction: 'outbound', offerId: offer.id, totalMinor: 100 },
    });
    await expectError(response, 400, 'BAD_REQUEST');
  });

  it('rejects offers that do not fit the session', async () => {
    const session = await newSession();
    const otherRoute = await offerFor('NV101-20261215', 'LIGHT');
    expect(
      (
        await expectError(
          await select(session, 'outbound', otherRoute.id),
          422,
          'INVALID_SELECTION',
        )
      ).error.message,
    ).toMatch(/different/);
    const otherParty = await offerFor(OUTBOUND, 'LIGHT', '&adults=2');
    await expectError(await select(session, 'outbound', otherParty.id), 422, 'INVALID_SELECTION');
    const inbound = await offerFor(INBOUND, 'LIGHT');
    await expectError(await select(session, 'inbound', inbound.id), 422, 'INVALID_SELECTION');
    await expectError(
      await select(session, 'outbound', 'off_AAAAAAAAAAAAAAAAAAAAAA'),
      404,
      'OFFER_NOT_FOUND',
    );
  });

  it('rejects expired and unavailable offers', async () => {
    const session = await newSession();
    const offer = await offerFor(OUTBOUND, 'CLASSIC');
    await expectError(
      await select(session, 'outbound', offer.id, 'offer-expired'),
      410,
      'OFFER_EXPIRED',
    );
    await expectError(
      await select(session, 'outbound', offer.id, 'sold-out'),
      409,
      'OFFER_UNAVAILABLE',
    );
  });

  it('keeps a round trip consistent: different families, combined total, preserved legs', async () => {
    const session = await newSession(ROUND_TRIP);
    const out = await offerFor(OUTBOUND, 'CLASSIC');
    const back = await offerFor(INBOUND, 'FLEX');
    await select(session, 'outbound', out.id);
    const both = selectOfferResponseSchema.parse((await select(session, 'inbound', back.id)).json())
      .data.session;
    expect(both.summary.complete).toBe(true);
    expect(both.summary.totalMinor).toBe(out.price.totalMinor + back.price.totalMinor);
    expect(both.summary.totals.taxesMinor).toBe(
      out.price.totals.taxesMinor + back.price.totals.taxesMinor,
    );

    // Changing the return fare leaves the departing selection alone.
    const backLight = await offerFor(INBOUND, 'LIGHT');
    const edited = selectOfferResponseSchema.parse(
      (await select(session, 'inbound', backLight.id)).json(),
    ).data.session;
    expect(edited.selections.outbound!.offer.id).toBe(out.id);
  });

  describe('same-day return', () => {
    const SAME_DAY = { ...ROUND_TRIP, returnDate: '2026-12-15' };
    const EVENING_RETURN = 'NV504-20261215'; // leaves Singapore after NV503 turns around

    it('clears only a return that no longer fits a new departing flight', async () => {
      const session = await newSession(SAME_DAY);
      await select(session, 'outbound', (await offerFor(OUTBOUND, 'CLASSIC', '')).id);
      const back = await offerFor(EVENING_RETURN, 'LIGHT');
      expect((await select(session, 'inbound', back.id)).statusCode).toBe(200);
      // NV503 lands in Singapore too late for the evening return.
      const later = await offerFor('NV503-20261215', 'FLEX');
      const moved = selectOfferResponseSchema.parse(
        (await select(session, 'outbound', later.id)).json(),
      ).data;
      expect(moved.inboundCleared).toBe(true);
      expect(moved.session.selections.inbound).toBeNull();
      expect(moved.session.selections.outbound!.offer.id).toBe(later.id);
      expect(moved.session.summary.complete).toBe(false);
    });

    it('rejects a return flight that leaves before the departing flight has landed for 2 hours', async () => {
      const session = await newSession(SAME_DAY);
      await select(session, 'outbound', (await offerFor('NV503-20261215', 'LIGHT')).id);
      const body = await expectError(
        await select(session, 'inbound', (await offerFor(EVENING_RETURN, 'LIGHT')).id),
        422,
        'INVALID_SELECTION',
      );
      expect(body.error.message).toMatch(/at least 2 hours/);
    });
  });

  describe('repricing', () => {
    async function selected(family: Offer['family'] = 'CLASSIC') {
      const session = await newSession();
      const offer = await offerFor(OUTBOUND, family);
      await select(session, 'outbound', offer.id);
      return { session, offer };
    }
    const reprice = (session: { id: string; token: string }, scenario?: Scenario) =>
      call(`/v1/shopping-sessions/${session.id}/reprice`, {
        method: 'POST',
        token: session.token,
        body: {},
        scenario,
      });

    it('validates a live offer at its price', async () => {
      const { session, offer } = await selected();
      const body = repriceResponseSchema.parse((await reprice(session)).json()).data;
      expect(body.outcomes).toEqual([
        {
          direction: 'outbound',
          outcome: 'VALIDATED',
          previousTotalMinor: offer.price.totalMinor,
          currentTotalMinor: offer.price.totalMinor,
        },
      ]);
      expect(body.session.summary.readyToContinue).toBe(true);
    });

    it('reports an expired selection and refreshes it when the price is unchanged', async () => {
      const { session, offer } = await selected();
      const view = shoppingSessionResponseSchema.parse(
        (
          await call(`/v1/shopping-sessions/${session.id}`, {
            token: session.token,
            scenario: 'offer-expired',
          })
        ).json(),
      ).data;
      expect(view.selections.outbound!.status).toBe('EXPIRED');
      expect(view.summary.readyToContinue).toBe(false);

      const body = repriceResponseSchema.parse(
        (await reprice(session, 'offer-expired')).json(),
      ).data;
      expect(body.outcomes[0]!.outcome).toBe('REFRESHED');
      const refreshed = body.session.selections.outbound!;
      expect(refreshed.offer.id).not.toBe(offer.id);
      expect(refreshed.offer.price.totalMinor).toBe(offer.price.totalMinor);
      expect(refreshed.status).toBe('VALIDATED');
      expect(refreshed.lastCheck).toMatchObject({ outcome: 'REFRESHED' });
    });

    it('never applies a changed price without explicit acceptance', async () => {
      const { session, offer } = await selected();
      const body = repriceResponseSchema.parse(
        (await reprice(session, 'price-increase')).json(),
      ).data;
      const [outcome] = body.outcomes;
      expect(outcome!.outcome).toBe('PRICE_CHANGED');
      expect(outcome!.currentTotalMinor).toBeGreaterThan(offer.price.totalMinor);
      const selection = body.session.selections.outbound!;
      expect(selection.status).toBe('PRICE_CHANGED');
      // The total still shows the price the traveller accepted, not the new one.
      expect(body.session.summary.totalMinor).toBe(offer.price.totalMinor);
      expect(body.session.summary.readyToContinue).toBe(false);

      // Accept: select the pending offer (priced by the check), in the same time frame.
      const accepted = selectOfferResponseSchema.parse(
        (await select(session, 'outbound', selection.pendingOffer!.id, 'price-increase')).json(),
      ).data.session;
      expect(accepted.selections.outbound).toMatchObject({
        status: 'VALIDATED',
        pendingOffer: null,
      });
      expect(accepted.summary.totalMinor).toBe(outcome!.currentTotalMinor);
      expect(accepted.selections.outbound!.previous!.totalMinor).toBe(offer.price.totalMinor);
      expect(accepted.summary.readyToContinue).toBe(true);
    });

    it('marks a selection unavailable when its flights sell out, keeping the other leg', async () => {
      const session = await newSession(ROUND_TRIP);
      await select(session, 'outbound', (await offerFor(OUTBOUND, 'LIGHT')).id);
      await select(session, 'inbound', (await offerFor(INBOUND, 'LIGHT')).id);
      const body = repriceResponseSchema.parse(
        (
          await call(`/v1/shopping-sessions/${session.id}/reprice`, {
            method: 'POST',
            token: session.token,
            body: { directions: ['inbound'] },
            scenario: 'sold-out',
          })
        ).json(),
      ).data;
      expect(body.outcomes).toEqual([
        expect.objectContaining({ direction: 'inbound', outcome: 'UNAVAILABLE' }),
      ]);
      expect(body.session.selections.inbound!.status).toBe('UNAVAILABLE');
      expect(body.session.selections.outbound!.status).toBe('SELECTED');
    });
  });

  it('expires sessions and says so', async () => {
    const session = await newSession();
    await expectError(
      await call(`/v1/shopping-sessions/${session.id}`, {
        token: session.token,
        scenario: 'session-expired',
      }),
      410,
      'SESSION_EXPIRED',
    );
  });

  it('deletes a session for its owner only', async () => {
    const session = await newSession();
    const other = await newSession();
    await expectError(
      await call(`/v1/shopping-sessions/${session.id}`, { method: 'DELETE', token: other.token }),
      404,
      'SESSION_NOT_FOUND',
    );
    const deleted = await call(`/v1/shopping-sessions/${session.id}`, {
      method: 'DELETE',
      token: session.token,
    });
    expect(deleted.statusCode).toBe(204);
    await expectError(
      await call(`/v1/shopping-sessions/${session.id}`, { token: session.token }),
      404,
      'SESSION_NOT_FOUND',
    );
  });

  it('applies concurrent changes one at a time, without losing any', async () => {
    const session = await newSession(ROUND_TRIP);
    const outs = await offersFor(OUTBOUND);
    const backs = await offersFor(INBOUND);
    const requests = [
      ...outs.data.offers.map((offer) => select(session, 'outbound', offer.id)),
      ...backs.data.offers.map((offer) => select(session, 'inbound', offer.id)),
      call(`/v1/shopping-sessions/${session.id}/reprice`, {
        method: 'POST',
        token: session.token,
        body: {},
      }),
    ];
    const responses = await Promise.all(requests);
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    const final = shoppingSessionResponseSchema.parse(
      (await call(`/v1/shopping-sessions/${session.id}`, { token: session.token })).json(),
    ).data;
    expect(final.version).toBe(requests.length);
    expect(final.selections.outbound).not.toBeNull();
    expect(final.selections.inbound).not.toBeNull();
    expect(final.summary.totalMinor).toBe(
      final.selections.outbound!.offer.price.totalMinor +
        final.selections.inbound!.offer.price.totalMinor,
    );
  });
});

describe('memory bounds', () => {
  it('never holds more sessions or offers than configured', () => {
    const clock = createClock(TODAY);
    const retailing = createRetailingService({
      flights: createFlightService({ clock, seed: SEED, horizonDays: 30 }),
      clock,
      config: { ...DEFAULT_RETAILING_CONFIG, maxSessions: 5, maxOffers: 8, offerReuseMs: 0 },
    });
    for (let i = 0; i < 25; i += 1) {
      expect(retailing.createSession(ONE_WAY).ok).toBe(true);
      const offers = retailing.searchOffers({
        itineraryId: OUTBOUND,
        passengers: { adults: (i % 3) + 1, children: 0, infants: 0 },
        cabin: 'economy',
      });
      expect(offers.ok).toBe(true);
    }
    expect(retailing.stats()).toMatchObject({ sessions: 5, offers: 8 });
    // Every one of the 25 searches created offers (offerReuseMs: 0), and 25 sessions were made.
    expect(retailing.stats().sessionsCreated).toBe(25);
    expect(retailing.stats().offersCreated).toBeGreaterThan(8);
  });
});
