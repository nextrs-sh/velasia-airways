# Railway cloud benchmark report (Milestone 9.1)

**Status: engineering hardening done; cloud benchmark BLOCKED. No cloud measurement exists.**

- Date: 2026-11-25.
- Branch: `feat/m9-benchmark-execution-order`.
- Method: [railway-benchmark-readiness.md](../../docs/deployment/railway-benchmark-readiness.md).

Nothing in this report is a Node.js-versus-NextRS performance result. The workstation that
prepared this milestone had no Railway CLI, no Railway login and no project token. So three
things that every comparable pair needs could not be done:

- create the temporary in-region runner;
- read the private API's metrics;
- record the deployments' Railway metadata.

The tooling refuses to call a pair comparable without them. No paired cloud run was started.

**Publication quality: no.** There is no cloud data to publish. The local numbers below come
from a laptop's Docker. They show that the method works, and they say nothing about either
runtime's performance.

## Contents

1. [Deployment environment](#1-deployment-environment)
2. [Source revisions and versions](#2-source-revisions-and-versions)
3. [CPU and memory allocations](#3-cpu-and-memory-allocations)
4. [Load generator](#4-load-generator)
5. [Shared API baseline](#5-shared-api-baseline)
6. [Warm-up methodology](#6-warm-up-methodology)
7. [Test execution order](#7-test-execution-order)
8. [Workload definitions](#8-workload-definitions)
9. [Results (A: runtime-focused, B: shared-API end-to-end)](#9-results)
10. [Shared API bottleneck assessment](#10-shared-api-bottleneck-assessment)
11. [Benchmark validity](#11-benchmark-validity)
12. [Cost and resource usage](#12-cost-and-resource-usage)
13. [Local rehearsal (method evidence only)](#13-local-rehearsal-method-evidence-only)
14. [Blockers and how to unblock](#14-blockers-and-how-to-unblock)
15. [Recommended NextRS improvements](#15-recommended-nextrs-improvements)
16. [Recommendation on larger-scale testing](#16-recommendation-on-larger-scale-testing)

## 1. Deployment environment

Verified from outside, with public requests only
([`preflight.mjs`](preflight.mjs), 2026-11-25 14:23 UTC: 24 of 24 checks passed):

| Item                          | Node.js (`velasiaweb-production`)                  | NextRS (`velasiaweb-nextrs-production`)            |
| ----------------------------- | -------------------------------------------------- | -------------------------------------------------- |
| Ready, and reaches the API    | 200 `{"retailingApi":"ready"}`                     | 200 `{"retailingApi":"ready"}`                     |
| Edge                          | `server: railway-hikari`, `x-railway-edge: sin1`   | `server: railway-hikari`, `x-railway-edge: sin1`   |
| Home page                     | 200, gzip, prerendered, `x-nextjs-cache: HIT`      | 200, gzip, prerendered, `x-nextjs-cache: STALE`    |
| JS / CSS assets               | 200, gzip, `public, max-age=31536000, immutable`   | 200, gzip, `public, max-age=31536000, immutable`   |
| RSC navigation                | 307 to the `_rsc` URL, then 200 `text/x-component` | 307 to the `_rsc` URL, then 200 `text/x-component` |
| API proxies                   | `/api/aircraft`, `/api/flights` 200, gzip          | `/api/aircraft`, `/api/flights` 200, gzip          |
| Build fingerprint (18 assets) | `aabce950edd7ba81`                                 | `d544eda7dffa666f`                                 |
| Deployment ID in HTML (`dpl`) | none                                               | none                                               |

Notes:

- **Both answers are gzip, but the public checks cannot tell who compressed them.** Railway's
  edge may compress on its own (readiness precondition 3). Where compression happens has to be
  checked from inside each container.
- **No `dpl` deployment ID.** `VELASIA_DEPLOYMENT_ID` is not set in the deployed builds, so
  `pair.mjs` tells a change of deployment by the asset fingerprint alone. Railway's own
  deployment IDs come from the `DEPLOYMENTS` file.
- **`STALE` on NextRS.** At that moment, NextRS served its home page from a stale
  prerender-cache entry (stale-while-revalidate); Node.js served a fresh one. This is
  storefront cache state. The warm-up before each measured run exists to even it out.
- Timings from this workstation (about 300 to 950 ms) include the network trip from the
  preparing workstation to Singapore. They are not benchmark latencies.

**Not verified** (needs Railway access): region, replica count, CPU and memory limits, commit,
Railway deployment IDs and status, whether a deploy or restart is in progress, the API's
process identity and health from the inside, and whether other traffic is present. The
deployed settings are the source of truth. `.railway/railway.ts` says what was intended (one
region, `asia-southeast1-eqsg3a`; storefronts 1 vCPU / 1 GiB; API 1 vCPU / 768 MiB; one replica
each), not what is running.

## 2. Source revisions and versions

**Not verified on Railway.** The NextRS rc.2 pin (`@nextrs/cli@0.1.0-rc.2`) and Next.js 16.4.6
are in the repository at `main` `bcc0524`. The commit each Railway service runs is not known:
`RAILWAY_GIT_COMMIT_SHA` inside each container, or the dashboard, will give it. The readiness
doc lists where each version is read (`/app/nextrs-version.txt`, the image labels, and so on).

## 3. CPU and memory allocations

**Not verified.** The intended limits are in section 1. The effective ones are under Settings →
Deploy → Replica Limits for each service, and in `cat /sys/fs/cgroup/cpu.max
/sys/fs/cgroup/memory.max` in each container. `pair.mjs` refuses to run on a `DEPLOYMENTS`
file in which the storefronts' limits differ.

## 4. Load generator

The runner was not created on Railway. Its image ([`Dockerfile.runner`](Dockerfile.runner):
k6 2.3.0 and Node.js 24.18.0, by digest) was built and used in the local rehearsal. Planned
configuration: same region as the services, 2 vCPU / 2 GB, no public domain, one replica,
deleted after the session. `pair.mjs` records the runner's cgroup CPU and memory, and the k6
and Node.js versions, in every `pair.json`.

## 5. Shared API baseline

**Not recorded.** The cloud API's metrics are private: they need the runner, or the
`railway ssh` fallback. The gate is ready for them (section 11).

## 6. Warm-up methodology

1. **Series pre-warm** ([`prewarm.mjs`](prewarm.mjs)). Every offer key the paired workloads
   can request is warmed through Node.js, then NextRS, sequentially, at no more than 5 requests/s.
   The script then verifies the warm state:
   - identical offer IDs on both storefronts;
   - an offer store that does not grow during the check;
   - the same API process throughout;
   - a pinned API clock.
2. **Storefront warm-up.** Before each measured run, the same workload runs on the same
   runtime for `WARMUP` at the same offered rate. It is not measured.
3. Why step 1 is needed: the pinned business date freezes the API's offer expiry
   ([known issue](../../docs/deployment/known-issue-pinned-clock-offer-expiry.md)). Without
   it, the first runtime creates offers and the second reuses them.

## 7. Test execution order

`pair.mjs` enforces the order:

- Odd rounds run Node.js first; even rounds run NextRS first.
- One k6 process at a time.
- Baseline → warm-up → measured run → recovery for the first runtime, then the same for the
  second.
- The API must be the same process throughout the series (`SERIES_START=1`, then
  `SERIES_BASELINE`).
- Both deployments must be unchanged.

Planned first cloud series: round 1 (Node.js first) and round 2 (NextRS first) for each
workload, at 2, then 5, then 10 iterations/s. Measure for 60 s after a 30 s warm-up. Go on
only while the previous level is clean.

## 8. Workload definitions

These are the readiness doc's two classes, never combined into one figure:

- **A. Runtime-focused:** `static-assets`, `rsc`, `home`, `destination`, `cached`.
- **B. Shared-API end-to-end:** `route-handler`, `offers`, `comparison`, `flight-search`.

Excluded, and refused by `pair.mjs`:

| Workload                                  | Why excluded                                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `server-action`                           | Not validated as read-only and deterministic                                                                           |
| `payment`, `checkout`, `shopping-session` | They write to TalaDB                                                                                                   |
| `mixed`                                   | It includes purchases                                                                                                  |
| `manage-booking`, `my-trips`              | They need seeded bookings, which write to TalaDB. They belong to a separate, approved series on its own database file. |

## 9. Results

### A. Runtime-focused measurements

No cloud data.

### B. Shared-API end-to-end measurements

No cloud data.

For both classes, the throughput, p50/p95/p99, TTFB, error, status, bytes, compression, CPU and
memory tables will come from [`summarize.mjs`](summarize.mjs). It reads only comparable pairs,
from their k6 summaries and gate files. Storefront CPU and memory come from Railway's service
metrics (`railway metrics --cpu --memory --json`, 30 s samples), matched to each run's window.
NextRS compression-cache and isolate metrics are read from its container-local operations
listener (`127.0.0.1:9100`).

## 10. Shared API bottleneck assessment

Not assessed in the cloud. In the local rehearsal at 5 iterations/s, the API stayed far from
every saturation threshold (section 13).

## 11. Benchmark validity

Status of the tooling after this milestone:

| Requirement                                       | Status                                                                                                                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The API gate fails closed                         | Done. Missing, non-numeric or out-of-order metrics, a failed scrape after one retry, an incomplete baseline or a short watch are `invalid` (gate exit 5, pair exit 7)   |
| Recovery is measured, not a sleep                 | Done. At least 2 consecutive healthy windows (default 3), with a time limit; a time-out stops the pair                                                                  |
| Saturation is detected                            | Done. CPU, memory, event loop, backlog, probe-latency spikes, 5xx, 429 and restarts; thresholds in a validated JSON file                                                |
| Process cleanup                                   | Done. k6, the watch and the recovery probes are stopped on every failure and on SIGINT, SIGTERM and SIGHUP; the watch also stops when its parent dies and at a time cap |
| A failed k6 run, dropped iterations, k6 CPU-bound | Each one stops the pair                                                                                                                                                 |
| A deployment changed, or the deployments differ   | Exit 5                                                                                                                                                                  |
| Read-only safety                                  | Writes beyond the idle rate while traffic reached the API, any created session, and any created offer each stop the pair                                                |
| `comparable: true` only with complete evidence    | `pairProblems()`; tested                                                                                                                                                |
| CI                                                | `pnpm test:bench`, a step in the `verify` job (34 tests, no network, no secrets)                                                                                        |

## 12. Cost and resource usage

No Railway resources were created and no cloud load was generated. The public preflight sent
24 GET requests in total. Estimated cost of one first-series session, from Railway's published
rates, before any run:

- The runner: about $0.08 per hour at 2 vCPU / 2 GB, fully busy.
- Egress from the storefronts to the runner through the public domains: $0.05 per GB.

The planned levels move far less than 1 GB.

## 13. Local rehearsal (method evidence only)

Setup:

- Stack: `compose.dual-runtime.yaml` + `compose.railway-local.yaml`, images `:doctor-rc2`
  (NextRS rc.2), on a 2-core Docker VM on a laptop.
- Runner: the runner image on the private network, capped at 2 CPUs and 2 GB.
- Runs were short: 10 s warm-up, 20 s measured.

These numbers are **not** benchmark results.

The rehearsal ran in two parts: first on the system clock, then with `VELASIA_TODAY=2026-12-01`,
as on Railway.

| Step                                                               | Result                                                                                                                                                                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Preflight (local), seed (itineraries only)                         | Passed; 327 itineraries, 0 bookings, 0 accounts                                                                                                                                                                                |
| `offers` round 1, **no pre-warm** (system clock)                   | Exit 6: "node: 76 offers created". The frozen-clock leak is real, and it is caught.                                                                                                                                            |
| `prewarm.mjs`, system clock                                        | NOT VERIFIED: store 160 → 5,008 → 6,260 during the check. Offers live only 60 s. Correctly refused, and now reported as `apiClockPinned: false`.                                                                               |
| `offers` rounds 1 and 2, system clock                              | Exit 6 (192 and 204 offers created). Round 2 ran NextRS first.                                                                                                                                                                 |
| `static-assets` round 1 at 10/s, system clock                      | **Comparable** (exit 0)                                                                                                                                                                                                        |
| `prewarm.mjs`, **pinned clock**                                    | **VERIFIED**: store 0 → 1,252 → 1,252, identical offers on both storefronts, one `serverTime`, one API process                                                                                                                 |
| `offers` round 1 (Node.js first) and round 2 (NextRS first) at 5/s | **Comparable** (exit 0), 0 offers created; round 2 under `SERIES_BASELINE`                                                                                                                                                     |
| `comparison` round 1 at 5/s                                        | **Comparable** (exit 0)                                                                                                                                                                                                        |
| `rsc` round 2 at 5/s, 20 s baseline                                | Exit 6: "the run made the API write". The run had 0 API requests and the write was one order-sweep write. The baseline was too short to include a sweep: a gate defect, fixed (section 11, readiness doc "Background writes"). |
| `rsc` round 2 and `static-assets` round 2, 60 s baseline           | See [Rehearsal re-run](#rehearsal-re-run)                                                                                                                                                                                      |

### Rehearsal re-run

With the gate fix and a 60 s baseline, on the pinned clock: **5 of 5 pairs are comparable**
(exit 0). They cover all three classes of checks:

- runtime-focused workloads with no API traffic: `rsc` and `static-assets` in round 2, NextRS
  first;
- `offers` in both orders, under one series baseline;
- `comparison`.

| Pair                        | Offered | Iterations (Node.js / NextRS) | API requests seen | Offers created | Writes | Shared API peaks during the runs                                      |
| --------------------------- | ------- | ----------------------------- | ----------------- | -------------- | ------ | --------------------------------------------------------------------- |
| `offers` r1 (Node.js first) | 5/s     | 100 / 101                     | 100 / 101         | 0 / 0          | none   | CPU ≤ 0.03 cores, in-flight 1, queue 0, loop p99 ≤ 12 ms, RSS 160 MiB |
| `offers` r2 (NextRS first)  | 5/s     | 100 / 101                     | 100 / 101         | 0 / 0          | none   | Same                                                                  |
| `comparison` r1             | 5/s     | 100 / 101                     | 100 / 101         | 0 / 0          | none   | CPU ≤ 0.04 cores, loop p99 ≤ 33 ms, RSS 162 MiB                       |
| `rsc` r2 (NextRS first)     | 5/s     | 102 / 102                     | 0 / 0             | 0 / 0          | none   | CPU ≤ 0.09 cores, loop p99 ≤ 64 ms                                    |
| `static-assets` r2          | 10/s    | 202 / 203                     | 0 / 0             | 0 / 0          | none   | CPU ≤ 0.09 cores, loop p99 ≤ 68 ms                                    |

The API stayed far below every saturation threshold. For each pair:

- every check passed;
- no answer failed;
- recovery after both runs was confirmed from the metrics;
- k6 peaked below 0.8 of the runner's 2 cores.

**Per-runtime latencies are deliberately not reproduced here.** The runner, both storefronts
and the API shared one 2-core laptop VM. The numbers measure that contention, not the runtimes,
and quoting them would invite exactly the claim this milestone must not make. They stay in the
local rehearsal output, which is not committed.

## 14. Blockers and how to unblock

| Blocker                                              | What unblocks it                                                                                                                                                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No Railway CLI or login on the workstation           | Install the CLI, `railway login`, `railway link` to the project. Register an SSH key (`railway ssh keys`) for `railway ssh`.                                                                                         |
| Runner creation (cost) not authorized                | The owner approves the runner and a usage limit (readiness: minimum hard limit $10). Then: `railway add --repo nextrs-sh/velasia-airways --service velasia-bench-runner …`, Replica Limits 2 vCPU / 2 GB, no domain. |
| Deployment metadata not recorded                     | Fill in `deployments.json` from `deployments.example.json` with Railway's values                                                                                                                                     |
| `railway ssh` stdin and `config apply` with a runner | Both are documented (stdin is inherited without a PTY; a whole-project `apply` deletes undeclared services). Confirm stdin on the first `railway ssh` session. Never `apply` while the runner exists.                |

Commands, in order, once unblocked (inside the runner):

```bash
node benchmarks/railway/preflight.mjs /tmp/preflight.json
node benchmarks/node-baseline/lib/seed.mjs "$API_URL" /tmp/fixtures.json 0 0
FIXTURES=/tmp/fixtures.json node benchmarks/railway/prewarm.mjs          # must print VERIFIED
export FIXTURES=/tmp/fixtures.json DEPLOYMENTS=/tmp/deployments.json PREWARM=/tmp/velasia-bench/prewarm.json
export API_CPU=1 API_MEMORY_MIB=768 RATE=2 WARMUP=30s DURATION=60s
SERIES_START=1 node benchmarks/railway/pair.mjs static-assets 1
export SERIES_BASELINE=/tmp/velasia-bench/round-1/static-assets/api-baseline.json
node benchmarks/railway/pair.mjs static-assets 2
# … rsc, home, destination, cached, route-handler, offers, comparison, flight-search; then RATE=5, RATE=10
node benchmarks/railway/summarize.mjs /tmp/velasia-bench /tmp/velasia-summary --label "Railway, first series"
```

## 15. Recommended NextRS improvements

None can be drawn from performance data: there is none. From the preflight only:

- **Compression ownership.** Expose whether NextRS compressed a response (or the edge did),
  for example in the operations metrics, so that compression comparisons do not depend on
  Railway's edge.
- **Prerender-cache state.** Expose prerender-cache freshness (HIT / STALE /
  revalidations) on the operations listener, so that a benchmark can confirm both runtimes
  are equally warm instead of inferring it from response headers.

## 16. Recommendation on larger-scale testing

**Do not proceed to larger-scale testing yet.** First:

1. Run the first cloud series as planned above (2 → 5 → 10/s, both orders, runtime-focused
   workloads first).
2. Confirm on Railway that the gate reads the private metrics, that the runner is not the
   limit, and that the API stays far from saturation.
3. Have at least two comparable rounds per workload.

Only then plan higher levels, still at a fixed offered load and well under the API's 1 vCPU.
The shared API, not either runtime, is the expected first limit for the end-to-end class.
