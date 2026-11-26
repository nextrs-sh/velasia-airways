// @vitest-environment node
import { NextRequest } from 'next/server';
import type * as NextServer from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET as getMetrics } from '@/app/api/internal/metrics/route';
import { bearerMatches } from '@/lib/secret-compare';

/*
 * Milestone 9.3: the storefront's /api/internal/metrics bearer check (both runtimes share this
 * code) compares without an early exit, and still refuses every wrong or missing token.
 */

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof NextServer>()),
  connection: async () => {},
}));

const TOKEN = 'm93-metrics-token-0123456789abcdef';

describe('bearerMatches', () => {
  it('accepts exactly `Bearer <token>`', () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['no scheme', TOKEN],
    ['other scheme', `Basic ${TOKEN}`],
    ['lowercase scheme', `bearer ${TOKEN}`],
    ['prefix only', `Bearer ${TOKEN.slice(0, -1)}`],
    ['longer', `Bearer ${TOKEN}x`],
    ['one character off', `Bearer ${TOKEN.slice(0, -1)}X`],
    ['empty token', 'Bearer '],
  ])('refuses %s', (_label, header) => {
    expect(bearerMatches(header, TOKEN)).toBe(false);
  });
});

describe('/api/internal/metrics', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const call = (authorization?: string) =>
    getMetrics(
      new NextRequest('http://storefront.test/api/internal/metrics', {
        headers: authorization ? { authorization } : {},
      }),
    );

  it('is open without METRICS_TOKEN (private network only)', async () => {
    vi.stubEnv('METRICS_TOKEN', '');
    expect((await call()).status).toBe(200);
  });

  it('needs the bearer token when METRICS_TOKEN is set, and never echoes it', async () => {
    vi.stubEnv('METRICS_TOKEN', TOKEN);
    const refused = await call();
    expect(refused.status).toBe(401);
    expect(refused.headers.get('cache-control')).toBe('no-store');
    expect(await refused.text()).not.toContain(TOKEN);
    const wrong = await call(`Bearer ${TOKEN.slice(0, -1)}X`);
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).not.toContain(TOKEN.slice(0, -1));
    const allowed = await call(`Bearer ${TOKEN}`);
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain('# TYPE');
  });
});
