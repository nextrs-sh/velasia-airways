/*
 * PROPOSAL (not applied, awaiting approval): narrow NextRS's outbound address policy from
 * production's `fd12::/16,10.0.0.0/8` to `fd12::/16,10.128.0.0/9`.
 *
 * Same production as .railway/railway.ts with one difference, so its plan must be exactly the
 * one change listed in `expectedChanges`, which `pnpm railway:plan-gate --file
 * .railway/proposals/nextrs-allowlist.ts` enforces (anything else fails the gate).
 *
 * Applying it changes a variable of @velasia/web-nextrs, which REDEPLOYS that service. Before
 * that: re-read the API's current addresses (`railway logs -s @velasia/web-nextrs --dns`) and
 * confirm they are inside 10.128.0.0/9; afterwards confirm /api/internal/health/ready is 200.
 * Rollback: set the variable back to `fd12::/16,10.0.0.0/8` (another redeploy).
 * See docs/deployment/RAILWAY-IAC-RECONCILIATION.md, "Proposal: narrow the NextRS allowlist".
 */
import { defineRailway } from 'railway/iac';
import { CURRENT, NEXTRS_NET_ALLOW_ADDR_INTENDED, SERVICES, production } from '../railway.ts';

/** The only changes this proposal's plan may contain (kind + target). */
export const expectedChanges = [
  { kind: 'variable.set', target: `${SERVICES.nextrs}.NEXTRS_NET_ALLOW_ADDR` },
];

export default defineRailway(() =>
  production({ ...CURRENT, nextrsNetAllowAddr: NEXTRS_NET_ALLOW_ADDR_INTENDED }),
);
