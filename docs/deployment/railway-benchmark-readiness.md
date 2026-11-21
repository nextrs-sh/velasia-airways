# Railway benchmark readiness (Milestone 9)

This document prepares a later Node.js-versus-NextRS comparison on Railway. **No cloud benchmark
was run in Milestone 9, and this document makes no performance claim.** Every number in a later
report must come from a measured run, recorded as described below.

## Preconditions (all must hold before any load)

1. **Functional validation passed on Railway.** That is step 8 of [railway.md](railway.md), with
   the parity suite green against both domains.
2. **NextRS is the official rc.2.** With rc.1:
   - NextRS does not gzip while Node.js does, so they do unequal work per response;
   - NextRS has no byte ranges;
   - the deployment-ID policy is forced to "off".

   An rc.1 cloud run can only be an explicitly labelled baseline, with
   `VELASIA_NEXT_COMPRESS=disabled` on both storefronts so that neither compresses. Even then, the
   Railway edge may compress (next point).

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

5. **A fresh database per run.** Bookings consume seats and change later answers. Use the
   non-destructive file switch in [railway.md](railway.md#resetting-fixtures-for-an-isolated-benchmark-manual-non-destructive).
6. **The load generator is not on the storefronts' resources.** k6 runs on a separate machine,
   or as a separate, temporary Railway service in the same region. That service is created for
   the run and deleted after it, and is never left running. Record where it ran and its limits.

## What to record for every run

| Item                         | Where to read it                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source commit                | `git rev-parse deploy/railway`; Railway deployment details (commit)                                                                                          |
| Node.js version              | `/app/node-version.txt` in velasia-node (`railway ssh --service velasia-node cat /app/node-version.txt`): 24.18.0 in the image                               |
| Next.js version              | `/app/next-version.txt` (both images): `next 16.4.6`                                                                                                         |
| NextRS version + binary hash | `/app/nextrs-version.txt`; `/usr/share/doc/nextrs/BUILD-INFO.json`; image label `dev.nextrs.binary-sha256`                                                   |
| Docker image identifiers     | Railway deployment → image digest, for each service                                                                                                          |
| Build IDs                    | `/app/apps/web/.next/BUILD_ID` in each storefront (they differ between separate builds)                                                                      |
| Runtime configuration        | The plan output of `railway config plan --json` with values redacted; the NextRS startup log line `exec nextrs` (flags, no secrets)                          |
| Effective CPU / RAM limits   | Dashboard → Settings → Deploy → Replica Limits for each service, plus `cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max` in each container               |
| Compression cache            | NextRS rc.2: `--compression-cache` (default 32 MiB); metrics on the container-local operations listener (`127.0.0.1:9100`)                                   |
| API latency                  | The API's `/metrics` (token) histogram, and the storefront metric for retailing-API calls by operation. Record it, but don't count it as runtime performance |
| Edge behaviour               | The headers from precondition 3                                                                                                                              |
| Load generator               | Host, region, k6 version, script commit, VUs/arrival rate, duration, warm-up                                                                                 |

**Do not use storefront → API latency as evidence of runtime speed.** It is mostly the API
(TalaDB fsync and the simulated payment delay) plus network. Report it beside the results so a
slow API run can be recognised and discarded, not credited to either runtime.

## Cache warm-up

Before each measured phase, warm up the same way on both domains:

- request every static or prerendered path of the workload once;
- request each `/_next/static` asset once with `accept-encoding: gzip`, so that the rc.2
  compression cache holds the eligible responses;
- run one complete booking flow;
- then pause 30 s.

The Node.js server's in-memory caches warm up the same way.

## Workload groups

Prepare these separately and report them separately; never mix them into one number. The
existing k6 harness, [`benchmarks/node-baseline/`](../../benchmarks/node-baseline/), already
covers most of them against a single origin. Point it at each domain in turn, with the same
script commit.

| #   | Group                    | Requests                                                                                                 | Notes                                                                   |
| --- | ------------------------ | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | Static / prerendered     | `/`, `/destinations`, `/destinations/<slug>`, `/about`, `/_next/static/*`, `/images/*`, `/sitemap.xml`   | No API calls. Sensitive to compression and to the edge                  |
| 2   | Dynamic SSR              | `/flights?…` with a pinned date (PPR shell + streamed results), `/booking/*` pages with a session cookie | Includes API calls; report the API latency beside the results           |
| 3   | RSC navigation           | The same paths with `rsc: 1` (+ `next-router-state-tree`) or `?_rsc=`                                    | Compare status and content type first (parity), then latency            |
| 4   | API proxy route handlers | `/api/airports`, `/api/destinations`, `/api/flights?…`, `/api/flights/<id>`, `/api/offers?…`             | Mostly a proxy: the shared API bounds them                              |
| 5   | Flight search            | `/flights?…` across routes and dates (the pinned calendar)                                               | The app's heaviest dynamic page                                         |
| 6   | Full booking flow        | Search → offer → travellers → seat → extras → review → checkout → pay (Server Actions)                   | Writes to TalaDB (fsync-bound). Low concurrency; fresh database per run |

Run groups 1–5 on both runtimes in alternating order (A B B A), each phase long enough to be stable
(≥ 5 min after warm-up). Run group 6 last, then switch the database file.

## Cost guardrails

- Keep benchmark traffic off until functional validation passes.
- Use one replica per service and never autoscale.
- Delete any temporary k6 service right after the run.
- Set a usage limit before a run (minimum hard limit $10).
- Between sessions, stop the deployments (`railway down`, see
  [railway.md](railway.md#stopping-and-deleting-trial-resources)). The API volume and its data
  are kept.

## Publishing

Publish no benchmark claim from Milestone 9. A later report must include, for each runtime and
each group:

- every item in "What to record";
- the raw k6 summaries;
- the failure and error counts.
