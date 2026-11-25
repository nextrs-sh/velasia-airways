# Node.js baseline (Milestone 7)

The reference performance of Velasia Airways on the **official Next.js Node.js runtime**,
recorded so that Milestone 8 (NextRS) can be compared against it under the same conditions.
**No NextRS measurement or comparison is made here.**

Results: [`results/`](results/). Each run directory has `summary.md` (the table), `summary.json`
(everything, including the environment), `k6/*.json` (raw k6 summaries, cold and warm),
`samples.json` (2 s metric samples from both services), and the services' logs.

## What is measured

| #   | Scenario (`SCENARIO`) | Requests                                                                                                                                     | Path                                                |
| --- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1   | `home`                | `GET /`                                                                                                                                      | Static page (prerendered, `use cache`)              |
| 2   | `destination`         | `GET /destinations/<slug>` (12 slugs)                                                                                                        | Static prerendered pages                            |
| 3   | `cached`              | `GET /destinations` + `GET /api/aircraft`                                                                                                    | Cached content and a static Route Handler           |
| 4   | `flight-search`       | `GET /flights?…` (327 itineraries' dates/routes)                                                                                             | Partial prerender + streamed live search (SSR)      |
| 5   | `route-handler`       | `GET /api/flights?…`                                                                                                                         | Dynamic GET Route Handler → API search              |
| 6   | `offers`              | `GET /api/offers?itineraryId=…`                                                                                                              | Offer generation via a Route Handler                |
| 7   | `comparison`          | `GET /flights?…&fares=<itinerary>`                                                                                                           | Fare comparison page (SSR, offers)                  |
| 8   | `shopping-session`    | API: create session, offers, select, reprice, read                                                                                           | Shopping-session operations (durable since M7)      |
| 9   | `server-action`       | `POST /manage-booking` (a real captured action, replayed)                                                                                    | Server Action pipeline (decode, action, RSC answer) |
| 10  | `checkout`            | API: session → travellers → steps → validate → **prepare** (seat hold)                                                                       | Checkout up to the durable pending order            |
| 11  | `payment`             | `checkout` + **simulated payment** → `CONFIRMED`                                                                                             | Full purchase (provider delay 0)                    |
| 12  | `manage-booking`      | `GET /manage-booking/<order>` with the guest cookie                                                                                          | Authenticated private SSR (order from TalaDB)       |
| 13  | `my-trips`            | `GET /account/trips` with an account cookie (4 linked bookings)                                                                              | Account SSR (TalaDB `aggregate`)                    |
| 14  | `mixed`               | Weighted: 25 home, 10 destination, 20 search, 10 route handler, 10 comparison, 5 Server Action, 8 manage, 5 My Trips, 4 shopping, 3 purchase | Browsing and booking                                |

Checkout and payment are driven at the API level: in the storefront they are Server Actions
whose cost is the API's plus the action pipeline measured in scenario 9.

Milestone 9 adds two storefront-only scenarios for the Railway comparison. They are not in
`run-baseline.mjs`'s default list, so the M7 runs stay reproducible:

| Scenario        | Requests                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------- |
| `static-assets` | The `/_next/static/*` URLs of `/` and `/destinations` (found in `setup()`), with gzip    |
| `rsc`           | `/`, `/destinations`, `/destinations/<slug>` as RSC payloads (`RSC: 1` + the `_rsc` key) |

`-e PICK=cycle` makes every scenario walk its lists in a fixed order instead of at random, so
two runtimes get the same request sequence. The paired Railway runs use it
([`../railway/pair.mjs`](../railway/pair.mjs),
[procedure](../../docs/deployment/railway-benchmark-readiness.md)). `lib/seed.mjs` sends
`RETAILING_API_SERVICE_TOKEN` from the environment when it is set, for an API that requires it.

Milestone 9.1 adds, without changing the defaults:

- `-e RATE=<iterations/s>`: a fixed offered load (`constant-arrival-rate`; `PRE_VUS` /
  `MAX_VUS` size the VU pool). k6 then reports `dropped_iterations` when it fell behind.
- `-e ACCEPT_ENCODING=gzip`: page requests carry that header, as a browser's would.
- Per-answer status counters (`velasia_status_2xx` … `velasia_status_5xx`,
  `velasia_status_429`) and `velasia_compressed` (the share of text answers of 1 KiB or more
  that came back encoded).

`node lib/seed.mjs <api> fixtures.json 0 0` seeds **itineraries only**: it searches, and books
nothing and registers nobody. Use that against a shared or live database. The default counts
(40 bookings, 10 accounts) write to TalaDB and consume seats.

Every request **checks its answer** (status and content: a booking page must contain its
order id, a search page must be a complete document, a purchase must end `CONFIRMED`). The
`Correct` column is the share of passing checks. Seat conflicts under load
(`INVENTORY_UNAVAILABLE`) are correct business answers and are counted separately. After
every run both services are stopped gracefully and the TalaDB file is checked end to end
(`db-tool verify`: order invariants, no seat held twice, one booking per session, provider
records ↔ orders). **A run with a failed integrity check is invalid.**

Per scenario: a cold pass (15 s, first requests after start or after the previous scenario),
then the measured warm pass (60 s), closed model with 20 virtual users. Reported:

- **Throughput:** requests per second, and requests per CPU-second consumed by the two
  services.
- **Latency:** HTTP p50, p95, and p99.
- **Errors:** the HTTP failure rate and the correct-check rate.
- **Resources:** CPU utilisation of each service, the maximum RSS and V8 heap, and the
  maximum event-loop p99 (2 s windows).
- **Writer:** the maximum depth of the serialized-writer queue, and per-step latencies for
  the API flows.

Startup is measured from process spawn to `/health/ready` (API) and
`/api/internal/health/ready` (web).

## Rules followed

- Production builds only: the API's esbuild bundle (`node dist/server.mjs`) and the Next.js
  standalone server (`node apps/web/server.js`), exactly what the images run, with
  `NODE_ENV=production`.
- Fixed versions: Node.js, Next.js, k6, and the git commit are recorded in `summary.json`.
- Deterministic fixtures:
  - "today" is pinned to `2026-12-01` and the inventory seed is the default.
  - The fixtures are created through the public API on a **fresh** TalaDB file: 327
    itineraries, 40 confirmed bookings, 10 demo accounts with 4 linked bookings each.
  - They are synthetic only. No real or private data, and no external API is involved.
- CPU pinning with `taskset`: API on CPUs 0–1, web on 2–3, k6 on 4–5. This stands in for
  container CPU limits on a 6-core machine without SMT.
- The simulated payment provider has no artificial delay (`PAYMENT_PROVIDER_DELAY_MS=0`), so
  the server is measured, not the simulation. Durability is TalaDB's default
  (`flush_every_write`). Shopping sessions use the default `batched` mode.
- Two storage variants:
  - **disk:** the TalaDB file on the machine's disk, the realistic case.
  - **tmpfs:** the file on `/tmp`, where fsync is free. This isolates CPU cost from storage.
- Raw output is kept. Nothing is averaged across runs or hand-edited.

## Reproduce

```bash
pnpm install && pnpm build                       # production builds
# k6 v2.3.0: https://github.com/grafana/k6/releases (verify the checksums file)
K6=/path/to/k6 node benchmarks/node-baseline/run-baseline.mjs --label my-run            # disk, ~20 min
K6=/path/to/k6 node benchmarks/node-baseline/run-baseline.mjs --label my-run-tmpfs --db-dir /tmp
K6=/path/to/k6 node benchmarks/node-baseline/run-baseline.mjs --label my-soak \
  --scenarios home --duration 5s --warmup 2s --soak 30m --soak-vus 30                   # 30-min soak
```

Options: `--vus`, `--duration`, `--warmup`, `--scenarios a,b,c`, `--db-dir`, `--soak`,
`--soak-vus`. A single scenario can also be run by hand with
`k6 run -e SCENARIO=… -e WEB=… -e API=… -e FIXTURES=… k6/scenarios.js`; `lib/seed.mjs` and
`lib/capture-action.mjs` create the fixtures and the action payload.

## Limitations

- **Workstation, not a server.** A desktop session (IDE, browser) shares the machine, so
  absolute numbers carry noise. Compare runs on the same machine only, and repeat runs before
  drawing conclusions from small differences.
- **The disk is a 7200 rpm hard drive** (btrfs, zstd). One durable TalaDB commit costs
  ≈60 ms (p50) to 170 ms (p95) there, against 0.1 ms on tmpfs. Every scenario that writes
  orders is storage-bound in the disk variant; the tmpfs variant shows what the CPU allows. On
  SSD or NVMe the disk numbers would sit between the two.
- **One machine for client and servers.** k6 on its own cores still shares memory bandwidth
  and the kernel's network stack.
- **No proxy.** Measured directly against the storefront and API, without nginx or Docker
  networking. The Docker deployment adds a hop and runs under container limits, which differ
  from `taskset` pinning.
- **Closed model.** 20 VUs means throughput adapts to latency. The soak adds 30 VUs over 30
  minutes for memory and stability, not peak throughput.
- **Mixed weights are a choice,** not real traffic. Fixtures are small: 40 bookings, 10
  accounts.
