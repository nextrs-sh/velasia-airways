#!/usr/bin/env node
/**
 * Offline checks of the Railway IaC (no Railway account, nothing sent anywhere; runs in CI).
 *
 *   pnpm railway:check                              (= tsc -p .railway + this script)
 *   node scripts/railway/check-iac.mjs [file]       another current-state file, e.g. a draft
 *
 * 1. .railway/railway.ts must describe production as it is (current-state parity, M9.2):
 *    the three existing services by name, `main`, `iad`, one replica each, the live builders
 *    (Dockerfile.node, Dockerfile.nextrs, Railpack for the API), no volume, no limit override,
 *    no public API, every live variable declared (an omitted one would be deleted), no pending
 *    change (tokens, VELASIA_TODAY, NODE_ENV, …), no secret values. Rules: iac-rules.mjs;
 *    production facts: expected-production.mjs.
 * 2. NextRS's allowlist must cover every observed API address; the INTENDED allowlist must
 *    satisfy the private-network policy (cidr.mjs).
 * 3. Each .railway/proposals/*.ts must export `expectedChanges`, differ from railway.ts by
 *    exactly those changes, and still pass every other rule.
 * 4. Dockerfiles: no secret-named ARG (Railway passes same-named service variables to ARGs),
 *    SITE_URL is a build argument, builds use their own throwaway API.
 * 5. No legacy railway.json / railway.toml.
 *
 * Whether Railway agrees is a separate, read-only release gate: `pnpm railway:plan-gate`.
 * Exit code 1 on any failure.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRailwayContext, project } from 'railway/iac';
import { APPLIED_STAGES, EXPECTED, STAGES, expectedFor } from './expected-production.mjs';
import {
  checkCurrentState,
  compareChanges,
  definitionChanges,
  evaluate,
  servicesOf,
} from './iac-rules.mjs';

const root = resolve(import.meta.dirname, '../..');
const failures = [];
const warnings = [];
const read = (path) => readFileSync(join(root, path), 'utf8');
const sdk = { createRailwayContext, project };

// --- 1–2. The current-state file -------------------------------------------------------------
const file = resolve(process.argv[2] ?? join(root, '.railway/railway.ts'));
const mod = await import(pathToFileURL(file).href);
if (mod.partial) failures.push('railway.ts must be a whole-project file (no `partial` export).');
const base = await evaluate(mod, sdk);
const observed = (mod.OBSERVED_API_ADDRESSES ?? []).map((o) => o.address);
if (observed.length === 0) failures.push('railway.ts must export OBSERVED_API_ADDRESSES');
if (mod.NEXTRS_NET_ALLOW_ADDR_LIVE !== EXPECTED.nextrsNetAllowAddrLive) {
  failures.push(
    `NEXTRS_NET_ALLOW_ADDR_LIVE (${mod.NEXTRS_NET_ALLOW_ADDR_LIVE}) must match production (${EXPECTED.nextrsNetAllowAddrLive})`,
  );
}
const current = checkCurrentState(base, {
  expected: EXPECTED,
  root,
  observed,
  intended: mod.NEXTRS_NET_ALLOW_ADDR_INTENDED,
});
failures.push(...current.failures);
warnings.push(...current.warnings);

// M9.3: railway.ts's CURRENT must say the same stages are applied as expected-production.mjs.
const flags = {
  apiPersistence: mod.CURRENT?.apiPersistence === true,
  clientTokens: mod.CURRENT?.clientTokens === true,
  apiTokenEnforcement: mod.CURRENT?.apiTokenEnforcement === true,
  deployPolicy: mod.CURRENT?.deployPolicy === true,
  nextrsAllowlist:
    mod.CURRENT?.nextrsNetAllowAddr !== undefined &&
    mod.CURRENT.nextrsNetAllowAddr === mod.NEXTRS_NET_ALLOW_ADDR_INTENDED,
};
for (const name of Object.keys(STAGES)) {
  const applied = APPLIED_STAGES.includes(name);
  if (flags[name] !== applied) {
    failures.push(
      `stage ${name}: railway.ts CURRENT says ${flags[name] ? 'applied' : 'not applied'}, expected-production.mjs APPLIED_STAGES says ${applied ? 'applied' : 'not applied'}`,
    );
  }
}

// --- 3. Proposals --------------------------------------------------------------------------
const proposalDir = join(root, '.railway/proposals');
const proposals = existsSync(proposalDir)
  ? readdirSync(proposalDir).filter((f) => f.endsWith('.ts'))
  : [];
for (const f of proposals) {
  const path = join(proposalDir, f);
  const name = relative(root, path);
  const p = await import(pathToFileURL(path).href);
  if (p.partial) failures.push(`${name}: no \`partial\` export`);
  if (!Array.isArray(p.expectedChanges) || p.expectedChanges.length === 0) {
    failures.push(`${name}: must export a non-empty expectedChanges list`);
    continue;
  }
  if (!STAGES[p.stage]) {
    failures.push(`${name}: must export \`stage\`, one of ${Object.keys(STAGES).join(', ')}`);
    continue;
  }
  if (APPLIED_STAGES.includes(p.stage)) {
    failures.push(
      `${name}: stage ${p.stage} is already applied (fold it in and delete the proposal)`,
    );
    continue;
  }
  const unmet = STAGES[p.stage].requires.filter((s) => !APPLIED_STAGES.includes(s));
  const def = await evaluate(p, sdk);
  const actual = definitionChanges(base, def);
  const { unexpected, missing } = compareChanges(actual, p.expectedChanges);
  for (const c of unexpected) failures.push(`${name}: unexpected change ${c.kind} ${c.target}`);
  for (const c of missing)
    failures.push(`${name}: expected change ${c.kind} ${c.target} is absent`);
  for (const c of actual) {
    if (c.kind === 'resource.delete') failures.push(`${name}: deletes ${c.target} (never allowed)`);
  }
  // Production once this stage is applied: the rules hold the proposal to it, nothing else.
  const staged = expectedFor([...APPLIED_STAGES, p.stage]);
  const r = checkCurrentState(def, { expected: staged, root, observed });
  for (const m of r.failures) failures.push(`${name}: ${m}`);
  const blocked = unmet.length ? `  [BLOCKED until applied: ${unmet.join(', ')}]` : '';
  console.log(
    `proposal ${name} (stage ${p.stage}): ${actual.map((c) => `${c.kind} ${c.target}`).join(', ')}${blocked}`,
  );
}

// --- 4. Dockerfiles --------------------------------------------------------------------------
const SECRETISH = /TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|CREDENTIAL/;
for (const f of ['Dockerfile.node', 'Dockerfile.nextrs', 'docker/Dockerfile.api']) {
  const args = [...read(f).matchAll(/^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)/gm)].map((m) => m[1]);
  for (const a of args) {
    if (SECRETISH.test(a)) failures.push(`${f}: ARG ${a} would receive a secret service variable`);
  }
}
for (const f of ['Dockerfile.node', 'Dockerfile.nextrs']) {
  const text = read(f);
  if (!/^ARG SITE_URL=/m.test(text)) failures.push(`${f}: SITE_URL must be a build argument`);
  if (!/RETAILING_API_URL=http:\/\/127\.0\.0\.1:4010/.test(text)) {
    failures.push(`${f}: the build must use its own throwaway API, not a deployed one`);
  }
}

// --- 5. No legacy Config as Code ----------------------------------------------------------------
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n');
const legacy = tracked.filter((f) => /(^|\/)railway\.(json|toml)$/.test(f));
if (legacy.length)
  failures.push(`legacy Config as Code files must not exist: ${legacy.join(', ')}`);

// --- Report ----------------------------------------------------------------------------------
for (const s of Object.values(servicesOf(base))) {
  const region = Object.keys(s.deploy?.multiRegionConfig ?? {})[0];
  const replicas = Object.values(s.deploy?.multiRegionConfig ?? {})[0]?.numReplicas;
  const build = s.build?.dockerfilePath ?? s.build?.builder;
  console.log(
    `${s.name.padEnd(24)} ${String(build).padEnd(18)} ${s.source?.repo}#${s.source?.branch}  ${region} x${replicas}  ` +
      `limits ${s.deploy?.limitOverride ? 'override' : 'plan default'}  health ${s.deploy?.healthcheckPath ?? 'none'}  ` +
      `${Object.keys(s.variables ?? {}).length} variables`,
  );
}
for (const w of warnings) console.log(`WARN  ${w}`);
if (failures.length) {
  for (const f of failures) console.error(`FAIL  ${f}`);
  console.error(`\nRailway IaC: ${failures.length} problem(s).`);
  process.exit(1);
}
console.log(
  `\nRailway IaC: all checks passed (${proposals.length} proposal(s), ${warnings.length} warning(s)).`,
);
