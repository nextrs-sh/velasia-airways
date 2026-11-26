/**
 * Shared-API gate for paired Node.js / NextRS benchmark runs: the pure part (no I/O), so it can
 * be tested on its own. The CLI is api-gate.mjs; the orchestration is pair.mjs; the procedure is
 * docs/deployment/railway-benchmark-readiness.md.
 *
 * Everything here reads the retailing API's own Prometheus metrics (apps/retailing-api/src/
 * observability.ts and packages/observability/src/process-metrics.ts). Two scrapes `a` and `b`
 * make a window; counters become per-window deltas, gauges are read from `b`.
 *
 * Fail closed: a window whose metrics are missing, non-numeric, out of order or reset is marked
 * `invalid` (with the reason) and is never read as a healthy window. Missing values are never
 * replaced by zero.
 */

/** Routes that are not workload traffic: the gate's own scrapes and health probes. */
export const NON_WORKLOAD_ROUTES = new Set([
  '/metrics',
  '/health',
  '/health/live',
  '/health/ready',
]);

/**
 * Samples every scrape must contain. They are gauges set on every scrape (collect callbacks),
 * or series that exist as soon as the gate's own probes have run.
 */
export const REQUIRED_SAMPLES = [
  ['process_start_time_seconds', {}],
  ['process_cpu_seconds_total', {}],
  ['process_resident_memory_bytes', {}],
  ['nodejs_eventloop_delay_seconds', { quantile: '0.99' }],
  ['velasia_http_requests_in_flight', {}],
  ['velasia_writer_queue_depth', {}],
  ['velasia_memory_store_entries', { store: 'offers' }],
  ['velasia_memory_store_entries', { store: 'sessions' }],
  // M9.3: offers and sessions now expire in real time and are swept on writes, so a store's
  // size can stay flat while entries are created. Only these monotonic counts show creation;
  // an API without them (older than M9.3) fails closed here.
  ['velasia_memory_store_created_total', { store: 'offers' }],
  ['velasia_memory_store_created_total', { store: 'sessions' }],
];

/**
 * Metric families that must be declared (`# TYPE` line). Their labelled series appear only once
 * something happened (a first error, a first write), so "declared with no series" means zero,
 * while "not declared" means this is not the API the gate was written for.
 */
export const REQUIRED_FAMILIES = [
  'velasia_http_requests_total',
  'velasia_api_errors_total',
  'velasia_writer_task_seconds',
];

/** Lines `# velasia_gate_probe_ms <n>` in a scrape carry probe timings (scrape-in-container.cjs). */
const PROBE_LINE = /^# velasia_gate_probe_ms (\S+)$/;
const TYPE_LINE = /^# TYPE ([a-zA-Z_:][a-zA-Z0-9_:]*) (\S+)$/;

function parseValue(text) {
  if (text === '+Inf' || text === 'Inf') return Infinity;
  if (text === '-Inf') return -Infinity;
  // Number('') is 0 and Number('0x10') is 16: only plain decimal / exponent numbers count.
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return NaN;
  return Number(text);
}

/**
 * Parse the Prometheus text format into samples, declared families and probe timings embedded
 * as comment lines. Lines that cannot be parsed are counted in `malformed`, not dropped
 * silently; a non-numeric value is kept as NaN so that the checks below can see it.
 */
export function parseMetrics(text) {
  const samples = [];
  const probesMs = [];
  const families = new Set();
  let malformed = 0;
  let badProbes = 0;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const probe = PROBE_LINE.exec(line);
    if (probe) {
      const ms = parseValue(probe[1]);
      if (Number.isFinite(ms) && ms >= 0) probesMs.push(ms);
      else badProbes += 1;
      continue;
    }
    const type = TYPE_LINE.exec(line);
    if (type) {
      families.add(type[1]);
      continue;
    }
    if (line.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)(?:\s+\S+)?$/.exec(line);
    if (!match) {
      malformed += 1;
      continue;
    }
    const labels = {};
    if (match[2]) {
      const pair = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
      let m;
      while ((m = pair.exec(match[2]))) {
        labels[m[1]] = m[2].replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c));
      }
    }
    samples.push({ name: match[1], labels, value: parseValue(match[3]) });
  }
  return { samples, probesMs, families: [...families], malformed, badProbes };
}

const matches = (labels, match) => Object.entries(match).every(([k, v]) => labels[k] === v);

/** Sum of every sample of `name` whose labels pass `filter` (finite values only). */
export function sum(snapshot, name, filter = () => true) {
  let total = 0;
  for (const s of snapshot.samples) {
    if (s.name === name && filter(s.labels) && Number.isFinite(s.value)) total += s.value;
  }
  return total;
}

/** The first sample of `name` whose labels include `match`, or undefined. */
export function value(snapshot, name, match = {}) {
  return snapshot.samples.find((s) => s.name === name && matches(s.labels, match))?.value;
}

/**
 * Why one scrape cannot be trusted (empty list = usable): required samples or families missing,
 * non-numeric values, malformed lines, a bad timestamp, fewer probe timings than expected.
 */
export function snapshotProblems(snapshot, { expectProbes = 0 } = {}) {
  const problems = [];
  if (!snapshot || !Array.isArray(snapshot.samples)) return ['no scrape'];
  if (!Number.isFinite(snapshot.at) || snapshot.at < 0) problems.push('invalid scrape timestamp');
  for (const [name, match] of REQUIRED_SAMPLES) {
    const found = snapshot.samples.filter((s) => s.name === name && matches(s.labels, match));
    const label = `${name}${Object.keys(match).length ? JSON.stringify(match) : ''}`;
    if (found.length === 0) problems.push(`missing metric ${label}`);
    else if (found.some((s) => !Number.isFinite(s.value))) problems.push(`non-numeric ${label}`);
  }
  const families = new Set(snapshot.families ?? []);
  for (const family of REQUIRED_FAMILIES) {
    if (!families.has(family)) problems.push(`metric family ${family} not exported`);
  }
  const counted = new Set([
    'velasia_http_requests_total',
    'velasia_api_errors_total',
    'velasia_writer_task_seconds_count',
  ]);
  for (const s of snapshot.samples) {
    if (counted.has(s.name) && !Number.isFinite(s.value)) {
      problems.push(`non-numeric ${s.name}`);
      break;
    }
  }
  if (snapshot.malformed > 0) problems.push(`${snapshot.malformed} malformed metric lines`);
  if (snapshot.badProbes > 0) problems.push(`${snapshot.badProbes} unreadable probe timings`);
  const probes = snapshot.probesMs?.length ?? 0;
  if (probes < expectProbes) problems.push(`${probes} probe timings, expected ${expectProbes}`);
  return problems;
}

/** Per-label-value deltas of a counter, keeping only the ones that changed. */
function deltasBy(a, b, name, label) {
  const out = {};
  for (const s of b.samples) {
    if (s.name !== name || !Number.isFinite(s.value)) continue;
    const key = s.labels[label] ?? '';
    const before = sum(a, name, (l) => Object.entries(s.labels).every(([k, v]) => l[k] === v));
    const change = s.value - before;
    if (change > 0) out[key] = (out[key] ?? 0) + change;
  }
  return out;
}

export function percentile(values, p) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((x, y) => x - y);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

/**
 * What happened between two scrapes.
 *
 * `probeRequests` is how many probe requests the gate itself sent in the window; they are
 * subtracted so the gate's own traffic never looks like a workload still running.
 * `expectProbes` is how many probe timings each scrape must carry (0: probes are off).
 *
 * `invalid` lists why the window cannot be used. Any entry makes every consumer below treat the
 * window as evidence missing, never as a healthy reading.
 */
export function windowStats(a, b, { probeRequests = 0, expectProbes = 0 } = {}) {
  const invalid = [
    ...snapshotProblems(a, { expectProbes: 0 }).map((p) => `first scrape: ${p}`),
    ...snapshotProblems(b, { expectProbes }),
  ];
  const elapsedMs = b.at - a.at;
  if (!(elapsedMs > 0)) invalid.push(`scrapes out of order (${elapsedMs} ms apart)`);
  const seconds = elapsedMs > 0 ? elapsedMs / 1000 : NaN;
  const delta = (name, filter) => sum(b, name, filter) - sum(a, name, filter);
  const http = 'velasia_http_requests_total';
  const workload = (l) => !NON_WORKLOAD_ROUTES.has(l.route);
  const startA = value(a, 'process_start_time_seconds');
  const startB = value(b, 'process_start_time_seconds');
  const restartedInWindow = Number.isFinite(startA) && Number.isFinite(startB) && startA !== startB;
  const cpuDelta = delta('process_cpu_seconds_total');
  const requestDelta = delta(http, workload);
  // Counters only go up within one process. A decrease without a restart is a broken source.
  if (!restartedInWindow) {
    if (cpuDelta < 0) invalid.push('process_cpu_seconds_total went down without a restart');
    if (delta(http) < 0) invalid.push(`${http} went down without a restart`);
  }
  const offerEntries = (s) => value(s, 'velasia_memory_store_entries', { store: 'offers' });
  const createdCount = (s, store) => value(s, 'velasia_memory_store_created_total', { store });
  const created = (store) => createdCount(b, store) - createdCount(a, store);
  if (!restartedInWindow) {
    for (const store of ['offers', 'sessions']) {
      if (created(store) < 0) {
        invalid.push(
          `velasia_memory_store_created_total{store="${store}"} went down without a restart`,
        );
      }
    }
  }
  const probes = b.probesMs ?? [];
  return {
    at: Number.isFinite(b.at) ? new Date(b.at).toISOString() : String(b.at),
    seconds,
    startTime: startB,
    restartedInWindow,
    cpuCores: cpuDelta / seconds,
    rssBytes: value(b, 'process_resident_memory_bytes'),
    heapUsedBytes: value(b, 'nodejs_heap_bytes', { kind: 'used' }),
    requests: Math.max(0, requestDelta - probeRequests),
    requestRate: Math.max(0, requestDelta - probeRequests) / seconds,
    inFlight: sum(b, 'velasia_http_requests_in_flight'),
    queueDepth: sum(b, 'velasia_writer_queue_depth'),
    loopP99Seconds: value(b, 'nodejs_eventloop_delay_seconds', { quantile: '0.99' }),
    status5xx: delta(http, (l) => String(l.status).startsWith('5')),
    status429: delta(http, (l) => String(l.status) === '429'),
    apiErrors: deltasBy(a, b, 'velasia_api_errors_total', 'code'),
    writerTasks: delta('velasia_writer_task_seconds_count'),
    writerRejected: delta('velasia_writer_rejected_total'),
    dbFailures: delta('velasia_taladb_operation_failures_total'),
    sessionFlushFailures: delta('velasia_shopping_session_flush_failures_total'),
    dbFileBytes: sum(b, 'velasia_taladb_file_bytes'),
    offerStoreEntries: offerEntries(b),
    // Counts, not store-size differences (M9.3): sweeps of expired entries cannot hide them.
    offersCreated: created('offers'),
    sessionsCreated: created('sessions'),
    probeP50Ms: percentile(probes, 50),
    probeMaxMs: probes.length ? Math.max(...probes) : undefined,
    invalid,
  };
}

// A RATE_LIMITED error answer is itself a 429: the larger count, never the sum.
const rateLimited = (w) => Math.max(w.status429, w.apiErrors.RATE_LIMITED ?? 0);

/** Why a set of idle windows is not a usable baseline (empty list = usable). */
export function baselineProblems(windows, { minWindows = 1 } = {}) {
  const problems = [];
  if (windows.length < Math.max(1, minWindows)) {
    problems.push(`incomplete baseline: ${windows.length} of ${minWindows} windows`);
  }
  const starts = new Set(windows.map((w) => w.startTime));
  if (starts.size > 1 || windows.some((w) => w.restartedInWindow)) {
    problems.push('the API restarted while the baseline was sampled');
  }
  for (const w of windows) {
    for (const reason of w.invalid ?? ['window has no validity record']) {
      problems.push(`${w.at}: INVALID ${reason}`);
    }
    if (w.requests > 0) problems.push(`${w.at}: ${w.requests} workload requests (API not idle)`);
    if (w.queueDepth > 0) problems.push(`${w.at}: writer queue depth ${w.queueDepth}`);
    if (w.status5xx > 0) problems.push(`${w.at}: ${w.status5xx} answers 5xx`);
    if (rateLimited(w) > 0) problems.push(`${w.at}: ${rateLimited(w)} rate-limited answers`);
  }
  return problems;
}

/** Condense idle windows into the baseline the other commands compare against. */
export function summarizeBaseline(windows, { source, expectProbes = 0 } = {}) {
  const nums = (key) => windows.map((w) => w[key]).filter((v) => Number.isFinite(v));
  const max = (key) => (nums(key).length ? Math.max(...nums(key)) : null);
  const probes = nums('probeP50Ms');
  return {
    kind: 'velasia-api-baseline',
    version: 2,
    takenAt: new Date().toISOString(),
    source,
    expectProbes,
    startTime: windows.at(-1)?.startTime ?? null,
    cpuCoresMax: max('cpuCores'),
    cpuCoresMean: nums('cpuCores').length
      ? nums('cpuCores').reduce((s, v) => s + v, 0) / nums('cpuCores').length
      : null,
    loopP99SecondsMax: max('loopP99Seconds'),
    inFlightMax: max('inFlight'),
    rssBytes: windows.at(-1)?.rssBytes ?? null,
    heapUsedBytes: windows.at(-1)?.heapUsedBytes ?? null,
    dbFileBytes: windows.at(-1)?.dbFileBytes ?? null,
    offerStoreEntries: windows.at(-1)?.offerStoreEntries ?? null,
    writerTasksPerSecondMax: windows.length
      ? Math.max(...windows.map((w) => (w.seconds > 0 ? w.writerTasks / w.seconds : Infinity)))
      : null,
    probeP50Ms: probes.length ? percentile(probes, 50) : null,
    probeP50MsMax: probes.length ? Math.max(...probes) : null,
    windows,
  };
}

/**
 * Why a baseline file cannot be compared against (empty list = usable). Every number the other
 * checks read must be present: a baseline with a hole would make those checks pass vacuously.
 */
export function baselineFileProblems(baseline) {
  if (!baseline || baseline.kind !== 'velasia-api-baseline') return ['not a gate baseline'];
  const problems = [];
  if (baseline.version !== 2) problems.push(`baseline version ${baseline.version}, expected 2`);
  for (const key of [
    'startTime',
    'cpuCoresMax',
    'loopP99SecondsMax',
    'inFlightMax',
    'rssBytes',
    'writerTasksPerSecondMax',
    'offerStoreEntries',
  ]) {
    if (!Number.isFinite(baseline[key])) problems.push(`baseline has no ${key}`);
  }
  if (baseline.expectProbes > 0 && !Number.isFinite(baseline.probeP50Ms)) {
    problems.push('baseline has no probe latency');
  }
  if (Array.isArray(baseline.problems) && baseline.problems.length) {
    problems.push(`baseline was refused when taken (${baseline.problems.length} problems)`);
  }
  return problems;
}

export const DEFAULT_RECOVERY = {
  /** CPU may exceed the idle maximum by this factor or by this many cores, whichever is more. */
  cpuFactor: 1.5,
  cpuSlackCores: 0.05,
  /** Event-loop p99 may exceed the idle maximum by this much. */
  loopSlackSeconds: 0.01,
  /** Probe p50 may exceed the idle p50 by this factor plus this many milliseconds. */
  latencyFactor: 1.5,
  latencySlackMs: 2,
};

/**
 * Why the API has not recovered in this window (empty list = recovered). A restart is fatal
 * for the series (`RESTARTED…`), and so is a window without valid metrics (`INVALID…`): the
 * caller stops on either.
 */
export function recoveryProblems(w, baseline, limits = DEFAULT_RECOVERY) {
  if (w.startTime !== baseline.startTime || w.restartedInWindow) {
    return ['RESTARTED: the API process is not the one the baseline measured'];
  }
  // `null <= x` is true in JavaScript: a baseline with holes would pass every check below.
  const holes = baselineFileProblems(baseline);
  if (holes.length) return [`INVALID: baseline ${holes.join('; ')}`];
  if (w.invalid?.length !== 0) {
    return [`INVALID: ${(w.invalid ?? ['window has no validity record']).join('; ')}`];
  }
  const problems = [];
  if (w.requests > 0) problems.push(`traffic still arriving (${w.requests} requests)`);
  if (w.inFlight > baseline.inFlightMax) {
    problems.push(`in-flight ${w.inFlight} > idle ${baseline.inFlightMax}`);
  }
  if (w.queueDepth > 0) problems.push(`writer queue depth ${w.queueDepth}`);
  if (w.status5xx > 0) problems.push(`${w.status5xx} answers 5xx`);
  if (rateLimited(w) > 0) problems.push(`${rateLimited(w)} rate-limited answers`);
  const cpuCeiling = Math.max(
    baseline.cpuCoresMax * limits.cpuFactor,
    baseline.cpuCoresMax + limits.cpuSlackCores,
  );
  if (!(w.cpuCores <= cpuCeiling)) {
    problems.push(`CPU ${w.cpuCores.toFixed(3)} cores > ${cpuCeiling.toFixed(3)}`);
  }
  if (!(w.loopP99Seconds <= baseline.loopP99SecondsMax + limits.loopSlackSeconds)) {
    problems.push(`event-loop p99 ${(w.loopP99Seconds * 1000).toFixed(1)} ms above idle`);
  }
  if (Number.isFinite(baseline.probeP50Ms)) {
    if (!Number.isFinite(w.probeP50Ms)) {
      problems.push('no probe latency in this window (the baseline has one)');
    } else {
      const ceiling = baseline.probeP50Ms * limits.latencyFactor + limits.latencySlackMs;
      if (w.probeP50Ms > ceiling) {
        problems.push(`probe p50 ${w.probeP50Ms.toFixed(1)} ms > ${ceiling.toFixed(1)} ms`);
      }
    }
  }
  return problems;
}

export const DEFAULT_SATURATION = {
  /** Writer queue at or above this depth means writes are backing up. */
  queueDepth: 4,
  /** Concurrent requests inside the API at or above this. */
  inFlight: 64,
  /** Event-loop p99 at or above this. */
  loopP99Seconds: 0.1,
  /** Fraction of the API's CPU limit (cores); only checked when the limit is given. */
  cpuShare: 0.9,
  cpuLimitCores: undefined,
  /** Fraction of the API's memory limit (bytes) for RSS; only checked when the limit is given. */
  memoryShare: 0.85,
  memoryLimitBytes: undefined,
  /** Probe p50 at or above idle p50 × this factor + this slack (only with probes). */
  probeFactor: 5,
  probeSlackMs: 25,
};

/** Signs of API saturation in one window (empty list = none). */
export function saturationSignals(w, limits = DEFAULT_SATURATION, baseline = undefined) {
  const signals = [];
  if (w.queueDepth >= limits.queueDepth) signals.push(`writer queue depth ${w.queueDepth}`);
  if (w.inFlight >= limits.inFlight) signals.push(`in-flight ${w.inFlight}`);
  if (Number.isFinite(w.loopP99Seconds) && w.loopP99Seconds >= limits.loopP99Seconds) {
    signals.push(`event-loop p99 ${(w.loopP99Seconds * 1000).toFixed(0)} ms`);
  }
  if (limits.cpuLimitCores && w.cpuCores >= limits.cpuShare * limits.cpuLimitCores) {
    signals.push(`CPU ${w.cpuCores.toFixed(2)} of ${limits.cpuLimitCores} cores`);
  }
  if (limits.memoryLimitBytes && w.rssBytes >= limits.memoryShare * limits.memoryLimitBytes) {
    signals.push(
      `RSS ${(w.rssBytes / 2 ** 20).toFixed(0)} MiB of ${(limits.memoryLimitBytes / 2 ** 20).toFixed(0)} MiB`,
    );
  }
  if (Number.isFinite(baseline?.probeP50Ms) && Number.isFinite(w.probeP50Ms)) {
    const ceiling = baseline.probeP50Ms * limits.probeFactor + limits.probeSlackMs;
    if (w.probeP50Ms >= ceiling) {
      signals.push(`probe p50 ${w.probeP50Ms.toFixed(1)} ms (idle ${baseline.probeP50Ms} ms)`);
    }
  }
  return signals;
}

/**
 * The verdict for one measured run, from the windows sampled while it ran.
 *
 * - `restarted`: the API process changed; the series is invalid.
 * - `invalid`: the evidence is incomplete (a window without valid metrics, no windows, or less
 *   watched time than `expectSeconds`). Nothing can be concluded from the run.
 * - `backend-limited`: saturation in `sustain` consecutive windows, or any 5xx / rate-limited
 *   answer from the API. The run must not be credited to either runtime.
 * - `ok`: none of these.
 *
 * Reported beside the verdict, for the caller to judge against the workload:
 * - `wrote`: the API's writer worked beyond its idle rate, or a shopping session was created
 *   (a read-only run changed shared state);
 * - `offersCreated`: offers the API created during the run (`velasia_memory_store_created_total`).
 *   Any is a difference in the shared offer cache's state between the two runtimes. Since
 *   M9.3 offers expire in real time (60 s reuse, 15 min validity), so no pre-warm keeps them
 *   warm across a series: offer workloads are excluded from pairs (pair-lib.mjs).
 */
export function classifyRun(
  windows,
  baseline,
  { limits = DEFAULT_SATURATION, sustain = 2, expectSeconds = 0, coverage = 0.9 } = {},
) {
  const peaks = {
    cpuCores: 0,
    inFlight: 0,
    queueDepth: 0,
    loopP99Seconds: 0,
    rssBytes: 0,
    probeP50Ms: 0,
  };
  let streak = 0;
  let saturated = null;
  let restarted = false;
  const invalid = [];
  const totals = {
    requests: 0,
    status5xx: 0,
    rateLimited: 0,
    writerTasks: 0,
    offersCreated: 0,
    sessionsCreated: 0,
    apiErrors: {},
  };
  let seconds = 0;
  let maxWindowSeconds = 0;
  for (const w of windows) {
    if (w.startTime !== baseline.startTime || w.restartedInWindow) restarted = true;
    for (const reason of w.invalid ?? ['window has no validity record']) {
      invalid.push(`${w.at}: ${reason}`);
    }
    for (const key of Object.keys(peaks)) {
      if (Number.isFinite(w[key])) peaks[key] = Math.max(peaks[key], w[key]);
    }
    totals.requests += w.requests;
    totals.status5xx += w.status5xx;
    totals.rateLimited += rateLimited(w);
    totals.writerTasks += w.writerTasks;
    totals.offersCreated += Math.max(0, w.offersCreated);
    totals.sessionsCreated += Math.max(0, w.sessionsCreated);
    for (const [code, n] of Object.entries(w.apiErrors ?? {})) {
      totals.apiErrors[code] = (totals.apiErrors[code] ?? 0) + n;
    }
    if (Number.isFinite(w.seconds)) {
      seconds += w.seconds;
      maxWindowSeconds = Math.max(maxWindowSeconds, w.seconds);
    }
    const signals = saturationSignals(w, limits, baseline);
    streak = signals.length ? streak + 1 : 0;
    if (streak >= sustain && !saturated) saturated = { at: w.at, signals };
  }
  if (windows.length === 0) invalid.push('no API windows were sampled during the run');
  if (expectSeconds > 0 && seconds < coverage * expectSeconds) {
    invalid.push(`API watched for ${seconds.toFixed(0)} s of a ${expectSeconds} s run`);
  }
  // The API's order sweep (every ORDER_SWEEP_INTERVAL_MS, 30 s) does writer work on its own.
  // The baseline covers at least two sweeps, so its idle rate includes them. Writer work in a run
  // during which no workload request reached the API cannot come from the workload: it is
  // background work, reported but not held against the run. A created session always counts.
  const idleWrites = (baseline.writerTasksPerSecondMax ?? 0) * seconds;
  const beyondIdle = totals.writerTasks > Math.ceil(idleWrites);
  const wrote = totals.sessionsCreated > 0 || (beyondIdle && totals.requests > 0);
  const backgroundWrites = beyondIdle && totals.requests === 0 ? totals.writerTasks : 0;
  const reasons = [];
  if (saturated) reasons.push(`saturated from ${saturated.at}: ${saturated.signals.join(', ')}`);
  if (totals.status5xx > 0) reasons.push(`${totals.status5xx} API answers 5xx`);
  if (totals.rateLimited > 0) reasons.push(`${totals.rateLimited} API answers rate-limited`);
  let verdict = reasons.length ? 'backend-limited' : 'ok';
  if (invalid.length) {
    verdict = 'invalid';
    reasons.unshift(`evidence missing: ${invalid.slice(0, 5).join('; ')}`);
  }
  if (restarted) {
    verdict = 'restarted';
    reasons.unshift('the API process changed during the run');
  }
  return {
    verdict,
    reasons,
    wrote,
    backgroundWrites,
    peaks,
    totals,
    seconds,
    maxWindowSeconds,
    invalid,
  };
}

/** Exit code of api-gate.mjs for each verdict (pair.mjs maps them to its own). */
export const GATE_EXIT = {
  ok: 0,
  usage: 1,
  'not-idle': 2,
  'not-recovered': 2,
  'backend-limited': 3,
  restarted: 4,
  invalid: 5,
};

/**
 * Merge a thresholds file into the defaults. Unknown keys and non-numeric values are refused, so
 * a typo can never switch a check off silently.
 */
export function mergeThresholds(overrides = {}) {
  const out = {
    saturation: { ...DEFAULT_SATURATION },
    recovery: { ...DEFAULT_RECOVERY },
    sustain: 2,
  };
  for (const [group, values] of Object.entries(overrides)) {
    if (group === 'sustain') {
      if (!Number.isInteger(values) || values < 1)
        throw new Error('sustain must be an integer ≥ 1');
      out.sustain = values;
      continue;
    }
    if (!(group in out) || typeof values !== 'object' || values === null) {
      throw new Error(`unknown thresholds group "${group}"`);
    }
    for (const [key, v] of Object.entries(values)) {
      if (!(key in out[group])) throw new Error(`unknown threshold ${group}.${key}`);
      if (!Number.isFinite(v) || v < 0) throw new Error(`${group}.${key} must be a number ≥ 0`);
      out[group][key] = v;
    }
  }
  return out;
}
