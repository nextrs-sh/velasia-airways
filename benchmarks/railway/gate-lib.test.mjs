// node --test benchmarks/railway/gate-lib.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  baselineFileProblems,
  baselineProblems,
  classifyRun,
  mergeThresholds,
  parseMetrics,
  recoveryProblems,
  saturationSignals,
  snapshotProblems,
  summarizeBaseline,
  windowStats,
} from './gate-lib.mjs';

/** A scrape of the retailing API as the gate would see it. */
function scrape(at, o = {}) {
  const v = {
    start: 1000,
    cpu: 10,
    workload: 100,
    metrics: 50,
    s5xx: 0,
    s429: 0,
    inFlight: 1,
    queue: 0,
    loop: 0.011,
    writes: 7,
    rateLimited: 0,
    offers: 1200,
    sessions: 3,
    offersCreated: 5000,
    sessionsCreated: 40,
    rss: 150000000,
    probes: [],
    drop: [],
    ...o,
  };
  const text = [
    ...v.probes.map((ms) => `# velasia_gate_probe_ms ${ms}`),
    '# TYPE velasia_http_requests_total counter',
    '# TYPE velasia_api_errors_total counter',
    '# TYPE velasia_writer_task_seconds histogram',
    '# HELP process_start_time_seconds When the process started (Unix seconds).',
    `process_start_time_seconds{service="retailing-api"} ${v.start}`,
    `process_cpu_seconds_total{service="retailing-api",mode="user"} ${v.cpu * 0.8}`,
    `process_cpu_seconds_total{service="retailing-api",mode="system"} ${v.cpu * 0.2}`,
    `process_resident_memory_bytes{service="retailing-api"} ${v.rss}`,
    'nodejs_heap_bytes{service="retailing-api",kind="used"} 60000000',
    `nodejs_eventloop_delay_seconds{service="retailing-api",quantile="0.99"} ${v.loop}`,
    `velasia_http_requests_total{method="GET",route="/v1/flights",status="200"} ${v.workload}`,
    `velasia_http_requests_total{method="GET",route="/metrics",status="200"} ${v.metrics}`,
    `velasia_http_requests_total{method="GET",route="/health/ready",status="200"} ${v.metrics}`,
    `velasia_http_requests_total{method="GET",route="/v1/offers",status="503"} ${v.s5xx}`,
    `velasia_http_requests_total{method="POST",route="/v1/sessions",status="429"} ${v.s429}`,
    `velasia_api_errors_total{code="RATE_LIMITED"} ${v.rateLimited}`,
    `velasia_http_requests_in_flight ${v.inFlight}`,
    `velasia_writer_queue_depth ${v.queue}`,
    `velasia_writer_task_seconds_count ${v.writes}`,
    'velasia_writer_task_seconds_bucket{le="+Inf"} 7',
    `velasia_memory_store_entries{store="offers"} ${v.offers}`,
    `velasia_memory_store_entries{store="sessions"} ${v.sessions}`,
    `velasia_memory_store_created_total{store="offers"} ${v.offersCreated}`,
    `velasia_memory_store_created_total{store="sessions"} ${v.sessionsCreated}`,
  ]
    .filter((line) => !v.drop.some((name) => line.includes(name)))
    .join('\n');
  return { at, ...parseMetrics(text) };
}

test('parseMetrics reads labels, +Inf, and probe comment lines', () => {
  const { samples, probesMs } = parseMetrics(
    '# velasia_gate_probe_ms 1.5\n# HELP x y\nx_bucket{le="+Inf",a="q\\"uote"} 3\ny +Inf\n',
  );
  assert.deepEqual(probesMs, [1.5]);
  assert.deepEqual(samples[0], { name: 'x_bucket', labels: { le: '+Inf', a: 'q"uote' }, value: 3 });
  assert.equal(samples[1].value, Infinity);
});

test('windowStats: CPU rate, workload excludes scrapes, health and the gate probes', () => {
  const a = scrape(0, { cpu: 10, workload: 100, metrics: 50 });
  const b = scrape(10_000, { cpu: 12, workload: 105, metrics: 60, probes: [2, 3, 4, 5, 6] });
  const w = windowStats(a, b, { probeRequests: 5 });
  assert.ok(Math.abs(w.cpuCores - 0.2) < 1e-9);
  assert.equal(w.requests, 0); // 5 more on a workload route, all of them the gate's probes
  assert.equal(w.probeP50Ms, 4);
  assert.equal(w.startTime, 1000);
});

test('baselineProblems refuses a busy or restarted API', () => {
  const idle = windowStats(scrape(0), scrape(10_000));
  assert.deepEqual(baselineProblems([idle]), []);
  const busy = windowStats(scrape(0), scrape(10_000, { workload: 400, queue: 2 }));
  assert.equal(baselineProblems([busy]).length, 2);
  const restarted = windowStats(scrape(0), scrape(10_000, { start: 2000 }));
  assert.match(baselineProblems([idle, restarted]).join(), /restarted/);
  assert.match(baselineProblems([idle], { minWindows: 3 }).join(), /incomplete baseline: 1 of 3/);
});

const baselineFrom = (...scrapes) => {
  const windows = [];
  for (let i = 1; i < scrapes.length; i++) windows.push(windowStats(scrapes[i - 1], scrapes[i]));
  return summarizeBaseline(windows, { source: 'test' });
};

test('recoveryProblems: recovered only when traffic, CPU, backlog, errors and latency are back', () => {
  const baseline = baselineFrom(
    scrape(0, { cpu: 10, probes: [2] }),
    scrape(10_000, { cpu: 10.1, probes: [2] }),
    scrape(20_000, { cpu: 10.2, probes: [2] }),
  );
  assert.ok(Math.abs(baseline.cpuCoresMax - 0.01) < 1e-9);
  const ok = windowStats(scrape(0, { probes: [2] }), scrape(10_000, { cpu: 10.1, probes: [2] }));
  assert.deepEqual(recoveryProblems(ok, baseline), []);

  const busy = windowStats(
    scrape(0),
    scrape(10_000, { cpu: 18, workload: 900, inFlight: 9, queue: 3, s5xx: 1, probes: [40] }),
  );
  const problems = recoveryProblems(busy, baseline).join('; ');
  for (const part of ['traffic', 'in-flight', 'queue', '5xx', 'CPU', 'probe p50']) {
    assert.match(problems, new RegExp(part));
  }
  const restarted = windowStats(scrape(0), scrape(10_000, { start: 5 }));
  assert.match(recoveryProblems(restarted, baseline)[0], /^RESTARTED/);
});

test('classifyRun: sustained saturation or API errors make a run backend-limited', () => {
  const baseline = baselineFrom(scrape(0), scrape(10_000), scrape(20_000));
  const clean = [windowStats(scrape(0), scrape(2000, { workload: 300, cpu: 11 }))];
  assert.equal(classifyRun(clean, baseline).verdict, 'ok');

  // One saturated window is a blip; two in a row are saturation.
  const blip = [
    windowStats(scrape(0), scrape(2000, { queue: 6 })),
    windowStats(scrape(2000), scrape(4000)),
  ];
  assert.equal(classifyRun(blip, baseline).verdict, 'ok');
  const sustained = [
    windowStats(scrape(0), scrape(2000, { queue: 6 })),
    windowStats(scrape(2000, { queue: 6 }), scrape(4000, { queue: 9 })),
  ];
  assert.equal(classifyRun(sustained, baseline).verdict, 'backend-limited');

  const limited = [windowStats(scrape(0), scrape(2000, { rateLimited: 2, s429: 2 }))];
  const result = classifyRun(limited, baseline);
  assert.equal(result.verdict, 'backend-limited');
  assert.equal(result.totals.rateLimited, 2); // the same two answers, by status and by code

  const restarted = [windowStats(scrape(0), scrape(2000, { start: 9 }))];
  assert.equal(classifyRun(restarted, baseline).verdict, 'restarted');
});

test('classifyRun flags writes beyond the idle rate (not a read-only run)', () => {
  const baseline = baselineFrom(scrape(0), scrape(10_000), scrape(20_000));
  const read = [windowStats(scrape(0), scrape(2000, { workload: 500 }))];
  assert.equal(classifyRun(read, baseline).wrote, false);
  const wrote = [windowStats(scrape(0), scrape(2000, { writes: 40, workload: 300 }))];
  assert.equal(classifyRun(wrote, baseline).wrote, true);
});

// --- Fail closed --------------------------------------------------------------------------

test('missing metrics make a scrape and its window invalid, never zero', () => {
  for (const name of [
    'process_cpu_seconds_total',
    'nodejs_eventloop_delay_seconds',
    'process_start_time_seconds',
    'velasia_writer_queue_depth',
    'velasia_memory_store_entries',
    'velasia_memory_store_created_total',
  ]) {
    const b = scrape(10_000, { drop: [name] });
    assert.ok(
      snapshotProblems(b).some((p) => p.includes(name)),
      name,
    );
    const w = windowStats(scrape(0), b);
    assert.ok(w.invalid.length > 0, name);
  }
  const noFamily = scrape(0, { drop: ['# TYPE velasia_api_errors_total'] });
  assert.match(snapshotProblems(noFamily).join(), /velasia_api_errors_total not exported/);
  assert.deepEqual(snapshotProblems({ at: 1 }), ['no scrape']);
});

test('non-numeric values, malformed lines and bad timestamps are invalid', () => {
  const nan = windowStats(scrape(0), scrape(10_000, { loop: 'abc', cpu: 'NaN' }));
  assert.match(nan.invalid.join(), /non-numeric nodejs_eventloop_delay_seconds/);
  assert.match(nan.invalid.join(), /non-numeric process_cpu_seconds_total/);
  const garbage = { at: 10_000, ...parseMetrics('<html>502 Bad Gateway</html>') };
  assert.ok(windowStats(scrape(0), garbage).invalid.some((p) => /malformed|missing/.test(p)));
  const backwards = windowStats(scrape(10_000), scrape(5_000));
  assert.match(backwards.invalid.join(), /out of order/);
  const reset = windowStats(scrape(0, { cpu: 50 }), scrape(10_000, { cpu: 10 }));
  assert.match(reset.invalid.join(), /went down without a restart/);
  const fewProbes = windowStats(scrape(0), scrape(10_000, { probes: [1] }), { expectProbes: 5 });
  assert.match(fewProbes.invalid.join(), /1 probe timings, expected 5/);
});

test('an invalid window is never a recovery, a baseline or a clean run', () => {
  const baseline = baselineFrom(scrape(0), scrape(10_000), scrape(20_000));
  const invalid = windowStats(scrape(0), scrape(10_000, { drop: ['process_cpu_seconds_total'] }));
  assert.match(recoveryProblems(invalid, baseline)[0], /^INVALID/);
  assert.match(baselineProblems([invalid]).join(), /INVALID/);
  const run = classifyRun([invalid], baseline);
  assert.equal(run.verdict, 'invalid');
  // A window object without a validity record is treated the same way.
  const { invalid: _, ...unchecked } = windowStats(scrape(0), scrape(10_000));
  assert.match(recoveryProblems(unchecked, baseline)[0], /^INVALID/);
  assert.equal(classifyRun([unchecked], baseline).verdict, 'invalid');
});

test('classifyRun: no windows or too little watched time is invalid', () => {
  const baseline = baselineFrom(scrape(0), scrape(10_000), scrape(20_000));
  assert.equal(classifyRun([], baseline).verdict, 'invalid');
  const short = [windowStats(scrape(0), scrape(2000))];
  const result = classifyRun(short, baseline, { expectSeconds: 60 });
  assert.equal(result.verdict, 'invalid');
  assert.match(result.invalid.join(), /watched for 2 s of a 60 s run/);
});

test('baselineFileProblems refuses a baseline with holes', () => {
  const good = baselineFrom(scrape(0), scrape(10_000), scrape(20_000));
  assert.deepEqual(baselineFileProblems(good), []);
  assert.match(baselineFileProblems({ ...good, cpuCoresMax: null }).join(), /cpuCoresMax/);
  assert.match(baselineFileProblems({ ...good, problems: ['busy'] }).join(), /refused/);
  assert.match(baselineFileProblems({ kind: 'other' }).join(), /not a gate baseline/);
  const probed = summarizeBaseline([windowStats(scrape(0), scrape(1))], { expectProbes: 5 });
  assert.match(baselineFileProblems(probed).join(), /probe latency/);
});

// --- Saturation ---------------------------------------------------------------------------

test('saturation: memory pressure and probe-latency spikes are signals', () => {
  const baseline = baselineFrom(
    scrape(0, { probes: [2] }),
    scrape(10_000, { probes: [2] }),
    scrape(20_000, { probes: [2] }),
  );
  const limits = { ...mergeThresholds().saturation, memoryLimitBytes: 768 * 2 ** 20 };
  const heavy = windowStats(scrape(0), scrape(2000, { rss: 700 * 2 ** 20, probes: [80] }));
  const signals = saturationSignals(heavy, limits, baseline).join();
  assert.match(signals, /RSS 700 MiB of 768 MiB/);
  assert.match(signals, /probe p50 80/);
  const calm = windowStats(scrape(0), scrape(2000, { probes: [3] }));
  assert.deepEqual(saturationSignals(calm, limits, baseline), []);
});

test('classifyRun counts offers and sessions created in the shared stores', () => {
  const baseline = baselineFrom(scrape(0), scrape(10_000), scrape(20_000));
  const reused = [windowStats(scrape(0), scrape(2000, { workload: 400 }))];
  assert.equal(classifyRun(reused, baseline).totals.offersCreated, 0);
  const created = [windowStats(scrape(0), scrape(2000, { offers: 1300, offersCreated: 5100 }))];
  assert.equal(classifyRun(created, baseline).totals.offersCreated, 100);
  const session = [windowStats(scrape(0), scrape(2000, { sessions: 4, sessionsCreated: 41 }))];
  assert.equal(classifyRun(session, baseline).wrote, true);
});

test('classifyRun (M9.3): creation hidden by a sweep of expired entries is still counted', () => {
  const baseline = baselineFrom(scrape(0), scrape(10_000), scrape(20_000));
  // 100 offers created while 100 expired ones were swept: the store size did not change.
  const swept = [windowStats(scrape(0), scrape(2000, { offers: 1200, offersCreated: 5100 }))];
  assert.equal(classifyRun(swept, baseline).totals.offersCreated, 100);
  // Shopping sessions the same way: the store shrank, yet one was created (a write).
  const session = [windowStats(scrape(0), scrape(2000, { sessions: 1, sessionsCreated: 41 }))];
  assert.equal(classifyRun(session, baseline).totals.sessionsCreated, 1);
  assert.equal(classifyRun(session, baseline).wrote, true);
  // The store shrinking (expiry) is not "negative creation".
  const shrank = [windowStats(scrape(0), scrape(2000, { offers: 900 }))];
  assert.equal(classifyRun(shrank, baseline).totals.offersCreated, 0);
});

test('classifyRun (M9.3): an API without the created counters fails closed', () => {
  const old = scrape(2000, { drop: ['velasia_memory_store_created_total'] });
  assert.ok(snapshotProblems(old).some((p) => p.includes('velasia_memory_store_created_total')));
  const w = windowStats(scrape(0), old);
  assert.ok(w.invalid.length > 0);
  // A count that goes down without a restart is a broken source, not zero.
  const down = windowStats(scrape(0), scrape(2000, { offersCreated: 4000 }));
  assert.ok(down.invalid.some((r) => r.includes('went down without a restart')));
});

test('classifyRun: background writer work with no workload traffic is not a write by the run', () => {
  const baseline = baselineFrom(scrape(0), scrape(10_000), scrape(20_000));
  // The order sweep wrote once while no workload request reached the API (rsc, static assets).
  const sweep = [windowStats(scrape(0), scrape(2000, { writes: 8 }))];
  const result = classifyRun(sweep, baseline);
  assert.equal(result.wrote, false);
  assert.equal(result.backgroundWrites, 1);
  // The same write while workload requests reached the API is held against the run.
  const busy = [windowStats(scrape(0), scrape(2000, { writes: 8, workload: 150 }))];
  assert.equal(classifyRun(busy, baseline).wrote, true);
});

test('mergeThresholds refuses unknown keys and non-numbers', () => {
  assert.equal(mergeThresholds({ saturation: { queueDepth: 8 } }).saturation.queueDepth, 8);
  assert.equal(mergeThresholds({ sustain: 3 }).sustain, 3);
  assert.throws(() => mergeThresholds({ saturation: { queueDeph: 8 } }), /unknown threshold/);
  assert.throws(() => mergeThresholds({ recovery: { cpuFactor: 'x' } }), /number/);
  assert.throws(() => mergeThresholds({ other: {} }), /unknown thresholds group/);
  assert.throws(() => mergeThresholds({ sustain: 0 }), /sustain/);
});
