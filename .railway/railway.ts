/*
 * Velasia Airways on Railway: Infrastructure as Code (Milestone 9).
 *
 * One project, three services built from this repository's production Dockerfiles, with the
 * repository root as the build context (the Dockerfiles copy workspace packages from it):
 *
 *   velasia-node    Dockerfile.node          official Next.js server   public (generated domain)
 *   velasia-nextrs  Dockerfile.nextrs        NextRS (no Node.js)       public (generated domain)
 *   velasia-api     docker/Dockerfile.api    Fastify + TalaDB          private network only
 *
 * The browser talks only to the storefronts (`/api/*` route handlers, Server Actions); both
 * storefronts call the same API at http://velasia-api.railway.internal:4010 with the same
 * service token.
 *
 *   pnpm railway:check     typecheck + offline checks of this file (no Railway account needed)
 *   railway config plan    read-only diff against the linked environment (needs `railway login`)
 *
 * Milestone 9 is preparation only: never `railway config apply` without the owner's go-ahead.
 * In whole-project mode an apply DELETES any service of the environment that is missing here.
 *
 * What this file does not (and cannot) set; see docs/deployment/railway.md:
 *   - Railway-generated *.up.railway.app domains ("not included in .railway/railway.ts"): one per
 *     storefront, target port 8080, created with `railway domain` or the dashboard. None for the API.
 *   - Shared variables RETAILING_API_SERVICE_TOKEN and METRICS_TOKEN: only referenced here
 *     (ctx.shared), created in the dashboard with values generated outside the repository.
 *   - GitHub autodeploy: no IaC field. Disable it per service in the dashboard; deployments are
 *     started deliberately from DEPLOY_BRANCH.
 *   - Volume backups, usage limits, sealing.
 *
 * Settings marked [SDK] exist in the `railway` package's types (3.17.0) but not in the IaC
 * documentation; the first `railway config plan` must show them as intended, or they are set in
 * the dashboard instead (docs/deployment/railway.md, "IaC coverage").
 *
 * No secret value is written here, and none may be: secrets are `ctx.shared.*` references.
 */
import { defineRailway, github, project, service, volume } from 'railway/iac';

/** The repository every service builds from. */
const REPO = 'nextrs-sh/velasia-airways';
/**
 * The branch all three services deploy from. Move it deliberately (fast-forward to the commit
 * under test) so both storefronts always run the same source revision; `main` merges do not
 * redeploy anything.
 */
const DEPLOY_BRANCH = 'deploy/railway';
/**
 * One region for all three services and the volume (Southeast Asia, Singapore). Full region ID
 * from https://docs.railway.com/deployments/regions (the IaC reference shows short IDs; check
 * the first plan). Region choice needs the Trial plan or above.
 */
const REGION = 'asia-southeast1-eqsg3a';
/**
 * Pinned "today" (YYYY-MM-DD, Asia/Manila) for the API and both storefronts, at build and run
 * time: deterministic inventory, prices and prerendered pages for parity runs and benchmarks.
 * Set to '' for a live-calendar demo (then on every service at once).
 */
const VELASIA_TODAY = '2026-12-01';
/** The API's deterministic demand seed (the application default, stated explicitly). */
const INVENTORY_SEED = 'aeronova';

/**
 * NextRS outbound policy. Railway's private network is documented as fd12::/16 (IPv6). Projects
 * created after 2025-10-16 are dual-stack, so velasia-api.railway.internal also has an IPv4
 * (A) record, and NextRS refuses the whole DNS answer if ANY address is outside these ranges.
 * Railway does not document its private IPv4 range: it is read from the running environment
 * (docs/deployment/railway.md, "Private IPv4 range") and entered here. Never 10.0.0.0/8 or wider.
 */
const RAILWAY_PRIVATE_IPV6 = 'fd12::/16';
const RAILWAY_PRIVATE_IPV4: string = '';

/** Identical for both storefronts: a comparison needs equal CPU and memory. [SDK] */
const STOREFRONT_LIMITS = { containers: { cpu: 1, memoryBytes: 1024 * 1024 * 1024 } };
const API_LIMITS = { containers: { cpu: 1, memoryBytes: 768 * 1024 * 1024 } };
/** Trial accounts allow at most 10 restarts on failure ("Always" needs a paid plan). [SDK] */
const RESTART = { restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 10 } as const;
/** SIGTERM-to-SIGKILL time; Railway's default is 0 (killed at once). Above the apps' 10 s. */
const DRAINING_SECONDS = '15';

export default defineRailway((ctx) => {
  const apiData = volume('velasia-api-data', { region: REGION, sizeMB: 500 });

  const api = service('velasia-api', {
    source: github(REPO, { branch: DEPLOY_BRANCH }),
    build: { builder: 'DOCKERFILE', dockerfilePath: 'docker/Dockerfile.api' }, // [SDK]
    // Exactly one API process owns the TalaDB file: one replica (Railway also refuses replicas
    // with a volume, and never mounts one volume into two deployments at once).
    replicas: { [REGION]: 1 },
    healthcheck: '/health/ready',
    healthcheckTimeout: 120,
    deploy: { ...RESTART, sleepApplication: false, limitOverride: API_LIMITS }, // [SDK]
    volumeMounts: { '/data': apiData },
    env: {
      RAILWAY_DOCKERFILE_PATH: 'docker/Dockerfile.api',
      // Railway mounts volumes root-owned. The entrypoint (docker/api/start.sh) runs as root
      // only to give /data to uid 1000, then drops privileges; the API never runs as root.
      RAILWAY_RUN_UID: '0',
      RAILWAY_DEPLOYMENT_DRAINING_SECONDS: DRAINING_SECONDS,
      NODE_ENV: 'production',
      // `::` accepts IPv6 and IPv4 on the private network (legacy environments are IPv6-only).
      RETAILING_API_HOST: '::',
      RETAILING_API_PORT: '4010',
      // Railway's deploy health check probes $PORT.
      PORT: '4010',
      TALADB_PATH: '/data/velasia.db',
      // Refuse to start unless /data is the mounted volume (never ephemeral storage).
      TALADB_REQUIRE_VOLUME: 'enabled',
      INVENTORY_SEED,
      VELASIA_TODAY,
      ACCOUNT_REGISTRATION: 'disabled',
      PAYMENT_OUTCOME_CONTROLS: 'disabled',
      SHUTDOWN_TIMEOUT_MS: '10000',
      LOG_LEVEL: 'info',
      RETAILING_API_SERVICE_TOKEN: ctx.shared.RETAILING_API_SERVICE_TOKEN,
      METRICS_TOKEN: ctx.shared.METRICS_TOKEN,
    },
  });

  /** Runtime and build variables both storefronts share (the build reads SITE_URL, VELASIA_TODAY). */
  const storefrontEnv = {
    RAILWAY_DEPLOYMENT_DRAINING_SECONDS: DRAINING_SECONDS,
    NODE_ENV: 'production',
    PORT: '8080',
    // Each storefront's own generated domain. It must exist before the first build (two-stage
    // bootstrap): SITE_URL is baked into sitemap/robots/metadata at build time.
    SITE_URL: 'https://${{RAILWAY_PUBLIC_DOMAIN}}',
    // The private API, never a public URL; resolved by Railway at runtime only.
    RETAILING_API_URL: 'http://${{velasia-api.RAILWAY_PRIVATE_DOMAIN}}:${{velasia-api.PORT}}',
    RETAILING_API_TIMEOUT_MS: '5000',
    VELASIA_TODAY,
    RETAILING_API_SERVICE_TOKEN: ctx.shared.RETAILING_API_SERVICE_TOKEN,
    METRICS_TOKEN: ctx.shared.METRICS_TOKEN,
  };
  const storefront = {
    source: github(REPO, { branch: DEPLOY_BRANCH }),
    replicas: { [REGION]: 1 },
    // Ready = the server answers AND reaches the API (for NextRS: through its network policy).
    healthcheck: '/api/internal/health/ready',
    healthcheckTimeout: 120,
    deploy: { ...RESTART, sleepApplication: false, limitOverride: STOREFRONT_LIMITS }, // [SDK]
    cdn: { enabled: false },
  };

  const node = service('velasia-node', {
    ...storefront,
    build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile.node' }, // [SDK]
    env: { ...storefrontEnv, RAILWAY_DOCKERFILE_PATH: 'Dockerfile.node' },
  });

  const nextrs = service('velasia-nextrs', {
    ...storefront,
    build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile.nextrs' }, // [SDK]
    env: {
      ...storefrontEnv,
      RAILWAY_DOCKERFILE_PATH: 'Dockerfile.nextrs',
      // One V8 isolate: one JavaScript thread, like the single Node.js process.
      NEXTRS_ISOLATES: '1',
      NEXTRS_SHUTDOWN_GRACE: '10',
      NEXTRS_NET_ALLOW_ADDR: [RAILWAY_PRIVATE_IPV6, RAILWAY_PRIVATE_IPV4].filter(Boolean).join(','),
    },
  });

  return project('velasia-airways', { resources: [api, apiData, node, nextrs] });
});
