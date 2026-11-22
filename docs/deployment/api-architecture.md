# API architecture (Milestone 8 audit)

How Velasia Airways' storefront reaches its data, verified against the repository at
`f03de91` (main after Milestone 7) rather than taken from the project history. This is the
basis for deploying two storefront runtimes, Node.js and NextRS, on one shared backend.

## Summary

```text
Browser ──HTTPS──▶ Storefront (Next.js 16 App Router)          ──HTTP(S)──▶ Retailing API (Fastify 5)
                   Server Components, Route Handlers /api/*,                 /v1/*, /health*, /metrics
                   Server Actions; server-only API client                    │
                   (velasia-node  = official Next.js server)                 ▼
                   (velasia-nextrs = NextRS, same build output)             TalaDB file (orders, payments,
                                                                             accounts, sessions)
```

- **The browser never calls the retailing API.** It talks only to the storefront: pages, RSC
  requests, `/api/*` Route Handlers and Server Actions. No `NEXT_PUBLIC_*` variable exists, and
  the CSP allows `connect-src 'self'` only.
- **All business logic lives in a separate Fastify service** (`apps/retailing-api`). This
  covers inventory, search, offers and pricing, shopping sessions, seats, checkout, simulated
  payments, orders, servicing and demo accounts. The storefront's Route Handlers and Server
  Actions are thin, validating proxies to it.
- **One process owns all persistent data.** The API embeds TalaDB 0.13.1 in a single file. The
  storefront is stateless: its cookies hold opaque tokens that the API resolves.
- **No external services.** Payments are simulated inside the API, fonts are self-hosted at
  build time by `next/font`, and every image is local (`public/images`).

So a separately deployed API is **necessary, and it already exists**. Both storefront
deployments use it as the shared backend (`velasia-api`). Nothing is extracted or duplicated.

## Stack (verified)

|                 |                                                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Package manager | pnpm 10.23.0 (`packageManager`), `pnpm-lock.yaml` committed, exact version catalog in `pnpm-workspace.yaml`; Turborepo 2.11.11               |
| Workspaces      | `apps/web` (`@velasia/web`), `apps/retailing-api` (`@velasia/retailing-api`), `packages/{contracts,ui,observability,config}`                 |
| Next.js / React | 16.4.6 / 19.3.1                                                                                                                              |
| Node.js         | `engines: >=22.22.2`; CI 22.22.2; every image uses `node:24.18.0-bookworm-slim` (pinned by digest)                                           |
| API             | Fastify 5.12.8, zod 4.6.7, `@node-rs/argon2` 2.2.2 (demo account passwords), TalaDB 0.13.1 (`@taladb/node`, prebuilt for linux-x64-gnu only) |

## Next.js features in use

| Feature                                                                               | Where                                                                                                                                                                         |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App Router, Server Components                                                         | every page under `apps/web/src/app`                                                                                                                                           |
| Cache Components (`cacheComponents: true`), `'use cache'` + `cacheLife`               | public content in `lib/content.ts` and the destination pages                                                                                                                  |
| Partial Prerendering (static shell plus streamed dynamic holes), `partialPrefetching` | e.g. `/flights` (static shell, results streamed at request time)                                                                                                              |
| `generateStaticParams`                                                                | `/destinations/[slug]` (12 destinations, prerendered from the API **at build time**)                                                                                          |
| Request-time dynamic routes                                                           | `/booking/*`, `/booking/confirmation/[orderId]`, `/manage-booking/[orderId]/*`, `/account/*`                                                                                  |
| Server Actions                                                                        | 37 exported actions in 5 modules (`features/{shopping,booking,checkout,account,manage}/actions.ts`); `bodySizeLimit: 128kb`                                                   |
| Route Handlers                                                                        | 14 (`app/api/**/route.ts`), plus the metadata routes `robots.ts`, `sitemap.ts`, `manifest.ts`                                                                                 |
| Streaming                                                                             | Suspense/PPR HTML streaming and RSC payloads; `X-Accel-Buffering: no`                                                                                                         |
| `next.config`                                                                         | CSP and security headers, 2 redirects, `typedRoutes`, `output: 'standalone'`, `isrFlushToDisk: false`, `deploymentId` from `VELASIA_DEPLOYMENT_ID`, image sizes and qualities |
| `instrumentation.ts`                                                                  | `register()` validates the environment at boot (exits on a bad config); `onRequestError` logs and counts                                                                      |
| Middleware / `proxy.ts`                                                               | **none**                                                                                                                                                                      |
| `next/image`, `next/font`                                                             | local images only; self-hosted fonts                                                                                                                                          |

## Endpoint classification

### Next.js Route Handlers (storefront, `apps/web/src/app/api`)

| Route                            | Calls                                           | Caching             |
| -------------------------------- | ----------------------------------------------- | ------------------- |
| `GET /api/airports`              | API `/v1/airports`                              | public              |
| `GET /api/destinations`          | API `/v1/destinations`                          | public              |
| `GET /api/fare-families`         | API `/v1/fare-families`                         | public              |
| `GET /api/aircraft`              | API `/v1/aircraft`                              | public              |
| `GET /api/ancillaries`           | API `/v1/ancillaries`                           | public              |
| `GET /api/routes`                | API `/v1/routes`                                | public              |
| `GET /api/flights`               | API `/v1/flights`                               | `private, no-store` |
| `GET /api/flights/[id]`          | API `/v1/flights/:id` (+ availability)          | live                |
| `GET /api/flights/[id]/seatmap`  | API seat map (with the shopping-session cookie) | live                |
| `GET /api/offers`                | API `/v1/offers`                                | live                |
| `GET /api/offers/[offerId]`      | API `/v1/offers/:offerId`                       | live                |
| `GET /api/internal/health/live`  | nothing (liveness)                              | `no-store`          |
| `GET /api/internal/health/ready` | API `/health/ready`                             | `no-store`          |
| `GET /api/internal/metrics`      | nothing (Prometheus text; `METRICS_TOKEN`)      | `no-store`          |

All public handlers are validating proxies: the query is parsed with the shared
`@velasia/contracts` schemas, rebuilt, and forwarded through the one server-only client
(`lib/retailing-api/client.ts`). The response contract is the API's own.

**Server Actions** (not URLs, but POSTs to page routes) cover every write: select fare,
travellers, seats, extras, checkout, payment, manage booking, servicing changes, cancellation,
register, sign in and out, settings. All of them call the API through the same client.

### Separate backend endpoints (Fastify, `apps/retailing-api`)

There are 56 route registrations:

- **Reference data:** `/v1/airline`, `/v1/airports`, `/v1/destinations[/:slug]`, `/v1/aircraft`,
  `/v1/fare-families`, `/v1/ancillaries[/:productId]`, `/v1/routes`.
- **Flights:** `/v1/flights`, `/v1/flights/calendar`, `/v1/flights/:id[/availability|/seatmap]`.
- **Offers:** `/v1/offers`, `/v1/offers/:offerId[/price]`.
- **Shopping sessions** (create, read, delete, steps, seats, seat maps, ancillaries, review):
  `/v1/shopping-sessions/*`.
- **Checkout:** `/v1/checkout/{prepare,validate}`, `/v1/payments/options`.
- **Orders:** `/v1/orders/*` (read, by reference, events, payment status, ancillaries, seat maps,
  seat quotes, changes, refunds, servicing) and `/v1/guest/orders`.
- **Demo accounts:** `/v1/accounts`, `/v1/sessions`, `/v1/me/*`.
- **Operations:** `/health`, `/health/live`, `/health/ready` and `/metrics`.

There is no CORS configuration, and none is needed, because only the storefront's server calls
it.

### External services

None. There are no outbound calls besides storefront to API.

### Mock and fixture data

- **Flight inventory** is generated deterministically. The inputs are the fixtures in
  `apps/retailing-api/src/fixtures` (airports, network, aircraft, seat layouts, fare families,
  ancillaries, destinations), plus `INVENTORY_SEED` (default `aeronova`),
  `INVENTORY_HORIZON_DAYS` and "today" (`VELASIA_TODAY` or the clock).
- **Payments** go to a simulated provider inside the API. Production mode approves every
  payment (`PAYMENT_OUTCOME_CONTROLS` off).
- **Fault injection** (`RETAILING_API_FAULTS`, `RETAILING_API_CRASH_TESTS` and the storefront's
  `RETAILING_API_FORWARD_FAULTS`) is test-only. Production refuses it unless
  `VELASIA_ALLOW_TEST_CONTROLS=enabled`.

Because the data comes from one API process with one seed, **both storefronts necessarily see
the same fixture data.** The one exception is the build: each storefront build prerenders the
destination pages from a throwaway API started inside the build
(`apps/web/scripts/with-retailing-api.mjs`). That API uses the same code and the same default
seed, so the output is identical as long as the build "today" is the same. Pin
`VELASIA_TODAY` for benchmarks.

## Persistence

| Data                                                        | Store                                                                                             | Durability                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Orders, payments, refunds, demo accounts and their sessions | TalaDB file (`TALADB_PATH`), API only                                                             | durable commits (fsync)                     |
| Shopping sessions                                           | in API memory, written to TalaDB in batches (`SHOPPING_SESSION_DURABILITY=batched`, 1 s)          | up to 1 s of changes can be lost on a crash |
| Flight inventory                                            | generated in API memory; held seats rebuilt from orders at startup                                | derived                                     |
| Storefront                                                  | none (cookies with opaque tokens; Next.js caches in memory; optimised images under `.next/cache`) | —                                           |

TalaDB has a **single writer**: one API process per file, locked. The API must therefore run as
**exactly one instance**. Milestone 8 introduces no other storage system.

## Environment variables

| Variable                                                                                                                            | Read by            | When                | Notes                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------- | --------------------------------------------------------------------------------------- |
| `RETAILING_API_URL`                                                                                                                 | storefront         | runtime             | where the server reaches the API; required in production                                |
| `RETAILING_API_SERVICE_TOKEN`                                                                                                       | storefront + API   | runtime             | **new in M8**, see below                                                                |
| `RETAILING_API_TIMEOUT_MS`                                                                                                          | storefront         | runtime             | default 5000                                                                            |
| `SITE_URL`                                                                                                                          | storefront         | **build** + runtime | sitemap, robots and metadata at build time; at runtime, `https://` means Secure cookies |
| `VELASIA_DEPLOYMENT_ID`                                                                                                             | storefront         | build               | version-skew id (optional); the same value on both storefronts                          |
| `VELASIA_TODAY`                                                                                                                     | storefront + API   | build + runtime     | pins "today" (demos, tests, benchmarks)                                                 |
| `METRICS_TOKEN`                                                                                                                     | storefront + API   | runtime             | bearer token for metrics                                                                |
| `RETAILING_API_HOST` / `_PORT` (or `PORT`)                                                                                          | API                | runtime             | the image uses `0.0.0.0:4010`                                                           |
| `TALADB_PATH`                                                                                                                       | API                | runtime             | absolute in production (`/data/velasia.db`)                                             |
| `ACCOUNT_REGISTRATION`, `PAYMENT_OUTCOME_CONTROLS`, `INVENTORY_*`, `CHECKOUT_*`, `OFFER_VALIDITY_MINUTES`, `SHUTDOWN_TIMEOUT_MS`, … | API                | runtime             | see `.env.production.example`                                                           |
| `PORT`, `HOSTNAME`                                                                                                                  | Node.js storefront | runtime             | standalone `server.js`                                                                  |
| `NEXTRS_*`                                                                                                                          | NextRS storefront  | runtime             | mapped to `nextrs start` flags by `docker/nextrs/start.sh`                              |

Only `SITE_URL`, `VELASIA_DEPLOYMENT_ID` and `VELASIA_TODAY` are build-time values. Everything
else, including the API URL, is read at runtime, so one image works with any API hostname.

## Existing Docker, CI and deployment (before Milestone 8)

- **Images.** `docker/Dockerfile.api`, `docker/Dockerfile.web` (Node.js standalone, port 3000)
  and `docker/Dockerfile.proxy` (nginx).
- **Compose.** `compose.yaml` and `compose.e2e.yaml`: proxy, then web, then API. The API is on
  an internal network and the proxy hides `/api/internal/*`.
- **CI.** `.github/workflows/ci.yml` runs lint, typecheck, unit tests, build and E2E, then a
  Docker job (compose build, smoke, Docker E2E, backup/restore, graceful shutdown, Trivy,
  SBOM).
- **Deployment.** No cloud configuration existed.

Milestone 8 keeps all of these unchanged in behaviour. It only drops the BuildKit cache mounts
from `docker/Dockerfile.api` so App Platform can build it.

## What Milestone 8 changes, and why

**1. A shared service token for the API** (`RETAILING_API_SERVICE_TOKEN`).

- On App Platform, three separate apps share no private network, so `velasia-api` gets a
  public HTTPS hostname. The M7 security model ("the API is never reachable from outside")
  would no longer hold:
  - anyone could call `/v1/*` directly;
  - the per-browser rate-limit key (`x-velasia-client`) could be spoofed;
  - `/metrics` could be read.
- When the token is set, the API refuses any request without the matching
  `x-velasia-service-token` header with `401 UNAUTHENTICATED`. Requests are refused before
  routing, the comparison is constant-time, and the header is redacted from logs. `/health`,
  `/health/live` and `/health/ready` stay open for platform probes.
- The storefront sends the token server-side from `lib/retailing-api/client.ts`.
- When the token is unset, behaviour is exactly as before (Compose, tests).
- Tests: `apps/retailing-api/test/m8-service-auth.test.ts` and
  `apps/web/test/m8-service-token.test.ts`.

**2. `RETAILING_API_START_TIMEOUT_MS`** for the build-time API in `with-retailing-api.mjs`
(default 30 s, as before). A cold container build can need longer to start the API under
`tsx`. Both new Dockerfiles set 180 s.

No request or response contract changed.

## NextRS and the Route Handlers

No handler needs to move.

- `nextrs inspect` recognises all 17 route handlers: the 14 under `/api` and the 3 metadata
  routes.
- Under `--js-runtime embedded-v8`, NextRS executes the handlers, Server Actions and dynamic
  pages in V8, using the same `next build` bundles.
- The parity suite exercises every public handler on both runtimes (see
  [`runtime-parity-report.md`](runtime-parity-report.md)).

## Runtime compatibility risks

| Risk                                                                                                                    | Affects        | Status                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NextRS is a release candidate (`0.1.0-rc.2`), described by its CLI as experimental                                      | velasia-nextrs | Accepted for this milestone; every route tested                                                                                                                       |
| NextRS outbound `fetch` is allow-listed (`--net-allow`) and private addresses are refused                               | velasia-nextrs | The entrypoint derives the allow-list from `RETAILING_API_URL`; Compose adds `NEXTRS_NET_ALLOW_ADDR`                                                                  |
| NextRS exposes only `--js-env` variables to JavaScript                                                                  | velasia-nextrs | The entrypoint passes every variable the storefront reads                                                                                                             |
| Missing Node APIs in NextRS (`crypto.generatePrimeSync` / `generateKeySync` logged as not implemented at isolate start) | velasia-nextrs | Not used by Velasia                                                                                                                                                   |
| App Platform runs containers under gVisor                                                                               | all            | Not testable locally; first item of the cloud preflight                                                                                                               |
| TalaDB file on an ephemeral filesystem                                                                                  | velasia-api    | Data is lost on redeploy or restart; documented, acceptable for demo and benchmark only                                                                               |
| Client address for account rate limits comes from the last `X-Forwarded-For` entry                                      | storefront     | On App Platform this may be an edge address, so clients could share one sign-in rate-limit bucket. The real client IP is in `do-connecting-ip` (documented follow-up) |
