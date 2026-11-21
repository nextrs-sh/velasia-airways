# Railway preparation: validation report (Milestone 9)

Validated locally on 2026-11-21. **Nothing ran on Railway:** no account was used, and no
project, service, volume, domain or deployment exists. `railway config plan` and `apply` were
never run. What only Railway can show is listed under [Not validated](#not-validated).

## Environment

| Item              | Value                                                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch            | `feat/m9-railway-deployment`, from `main` 850e892 (M8 merged as PR #10)                                                                                                                |
| Docker            | Engine 29.9.3 (Fedora 45 host, linux/amd64), Compose 5.7.0, BuildKit                                                                                                                   |
| Node.js (tools)   | 24.18.0 locally; CI pins 22.22.2                                                                                                                                                       |
| Railway tooling   | CLI 5.75.0 (GitHub release, sha256 verified); IaC SDK `railway@3.17.0` (npm integrity matches the downloaded tarball)                                                                  |
| Browsers          | Playwright 1.65.1, Chromium headless shell                                                                                                                                             |
| NextRS            | `@nextrs/cli@0.1.0-rc.1` from npm. **rc.2 is not published** (npm `dist-tags` rc.1, no rc.2 version, tarball 404, no GitHub tag or release). Not substituted                           |
| Images (`m9` tag) | velasia-api `ec449e6a…` 425 MB · velasia-node `c47c1b23…` 464 MB · velasia-nextrs `875b6e1e…` 347 MB (final; the first build `6cdd40fe…` predates the allowlist warning in `start.sh`) |
| Build             | One `next build` shared by both storefront images (byte-identical build stages): build ID `94EitfUHzCci3XNiyXIMI` in both                                                              |

## Results

| Check                                                           | Result                                              |
| --------------------------------------------------------------- | --------------------------------------------------- |
| Three images build from the repository root                     | pass                                                |
| M8 topology (`compose.dual-runtime.yaml`): parity suite         | **100 passed, 1 skipped, 0 unexpected, 0 flaky**    |
| M8 container validation (`validate-dual-runtime.sh`)            | pass (same results as M8)                           |
| Railway-like topology: parity suite                             | **100 passed, 1 skipped, 0 unexpected, 0 flaky**    |
| Railway-like container validation (`validate-railway-local.sh`) | **all checks pass**                                 |
| API image under M7 `compose.yaml` hardening                     | pass                                                |
| `.railway/railway.ts`: typecheck + offline checks               | pass, 1 expected warning                            |
| Negative checks of the offline IaC validator                    | 7/7 caught                                          |
| Build-time API is stopped after the build                       | pass                                                |
| `SITE_URL` and build artifacts                                  | measured, see [§5](#5-site_url-and-build-artifacts) |

### 1. Parity suite

`pnpm test:parity` now has 101 tests:

| Project   | Tests | What                                             |
| --------- | ----- | ------------------------------------------------ |
| `compare` | 39    | Both runtimes side by side (M8 had 34)           |
| `node`    | 31    | `runtime.spec.ts` against the Node.js storefront |
| `nextrs`  | 31    | `runtime.spec.ts` against the NextRS storefront  |

New in Milestone 9:

- **The 4 route handlers the suite did not exercise yet.** All 14 are now covered.
  - `flights/[id]/seatmap`: JSON compared.
  - `offers` and `offers/[offerId]`: JSON compared with random offer IDs and timestamps
    normalised. Unknown and malformed offer IDs return the same errors.
  - `internal/metrics`: 401 without the token and 200 with it, on both runtimes.
- **Static byte ranges.** A chunk and a public image, `Range: bytes=0-99`.
  - Node.js answers 206 with the right `content-range` and bytes. NextRS rc.1 answers 200.
  - The test carries an rc.1 expected-failure marker, like the existing compression test.
- **Deployment ID.** Skipped unless the stack was built with `VELASIA_DEPLOYMENT_ID`, which
  NextRS rc.1 refuses to serve.

Both runs had accounts (registration, sign-in) and the metrics token enabled:

```bash
PARITY_NODE_URL=http://127.0.0.1:8091 PARITY_NEXTRS_URL=http://127.0.0.1:8092 \
PARITY_ACCOUNTS=enabled PARITY_METRICS_TOKEN=… pnpm test:parity
```

The usual ports, 8081 and 8082, were held by a leftover local `next-server` from an earlier
session. It was left running, and the stacks were published on 8091/8092 through the compose
file's own `VELASIA_NODE_PORT` / `VELASIA_NEXTRS_PORT`.

Coverage of the milestone's functional list (both runtimes, both topologies):

- flight search and details;
- booking and checkout: Server Actions, cookies and API writes, with the seat held by the API,
  payment, confirmation, and manage-booking by reference;
- registration, sign-out and sign-in;
- Server Actions, including the refusal of a cross-site action;
- all 14 route handlers;
- static assets, immutable caching and `next/image` optimisation;
- RSC payloads and client navigation; the PPR shell with a streamed, uncached result;
- metadata routes and redirects;
- health routes.

**The two rc.1 expected failures fail for the right reason.** In both, the Node.js assertion
passes first and the NextRS assertion then fails:

| Test        | Node.js                  | NextRS rc.1 |
| ----------- | ------------------------ | ----------- |
| Compression | `content-encoding: gzip` | `none`      |
| Byte ranges | 206                      | 200         |

When rc.2 is pinned, both markers must be removed together.

### 2. M8 topology still works

`validate-dual-runtime.sh` was run with `VELASIA_TAG=m9` on 8091/8092. Its results match M8's
[docker-validation-report.md](docker-validation-report.md):

- build ID identical in both images, and no `node` executable in velasia-nextrs;
- PID 1 is `next-server (v16.4.6)` and `nextrs start … --net-allow http://velasia-api:4010 …
--net-allow-addr 172.30.48.0/24`;
- startup to the first healthy response: Node.js 1680 / 461 / 437 ms, NextRS 280 / 165 / 108 ms;
- an invalid variable stops either container with a logged reason (exit 1); NextRS without
  `RETAILING_API_URL` also exits 1;
- SIGTERM with a request in flight: Node.js exits in 423 ms with code 143 (M8: 419 ms, 143),
  NextRS in 453 ms with code 0. The in-flight request returns 200 on both.

### 3. Railway-like stack

`compose.dual-runtime.yaml` + `compose.railway-local.yaml`, with a fresh volume.

The parity suite and `validate-railway-local.sh` were run again on the final NextRS image (the
one with the allowlist warning in `start.sh`): 100 passed, 1 skipped, and every check passed.
That image was also run once in the M8 topology. There it logs the API host
(`172.30.48.2`, allowed `172.30.48.0/24`) with no warning, and both storefronts were ready.
`scripts/docker/validate-railway-local.sh` checks:

| Area               | Observed                                                                                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API privileges     | Container started as uid 0 (the `RAILWAY_RUN_UID=0` equivalent). PID 1 runs as uid/gid `1000:1000`, with `CapEff` `0000000000000000` and `NoNewPrivs` 1. The first-start log reads `database directory /data given to uid 1000 (volume mounted root-owned)`                                                                    |
| Volume             | `/data` is a mount point, `1000:1000` mode 700; `velasia.db` is owned by 1000                                                                                                                                                                                                                                                  |
| Listening          | `Server listening at http://[::]:4010`                                                                                                                                                                                                                                                                                         |
| Private DNS        | `velasia-api.railway.internal` → `172.30.48.2 fd12:7e57:a11::2` (A + AAAA, as in a dual-stack Railway environment). NextRS logged both at startup                                                                                                                                                                              |
| NextRS allowlist   | Both families listed → `/api/internal/health/ready` 200, no warning. IPv6 range only → 503; IPv4 range only → 503 (whole-answer refusal). In both refused cases the start script's warning named the uncovered address                                                                                                         |
| Private API        | No published port. From inside the network: `/health/ready` 200 without a token, `/v1/airports` 401 without and 200 with the service token, `/metrics` 401 with only the service token                                                                                                                                         |
| Secrets            | No file in any of the three images contains the service token, and no image history sets one. The browser bundles contain neither the token's name, the header name, nor the private hostname                                                                                                                                  |
| Persistence        | Record counts before and after `--force-recreate` of the API container were identical: `{"orders":2,"paymentProviderCharges":2,"refundProviderRefunds":0,"accounts":2,"accountSessions":4,"savedTravellers":0,"shoppingSessions":2}`, from the parity runs' bookings. The new container logged `opening the existing database` |
| Guards             | `TALADB_REQUIRE_VOLUME=enabled` without a volume exits 1 with `… is not a mounted volume …`. An unwritable directory exits 1, and the message names `RAILWAY_RUN_UID=0`                                                                                                                                                        |
| Shutdown / restart | API SIGTERM → `shutdown complete`, exit 0. After a full restart, both storefronts report `/api/internal/health/ready` 200                                                                                                                                                                                                      |
| Range discovery    | `node -e … networkInterfaces()` printed `eth0 IPv4 172.30.48.2/24`, `eth0 IPv6 fd12:7e57:a11::2/64`; the `fib_trie` fallback printed `172.30.48.0/24`                                                                                                                                                                          |

**NextRS does not log refused destinations,** even with `RUST_LOG=debug`. The application only
sees a failed fetch, and the readiness route answers `"retailingApi":"unreachable"`. That is why
`docker/nextrs/start.sh` now compares the startup lookup with `NEXTRS_NET_ALLOW_ADDR` and logs a
warning, `retailing API addresses outside NEXTRS_NET_ALLOW_ADDR …`. The comparison is a POSIX awk
CIDR check covering IPv4, IPv6, `::` compression and exact hosts, tested with Debian's mawk.

**The API image under M7 production hardening.** The API was run with `compose.yaml`'s settings:
read-only root, `cap_drop: ALL`, `no-new-privileges`, `init: true` and a named volume. It was
healthy, ran as uid 1000 under `docker-init`, and exited 0 on SIGTERM with `shutdown complete`.
The entrypoint's root branch did not run, because Docker initialises a new named volume with the
image's `node` ownership.

### 4. IaC

- **Typecheck.** `tsc -p .railway` passes. It uses the SDK's declarations and
  `erasableSyntaxOnly`, because the CLI evaluates the file with Node's type stripping.
- **Offline checks.** `node scripts/railway/check-iac.mjs` evaluates the program as the CLI does
  and passes all checks. Its one warning is the bootstrap value: the private IPv4 range is unknown
  until the API runs on Railway.
- **Negative tests.** Each was a modified copy of the file, and each failed with a precise
  message:
  - two replicas;
  - a literal secret;
  - `10.0.0.0/8` in the allowlist;
  - the database off the volume;
  - the wrong Dockerfile;
  - diverging storefront limits;
  - diverging storefront variables, together with a non-https `SITE_URL`.
- **CLI behaviour.** `railway config init` in a scratch directory showed the documented scaffold
  (`railway/iac`, `defineRailway`, `project`, `service`). `railway config plan` without a login
  answered `Not authenticated. Run railway login …`: as documented, no plan can run without an
  account.

### 5. SITE_URL and build artifacts

On Railway each storefront builds separately, each with its own `SITE_URL`. To see what that
changes, the shared build stage was built twice locally, with the same source and arguments
except `SITE_URL`: `https://velasia-a.example.invalid` and `https://velasia-b.example.invalid`.
The two standalone outputs were then compared file by file (sha256):

| Measurement                                                      | Result                                                                                                                                                                 |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build IDs                                                        | `uDLAnkkLAWIsx5ZbD0etv` vs `EEOq5hLfYR_K85zlg4z18` (random per build)                                                                                                  |
| Files                                                            | 2163 vs 2162: one traced `styled-jsx` file only in A; build-ID-named manifests                                                                                         |
| Files with different content                                     | 408 of 2163                                                                                                                                                            |
| Files containing the origin                                      | 132 in each, all server-side: prerendered HTML/RSC, metadata, sitemap, robots, manifests. **No client (`/_next/static`) file contains it**                             |
| Still different after replacing B's origin and build ID with A's | 280 files                                                                                                                                                              |
| Client chunks                                                    | 43 each, of which 30 have the same name; the other 13 have the same size but renumbered Turbopack module IDs (e.g. `e.r(96302)`), so their content-hashed names differ |

**Conclusion.**

- Builds with different `SITE_URL` values produce different artifact hashes, both in the files
  that embed the origin and in the build ID.
- Separate builds also differ beyond `SITE_URL`: the build ID, Turbopack module numbering and
  chunk hashes, per-build preview and Server Action keys, and file tracing.
- The two Railway storefronts will therefore **not** be byte-identical, and no claim is made that
  they are.
- That the remaining 280 differences are build-to-build variation, independent of `SITE_URL`, is
  an inference. It rests on the origin appearing in no client file while client chunks still
  differ. A second build with the same `SITE_URL` was not run.
- Comparability rests on: the same commit, the same build arguments apart from `SITE_URL`, the same
  deployment-ID policy, and the same fixture seed and date. It does not rest on identical bytes.

(Locally, both images come from one BuildKit build and share build ID `94EitfUHzCci3XNiyXIMI`.
That is a property of the local setup, not of Railway.)

### 6. Other checks

- **The build-time API stops after the build.** `with-retailing-api.mjs` was run around a command:
  the API answered 200 during the command, and afterwards nothing listened and no API process was
  left.
- **Build-time addresses don't leak.** The only `127.0.0.1:4010` in the server output is the
  app's own default in `env.ts` (4 bundles). Production startup requires `RETAILING_API_URL` to
  be set, and no client file mentions the address.

## Not validated

These need a Railway account, or rc.2:

- The `[SDK]` IaC keys: whether Railway honours them, and the units of `limitOverride`.
  - Keys: Dockerfile builder/path, CPU/memory limits, restart policy, serverless off, CDN off.
  - First `railway config plan`; see [railway.md](railway.md#iac-coverage).
- The region ID form `asia-southeast1-eqsg3a` in `replicas`.
- `SITE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}` resolving at build time, with
  `${{velasia-api.RAILWAY_PRIVATE_DOMAIN}}`/`PORT` composed in one value.
- Railway's real private IPv4 range, the IPv6 prefix, and DNS answers.
- `RAILWAY_RUN_UID=0` with the root-owned volume on Railway. The local emulation reproduces the
  documented behaviour, not Railway itself.
- Railway's health checker (`healthcheck.railway.app`), draining, and the volume redeploy downtime.
- Edge behaviour: compression with the CDN off, headers, HTTP/2.
- **rc.2 features:** gzip from NextRS, the bounded compression cache, static ranges, and the
  deployment ID. All are blocked until `@nextrs/cli@0.1.0-rc.2` is published. The rc.1 build guard
  and the two expected-failure markers stay until then.
