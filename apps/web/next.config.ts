import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV !== 'production';

/*
 * Milestone 7: Content Security Policy.
 *
 * Everything the storefront loads is first-party: scripts and CSS from `/_next/static`, fonts
 * self-hosted by `next/font` at build time, images from `/_next/image` and `/images`. No third
 * party is allowed anywhere.
 *
 * `script-src` keeps `'unsafe-inline'`: Next.js streams inline bootstrap and RSC payload scripts
 * (`self.__next_f.push(…)`), and the alternative — a per-request nonce — forces every page to
 * render at request time, which would disable the static shells and Partial Prerendering this
 * app is built on. The other directives still block third-party scripts, plugins, framing,
 * `<base>` hijacking, and form posts to other origins. See docs/SECURITY.md.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self'${isDev ? ' ws: wss:' : ''}`,
  "manifest-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  // nginx must not buffer streamed HTML/RSC (Suspense, Partial Prerendering).
  { key: 'X-Accel-Buffering', value: 'no' },
  // HSTS is set by the TLS-terminating proxy (docker/proxy/), never on plain HTTP.
];

const nextConfig: NextConfig = {
  // Cache Components: `use cache` + `cacheLife` for public content, Partial
  // Prerendering for routes that mix a static shell with request-time data.
  cacheComponents: true,
  partialPrefetching: true,
  typedRoutes: true,
  poweredByHeader: false,
  // Milestone 8: gzip in the Next.js server (Next's default, on). `VELASIA_NEXT_COMPRESS=disabled`
  // at build time turns it off, for both runtimes (NextRS 0.1.0-rc.2 reads the same switch), e.g.
  // behind a CDN that compresses. See docs/deployment/runtime-parity-report.md.
  compress: process.env.VELASIA_NEXT_COMPRESS !== 'disabled',
  reactStrictMode: true,
  // Milestone 7: a self-contained server (`.next/standalone`) for the production image. It is
  // the same Next.js server as `next start` (same Cache Components, Server Actions, image
  // optimisation); tracing starts at the monorepo root so workspace packages are included.
  output: 'standalone',
  outputFileTracingRoot: join(dirname(fileURLToPath(import.meta.url)), '../..'),
  // Version-skew protection across rolling deploys: set per build (docker/Dockerfile.web).
  deploymentId: process.env.VELASIA_DEPLOYMENT_ID || undefined,
  // Internal workspace packages ship TypeScript source.
  transpilePackages: ['@velasia/contracts', '@velasia/ui', '@velasia/observability'],
  experimental: {
    // Booking forms are a few KB; refuse anything larger early (default 1 MB).
    serverActions: { bodySizeLimit: '128kb' },
    // Revalidated pages stay in the server's in-memory cache instead of being written into
    // `.next/server/app`, so the production container's application files can be read-only.
    // Prerendered pages are still read from the build output; only `.next/cache` (optimised
    // images, fetch cache) needs to be writable. See docs/DEPLOYMENT.md.
    isrFlushToDisk: false,
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  // US spelling of the first booking step, and the short checkout URL.
  async redirects() {
    return [
      { source: '/booking/travelers', destination: '/booking/travellers', permanent: true },
      { source: '/checkout', destination: '/booking/checkout', permanent: false },
    ];
  },
  images: {
    // All imagery is local (public/images); trim variants to what layouts use.
    deviceSizes: [640, 828, 1080, 1280, 1600, 1920],
    imageSizes: [128, 256, 384],
    qualities: [70, 80],
  },
};

export default nextConfig;
