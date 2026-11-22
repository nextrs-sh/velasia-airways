import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientAddress } from '@/features/account/session';
import { validateServerEnvAtStartup } from '@/lib/env';
import { operationOf, webMetrics } from '@/lib/observability';

vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => ({}) }));

/* Milestone 7: production configuration, client keys behind a proxy, and metric labels. */

describe('client address for rate limits', () => {
  it('uses the address the nearest proxy saw, not what the client claims', () => {
    // A client can prepend anything; the proxy appends (or overwrites with) the real address.
    expect(clientAddress('1.2.3.4, 198.51.100.7', null)).toBe('198.51.100.7');
    expect(clientAddress('198.51.100.7', null)).toBe('198.51.100.7');
    expect(clientAddress(' 10.0.0.1 ,  203.0.113.9 ', null)).toBe('203.0.113.9');
    expect(clientAddress(null, '203.0.113.5')).toBe('203.0.113.5');
    expect(clientAddress('', null)).toBe('local');
    // Rotating a spoofed leftmost value no longer yields a fresh key.
    const keys = new Set(
      ['9.9.9.1', '9.9.9.2', '9.9.9.3'].map((fake) => clientAddress(`${fake}, 198.51.100.7`, null)),
    );
    expect(keys.size).toBe(1);
  });
});

describe('metric labels', () => {
  it('turn ids, dates, and flight numbers into :id so cardinality stays bounded', () => {
    expect(operationOf('/v1/orders/ord_AbCdEfGhIjKlMnOpQrStUv/servicing')).toBe(
      '/v1/orders/:id/servicing',
    );
    expect(operationOf('/v1/shopping-sessions/ses_x/seatmaps/NV501-20261215')).toBe(
      '/v1/shopping-sessions/:id/seatmaps/:id',
    );
    expect(operationOf('/v1/flights?from=MNL&to=SIN')).toBe('/v1/flights');
    expect(operationOf('/v1/orders/reference/VEL-8K4P2Q')).toBe('/v1/orders/reference/:id');
    // A reference without a digit (about one in six) is still an id.
    expect(operationOf('/v1/orders/reference/VEL-XJSGVC')).toBe('/v1/orders/reference/:id');
    expect(operationOf('/v1/destinations/singapore')).toBe('/v1/destinations/singapore');
  });

  it('share one registry per process', () => {
    expect(webMetrics()).toBe(webMetrics());
    expect(webMetrics().registry.render()).toContain('velasia_web_upstream_requests_total');
  });
});

describe('startup environment validation', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('requires explicit URLs in production and names variables, never values', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('RETAILING_API_URL', '');
    vi.stubEnv('SITE_URL', '');
    expect(() => validateServerEnvAtStartup()).toThrow(/RETAILING_API_URL must be set/);
    vi.stubEnv('RETAILING_API_URL', 'http://velasia-api:4010');
    vi.stubEnv('SITE_URL', 'https://velasia.example');
    expect(validateServerEnvAtStartup().SITE_URL).toBe('https://velasia.example');
  });

  it('refuses test-only fault forwarding in production unless explicitly allowed', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('RETAILING_API_URL', 'http://velasia-api:4010');
    vi.stubEnv('SITE_URL', 'https://velasia.example');
    vi.stubEnv('RETAILING_API_FORWARD_FAULTS', 'enabled');
    expect(() => validateServerEnvAtStartup()).toThrow(/VELASIA_ALLOW_TEST_CONTROLS/);
    vi.stubEnv('VELASIA_ALLOW_TEST_CONTROLS', 'enabled');
    expect(validateServerEnvAtStartup().RETAILING_API_FORWARD_FAULTS).toBe('enabled');
  });

  it('reports a malformed value without echoing it', () => {
    vi.stubEnv('METRICS_TOKEN', 'short-secret');
    let message = '';
    try {
      validateServerEnvAtStartup();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/METRICS_TOKEN/);
    expect(message).not.toContain('short-secret');
  });
});
