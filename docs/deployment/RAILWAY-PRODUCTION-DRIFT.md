# Railway production drift (M9.2)

What the Railway production environment actually runs, compared with the Milestone 9
Infrastructure as Code (`.railway/railway.ts` before M9.2), verified on **2026-11-26** with
read-only commands only.

| Status                  | Meaning                                                                  |
| ----------------------- | ------------------------------------------------------------------------ |
| **Deployed**            | Running in production now                                                |
| **Configured (IaC)**    | Declared in `.railway/railway.ts` after M9.2 (equal to deployed)         |
| **Proposed**            | Written down or in `.railway/proposals/`, not applied, awaiting approval |
| **Validated locally**   | `pnpm railway:check`, `pnpm test:railway` (CI)                           |
| **Validated (Railway)** | `railway config plan` / `pnpm railway:plan-gate` against production      |

## How it was verified

| Command (read-only)                              | What it gave                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| `railway status --json`                          | Services, active deployments, commits, build/deploy manifests     |
| `railway config pull --json` (scratch directory) | The imported IaC graph; variables as `preserve()` (names only)    |
| `railway config pull --variables=managed`        | An authoring file, written to a scratch repository, then compared |
| `railway variables --json -s <service>`          | Variable values (none secret: no token exists); secrets redacted  |
| `railway metrics --all --json`                   | CPU and memory limits                                             |
| `railway deployment list --json -s <service>`    | Deployment history                                                |
| `railway logs --dns` / startup logs              | The API's private addresses as the storefronts resolve them       |
| `railway config plan --json` (old and new file)  | The change sets in the tables below                               |

The pull went into an isolated scratch directory and never touched the repository file. The raw
exports (with project, environment, service and deployment IDs) are kept as private evidence
under `.railway/evidence/` (gitignored, owner-only permissions). Nothing was applied, redeployed,
restarted, attached or deleted. No shell was opened in any production container.

## Service identities

Railway matches IaC services **by name**. The plan confirms it: the M9 file's `velasia-api` was
planned as "Create service velasia-api" plus "Delete service @velasia/retailing-api", not as an
update. A matching name is the only adoption mechanism, so the reconciled file uses the live names.

| Service (identity)       | Private endpoint                        | Public domain                                 | Active deployment                    |
| ------------------------ | --------------------------------------- | --------------------------------------------- | ------------------------------------ |
| `@velasia/retailing-api` | `velasiaretailing-api.railway.internal` | none                                          | `main` 552062a, 2026-11-26 02:47 UTC |
| `@velasia/web`           | `velasiaweb.railway.internal`           | `velasiaweb-production.up.railway.app`        | `main` 552062a, 2026-11-26 02:46 UTC |
| `@velasia/web-nextrs`    | `velasiaweb-nextrs.railway.internal`    | `velasiaweb-nextrs-production.up.railway.app` | `main` 552062a, 2026-11-25 17:43 UTC |

Project `velasia-airways`, environment `production`, Trial plan, no buckets, **no volumes**.

Active deployments as verified before the PR #15 merge. That merge's autodeploy then rebuilt all three from `a66e74c` (03:59–04:01 UTC). The configuration did not change, and the baseline plan was still a no-op afterwards.

## Field by field

Classes: **P** correct production setting (now in IaC) · **O** outdated IaC assumption ·
**S** missing production safeguard · **I** intentional difference · **D** destructive if the
old file were applied.

| Setting                  | M9 IaC (before)                                 | Production (deployed)                                                                                          | Class               |
| ------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------- |
| Service names            | `velasia-api`, `velasia-node`, `velasia-nextrs` | `@velasia/retailing-api`, `@velasia/web`, `@velasia/web-nextrs`                                                | **D**, O            |
| Volume                   | `velasia-api-data`, 500 MB at `/data`           | none                                                                                                           | O, **S**            |
| Branch                   | `deploy/railway` (does not exist on the remote) | `main`                                                                                                         | O                   |
| GitHub autodeploy        | off (dashboard, by design)                      | **on**; `checkSuites: false` (deploys without waiting for CI)                                                  | **S**               |
| Watch patterns           | none                                            | API `/apps/retailing-api/**`, Node.js `/apps/web/**`, NextRS none                                              | **S**, I            |
| Region                   | `asia-southeast1-eqsg3a`                        | `iad`                                                                                                          | O                   |
| Replicas                 | 1 each                                          | 1 each                                                                                                         | P                   |
| CPU / memory             | `limitOverride` 1 vCPU/1 GiB (API 768 MiB)      | no override; plan default 2 vCPU / 1 GB each                                                                   | O, P                |
| Node.js build            | `Dockerfile.node`                               | `Dockerfile.node`, build command `""`, start `""`                                                              | P                   |
| NextRS build             | `Dockerfile.nextrs`                             | `Dockerfile.nextrs`                                                                                            | P                   |
| API build                | `docker/Dockerfile.api` (entrypoint guards)     | **Railpack**: `pnpm --filter @velasia/retailing-api build/start`                                               | O, **S**            |
| API process              | `node dist/server.mjs` as uid 1000              | `tsx src/server.ts` through pnpm                                                                               | O                   |
| Storefront health check  | `/api/internal/health/ready`, 120 s             | `/api/internal/health/ready`, 60 s                                                                             | P                   |
| API health check         | `/health/ready`                                 | **none**                                                                                                       | **S**               |
| Restart policy           | `ON_FAILURE` ×10 (declared)                     | `ON_FAILURE` ×10 (default)                                                                                     | P                   |
| Draining seconds         | `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15`        | unset (Railway default: SIGKILL at once)                                                                       | **S**               |
| `VELASIA_TODAY`          | `2026-12-01` on all three                       | **unset** (real clock)                                                                                         | O, I                |
| Service token            | shared `RETAILING_API_SERVICE_TOKEN`            | **not configured**                                                                                             | **S**               |
| Metrics token            | shared `METRICS_TOKEN`                          | **not configured**                                                                                             | **S**               |
| API `NODE_ENV`           | `production`                                    | unset (production config checks off)                                                                           | **S**               |
| `TALADB_REQUIRE_VOLUME`  | `enabled`, enforced by `docker/api/start.sh`    | `enabled` but **inert** (start.sh never runs under Railpack)                                                   | **S**               |
| `TALADB_PATH`            | `/data/velasia.db` on the volume                | `/data/velasia.db` on **ephemeral disk**                                                                       | **S**               |
| API private URL          | `velasia-api.railway.internal:4010` (reference) | `velasiaretailing-api.railway.internal:4010` (literal)                                                         | O, P                |
| `SITE_URL` storefronts   | `https://${{RAILWAY_PUBLIC_DOMAIN}}`            | literal `https://<own generated domain>`                                                                       | P                   |
| NextRS allowlist         | `fd12::/16` + empty IPv4                        | `fd12::/16,10.0.0.0/8` (dashboard, 2026-11-25)                                                                 | P, **S**            |
| `NEXTRS_ISOLATES`, grace | `1`, `10` (declared)                            | unset; image defaults are `1`, `10` (startup log confirms)                                                     | P                   |
| Stale API variables      | n/a                                             | `SITE_URL=http://localhost:8080`, `RETAILING_API_URL=127.0.0.1`, `VELASIA_HTTP_BIND/PORT`, `VELASIA_TAG=local` | I (cleanup pending) |
| Node.js-only variable    | n/a                                             | `RETAILING_API_START_TIMEOUT_MS=60000` (inert at runtime)                                                      | I                   |
| CDN                      | `cdn: { enabled: false }`                       | not set (off)                                                                                                  | P                   |

## Plan results

| File                                     | Plan (read-only)                                                                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M9 `railway.ts` (before)                 | **4 to add, 0 to change, 3 to destroy**: creates `velasia-api`, `velasia-api-data`, `velasia-node`, `velasia-nextrs`; **deletes all three live services** |
| Reconciled `railway.ts` (after)          | **No changes** ("Your Railway configuration is already up to date"), exit 0 with `--detailed-exit-code`                                                   |
| `.railway/proposals/nextrs-allowlist.ts` | 0 add, **1 change** (`variable.set @velasia/web-nextrs.NEXTRS_NET_ALLOW_ADDR`), 0 destroy                                                                 |

Sanitized gate output: [RAILWAY-IAC-RECONCILIATION.md](RAILWAY-IAC-RECONCILIATION.md#sanitized-plan-results).

## Private network observations

| When (UTC)                                        | API IPv4         | API IPv6                              | Source                  |
| ------------------------------------------------- | ---------------- | ------------------------------------- | ----------------------- |
| 2026-11-25 (before the 15:17 API redeploy)        | `10.228.244.185` | (not recorded)                        | NextRS startup log      |
| 2026-11-25 17:43                                  | `10.146.207.192` | `fd12:382f:2f26:1:a000:1f:5092:cfc0`  | NextRS startup log, DNS |
| 2026-11-26 03:01                                  | `10.236.48.211`  | `fd12:382f:2f26:1:3000:179:bb6c:30d3` | `railway logs --dns`    |
| 2026-11-26 04:01 (after the #15 merge autodeploy) | `10.137.93.22`   | `fd12:382f:2f26:1:3000:1b6:5a89:5d16` | `railway logs --dns`    |

Every IPv4 address changed /16 on an API redeploy; all are inside `10.128.0.0/9`. Every IPv6
address is inside `fd12:382f:2f26:1::/64`. Railway documents neither range. Both storefronts
were ready (`/api/internal/health/ready` 200) at 2026-11-26 03:0x UTC.

## Risks found

1. **Data loss on every API redeploy.** No volume, so TalaDB lives on ephemeral disk. The API
   was redeployed at 2026-11-26 02:47 UTC (after the first benchmark series) and again at 03:59 UTC (the autodeploy of this milestone's own merge, PR #15); each started
   from an empty database. A merge that touches `apps/retailing-api/` redeploys it again
   (autodeploy).
2. **Autodeploy from `main` without CI checks** (`checkSuites: false`), with different watch
   patterns: a change under `packages/` rebuilds NextRS but not Node.js, so the two storefronts can
   run different builds of the same app.
3. **The volume guard is inert** under Railpack, so attaching a volume at the wrong path would not
   be detected.
4. **No API health check or draining time:** a broken API deploy can go live, and in-flight
   requests are killed at once on redeploy.
5. **Unauthenticated private API and metrics:** anything on the project's private network can call
   them.
6. **Broad NextRS allowlist** (`10.0.0.0/8`).
