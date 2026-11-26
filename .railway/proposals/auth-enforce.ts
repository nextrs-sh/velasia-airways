/*
 * PROPOSAL, M9.3 stage 3 (not applied; BLOCKED until stages 1 and 2 are applied and verified):
 * the API requires the service token from every caller except its health probes, and the
 * metrics token (in addition) on /metrics.
 *
 * Adds the same two shared-variable references to @velasia/retailing-api. Requires
 * apiPersistence (the redeploy must not lose the database) and clientTokens (both storefronts
 * already send the token, or every API call would get 401).
 *
 * Applying it REDEPLOYS the API (about 1–3 minutes without it; the volume keeps the database).
 * Rollback: remove the two references (one more API redeploy); the storefronts keep sending a
 * header the API then ignores. Runbook: docs/deployment/M9.3-API-SECURITY-VALIDATION.md.
 */
import { defineRailway } from 'railway/iac';
import { CURRENT, SERVICES, production } from '../railway.ts';

export const stage = 'apiTokenEnforcement';

export const expectedChanges = [
  { kind: 'variable.set', target: `${SERVICES.api}.RETAILING_API_SERVICE_TOKEN` },
  { kind: 'variable.set', target: `${SERVICES.api}.METRICS_TOKEN` },
];

export default defineRailway((ctx) => production({ ...CURRENT, apiTokenEnforcement: true }, ctx));
