import {
  MAX_STOPS,
  UNRESOLVED_REFUND_STATUSES,
  formatTravelDate,
  isIsoDate,
  type AncillaryPurchase,
  type CancellationQuote,
  type ChangeSearchRequest,
  type ChangeSearchResult,
  type ConfirmAncillaryPurchaseRequest,
  type ConfirmCancellationRequest,
  type ConfirmChangeRequest,
  type ConfirmSeatChangeRequest,
  type OrderAncillaries,
  type OrderSeatMap,
  type SeatChange,
  type ServicingOperation,
  type ServicingOverview,
  type ServicingPaymentRequest,
  type ServicingQuote,
  type SimulatedOutcome,
} from '@velasia/contracts';
import { seatPricing, seatTravellers } from '../booking/booking';
import { crashIf, type CrashPoint } from '../crash';
import {
  MAX_REFUND_ATTEMPTS,
  MAX_SERVICING_OPERATIONS,
  MAX_SERVICING_PAYMENT_ATTEMPTS,
  type StoredAttempt,
  type StoredOrder,
  type StoredRefund,
  type StoredServicing,
} from '../db/schema';
import { fareRules } from '../fixtures/fare-families';
import type { RetailingResult, RetailingService } from '../offers/retailing-service';
import type { Scenario } from '../offers/scenario';
import { canAccess, type Principal } from '../orders/access';
import { formatPesos } from '../orders/format';
import { hashOf, newId } from '../orders/ids';
import { isUnresolved } from '../orders/lifecycle';
import type { OrderStore } from '../orders/order-store';
import type { ChargeAnswer, PaymentSimulator } from '../orders/payment-simulator';
import type { RefundAnswer, RefundSimulator } from '../orders/refund-simulator';
import {
  cancelBooking,
  confirmServicingPayment,
  endOperation,
  failServicingPayment,
  findOperation,
  markServicingUndecided,
  openOperation,
  pendingOperation,
  retryRefund,
  setRefund,
  startServicingAttempt,
} from '../orders/servicing-lifecycle';
import { buildCandidates, resolveCandidate } from '../search/itineraries';
import type { FlightService } from '../services/flights';
import { moneyOf } from './money';
import { legFor, orderTrip, type OrderTrip } from './order-trip';
import {
  ancillaryView,
  cancelAvailability,
  changeAvailability,
  isQuoteFailure,
  modifiable,
  quoteAncillaries,
  quoteCancellation,
  quoteChange,
  quoteSeats,
  seatClosesAt,
  seatMapNow,
  type CancellationComputed,
  type Computed,
  type QuoteContext,
  type QuoteFailure,
} from './quotes';

/*
 * Order servicing (Milestone 6): flight changes, seat changes, services, and cancellations of a
 * confirmed booking, with their simulated payments and refunds.
 *
 * Every confirmation runs the M5 protocol, so the slow provider call never holds the writer:
 *
 *   A. (queue) authorise; replay a known idempotency key; check the order revision the traveller
 *      saw; re-price from scratch (quotes are never trusted or stored) and compare with the
 *      accepted amount; check inventory; then write ONE document: the operation, its claim on any
 *      replacement inventory, and its first payment attempt (PROCESSING) — or, with nothing to
 *      pay, the change itself (and its refund as PROCESSING). The booking's own seats stay
 *      committed until a change is applied.
 *   B. (no queue) ask the simulated provider (payment or refund); it records its answer first.
 *   C. (queue) apply the answer in one write: a successful payment applies the change and commits
 *      the claim; a decline leaves the booking exactly as it was.
 *
 * Recovery (`reconcile`, at startup and in the sweep, and `refreshStatus`) finishes what a
 * stopped process left: undecided payments are looked up (no record and nothing in flight ⇒
 * never charged ⇒ the attempt fails), refunds are looked up and, if the provider never received
 * one, sent again under the same id (idempotent), and claims that ended are released. It never
 * invents a successful payment or refund.
 */

export interface ServicingConfig {
  /** How long replacement inventory is claimed while a change waits for its payment. */
  claimMs: number;
  outcomeControls: boolean;
}

type Failure = Extract<RetailingResult<never>, { ok: false }>;
const fail = (
  status: Failure['status'],
  code: Failure['code'],
  message: string,
  path?: string,
): Failure => ({
  ok: false,
  status,
  code,
  message,
  ...(path ? { path } : {}),
});
const NOT_FOUND = () => fail(404, 'ORDER_NOT_FOUND', 'We couldn’t find this booking.');
const NEVER_CHARGED =
  'The payment didn’t reach the provider, so nothing was charged. You can try again.';

export interface ServicingOutcome {
  order: StoredOrder;
  operation: StoredServicing;
  replayed: boolean;
}

interface ConfirmInput {
  idempotencyKey: string;
  expectedRevision: number;
  acceptedAmountMinor: number;
  payment?: { method: StoredAttempt['method']; simulatedOutcome?: SimulatedOutcome };
  simulatedRefundOutcome?: SimulatedOutcome;
}

const itemsTotal = (order: Pick<StoredOrder, 'current'>) =>
  order.current.items.reduce((sum, item) => sum + item.amountMinor, 0);

export function createServicingService({
  store,
  flights,
  retailing,
  provider,
  refunds,
  config,
  log,
}: {
  store: OrderStore;
  flights: FlightService;
  retailing: Pick<RetailingService, 'now' | 'businessNow' | 'pricingContext' | 'offerValidityMs'>;
  provider: PaymentSimulator;
  refunds: RefundSimulator;
  config: ServicingConfig;
  log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}) {
  const { repository, queue, ledger } = store;

  function context(scenario?: Scenario): QuoteContext {
    const inventory = flights.current();
    return {
      now: retailing.now(scenario),
      businessNow: retailing.businessNow(scenario),
      pricing: retailing.pricingContext(scenario),
      inventory,
      seed: inventory.seed,
      offerValidityMs: retailing.offerValidityMs,
    };
  }

  const tripOf = (order: StoredOrder) => orderTrip(order, flights.current());

  /** The order if this principal may open it, expired first if due; otherwise like unknown. */
  async function owned(orderId: string, principal: Principal, now: number) {
    const order = await store.readCurrent(orderId, now);
    return order && canAccess(order, principal) ? order : null;
  }

  // -------------------------------------------------------------------------
  // Applying provider answers (inside the queue; idempotent)
  // -------------------------------------------------------------------------

  async function applyCharge(
    order: StoredOrder,
    operationId: string,
    attemptId: string,
    answer: ChargeAnswer | { kind: 'missing' },
    now: number,
  ): Promise<StoredOrder> {
    const op = findOperation(order, operationId);
    const attempt = op?.attempts.find((candidate) => candidate.attemptId === attemptId);
    if (!op || !attempt || !isUnresolved(attempt)) return order;
    let next: StoredOrder;
    if (answer.kind === 'timeout') {
      next = markServicingUndecided(order, operationId, attemptId, 'UNKNOWN', now);
    } else if (answer.kind === 'missing') {
      next = failServicingPayment(order, operationId, attemptId, NEVER_CHARGED, now);
    } else {
      const { charge } = answer;
      if (charge.amountMinor !== attempt.amountMinor || charge.orderId !== order.orderId) {
        throw new Error(`Provider charge ${charge.reference} doesn’t match its change.`);
      }
      next =
        charge.status === 'SUCCEEDED'
          ? confirmServicingPayment(order, operationId, attemptId, charge.reference, now)
          : charge.status === 'DECLINED'
            ? failServicingPayment(
                order,
                operationId,
                attemptId,
                charge.declineReason ?? 'Declined.',
                now,
                charge.reference,
              )
            : markServicingUndecided(
                order,
                operationId,
                attemptId,
                'PENDING',
                now,
                charge.reference,
              );
    }
    const stored = await store.write(order, next);
    const after = findOperation(stored, operationId)!;
    if (after.status === 'COMPLETED' && op.status !== 'COMPLETED') {
      log?.info({ orderId: order.orderId, operation: op.operation }, 'servicing completed');
    }
    return stored;
  }

  async function applyRefund(
    order: StoredOrder,
    operationId: string,
    refundId: string,
    answer: RefundAnswer,
    now: number,
  ): Promise<StoredOrder> {
    const refund = findOperation(order, operationId)?.refunds.find((r) => r.refundId === refundId);
    if (!refund || !UNRESOLVED_REFUND_STATUSES.includes(refund.status)) return order;
    if (answer.kind === 'timeout') {
      return store.write(
        order,
        setRefund(order, operationId, refundId, { status: 'UNKNOWN' }, now),
      );
    }
    const { refund: record } = answer;
    if (record.amountMinor !== refund.amountMinor || record.orderId !== order.orderId) {
      throw new Error(`Provider refund ${record.reference} doesn’t match its booking.`);
    }
    const change =
      record.status === 'SUCCEEDED'
        ? {
            status: 'SUCCEEDED' as const,
            providerReference: record.reference,
            completedAt: now,
            failureReason: null,
          }
        : record.status === 'FAILED'
          ? {
              status: 'FAILED' as const,
              providerReference: record.reference,
              completedAt: now,
              failureReason: record.failureReason,
            }
          : { status: 'PENDING' as const, providerReference: record.reference };
    return store.write(order, setRefund(order, operationId, refundId, change, now));
  }

  /** Send a refund (outside the queue), then apply the answer (inside it). */
  async function sendRefund(
    orderId: string,
    operationId: string,
    refund: StoredRefund,
    crashAt?: CrashPoint | null,
    scenario?: Scenario,
  ) {
    const answer = await refunds.refund(
      {
        refundId: refund.refundId,
        orderId,
        amountMinor: refund.amountMinor,
        currency: refund.currency,
        outcome: refund.simulatedOutcome ?? 'SUCCESS',
      },
      crashAt,
    );
    return queue.run(async () => {
      const latest = (await repository.byId(orderId))!;
      return applyRefund(latest, operationId, refund.refundId, answer, retailing.now(scenario));
    });
  }

  async function sendCharge(
    order: StoredOrder,
    operationId: string,
    attempt: StoredAttempt,
    outcome: SimulatedOutcome,
    crashAt?: CrashPoint | null,
    scenario?: Scenario,
  ) {
    const answer = await provider.charge(
      {
        attemptId: attempt.attemptId,
        orderId: order.orderId,
        amountMinor: attempt.amountMinor,
        currency: attempt.currency,
        method: attempt.method,
        outcome,
      },
      crashAt,
    );
    return queue.run(async () => {
      const latest = (await repository.byId(order.orderId))!;
      return applyCharge(latest, operationId, attempt.attemptId, answer, retailing.now(scenario));
    });
  }

  /**
   * Decide what can be decided from durable records (inside the queue): undecided servicing
   * payments and refunds are looked up; ended claims are released. Returns refunds the provider
   * never received, to send again after the queue task (same id: idempotent).
   */
  async function resolve(order: StoredOrder, now: number) {
    let current = order;
    const resend: { operationId: string; refund: StoredRefund }[] = [];
    for (const op of order.servicing) {
      const attempt = op.attempts.find(isUnresolved);
      if (attempt) {
        const charge = await provider.lookup(attempt.attemptId);
        if (charge) {
          current = await applyCharge(
            current,
            op.operationId,
            attempt.attemptId,
            { kind: 'answered', charge },
            now,
          );
        } else if (!provider.isInFlight(attempt.attemptId)) {
          current = await applyCharge(
            current,
            op.operationId,
            attempt.attemptId,
            { kind: 'missing' },
            now,
          );
        }
      }
      for (const refund of op.refunds) {
        if (!UNRESOLVED_REFUND_STATUSES.includes(refund.status)) continue;
        const record = await refunds.lookup(refund.refundId);
        if (record) {
          current = await applyRefund(
            current,
            op.operationId,
            refund.refundId,
            { kind: 'answered', refund: record },
            now,
          );
        } else if (!refunds.isInFlight(refund.refundId)) {
          resend.push({ operationId: op.operationId, refund });
        }
      }
    }
    current = await store.expireIfDue(current, now);
    return { order: current, resend };
  }

  // -------------------------------------------------------------------------
  // The shared confirmation protocol
  // -------------------------------------------------------------------------

  async function confirm(
    operation: ServicingOperation,
    orderId: string,
    principal: Principal,
    input: ConfirmInput,
    requestHash: string,
    compute: (order: StoredOrder, trip: OrderTrip, ctx: QuoteContext) => QuoteFailure | Computed,
    scenario?: Scenario,
    crashAt?: CrashPoint | null,
  ): Promise<RetailingResult<ServicingOutcome>> {
    if (
      (input.payment?.simulatedOutcome || input.simulatedRefundOutcome) &&
      !config.outcomeControls
    ) {
      return fail(400, 'BAD_REQUEST', 'Choosing a simulated outcome isn’t available here.');
    }
    type Started = ServicingOutcome & {
      attempt: StoredAttempt | null;
      refund: StoredRefund | null;
    };
    const started = await queue.run(async (): Promise<RetailingResult<Started>> => {
      const ctx = context(scenario);
      const found = await repository.byId(orderId);
      if (!found || !canAccess(found, principal)) return NOT_FOUND();
      const replay = found.servicing.find((op) => op.idempotencyKey === input.idempotencyKey);
      if (replay) {
        if (replay.requestHash !== requestHash) {
          return fail(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This request was already used for a different change. Please reload.',
          );
        }
        return {
          ok: true,
          value: { order: found, operation: replay, replayed: true, attempt: null, refund: null },
        };
      }
      // A revision from before this request's own housekeeping (an ended claim) still counts.
      if (input.expectedRevision !== found.rev) {
        return fail(
          409,
          'SERVICING_CONFLICT',
          'Your booking was changed in another window or tab. We’ve loaded the latest version.',
        );
      }
      const order = await store.expireIfDue(found, ctx.now);
      if (order.servicing.length >= MAX_SERVICING_OPERATIONS) {
        return fail(
          409,
          'LIMIT_REACHED',
          'This booking has reached the number of online changes allowed in this demo.',
        );
      }
      const computed = compute(order, tripOf(order), ctx);
      if (isQuoteFailure(computed)) return computed;
      const { quote } = computed;
      if (quote.netMinor !== input.acceptedAmountMinor) {
        return fail(
          409,
          'PRICE_CHANGED',
          `The price of this change is now ${describe(quote)} instead of what you saw. Review it before you confirm.`,
        );
      }
      const charge = quote.adjustment.kind === 'CHARGE';
      if (charge && !input.payment) {
        return fail(
          400,
          'BAD_REQUEST',
          'Choose a demo payment method to pay for this change.',
          'payment',
        );
      }
      const operationId = newId('svc');
      const attempt: StoredAttempt | null = charge
        ? {
            attemptId: newId('pay'),
            idempotencyKey: input.idempotencyKey,
            requestHash: hashOf({
              method: input.payment!.method,
              outcome: input.payment!.simulatedOutcome ?? 'SUCCESS',
            }),
            method: input.payment!.method,
            simulatedOutcome: input.payment!.simulatedOutcome ?? null,
            amountMinor: quote.adjustment.amountMinor,
            currency: order.currency,
            status: 'PROCESSING',
            createdAt: ctx.now,
            startedAtWall: Date.now(),
            completedAt: null,
            failureReason: null,
            providerReference: null,
          }
        : null;
      const refund: StoredRefund | null =
        quote.adjustment.kind === 'REFUND'
          ? {
              refundId: newId('rfd'),
              amountMinor: quote.adjustment.amountMinor,
              currency: order.currency,
              status: 'PROCESSING',
              createdAt: ctx.now,
              startedAtWall: Date.now(),
              completedAt: null,
              failureReason: null,
              providerReference: null,
              simulatedOutcome: input.simulatedRefundOutcome ?? null,
            }
          : null;
      const op: StoredServicing = {
        operationId,
        operation,
        status: 'COMPLETED',
        idempotencyKey: input.idempotencyKey,
        requestHash,
        request: computed.request,
        summary: computed.summary,
        createdAt: ctx.now,
        updatedAt: ctx.now,
        completedAt: null,
        previousRevision: found.rev,
        newRevision: null,
        lines: quote.lines,
        priceDifferenceMinor: quote.priceDifferenceMinor,
        adjustment: quote.adjustment,
        valueDeltaMinor: computed.plan ? itemsTotal(computed.plan) - itemsTotal(order) : 0,
        plan: computed.plan,
        claim:
          charge && computed.claim.length > 0
            ? {
                status: 'HELD',
                createdAt: ctx.now,
                expiresAt: ctx.now + config.claimMs,
                releasedAt: null,
                allocations: computed.claim,
              }
            : null,
        attempts: [],
        refunds: refund ? [refund] : [],
        failureReason: null,
      };
      const next =
        operation === 'CANCEL_ORDER'
          ? cancelBooking(order, op, ctx.now)
          : openOperation(order, op, ctx.now, attempt);
      const stored = await store.write(order, next);
      crashIf(
        crashAt,
        operation === 'CANCEL_ORDER' ? 'cancel:after-commit' : 'servicing:after-intent',
      );
      return {
        ok: true,
        value: {
          order: stored,
          operation: findOperation(stored, operationId)!,
          replayed: false,
          attempt,
          refund,
        },
      };
    });
    if (!started.ok) return started;
    if (started.value.replayed) {
      const { order, operation: op } = started.value;
      return { ok: true, value: { order, operation: op, replayed: true } };
    }
    const { attempt, refund, operation: op } = started.value;
    let order = started.value.order;
    if (attempt) {
      order = await sendCharge(
        order,
        op.operationId,
        attempt,
        input.payment!.simulatedOutcome ?? 'SUCCESS',
        crashAt,
        scenario,
      );
    } else if (refund) {
      order = await sendRefund(orderId, op.operationId, refund, crashAt, scenario);
    }
    crashIf(
      crashAt,
      operation === 'CANCEL_ORDER' ? 'cancel:before-response' : 'servicing:after-commit',
    );
    return {
      ok: true,
      value: { order, operation: findOperation(order, op.operationId)!, replayed: false },
    };
  }

  function describe(quote: ServicingQuote) {
    const { kind, amountMinor } = quote.adjustment;
    if (kind === 'CHARGE') return `${formatPesos(amountMinor)} to pay`;
    if (kind === 'REFUND') return `${formatPesos(amountMinor)} to refund`;
    if (kind === 'CREDIT') return `${formatPesos(amountMinor)} in travel credit`;
    return 'no charge';
  }

  /** Quote outside the queue (reads only). */
  async function quote<T>(
    orderId: string,
    principal: Principal,
    scenario: Scenario | undefined,
    crashAt: CrashPoint | null | undefined,
    compute: (order: StoredOrder, trip: OrderTrip, ctx: QuoteContext) => QuoteFailure | T,
  ): Promise<RetailingResult<{ order: StoredOrder; result: T }>> {
    const ctx = context(scenario);
    const order = await owned(orderId, principal, ctx.now);
    if (!order) return NOT_FOUND();
    const result = compute(order, tripOf(order), ctx);
    if (isQuoteFailure(result)) return result;
    crashIf(crashAt, 'servicing:after-quote');
    return { ok: true, value: { order, result } };
  }

  function cancellationQuoteFor(
    order: StoredOrder,
    trip: OrderTrip,
    ctx: QuoteContext,
  ): QuoteFailure | CancellationComputed {
    if (order.servicingState === 'REFUND_PENDING') {
      return fail(
        409,
        'REFUND_PENDING',
        'A refund on this booking is still being processed. Check its status first.',
      );
    }
    const money = moneyOf(order);
    return quoteCancellation(order, trip, ctx, money.refundableCeilingMinor, money.creditMinor);
  }

  const toCancellationQuote = (
    computed: CancellationComputed,
    order: StoredOrder,
  ): CancellationQuote => ({
    ...computed.quote,
    paidMinor: moneyOf(order).paidMinor,
    refundMinor: computed.refundMinor,
    nonRefundableMinor: computed.nonRefundableMinor,
    feeMinor: computed.feeMinor,
  });

  return {
    /** What the booking allows right now, action by action. */
    async overview(
      orderId: string,
      principal: Principal,
      scenario?: Scenario,
    ): Promise<RetailingResult<{ order: StoredOrder; servicing: ServicingOverview }>> {
      const ctx = context(scenario);
      const order = await owned(orderId, principal, ctx.now);
      if (!order) return NOT_FOUND();
      const trip = tripOf(order);
      const blocked = modifiable(order);
      const iso = (ms: number) => new Date(ms).toISOString();
      const closed = (reason: string) => ({ allowed: false, reason, closesAt: null });
      const seatFlights = trip.legs
        .flatMap((leg) => leg.segments)
        .filter((segment) => ctx.businessNow < seatClosesAt(segment));
      const extras = ancillaryView(order, trip, ctx).offers.some(
        (offer) => !offer.unavailableReason,
      );
      const cancel = cancelAvailability(order, trip, ctx.businessNow);
      const refundPending = order.servicingState === 'REFUND_PENDING';
      return {
        ok: true,
        value: {
          order,
          servicing: {
            changeFlight: trip.legs.map((leg) => {
              const availability = changeAvailability(leg, ctx.businessNow);
              return {
                direction: leg.direction,
                family: leg.family.code,
                feePerTravellerMinor: leg.family.rules.change.feePerTravellerMinor,
                allowed: !blocked && availability.allowed,
                reason: blocked?.message ?? availability.reason,
                closesAt: iso(availability.closesAt),
              };
            }),
            seats: blocked
              ? closed(blocked.message)
              : seatFlights.length
                ? {
                    allowed: true,
                    reason: null,
                    closesAt: iso(Math.max(...seatFlights.map(seatClosesAt))),
                  }
                : closed('Seat selection has closed for every flight in this booking.'),
            extras: blocked
              ? closed(blocked.message)
              : extras
                ? { allowed: true, reason: null, closesAt: null }
                : closed('No more services can be added to this booking.'),
            cancel:
              blocked || refundPending
                ? closed(blocked?.message ?? 'A refund on this booking is still being processed.')
                : { ...cancel, closesAt: iso(cancel.closesAt) },
            rules: trip.legs.map((leg) => ({ ...fareRules(leg.family), direction: leg.direction })),
            pendingOperationId: pendingOperation(order)?.operationId ?? null,
            refundPending,
          },
        },
      };
    },

    /** Replacement flights for one direction on one date, each with its change quote. */
    async changeSearch(
      orderId: string,
      principal: Principal,
      request: ChangeSearchRequest,
      scenario?: Scenario,
      crashAt?: CrashPoint | null,
    ): Promise<RetailingResult<ChangeSearchResult>> {
      const found = await quote(
        orderId,
        principal,
        scenario,
        crashAt,
        (order, trip, ctx): QuoteFailure | ChangeSearchResult => {
          const refused = modifiable(order);
          if (refused) return refused;
          const leg = trip.legs.find((candidate) => candidate.direction === request.direction);
          if (!leg)
            return fail(
              422,
              'CHANGE_NOT_ALLOWED',
              'This booking has no return flight to change.',
              'direction',
            );
          const availability = changeAvailability(leg, ctx.businessNow);
          if (!availability.allowed) return fail(409, 'CHANGE_NOT_ALLOWED', availability.reason!);
          const { inventory } = ctx;
          const today = inventory.referenceDate;
          if (
            !isIsoDate(request.date) ||
            request.date < today ||
            !inventory.isWithinSchedule(request.date)
          ) {
            return fail(
              422,
              'CHANGE_NOT_ALLOWED',
              `Choose a date between ${formatTravelDate(today)} and ${formatTravelDate(inventory.scheduleEndDate)}.`,
              'date',
            );
          }
          const candidates = buildCandidates(
            inventory,
            leg.journey.itinerary.origin,
            leg.journey.itinerary.destination,
            request.date,
            MAX_STOPS,
          )
            .filter((candidate) =>
              candidate.segments.every((segment) => segment.status === 'scheduled'),
            )
            .sort(
              (a, b) =>
                a.segments[0]!.departureUtc - b.segments[0]!.departureUtc ||
                a.id.localeCompare(b.id),
            )
            .slice(0, 24);
          const alternatives = [];
          let lastReason: string | null = null;
          for (const candidate of candidates) {
            if (candidate.id === leg.journey.itinerary.id) continue;
            const computed = quoteChange(order, trip, request.direction, candidate, ctx);
            if (isQuoteFailure(computed)) {
              lastReason = computed.message;
              continue;
            }
            const journey = computed.plan!.current.journeys.find(
              (j) => j.direction === request.direction,
            )!;
            alternatives.push({
              itineraryId: candidate.id,
              itinerary: journey.itinerary,
              price: journey.price,
              quote: computed.quote,
            });
          }
          return {
            direction: request.direction,
            date: request.date,
            current: leg.journey,
            alternatives,
            emptyReason:
              alternatives.length > 0
                ? null
                : candidates.length === 0
                  ? `Velasia doesn’t fly ${leg.journey.itinerary.origin} → ${leg.journey.itinerary.destination} on ${formatTravelDate(request.date)}.`
                  : (lastReason ?? 'No other flight can be booked for your party on this date.'),
            family: leg.family.code,
          };
        },
      );
      return found.ok ? { ok: true, value: found.value.result } : found;
    },

    confirmChange(
      orderId: string,
      principal: Principal,
      request: ConfirmChangeRequest,
      scenario?: Scenario,
      crashAt?: CrashPoint | null,
    ) {
      const requestHash = hashOf({
        op: 'CHANGE_FLIGHT',
        direction: request.direction,
        itineraryId: request.itineraryId,
        accepted: request.acceptedAmountMinor,
        payment: request.payment ?? null,
      });
      return confirm(
        'CHANGE_FLIGHT',
        orderId,
        principal,
        request,
        requestHash,
        (order, trip, ctx) => {
          const candidate = resolveCandidate(ctx.inventory, request.itineraryId);
          if (!candidate)
            return fail(
              404,
              'INVENTORY_UNAVAILABLE',
              'This flight is no longer available.',
              'itineraryId',
            );
          return quoteChange(order, trip, request.direction, candidate, ctx);
        },
        scenario,
        crashAt,
      );
    },

    /** A flight's seat map for the booking's owner: their own seats show as theirs. */
    async seatMap(
      orderId: string,
      principal: Principal,
      flightId: string,
      scenario?: Scenario,
    ): Promise<RetailingResult<OrderSeatMap>> {
      const ctx = context(scenario);
      const order = await owned(orderId, principal, ctx.now);
      if (!order) return NOT_FOUND();
      const trip = tripOf(order);
      const located = legFor(trip, flightId);
      if (!located) return fail(404, 'NOT_FOUND', 'This flight isn’t part of your booking.');
      const { leg, segment } = located;
      const own = ledger.ownSeatIds(order.orderId, segment.id);
      const map = seatMapNow(segment, ctx);
      const seatMap = {
        ...map,
        cabins: map.cabins.map((cabin) => ({
          ...cabin,
          rows: cabin.rows.map((row) => ({
            ...row,
            seats: row.seats.map((seat) =>
              seat && own.has(seat.id)
                ? { ...seat, status: 'AVAILABLE' as const, unavailableReason: null }
                : seat,
            ),
          })),
        })),
      };
      const seats = order.current.seats.filter((seat) => seat.flightId === flightId);
      return {
        ok: true,
        value: {
          seatMap,
          direction: leg.direction,
          fare: { family: leg.family.code, cabin: leg.family.cabin },
          currency: order.currency,
          pricing: seatPricing(leg, segment),
          travellers: seatTravellers({ passengers: order.snapshot.passengers }, trip.slots),
          assignments: seats,
          paid: trip.slots.map((slot) => ({
            travellerId: slot.id,
            amountMinor:
              order.current.items.find((item) => item.id === `seat-${slot.id}-${flightId}`)
                ?.amountMinor ?? 0,
          })),
          closesAt: new Date(seatClosesAt(segment)).toISOString(),
        },
      };
    },

    async seatQuote(
      orderId: string,
      principal: Principal,
      changes: SeatChange[],
      scenario?: Scenario,
      crashAt?: CrashPoint | null,
    ) {
      const found = await quote(orderId, principal, scenario, crashAt, (order, trip, ctx) =>
        quoteSeats(order, trip, changes, ctx, ledger),
      );
      return found.ok ? { ok: true as const, value: found.value.result.quote } : found;
    },

    confirmSeats(
      orderId: string,
      principal: Principal,
      request: ConfirmSeatChangeRequest,
      scenario?: Scenario,
      crashAt?: CrashPoint | null,
    ) {
      const requestHash = hashOf({
        op: 'CHANGE_SEAT',
        changes: request.changes,
        accepted: request.acceptedAmountMinor,
        payment: request.payment ?? null,
      });
      return confirm(
        'CHANGE_SEAT',
        orderId,
        principal,
        request,
        requestHash,
        (order, trip, ctx) => quoteSeats(order, trip, request.changes, ctx, ledger),
        scenario,
        crashAt,
      );
    },

    async ancillaries(
      orderId: string,
      principal: Principal,
      scenario?: Scenario,
    ): Promise<RetailingResult<OrderAncillaries>> {
      const ctx = context(scenario);
      const order = await owned(orderId, principal, ctx.now);
      if (!order) return NOT_FOUND();
      return { ok: true, value: ancillaryView(order, tripOf(order), ctx) };
    },

    async ancillaryQuote(
      orderId: string,
      principal: Principal,
      changes: AncillaryPurchase[],
      scenario?: Scenario,
      crashAt?: CrashPoint | null,
    ) {
      const found = await quote(orderId, principal, scenario, crashAt, (order, trip, ctx) =>
        quoteAncillaries(order, trip, changes, ctx),
      );
      return found.ok ? { ok: true as const, value: found.value.result.quote } : found;
    },

    confirmAncillaries(
      orderId: string,
      principal: Principal,
      request: ConfirmAncillaryPurchaseRequest,
      scenario?: Scenario,
      crashAt?: CrashPoint | null,
    ) {
      const requestHash = hashOf({
        op: 'ADD_ANCILLARY',
        changes: request.changes,
        accepted: request.acceptedAmountMinor,
        payment: request.payment ?? null,
      });
      return confirm(
        'ADD_ANCILLARY',
        orderId,
        principal,
        request,
        requestHash,
        (order, trip, ctx) => quoteAncillaries(order, trip, request.changes, ctx),
        scenario,
        crashAt,
      );
    },

    async cancellationQuote(
      orderId: string,
      principal: Principal,
      scenario?: Scenario,
      crashAt?: CrashPoint | null,
    ): Promise<RetailingResult<CancellationQuote>> {
      const found = await quote(orderId, principal, scenario, crashAt, cancellationQuoteFor);
      return found.ok
        ? { ok: true, value: toCancellationQuote(found.value.result, found.value.order) }
        : found;
    },

    confirmCancellation(
      orderId: string,
      principal: Principal,
      request: ConfirmCancellationRequest,
      scenario?: Scenario,
      crashAt?: CrashPoint | null,
    ) {
      const requestHash = hashOf({ op: 'CANCEL_ORDER', accepted: request.acceptedRefundMinor });
      return confirm(
        'CANCEL_ORDER',
        orderId,
        principal,
        { ...request, acceptedAmountMinor: -request.acceptedRefundMinor },
        requestHash,
        cancellationQuoteFor,
        scenario,
        crashAt,
      );
    },

    /** Pay again for a change whose payment was declined, while its claim lasts. */
    async pay(
      orderId: string,
      principal: Principal,
      operationId: string,
      request: ServicingPaymentRequest,
      scenario?: Scenario,
      crashAt?: CrashPoint | null,
    ): Promise<RetailingResult<ServicingOutcome>> {
      if (request.simulatedOutcome && !config.outcomeControls) {
        return fail(400, 'BAD_REQUEST', 'Choosing a payment outcome isn’t available here.');
      }
      const outcome = request.simulatedOutcome ?? 'SUCCESS';
      const requestHash = hashOf({ method: request.method, outcome });
      const started = await queue.run(
        async (): Promise<
          RetailingResult<ServicingOutcome & { attempt: StoredAttempt | null }>
        > => {
          const now = retailing.now(scenario);
          const found = await repository.byId(orderId);
          if (!found || !canAccess(found, principal)) return NOT_FOUND();
          const op = findOperation(found, operationId);
          if (!op) return NOT_FOUND();
          const replay = op.attempts.find(
            (attempt) => attempt.idempotencyKey === request.idempotencyKey,
          );
          if (replay) {
            if (replay.requestHash !== requestHash)
              return fail(
                409,
                'IDEMPOTENCY_CONFLICT',
                'This payment request was already used with different details. Please reload.',
              );
            return {
              ok: true,
              value: { order: found, operation: op, replayed: true, attempt: null },
            };
          }
          const order = await store.expireIfDue(found, now);
          const current = findOperation(order, operationId)!;
          if (current.status === 'EXPIRED')
            return fail(
              410,
              'HOLD_EXPIRED',
              'This change wasn’t paid in time, so the seats held for it were released. Nothing was charged.',
            );
          if (current.status !== 'AWAITING_PAYMENT')
            return fail(409, 'ORDER_NOT_PAYABLE', 'This change isn’t waiting for a payment.');
          if (current.attempts.some(isUnresolved))
            return fail(
              409,
              'PAYMENT_PENDING',
              'Your last payment for this change is still being processed. Check its status first.',
            );
          if (current.attempts.length >= MAX_SERVICING_PAYMENT_ATTEMPTS)
            return fail(409, 'ORDER_NOT_PAYABLE', 'No payment attempts are left for this change.');
          const attempt: StoredAttempt = {
            attemptId: newId('pay'),
            idempotencyKey: request.idempotencyKey,
            requestHash,
            method: request.method,
            simulatedOutcome: request.simulatedOutcome ?? null,
            amountMinor: current.adjustment.amountMinor,
            currency: order.currency,
            status: 'PROCESSING',
            createdAt: now,
            startedAtWall: Date.now(),
            completedAt: null,
            failureReason: null,
            providerReference: null,
          };
          const stored = await store.write(
            order,
            startServicingAttempt(order, operationId, attempt, now),
          );
          crashIf(crashAt, 'servicing:after-intent');
          return {
            ok: true,
            value: {
              order: stored,
              operation: findOperation(stored, operationId)!,
              replayed: false,
              attempt,
            },
          };
        },
      );
      if (!started.ok) return started;
      if (!started.value.attempt)
        return {
          ok: true,
          value: { order: started.value.order, operation: started.value.operation, replayed: true },
        };
      const order = await sendCharge(
        started.value.order,
        operationId,
        started.value.attempt,
        outcome,
        crashAt,
        scenario,
      );
      crashIf(crashAt, 'servicing:after-commit');
      return {
        ok: true,
        value: { order, operation: findOperation(order, operationId)!, replayed: false },
      };
    },

    /** Give up a change waiting for payment: release its claim. The booking is unchanged. */
    async abandon(
      orderId: string,
      principal: Principal,
      operationId: string,
      scenario?: Scenario,
    ): Promise<RetailingResult<ServicingOutcome>> {
      return queue.run(async () => {
        const now = retailing.now(scenario);
        const found = await repository.byId(orderId);
        if (!found || !canAccess(found, principal)) return NOT_FOUND();
        const order = await store.expireIfDue(found, now);
        const op = findOperation(order, operationId);
        if (!op) return NOT_FOUND();
        if (op.status !== 'AWAITING_PAYMENT')
          return { ok: true, value: { order, operation: op, replayed: true } };
        if (op.attempts.some(isUnresolved))
          return fail(
            409,
            'PAYMENT_PENDING',
            'A payment for this change is still being processed. Check its status first.',
          );
        const stored = await store.write(
          order,
          endOperation(
            order,
            operationId,
            'FAILED',
            'Discarded by the traveller. Nothing was charged.',
            now,
          ),
        );
        return {
          ok: true,
          value: { order: stored, operation: findOperation(stored, operationId)!, replayed: false },
        };
      });
    },

    /** Find out what happened to undecided payments and refunds of this booking. Never pays. */
    async refreshStatus(
      orderId: string,
      principal: Principal,
      scenario?: Scenario,
    ): Promise<RetailingResult<StoredOrder>> {
      const resolved = await queue.run(async () => {
        const found = await repository.byId(orderId);
        if (!found || !canAccess(found, principal)) return null;
        return resolve(found, retailing.now(scenario));
      });
      if (!resolved) return NOT_FOUND();
      let { order } = resolved;
      for (const { operationId, refund } of resolved.resend)
        order = await sendRefund(orderId, operationId, refund, null, scenario);
      return { ok: true, value: order };
    },

    /**
     * Try a refund the simulated provider declined again (same amount, new refund id). Repeating
     * the request is safe: once the new refund is recorded, nothing has failed any more, so a
     * second retry is refused instead of sending a second refund.
     */
    async retryRefund(
      orderId: string,
      principal: Principal,
      simulatedOutcome: SimulatedOutcome | undefined,
      scenario?: Scenario,
    ): Promise<RetailingResult<StoredOrder>> {
      if (simulatedOutcome && !config.outcomeControls)
        return fail(400, 'BAD_REQUEST', 'Choosing a simulated outcome isn’t available here.');
      const started = await queue.run(
        async (): Promise<
          RetailingResult<{ order: StoredOrder; operationId: string; refund: StoredRefund | null }>
        > => {
          const now = retailing.now(scenario);
          const order = await repository.byId(orderId);
          if (!order || !canAccess(order, principal)) return NOT_FOUND();
          const op = order.servicing.find(
            (candidate) =>
              candidate.refunds.at(-1)?.status === 'FAILED' &&
              !candidate.refunds.some((r) => r.status === 'SUCCEEDED'),
          );
          if (!op) {
            return order.servicingState === 'REFUND_PENDING'
              ? fail(409, 'REFUND_PENDING', 'A refund on this booking is still being processed.')
              : fail(409, 'ORDER_NOT_MODIFIABLE', 'There is no failed refund to try again.');
          }
          if (op.refunds.length >= MAX_REFUND_ATTEMPTS)
            return fail(
              409,
              'LIMIT_REACHED',
              'This refund was tried the maximum number of times in this demo.',
            );
          const refund: StoredRefund = {
            refundId: newId('rfd'),
            amountMinor: op.adjustment.amountMinor,
            currency: order.currency,
            status: 'PROCESSING',
            createdAt: now,
            startedAtWall: Date.now(),
            completedAt: null,
            failureReason: null,
            providerReference: null,
            simulatedOutcome: simulatedOutcome ?? null,
          };
          const stored = await store.write(order, retryRefund(order, op.operationId, refund, now));
          return { ok: true, value: { order: stored, operationId: op.operationId, refund } };
        },
      );
      if (!started.ok) return started;
      const order = await sendRefund(
        orderId,
        started.value.operationId,
        started.value.refund!,
        null,
        scenario,
      );
      return { ok: true, value: order };
    },

    /**
     * Startup recovery and periodic sweep for servicing: finish undecided payments and refunds,
     * release ended claims. Reads only durable state; safe to run any number of times.
     */
    async reconcile(now: number) {
      const summary = { payments: 0, refunds: 0, resent: 0, expired: 0 };
      for (const candidate of await repository.withPendingServicing()) {
        const resolved = await queue.run(async () => {
          const before = await repository.byId(candidate.orderId);
          if (!before) return null;
          const result = await resolve(before, now);
          const count = (order: StoredOrder, pick: (op: StoredServicing) => boolean) =>
            order.servicing.filter(pick).length;
          summary.payments +=
            count(before, (op) => op.attempts.some(isUnresolved)) -
            count(result.order, (op) => op.attempts.some(isUnresolved));
          summary.refunds +=
            count(before, (op) =>
              op.refunds.some((r) => UNRESOLVED_REFUND_STATUSES.includes(r.status)),
            ) -
            count(result.order, (op) =>
              op.refunds.some((r) => UNRESOLVED_REFUND_STATUSES.includes(r.status)),
            );
          summary.expired +=
            count(result.order, (op) => op.status === 'EXPIRED') -
            count(before, (op) => op.status === 'EXPIRED');
          return result;
        });
        for (const { operationId, refund } of resolved?.resend ?? []) {
          await sendRefund(candidate.orderId, operationId, refund);
          summary.resent += 1;
        }
      }
      if (summary.payments || summary.refunds || summary.resent || summary.expired)
        log?.info(summary, 'servicing reconciled');
      return summary;
    },

    async events(orderId: string, principal: Principal, scenario?: Scenario) {
      const order = await owned(orderId, principal, retailing.now(scenario));
      return order ? { ok: true as const, value: order } : NOT_FOUND();
    },
  };
}

export type ServicingService = ReturnType<typeof createServicingService>;
