#!/usr/bin/env node
/**
 * Public preflight of the two live storefronts before any benchmark (readiness doc, step 1).
 * About ten sequential GETs per storefront: no load, no writes, nothing that creates offers or
 * sessions in the shared API. Runs from anywhere (no Railway access, no tokens).
 *
 *   NODE_URL=https://… NEXTRS_URL=https://… node benchmarks/railway/preflight.mjs [out.json]
 *
 * Checks per storefront: readiness (and that it reaches the API), the home page (status,
 * encoding with `accept-encoding: gzip`, prerender header, edge, build fingerprint), one JS and
 * one CSS asset (encoding, cache policy), an RSC navigation (307 to the `_rsc` URL, then
 * `text/x-component`), two API proxy routes and a prerendered destination page.
 * It cannot see Railway's deployment IDs, limits, region or replicas: those come from Railway
 * (DEPLOYMENTS file, readiness doc). Exit 0 all checks passed; 2 a check failed; 1 error.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const env = process.env;
const targets = { node: env.NODE_URL, nextrs: env.NEXTRS_URL };
if (!targets.node || !targets.nextrs) {
  process.stderr.write('preflight: set NODE_URL and NEXTRS_URL\n');
  process.exit(1);
}

async function get(url, headers = {}) {
  const started = performance.now();
  const response = await fetch(url, {
    headers: { 'accept-encoding': 'gzip', ...headers },
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  const body = Buffer.from(await response.arrayBuffer());
  const h = (name) => response.headers.get(name);
  return {
    status: response.status,
    ms: Math.round(performance.now() - started),
    // fetch decodes the body; the header still says what came over the wire.
    encoding: h('content-encoding'),
    type: h('content-type'),
    cacheControl: h('cache-control'),
    edge: h('x-railway-edge'),
    server: h('server'),
    prerender: h('x-nextjs-prerender'),
    nextCache: h('x-nextjs-cache'),
    location: h('location'),
    bytes: body.length,
    text: body.toString('utf8'),
  };
}

const strip = ({ text, ...rest }) => rest;
const result = { kind: 'velasia-preflight', at: new Date().toISOString(), storefronts: {} };
let failed = 0;

for (const [runtime, origin] of Object.entries(targets)) {
  const checks = [];
  const check = (name, passed, detail) => {
    checks.push({ name, passed, ...detail });
    if (!passed) failed += 1;
  };
  try {
    const ready = await get(`${origin}/api/internal/health/ready`);
    check('ready', ready.status === 200 && /"retailingApi":"ready"/.test(ready.text), {
      ...strip(ready),
      body: ready.text.slice(0, 120),
    });

    const home = await get(`${origin}/`);
    const assets = [
      ...new Set(
        [...home.text.matchAll(/(?:src|href)="(\/_next\/static\/[^"#]+)"/g)].map((m) =>
          m[1].replaceAll('&amp;', '&'),
        ),
      ),
    ].sort();
    const fingerprint = assets.length
      ? createHash('sha256').update(assets.join('\n')).digest('hex').slice(0, 16)
      : null;
    check('home', home.status === 200 && home.text.includes('</html>'), {
      ...strip(home),
      assetCount: assets.length,
      assetsSha256: fingerprint,
      deploymentId: /[?&](?:amp;)?dpl=([^"&\s,]+)/.exec(home.text)?.[1] ?? null,
    });
    check('home gzip', home.encoding === 'gzip', { encoding: home.encoding });

    for (const ext of ['js', 'css']) {
      const url = assets.find((a) => new RegExp(`\\.${ext}(\\?|$)`).test(a));
      if (!url) {
        check(`${ext} asset`, false, { reason: 'none referenced by /' });
        continue;
      }
      const asset = await get(`${origin}${url}`);
      check(`${ext} asset`, asset.status === 200 && asset.bytes > 0, { url, ...strip(asset) });
      check(`${ext} asset gzip`, asset.encoding === 'gzip', { encoding: asset.encoding });
    }

    const hop = await get(`${origin}/`, { RSC: '1' });
    const query = hop.location?.slice(hop.location.indexOf('?') + 1) ?? '';
    check('rsc redirect to _rsc', hop.status === 307 && query.startsWith('_rsc'), strip(hop));
    if (query.startsWith('_rsc')) {
      const rsc = await get(`${origin}/?${query}`, { RSC: '1' });
      check(
        'rsc payload',
        rsc.status === 200 && (rsc.type ?? '').includes('text/x-component'),
        strip(rsc),
      );
    }

    const aircraft = await get(`${origin}/api/aircraft`);
    check(
      'api proxy /api/aircraft',
      aircraft.status === 200 && JSON.parse(aircraft.text).data?.length > 0,
      strip(aircraft),
    );
    const flights = await get(
      `${origin}/api/flights?from=MNL&to=CEB&departureDate=2026-12-10&adults=1`,
    );
    check(
      'api proxy /api/flights',
      flights.status === 200 && JSON.parse(flights.text).data?.legs?.[0]?.itineraries?.length > 0,
      strip(flights),
    );
    const destination = await get(`${origin}/destinations/tokyo`);
    check('destination page', destination.status === 200, strip(destination));
  } catch (error) {
    check('reachable', false, { error: error.message });
  }
  result.storefronts[runtime] = { origin, checks };
}

result.passed = failed === 0;
const out = process.argv[2];
if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
for (const [runtime, { checks }] of Object.entries(result.storefronts)) {
  for (const c of checks) {
    const detail = [
      c.status,
      c.ms !== undefined ? `${c.ms} ms` : '',
      c.encoding ?? '',
      c.edge ?? '',
    ]
      .filter(Boolean)
      .join(' ');
    console.log(
      `${c.passed ? 'PASS' : 'FAIL'}  ${runtime.padEnd(6)} ${c.name.padEnd(26)} ${detail}`,
    );
  }
}
console.log(result.passed ? 'preflight: all checks passed' : `preflight: ${failed} checks failed`);
process.exit(result.passed ? 0 : 2);
