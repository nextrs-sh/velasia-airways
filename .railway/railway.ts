/*
 * Velasia Airways on Railway: Infrastructure as Code, reconciled with production (M9.2).
 *
 * This file describes the production environment AS IT RUNS TODAY, verified on 2026-11-26 with
 * read-only commands (`railway status --json`, `railway config pull --json`, `railway variables
 * --json`, `railway metrics --all --json`). `railway config plan` on this file is a complete
 * no-op ("already up to date"). It is NOT the original Milestone 9 design (Singapore,
 * `deploy/railway`, Docker-built API on a volume, pinned clock, service tokens): those are
 * pending changes, each with its own reviewed rollout (docs/deployment/RAILWAY-IAC-RECONCILIATION.md).
 *
 *   @velasia/web          Dockerfile.node     Next.js server (Node.js)   public generated domain
 *   @velasia/web-nextrs   Dockerfile.nextrs   NextRS (no Node.js)        public generated domain
 *   @velasia/retailing-api  Railpack (pnpm)   Fastify + TalaDB           private network only
 *
 * Identity: Railway matches a service in this file to the existing service OF THE SAME NAME.
 * A different name is a different resource: renaming a service here plans "create" for the new
 * name and "delete" for the old one. In this whole-project file, an omitted service or variable
 * is DELETED by an apply. Never rename or drop anything here.
 *
 *   pnpm railway:check                       offline checks (no Railway account; also in CI)
 *   pnpm railway:plan-gate                   read-only plan + destructive-change gate (needs login)
 *   railway config plan --file .railway/railway.ts   the raw read-only plan
 *
 * Never `railway config apply` from this milestone. An apply needs the owner's approval of the
 * exact plan (docs/deployment/RAILWAY-CHANGE-SAFETY.md).
 *
 * Variables are managed (the CLI default): every variable live on these three services is
 * declared here with its live value, so a dashboard edit shows up as drift in the plan, and an
 * omitted variable shows up as a destructive `variable.delete`. None of them is a secret today
 * (no token is configured in production). A future secret is never written here as a value:
 * it is `ctx.shared.NAME` (an existing shared variable) or `preserve()` (keep Railway's value).
 *
 * What this file does not set:
 *   - Generated *.up.railway.app domains (not represented in IaC; they exist on both storefronts,
 *     target port 8080, and none on the API).
 *   - CPU/memory: no `limitOverride` on any service. All three run with the plan's default
 *     limit (2 vCPU / 1 GB on the current Trial plan, read from `railway metrics`), so both
 *     storefronts are equal by construction. An explicit override plans as a change.
 *   - GitHub autodeploy and its watch patterns' effects, volume backups, usage limits.
 */
import { defineRailway, github, project, service } from 'railway/iac';

export const PROJECT = 'velasia-airways';
export const REPO = 'nextrs-sh/velasia-airways';
/** All three services deploy from `main` (GitHub autodeploy is on; see the drift report). */
export const DEPLOY_BRANCH = 'main';
/** US East (Virginia). All three services; there is no volume. */
export const REGION = 'iad';

/** Existing Railway service names: their identity. Never rename. */
export const SERVICES = {
  api: '@velasia/retailing-api',
  node: '@velasia/web',
  nextrs: '@velasia/web-nextrs',
} as const;

/** The API's private host, from its private network endpoint `velasiaretailing-api`. */
const API_PRIVATE_URL = 'http://velasiaretailing-api.railway.internal:4010';

/*
 * NextRS outbound address policy (NEXTRS_NET_ALLOW_ADDR). NextRS refuses the API lookup if ANY
 * address in the DNS answer is non-public and outside these ranges; the environment is
 * dual-stack, so velasiaretailing-api.railway.internal has an A and an AAAA record.
 *
 * LIVE: what production has today (set in the dashboard on 2026-11-25). 10.0.0.0/8 is broader
 * than needed.
 *
 * INTENDED: the narrowed policy. Railway documents no private IPv4 range; 10.128.0.0/9 is an
 * observation of THIS environment (every API address seen so far, below), not a Railway
 * guarantee, and it may not hold for other projects. The IPv6 range is Railway's private
 * network (all observed AAAA answers are in fd12:382f:2f26:1::/64).
 *
 * The intended value is not applied by this file: `.railway/proposals/nextrs-allowlist.ts`
 * plans it as exactly one variable change, for a separate reviewed rollout.
 */
export const NEXTRS_NET_ALLOW_ADDR_LIVE = 'fd12::/16,10.0.0.0/8';
export const NEXTRS_NET_ALLOW_ADDR_INTENDED = 'fd12::/16,10.128.0.0/9';

/**
 * Addresses `velasiaretailing-api.railway.internal` resolved to (NextRS startup logs and
 * `railway logs --dns`). The API's IPv4 changes on every API redeploy.
 */
export const OBSERVED_API_ADDRESSES = [
  { address: '10.228.244.185', seen: '2026-11-25' },
  { address: '10.146.207.192', seen: '2026-11-25' },
  { address: '10.236.48.211', seen: '2026-11-26' },
  { address: '10.137.93.22', seen: '2026-11-26' },
  { address: 'fd12:382f:2f26:1:a000:1f:5092:cfc0', seen: '2026-11-25' },
  { address: 'fd12:382f:2f26:1:3000:179:bb6c:30d3', seen: '2026-11-26' },
  { address: 'fd12:382f:2f26:1:3000:1b6:5a89:5d16', seen: '2026-11-26' },
] as const;

export interface ProductionOptions {
  /** NextRS's NEXTRS_NET_ALLOW_ADDR. */
  nextrsNetAllowAddr: string;
}

/** Production today. */
export const CURRENT: ProductionOptions = { nextrsNetAllowAddr: NEXTRS_NET_ALLOW_ADDR_LIVE };

export function production(options: ProductionOptions = CURRENT) {
  const source = github(REPO, { branch: DEPLOY_BRANCH, checkSuites: false });

  const api = service(SERVICES.api, {
    source,
    // Railpack (Nixpacks' successor), NOT docker/Dockerfile.api: docker/api/start.sh (volume
    // guard, uid drop) does not run, and the API runs TypeScript through tsx.
    build: {
      builder: 'RAILPACK',
      buildEnvironment: 'V3',
      buildCommand: 'pnpm --filter @velasia/retailing-api build',
      watchPatterns: ['/apps/retailing-api/**'],
    },
    start: 'pnpm --filter @velasia/retailing-api start',
    replicas: { [REGION]: 1 },
    networking: { privateNetworkEndpoint: 'velasiaretailing-api' },
    // No volume, no deploy health check, no NODE_ENV, no VELASIA_TODAY, no tokens: all live
    // facts, all pending changes (see the drift report). The database is on the container's
    // ephemeral disk.
    env: {
      ACCOUNT_REGISTRATION: 'disabled',
      CHECKOUT_HOLD_MINUTES: '10',
      CHECKOUT_MAX_PAYMENT_ATTEMPTS: '5',
      INVENTORY_HORIZON_DAYS: '120',
      INVENTORY_SEED: 'aeronova',
      LOG_LEVEL: 'info',
      OFFER_VALIDITY_MINUTES: '15',
      ORDER_SWEEP_INTERVAL_MS: '30000',
      PAYMENT_OUTCOME_CONTROLS: 'disabled',
      PAYMENT_PENDING_RESOLVE_MS: '5000',
      PAYMENT_PROVIDER_DELAY_MS: '350',
      PAYMENT_PROVIDER_TIMEOUT_MS: '2500',
      RETAILING_API_HOST: '::',
      RETAILING_API_PORT: '4010',
      RETAILING_API_TIMEOUT_MS: '5000',
      SERVICING_CLAIM_MINUTES: '10',
      SHUTDOWN_TIMEOUT_MS: '10000',
      SLOW_REQUEST_MS: '1000',
      // Inert under Railpack: only docker/api/start.sh reads TALADB_REQUIRE_VOLUME, so nothing
      // stops the API from writing /data/velasia.db to ephemeral storage today.
      TALADB_PATH: '/data/velasia.db',
      TALADB_REQUIRE_VOLUME: 'enabled',
      VELASIA_POST_RATE_LIMIT_BURST: '30',
      VELASIA_POST_RATE_LIMIT_RPS: '10',
      VELASIA_RATE_LIMIT_BURST: '100',
      VELASIA_RATE_LIMIT_RPS: '50',
      // Stale values copied from the local Compose setup; the API does not use them. Removal is
      // a pending cleanup (a `variable.delete`, so it needs its own approved plan).
      RETAILING_API_URL: 'http://127.0.0.1:4010',
      SITE_URL: 'http://localhost:8080',
      VELASIA_HTTP_BIND: '127.0.0.1',
      VELASIA_HTTP_PORT: '8080',
      VELASIA_TAG: 'local',
    },
  });

  /** Same for both storefronts: health check, replica, region. */
  const storefront = {
    source,
    healthcheck: '/api/internal/health/ready',
    healthcheckTimeout: 60,
    replicas: { [REGION]: 1 },
  };

  const node = service(SERVICES.node, {
    ...storefront,
    build: {
      builder: 'DOCKERFILE',
      buildEnvironment: 'V3',
      dockerfilePath: 'Dockerfile.node',
      buildCommand: '',
      // Differs from NextRS (none): a change outside apps/web/ redeploys NextRS but not Node.js.
      watchPatterns: ['/apps/web/**'],
    },
    start: '',
    networking: { privateNetworkEndpoint: 'velasiaweb' },
    env: {
      RAILWAY_DOCKERFILE_PATH: 'Dockerfile.node',
      RETAILING_API_URL: API_PRIVATE_URL,
      SITE_URL: 'https://velasiaweb-production.up.railway.app',
      // Inert: read only by the image build's throwaway API, and Dockerfile.node sets its own.
      RETAILING_API_START_TIMEOUT_MS: '60000',
    },
  });

  const nextrs = service(SERVICES.nextrs, {
    ...storefront,
    build: { builder: 'DOCKERFILE', buildEnvironment: 'V3', dockerfilePath: 'Dockerfile.nextrs' },
    networking: { privateNetworkEndpoint: 'velasiaweb-nextrs' },
    env: {
      RAILWAY_DOCKERFILE_PATH: 'Dockerfile.nextrs',
      RETAILING_API_URL: API_PRIVATE_URL,
      SITE_URL: 'https://velasiaweb-nextrs-production.up.railway.app',
      NEXTRS_NET_ALLOW_ADDR: options.nextrsNetAllowAddr,
    },
  });

  return project(PROJECT, { resources: [api, node, nextrs] });
}

export default defineRailway(() => production(CURRENT));
