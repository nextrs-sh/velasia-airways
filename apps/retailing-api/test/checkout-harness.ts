import { randomBytes, randomUUID } from 'node:crypto';
import {
  createSessionResponseSchema,
  offerSearchResponseSchema,
  prepareCheckoutResponseSchema,
  paymentResultResponseSchema,
  seatsOf,
  sessionSeatMapResponseSchema,
  validateBookingResponseSchema,
  type FlightSearch,
  type Offer,
  type PaymentMethod,
  type Seat,
  type ShoppingSession,
  type SimulatedOutcome,
  type TravellerInput,
} from '@velasia/contracts';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { expect } from 'vitest';
import { buildApp, type TestHooks } from '../src/app';
import { createClock, type Clock } from '../src/clock';
import type { ApiConfig } from '../src/config';
import type { CrashPoint } from '../src/crash';
import { TODAY } from './helpers';

/*
 * Shared harness for the Milestone 5 tests: an app with its own temporary TalaDB file and a
 * clock the test can move, plus helpers that take a shopping session to a READY review.
 * Every traveller is synthetic.
 */

export interface ManualClock {
  clock: Clock;
  advance(ms: number): void;
}

/**
 * "Today" pinned like the E2E suite, with a "now" the test can move forward. `advance` moves
 * business time and real time together (time passing on the unpinned system clock); the M9.3
 * clock tests move real time alone with `createClock(today, realNow)`.
 */
export function manualClock(today = TODAY): ManualClock {
  const base = createClock(today);
  let offset = 0;
  return {
    clock: {
      today: () => base.today(),
      businessNow: () => base.businessNow() + offset,
      now: () => base.businessNow() + offset,
      pinned: true,
    },
    advance(ms) {
      offset += ms;
    },
  };
}

export type Scenario =
  | 'offer-expired'
  | 'price-increase'
  | 'sold-out'
  | 'session-expired'
  | 'seat-taken'
  | 'hold-expired';

export interface CallOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Shopping session token or guest token, as a bearer token. */
  token?: string;
  /** Guest token for checkout (`x-velasia-guest`). */
  guest?: string;
  body?: unknown;
  scenario?: Scenario;
  fault?: string;
  /** Test-only crash point (child-process tests). */
  crash?: CrashPoint;
  /** Milestone 6: an account session token (`x-velasia-account`). */
  account?: string;
  /** Milestone 6: the rate-limit client key (`x-velasia-client`). */
  client?: string;
}

/** What a call returns, whether it went through `inject` or real HTTP. */
export interface CallResult {
  statusCode: number;
  body: string;
  headers: Record<string, string | string[] | number | undefined>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json(): any;
}

/** Anything that can make API calls: the in-process app or a real server process. */
export interface Caller {
  call(url: string, options?: CallOptions): Promise<CallResult>;
}

export interface Harness extends Caller {
  app: FastifyInstance;
  time: ManualClock;
  close(): Promise<void>;
}

function headersFor({ token, guest, scenario, fault, crash, account, client }: CallOptions) {
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(guest ? { 'x-velasia-guest': guest } : {}),
    ...(scenario ? { 'x-velasia-scenario': scenario } : {}),
    ...(fault ? { 'x-velasia-fault': fault } : {}),
    ...(crash ? { 'x-velasia-crash': crash } : {}),
    ...(account ? { 'x-velasia-account': account } : {}),
    ...(client ? { 'x-velasia-client': client } : {}),
  };
}

/** A caller for a real API process at `baseUrl`. */
export function httpCaller(baseUrl: string): Caller {
  return {
    async call(url, options = {}) {
      const { method = 'GET', body } = options;
      const response = await fetch(new URL(url, baseUrl), {
        method,
        headers: {
          ...headersFor(options),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await response.text();
      return {
        statusCode: response.status,
        body: text,
        headers: Object.fromEntries(response.headers),
        json: () => JSON.parse(text),
      };
    },
  };
}

/** Quick, but with a provider timeout that a loaded CI machine still meets. */
export const FAST_PAYMENTS: ApiConfig['payments'] = {
  outcomeControls: true,
  pendingResolveMs: 150,
  responseDelayMs: 0,
  timeoutMs: 1_500,
};

export async function startHarness({
  config = {},
  testHooks = {},
  logger,
}: {
  config?: Partial<ApiConfig>;
  testHooks?: TestHooks;
  /** Fastify logger options, to inspect what the API logs (Milestone 6). */
  logger?: FastifyServerOptions['logger'];
} = {}): Promise<Harness> {
  const time = manualClock();
  const app = buildApp({
    ...(logger ? { logger } : {}),
    config: {
      today: TODAY,
      faults: { enabled: true, timeoutMs: 300 },
      payments: FAST_PAYMENTS,
      ...config,
    },
    testHooks: { clock: time.clock, ...testHooks },
  });
  await app.ready();
  const call = async (url: string, options: CallOptions = {}): Promise<CallResult> => {
    const { method = 'GET', body } = options;
    return app.inject({
      method,
      url,
      headers: headersFor(options),
      ...(body === undefined ? {} : { payload: body as object }),
    });
  };
  return { app, time, call, close: () => app.close() };
}

export const newGuestToken = () => randomBytes(32).toString('base64url');
export const newKey = () => randomUUID();

// ---------------------------------------------------------------------------
// Synthetic travellers
// ---------------------------------------------------------------------------

export const ADULT: TravellerInput = {
  id: 'ADT1',
  type: 'adult',
  title: 'MS',
  givenName: 'Ligaya',
  middleName: '',
  familyName: 'Testcase',
  dateOfBirth: '1991-02-14',
  nationality: 'PH',
  specialAssistance: '',
  infantOf: '',
};
export const ADULT_2: TravellerInput = {
  ...ADULT,
  id: 'ADT2',
  title: 'MR',
  givenName: 'Dakila',
  familyName: 'Sample',
  dateOfBirth: '1988-11-03',
};
export const CHILD: TravellerInput = {
  ...ADULT,
  id: 'CHD1',
  type: 'child',
  title: '',
  givenName: 'Malaya',
  dateOfBirth: '2017-08-20',
};
export const INFANT: TravellerInput = {
  ...ADULT,
  id: 'INF1',
  type: 'infant',
  title: '',
  givenName: 'Bituin',
  dateOfBirth: '2026-04-02',
  infantOf: 'ADT1',
};
export const CONTACT = { email: 'ligaya.testcase@example.com', phone: '+63 917 555 0199' };

// ---------------------------------------------------------------------------
// From search to a READY review
// ---------------------------------------------------------------------------

export const MNL_SIN: FlightSearch = {
  tripType: 'one-way',
  origin: 'MNL',
  destination: 'SIN',
  departDate: '2026-12-15',
  passengers: { adults: 1, children: 0, infants: 0 },
  cabin: 'economy',
};
export const OUTBOUND = 'NV501-20261215'; // A321neo
export const INBOUND = 'NV502-20261220';
/** MNL → TPE on 3 Dec: exactly one Business seat left in the seeded inventory. */
export const LAST_BUSINESS_SEAT = {
  itineraryId: 'NV541-20261203',
  search: {
    ...MNL_SIN,
    destination: 'TPE',
    departDate: '2026-12-03',
    cabin: 'business',
  } satisfies FlightSearch,
};

export interface SessionRef {
  id: string;
  token: string;
}

export interface ReadyCheckout extends SessionRef {
  session: ShoppingSession;
  version: number;
  totalMinor: number;
}

export interface TripPlan {
  legs?: { itineraryId: string; family: Offer['family'] }[];
  search?: Partial<FlightSearch>;
  passengers?: TravellerInput[];
  /** Seats per flight: `auto` picks a free regular seat for every seated traveller. */
  seats?: 'auto' | 'none' | Record<string, Record<string, string>>;
  /** Extras to buy (ancillary changes). */
  extras?: object[];
}

async function offerFor(
  h: Caller,
  itineraryId: string,
  family: Offer['family'],
  search: FlightSearch,
) {
  const p = search.passengers;
  const response = await h.call(
    `/v1/offers?itineraryId=${itineraryId}&adults=${p.adults}&children=${p.children}&infants=${p.infants}`,
  );
  expect(response.statusCode, response.body).toBe(200);
  const offer = offerSearchResponseSchema
    .parse(response.json())
    .data.offers.find((candidate) => candidate.family === family);
  if (!offer) throw new Error(`no ${family} offer for ${itineraryId}`);
  return offer;
}

const ok = (response: CallResult, status = 200) => {
  expect(response.statusCode, response.body).toBe(status);
  return response;
};

export async function readyCheckout(h: Caller, plan: TripPlan = {}): Promise<ReadyCheckout> {
  const search: FlightSearch = { ...MNL_SIN, ...plan.search };
  const legs = plan.legs ?? [{ itineraryId: OUTBOUND, family: 'CLASSIC' as const }];
  const passengers = plan.passengers ?? [ADULT];
  const created = ok(
    await h.call('/v1/shopping-sessions', { method: 'POST', body: { search } }),
    201,
  );
  const { session, token } = createSessionResponseSchema.parse(created.json()).data;
  const s: SessionRef = { id: session.id, token };
  const base = `/v1/shopping-sessions/${s.id}`;
  for (const [index, leg] of legs.entries()) {
    const offer = await offerFor(h, leg.itineraryId, leg.family, search);
    ok(
      await h.call(`${base}/select`, {
        method: 'POST',
        token,
        body: { direction: index === 0 ? 'outbound' : 'inbound', offerId: offer.id },
      }),
    );
  }
  ok(await h.call(`${base}/reprice`, { method: 'POST', token, body: {} }));
  ok(
    await h.call(`${base}/passengers`, {
      method: 'PUT',
      token,
      body: { passengers, contact: CONTACT },
    }),
  );
  const flightIds = legs.flatMap((leg) => leg.itineraryId.split('_'));
  const seatable = passengers.filter((passenger) => passenger.type !== 'infant');
  const assignments: { travellerId: string; flightId: string; seatId: string }[] = [];
  if (plan.seats === 'auto' || plan.seats === undefined) {
    for (const flightId of flightIds) {
      const map = sessionSeatMapResponseSchema.parse(
        ok(await h.call(`${base}/seatmaps/${flightId}`, { token })).json(),
      ).data;
      const free = seatsOf(map.seatMap).filter(
        (seat: Seat) =>
          seat.status === 'AVAILABLE' &&
          seat.cabin === map.fare.cabin &&
          seat.restrictions.length === 0,
      );
      seatable.forEach((traveller, index) => {
        const seat = free[index];
        if (seat) assignments.push({ travellerId: traveller.id, flightId, seatId: seat.id });
      });
    }
  } else if (plan.seats !== 'none') {
    for (const [flightId, byTraveller] of Object.entries(plan.seats)) {
      for (const [travellerId, seatId] of Object.entries(byTraveller)) {
        assignments.push({ travellerId, flightId, seatId });
      }
    }
  }
  if (assignments.length) {
    ok(await h.call(`${base}/seats`, { method: 'PUT', token, body: { assignments } }));
  }
  ok(await h.call(`${base}/steps`, { method: 'POST', token, body: { step: 'seats' } }));
  if (plan.extras?.length) {
    ok(
      await h.call(`${base}/ancillaries`, {
        method: 'PUT',
        token,
        body: { changes: plan.extras },
      }),
    );
  }
  ok(await h.call(`${base}/steps`, { method: 'POST', token, body: { step: 'extras' } }));
  const validated = validateBookingResponseSchema.parse(
    ok(await h.call(`${base}/validate`, { method: 'POST', token, body: {} })).json(),
  ).data;
  expect(validated.review.status, JSON.stringify(validated.review.issues)).toBe('READY');
  return {
    ...s,
    session: validated.session,
    version: validated.session.version,
    totalMinor: validated.quote.totals.totalMinor,
  };
}

// ---------------------------------------------------------------------------
// Checkout and payment calls
// ---------------------------------------------------------------------------

export interface PrepareOptions {
  key?: string;
  expectedVersion?: number;
  acceptedTotalMinor?: number;
  scenario?: Scenario;
  crash?: CrashPoint;
  extra?: object;
}

export function prepare(
  h: Caller,
  ready: ReadyCheckout,
  guest: string,
  {
    key = newKey(),
    expectedVersion,
    acceptedTotalMinor,
    scenario,
    crash,
    extra = {},
  }: PrepareOptions = {},
) {
  return h.call('/v1/checkout/prepare', {
    method: 'POST',
    token: ready.token,
    guest,
    scenario,
    crash,
    body: {
      sessionId: ready.id,
      idempotencyKey: key,
      expectedVersion: expectedVersion ?? ready.version,
      acceptedTotalMinor: acceptedTotalMinor ?? ready.totalMinor,
      ...extra,
    },
  });
}

/** Prepare and expect a new pending order. */
export async function prepared(
  h: Caller,
  ready: ReadyCheckout,
  guest: string,
  options?: PrepareOptions,
) {
  const response = await prepare(h, ready, guest, options);
  expect(response.statusCode, response.body).toBe(201);
  return prepareCheckoutResponseSchema.parse(response.json()).data.order;
}

export interface PayOptions {
  key?: string;
  method?: PaymentMethod;
  outcome?: SimulatedOutcome;
  scenario?: Scenario;
  fault?: string;
  crash?: CrashPoint;
  extra?: object;
}

export function pay(
  h: Caller,
  orderId: string,
  guest: string,
  {
    key = newKey(),
    method = 'DEMO_CARD',
    outcome,
    scenario,
    fault,
    crash,
    extra = {},
  }: PayOptions = {},
) {
  return h.call(`/v1/orders/${orderId}/payment-attempts`, {
    method: 'POST',
    token: guest,
    scenario,
    fault,
    crash,
    body: {
      idempotencyKey: key,
      method,
      ...(outcome ? { simulatedOutcome: outcome } : {}),
      ...extra,
    },
  });
}

export const paymentOf = (response: CallResult) =>
  paymentResultResponseSchema.parse(response.json()).data;

export const paymentStatus = (h: Caller, orderId: string, guest: string, scenario?: Scenario) =>
  h.call(`/v1/orders/${orderId}/payment-status`, { token: guest, scenario });
