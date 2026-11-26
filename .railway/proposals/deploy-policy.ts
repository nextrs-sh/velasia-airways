/*
 * PROPOSAL, M9.3 stage 5 (not applied, awaiting approval): coordinated deployments.
 *
 *   - `checkSuites: true` on all three services: a GitHub autodeploy waits until the commit's
 *     CI checks pass (Railway's "Wait for CI"), and never deploys a red commit;
 *   - both storefronts watch the same paths (everything either image is built from), so a
 *     merge rebuilds both from the same commit or neither; the API watches what its Docker
 *     image is built from.
 *
 * What it cannot do: stop autodeploy. During a migration window or a benchmark series `main` is
 * frozen (nothing is merged), and `pnpm railway:deployments --compare` proves that nothing was
 * deployed meanwhile (docs/deployment/M9.3-DEPLOYMENT-PARITY.md).
 *
 * Applying it changes service settings only. Whether Railway redeploys on a settings-only
 * change is read from the plan before applying (expected: no redeploy until the next commit).
 */
import { defineRailway } from 'railway/iac';
import { CURRENT, SERVICES, production } from '../railway.ts';

export const stage = 'deployPolicy';

export const expectedChanges = [SERVICES.api, SERVICES.node, SERVICES.nextrs].map((target) => ({
  kind: 'resource.update',
  target,
  fields: ['source.checkSuites', 'build.watchPatterns'],
}));

export default defineRailway((ctx) => production({ ...CURRENT, deployPolicy: true }, ctx));
