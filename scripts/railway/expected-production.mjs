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
export const EXPECTED = {
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
  ],
};
