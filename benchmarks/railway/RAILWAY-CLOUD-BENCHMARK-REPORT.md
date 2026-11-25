# Railway cloud benchmark report (Milestone 9.1)

**Status: first cloud series run on 2026-11-25. Runtime-focused workloads only; 12 of 12
pairs comparable. Not yet publication quality.**

- Method: [railway-benchmark-readiness.md](../../docs/deployment/railway-benchmark-readiness.md).
- Results: [`results/2026-11-25-series-1/`](results/2026-11-25-series-1/). It holds the summary
  table, CSV and charts, and the per-run Railway service metrics. Raw k6 and gate files are kept
  locally (gitignored).

**What this series measured:** static JS/CSS assets and RSC navigation payloads, served by the
two deployed storefronts, at fixed offered loads of 2, 5 and 10 requests per second. It ran in
both orders, with the shared API idle and untouched.

**What it did not measure:**

- capacity or peak throughput;
- any shared-API (end-to-end) workload;
- SSR or Cache Components pages;
- anything statistically strong: two rounds per level, 60 s each.

Section 10 explains why the data is not yet publication quality.

## 1. Deployment environment (verified with the Railway CLI)

The deployed project is **not** the one `.railway/railway.ts` describes (section 11). The
values below are what is actually running. They were read on 2026-11-25 with `railway config
pull`, `railway deployment list --json`, `railway metrics --json`, `railway variables` (only
non-secret values printed) and `railway ssh`.

| Item                          | Node.js storefront               | NextRS storefront                 | Shared API                |
| ----------------------------- | -------------------------------- | --------------------------------- | ------------------------- |
| Service                       | `@velasia/web`                   | `@velasia/web-nextrs`             | `@velasia/retailing-api`  |
| Deployment                    | `edf2d338-8396-…`                | `376caa49-e9b9-…`                 | `62a05b98-f084-…`         |
| Commit                        | `d04127a` (`main`)               | `d04127a` (`main`)                | `d04127a` (`main`)        |
| Region                        | `iad` (US East)                  | `iad`                             | `iad`                     |
| Replicas                      | 1                                | 1                                 | 1                         |
| Limits                        | 2 vCPU, 1 GB                     | 2 vCPU, 1 GB                      | 2 vCPU, 1 GB              |
| Build                         | `Dockerfile.node`                | `Dockerfile.nextrs`               | Railpack (`pnpm … start`) |
| Runtime                       | Node.js v24.18.0, Next.js 16.4.6 | NextRS 0.1.0-rc.2, Next.js 16.4.6 | Node.js v22.23.5          |
| Build fingerprint (18 assets) | `04545b0aba18cf1a`               | `04545b0aba18cf1a`                | n/a                       |

How the storefronts were reached:

- Through their public domains; the runner reached both through the `iad1` edge.
- Compression on every checked answer: gzip.
- Health checks on `/api/internal/health/ready`.
- No `dpl` deployment ID in the HTML, because `VELASIA_DEPLOYMENT_ID` is not set.

The two storefronts have the **same build fingerprint**: one source, two runtimes. Before the
redeploys between 15:13 and 15:25 UTC, the fingerprints differed.

Differences from the Milestone 9 design, all in the running deployment:

- **Region** `iad`, not Singapore (`asia-southeast1-eqsg3a`).
- **No volume** in the environment. The API writes TalaDB to `/data/velasia.db` on the
  container's own disk, and every API redeploy starts with an empty database. The
  `TALADB_REQUIRE_VOLUME` guard is in `docker/api/start.sh`, which a Railpack build does not
  use.
- **`VELASIA_TODAY` is not set.** The API runs on the real clock, so offers are reused for only
  60 s.
- **No service token and no metrics token.** The private API, including `/metrics`, answers
  without one.
- Stale local values on the API: `SITE_URL=http://localhost:8080`, `VELASIA_TAG=local`.
- **NextRS outbound policy:** `NEXTRS_NET_ALLOW_ADDR=fd12::/16,10.0.0.0/8`, set in the
  dashboard. The API's private interface is `railnet0 10.146.207.192/9`, so the actual subnet
  is `10.128.0.0/9`. The API's IPv4 moved from `10.228.244.185` to `10.146.207.192` when it was
  redeployed at 15:17 UTC, which is what broke NextRS between 15:19 and 15:21 UTC.

## 2. Load generator

The temporary service `velasia-bench-runner`:

- **Built from** `main` at `d04127a` with `benchmarks/railway/Dockerfile.runner`: k6 v2.3.0,
  Node.js v24.18.0.
- **Placement and size:** region `iad`, 1 replica, no public domain, cgroup limit 2 vCPU / 0.93
  GiB.
- **Reaching the services:** the private API at `velasiaretailing-api.railway.internal:4010`;
  the storefronts through their public domains, the same way for both.
- **Commands:** run through `railway ssh` (stdin forwarding verified).
- **Lifetime:** created at 15:51 UTC and **deleted at about 17:05 UTC**, after the results were
  copied out (SHA-256 of the archive checked on both sides).

k6 used at most 0.12 of the runner's 2 cores and dropped no iterations.

## 3. Execution order and settings

The series ran from 15:52 to 17:02 UTC. Every step was run by `pair.mjs`.

| Setting             | Value                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| Workloads           | `static-assets`, `rsc` (runtime-focused class)                                                         |
| Offered load        | 2, then 5, then 10 iterations/s (`RATE`, constant arrival rate; one request per iteration)             |
| Warm-up / measured  | 30 s / 60 s per runtime, `PICK=cycle`, `accept-encoding: gzip`                                         |
| Order               | Round 1 Node.js first, round 2 NextRS first, at every level                                            |
| Series              | One API process throughout. The first pair used `SERIES_START=1`; every later pair named its baseline. |
| API baseline        | 6 × 10 s idle windows before every pair                                                                |
| Recovery            | Metrics-confirmed after every run (3 healthy 10 s windows, at least 30 s quiet)                        |
| Stop rule           | Any pair not exiting 0 stops the series and skips the higher levels (none did)                         |
| Deployment metadata | `deployments.json` (above), checked by `deploymentProblems()`: no findings                             |

## 4. Shared API during the series

The API was idle and unchanged throughout:

- **One process** (one start time in all 12 baselines).
- **Traffic:** no workload requests in any run, 0 offers created, no writes, no background
  writes.
- **Peaks while runs were measured:**
  - 0.028 vCPU;
  - 1 request in flight, writer queue 0;
  - event-loop p99 12.7 ms;
  - RSS 142 MiB;
  - probe p50 5.5 ms.
- **Idle baselines:** CPU at most 0.007–0.008 vCPU; probe p50 2.6–3.2 ms.
- **Recovery** after each run: 50 s, the configured minimum. In other words, recovery was
  immediate.

Neither workload calls the API, so **no result below involves the shared API**.

## 5. Results: A. Runtime-focused

All values are k6 measurements from the runner in `iad`, through Railway's edge to each
storefront. Latency includes that network path; it is the same for both runtimes. Every check
passed: no failed requests, no 5xx or 429, and every text answer of 1 KiB or more came back
compressed. Full table: [`summary.md`](results/2026-11-25-series-1/summary.md). Charts:
[p50](results/2026-11-25-series-1/latency-p50.svg),
[p95](results/2026-11-25-series-1/latency-p95.svg),
[p99](results/2026-11-25-series-1/latency-p99.svg).

### `static-assets` (`/_next/static` JS and CSS of this build)

| Offered | Round (first) | Node.js p50 / p95 / p99 (ms) | NextRS p50 / p95 / p99 (ms) |
| ------- | ------------- | ---------------------------- | --------------------------- |
| 2/s     | 1 (Node.js)   | 5.7 / 11.5 / 16.4            | 4.1 / 7.1 / 11.5            |
| 2/s     | 2 (NextRS)    | 6.2 / 16.1 / 19.0            | 4.6 / 9.7 / 15.7            |
| 5/s     | 1 (Node.js)   | 5.8 / 12.7 / 20.3            | 4.1 / 8.5 / 15.3            |
| 5/s     | 2 (NextRS)    | 6.0 / 12.3 / 19.6            | 4.7 / 10.6 / 21.8           |
| 10/s    | 1 (Node.js)   | 6.0 / 13.0 / 25.9            | 3.9 / 8.6 / 14.3            |
| 10/s    | 2 (NextRS)    | 5.3 / 11.9 / 16.9            | 4.1 / 11.0 / 343.8          |

### `rsc` (RSC payloads of `/`, `/destinations` and 12 destination pages)

| Offered | Round (first) | Node.js p50 / p95 / p99 (ms) | NextRS p50 / p95 / p99 (ms) |
| ------- | ------------- | ---------------------------- | --------------------------- |
| 2/s     | 1 (Node.js)   | 7.0 / 13.0 / 20.2            | 7.8 / 13.3 / 15.7           |
| 2/s     | 2 (NextRS)    | 6.1 / 11.8 / 22.1            | 7.9 / 15.2 / 23.5           |
| 5/s     | 1 (Node.js)   | 6.5 / 13.1 / 20.5            | 6.8 / 11.1 / 17.6           |
| 5/s     | 2 (NextRS)    | 6.0 / 11.8 / 35.5            | 6.7 / 12.7 / 18.0           |
| 10/s    | 1 (Node.js)   | 5.7 / 11.1 / 19.3            | 6.7 / 11.2 / 22.2           |
| 10/s    | 2 (NextRS)    | 5.8 / 11.3 / 17.2            | 6.6 / 13.3 / 26.5           |

What the measurements show, and no more:

- **`static-assets`:** NextRS had the lower p50 in 6 of 6 pairs (3.9–4.7 ms against 5.3–6.2
  ms), and the lower p95 in 6 of 6, in both orders. p99 is mixed. One NextRS run had a single
  343.8 ms p99 outlier; at 600 requests that is about 6 slow requests.
- **`rsc`:** Node.js had the lower p50 in 6 of 6 pairs (5.7–7.0 ms against 6.6–7.9 ms), and
  the lower TTFB p95 in 5 of 6. p95 and p99 are mixed.
- **Size of the differences:** about 1–2 ms at the median, on an edge-inclusive path, at very
  low load.

### Resource use

Railway service metrics were read for the series window and matched to each measured minute
([`railway-service-metrics.csv`](results/2026-11-25-series-1/railway-service-metrics.csv)).

| Offered | Node.js CPU avg (vCPU) | NextRS CPU avg (vCPU) | Node.js memory max (MiB) | NextRS memory max (MiB) |
| ------- | ---------------------- | --------------------- | ------------------------ | ----------------------- |
| 2/s     | 0.006–0.014            | 0.005–0.022           | 95–101                   | 137–147                 |
| 5/s     | 0.017–0.030            | 0.008–0.035           | 101–199                  | 159–185                 |
| 10/s    | 0.023–0.041            | 0.010–0.054           | 202–220                  | 165–230                 |

**These CPU numbers cannot rank the runtimes.** Railway samples every 30 s, so each 60 s run
has two samples. All values are under 3 % of the 2 vCPU limit, and the ranges overlap.

Memory grew on both storefronts over the series: Node.js from 89 to 220 MiB, NextRS from 129
to 230 MiB. That is cache growth during warm-up and load; neither was near its limit.
Railway's network metrics cover public traffic only and are not broken out per run. NextRS's
compression-cache and isolate metrics, on its container-local listener, were not collected in
this series.

## 6. Results: B. Shared-API end-to-end

**Not run.** The API runs on the real clock (`VELASIA_TODAY` unset), so the offer workloads
cannot be pre-warmed into an equivalent state. `prewarm.mjs` would refuse to verify, and
`pair.mjs` would refuse the pairs (`offersCreated > 0`), exactly as in the local rehearsal.
`route-handler` and `flight-search` do not create offers and could be run. They were left out
of this first series to keep it to the runtime-focused class.

## 7. Benchmark validity

| Requirement                    | This series                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------- |
| Same revision, limits, region  | Yes: `d04127a`, 2 vCPU / 1 GB, `iad`, 1 replica each (`deployments.json`)    |
| Unchanged deployments          | Yes: same fingerprint before and after every pair                            |
| Same API process; API idle     | Yes: one start time; 0 workload requests; recovery confirmed after every run |
| Same offered load and sequence | Yes: `RATE`, `PICK=cycle`; iteration counts within 2 % in every pair         |
| Load generator not the limit   | Yes: 0 dropped iterations; k6 at most 0.12 of 2 cores                        |
| Valid k6 evidence              | Yes: every check passed; status distribution complete                        |
| No writes, no cache leakage    | Yes: no writes, 0 offers created, 0 sessions                                 |
| Comparable pairs               | **12 of 12**; none stopped                                                   |

## 8. Cost and resource usage

The runner ran for about 75 minutes (15:51–17:05 UTC) and was then deleted. At Railway's
published rates ($20/vCPU-month, $10/GB-month, billed per minute on actual use, $0.05/GB
egress):

- **Runner CPU:** at most 0.12 vCPU for k6, well under $0.01.
- **Runner reservation:** a fully busy 2 vCPU / 1 GB runner for the same 75 minutes would
  have cost about $0.07.
- **Egress:** k6 received 188 MB from the storefronts, warm-ups included; about $0.01.

Changes made to the Railway account:

- the runner was created and deleted;
- an SSH key (`velasia-bench`, the existing `~/.ssh/id_ed25519.pub`) was registered;
- `ssh.railway.com` was added to `~/.ssh/known_hosts`.

No application service was redeployed or reconfigured by this work.

## 9. Local rehearsal (method evidence, before the cloud series)

On the local Railway-like stack, with these confirmed:

- the frozen-clock leak ("76 offers created" without pre-warm);
- the pre-warm refusing on the system clock and verifying on the pinned clock (offer store 0 →
  1,252 → 1,252);
- 5 of 5 comparable pairs on the pinned clock, including `offers` in both orders.

It also found a gate defect, since fixed: a 20 s baseline let one order-sweep write count
against a run with no traffic. The laptop's per-runtime latencies are not reproduced: the
runner, both storefronts and the API shared one 2-core VM.

## 10. Is this publication quality?

**Not yet.** It is valid by the method, and too thin to publish:

1. **Two rounds per level, 60 s per run.** p99 rests on 120–600 requests, and one outlier
   moves it by hundreds of ms. At least 5 rounds per level and longer runs are needed, with
   the spread between rounds reported.
2. **Very low load.** At 2–10 requests/s, both runtimes use under 3 % of their CPU. The
   series shows behaviour at idle-like load, not efficiency under load.
3. **CPU resolution.** Railway's 30 s samples cannot rank two runtimes at this load. A
   per-container reading from inside each storefront during the run would be needed.
4. **Edge-inclusive latency.** The runner went through the public domains. That is fair to
   both runtimes, but every number includes Railway's edge.
5. **The deployment is not the designed one** (region, no volume, unpinned clock, no tokens).
   For runtime-focused workloads that is acceptable. The end-to-end class needs the pinned
   clock first.

The direction is consistent in both orders: static assets lower at the median on NextRS, and
RSC payloads lower at the median on Node.js. The differences are small (1–2 ms). Treat both
as hypotheses for a larger series, not as findings.

## 11. Outstanding issues

1. **The IaC file does not describe production.** `railway config plan` on
   `.railway/railway.ts` shows **4 to add, 3 to destroy**: different service names, branch,
   build and region, and a volume that does not exist. **Never run `railway config apply`
   with the current file.** The alignment is pending the owner's decision: describe the
   deployment as it is, or bring the deployment to the design.
2. **No persistent storage for TalaDB.** Every API redeploy loses all bookings.
3. **NextRS allow-list:** the observed subnet is `10.128.0.0/9`, narrower than the
   `10.0.0.0/8` that is set. `pnpm railway:check` still rejects anything wider than /16. That
   rule cannot hold on Railway, where the private IPv4 moves between /16s.
4. **`scrape-in-container.cjs`** read `PORT` (8080 on Railway) before `RETAILING_API_PORT`
   (4010). Fixed on this branch.
5. **`server-action`** remains excluded until it is shown to be read-only and deterministic.

## 12. Recommended NextRS improvements

From this series only:

- **RSC payload path.** NextRS was slightly slower at the median on RSC requests (by about 1
  ms) and faster on static assets. If the RSC difference holds in a larger series, profile the
  RSC route: payload rendering, or compression of `text/x-component`.
- **Tail latency.** Investigate the single 343.8 ms p99 outlier on static assets at 10/s.
  NextRS's own metrics (compression cache, isolate) would show whether it was a cache miss or
  isolate contention. Collect them in the next series.
- **Observability.** Expose compression-cache hits and prerender-cache freshness on the
  operations listener, so that warm-state equivalence can be proven, not inferred.

## 13. Recommendation on larger-scale testing

**Not yet.** Next steps, in order:

1. Decide the IaC and deployment questions in section 11. At least set `VELASIA_TODAY` and
   attach a volume, or the end-to-end class stays blocked.
2. Repeat the runtime-focused series with 5 rounds per level and 120 s runs, adding
   `home`, `destination` and `cached`. Read each storefront's CPU from inside the container,
   at 1 s resolution.
3. Run the end-to-end class on the pinned clock, after `prewarm.mjs` verifies.
4. Only then raise the offered load in steps, still at a fixed rate, and still far below the
   API's limit.
