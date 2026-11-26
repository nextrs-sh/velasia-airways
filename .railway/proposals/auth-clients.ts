/*
 * PROPOSAL, M9.3 stage 2 (not applied, awaiting approval): both storefronts send the shared
 * service token, and protect their own /api/internal/metrics with the shared metrics token.
 *
 * Adds `RETAILING_API_SERVICE_TOKEN: ${{shared.RETAILING_API_SERVICE_TOKEN}}` and
 * `METRICS_TOKEN: ${{shared.METRICS_TOKEN}}` to @velasia/web and @velasia/web-nextrs. The values
 * are shared variables the owner creates first (outside Git; never in this file, a log, or a
 * NEXT_PUBLIC_ name). The API does not enforce the token yet (stage 3): it ignores the header
 * while unconfigured, so nothing can fail on the API side.
 *
 * Applying it REDEPLOYS both storefronts (environment only: same commit, same image build
 * inputs). Rollback: a proposal that removes the four references (acknowledged destructive
 * `variable.delete` entries). Runbook: docs/deployment/M9.3-API-SECURITY-VALIDATION.md.
 */
import { defineRailway } from 'railway/iac';
import { CURRENT, SERVICES, production } from '../railway.ts';

export const stage = 'clientTokens';

export const expectedChanges = [SERVICES.node, SERVICES.nextrs].flatMap((service) => [
  { kind: 'variable.set', target: `${service}.RETAILING_API_SERVICE_TOKEN` },
  { kind: 'variable.set', target: `${service}.METRICS_TOKEN` },
]);

export default defineRailway((ctx) => production({ ...CURRENT, clientTokens: true }, ctx));
