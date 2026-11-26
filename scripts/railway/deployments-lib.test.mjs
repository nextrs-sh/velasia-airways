/*
 * M9.3: deployment parity checks on synthetic `railway status --json` documents (the shape of
 * CLI 5.75.0's output, with made-up IDs and digests).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SERVICES,
  deploymentsFile,
  parityProblems,
  snapshotFromStatus,
} from './deployments-lib.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

function instance(name, o = {}) {
  const id = o.id ?? `dep-${name}`;
  const status = o.status ?? 'SUCCESS';
  return {
    node: {
      serviceName: name,
      latestDeployment: {
        id,
        status,
        createdAt: '2026-11-26T04:00:00Z',
        meta: {
          branch: 'main',
          commitHash: o.commit ?? SHA,
          imageDigest: o.digest ?? `sha256:${name.length}`.padEnd(71, '0'),
          serviceManifest: {
            deploy: { multiRegionConfig: o.regions ?? { iad: { numReplicas: 1 } } },
          },
        },
      },
      activeDeployments: o.active ?? [{ id, status }],
    },
  };
}
function status(overrides = {}) {
  return {
    name: 'velasia-airways',
    environments: {
      edges: [
        {
          node: {
            name: 'production',
            serviceInstances: {
              edges: Object.values(SERVICES)
                .filter((n) => overrides[n] !== null)
                .map((n) => instance(n, overrides[n])),
            },
          },
        },
      ],
    },
  };
}
const problems = (s, options) => parityProblems(snapshotFromStatus(s), options);
const has = (list, pattern) =>
  assert.ok(
    list.some((p) => pattern.test(p)),
    `expected ${pattern}; got:\n${list.join('\n') || '(none)'}`,
  );

test('equal, settled deployments are comparable', () => {
  assert.deepEqual(problems(status()), []);
  assert.deepEqual(problems(status(), { expectSha: SHA.slice(0, 7) }), []);
});

test('storefronts on different commits are refused (revision mismatch)', () => {
  const p = problems(status({ [SERVICES.nextrs]: { commit: OTHER } }));
  has(p, /storefronts run different commits: Node\.js aaaaaaa, NextRS bbbbbbb/);
  // The API may run an older commit (its watch patterns skip storefront-only changes).
  assert.deepEqual(problems(status({ [SERVICES.api]: { commit: OTHER } })), []);
});

test('a storefront not on the approved release commit is refused', () => {
  has(problems(status(), { expectSha: OTHER }), /not the approved bbbbbbb/);
});

test('deployments in progress, failed or overlapping are refused', () => {
  has(
    problems(
      status({ [SERVICES.node]: { status: 'BUILDING', active: [{ id: 'x', status: 'SUCCESS' }] } }),
    ),
    /@velasia\/web: latest deployment is BUILDING/,
  );
  has(
    problems(
      status({
        [SERVICES.nextrs]: {
          active: [
            { id: 'dep-@velasia/web-nextrs', status: 'SUCCESS' },
            { id: 'new', status: 'DEPLOYING' },
          ],
        },
      }),
    ),
    /deployment in progress \(DEPLOYING\)/,
  );
  has(
    problems(status({ [SERVICES.api]: { active: [{ id: 'older', status: 'SUCCESS' }] } })),
    /the active deployment is not the latest one/,
  );
  has(problems(status({ [SERVICES.api]: { status: 'FAILED' } })), /latest deployment is FAILED/);
});

test('region, replica and missing-service problems are refused', () => {
  has(
    problems(status({ [SERVICES.node]: { regions: { sin: { numReplicas: 1 } } } })),
    /expected only iad/,
  );
  has(
    problems(status({ [SERVICES.nextrs]: { regions: { iad: { numReplicas: 2 } } } })),
    /2 replicas/,
  );
  has(
    problems(status({ [SERVICES.api]: null })),
    /retailing-api \(api\) is not in the environment/,
  );
  has(problems({}), /is not in the environment/);
});

test('a deployment that changed between two snapshots of a series is refused', () => {
  const before = snapshotFromStatus(status());
  assert.deepEqual(parityProblems(snapshotFromStatus(status()), { previous: before }), []);
  const redeployed = snapshotFromStatus(status({ [SERVICES.nextrs]: { id: 'dep-new' } }));
  has(parityProblems(redeployed, { previous: before }), /web-nextrs: the deployment changed/);
  const rebuilt = snapshotFromStatus(status({ [SERVICES.node]: { digest: 'sha256:other' } }));
  has(parityProblems(rebuilt, { previous: before }), /@velasia\/web: the deployment changed/);
});

test('the DEPLOYMENTS file has what pair.mjs requires, and refuses missing limits', () => {
  const file = deploymentsFile(snapshotFromStatus(status()), {
    cpu: 2,
    memoryBytes: 1073741824,
    nextrsVersion: '0.1.0-rc.2',
    recordedAt: '2026-11-26T00:00:00Z',
  });
  assert.equal(file.services['velasia-node'].commit, SHA);
  assert.equal(file.services['velasia-nextrs'].region, 'iad');
  assert.equal(file.services['velasia-api'].replicas, 1);
  assert.throws(() => deploymentsFile(snapshotFromStatus(status()), { nextrsVersion: 'x' }), /cpu/);
});
