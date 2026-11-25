#!/usr/bin/env node
/**
 * Summarize paired runs: every `pair.json` under a results directory becomes a row. Comparable
 * pairs go in the comparison tables and charts. Every other pair is listed with its
 * classification and reason, and never enters a comparison.
 *
 *   node benchmarks/railway/summarize.mjs <results-dir> <out-dir> [--label "local rehearsal"]
 *
 * Writes <out-dir>/summary.md, summary.csv, latency-p95.svg, latency-p99.svg and throughput.svg.
 * Every number comes from the k6 summaries and gate files that pair.mjs saved. Nothing is
 * estimated, and a missing value prints as "–".
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { label: { type: 'string', default: 'results' } },
});
const [root, outDir] = positionals;
if (!root || !outDir) {
  process.stderr.write('usage: summarize.mjs <results-dir> <out-dir> [--label text]\n');
  process.exit(1);
}

function* pairFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* pairFiles(path);
    else if (name === 'pair.json') yield path;
  }
}

const pairs = [...pairFiles(root)]
  .map((file) => ({ file, ...JSON.parse(readFileSync(file, 'utf8')) }))
  .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
if (pairs.length === 0) {
  process.stderr.write(`summarize: no pair.json under ${root}\n`);
  process.exit(1);
}

const f = (v, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : '–');
const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)} %` : '–');
const mib = (v) => (Number.isFinite(v) ? (v / 2 ** 20).toFixed(0) : '–');

const rows = [];
for (const p of pairs) {
  for (const runtime of ['node', 'nextrs']) {
    const run = p.runs?.[runtime];
    const k = run?.k6;
    rows.push({
      scenario: p.scenario,
      round: p.round,
      position: p.order.indexOf(runtime) + 1,
      runtime,
      classification: p.classification ?? (p.comparable ? 'comparable' : 'stopped'),
      rate: p.config?.rate || null,
      requests: k?.requests,
      rps: k?.requestsPerSecond,
      p50: k?.durationMs?.med,
      p95: k?.durationMs?.p95,
      p99: k?.durationMs?.p99,
      ttfbP95: k?.ttfbMs?.p95,
      failed: k?.failed,
      status5xx: k?.status?.['5xx'],
      status429: k?.status?.[429],
      dropped: k?.droppedIterations,
      compressed: k?.compressed,
      bytesReceived: k?.bytesReceived,
      k6CpuPeak: run?.cpu?.peakCores,
      apiProbeP50Peak: run?.gate?.peaks?.probeP50Ms,
      apiCpuPeak: run?.gate?.peaks?.cpuCores,
      apiRssPeak: run?.gate?.peaks?.rssBytes,
      apiRequests: run?.gate?.totals?.requests,
      offersCreated: run?.gate?.totals?.offersCreated,
      reason: p.stopped?.reason ?? '',
    });
  }
}

const comparable = rows.filter((r) => r.classification === 'comparable');
const other = pairs.filter((p) => !p.comparable);

const md = [
  `# Paired runs: ${values.label}`,
  '',
  `Generated ${new Date().toISOString()} from ${pairs.length} pair.json files under \`${root}\`.`,
  'Only comparable pairs are compared. Latency is in ms, as k6 measures it from the load',
  'generator, so it includes the network to the storefront. "API" columns come from the shared',
  "API's own metrics during the run (gate). Resource use of the storefronts themselves is not",
  'in these files: Railway service metrics are recorded separately.',
  '',
  '## Comparable pairs',
  '',
];
if (comparable.length === 0) md.push('_None._', '');
else {
  md.push(
    '| Workload | Round | Runtime (position) | Offered /s | Requests | Req/s | p50 | p95 | p99 | TTFB p95 | Failed | Compressed | k6 CPU peak | API CPU peak | API probe p50 peak | API requests |',
    '| -------- | ----- | ------------------ | ---------- | -------- | ----- | --- | --- | --- | -------- | ------ | ---------- | ----------- | ------------ | ------------------ | ------------ |',
  );
  for (const r of comparable) {
    md.push(
      `| ${r.scenario} | ${r.round} | ${r.runtime} (${r.position}) | ${r.rate ?? 'closed'} | ${r.requests ?? '–'} | ${f(r.rps)} | ${f(r.p50)} | ${f(r.p95)} | ${f(r.p99)} | ${f(r.ttfbP95)} | ${pct(r.failed)} | ${pct(r.compressed)} | ${f(r.k6CpuPeak, 2)} | ${f(r.apiCpuPeak, 3)} | ${f(r.apiProbeP50Peak)} | ${r.apiRequests ?? '–'} |`,
    );
  }
  md.push('');
}
md.push('## Stopped or not comparable', '');
if (other.length === 0) md.push('_None._', '');
else {
  md.push(
    '| Workload | Round | Order | Classification | Step | Reason |',
    '| --- | --- | --- | --- | --- | --- |',
  );
  for (const p of other) {
    md.push(
      `| ${p.scenario} | ${p.round} | ${p.order.join(' → ')} | ${p.classification} | ${p.stopped?.step ?? '–'} | ${(p.stopped?.reason ?? (p.problems ?? []).join('; ')).replaceAll('|', '\\|')} |`,
    );
  }
  md.push('');
}
md.push(
  '## Files',
  '',
  ...pairs.map((p) => `- \`${relative(root, p.file)}\`: ${p.classification}`),
  '',
);

const headers = Object.keys(rows[0]);
const csv = [
  headers.join(','),
  ...rows.map((r) => headers.map((h) => JSON.stringify(r[h] ?? '')).join(',')),
].join('\n');

/** A grouped bar chart (one group per workload/round, one bar per runtime), as plain SVG. */
function chart(title, unit, key) {
  const groups = [...new Set(comparable.map((r) => `${r.scenario} r${r.round}`))];
  const colors = { node: '#2f6f9f', nextrs: '#c2702a' };
  const max = Math.max(1, ...comparable.map((r) => r[key]).filter(Number.isFinite));
  const width = 120 + groups.length * 110;
  const height = 320;
  const plot = { x: 70, y: 40, h: 220 };
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="system-ui, sans-serif" font-size="12">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<text x="${plot.x}" y="22" font-size="14" font-weight="600">${title} (${unit}) — ${values.label}, measured</text>`,
    `<line x1="${plot.x}" y1="${plot.y + plot.h}" x2="${width - 20}" y2="${plot.y + plot.h}" stroke="#888"/>`,
    `<text x="${plot.x - 8}" y="${plot.y + 4}" text-anchor="end">${f(max)}</text>`,
    `<text x="${plot.x - 8}" y="${plot.y + plot.h}" text-anchor="end">0</text>`,
  ];
  groups.forEach((group, i) => {
    const gx = plot.x + 20 + i * 110;
    ['node', 'nextrs'].forEach((runtime, j) => {
      const r = comparable.find(
        (x) => `${x.scenario} r${x.round}` === group && x.runtime === runtime,
      );
      const v = r?.[key];
      if (!Number.isFinite(v)) return;
      const h = (v / max) * plot.h;
      const x = gx + j * 40;
      parts.push(
        `<rect x="${x}" y="${plot.y + plot.h - h}" width="34" height="${h}" fill="${colors[runtime]}"/>`,
        `<text x="${x + 17}" y="${plot.y + plot.h - h - 4}" text-anchor="middle">${f(v)}</text>`,
      );
    });
    parts.push(
      `<text x="${gx + 37}" y="${plot.y + plot.h + 18}" text-anchor="middle">${group}</text>`,
    );
  });
  parts.push(
    `<rect x="${plot.x}" y="${height - 30}" width="12" height="12" fill="${colors.node}"/><text x="${plot.x + 16}" y="${height - 20}">Node.js</text>`,
    `<rect x="${plot.x + 90}" y="${height - 30}" width="12" height="12" fill="${colors.nextrs}"/><text x="${plot.x + 106}" y="${height - 20}">NextRS</text>`,
    '</svg>',
  );
  return parts.join('\n');
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'summary.md'), `${md.join('\n')}\n`);
writeFileSync(join(outDir, 'summary.csv'), `${csv}\n`);
if (comparable.length) {
  writeFileSync(join(outDir, 'latency-p95.svg'), chart('p95 latency', 'ms', 'p95'));
  writeFileSync(join(outDir, 'latency-p99.svg'), chart('p99 latency', 'ms', 'p99'));
  writeFileSync(join(outDir, 'throughput.svg'), chart('Throughput', 'req/s', 'rps'));
}
console.log(
  `${pairs.length} pairs (${comparable.length / 2} comparable) → ${join(outDir, 'summary.md')}`,
);
