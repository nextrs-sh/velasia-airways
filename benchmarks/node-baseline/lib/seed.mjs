/**
 * Milestone 7 benchmark fixtures: synthetic, deterministic, created through the public API of a
 * fresh retailing API (never a database with real data).
 *
 *   node lib/seed.mjs <apiUrl> <out.json> [bookings=40] [accounts=10]
 *
 * Writes the itinerary ids the scenarios shop for, confirmed bookings with their guest tokens
 * (Manage Booking pages), and demo accounts with linked bookings (My Trips pages).
 *
 * Against an API that requires the shared service token (Railway, compose.dual-runtime), export
 * RETAILING_API_SERVICE_TOKEN first; it is read from the environment and never printed.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const [apiUrl, out, bookingCount = '40', accountCount = '10'] = process.argv.slice(2);
const serviceToken = process.env.RETAILING_API_SERVICE_TOKEN;
const api = async (path, { method = 'GET', body, bearer, headers = {} } = {}) => {
  const response = await fetch(new URL(path, apiUrl), {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(serviceToken ? { 'x-velasia-service-token': serviceToken } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};

export const DATES = Array.from({ length: 28 }, (_, i) =>
  new Date(Date.UTC(2026, 11, 3 + i)).toISOString().slice(0, 10),
);
const ROUTES = [
  ['MNL', 'SIN'],
  ['MNL', 'CEB'],
  ['MNL', 'HKG'],
  ['CEB', 'MNL'],
];
const ADULT = {
  id: 'ADT1',
  type: 'adult',
  title: 'MS',
  givenName: 'Bench',
  middleName: '',
  familyName: 'Synthetic',
  dateOfBirth: '1990-01-01',
  nationality: 'PH',
  specialAssistance: '',
  infantOf: '',
};
const CONTACT = { email: 'bench.synthetic@example.com', phone: '+63 917 555 0100' };

/** One confirmed booking for one adult on `itineraryId`, owned by `guest`. */
export async function book({ itineraryId, date, origin, destination }, guest) {
  const search = {
    tripType: 'one-way',
    origin,
    destination,
    departDate: date,
    passengers: { adults: 1, children: 0, infants: 0 },
    cabin: 'economy',
  };
  const { data } = await api('/v1/shopping-sessions', { method: 'POST', body: { search } });
  const { session, token } = data;
  const base = `/v1/shopping-sessions/${session.id}`;
  const offers = await api(`/v1/offers?itineraryId=${itineraryId}&adults=1&children=0&infants=0`);
  const offer = offers.data.offers.find((o) => o.family === 'CLASSIC') ?? offers.data.offers[0];
  await api(`${base}/select`, {
    method: 'POST',
    bearer: token,
    body: { direction: 'outbound', offerId: offer.id },
  });
  await api(`${base}/reprice`, { method: 'POST', bearer: token, body: {} });
  await api(`${base}/passengers`, {
    method: 'PUT',
    bearer: token,
    body: { passengers: [ADULT], contact: CONTACT },
  });
  await api(`${base}/steps`, { method: 'POST', bearer: token, body: { step: 'seats' } });
  await api(`${base}/steps`, { method: 'POST', bearer: token, body: { step: 'extras' } });
  const validated = await api(`${base}/validate`, { method: 'POST', bearer: token, body: {} });
  const prepared = await api('/v1/checkout/prepare', {
    method: 'POST',
    bearer: token,
    headers: { 'x-velasia-guest': guest },
    body: {
      sessionId: session.id,
      idempotencyKey: randomUUID(),
      expectedVersion: validated.data.session.version,
      acceptedTotalMinor: validated.data.quote.totals.totalMinor,
    },
  });
  const orderId = prepared.data.order.id;
  await api(`/v1/orders/${orderId}/payment-attempts`, {
    method: 'POST',
    bearer: guest,
    body: { idempotencyKey: randomUUID(), method: 'DEMO_CARD' },
  });
  return orderId;
}

if (process.argv[1]?.endsWith('seed.mjs')) {
  const itineraries = [];
  for (const [origin, destination] of ROUTES) {
    for (const date of DATES) {
      const search = await api(
        `/v1/flights?from=${origin}&to=${destination}&departureDate=${date}&adults=1&pageSize=5`,
      );
      for (const itinerary of search.data.legs[0].itineraries.slice(0, 3)) {
        itineraries.push({ itineraryId: itinerary.id, date, origin, destination });
      }
    }
  }
  const bookings = [];
  for (let i = 0; i < Number(bookingCount); i += 1) {
    const guest = randomBytes(32).toString('base64url');
    const trip = itineraries[(i * 7) % itineraries.length];
    bookings.push({ orderId: await book(trip, guest), guest });
  }
  const accounts = [];
  for (let i = 0; i < Number(accountCount); i += 1) {
    const email = `bench.account.${i}.${Date.now()}@example.com`;
    const registered = await api('/v1/accounts', {
      method: 'POST',
      headers: { 'x-velasia-client': `bench-${i}` },
      body: {
        email,
        password: 'bench-synthetic-passphrase',
        givenName: 'Bench',
        familyName: 'Account',
      },
    });
    const token = registered.data.session.token;
    const guest = randomBytes(32).toString('base64url');
    const orderIds = [];
    for (let j = 0; j < 4; j += 1) {
      orderIds.push(await book(itineraries[(i * 13 + j * 3 + 5) % itineraries.length], guest));
    }
    await api('/v1/me/orders/link', {
      method: 'POST',
      bearer: guest,
      headers: { 'x-velasia-account': token },
      body: { orderIds },
    });
    accounts.push({ token, orders: orderIds.length });
  }
  writeFileSync(out, `${JSON.stringify({ itineraries, bookings, accounts }, null, 2)}\n`);
  console.log(
    `seeded ${itineraries.length} itineraries, ${bookings.length} bookings, ${accounts.length} accounts (${accounts.length * 4} linked bookings)`,
  );
}
