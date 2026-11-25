#!/usr/bin/env node
/**
 * The mandatory paired run for ONE read-only workload and ONE round
 * (docs/deployment/railway-benchmark-readiness.md, "Mandatory execution order").
 *
 *   node benchmarks/railway/pair.mjs <scenario> <round>
 *
 * Odd rounds run Node.js first, even rounds NextRS first. Steps, numbered as in the document:
 *    1  both storefronts and the API are ready; record both deployments' identity; check the
 *       recorded Railway metadata (DEPLOYMENTS) and the series (SERIES_BASELINE / SERIES_START)
 *    2  API baseline: CPU, memory, latency, offer store (and the same API process as the series)
 *    3  warm up the first runtime            4  measured k6 run while the gate watches the API
 *    5  save results                         6–7  wait until the API is back at its baseline
 *    8  warm up the second runtime           9–10 measured run, results, recovery again
 *   11  pair.json: comparable only if every check in pair-lib.mjs pairProblems() passed
 * It stops at the first failed gate; a stopped pair is never compared. Only one k6 process
 * runs at any time, and nothing here restarts, resets or reconfigures anything. On SIGINT,
 * SIGTERM or SIGHUP, and on every failure, it stops its children (k6, gate) before exiting.
 *
 * Environment:
 *   NODE_URL, NEXTRS_URL  storefront origins, reached the same way for both
 *   API_URL               private API origin, e.g. http://velasia-api.railway.internal:4010
 *   METRICS_TOKEN, RETAILING_API_SERVICE_TOKEN  read by the gate; never printed
 *   FIXTURES              lib/seed.mjs output (not needed by static-assets, rsc, home, …)
 *   DEPLOYMENTS           Railway metadata recorded by the operator (deployments.example.json);
 *                         without it the pair runs but is never comparable
 *   SERIES_BASELINE       the series' first api-baseline.json: proves the API never restarted
 *   SERIES_START=1        instead: this pair starts a new series (its baseline becomes the
 *                         SERIES_BASELINE of every later pair)
 *   PREWARM               prewarm.mjs output for this series (recorded in pair.json)
 *   RATE                  fixed offered load, iterations/s (constant-arrival-rate); else VUS
 *   VUS=20 DURATION=300s WARMUP=60s ACCEPT_ENCODING=gzip OUT=/tmp/velasia-bench
 *   API_CPU, API_MEMORY_MIB  the API's Railway limits (saturation checks)
 *   RECOVER_TIMEOUT=900 MIN_QUIET=30 GATE_THRESHOLDS=<file.json>
 *   GATE_WINDOW=10 GATE_WINDOWS=6 GATE_INTERVAL=2 GATE_STABLE=3 GATE_PROBES=5
 *   GATE_MIN_BASELINE=60 (seconds; never below two API order sweeps outside tests)
 *
 * Exit: 0 comparable; 1 error; 2 API not idle / not recovered; 3 backend-limited;
 * 4 API restarted; 5 a deployment changed or differs; 6 not comparable (incorrect answers,
 * writes, offers created, k6 limits, missing metadata); 7 API evidence missing;
 * 130 / 143 / 129 interrupted.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  NEEDS_FIXTURES,
  cgroupCores,
  deploymentProblems,
  durationSeconds,
  k6Problems,
  pairProblems,
  procCpuSeconds,
  refusedWorkload,
  summarizeK6,
} from './pair-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'api-gate.mjs');
const K6_SCRIPT = join(HERE, '..', 'node-baseline', 'k6', 'scenarios.js');
const EXIT = {
  comparable: 0,
  error: 1,
  'not-recovered': 2,
  'backend-limited': 3,
  restarted: 4,
  deployment: 5,
  'not-comparable': 6,
  invalid: 7,
};
/** api-gate.mjs exit code → pair exit code. */
const FROM_GATE = { 2: 2, 3: 3, 4: 4, 5: 7 };

const die = (message, code = EXIT.error) => {
  process.stderr.write(`pair: ${message}\n`);
  process.exit(code);
};
const [scenario, roundText] = process.argv.slice(2);
if (!scenario || !/^[1-9][0-9]*$/.test(roundText ?? '')) die('usage: pair.mjs <scenario> <round>');
const refused = refusedWorkload(scenario);
if (refused) die(refused);
const need = (name) => process.env[name] || die(`${name} is not set`);
const urls = { node: need('NODE_URL'), nextrs: need('NEXTRS_URL') };
const apiUrl = need('API_URL').replace(/\/$/, '');
const env = process.env;
const cfg = {
  vus: env.VUS ?? '20',
  rate: env.RATE ? Number(env.RATE) : 0,
  duration: env.DURATION ?? '300s',
  warmup: env.WARMUP ?? '60s',
  acceptEncoding: env.ACCEPT_ENCODING ?? 'gzip',
  apiCpu: env.API_CPU,
  apiMemoryMib: env.API_MEMORY_MIB,
  recoverTimeout: env.RECOVER_TIMEOUT ?? '900',
  minQuiet: env.MIN_QUIET ?? '30',
  thresholds: env.GATE_THRESHOLDS,
  gateWindow: env.GATE_WINDOW ?? '10',
  gateWindows: env.GATE_WINDOWS ?? '6',
  gateInterval: env.GATE_INTERVAL ?? '2',
  gateStable: env.GATE_STABLE ?? '3',
  gateProbes: env.GATE_PROBES ?? '5',
  gateMinBaseline: env.GATE_MIN_BASELINE ?? '60',
  seriesBaseline: env.SERIES_BASELINE,
  seriesStart: env.SERIES_START === '1',
};
cfg.seconds = durationSeconds(cfg.duration);
if (!Number.isFinite(cfg.seconds) || cfg.seconds <= 0) die(`DURATION ${cfg.duration} unreadable`);
if (!Number.isFinite(durationSeconds(cfg.warmup))) die(`WARMUP ${cfg.warmup} unreadable`);
if (!(cfg.rate >= 0)) die('RATE must be a number ≥ 0');
if (cfg.seriesBaseline && cfg.seriesStart) die('set SERIES_BASELINE or SERIES_START=1, not both');
if (!cfg.seriesBaseline && !cfg.seriesStart) {
  die('set SERIES_BASELINE (a later pair of the series) or SERIES_START=1 (the first pair)');
}
if (NEEDS_FIXTURES.has(scenario)) need('FIXTURES');
const round = Number(roundText);
const order = round % 2 === 1 ? ['node', 'nextrs'] : ['nextrs', 'node'];
const dir = join(env.OUT ?? '/tmp/velasia-bench', `round-${round}`, scenario);
mkdirSync(dir, { recursive: true });

const pair = {
  kind: 'velasia-paired-run',
  version: 2,
  scenario,
  round,
  order,
  config: { ...cfg, apiUrl },
  startedAt: new Date().toISOString(),
  steps: [],
  runs: {},
  recovered: {},
  comparable: false,
  classification: 'running',
};
const save = () => writeFileSync(join(dir, 'pair.json'), `${JSON.stringify(pair, null, 2)}\n`);
const log = (step, text) => {
  pair.steps.push({ step, at: new Date().toISOString(), text });
  console.log(`[${step}] ${text}`);
  save();
};

// --- Children: every one is tracked and stopped on any exit path ---------------------------
const children = new Set();

/** Start a child with its output in `<name>.log`; resolves to its exit code. */
function start(name, command, args) {
  const out = createWriteStream(join(dir, `${name}.log`));
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  const done = new Promise((resolve) => {
    child.on('error', (error) => {
      out.write(`spawn failed: ${error.message}\n`);
      children.delete(child);
      resolve(127);
    });
    child.on('close', (code, signal) => {
      children.delete(child);
      resolve(code ?? (signal ? 128 : 1));
    });
  });
  return { child, done };
}

/** SIGTERM every live child, wait up to `graceMs`, then SIGKILL what is left. */
async function stopChildren(graceMs = 15_000) {
  const live = [...children];
  if (live.length === 0) return;
  const closed = live.map((c) => new Promise((resolve) => c.once('close', resolve)));
  for (const child of live) child.kill('SIGTERM');
  const all = Promise.all(closed);
  if ((await Promise.race([all.then(() => 'closed'), sleep(graceMs, 'timeout')])) === 'timeout') {
    for (const child of children) child.kill('SIGKILL');
    await Promise.race([all, sleep(2_000)]);
  }
}

class Stop extends Error {
  constructor(step, reason, code, classification) {
    super(reason);
    Object.assign(this, { step, code, classification });
  }
}
const stop = (step, reason, code, classification = 'stopped') => {
  throw new Stop(step, reason, code, classification);
};

let interrupted = false;
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
]) {
  process.on(signal, async () => {
    if (interrupted) return;
    interrupted = true;
    pair.stopped = { step: 'signal', reason: `interrupted by ${signal}` };
    pair.classification = 'interrupted';
    log('!', `${signal}: stopping k6 and the gate`);
    await stopChildren();
    save();
    process.exit(code);
  });
}

const lastLine = (name) => {
  const file = join(dir, `${name}.log`);
  return existsSync(file) ? (readFileSync(file, 'utf8').trim().split('\n').at(-1) ?? '') : '';
};
const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);
const gate = (command, ...args) => [
  GATE,
  command,
  '--metrics-url',
  `${apiUrl}/metrics`,
  '--probes',
  cfg.gateProbes,
  ...(cfg.thresholds ? ['--thresholds', cfg.thresholds] : []),
  ...args,
];

// --- Runner and k6 ---------------------------------------------------------------------------
function runnerInfo() {
  const read = (file) => {
    try {
      return readFileSync(file, 'utf8').trim();
    } catch {
      return null;
    }
  };
  const cpuMax = read('/sys/fs/cgroup/cpu.max');
  let k6Version = null;
  try {
    k6Version = execFileSync('k6', ['version'], { encoding: 'utf8', timeout: 10_000 }).trim();
  } catch {
    // recorded as null; the k6 run itself fails if k6 is missing
  }
  return {
    node: process.version,
    k6: k6Version,
    hostCores: availableParallelism(),
    cores: cgroupCores(cpuMax, availableParallelism()),
    cpuMax,
    memoryMax: read('/sys/fs/cgroup/memory.max'),
    region: env.RAILWAY_REPLICA_REGION ?? null,
  };
}

/** Sample a child's CPU from /proc every second (Linux); null fields elsewhere. */
function sampleCpu(pid, runnerCores) {
  const stat = `/proc/${pid}/stat`;
  const result = { cores: null, peakCores: null, runnerCores, seconds: null };
  if (!existsSync(stat)) return { result, stop() {} };
  const started = performance.now();
  let last = { at: started, cpu: 0 };
  let peak = 0;
  const timer = setInterval(() => {
    try {
      const cpu = procCpuSeconds(readFileSync(stat, 'utf8'));
      const at = performance.now();
      if (cpu === null) return;
      peak = Math.max(peak, (cpu - last.cpu) / ((at - last.at) / 1000));
      last = { at, cpu };
    } catch {
      // the process ended between two samples
    }
  }, 1_000);
  return {
    result,
    stop() {
      clearInterval(timer);
      const seconds = (last.at - started) / 1000;
      if (seconds > 0) {
        Object.assign(result, { cores: last.cpu / seconds, peakCores: peak, seconds });
      }
    },
  };
}

function k6(runtime, phase, duration) {
  const vars = {
    SCENARIO: scenario,
    WEB: urls[runtime],
    PICK: 'cycle',
    VUS: cfg.vus,
    DURATION: duration,
    ...(cfg.rate ? { RATE: String(cfg.rate) } : {}),
    ...(cfg.acceptEncoding ? { ACCEPT_ENCODING: cfg.acceptEncoding } : {}),
  };
  for (const name of ['FIXTURES', 'PRE_VUS', 'MAX_VUS']) if (env[name]) vars[name] = env[name];
  const args = ['run', '-q', '--no-color'];
  for (const [k, v] of Object.entries(vars)) args.push('-e', `${k}=${v}`);
  args.push('--summary-export', join(dir, `${runtime}-${phase}.k6.json`), K6_SCRIPT);
  return start(`${runtime}-${phase}.k6`, 'k6', args);
}

/** Both storefronts' and the API's readiness, plus each storefront's build identity. */
async function identity() {
  const result = {};
  for (const [runtime, url] of Object.entries(urls)) {
    const ready = await fetch(`${url}/api/internal/health/ready`, {
      signal: AbortSignal.timeout(10_000),
    });
    await ready.arrayBuffer();
    const home = await fetch(`${url}/`, { signal: AbortSignal.timeout(10_000) });
    const html = await home.text();
    const assets = [
      ...new Set([...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"#]+)"/g)].map((m) => m[1])),
    ].sort();
    result[runtime] = {
      ready: ready.status,
      deploymentId: /[?&](?:amp;)?dpl=([^"&\s,]+)/.exec(html)?.[1] ?? null,
      assetCount: assets.length,
      assetsSha256: assets.length
        ? createHash('sha256').update(assets.join('\n')).digest('hex').slice(0, 16)
        : null,
      edge: home.headers.get('x-railway-edge'),
    };
  }
  const api = await fetch(`${apiUrl}/health/ready`, { signal: AbortSignal.timeout(10_000) });
  await api.arrayBuffer();
  result.api = { ready: api.status };
  return result;
}

/** Problems that make a single runtime's run unusable right away (empty = continue). */
function runProblems(runtime) {
  const run = pair.runs[runtime];
  const problems = k6Problems(run.k6, { rate: cfg.rate, seconds: cfg.seconds, cpu: run.cpu });
  if (run.gate?.wrote) problems.push('the run made the API write: not a read-only run');
  if (run.gate && run.gate.totals.offersCreated !== 0) {
    problems.push(`${run.gate.totals.offersCreated} offers created: pre-warm the series`);
  }
  return problems;
}

async function measure(runtime, steps, runner) {
  log(
    steps[0],
    `warm-up: ${runtime}, ${cfg.warmup}${cfg.rate ? ` at ${cfg.rate}/s` : ` at ${cfg.vus} VUs`}`,
  );
  const warm = k6(runtime, 'warmup', cfg.warmup);
  const warmCode = await warm.done;
  if (warmCode !== 0) {
    stop(
      steps[0],
      `warm-up failed on ${runtime} (k6 exit ${warmCode}): ${lastLine(`${runtime}-warmup.k6`)}`,
      EXIT.error,
      'invalid',
    );
  }
  const warmSummary = summarizeK6(readJson(join(dir, `${runtime}-warmup.k6.json`)));
  if (warmSummary?.correct !== 1 || warmSummary.status['5xx'] > 0) {
    stop(
      steps[0],
      `warm-up on ${runtime} answered incorrectly (correct = ${warmSummary?.correct})`,
      EXIT['not-comparable'],
      'not-comparable',
    );
  }

  log(steps[1], `measured run: ${runtime}, ${cfg.duration}; API watched`);
  const watchArgs = gate(
    'watch',
    '--baseline',
    join(dir, 'api-baseline.json'),
    '--out',
    join(dir, `${runtime}-api.json`),
    '--interval',
    cfg.gateInterval,
    '--expect-seconds',
    String(cfg.seconds),
    // Safety cap: the watch ends on its own even if this process is killed hard.
    '--duration',
    String(cfg.seconds + 120),
    '--fail-fast',
  );
  if (cfg.apiCpu) watchArgs.push('--cpu-limit', cfg.apiCpu);
  if (cfg.apiMemoryMib) watchArgs.push('--memory-limit-mib', cfg.apiMemoryMib);
  const watch = start(`${runtime}-api`, process.execPath, watchArgs);
  await sleep(2_000);
  const load = k6(runtime, 'measured', cfg.duration);
  const cpu = sampleCpu(load.child.pid, runner.cores);
  let watchCode = null;
  // The gate ends early only when the API became backend-limited, restarted or unreadable.
  watch.done.then((code) => {
    watchCode = code;
    if (code !== 0) load.child.kill('SIGTERM');
  });
  const loadCode = await load.done;
  cpu.stop();
  if (watchCode === null) watch.child.kill('SIGTERM');
  watchCode = await watch.done;
  const gateFile = readJson(join(dir, `${runtime}-api.json`));
  pair.runs[runtime] = {
    k6: summarizeK6(readJson(join(dir, `${runtime}-measured.k6.json`))),
    k6Exit: loadCode,
    cpu: cpu.result,
    gate: gateFile?.result ?? null,
    gateExit: watchCode,
    api: lastLine(`${runtime}-api`),
  };
  log(steps[2], `${runtime}: ${pair.runs[runtime].api}`);
  if (watchCode === 4)
    stop(steps[1], `the API restarted during the ${runtime} run`, EXIT.restarted, 'restarted');
  if (watchCode === 5 || !gateFile) {
    stop(
      steps[1],
      `API evidence missing during the ${runtime} run: ${pair.runs[runtime].api}`,
      EXIT.invalid,
      'invalid',
    );
  }
  if (watchCode !== 0) {
    stop(
      steps[1],
      `backend-limited during the ${runtime} run: ${pair.runs[runtime].api}`,
      EXIT['backend-limited'],
      'backend-limited',
    );
  }
  if (loadCode !== 0)
    stop(steps[1], `k6 failed on ${runtime} (exit ${loadCode})`, EXIT.error, 'invalid');
  const problems = runProblems(runtime);
  if (problems.length) {
    stop(steps[2], `${runtime}: ${problems.join('; ')}`, EXIT['not-comparable'], 'not-comparable');
  }
}

async function recover(step, after) {
  log(step, `waiting for the API to return to its baseline after ${after}`);
  const r = start(
    `recover-after-${after}`,
    process.execPath,
    gate(
      'recover',
      '--baseline',
      join(dir, 'api-baseline.json'),
      '--out',
      join(dir, `recover-after-${after}.json`),
      '--window',
      cfg.gateWindow,
      '--stable',
      cfg.gateStable,
      '--timeout',
      cfg.recoverTimeout,
      '--min-quiet',
      cfg.minQuiet,
    ),
  );
  const code = await r.done;
  pair.recovered[after] = code === 0;
  if (code === 4)
    stop(step, 'the API restarted: the series is invalid', EXIT.restarted, 'restarted');
  if (code === 5)
    stop(
      step,
      `API evidence missing during recovery: ${lastLine(`recover-after-${after}`)}`,
      EXIT.invalid,
      'invalid',
    );
  if (code !== 0) {
    stop(
      step,
      `the API did not recover after ${after}; that run counts as backend-limited`,
      EXIT['not-recovered'],
      'backend-limited',
    );
  }
  log(step, lastLine(`recover-after-${after}`));
}

async function main() {
  const runner = runnerInfo();
  pair.runner = runner;
  log('1', `round ${round}: ${order.join(' then ')}; scenario ${scenario}`);
  pair.identityBefore = await identity();
  const notReady = Object.entries(pair.identityBefore).filter(([, v]) => v.ready !== 200);
  if (notReady.length)
    stop('1', `not ready: ${notReady.map(([k]) => k).join(', ')}`, EXIT.error, 'invalid');

  if (env.DEPLOYMENTS) {
    pair.deployments = readJson(env.DEPLOYMENTS);
    const problems = deploymentProblems(pair.deployments, { expectNextrs: env.EXPECT_NEXTRS });
    if (problems.length)
      stop(
        '1',
        `deployments not equivalent: ${problems.join('; ')}`,
        EXIT.deployment,
        'not-comparable',
      );
  } else {
    log(
      '1',
      'WARNING: no DEPLOYMENTS file: this pair cannot be comparable (rehearsal / smoke only)',
    );
  }
  if (env.PREWARM) pair.prewarm = readJson(env.PREWARM);

  log('2', 'API baseline (idle)');
  const baseArgs = gate(
    'baseline',
    '--out',
    join(dir, 'api-baseline.json'),
    '--window',
    cfg.gateWindow,
    '--windows',
    cfg.gateWindows,
    '--min-baseline-seconds',
    cfg.gateMinBaseline,
  );
  if (cfg.seriesBaseline) baseArgs.push('--same-process-as', cfg.seriesBaseline);
  const base = start('api-baseline', process.execPath, baseArgs);
  const baseCode = await base.done;
  if (baseCode === 4)
    stop(
      '2',
      'the API restarted since the series began: the series is invalid',
      EXIT.restarted,
      'restarted',
    );
  if (baseCode === 5)
    stop('2', `API evidence missing: ${lastLine('api-baseline')}`, EXIT.invalid, 'invalid');
  if (baseCode !== 0)
    stop(
      '2',
      `no usable baseline: ${lastLine('api-baseline')}`,
      FROM_GATE[baseCode] ?? EXIT.error,
      'invalid',
    );
  log('2', lastLine('api-baseline'));
  pair.series = cfg.seriesBaseline
    ? { proven: true, baseline: cfg.seriesBaseline }
    : { proven: true, start: true, baseline: join(dir, 'api-baseline.json') };

  await measure(order[0], ['3', '4', '5'], runner);
  await recover('6-7', order[0]);
  await measure(order[1], ['8', '9', '10'], runner);
  await recover('10', order[1]);

  pair.identityAfter = await identity();
  const problems = pairProblems(
    {
      order,
      config: { rate: cfg.rate, seconds: cfg.seconds },
      runs: pair.runs,
      recovered: pair.recovered,
      identityBefore: pair.identityBefore,
      identityAfter: pair.identityAfter,
      deployments: pair.deployments,
      series: pair.series,
    },
    { expectNextrs: env.EXPECT_NEXTRS },
  );
  pair.problems = problems;
  pair.finishedAt = new Date().toISOString();
  if (problems.some((p) => p.includes('deployment changed'))) {
    stop('11', problems.join('; '), EXIT.deployment, 'not-comparable');
  }
  if (problems.length)
    stop('11', `not comparable: ${problems.join('; ')}`, EXIT['not-comparable'], 'not-comparable');
  pair.comparable = true;
  pair.classification = 'comparable';
  log('11', `comparable: every check passed → ${join(dir, 'pair.json')}`);
}

try {
  await main();
  process.exit(EXIT.comparable);
} catch (error) {
  if (interrupted) await new Promise(() => {}); // the signal handler owns the exit
  const s =
    error instanceof Stop
      ? error
      : new Stop(
          '?',
          error instanceof Error ? error.message : String(error),
          EXIT.error,
          'invalid',
        );
  pair.stopped = { step: s.step, reason: s.message };
  pair.classification = s.classification;
  pair.comparable = false;
  log(s.step, `STOPPED: ${s.message}`);
  await stopChildren();
  save();
  process.exit(s.code);
}
