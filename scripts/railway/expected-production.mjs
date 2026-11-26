/**
 * M9.2: the production facts .railway/railway.ts must keep describing, recorded independently
 * of that file so `pnpm railway:check` can catch an edit that would change production.
 *
 * Verified 2026-11-26 with read-only commands (`railway status --json`, `railway config pull
 * --json`, `railway variables --json`, `railway metrics --all --json`); railway.ts planned as a
 * complete no-op against it. Changing production deliberately means changing this file in the
 * same reviewed PR, with the plan that shows the change (docs/deployment/RAILWAY-CHANGE-SAFETY.md).
 *
 * Service names are Railway's resource identities here: a renamed service is a new resource.
 */
const BASE = {
  project: 'velasia-airways',
  environment: 'production',
  repo: 'nextrs-sh/velasia-airways',
  branch: 'main',
  region: 'iad',
  services: {
    '@velasia/retailing-api': {
      role: 'api',
      builder: 'RAILPACK',
      buildCommand: 'pnpm --filter @velasia/retailing-api build',
      startCommand: 'pnpm --filter @velasia/retailing-api start',
      privateNetworkEndpoint: 'velasiaretailing-api',
      variables: [
        'ACCOUNT_REGISTRATION',
        'CHECKOUT_HOLD_MINUTES',
        'CHECKOUT_MAX_PAYMENT_ATTEMPTS',
        'INVENTORY_HORIZON_DAYS',
        'INVENTORY_SEED',
        'LOG_LEVEL',
        'OFFER_VALIDITY_MINUTES',
        'ORDER_SWEEP_INTERVAL_MS',
        'PAYMENT_OUTCOME_CONTROLS',
        'PAYMENT_PENDING_RESOLVE_MS',
        'PAYMENT_PROVIDER_DELAY_MS',
        'PAYMENT_PROVIDER_TIMEOUT_MS',
        'RETAILING_API_HOST',
        'RETAILING_API_PORT',
        'RETAILING_API_TIMEOUT_MS',
        'RETAILING_API_URL',
        'SERVICING_CLAIM_MINUTES',
        'SHUTDOWN_TIMEOUT_MS',
        'SITE_URL',
        'SLOW_REQUEST_MS',
        'TALADB_PATH',
        'TALADB_REQUIRE_VOLUME',
        'VELASIA_HTTP_BIND',
        'VELASIA_HTTP_PORT',
        'VELASIA_POST_RATE_LIMIT_BURST',
        'VELASIA_POST_RATE_LIMIT_RPS',
        'VELASIA_RATE_LIMIT_BURST',
        'VELASIA_RATE_LIMIT_RPS',
        'VELASIA_TAG',
      ],
      /** Known-stale values (from local Compose); removal is a pending, approved cleanup. */
      staleVariables: [
        'RETAILING_API_URL',
        'SITE_URL',
        'VELASIA_HTTP_BIND',
        'VELASIA_HTTP_PORT',
        'VELASIA_TAG',
      ],
    },
    '@velasia/web': {
      role: 'storefront',
      builder: 'DOCKERFILE',
      dockerfilePath: 'Dockerfile.node',
      privateNetworkEndpoint: 'velasiaweb',
      variables: [
        'RAILWAY_DOCKERFILE_PATH',
        'RETAILING_API_START_TIMEOUT_MS',
        'RETAILING_API_URL',
        'SITE_URL',
      ],
    },
    '@velasia/web-nextrs': {
      role: 'storefront',
      builder: 'DOCKERFILE',
      dockerfilePath: 'Dockerfile.nextrs',
      privateNetworkEndpoint: 'velasiaweb-nextrs',
      variables: [
        'NEXTRS_NET_ALLOW_ADDR',
        'RAILWAY_DOCKERFILE_PATH',
        'RETAILING_API_URL',
        'SITE_URL',
      ],
    },
  },
  /** Storefront variables allowed to differ between the two runtimes. */
  perRuntimeVariables: ['RAILWAY_DOCKERFILE_PATH', 'SITE_URL', 'NEXTRS_NET_ALLOW_ADDR'],
  /** Present on one storefront only, verified inert at runtime (warned, not failed). */
  inertStorefrontVariables: ['RETAILING_API_START_TIMEOUT_MS'],
  storefrontHealthcheck: '/api/internal/health/ready',
  apiPrivateUrl: 'http://velasiaretailing-api.railway.internal:4010',
  /** NextRS allowlist live in production (broader than the policy; narrowing is a proposal). */
  nextrsNetAllowAddrLive: 'fd12::/16,10.0.0.0/8',
  /**
   * Pending changes that must NOT appear in the current-state file (each needs its own
   * rollout plan): checked by name.
   */
  pendingVariables: [
    'VELASIA_TODAY',
    'RETAILING_API_SERVICE_TOKEN',
    'METRICS_TOKEN',
    'NODE_ENV',
    'RAILWAY_RUN_UID',
    'RAILWAY_DEPLOYMENT_DRAINING_SECONDS',
    'PORT',
  ],
  /** No volume in production today (stage 1 adds one). */
  volumes: [],
  /** GitHub autodeploy waits for no CI (`checkSuites: false`; stage 5 turns it on). */
  checkSuites: false,
};

/*
 * M9.3 staged changes, recorded independently of .railway/railway.ts. Each stage says what
 * production looks like once it is applied; a proposal is checked against BASE plus the
 * applied stages plus its own stage, and nothing else may differ.
 */
export const STAGES = {
  /** Stage 1: TalaDB on a volume; the API built from docker/Dockerfile.api. */
  apiPersistence: {
    title: 'API volume, Docker build, health check and draining window',
    requires: [],
    apply(e) {
      const api = e.services['@velasia/retailing-api'];
      api.builder = 'DOCKERFILE';
      api.dockerfilePath = 'docker/Dockerfile.api';
      delete api.buildCommand;
      delete api.startCommand;
      api.healthcheck = '/health/ready';
      api.volume = 'velasia-api-data';
      api.variables.push(
        'NODE_ENV',
        'PORT',
        'RAILWAY_DEPLOYMENT_DRAINING_SECONDS',
        'RAILWAY_DOCKERFILE_PATH',
        'RAILWAY_RUN_UID',
      );
      api.literals = {
        ...api.literals,
        NODE_ENV: 'production',
        PORT: '4010',
        RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '15',
        RAILWAY_RUN_UID: '0',
        TALADB_PATH: '/data/velasia.db',
        TALADB_REQUIRE_VOLUME: 'enabled',
      };
      e.volumes = [{ name: 'velasia-api-data', mountPath: '/data', region: 'iad', sizeMB: 500 }];
    },
  },
  /** Stage 2: both storefronts send the shared tokens (the API does not require them yet). */
  clientTokens: {
    title: 'Shared service and metrics tokens on both storefronts',
    requires: [],
    apply(e) {
      for (const name of ['@velasia/web', '@velasia/web-nextrs']) {
        e.services[name].variables.push('RETAILING_API_SERVICE_TOKEN', 'METRICS_TOKEN');
      }
    },
  },
  /** Stage 3: the API requires the service token, and the metrics token on /metrics. */
  apiTokenEnforcement: {
    title: 'Service-token and metrics-token enforcement on the API',
    requires: ['apiPersistence', 'clientTokens'],
    apply(e) {
      e.services['@velasia/retailing-api'].variables.push(
        'RETAILING_API_SERVICE_TOKEN',
        'METRICS_TOKEN',
      );
    },
  },
  /** Stage 4: the narrowed NextRS outbound allowlist. */
  nextrsAllowlist: {
    title: 'Narrow the NextRS allowlist to fd12::/16,10.128.0.0/9',
    requires: [],
    apply(e) {
      e.nextrsNetAllowAddrLive = 'fd12::/16,10.128.0.0/9';
    },
  },
  /** Stage 5: autodeploys wait for CI; both storefronts watch the same paths. */
  deployPolicy: {
    title: 'Wait for CI; identical storefront watch patterns',
    requires: [],
    apply(e) {
      e.checkSuites = true;
      e.sameStorefrontWatchPatterns = true;
    },
  },
};

/**
 * Stages applied to production and verified (in order). Changing this list is part of folding
 * an applied stage into .railway/railway.ts (CURRENT must agree; check-iac.mjs checks it).
 */
export const APPLIED_STAGES = [
  // 2026-11-26 07:02 UTC (pinned plan, 9 changes, 0 destructive); persistence verified across a
  // restart and a redeploy. Proposal deleted; its expected changes live on in m9-3-stages.test.mjs.
  'apiPersistence',
  // 2026-11-26 07:37 UTC (pinned plan, 6 resource.update, 0 destructive). Railway redeployed all
  // three services from the settings change (same images); parity and persistence verified.
  'deployPolicy',
];

/** What production must look like with these stages applied (a fresh copy). */
export function expectedFor(stages = APPLIED_STAGES) {
  const e = structuredClone(BASE);
  for (const name of stages) {
    const stage = STAGES[name];
    if (!stage) throw new Error(`unknown stage ${name}`);
    stage.apply(e);
  }
  const live = new Set(Object.values(e.services).flatMap((s) => s.variables));
  e.pendingVariables = e.pendingVariables.filter((v) => !live.has(v));
  e.stages = [...stages];
  return e;
}

/** Production as it is today. */
export const EXPECTED = expectedFor(APPLIED_STAGES);
