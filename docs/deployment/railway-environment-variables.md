# Railway environment variables

Every variable of the three Railway services, using the names the code actually reads:

- [`apps/web/src/lib/env.ts`](../../apps/web/src/lib/env.ts) for the storefront;
- [`apps/retailing-api/src/config.ts`](../../apps/retailing-api/src/config.ts) for the API;
- the Dockerfiles and the two start scripts.

The values are set in [`.railway/railway.ts`](../../.railway/railway.ts), except secrets and the
Railway-generated values. See [railway.md](railway.md) for the procedure.

**Kinds**

| Kind          | Meaning                                                                                                                                                                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **build**     | Also a Docker build argument. Railway passes a service variable to a Dockerfile `ARG` of the same name, and to nothing else at build time. Only `SITE_URL`, `VELASIA_TODAY`, `VELASIA_DEPLOYMENT_ID` and `VELASIA_NEXT_COMPRESS` are declared, all public. |
| **runtime**   | Read by the running container only.                                                                                                                                                                                                                        |
| **secret**    | A project **shared variable**, created in the dashboard, and only referenced from IaC (`ctx.shared`). It is never in the repository, a build argument, an image layer, a log line or a `NEXT_PUBLIC_*` name.                                               |
| **railway**   | Generated or injected by Railway.                                                                                                                                                                                                                          |
| **reference** | A Railway reference, `${{service.VAR}}` or `${{shared.VAR}}`, resolved by Railway.                                                                                                                                                                         |

No variable uses the `NEXT_PUBLIC_` prefix, and `pnpm railway:check` fails if one appears.

## Matrix

`—` means the service doesn't read the variable, so it isn't set there.

| Variable                                                                                                                                                             | velasia-node                                                           | velasia-nextrs                                               | velasia-api                                          | Kind                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------ |
| `PORT`                                                                                                                                                               | `8080`                                                                 | `8080`                                                       | `4010` (health checks use `PORT`)                    | runtime (railway-injected; set explicitly) |
| `NODE_ENV`                                                                                                                                                           | `production` (the image's default too)                                 | `production` (inert: Next.js inlines it at build)            | `production`                                         | runtime                                    |
| `SITE_URL`                                                                                                                                                           | `https://${{RAILWAY_PUBLIC_DOMAIN}}` (its own domain)                  | `https://${{RAILWAY_PUBLIC_DOMAIN}}` (its own domain)        | —                                                    | **build** + runtime, reference             |
| `VELASIA_TODAY`                                                                                                                                                      | `2026-12-01`                                                           | `2026-12-01`                                                 | `2026-12-01`                                         | **build** + runtime                        |
| `VELASIA_DEPLOYMENT_ID`                                                                                                                                              | unset (rc.1; see below)                                                | unset (rc.1 refuses it)                                      | —                                                    | **build**                                  |
| `VELASIA_NEXT_COMPRESS`                                                                                                                                              | unset (gzip on)                                                        | unset                                                        | —                                                    | **build**                                  |
| `RETAILING_API_URL`                                                                                                                                                  | `http://${{velasia-api.RAILWAY_PRIVATE_DOMAIN}}:${{velasia-api.PORT}}` | same                                                         | —                                                    | runtime, reference                         |
| `RETAILING_API_SERVICE_TOKEN`                                                                                                                                        | `${{shared.RETAILING_API_SERVICE_TOKEN}}`                              | same                                                         | same                                                 | **secret**, reference                      |
| `METRICS_TOKEN`                                                                                                                                                      | `${{shared.METRICS_TOKEN}}`                                            | same                                                         | same                                                 | **secret**, reference                      |
| `RETAILING_API_TIMEOUT_MS`                                                                                                                                           | `5000`                                                                 | `5000`                                                       | —                                                    | runtime                                    |
| `RETAILING_API_FORWARD_FAULTS`                                                                                                                                       | unset (= `disabled`)                                                   | unset                                                        | —                                                    | runtime, test-only                         |
| `VELASIA_ALLOW_TEST_CONTROLS`                                                                                                                                        | unset (= `disabled`)                                                   | unset                                                        | unset                                                | runtime, test-only                         |
| `NEXTRS_ISOLATES`                                                                                                                                                    | —                                                                      | `1`                                                          | —                                                    | runtime                                    |
| `NEXTRS_NET_ALLOW_ADDR`                                                                                                                                              | —                                                                      | `fd12::/16,<private IPv4 range>`                             | —                                                    | runtime                                    |
| `NEXTRS_SHUTDOWN_GRACE`                                                                                                                                              | —                                                                      | `10`                                                         | —                                                    | runtime                                    |
| `NEXTRS_METRICS_ADDR`                                                                                                                                                | —                                                                      | unset (= `127.0.0.1:9100`, container-local)                  | —                                                    | runtime                                    |
| `NEXTRS_TRUSTED_PROXY`, `NEXTRS_STRIP_FORWARDED_HEADERS`                                                                                                             | —                                                                      | unset (forwarded headers pass through, as with `next start`) | —                                                    | runtime                                    |
| `NEXTRS_LOG_FORMAT`                                                                                                                                                  | —                                                                      | `json` (image default)                                       | —                                                    | runtime                                    |
| `HOSTNAME`                                                                                                                                                           | `0.0.0.0` (image default)                                              | — (`--host 0.0.0.0`)                                         | —                                                    | runtime                                    |
| `RETAILING_API_HOST`                                                                                                                                                 | —                                                                      | —                                                            | `::` (IPv6 + IPv4 private network)                   | runtime                                    |
| `RETAILING_API_PORT`                                                                                                                                                 | —                                                                      | —                                                            | `4010`                                               | runtime                                    |
| `TALADB_PATH`                                                                                                                                                        | —                                                                      | —                                                            | `/data/velasia.db` (on the volume)                   | runtime                                    |
| `TALADB_REQUIRE_VOLUME`                                                                                                                                              | —                                                                      | —                                                            | `enabled`                                            | runtime                                    |
| `INVENTORY_SEED`                                                                                                                                                     | —                                                                      | —                                                            | `aeronova` (the default, stated)                     | runtime                                    |
| `ACCOUNT_REGISTRATION`                                                                                                                                               | —                                                                      | —                                                            | `disabled` (`enabled` only for a private smoke test) | runtime                                    |
| `PAYMENT_OUTCOME_CONTROLS`                                                                                                                                           | —                                                                      | —                                                            | `disabled`                                           | runtime                                    |
| `SHUTDOWN_TIMEOUT_MS`                                                                                                                                                | —                                                                      | —                                                            | `10000`                                              | runtime                                    |
| `LOG_LEVEL`                                                                                                                                                          | —                                                                      | —                                                            | `info`                                               | runtime                                    |
| `RETAILING_API_FAULTS`, `RETAILING_API_CRASH_TESTS`                                                                                                                  | —                                                                      | —                                                            | unset (= `disabled`)                                 | runtime, test-only                         |
| other API tuning (`OFFER_VALIDITY_MINUTES`, `CHECKOUT_*`, `PAYMENT_*`, `SERVICING_CLAIM_MINUTES`, `SHOPPING_SESSION_*`, `SLOW_REQUEST_MS`, `INVENTORY_HORIZON_DAYS`) | —                                                                      | —                                                            | unset (code defaults, as in compose)                 | runtime                                    |
| `RAILWAY_DOCKERFILE_PATH`                                                                                                                                            | `Dockerfile.node`                                                      | `Dockerfile.nextrs`                                          | `docker/Dockerfile.api`                              | railway (builder setting)                  |
| `RAILWAY_RUN_UID`                                                                                                                                                    | —                                                                      | —                                                            | `0` (entrypoint drops to uid 1000)                   | railway (runtime setting)                  |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`                                                                                                                                | `15`                                                                   | `15`                                                         | `15`                                                 | railway (default 0)                        |
| `RAILWAY_HEALTHCHECK_TIMEOUT_SEC`                                                                                                                                    | not set: IaC `healthcheckTimeout: 120`                                 | same                                                         | same                                                 | railway                                    |
| `RAILWAY_PUBLIC_DOMAIN`                                                                                                                                              | generated domain                                                       | generated domain                                             | none (no domain)                                     | railway                                    |
| `RAILWAY_PRIVATE_DOMAIN`                                                                                                                                             | (unused)                                                               | (unused)                                                     | `velasia-api.railway.internal`                       | railway                                    |
| `RAILWAY_VOLUME_MOUNT_PATH`, `RAILWAY_VOLUME_NAME`                                                                                                                   | —                                                                      | —                                                            | `/data`, `velasia-api-data`                          | railway (informational)                    |

## Notes

**Two storefronts, one configuration.** The storefronts' variables are identical except for:

- `RAILWAY_DOCKERFILE_PATH`;
- the three `NEXTRS_*` settings;
- `SITE_URL`, which has the same reference text but resolves to each service's own domain.

`pnpm railway:check` fails if anything else differs.

**How the token flows.**

1. The storefronts send `RETAILING_API_SERVICE_TOKEN` in `x-velasia-service-token` on every API
   call. These calls are made server-side only, from route handlers and Server Actions, in
   [`apps/web/src/lib/retailing-api/client.ts`](../../apps/web/src/lib/retailing-api/client.ts).
2. The API answers 401 to any other request, except `/health`, `/health/live` and `/health/ready`.
3. NextRS sees the variable only because `docker/nextrs/start.sh` passes it with
   `--js-env RETAILING_API_SERVICE_TOKEN`. That is NextRS's only way to expose a variable to
   JavaScript, and the start script logs variable names, never values.

**Why `METRICS_TOKEN` is required on Railway.** In the compose deployment, nginx hides
`/api/internal/*`. Railway has no such proxy, so `/api/internal/metrics` is reachable on each
storefront domain, and the token is what protects it (401 without it). The health routes there
are public by design and reveal only status and uptime.

**Build versus runtime.**

- The storefront builds receive only the four public build arguments listed under Kinds.
- `RETAILING_API_URL` and the service token are pinned inside the build stage, to
  `http://127.0.0.1:4010` and an empty value. The build-time API is a throwaway local process
  with a temporary database. The private hostname does not exist at build time and never needs
  to.
- None of these build-time values reaches the runtime image. The runtime stages start from fresh
  base images.

**`VELASIA_DEPLOYMENT_ID`** stays unset on both storefronts while NextRS is rc.1. With rc.1,
`Dockerfile.nextrs` refuses a build that uses it, and a comparison must use the same policy on
both sides. After the [rc.2 upgrade](railway.md#nextrs-rc2-upgrade), set the same value (the
deployed commit) on both.

## Local equivalents

- [`.env.production.example`](../../.env.production.example): compose production mode.
- [`compose.dual-runtime.yaml`](../../compose.dual-runtime.yaml): the two runtimes.
- [`compose.railway-local.yaml`](../../compose.railway-local.yaml): the Railway-like overrides.
- [`deploy/railway/shared-variables.example.env`](../../deploy/railway/shared-variables.example.env):
  the two secrets, as placeholders.
