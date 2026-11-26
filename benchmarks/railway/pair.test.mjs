// node --test benchmarks/railway/pair.test.mjs
//
// pair.mjs end to end against fakes: a fake retailing API (/metrics, /health/ready, the probe
// route), two fake storefronts, and a fake `k6` first on PATH. No network beyond 127.0.0.1, no
// Railway, no real k6. Checks the exit codes and that no child process outlives pair.mjs.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PAIR = join(dirname(fileURLToPath(import.meta.url)), 'pair.mjs');

const FAKE_K6 = `#!/usr/bin/env node
// Fake k6 for pair.test.mjs. FAKE_K6_MODE: ok | fail | hang (the measured run only).
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'version') { console.log('k6 v0.0.0-fake'); process.exit(0); }
const out = args[args.indexOf('--summary-export') + 1];
const measured = out.includes('-measured');
const mode = process.env.FAKE_K6_MODE ?? 'ok';
if (measured && mode === 'fail') { console.error('fake k6: failed'); process.exit(99); }
if (measured && mode === 'hang') {
  fs.writeFileSync(process.env.FAKE_K6_PIDFILE, String(process.pid));
  setTimeout(() => {}, 120000);
  return;
}
const n = 50;
const summary = { metrics: {
  http_reqs: { count: n, rate: 50 }, iterations: { count: n, rate: 50 },
  http_req_failed: { value: 0, passes: 0, fails: n },
  http_req_duration: { avg: 5, med: 5, 'p(90)': 6, 'p(95)': 7, 'p(99)': 8, max: 9 },
  http_req_waiting: { avg: 4, med: 4, 'p(90)': 5, 'p(95)': 6, 'p(99)': 7, max: 8 },
  data_received: { count: 1000, rate: 1 }, data_sent: { count: 100, rate: 1 },
  velasia_correct: { value: 1, passes: n, fails: 0 },
  velasia_status_2xx: { count: n, rate: 1 },
} };
// Burn a little CPU, like a real load generator, so /proc has something to read.
const until = Date.now() + 1200; while (Date.now() < until) Math.sqrt(Math.random());
fs.writeFileSync(out, JSON.stringify(summary));
`;

/** The retailing API as the gate sees it. `state` is changed by the tests. */
function fakeApi(state) {
  let cpu = 10;
  let probes = 0;
  return createServer((req, res) => {
    if (req.url === '/v1/airline') {
      probes += 1;
      return res.end('{}');
    }
    if (req.url === '/health/ready') return res.end('ok');
    if (req.url !== '/metrics') return res.writeHead(404).end();
    state.scrapes += 1;
    cpu += 0.0001;
    const start = state.restartAfter && state.scrapes > state.restartAfter ? 2000 : 1000;
    const lines = [
      '# TYPE velasia_http_requests_total counter',
      '# TYPE velasia_api_errors_total counter',
      '# TYPE velasia_writer_task_seconds histogram',
      `process_start_time_seconds{service="retailing-api"} ${start}`,
      `process_cpu_seconds_total{service="retailing-api",mode="user"} ${cpu}`,
      'process_resident_memory_bytes{service="retailing-api"} 150000000',
      'nodejs_eventloop_delay_seconds{service="retailing-api",quantile="0.99"} 0.001',
      `velasia_http_requests_total{method="GET",route="/v1/airline",status="200"} ${probes}`,
      'velasia_http_requests_in_flight 1',
      'velasia_writer_queue_depth 0',
      'velasia_writer_task_seconds_count 0',
      'velasia_memory_store_entries{store="offers"} 1200',
      'velasia_memory_store_entries{store="sessions"} 0',
      'velasia_memory_store_created_total{store="offers"} 1200',
      'velasia_memory_store_created_total{store="sessions"} 0',
    ];
    const broken = state.breakAfter && state.scrapes > state.breakAfter;
    res.end(lines.filter((l) => !(broken && l.startsWith('process_cpu'))).join('\n'));
  });
}

/** A storefront: ready, and a home page whose asset list can change mid-pair. */
function fakeStorefront(state, name) {
  let homes = 0;
  return createServer((req, res) => {
    if (req.url === '/api/internal/health/ready') return res.end('ok');
    if (req.url !== '/') return res.writeHead(404).end();
    homes += 1;
    const build = state.changeAfter?.[name] && homes > state.changeAfter[name] ? 'b2' : 'b1';
    res.end(`<html><script src="/_next/static/chunks/${name}-${build}.js"></script></html>`);
  });
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
const origin = (server) => `http://127.0.0.1:${server.address().port}`;

/** Run pair.mjs against fresh fakes; resolves with its exit code and output directory. */
async function runPair({ mode = 'ok', state = {}, scenario = 'home', onStart } = {}) {
  const fixtures = mkdtempSync(join(tmpdir(), 'velasia-pair-test-'));
  writeFileSync(join(fixtures, 'k6'), FAKE_K6);
  chmodSync(join(fixtures, 'k6'), 0o755);
  writeFileSync(
    join(fixtures, 'deployments.json'),
    JSON.stringify({
      nextrsVersion: '0.1.0-rc.2',
      services: Object.fromEntries(
        ['velasia-node', 'velasia-nextrs', 'velasia-api'].map((name) => [
          name,
          {
            deploymentId: `${name}-1`,
            commit: 'abc',
            region: 'r1',
            replicas: 1,
            cpu: 1,
            memoryBytes: 2 ** 30,
          },
        ]),
      ),
    }),
  );
  const s = { scrapes: 0, ...state };
  const servers = await Promise.all([
    listen(fakeApi(s)),
    listen(fakeStorefront(s, 'node')),
    listen(fakeStorefront(s, 'nextrs')),
  ]);
  const [api, node, nextrs] = servers;
  const out = join(fixtures, 'out');
  const child = spawn(process.execPath, [PAIR, scenario, '1'], {
    env: {
      PATH: `${fixtures}:${process.env.PATH}`,
      NODE_URL: origin(node),
      NEXTRS_URL: origin(nextrs),
      API_URL: origin(api),
      SERIES_START: '1',
      DEPLOYMENTS: join(fixtures, 'deployments.json'),
      OUT: out,
      DURATION: '1s',
      WARMUP: '1s',
      GATE_WINDOW: '0.2',
      GATE_WINDOWS: '3',
      GATE_INTERVAL: '0.2',
      GATE_STABLE: '2',
      GATE_PROBES: '1',
      GATE_MIN_BASELINE: '0',
      MIN_QUIET: '0',
      RECOVER_TIMEOUT: '10',
      FAKE_K6_MODE: mode,
      FAKE_K6_PIDFILE: join(fixtures, 'k6.pid'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  await onStart?.({ child, fixtures });
  const code = await exited;
  for (const server of servers) server.close();
  const pairFile = join(out, 'round-1', scenario, 'pair.json');
  const pair = existsSync(pairFile) ? JSON.parse(readFileSync(pairFile, 'utf8')) : null;
  return { code, output, pair, out, fixtures };
}

/** Processes whose command line mentions `text` (our children carry the output path). */
function processesMentioning(text) {
  if (existsSync('/proc/self/cmdline')) {
    // Linux: read /proc directly (slim images have no `ps`).
    return readdirSync('/proc')
      .filter((name) => /^\d+$/.test(name))
      .map((pid) => {
        try {
          return `${pid} ${readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ')}`;
        } catch {
          return '';
        }
      })
      .filter((line) => line.includes(text));
  }
  const list = execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' });
  return list.split('\n').filter((line) => line.includes(text) && !line.includes('ps -A'));
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('pair.mjs end to end (fakes)', { concurrency: true, timeout: 60_000 }, () => {
  test('a clean pair: comparable on Linux; elsewhere only the k6 CPU evidence is missing', async () => {
    const { code, pair, output } = await runPair();
    assert.deepEqual(pair.order, ['node', 'nextrs']);
    assert.equal(pair.runs.node.gate.verdict, 'ok', output);
    if (existsSync('/proc/self/stat')) {
      assert.equal(code, 0, output);
      assert.equal(pair.comparable, true);
      assert.deepEqual(pair.recovered, { node: true, nextrs: true });
      assert.ok(pair.runs.nextrs.cpu.cores > 0);
    } else {
      assert.equal(code, 6, output);
      assert.equal(pair.comparable, false);
      assert.match(pair.stopped.reason, /k6 CPU not measured/);
    }
  });

  test('a failed k6 run stops the pair (exit 1) and leaves no child behind', async () => {
    const { code, pair, out } = await runPair({ mode: 'fail' });
    assert.equal(code, 1);
    assert.equal(pair.comparable, false);
    assert.match(pair.stopped.reason, /k6 failed on node \(exit 99\)/);
    await sleep(500);
    assert.deepEqual(processesMentioning(out), []);
  });

  test('SIGTERM stops k6 and the API watch before pair.mjs exits', async () => {
    let k6Pid;
    const { code, pair, out } = await runPair({
      mode: 'hang',
      onStart: async ({ child, fixtures }) => {
        const pidFile = join(fixtures, 'k6.pid');
        for (let i = 0; i < 200 && !existsSync(pidFile); i++) await sleep(100);
        k6Pid = Number(readFileSync(pidFile, 'utf8'));
        assert.ok(alive(k6Pid));
        child.kill('SIGTERM');
      },
    });
    assert.equal(code, 143);
    assert.equal(pair.classification, 'interrupted');
    assert.equal(alive(k6Pid), false);
    await sleep(500);
    assert.deepEqual(processesMentioning(out), []);
  });

  test('a storefront deployment change during the pair: exit 5', async () => {
    // identity() reads each home page once before and once after the pair.
    const { code, pair } = await runPair({ state: { changeAfter: { nextrs: 1 } } });
    if (existsSync('/proc/self/stat')) {
      assert.equal(code, 5);
      assert.match(pair.stopped.reason, /nextrs: the deployment changed/);
    } else {
      // Without /proc the pair already stops at the first run (k6 CPU not measured).
      assert.equal(code, 6);
    }
    assert.equal(pair.comparable, false);
  });

  test('an API restart during the series: exit 4', async () => {
    const { code, pair } = await runPair({ state: { restartAfter: 6 } });
    assert.equal(code, 4);
    assert.equal(pair.classification, 'restarted');
  });

  test('API metrics that disappear: exit 7, never a healthy reading', async () => {
    const { code, pair } = await runPair({ state: { breakAfter: 6 } });
    assert.equal(code, 7);
    assert.equal(pair.classification, 'invalid');
    assert.match(pair.stopped.reason, /evidence missing|process_cpu_seconds_total/);
  });

  test('without a series declaration, or for a writing workload, nothing runs', () => {
    const run = (args, extra = {}) => {
      try {
        execFileSync(process.execPath, [PAIR, ...args], {
          env: { PATH: process.env.PATH, NODE_URL: 'x', NEXTRS_URL: 'y', API_URL: 'z', ...extra },
          stdio: 'pipe',
        });
        return '';
      } catch (error) {
        return String(error.stderr);
      }
    };
    assert.match(run(['home', '1']), /SERIES_BASELINE .* or SERIES_START=1/);
    assert.match(run(['payment', '1']), /changes shared state/);
    assert.match(run(['server-action', '1']), /excluded until/);
  });
});
