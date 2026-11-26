import { randomBytes } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import {
  ACCOUNT_RULES,
  type Account,
  type SavedTraveller,
  type SavedTravellerInput,
  type TripSection,
  type TripSummary,
  type TripsResponse,
} from '@velasia/contracts';
import { savedTravellerInputSchema } from '@velasia/contracts';
import type {
  AccountRepository,
  SessionRepository,
  TravellerRepository,
} from '../db/repositories/account-repository';
import type {
  OrderListing,
  OrderRepository,
  TripListSection,
} from '../db/repositories/order-repository';
import {
  ACCOUNT_SCHEMA_VERSION,
  type StoredAccount,
  type StoredSession,
  type StoredTraveller,
} from '../db/schema';
import type { Inventory } from '../inventory/inventory';
import type { RetailingResult } from '../offers/retailing-service';
import { canAccess } from '../orders/access';
import { guestIdFor, newId, sha256Hex } from '../orders/ids';
import { withEvent } from '../orders/lifecycle';
import type { OrderStore } from '../orders/order-store';
import { RateLimiter } from './rate-limiter';

/*
 * Demo customer accounts (Milestone 6).
 *
 * - Passwords: Argon2id (`@node-rs/argon2`, OWASP parameters m=19 MiB, t=2, p=1), hashed outside
 *   the serial writer. An unknown email is verified against a dummy hash, so a sign-in takes the
 *   same time whether or not the account exists, and gets the same answer.
 * - Sessions: 256-bit random tokens; only their SHA-256 hash is stored. A new one at every sign-in
 *   (the one presented, if any, is revoked: rotation), revoked at sign-out, and all of them at a
 *   password change. Absolute lifetime `ACCOUNT_RULES.sessionDays`.
 * - Rate limits: failed sign-ins per email and attempts per client, registrations per client.
 * - Uniqueness (one account per email) is enforced by the serial writer: TalaDB has no unique
 *   index, so the check and the insert run with no other writer in between.
 * - Bookings are never copied into an account. An account owns orders through `ownerAccountId`
 *   on the order itself, set only by linking a booking the same browser already owns as a guest.
 *   A matching email address links nothing.
 *
 * No email is ever sent: addresses are unverified, and there is no password reset.
 */

export interface AccountConfig {
  /** Demo registration open in this environment. */
  registration: boolean;
  sessionMs: number;
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

const INVALID = () => fail(401, 'INVALID_CREDENTIALS', 'The email or password is incorrect.');
const TOO_MANY = () =>
  fail(429, 'RATE_LIMITED', 'Too many attempts. Please wait a few minutes and try again.');
const UNAUTHENTICATED = () => fail(401, 'UNAUTHENTICATED', 'Please sign in again.');
const TRAVELLER_NOT_FOUND = () => fail(404, 'NOT_FOUND', 'We couldn’t find this saved traveller.');
const ORDER_NOT_FOUND = () => fail(404, 'ORDER_NOT_FOUND', 'We couldn’t find this booking.');

const MINUTE = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

export interface AuthenticatedSession {
  account: StoredAccount;
  session: StoredSession;
}

export function toPublicAccount(account: StoredAccount): Account {
  return {
    id: account.accountId,
    email: account.email,
    givenName: account.givenName,
    familyName: account.familyName,
    createdAt: iso(account.createdAt),
    demo: true,
    emailVerified: false,
  };
}

export function toPublicTraveller(traveller: StoredTraveller): SavedTraveller {
  return {
    id: traveller.travellerId,
    title: traveller.title,
    givenName: traveller.givenName,
    middleName: traveller.middleName,
    familyName: traveller.familyName,
    dateOfBirth: traveller.dateOfBirth,
    nationality: traveller.nationality,
    revision: traveller.rev,
    createdAt: iso(traveller.createdAt),
    updatedAt: iso(traveller.updatedAt),
  };
}

const LINKABLE_LIMIT = 20;

export function createAccountService({
  accounts,
  sessions,
  travellers,
  orders,
  store,
  inventory,
  now,
  businessNow = now,
  config,
  log,
}: {
  accounts: AccountRepository;
  sessions: SessionRepository;
  travellers: TravellerRepository;
  orders: OrderRepository;
  store: OrderStore;
  inventory: () => Inventory;
  /** Real time: account sessions and timestamps. */
  now: () => number;
  /** Business time: which trips are upcoming or past (see `clock.ts`). */
  businessNow?: () => number;
  config: AccountConfig;
  log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}) {
  const { queue } = store;
  const failuresByEmail = new RateLimiter(5, 15 * MINUTE);
  const attemptsByClient = new RateLimiter(30, 15 * MINUTE);
  const registrationsByClient = new RateLimiter(10, 60 * MINUTE);
  let dummyHash: Promise<string> | null = null;
  const dummy = () => (dummyHash ??= argonHash(randomBytes(24).toString('base64url')));

  async function issueSession(accountId: string, at: number) {
    const token = randomBytes(32).toString('base64url');
    const session: StoredSession = {
      schemaVersion: ACCOUNT_SCHEMA_VERSION,
      sessionId: newId('ses'),
      tokenHash: sha256Hex(token),
      accountId,
      createdAt: at,
      expiresAt: at + config.sessionMs,
      revokedAt: null,
    };
    await sessions.insert(session);
    return { token, expiresAt: iso(session.expiresAt) };
  }

  async function sessionFor(token: string | undefined): Promise<AuthenticatedSession | null> {
    if (!token) return null;
    const session = await sessions.byTokenHash(sha256Hex(token));
    if (!session || session.revokedAt !== null || now() >= session.expiresAt) return null;
    const account = await accounts.byId(session.accountId);
    return account ? { account, session } : null;
  }

  function tripOf(listing: OrderListing): TripSummary {
    const inv = inventory();
    const { listing: l } = listing;
    return {
      orderId: listing.orderId,
      reference: listing.reference,
      status: listing.status as TripSummary['status'],
      tripType: l.tripType,
      origin: l.origin,
      destination: l.destination,
      departsAt: iso(l.departsAt),
      returnsAt: l.returnsAt === null ? null : iso(l.returnsAt),
      endsAt: iso(l.endsAt),
      families: l.families as TripSummary['families'],
      flightNumbers: l.flightNumbers,
      flightStatus: listing.flightIds.some((id) => inv.getInstance(id)?.status === 'cancelled')
        ? 'disrupted'
        : 'scheduled',
      travellers: l.travellers,
      leadTraveller: l.leadTraveller,
      attention:
        listing.servicingState === 'AWAITING_PAYMENT'
          ? 'A change is waiting for payment'
          : listing.servicingState === 'REFUND_PENDING'
            ? 'Refund in progress'
            : null,
      currentTotalMinor: l.currentTotalMinor,
      currency: l.currency,
    };
  }

  return {
    sessionFor,

    async register(
      input: { email: string; password: string; givenName: string; familyName: string },
      clientKey: string,
    ): Promise<
      RetailingResult<{ account: Account; session: { token: string; expiresAt: string } }>
    > {
      if (!config.registration) {
        return fail(
          403,
          'REGISTRATION_DISABLED',
          'Demo account registration is switched off here.',
        );
      }
      const at = now();
      if (registrationsByClient.blocked(clientKey, at)) return TOO_MANY();
      registrationsByClient.hit(clientKey, at);
      // CPU-heavy hashing happens before the writer is taken, never inside it.
      const passwordHash = await argonHash(input.password);
      return queue.run(async () => {
        if (await accounts.byEmail(input.email)) {
          return fail(
            409,
            'ACCOUNT_EXISTS',
            'An account with this email already exists. Sign in instead.',
            'email',
          );
        }
        const account: StoredAccount = {
          schemaVersion: ACCOUNT_SCHEMA_VERSION,
          accountId: newId('acc'),
          email: input.email,
          givenName: input.givenName,
          familyName: input.familyName,
          passwordHash,
          createdAt: at,
          updatedAt: at,
          rev: 1,
        };
        await accounts.insert(account);
        const session = await issueSession(account.accountId, at);
        log?.info({ accountId: account.accountId }, 'demo account registered');
        return { ok: true, value: { account: toPublicAccount(account), session } };
      });
    },

    async signIn(
      input: { email: string; password: string },
      clientKey: string,
      previousToken: string | undefined,
    ): Promise<
      RetailingResult<{ account: Account; session: { token: string; expiresAt: string } }>
    > {
      const at = now();
      if (failuresByEmail.blocked(input.email, at) || attemptsByClient.blocked(clientKey, at)) {
        return TOO_MANY();
      }
      attemptsByClient.hit(clientKey, at);
      const account = await accounts.byEmail(input.email);
      const valid = await argonVerify(
        account?.passwordHash ?? (await dummy()),
        input.password,
      ).catch(() => false);
      if (!account || !valid) {
        failuresByEmail.hit(input.email, at);
        return INVALID();
      }
      failuresByEmail.reset(input.email);
      return queue.run(async () => {
        // Rotation: the session this browser presented (if any) ends; a fresh one is issued.
        if (previousToken) {
          const previous = await sessions.byTokenHash(sha256Hex(previousToken));
          if (previous) await sessions.revoke(previous.sessionId, at);
        }
        const session = await issueSession(account.accountId, at);
        return { ok: true, value: { account: toPublicAccount(account), session } };
      });
    },

    async signOut(token: string | undefined): Promise<void> {
      if (!token) return;
      const session = await sessions.byTokenHash(sha256Hex(token));
      if (session) await queue.run(() => sessions.revoke(session.sessionId, now()));
    },

    async updateProfile(
      token: string | undefined,
      input: { givenName: string; familyName: string },
    ) {
      const auth = await sessionFor(token);
      if (!auth) return UNAUTHENTICATED();
      return queue.run(async (): Promise<RetailingResult<Account>> => {
        const latest = (await accounts.byId(auth.account.accountId))!;
        const next = await accounts.replace(latest, { ...latest, ...input, updatedAt: now() });
        return { ok: true, value: toPublicAccount(next) };
      });
    },

    /** Change the password, end every session, and start a new one for this browser. */
    async changePassword(
      token: string | undefined,
      input: { currentPassword: string; newPassword: string },
    ) {
      const auth = await sessionFor(token);
      if (!auth) return UNAUTHENTICATED();
      const at = now();
      if (failuresByEmail.blocked(auth.account.email, at)) return TOO_MANY();
      if (
        !(await argonVerify(auth.account.passwordHash, input.currentPassword).catch(() => false))
      ) {
        failuresByEmail.hit(auth.account.email, at);
        return fail(
          401,
          'INVALID_CREDENTIALS',
          'Your current password is incorrect.',
          'currentPassword',
        );
      }
      const passwordHash = await argonHash(input.newPassword);
      return queue.run(async () => {
        const latest = (await accounts.byId(auth.account.accountId))!;
        await accounts.replace(latest, { ...latest, passwordHash, updatedAt: at });
        await sessions.revokeAll(latest.accountId, at);
        const session = await issueSession(latest.accountId, at);
        return { ok: true as const, value: { session } };
      });
    },

    /** Revoke every session of the account, this one included. */
    async signOutEverywhere(token: string | undefined) {
      const auth = await sessionFor(token);
      if (!auth) return UNAUTHENTICATED();
      await queue.run(() => sessions.revokeAll(auth.account.accountId, now()));
      return { ok: true as const, value: null };
    },

    // -----------------------------------------------------------------------
    // Saved travellers
    // -----------------------------------------------------------------------

    async listTravellers(accountId: string) {
      return (await travellers.forAccount(accountId)).map(toPublicTraveller);
    },

    async createTraveller(
      accountId: string,
      idempotencyKey: string,
      input: SavedTravellerInput,
    ): Promise<RetailingResult<{ traveller: SavedTraveller; replayed: boolean }>> {
      const parsed = savedTravellerInputSchema.parse(input);
      return queue.run(async () => {
        const createKey = `${accountId}:${idempotencyKey}`;
        const existing = await travellers.byCreateKey(createKey);
        if (existing)
          return { ok: true, value: { traveller: toPublicTraveller(existing), replayed: true } };
        if ((await travellers.countForAccount(accountId)) >= ACCOUNT_RULES.maxSavedTravellers) {
          return fail(
            409,
            'LIMIT_REACHED',
            `You can save up to ${ACCOUNT_RULES.maxSavedTravellers} travellers.`,
          );
        }
        const at = now();
        const traveller: StoredTraveller = {
          schemaVersion: ACCOUNT_SCHEMA_VERSION,
          travellerId: newId('trv'),
          accountId,
          createKey,
          title: parsed.title ?? null,
          givenName: parsed.givenName,
          middleName: parsed.middleName ?? null,
          familyName: parsed.familyName,
          dateOfBirth: parsed.dateOfBirth,
          nationality: parsed.nationality,
          createdAt: at,
          updatedAt: at,
          rev: 1,
        };
        await travellers.insert(traveller);
        return { ok: true, value: { traveller: toPublicTraveller(traveller), replayed: false } };
      });
    },

    async updateTraveller(
      accountId: string,
      travellerId: string,
      expectedRevision: number,
      input: SavedTravellerInput,
    ): Promise<RetailingResult<SavedTraveller>> {
      const parsed = savedTravellerInputSchema.parse(input);
      return queue.run(async () => {
        const existing = await travellers.owned(accountId, travellerId);
        if (!existing) return TRAVELLER_NOT_FOUND();
        if (existing.rev !== expectedRevision) {
          return fail(
            409,
            'SERVICING_CONFLICT',
            'This traveller was changed in another window. We’ve loaded the latest details.',
          );
        }
        const next = await travellers.replace(existing, {
          ...existing,
          ...parsed,
          title: parsed.title ?? null,
          middleName: parsed.middleName ?? null,
          updatedAt: now(),
        });
        return { ok: true, value: toPublicTraveller(next) };
      });
    },

    /** Deleting a profile never touches bookings: their passenger details are their own copy. */
    async deleteTraveller(accountId: string, travellerId: string): Promise<RetailingResult<null>> {
      return queue.run(async () => {
        const deleted = await travellers.delete(accountId, travellerId);
        return deleted ? { ok: true, value: null } : TRAVELLER_NOT_FOUND();
      });
    },

    // -----------------------------------------------------------------------
    // Trips and linking
    // -----------------------------------------------------------------------

    async trips(
      accountId: string,
      section: TripSection,
      page: number,
      pageSize: number,
    ): Promise<TripsResponse> {
      const at = businessNow();
      const { items, total } = await orders.listForAccount(
        accountId,
        section as TripListSection,
        at,
        page,
        pageSize,
      );
      const sections: TripSection[] = ['upcoming', 'past', 'cancelled', 'attention'];
      const counts = Object.fromEntries(
        await Promise.all(
          sections.map(
            async (name) => [name, await orders.countForAccount(accountId, name, at)] as const,
          ),
        ),
      ) as Record<TripSection, number>;
      return { data: items.map(tripOf), meta: { section, page, pageSize, total, counts } };
    },

    /** Bookings this guest token owns that no account owns yet. */
    async linkable(guestToken: string | undefined): Promise<TripSummary[]> {
      if (!guestToken) return [];
      const { guestId, tokenHash } = guestIdFor(guestToken);
      const listings = await orders.linkableForGuest(guestId, LINKABLE_LIMIT);
      return listings.filter((listing) => listing.ownerTokenHash === tokenHash).map(tripOf);
    },

    /**
     * Move bookings from the guest to the account. Both must be proven: the account by its
     * verified session, the booking by the guest token that owns it. Anything not owned by this
     * guest is refused as unknown, and nothing is linked. Each booking is one compare-and-set
     * write; linking again is a no-op, so a retry after a partial run finishes the job.
     */
    async link(
      accountId: string,
      guestToken: string | undefined,
      orderIds: string[],
    ): Promise<RetailingResult<{ linked: string[]; alreadyLinked: string[] }>> {
      return queue.run(async () => {
        const found = await Promise.all(orderIds.map((id) => orders.byId(id)));
        const alreadyLinked: string[] = [];
        const toLink = [];
        for (const order of found) {
          if (!order) return ORDER_NOT_FOUND();
          if (order.ownerAccountId === accountId) {
            alreadyLinked.push(order.orderId);
            continue;
          }
          if (!canAccess(order, { guestToken })) return ORDER_NOT_FOUND();
          if (order.status !== 'CONFIRMED' && order.status !== 'BOOKING_CANCELLED') {
            return fail(
              409,
              'ORDER_NOT_MODIFIABLE',
              'Only confirmed bookings can be added to your account.',
            );
          }
          toLink.push(order);
        }
        const at = now();
        const linked: string[] = [];
        for (const order of toLink) {
          const next = withEvent(
            {
              ...order,
              ownerAccountId: accountId,
              // From now on only the account opens it; the guest's attribution stays in `ownership`.
              ownerTokenHash: null,
              ownership: [...order.ownership, { kind: 'ACCOUNT', id: accountId, at }],
            },
            'OWNER_LINKED',
            at,
            'account',
          );
          await store.write(order, next);
          linked.push(order.orderId);
        }
        if (linked.length) log?.info({ accountId, linked: linked.length }, 'guest bookings linked');
        return { ok: true, value: { linked, alreadyLinked } };
      });
    },

    /** Delete sessions that ended more than a day ago (the sweep). */
    async purgeSessions() {
      return queue.run(() => sessions.purgeEnded(now() - 24 * 60 * MINUTE));
    },

    stats() {
      return {
        rateLimitKeys: failuresByEmail.size + attemptsByClient.size + registrationsByClient.size,
      };
    },
  };
}

export type AccountService = ReturnType<typeof createAccountService>;
