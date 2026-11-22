#!/usr/bin/env node
/**
 * Milestone 9: offline checks of .railway/railway.ts (no Railway account, nothing sent anywhere).
 *
 *   pnpm railway:check     (= tsc -p .railway + this script)
 *   node scripts/railway/check-iac.mjs [file]   (another authoring file, e.g. a draft)
 *
 * The Railway CLI evaluates the file with Node's type stripping and compares the result with the
 * linked environment (`railway config plan`, which needs a login). This script evaluates it the
 * same way, offline, and checks what this deployment depends on:
 *
 * - exactly the three services and one volume, from one repository and branch, built from the
 *   repository root with the intended Dockerfiles (which must exist);
 * - one replica each, one region for everything, no autoscaling, no serverless sleep;
 * - identical CPU/memory limits and environments for the two storefronts;
 * - the API private (no domain, TCP proxy or public URL), its volume at the TalaDB directory,
 *   and the guards that keep it there; storefronts reach it by its private domain;
 * - secrets only as shared-variable references, never as values, and never a Dockerfile ARG
 *   (Railway passes service variables to ARGs of the same name); no NEXT_PUBLIC_ variables;
 * - NextRS's address allowlist explicit and narrow; health check paths that exist in the code;
 * - no legacy railway.json / railway.toml anywhere (deprecated; read until 2026-12-01).
 *
 * Exit code 1 on any failure. Warnings name bootstrap values still to be filled in.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRailwayContext, project } from 'railway/iac';

const root = resolve(import.meta.dirname, '../..');
const failures = [];
const warnings = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};
const warn = (message) => warnings.push(message);
const read = (path) => readFileSync(join(root, path), 'utf8');

// --- Evaluate the authoring file as the CLI does -------------------------------------------
const file = resolve(process.argv[2] ?? join(root, '.railway/railway.ts'));
const mod = await import(pathToFileURL(file).href);
check(!mod.partial, 'railway.ts must be a whole-project file (no `partial` export).');
const definition = await mod.default(createRailwayContext({ environment: 'production' }), project);
const resources = definition.resources.flat();
const services = Object.fromEntries(
  resources.filter((r) => r.type === 'service').map((s) => [s.name, s]),
);
const volumes = resources.filter((r) => r.type === 'volume');

const API = 'velasia-api';
const STOREFRONTS = ['velasia-node', 'velasia-nextrs'];
const DOCKERFILES = {
  'velasia-api': 'docker/Dockerfile.api',
  'velasia-node': 'Dockerfile.node',
  'velasia-nextrs': 'Dockerfile.nextrs',
};
const SECRETS = ['RETAILING_API_SERVICE_TOKEN', 'METRICS_TOKEN'];

check(definition.name === 'velasia-airways', `project name is ${definition.name}`);
check(
  JSON.stringify(Object.keys(services).sort()) === JSON.stringify(Object.keys(DOCKERFILES).sort()),
  `services must be exactly ${Object.keys(DOCKERFILES).join(', ')}; found ${Object.keys(services).join(', ')}`,
);
check(
  resources.every((r) => r.type === 'service' || r.type === 'volume'),
  'only services and the API volume are expected (no databases, buckets or workers)',
);
check(volumes.length === 1, `exactly one volume expected, found ${volumes.length}`);

const literal = (svc, name) => {
  const v = svc.variables?.[name];
  return v?.type === 'literal' ? v.value : undefined;
};
const one = (values, what) => {
  const set = new Set(values.map((v) => JSON.stringify(v)));
  check(set.size === 1, `${what} differs between services: ${[...set].join(' / ')}`);
  return values[0];
};

// --- Source, build, placement --------------------------------------------------------------
const all = Object.values(services);
one(
  all.map((s) => [s.source?.type, s.source?.repo, s.source?.branch]),
  'source repository/branch',
);
check(
  all.every((s) => s.source?.type === 'github'),
  'every service builds from the GitHub repository',
);
for (const s of all) {
  const want = DOCKERFILES[s.name];
  if (!want) continue;
  check(
    !s.source?.rootDirectory,
    `${s.name}: no root directory (the build context is the repository root)`,
  );
  check(s.build?.builder === 'DOCKERFILE', `${s.name}: build.builder must be DOCKERFILE`);
  check(s.build?.dockerfilePath === want, `${s.name}: build.dockerfilePath must be ${want}`);
  check(
    literal(s, 'RAILWAY_DOCKERFILE_PATH') === want,
    `${s.name}: RAILWAY_DOCKERFILE_PATH must be ${want}`,
  );
  check(existsSync(join(root, want)), `${s.name}: ${want} does not exist`);
  check(
    !s.build?.buildCommand && !s.deploy?.startCommand,
    `${s.name}: the Dockerfile's own CMD/ENTRYPOINT must run (no build/start command override)`,
  );
  check(
    !s.deploy?.preDeployCommand,
    `${s.name}: no pre-deploy command (volumes are not mounted there)`,
  );
  const regions = Object.entries(s.deploy?.multiRegionConfig ?? {});
  check(regions.length === 1, `${s.name}: exactly one region`);
  check(regions[0]?.[1]?.numReplicas === 1, `${s.name}: exactly one replica`);
  check(
    s.deploy?.numReplicas === undefined || s.deploy.numReplicas === 1,
    `${s.name}: numReplicas must be 1`,
  );
  check(!s.replicaConfig, `${s.name}: no replica autoscaling`);
  check(s.deploy?.sleepApplication === false, `${s.name}: serverless sleep must be off`);
  check(typeof s.deploy?.healthcheckPath === 'string', `${s.name}: a deploy health check path`);
  const draining = Number(literal(s, 'RAILWAY_DEPLOYMENT_DRAINING_SECONDS'));
  check(
    draining >= 12,
    `${s.name}: RAILWAY_DEPLOYMENT_DRAINING_SECONDS (default 0 = SIGKILL at once) must exceed the app's 10 s shutdown`,
  );
  for (const name of Object.keys(s.variables ?? {})) {
    check(
      !name.startsWith('NEXT_PUBLIC_'),
      `${s.name}: ${name} would be inlined into browser bundles`,
    );
  }
}
const region = one(
  all.map((s) => Object.keys(s.deploy?.multiRegionConfig ?? {})[0]),
  'region',
);
check(
  volumes[0]?.config?.region === region,
  `the volume must be in the services' region (${region})`,
);

// --- The API: private, one TalaDB owner on the volume --------------------------------------
const api = services[API];
if (api) {
  const net = api.networking ?? {};
  check(
    !net.customDomains && !net.serviceDomains && !net.tcpProxies,
    `${API}: no public domain or TCP proxy`,
  );
  const mounts = Object.values(api.volumeAttachments ?? {});
  check(
    mounts.length === 1 && mounts[0].volume === volumes[0]?.address,
    `${API}: the volume is attached to the API`,
  );
  const mountPath = mounts[0]?.mountPath;
  const taladb = literal(api, 'TALADB_PATH') ?? '';
  check(
    taladb.startsWith(`${mountPath}/`),
    `${API}: TALADB_PATH (${taladb}) must be on the volume (${mountPath})`,
  );
  check(
    literal(api, 'TALADB_REQUIRE_VOLUME') === 'enabled',
    `${API}: TALADB_REQUIRE_VOLUME=enabled`,
  );
  check(
    literal(api, 'RAILWAY_RUN_UID') === '0',
    `${API}: RAILWAY_RUN_UID=0 (root-owned volume; the entrypoint drops to uid 1000)`,
  );
  check(
    literal(api, 'PORT') === literal(api, 'RETAILING_API_PORT'),
    `${API}: PORT (health check) must equal RETAILING_API_PORT`,
  );
  check(
    literal(api, 'RETAILING_API_HOST') === '::',
    `${API}: RETAILING_API_HOST must be :: (IPv6 private network)`,
  );
  check(api.deploy?.healthcheckPath === '/health/ready', `${API}: health check /health/ready`);
  check(
    read('apps/retailing-api/src/service-auth.ts').includes("'/health/ready'"),
    `${API}: /health/ready must stay open to unauthenticated probes`,
  );
}

// --- Storefronts: identical, reaching the private API ---------------------------------------
const NEXTRS_ONLY = ['NEXTRS_ISOLATES', 'NEXTRS_SHUTDOWN_GRACE', 'NEXTRS_NET_ALLOW_ADDR'];
const shared = (s) =>
  Object.fromEntries(
    Object.entries(s.variables ?? {}).filter(
      ([k]) => !NEXTRS_ONLY.includes(k) && k !== 'RAILWAY_DOCKERFILE_PATH',
    ),
  );
const fronts = STOREFRONTS.map((n) => services[n]).filter(Boolean);
one(fronts.map(shared), 'storefront environment');
one(
  fronts.map((s) => s.deploy?.limitOverride),
  'storefront CPU/memory limits',
);
one(
  fronts.map((s) => s.deploy?.healthcheckPath),
  'storefront health check',
);
for (const s of fronts) {
  check(
    Boolean(
      s.deploy?.limitOverride?.containers?.cpu && s.deploy.limitOverride.containers.memoryBytes,
    ),
    `${s.name}: CPU and memory limits`,
  );
  check(
    literal(s, 'RETAILING_API_URL') ===
      `http://\${{${API}.RAILWAY_PRIVATE_DOMAIN}}:\${{${API}.PORT}}`,
    `${s.name}: RETAILING_API_URL must be the API's private domain`,
  );
  check(
    /^https:\/\/\S+$/.test(literal(s, 'SITE_URL') ?? ''),
    `${s.name}: SITE_URL must be an https origin`,
  );
  check(
    !s.cdn?.enabled,
    `${s.name}: Railway CDN caching stays off (it would answer for the runtime)`,
  );
}
check(
  existsSync(join(root, 'apps/web/src/app/api/internal/health/ready/route.ts')),
  'storefront health route apps/web/src/app/api/internal/health/ready exists',
);
one(
  all.map((s) => literal(s, 'VELASIA_TODAY') ?? ''),
  'VELASIA_TODAY',
);

const nextrs = services['velasia-nextrs'];
if (nextrs) {
  check(
    literal(nextrs, 'NEXTRS_ISOLATES') === '1',
    'velasia-nextrs: one V8 isolate for the initial comparison',
  );
  const ranges = (literal(nextrs, 'NEXTRS_NET_ALLOW_ADDR') ?? '').split(/[\s,]+/).filter(Boolean);
  check(
    ranges.length > 0,
    'velasia-nextrs: NEXTRS_NET_ALLOW_ADDR must list the private network ranges',
  );
  for (const range of ranges) {
    const [addr, prefix] = range.split('/');
    const family = isIP(addr ?? '');
    const bits = prefix === undefined ? (family === 4 ? 32 : 128) : Number(prefix);
    check(family !== 0, `NEXTRS_NET_ALLOW_ADDR: ${range} is not an address or CIDR`);
    check(
      family !== 4 || bits >= 16,
      `NEXTRS_NET_ALLOW_ADDR: ${range} is wider than /16 (allow only Railway's private range)`,
    );
    check(family !== 6 || bits >= 16, `NEXTRS_NET_ALLOW_ADDR: ${range} is wider than /16`);
  }
  if (!ranges.some((r) => isIP(r.split('/')[0]) === 4)) {
    warn(
      'velasia-nextrs: no private IPv4 range yet. Dual-stack environments need it: read it from the running environment (docs/deployment/railway.md, "Private IPv4 range") and set RAILWAY_PRIVATE_IPV4 before deploying velasia-nextrs.',
    );
  }
}

// --- Secrets -------------------------------------------------------------------------------
const SECRETISH = /TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY/;
for (const s of all) {
  for (const [name, value] of Object.entries(s.variables ?? {})) {
    if (SECRETISH.test(name)) {
      check(
        value.type === 'sharedReference' || value.type === 'preserve',
        `${s.name}: ${name} must be a shared-variable reference or preserve(), never a value in the repository`,
      );
    }
  }
  for (const name of SECRETS) {
    const v = s.variables?.[name];
    check(
      v?.type === 'sharedReference' && v.name === name,
      `${s.name}: ${name} must reference the shared variable ${name}`,
    );
  }
}
for (const file of Object.values(DOCKERFILES)) {
  const args = [...read(file).matchAll(/^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)/gm)].map((m) => m[1]);
  for (const name of args) {
    check(
      !SECRETISH.test(name),
      `${file}: ARG ${name} would receive a secret service variable at build time`,
    );
  }
}
for (const file of ['Dockerfile.node', 'Dockerfile.nextrs']) {
  const text = read(file);
  check(
    /^ARG SITE_URL=/m.test(text),
    `${file}: SITE_URL must be a build argument (baked into metadata)`,
  );
  check(
    /RETAILING_API_URL=http:\/\/127\.0\.0\.1:4010/.test(text),
    `${file}: the build must use its own throwaway API, not a deployed one`,
  );
}

// --- No legacy Config as Code ---------------------------------------------------------------
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n');
const legacy = tracked.filter((f) => /(^|\/)railway\.(json|toml)$/.test(f));
check(legacy.length === 0, `legacy Config as Code files must not exist: ${legacy.join(', ')}`);
check(
  !existsSync(join(root, 'railway.json')) && !existsSync(join(root, 'railway.toml')),
  'no railway.json / railway.toml in the repository root',
);

// --- Report --------------------------------------------------------------------------------
for (const s of all) {
  const lim = s.deploy?.limitOverride?.containers;
  console.log(
    `${s.name.padEnd(15)} ${s.build?.dockerfilePath?.padEnd(22)} ${s.source?.repo}#${s.source?.branch}  ${region} x${Object.values(s.deploy?.multiRegionConfig ?? {})[0]?.numReplicas}  ` +
      `${lim?.cpu} vCPU / ${Math.round((lim?.memoryBytes ?? 0) / 2 ** 20)} MiB  health ${s.deploy?.healthcheckPath}` +
      (s.volumeAttachments ? `  volume ${Object.values(s.volumeAttachments)[0].mountPath}` : ''),
  );
}
for (const w of warnings) console.log(`WARN  ${w}`);
if (failures.length) {
  for (const f of failures) console.error(`FAIL  ${f}`);
  console.error(`\n.railway/railway.ts: ${failures.length} problem(s).`);
  process.exit(1);
}
console.log(`\n.railway/railway.ts: all checks passed (${warnings.length} warning(s)).`);
