// node --test benchmarks/railway/pair-lib.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cgroupCores,
  deploymentProblems,
  durationSeconds,
  k6Problems,
  pairProblems,
  procCpuSeconds,
  refusedWorkload,
  summarizeK6,
} from './pair-lib.mjs';

/** A k6 --summary-export file for a clean run of `n` single-request iterations. */
function k6Export(n = 300, o = {}) {
  const metrics = {
    http_reqs: { count: n + (o.setup ?? 0), rate: n / 60 },
    iterations: { count: n, rate: n / 60 },
    http_req_failed: { value: 0, passes: 0, fails: n },
    http_req_duration: { avg: 20, med: 18, 'p(90)': 30, 'p(95)': 35, 'p(99)': 50, max: 90 },
    http_req_waiting: { avg: 15, med: 14, 'p(90)': 25, 'p(95)': 28, 'p(99)': 40, max: 80 },
    data_received: { count: 1_000_000, rate: 1 },
    data_sent: { count: 50_000, rate: 1 },
    velasia_correct: { value: 1, passes: n, fails: 0 },
    velasia_status_2xx: { count: n, rate: 1 },
    velasia_compressed: { value: 1, passes: n, fails: 0 },
    ...o.metrics,
  };
  for (const key of o.drop ?? []) delete metrics[key];
  return { metrics };
}
const cpu = { cores: 0.1, peakCores: 0.2, runnerCores: 2, seconds: 60 };

test('refusedWorkload: writes and the unvalidated Server Action are refused', () => {
  for (const allowed of ['static-assets', 'rsc', 'flight-search', 'route-handler']) {
    assert.equal(refusedWorkload(allowed), undefined, allowed);
  }
  assert.match(refusedWorkload('payment'), /changes shared state/);
  assert.match(refusedWorkload('checkout'), /changes shared state/);
  assert.match(refusedWorkload('mixed'), /changes shared state/);
  assert.match(refusedWorkload('server-action'), /excluded until/);
  assert.match(refusedWorkload('nope'), /unknown/);
});

test('refusedWorkload: offer-cache workloads are refused since M9.3 (real-time expiry)', () => {
  for (const w of ['offers', 'comparison']) {
    assert.match(refusedWorkload(w), /offer cache/);
    assert.match(refusedWorkload(w), /cannot be made equal/);
  }
});

test('durationSeconds reads k6 durations', () => {
  assert.equal(durationSeconds('60s'), 60);
  assert.equal(durationSeconds('5m'), 300);
  assert.equal(durationSeconds('1m30s'), 90);
  assert.ok(Number.isNaN(durationSeconds('soon')));
  assert.ok(Number.isNaN(durationSeconds('')));
});

test('k6Problems: a clean fixed-rate run passes', () => {
  const s = summarizeK6(k6Export(300));
  assert.deepEqual(k6Problems(s, { rate: 5, seconds: 60, cpu }), []);
  assert.equal(s.status['2xx'], 300);
  assert.equal(s.ttfbMs.p95, 28);
});

test('k6Problems: missing or failed k6 evidence is refused', () => {
  assert.deepEqual(k6Problems(null), ['no k6 summary']);
  assert.equal(summarizeK6({}), null);
  const noChecks = summarizeK6(k6Export(300, { drop: ['velasia_correct'] }));
  assert.match(k6Problems(noChecks, { cpu }).join(), /no correctness checks/);
  const wrong = summarizeK6(
    k6Export(300, { metrics: { velasia_correct: { value: 0.99, passes: 297, fails: 3 } } }),
  );
  assert.match(k6Problems(wrong, { cpu }).join(), /3 failed checks/);
  const failed = summarizeK6(k6Export(300, { drop: ['http_req_failed'] }));
  assert.match(k6Problems(failed, { cpu }).join(), /http_req_failed missing/);
  const noLatency = summarizeK6(k6Export(300, { drop: ['http_req_duration'] }));
  assert.match(k6Problems(noLatency, { cpu }).join(), /no latency/);
});

test('k6Problems: 5xx, 429 and an incomplete status distribution', () => {
  const errors = summarizeK6(
    k6Export(300, {
      metrics: {
        velasia_status_2xx: { count: 290 },
        velasia_status_5xx: { count: 4 },
        velasia_status_4xx: { count: 6 },
        velasia_status_429: { count: 6 },
      },
    }),
  );
  const problems = k6Problems(errors, { cpu }).join();
  assert.match(problems, /4 answers 5xx/);
  assert.match(problems, /6 answers 429/);
  const partial = summarizeK6(k6Export(300, { metrics: { velasia_status_2xx: { count: 200 } } }));
  assert.match(k6Problems(partial, { cpu }).join(), /covers 200 of 300/);
});

test('k6Problems: dropped iterations, unreached rate, and k6 CPU-bound', () => {
  const dropped = summarizeK6(k6Export(280, { metrics: { dropped_iterations: { count: 20 } } }));
  const problems = k6Problems(dropped, { rate: 5, seconds: 60, cpu }).join();
  assert.match(problems, /20 of 300 iterations dropped/);
  assert.match(problems, /280 iterations started/);
  const busy = { ...cpu, peakCores: 1.9 };
  assert.match(k6Problems(summarizeK6(k6Export()), { cpu: busy }).join(), /k6 CPU-bound/);
  assert.match(k6Problems(summarizeK6(k6Export()), { cpu: null }).join(), /CPU not measured/);
});

const service = (o = {}) => ({
  deploymentId: 'dep-1',
  commit: 'abc123',
  region: 'asia-southeast1-eqsg3a',
  replicas: 1,
  cpu: 1,
  memoryBytes: 1073741824,
  status: 'SUCCESS',
  ...o,
});
const deployments = (o = {}) => ({
  nextrsVersion: '0.1.0-rc.2',
  services: {
    'velasia-node': service(),
    'velasia-nextrs': service({ deploymentId: 'dep-2' }),
    'velasia-api': service({ deploymentId: 'dep-3', memoryBytes: 805306368 }),
    ...o,
  },
});

test('deploymentProblems: revision, limits, region, replicas and NextRS version', () => {
  assert.deepEqual(deploymentProblems(deployments()), []);
  assert.deepEqual(deploymentProblems(null), ['no deployment metadata (DEPLOYMENTS)']);
  const mismatch = deploymentProblems(
    deployments({
      'velasia-nextrs': service({ commit: 'def456', cpu: 2, region: 'us-west2' }),
      'velasia-node': service({ replicas: 2, status: 'DEPLOYING' }),
    }),
  ).join();
  for (const part of [
    'different commits',
    'limits differ',
    'different regions',
    '2 replicas',
    'DEPLOYING',
  ]) {
    assert.match(mismatch, new RegExp(part));
  }
  assert.match(
    deploymentProblems({ ...deployments(), nextrsVersion: '0.1.0-rc.1' }).join(),
    /expected 0.1.0-rc.2/,
  );
});

/** Evidence for a clean pair; `o` overrides parts of it. */
function evidence(o = {}) {
  const gate = { verdict: 'ok', reasons: [], wrote: false, totals: { offersCreated: 0 } };
  const id = { ready: 200, deploymentId: null, assetCount: 12, assetsSha256: 'aa' };
  const ids = { node: id, nextrs: { ...id, assetsSha256: 'bb' } };
  return {
    order: ['node', 'nextrs'],
    config: { rate: 5, seconds: 60 },
    runs: {
      node: { gate, k6: summarizeK6(k6Export()), cpu },
      nextrs: { gate, k6: summarizeK6(k6Export()), cpu },
    },
    recovered: { node: true, nextrs: true },
    identityBefore: ids,
    identityAfter: ids,
    deployments: deployments(),
    series: { proven: true },
    ...o,
  };
}

test('pairProblems: a clean pair is comparable', () => {
  assert.deepEqual(pairProblems(evidence()), []);
});

test('pairProblems: every missing piece of evidence blocks comparable', () => {
  const cases = [
    [{ deployments: undefined }, /no deployment metadata/],
    [{ series: undefined }, /same API process not proven/],
    [{ recovered: { node: true } }, /nextrs: API recovery not confirmed/],
    [{ identityAfter: undefined }, /identity not recorded/],
    [{ runs: { node: evidence().runs.node } }, /nextrs: no measured run/],
    [{ order: ['node'] }, /order is not two runtimes/],
  ];
  for (const [override, pattern] of cases) {
    assert.match(pairProblems(evidence(override)).join('\n'), pattern);
  }
});

test('pairProblems: invalid comparison states', () => {
  const limited = { verdict: 'backend-limited', reasons: ['3 API answers 5xx'], wrote: false };
  const runs = (nextrs) => ({
    runs: { ...evidence().runs, nextrs: { ...evidence().runs.nextrs, ...nextrs } },
  });
  const cases = [
    [runs({ gate: { ...limited, totals: { offersCreated: 0 } } }), /API backend-limited/],
    [runs({ gate: null }), /no API verdict/],
    [
      runs({ gate: { verdict: 'ok', reasons: [], wrote: false, totals: { offersCreated: 40 } } }),
      /40 offers created/,
    ],
    [
      runs({ gate: { verdict: 'ok', reasons: [], wrote: true, totals: { offersCreated: 0 } } }),
      /write/,
    ],
    [runs({ k6: null }), /no k6 summary/],
    [runs({ k6: summarizeK6(k6Export(250)) }), /iteration counts differ: 300 vs 250/],
  ];
  for (const [override, pattern] of cases) {
    assert.match(pairProblems(evidence(override)).join('\n'), pattern);
  }
});

test('pairProblems: a deployment revision change during the pair', () => {
  const before = evidence().identityBefore;
  const after = { ...before, nextrs: { ...before.nextrs, assetsSha256: 'cc' } };
  assert.match(pairProblems(evidence({ identityAfter: after })).join(), /deployment changed/);
  const noAssets = { ...before, node: { ...before.node, assetCount: 0, assetsSha256: null } };
  assert.match(
    pairProblems(evidence({ identityBefore: noAssets, identityAfter: noAssets })).join(),
    /no build fingerprint/,
  );
});

test('procCpuSeconds and cgroupCores read Linux process and cgroup files', () => {
  const stat = '4242 (k6 (load)) S 1 4242 4242 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 9 0 1 2 3';
  assert.equal(procCpuSeconds(stat), 3); // (250 + 50) ticks / 100
  assert.equal(procCpuSeconds('garbage'), null);
  assert.equal(cgroupCores('200000 100000', 8), 2);
  assert.equal(cgroupCores('max 100000', 8), 8);
  assert.equal(cgroupCores(null, 4), 4);
});
