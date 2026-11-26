/**
 * M9.2: IPv4/IPv6 CIDR parsing and the NextRS private-network allowlist policy.
 *
 * NextRS (`--net-allow-addr`) refuses a DNS answer if any non-public address in it is outside
 * the listed ranges. This module decides, offline, whether an allowlist is acceptable for the
 * Railway environment: narrow enough that unrelated private destinations stay blocked, and
 * wide enough that every address the API was observed at is allowed.
 *
 * The policy (`allowlistProblems`):
 *   - not empty; every entry an address or CIDR with no host bits set (10.128.0.0/9, not 10.200.0.0/9);
 *   - IPv4 ranges inside 10.0.0.0/8 and NARROWER than it (prefix >= 9): Railway documents no
 *     private IPv4 range, and the observed one is 10.128.0.0/9;
 *   - IPv6 ranges inside the unique-local block fd00::/8, prefix >= 16 (Railway: fd12::/16);
 *   - both families present (this environment is dual-stack: the API has A and AAAA records).
 *
 * Addresses are compared as BigInt bit strings; nothing here touches the network.
 */
import { isIP } from 'node:net';

/** Parse an IPv4 or IPv6 address into { family, value: BigInt }; null if invalid. */
export function parseAddress(text) {
  const family = isIP(text ?? '');
  if (family === 4) {
    const value = text.split('.').reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
    return { family, value };
  }
  if (family === 6) {
    if (text.includes('.')) return null; // IPv4-mapped/embedded forms are not used here
    const [head, tail] = text.includes('::') ? text.split('::') : [text, undefined];
    const h = head ? head.split(':') : [];
    const t = tail === undefined ? [] : tail ? tail.split(':') : [];
    const missing = 8 - h.length - t.length;
    if (tail === undefined ? h.length !== 8 : missing < 1) return null;
    const groups = [...h, ...Array(tail === undefined ? 0 : missing).fill('0'), ...t];
    const value = groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
    return { family, value };
  }
  return null;
}

const WIDTH = { 4: 32, 6: 128 };

/**
 * Parse `addr` or `addr/prefix` into { family, network, prefix, text }; null if invalid.
 * `hostBits` is true when the address has bits set below the prefix (a mistyped range).
 */
export function parseCidr(text) {
  if (typeof text !== 'string' || text.trim() !== text || text === '') return null;
  const parts = text.split('/');
  if (parts.length > 2) return null;
  const addr = parseAddress(parts[0]);
  if (!addr) return null;
  const width = WIDTH[addr.family];
  let prefix = width;
  if (parts.length === 2) {
    if (!/^\d{1,3}$/.test(parts[1])) return null;
    prefix = Number(parts[1]);
    if (prefix > width) return null;
  }
  const hostMask = (1n << BigInt(width - prefix)) - 1n;
  return {
    family: addr.family,
    network: addr.value & ~hostMask,
    prefix,
    hostBits: (addr.value & hostMask) !== 0n,
    text,
  };
}

/** Whether the parsed CIDR `range` contains the address text `address`. */
export function cidrContains(range, address) {
  const r = typeof range === 'string' ? parseCidr(range) : range;
  const a = parseAddress(address);
  if (!r || !a || r.family !== a.family) return false;
  const width = WIDTH[r.family];
  const hostMask = (1n << BigInt(width - r.prefix)) - 1n;
  return (a.value & ~hostMask) === r.network;
}

/** Whether CIDR `inner` lies entirely inside CIDR `outer`. */
export function cidrWithin(inner, outer) {
  const i = typeof inner === 'string' ? parseCidr(inner) : inner;
  const o = typeof outer === 'string' ? parseCidr(outer) : outer;
  if (!i || !o || i.family !== o.family || i.prefix < o.prefix) return false;
  const width = WIDTH[o.family];
  const hostMask = (1n << BigInt(width - o.prefix)) - 1n;
  return (i.network & ~hostMask) === o.network;
}

/** Split a NEXTRS_NET_ALLOW_ADDR value the way docker/nextrs/start.sh does (commas/spaces). */
export function splitAllowlist(value) {
  return String(value ?? '')
    .split(/[\s,]+/)
    .filter(Boolean);
}

export const IPV4_ENVELOPE = '10.0.0.0/8';
export const IPV4_MIN_PREFIX = 9;
export const IPV6_ENVELOPE = 'fd00::/8';
export const IPV6_MIN_PREFIX = 16;

/** Problems with an allowlist value under the policy above (empty array = acceptable). */
export function allowlistProblems(value) {
  const entries = splitAllowlist(value);
  const problems = [];
  if (entries.length === 0) return ['the allowlist is empty (NextRS would refuse the private API)'];
  const families = new Set();
  for (const entry of entries) {
    const c = parseCidr(entry);
    if (!c) {
      problems.push(`${entry} is not an IP address or CIDR`);
      continue;
    }
    families.add(c.family);
    if (c.hostBits) problems.push(`${entry} has host bits set (write the network address)`);
    if (c.family === 4) {
      if (!cidrWithin(c, IPV4_ENVELOPE)) {
        problems.push(
          `${entry} is outside ${IPV4_ENVELOPE} (Railway's private IPv4 lies inside it)`,
        );
      } else if (c.prefix < IPV4_MIN_PREFIX) {
        problems.push(
          `${entry} is too broad (/${c.prefix}): it allows all of ${IPV4_ENVELOPE}; the observed Railway range is 10.128.0.0/9`,
        );
      }
    } else {
      if (!cidrWithin(c, IPV6_ENVELOPE)) {
        problems.push(`${entry} is outside the unique-local block ${IPV6_ENVELOPE}`);
      } else if (c.prefix < IPV6_MIN_PREFIX) {
        problems.push(
          `${entry} is too broad (/${c.prefix}); Railway's private network is fd12::/16`,
        );
      }
    }
  }
  if (!families.has(4)) problems.push('no IPv4 range: the API also has an A record (dual-stack)');
  if (!families.has(6)) problems.push('no IPv6 range: the API has an AAAA record');
  return problems;
}

/** Addresses from `addresses` that no entry of the allowlist contains. */
export function addressesOutside(value, addresses) {
  const ranges = splitAllowlist(value).map(parseCidr).filter(Boolean);
  return addresses.filter((a) => !ranges.some((r) => cidrContains(r, a)));
}
