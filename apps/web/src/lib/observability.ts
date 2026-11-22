import 'server-only';
import {
  Registry,
  registerProcessMetrics,
  type Counter,
  type Histogram,
} from '@velasia/observability';

/*
 * Milestone 7: storefront logs and metrics.
 *
 * Logs are one JSON object per line on stdout/stderr (the same shape as the API's pino lines:
 * `level`, `time`, `msg`), carrying codes and route templates only — never names, emails,
 * tokens, or booking documents.
 *
 * Metrics live in one registry per process. Next.js can evaluate a module once per route
 * bundle, so the registry is kept on `globalThis` rather than in module scope.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<Level, number> = { debug: 20, info: 30, warn: 40, error: 50 };

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    level: LEVELS[level],
    time: Date.now(),
    service: 'velasia-web',
    msg,
    ...fields,
  });
  if (LEVELS[level] >= LEVELS.warn) process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

/** A failed retailing API call: area (`account`, `checkout`…), action, and the error code only. */
export function logUpstreamFailure(
  area: string,
  action: string,
  error: { code?: string; kind?: string; status?: number },
): void {
  log('error', 'retailing api call failed', {
    area,
    action,
    code: error.code ?? null,
    kind: error.kind ?? null,
    status: error.status ?? null,
  });
}

interface WebMetrics {
  registry: Registry;
  upstreamRequests: Counter;
  upstreamDuration: Histogram;
  requestErrors: Counter;
}

const KEY = Symbol.for('velasia.web.metrics');

export function webMetrics(): WebMetrics {
  const holder = globalThis as unknown as Record<symbol, WebMetrics | undefined>;
  let metrics = holder[KEY];
  if (!metrics) {
    const registry = new Registry();
    registerProcessMetrics(registry, { service: 'web' });
    metrics = {
      registry,
      upstreamRequests: registry.counter({
        name: 'velasia_web_upstream_requests_total',
        help: 'Retailing API calls from the storefront, by operation, method, and outcome.',
        labelNames: ['operation', 'method', 'outcome'],
      }),
      upstreamDuration: registry.histogram({
        name: 'velasia_web_upstream_request_duration_seconds',
        help: 'Retailing API call latency as the storefront sees it, by operation.',
        labelNames: ['operation', 'method'],
      }),
      requestErrors: registry.counter({
        name: 'velasia_web_request_errors_total',
        help: 'Server errors reported by Next.js (onRequestError), by route type.',
        labelNames: ['route_type', 'render_source'],
      }),
    };
    holder[KEY] = metrics;
  }
  return metrics;
}

// Booking references (`VEL-` + 6 characters) need their own rule: about one in six has no digit
// (`VEL-XJSGVC`), and the digit rule alone then leaked the reference into the label.
const ID_SEGMENT = /^(ord|ses|off|opr|trv|acc|rfd|pat|hld|svc)_|^VEL-|\d/;

/** A bounded label for an API path: ids, booking references, dates, and flight numbers become `:id`. */
export function operationOf(path: string): string {
  const pathname = path.split('?')[0] ?? path;
  return pathname
    .split('/')
    .map((segment) => (!/^v\d+$/.test(segment) && ID_SEGMENT.test(segment) ? ':id' : segment))
    .join('/');
}
