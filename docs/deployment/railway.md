# Deploying to Railway

Railway is the active cloud target (Milestone 9). The DigitalOcean App Platform guide is kept
as an [archived alternative](digitalocean-app-platform.md).

The deployment is one Railway project, `velasia-airways`, with three services. All three build
from this repository's production Dockerfiles, with the repository root as the build context.

| Service          | Runtime                                   | Dockerfile              | Network                         | Port | Deploy health check          |
| ---------------- | ----------------------------------------- | ----------------------- | ------------------------------- | ---- | ---------------------------- |
| `velasia-node`   | Official Next.js server (Node.js 24.18.0) | `Dockerfile.node`       | Public (generated HTTPS domain) | 8080 | `/api/internal/health/ready` |
| `velasia-nextrs` | NextRS, embedded V8, no Node.js           | `Dockerfile.nextrs`     | Public (generated HTTPS domain) | 8080 | `/api/internal/health/ready` |
| `velasia-api`    | Fastify retailing API + TalaDB            | `docker/Dockerfile.api` | Private network only, volume    | 4010 | `/health/ready`              |

The configuration lives in code:

- [`.railway/railway.ts`](../../.railway/railway.ts): Railway Infrastructure as Code.
- Variables: [railway-environment-variables.md](railway-environment-variables.md).
- Design and risks: [railway-architecture.md](railway-architecture.md).
- What was validated locally: [railway-validation-report.md](railway-validation-report.md).
- Cloud benchmark preparation: [railway-benchmark-readiness.md](railway-benchmark-readiness.md).

> **Status: prepared, not deployed.** No Railway account was used. No project, service, volume
> or domain exists, and `railway config plan` / `apply` have never run. Platform facts come from
> docs.railway.com, read on 2026-11-21.
>
> **Open blocker:** `@nextrs/cli@0.1.0-rc.2` is not on npm yet.
>
> - `Dockerfile.nextrs` still pins rc.1.
> - Gzip, static byte ranges and `VELASIA_DEPLOYMENT_ID` need rc.2 ([upgrade steps](#nextrs-rc2-upgrade)).
>
> Velasia Airways is fictional: no reservations, tickets or payments are real.

## Contents

1. [Before you start](#before-you-start)
2. [Infrastructure as Code](#infrastructure-as-code)
3. [Deployment procedure](#deployment-procedure), including the two-stage `SITE_URL` bootstrap
4. [Private networking and the NextRS allowlist](#private-networking-and-the-nextrs-allowlist)
5. [TalaDB on a Railway volume](#taladb-on-a-railway-volume)
6. [Health checks, ports and shutdown](#health-checks-ports-and-shutdown)
7. [Common startup errors](#common-startup-errors)
8. [Restart, redeploy and rollback](#restart-redeploy-and-rollback)
9. [Avoiding data loss](#avoiding-data-loss)
10. [Stopping and deleting trial resources](#stopping-and-deleting-trial-resources)
11. [NextRS rc.2 upgrade](#nextrs-rc2-upgrade)

## Before you start

**Account and plan.** The deployment fits the Trial plan's per-service limits: 1 GB RAM, 2 vCPU,
5 services per project, 3 volumes of 0.5 GB, and at most 10 restarts on failure. Check the plan
you actually have; the limits that matter are below. Railway's documented prices: RAM $10/GB/month,
CPU $20/vCPU/month, volume storage $0.15/GB/month; builds are free. Billing follows usage, not the
limits.

| Need                                | Free plan                                           | Trial                        | Hobby / Pro  |
| ----------------------------------- | --------------------------------------------------- | ---------------------------- | ------------ |
| Three services                      | yes (3 max)                                         | yes (5 max)                  | yes          |
| 1 GiB storefront memory limit       | **no** (0.5 GB per service)                         | yes (1 GB max)               | yes          |
| Always-on (no serverless sleep)     | **no** ("Services on the Free plan run serverless") | yes                          | yes          |
| Region choice (one region for all)  | **no** ("Railway picks the region")                 | yes                          | yes          |
| 500 MB volume for TalaDB            | 0.5 GB                                              | 0.5 GB                       | 5 GB / 50 GB |
| Restart policy `ON_FAILURE`, 10 max | yes                                                 | yes (`Always` needs paid)    | yes          |
| Rollback image retention            | 24 h                                                | 24 h                         | 72 h / 120 h |
| Volume kept after the plan ends     | 30 days                                             | 30 days after credits expire | n/a          |

The **Free plan cannot run this comparison**: it forces serverless sleep, a 0.5 GB memory cap and
platform-chosen regions. Use Trial or a paid plan.

**GitHub.** Railway's GitHub app needs read access to `nextrs-sh/velasia-airways`.

**Tooling** (local, no account needed until `railway login`):

```bash
pnpm install                   # includes the IaC SDK, railway@3.17.0 (exact pin)
pnpm railway:check             # typecheck + offline checks of .railway/railway.ts
railway --version              # Railway CLI >= 5.63.0; validated with 5.75.0
```

The CLI was validated with 5.75.0, installed from the GitHub release
`railway-v5.75.0-x86_64-unknown-linux-musl.tar.gz`, sha256
`ba5d9fb5dce1c59789f4216e6b754becd75025ed740388452be55aae83720400`. The npm package
`@railway/cli` downloads the same file in a postinstall script.

**Secrets**, generated on your machine and never committed:

```bash
openssl rand -hex 32   # RETAILING_API_SERVICE_TOKEN (32+ characters)
openssl rand -hex 24   # METRICS_TOKEN (16+ characters)
```

## Infrastructure as Code

Railway's current IaC system is `.railway/railway.ts` with the `railway/iac` SDK. The CLI
evaluates the file and compares it with the linked environment.

The legacy Config as Code files (`railway.json` / `railway.toml`) are deprecated. New services
cannot use them, and Railway stops reading them on 2026-12-01. This repository has none, and
`pnpm railway:check` fails if one appears.

| Command                      | Changes Railway? | Use                                                                                       |
| ---------------------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| `pnpm railway:check`         | no (offline)     | Typecheck, then evaluate the file as the CLI does and check this deployment's invariants  |
| `railway config plan`        | no (read-only)   | Diff against the linked environment. Needs `railway login` + a linked project             |
| `railway config pull --json` | no (local)       | Import the live configuration, e.g. to confirm the field names of dashboard-made settings |
| `railway config apply`       | **yes**          | Owner only, after reviewing a plan. Never with `--yes`/`--json` unattended                |

> **Whole-project mode deletes what it does not list.** In whole-project mode "omitting a resource
> means deleting it". Never apply a file to an environment that holds services or volumes this
> file does not describe.

### IaC coverage

The services are described with the documented IaC fields where they exist. A few settings
exist only in the SDK's TypeScript types (`railway@3.17.0`, marked `[SDK]` in the file). Some
settings have no IaC form at all.

| Setting                                                | How it is set                                                                                                                      | Verified by                                      |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Repository + branch, all three                         | IaC `source: github(REPO, { branch: DEPLOY_BRANCH })`                                                                              | `pnpm railway:check`                             |
| Dockerfile per service, repo-root context              | IaC `build.dockerfilePath` [SDK] **and** the documented service variable `RAILWAY_DOCKERFILE_PATH` (same value); no root directory | check; confirm in the first plan                 |
| One replica each, one region                           | IaC `replicas: { "asia-southeast1-eqsg3a": 1 }`                                                                                    | check; plan (the IaC docs show short region IDs) |
| CPU / memory limits                                    | IaC `deploy.limitOverride` [SDK]: storefronts 1 vCPU / 1 GiB, API 1 vCPU / 768 MiB. Dashboard: Settings → Deploy → Replica Limits  | plan, then the dashboard (units undocumented)    |
| Restart policy `ON_FAILURE` ×10, serverless off        | IaC `deploy` [SDK]; dashboard Settings → Deploy                                                                                    | plan                                             |
| Health check path and timeout                          | IaC `healthcheck`, `healthcheckTimeout`                                                                                            | check; plan                                      |
| Draining seconds (SIGTERM → SIGKILL)                   | Service variable `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15` (the default is 0)                                                       | check                                            |
| Volume (500 MB, mounted at `/data` on the API)         | IaC `volume()` + `volumeMounts`                                                                                                    | check; plan                                      |
| Non-root volume access                                 | Service variable `RAILWAY_RUN_UID=0` + the image's entrypoint                                                                      | local emulation                                  |
| Variables, references                                  | IaC `env`                                                                                                                          | check; plan                                      |
| Secrets `RETAILING_API_SERVICE_TOKEN`, `METRICS_TOKEN` | **Dashboard**: project shared variables; IaC only references them (`ctx.shared`)                                                   | plan shows `«hidden»`                            |
| Railway-generated domains (storefronts, port 8080)     | **Dashboard** Networking → Generate Domain, or `railway domain`: "not included in `.railway/railway.ts`"                           | manual                                           |
| No domain / TCP proxy for the API                      | Nothing is created; check that the dashboard shows none                                                                            | check; manual                                    |
| GitHub autodeploy off                                  | **Dashboard**, per service: Settings → Source → Disable. No IaC field                                                              | manual                                           |
| Volume backups, usage limit, sealing                   | **Dashboard** (usage limit also `railway usage limit`)                                                                             | manual                                           |

If the first plan shows that the CLI ignores or rejects an `[SDK]` key, delete the key from
`railway.ts` and set it in the dashboard instead. Note that change in this table.

## Deployment procedure

Do this only with the owner's authorization: every numbered step after 1 creates or changes
Railway resources. The order matters. The API comes first, the storefronts need their
generated domains before their first real build, and NextRS needs the private IPv4 range.

### 1. Choose the source revision

All three services deploy from one branch, `deploy/railway`. Point it at the commit under test:

```bash
git push origin <commit>:refs/heads/deploy/railway      # fast-forward only; owner action
```

Merges into `main` deploy nothing. Both storefronts always build the same revision.

### 2. Create and link the project; add the shared secrets

1. Create an empty project named `velasia-airways` (dashboard → New Project → Empty Project).
2. Link it locally: `railway login`, then `railway link` and pick `velasia-airways` / `production`.
   The link state stays local; `.gitignore` keeps it out of git.
3. Project Settings → **Shared Variables** (production environment):
   - add `RETAILING_API_SERVICE_TOKEN` and `METRICS_TOKEN` with the values generated above;
   - seal them if your plan offers it.

   A variable reaches a Docker build only through an `ARG` of the same name. No Dockerfile
   declares one for these names, and `pnpm railway:check` enforces that.

### 3. Plan, review, apply

```bash
pnpm railway:check
railway config plan --verbose
```

Review the plan before applying. It should create three services and one volume, and delete
nothing. Variable values show as `«hidden»`. Check that the `[SDK]` keys appear as intended (see
[IaC coverage](#iac-coverage)). Then the owner applies interactively:

```bash
railway config apply           # asks for confirmation; never --yes / --json here
```

Right after the apply, **disable GitHub autodeploy on all three services** (Settings → Source).

Railway may start a first deployment of each service at once:

- **API**: this one is wanted; it creates the empty database on the volume.
- **Storefronts**: their first builds are expected to fail at the `SITE_URL` check ("generate the
  service domain before the first build"), because no domain exists yet. The reference then
  resolves to an empty host, or stays an unresolved `${{…}}`, and the check rejects both. Builds
  are free, and nothing broken is ever served. This has not been observed on Railway yet.

### 4. Validate the API on the private network

Wait for `velasia-api` to be **Active**, i.e. its `/health/ready` deploy health check passed.
Its log shows the following lines:

```text
database directory /data given to uid 1000 (volume mounted root-owned)    # first start only
no database at /data/velasia.db yet: the API creates an empty one         # first start only
"msg":"orders database ready" … "serviceToken":"required","production":true
```

Then confirm there is no domain and no TCP proxy under velasia-api → Settings → Networking.

### 5. Find the private IPv4 range (NextRS allowlist)

See [Private IPv4 range](#private-ipv4-range). Put the range in `RAILWAY_PRIVATE_IPV4` in
`.railway/railway.ts`, commit it to `deploy/railway`, then run `pnpm railway:check` and
`railway config plan`. The owner applies.

### 6. Generate the storefront domains (two-stage `SITE_URL` bootstrap, part 1)

```bash
railway domain --service velasia-node --port 8080
railway domain --service velasia-nextrs --port 8080
```

(Or use the dashboard: Settings → Networking → Generate Domain, target port 8080.)

Each storefront's `SITE_URL` is `https://${{RAILWAY_PUBLIC_DOMAIN}}`, its own domain, so nothing
is hard-coded. Confirm that the references now resolve. Neither variable is a secret:

```bash
railway variable list --service velasia-node --kv | grep -E '^(SITE_URL|RETAILING_API_URL)='
railway variable list --service velasia-nextrs --kv | grep -E '^(SITE_URL|RETAILING_API_URL)='
# SITE_URL=https://<generated>.up.railway.app
# RETAILING_API_URL=http://velasia-api.railway.internal:4010
```

### 7. Build and deploy both storefronts (part 2)

Deploy both from the same commit: dashboard → service → Deployments → **Deploy Latest Commit**,
once for velasia-node and once for velasia-nextrs. Each build:

- bakes `SITE_URL` into the sitemap, robots and metadata. It logs `SITE_URL baked into this
build: https://…`;
- prerenders from its own throwaway API on 127.0.0.1 with a temporary TalaDB file. The build never
  touches `velasia-api.railway.internal`, which does not exist during builds;
- receives no secret.

Each deployment becomes Active only when `/api/internal/health/ready` answers 200. That means the
server is up **and** reached the API (for NextRS, through its network policy).

### 8. Verify (smoke checks before any browser test)

```bash
for app in https://<node-domain> https://<nextrs-domain>; do
  curl -fsS "$app/api/internal/health/ready"; echo          # {"status":"ok",…,"retailingApi":"ready"}
  curl -fsS -o /dev/null -w '%{http_code} /api/airports\n' "$app/api/airports"   # 200: token accepted by the API
  curl -fsS "$app/sitemap.xml" | grep -o '<loc>[^<]*' | head -2              # canonical origin = own domain
  curl -fsSI "$app/booking/travelers" | grep -i '^location'                    # 308 → /booking/travellers
  curl -s -o /dev/null -w '%{http_code} metrics without token\n' "$app/api/internal/metrics"   # 401
done
```

Then the parity suite, run against the two domains from a machine outside Railway:

```bash
PARITY_NODE_URL=https://<node-domain> PARITY_NEXTRS_URL=https://<nextrs-domain> \
PARITY_TODAY=2026-12-01 PARITY_METRICS_TOKEN=<METRICS_TOKEN> pnpm test:parity
```

Demo registration is off in production. The account test runs only with `PARITY_ACCOUNTS=enabled`
after temporarily setting `ACCOUNT_REGISTRATION=enabled` on the API.

Keep benchmark traffic off until this passes; see
[railway-benchmark-readiness.md](railway-benchmark-readiness.md).

## Private networking and the NextRS allowlist

- Both storefronts reach the API at
  `RETAILING_API_URL=http://${{velasia-api.RAILWAY_PRIVATE_DOMAIN}}:${{velasia-api.PORT}}`, which
  resolves to `http://velasia-api.railway.internal:4010`.
  - Railway encrypts private traffic itself (WireGuard), so `http://` is correct.
  - Renaming the service changes the hostname.
- The API listens on `::` (`RETAILING_API_HOST`). That covers IPv6-only legacy environments as
  well as dual-stack ones (projects created after 2025-10-16 are dual-stack).
- Private networking exists only at runtime: "Build scripts cannot reach other services over the
  private network". The storefront builds therefore always use their own throwaway API.

**How NextRS checks a destination.** NextRS allows outbound `fetch` only to:

1. the origin of `RETAILING_API_URL` (`--net-allow http://velasia-api.railway.internal:4010`),
   checked before any lookup. No other host or port is allowed: no CDN, no metadata service, no
   other Railway service.
2. resolved addresses that are public, or inside a `--net-allow-addr` range. The resolver that
   checks is the one the HTTP client connects with, so DNS rebinding is covered. **If any address
   in the answer is outside the ranges, the whole lookup is refused.** A dual-stack name has an A
   and an AAAA record, so both families must be listed.

`NEXTRS_NET_ALLOW_ADDR` is therefore:

- `fd12::/16`: Railway's documented private IPv6 range, used by every environment;
- **plus the environment's private IPv4 range**, which Railway does not document.

Nothing broader is allowed. `pnpm railway:check` rejects ranges wider than /16, including
`10.0.0.0/8`.

### Private IPv4 range

Read it from the running environment once the API is up (step 5):

```bash
railway ssh --service velasia-api                 # a shell in the API container
node -e 'for (const [n, a] of Object.entries(require("os").networkInterfaces())) for (const i of a) if (!i.internal) console.log(n, i.family, i.cidr)'
# eth0 IPv4 <a.b.c.d>/<prefix>    <- the private IPv4 subnet: its network address/prefix goes into RAILWAY_PRIVATE_IPV4
# eth0 IPv6 fd12:…/<prefix>       <- inside fd12::/16 (a narrower prefix may be used instead)
# Fallback without Node.js (IPv4 subnets the container is attached to):
awk '/\|-- /{ip=$2} /link UNICAST/{print ip $1}' /proc/net/fib_trie | sort -u
exit
```

Both commands were checked on the local Railway-like stack: they printed `172.30.48.2/24` and
`172.30.48.0/24` (see the validation report). Railway's real ranges are only known after
the API runs there.

You can also see the answer the storefront gets. The NextRS container logs it at startup, before
any request:

```text
{"msg":"retailing API host","host":"velasia-api.railway.internal","addresses":"10.x.y.z fd12:…","allowAddr":"fd12::/16"}
```

Use the **subnet**, not the single address: the API's address can change when
it is redeployed. During the smoke phase:

1. redeploy the API once;
2. confirm that velasia-nextrs `/api/internal/health/ready` is still 200;
3. if it is not, the range was too narrow.

**What a missing range looks like.**

- `/api/internal/health/ready` answers 503 with `"retailingApi":"unreachable"`.
- The deployment does not become Active.
- NextRS itself logs nothing about the refusal, even with `RUST_LOG=debug` (checked locally); the
  application only sees a failed fetch. The image's start script therefore compares the startup
  lookup with the ranges and logs a warning naming every uncovered address:
  ```text
  {"level":"warn","msg":"retailing API addresses outside NEXTRS_NET_ALLOW_ADDR: NextRS refuses the API unless they are public","outside":"10.x.y.z","allowAddr":"fd12::/16"}
  ```

The failure is explicit: there is no fallback to Node.js and no allow-all.

## TalaDB on a Railway volume

| Fact (Railway docs)                                                                        | What this deployment does                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Volumes are mounted as the `root` user"; for non-root images "set `RAILWAY_RUN_UID=0`"    | `RAILWAY_RUN_UID=0` on the API only. Its entrypoint ([`docker/api/start.sh`](../../docker/api/start.sh)) runs as root just long enough to give `/data` (and top-level database files) to uid 1000, then `setpriv` drops to uid/gid 1000 with no groups, no capabilities and no_new_privs. The API process never runs as root; the storefronts are untouched (uid 1000 / 10001). |
| Volumes are mounted at start, "not during build time" nor pre-deploy                       | Nothing is initialised at build time and there is no pre-deploy command. The API creates an empty database on first start (flight inventory is computed from the seed, not stored).                                                                                                                                                                                             |
| "Replicas cannot be used with volumes"; one volume per service; no two deployments mounted | One replica (IaC). TalaDB's own file lock refuses a second opener, and no cluster mode exists.                                                                                                                                                                                                                                                                                  |
| Ephemeral filesystem otherwise                                                             | `TALADB_PATH=/data/velasia.db` and `TALADB_REQUIRE_VOLUME=enabled`: the API refuses to start if `/data` is not a mount point.                                                                                                                                                                                                                                                   |
| "a small amount of downtime when re-deploying a service that has a volume attached"        | Expected, and only on API redeploys. The old API stops, then the new one opens the file. Meanwhile the storefronts answer "temporarily unavailable" for booking data, and prerendered pages keep working.                                                                                                                                                                       |

A redeploy never resets data. The API opens the existing file, records its schema version, and
refuses a file written by a newer, incompatible build. Nothing seeds orders, and nothing deletes
or overwrites the database automatically.

### Resetting fixtures for an isolated benchmark (manual, non-destructive)

Bookings consume seats, so later runs see different inventory. For a clean, repeatable run, point
the API at a **new file** on the same volume instead of deleting anything:

1. In `.railway/railway.ts`, set `TALADB_PATH` to `/data/bench-<yyyymmdd>-<n>.db`, then plan and
   apply. Or set the variable in the dashboard for a one-off run.
2. The API redeploys: there is a short downtime, and it starts on an empty database.
3. Earlier files stay on the volume, untouched.
4. Switch back the same way.

The volume is 500 MB: list the files from an `railway ssh` shell (`ls -la /data`). Delete an old
run's file only on purpose, with the API pointed elsewhere. Wiping the whole volume (dashboard)
also deletes its backups.

## Health checks, ports and shutdown

| Service        | `PORT` | Health check (deploy-time only)                                                     | Timeout             | SIGTERM handling                                                                                       | Draining |
| -------------- | ------ | ----------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------ | -------- |
| velasia-api    | 4010   | `/health/ready`: TalaDB open, migrations verified, recovery done, not shutting down | 120 s (default 300) | Readiness fails, in-flight requests finish, writes flush, TalaDB closes; ≤10 s (`SHUTDOWN_TIMEOUT_MS`) | 15 s     |
| velasia-node   | 8080   | `/api/internal/health/ready`: server up and API ready                               | 120 s               | Next.js stops accepting, finishes in-flight requests                                                   | 15 s     |
| velasia-nextrs | 8080   | `/api/internal/health/ready`: same route, through NextRS's network policy           | 120 s               | NextRS stops accepting; in-flight requests get `NEXTRS_SHUTDOWN_GRACE=10` s                            | 15 s     |

- **Deploy-time only.** Railway "does not monitor the healthcheck endpoint after the deployment
  has gone live". The health check gates readiness during a deploy; it is not uptime monitoring.
- **Requests.** The probes come from the hostname `healthcheck.railway.app` and send no cookies or
  credentials. Neither server checks `Host`. The API's health paths are exempt from the service
  token.
- **Responses.** They contain status words only: no versions of dependencies, no addresses, no
  data.
- **Ports.**
  - Railway's checks use `PORT`, so the API sets `PORT=4010` (equal to `RETAILING_API_PORT`).
  - The storefronts listen on `0.0.0.0:$PORT`.
  - Each generated domain targets port 8080.
- **Draining.** Railway's draining default is 0 s, which would SIGKILL right after SIGTERM.
  `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15` gives every process its full graceful shutdown.
- **Overlap.** It stays at the default of 0.
- **Restart policy.** `ON_FAILURE`, with at most 10 restarts.

## Common startup errors

Every failure is one JSON log line naming variables, never values.

| Log line / symptom                                                                           | Cause and fix                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build: `SITE_URL must be an absolute http(s) origin with a host …`                           | No generated domain yet (`${{RAILWAY_PUBLIC_DOMAIN}}` is empty). Do step 6, then deploy again                                                                                                                        |
| API: `TALADB_REQUIRE_VOLUME=enabled but /data is not a mounted volume`                       | The volume is not attached at `/data`. Attach it; never remove the guard                                                                                                                                             |
| API: `The database directory /data is not writable by uid 1000 …`                            | `RAILWAY_RUN_UID=0` is missing on velasia-api                                                                                                                                                                        |
| API: `… is in use by another process. Only one retailing API process may own it.`            | A second process holds the TalaDB lock. Should be impossible on Railway; check for replicas or a stray `railway ssh` tool run                                                                                        |
| API: `This database was written by a newer build …`                                          | Rolled back across an incompatible schema. Deploy the newer build, or restore a backup taken before the upgrade                                                                                                      |
| API: `Invalid environment: RETAILING_API_SERVICE_TOKEN (…)`                                  | Token shorter than 32 characters, or the shared variable is missing                                                                                                                                                  |
| Storefront: `Invalid storefront environment: RETAILING_API_URL …` / `SITE_URL …`             | A reference did not resolve (renamed service, missing domain)                                                                                                                                                        |
| Storefront health check fails, `/api/internal/health/ready` → `"retailingApi":"unreachable"` | The API is down or redeploying (deploy the API first). For NextRS only: the private IPv4 range is missing from `NEXTRS_NET_ALLOW_ADDR`; the start script's `outside NEXTRS_NET_ALLOW_ADDR` warning names the address |
| Pages work, but every booking call fails with 401 in the API log                             | The storefront and the API have different tokens. Both must reference the shared variable                                                                                                                            |
| NextRS: `RETAILING_API_URL must be set.`                                                     | The variable is missing on velasia-nextrs                                                                                                                                                                            |

## Restart, redeploy and rollback

- **Restart** (same image, same variables): dashboard → deployment → Restart.
  - Storefronts restart without data effects.
  - An API restart has the volume's short downtime.
- **Redeploy a new revision**: move `deploy/railway`, then use **Deploy Latest Commit** on each
  service that should change.
  - For a comparison, always deploy **both** storefronts from the same commit.
  - Deploy the API first when its contract changed.
- **Rollback**: dashboard → Deployments → a previous deployment → Rollback, which restores "both
  the Docker image and custom variables".
  - Image retention limits how far back you can go: 24 h on Trial.
  - Rolling the API back across a schema change is refused by the API itself, and the data is
    untouched. Restore a volume backup from before the upgrade instead (paid plans: Backups tab).
- **Configuration changes** go through `.railway/railway.ts`: edit, `pnpm railway:check`,
  `railway config plan`, then the owner applies.

## Avoiding data loss

- **Never apply `railway.ts` to an environment with resources it does not describe.** In
  whole-project mode, omitted resources are deleted.
- **Shrinking `sizeMB`, detaching the volume or changing its region are destructive** in IaC,
  and Railway asks for `--confirm-destructive`. Don't.
- **Don't delete `velasia-api` while it holds the volume.** Railway does not document whether
  deleting a service deletes its volume. Back up first (paid plans), or detach the volume first.
- **Trial volumes are deleted 30 days after the trial's credits expire.** A deleted volume can be
  restored within 48 hours from the e-mailed link.
- **Wiping a volume also deletes its backups.**
- **The database contains passenger names and demo account data.** Never copy it out to a public
  place.

## Stopping and deleting trial resources

Least to most destructive:

1. **Stop usage, keep everything**:
   ```bash
   railway down --service velasia-nextrs -y
   railway down --service velasia-node -y
   railway down --service velasia-api -y
   ```
   Each command removes the service's latest deployment ("The service itself is not deleted").
   The volume and its data stay. Deploy again later from the dashboard.
2. **Cap spend**: set a workspace usage limit (minimum hard limit $10). Reaching it takes every
   workload offline.
3. **Delete the storefronts**: they hold no data. Delete velasia-nextrs and velasia-node in the
   dashboard. Remove them from `railway.ts` first, or a later apply recreates them.
4. **Delete the API and its data**, only deliberately and after any backup you want:
   - detach or delete the volume (`railway volume list` shows it);
   - then delete the service;
   - or delete the whole project (dashboard → Project Settings → Danger).
5. Remove the GitHub app's access if no other project needs it. Remove the `deploy/railway`
   branch if it is no longer needed.

## NextRS rc.2 upgrade

`@nextrs/cli@0.1.0-rc.2` was checked on 2026-11-21 and is not published yet:

- npm `dist-tags` still show `0.1.0-rc.1`;
- the registry has no `0.1.0-rc.2` version, and its tarball URL returns 404;
- the GitHub repository has no `v0.1.0-rc.2` tag or release, although the "prepare v0.1.0-rc.2" PR
  is merged.

Following the milestone brief, neither rc.1 nor a locally built binary was presented as rc.2.
The images stay on rc.1 until rc.2 is officially published. Then, in one commit:

1. **Verify the release**: `npm view @nextrs/cli@0.1.0-rc.2 version dist.integrity`, the GitHub
   release and tag, and the package's `BUILD-INFO.json` sha256.
2. **Update the pin.** In `docker/nextrs/`, set `"@nextrs/cli": "0.1.0-rc.2"` in `package.json`,
   then run `npm install --package-lock-only --ignore-scripts`. This updates the lockfile with the
   integrity value.
3. **Update `Dockerfile.nextrs`**:
   - the expected version: `0.1.0-rc.2` in the version check, `--version`, and the labels;
   - the binary sha256 label, from the new `BUILD-INFO.json`;
   - **delete the rc.1-only `onMatchHeaders` refusal** in the `nextrs-inspect` stage, so that
     `VELASIA_DEPLOYMENT_ID` builds are allowed.
4. **Remove the rc.1 restriction comments** in `Dockerfile.node` and `compose.dual-runtime.yaml`.
5. **Remove the two rc.1 expected-failure markers** in `tests/parity/compare.spec.ts`
   (compression, byte ranges), and only those. Then run the suite. It must pass without them,
   with a deployment ID set:
   ```bash
   VELASIA_DEPLOYMENT_ID=$(git rev-parse --short=12 HEAD) docker compose … up --build
   PARITY_DEPLOYMENT_ID=… pnpm test:parity
   ```
6. **On Railway**, set `VELASIA_DEPLOYMENT_ID` identically on both storefronts. For example, set
   it to the commit of `deploy/railway`, as a literal in `railway.ts` updated with each deploy. It
   is a build argument.

Gzip, the bounded compression cache, static ranges and the deployment ID then need no further
flags:

- gzip is on by default (`next.config` `compress`);
- the compression cache is `--compression-cache`, 32 MiB by default;
- static byte ranges and the deployment ID are built in.

## References

- [Infrastructure as Code](https://docs.railway.com/infrastructure-as-code), [IaC reference](https://docs.railway.com/infrastructure-as-code/reference), [CLI `config`](https://docs.railway.com/cli/config)
- [Dockerfiles](https://docs.railway.com/builds/dockerfiles), [build-time vs runtime secrets](https://docs.railway.com/guides/build-time-vs-runtime-secrets)
- [Private networking](https://docs.railway.com/networking/private-networking), [how it works](https://docs.railway.com/networking/private-networking/how-it-works)
- [Volumes](https://docs.railway.com/volumes), [volume reference](https://docs.railway.com/volumes/reference), [backups](https://docs.railway.com/volumes/backups)
- [Health checks](https://docs.railway.com/deployments/healthchecks), [deployment teardown](https://docs.railway.com/deployments/deployment-teardown), [restart policy](https://docs.railway.com/deployments/restart-policy)
- [Domains](https://docs.railway.com/networking/domains/working-with-domains), [public networking limits](https://docs.railway.com/networking/public-networking/specs-and-limits)
- [Plans](https://docs.railway.com/pricing/plans), [regions](https://docs.railway.com/deployments/regions)
