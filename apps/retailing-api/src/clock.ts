import { AIRLINE_TIME_ZONE, todayIn, zonedDateTimeToUtc } from '@velasia/contracts';

/**
 * The API's two meanings of "now" (Milestone 9.3).
 *
 * - **Business time** (`today()`, `businessNow()`): the fictional calendar that inventory,
 *   prices and departure rules are computed against. `VELASIA_TODAY` pins it so schedules,
 *   availability and prerendered pages are deterministic.
 * - **Real time** (`now()`): elapsed time. Every expiry and every stored or displayed
 *   timestamp uses it: offer validity and reuse, shopping-session idle and maximum life,
 *   checkout holds, servicing claims, account sessions, store sweeps, `serverTime`.
 *
 * Before M9.3 a pinned date froze both, so an offer's 60 s reuse window and its 15-minute
 * validity never ended (docs/deployment/known-issue-pinned-clock-offer-expiry.md). With the
 * system clock (no `VELASIA_TODAY`) the two are the same instant, as before.
 *
 * Real time is wall-clock epoch milliseconds, not a monotonic reading: holds, sessions and
 * account sessions are persisted in TalaDB and compared again after a restart, and offer
 * expiry times are shown to clients next to `serverTime`. A monotonic clock restarts with the
 * process, so it cannot be compared with a stored value. A wall-clock step only shifts the
 * windows that are open at that moment by the size of the step.
 */
export interface Clock {
  /** Business date in the airline time zone, `YYYY-MM-DD` (pinned by `VELASIA_TODAY`). */
  today(): string;
  /**
   * Business instant, epoch ms: sales cut-off, departure, check-in and servicing windows, and
   * the seat-map and fare-calendar views of the schedule. A pinned clock reads it as midnight at
   * the start of the pinned day in Manila, so every flight that day is still on sale.
   */
  businessNow(): number;
  /** Real time, epoch ms: every expiry, TTL and timestamp. Never pinned. */
  now(): number;
  /** True when the business date is fixed (tests, demos) rather than read from the system clock. */
  readonly pinned: boolean;
}

/**
 * The system clock, or a pinned business date. `realNow` is the real-time source (tests pass
 * a controllable one; production uses `Date.now`).
 */
export function createClock(pinnedDate?: string, realNow: () => number = Date.now): Clock {
  if (pinnedDate) {
    const midnight = zonedDateTimeToUtc(pinnedDate, '00:00', AIRLINE_TIME_ZONE).getTime();
    return {
      today: () => pinnedDate,
      businessNow: () => midnight,
      now: realNow,
      pinned: true,
    };
  }
  return {
    today: () => todayIn(AIRLINE_TIME_ZONE, new Date(realNow())),
    businessNow: realNow,
    now: realNow,
    pinned: false,
  };
}
