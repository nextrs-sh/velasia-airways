/*
 * M9.3: the staged Railway proposals (.railway/proposals/*.ts) against the offline rules and the
 * plan gate. Plan fixtures are real `railway config plan --json` outputs of these proposals
 * (CLI 5.75.0, 2026-11-26), sanitized: fixtures/plan-{api-persistence,auth-clients,deploy-policy}.json.
 * All three were recorded BEFORE stage 1 was applied, so each is judged against the stages that
 * were applied when it was recorded (none), plus its own.
 *
 * Stage 1 (apiPersistence) is applied (2026-11-26) and folded into .railway/railway.ts; its
 * proposal is deleted. The plan it applied stays here as STAGE1_CHANGES + its fixture.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createRailwayContext, project } from 'railway/iac';
import * as baseline from '../../.railway/railway.ts';
import * as authClients from '../../.railway/proposals/auth-clients.ts';
import * as authEnforce from '../../.railway/proposals/auth-enforce.ts';
import * as deployPolicy from '../../.railway/proposals/deploy-policy.ts';
import * as allowlist from '../../.railway/proposals/nextrs-allowlist.ts';
import { APPLIED_STAGES, EXPECTED, STAGES, expectedFor } from './expected-production.mjs';
import {
  checkCurrentState,
  compareChanges,
  definitionChanges,
  evaluate,
  servicesOf,
} from './iac-rules.mjs';
import { changeFields, evaluatePlan } from './plan-gate-lib.mjs';

const root = resolve(import.meta.dirname, '../..');
const sdk = { createRailwayContext, project };
const observed = baseline.OBSERVED_API_ADDRESSES.map((o) => o.address);
const base = await evaluate(baseline, sdk);
const API = '@velasia/retailing-api';
const NODE = '@velasia/web';
const NEXTRS = '@velasia/web-nextrs';
const PROPOSALS = { authClients, authEnforce, deployPolicy, allowlist };

/** The applied stage 1 proposal's expectedChanges (the reviewed, applied plan: 9 changes). */
const STAGE1_CHANGES = [
  { kind: 'resource.create', target: 'velasia-api-data' },
  {
    kind: 'resource.update',
    target: API,
    fields: [
      'build.builder',
      'build.buildCommand',
      'build.dockerfilePath',
      'deploy.startCommand',
      'deploy.healthcheckPath',
      'deploy.healthcheckTimeout',
      'volumeAttachments.velasia-api-data.mountPath',
      'volumeAttachments.velasia-api-data.volume',
    ],
  },
  { kind: 'variable.set', target: `${API}.NODE_ENV` },
  { kind: 'variable.set', target: `${API}.PORT` },
  { kind: 'variable.set', target: `${API}.RAILWAY_DEPLOYMENT_DRAINING_SECONDS` },
  { kind: 'variable.set', target: `${API}.RAILWAY_DOCKERFILE_PATH` },
  { kind: 'variable.set', target: `${API}.RAILWAY_RUN_UID` },
];
const stage1 = { stage: 'apiPersistence', expectedChanges: STAGE1_CHANGES };

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/plan-${name}.json`, import.meta.url), 'utf8'));
const rules = (definition, stages) =>
  checkCurrentState(definition, { expected: expectedFor(stages), root, observed });
const fails = (definition, stages, pattern) => {
  const { failures } = rules(definition, stages);
  assert.ok(
    failures.some((f) => pattern.test(f)),
    `expected a failure matching ${pattern}; got:\n${failures.join('\n') || '(none)'}`,
  );
};
const hasProblem = (result, pattern) =>
  assert.ok(
    result.problems.some((p) => pattern.test(p)),
    `expected a problem matching ${pattern}; got:\n${result.problems.join('\n') || '(none)'}`,
  );
const staged = async (mod) => evaluate(mod, sdk);
const mutate = (definition, edit) => {
  const d = structuredClone(definition);
  edit(servicesOf(d), d);
  return d;
};

// --- Stages ------------------------------------------------------------------------------------

test('only stage 1 is applied, and railway.ts CURRENT agrees', () => {
  assert.deepEqual(APPLIED_STAGES, ['apiPersistence']);
  assert.deepEqual(EXPECTED.stages, ['apiPersistence']);
  assert.equal(baseline.CURRENT.apiPersistence, true);
  for (const key of ['clientTokens', 'apiTokenEnforcement', 'deployPolicy']) {
    assert.equal(baseline.CURRENT[key], false, key);
  }
  assert.equal(baseline.CURRENT.nextrsNetAllowAddr, baseline.NEXTRS_NET_ALLOW_ADDR_LIVE);
});

test('every unapplied stage has one proposal; enforcement needs persistence and client tokens', () => {
  const stages = Object.values(PROPOSALS).map((p) => p.stage);
  for (const s of stages) assert.ok(!APPLIED_STAGES.includes(s), `${s} is applied: delete it`);
  assert.deepEqual(new Set([...stages, ...APPLIED_STAGES]), new Set(Object.keys(STAGES)));
  assert.deepEqual(STAGES.apiTokenEnforcement.requires, ['apiPersistence', 'clientTokens']);
  assert.throws(() => expectedFor(['nope']), /unknown stage/);
});

test('each proposal differs from railway.ts by exactly its expectedChanges, and passes its stage rules', async () => {
  for (const [name, p] of Object.entries(PROPOSALS)) {
    const def = await staged(p);
    const { unexpected, missing } = compareChanges(definitionChanges(base, def), p.expectedChanges);
    assert.deepEqual(unexpected, [], `${name}: unexpected`);
    assert.deepEqual(missing, [], `${name}: missing`);
    const r = rules(def, [...APPLIED_STAGES, p.stage]);
    assert.deepEqual(r.failures, [], `${name}: ${r.failures.join('; ')}`);
  }
});

test('a stage is never current state by accident: railway.ts rules reject each proposal', async () => {
  const patterns = {
    authClients:
      /RETAILING_API_SERVICE_TOKEN is a pending change|METRICS_TOKEN is a pending change/,
    authEnforce: /pending change/,
    deployPolicy: /checkSuites/,
  };
  for (const [name, pattern] of Object.entries(patterns)) {
    fails(await staged(PROPOSALS[name]), APPLIED_STAGES, pattern);
  }
  // And the pre-stage-1 rules reject today's baseline (it has the volume).
  fails(base, [], /volume|builder must be RAILPACK/);
});

// --- Stage 1: persistence -----------------------------------------------------------------------

test('stage 1 (applied): railway.ts mounts exactly velasia-api-data at /data, Docker-built, health-checked', () => {
  const def = base;
  const api = servicesOf(def)[API];
  assert.equal(api.build.builder, 'DOCKERFILE');
  assert.equal(api.build.dockerfilePath, 'docker/Dockerfile.api');
  assert.equal(api.deploy.healthcheckPath, '/health/ready');
  assert.deepEqual(Object.values(api.volumeAttachments), [
    {
      volume: 'volume.velasia-api-data',
      mountPath: '/data',
      volumeConfig: { region: 'iad', sizeMB: 500 },
    },
  ]);
  const literal = (k) => api.variables[k]?.value;
  assert.equal(literal('TALADB_PATH'), '/data/velasia.db');
  assert.equal(literal('TALADB_REQUIRE_VOLUME'), 'enabled');
  assert.equal(literal('RAILWAY_RUN_UID'), '0');
  assert.equal(literal('PORT'), '4010');
  assert.equal(literal('RETAILING_API_PORT'), '4010');
  // The draining window outlasts the API's own shutdown bound.
  assert.ok(
    Number(literal('RAILWAY_DEPLOYMENT_DRAINING_SECONDS')) * 1000 >
      Number(literal('SHUTDOWN_TIMEOUT_MS')),
  );
  for (const name of [NODE, NEXTRS]) {
    assert.equal(Object.keys(servicesOf(def)[name].volumeAttachments ?? {}).length, 0, name);
  }
});

test('stage 1 rules reject a wrong mount, size, region, missing guard or missing health check', () => {
  const def = base;
  const S = ['apiPersistence'];
  const vol = (d) => d.resources.flat().find((r) => r.type === 'volume');
  fails(
    mutate(def, (s) => {
      Object.values(s[API].volumeAttachments)[0].mountPath = '/var/lib/velasia';
    }),
    S,
    /must mount exactly volume velasia-api-data at \/data/,
  );
  const bigger = structuredClone(def);
  vol(bigger).config.sizeMB = 5000;
  fails(bigger, S, /must be 500 MB in iad/);
  const moved = structuredClone(def);
  vol(moved).config.region = 'sin';
  fails(moved, S, /must be 500 MB in iad/);
  const dropped = structuredClone(def);
  dropped.resources = dropped.resources.flat().filter((r) => r.type !== 'volume');
  fails(dropped, S, /volume velasia-api-data is live but missing here: an apply would DELETE it/);
  fails(
    mutate(def, (s) => {
      s[NODE].volumeAttachments = structuredClone(s[API].volumeAttachments);
    }),
    S,
    /@velasia\/web: no volume attachment/,
  );
  fails(
    mutate(def, (s) => {
      s[API].variables.TALADB_REQUIRE_VOLUME = { type: 'literal', value: 'disabled' };
    }),
    S,
    /TALADB_REQUIRE_VOLUME must be enabled/,
  );
  fails(
    mutate(def, (s) => {
      delete s[API].deploy.healthcheckPath;
    }),
    S,
    /deploy health check must be \/health\/ready/,
  );
  fails(
    mutate(def, (s) => {
      delete s[API].variables.RAILWAY_RUN_UID;
    }),
    S,
    /RAILWAY_RUN_UID is live but missing here/,
  );
  fails(
    mutate(def, (s) => {
      s[API].deploy.multiRegionConfig = { iad: { numReplicas: 2 } };
    }),
    S,
    /exactly one replica/,
  );
});

// --- Stages 2–3: tokens -------------------------------------------------------------------------

test('stages 2 and 3: tokens are shared-variable references on both storefronts, never values', async () => {
  const clients = servicesOf(await staged(authClients));
  for (const name of [NODE, NEXTRS]) {
    for (const v of ['RETAILING_API_SERVICE_TOKEN', 'METRICS_TOKEN']) {
      assert.deepEqual(clients[name].variables[v], { type: 'sharedReference', name: v });
    }
  }
  assert.equal(clients[API].variables.RETAILING_API_SERVICE_TOKEN, undefined);
  const enforce = servicesOf(await staged(authEnforce));
  assert.deepEqual(enforce[API].variables.RETAILING_API_SERVICE_TOKEN, {
    type: 'sharedReference',
    name: 'RETAILING_API_SERVICE_TOKEN',
  });

  const literalToken = mutate(await staged(authClients), (s) => {
    s[NODE].variables.RETAILING_API_SERVICE_TOKEN = { type: 'literal', value: 'x'.repeat(64) };
  });
  fails(
    literalToken,
    ['clientTokens'],
    /must be ctx\.shared\.RETAILING_API_SERVICE_TOKEN or preserve/,
  );
  const oneSided = mutate(await staged(authClients), (s) => {
    delete s[NEXTRS].variables.METRICS_TOKEN;
  });
  fails(
    oneSided,
    ['clientTokens'],
    /storefront environments differ|METRICS_TOKEN is live but missing/,
  );
});

// --- Stage 5: deploy policy ---------------------------------------------------------------------

test('stage 5: every service waits for CI, and the storefronts watch identical paths', async () => {
  const s = servicesOf(await staged(deployPolicy));
  for (const name of [API, NODE, NEXTRS]) assert.equal(s[name].source.checkSuites, true, name);
  assert.deepEqual(s[NODE].build.watchPatterns, s[NEXTRS].build.watchPatterns);
  for (const path of ['/apps/web/**', '/packages/**', '/Dockerfile.node', '/Dockerfile.nextrs']) {
    assert.ok(s[NODE].build.watchPatterns.includes(path), path);
  }
  for (const path of ['/apps/retailing-api/**', '/docker/api/**', '/docker/Dockerfile.api']) {
    assert.ok(s[API].build.watchPatterns.includes(path), path);
  }
  const drift = mutate(await staged(deployPolicy), (x) => {
    x[NEXTRS].build.watchPatterns = ['/apps/web/**'];
  });
  fails(drift, ['deployPolicy'], /storefront watch patterns differ/);
  const noCi = mutate(await staged(deployPolicy), (x) => {
    x[NODE].source.checkSuites = false;
  });
  fails(noCi, ['deployPolicy'], /checkSuites \(wait for CI\) must be true/);
});

// --- The live plan gate, on the real plans ------------------------------------------------------

// The fixtures were planned before stage 1: judge each against the stages applied then (none).
const gate = (name, mod) =>
  evaluatePlan(fixture(name), {
    expected: expectedFor([mod.stage]),
    expectedChanges: mod.expectedChanges,
  });

test('plan gate: the real stage 1, 2 and 5 plans pass with exactly their changes', () => {
  for (const [name, mod, total] of [
    ['api-persistence', stage1, 9],
    ['auth-clients', authClients, 4],
    ['deploy-policy', deployPolicy, 6],
  ]) {
    const r = gate(name, mod);
    assert.deepEqual(r.problems, [], name);
    assert.equal(r.counts.total, total, name);
    assert.equal(r.counts.destructive, 0, name);
    assert.equal(r.counts.delete, 0, name);
  }
});

test('plan gate: the stage 1 plan is refused against pre-stage-1 production (a volume was not current)', () => {
  const r = evaluatePlan(fixture('api-persistence'), {
    expected: expectedFor([]),
    expectedChanges: STAGE1_CHANGES,
  });
  hasProblem(r, /declares unexpected volume velasia-api-data/);
  hasProblem(r, /attaches an unexpected volume to @velasia\/retailing-api/);
});

test('plan gate: an update outside the listed settings fails, even on the right service', () => {
  const plan = fixture('api-persistence');
  plan.changeSet.changes.push({
    kind: 'resource.update',
    severity: 'safe',
    summary:
      'Update @velasia/retailing-api deploy.multiRegionConfig.iad.numReplicas, deploy.region',
  });
  hasProblem(
    evaluatePlan(plan, {
      expected: expectedFor(['apiPersistence']),
      expectedChanges: STAGE1_CHANGES,
    }),
    /changes settings outside the proposal: deploy\.multiRegionConfig\.iad\.numReplicas, deploy\.region/,
  );
  // An expected update without a field list accepts nothing.
  const bare = STAGE1_CHANGES.map(({ fields: _f, ...c }) => c);
  hasProblem(
    evaluatePlan(fixture('api-persistence'), {
      expected: expectedFor(['apiPersistence']),
      expectedChanges: bare,
    }),
    /changes settings outside the proposal/,
  );
  assert.deepEqual(
    changeFields({ summary: 'Update @velasia/web source.checkSuites, build.watchPatterns' }),
    ['source.checkSuites', 'build.watchPatterns'],
  );
  assert.equal(changeFields({ summary: 'Update @velasia/web' }), null);
});

test('plan gate: dropping, resizing, moving or re-attaching the volume fails', () => {
  const S = expectedFor(['apiPersistence']);
  const changes = STAGE1_CHANGES;
  // After stage 1: production has the volume; a plan that drops it deletes the database.
  const dropped = fixture('api-persistence');
  dropped.currentGraph = structuredClone(dropped.desiredGraph);
  dropped.desiredGraph.resources = dropped.desiredGraph.resources.filter(
    (r) => r.type !== 'volume',
  );
  dropped.changeSet.changes = [
    { kind: 'resource.delete', severity: 'destructive', summary: 'Delete volume velasia-api-data' },
  ];
  const r = evaluatePlan(dropped, { expected: S, expectedChanges: [] });
  hasProblem(r, /drops live volume velasia-api-data/);
  hasProblem(r, /unexpected deletion: Delete volume velasia-api-data/);

  const resized = fixture('api-persistence');
  resized.desiredGraph.resources.find((x) => x.type === 'volume').config.sizeMB = 50_000;
  hasProblem(evaluatePlan(resized, { expected: S, expectedChanges: changes }), /changes volume/);

  const elsewhere = fixture('api-persistence');
  const web = elsewhere.desiredGraph.resources.find((x) => x.name === NODE);
  web.volumeAttachments = {
    'velasia-api-data': { volume: 'volume.velasia-api-data', mountPath: '/data' },
  };
  hasProblem(
    evaluatePlan(elsewhere, { expected: S, expectedChanges: changes }),
    /attaches an unexpected volume to @velasia\/web/,
  );
});
