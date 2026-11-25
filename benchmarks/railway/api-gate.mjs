#!/usr/bin/env node
/**
 * Shared-API gate for paired Node.js / NextRS benchmark runs (Railway or the local
 * Railway-like stack). It never generates load and never changes the API: it only reads the
 * API's metrics and, optionally, times a few requests to one cheap read-only route.
 *
 *   api-gate.mjs baseline --out baseline.json [--same-process-as series-first-baseline.json]
 *                         (API idle: record CPU, memory, latency; optionally prove that the API
 *                         is still the process the series started with)
 *   api-gate.mjs watch    --baseline baseline.json --out run.json [--fail-fast]
 *                         (while one k6 run executes: saturation, errors, rate limits, writes)
 *   api-gate.mjs recover  --baseline baseline.json [--out recover.json]
 *                         (after a run: wait until the API is back at its baseline, or fail)
 *
 * Source (one of):
 *   --metrics-url http://velasia-api.railway.internal:4010/metrics
 *       Direct, from a host on the API's private network. Reads METRICS_TOKEN and
 *       RETAILING_API_SERVICE_TOKEN from the environment (never from arguments, never printed)
 *       and probes --probe-path (default /v1/airline) --probes times per window.
 *   --metrics-cmd '<command>'
 *       Any command that prints the metrics text, for example
 *       `docker exec -i velasia-api node - < benchmarks/railway/scrape-in-container.cjs`, which
 *       also times the probes inside the container. Never put a secret in the command.
 *
 * Options shared by all commands:
 *   --thresholds file.json   overrides for DEFAULT_SATURATION / DEFAULT_RECOVERY / sustain
 *                            (gate-lib.mjs); unknown keys are refused
 *   --probes N               probe timings every window must carry (0 turns probes off)
 *   --cpu-limit CORES, --memory-limit-mib MIB   the API's Railway limits (saturation checks)
 *   --expect-seconds S       watch: the measured run's length; less watched time is invalid
 *   --min-baseline-seconds S baseline: refuse a shorter baseline (default 60: two of the API's
 *                            30 s order sweeps, whose writes must be part of the idle rate)
 *
 * Fail closed: a scrape that fails (after one retry), or a window whose metrics are missing,
 * non-numeric or out of order, never counts as healthy. The command records what it has and
 * exits 5.
 *
 * Exit codes: 0 ok / recovered; 1 usage error; 2 not idle (baseline) or not recovered in time
 * (recover); 3 backend-limited (watch); 4 the API restarted; 5 evidence missing (metrics
 * unavailable or invalid).
 *
 * Procedure and thresholds: docs/deployment/railway-benchmark-readiness.md.
 */
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import {
  GATE_EXIT,
  baselineFileProblems,
  baselineProblems,
  classifyRun,
  mergeThresholds,
  parseMetrics,
  percentile,
  recoveryProblems,
  saturationSignals,
  summarizeBaseline,
  windowStats,
} from './gate-lib.mjs';

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'metrics-url': { type: 'string' },
    'metrics-cmd': { type: 'string' },
    'probe-path': { type: 'string', default: '/v1/airline' },
    probes: { type: 'string', default: '5' },
    out: { type: 'string' },
    baseline: { type: 'string' },
    'same-process-as': { type: 'string' },
    window: { type: 'string' },
    windows: { type: 'string', default: '6' },
    interval: { type: 'string', default: '2' },
    duration: { type: 'string' },
    stable: { type: 'string', default: '3' },
    'min-quiet': { type: 'string', default: '30' },
    'min-baseline-seconds': { type: 'string', default: '60' },
    timeout: { type: 'string', default: '900' },
    'cpu-limit': { type: 'string' },
    'memory-limit-mib': { type: 'string' },
    'expect-seconds': { type: 'string', default: '0' },
    thresholds: { type: 'string' },
    'fail-fast': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const command = positionals[0];
const usage = () => {
  const text = readFileSync(new URL(import.meta.url), 'utf8');
  process.stdout.write(
    `${text.slice(text.indexOf('/**') + 4, text.indexOf('*/')).replace(/^ \* ?/gm, '')}\n`,
  );
};
if (opts.help || !['baseline', 'watch', 'recover'].includes(command)) {
  usage();
  process.exit(opts.help ? 0 : 1);
}
const fail = (message, code = GATE_EXIT.usage) => {
  process.stderr.write(`api-gate: ${message}\n`);
  process.exit(code);
};
/** Evidence is missing: record what there is, then stop with exit code 5. */
class EvidenceError extends Error {}
if (Boolean(opts['metrics-url']) === Boolean(opts['metrics-cmd'])) {
  fail('give exactly one of --metrics-url or --metrics-cmd');
}
const num = (name) => {
  const n = Number(opts[name]);
  if (opts[name] === undefined || !Number.isFinite(n) || n < 0) {
    fail(`--${name} must be a non-negative number`);
  }
  return n;
};
let thresholds;
try {
  thresholds = mergeThresholds(
    opts.thresholds ? JSON.parse(readFileSync(opts.thresholds, 'utf8')) : {},
  );
} catch (error) {
  fail(`--thresholds: ${error.message}`);
}
const saturationLimits = {
  ...thresholds.saturation,
  ...(opts['cpu-limit'] ? { cpuLimitCores: num('cpu-limit') } : {}),
  ...(opts['memory-limit-mib'] ? { memoryLimitBytes: num('memory-limit-mib') * 2 ** 20 } : {}),
};
const expectProbes = num('probes');

// --- Scraping ------------------------------------------------------------------------------
let metricsUrl;
if (opts['metrics-url']) {
  metricsUrl = new URL(opts['metrics-url']);
  if (metricsUrl.username || metricsUrl.password) fail('no credentials in --metrics-url');
}
const source = metricsUrl ? metricsUrl.toString() : 'command';
const headers = () => ({
  ...(process.env.METRICS_TOKEN ? { authorization: `Bearer ${process.env.METRICS_TOKEN}` } : {}),
  ...(process.env.RETAILING_API_SERVICE_TOKEN
    ? { 'x-velasia-service-token': process.env.RETAILING_API_SERVICE_TOKEN }
    : {}),
});

async function probe() {
  const count = expectProbes;
  const timings = [];
  const url = new URL(opts['probe-path'], metricsUrl);
  for (let i = 0; i < count; i++) {
    const started = performance.now();
    const response = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(5_000) });
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`probe ${url.pathname}: HTTP ${response.status}`);
    timings.push(performance.now() - started);
  }
  return timings;
}

function runCommand() {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/sh',
      ['-c', opts['metrics-cmd']],
      { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) =>
        error ? reject(new Error(`--metrics-cmd failed: ${error.message}`)) : resolve(stdout),
    );
  });
}

/** One scrape. In URL mode the probes run first, so the scrape counts them. */
async function scrapeOnce() {
  if (metricsUrl) {
    const probesMs = await probe();
    const response = await fetch(metricsUrl, {
      headers: headers(),
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `metrics: HTTP ${response.status}${response.status === 401 ? ' (set METRICS_TOKEN and RETAILING_API_SERVICE_TOKEN in the environment)' : ''}`,
      );
    }
    return { at: Date.now(), ...parseMetrics(text), probesMs };
  }
  const text = await runCommand();
  return { at: Date.now(), ...parseMetrics(text) };
}

let scrapeRetries = 0;
/**
 * A scrape, retried once after a second: a transient network error only makes the window
 * longer. A second failure is missing evidence (exit 5); no value is ever made up for it.
 */
async function scrape() {
  try {
    return await scrapeOnce();
  } catch (first) {
    scrapeRetries += 1;
    console.error(`scrape failed (${first.message}); retrying once`);
    await sleep(1_000);
    try {
      return await scrapeOnce();
    } catch (second) {
      throw new EvidenceError(`metrics unavailable: ${second.message}`);
    }
  }
}

/** True when the process that started this gate is gone (we were re-parented). */
const parentPid = process.ppid;
const orphaned = () => process.ppid !== parentPid;

/** Sample one window of `seconds` that starts at `previous` (or a fresh scrape). */
async function nextWindow(previous, seconds) {
  const a = previous ?? (await scrape());
  const elapsed = (Date.now() - a.at) / 1000;
  if (elapsed < seconds) await sleep((seconds - elapsed) * 1000);
  const b = await scrape();
  return {
    b,
    stats: windowStats(a, b, { probeRequests: b.probesMs.length, expectProbes }),
  };
}

const n = (v, digits, scale = 1) => (Number.isFinite(v) ? (v * scale).toFixed(digits) : '?');
const fmt = (w) =>
  [
    `${w.at}`,
    `cpu ${n(w.cpuCores, 3)}`,
    `req ${w.requests}`,
    `inflight ${w.inFlight}`,
    `queue ${w.queueDepth}`,
    `loop.p99 ${n(w.loopP99Seconds, 1, 1000)}ms`,
    `rss ${n(w.rssBytes, 0, 2 ** -20)}MiB`,
    `probe.p50 ${n(w.probeP50Ms, 1)}ms`,
    `5xx ${w.status5xx}`,
    `429 ${w.status429}`,
    `writes ${w.writerTasks}`,
    `offers+ ${n(w.offersCreated, 0)}`,
    ...(w.invalid.length ? [`INVALID: ${w.invalid.join('; ')}`] : []),
  ].join('  ');

const write = (file, data) => file && writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
const readBaseline = (file) => {
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${file}: ${error.message}`);
  }
  const problems = baselineFileProblems(baseline);
  if (problems.length) fail(`${file} is not a usable baseline: ${problems.join('; ')}`);
  return baseline;
};
const loadBaseline = () => {
  if (!opts.baseline) fail('--baseline is required');
  return readBaseline(opts.baseline);
};

// --- Commands ------------------------------------------------------------------------------
async function baselineCommand() {
  if (!opts.out) fail('--out is required');
  const windowSeconds = opts.window ? num('window') : 10;
  const wanted = num('windows');
  if (wanted < 3) fail('--windows must be at least 3');
  // At least two of the API's 30 s order sweeps, so the idle write rate includes them.
  if (wanted * windowSeconds < num('min-baseline-seconds')) {
    fail(
      `a baseline of ${wanted} × ${windowSeconds} s is shorter than --min-baseline-seconds ${opts['min-baseline-seconds']}`,
    );
  }
  const windows = [];
  let previous;
  const record = (extra = []) => {
    const problems = [...extra, ...baselineProblems(windows, { minWindows: wanted })];
    const baseline = summarizeBaseline(windows, { source, expectProbes });
    write(opts.out, { ...baseline, thresholds, scrapeRetries, problems });
    return { baseline, problems };
  };
  try {
    for (let i = 0; i < wanted; i++) {
      const { b, stats } = await nextWindow(previous, windowSeconds);
      previous = b;
      windows.push(stats);
      console.log(fmt(stats));
    }
  } catch (error) {
    if (!(error instanceof EvidenceError)) throw error;
    record([error.message]);
    fail(`${error.message}: no baseline (record in ${opts.out})`, GATE_EXIT.invalid);
  }
  const { baseline, problems } = record();
  if (opts['same-process-as']) {
    const first = readBaseline(opts['same-process-as']);
    if (first.startTime !== baseline.startTime) {
      fail(
        `the API restarted since ${opts['same-process-as']}: this series is invalid`,
        GATE_EXIT.restarted,
      );
    }
  }
  if (problems.some((p) => p.includes('restarted'))) {
    for (const p of problems) console.error(`baseline: ${p}`);
    fail('the API restarted while the baseline was sampled', GATE_EXIT.restarted);
  }
  if (problems.some((p) => p.includes('INVALID'))) {
    for (const p of problems) console.error(`baseline: ${p}`);
    fail(`metrics invalid: no usable baseline (record in ${opts.out})`, GATE_EXIT.invalid);
  }
  if (problems.length) {
    for (const p of problems) console.error(`not idle: ${p}`);
    fail(`no usable baseline (written to ${opts.out} for the record)`, GATE_EXIT['not-idle']);
  }
  console.log(
    `baseline: cpu max ${n(baseline.cpuCoresMax, 3)} cores, loop p99 max ${n(baseline.loopP99SecondsMax, 1, 1000)} ms, ` +
      `rss ${n(baseline.rssBytes, 0, 2 ** -20)} MiB, probe p50 ${n(baseline.probeP50Ms, 1)} ms, ` +
      `offer store ${baseline.offerStoreEntries} → ${opts.out}`,
  );
}

async function watchCommand() {
  if (!opts.out) fail('--out is required');
  const baseline = loadBaseline();
  const limits = saturationLimits;
  const sustain = thresholds.sustain;
  const expectSeconds = num('expect-seconds');
  const interval = num('interval');
  if (interval <= 0) fail('--interval must be positive');
  // Safety cap: a watcher never outlives its run by much, even if its parent is killed hard.
  const until = Date.now() + (opts.duration ? num('duration') : 3600) * 1000;
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => (stopping = true));
  const windows = [];
  const extra = [];
  const finish = () => {
    const result = classifyRun(windows, baseline, { limits, sustain, expectSeconds });
    for (const reason of extra) {
      result.invalid.push(reason);
      if (result.verdict === 'ok' || result.verdict === 'backend-limited') {
        result.verdict = 'invalid';
        result.reasons.unshift(`evidence missing: ${reason}`);
      }
    }
    write(opts.out, {
      kind: 'velasia-api-run',
      baseline: opts.baseline,
      limits,
      sustain,
      expectSeconds,
      scrapeRetries,
      result,
      windows,
    });
    const probes = windows.map((w) => w.probeP50Ms).filter((v) => Number.isFinite(v));
    console.log(
      `verdict: ${result.verdict}${result.reasons.length ? ` (${result.reasons.join('; ')})` : ''}` +
        `; wrote: ${result.wrote}; offers created ${result.totals.offersCreated}` +
        `; API requests ${result.totals.requests}` +
        `; probe p50 median ${n(percentile(probes, 50), 1)} ms → ${opts.out}`,
    );
    process.exit(GATE_EXIT[result.verdict]);
  };
  try {
    let previous = await scrape();
    while (!stopping && Date.now() < until) {
      if (orphaned()) {
        extra.push('the benchmark process that started the watch is gone');
        break;
      }
      const { b, stats } = await nextWindow(previous, interval);
      previous = b;
      windows.push(stats);
      const signals = saturationSignals(stats, limits, baseline);
      console.log(`${fmt(stats)}${signals.length ? `  SATURATION: ${signals.join(', ')}` : ''}`);
      if (
        opts['fail-fast'] &&
        classifyRun(windows, baseline, { limits, sustain }).verdict !== 'ok'
      ) {
        break;
      }
    }
    if (!stopping && Date.now() >= until) extra.push('the watch reached its --duration cap');
  } catch (error) {
    if (!(error instanceof EvidenceError)) throw error;
    extra.push(error.message);
  }
  finish();
}

async function recoverCommand() {
  const baseline = loadBaseline();
  const windowSeconds = opts.window ? num('window') : 10;
  const stable = num('stable');
  if (stable < 2) fail('--stable must be at least 2 (one healthy reading is not a recovery)');
  const deadline = Date.now() + num('timeout') * 1000;
  const minQuietMs = num('min-quiet') * 1000;
  let lastTraffic = Date.now();
  let streak = 0;
  let previous;
  const windows = [];
  const started = Date.now();
  let interrupted = null;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => (interrupted = signal));
  }
  const record = (extra) =>
    write(opts.out, {
      kind: 'velasia-api-recovery',
      thresholds: thresholds.recovery,
      stable,
      scrapeRetries,
      ...extra,
      windows,
    });
  while (Date.now() < deadline) {
    if (interrupted || orphaned()) {
      record({ recovered: false, interrupted: interrupted ?? 'parent gone' });
      fail('interrupted before recovery was confirmed', GATE_EXIT['not-recovered']);
    }
    let next;
    try {
      next = await nextWindow(previous, windowSeconds);
    } catch (error) {
      if (!(error instanceof EvidenceError)) throw error;
      record({ recovered: false, invalid: error.message });
      fail(`${error.message}: recovery cannot be confirmed`, GATE_EXIT.invalid);
    }
    const { b, stats } = next;
    previous = b;
    windows.push(stats);
    const problems = recoveryProblems(stats, baseline, thresholds.recovery);
    if (stats.requests > 0) lastTraffic = Date.now();
    const quietFor = Date.now() - lastTraffic;
    if (problems.length === 0 && quietFor < minQuietMs) {
      problems.push(`quiet for ${(quietFor / 1000).toFixed(0)} s < ${minQuietMs / 1000} s`);
    }
    streak = problems.length ? 0 : streak + 1;
    console.log(
      `${fmt(stats)}  ${problems.length ? `waiting: ${problems.join('; ')}` : `ok ${streak}/${stable}`}`,
    );
    if (problems.some((p) => p.startsWith('RESTARTED'))) {
      record({ recovered: false, restarted: true });
      fail('the API restarted: this series is invalid (do not compare across it)', 4);
    }
    if (problems.some((p) => p.startsWith('INVALID'))) {
      record({ recovered: false, invalid: problems[0] });
      fail(`metrics invalid (${problems[0]}): recovery cannot be confirmed`, GATE_EXIT.invalid);
    }
    if (streak >= stable) {
      const seconds = ((Date.now() - started) / 1000).toFixed(0);
      record({ recovered: true, seconds });
      console.log(`recovered after ${seconds} s (${stable} consecutive windows at baseline)`);
      return;
    }
  }
  record({ recovered: false, timedOut: true });
  fail(
    'the API did not return to its baseline in time: stop the series and classify the last run as backend-limited',
    GATE_EXIT['not-recovered'],
  );
}

try {
  await { baseline: baselineCommand, watch: watchCommand, recover: recoverCommand }[command]();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error), GATE_EXIT.invalid);
}
