/*
 * PROPOSAL, M9.3 stage 1 (not applied, awaiting approval): TalaDB on a persistent volume.
 *
 * Production as in .railway/railway.ts, plus:
 *   - volume `velasia-api-data` (500 MB, iad) mounted on @velasia/retailing-api at /data;
 *   - the API built from docker/Dockerfile.api instead of Railpack: its entrypoint
 *     docker/api/start.sh runs (TALADB_REQUIRE_VOLUME=enabled refuses to start without the
 *     mount; started as root it gives /data to uid 1000 and drops privileges) and the API runs
 *     the esbuild bundle with Node.js, no tsx;
 *   - deploy health check /health/ready (TalaDB open, migrations verified, recovery done, not
 *     shutting down), timeout 120 s;
 *   - NODE_ENV=production, PORT=4010 (Railway's health check port), RAILWAY_DOCKERFILE_PATH,
 *     RAILWAY_RUN_UID=0 (for start.sh only), RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15 (above
 *     SHUTDOWN_TIMEOUT_MS=10000, so a graceful shutdown finishes before SIGKILL).
 * TALADB_PATH stays /data/velasia.db.
 *
 * The owner approved discarding the current (ephemeral, fictional) demo database: the API
 * starts on an EMPTY volume and creates a fresh database. Nothing is copied or restored.
 *
 * Applying it REDEPLOYS @velasia/retailing-api once (Docker build, then the old deployment is
 * stopped before the volume-backed one starts: about 1–3 minutes without the API). The
 * storefronts are not redeployed. Runbook: docs/deployment/M9.3-TALADB-PERSISTENCE-VALIDATION.md.
 */
import { defineRailway } from 'railway/iac';
import { API_VOLUME, CURRENT, SERVICES, production } from '../railway.ts';

export const stage = 'apiPersistence';

/** The only changes this proposal's plan may contain (kind + target). */
export const expectedChanges = [
  { kind: 'resource.create', target: API_VOLUME.name },
  {
    kind: 'resource.update',
    target: SERVICES.api,
    // The only API settings the plan may change (the gate refuses any other field).
    fields: [
      'build.builder',
      'build.buildCommand',
      'build.dockerfilePath',
      'deploy.startCommand',
      'deploy.healthcheckPath',
      'deploy.healthcheckTimeout',
      `volumeAttachments.${API_VOLUME.name}.mountPath`,
      `volumeAttachments.${API_VOLUME.name}.volume`,
    ],
  },
  { kind: 'variable.set', target: `${SERVICES.api}.NODE_ENV` },
  { kind: 'variable.set', target: `${SERVICES.api}.PORT` },
  { kind: 'variable.set', target: `${SERVICES.api}.RAILWAY_DEPLOYMENT_DRAINING_SECONDS` },
  { kind: 'variable.set', target: `${SERVICES.api}.RAILWAY_DOCKERFILE_PATH` },
  { kind: 'variable.set', target: `${SERVICES.api}.RAILWAY_RUN_UID` },
];

export default defineRailway((ctx) => production({ ...CURRENT, apiPersistence: true }, ctx));
