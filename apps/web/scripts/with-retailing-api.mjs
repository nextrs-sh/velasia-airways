#!/usr/bin/env node
/**
 * Run a command (normally `next build`) with the retailing API reachable.
 *
 * Destination pages are prerendered from the API at build time. If
 * RETAILING_API_URL already answers /health, it is used as-is. Otherwise, when
 * it points at this machine, a local API instance is started for the duration
 * of the command and stopped afterwards.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiUrl = process.env.RETAILING_API_URL ?? 'http://127.0.0.1:4010';
const apiDir = join(dirname(fileURLToPath(import.meta.url)), '../../retailing-api');
const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('usage: with-retailing-api.mjs <command> [...args]');
  process.exit(2);
}

async function isHealthy() {
  try {
    const response = await fetch(new URL('/health', apiUrl), { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Every API process started, including failed attempts: all are stopped before exiting. */
const apis = [];
let dataDir;

/**
 * Stop the API processes and wait until they have exited.
 *
 * The API holds this script's stdout and stderr (stdio: 'inherit'). Exiting while it still runs
 * leaves an orphan with the pipe open, and the caller (turbo) then waits for that pipe to close:
 * the build never finishes. So: SIGTERM, wait, SIGKILL after a grace period, and only then exit.
 */
async function stopApis() {
  const running = apis.filter((api) => api.exitCode === null && api.signalCode === null);
  await Promise.all(
    running.map(
      (api) =>
        new Promise((resolve) => {
          const force = setTimeout(() => api.kill('SIGKILL'), 10_000);
          api.once('exit', () => {
            clearTimeout(force);
            resolve();
          });
          api.kill('SIGTERM');
        }),
    ),
  );
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
}

if (!(await isHealthy())) {
  const { hostname, port } = new URL(apiUrl);
  if (!['127.0.0.1', 'localhost'].includes(hostname)) {
    console.error(`Retailing API at ${apiUrl} is unreachable; start it or fix RETAILING_API_URL.`);
    process.exit(1);
  }
  console.warn(`[with-retailing-api] starting a local retailing API on ${apiUrl}`);
  // A throwaway orders database: the build reads only public data and must never touch (or be
  // blocked by the lock on) a developer's own database.
  dataDir = mkdtempSync(join(tmpdir(), 'velasia-build-api-'));
  const startApi = (attempt) => {
    // A fresh file per attempt: a failed start may leave its file locked or half-created.
    const path = join(dataDir, `velasia-${attempt}.db`);
    // The server itself, in this one process (tsx as a loader), as the API's own process tests
    // start it. Not `pnpm --filter … start`: pnpm, its shell and the tsx CLI each add a process,
    // and a SIGTERM to the outermost one did not reach the server, which then outlived the build.
    const api = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: apiDir,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env,
        RETAILING_API_HOST: hostname,
        RETAILING_API_PORT: port || '80',
        LOG_LEVEL: 'warn',
        TALADB_PATH: path,
      },
    });
    apis.push(api);
    return api;
  };
  // A cold container build (tsx compiling the API on a busy builder) can need more than the
  // 30 s default; Dockerfile.node and Dockerfile.nextrs raise it. On a slow, busy disk the API
  // can also exit at startup (its database plugin misses Fastify's 10 s plugin timeout); it is
  // then started again, up to 3 times, within the same deadline.
  const startTimeoutMs = Number(process.env.RETAILING_API_START_TIMEOUT_MS) || 30_000;
  const deadline = Date.now() + startTimeoutMs;
  let attempt = 1;
  let api = startApi(attempt);
  while (!(await isHealthy())) {
    if (api.exitCode !== null && attempt < 3 && Date.now() < deadline) {
      attempt += 1;
      console.warn(
        `[with-retailing-api] the retailing API exited; starting it again (${attempt}/3)`,
      );
      api = startApi(attempt);
    } else if (Date.now() > deadline || api.exitCode !== null) {
      console.error(
        `[with-retailing-api] the retailing API did not become healthy within ${startTimeoutMs} ms.`,
      );
      await stopApis();
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const child = spawn(command, args, {
  stdio: 'inherit',
  env: { ...process.env, RETAILING_API_URL: apiUrl },
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child.kill(signal));
}
child.on('exit', async (code, signal) => {
  await stopApis();
  process.exit(code ?? (signal ? 1 : 0));
});
