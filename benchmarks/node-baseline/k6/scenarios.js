/*
 * Milestone 7 — Node.js baseline workloads for Velasia Airways (k6).
 *
 *   k6 run -e SCENARIO=flight-search -e WEB=http://127.0.0.1:3400 -e API=http://127.0.0.1:4400 \
 *     -e FIXTURES=fixtures.json -e ACTION=action.json -e VUS=20 -e DURATION=60s k6/scenarios.js
 *
 * Every request checks its response for correctness (status and content), not only that it
 * answered. Business refusals that are correct outcomes under load (a seat sold meanwhile:
 * INVENTORY_UNAVAILABLE / SEAT_UNAVAILABLE) are counted separately and are not errors.
 * Synthetic data only. Benchmark rules: docs in ../README.md.
 *
 * Railway paired runs (docs/deployment/railway-benchmark-readiness.md) add `-e PICK=cycle`:
 * requests then walk every list in the same order on both runtimes instead of sampling at
 * random. `static-assets` and `rsc` need no FIXTURES file.
 *
 * `-e RATE=<iterations per second>` replaces the closed model (VUS looping as fast as they can)
 * with a fixed offered load (constant-arrival-rate; `PRE_VUS` / `MAX_VUS` size the pool). k6
 * then reports `dropped_iterations` when it could not start an iteration on time. Every
 * scenario here except `cached` (2) issues one request per iteration.
 * `-e ACCEPT_ENCODING=gzip` sends that header on every page request, as a browser would.
 */
import { check } from 'k6';
import encoding from 'k6/encoding';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';

const WEB = __ENV.WEB;
const API = __ENV.API;
const SCENARIO = __ENV.SCENARIO;
const fixtures = __ENV.FIXTURES
  ? JSON.parse(open(__ENV.FIXTURES))
  : { itineraries: [], bookings: [], accounts: [] };
const action = __ENV.ACTION ? JSON.parse(open(__ENV.ACTION)) : null;
const actionBody = action ? encoding.b64decode(action.body) : null;

const RATE = Number(__ENV.RATE ?? 0);
const closedModel = {
  executor: 'constant-vus',
  vus: Number(__ENV.VUS ?? 20),
  duration: __ENV.DURATION ?? '60s',
  gracefulStop: '10s',
};
const openModel = {
  executor: 'constant-arrival-rate',
  rate: RATE,
  timeUnit: '1s',
  duration: __ENV.DURATION ?? '60s',
  preAllocatedVUs: Number(__ENV.PRE_VUS ?? Math.max(2, Math.ceil(RATE * 2))),
  maxVUs: Number(__ENV.MAX_VUS ?? Math.max(10, Math.ceil(RATE * 10))),
  gracefulStop: '10s',
};

export const options = {
  scenarios: { main: RATE > 0 ? openModel : closedModel },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
  discardResponseBodies: false,
};

const correct = new Rate('velasia_correct');
const conflicts = new Counter('velasia_inventory_conflicts');
const step = {
  session: new Trend('velasia_step_session_ms', true),
  offers: new Trend('velasia_step_offers_ms', true),
  select: new Trend('velasia_step_select_ms', true),
  reprice: new Trend('velasia_step_reprice_ms', true),
  passengers: new Trend('velasia_step_passengers_ms', true),
  validate: new Trend('velasia_step_validate_ms', true),
  prepare: new Trend('velasia_step_checkout_prepare_ms', true),
  payment: new Trend('velasia_step_payment_ms', true),
};

// The M7 baseline sampled at random (still the default, so its runs stay reproducible).
// PICK=cycle: the n-th iteration of the test takes item n, so two runs issue the same sequence.
const CYCLE = __ENV.PICK === 'cycle';
const pick = (list) =>
  list[
    CYCLE ? exec.scenario.iterationInTest % list.length : Math.floor(Math.random() * list.length)
  ];
const DESTINATIONS = [
  'manila',
  'cebu',
  'davao',
  'singapore',
  'tokyo',
  'seoul',
  'bangkok',
  'hong-kong',
  'kuala-lumpur',
  'taipei',
  'osaka',
  'ho-chi-minh-city',
];
const json = { headers: { 'content-type': 'application/json' } };
const bearer = (token, extra = {}) => ({
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...extra },
});
const uuid = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
const token32 = () => encoding.b64encode(uuid() + uuid(), 'rawurl').slice(0, 43);

// Status distribution and effective compression of every checked response.
const statusClass = {
  2: new Counter('velasia_status_2xx'),
  3: new Counter('velasia_status_3xx'),
  4: new Counter('velasia_status_4xx'),
  5: new Counter('velasia_status_5xx'),
};
const status429 = new Counter('velasia_status_429');
const statusOther = new Counter('velasia_status_other');
const compressed = new Rate('velasia_compressed');
const TEXTUAL = /html|json|javascript|css|x-component|text\//;

function ok(response, name, predicate = () => true) {
  const passed = check(response, { [name]: (r) => predicate(r) });
  correct.add(passed);
  (statusClass[Math.floor(response.status / 100)] ?? statusOther).add(1);
  if (response.status === 429) status429.add(1);
  // Text answers of at least 1 KiB: did they come back encoded? (A runtime may leave smaller
  // answers as they are, so those are not counted either way.)
  if (
    response.status === 200 &&
    TEXTUAL.test(response.headers['Content-Type'] ?? '') &&
    (response.body?.length ?? 0) >= 1024
  ) {
    compressed.add(/gzip|br|deflate|zstd/.test(response.headers['Content-Encoding'] ?? ''));
  }
  return passed;
}

/** Page requests carry `accept-encoding` when ACCEPT_ENCODING is set. */
const ENCODING = __ENV.ACCEPT_ENCODING;
const get = (url, params = {}) =>
  http.get(
    url,
    ENCODING
      ? { ...params, headers: { 'accept-encoding': ENCODING, ...(params.headers ?? {}) } }
      : params,
  );
const html = (r) => r.status === 200 && r.body.includes('</html>');
const searchUrl = (trip) =>
  `/flights?trip=one-way&from=${trip.origin}&to=${trip.destination}&depart=${trip.date}&adults=1&cabin=economy`;

// RSC payloads for client-side navigation: `RSC: 1` (as in tests/parity) plus the `_rsc`
// cache-busting key the server asks for (learned in setup()), so no redirect hop is measured.
const RSC_PATHS = ['/', '/destinations', ...DESTINATIONS.map((slug) => `/destinations/${slug}`)];
const staticGzip = new Rate('velasia_static_gzip');

// --- Page and route workloads -------------------------------------------------------------
const pages = {
  // Build assets referenced by two prerendered pages (found in setup(), with their `?dpl=`
  // deployment-ID query), asked for with gzip. Correctness is the status; whether JS/CSS came
  // back gzip-encoded is its own rate, because a runtime may leave very small files as they are.
  'static-assets': (data) => {
    const url = pick(data.assets);
    const r = get(`${WEB}${url}`, {
      headers: { 'accept-encoding': 'gzip' },
      redirects: 0,
      tags: { name: 'static-asset' },
    });
    ok(r, 'static asset', (res) => res.status === 200 && res.body.length > 0);
    if (/\.(js|css)(\?|$)/.test(url)) {
      staticGzip.add(/gzip/.test(r.headers['Content-Encoding'] ?? ''));
    }
  },
  rsc: (data) => {
    const path = pick(RSC_PATHS);
    ok(
      get(`${WEB}${path}?${data.rscQuery}`, {
        headers: { RSC: '1' },
        redirects: 0,
        tags: { name: 'rsc' },
      }),
      'rsc payload',
      (r) => r.status === 200 && (r.headers['Content-Type'] ?? '').includes('text/x-component'),
    );
  },
  home: () =>
    ok(
      get(`${WEB}/`, { tags: { name: 'home' } }),
      'home',
      (r) => html(r) && r.body.includes('Velasia'),
    ),
  destination: () =>
    ok(
      get(`${WEB}/destinations/${pick(DESTINATIONS)}`, { tags: { name: 'destination' } }),
      'destination',
      html,
    ),
  cached: () => {
    ok(
      get(`${WEB}/destinations`, { tags: { name: 'destinations-index' } }),
      'destinations index',
      html,
    );
    ok(
      get(`${WEB}/api/aircraft`, { tags: { name: 'api-aircraft' } }),
      'aircraft',
      (r) => r.status === 200 && r.json('data.0') !== undefined,
    );
  },
  'flight-search': () =>
    ok(
      get(`${WEB}${searchUrl(pick(fixtures.itineraries))}`, { tags: { name: 'flights-ssr' } }),
      'search page',
      html,
    ),
  'route-handler': () => {
    const trip = pick(fixtures.itineraries);
    ok(
      get(
        `${WEB}/api/flights?from=${trip.origin}&to=${trip.destination}&departureDate=${trip.date}&adults=1`,
        { tags: { name: 'api-flights' } },
      ),
      'flights route handler',
      (r) => r.status === 200 && r.json('data.legs.0.itineraries') !== undefined,
    );
  },
  offers: () => {
    const trip = pick(fixtures.itineraries);
    ok(
      get(`${WEB}/api/offers?itineraryId=${trip.itineraryId}&adults=1&children=0&infants=0`, {
        tags: { name: 'api-offers' },
      }),
      'offers',
      (r) => r.status === 200 && r.json('data.offers.0.id') !== undefined,
    );
  },
  comparison: () => {
    const trip = pick(fixtures.itineraries);
    ok(
      get(`${WEB}${searchUrl(trip)}&fares=${trip.itineraryId}`, {
        tags: { name: 'fares-ssr' },
      }),
      'fare comparison page',
      (r) => html(r) && r.body.includes('fare-cards'),
    );
  },
  'server-action': () => {
    ok(
      http.post(`${WEB}${action.path}`, actionBody, {
        headers: action.headers,
        tags: { name: 'server-action' },
      }),
      'server action',
      (r) => r.status === 200 && r.body.includes('couldn'),
    );
  },
  'manage-booking': () => {
    const booking = pick(fixtures.bookings);
    ok(
      get(`${WEB}/manage-booking/${booking.orderId}`, {
        cookies: { 'velasia-guest': booking.guest },
        tags: { name: 'manage-ssr' },
      }),
      'manage booking page',
      (r) => html(r) && r.body.includes(booking.orderId),
    );
  },
  'my-trips': () => {
    const account = pick(fixtures.accounts);
    ok(
      get(`${WEB}/account/trips`, {
        cookies: { 'velasia-account': account.token },
        tags: { name: 'trips-ssr' },
      }),
      'my trips page',
      (r) => html(r) && r.body.includes('trip-card'),
    );
  },
};

// --- API workloads (the internal retailing API; the storefront runs these as Server Actions) --
function timed(trend, fn) {
  const started = Date.now();
  const result = fn();
  trend.add(Date.now() - started);
  return result;
}

function shoppingSession(trip) {
  const search = {
    tripType: 'one-way',
    origin: trip.origin,
    destination: trip.destination,
    departDate: trip.date,
    passengers: { adults: 1, children: 0, infants: 0 },
    cabin: 'economy',
  };
  const created = timed(step.session, () =>
    http.post(`${API}/v1/shopping-sessions`, JSON.stringify({ search }), {
      ...json,
      tags: { name: 'api-session-create' },
    }),
  );
  if (!ok(created, 'session created', (r) => r.status === 201)) return null;
  const { session, token } = created.json('data');
  const offers = timed(step.offers, () =>
    http.get(`${API}/v1/offers?itineraryId=${trip.itineraryId}&adults=1&children=0&infants=0`, {
      tags: { name: 'api-offers' },
    }),
  );
  const offerList = offers.status === 200 ? offers.json('data.offers') : [];
  const offer = offerList.find((o) => o.family === 'CLASSIC') ?? offerList[0];
  if (!offer) {
    conflicts.add(1); // sold out meanwhile: a correct answer under load
    return null;
  }
  const base = `${API}/v1/shopping-sessions/${session.id}`;
  const selected = timed(step.select, () =>
    http.post(`${base}/select`, JSON.stringify({ direction: 'outbound', offerId: offer.id }), {
      ...bearer(token),
      tags: { name: 'api-select' },
    }),
  );
  if (!ok(selected, 'offer selected', (r) => r.status === 200)) return null;
  const repriced = timed(step.reprice, () =>
    http.post(`${base}/reprice`, '{}', { ...bearer(token), tags: { name: 'api-reprice' } }),
  );
  ok(repriced, 'repriced', (r) => r.status === 200);
  return { session, token, base };
}

function checkout(withPayment) {
  const trip = pick(fixtures.itineraries);
  const shopping = shoppingSession(trip);
  if (!shopping) return;
  const { session, token, base } = shopping;
  const traveller = {
    id: 'ADT1',
    type: 'adult',
    title: 'MR',
    givenName: 'Load',
    middleName: '',
    familyName: 'Synthetic',
    dateOfBirth: '1988-05-05',
    nationality: 'PH',
    specialAssistance: '',
    infantOf: '',
  };
  const saved = timed(step.passengers, () =>
    http.put(
      `${base}/passengers`,
      JSON.stringify({
        passengers: [traveller],
        contact: { email: 'load.synthetic@example.com', phone: '+63 917 555 0101' },
      }),
      { ...bearer(token), tags: { name: 'api-passengers' } },
    ),
  );
  if (!ok(saved, 'travellers saved', (r) => r.status === 200)) return;
  http.post(`${base}/steps`, JSON.stringify({ step: 'seats' }), {
    ...bearer(token),
    tags: { name: 'api-step' },
  });
  http.post(`${base}/steps`, JSON.stringify({ step: 'extras' }), {
    ...bearer(token),
    tags: { name: 'api-step' },
  });
  const validated = timed(step.validate, () =>
    http.post(`${base}/validate`, '{}', { ...bearer(token), tags: { name: 'api-validate' } }),
  );
  if (
    !ok(
      validated,
      'review ready',
      (r) => r.status === 200 && r.json('data.review.status') === 'READY',
    )
  )
    return;
  const guest = token32();
  const prepared = timed(step.prepare, () =>
    http.post(
      `${API}/v1/checkout/prepare`,
      JSON.stringify({
        sessionId: session.id,
        idempotencyKey: uuid(),
        expectedVersion: validated.json('data.session.version'),
        acceptedTotalMinor: validated.json('data.quote.totals.totalMinor'),
      }),
      { ...bearer(token, { 'x-velasia-guest': guest }), tags: { name: 'api-checkout-prepare' } },
    ),
  );
  if (prepared.status === 409 && /INVENTORY_UNAVAILABLE|SEAT_UNAVAILABLE/.test(prepared.body)) {
    conflicts.add(1);
    return;
  }
  if (!ok(prepared, 'order held', (r) => r.status === 201)) return;
  if (!withPayment) return;
  const paid = timed(step.payment, () =>
    http.post(
      `${API}/v1/orders/${prepared.json('data.order.id')}/payment-attempts`,
      JSON.stringify({ idempotencyKey: uuid(), method: 'DEMO_CARD' }),
      { ...bearer(guest), tags: { name: 'api-payment' } },
    ),
  );
  ok(
    paid,
    'order confirmed',
    (r) => r.status === 201 && r.json('data.order.status') === 'CONFIRMED',
  );
}

const api = {
  'shopping-session': () => {
    const trip = pick(fixtures.itineraries);
    const shopping = shoppingSession(trip);
    if (!shopping) return;
    ok(
      http.get(shopping.base, { ...bearer(shopping.token), tags: { name: 'api-session-get' } }),
      'session read',
      (r) => r.status === 200,
    );
  },
  checkout: () => checkout(false),
  payment: () => checkout(true),
};

// --- Mixed browsing and booking ----------------------------------------------------------
const MIX = [
  [25, pages.home],
  [10, pages.destination],
  [20, pages['flight-search']],
  [10, pages['route-handler']],
  [10, pages.comparison],
  [5, pages['server-action']],
  [8, pages['manage-booking']],
  [5, pages['my-trips']],
  [4, api['shopping-session']],
  [3, api.payment],
];
const MIX_TOTAL = MIX.reduce((sum, [weight]) => sum + weight, 0);
export function mixed() {
  let roll = Math.random() * MIX_TOTAL;
  for (const [weight, run] of MIX) {
    roll -= weight;
    if (roll <= 0) return run();
  }
  return MIX[0][1]();
}

const ALL = { ...pages, ...api, mixed };

// Setup for the two scenarios that depend on the build being measured.
export function setup() {
  if (SCENARIO === 'static-assets') {
    // This build's asset URLs (build id in the path, deployment id in `?dpl=`).
    const assets = new Set();
    for (const path of ['/', '/destinations']) {
      const r = http.get(`${WEB}${path}`, { tags: { name: 'setup' } });
      for (const m of r.body.matchAll(/(?:src|href)="(\/_next\/static\/[^"#]+)"/g)) {
        assets.add(m[1].replaceAll('&amp;', '&'));
      }
    }
    if (assets.size === 0)
      exec.test.abort('static-assets: no /_next/static URLs in / or /destinations');
    return { assets: [...assets].sort() };
  }
  if (SCENARIO === 'rsc') {
    // Next.js redirects an RSC request without the `_rsc` key to the URL that has it; take the
    // key from that redirect instead of re-implementing how it is derived.
    const r = http.get(`${WEB}/`, { headers: { RSC: '1' }, redirects: 0, tags: { name: 'setup' } });
    const location = r.headers.Location ?? '';
    const query = r.status === 200 ? '_rsc' : location.slice(location.indexOf('?') + 1);
    if (!query.startsWith('_rsc'))
      exec.test.abort(`rsc: unexpected answer ${r.status} ${location}`);
    return { rscQuery: query };
  }
  return {};
}

export default function (data) {
  const run = ALL[SCENARIO];
  if (!run) exec.test.abort(`unknown SCENARIO ${SCENARIO}`);
  run(data);
}
