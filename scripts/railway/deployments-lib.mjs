/**
 * M9.3: deployment parity, as pure functions over `railway status --json` (CLI 5.75.0).
 *
 * A benchmark compares two storefronts, so it is only fair while both run the same commit, in
 * the same region, with one replica each, and nothing is being (re)deployed. GitHub autodeploy
 * and independent watch patterns can break that silently: before M9.3's deploy-policy stage a
 * change outside apps/web/ redeployed NextRS and not Node.js. These checks read what Railway is
 * actually running, fail closed on anything missing, and compare two snapshots taken before and
 * after a series ("nothing changed in between").
 */

export const SERVICES = {
  api: '@velasia/retailing-api',
  node: '@velasia/web',
  nextrs: '@velasia/web-nextrs',
};
const DONE = 'SUCCESS';

/** The facts the checks need, per service, from `railway status --json`. */
export function snapshotFromStatus(status, { environment = 'production' } = {}) {
  const env = (status?.environments?.edges ?? [])
    .map((e) => e.node)
    .find((e) => e?.name === environment);
  const services = {};
  for (const edge of env?.serviceInstances?.edges ?? []) {
    const n = edge.node;
    const d = n.latestDeployment ?? null;
    const regions = d?.meta?.serviceManifest?.deploy?.multiRegionConfig ?? null;
    services[n.serviceName] = {
      deploymentId: d?.id ?? null,
      status: d?.status ?? null,
      commit: d?.meta?.commitHash ?? null,
      branch: d?.meta?.branch ?? null,
      imageDigest: d?.meta?.imageDigest ?? null,
      createdAt: d?.createdAt ?? null,
      regions: regions ? Object.keys(regions) : null,
      replicas: regions
        ? Object.values(regions).reduce((sum, r) => sum + (r?.numReplicas ?? 0), 0)
        : null,
      /** Deployments Railway runs now; more than one SUCCESS means an overlap or a rollout. */
      active: (n.activeDeployments ?? []).map((a) => ({ id: a.id, status: a.status })),
    };
  }
  return { project: status?.name ?? null, environment, services };
}

/**
 * Why this snapshot is not a comparable pair of storefronts (empty list = comparable).
 *
 * @param options.expectSha   the approved release commit: both storefronts must run it
 * @param options.region      the one region every service must run in
 * @param options.previous    an earlier snapshot of the same series: nothing may have changed
 */
export function parityProblems(snapshot, { expectSha, region = 'iad', previous } = {}) {
  const problems = [];
  const s = snapshot?.services ?? {};
  for (const [role, name] of Object.entries(SERVICES)) {
    const svc = s[name];
    if (!svc) {
      problems.push(`${name} (${role}) is not in the environment`);
      continue;
    }
    for (const key of ['deploymentId', 'commit', 'imageDigest']) {
      if (typeof svc[key] !== 'string' || !svc[key]) problems.push(`${name}: ${key} unknown`);
    }
    if (svc.status !== DONE)
      problems.push(`${name}: latest deployment is ${svc.status ?? 'unknown'}, not ${DONE}`);
    const notDone = svc.active.filter((a) => a.status !== DONE);
    if (notDone.length) {
      problems.push(`${name}: deployment in progress (${notDone.map((a) => a.status).join(', ')})`);
    }
    if (svc.active.length !== 1) {
      problems.push(`${name}: ${svc.active.length} active deployments (expected exactly 1)`);
    } else if (svc.active[0].id !== svc.deploymentId) {
      problems.push(
        `${name}: the active deployment is not the latest one (a newer one failed or is pending)`,
      );
    }
    if (!svc.regions || svc.regions.length !== 1 || svc.regions[0] !== region) {
      problems.push(`${name}: regions ${JSON.stringify(svc.regions)}, expected only ${region}`);
    }
    if (svc.replicas !== 1) problems.push(`${name}: ${svc.replicas ?? '?'} replicas, expected 1`);
  }
  const node = s[SERVICES.node];
  const nextrs = s[SERVICES.nextrs];
  if (node?.commit && nextrs?.commit && node.commit !== nextrs.commit) {
    problems.push(
      `storefronts run different commits: Node.js ${node.commit.slice(0, 7)}, NextRS ${nextrs.commit.slice(0, 7)}`,
    );
  }
  if (expectSha !== undefined) {
    for (const svc of [node, nextrs]) {
      if (svc?.commit && !svc.commit.startsWith(expectSha)) {
        const name = svc === node ? SERVICES.node : SERVICES.nextrs;
        problems.push(
          `${name} runs ${svc.commit.slice(0, 7)}, not the approved ${expectSha.slice(0, 7)}`,
        );
      }
    }
  }
  if (previous) {
    for (const name of Object.values(SERVICES)) {
      const a = previous.services?.[name];
      const b = s[name];
      if (!a || !b) continue;
      if (a.deploymentId !== b.deploymentId || a.imageDigest !== b.imageDigest) {
        problems.push(`${name}: the deployment changed since the previous snapshot`);
      }
    }
  }
  return problems;
}

/**
 * The DEPLOYMENTS file pair.mjs requires (benchmarks/railway/deployments.example.json), from a
 * snapshot that passed `parityProblems`. CPU and memory are the plan's limits, which Railway's
 * status does not report: the operator passes them (`railway metrics` / dashboard).
 */
export function deploymentsFile(
  snapshot,
  { cpu, memoryBytes, apiMemoryBytes, nextrsVersion, recordedAt },
) {
  if (!(cpu > 0) || !(memoryBytes > 0)) throw new Error('cpu and memoryBytes are required');
  if (!nextrsVersion) throw new Error('nextrsVersion is required');
  const entry = (name, mem) => {
    const svc = snapshot.services[name];
    return {
      deploymentId: svc.deploymentId,
      commit: svc.commit,
      region: svc.regions?.[0] ?? null,
      replicas: svc.replicas,
      cpu,
      memoryBytes: mem,
      status: svc.status,
      imageDigest: svc.imageDigest,
    };
  };
  return {
    recordedAt,
    recordedBy: 'pnpm railway:deployments (railway status --json)',
    nextrsVersion,
    services: {
      'velasia-node': entry(SERVICES.node, memoryBytes),
      'velasia-nextrs': entry(SERVICES.nextrs, memoryBytes),
      'velasia-api': entry(SERVICES.api, apiMemoryBytes ?? memoryBytes),
    },
  };
}
