# Railway IaC reconciliation (M9.2)

`.railway/railway.ts` now describes production **as it runs**, not the original M9 design, and
`railway config plan` on it is a complete no-op. The differences it records are in
[RAILWAY-PRODUCTION-DRIFT.md](RAILWAY-PRODUCTION-DRIFT.md). Every change after this one goes
through [RAILWAY-CHANGE-SAFETY.md](RAILWAY-CHANGE-SAFETY.md).

## What the file is

| Aspect    | Choice                                                                                                                    | Why                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Shape     | Started from `railway config pull --variables=managed` (scratch directory), rewritten by hand with comments, then planned | The import is Railway's own description of the live state                                                            |
| Identity  | Live names `@velasia/retailing-api`, `@velasia/web`, `@velasia/web-nextrs`                                                | IaC matches services by name; a new name plans create + delete                                                       |
| Scope     | Whole project, no `partial` export                                                                                        | Single repository; any omission shows up in the plan as a delete                                                     |
| Variables | **Managed** (the CLI default), every live variable declared with its live value                                           | A dashboard edit shows as drift, and an omission shows as a destructive `variable.delete`. Unmanaged would hide both |
| Secrets   | None exist in production. Future ones: `ctx.shared.NAME` or `preserve()`, never a value                                   | `pnpm railway:check` fails on a secret-named literal or a credential-shaped value                                    |
| Limits    | No `limitOverride`                                                                                                        | Live has none (plan default 2 vCPU / 1 GB). An explicit override plans as `resource.update` (verified)               |
| Allowlist | Live `fd12::/16,10.0.0.0/8`; intended `fd12::/16,10.128.0.0/9` exported as a constant and used only by the proposal       | The baseline stays a strict no-op; narrowing is a separate, reviewed change                                          |
| Domains   | Not represented                                                                                                           | Railway: "Generated Railway service domains are not included in `.railway/railway.ts`"                               |

Literal values were checked against the plan: a wrong literal (`TALADB_PATH=/data/other.db`)
planned as `variable.set`, so the no-op result really compares values. It is not an artefact of
redaction.

SDK: `railway@3.17.0` (3.18.0 was published 2026-11-25; its type definitions are identical for
everything this file uses, so no bump). CLI 5.75.0. The SDK checks the CLI version by running
`$_ --version`, which fails when the plan is spawned from Node.js. `plan-gate.mjs` sets `_` to
the `railway` binary.

## Sanitized plan results

`pnpm railway:plan-gate` on 2026-11-26 (variables managed, project `velasia-airways`,
environment `production`; no IDs):

| File                                     | Changes | Kinds                                                           | Gate                               |
| ---------------------------------------- | ------- | --------------------------------------------------------------- | ---------------------------------- |
| `.railway/railway.ts`                    | 0       | none                                                            | PASS                               |
| `.railway/proposals/nextrs-allowlist.ts` | 1       | `variable.set @velasia/web-nextrs.NEXTRS_NET_ALLOW_ADDR` (safe) | PASS                               |
| proposal plan evaluated as the baseline  | 1       | same                                                            | FAIL (unexpected variable change)  |
| M9 `railway.ts` (before)                 | 7       | 4 `resource.create`, 3 `resource.delete` (destructive)          | FAIL (destroys all three services) |

The fixtures in `scripts/railway/fixtures/` are these real plan outputs, sanitized (IDs, etag
and graph detail removed). They also include a `resource.update` (explicit limits) and a
destructive `variable.delete` (an omitted live variable).

## Proposal: narrow the NextRS allowlist

**Status: proposed, validated locally and through a Railway plan, not applied, awaiting
approval.**

| From                   | To                       | Plan                                |
| ---------------------- | ------------------------ | ----------------------------------- |
| `fd12::/16,10.0.0.0/8` | `fd12::/16,10.128.0.0/9` | one `variable.set` on NextRS (safe) |

- Evidence: all four observed API IPv4 addresses lie in `10.128.0.0/9`, in four different /16
  blocks. IPv6 lies in `fd12:382f:2f26:1::/64`. This is an observation of this environment, not
  a Railway guarantee. Railway documents no private IPv4 range.
- Effect: the lower half of `10.0.0.0/8` (`10.0.0.0`–`10.127.255.255`) becomes unreachable from
  NextRS. Other private and special ranges were never allowed and stay blocked: `172.16/12`,
  `192.168/16`, `127/8`, `169.254/16` (metadata), `fd00::/8` outside `fd12::/16`. `--net-allow`
  still restricts the origin to the API's URL.
- Risk: if Railway ever assigns the API an address in `10.0.0.0/9`, NextRS refuses the API
  (readiness 503 `retailingApi: unreachable`, the deployment does not go live, the old one keeps
  serving). The start script logs the uncovered address.
- Apply (owner, separately approved): see the proposal file's header and
  [RAILWAY-CHANGE-SAFETY.md](RAILWAY-CHANGE-SAFETY.md). It **redeploys `@velasia/web-nextrs`**
  (an env-only redeploy; same image). Check the API's current addresses
  (`railway logs -s @velasia/web-nextrs --dns`) just before. Rollback: the old value, one more
  redeploy.
- Alternative: keep `10.0.0.0/8` and accept the breadth (it is still only the API origin, on
  private ranges).

## Pending changes (not in the current-state file)

Each changes running behaviour and needs its own plan, rollout and approval. `pnpm railway:check`
fails if any of them appears in `.railway/railway.ts`.

| Change                                                                  | Plan                                                                      | Status                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------- |
| Narrow NextRS allowlist                                                 | `.railway/proposals/nextrs-allowlist.ts`                                  | Proposed, plan-gated                   |
| TalaDB volume, Docker-built API, `RAILWAY_RUN_UID`, `NODE_ENV`          | [TALADB-PERSISTENCE-MIGRATION.md](TALADB-PERSISTENCE-MIGRATION.md)        | Proposed, blocked on a backup decision |
| `RETAILING_API_SERVICE_TOKEN`, `METRICS_TOKEN`                          | [RAILWAY-AUTH-ROLLOUT.md](RAILWAY-AUTH-ROLLOUT.md)                        | Proposed                               |
| `VELASIA_TODAY` (deterministic environment only)                        | [benchmark options](railway-benchmark-readiness.md#two-benchmark-options) | Proposed (option B)                    |
| API health check `/health/ready`, `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | together with the API migration (both redeploy the API)                   | Proposed                               |
| Remove stale API variables                                              | a proposal with `allowDestructive` `variable.delete` entries              | Not started                            |
| Equal watch patterns / autodeploy policy                                | owner decision (dashboard; also `build.watchPatterns`)                    | Not started                            |
| Region, explicit limits                                                 | none: `iad` and plan-default limits stay                                  | Not planned                            |

## When production changes

1. Change the IaC first (a proposal file, or `railway.ts` together with
   `scripts/railway/expected-production.mjs`), with the plan output in the PR.
2. Apply only that reviewed plan (owner).
3. Afterwards, the baseline must plan as a no-op again: fold the proposal into `railway.ts` and
   `expected-production.mjs`, then delete the proposal.

A change made in the dashboard first shows up as drift: `pnpm railway:plan-gate` then fails
with an unexpected `variable.set` or `resource.update`. Re-run the read-only inspection and update
both files before anything else.
