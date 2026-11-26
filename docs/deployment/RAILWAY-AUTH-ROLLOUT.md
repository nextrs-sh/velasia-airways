# Service authentication rollout (plan, not executed)

**Status: proposed, awaiting owner approval.** Production has no `RETAILING_API_SERVICE_TOKEN`
and no `METRICS_TOKEN` (verified 2026-11-26). M9.2 adds tests and this plan only; no variable
was created or changed.

## How the code behaves (already on `main`)

| Component                                                       | With the variable unset (today)                                                                                                                          | With it set                                                                                                                                                                          |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API, `RETAILING_API_SERVICE_TOKEN` (≥ 32 chars)                 | Every caller is answered                                                                                                                                 | Every request except `/health`, `/health/live`, `/health/ready` needs `x-velasia-service-token`; 401 `UNAUTHENTICATED` otherwise. Compared on SHA-256 digests with `timingSafeEqual` |
| API, `METRICS_TOKEN` (≥ 16)                                     | `/metrics` open (on the private network)                                                                                                                 | `/metrics` also needs `Authorization: Bearer <token>`, in addition to the service token                                                                                              |
| Storefronts (Node.js and NextRS), `RETAILING_API_SERVICE_TOKEN` | No header sent                                                                                                                                           | Sent server-side on every API call (`apps/web/src/lib/retailing-api/client.ts`). The NextRS image passes it to JavaScript with `--js-env` only when set                              |
| Storefronts, `METRICS_TOKEN`                                    | `/api/internal/metrics` open                                                                                                                             | Bearer token required                                                                                                                                                                |
| Browser                                                         | Never sees either: no `NEXT_PUBLIC_` names, server-only env module                                                                                       |                                                                                                                                                                                      |
| Docker builds                                                   | No `ARG` with a secret-like name (`pnpm railway:check` enforces it); the build stage sets the token empty and uses its own throwaway API                 |                                                                                                                                                                                      |
| Logs                                                            | Startup logs `serviceToken: required/off`, never the value. Config errors name variables, not values. 401 bodies never echo the presented token (tested) |                                                                                                                                                                                      |

Empty variables count as "not configured" on both sides. A too-short token fails the service's
startup, and the deploy health check then keeps the old deployment serving.

Tests: `apps/retailing-api/test/m8-service-auth.test.ts` (enforcement) and
`m9-auth-rollout.test.ts` (M9.2). The latter covers stage 1 (an API without a token answers
callers that send one), metrics needing both tokens, open health probes, no token echo and
empty-means-unset. `apps/web/test/m8-service-token.test.ts` covers the storefront header.

## Constraints that shape the order

1. **Clients before enforcement.** If the API enforces first, both storefronts get 401 on every
   call until they redeploy.
2. **Setting a variable redeploys that service.** On the API that means **losing its TalaDB data**
   until the [persistence migration](TALADB-PERSISTENCE-MIGRATION.md) is done. Enforcement is
   therefore scheduled after the migration, or deliberately combined with its redeploy.
3. Both storefronts must hold the same token. A shared variable gives one source of truth.
4. The API stays private: no public domain, ever, for benchmarking or otherwise.

## Rollout

**0. Generate outside Git** (owner's machine; never pasted into chat, tickets or files):

```bash
openssl rand -hex 32   # RETAILING_API_SERVICE_TOKEN
openssl rand -hex 24   # METRICS_TOKEN
```

**1. Store** them as project shared variables in the `production` environment (dashboard →
Project Settings → Shared Variables; seal them if the plan offers it). Creating a shared variable
redeploys nothing. Nothing references it yet.

**2. Distribute to the clients (no enforcement yet).** A proposal file
(`.railway/proposals/auth-clients.ts`) adds `RETAILING_API_SERVICE_TOKEN:
ctx.shared.RETAILING_API_SERVICE_TOKEN` and `METRICS_TOKEN: ctx.shared.METRICS_TOKEN` to **both
storefronts**. Its `expectedChanges` are four `variable.set` entries, and the plan gate must pass.
Applying it redeploys both storefronts (env-only, same images). Verify:

- `/api/internal/health/ready` is 200 on both domains;
- `/api/internal/metrics` is 401 without a bearer token and 200 with it (from the runner or an
  owner shell, never in CI logs);
- API traffic still works: the API ignores the header while unconfigured (stage 1, tested).

Rollback: remove the references (destructive `variable.delete` entries, acknowledged in a
rollback proposal).

**3. Enforce on the API** (after the persistence migration, or in its maintenance window). Add
both references to `@velasia/retailing-api` through a proposal, gate it, and apply. That
redeploys the API. Verify:

- startup log `serviceToken: required`;
- both storefronts ready (they send the token);
- a call without the token from the runner gets 401;
- `/health/ready` still answers the deploy health check.

Rollback: remove the API's references (one redeploy). The storefronts keep sending a header the
API then ignores.

**4. Benchmark runner.** Its variables reference the same shared variables
(`${{shared.METRICS_TOKEN}}`, `${{shared.RETAILING_API_SERVICE_TOKEN}}`). `api-gate.mjs` and
`scrape-in-container.cjs` read them from the environment and never print them. The runner stays
on the private network, and the API stays private.

**5. Fold into the baseline.** After each applied stage, move its references into
`.railway/railway.ts` and `scripts/railway/expected-production.mjs` (the secret rule requires
`ctx.shared`/`preserve()`), and delete the proposal.

## Rotation

Change the shared variable's value. That redeploys every service referencing it, in no guaranteed
order, so requests can fail briefly while the API and the storefronts hold different values. For
a zero-failure rotation, the API would need to accept two tokens during the overlap. That is a
code change, not planned yet.

## Findings (not fixed in M9.2)

- The storefront `/api/internal/metrics` and the API `/metrics` bearer checks compare with `!==`
  rather than a constant-time comparison. Low risk (private network, metrics only), but worth
  aligning with the service-token check.
