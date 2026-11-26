import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestIdFrom } from '@velasia/observability';
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { createClock, type Clock } from './clock';
import {
  DEFAULT_ACCOUNTS_CONFIG,
  DEFAULT_CHECKOUT_CONFIG,
  DEFAULT_PAYMENTS_CONFIG,
  DEFAULT_SERVICING_CONFIG,
  DEFAULT_SESSIONS_CONFIG,
  type ApiConfig,
} from './config';
import { createAccountService, type AccountService } from './accounts/account-service';
import {
  AccountRepository,
  SessionRepository,
  TravellerRepository,
} from './db/repositories/account-repository';
import { RefundProviderRepository } from './db/repositories/refund-provider-repository';
import { RefundSimulator } from './orders/refund-simulator';
import { accountRoutes } from './routes/accounts';
import { servicingRoutes } from './routes/servicing';
import { createServicingService, type ServicingService } from './servicing/servicing-service';
import { ShoppingSessionRepository } from './db/repositories/shopping-session-repository';
import { SessionWriter } from './offers/session-persistence';
import {
  createApiMetrics,
  instrumentCollection,
  instrumentProvider,
  registerHttpObservability,
  registerMetricsRoute,
  registerStateGauges,
  timedReconcile,
  type ApiMetrics,
} from './observability';
import type { ChargeAnswer } from './orders/payment-simulator';
import type { RefundAnswer } from './orders/refund-simulator';
import { openDatabase, type Database } from './db/client';
import { OrderRepository } from './db/repositories/order-repository';
import { PaymentProviderRepository } from './db/repositories/payment-provider-repository';
import { registerFaultInjection } from './faults';
import { sendError } from './http';
import { AllocationLedger } from './inventory/ledger';
import { createCheckoutService, type CheckoutService } from './orders/checkout-service';
import { newBookingReference } from './orders/ids';
import { createOrderService, type OrderService } from './orders/order-service';
import { OrderStore } from './orders/order-store';
import { PaymentSimulator } from './orders/payment-simulator';
import { SerialQueue } from './orders/serial-queue';
import { airlineRoutes } from './routes/airline';
import { airportRoutes } from './routes/airports';
import { bookingRoutes } from './routes/booking';
import { checkoutRoutes } from './routes/checkout';
import { destinationRoutes } from './routes/destinations';
import { flightRoutes } from './routes/flights';
import { healthRoutes } from './routes/health';
import { networkRoutes } from './routes/network';
import { offerRoutes } from './routes/offers';
import { orderRoutes } from './routes/orders';
import { shoppingRoutes } from './routes/shopping';
import { createRetailingService, DEFAULT_RETAILING_CONFIG } from './offers/retailing-service';
import { createCatalog } from './services/catalog';
import { createFlightService } from './services/flights';
import { registerServiceAuth } from './service-auth';

export const API_VERSION = '0.7.0';

/** Hooks for tests: control time and randomness that production takes from the system. */
export interface TestHooks {
  clock?: Clock;
  /** Wall clock of the simulated payment provider. */
  wallClock?: () => number;
  referenceGenerator?: () => string;
}

export interface BuildAppOptions extends FastifyServerOptions {
  /** Defaults are deterministic apart from "today", which follows the system clock unless pinned. */
  config?: Partial<ApiConfig>;
  testHooks?: TestHooks;
  /** Milestone 7: metrics registry (a private one per app when omitted) and options. */
  metrics?: ApiMetrics;
  observability?: { metricsToken?: string; slowRequestMs?: number };
  /** Milestone 8: shared service token required from callers (see `service-auth.ts`). */
  access?: { serviceToken?: string };
}

/** Milestone 7: whether the API should receive traffic. */
export interface Lifecycle {
  /** TalaDB open, migrations checked, ledger rebuilt, recovery done, sessions restored. */
  ready: boolean;
  /** Graceful shutdown has begun: readiness fails while in-flight requests finish. */
  shuttingDown: boolean;
}

/** Checkout and order internals, for graceful shutdown, diagnostics, and tests. */
export interface Persistence {
  database: Database;
  orders: OrderRepository;
  provider: PaymentProviderRepository;
  ledger: AllocationLedger;
  queue: SerialQueue;
  checkout: CheckoutService;
  orderService: OrderService;
  /** Milestone 6. */
  refundProvider: RefundProviderRepository;
  servicing: ServicingService;
  accounts: AccountService;
  accountRepository: AccountRepository;
  sessions: SessionRepository;
  travellers: TravellerRepository;
  /** What startup reconciliation did. */
  recovered: { resolved: number; expired: number; confirmed: number };
  recoveredServicing: { payments: number; refunds: number; resent: number; expired: number };
  /** Milestone 7: durable shopping sessions. */
  shoppingSessions: ShoppingSessionRepository;
  sessionWriter: SessionWriter;
  restoredSessions: number;
}

declare module 'fastify' {
  interface FastifyInstance {
    persistence: Persistence;
    lifecycle: Lifecycle;
    metrics: ApiMetrics;
  }
}

const DEFAULT_CONFIG: ApiConfig = {
  // Pre-rebrand seed kept on purpose: it keeps deterministic inventory identical (see config.ts).
  inventory: { seed: 'aeronova', horizonDays: 120 },
  faults: { enabled: false, timeoutMs: 15_000 },
  retailing: DEFAULT_RETAILING_CONFIG,
  persistence: {},
  checkout: DEFAULT_CHECKOUT_CONFIG,
  payments: DEFAULT_PAYMENTS_CONFIG,
  servicing: DEFAULT_SERVICING_CONFIG,
  accounts: DEFAULT_ACCOUNTS_CONFIG,
  sessions: DEFAULT_SESSIONS_CONFIG,
};

/** Build the app without listening, so tests can use `app.inject()`. Await `app.ready()`. */
export function buildApp({
  config = {},
  testHooks = {},
  metrics = createApiMetrics(),
  observability = {},
  access = {},
  ...options
}: BuildAppOptions = {}): FastifyInstance {
  const settings: ApiConfig = {
    ...DEFAULT_CONFIG,
    ...config,
    checkout: { ...DEFAULT_CHECKOUT_CONFIG, ...config.checkout },
    payments: { ...DEFAULT_PAYMENTS_CONFIG, ...config.payments },
    servicing: { ...DEFAULT_SERVICING_CONFIG, ...config.servicing },
    accounts: { ...DEFAULT_ACCOUNTS_CONFIG, ...config.accounts },
    sessions: { ...DEFAULT_SESSIONS_CONFIG, ...config.sessions },
  };
  const app = Fastify({
    logger: false,
    // Correlation: keep a well-formed `x-request-id` from the proxy or storefront, else mint one.
    genReqId: (request) => requestIdFrom(request.headers['x-request-id']),
    // One structured line per request comes from `registerHttpObservability` instead.
    logController: new LogController({
      requestIdLogLabel: 'requestId',
      disableRequestLogging: true,
    }),
    ...options,
  });
  const lifecycle: Lifecycle = { ready: false, shuttingDown: false };
  app.decorate('lifecycle', lifecycle);
  app.decorate('metrics', metrics);
  registerHttpObservability(app, metrics, {
    slowRequestMs: observability.slowRequestMs ?? 1_000,
  });
  registerServiceAuth(app, access.serviceToken);
  // Changed shopping sessions are durable before a mutating request is answered (Milestone 7).
  let sessionWriter: SessionWriter | null = null;
  app.addHook('onSend', async (request, reply, payload) => {
    // While draining, close each connection after its answer: a kept-alive socket would
    // otherwise hold `close()` open until its keep-alive timeout.
    if (lifecycle.shuttingDown) reply.header('connection', 'close');
    // Only in `sync` mode; `batched` writes behind (see offers/session-persistence.ts).
    if (!sessionWriter || sessionWriter.durability !== 'sync') return payload;
    if (request.method === 'GET' || request.method === 'HEAD') return payload;
    if (sessionWriter.pending === 0) return payload;
    try {
      await sessionWriter.flush();
      return payload;
    } catch (error) {
      request.log.error({ err: error }, 'shopping session write failed');
      reply.code(503).header('cache-control', 'no-store');
      reply.header('content-type', 'application/json; charset=utf-8');
      reply.apiErrorCode = 'SERVICE_UNAVAILABLE';
      return JSON.stringify({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'We couldn’t save your trip just now. Please try again.',
        },
      });
    }
  });

  const clock = testHooks.clock ?? createClock(settings.today);
  // Seats held by orders; filled from the database before the app is ready.
  const ledger = new AllocationLedger(() => clock.now());
  const flights = createFlightService({ clock, ...settings.inventory, ledger });
  const retailing = createRetailingService({
    flights,
    clock,
    config: settings.retailing,
    ledger,
  });
  // Generate inventory at startup, off the request path.
  flights.current();
  const catalog = createCatalog(flights);
  // Derive destination routes and fares now, so the first request doesn't pay for it.
  catalog.listDestinations();

  registerFaultInjection(app, settings.faults, {
    offerValidityMs: settings.retailing.offerValidityMs,
    sessionMaxMs: settings.retailing.sessionMaxMs,
    holdMs: settings.checkout.holdMs,
  });
  app.register(healthRoutes, { version: API_VERSION, lifecycle });
  registerMetricsRoute(app, metrics, { token: observability.metricsToken });
  app.register(airlineRoutes);
  app.register(airportRoutes, { catalog });
  app.register(destinationRoutes, { catalog });
  app.register(flightRoutes, { flights });
  app.register(networkRoutes, { flights });
  app.register(offerRoutes, { retailing });
  app.register(shoppingRoutes, { retailing });
  app.register(bookingRoutes, { retailing });

  // Milestone 5: TalaDB, checkout, orders, simulated payments.
  app.decorate('persistence', null as unknown as Persistence);
  app.register(async (scope) => {
    // Without a configured path (tests), use a private temporary file.
    const tempDir = settings.persistence.path
      ? null
      : mkdtempSync(join(tmpdir(), 'velasia-retailing-'));
    const database = await openDatabase(settings.persistence.path ?? join(tempDir!, 'velasia.db'), {
      wrap: (collection, name) => instrumentCollection(collection, name, metrics),
    });
    const orders = new OrderRepository(database.orders);
    const provider = new PaymentProviderRepository(database.provider);
    const queue = new SerialQueue();
    queue.observer = {
      waited: (seconds) => metrics.writerWait.observe(seconds),
      ran: (seconds) => metrics.writerRun.observe(seconds),
      rejected: (reason) => metrics.writerRejected.inc({ reason }),
    };
    const store = new OrderStore(orders, ledger, queue, settings.checkout.maxPaymentAttempts);
    // Inventory held by orders comes from durable state only.
    ledger.rebuild(await orders.withActiveHolds());
    const simulator = new PaymentSimulator(provider, {
      responseDelayMs: settings.payments.responseDelayMs,
      timeoutMs: settings.payments.timeoutMs,
      pendingResolveMs: settings.payments.pendingResolveMs,
      wallClock: testHooks.wallClock,
    });
    instrumentProvider(simulator, 'charge', 'payment', metrics, (answer: ChargeAnswer) =>
      answer.kind === 'answered' ? answer.charge.status : 'TIMEOUT',
    );
    const orderService = createOrderService({
      store,
      provider: simulator,
      retailing,
      config: {
        maxPaymentAttempts: settings.checkout.maxPaymentAttempts,
        outcomeControls: settings.payments.outcomeControls,
      },
      log: app.log,
    });
    const checkout = createCheckoutService({
      retailing,
      flights,
      store,
      config: settings.checkout,
      referenceGenerator: testHooks.referenceGenerator ?? newBookingReference,
    });
    // Milestone 6: servicing (changes, seats, services, cancellations) and demo accounts.
    const refundProvider = new RefundProviderRepository(database.refundProvider);
    const refundSimulator = new RefundSimulator(refundProvider, {
      responseDelayMs: settings.payments.responseDelayMs,
      timeoutMs: settings.payments.timeoutMs,
      pendingResolveMs: settings.payments.pendingResolveMs,
      wallClock: testHooks.wallClock,
    });
    instrumentProvider(refundSimulator, 'refund', 'refund', metrics, (answer: RefundAnswer) =>
      answer.kind === 'answered' ? answer.refund.status : 'TIMEOUT',
    );
    const servicing = createServicingService({
      store,
      flights,
      retailing,
      provider: simulator,
      refunds: refundSimulator,
      config: {
        claimMs: settings.servicing.claimMs,
        outcomeControls: settings.payments.outcomeControls,
      },
      log: app.log,
    });
    const accountRepository = new AccountRepository(database.accounts);
    const sessions = new SessionRepository(database.sessions);
    const travellers = new TravellerRepository(database.travellers);
    const accounts = createAccountService({
      accounts: accountRepository,
      sessions,
      travellers,
      orders,
      store,
      inventory: () => flights.current(),
      now: () => clock.now(),
      businessNow: () => clock.businessNow(),
      config: settings.accounts,
      log: app.log,
    });

    // Finish what a previous process left undecided, and release holds that ended meanwhile.
    const recovered = await timedReconcile(metrics, 'orders', 'startup', () =>
      orderService.reconcile(clock.now()),
    );
    const recoveredServicing = await timedReconcile(metrics, 'servicing', 'startup', () =>
      servicing.reconcile(clock.now()),
    );

    // Milestone 7: shopping sessions survive a restart. Ended ones are purged, the rest restored
    // into memory, and every later change is written through before it is acknowledged.
    const shoppingSessions = new ShoppingSessionRepository(database.shoppingSessions);
    const sessionCutoff = () => clock.now() - retailing.sessionGraceMs;
    await shoppingSessions.purgeEnded(sessionCutoff());
    const { sessions: restorable, unreadable } =
      await shoppingSessions.loadRestorable(sessionCutoff());
    const restore = retailing.restoreSessions(restorable);
    const writer = new SessionWriter(shoppingSessions, (id) => retailing.storedSession(id), {
      ...settings.sessions,
      observe: (seconds, failed, error) => {
        metrics.sessionWrites.observe(seconds);
        if (!failed) return;
        metrics.sessionWriteFailures.inc();
        app.log.error({ err: error }, 'shopping session write failed');
      },
    });
    retailing.attachSessionListener(writer);
    for (const id of restore.dropped) writer.deleted(id);
    if (restore.dropped.length > 0) await writer.flush();
    sessionWriter = writer;
    if (unreadable > 0) app.log.warn({ unreadable }, 'unreadable shopping sessions removed');

    app.persistence = {
      database,
      orders,
      provider,
      ledger,
      queue,
      checkout,
      orderService,
      refundProvider,
      servicing,
      accounts,
      accountRepository,
      sessions,
      travellers,
      recovered,
      recoveredServicing,
      shoppingSessions,
      sessionWriter: writer,
      restoredSessions: restore.restored,
    };
    registerStateGauges(metrics, {
      queueDepth: () => queue.size,
      databasePath: () => database.path,
      memoryStores: () => retailing.stats(),
      pendingSessionWrites: () => writer.pending,
      activeHolds: () => ledger.activeOrders,
      ready: () => lifecycle.ready && !lifecycle.shuttingDown,
    });

    // Expiry is also checked on every access; the sweep releases holds nobody looks at.
    const sweep = setInterval(() => {
      const now = clock.now();
      timedReconcile(metrics, 'orders', 'sweep', () => orderService.reconcile(now))
        .then(() => timedReconcile(metrics, 'servicing', 'sweep', () => servicing.reconcile(now)))
        .then(() => accounts.purgeSessions())
        .then(() => {
          retailing.sweepSessions(now);
          return writer.flush();
        })
        .then(() => shoppingSessions.purgeEnded(sessionCutoff()))
        .catch((error: unknown) => {
          app.log.error({ err: error }, 'order sweep failed');
        });
    }, settings.checkout.sweepIntervalMs);
    sweep.unref();

    scope.get('/health/ready', async (_request, reply) => {
      const db = await database.health();
      const ready = db.ok && lifecycle.ready && !lifecycle.shuttingDown;
      return reply
        .code(ready ? 200 : 503)
        .header('cache-control', 'no-store')
        .send({
          status: ready ? 'ok' : lifecycle.shuttingDown ? 'shutting-down' : 'unavailable',
          database: db,
          schemaVersion: database.schema.schemaVersion,
          checkoutQueue: queue.size,
          pendingSessionWrites: writer.pending,
        });
    });
    scope.register(checkoutRoutes, { checkout, orders: orderService, retailing });
    scope.register(orderRoutes, { orders: orderService, retailing, accounts });
    scope.register(servicingRoutes, {
      servicing,
      retailing,
      accounts,
      maxPaymentAttempts: settings.checkout.maxPaymentAttempts,
    });
    scope.register(accountRoutes, { accounts });
    lifecycle.ready = true;

    scope.addHook('onClose', async () => {
      lifecycle.ready = false;
      clearInterval(sweep);
      // No new durable writes; let queued ones reach their (atomic) end.
      await queue.drain();
      await writer.close().catch((error: unknown) => {
        app.log.error({ err: error }, 'shopping sessions not saved at shutdown');
      });
      await database.close();
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    });
  });

  app.setNotFoundHandler((request, reply) =>
    sendError(reply, 404, 'NOT_FOUND', `Route ${request.method} ${request.url} not found.`),
  );

  app.setErrorHandler((error, request, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status < 500) {
      return sendError(reply, status, 'BAD_REQUEST', (error as Error).message);
    }
    const name = (error as Error).name;
    if (name === 'QueueFullError' || name === 'QueueTimeoutError' || name === 'QueueClosedError') {
      return sendError(reply, 503, 'SERVICE_UNAVAILABLE', (error as Error).message);
    }
    request.log.error(error);
    return sendError(reply, 500, 'INTERNAL_ERROR', 'Something went wrong.');
  });

  return app;
}
