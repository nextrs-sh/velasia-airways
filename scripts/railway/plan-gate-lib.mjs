/**
 * M9.2: the read-only Railway release gate, as pure functions over `railway config plan --json`.
 *
 * The CLI's JSON (CLI 5.75.0) carries a structured change set:
 *   changeSet.changes[] = { summary, severity: 'safe' | 'destructive', kind, details }
 * with the kinds seen against this project: resource.create, resource.delete, resource.update,
 * variable.set, variable.delete. The gate reads those fields, never the human-readable text,
 * and fails closed: an unknown kind, an unknown severity, or a malformed plan is a failure.
 *
 * Rules (`evaluatePlan`):
 *   - the plan is for the expected project and environment, and variables are managed (else
 *     variable drift would be invisible);
 *   - a production service is never deleted (no exception exists);
 *   - every change must be listed in `expectedChanges` (kind + target): a create, an update of
 *     service settings, and any variable change are failures otherwise;
 *   - a `resource.update` must also stay within its entry's `fields` (M9.3): an update of the
 *     right service that touches another setting (region, replicas, limits, …) fails, and an
 *     entry without `fields` accepts no update at all;
 *   - a destructive change also needs `allowDestructive: true` on its expected entry;
 *   - every expected change must be present (a proposal that no longer matches is stale);
 *   - independently of the change list, the desired graph must keep every current service and
 *     every current volume, declare exactly the volumes production is expected to have (none
 *     before M9.3 stage 1; `expected.volumes`), attach them only where expected, and give the API
 *     no public domain.
 */

export const KNOWN_KINDS = new Set([
  'resource.create',
  'resource.delete',
  'resource.update',
  'variable.set',
  'variable.delete',
]);
export const KNOWN_SEVERITIES = new Set(['safe', 'destructive']);

/** Flags the gate must never pass to `railway config plan` (they confirm, decrypt or reveal). */
export const FORBIDDEN_FLAGS = [
  '--yes',
  '--confirm-destructive',
  '--show-values',
  '--decrypt-variables',
  '--plan',
];

/** argv for the read-only plan the gate runs. */
export function planArgs({ file, environment }) {
  const args = ['config', 'plan', '--file', file, '--json', '--detailed-exit-code'];
  if (environment) args.push('--environment', environment);
  for (const f of FORBIDDEN_FLAGS) if (args.includes(f)) throw new Error(`refusing ${f}`);
  return args;
}

/**
 * The target a change summary names: `svc.VAR` for variable changes, the resource name for
 * resource changes ("Create service X", "Delete volume X", "Update X field, field").
 */
export function changeTarget(change) {
  const s = String(change?.summary ?? '');
  let m;
  if ((m = /^(?:Update|Set|Create|Delete) variable (\S+)/.exec(s))) return m[1];
  if ((m = /^(?:Create|Delete) (?:service|volume|database|bucket|function) (\S+)/.exec(s)))
    return m[1];
  if ((m = /^Update (\S+)/.exec(s))) return m[1];
  return null;
}

/**
 * The settings a `resource.update` summary names ("Update X build.builder, deploy.startCommand"):
 * the plan JSON carries no structured details for updates, so this is the only field list.
 * Null when the summary has none (the gate then fails closed).
 */
export function changeFields(change) {
  const m = /^Update \S+ (.+)$/.exec(String(change?.summary ?? ''));
  if (!m) return null;
  return m[1]
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
}

/** The resource kind a create/delete summary names (service, volume, …), if any. */
function resourceType(change) {
  const m = /^(?:Create|Delete) (service|volume|database|bucket|function) /.exec(
    String(change?.summary ?? ''),
  );
  return m?.[1] ?? null;
}

/**
 * @param plan                  parsed `railway config plan --json`
 * @param options.expected      EXPECTED (scripts/railway/expected-production.mjs)
 * @param options.expectedChanges  [{ kind, target, allowDestructive? }] (proposal files)
 * @returns {{ ok: boolean, problems: string[], warnings: string[], changes: object[], counts: object }}
 */
export function evaluatePlan(plan, { expected, expectedChanges = [] }) {
  const problems = [];
  const warnings = [];
  const fail = (m) => problems.push(m);

  if (!plan || typeof plan !== 'object') {
    return { ok: false, problems: ['no plan JSON'], warnings, changes: [], counts: {} };
  }
  if (plan.ok !== true) fail('the plan did not succeed (ok !== true)');
  if (plan.command !== 'plan') fail(`not a plan (command: ${plan.command})`);
  if (plan.applyResult || plan.deploymentId || plan.stagedPatchId) {
    fail('the output carries an apply/staged result: only a plain plan is accepted');
  }
  const env = plan.currentEnvironment ?? {};
  if (env.projectName !== expected.project) {
    fail(`project is ${env.projectName}, expected ${expected.project}`);
  }
  if (env.environmentName !== expected.environment) {
    fail(`environment is ${env.environmentName}, expected ${expected.environment}`);
  }
  if (plan.variablePolicy?.managed !== true) {
    fail('variables are not managed: variable drift would not show in the plan');
  }
  for (const d of plan.diagnostics ?? []) {
    const text = typeof d === 'string' ? d : JSON.stringify(d);
    if (/error/i.test(d?.severity ?? d?.level ?? '')) fail(`diagnostic: ${text}`);
    else warnings.push(`diagnostic: ${text}`);
  }

  const raw = plan.changeSet?.changes;
  if (!Array.isArray(raw)) {
    fail('changeSet.changes is missing');
    return { ok: false, problems, warnings, changes: [], counts: {} };
  }
  const productionServices = new Set(Object.keys(expected.services));
  const key = (c) => `${c.kind} ${c.target}`;
  const wanted = new Map(expectedChanges.map((c) => [key(c), c]));
  const seen = new Set();
  const changes = raw.map((c) => ({
    kind: c.kind,
    severity: c.severity,
    target: changeTarget(c),
    summary: c.summary,
  }));

  for (const c of changes) {
    if (!KNOWN_KINDS.has(c.kind)) fail(`unknown change kind ${c.kind}: ${c.summary}`);
    if (!KNOWN_SEVERITIES.has(c.severity)) fail(`unknown severity ${c.severity}: ${c.summary}`);
    if (c.target === null) fail(`cannot tell what this change targets: ${c.summary}`);
    if (c.kind === 'resource.delete' && productionServices.has(c.target)) {
      fail(`DESTROYS production service ${c.target}`);
      continue;
    }
    const want = wanted.get(key(c));
    if (!want) {
      const what =
        c.kind === 'resource.create'
          ? `unexpected new ${resourceType(c) ?? 'resource'}`
          : c.kind === 'resource.update'
            ? 'unexpected service configuration change'
            : c.kind === 'resource.delete'
              ? 'unexpected deletion'
              : 'unexpected variable change';
      fail(`${what}: ${c.summary}`);
      continue;
    }
    if (c.kind === 'resource.update') {
      const fields = changeFields(c);
      const allowed = new Set(want.fields ?? []);
      if (!fields || fields.length === 0) {
        fail(`cannot tell which settings this update changes: ${c.summary}`);
        continue;
      }
      const extra = fields.filter((f) => !allowed.has(f));
      if (extra.length) {
        fail(`update of ${c.target} changes settings outside the proposal: ${extra.join(', ')}`);
        continue;
      }
    }
    seen.add(key(c));
    if (c.severity === 'destructive' && want.allowDestructive !== true) {
      fail(`destructive change not acknowledged (allowDestructive): ${c.summary}`);
    }
  }
  for (const [k] of wanted) {
    if (!seen.has(k)) fail(`expected change is not in the plan (stale proposal?): ${k}`);
  }

  // Graph-level checks, independent of how the change set is worded.
  const names = (g, type) =>
    (g?.resources ?? []).filter((r) => !type || r.type === type).map((r) => r.name);
  if (plan.currentGraph && plan.desiredGraph) {
    const desired = new Set(names(plan.desiredGraph, 'service'));
    for (const n of names(plan.currentGraph, 'service')) {
      if (!desired.has(n)) fail(`desired graph drops live service ${n} (deletion or replacement)`);
    }
    const wantedVolumes = expected.volumes ?? [];
    const desiredVolumes = new Set(names(plan.desiredGraph, 'volume'));
    for (const n of names(plan.currentGraph, 'volume')) {
      if (!desiredVolumes.has(n))
        fail(`desired graph drops live volume ${n} (its data would be deleted)`);
    }
    for (const r of plan.desiredGraph.resources ?? []) {
      if (r.type === 'volume') {
        const want = wantedVolumes.find((v) => v.name === r.name);
        if (!want) fail(`desired graph declares unexpected volume ${r.name}`);
        else if (
          (r.config?.region !== undefined && r.config.region !== want.region) ||
          (r.config?.sizeMB !== undefined && r.config.sizeMB !== want.sizeMB)
        ) {
          fail(
            `desired graph changes volume ${r.name} (expected ${want.sizeMB} MB in ${want.region})`,
          );
        }
      }
      const attached = Object.values(r.volumeAttachments ?? {});
      if (attached.length) {
        const wantVolume = expected.services[r.name]?.volume;
        const mount = wantedVolumes.find((v) => v.name === wantVolume)?.mountPath;
        const ok =
          wantVolume &&
          attached.length === 1 &&
          String(attached[0].volume ?? '').replace(/^volume\./, '') === wantVolume &&
          (attached[0].mountPath === undefined || attached[0].mountPath === mount);
        if (!ok) fail(`desired graph attaches an unexpected volume to ${r.name}`);
      }
      const role = expected.services[r.name]?.role;
      if (role === 'api' && Object.keys(r.networking?.serviceDomains ?? {}).length) {
        fail(`desired graph gives the API ${r.name} a public domain`);
      }
    }
  } else {
    warnings.push('plan JSON has no current/desired graph: graph-level checks skipped');
  }

  const counts = {
    total: changes.length,
    create: changes.filter((c) => c.kind === 'resource.create').length,
    update: changes.filter((c) => c.kind === 'resource.update' || c.kind === 'variable.set').length,
    delete: changes.filter((c) => c.kind.endsWith('.delete')).length,
    destructive: changes.filter((c) => c.severity === 'destructive').length,
  };
  return { ok: problems.length === 0, problems, warnings, changes, counts };
}

/**
 * A copy of the plan safe to keep and share: no project/environment IDs, no etag, no graphs,
 * no variable values (only names), no staged/apply fields.
 */
export function sanitizePlan(plan) {
  const env = plan?.currentEnvironment ?? {};
  return {
    command: plan?.command,
    ok: plan?.ok,
    projectName: env.projectName,
    environmentName: env.environmentName,
    variablePolicy: plan?.variablePolicy
      ? { managed: plan.variablePolicy.managed, default: plan.variablePolicy.default }
      : undefined,
    changes: (plan?.changeSet?.changes ?? []).map((c) => ({
      kind: c.kind,
      severity: c.severity,
      summary: c.summary,
      // Variable details can carry values when a plan was made with --show-values: drop them.
      details: String(c.kind).startsWith('variable.') ? undefined : (c.details ?? undefined),
    })),
    diagnostics: plan?.diagnostics ?? [],
    services: (plan?.currentGraph?.resources ?? [])
      .filter((r) => r.type === 'service')
      .map((r) => r.name),
  };
}

/** Human-readable summary (Markdown) of a gate result. */
export function summarize({ file, result, sanitized, generatedAt }) {
  const lines = [
    `# Railway plan gate: ${result.ok ? 'PASS' : 'FAIL'}`,
    '',
    `- File: \`${file}\``,
    `- Project / environment: ${sanitized.projectName} / ${sanitized.environmentName}`,
    `- Generated: ${generatedAt}`,
    `- Variables managed: ${sanitized.variablePolicy?.managed}`,
    `- Changes: ${result.counts.total ?? 0} (create ${result.counts.create ?? 0}, update ${result.counts.update ?? 0}, delete ${result.counts.delete ?? 0}, destructive ${result.counts.destructive ?? 0})`,
    '',
  ];
  if (result.changes.length) {
    lines.push('| Kind | Severity | Change |', '| --- | --- | --- |');
    for (const c of result.changes) lines.push(`| ${c.kind} | ${c.severity} | ${c.summary} |`);
    lines.push('');
  } else {
    lines.push('No changes: the file matches the environment.', '');
  }
  if (result.problems.length) {
    lines.push('## Problems', '', ...result.problems.map((p) => `- ${p}`), '');
  }
  if (result.warnings.length) {
    lines.push('## Warnings', '', ...result.warnings.map((w) => `- ${w}`), '');
  }
  return lines.join('\n');
}
