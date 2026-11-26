import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterAll, afterEach, expect } from 'vitest';
import { openDatabase } from '../src/db/client';
import { OrderRepository } from '../src/db/repositories/order-repository';
import { PaymentProviderRepository } from '../src/db/repositories/payment-provider-repository';
import { RefundProviderRepository } from '../src/db/repositories/refund-provider-repository';
import type { ProviderCharge, ProviderRefund, StoredOrder } from '../src/db/schema';
import { httpCaller, type Caller } from './checkout-harness';
import { TODAY } from './helpers';

/*
 * Real API processes on their own TalaDB files, for the fault-injection suites (Milestones 5
 * and 6): start, stop gracefully, kill with SIGKILL at a crash point, and read the durable state
 * directly between processes.
 */

const API_DIR = join(import.meta.dirname, '..');
const dirs: string[] = [];
const children = new Set<ChildProcess>();

setFlagsFromString('--expose_gc');
const gc = runInNewContext('gc') as () => void;

/** Register the cleanup hooks (call once per test file). */
export function useProcessHarness() {
  afterEach(() => {
    for (const child of children) child.kill('SIGKILL');
    children.clear();
  });
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

export interface Server extends Caller {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output: () => string;
}

export async function startServer(
  dbPath: string,
  env: Record<string, string> = {},
): Promise<Server> {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: API_DIR,
    env: {
      ...process.env,
      RETAILING_API_PORT: String(port),
      RETAILING_API_HOST: '127.0.0.1',
      TALADB_PATH: dbPath,
      VELASIA_TODAY: TODAY,
      RETAILING_API_FAULTS: 'enabled',
      RETAILING_API_CRASH_TESTS: 'enabled',
      RETAILING_API_FAULT_TIMEOUT_MS: '300',
      PAYMENT_PROVIDER_DELAY_MS: '0',
      PAYMENT_PROVIDER_TIMEOUT_MS: '1500',
      PAYMENT_PENDING_RESOLVE_MS: '0',
      LOG_LEVEL: 'warn',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let output = '';
  child.stdout!.on('data', (chunk) => (output += chunk));
  child.stderr!.on('data', (chunk) => (output += chunk));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => {
      children.delete(child);
      resolve({ code, signal });
    }),
  );
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`API exited during startup:\n${output}`);
    try {
      const response = await fetch(`${base}/health/ready`);
      if (response.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`API didn't start:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { ...httpCaller(base), child, exited, output: () => output };
}

/** Graceful stop (SIGTERM): what a deployment does. */
export async function stop(server: Server) {
  server.child.kill('SIGTERM');
  const { code } = await server.exited;
  expect(code).toBe(0);
}

/** Read the durable state directly, between processes. */
export async function inspect(
  dbPath: string,
): Promise<{ orders: StoredOrder[]; charges: ProviderCharge[]; refunds: ProviderRefund[] }> {
  let db: Awaited<ReturnType<typeof openDatabase>> | null = await openDatabase(dbPath);
  const orders = await new OrderRepository(db.orders).all();
  const charges = await new PaymentProviderRepository(db.provider).all();
  const refunds = await new RefundProviderRepository(db.refundProvider).all();
  await db.close();
  db = null;
  for (let i = 0; i < 6; i += 1) {
    gc(); // TalaDB releases the file lock once its handles are collected
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { orders, charges, refunds };
}

/**
 * Real time passing while the API is down (Milestone 9.3): every stored hold and servicing
 * claim expiry moves `ms` into the past, written through the repository so the index fields
 * follow. Holds and claims expire on real time, so moving the business date (`VELASIA_TODAY`)
 * no longer ends them, and a child process's clock can't be moved from the test.
 */
export async function elapseWhileDown(dbPath: string, ms: number): Promise<void> {
  // In its own frame: no handle may outlive it, or TalaDB keeps the file locked.
  await (async () => {
    const db = await openDatabase(dbPath);
    const repository = new OrderRepository(db.orders);
    for (const order of await repository.all()) {
      await repository.replace(order, {
        ...order,
        hold: { ...order.hold, expiresAt: order.hold.expiresAt - ms },
        servicing: order.servicing.map((op) =>
          op.claim ? { ...op, claim: { ...op.claim, expiresAt: op.claim.expiresAt - ms } } : op,
        ),
      });
    }
    await db.close();
  })();
  for (let i = 0; i < 6; i += 1) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function newDb() {
  const dir = mkdtempSync(join(tmpdir(), 'velasia-crash-'));
  dirs.push(dir);
  return join(dir, 'velasia.db');
}

export async function killedBy(server: Server, request: Promise<unknown>) {
  await expect(request).rejects.toThrow(); // the connection dies with the process
  const { signal } = await server.exited;
  expect(signal).toBe('SIGKILL');
}
