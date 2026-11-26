/**
 * M9.2: offline rules for .railway/railway.ts (current-state parity) and for the proposal files
 * in .railway/proposals/ (each a reviewed, bounded change on top of it).
 *
 * Pure functions over the evaluated IaC graph (what `defineRailway(...)` returns), so the tests
 * can feed them modified graphs. scripts/railway/check-iac.mjs runs them on the real files.
 *
 * Current-state parity (`checkCurrentState`) means: the file says what production is, nothing
 * more. Future desired changes (a volume, tokens, a pinned clock, a Docker-built API, explicit
 * CPU/memory limits) fail here on purpose; they belong in a proposal with its own plan.
 *
 * M9.3: "production" is `expectedFor(stages)` (expected-production.mjs): the M9.2 facts plus
 * the applied stages, and for a proposal also its own stage. A stage can make a volume, the
 * API's Docker build and health check, token references or `checkSuites` expected; anything a
 * stage does not name still fails.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addressesOutside, allowlistProblems } from './cidr.mjs';

const SECRETISH_NAME = /TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|CREDENTIAL/;
/** A literal value shaped like a credential: long unbroken key material, or a PEM/bearer prefix. */
const SECRETISH_VALUE = /^[A-Za-z0-9+/_=-]{32,}$|-----BEGIN|^Bearer\s|^sk_|^ghp_|^xox[abp]-/;

/** Evaluate an authoring module the way the Railway CLI does (whole-project mode). */
export async function evaluate(mod, { createRailwayContext, project }) {
  const definition = await mod.default(
    createRailwayContext({ environment: 'production' }),
    project,
  );
  return definition;
}

export function servicesOf(definition) {
  const resources = (definition?.resources ?? []).flat();
  return Object.fromEntries(resources.filter((r) => r.type === 'service').map((s) => [s.name, s]));
}

const literal = (svc, name) => {
  const v = svc?.variables?.[name];
  return v?.type === 'literal' ? v.value : undefined;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Rules for the current-state file.
 *
 * @param definition  evaluated graph
 * @param options.expected       scripts/railway/expected-production.mjs EXPECTED
 * @param options.root           repository root (Dockerfiles, health routes)
 * @param options.observed       addresses the API was observed at
 * @param options.intended       the intended NextRS allowlist (must satisfy the policy)
 * @param options.allowedTargets `service.VAR` targets a proposal may change (proposal mode)
 * @returns {{ failures: string[], warnings: string[] }}
 */
export function checkCurrentState(definition, options) {
  const { expected, root, observed = [], intended, allowedTargets = new Set() } = options;
  const failures = [];
  const warnings = [];
  const check = (ok, message) => {
    if (!ok) failures.push(message);
  };
  const read = (path) => readFileSync(join(root, path), 'utf8');

  check(
    definition?.name === expected.project,
    `project name is ${definition?.name}, not ${expected.project}`,
  );
  const resources = (definition?.resources ?? []).flat();
  const services = servicesOf(definition);
  const names = Object.keys(services).sort();
  const wanted = Object.keys(expected.services).sort();

  // --- Identity: exactly the existing services (no additions, removals or renames) ----------
  for (const name of wanted) {
    check(
      name in services,
      `service ${name} is missing: a whole-project apply would DELETE the live service`,
    );
  }
  for (const name of names) {
    check(
      name in expected.services,
      `service ${name} is not in production: an apply would CREATE it (renames are create + delete)`,
    );
  }
  const volumes = expected.volumes ?? [];
  for (const r of resources) {
    if (r.type === 'service') continue;
    const want = r.type === 'volume' ? volumes.find((v) => v.name === r.name) : undefined;
    check(
      Boolean(want),
      `${r.address ?? r.type}: only the three existing services${volumes.length ? ' and the API volume' : ''} are expected (production has no ${r.type} ${r.name ?? ''})`,
    );
    if (want) {
      check(
        r.config?.region === want.region && r.config?.sizeMB === want.sizeMB,
        `volume ${r.name}: must be ${want.sizeMB} MB in ${want.region} (found ${r.config?.sizeMB} MB in ${r.config?.region})`,
      );
    }
  }
  for (const v of volumes) {
    check(
      resources.some((r) => r.type === 'volume' && r.name === v.name),
      `volume ${v.name} is live but missing here: an apply would DELETE it, and the TalaDB data with it`,
    );
  }

  // --- Per service: source, placement, build ----------------------------------------------
  for (const [name, want] of Object.entries(expected.services)) {
    const s = services[name];
    if (!s) continue;
    check(s.source?.type === 'github', `${name}: source must be the GitHub repository`);
    check(s.source?.repo === expected.repo, `${name}: repository must be ${expected.repo}`);
    check(
      s.source?.branch === expected.branch,
      `${name}: deployment branch must be ${expected.branch} (found ${s.source?.branch})`,
    );
    check(!s.source?.rootDirectory, `${name}: no root directory (the repository root builds)`);
    check(
      same(s.deploy?.multiRegionConfig, { [expected.region]: { numReplicas: 1 } }),
      `${name}: exactly one replica in ${expected.region} (found ${JSON.stringify(s.deploy?.multiRegionConfig)})`,
    );
    check(
      s.deploy?.numReplicas === undefined || s.deploy.numReplicas === 1,
      `${name}: numReplicas must be 1`,
    );
    check(!s.replicaConfig, `${name}: no replica autoscaling`);
    check(s.deploy?.sleepApplication !== true, `${name}: serverless sleep must stay off`);
    check(!s.deploy?.preDeployCommand, `${name}: no pre-deploy command`);
    check(
      s.deploy?.limitOverride === undefined || s.deploy.limitOverride === null,
      `${name}: no CPU/memory limitOverride (production uses the plan default; an override is a change)`,
    );
    const attachments = Object.values(s.volumeAttachments ?? {});
    if (want.volume) {
      const v = volumes.find((x) => x.name === want.volume);
      check(
        attachments.length === 1 &&
          attachments[0].volume === `volume.${want.volume}` &&
          attachments[0].mountPath === v?.mountPath,
        `${name}: must mount exactly volume ${want.volume} at ${v?.mountPath} (found ${JSON.stringify(attachments)})`,
      );
    } else {
      check(
        attachments.length === 0,
        volumes.length
          ? `${name}: no volume attachment (only the API mounts ${volumes.map((v) => v.name).join(', ')})`
          : `${name}: no volume attachment (production has no volume; attaching one is the TalaDB migration)`,
      );
    }
    check(
      (s.source?.checkSuites ?? false) === (expected.checkSuites ?? false),
      `${name}: checkSuites (wait for CI) must be ${expected.checkSuites ?? false} (found ${s.source?.checkSuites ?? false})`,
    );
    if (want.role === 'api') {
      check(
        (s.deploy?.healthcheckPath ?? null) === (want.healthcheck ?? null),
        `${name}: deploy health check must be ${want.healthcheck ?? 'none'} (found ${s.deploy?.healthcheckPath ?? 'none'})`,
      );
    }
    for (const [variable, value] of Object.entries(want.literals ?? {})) {
      check(
        literal(s, variable) === value,
        `${name}: ${variable} must be ${value} (found ${literal(s, variable) ?? 'not a literal'})`,
      );
    }
    check(
      s.networking?.privateNetworkEndpoint === want.privateNetworkEndpoint,
      `${name}: private network endpoint must stay ${want.privateNetworkEndpoint}`,
    );
    check(
      !s.networking?.customDomains || Object.keys(s.networking.customDomains).length === 0,
      `${name}: no custom domain (none in production)`,
    );
    check(
      !s.networking?.tcpProxies || Object.keys(s.networking.tcpProxies).length === 0,
      `${name}: no TCP proxy`,
    );
    check(s.build?.builder === want.builder, `${name}: builder must be ${want.builder}`);
    if (want.builder === 'DOCKERFILE') {
      check(
        s.build?.dockerfilePath === want.dockerfilePath,
        `${name}: dockerfilePath must be ${want.dockerfilePath}`,
      );
      check(
        existsSync(join(root, want.dockerfilePath)),
        `${name}: ${want.dockerfilePath} is missing`,
      );
      check(
        literal(s, 'RAILWAY_DOCKERFILE_PATH') === want.dockerfilePath,
        `${name}: RAILWAY_DOCKERFILE_PATH must be ${want.dockerfilePath}`,
      );
      check(!s.build?.buildCommand, `${name}: the Dockerfile builds (no build command)`);
      check(!s.deploy?.startCommand, `${name}: the image's own entrypoint runs (no start command)`);
    } else {
      check(!s.build?.dockerfilePath, `${name}: a Railpack build has no dockerfilePath`);
      check(
        s.build?.buildCommand === want.buildCommand,
        `${name}: build command must stay \`${want.buildCommand}\``,
      );
      check(
        s.deploy?.startCommand === want.startCommand,
        `${name}: start command must stay \`${want.startCommand}\``,
      );
    }

    // Variables: exactly the live set, so an apply neither deletes nor adds one.
    const declared = Object.keys(s.variables ?? {});
    for (const v of want.variables) {
      if (allowedTargets.has(`${name}.${v}`)) continue;
      check(
        declared.includes(v),
        `${name}: variable ${v} is live but missing here: a managed apply would DELETE it (keep it, or preserve())`,
      );
    }
    for (const v of declared) {
      if (allowedTargets.has(`${name}.${v}`)) continue;
      check(
        want.variables.includes(v),
        expected.pendingVariables.includes(v)
          ? `${name}: ${v} is a pending change (needs its own rollout), not current production`
          : `${name}: variable ${v} is not in production: an apply would add it`,
      );
    }
    for (const v of want.staleVariables ?? []) {
      if (declared.includes(v)) {
        warnings.push(`${name}: ${v} is a known-stale value kept for parity (cleanup is pending)`);
      }
    }
  }

  // --- The API stays private -----------------------------------------------------------------
  const apiName = Object.keys(expected.services).find((n) => expected.services[n].role === 'api');
  const api = services[apiName];
  if (api) {
    const net = api.networking ?? {};
    check(
      !net.serviceDomains || Object.keys(net.serviceDomains).length === 0,
      `${apiName}: no public service domain (the API is reachable on the private network only)`,
    );
    check(!api.domains?.length && !api.tcp?.length, `${apiName}: no public domain or TCP port`);
    check(
      literal(api, 'RETAILING_API_HOST') === '::',
      `${apiName}: RETAILING_API_HOST must stay :: (dual-stack private network)`,
    );
    check(
      literal(api, 'RETAILING_API_PORT') === '4010',
      `${apiName}: RETAILING_API_PORT must stay 4010 (the storefronts' private URL uses it)`,
    );
    if (existsSync(join(root, 'apps/retailing-api/src/service-auth.ts'))) {
      check(
        read('apps/retailing-api/src/service-auth.ts').includes("'/health/ready'"),
        `${apiName}: /health/ready must stay open to unauthenticated probes`,
      );
    }
  }

  // --- Storefronts: equal, on the private API -------------------------------------------------
  const fronts = Object.keys(expected.services)
    .filter((n) => expected.services[n].role === 'storefront')
    .map((n) => services[n])
    .filter(Boolean);
  const sharedEnv = (s) =>
    Object.fromEntries(
      Object.entries(s.variables ?? {}).filter(
        ([k]) =>
          !expected.perRuntimeVariables.includes(k) &&
          !expected.inertStorefrontVariables.includes(k),
      ),
    );
  if (fronts.length === 2) {
    const [a, b] = fronts;
    check(
      same(sharedEnv(a), sharedEnv(b)),
      `storefront environments differ: ${JSON.stringify(sharedEnv(a))} / ${JSON.stringify(sharedEnv(b))}`,
    );
    check(
      same(a.deploy?.limitOverride ?? null, b.deploy?.limitOverride ?? null),
      'storefront CPU/memory limits differ',
    );
    check(
      a.deploy?.healthcheckPath === b.deploy?.healthcheckPath &&
        a.deploy?.healthcheckTimeout === b.deploy?.healthcheckTimeout,
      'storefront health checks differ',
    );
    for (const k of expected.inertStorefrontVariables) {
      const on = fronts.filter((s) => s.variables?.[k]).map((s) => s.name);
      if (on.length === 1) {
        warnings.push(`${k} is set on ${on[0]} only (verified inert at runtime; kept for parity)`);
      }
    }
    if (!same(a.build?.watchPatterns ?? [], b.build?.watchPatterns ?? [])) {
      const message = `storefront watch patterns differ (${JSON.stringify(a.build?.watchPatterns ?? [])} / ${JSON.stringify(b.build?.watchPatterns ?? [])}): an autodeploy can rebuild one runtime and not the other`;
      if (expected.sameStorefrontWatchPatterns) failures.push(message);
      else warnings.push(message);
    }
  }
  for (const s of fronts) {
    check(
      s.deploy?.healthcheckPath === expected.storefrontHealthcheck,
      `${s.name}: deploy health check must be ${expected.storefrontHealthcheck}`,
    );
    check(
      literal(s, 'RETAILING_API_URL') === expected.apiPrivateUrl,
      `${s.name}: RETAILING_API_URL must be the API's private URL ${expected.apiPrivateUrl}`,
    );
    check(
      /^https:\/\/[a-z0-9.-]+$/.test(literal(s, 'SITE_URL') ?? ''),
      `${s.name}: SITE_URL must be an https origin`,
    );
    check(!s.cdn?.enabled, `${s.name}: Railway CDN stays off`);
  }
  check(
    existsSync(join(root, 'apps/web/src/app/api/internal/health/ready/route.ts')),
    'the storefront health route apps/web/src/app/api/internal/health/ready exists',
  );

  // --- NextRS private-network policy ----------------------------------------------------------
  const nextrs = services['@velasia/web-nextrs'];
  if (nextrs) {
    const allow = literal(nextrs, 'NEXTRS_NET_ALLOW_ADDR');
    check(
      typeof allow === 'string',
      '@velasia/web-nextrs: NEXTRS_NET_ALLOW_ADDR must be a literal (the policy is reviewed in code)',
    );
    const problems = allowlistProblems(allow ?? '');
    if (problems.length && allow === expected.nextrsNetAllowAddrLive) {
      warnings.push(
        `@velasia/web-nextrs: the live allowlist ${allow} is broader than the policy (${problems.join('; ')}); narrowing is .railway/proposals/nextrs-allowlist.ts`,
      );
    } else {
      for (const p of problems) failures.push(`@velasia/web-nextrs: NEXTRS_NET_ALLOW_ADDR: ${p}`);
    }
    const outside = addressesOutside(allow ?? '', observed);
    check(
      outside.length === 0,
      `@velasia/web-nextrs: observed API addresses outside NEXTRS_NET_ALLOW_ADDR (NextRS would refuse the API): ${outside.join(', ')}`,
    );
  }
  if (intended !== undefined) {
    for (const p of allowlistProblems(intended)) failures.push(`intended NextRS allowlist: ${p}`);
    const outside = addressesOutside(intended, observed);
    check(
      outside.length === 0,
      `intended NextRS allowlist misses observed API addresses: ${outside.join(', ')}`,
    );
  }

  // --- Secrets ----------------------------------------------------------------------------------
  for (const s of Object.values(services)) {
    for (const [name, value] of Object.entries(s.variables ?? {})) {
      if (SECRETISH_NAME.test(name)) {
        check(
          value?.type === 'sharedReference' || value?.type === 'preserve',
          `${s.name}: ${name} must be ctx.shared.${name} or preserve(), never a value in the repository`,
        );
      }
      if (value?.type === 'literal' && typeof value.value === 'string') {
        check(
          !SECRETISH_VALUE.test(value.value),
          `${s.name}: ${name} has a credential-shaped literal value; secrets never go in this file`,
        );
      }
      check(
        !name.startsWith('NEXT_PUBLIC_'),
        `${s.name}: ${name} would be inlined into browser bundles`,
      );
    }
  }
  return { failures, warnings };
}

/**
 * The changes from `base` to `proposal`, in the plan's vocabulary (kind + target), computed
 * offline from the two evaluated graphs.
 */
export function definitionChanges(base, proposal) {
  const a = servicesOf(base);
  const b = servicesOf(proposal);
  const changes = [];
  for (const name of Object.keys(a)) {
    if (!(name in b)) changes.push({ kind: 'resource.delete', target: name });
  }
  for (const name of Object.keys(b)) {
    if (!(name in a)) {
      changes.push({ kind: 'resource.create', target: name });
      continue;
    }
    const { variables: va = {}, ...ra } = a[name];
    const { variables: vb = {}, ...rb } = b[name];
    if (!same(ra, rb)) changes.push({ kind: 'resource.update', target: name });
    for (const v of Object.keys(va)) {
      if (!(v in vb)) changes.push({ kind: 'variable.delete', target: `${name}.${v}` });
    }
    for (const v of Object.keys(vb)) {
      if (!same(va[v], vb[v])) changes.push({ kind: 'variable.set', target: `${name}.${v}` });
    }
  }
  // By name, as the plan's summaries name them ("Create volume velasia-api-data").
  const others = (d) =>
    (d?.resources ?? [])
      .flat()
      .filter((r) => r.type !== 'service')
      .map((r) => r.name ?? r.address);
  for (const addr of others(proposal)) {
    if (!others(base).includes(addr)) changes.push({ kind: 'resource.create', target: addr });
  }
  for (const addr of others(base)) {
    if (!others(proposal).includes(addr)) changes.push({ kind: 'resource.delete', target: addr });
  }
  return changes;
}

/** Changes not in `expected` and expected changes not present (both are failures). */
export function compareChanges(actual, expected) {
  const key = (c) => `${c.kind} ${c.target}`;
  const want = new Set(expected.map(key));
  const have = new Set(actual.map(key));
  return {
    unexpected: actual.filter((c) => !want.has(key(c))),
    missing: expected.filter((c) => !have.has(key(c))),
  };
}
