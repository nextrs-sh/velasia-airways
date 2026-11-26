import { SERVICE_TOKEN_HEADER } from '@velasia/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadRuntimeConfig } from '../src/config';
import { TODAY } from './helpers';

/*
 * M9.2: the staged service-token rollout (docs/deployment/RAILWAY-AUTH-ROLLOUT.md) relies on
 * these properties of the API, checked here in isolation (no Railway, no deployed service):
 *
 * - stage 1, clients first: an API with no token configured answers callers that already send
 *   one, so both storefronts can get the token before the API enforces it;
 * - stage 2, enforcement: with both tokens set, /metrics needs the service token AND the
 *   metrics bearer token, health probes stay open, and everything else needs the service token;
 * - an empty variable is "not configured", never a token an empty header could match.
 */

const SERVICE_TOKEN = 'm9-rollout-service-token-0123456789abcdef';
const METRICS_TOKEN = 'm9-rollout-metrics-token-0123';

describe('stage 1: clients send the token before the API enforces it', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = buildApp({ config: { today: TODAY } });
    await app.ready();
  });
  afterAll(() => app.close());

  it('answers requests with and without the header', async () => {
    for (const headers of [{}, { [SERVICE_TOKEN_HEADER]: SERVICE_TOKEN }]) {
      expect((await app.inject({ method: 'GET', url: '/v1/airports', headers })).statusCode).toBe(
        200,
      );
      expect((await app.inject({ method: 'GET', url: '/metrics', headers })).statusCode).toBe(200);
    }
  });
});

describe('stage 2: enforcement with both tokens', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = buildApp({
      config: { today: TODAY },
      access: { serviceToken: SERVICE_TOKEN },
      observability: { metricsToken: METRICS_TOKEN },
    });
    await app.ready();
  });
  afterAll(() => app.close());

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers });

  it('metrics need the service token and the metrics bearer token', async () => {
    const service = { [SERVICE_TOKEN_HEADER]: SERVICE_TOKEN };
    const bearer = { authorization: `Bearer ${METRICS_TOKEN}` };
    expect((await get('/metrics')).statusCode).toBe(401);
    expect((await get('/metrics', bearer)).statusCode).toBe(401);
    expect((await get('/metrics', service)).statusCode).toBe(401);
    expect((await get('/metrics', { ...service, authorization: 'Bearer wrong' })).statusCode).toBe(
      401,
    );
    const ok = await get('/metrics', { ...service, ...bearer });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('# TYPE');
  });

  it('keeps health probes open and answers the storefront with its token', async () => {
    for (const url of ['/health', '/health/live', '/health/ready']) {
      expect((await get(url)).statusCode, url).toBe(200);
    }
    expect((await get('/v1/airports', { [SERVICE_TOKEN_HEADER]: SERVICE_TOKEN })).statusCode).toBe(
      200,
    );
    expect((await get('/v1/airports')).statusCode).toBe(401);
  });

  it('never echoes a token in an error body', async () => {
    const response = await get('/v1/airports', { [SERVICE_TOKEN_HEADER]: 'x'.repeat(40) });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(SERVICE_TOKEN);
    expect(response.body).not.toContain('x'.repeat(40));
  });
});

describe('configuration', () => {
  it('treats empty variables as not configured', () => {
    const config = loadRuntimeConfig({ RETAILING_API_SERVICE_TOKEN: '', METRICS_TOKEN: '' });
    expect(config.serviceToken).toBeUndefined();
    expect(config.metricsToken).toBeUndefined();
  });

  it('refuses a too-short metrics token at startup', () => {
    expect(() => loadRuntimeConfig({ METRICS_TOKEN: 'short' })).toThrow(/METRICS_TOKEN/);
  });
});
