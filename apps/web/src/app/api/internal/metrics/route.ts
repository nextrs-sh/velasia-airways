import { PROMETHEUS_CONTENT_TYPE } from '@velasia/observability';
import { connection, type NextRequest } from 'next/server';
import { getServerEnv } from '@/lib/env';
import { webMetrics } from '@/lib/observability';
import { bearerMatches } from '@/lib/secret-compare';

/**
 * Milestone 7: storefront metrics in Prometheus text format (process, event loop, retailing API
 * calls by operation, server errors). Internal only: the proxy answers 404 for `/api/internal/*`,
 * and `METRICS_TOKEN`, when set, is required as a bearer token.
 */
export async function GET(request: NextRequest) {
  await connection();
  const token = getServerEnv().METRICS_TOKEN;
  if (token && !bearerMatches(request.headers.get('authorization'), token)) {
    return Response.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Metrics need a token.' } },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return new Response(webMetrics().registry.render(), {
    headers: { 'Content-Type': PROMETHEUS_CONTENT_TYPE, 'Cache-Control': 'no-store' },
  });
}
