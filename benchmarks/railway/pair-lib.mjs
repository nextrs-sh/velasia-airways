/**
 * The pure part of pair.mjs: reading a k6 summary and deciding whether a paired run is
 * comparable. Every check fails closed: evidence that is missing is a reason, never a pass.
 * Tests: pair-lib.test.mjs. Procedure: docs/deployment/railway-benchmark-readiness.md.
 */

/** Workloads verified read-only on the Railway-like stack (the gate saw no writes). */
export const PAIRED_WORKLOADS = new Set([
  'home',
  'destination',
  'cached',
  'static-assets',
  'rsc',
  'flight-search',
  'route-handler',
  'offers',
  'comparison',
  'manage-booking',
  'my-trips',
]);

/** Why a workload is refused by pair.mjs (undefined = allowed). */
export function refusedWorkload(scenario) {
  if (PAIRED_WORKLOADS.has(scenario)) return undefined;
  if (scenario === 'server-action') {
    return "'server-action' is excluded until a captured request is shown to be read-only and deterministic (docs: Server Actions)";
  }
  if (['shopping-session', 'checkout', 'payment', 'mixed'].includes(scenario)) {
    return `'${scenario}' changes shared state; it is not part of the paired (primary) comparison`;
  }
  return `unknown workload '${scenario}'`;
}

/** Workloads whose requests need the seeded fixtures file. */
export const NEEDS_FIXTURES = new Set([
  'flight-search',
  'route-handler',
  'offers',
  'comparison',
  'manage-booking',
  'my-trips',
]);

/** Parse a k6 duration such as `60s`, `5m`, `1m30s` into seconds (NaN if unreadable). */
export function durationSeconds(text) {
  const match = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?$/.exec(String(text).trim());
  if (!match || !match.slice(1).some(Boolean)) return NaN;
  const [, h = 0, m = 0, s = 0] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/**
 * The numbers a report needs from a `k6 run --summary-export` file. Counters that k6 only
 * emits once they are non-zero (status classes, dropped iterations) read as 0 when absent;
 * everything else stays null when absent, and k6Problems refuses it.
 */
export function summarizeK6(exported) {
  if (!exported || typeof exported !== 'object' || !exported.metrics) return null;
  const m = exported.metrics;
  const count = (k) => (m[k] && Number.isFinite(m[k].count) ? m[k].count : null);
  const zeroIfAbsent = (k) => (m[k] ? count(k) : 0);
  const trend = (k) =>
    m[k]
      ? {
          avg: m[k].avg ?? null,
          med: m[k].med ?? null,
          p90: m[k]['p(90)'] ?? null,
          p95: m[k]['p(95)'] ?? null,
          p99: m[k]['p(99)'] ?? null,
          max: m[k].max ?? null,
        }
      : null;
  const status = {
    '2xx': zeroIfAbsent('velasia_status_2xx'),
    '3xx': zeroIfAbsent('velasia_status_3xx'),
    '4xx': zeroIfAbsent('velasia_status_4xx'),
    '5xx': zeroIfAbsent('velasia_status_5xx'),
    429: zeroIfAbsent('velasia_status_429'),
    other: zeroIfAbsent('velasia_status_other'),
  };
  const correct = m.velasia_correct;
  return {
    correct: correct?.value ?? null,
    checks: correct ? { passes: correct.passes ?? null, fails: correct.fails ?? null } : null,
    requests: count('http_reqs'),
    requestsPerSecond: m.http_reqs?.rate ?? null,
    iterations: count('iterations'),
    droppedIterations: zeroIfAbsent('dropped_iterations'),
    failed: m.http_req_failed?.value ?? null,
    durationMs: trend('http_req_duration'),
    ttfbMs: trend('http_req_waiting'),
    bytesReceived: count('data_received'),
    bytesSent: count('data_sent'),
    status,
    compressed: m.velasia_compressed?.value ?? null,
    staticGzip: m.velasia_static_gzip?.value ?? null,
  };
}

export const DEFAULT_K6_LIMITS = {
  /** Share of offered iterations k6 could not start on time (RATE mode). */
  maxDroppedShare: 0.01,
  /** Share of iterations actually started, of RATE × duration. */
  minOfferedShare: 0.97,
  /** http_req_failed rate allowed (any failed request makes a run not comparable). */
  maxFailedRate: 0,
  /** k6's CPU, as a share of the runner's cores, above which k6 itself may be the limit. */
  maxK6CpuShare: 0.8,
};

/** Why a measured k6 run is not usable evidence (empty list = usable). */
export function k6Problems(
  summary,
  { rate = 0, seconds = NaN, cpu = null, limits = DEFAULT_K6_LIMITS } = {},
) {
  if (!summary) return ['no k6 summary'];
  const problems = [];
  if (!(summary.requests > 0)) problems.push('k6 recorded no requests');
  const checks = summary.checks ? summary.checks.passes + summary.checks.fails : NaN;
  if (!(checks > 0)) problems.push('k6 recorded no correctness checks');
  if (summary.correct !== 1) {
    problems.push(`incorrect answers (${summary.checks?.fails ?? '?'} failed checks)`);
  }
  if (!(Number.isFinite(summary.failed) && summary.failed <= limits.maxFailedRate)) {
    problems.push(`http_req_failed ${summary.failed ?? 'missing'}`);
  }
  if (summary.status['5xx'] > 0) problems.push(`${summary.status['5xx']} answers 5xx`);
  if (summary.status[429] > 0) problems.push(`${summary.status[429]} answers 429`);
  const statusTotal = Object.entries(summary.status)
    .filter(([k]) => k !== '429')
    .reduce((s, [, v]) => s + v, 0);
  if (statusTotal !== checks) {
    problems.push(`status distribution covers ${statusTotal} of ${checks} checked answers`);
  }
  if (!summary.durationMs || !Number.isFinite(summary.durationMs.p99)) {
    problems.push('no latency distribution');
  }
  if (rate > 0) {
    if (!Number.isFinite(summary.iterations)) problems.push('no iteration count');
    const offered = summary.iterations + summary.droppedIterations;
    if (offered > 0 && summary.droppedIterations / offered > limits.maxDroppedShare) {
      problems.push(`${summary.droppedIterations} of ${offered} iterations dropped`);
    }
    if (Number.isFinite(seconds) && summary.iterations < limits.minOfferedShare * rate * seconds) {
      problems.push(
        `${summary.iterations} iterations started, offered ${rate}/s × ${seconds} s = ${rate * seconds}`,
      );
    }
  }
  if (!cpu || !Number.isFinite(cpu.cores) || !Number.isFinite(cpu.runnerCores)) {
    problems.push('k6 CPU not measured (needs Linux /proc)');
  } else if (cpu.peakCores > limits.maxK6CpuShare * cpu.runnerCores) {
    problems.push(
      `k6 CPU-bound: peak ${cpu.peakCores.toFixed(2)} of ${cpu.runnerCores} runner cores`,
    );
  }
  return problems;
}

/**
 * Why the operator-recorded deployment metadata (DEPLOYMENTS file, read from Railway) does not
 * show an equivalent pair of deployments (empty list = equivalent). The file is the only
 * source for commit, region, replicas and limits: the runner cannot read them itself.
 */
export function deploymentProblems(meta, { expectNextrs = '0.1.0-rc.2' } = {}) {
  if (!meta || typeof meta !== 'object') return ['no deployment metadata (DEPLOYMENTS)'];
  const problems = [];
  const services = meta.services ?? {};
  const node = services['velasia-node'];
  const nextrs = services['velasia-nextrs'];
  const api = services['velasia-api'];
  for (const [name, s] of Object.entries({
    'velasia-node': node,
    'velasia-nextrs': nextrs,
    'velasia-api': api,
  })) {
    if (!s) {
      problems.push(`${name} not recorded`);
      continue;
    }
    for (const key of ['deploymentId', 'commit', 'region']) {
      if (typeof s[key] !== 'string' || !s[key]) problems.push(`${name}.${key} missing`);
    }
    if (s.replicas !== 1) problems.push(`${name} has ${s.replicas ?? '?'} replicas, not 1`);
    if (!(s.cpu > 0) || !(s.memoryBytes > 0)) problems.push(`${name} limits missing`);
    if (s.status !== undefined && s.status !== 'SUCCESS') {
      problems.push(`${name} deployment status ${s.status}`);
    }
  }
  if (node && nextrs) {
    if (node.commit !== nextrs.commit) problems.push('storefronts run different commits');
    if (node.cpu !== nextrs.cpu || node.memoryBytes !== nextrs.memoryBytes) {
      problems.push('storefront CPU / memory limits differ');
    }
  }
  const regions = new Set([node, nextrs, api].filter(Boolean).map((s) => s.region));
  if (regions.size > 1) problems.push(`services in different regions: ${[...regions].join(', ')}`);
  if (meta.nextrsVersion !== expectNextrs) {
    problems.push(`NextRS ${meta.nextrsVersion ?? 'unrecorded'}, expected ${expectNextrs}`);
  }
  return problems;
}

/**
 * Everything that must hold for `comparable: true` (empty list = comparable).
 *
 * evidence = {
 *   order: ['node', 'nextrs'],
 *   config: { rate, seconds },
 *   runs: { node: { gate, k6, cpu }, nextrs: { … } },   gate = classifyRun() result
 *   recovered: { node: true, nextrs: true },
 *   identityBefore, identityAfter,                     from pair.mjs identity()
 *   deployments,                                       DEPLOYMENTS file contents
 *   series: { proven: true } | { proven: false, reason },
 * }
 */
export function pairProblems(evidence, { k6Limits = DEFAULT_K6_LIMITS, expectNextrs } = {}) {
  const problems = [];
  const order = evidence?.order ?? [];
  if (order.length !== 2 || new Set(order).size !== 2) problems.push('order is not two runtimes');
  for (const runtime of order) {
    const run = evidence.runs?.[runtime];
    if (!run) {
      problems.push(`${runtime}: no measured run`);
      continue;
    }
    if (!run.gate) problems.push(`${runtime}: no API verdict`);
    else {
      if (run.gate.verdict !== 'ok') {
        problems.push(`${runtime}: API ${run.gate.verdict} (${run.gate.reasons.join('; ')})`);
      }
      if (run.gate.wrote) problems.push(`${runtime}: the run made the API write`);
      if (run.gate.totals?.offersCreated !== 0) {
        problems.push(
          `${runtime}: ${run.gate.totals?.offersCreated ?? '?'} offers created (shared offer cache not equivalent; pre-warm the series)`,
        );
      }
    }
    for (const p of k6Problems(run.k6, {
      rate: evidence.config?.rate ?? 0,
      seconds: evidence.config?.seconds,
      cpu: run.cpu,
      limits: k6Limits,
    })) {
      problems.push(`${runtime}: ${p}`);
    }
    if (evidence.recovered?.[runtime] !== true) {
      problems.push(`${runtime}: API recovery not confirmed`);
    }
    const before = evidence.identityBefore?.[runtime];
    const after = evidence.identityAfter?.[runtime];
    if (!before || !after) problems.push(`${runtime}: deployment identity not recorded`);
    else {
      if (before.ready !== 200 || after.ready !== 200) problems.push(`${runtime}: not ready`);
      if (!before.assetsSha256 || !(before.assetCount > 0)) {
        problems.push(`${runtime}: no build fingerprint`);
      }
      if (
        before.assetsSha256 !== after.assetsSha256 ||
        before.deploymentId !== after.deploymentId
      ) {
        problems.push(`${runtime}: the deployment changed during the pair`);
      }
    }
  }
  if (evidence?.config?.rate > 0 && order.length === 2) {
    const [a, b] = order.map((r) => evidence.runs?.[r]?.k6?.iterations);
    if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) > 0.02 * Math.max(a, b)) {
      problems.push(`iteration counts differ: ${a} vs ${b} at the same offered rate`);
    }
  }
  for (const p of deploymentProblems(evidence?.deployments, { expectNextrs })) {
    problems.push(`deployments: ${p}`);
  }
  if (evidence?.series?.proven !== true) {
    problems.push(`series: ${evidence?.series?.reason ?? 'same API process not proven'}`);
  }
  return problems;
}

/** CPU seconds used by a Linux process so far, from /proc/<pid>/stat (null elsewhere). */
export function procCpuSeconds(statText, ticksPerSecond = 100) {
  // Field 2 (comm) may contain spaces and parentheses: split after the last ')'.
  const rest = String(statText)
    .slice(String(statText).lastIndexOf(')') + 2)
    .split(' ');
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return (utime + stime) / ticksPerSecond;
}

/** CPU cores available to this cgroup, from the text of /sys/fs/cgroup/cpu.max. */
export function cgroupCores(cpuMaxText, hostCores) {
  const [quota, period] = String(cpuMaxText ?? '')
    .trim()
    .split(/\s+/);
  if (quota === 'max' || !quota) return hostCores;
  const cores = Number(quota) / Number(period);
  return Number.isFinite(cores) && cores > 0 ? Math.min(cores, hostCores) : hostCores;
}
