# Railway architecture and deployment-gap assessment (Milestone 9)

How the Milestone 8 dual-runtime setup maps onto Railway, what had to change, and what stays a
risk. Procedure: [railway.md](railway.md). Variables:
[railway-environment-variables.md](railway-environment-variables.md).

## Topology

```text
                        Railway edge (TLS, HTTP/1.1 + HTTP/2, X-Forwarded-Proto/Host, X-Real-IP)
                 https://<node>.up.railway.app            https://<nextrs>.up.railway.app
                               │                                     │
   ┌───────────────────────────▼───────────┐   ┌─────────────────────▼─────────────────────────┐
   │ velasia-node            :8080          │   │ velasia-nextrs          :8080                  │
   │ Dockerfile.node                        │   │ Dockerfile.nextrs                              │
   │ node apps/web/server.js (Next 16.4.6)  │   │ nextrs start (Rust + embedded V8, 1 isolate)   │
   │ uid 1000, 1 vCPU / 1 GiB, 1 replica    │   │ uid 10001, 1 vCPU / 1 GiB, 1 replica, no Node  │
   └───────────────────┬────────────────────┘   └───────────────────┬────────────────────────────┘
                       │  server-side only: route handlers, Server Actions, RSC/PPR rendering
                       │  x-velasia-service-token: ${{shared.RETAILING_API_SERVICE_TOKEN}}
                       └──────────────┐          ┌──────────────────┘   NextRS: --net-allow this origin only,
                                      ▼          ▼                      --net-allow-addr fd12::/16 + IPv4 range
              private network (WireGuard), http://velasia-api.railway.internal:4010, no public domain
                         ┌───────────────────────────────────────────────┐
                         │ velasia-api   :: 4010   docker/Dockerfile.api │
                         │ Fastify, 56 endpoints, service-token check    │
                         │ uid 1000 (entrypoint starts as root, drops)   │
                         │ 1 vCPU / 768 MiB, exactly 1 replica           │
                         │ TalaDB /data/velasia.db ── Railway volume     │
                         └───────────────────────────────────────────────┘
```

The browser only ever talks to a storefront: pages, `/api/*` route handlers and Server Actions.
CORS is not enabled anywhere, and the API is not reachable from the internet.

## Repository audit (Phase 1)

| Item                   | Found (main 850e892 = M8 merged, PR #10)                                                                                                                                                      | Railway implication                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Dockerfiles            | `Dockerfile.node` and `Dockerfile.nextrs` share a byte-identical build stage. `docker/Dockerfile.api`. All use the repository root as context and portable syntax (no `RUN --mount`)          | Usable as they are; Railway builds Dockerfiles from the repository root (`RAILWAY_DOCKERFILE_PATH`) |
| NextRS entrypoint      | `docker/nextrs/start.sh`: env → `nextrs start` flags; `--js-env` per variable; one `--net-allow` (the API origin); `--net-allow-addr` from `NEXTRS_NET_ALLOW_ADDR`                            | Needs Railway's private ranges, both address families                                               |
| NextRS version         | `@nextrs/cli@0.1.0-rc.1`. **rc.2 not on npm** (2026-11-21)                                                                                                                                    | rc.2 items blocked (see [railway.md](railway.md#nextrs-rc2-upgrade))                                |
| Storefront environment | `apps/web/src/lib/env.ts`, validated at startup                                                                                                                                               | Railway references fill `RETAILING_API_URL` and `SITE_URL`                                          |
| API startup / database | Config validated first. `openDatabase` creates the file if missing, applies migrations, refuses newer schemas, and locks the file. No fixtures in the database: inventory comes from the seed | Safe on a persistent volume: a redeploy re-opens, never re-seeds                                    |
| Build-time API helper  | `apps/web/scripts/with-retailing-api.mjs` starts a local API with a temporary TalaDB file and stops it afterwards (verified: no process left)                                                 | Kept. The build stage now pins it to 127.0.0.1 with no token                                        |
| TalaDB data directory  | `TALADB_PATH=/data/velasia.db`. `/data` is `node`-owned in the image, and `VOLUME ["/data"]` was declared                                                                                     | Railway mounts root-owned volumes; the `VOLUME` instruction is undocumented there                   |
| Service token          | Optional `RETAILING_API_SERVICE_TOKEN` (M8). Constant-time check; the health paths are exempt                                                                                                 | Kept, and made mandatory by configuration (shared variable) although the API is private             |
| Health endpoints       | Storefront `/api/internal/health/{live,ready}`; API `/health`, `/health/live`, `/health/ready`                                                                                                | `ready` is used for Railway's deploy check (it also proves the storefront → API path)               |
| Parity tests           | `tests/parity`: 96 runs in M8. 10 of the 14 route handlers covered; no range or deployment-ID check                                                                                           | Extended (all 14 handlers, ranges, deployment ID)                                                   |
| DigitalOcean configs   | `deploy/digitalocean/*.yaml` and `docs/deployment/digitalocean-app-platform.md`: public API + token, no volumes                                                                               | Kept as the archived alternative                                                                    |
| Internal routes        | nginx hid `/api/internal/*` in compose. The M8 App Platform design had no proxy either                                                                                                        | Public on Railway: `METRICS_TOKEN` is required; health shows status only                            |

### Gaps closed in Milestone 9

| Gap (DigitalOcean design → Railway)                          | Change                                                                                                                                                                                 |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The API had to be public (separate apps share no network)    | Private-only API on `velasia-api.railway.internal`. No domain or TCP proxy, `RETAILING_API_HOST=::`. The token stays as defence in depth                                               |
| Ephemeral TalaDB (no volumes on App Platform)                | Railway volume at `/data`. Entrypoint [`docker/api/start.sh`](../../docker/api/start.sh) for root-owned mounts, and `TALADB_REQUIRE_VOLUME` so the file is never on ephemeral storage  |
| Platform config in App Platform specs                        | [`.railway/railway.ts`](../../.railway/railway.ts) (IaC), checked offline by [`scripts/railway/check-iac.mjs`](../../scripts/railway/check-iac.mjs) (`pnpm railway:check`, also in CI) |
| NextRS allowlist assumed a public HTTPS API                  | Private-range allowlist with both families. The start script logs what the API resolves to and warns about addresses outside the ranges (NextRS does not log refusals)                 |
| Build could in principle inherit a deployed API URL or token | The build stage pins `RETAILING_API_URL=http://127.0.0.1:4010` and an empty token                                                                                                      |
| `SITE_URL` unknown before the domain exists                  | `SITE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}`, a two-stage bootstrap. The build fails explicitly on an empty or unresolved origin                                                      |
| Railway kills at SIGTERM + 0 s by default                    | `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15` on all three                                                                                                                                  |
| `VOLUME ["/data"]` (undocumented on Railway)                 | Removed. Every compose file mounts `/data` explicitly                                                                                                                                  |

## Private API networking

- **Name.** The storefronts use the Railway reference
  `http://${{velasia-api.RAILWAY_PRIVATE_DOMAIN}}:${{velasia-api.PORT}}`, which is
  `http://velasia-api.railway.internal:4010`. Nothing is hard-coded.
- **Transport.** It is plain HTTP inside Railway's WireGuard mesh, as Railway documents. No egress
  costs.
- **Listening.**
  - The API binds `::`. That is dual-stack on Linux, so it serves both the IPv4 and IPv6 records
    of new environments, and the IPv6-only legacy ones.
  - Docker's `HEALTHCHECK` (127.0.0.1) still works.
  - The compose default stays `0.0.0.0`, because a Docker network without IPv6 cannot bind `::`.
- **Authentication.** It is unchanged: a constant-time comparison of `x-velasia-service-token`,
  with 401 otherwise, except `/health`, `/health/live` and `/health/ready`.
  - Both storefronts and the API reference the same shared variable, so they cannot drift apart.
  - A wrong token shows up as 401s in the API log and as the smoke check `GET /api/airports` ≠ 200.
- **NextRS policy.**
  - Allowed hosts: exactly the API origin.
  - Allowed non-public addresses: `fd12::/16` plus the environment's IPv4 range.
  - Everything else is refused: other Railway services, `169.254.169.254`, the internet. That
    includes image optimisation of remote URLs, which the app doesn't use.
  - The resolver refuses an answer if any address is outside the ranges. That is why one family
    is not enough on a dual-stack network. It was demonstrated locally with an IPv6-only
    allowlist; see the validation report.
- **Node.js storefront.** It has no outbound policy, as with `next start` anywhere. The CSP keeps
  the browser first-party.

## TalaDB: persistence and single-writer safeguards

The safeguards are layered; any one of them is enough to stop a second writer:

1. **Platform.** Railway allows no replicas with a volume, one volume per service, and never two
   deployments mounted at once. That is also why API redeploys have a short downtime.
2. **Configuration.** `replicas: { region: 1 }`, no autoscaling (`pnpm railway:check` fails
   otherwise), no pre-deploy command, and no cron or worker service.
3. **Process.** The API is a single Node.js process with no cluster mode. The entrypoint `exec`s
   it as PID 1, under the existing `SHUTDOWN_TIMEOUT_MS` graceful close.
4. **TalaDB.** It holds an exclusive file lock. A second opener gets "Only one retailing API
   process may own it". Tools (`db-tool verify|backup|restore`, `db:reset`) take the same lock,
   so they refuse while the API runs.
5. **Build.** `next build` prerenders against a throwaway API on a temporary file. It never sees
   the volume, which does not exist at build time.

Persistence:

- The database file lives on the volume, and `TALADB_REQUIRE_VOLUME=enabled` refuses to start if
  `/data` is not a mount point.
- A first start on an empty volume creates the schema and logs it. Later starts open the existing
  file: they recover held orders and restore sessions.
- Nothing seeds, resets or deletes the database automatically.

Permissions:

- **Railway.** The volume is mounted root-owned, and `RAILWAY_RUN_UID=0` makes the container start
  as root. `start.sh` then:
  1. gives the TalaDB directory, and the regular files directly in it, to uid 1000. The `find` is
     non-recursive, stays on one filesystem and never follows symlinks;
  2. `exec`s `setpriv --reuid=1000 --regid=1000 --clear-groups --inh-caps=-all --no-new-privs`.

  Only the shell script ever runs as root. The API, its native addons and every request handler
  run as `node`. `--bounding-set` is left out because it needs CAP_SETPCAP; the uid change clears
  the effective and permitted capability sets anyway, and no_new_privs blocks regaining them.

- **Compose.** The image's `USER node` applies, and the root branch never runs. `cap_drop: ALL`
  is unchanged.
- **Why not run as root.** The documented alternative, running the whole API as root, was
  rejected on purpose.

## Build-time versus runtime

| Concern             | Build (Railway builder, no private network)                                   | Runtime                                                  |
| ------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| Retailing API       | Throwaway `127.0.0.1:4010`, temporary TalaDB file, stopped after `next build` | `velasia-api.railway.internal:4010`                      |
| Service token       | none (`RETAILING_API_SERVICE_TOKEN=` in the build stage; no `ARG`)            | shared variable, server-side only                        |
| Fixture determinism | `VELASIA_TODAY` build argument + the default seed `aeronova`                  | the same `VELASIA_TODAY` and `INVENTORY_SEED` on the API |
| `SITE_URL`          | build argument → sitemap, robots, metadata                                    | runtime variable → Secure cookies, absolute URLs         |
| Secrets in layers   | none: no secret `ARG` exists (checked), so `docker history` shows none        | environment only                                         |

## SITE_URL, build artifacts and comparability

On Railway each storefront builds separately, unlike the local BuildKit build that shares one
`next build`. Each bakes its own `SITE_URL`. What differs between two such builds was measured
locally; see [railway-validation-report.md](railway-validation-report.md#5-site_url-and-build-artifacts).
The binary outputs are **not** claimed to be byte-identical.

For the comparison what must match is:

- the source revision (one branch);
- the build configuration (same build arguments other than `SITE_URL`);
- the deployment-ID policy (unset on both while NextRS is rc.1);
- the fixture data (same seed and `VELASIA_TODAY`).

## Railway-specific risks

| Risk                                                                                                            | Mitigation / status                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[SDK]` keys (Dockerfile builder/path, limits, restart policy, sleep) may not be honoured by the CLI engine     | Dockerfile path also set via the documented variable. Verify the rest in the first `config plan`; fall back to the dashboard                                          |
| Private IPv4 range undocumented                                                                                 | Read from the environment (fib_trie / the NextRS startup log). Redeploy-the-API test during smoke                                                                     |
| Region ID form: the IaC docs show `europe-west4`, the regions page `europe-west4-drams3a`                       | Full ID used (`asia-southeast1-eqsg3a`); confirm in the first plan                                                                                                    |
| Edge compression: the CDN page says the edge compresses uncompressed responses (scope unclear with the CDN off) | NextRS rc.1 sends identity and Node gzips, so the edge may re-encode one side. Measure `content-encoding` at the edge before benchmarking. rc.2 removes the asymmetry |
| Whole-project IaC apply deletes unlisted resources                                                              | Dedicated project; plan review; never apply to a shared environment                                                                                                   |
| API redeploy downtime (volume)                                                                                  | Documented; deploy the API outside benchmark windows                                                                                                                  |
| Trial: 1 GB RAM per service, 10 restarts, 24 h image retention, volume deleted 30 days after the trial          | Limits chosen within the Trial plan; back up before a trial ends                                                                                                      |
| `/api/internal/*` reachable publicly                                                                            | `METRICS_TOKEN` required; health routes reveal status only                                                                                                            |
| No `X-Forwarded-For` documented (`X-Real-IP` is), proxy IP ranges unknown                                       | No trusted-proxy list: forwarded headers pass through as with `next start`, on both runtimes                                                                          |
| Deleting a service may or may not delete its volume (undocumented)                                              | Teardown order in [railway.md](railway.md#stopping-and-deleting-trial-resources)                                                                                      |
| `railway link` state may be written to `.railway/`                                                              | `.gitignore` admits only the three IaC files                                                                                                                          |
