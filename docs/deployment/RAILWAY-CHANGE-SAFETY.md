# Railway change safety

How any change to the Railway production environment is checked before the owner applies it.
Introduced in M9.2, after a read-only plan of the M9 IaC showed it would **delete all three live
services**.

## Rules

1. **Never `railway config apply` without the owner's approval of the exact plan.** Never with
   `--yes`, `--confirm-destructive` or a saved `--plan` unless the owner runs it.
2. `.railway/railway.ts` is current state. Its plan must be **empty**. A nonzero plan on it means
   drift, never "nothing to do".
3. A change is a **proposal file** in `.railway/proposals/` that builds on `railway.ts` and
   exports `expectedChanges` (kind + target). Its plan must contain exactly those changes.
4. A production service is never deleted, renamed or replaced through IaC. A service's identity is
   its name.
5. Destructive changes (`variable.delete`, volume changes) need `allowDestructive: true` on their
   expected entry, and a written reason in the PR.
6. Secrets are never values in the repository: `ctx.shared.NAME` or `preserve()` only.

## The checks

| Check                    | Runs where                      | Needs Railway | What it catches                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm railway:check`     | CI (every PR), locally          | no            | Current-state parity against `scripts/railway/expected-production.mjs`: names, `main`, `iad`, one replica, builders and Dockerfiles, Railpack API, no volume, no `limitOverride`, no public API, every live variable declared, no pending change, CIDR policy, secret rules. Also each proposal's offline diff against `railway.ts` |
| `pnpm test:railway`      | CI, locally                     | no            | The rules, the CIDR policy and the plan gate against sanitized real plan outputs (`scripts/railway/fixtures/`)                                                                                                                                                                                                                      |
| `pnpm railway:plan-gate` | Owner / release step, read-only | **yes**       | The real plan: runs `railway config plan --json --detailed-exit-code` and fails on any service deletion, any unexpected create/update/variable change, unknown change kinds, unacknowledged destructive changes, a stale proposal, a volume or a public API domain in the desired graph, or unmanaged variables                     |

PR CI never needs production credentials. The live gate is a separate, deliberately authorized,
read-only step.

## Running the live gate

```bash
railway login                                       # owner
railway link -p <project-id> -e production          # in a scratch or the checkout; local state only
pnpm railway:plan-gate                              # baseline: must be PASS with 0 changes
pnpm railway:plan-gate --file .railway/proposals/nextrs-allowlist.ts
pnpm railway:plan-gate --out-dir .railway/evidence/$(date +%F)   # sanitized copy, gitignored
# from an unlinked checkout: --linked-dir <linked directory>; or RAILWAY_TOKEN=<project token>
# evaluate a saved plan offline: --plan-json plan.json
```

Exit codes: `0` pass, `1` gate failure (or an offline-check failure), `3` plan unavailable
(login, link, CLI). The gate only reads the plan's structured `changeSet` (kinds
`resource.create`, `resource.update`, `resource.delete`, `variable.set`, `variable.delete`;
severities `safe`, `destructive`), never its console text. It fails closed on anything else.

## Applying an approved proposal (owner)

1. `pnpm railway:plan-gate --file <proposal>` passes, and the PR shows the same change set.
2. Note which services the change **redeploys** (any variable or build change redeploys its
   service). For the API that loses data until the
   [persistence migration](TALADB-PERSISTENCE-MIGRATION.md) is done.
3. `railway config apply --file <proposal>`, interactive, reading the confirmation.
4. Verify (health endpoints, logs), then fold the change into `railway.ts` and
   `expected-production.mjs`. `pnpm railway:plan-gate` must be a no-op again.

A temporary service (the benchmark runner) is not in `railway.ts`. Any whole-project apply while
it exists plans its deletion, and the gate reports `unexpected deletion`. Delete the runner first,
or do not apply.
