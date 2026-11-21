import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
} from '@playwright/test';
import { API_FLIGHTS, RUNTIMES, SEARCH, addDays, outline, pinClock } from './support';

/*
 * Milestone 8: Node.js versus NextRS, side by side. Each check asks both storefronts the same
 * question back to back (no other test runs concurrently: workers=1) and compares the answers
 * that the application, not the server runtime, decides: status, redirects, content type,
 * caching and security headers, the server-rendered outline of each page, and route handler
 * JSON from the shared retailing API.
 *
 * Runtime-specific values are deliberately NOT compared: `date`, `etag`, connection and
 * transfer headers, build-id-bearing asset URLs, and the RSC payload bytes.
 */

let node: APIRequestContext;
let nextrs: APIRequestContext;
test.beforeAll(async () => {
  node = await playwrightRequest.newContext({ baseURL: RUNTIMES.node });
  nextrs = await playwrightRequest.newContext({ baseURL: RUNTIMES.nextrs });
});
test.afterAll(async () => {
  await node.dispose();
  await nextrs.dispose();
});

/** Headers the application controls (next.config, route handlers, Next.js caching semantics). */
const CONTRACT_HEADERS = [
  'content-type',
  'cache-control',
  'location',
  'content-security-policy',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy',
  'vary',
];

async function both(path: string, headers: Record<string, string> = {}) {
  const [a, b] = await Promise.all([
    node.get(path, { maxRedirects: 0, headers }),
    nextrs.get(path, { maxRedirects: 0, headers }),
  ]);
  return { node: a, nextrs: b };
}

function contract(h: Record<string, string>) {
  return Object.fromEntries(CONTRACT_HEADERS.map((name) => [name, normalise(name, h[name])]));
}
function normalise(name: string, value: string | undefined) {
  if (value === undefined) return null;
  // Header order inside Vary is not meaningful. `Accept-Encoding` is left out here: it follows
  // response compression, which differs by runtime and is checked on its own below.
  if (name === 'vary')
    return value
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v !== 'accept-encoding')
      .sort()
      .join(', ');
  return value;
}

// ---------------------------------------------------------------------------------------------
test.describe('static and prerendered pages', () => {
  for (const path of ['/', '/destinations', '/help', '/about', '/credits', '/destinations/tokyo']) {
    test(`${path}: same status, headers and server-rendered outline`, async () => {
      const r = await both(path);
      expect(r.nextrs.status()).toBe(r.node.status());
      expect(contract(r.nextrs.headers())).toEqual(contract(r.node.headers()));
      expect(outline(await r.nextrs.text())).toEqual(outline(await r.node.text()));
      // Both runtimes serve the build's prerendered output (Next.js cache headers present).
      for (const name of ['x-nextjs-cache', 'x-nextjs-prerender']) {
        test.info().annotations.push({
          type: name,
          description: `node=${r.node.headers()[name] ?? '-'} nextrs=${r.nextrs.headers()[name] ?? '-'}`,
        });
      }
    });
  }

  test('metadata routes are identical', async () => {
    for (const path of ['/robots.txt', '/sitemap.xml', '/manifest.webmanifest']) {
      const r = await both(path);
      expect(r.nextrs.status(), path).toBe(r.node.status());
      expect(r.nextrs.headers()['content-type'], path).toBe(r.node.headers()['content-type']);
      expect(await r.nextrs.text(), path).toBe(await r.node.text());
    }
  });
});

// ---------------------------------------------------------------------------------------------
test.describe('dynamic pages', () => {
  for (const path of [SEARCH, '/booking/travellers', '/manage-booking', '/account/sign-in']) {
    test(`${path}: same status, headers and server-rendered outline`, async () => {
      const r = await both(path);
      expect(r.nextrs.status()).toBe(r.node.status());
      expect(contract(r.nextrs.headers())).toEqual(contract(r.node.headers()));
      expect(outline(await r.nextrs.text())).toEqual(outline(await r.node.text()));
    });
  }

  test('RSC requests: same status and content type', async () => {
    for (const path of ['/', '/destinations', SEARCH]) {
      const r = await both(path, { RSC: '1' });
      expect(r.nextrs.status(), path).toBe(r.node.status());
      expect(r.nextrs.headers()['content-type'], path).toBe(r.node.headers()['content-type']);
    }
  });
});

// ---------------------------------------------------------------------------------------------
test.describe('redirects and errors', () => {
  for (const path of [
    '/booking/travelers',
    '/checkout',
    '/this-page-does-not-exist',
    '/api/flights?from=MNL&to=MNL&departureDate=2001-01-01&adults=0',
    '/api/flights/not-a-flight',
    '/api/offers/not-an-offer',
    '/api/routes?from=12',
    // Offers are minted per request (fresh ids), so only the validation answer is comparable.
    '/api/offers?adults=1',
  ]) {
    test(`${path}: same status, headers and body`, async () => {
      const r = await both(path);
      expect(r.nextrs.status()).toBe(r.node.status());
      expect(contract(r.nextrs.headers())).toEqual(contract(r.node.headers()));
      if ((r.node.headers()['content-type'] ?? '').includes('json'))
        expect(await r.nextrs.json()).toEqual(await r.node.json());
      else expect(outline(await r.nextrs.text())).toEqual(outline(await r.node.text()));
    });
  }
});

// ---------------------------------------------------------------------------------------------
test.describe('route handlers: same JSON from the shared API', () => {
  for (const path of [
    '/api/airports',
    '/api/airports?q=osaka',
    '/api/destinations',
    '/api/destinations?featured=true',
    '/api/fare-families',
    '/api/aircraft',
    '/api/ancillaries',
    '/api/routes?from=MNL',
    API_FLIGHTS,
    `/api/flights?from=CEB&to=SIN&departureDate=${addDays(22)}&adults=2`,
  ]) {
    test(path, async () => {
      const r = await both(path);
      expect(r.nextrs.status()).toBe(r.node.status());
      expect(contract(r.nextrs.headers())).toEqual(contract(r.node.headers()));
      expect(await r.nextrs.json()).toEqual(await r.node.json());
    });
  }

  test('flight detail JSON for the same flight', async () => {
    const search = await (await node.get(API_FLIGHTS)).json();
    const id: string = JSON.stringify(search).match(/"id":"([^"]+)"/)![1]!;
    const r = await both(`/api/flights/${encodeURIComponent(id)}`);
    expect(r.nextrs.status()).toBe(r.node.status());
    expect(await r.nextrs.json()).toEqual(await r.node.json());
  });

  /*
   * Milestone 9: the remaining route handlers, so all 14 are exercised on both runtimes. Offers
   * are created per request (random `off_` ids, fresh expiry times), so those answers are
   * compared with ids and timestamps replaced; prices and fare families come from the seeded
   * inventory and must match.
   */
  const stable = (value: unknown) =>
    JSON.parse(
      JSON.stringify(value)
        .replace(/off_[A-Za-z0-9_-]{22}/g, 'off_<id>')
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/g, '<time>'),
    );

  test('seat map JSON for the same flight (no shopping session)', async () => {
    const search = JSON.stringify(await (await node.get(API_FLIGHTS)).json());
    const flightId = search.match(/NV\d{1,4}-\d{8}/)![0];
    const r = await both(`/api/flights/${flightId}/seatmap`);
    expect(r.node.status()).toBe(200);
    expect(r.nextrs.status()).toBe(r.node.status());
    expect(contract(r.nextrs.headers())).toEqual(contract(r.node.headers()));
    expect(stable(await r.nextrs.json())).toEqual(stable(await r.node.json()));
  });

  test('offers for an itinerary, then one offer by id', async () => {
    const search = JSON.stringify(await (await node.get(API_FLIGHTS)).json());
    const itineraryId = search.match(/"id":"(NV\d{1,4}-\d{8}(?:_NV\d{1,4}-\d{8})?)"/)![1]!;
    const offers = await both(`/api/offers?itineraryId=${itineraryId}&adults=1&cabin=economy`);
    expect(offers.node.status()).toBe(200);
    expect(offers.nextrs.status()).toBe(offers.node.status());
    expect(contract(offers.nextrs.headers())).toEqual(contract(offers.node.headers()));
    const [fromNode, fromNextrs] = [await offers.node.json(), await offers.nextrs.json()];
    expect(stable(fromNextrs)).toEqual(stable(fromNode));

    // Each runtime reads back an offer it created (same API, so either could read either).
    const nodeOffer = JSON.stringify(fromNode).match(/off_[A-Za-z0-9_-]{22}/)![0];
    const nextrsOffer = JSON.stringify(fromNextrs).match(/off_[A-Za-z0-9_-]{22}/)![0];
    const [a, b] = await Promise.all([
      node.get(`/api/offers/${nodeOffer}`),
      nextrs.get(`/api/offers/${nextrsOffer}`),
    ]);
    expect(a.status()).toBe(200);
    expect(b.status()).toBe(a.status());
    expect(contract(b.headers())).toEqual(contract(a.headers()));
    expect(stable(await b.json())).toEqual(stable(await a.json()));
    // An unknown (well-formed) offer and a malformed one: the same errors.
    for (const path of [`/api/offers/off_${'A'.repeat(22)}`, '/api/offers/not-an-offer']) {
      const r = await both(path);
      expect(r.nextrs.status(), path).toBe(r.node.status());
      expect(await r.nextrs.json(), path).toEqual(await r.node.json());
    }
  });

  test('storefront metrics: same status and format', async () => {
    const r = await both('/api/internal/metrics');
    expect(r.nextrs.status()).toBe(r.node.status());
    expect(r.nextrs.headers()['content-type']).toBe(r.node.headers()['content-type']);
    if (process.env.PARITY_METRICS_TOKEN) {
      // A token is configured: unauthenticated scrapes are refused, authenticated ones answer.
      expect(r.node.status()).toBe(401);
      const auth = { authorization: `Bearer ${process.env.PARITY_METRICS_TOKEN}` };
      const ok = await both('/api/internal/metrics', auth);
      expect(ok.node.status()).toBe(200);
      expect(ok.nextrs.status()).toBe(200);
      expect(await ok.nextrs.text()).toMatch(/^# (HELP|TYPE) /m);
    }
  });
});

// ---------------------------------------------------------------------------------------------
test.describe('rendered in the browser', () => {
  test('flight details dialog shows the same content', async ({ browser }) => {
    const texts: string[] = [];
    for (const baseURL of [RUNTIMES.node, RUNTIMES.nextrs]) {
      const page = await browser.newPage({ baseURL });
      await pinClock(page);
      await page.goto(SEARCH);
      await page
        .getByTestId('flight-card')
        .first()
        .getByRole('button', { name: /^Details/ })
        .click();
      const dialog = page.getByRole('dialog', { name: 'Flight details' });
      await expect(dialog).toBeVisible();
      texts.push((await dialog.innerText()).replace(/\s+/g, ' ').trim());
      await page.close();
    }
    expect(texts[0]!.length).toBeGreaterThan(40);
    expect(texts[1]).toBe(texts[0]);
  });

  test('flight results show the same cards', async ({ browser }) => {
    const cards: string[][] = [];
    for (const baseURL of [RUNTIMES.node, RUNTIMES.nextrs]) {
      const page = await browser.newPage({ baseURL });
      await pinClock(page);
      await page.goto(SEARCH);
      await expect(page.getByTestId('flight-card').first()).toBeVisible();
      cards.push(
        (await page.getByTestId('flight-card').allInnerTexts()).map((t) =>
          t.replace(/\s+/g, ' ').trim(),
        ),
      );
      await page.close();
    }
    expect(cards[0]!.length).toBeGreaterThan(0);
    expect(cards[1]).toEqual(cards[0]);
  });
});

// ---------------------------------------------------------------------------------------------
test.describe('response compression (known NextRS 0.1.0-rc.1 difference)', () => {
  /*
   * The official Next.js server compresses (gzip; `compress` defaults to true) HTML, RSC, JSON
   * and static JavaScript/CSS, with `Vary: Accept-Encoding`. NextRS 0.1.0-rc.1 sends every
   * response uncompressed. Marked as an expected failure so the gap is reported on every run;
   * if NextRS starts compressing, this test "unexpectedly passes" and must be updated.
   */
  test('both runtimes compress HTML, JSON and static assets for gzip clients', async () => {
    test.fail(true, 'NextRS 0.1.0-rc.1 does not compress responses');
    const html = await (await node.get('/')).text();
    const chunk = html.match(/\/_next\/static\/chunks\/[^"]+\.js/)![0];
    for (const path of ['/', '/api/airports', chunk]) {
      const r = await both(path, { 'accept-encoding': 'gzip, br' });
      test.info().annotations.push({
        type: 'content-encoding',
        description: `${path}: node=${r.node.headers()['content-encoding'] ?? 'none'} nextrs=${r.nextrs.headers()['content-encoding'] ?? 'none'}`,
      });
      expect(r.node.headers()['content-encoding'], `node ${path}`).toBe('gzip');
      expect(r.nextrs.headers()['content-encoding'], `nextrs ${path}`).toBeTruthy();
    }
  });
});

test.describe('static byte ranges (known NextRS 0.1.0-rc.1 difference)', () => {
  /*
   * Milestone 9. The official server answers `Range` requests for build assets and public files
   * with 206 Partial Content. NextRS 0.1.0-rc.1 ignores `Range` (200, whole body); 0.1.0-rc.2
   * adds static ranges. Expected failure until Velasia pins rc.2 (docker/nextrs/package.json),
   * like the compression check above; then both markers are removed together.
   */
  test('a byte range of a build chunk and of a public image', async () => {
    test.fail(true, 'NextRS 0.1.0-rc.1 does not serve byte ranges');
    const html = await (await node.get('/')).text();
    const chunk = html.match(/\/_next\/static\/chunks\/[^"?]+\.js/)![0];
    for (const path of [chunk, '/images/brand/hero.jpg']) {
      const whole = await (
        await node.get(path, { headers: { 'accept-encoding': 'identity' } })
      ).body();
      const r = await both(path, { range: 'bytes=0-99', 'accept-encoding': 'identity' });
      for (const [name, res] of [
        ['node', r.node],
        ['nextrs', r.nextrs],
      ] as const) {
        expect(res.status(), `${name} ${path}`).toBe(206);
        expect(res.headers()['content-range'], `${name} ${path}`).toBe(
          `bytes 0-99/${whole.length}`,
        );
        expect(Buffer.compare(await res.body(), whole.subarray(0, 100)), `${name} ${path}`).toBe(0);
      }
    }
  });
});

test.describe('deployment ID (VELASIA_DEPLOYMENT_ID)', () => {
  /*
   * Milestone 9. Runs only when both storefronts were built with a deployment ID
   * (PARITY_DEPLOYMENT_ID = the VELASIA_DEPLOYMENT_ID build argument). NextRS 0.1.0-rc.1 cannot
   * serve such builds (Dockerfile.nextrs refuses them), so this is checked once rc.2 is pinned.
   */
  const id = process.env.PARITY_DEPLOYMENT_ID;
  test('both runtimes serve assets tagged with the same deployment ID', async () => {
    test.skip(!id, 'PARITY_DEPLOYMENT_ID is not set (the build has no deployment ID)');
    const r = await both('/');
    for (const [name, res] of [
      ['node', r.node],
      ['nextrs', r.nextrs],
    ] as const) {
      expect(res.status(), name).toBe(200);
      expect(await res.text(), name).toContain(`dpl=${id}`);
    }
  });
});
