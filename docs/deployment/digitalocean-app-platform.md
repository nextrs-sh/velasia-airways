# Deploying to DigitalOcean App Platform

> **Archived alternative (Milestone 9).** The active cloud target is now Railway:
> [railway.md](railway.md). This guide and [`deploy/digitalocean/`](../../deploy/digitalocean/)
> are kept for reference. They describe the Milestone 8 design: a public API with a service
> token, and an ephemeral TalaDB. Neither has been updated for Milestone 9.

This guide covers three independent App Platform apps built from this repository:

| App              | What it runs                                  | Dockerfile              | Build context         | HTTP port | Health check                                           |
| ---------------- | --------------------------------------------- | ----------------------- | --------------------- | --------- | ------------------------------------------------------ |
| `velasia-api`    | Retailing API (Fastify + TalaDB), shared      | `docker/Dockerfile.api` | `/` (repository root) | 4010      | `/health/ready` (readiness), `/health/live` (liveness) |
| `velasia-node`   | Storefront on the official Next.js server     | `Dockerfile.node`       | `/`                   | 8080      | `/api/internal/health/live`                            |
| `velasia-nextrs` | Storefront on NextRS `@nextrs/cli@0.1.0-rc.1` | `Dockerfile.nextrs`     | `/`                   | 8080      | `/api/internal/health/live`                            |

Ready-to-edit specs: [`deploy/digitalocean/`](../../deploy/digitalocean/).

- `velasia-api.yaml`
- `velasia-node.yaml`
- `velasia-nextrs.yaml`

**Status.** Prepared only. Nothing has been deployed, and none of these specs has been
submitted to DigitalOcean.

- `doctl apps spec validate` needs an authenticated account and was not run.
- Platform facts below come from DigitalOcean's documentation as of 2026-11-20. Links are under
  [References](#references).

> Velasia Airways is fictional. No deployment makes real reservations or takes payments.

## Why three apps, and what that implies

The storefronts need one shared backend. Separate App Platform apps **do not share a private
network**: `internal_ports` and `http://<component>:<port>` work only between components of one
app. So:

- **`velasia-api` is reachable on a public `https://…ondigitalocean.app` hostname.**
  - Both storefronts call that URL server-side.
  - The API requires the shared secret `RETAILING_API_SERVICE_TOKEN` in an
    `x-velasia-service-token` header from every caller, and answers `401` otherwise.
  - Its health endpoints stay open for the platform's probes.
  - The browser never calls the API. CORS is therefore not enabled, and must stay that way.
- **Data on `velasia-api` is ephemeral.** App Platform has no persistent volumes: "every
  redeployment of your app will reset the filesystem", and each instance has its own disk
  (4 GiB). The TalaDB file `/data/velasia.db` holds orders, payments, demo accounts and
  sessions, and it is **lost on every redeploy, restart or instance replacement**. That is
  acceptable for a demo or a benchmark. For durable data, see
  [Durable data](#durable-data-not-on-app-platform).
- **`velasia-api` must run exactly one instance.** TalaDB allows one writer per file. Never set
  `instance_count` above 1 and never enable autoscaling on it. The storefronts can scale
  freely, because they are stateless.

## Before you start

1. **Same region.** Put all three apps in the same region (the specs use `nyc`). The storefront
   → API hop crosses DigitalOcean's edge on every request.
2. **GitHub access.** App Platform must be authorised for the `nextrs-sh/velasia-airways`
   repository.
3. **Same commit.** Both storefronts must build the same Git revision. The specs set
   `deploy_on_push: false`, so you deploy all three deliberately (see
   [Deploying and redeploying](#deploying-and-redeploying)).
4. **Generate the secrets.** Keep them in your password manager, never in Git.
   ```bash
   openssl rand -hex 32   # RETAILING_API_SERVICE_TOKEN (same value in all three apps)
   openssl rand -hex 24   # METRICS_TOKEN (API)
   openssl rand -hex 24   # METRICS_TOKEN (storefronts; may be the same or separate)
   ```
5. **Edit a local copy of each spec.** Replace every `REPLACE_ME`. The placeholders are
   deliberately too short for the apps' validation, so a forgotten one fails the build or the
   start, visibly. Do not commit the edited copies.

## Step 1: create `velasia-api`

```bash
doctl apps create --spec velasia-api.yaml --wait
doctl apps list --format ID,Spec.Name,DefaultIngress
```

The image is built from `docker/Dockerfile.api`: Node.js 24.18.0, bookworm and linux/amd64,
as App Platform requires. It runs as the `node` user and listens on `0.0.0.0:4010`
(`RETAILING_API_PORT`; App Platform also sets `PORT=4010`).

Then check it:

```bash
API=https://velasia-api-xxxxx.ondigitalocean.app        # DefaultIngress from above
curl -fsS "$API/health/ready"                            # 200 {"status":"ok",...}
curl -s -o /dev/null -w '%{http_code}\n' "$API/v1/airports"   # 401: the token is enforced
curl -fsS -H "x-velasia-service-token: $TOKEN" "$API/v1/airports" | head -c 200
```

## Step 2: create `velasia-node` and `velasia-nextrs`

Edit both specs with **identical values**:

| Variable                      | Scope                  | Value                                                                          |
| ----------------------------- | ---------------------- | ------------------------------------------------------------------------------ |
| `RETAILING_API_URL`           | RUN_TIME               | `https://velasia-api-xxxxx.ondigitalocean.app` (origin only, no trailing path) |
| `RETAILING_API_SERVICE_TOKEN` | RUN_TIME, SECRET       | the API's value                                                                |
| `METRICS_TOKEN`               | RUN_TIME, SECRET       | 16+ characters                                                                 |
| `SITE_URL`                    | **RUN_AND_BUILD_TIME** | the app's **own** public URL (see below)                                       |
| `RETAILING_API_TIMEOUT_MS`    | RUN_TIME               | `5000`                                                                         |
| `VELASIA_TODAY`               | RUN_AND_BUILD_TIME     | benchmarks only: same date in all three apps                                   |

**Do not set `VELASIA_DEPLOYMENT_ID`** (Next.js `deploymentId`, version-skew protection) on
either storefront. `velasia-node` would accept it, but NextRS `0.1.0-rc.1` refuses to serve
such a build (`routes-manifest onMatchHeaders are not implemented`). `Dockerfile.nextrs`
therefore fails its build when it is set, and setting it on only one app would make the two
builds differ.

**`SITE_URL` is needed at build time, before the URL exists.**

- What it does:
  - Next.js bakes it into `sitemap.xml`, `robots.txt` and page metadata during the build.
  - At runtime, an `https://` value turns on Secure cookies.
- App Platform passes `BUILD_TIME` variables to a Dockerfile build as build arguments. The
  Dockerfiles declare `ARG SITE_URL`.
- Bindable variables such as `${APP_URL}` are **not** available to Dockerfile builds. So:
  1. Create the app with any valid placeholder URL, e.g. `https://example.invalid`.
  2. Read its URL (`doctl apps list`, column `DefaultIngress`).
  3. Set `SITE_URL` to it (Settings → App-Level/Component Environment Variables, or in the spec).
  4. Redeploy. Rebuild if prompted.
- No custom domain is needed, and no URL is hard-coded in the source.

```bash
doctl apps create --spec velasia-node.yaml --wait
doctl apps create --spec velasia-nextrs.yaml --wait
```

**What each image runs:**

- **`velasia-node`**: `node apps/web/server.js`, the standalone output of `next build`. This is
  the official Next.js production server. It reads `PORT` (App Platform sets it to 8080) and
  `HOSTNAME=0.0.0.0`, and runs as user `node`.
- **`velasia-nextrs`**: `docker/nextrs/start.sh`.
  - It maps the environment to flags and `exec`s the native binary:
    `nextrs start /app/apps/web --host 0.0.0.0 --port $PORT --js-runtime embedded-v8 …`.
  - `--net-allow` is derived from `RETAILING_API_URL`'s origin. On App Platform that is a
    public HTTPS host, so no `--net-allow-addr` is needed.
  - The image contains no Node.js, and the build fails if Node.js is present.
  - It runs as uid 10001. Logs are JSON (`NEXTRS_LOG_FORMAT=json`).

Both read the same application variables. NextRS exposes to JavaScript only the variables its
entrypoint names with `--js-env`. That list covers every variable the storefront reads.

## Step 3: verify

```bash
for app in https://velasia-node-xxxxx.ondigitalocean.app https://velasia-nextrs-xxxxx.ondigitalocean.app; do
  curl -fsS "$app/api/internal/health/ready"; echo   # {"status":"ok","retailingApi":"ready"}
  curl -fsS -o /dev/null -w '%{http_code} %{size_download}\n' "$app/"
done
# The full parity suite against the two deployments (from a machine with Playwright):
PARITY_NODE_URL=https://velasia-node-xxxxx.ondigitalocean.app \
PARITY_NEXTRS_URL=https://velasia-nextrs-xxxxx.ondigitalocean.app pnpm test:parity
```

## Health checks

| App           | Readiness (`health_check`)                                     | Liveness (`liveness_health_check`) |
| ------------- | -------------------------------------------------------------- | ---------------------------------- |
| `velasia-api` | `/health/ready`: TalaDB open, recovery done, not shutting down | `/health/live`: event loop answers |
| storefronts   | `/api/internal/health/live`                                    | `/api/internal/health/live`        |

**Why the storefronts don't use `/ready` for readiness.**

- `/api/internal/health/ready` also requires the API.
- If App Platform used it for readiness, an API redeploy would take both storefronts out of
  rotation, including their static pages.
- Use `/ready` in monitoring instead.

**Both runtimes answer the same route.** It is application code (a Route Handler), so health
checks cost each runtime the same. Exclude it from benchmark counts (see
[`runtime-parity-report.md`](runtime-parity-report.md)).

The Dockerfiles' `HEALTHCHECK` instructions are for local Docker only. App Platform does not
document using them.

## Shutdown

App Platform drains an instance from the load balancer, then sends **SIGTERM** after
`drain_seconds`, then SIGKILL after `grace_period_seconds`. The specs set 15 s and 30 s. No init
process is added, so each server is PID 1 and handles SIGTERM itself:

- **Node.js.** Next.js's own handler closes the listener, waits for in-flight requests, and
  exits with code 143 (documented by DigitalOcean as a normal graceful stop).
- **NextRS.** Stops accepting connections and gives in-flight requests
  `NEXTRS_SHUTDOWN_GRACE` seconds (the spec uses 25, below the 30 s grace period).
- **API.** Readiness fails at once, requests drain, queued TalaDB writes complete, the database
  closes, and the process exits 0. `SHUTDOWN_TIMEOUT_MS` is 10 s.

## Instance sizes

Use **identical sizes for `velasia-node` and `velasia-nextrs`**. For benchmarks, use dedicated
CPU. On shared plans (`apps-s-*`), neighbours make results noisy.

| Purpose                   | Storefronts (each) | API                                                                     |
| ------------------------- | ------------------ | ----------------------------------------------------------------------- |
| Demo                      | `apps-s-1vcpu-1gb` | `apps-s-1vcpu-1gb`                                                      |
| Benchmark (specs default) | `apps-d-1vcpu-2gb` | `apps-d-1vcpu-2gb` (or larger, so the shared API is not the bottleneck) |

Images are linux/amd64 only. That is App Platform's only architecture, and TalaDB and NextRS
ship x64 glibc binaries only.

## Deploying and redeploying

- **Auto-deploy.** `deploy_on_push: false` in all specs keeps the two storefronts on the same
  commit, because nothing deploys without you. To deploy a commit to all three:
  ```bash
  for id in $API_APP_ID $NODE_APP_ID $NEXTRS_APP_ID; do doctl apps create-deployment "$id" --force-rebuild; done
  ```
  To make `main` auto-deploy instead, set `deploy_on_push: true` in all three. Each app then
  builds independently on every push, so for a short time the storefronts may run different
  commits. Check `COMMIT_HASH` in each app's deployment details.
- **Rebuilds.** A storefront rebuild is needed only for build-time values: `SITE_URL` and
  `VELASIA_TODAY`. Runtime variables (the API URL, tokens and
  `NEXTRS_*`) take effect on redeploy without a rebuild.
- **Redeploying `velasia-api` resets its data.** The storefronts stay up, and their readiness
  routes report `retailingApi: unreachable` until the new instance is ready.

## Build notes

- **Portable Dockerfile syntax only.** `Dockerfile.node`, `Dockerfile.nextrs` and
  `docker/Dockerfile.api` avoid BuildKit-only syntax: no `RUN --mount=type=cache|secret`, no
  `COPY --chmod`, no heredocs. App Platform documents none of these, and community reports say
  its builder rejects cache and secret mounts.
- **Server Actions encryption key.** Without a secret mount, Next.js generates the key per
  build. Every instance of an app runs the same image, so the key is consistent within an app.
  A key shared _across_ separately built apps is not needed, because each storefront serves
  its own Server Actions.
- **Build-time API.** The storefront build prerenders the destination pages from a throwaway
  API that starts **inside the build**, using a temporary database. It does not need, and does
  not contact, the deployed `velasia-api`. The build has 180 s for that API to start
  (`RETAILING_API_START_TIMEOUT_MS`).
- **Limits.** App Platform builds get a 1-hour timeout and 8 vCPU / 15 GiB.
- **Measured locally.** See [`docker-validation-report.md`](docker-validation-report.md) for
  build times and image sizes.

## Security checklist

- `RETAILING_API_SERVICE_TOKEN` is set, identically, in all three apps. Without it the API on
  its public hostname is open to anyone.
- `METRICS_TOKEN` is set in all three apps. On App Platform no nginx hides
  `/api/internal/metrics`, and the API's `/metrics` is also behind the service token.
- `ACCOUNT_REGISTRATION=disabled` and `PAYMENT_OUTCOME_CONTROLS=disabled` stay that way on any
  public deployment. Enable registration only for a private demonstration.
- The fault and crash test controls stay unset. Production refuses them unless
  `VELASIA_ALLOW_TEST_CONTROLS=enabled`.
- No secret is a build argument. SECRET variables are RUN_TIME only.

### What the M7 nginx proxy did that App Platform does not

| Proxy feature (Compose)        | On App Platform                                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Rate limits per client address | Not provided. The API still has its own account rate limits. Add DigitalOcean firewall rules or a CDN rule if needed |
| Hide `/api/internal/*`         | `METRICS_TOKEN` guards metrics. The health routes are public and reveal only status and uptime                       |
| HSTS                           | Not set by App Platform. Add it with a custom domain if required                                                     |
| Request ids (`x-request-id`)   | Not minted. The storefront and API mint their own                                                                    |

**Forwarded headers.**

- DigitalOcean puts the client address in `do-connecting-ip`. Its `X-Forwarded-*` behaviour is
  not documented.
- Both runtimes pass forwarded headers through to Next.js unchanged. That is `next start`'s
  behaviour; NextRS behaves the same without `--trusted-proxy` or `--strip-forwarded-headers`.
- Next.js uses `X-Forwarded-Host` for the Server Action origin check, so leave it as is unless
  DigitalOcean documents its proxy addresses (`NEXTRS_TRUSTED_PROXY`).
- Known limitation: the storefront derives its per-client rate-limit key from the last
  `X-Forwarded-For` entry. Behind DigitalOcean's edge, that may be an edge address.

## Edge cache

App Platform puts a Cloudflare-backed CDN in front of every app, and edge caching is on by
default.

- **What may be cached.** Velasia's static pages send `Cache-Control: s-maxage=…`, so the edge
  may serve them without reaching the container. Personal and live responses are
  `private, no-store`.
- **Next.js cache poisoning.** DigitalOcean's documentation lists a Next.js cache-poisoning
  issue and recommends `private` or no `cache-control` on responses that must not be cached.
  Velasia already does this. RSC requests carry Next.js's `_rsc` cache-busting query parameter.
- **Turning it off.** `disable_edge_cache: true` needs a custom domain, so it is not available
  on the generated hostname.
- **Benchmarks.** This matters for benchmarks; see
  [`runtime-parity-report.md`](runtime-parity-report.md#benchmark-readiness).

## Logs and diagnostics

- **Logs.** `doctl apps logs <app-id> --type run --follow` (runtime) or `--type build`.
  - The storefront (Node.js) and the API log one JSON object per line.
  - NextRS logs JSON too (`NEXTRS_LOG_FORMAT=json`). Its first line is the entrypoint's
    `exec nextrs` record with the effective flags (names only, never secret values).
- **Startup failures** are visible in the run log and fail the deployment:
  - A missing or invalid variable: the storefront logs `startup failed` with the variable name
    and exits, whichever runtime it runs on. The API logs `startup failed`.
  - A missing `RETAILING_API_URL` in NextRS: its entrypoint stops before starting NextRS.
- **Forwarding.** Use `log_destinations` (Papertrail, Datadog, Logtail, OpenSearch) to keep
  logs.
- **Alerts.** The specs alert on `DEPLOYMENT_FAILED`, any restart, and memory above 85 %.
- **Metrics.**
  - Storefront: `GET /api/internal/metrics` with `Authorization: Bearer $METRICS_TOKEN`.
  - API: `GET /metrics` with the service token and the metrics token.
  - NextRS's own operations listener (`/metrics`, `/readyz`) stays on `127.0.0.1:9100` inside
    the container (`NEXTRS_METRICS_ADDR`). App Platform has no console access to reach it, so
    rely on the app-level metrics.

## Durable data (not on App Platform)

TalaDB is an embedded, single-file database. It needs one persistent block device and one
process. App Platform offers neither:

- it has no volumes;
- its NFS shares are in private preview, limited to a few regions (not `nyc`), and
  "may not be suitable for production";
- NFS is a poor fit for TalaDB's file lock and fsync-bound commits anyway.

If orders must survive redeploys, run the same `docker/Dockerfile.api` image on a **Droplet with
a DigitalOcean Volume** mounted at `/data`, as in `compose.yaml`. Then:

- set the storefronts' `RETAILING_API_URL` to it, served over HTTPS (e.g. Caddy in front);
- keep `RETAILING_API_SERVICE_TOKEN` set;
- schedule `pnpm docker:backup` (see `docs/OPERATIONS.md`).

This replaces no part of the persistence design and introduces no new database.

## References

DigitalOcean documentation, retrieved 2026-11-20:

- [App spec reference](https://docs.digitalocean.com/products/app-platform/reference/app-spec/) (fields, `PORT` from `http_port`, health checks, termination)
- [Dockerfile builds](https://docs.digitalocean.com/products/app-platform/reference/dockerfile/) and [build-time variables in Dockerfile builds](https://docs.digitalocean.com/support/why-cant-i-access-my-environment-variables-at-build-time-when-building-from-a-dockerfile-on-app-platform/)
- [Environment variables and bindable variables](https://docs.digitalocean.com/products/app-platform/how-to/use-environment-variables/)
- [Internal routing](https://docs.digitalocean.com/products/app-platform/how-to/manage-internal-routing/) and [VPC](https://docs.digitalocean.com/products/app-platform/how-to/enable-vpc/)
- [Limits](https://docs.digitalocean.com/products/app-platform/details/limits/) (ephemeral filesystem, 4 GiB disk, amd64 only, gVisor, build limits) and [storing data](https://docs.digitalocean.com/products/app-platform/how-to/store-data/)
- [Termination](https://docs.digitalocean.com/products/app-platform/how-to/configure-termination/), [health checks](https://docs.digitalocean.com/products/app-platform/how-to/manage-health-checks/)
- [Pricing and instance sizes](https://docs.digitalocean.com/products/app-platform/details/pricing/)
- [Edge settings](https://docs.digitalocean.com/products/app-platform/how-to/configure-edge-settings/), [client IP (`do-connecting-ip`)](https://docs.digitalocean.com/support/where-can-i-find-the-client-ip-address-of-a-request-connecting-to-my-app/)
- [NFS shares (private preview)](https://docs.digitalocean.com/products/app-platform/how-to/mount-nfs-shares/)
- [doctl apps create](https://docs.digitalocean.com/reference/doctl/reference/apps/create/), [doctl apps spec validate](https://docs.digitalocean.com/reference/doctl/reference/apps/spec/validate/)
- BuildKit on App Platform (community, unofficial): [no BuildKit](https://www.digitalocean.com/community/questions/app-platform-docker-builds-broken-due-to-no-buildkit)
