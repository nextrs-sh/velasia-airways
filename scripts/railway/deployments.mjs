#!/usr/bin/env node
/**
 * M9.3: read-only deployment parity check (docs/deployment/M9.3-DEPLOYMENT-PARITY.md).
 *
 *   pnpm railway:deployments [--linked-dir <dir>] [--status-json saved.json]
 *                            [--expect-sha <approved commit>]
 *                            [--save snapshot.json] [--compare earlier-snapshot.json]
 *                            [--deployments-out deployments.json --cpu 2 --memory-bytes 1073741824]
 *
 * Runs `railway status --json` (read-only) unless --status-json is given, then fails unless:
 * all three services have one active, successful deployment and nothing in progress; both
 * storefronts run the same commit (and the approved one, with --expect-sha); every service is
 * in iad with one replica; and, with --compare, no deployment changed since that snapshot.
 *
 * --save writes the snapshot (deployment IDs and commits: keep it in a gitignored place such as
 * .railway/evidence/). --deployments-out writes the DEPLOYMENTS file pair.mjs requires.
 * Exit: 0 parity · 1 parity problems · 3 status unavailable.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { deploymentsFile, parityProblems, snapshotFromStatus } from './deployments-lib.mjs';

const root = resolve(import.meta.dirname, '../..');
const { values } = parseArgs({
  options: {
    'linked-dir': { type: 'string' },
    'status-json': { type: 'string' },
    environment: { type: 'string', default: 'production' },
    'expect-sha': { type: 'string' },
    save: { type: 'string' },
    compare: { type: 'string' },
    'deployments-out': { type: 'string' },
    cpu: { type: 'string' },
    'memory-bytes': { type: 'string' },
    'api-memory-bytes': { type: 'string' },
  },
});

let status;
if (values['status-json']) {
  status = JSON.parse(readFileSync(resolve(values['status-json']), 'utf8'));
} else {
  const run = spawnSync('railway', ['status', '--json'], {
    cwd: values['linked-dir'] ? resolve(values['linked-dir']) : root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error || run.status !== 0) {
    console.error(
      'deployments: `railway status --json` failed (log in and link a directory, or pass --status-json).',
    );
    process.exit(3);
  }
  status = JSON.parse(run.stdout);
}

const snapshot = { takenAt: new Date().toISOString(), ...snapshotFromStatus(status, values) };
const previous = values.compare
  ? JSON.parse(readFileSync(resolve(values.compare), 'utf8'))
  : undefined;
const problems = parityProblems(snapshot, { expectSha: values['expect-sha'], previous });

for (const [name, s] of Object.entries(snapshot.services)) {
  console.log(
    `${name.padEnd(24)} ${String(s.status).padEnd(8)} ${String(s.commit).slice(0, 7)}  ${JSON.stringify(s.regions)} x${s.replicas}  ` +
      `image ${String(s.imageDigest).slice(7, 19)}  active ${s.active.length}  since ${s.createdAt}`,
  );
}
if (values.save)
  writeFileSync(resolve(values.save), `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });

if (values['deployments-out']) {
  if (problems.length) {
    console.error('deployments: not writing a DEPLOYMENTS file for a non-comparable environment.');
  } else {
    const pin = JSON.parse(readFileSync(resolve(root, 'docker/nextrs/package.json'), 'utf8'));
    const file = deploymentsFile(snapshot, {
      cpu: Number(values.cpu),
      memoryBytes: Number(values['memory-bytes']),
      apiMemoryBytes: values['api-memory-bytes'] ? Number(values['api-memory-bytes']) : undefined,
      nextrsVersion: pin.dependencies['@nextrs/cli'],
      recordedAt: snapshot.takenAt,
    });
    writeFileSync(resolve(values['deployments-out']), `${JSON.stringify(file, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(`deployments: wrote ${values['deployments-out']}`);
  }
}

if (problems.length) {
  for (const p of problems) console.error(`FAIL  ${p}`);
  console.error(`\ndeployment parity: ${problems.length} problem(s).`);
  process.exit(1);
}
console.log(
  '\ndeployment parity: OK (same storefront commit, one successful deployment each, iad, 1 replica).',
);
