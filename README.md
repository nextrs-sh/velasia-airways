<p align="center">
  <img src="apps/web/public/brand/velasia-logo.svg" alt="Velasia Airways" width="320">
</p>

# Velasia Airways

[![CI](https://github.com/nextrs-sh/velasia-airways/actions/workflows/ci.yml/badge.svg)](https://github.com/nextrs-sh/velasia-airways/actions/workflows/ci.yml)

**Beyond every horizon.**

A fictional premium airline retailing experience built with Next.js. Explore flight discovery,
dynamic offers, booking journeys, and modern Offer & Order retailing.

Velasia Airways is a modern, full-service airline headquartered (fictionally) in the
Philippines, flying across Southeast Asia and to selected international destinations, priced in
PHP. **Flight search, offer shopping, booking, and checkout are built today**: compare fare
families, choose offers for each direction, enter traveller details, choose seats on
aircraft-specific seat maps, add baggage, meals, and priority services, review a
server-validated quote, then check out with a **simulated** payment into a durable order with a
booking reference (see [status](#milestone-status)). It is all fictional: no real booking, no
ticket, and no money ever moves.

> Velasia Airways is not a real airline. It does not operate flights, sell tickets, or process
> payments, and it holds no IATA or ICAO airline designator: flight numbers such as `VEL 501`
> are a display convention for this demo. Airports and cities are real; the route network,
> schedules, fares, fare rules, and allowances are invented. Nothing on the site is a booking.

![Velasia Airways homepage](docs/screenshots/home-desktop.jpg)

## Milestone status

| Milestone | Scope                                                            | Status                    |
| --------- | ---------------------------------------------------------------- | ------------------------- |
| 1         | Monorepo foundation, premium storefront, search, destinations    | ✅ Done                   |
| 2         | Flight inventory, dynamic search, indicative pricing             | ✅ Done                   |
| 2.5       | Velasia Airways rebrand: identity, design system, API, docs      | ✅ Done                   |
| 3         | Dynamic offers, fare families, shopping sessions                 | ✅ Done                   |
| 4         | Traveller details, seat maps, ancillaries, booking review        | ✅ Done                   |
| 5         | Checkout, durable orders (TalaDB), simulated payments            | ✅ Done                   |
| 6         | Manage Booking, order servicing, demo accounts, My Trips         | ✅ Done                   |
| 7         | Production hardening, Docker, observability, Node.js baseline    | ✅ Done                   |
| 8         | Dual runtime Docker images (Node.js, NextRS), App Platform prep  | ✅ Done                   |
| 9         | Railway deployment preparation (IaC, private API, TalaDB volume) | 🟡 Prepared, not deployed |

See [docs/ROADMAP.md](docs/ROADMAP.md) and the milestone reports:
[M1](docs/MILESTONE-1-REPORT.md), [M2](docs/MILESTONE-2-REPORT.md),
[M2.5](docs/MILESTONE-2.5-REBRANDING.md), [M3](docs/MILESTONE-3-REPORT.md),
[M4](docs/MILESTONE-4-REPORT.md), [M5](docs/MILESTONE-5-REPORT.md), [M6](docs/MILESTONE-6-REPORT.md),
[M7](docs/MILESTONE-7-REPORT.md). Operating it: [DEPLOYMENT](docs/DEPLOYMENT.md),
[OPERATIONS](docs/OPERATIONS.md), [SECURITY](docs/SECURITY.md); performance reference:
[benchmarks/node-baseline](benchmarks/node-baseline/README.md). M1 and M2 were delivered under the project's former
working name, AeroNova; their reports are kept as written.

**What works today:** search a fictional network of 21 airports and 54 routes, and get real
results from the Fastify retailing API. Results come from deterministic schedules and seat
inventory, with direct and one-stop itineraries and indicative prices that include simulated
taxes. One-way and round trips step through choosing a departing flight, a return flight, and a
fare choice for each, and a trip summary. You can filter by stops, departure time, price, and aircraft;
sort; browse nearby dates with their lowest fares; and open flight details with per-cabin seat
availability. Results stream into a server-rendered `/flights` page, and every empty and error
state is explained. "View fares" opens offers from the retailing API for that flight — Velasia
Light, Classic, Flex, and Business where the aircraft has a Business cabin — with what each
includes, a full comparison, and an itemised price for the whole party. Choices are kept in a
server-side shopping session, re-validated before you continue, and never re-priced without
your say. There are also destination guides and help pages. Nothing on the site books a flight.

![Fare comparison](docs/screenshots/fares-desktop.jpg)

## Flight search

- **Inventory.** 48 aircraft rotations (96 flight numbers) over 21 airports and four aircraft
  types — 562 departures a week, expanded into 9,628 dated flights over a 120-day horizon. Block times come from
  great-circle distance; local times are converted through each airport's IANA time zone.
  Load factors, demand, and cancellations are seeded and deterministic.
- **Search.** `GET /v1/flights` handles one-way and round-trip searches, cabins, passenger mixes,
  filters (stops, departure windows, price, aircraft), sort, and pagination. One-stop
  connections go through Manila or Cebu, with minimum and maximum connection times. Every
  empty result carries a reason: `no-route`, `cabin-not-offered`, `beyond-schedule`,
  `no-flights-on-date`, `insufficient-seats`, or `filtered-out`.
- **Pricing.** Calculated by the API in integer minor units (PHP centavos). It depends on
  distance band, cabin, days to departure, demand band, weekday, season, and time of day, and
  adds simulated passenger service charges, fuel surcharges, and domestic VAT. Search shows an
  indicative "From" price, which is exactly the Light offer.
- **Network conditions.** Opt-in latency and per-request faults (`delay`, `timeout`,
  `unavailable`, `empty`, `malformed`) for testing the storefront against a failing service.

## Offers and fare families

- **Fare families.** Light (cabin bag only), Classic (20 kg bag, seat choice, cheaper changes),
  Flex (30 kg bag, preferred seats, no change or refund fees, priority), and Business (Business
  cabin, 2 × 32 kg, lounge). Each is a typed set of services; all rules are fictional.
- **Offers.** `GET /v1/offers?itineraryId=…` prices every family that can be sold on that flight
  for your party and explains the rest (no Business cabin, not enough seats). Offers have opaque
  ids, a 15-minute validity, and an itemised price: base fare, fare-family component, each tax
  and fee, and included services at no extra charge.
- **Shopping session.** Server Actions select, change, and accept offers in a session held by
  the API and tied to your browser by an HTTP-only cookie. "Continue" re-validates every offer;
  an expired one is refreshed (and you're told), a changed price waits for you to accept it, and
  an unsellable flight is flagged while your other choice is kept.
- **Comparison.** Fare cards show the total for everyone and key inclusions; "Compare all
  features" opens a matrix (a table on desktop, lists on phones) with every condition spelled out.
- **Next.** "Continue to traveller details" starts the booking steps below.

## Booking: travellers, seats, extras, review

- **Travellers** (`/booking/travellers`). One card per priced passenger (Adult 1, Child 1,
  Infant 1…), validated inline with the same Zod schema the API applies: names, dates of birth
  against the travel dates, nationality, lap infants with their own adult, and contact details.
  The party can't change here: offers are priced for it. Use made-up details only.
- **Seats** (`/booking/seats`). A seat map per flight, built from each aircraft's own layout
  (A320neo, A321neo, 737-8, A330-900) with availability that matches the inventory. Seats show
  their category (standard, preferred, extra legroom, Business), price for your fare, or
  "Included with your fare"; exit rows are for adults without an infant. Fully keyboard
  operable; optional (unchosen seats are assigned free at check-in) and **provisional**: a seat
  is checked again at review and only held at checkout (a later milestone).
- **Extras** (`/booking/extras`). Extra checked baggage per traveller and direction on top of
  the fare's allowance, meals per flight (none on flights under 90 minutes; complimentary in
  Business), and priority services (never sold to fares that include them). Saved as you choose.
- **Review** (`/booking/review`). Itinerary, travellers, seats, extras, and an itemised quote. A
  final check re-prices the offers and re-checks every seat and service; "Continue to checkout"
  appears only when it passes.

## Checkout, orders, and simulated payments

- **Checkout** (`/booking/checkout`). Continuing from the review validates everything once more
  and creates a pending **order** that holds your seats for 10 minutes. The page shows the order
  itself — travellers, flights, seats, baggage, extras, an itemised price with taxes, and the
  total in PHP — with a hold timer and a demo payment section. If the price changed, checkout
  stops and asks you to accept the new total first.
- **Simulated payments.** Demo Card, Demo Wallet, or Demo Bank Transfer — no card, bank, or
  wallet details are ever asked for. In development a "simulated outcome" control lets you
  approve, decline, time out, or leave a payment pending; the API decides the result. A decline
  can be retried while the seats are held; a timeout or pending payment shows "check status"
  and is never paid twice.
- **Durable orders.** Orders live in **TalaDB**, owned by the retailing API: they survive
  refreshes, new tabs, and API restarts. Seats held or bought by orders really are taken for
  everyone else; two guests can't buy the last seat, and an expired hold frees its seats.
- **Confirmation** (`/booking/confirmation/[orderId]`). "Booking confirmed" only once the
  payment succeeded and the seats were committed, with a booking reference like `VEL-8K4P2Q`,
  the itinerary, travellers, seats, extras, and total, plus print / save as PDF. It opens only in
  the browser that made the booking.

The consistency design, recovery protocol, and test evidence are in the
[M5 report](docs/MILESTONE-5-REPORT.md).

## Manage Booking, servicing, and accounts (Milestone 6)

- **Manage Booking** (`/manage-booking`, `/manage-booking/[orderId]`). The booking as it is now
  — itinerary, fare, travellers, seats, bags, meals, payments and refunds — with only the
  actions it really allows (each disabled action says why), a print view, and a full history.
  It opens for the browser that booked it or the account it was added to; a booking reference
  only finds a booking you already have access to, and never reveals anything on its own.
- **Change flight.** Pick a date, compare every replacement flight with its full price (new
  fare, your current fare, paid seats and meals you leave, and the fare's change fee), review
  old and new side by side, and confirm. More to pay is a simulated payment; less is refunded
  (Flex, Business) or kept as travel credit (Light, Classic). Your original seats stay booked
  until the replacement is paid for; a declined payment changes nothing. Light changes close
  24 hours before departure, Classic 3 hours, Flex and Business 1 hour (fictional rules).
- **Seats and services after booking.** The aircraft's own seat map; what you already paid
  for a seat or a service counts towards a new one, and nothing your fare includes is charged.
  Extra bags, meals (and upgrades), and priority services until 3 hours (meals 24 hours) before
  departure.
- **Cancel.** What you paid, what comes back, and what is kept, line by line, before an explicit
  confirmation. Seats are released at once; the simulated refund is tracked separately
  (processing → refunded, or failed with a retry).
- **Demo accounts** (`/account`). Register, sign in and out, My Trips (upcoming, past,
  cancelled, needs attention), saved travellers you can pick in the booking form, and settings.
  Bookings made as a guest are added to an account only when you choose to, from the browser
  that made them. Demo accounts have no email verification or password reset, and registration
  is off in production unless `ACCOUNT_REGISTRATION=enabled`.

Every change is priced, validated, and written by the retailing API (TalaDB, one document per
order, compare-and-set with the order revision, idempotency keys); recovery after a crash
finishes undecided payments and refunds without ever inventing a success.

## Mock retailing API

`apps/retailing-api` is an independent Fastify service: deterministic inventory from fixtures, a
seeded demand model, offers and shopping sessions in bounded memory, and orders, seat holds, and
simulated payments in a TalaDB file that only this service opens. The full
endpoint list is in [ARCHITECTURE.md](docs/ARCHITECTURE.md) and the
[M3 report](docs/MILESTONE-3-REPORT.md#api-endpoint-changes). For testing, it can simulate
latency, failures (`x-velasia-fault`, including `slow-commit` for an answer lost after a change),
and retailing scenarios (`x-velasia-scenario`: `offer-expired`, `price-increase`, `sold-out`,
`session-expired`, `seat-taken`, `hold-expired`), all off by default. M4's endpoints are listed in the
[M4 report](docs/MILESTONE-4-REPORT.md#api-endpoints).

## Brand

The Velasia symbol is two swept wing blades forming a V on a shared horizon line; the trailing
blade, in Velasia Crimson, climbs past the frame. Crimson marks primary actions and selected
states, Midnight Navy carries premium surfaces, and booking screens stay on light, readable
surfaces.

- Assets: [`apps/web/public/brand/`](apps/web/public/brand/) (SVG logos, favicon, app icons,
  social card)
- Usage, colour, typography, and clear space: [docs/BRAND-GUIDELINES.md](docs/BRAND-GUIDELINES.md)
- Single source of truth for the airline's name, tagline, currency, and flight-number display:
  `airline` in [`packages/contracts/src/airline.ts`](packages/contracts/src/airline.ts), also
  served by the API at `GET /v1/airline`

## Stack

Next.js 16.4 (App Router, Cache Components) · React 19 · TypeScript (strict) · Tailwind CSS 4 ·
Radix UI · Lucide · Zustand · React Hook Form · Zod · Axios (Fetch adapter) · Fastify 5 ·
TalaDB (`taladb`, `@taladb/node`) · Vitest · Playwright · pnpm workspaces · Turborepo

```text
apps/web             Next.js storefront
apps/retailing-api   Fastify mock retailing API (deterministic inventory; orders in TalaDB)
packages/contracts   Shared Zod schemas, types, and pure domain rules
packages/ui          Design tokens and accessible UI primitives
packages/config      Shared TypeScript and ESLint configuration
tests/e2e            Playwright browser tests
```

Architecture, data flow, and the rendering strategy per route are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Getting started

Requires Node.js ≥ 22.22 and pnpm 10.

```bash
pnpm install
pnpm dev          # storefront on http://localhost:3000, API on http://127.0.0.1:4010
```

No API keys, paid services, or database servers are needed. Configuration is optional; see
[`.env.example`](.env.example).

**Orders database.** The retailing API creates its TalaDB file at
`apps/retailing-api/data/velasia.db` (gitignored; set `TALADB_PATH` to move it). Only one API
process may own a file — a second one exits with "in use by another process". Orders are kept
across restarts; to start empty, stop the API and run
`pnpm --filter @velasia/retailing-api db:reset --confirm`. Tests and builds use their own
temporary files.

`@taladb/node` 0.13 ships native binaries for Apple silicon Macs, Linux x64, and Windows x64.
**Intel Macs** have none yet: build it once from the matching tag
(`git clone --depth 1 --branch v0.13.1 https://github.com/taladb/taladb && cd taladb &&
cargo build --release -p taladb-node`), then copy `target/release/libtaladb_node.dylib` to
`node_modules/.pnpm/@taladb+node@0.13.1/node_modules/@taladb/node/taladb-node.darwin-x64.node`
(repeat after a fresh install).

| Command                                         | What it does                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `pnpm dev`                                      | Run the storefront and the mock API with hot reload                |
| `pnpm build`                                    | Production build (starts a temporary local API if none is running) |
| `pnpm lint`                                     | ESLint across all packages                                         |
| `pnpm typecheck`                                | `tsc --noEmit` across all packages and the E2E suite               |
| `pnpm test`                                     | Vitest unit, component, and integration tests                      |
| `pnpm test:e2e`                                 | Build, then run Playwright (desktop + mobile) on ports 3200/4210   |
| `pnpm format`                                   | Prettier                                                           |
| `pnpm --filter @velasia/retailing-api db:reset` | Show (or `--confirm`: delete) the orders database                  |

To try slow responses locally, run the API with `RETAILING_API_LATENCY_MS=300-1200`. Offers stay
valid for `OFFER_VALIDITY_MINUTES` (default 15). For
repeatable prices and seats, set `VELASIA_TODAY=2026-12-01` for both the API and the
storefront.

First E2E run: `pnpm exec playwright install chromium`.

## Production mode with Docker (Milestone 7)

```bash
cp .env.production.example .env.production   # optional; defaults work for local use
docker compose up --build -d --wait           # or: pnpm docker:build && pnpm docker:up
pnpm docker:smoke                             # 15 checks from outside and inside the stack
open http://localhost:8080
```

Three containers: an nginx proxy (the only published port, `127.0.0.1:8080`), the Next.js
standalone server, and the retailing API with its TalaDB volume on an internal network. All run
as non-root on read-only root filesystems. linux/amd64 only: TalaDB 0.13.1 ships no Linux arm64
binary. Backups: `pnpm docker:backup` (a cold, verified copy; the API pauses for seconds).
Everything else — configuration, TLS, restore, rollback, troubleshooting — is in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Two runtimes: Node.js and NextRS (Milestone 8)

The storefront ships as two production images built from the same source and the same
`next build` output, both talking to one shared retailing API:

| Image            | Server                                                                                                                        | Dockerfile              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `velasia-node`   | the official Next.js production server (standalone `server.js`, Node.js 24)                                                   | `Dockerfile.node`       |
| `velasia-nextrs` | [NextRS](https://github.com/nextrs-sh/nextrs) `@nextrs/cli@0.1.0-rc.2` from npm (Rust + embedded V8, no Node.js in the image) | `Dockerfile.nextrs`     |
| `velasia-api`    | the retailing API (unchanged role)                                                                                            | `docker/Dockerfile.api` |

```bash
docker compose -f compose.dual-runtime.yaml up --build -d --wait   # :8081 Node.js, :8082 NextRS
pnpm test:parity                                                   # the same checks against both
```

**Cloud target: Railway (Milestone 9, prepared, not deployed).** One project with three
services: the two storefronts on generated HTTPS domains, and the API on the private network only,
with TalaDB on a Railway volume. They are described in [`.railway/railway.ts`](.railway/railway.ts)
and checked offline with `pnpm railway:check`.

- Guide: [docs/deployment/railway.md](docs/deployment/railway.md).
- Also: [architecture](docs/deployment/railway-architecture.md),
  [variables](docs/deployment/railway-environment-variables.md),
  [validation](docs/deployment/railway-validation-report.md),
  [benchmark readiness](docs/deployment/railway-benchmark-readiness.md).
- Railway-like local run: add `-f compose.railway-local.yaml` to the command above.

The Milestone 8 [DigitalOcean App Platform guide](docs/deployment/digitalocean-app-platform.md)
is kept as an archived alternative, with the
[API architecture](docs/deployment/api-architecture.md),
[Docker validation](docs/deployment/docker-validation-report.md) and
[runtime parity](docs/deployment/runtime-parity-report.md) reports.

## Screenshots

| Checkout (simulated payment)                       | Booking confirmation                                       |
| -------------------------------------------------- | ---------------------------------------------------------- |
| ![Checkout](docs/screenshots/checkout-desktop.jpg) | ![Confirmation](docs/screenshots/confirmation-desktop.jpg) |

| Seat selection (A321neo)                                      | Booking review                                                 |
| ------------------------------------------------------------- | -------------------------------------------------------------- |
| ![Seat selection](docs/screenshots/booking-seats-desktop.jpg) | ![Booking review](docs/screenshots/booking-review-desktop.jpg) |

| Traveller details with validation                                             | Travel extras                                                 |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------- |
| ![Traveller form](docs/screenshots/booking-travellers-validation-desktop.jpg) | ![Travel extras](docs/screenshots/booking-extras-desktop.jpg) |

| Flight results                                                  | Flight details                                                 |
| --------------------------------------------------------------- | -------------------------------------------------------------- |
| ![Flight results](docs/screenshots/flights-results-desktop.jpg) | ![Flight details](docs/screenshots/flight-details-desktop.jpg) |

| Trip summary (round trip, two families)                    | Price change awaiting acceptance                             |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| ![Trip summary](docs/screenshots/trip-summary-desktop.jpg) | ![Price changed](docs/screenshots/price-changed-desktop.jpg) |

| Fare comparison matrix                                   | API unavailable                                            |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| ![Fare matrix](docs/screenshots/fare-matrix-desktop.jpg) | ![Error state](docs/screenshots/results-error-desktop.jpg) |

| Mobile fares                                       | Mobile trip summary                                              |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| ![Mobile fares](docs/screenshots/fares-mobile.jpg) | ![Mobile trip summary](docs/screenshots/trip-summary-mobile.jpg) |

| Mobile results                                         | Mobile filters                                         | Mobile edit search                                             |
| ------------------------------------------------------ | ------------------------------------------------------ | -------------------------------------------------------------- |
| ![Mobile results](docs/screenshots/flights-mobile.jpg) | ![Mobile filters](docs/screenshots/filters-mobile.jpg) | ![Mobile edit search](docs/screenshots/edit-search-mobile.jpg) |

| Destination guide                                              | Mobile home                                      |
| -------------------------------------------------------------- | ------------------------------------------------ |
| ![Tokyo guide](docs/screenshots/destination-tokyo-desktop.jpg) | ![Mobile home](docs/screenshots/home-mobile.jpg) |

## Credits and license

Photography comes from Wikimedia Commons under CC0, public-domain, CC BY, and CC BY-SA licences.
Attribution is listed on the site’s `/credits` page and in
[`apps/web/public/images/credits.json`](apps/web/public/images/credits.json).

Code is released under the [MIT License](LICENSE).
