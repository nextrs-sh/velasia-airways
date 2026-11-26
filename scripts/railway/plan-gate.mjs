#!/usr/bin/env node
/**
 * M9.2: read-only Railway release gate. Runs the offline checks, then `railway config plan
 * --json --detailed-exit-code` (never apply, never --yes / --confirm-destructive /
 * --show-values / --decrypt-variables), and fails unless the plan is exactly what the file
 * says it should be:
 *
 *   .railway/railway.ts                 no changes at all (strict no-op baseline)
 *   .railway/proposals/<name>.ts        exactly its `expectedChanges`, nothing else
 *
 * Usage:
 *   pnpm railway:plan-gate [--file .railway/proposals/nextrs-allowlist.ts]
 *                          [--plan-json saved-plan.json]   evaluate a saved plan instead
 *                          [--linked-dir <dir>]            run `railway` from a linked directory
 *                          [--environment production] [--out-dir .railway/evidence/<date>]
 *
 * Railway access: `railway login` plus a linked directory (`railway link -p <project> -e
 * production`, local state only), or a project token in RAILWAY_TOKEN. Not part of ordinary PR
 * CI (it needs production credentials); a separately authorized, read-only release step.
 *
 * Exit: 0 pass · 1 gate failure (including offline-check failures) · 3 plan unavailable.
 * --out-dir writes plan.sanitized.json and plan-gate.md (no IDs, no values); `.railway/*` is
 * gitignored, so .railway/evidence/ stays private.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { EXPECTED } from './expected-production.mjs';
import { evaluatePlan, planArgs, sanitizePlan, summarize } from './plan-gate-lib.mjs';

const root = resolve(import.meta.dirname, '../..');
const { values } = parseArgs({
  options: {
    file: { type: 'string', default: '.railway/railway.ts' },
    'plan-json': { type: 'string' },
    'linked-dir': { type: 'string' },
    environment: { type: 'string', default: EXPECTED.environment },
    'out-dir': { type: 'string' },
    'skip-offline': { type: 'boolean', default: false },
  },
});
const file = resolve(root, values.file);
const shown = relative(root, file);

// 1. The offline checks first (same as CI): a file that fails them is never planned.
if (!values['skip-offline']) {
  try {
    execFileSync(process.execPath, [join(root, 'scripts/railway/check-iac.mjs')], {
      cwd: root,
      stdio: 'inherit',
    });
  } catch {
    console.error('plan gate: offline checks failed; not planning.');
    process.exit(1);
  }
}

// 2. The plan.
let plan;
if (values['plan-json']) {
  plan = JSON.parse(readFileSync(resolve(values['plan-json']), 'utf8'));
} else {
  // railway/iac (3.17.0) checks the CLI version by running `$_ --version`, where `_` is the
  // program the parent shell last started (here: node). Point it at the railway binary.
  const which = spawnSync('sh', ['-c', 'command -v railway'], { encoding: 'utf8' });
  const railway = which.status === 0 ? which.stdout.trim() : 'railway';
  const run = spawnSync(railway, planArgs({ file, environment: values.environment }), {
    cwd: values['linked-dir'] ? resolve(values['linked-dir']) : root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, _: railway },
  });
  if (run.error || (run.status !== 0 && run.status !== 2)) {
    console.error(
      `plan gate: \`railway config plan\` failed (exit ${run.status ?? run.error?.code}). Log in and link a directory, or set RAILWAY_TOKEN.`,
    );
    if (run.stderr) console.error(run.stderr.trim().split('\n').slice(-5).join('\n'));
    process.exit(3);
  }
  try {
    plan = JSON.parse(run.stdout);
  } catch {
    console.error('plan gate: the plan output is not JSON.');
    process.exit(3);
  }
}

// 3. Expected changes: none for the baseline; a proposal lists its own.
const mod = await import(pathToFileURL(file).href);
const expectedChanges = mod.expectedChanges ?? [];
const result = evaluatePlan(plan, { expected: EXPECTED, expectedChanges });
const sanitized = sanitizePlan(plan);
const report = summarize({ file: shown, result, sanitized, generatedAt: new Date().toISOString() });
console.log(`\n${report}`);

if (values['out-dir']) {
  const dir = resolve(root, values['out-dir']);
  mkdirSync(dir, { recursive: true });
  const base = shown.replace(/^\.railway\//, '').replace(/[^A-Za-z0-9.-]+/g, '_');
  writeFileSync(
    join(dir, `${base}.plan.sanitized.json`),
    `${JSON.stringify(sanitized, null, 2)}\n`,
  );
  writeFileSync(join(dir, `${base}.plan-gate.md`), `${report}\n`);
  console.log(
    `plan gate: wrote ${relative(root, dir)}/${base}.plan.sanitized.json and ${base}.plan-gate.md`,
  );
}
process.exit(result.ok ? 0 : 1);
