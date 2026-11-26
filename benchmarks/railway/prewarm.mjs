#!/usr/bin/env node
/**
 * Offer-cache diagnostic for the shared API (docs/deployment/M9.3-BENCHMARK-CORRECTNESS.md).
 * Warms the offer store through both storefronts, then checks that both storefronts are handed
 * the same offers inside one reuse window.
 *
 *   node benchmarks/railway/prewarm.mjs            (environment below; writes $OUT/prewarm.json)
 *
 * M9.3: this NO LONGER makes offer workloads comparable, and pair.mjs refuses them. Until M9.1
 * a pinned VELASIA_TODAY froze the API's clock, so an offer, once created for a key, was reused
 * for the life of the process and one pre-warm kept the cache warm for a whole series. That was
 * the frozen-clock bug: offers now expire in real time (reused for 60 s, valid 15 minutes), so
 * the cache cools between 120 s runs and the second runtime of a pair can meet a different
 * cache state than the first. What this script still shows, for planning cold/warm offer-cache
 * experiments in an isolated environment: whether both storefronts reach the same offers
 * within one window, and whether the business date is pinned.
 *
 * Steps (sequential, rate-capped, never both storefronts at once):
 *   1  every request URL of WORKLOADS for every fixture itinerary, through Node.js, then NextRS
 *   2  verify: /api/offers for every itinerary through both; offer ids must be identical per
 *      itinerary on both storefronts, and the API's offer store must not grow during the check
 * Exit 0 verified; 1 error; 2 not verified (details in prewarm.json).
 *
 * Environment: NODE_URL, NEXTRS_URL, API_URL (private), FIXTURES, METRICS_TOKEN,
 * RETAILING_API_SERVICE_TOKEN (never printed); WORKLOADS=offers,comparison;
 * RATE=5 (requests/s); OUT=/tmp/velasia-bench
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseMetrics, snapshotProblems, value } from './gate-lib.mjs';

const die = (message, code = 1) => {
  process.stderr.write(`prewarm: ${message}\n`);
  process.exit(code);
};
const env = process.env;
const need = (name) => env[name] || die(`${name} is not set`);
const storefronts = { node: need('NODE_URL'), nextrs: need('NEXTRS_URL') };
const apiUrl = need('API_URL').replace(/\/$/, '');
const fixtures = JSON.parse(readFileSync(need('FIXTURES'), 'utf8'));
const workloads = (env.WORKLOADS ?? 'offers,comparison').split(',').map((w) => w.trim());
const rate = Number(env.RATE ?? 5);
if (!(rate > 0 && rate <= 20)) die('RATE must be between 0 and 20 requests/s');
const out = env.OUT ?? '/tmp/velasia-bench';
mkdirSync(out, { recursive: true });

// Request URLs exactly as benchmarks/node-baseline/k6/scenarios.js builds them (keep in sync).
const searchUrl = (trip) =>
  `/flights?trip=one-way&from=${trip.origin}&to=${trip.destination}&depart=${trip.date}&adults=1&cabin=economy`;
const offersUrl = (trip) =>
  `/api/offers?itineraryId=${trip.itineraryId}&adults=1&children=0&infants=0`;
const URLS = {
  offers: offersUrl,
  comparison: (trip) => `${searchUrl(trip)}&fares=${trip.itineraryId}`,
  'flight-search': searchUrl,
  'route-handler': (trip) =>
    `/api/flights?from=${trip.origin}&to=${trip.destination}&departureDate=${trip.date}&adults=1`,
};
for (const w of workloads) if (!URLS[w]) die(`no pre-warm for workload '${w}'`);

const trips = [...new Map(fixtures.itineraries.map((t) => [t.itineraryId, t])).values()];
if (trips.length === 0) die('FIXTURES has no itineraries');
const paths = [...new Set(workloads.flatMap((w) => fixtures.itineraries.map(URLS[w])))];

const headers = {
  ...(env.METRICS_TOKEN ? { authorization: `Bearer ${env.METRICS_TOKEN}` } : {}),
  ...(env.RETAILING_API_SERVICE_TOKEN
    ? { 'x-velasia-service-token': env.RETAILING_API_SERVICE_TOKEN }
    : {}),
};
async function offerStore() {
  const response = await fetch(`${apiUrl}/metrics`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`metrics: HTTP ${response.status}`);
  const snapshot = { at: Date.now(), ...parseMetrics(await response.text()) };
  const problems = snapshotProblems(snapshot);
  if (problems.length) throw new Error(`metrics invalid: ${problems.join('; ')}`);
  return {
    offers: value(snapshot, 'velasia_memory_store_entries', { store: 'offers' }),
    startTime: value(snapshot, 'process_start_time_seconds'),
  };
}

const gapMs = 1000 / rate;
let next = 0;
async function get(origin, path) {
  const wait = next - performance.now();
  if (wait > 0) await sleep(wait);
  next = performance.now() + gapMs;
  const response = await fetch(`${origin}${path}`, {
    headers: { 'accept-encoding': 'gzip' },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  return { status: response.status, body };
}

const result = {
  kind: 'velasia-prewarm',
  startedAt: new Date().toISOString(),
  workloads,
  itineraries: trips.length,
  requestsPerStorefront: paths.length,
  rate,
  assumptions: [
    'M9.3: VELASIA_TODAY pins the business date only; offers are reused for 60 s of real time and expire after 15 minutes',
    'offer key = itineraryId|adults|children|infants|inventoryVersion|demandShift (retailing-service.ts searchOffers)',
    'offers live in the API process memory only (never TalaDB); an API restart empties the store',
    'a warm state therefore lasts at most one 60 s reuse window: no pre-warm can hold it across a series of pairs',
  ],
  offerStore: {},
  referenceDates: [],
  reuseWindowSeconds: 60,
  errors: [],
  mismatches: [],
};
const save = () => writeFileSync(join(out, 'prewarm.json'), `${JSON.stringify(result, null, 2)}\n`);

try {
  result.offerStore.before = await offerStore();
  for (const runtime of ['node', 'nextrs']) {
    console.log(`warm ${runtime}: ${paths.length} requests at ≤ ${rate}/s`);
    for (const path of paths) {
      const r = await get(storefronts[runtime], path);
      if (r.status !== 200) result.errors.push(`${runtime} ${path}: HTTP ${r.status}`);
    }
  }
  result.offerStore.afterWarm = await offerStore();
  result.verifyStartedAt = performance.now();
  console.log(`verify: /api/offers for ${trips.length} itineraries on both storefronts`);
  for (const trip of trips) {
    const ids = {};
    for (const runtime of ['node', 'nextrs']) {
      const r = await get(storefronts[runtime], offersUrl(trip));
      if (r.status !== 200) {
        result.errors.push(`verify ${runtime} ${trip.itineraryId}: HTTP ${r.status}`);
        continue;
      }
      const parsed = JSON.parse(r.body);
      ids[runtime] = parsed.data.offers
        .map((o) => o.id)
        .sort()
        .join(',');
      const referenceDate = parsed.meta?.referenceDate;
      if (!result.referenceDates.includes(referenceDate)) result.referenceDates.push(referenceDate);
    }
    if (ids.node !== ids.nextrs) {
      result.mismatches.push({ itineraryId: trip.itineraryId, node: ids.node, nextrs: ids.nextrs });
    }
  }
  result.offerStore.afterVerify = await offerStore();
  result.verifySeconds = (performance.now() - result.verifyStartedAt) / 1000;
  delete result.verifyStartedAt;
} catch (error) {
  result.errors.push(error.message);
}

const s = result.offerStore;
result.checks = {
  noErrors: result.errors.length === 0,
  // One business date for every answer (VELASIA_TODAY pinned, or no day change meanwhile).
  businessDateStable: result.referenceDates.length === 1 && Boolean(result.referenceDates[0]),
  // Same offers on both only means "warm" if the whole check fits in one reuse window.
  withinOneReuseWindow:
    Number.isFinite(result.verifySeconds) && result.verifySeconds < result.reuseWindowSeconds,
  sameOffersOnBothStorefronts: result.mismatches.length === 0,
  storeStableDuringVerify:
    Number.isFinite(s.afterWarm?.offers) && s.afterVerify?.offers === s.afterWarm.offers,
  sameApiProcess:
    Number.isFinite(s.before?.startTime) &&
    s.before.startTime === s.afterWarm?.startTime &&
    s.before.startTime === s.afterVerify?.startTime,
};
result.verified = Object.values(result.checks).every(Boolean);
result.finishedAt = new Date().toISOString();
save();
console.log(
  `prewarm ${result.verified ? 'VERIFIED' : 'NOT VERIFIED'}: offer store ${s.before?.offers} → ${s.afterWarm?.offers} → ${s.afterVerify?.offers}; ` +
    `${result.mismatches.length} mismatches, ${result.errors.length} errors → ${join(out, 'prewarm.json')}`,
);
console.log(
  'prewarm: a warm offer cache lasts one 60 s reuse window (M9.3), so this result says nothing about ' +
    'later runs; pair.mjs refuses the offers and comparison workloads.',
);
process.exit(result.verified ? 0 : 2);
