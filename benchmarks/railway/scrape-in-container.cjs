/*
 * Runs INSIDE the retailing-API container, read from stdin, so nothing has to be copied into
 * the image and nothing has to be quoted through a remote shell:
 *
 *   docker exec -i velasia-api node - < benchmarks/railway/scrape-in-container.cjs
 *
 * It times GATE_PROBES (default 5) sequential GETs of /v1/airline against 127.0.0.1, prints each
 * as a `# velasia_gate_probe_ms <ms>` comment line, then prints the API's /metrics text. The
 * tokens come from the container's own environment (RETAILING_API_SERVICE_TOKEN, METRICS_TOKEN)
 * and are never printed. Used as `api-gate.mjs --metrics-cmd`.
 */
'use strict';

const base = `http://127.0.0.1:${process.env.PORT || 4010}`;
const headers = {};
if (process.env.RETAILING_API_SERVICE_TOKEN) {
  headers['x-velasia-service-token'] = process.env.RETAILING_API_SERVICE_TOKEN;
}
if (process.env.METRICS_TOKEN) headers.authorization = `Bearer ${process.env.METRICS_TOKEN}`;

(async () => {
  const lines = [];
  const probes = Number(process.env.GATE_PROBES ?? 5);
  for (let i = 0; i < probes; i++) {
    const started = performance.now();
    const response = await fetch(`${base}/v1/airline`, { headers });
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`probe: HTTP ${response.status}`);
    lines.push(`# velasia_gate_probe_ms ${(performance.now() - started).toFixed(3)}`);
  }
  const response = await fetch(`${base}/metrics`, { headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`metrics: HTTP ${response.status}`);
  process.stdout.write(`${lines.join('\n')}\n${text}`);
})().catch((error) => {
  process.stderr.write(`scrape-in-container: ${error.message}\n`);
  process.exit(1);
});
