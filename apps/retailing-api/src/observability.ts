import { createHash, timingSafeEqual } from 'node:crypto';
import { statSync } from 'node:fs';
import {
  PROMETHEUS_CONTENT_TYPE,
  REQUEST_ID_HEADER,
  Registry,
  registerProcessMetrics,
  type Histogram,
} from '@velasia/observability';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Collection, Document } from 'taladb';

/*
 * Milestone 7: metrics and request logging for the retailing API.
 *
 * Every label value comes from a bounded set: route templates (never raw URLs, which carry
 * order and session ids), HTTP methods, status classes, error codes, collection and operation
 * names. Nothing a client controls freely, and nothing personal, becomes a label.
 */

export type ApiMetrics = ReturnType<typeof createApiMetrics>;

const HTTP_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const DB_BUCKETS = [0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.5, 1];

export function createApiMetrics() {
  const registry = new Registry();
  registerProcessMetrics(registry, { service: 'retailing-api' });
  return {
    registry,
    httpRequests: registry.counter({
      name: 'velasia_http_requests_total',
      help: 'HTTP requests answered, by route template, method, and status code.',
      labelNames: ['method', 'route', 'status'],
      maxSeries: 1_000,
    }),
    httpDuration: registry.histogram({
      name: 'velasia_http_request_duration_seconds',
      help: 'Time to answer an HTTP request, by route template.',
      labelNames: ['method', 'route'],
      buckets: HTTP_BUCKETS,
    }),
    httpInFlight: registry.gauge({
      name: 'velasia_http_requests_in_flight',
      help: 'Requests being processed.',
    }),
    apiErrors: registry.counter({
      name: 'velasia_api_errors_total',
      help: 'Error answers by API error code (inventory conflicts, price changes, rate limits…).',
      labelNames: ['code'],
    }),
    writerWait: registry.histogram({
      name: 'velasia_writer_wait_seconds',
      help: 'Time an operation waited for the serialized writer.',
      buckets: DB_BUCKETS,
    }),
    writerRun: registry.histogram({
      name: 'velasia_writer_task_seconds',
      help: 'Time an operation held the serialized writer.',
      buckets: DB_BUCKETS,
    }),
    writerRejected: registry.counter({
      name: 'velasia_writer_rejected_total',
      help: 'Operations the serialized writer refused or gave up on.',
      labelNames: ['reason'],
    }),
    dbOperation: registry.histogram({
      name: 'velasia_taladb_operation_seconds',
      help: 'TalaDB calls by collection, operation, and kind (read or write).',
      labelNames: ['collection', 'operation', 'kind'],
      buckets: DB_BUCKETS,
    }),
    dbFailures: registry.counter({
      name: 'velasia_taladb_operation_failures_total',
      help: 'TalaDB calls that threw, by collection, operation, and kind.',
      labelNames: ['collection', 'operation', 'kind'],
    }),
    reconcileDuration: registry.histogram({
      name: 'velasia_reconcile_duration_seconds',
      help: 'Recovery/reconciliation passes, by scope (orders, servicing) and trigger.',
      labelNames: ['scope', 'trigger'],
      buckets: DB_BUCKETS,
    }),
    reconcileActions: registry.counter({
      name: 'velasia_reconcile_actions_total',
      help: 'What reconciliation did: payments resolved, holds expired, refunds resent…',
      labelNames: ['action'],
    }),
    reconcileFailures: registry.counter({
      name: 'velasia_reconcile_failures_total',
      help: 'Reconciliation passes that failed.',
    }),
    providerAnswers: registry.counter({
      name: 'velasia_simulated_provider_answers_total',
      help: 'Simulated payment and refund provider answers, by outcome.',
      labelNames: ['provider', 'outcome'],
    }),
    providerDuration: registry.histogram({
      name: 'velasia_simulated_provider_seconds',
      help: 'Time waiting for the simulated payment or refund provider.',
      labelNames: ['provider'],
      buckets: HTTP_BUCKETS,
    }),
    sessionWrites: registry.histogram({
      name: 'velasia_shopping_session_flush_seconds',
      help: 'Time to make changed shopping sessions durable before answering.',
      buckets: DB_BUCKETS,
    }),
    sessionWriteFailures: registry.counter({
      name: 'velasia_shopping_session_flush_failures_total',
      help: 'Shopping-session flushes that failed (the request is answered 503).',
    }),
  };
}

/** Gauges read at scrape time from live objects. */
export function registerStateGauges(
  metrics: ApiMetrics,
  sources: {
    queueDepth: () => number;
    databasePath: () => string | undefined;
    memoryStores: () => {
      offers: number;
      sessions: number;
      offersCreated: number;
      sessionsCreated: number;
    };
    pendingSessionWrites: () => number;
    activeHolds: () => number;
    ready: () => boolean;
  },
): void {
  metrics.registry.gauge({
    name: 'velasia_writer_queue_depth',
    help: 'Operations waiting for or holding the serialized writer.',
    collect: (gauge) => gauge.set(sources.queueDepth()),
  });
  metrics.registry.gauge({
    name: 'velasia_taladb_file_bytes',
    help: 'Size of the TalaDB database file.',
    collect: (gauge) => {
      const path = sources.databasePath();
      if (path) gauge.set(statSync(path).size);
    },
  });
  metrics.registry.gauge({
    name: 'velasia_memory_store_entries',
    help: 'Offers and shopping sessions held in memory.',
    labelNames: ['store'],
    collect: (gauge) => {
      const stats = sources.memoryStores();
      gauge.set(stats.offers, { store: 'offers' });
      gauge.set(stats.sessions, { store: 'sessions' });
    },
  });
  metrics.registry.gauge({
    name: 'velasia_memory_store_created_total',
    // Monotonic within a process (a counter, exposed as a gauge like process_cpu_seconds_total).
    help: 'Offers and shopping sessions created since the process started (Milestone 9.3).',
    labelNames: ['store'],
    collect: (gauge) => {
      const stats = sources.memoryStores();
      gauge.set(stats.offersCreated, { store: 'offers' });
      gauge.set(stats.sessionsCreated, { store: 'sessions' });
    },
  });
  metrics.registry.gauge({
    name: 'velasia_shopping_session_pending_writes',
    help: 'Changed shopping sessions not yet written to TalaDB.',
    collect: (gauge) => gauge.set(sources.pendingSessionWrites()),
  });
  metrics.registry.gauge({
    name: 'velasia_inventory_active_holds',
    help: 'Orders whose hold takes seats (held or committed), from the allocation ledger.',
    collect: (gauge) => gauge.set(sources.activeHolds()),
  });
  metrics.registry.gauge({
    name: 'velasia_ready',
    help: '1 while the API is ready for traffic, 0 while starting or shutting down.',
    collect: (gauge) => gauge.set(sources.ready() ? 1 : 0),
  });
}

const READ_OPERATIONS = new Set(['find', 'findOne', 'count', 'aggregate', 'listIndexes']);
const WRITE_OPERATIONS = new Set([
  'insert',
  'insertMany',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
]);

/** Time every read and write a collection makes. Other members pass through untouched. */
export function instrumentCollection(
  collection: Collection<Document>,
  name: string,
  metrics: ApiMetrics,
): Collection<Document> {
  return new Proxy(collection, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof property !== 'string' || typeof value !== 'function') return value;
      const kind = READ_OPERATIONS.has(property)
        ? 'read'
        : WRITE_OPERATIONS.has(property)
          ? 'write'
          : null;
      if (!kind) return value;
      const labels = { collection: name, operation: property, kind };
      return async (...args: unknown[]) => {
        const stop = metrics.dbOperation.startTimer(labels);
        try {
          return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        } catch (error) {
          metrics.dbFailures.inc(labels);
          throw error;
        } finally {
          stop();
        }
      };
    },
  });
}

/** Record how long a simulated provider takes and what it answered. */
export function instrumentProvider<
  T extends object,
  K extends keyof T,
  A extends { kind: 'answered' | 'timeout' },
>(
  target: T,
  method: K,
  provider: 'payment' | 'refund',
  metrics: ApiMetrics,
  outcome: (a: A) => string,
) {
  const original = target[method] as unknown as (...args: unknown[]) => Promise<A>;
  (target as Record<K, unknown>)[method] = async (...args: unknown[]) => {
    const stop = metrics.providerDuration.startTimer({ provider });
    try {
      const answer = await original.apply(target, args);
      metrics.providerAnswers.inc({
        provider,
        outcome: answer.kind === 'timeout' ? 'TIMEOUT' : outcome(answer),
      });
      return answer;
    } catch (error) {
      metrics.providerAnswers.inc({ provider, outcome: 'ERROR' });
      throw error;
    } finally {
      stop();
    }
  };
}

/** Time a reconciliation pass and count what it did (numeric fields of its result). */
export async function timedReconcile<R extends Record<string, number>>(
  metrics: ApiMetrics,
  scope: 'orders' | 'servicing',
  trigger: 'startup' | 'sweep',
  run: () => Promise<R>,
): Promise<R> {
  const stop = metrics.reconcileDuration.startTimer({ scope, trigger });
  try {
    const result = await run();
    for (const [action, count] of Object.entries(result)) {
      if (count > 0) metrics.reconcileActions.inc({ action: `${scope}_${action}` }, count);
    }
    return result;
  } catch (error) {
    metrics.reconcileFailures.inc();
    throw error;
  } finally {
    stop();
  }
}

const statusClassOf = (status: number) => `${Math.floor(status / 100)}xx`;

/** The route template a request matched, or a fixed placeholder (never the raw URL). */
export function routeOf(request: FastifyRequest): string {
  return request.routeOptions?.url ?? '(unmatched)';
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the metrics hook when the request arrived. */
    stopTimer?: (labels?: Record<string, string>) => number;
  }
}

/**
 * Request metrics, correlation ids on responses, and one structured completion line per
 * request. High-volume reads that succeed log at `debug`, so a busy flight search doesn't
 * flood the logs; writes, errors, and slow requests log at `info` or above.
 */
export function registerHttpObservability(
  app: FastifyInstance,
  metrics: ApiMetrics,
  options: { slowRequestMs: number },
): void {
  app.addHook('onRequest', async (request, reply) => {
    metrics.httpInFlight.inc();
    request.stopTimer = metrics.httpDuration.startTimer();
    void reply.header(REQUEST_ID_HEADER, request.id).header('x-content-type-options', 'nosniff');
  });
  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    metrics.httpInFlight.dec();
    const route = routeOf(request);
    const seconds = request.stopTimer?.({ method: request.method, route }) ?? 0;
    const status = reply.statusCode;
    metrics.httpRequests.inc({ method: request.method, route, status: String(status) });
    if (reply.apiErrorCode) metrics.apiErrors.inc({ code: reply.apiErrorCode });
    const durationMs = Math.round(seconds * 1000 * 10) / 10;
    const line = {
      method: request.method,
      route,
      statusCode: status,
      statusClass: statusClassOf(status),
      durationMs,
    };
    if (status >= 500) request.log.error(line, 'request failed');
    else if (durationMs >= options.slowRequestMs) request.log.warn(line, 'slow request');
    else if (request.method === 'GET' || request.method === 'HEAD') {
      request.log.debug(line, 'request completed');
    } else request.log.info(line, 'request completed');
  });
}

/** Internal metrics endpoint. The API is on an internal network only; a token adds a guard. */
export function registerMetricsRoute(
  app: FastifyInstance,
  metrics: ApiMetrics,
  options: { token?: string },
): void {
  // M9.3: compared on SHA-256 digests with timingSafeEqual, like the service token.
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const expected = options.token ? digest(`Bearer ${options.token}`) : null;
  app.get('/metrics', async (request, reply) => {
    if (expected) {
      const header = request.headers.authorization ?? '';
      if (!timingSafeEqual(digest(header), expected)) {
        return reply
          .code(401)
          .header('cache-control', 'no-store')
          .send({
            error: { code: 'UNAUTHENTICATED', message: 'Metrics need a token.' },
          });
      }
    }
    return reply
      .header('content-type', PROMETHEUS_CONTENT_TYPE)
      .header('cache-control', 'no-store')
      .send(metrics.registry.render());
  });
}

/** Pino redaction for the API's logs: credentials never reach a log line. */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-velasia-guest"]',
  'req.headers["x-velasia-account"]',
  'req.headers["x-velasia-client"]',
  'req.headers["x-velasia-service-token"]',
  'headers.authorization',
  'headers.cookie',
  'password',
  '*.password',
  'currentPassword',
  '*.currentPassword',
  'newPassword',
  '*.newPassword',
  'token',
  '*.token',
  'email',
  '*.email',
  'phone',
  '*.phone',
  'givenName',
  '*.givenName',
  'familyName',
  '*.familyName',
];

export type { Histogram };
