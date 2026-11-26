import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createRailwayContext, preserve, project } from 'railway/iac';
import * as baseline from '../../.railway/railway.ts';
import { EXPECTED } from './expected-production.mjs';
import {
  checkCurrentState,
  definitionChanges,
  evaluate,
  servicesOf,
} from './iac-rules.mjs';

const root = resolve(import.meta.dirname, '../..');
const sdk = { createRailwayContext, project };
const observed = baseline.OBSERVED_API_ADDRESSES.map((o) => o.address);
const base = await evaluate(baseline, sdk);
const API = '@velasia/retailing-api';
const NODE = '@velasia/web';
const NEXTRS = '@velasia/web-nextrs';

const run = (definition, extra = {}) =>
  checkCurrentState(definition, {
    expected: EXPECTED,
    root,
    observed,
    intended: baseline.NEXTRS_NET_ALLOW_ADDR_INTENDED,
    ...extra,
  });
/** A copy of the baseline graph with `edit(services, definition)` applied. */
const mutate = (edit) => {
  const d = structuredClone(base);
  edit(servicesOf(d), d);
  return d;
};
const fails = (definition, pattern, extra) => {
  const { failures } = run(definition, extra);
  assert.ok(
    failures.some((f) => pattern.test(f)),
    `expected a failure matching ${pattern}; got:\n${failures.join('\n') || '(none)'}`,
  );
};

test('the reconciled file passes as current production', () => {
  const { failures, warnings } = run(base);
  assert.deepEqual(failures, []);
  // Stage 4 (applied): the live allowlist is the narrowed policy, so no 'broader' warning.
  assert.ok(!warnings.some((w) => /live allowlist .* broader/.test(w)));
  // Stage 5 (applied): both storefronts watch the same paths, so no drift warning.
  assert.ok(!warnings.some((w) => /watch patterns differ/.test(w)));
});

test('it names exactly the existing services, from main, in iad', () => {
  const s = servicesOf(base);
  assert.deepEqual(Object.keys(s).sort(), [API, NODE, NEXTRS]);
  for (const svc of Object.values(s)) {
    assert.equal(svc.source.branch, 'main');
    assert.equal(svc.source.repo, 'nextrs-sh/velasia-airways');
    assert.deepEqual(svc.deploy.multiRegionConfig, { iad: { numReplicas: 1 } });
    assert.equal(svc.deploy.limitOverride, undefined);
  }
  // Stage 1 (applied 2026-11-26): only the API mounts the volume, and it is Docker-built.
  assert.equal(s[NODE].volumeAttachments, undefined);
  assert.equal(s[NEXTRS].volumeAttachments, undefined);
  assert.deepEqual(Object.values(s[API].volumeAttachments), [
    {
      volume: 'volume.velasia-api-data',
      mountPath: '/data',
      volumeConfig: { region: 'iad', sizeMB: 500 },
    },
  ]);
  assert.equal(s[API].build.builder, 'DOCKERFILE');
  assert.equal(s[API].build.dockerfilePath, 'docker/Dockerfile.api');
  assert.equal(s[NODE].build.dockerfilePath, 'Dockerfile.node');
  assert.equal(s[NEXTRS].build.dockerfilePath, 'Dockerfile.nextrs');
});

test('renaming, removing or adding a service fails (identity is the name)', () => {
  fails(
    mutate((s, d) => {
      d.resources = d.resources.map((r) => (r.name === API ? { ...r, name: 'velasia-api' } : r));
    }),
    /service @velasia\/retailing-api is missing.*DELETE/,
  );
  fails(
    mutate((s, d) => {
      d.resources = d.resources.filter((r) => r.name !== NODE);
    }),
    /service @velasia\/web is missing/,
  );
  fails(
    mutate((s, d) => {
      d.resources.push({ ...structuredClone(s[NODE]), name: 'velasia-bench-runner' });
    }),
    /velasia-bench-runner is not in production.*CREATE/,
  );
});

test('another volume, a database, a storefront attachment or a dropped API volume fails', () => {
  fails(
    mutate((s, d) => {
      d.resources.push({ type: 'volume', address: 'volume.extra', name: 'extra' });
    }),
    /only the three existing services and the API volume are expected/,
  );
  fails(
    mutate((s, d) => {
      d.resources.push({ type: 'database', address: 'database.pg', name: 'pg' });
    }),
    /only the three existing services and the API volume are expected/,
  );
  fails(
    mutate((s) => {
      s[NODE].volumeAttachments = structuredClone(s[API].volumeAttachments);
    }),
    /@velasia\/web: no volume attachment/,
  );
  fails(
    mutate((s, d) => {
      d.resources = d.resources.flat().filter((x) => x.type !== 'volume');
      delete s[API].volumeAttachments;
    }),
    /volume velasia-api-data is live but missing here: an apply would DELETE it/,
  );
});

test('source branch, region, replicas and limits are pinned', () => {
  fails(
    mutate((s) => (s[NODE].source.branch = 'deploy/railway')),
    /branch must be main/,
  );
  fails(
    mutate(
      (s) => (s[API].deploy.multiRegionConfig = { 'asia-southeast1-eqsg3a': { numReplicas: 1 } }),
    ),
    /one replica in iad/,
  );
  fails(
    mutate((s) => (s[API].deploy.multiRegionConfig = { iad: { numReplicas: 2 } })),
    /one replica in iad/,
  );
  fails(
    mutate((s) => (s[API].replicaConfig = { min: 1, max: 3 })),
    /autoscaling/,
  );
  fails(
    mutate(
      (s) => (s[NEXTRS].deploy.limitOverride = { containers: { cpu: 1, memoryBytes: 2 ** 30 } }),
    ),
    /limitOverride/,
  );
  fails(
    mutate(
      (s) => (s[NEXTRS].deploy.limitOverride = { containers: { cpu: 1, memoryBytes: 2 ** 30 } }),
    ),
    /storefront CPU\/memory limits differ/,
  );
});

test('builds: Dockerfiles for all three (the API since stage 1)', () => {
  fails(
    mutate((s) => {
      s[API].build = { builder: 'RAILPACK', buildCommand: 'pnpm install' };
    }),
    /@velasia\/retailing-api: builder must be DOCKERFILE/,
  );
  fails(
    mutate((s) => (s[API].deploy.startCommand = 'pnpm --filter @velasia/retailing-api start')),
    /the image's own entrypoint runs/,
  );
  fails(
    mutate((s) => (s[API].build.dockerfilePath = 'Dockerfile.node')),
    /dockerfilePath must be docker\/Dockerfile.api/,
  );
  fails(
    mutate((s) => (s[NODE].build.dockerfilePath = 'Dockerfile.nextrs')),
    /dockerfilePath must be Dockerfile.node/,
  );
  fails(
    mutate((s) => (s[NEXTRS].build.builder = 'RAILPACK')),
    /builder must be DOCKERFILE/,
  );
});

test('the API never gets a public domain or TCP proxy', () => {
  fails(
    mutate(
      (s) =>
        (s[API].networking.serviceDomains = { 'api-production.up.railway.app': { port: 4010 } }),
    ),
    /no public service domain/,
  );
  fails(
    mutate((s) => (s[API].networking.tcpProxies = { 4010: {} })),
    /no TCP proxy/,
  );
  fails(
    mutate((s) => (s[API].networking.privateNetworkEndpoint = 'velasia-api')),
    /private network endpoint/,
  );
});

test('omitting a live variable fails (a managed apply would delete it)', () => {
  fails(
    mutate((s) => delete s[NODE].variables.RETAILING_API_START_TIMEOUT_MS),
    /RETAILING_API_START_TIMEOUT_MS is live but missing.*DELETE/,
  );
  fails(
    mutate((s) => delete s[API].variables.TALADB_PATH),
    /TALADB_PATH is live but missing/,
  );
});

test('pending changes are not current production', () => {
  // Stage 1's variables are live now, no longer pending.
  for (const name of [
    'NODE_ENV',
    'PORT',
    'RAILWAY_RUN_UID',
    'RAILWAY_DEPLOYMENT_DRAINING_SECONDS',
  ]) {
    assert.ok(!EXPECTED.pendingVariables.includes(name), name);
  }
  for (const name of ['VELASIA_TODAY']) {
    fails(
      mutate((s) => (s[API].variables[name] = { type: 'literal', value: 'x' })),
      new RegExp(`${name} is a pending change`),
    );
  }
  fails(
    mutate(
      (s) =>
        (s[NODE].variables.RETAILING_API_SERVICE_TOKEN = {
          type: 'sharedReference',
          name: 'RETAILING_API_SERVICE_TOKEN',
        }),
    ),
    /RETAILING_API_SERVICE_TOKEN is a pending change/,
  );
});

test('secrets are never values in the file', () => {
  fails(
    mutate(
      (s) =>
        (s[API].variables.METRICS_TOKEN = {
          type: 'literal',
          value: 'not-a-real-token-but-literal',
        }),
    ),
    /METRICS_TOKEN must be ctx.shared.METRICS_TOKEN or preserve/,
  );
  fails(
    mutate((s) => (s[API].variables.LOG_LEVEL = { type: 'literal', value: 'A'.repeat(40) })),
    /credential-shaped literal/,
  );
  fails(
    mutate((s) => (s[NODE].variables.NEXT_PUBLIC_API = { type: 'literal', value: 'x' })),
    /inlined into browser bundles/,
  );
  // preserve() is how a secret would be kept: the secret rule accepts it.
  const kept = mutate((s) => (s[API].variables.METRICS_TOKEN = preserve()));
  assert.ok(!run(kept).failures.some((f) => /must be ctx.shared/.test(f)));
});

test('storefronts reach the private API and stay equal', () => {
  fails(
    mutate(
      (s) =>
        (s[NEXTRS].variables.RETAILING_API_URL = {
          type: 'literal',
          value: 'https://api.example.com',
        }),
    ),
    /private URL/,
  );
  fails(
    mutate((s) => (s[NODE].deploy.healthcheckTimeout = 120)),
    /health checks differ/,
  );
});

test('NextRS allowlist: invalid, empty, broad or too-narrow values fail', () => {
  const allow = (value) =>
    mutate((s) => (s[NEXTRS].variables.NEXTRS_NET_ALLOW_ADDR = { type: 'literal', value }));
  fails(allow(''), /empty/);
  fails(allow('fd12::/16,not-a-cidr'), /not an IP address or CIDR/);
  fails(allow('fd12::/16,0.0.0.0/0'), /outside 10\.0\.0\.0\/8/);
  fails(allow('fd12::/16,10.0.0.0/7'), /outside 10\.0\.0\.0\/8/);
  fails(allow('fd12::/16,10.128.0.0/10'), /observed API addresses outside/);
  fails(allow('10.128.0.0/9'), /no IPv6 range/);
  fails(
    mutate((s) => (s[NEXTRS].variables.NEXTRS_NET_ALLOW_ADDR = preserve())),
    /must be a literal/,
  );
  fails(base, /intended NextRS allowlist: .*too broad/, { intended: 'fd12::/16,10.0.0.0/8' });
  // Since stage 4 the old dashboard value is no longer tolerated: it fails as too broad.
  fails(allow('fd12::/16,10.0.0.0/8'), /too broad/);
  assert.deepEqual(run(allow('fd12::/16,10.128.0.0/9')).failures, []);
});

test('stage 4 (applied): the baseline sets the narrowed allowlist as a literal', () => {
  assert.equal(baseline.NEXTRS_NET_ALLOW_ADDR_LIVE, baseline.NEXTRS_NET_ALLOW_ADDR_INTENDED);
  assert.deepEqual(servicesOf(base)[NEXTRS].variables.NEXTRS_NET_ALLOW_ADDR, {
    type: 'literal',
    value: 'fd12::/16,10.128.0.0/9',
  });
});

test('offline change detection covers deletes, creates and service updates', () => {
  const changed = mutate((s, d) => {
    delete s[API].variables.VELASIA_TAG;
    s[NODE].deploy.healthcheckTimeout = 120;
    d.resources = d.resources.filter((r) => r.name !== NEXTRS);
    d.resources.push({ type: 'volume', address: 'volume.data', name: 'data' });
  });
  const key = (c) => `${c.kind} ${c.target}`;
  assert.deepEqual(definitionChanges(base, changed).map(key).sort(), [
    'resource.create data',
    `resource.delete ${NEXTRS}`,
    `resource.update ${NODE}`,
    `variable.delete ${API}.VELASIA_TAG`,
  ]);
});
