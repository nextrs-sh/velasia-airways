# Known issue: a pinned business date freezes offer expiry

**Status: fixed in Milestone 9.3** (implemented and tested locally; not yet deployed). The fix
separates business time from real time: [M9.3 benchmark correctness](M9.3-BENCHMARK-CORRECTNESS.md).
The text below is the original M9.1 analysis, kept as found.

## What happens

`VELASIA_TODAY` exists so that inventory, prices and prerendered pages are deterministic: the
"business date" is fixed. `createClock()` (`apps/retailing-api/src/clock.ts`) implements this by
returning a constant `now()`: midnight, Manila time, on that date. Every elapsed-time rule in
the API reads the same `clock.now()`:

| Rule                                                  | Where                                                                                            | Effect with a pinned date                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Offer reuse window (60 s)                             | `searchOffers` in `apps/retailing-api/src/offers/retailing-service.ts` (`offerReuseMs`)          | Never elapses: an offer key is reused for the life of the process |
| Offer validity (`OFFER_VALIDITY_MINUTES`, 15)         | `createOffer` / `offerStatus`                                                                    | Offers never expire                                               |
| Store sweeps (`BoundedStore`, every 10 s)             | `apps/retailing-api/src/offers/bounded-store.ts`                                                 | Run once; after that only size eviction (20,000 entries)          |
| Shopping-session idle and maximum life, holds, sweeps | `retailing-service.ts`, `app.ts` (`sessionCutoff`, order/servicing reconcile, allocation ledger) | Frozen as well: needs its own review when this is fixed           |

So on a deployment with a pinned date, such as Railway and the E2E stack, an offer created
once is handed out indefinitely, and a "price held for 15 minutes" never runs out.

## Why it matters

- **Correctness:** expiry and reuse behave differently with a pinned date than in production
  with the system clock. Tests that pin the date cannot exercise expiry, except through
  scenario offsets (`clockOffsetMs`).
- **Benchmarks:** state created by one runtime's run is reused by the next, which would favour
  whichever runtime runs second. The benchmark counters this with a verified series pre-warm
  and a per-run "no offers created" check.

## Recommended fix (future milestone)

Separate the two meanings of "now":

1. A **business date** (`clock.today()`, and the instant used for sales cut-offs and departure
   checks). It stays pinnable for deterministic inventory and prices.
2. An **elapsed-time source** (a monotonic or wall clock), always real. Offer reuse and
   validity, session idle and maximum life, holds and store sweeps are measured on it.

For example, `now()` = pinned business midnight + (real time elapsed since the process
started), or two separate methods (`businessNow()`, `elapsed()`). Then audit every
`clock.now()` call for which of the two it means. Re-run the offer-expiry, hold-expiry and
session-expiry tests with a pinned date, and update the E2E scenarios that rely on today's
behaviour.

Once fixed, the benchmark pre-warm still matters: offers within the 60 s window are reused,
so a pair must not straddle it unevenly. The benchmark's procedure should then be revisited.
