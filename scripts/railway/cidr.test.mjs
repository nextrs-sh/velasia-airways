import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addressesOutside,
  allowlistProblems,
  cidrContains,
  cidrWithin,
  parseAddress,
  parseCidr,
  splitAllowlist,
} from './cidr.mjs';

const LIVE = 'fd12::/16,10.0.0.0/8';
const INTENDED = 'fd12::/16,10.128.0.0/9';
/** Every address the API was observed at (2026-11-25/26). */
const OBSERVED = [
  '10.228.244.185',
  '10.146.207.192',
  '10.236.48.211',
  'fd12:382f:2f26:1:a000:1f:5092:cfc0',
  'fd12:382f:2f26:1:3000:179:bb6c:30d3',
];
/** Private or special destinations that are not the API and must stay blocked. */
const UNRELATED = [
  '10.0.0.1',
  '10.127.255.255',
  '172.16.0.1',
  '192.168.1.1',
  '127.0.0.1',
  '169.254.169.254',
  '100.64.0.1',
  'fd00::1',
  'fd13::1',
  'fe80::1',
  '::1',
];

test('parses IPv4 and IPv6 addresses and CIDRs', () => {
  assert.equal(parseAddress('10.128.0.0').value, (10n << 24n) | (128n << 16n));
  assert.equal(parseAddress('::1').value, 1n);
  assert.equal(parseAddress('fd12::').value, 0xfd12n << 112n);
  assert.equal(parseAddress('fd12:382f:2f26:1:a000:1f:5092:cfc0').family, 6);
  assert.equal(parseAddress('10.1.2'), null);
  assert.equal(parseAddress('::ffff:10.0.0.1'), null);
  assert.equal(parseAddress(''), null);
  assert.deepEqual(
    { ...parseCidr('10.128.0.0/9'), network: undefined },
    { family: 4, network: undefined, prefix: 9, hostBits: false, text: '10.128.0.0/9' },
  );
  assert.equal(parseCidr('10.200.0.0/9').hostBits, true);
  assert.equal(parseCidr('10.0.0.1').prefix, 32);
  for (const bad of [
    '10.0.0.0/33',
    'fd12::/129',
    '10.0.0.0/',
    '10.0.0.0/x',
    '/8',
    'x',
    ' 10.0.0.0/8',
    '10.0.0.0/8/1',
  ]) {
    assert.equal(parseCidr(bad), null, bad);
  }
});

test('containment and nesting', () => {
  assert.ok(cidrContains('10.128.0.0/9', '10.128.0.0'));
  assert.ok(cidrContains('10.128.0.0/9', '10.255.255.255'));
  assert.ok(!cidrContains('10.128.0.0/9', '10.127.255.255'));
  assert.ok(cidrContains('fd12::/16', 'fd12:382f:2f26:1:3000:179:bb6c:30d3'));
  assert.ok(!cidrContains('fd12::/16', 'fd13::1'));
  assert.ok(!cidrContains('10.0.0.0/8', 'fd12::1'), 'families never mix');
  assert.ok(cidrWithin('10.128.0.0/9', '10.0.0.0/8'));
  assert.ok(!cidrWithin('10.0.0.0/8', '10.128.0.0/9'));
  assert.ok(!cidrWithin('11.0.0.0/9', '10.0.0.0/8'));
});

test('splits the way docker/nextrs/start.sh does (commas and spaces)', () => {
  assert.deepEqual(splitAllowlist('fd12::/16,10.128.0.0/9'), ['fd12::/16', '10.128.0.0/9']);
  assert.deepEqual(splitAllowlist(' fd12::/16 , 10.128.0.0/9 '), ['fd12::/16', '10.128.0.0/9']);
  assert.deepEqual(splitAllowlist(''), []);
  assert.deepEqual(splitAllowlist(undefined), []);
});

test('the intended allowlist allows every observed API address and nothing unrelated', () => {
  assert.deepEqual(allowlistProblems(INTENDED), []);
  assert.deepEqual(addressesOutside(INTENDED, OBSERVED), []);
  assert.deepEqual(addressesOutside(INTENDED, UNRELATED), UNRELATED);
});

test('the live allowlist works but is broader than the policy', () => {
  assert.deepEqual(addressesOutside(LIVE, OBSERVED), []);
  assert.match(allowlistProblems(LIVE).join(), /too broad \(\/8\)/);
  // What the narrowing removes: the lower half of 10/8.
  assert.deepEqual(addressesOutside(LIVE, ['10.0.0.1', '10.127.255.255']), []);
});

test('the old /16 rule cannot describe the observed allocation', () => {
  const sixteens = new Set(
    OBSERVED.filter((a) => !a.includes(':')).map((a) => a.split('.').slice(0, 2).join('.')),
  );
  assert.equal(sixteens.size, 3, 'three API redeploys, three different /16 blocks');
});

test('invalid, empty and unrestricted allowlists fail safely', () => {
  assert.match(allowlistProblems('').join(), /empty/);
  assert.match(allowlistProblems('   ,  ').join(), /empty/);
  assert.match(allowlistProblems('fd12::/16,nonsense').join(), /not an IP address or CIDR/);
  assert.match(allowlistProblems('fd12::/16,0.0.0.0/0').join(), /outside 10\.0\.0\.0\/8/);
  assert.match(allowlistProblems('::/0,10.128.0.0/9').join(), /outside the unique-local block/);
  assert.match(allowlistProblems('fd00::/8,10.128.0.0/9').join(), /too broad \(\/8\)/);
  assert.match(allowlistProblems('fd12::/16,172.16.0.0/12').join(), /outside 10\.0\.0\.0\/8/);
  assert.match(allowlistProblems('fd12::/16,169.254.0.0/16').join(), /outside 10\.0\.0\.0\/8/);
  assert.match(allowlistProblems('fd12::/16,10.200.0.0/9').join(), /host bits/);
  assert.match(allowlistProblems('10.128.0.0/9').join(), /no IPv6 range/);
  assert.match(allowlistProblems('fd12::/16').join(), /no IPv4 range/);
});

test('a range that misses the current API address is caught', () => {
  assert.deepEqual(addressesOutside('fd12::/16,10.128.0.0/10', OBSERVED), [
    '10.228.244.185',
    '10.236.48.211',
  ]);
  assert.deepEqual(addressesOutside('fd12:382f::/32,10.128.0.0/9', ['fd12:1::1']), ['fd12:1::1']);
});
