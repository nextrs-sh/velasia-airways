import { randomUUID } from 'node:crypto';
import { listingFor, ORDER_SCHEMA_VERSION, type StoredOrder } from '../src/db/schema';
import { FARE_FAMILIES_BY_CODE } from '../src/fixtures/fare-families';
import { createOffer, inventoryVersionFor, toPublicOffer } from '../src/offers/offer-engine';
import { guestIdFor, hashOf, newBookingReference, newId } from '../src/orders/ids';
import { resolveCandidate } from '../src/search/itineraries';
import { clock, inventory, TODAY } from './helpers';

/*
 * A valid stored order built from the real offer engine (deterministic inventory), for tests
 * of storage, lifecycle, and the ledger that don't need the HTTP flow. Synthetic traveller.
 */

export const FIXTURE_GUEST_TOKEN = 'G'.repeat(43);

export function sampleOrder(overrides: Partial<StoredOrder> = {}): StoredOrder {
  // A fixed instant (the pinned business midnight) keeps fixtures deterministic.
  const now = clock.businessNow();
  const candidate = resolveCandidate(inventory, 'NV501-20261215')!;
  const family = FARE_FAMILIES_BY_CODE.get('CLASSIC')!;
  const offer = toPublicOffer(
    createOffer(
      candidate,
      family,
      { adults: 1, children: 0, infants: 0 },
      {
        now,
        businessNow: now,
        inventoryVersion: inventoryVersionFor(TODAY),
        demandShift: 0,
        soldOut: false,
      },
      15 * 60_000,
    ),
    'AVAILABLE',
  );
  const total = offer.price.totalMinor;
  const { guestId, tokenHash } = guestIdFor(FIXTURE_GUEST_TOKEN);
  const sessionId = `ses_${'S'.repeat(22)}`;
  const reference = newBookingReference();
  const holdExpiresAt = now + 10 * 60_000;
  const order: StoredOrder = {
    schemaVersion: ORDER_SCHEMA_VERSION,
    orderId: newId('ord'),
    reference,
    rev: 1,
    guestId,
    ownerTokenHash: tokenHash,
    sessionId,
    checkoutKey: `${sessionId}:${randomUUID()}`,
    checkoutRequestHash: hashOf({ fixture: randomUUID() }),
    contentHash: hashOf({ fixture: 'content' }),
    status: 'PENDING_PAYMENT',
    createdAt: now,
    updatedAt: now,
    confirmedAt: null,
    currency: 'PHP',
    totalMinor: total,
    totals: {
      baseFareMinor: offer.price.totals.baseFareMinor,
      fareFamilyMinor: offer.price.totals.fareFamilyMinor,
      taxesMinor: offer.price.totals.taxesMinor,
      flightsMinor: total,
      seatsMinor: 0,
      baggageMinor: 0,
      mealsMinor: 0,
      priorityMinor: 0,
      totalMinor: total,
    },
    pricingVersion: offer.pricingVersion,
    snapshot: {
      search: {
        tripType: 'one-way',
        origin: 'MNL',
        destination: 'SIN',
        cabin: 'economy',
        passengers: { adults: 1, children: 0, infants: 0 },
      },
      journeys: [
        {
          direction: 'outbound',
          offerId: offer.id,
          family: 'CLASSIC',
          familyName: family.name,
          cabin: offer.cabin,
          itinerary: offer.itinerary,
          services: offer.services,
          price: offer.price,
        },
      ],
      passengers: [
        {
          id: 'ADT1',
          type: 'adult',
          title: null,
          givenName: 'Ligaya',
          middleName: null,
          familyName: 'Testcase',
          dateOfBirth: '1991-02-14',
          nationality: 'PH',
          specialAssistance: null,
          infantOf: null,
        },
      ],
      contact: { email: 'ligaya.testcase@example.com', phone: '+639175550199' },
      seats: [],
      ancillaries: [],
      baggage: [],
    },
    items: [
      {
        id: 'flight-outbound-adult',
        kind: 'FLIGHT',
        label: `${family.name} · Adult`,
        detail: 'MNL → SIN · VEL 501',
        direction: 'outbound',
        travellerId: null,
        flightId: null,
        productCode: 'CLASSIC',
        quantity: 1,
        unitPriceMinor: total,
        amountMinor: total,
        included: false,
      },
    ],
    hold: {
      holdId: newId('hld'),
      status: 'HELD',
      createdAt: now,
      expiresAt: holdExpiresAt,
      committedAt: null,
      releasedAt: null,
      releaseReason: null,
      inventoryVersion: TODAY,
      allocations: [{ flightId: 'NV501-20261215', cabin: 'economy', seats: 1, seatIds: [] }],
    },
    attempts: [],
    events: [
      { seq: 1, type: 'ORDER_CREATED', at: now, detail: reference },
      { seq: 2, type: 'INVENTORY_HELD', at: now, detail: '1 flight(s)' },
    ],
    paymentStatus: 'NOT_STARTED',
    holdState: 'HELD',
    holdExpiresAt,
    flightIds: ['NV501-20261215'],
    attemptIds: [],
    // Milestone 6.
    ownerAccountId: null,
    ownership: [{ kind: 'GUEST', id: guestId, at: now }],
    current: {
      version: 1,
      journeys: [],
      seats: [],
      ancillaries: [],
      baggage: [],
      items: [],
    },
    servicing: [],
    cancelledAt: null,
    servicingAttemptIds: [],
    servicingState: 'NONE',
    listing: null as never,
    tripStartsAt: 0,
    tripEndsAt: 0,
  };
  const withCurrent: StoredOrder = {
    ...order,
    current: { ...order.current, journeys: order.snapshot.journeys, items: order.items },
  };
  const listing = listingFor(withCurrent);
  return {
    ...withCurrent,
    listing,
    tripStartsAt: listing.departsAt,
    tripEndsAt: listing.endsAt,
    ...overrides,
  };
}
