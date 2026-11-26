/*
 * The plan gate against real `railway config plan --json` output (CLI 5.75.0, 2026-11-26),
 * sanitized (no project/environment IDs, no etag, graphs reduced to names): fixtures/plan-*.json.
 *
 *   noop                 .railway/railway.ts (the reconciled baseline): no changes
 *   allowlist-proposal   .railway/proposals/nextrs-allowlist.ts: one variable.set
 *   m9-destructive       the pre-M9.2 railway.ts: 4 creates, 3 production services deleted
 *   limits-update        an explicit limitOverride on @velasia/web: resource.update
 *   variable-delete      a live variable omitted: destructive variable.delete
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { EXPECTED } from './expected-production.mjs';
import {
  FORBIDDEN_FLAGS,
  changeTarget,
  evaluatePlan,
  planArgs,
  sanitizePlan,
  summarize,
} from './plan-gate-lib.mjs';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/plan-${name}.json`, import.meta.url), 'utf8'));
const gate = (plan, expectedChanges) => evaluatePlan(plan, { expected: EXPECTED, expectedChanges });
const ALLOWLIST = [{ kind: 'variable.set', target: '@velasia/web-nextrs.NEXTRS_NET_ALLOW_ADDR' }];
const hasProblem = (result, pattern) =>
  assert.ok(
    result.problems.some((p) => pattern.test(p)),
    `expected a problem matching ${pattern}; got:\n${result.problems.join('\n') || '(none)'}`,
  );

test('the reconciled baseline is a strict no-op', () => {
  const r = gate(fixture('noop'));
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.equal(r.counts.total, 0);
});

test('the pre-M9.2 file is rejected: it would destroy all three production services', () => {
  const r = gate(fixture('m9-destructive'));
  assert.equal(r.ok, false);
  for (const s of ['@velasia/retailing-api', '@velasia/web', '@velasia/web-nextrs']) {
    hasProblem(r, new RegExp(`DESTROYS production service ${s.replace('/', '\\/')}`));
    hasProblem(r, new RegExp(`desired graph drops live service ${s.replace('/', '\\/')}`));
  }
  hasProblem(r, /unexpected new service: Create service velasia-api/);
  hasProblem(r, /unexpected new volume: Create volume velasia-api-data/);
  assert.equal(r.counts.destructive, 3);
});

test('a production service deletion cannot be waived', () => {
  const r = gate(fixture('m9-destructive'), [
    { kind: 'resource.delete', target: '@velasia/web', allowDestructive: true },
  ]);
  hasProblem(r, /DESTROYS production service @velasia\/web/);
});

test('the allowlist proposal passes only with its expected change', () => {
  assert.equal(gate(fixture('allowlist-proposal'), ALLOWLIST).ok, true);
  const strict = gate(fixture('allowlist-proposal'));
  assert.equal(strict.ok, false, 'a nonzero plan is never accepted as the no-op baseline');
  hasProblem(
    strict,
    /unexpected variable change: Update variable @velasia\/web-nextrs\.NEXTRS_NET_ALLOW_ADDR/,
  );
});

test('a stale proposal (expected change absent) fails', () => {
  hasProblem(gate(fixture('noop'), ALLOWLIST), /expected change is not in the plan/);
});

test('unexpected service configuration changes fail', () => {
  const r = gate(fixture('limits-update'));
  hasProblem(
    r,
    /unexpected service configuration change: Update @velasia\/web deploy\.limitOverride/,
  );
});

test('a destructive variable deletion needs an explicit acknowledgement', () => {
  const plan = fixture('variable-delete');
  hasProblem(gate(plan), /unexpected variable change: Delete variable/);
  const target = '@velasia/web.RETAILING_API_START_TIMEOUT_MS';
  hasProblem(gate(plan, [{ kind: 'variable.delete', target }]), /not acknowledged/);
  assert.equal(gate(plan, [{ kind: 'variable.delete', target, allowDestructive: true }]).ok, true);
});

test('fails closed on unknown kinds, severities, wrong environment and unmanaged variables', () => {
  const unknown = fixture('noop');
  unknown.changeSet.changes = [
    { summary: 'Replace service @velasia/web', severity: 'safe', kind: 'resource.replace' },
  ];
  hasProblem(gate(unknown), /unknown change kind resource.replace/);

  const severity = fixture('allowlist-proposal');
  severity.changeSet.changes[0].severity = 'risky';
  hasProblem(gate(severity, ALLOWLIST), /unknown severity risky/);

  const env = fixture('noop');
  env.currentEnvironment.environmentName = 'staging';
  hasProblem(gate(env), /environment is staging/);

  const project = fixture('noop');
  project.currentEnvironment.projectName = 'someone-else';
  hasProblem(gate(project), /project is someone-else/);

  const unmanaged = fixture('noop');
  unmanaged.variablePolicy.managed = false;
  hasProblem(gate(unmanaged), /variables are not managed/);

  const failed = fixture('noop');
  failed.ok = false;
  hasProblem(gate(failed), /did not succeed/);

  const broken = fixture('noop');
  delete broken.changeSet;
  hasProblem(gate(broken), /changeSet.changes is missing/);

  assert.equal(gate(null).ok, false);

  const applied = fixture('noop');
  applied.applyResult = { ok: true };
  hasProblem(gate(applied), /apply\/staged result/);
});

test('graph checks catch a volume or a public API domain even without a change entry', () => {
  const vol = fixture('noop');
  vol.desiredGraph.resources.push({ address: 'volume.data', type: 'volume', name: 'data' });
  hasProblem(gate(vol), /declares volume data/);

  const pub = fixture('noop');
  const api = pub.desiredGraph.resources.find((r) => r.name === '@velasia/retailing-api');
  api.networking = { serviceDomains: { 'api.up.railway.app': {} } };
  hasProblem(gate(pub), /gives the API @velasia\/retailing-api a public domain/);

  const dropped = fixture('noop');
  dropped.desiredGraph.resources = dropped.desiredGraph.resources.filter(
    (r) => r.name !== '@velasia/web',
  );
  hasProblem(gate(dropped), /drops live service @velasia\/web/);
});

test('change targets are read from the structured summaries', () => {
  assert.equal(changeTarget({ summary: 'Create service velasia-api' }), 'velasia-api');
  assert.equal(changeTarget({ summary: 'Delete service @velasia/web' }), '@velasia/web');
  assert.equal(changeTarget({ summary: 'Create volume velasia-api-data' }), 'velasia-api-data');
  assert.equal(
    changeTarget({ summary: 'Update variable @velasia/web-nextrs.NEXTRS_NET_ALLOW_ADDR' }),
    '@velasia/web-nextrs.NEXTRS_NET_ALLOW_ADDR',
  );
  assert.equal(
    changeTarget({ summary: 'Delete variable @velasia/web.RETAILING_API_START_TIMEOUT_MS' }),
    '@velasia/web.RETAILING_API_START_TIMEOUT_MS',
  );
  assert.equal(
    changeTarget({ summary: 'Update @velasia/web deploy.limitOverride.containers.cpu' }),
    '@velasia/web',
  );
  assert.equal(changeTarget({ summary: 'Something new' }), null);
});

test('the gate only ever runs a read-only plan', () => {
  const args = planArgs({ file: '.railway/railway.ts', environment: 'production' });
  assert.deepEqual(args.slice(0, 2), ['config', 'plan']);
  assert.ok(args.includes('--json') && args.includes('--detailed-exit-code'));
  for (const f of FORBIDDEN_FLAGS) assert.ok(!args.includes(f), f);
  assert.ok(!args.includes('apply'));
});

test('the sanitized plan has no IDs, etag, graphs or variable values', () => {
  const plan = fixture('allowlist-proposal');
  plan.currentEnvironment.projectId = '11111111-2222-3333-4444-555555555555';
  plan.changeSet.changes[0].details = [
    'NEXTRS_NET_ALLOW_ADDR (fd12::/16,10.0.0.0/8 → fd12::/16,10.128.0.0/9)',
  ];
  const s = sanitizePlan(plan);
  const text = JSON.stringify(s);
  assert.ok(!text.includes('11111111-2222'));
  assert.ok(!text.includes('configEtag') && !text.includes('desiredGraph'));
  assert.ok(!text.includes('10.0.0.0/8'), 'variable details (possible values) are dropped');
  assert.deepEqual(s.services, ['@velasia/retailing-api', '@velasia/web', '@velasia/web-nextrs']);
  const md = summarize({
    file: '.railway/proposals/nextrs-allowlist.ts',
    result: gate(plan, ALLOWLIST),
    sanitized: s,
    generatedAt: '2026-11-26T00:00:00.000Z',
  });
  assert.match(md, /^# Railway plan gate: PASS/);
  assert.match(
    md,
    /\| variable.set \| safe \| Update variable @velasia\/web-nextrs.NEXTRS_NET_ALLOW_ADDR \|/,
  );
});
