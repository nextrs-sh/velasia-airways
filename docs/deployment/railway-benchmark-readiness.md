# Railway benchmark readiness (Milestone 9)

This document is the method for the Node.js-versus-NextRS comparison on Railway, and it makes
no performance claim. Every number in a report must come from a measured run, recorded as
described below. The first cloud series ran on 2026-11-25: the runtime-focused class only, 12
of 12 pairs comparable, not yet publication quality. Its results and limits are in
[`RAILWAY-CLOUD-BENCHMARK-REPORT.md`](../../benchmarks/railway/RAILWAY-CLOUD-BENCHMARK-REPORT.md).

Both storefronts share **one** Fastify retailing API and **one** TalaDB database. That makes the
execution order part of the method, not a detail: a run on one runtime changes the API's state,
caches and load for the next. The [mandatory execution order](#mandatory-execution-order) below
is therefore a rule, and [`benchmarks/railway/`](../../benchmarks/railway/) enforces most of it.

## Preconditions (all must hold before any load)

1. **Functional validation passed on Railway.** That is step 8 of [railway.md](railway.md), with
   the parity suite green against both domains.
2. **NextRS is the official rc.2** (pinned in `docker/nextrs/`). rc.1 did not gzip, had no byte
   ranges and refused deployment IDs, so an rc.1 run is not comparable. Never mix rc.1 numbers
   into an rc.2 report.
3. **The edge's behaviour is measured, not assumed.** Railway documents edge compression on its
   CDN page; its scope with the CDN off is unclear. Before benchmarking:
   ```bash
   curl -s -o /dev/null -D - -H 'accept-encoding: gzip, br' https://<domain>/ | grep -i -E 'content-encoding|x-cache|vary'
   ```
   Do this for both domains, for HTML, JSON and a `/_next/static` chunk, and record the output.
   The CDN stays off (`cdn: { enabled: false }`).
4. **The same deployment for both.**

   | What                 | Requirement                                    |
   | -------------------- | ---------------------------------------------- |
   | Source               | Same commit on `deploy/railway`                |
   | API                  | One API; neither storefront has its own        |
   | Fixtures             | `INVENTORY_SEED`, `VELASIA_TODAY`              |
   | Deployment-ID policy | Same on both                                   |
   | Region               | One region                                     |
   | CPU / memory limits  | Identical                                      |
   | Processes            | One Node.js server process; one NextRS isolate |
   | Compression          | Gzip on both                                   |

   `pnpm railway:check` enforces the configuration side of this.

5. **One database per series, never a reset inside it.** A _series_ is every round of every
   workload measured against one API process and one TalaDB file. Prepare the file once, before
   the series ([Before the series](#before-the-series-once)). Switching to a new file
   ([railway.md](railway.md#resetting-fixtures-for-an-isolated-benchmark-manual-non-destructive))
   redeploys the API, so it is allowed **only between series**, never between paired runs.
6. **The load generator is not on the storefronts' resources.** k6 runs in the temporary
   [benchmark runner](#where-k6-and-the-gate-run) (its own Railway service, same region), and
   only one k6 process runs at any time.

## Workloads: runtime-focused and end-to-end

Results are reported in two separate classes and never mixed into one number. Every workload in
the paired (primary) comparison is **read-only**. "Verified read-only" means that a local run on
the Railway-like stack made the API do no writer work (the gate's `wrote: false`). "0 API calls
warm" means that the first requests after a storefront starts fill its caches from the API (1 to
23 API requests in the rehearsal), and after that no request reaches the API. The warm-up before
every measured run absorbs those fills.

| Class               | Workload (k6 `SCENARIO`)                  | Requests                                                                               | API involvement                | Verified read-only |
| ------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------ | ------------------ |
| **Runtime-focused** | `static-assets`                           | `/_next/static/*` of this build (with `?dpl=`), `accept-encoding: gzip`                | None                           | 0 API calls        |
|                     | `home`, `destination`                     | `/`, `/destinations/<slug>` (prerendered)                                              | Cache fills after a start only | 0 API calls warm   |
|                     | `cached`                                  | `/destinations`, `/api/aircraft`                                                       | Cache fills after a start only | 0 API calls warm   |
|                     | `rsc`                                     | `/`, `/destinations`, `/destinations/<slug>` with `RSC: 1` and the server's `_rsc` key | None measured                  | 0 API calls        |
| **End-to-end**      | `flight-search`                           | `/flights?…` (PPR shell + streamed results, SSR)                                       | Search per request             | yes                |
|                     | `route-handler`                           | `/api/flights?…`                                                                       | Proxy                          | yes                |
|                     | `offers`                                  | `/api/offers?itineraryId=…`                                                            | Proxy; fills the offer store   | yes (memory only)  |
|                     | `comparison`                              | `/flights?…&fares=<itinerary>` (SSR with offers)                                       | Search + offers                | yes (memory only)  |
| _Excluded_          | `server-action`                           | Manage Booking lookup, replayed (answers "not found")                                  | One lookup                     | **not validated**  |
|                     | `manage-booking`                          | `/manage-booking/<order>` with the guest cookie                                        | Order read from TalaDB         | yes                |
|                     | `my-trips`                                | `/account/trips` with an account cookie                                                | Account + orders from TalaDB   | yes                |
| _Not paired_        | `shopping-session`, `checkout`, `payment` | API directly (sessions, holds, orders)                                                 | **Writes**; private API        | no                 |
|                     | `mixed`                                   | Weighted mix that includes purchases                                                   | **Writes**                     | no                 |

Notes:

- `offers` and `comparison` add entries to the API's in-memory offer store (bounded to 20,000;
  never written to TalaDB). See [the offer store](#the-shared-api-offer-store) for why the
  series pre-warms it.
- **`server-action` is refused by `pair.mjs`.** It replays a request captured by
  `benchmarks/node-baseline/lib/capture-action.mjs` (Playwright). Before it is enabled, a capture
  from each runtime must show three things. The request is a lookup with no credentials. The
  gate sees `wrote: false` and no sessions created. And the replay is deterministic: the same
  action ID and the same answer on both runtimes. The two builds have different action IDs,
  so each runtime needs its own capture. None of this has been shown yet. Never build the
  request from guessed headers.
- **The full booking flow (search → offer → travellers → seats → extras → checkout → pay) is
  not part of the paired comparison.** It writes to TalaDB and consumes seats, so the second
  runtime would always see the first runtime's bookings. Also, the harness drives checkout and
  payment at the API level only (scenarios `checkout` / `payment`). That measures Fastify and
  TalaDB, not either runtime, and on Railway it would need the private API. A storefront-level
  booking benchmark (Server Actions through each domain) does not exist yet. If one is added,
  it runs in its own series, after the read-only series, on a fresh database for that series.
  It reports the API's writer metrics beside every number, and it is never presented as a
  runtime result.
- **Never attribute Fastify or TalaDB latency to a runtime.** End-to-end numbers include the
  shared API's time; the gate records it beside them (probe latency, API request counts).

### The shared API offer store (pinned clock)

On Railway, `VELASIA_TODAY` pins the API's clock (`apps/retailing-api/src/clock.ts`). "Now" is
then a constant: midnight, Manila time, on that date. What follows was read from
`apps/retailing-api/src/offers/retailing-service.ts` and `bounded-store.ts`:

| Question                        | Answer                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which clock controls expiry     | `clock.now()`, the pinned clock. Offer validity (`OFFER_VALIDITY_MINUTES`, 15) and the reuse window (`offerReuseMs`, 60 s) are both measured on it. "Now" never advances, so neither ever elapses.                                                                                                                                      |
| Which endpoints create or reuse | Only `GET /v1/offers` (`searchOffers`). The storefront reaches it through `/api/offers` and the fare-comparison page (`/flights?…&fares=`), and the seeder and API workloads call it directly. Search (`/v1/flights`) creates no offers. `GET /v1/offers/:id` and `/price` only read.                                                   |
| Cache key                       | `itineraryId \| adults \| children \| infants \| inventoryVersion \| demandShift`. The paired workloads always send 1/0/0. `demandShift` is 0 without a scenario header, and `inventoryVersion` is fixed for a pinned date. Reuse also needs the same eligible fare families, which depend on seats: read-only runs do not change them. |
| Survives across rounds          | Yes, for the life of the API process. Offers live in memory only, never in TalaDB. A sweep runs on time only once; after that, entries leave only when the store passes 20,000 (oldest first). An API restart empties the store, and the series is then invalid anyway.                                                                 |
| First runtime feeds the second  | Yes. Without a pre-warm, the first runtime to ask creates the offers (a priced creation) and the second reuses them (a map lookup). **The second runtime of a pair would get the cheaper path.**                                                                                                                                        |
| Can every key be pre-warmed     | Yes. The keys are the fixture itineraries (at most 5 routes × 28 dates × 3, 327 in the M7 seed) × one party. [`prewarm.mjs`](../../benchmarks/railway/prewarm.mjs) requests each one through both storefronts, then verifies the warm state.                                                                                            |

What the benchmark does about it:

1. **Pre-warm once per series** (`prewarm.mjs`, [below](#before-the-series-once)). Every
   workload URL goes through Node.js, then through NextRS, rate-capped and sequential.
2. **Verify the warm state.** `/api/offers` is read for every itinerary through both storefronts.
   The offer IDs must be identical on both, and the API's offer store
   (`velasia_memory_store_entries{store="offers"}`) must not grow during the check. `prewarm.json`
   records the key count, the store sizes and these assumptions.
3. **Check every measured run.** The gate reads the offer-store gauge in every window, and
   `pair.mjs` refuses a run that created any offer (`offersCreated > 0`): the shared cache state
   was not equivalent for the two runtimes. The pair is then `not-comparable` (exit 6). It is
   not retried until it passes.
4. Never reset TalaDB or restart the API inside a series. The warm store is part of the
   series' state.

This needs the **pinned** clock, which Railway has (`VELASIA_TODAY` in `.railway/railway.ts`).
With the system clock, offers are reused for only 60 s, so no pre-warm can hold. `prewarm.mjs`
then reports `apiClockPinned: false` and refuses to verify. The offer workloads cannot be made
equivalent that way, and `pair.mjs` refuses them as `offersCreated > 0`. The local stack runs
on the system clock unless `VELASIA_TODAY` is set. The rehearsal showed both cases.

The underlying behaviour is an application bug: a deterministic business date should not
freeze elapsed-time expiry. It is recorded for a later fix in
[known issue: pinned clock freezes offer expiry](known-issue-pinned-clock-offer-expiry.md). It is
deliberately **not** fixed in the benchmark branch.

## Mandatory execution order

### Rules for the whole series

- **Never run load against Node.js and NextRS at the same time.** One k6 process at a time.
- **Start with Node.js.** Round 1 runs Node.js first. Every later round reverses the previous
  round's order (round 2: NextRS first, round 3: Node.js first, …). Run at least two rounds per
  workload.
- **Do not restart, redeploy or reconfigure the shared API between paired runs.** The gate
  records the API's process start time in every baseline. `--same-process-as` (or
  `SERIES_BASELINE` in `pair.mjs`) stops the series with exit code 4 if it changed.
- **Do not reset TalaDB or change persistent booking data** during the series. Only read-only
  workloads are paired.
- **Do not change service resources or deployment versions** during the series. `pair.mjs`
  records each storefront's deployment ID and asset fingerprint before and after every pair, and
  stops with exit code 5 if either changed. Also record the image digests at the start and end
  of the series (dashboard → deployment details).
- **A fixed cooldown is not enough.** Recovery is confirmed from the API's metrics
  ([gate criteria](#what-recovered-and-backend-limited-mean)).
- **Saturation stops the run.** If the shared API saturates, or answers with any 5xx or
  rate-limited response, the run is classified `backend-limited` and the pair stops. That
  result is kept for the record and never published as a runtime comparison.

### Before the series (once)

1. Decide on the database. A fresh file per series (a non-destructive switch, see precondition 5) redeploys the API, so it needs the owner's go-ahead. **The first cloud series (M9.1)
   uses the deployed API and database as they are, read-only.** No switch, no reset, no
   redeploy.
2. Record the deployments in a `deployments.json` copied from
   [`deployments.example.json`](../../benchmarks/railway/deployments.example.json). For each
   service, take the deployment ID, commit, region, replicas, CPU and memory limits and status
   from Railway. Use `railway deployment list --json`, the dashboard, or the `RAILWAY_*`
   variables in each container. The file is gitignored. Without it no pair can be comparable,
   because the runner cannot read these values itself.
3. Run the public preflight from anywhere:
   `NODE_URL=… NEXTRS_URL=… node benchmarks/railway/preflight.mjs preflight.json`.
4. Seed the fixtures from the runner, **itineraries only**:
   `node benchmarks/node-baseline/lib/seed.mjs "$API_URL" /tmp/fixtures.json 0 0`. This
   searches and books nothing. The `manage-booking` and `my-trips` workloads need seeded
   bookings, which write to TalaDB: they wait for a separate, approved series on its own
   database file.
5. **Pre-warm and verify the shared API:** `node benchmarks/railway/prewarm.mjs`. It must print
   `VERIFIED` before any pair runs. Keep its `prewarm.json` with the series.
6. Run the series' first pair with `SERIES_START=1`. Its `api-baseline.json` is then the
   `SERIES_BASELINE` of every later pair.

### For each workload, in each round

`node benchmarks/railway/pair.mjs <scenario> <round>` performs these steps, in this order, and
stops at the first one that fails:

| Step | What happens                                                                                                                                                                                                                                                |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Both storefronts' `/api/internal/health/ready` and the API's `/health/ready` answer 200. Each storefront's deployment ID and asset fingerprint are recorded. `DEPLOYMENTS` is checked: same commit, same limits, one region, one replica each, NextRS rc.2. |
| 2    | `api-gate baseline`: about 60 s of an idle API. Records CPU, RSS, heap, event-loop p99, writer queue and probe latency. Refuses an API that is not idle or not the series' process.                                                                         |
| 3    | Warm up the first runtime: the same scenario, same VUs, `WARMUP` (60 s), `PICK=cycle`. Not measured.                                                                                                                                                        |
| 4    | Measured k6 run (`DURATION`, 300 s), while `api-gate watch --fail-fast` samples the API every 2 s. If the API becomes backend-limited, the gate stops the run.                                                                                              |
| 5    | Results saved: the k6 summary, the gate's API samples and verdict.                                                                                                                                                                                          |
| 6–7  | `api-gate recover`: waits until traffic, CPU, in-flight requests, writer queue, errors and probe latency are back at the step-2 baseline for 3 windows in a row (and at least `MIN_QUIET` s). Times out at 15 min.                                          |
| 8    | Warm up the second runtime, exactly as in step 3.                                                                                                                                                                                                           |
| 9    | Measured run of the second runtime, exactly as in step 4.                                                                                                                                                                                                   |
| 10   | Results saved; then recovery is confirmed again, so the next workload starts from an idle API.                                                                                                                                                              |
| 11   | `pair.json` says `comparable: true` only if every check in [comparable](#what-comparable-requires) passed. Otherwise it records the reasons and a `classification`.                                                                                         |

Exit codes:

| Code          | Meaning                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| 0             | Comparable                                                                                                |
| 1             | Error, including a failed k6 run                                                                          |
| 2             | The API was not idle or did not recover                                                                   |
| 3             | Backend-limited                                                                                           |
| 4             | The API restarted: the series is invalid                                                                  |
| 5             | A deployment changed during the pair, or the recorded deployments differ                                  |
| 6             | Not comparable: incorrect answers, writes, offers created, k6 limits, or missing metadata                 |
| 7             | API evidence missing: metrics unavailable or invalid                                                      |
| 129, 130, 143 | Interrupted. `pair.mjs` first stops k6, the watch and the recovery probes, so nothing keeps sending load. |

**Compare only pairs with exit code 0.** A pair that stopped is kept, with its reason, and is
never retried until it passes. Each series must say what it is: `SERIES_START=1` for its first
pair, and `SERIES_BASELINE` for every later pair.

### What "comparable" requires

`pair-lib.mjs` `pairProblems()` checks every item below. Missing evidence is a failure, never a
pass.

| Requirement                     | Evidence                                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Same revision, limits, region   | `DEPLOYMENTS`: same commit for both storefronts, equal CPU/memory, one region, one replica each, status `SUCCESS`, rc.2          |
| Unchanged deployments           | The asset fingerprint and deployment ID before and after the pair are equal, and a fingerprint exists                            |
| Same shared API process         | Every gate window has the baseline's process start time; the series baseline (`SERIES_BASELINE`) proves it across pairs          |
| Equivalent warm-up and workload | Same scenario, `PICK=cycle`, same `WARMUP`, `DURATION`, `RATE`/`VUS` (by construction); with `RATE`, iteration counts within 2 % |
| Equivalent shared cache         | `offersCreated = 0` in both runs (the series was pre-warmed); no sessions created; writer work at the idle rate                  |
| No API saturation or errors     | Gate verdict `ok` for both runs: no sustained saturation, no 5xx / 429 / `RATE_LIMITED` from the API                             |
| Recovery                        | `api-gate recover` succeeded after both runs                                                                                     |
| Valid k6 evidence               | Summary present; all checks pass; `http_req_failed` 0; no 5xx/429; status counts cover every check; latency distribution         |
| Load generator not the limit    | With `RATE`: dropped iterations ≤ 1 %, started ≥ 97 % of offered. k6's peak CPU ≤ 80 % of the runner's cores (from `/proc`)      |
| Complete API observation        | Every gate window valid; watched time ≥ 90 % of `DURATION`                                                                       |

### What "recovered" and "backend-limited" mean

The gate reads the API's own `/metrics` (service token + metrics token). It also times a few
requests to `/v1/airline`, a cheap read-only route, and subtracts them from the traffic it
reports.

| Check                | Recovered when (each of 3 consecutive 10 s windows) | Backend-limited when (2 consecutive 2 s windows, or once for errors)                                          |
| -------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Traffic              | No workload requests reach the API                  | n/a                                                                                                           |
| CPU                  | ≤ max(1.5 × idle max, idle max + 0.05 cores)        | ≥ 90 % of `API_CPU` (the API's vCPU limit)                                                                    |
| Memory               | (recorded)                                          | RSS ≥ 85 % of `API_MEMORY_MIB` (the API's memory limit)                                                       |
| Backlog              | In-flight ≤ idle; writer queue 0                    | Writer queue ≥ 4, or in-flight ≥ 64                                                                           |
| Event loop           | p99 ≤ idle max + 10 ms                              | p99 ≥ 100 ms                                                                                                  |
| Latency              | Probe p50 ≤ 1.5 × idle p50 + 2 ms                   | Probe p50 ≥ 5 × idle p50 + 25 ms                                                                              |
| Errors / rate limits | No 5xx, no 429 / `RATE_LIMITED`                     | Any 5xx, 429 or `RATE_LIMITED` answer from the API                                                            |
| Same process         | Process start time equals the baseline's            | A different process: verdict `restarted`                                                                      |
| Writes               | n/a                                                 | Writer tasks above the idle rate while workload requests reached the API, or a session created: `wrote: true` |
| Offer store          | n/a                                                 | Offers created during a run: `offersCreated > 0` (not comparable)                                             |
| Evidence             | Every window valid (else exit 5, at once)           | Any invalid window, or watched < 90 % of the run: verdict `invalid`                                           |

Every threshold can be overridden with a JSON file (`--thresholds`, or `GATE_THRESHOLDS` for
`pair.mjs`) whose keys are those of `DEFAULT_SATURATION`, `DEFAULT_RECOVERY` and `sustain` in
`gate-lib.mjs`. An unknown key or a non-number is refused, so a typo cannot switch a check off.

**Background writes.** Every `ORDER_SWEEP_INTERVAL_MS` (30 s), the API's order sweep runs.
It can do writer work with no request involved, and the writer metric has no label that tells
sweep work from request work. Two rules keep that from looking like a workload write:

- A baseline must cover at least 60 s (`--min-baseline-seconds`, `GATE_MIN_BASELINE`). That is
  two sweeps, so the idle write rate includes them.
- Writer work in a run during which no workload request reached the API is reported as
  `backgroundWrites`, and is not held against the run.

The local rehearsal found this: with a 20 s baseline, one sweep write during an `rsc` run (0
API requests) was counted as a write.

**Fail closed.** A window is invalid, never healthy, in any of these cases:

- a required metric is missing (process start time, CPU, RSS, event-loop p99, in-flight,
  writer queue, both store gauges);
- a metric family is not exported (`velasia_http_requests_total`, `velasia_api_errors_total`,
  `velasia_writer_task_seconds`);
- a value is not a number;
- the response is not the Prometheus text format;
- the scrape timestamps run backwards;
- a counter went down without a restart;
- the window has fewer probe timings than `--probes`.

A scrape that fails is retried once, after a second. If it fails again, the gate records what
it has and exits 5. No missing value is ever replaced by zero. A baseline is refused if it has
fewer windows than asked for, or any value missing. Recovery needs at least 2 consecutive
healthy windows (default 3) and has a time limit. The watch also stops on its own: at its
`--duration` cap, and as soon as the `pair.mjs` that started it is gone.

RSS is recorded, and it is gated only against the memory limit. The API's V8 heap and the offer
store do not shrink back after load, and that is expected.

## Where k6 and the gate run

The API is private, so the gate must run on the project's private network. Use a **temporary
benchmark runner**: one extra Railway service built from
[`benchmarks/railway/Dockerfile.runner`](../../benchmarks/railway/Dockerfile.runner). It holds
k6 2.3.0, Node.js 24.18.0 and the benchmark scripts. It serves no traffic and idles until you
run commands through `railway ssh`.

- **Create it after the last `railway config apply`, and delete it before the next one.** It is
  deliberately not declared in `.railway/railway.ts`. Railway's IaC documentation says that in
  whole-project mode "omitting a resource means deleting it". `.railway/railway.ts` is a
  whole-project file (no `partial` export), so **an `apply` while the runner exists would
  delete the runner**. In a non-interactive session the apply needs `--confirm-destructive` to
  do so, and `railway config plan` would show the deletion first. No `apply` may happen during
  a series anyway.
- Service settings: the same region as the other three; no public domain; no health check; its
  own resource limits (record them, for example 2 vCPU / 2 GB); one replica.
- Variables: `RAILWAY_DOCKERFILE_PATH=benchmarks/railway/Dockerfile.runner`,
  `METRICS_TOKEN=${{shared.METRICS_TOKEN}}`,
  `RETAILING_API_SERVICE_TOKEN=${{shared.RETAILING_API_SERVICE_TOKEN}}`,
  `API_URL=http://${{velasia-api.RAILWAY_PRIVATE_DOMAIN}}:4010`, and
  `NODE_URL` / `NEXTRS_URL` set to the two `https://` domains.
- Storefront traffic goes to the public domains, so both runtimes are reached the same way,
  through Railway's edge. Record the edge behaviour (precondition 3).
- A pair takes about 15 minutes with the defaults. Start it detached
  (`nohup node benchmarks/railway/pair.mjs flight-search 1 > /tmp/pair.log 2>&1 &`), so that a
  dropped `railway ssh` session does not end it. Results are under `/tmp/velasia-bench/`. Copy
  them out before deleting the runner.

```bash
# inside the runner (railway ssh --service velasia-bench-runner)
node benchmarks/node-baseline/lib/seed.mjs "$API_URL" /tmp/fixtures.json        # before the series
export FIXTURES=/tmp/fixtures.json API_CPU=1
export SERIES_BASELINE=/tmp/velasia-bench/round-1/static-assets/api-baseline.json   # after the first pair
node benchmarks/railway/pair.mjs static-assets 1
node benchmarks/railway/pair.mjs flight-search 1
#   … every workload, then round 2 (reversed order) …
node benchmarks/railway/pair.mjs static-assets 2
```

**Fallback without a runner (not run).** k6 runs on an external machine, and the gate reads
the API with `--metrics-cmd`, through `railway ssh` into the API container:

```bash
node benchmarks/railway/api-gate.mjs \
  --metrics-cmd 'railway ssh --service velasia-api -- node - < benchmarks/railway/scrape-in-container.cjs' \
  baseline --out baseline.json
```

`scrape-in-container.cjs` is read from stdin and runs inside the container with the container's
own tokens. The same pattern through `docker exec -i` was validated locally.

This works through `railway ssh`. It was verified on 2026-11-25 against the deployed API: the
script arrived on stdin and ran in the container. Setting it up:

- An SSH key must be registered with `railway ssh keys add`; a project token cannot register
  one.
- `ssh.railway.com` must be in `~/.ssh/known_hosts`. With stdin piped, ssh cannot ask to trust
  the host, and fails with `Host key verification failed`. Railway publishes no host-key
  fingerprint, so trusting it is a first-use decision.
- A key with a passphrase must be loaded into the agent first
  (`ssh-add --apple-use-keychain ~/.ssh/id_ed25519`). Otherwise Railway answers
  `{"status":"no_ssh_key"}`.
- Pass a script on stdin (`… -- node - < file` or `… -- sh -s < file`). Do not pass
  `sh -c '…'`: the CLI re-quotes each word, and a quoted command line arrives as one word.
- **Port trap:** Railway injects `PORT` into every service (8080 on the API service). The API
  listens on `RETAILING_API_PORT` (4010). `scrape-in-container.cjs` reads `RETAILING_API_PORT`
  first.

The fallback still puts k6 on an external machine, so storefront traffic crosses the public
internet from there. `pair.mjs` supports only the runner layout.

**Railway behaviour.** Checked against docs.railway.com and the `railwayapp/cli` source (CLI
5.75.0, `railway` SDK 3.17.0). The first cloud series confirmed each "Used" row on
2026-11-25.

| Topic                   | Finding                                                                                                                                                      | Status                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| Create the runner       | `railway add --repo nextrs-sh/velasia-airways --branch main --service velasia-bench-runner --variables …`. `RAILWAY_DOCKERFILE_PATH` selects the Dockerfile. | Used                   |
| Runner placement        | The new service landed in the project's region (`iad`) with 1 replica and no domain; its cgroup limit was 2 vCPU / 0.93 GiB                                  | Used                   |
| Resource limits         | No CLI flag. Use the dashboard: Settings → Deploy → Replica Limits. Read them with `railway metrics -a --json` (`limit`).                                    | Documented / used      |
| Delete the runner       | `railway service delete --service velasia-bench-runner --yes`                                                                                                | Used                   |
| Private DNS             | `<private endpoint>.railway.internal`; the endpoint is not always the service name (`@velasia/retailing-api` → `velasiaretailing-api`). IPv4 and IPv6.       | Used                   |
| Private IPv4            | Interface `railnet0` is a `/9` (`10.128.0.0/9` here). A service's address can move to another /16 on redeploy (`10.228.x` → `10.146.x`).                     | Observed               |
| Service metrics         | `railway metrics -s <svc> --cpu --memory --network --raw --json -S <iso> -U <iso>` gives 30 s samples. `--all` cannot be combined with `--raw`.              | Used                   |
| Deployment identity     | `railway deployment list -s <svc> --json`: id, status, `meta.commitHash`, `meta.branch`                                                                      | Used                   |
| Copy results out        | `railway ssh … -- sh -s` with a script that prints `tar -czf - … \| base64`. Check the SHA-256 on both sides.                                                | Used                   |
| Cost                    | $20/vCPU-month and $10/GB-month, billed per minute; egress $0.05/GB. A 2 vCPU / 2 GB runner fully busy for 1 h is about $0.08.                               | Documented             |
| Whole-project IaC apply | Deletes undeclared services. `railway config plan` on the current file shows 4 to add, 3 to destroy (report, section 11).                                    | Plan run (never apply) |

## What to record for every run

`pair.mjs` writes `pair.json`, the k6 summaries, the gate's API baseline, samples and verdicts,
and the recovery logs. In addition, record:

| Item                         | Where to read it                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source commit                | `git rev-parse deploy/railway`; Railway deployment details (commit)                                                                                      |
| Node.js version              | `/app/node-version.txt` in velasia-node (`railway ssh --service velasia-node cat /app/node-version.txt`): 24.18.0 in the image                           |
| Next.js version              | `/app/next-version.txt` (both images): `next 16.4.6`                                                                                                     |
| NextRS version + binary hash | `/app/nextrs-version.txt`; `/usr/share/doc/nextrs/BUILD-INFO.json`; image label `dev.nextrs.binary-sha256`                                               |
| Docker image identifiers     | Railway deployment → image digest, for each service, at the start and the end of the series                                                              |
| Build and deployment IDs     | `pair.json` → `identityBefore` / `identityAfter`; `/app/apps/web/.next/BUILD_ID` in each storefront                                                      |
| Runtime configuration        | The plan output of `railway config plan --json` with values redacted; the NextRS startup log line `exec nextrs` (flags, no secrets)                      |
| Effective CPU / RAM limits   | Dashboard → Settings → Deploy → Replica Limits for each service, plus `cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max` in each container           |
| Compression cache            | NextRS rc.2: `--compression-cache` (default 32 MiB); metrics on the container-local operations listener (`127.0.0.1:9100`)                               |
| API CPU, memory, latency     | The gate files: `api-baseline.json` (idle), `<runtime>-api.json` (during the run), `recover-after-<runtime>.json`; Railway's service metrics beside them |
| Edge behaviour               | The headers from precondition 3                                                                                                                          |
| Load generator               | Runner region and limits, k6 version, script commit, VUs, duration, warm-up                                                                              |

## Cache warm-up

The API is pre-warmed once per series ([above](#before-the-series-once)). Each storefront is
warmed just before its own measured run (steps 3 and 8): the same scenario at the same VUs for
`WARMUP`, so its in-memory caches, and NextRS's compression cache for `static-assets`, are warm.
The warm-up and the measured run are back to back; there is no recovery wait between them.

## First cloud baseline (fixed offered load)

The first cloud series checks the method, not capacity. It uses a fixed offered load
(`RATE`, iterations per second), so both runtimes get the same request rate. It measures
latency and resource use at that rate, never a throughput ceiling:

| Level | `RATE` | Warm-up | Measured | Go on to the next level only if                                  |
| ----- | ------ | ------- | -------- | ---------------------------------------------------------------- |
| 1     | 2      | 30 s    | 60 s     | The pair exits 0, or stops for a reason that is not load-related |
| 2     | 5      | 30 s    | 60 s     | Same                                                             |
| 3     | 10     | 30 s    | 60 s     | Not run if any earlier level showed saturation or errors         |

```bash
# inside the runner, after "Before the series"
export FIXTURES=/tmp/fixtures.json DEPLOYMENTS=/tmp/deployments.json PREWARM=/tmp/velasia-bench/prewarm.json
export API_CPU=1 API_MEMORY_MIB=768 RATE=2 WARMUP=30s DURATION=60s
SERIES_START=1 node benchmarks/railway/pair.mjs static-assets 1      # round 1: Node.js first
export SERIES_BASELINE=/tmp/velasia-bench/round-1/static-assets/api-baseline.json
node benchmarks/railway/pair.mjs static-assets 2                     # round 2: NextRS first
node benchmarks/railway/pair.mjs rsc 1 && node benchmarks/railway/pair.mjs rsc 2
node benchmarks/railway/pair.mjs offers 1 && node benchmarks/railway/pair.mjs offers 2
```

At 10 iterations/s for 90 s, one run sends about 900 requests. A pair is about 2 × (warm-up +
measured) plus recovery, about 6 to 10 minutes. The workloads in order: `static-assets`, `rsc`,
`home`, `destination`, `cached`; then `route-handler`, `offers`, `comparison`, `flight-search`.

**Stop the series** in any of these cases:

- a storefront becomes unhealthy;
- the gate reports saturation, a 5xx, a 429, a restart or missing metrics;
- k6 drops iterations or becomes CPU-bound;
- Railway shows memory near a service's limit;
- the cost limit is near.

A level-3 failure is not retried at a higher rate. No stress or saturation test is part of
this milestone.

## Cost guardrails

- Keep benchmark traffic off until functional validation passes.
- Use one replica per service and never autoscale.
- Delete the runner right after the session; never leave it running.
- Set a usage limit before a run (minimum hard limit $10).
- Between sessions, stop the deployments (`railway down`, see
  [railway.md](railway.md#stopping-and-deleting-trial-resources)). The API volume and its data
  are kept.

## Publishing

Publish no benchmark claim from Milestone 9. A later report must include, for each runtime,
each workload and each round:

- every item in "What to record";
- the raw k6 summaries and the gate files;
- the failure, error and backend-limited counts, including stopped pairs.

Do not publish:

- a pair that is not `comparable: true`;
- results from a series in which the API restarted, the database was switched, or a
  deployment, image or resource limit changed;
- runtime-focused and end-to-end results combined into one figure;
- any difference that the end-to-end class attributes to a runtime without the API's latency
  shown beside it.

## Local rehearsal (2026-11-25)

The tooling was rehearsed on the Railway-like local stack (`compose.dual-runtime.yaml` +
`compose.railway-local.yaml`, the M9 rc.2 images, a private API with both tokens). The runner
image sat on the private network, as it would on Railway. Durations were seconds, not minutes.
This checked the procedure only; **no number from it is a benchmark result**.

- `pair.mjs flight-search 1` (Node.js first) and `pair.mjs rsc 2` (NextRS first, with
  `SERIES_BASELINE`): every step ran, both API recoveries were confirmed by metrics, and both
  pairs ended `comparable`.
- Read-only check (`wrote: false`): `flight-search`, `comparison`, `offers`, `route-handler`,
  `manage-booking`, `my-trips`. `static-assets` and `rsc` made no API calls. `home`, `destination`
  and `cached` made a few after a fresh start (cache fills) and none on a repeat run, on both
  runtimes.
- Negative paths: shopping-session writes gave `wrote: true`; failed logins until 429 gave
  `backend-limited` (exit 3); restarting the API container gave exit 4 from `recover`, `watch`
  and `pair.mjs` (with `SERIES_BASELINE`); `pair.mjs payment` was refused; a failing
  `--metrics-cmd` gave exit 1.
- The gate's pure logic has unit tests: `node --test benchmarks/railway/gate-lib.test.mjs`.

## Local rehearsal, Milestone 9.1 (2026-11-25)

Same stack, the hardened tooling, the runner image capped at 2 CPUs / 2 GB, and fixed offered
loads of 5 and 10 iterations/s. Outcomes and evidence are in
[the M9.1 report](../../benchmarks/railway/RAILWAY-CLOUD-BENCHMARK-REPORT.md#13-local-rehearsal-method-evidence-only).
In short:

- On the system clock, an `offers` pair without pre-warm is refused ("76 offers created"), and
  the pre-warm refuses to verify.
- On the pinned clock, the pre-warm verifies (offer store 0 → 1,252 → 1,252), and `offers` (both
  orders), `comparison`, `rsc` and `static-assets` pairs are comparable.
- A 20 s baseline produced one false "wrote" from the API's order sweep. That led to the
  60 s baseline minimum and the background-write rule.

All gate, comparability and orchestration tests (34) run in CI as `pnpm test:bench`.
