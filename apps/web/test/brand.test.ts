// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { airline } from '@velasia/contracts';
import { describe, expect, it } from 'vitest';
import { pageMetadata } from '@/lib/metadata';
import { footerNav, site } from '@/lib/site';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const publicDir = path.join(repoRoot, 'apps/web/public');

describe('storefront identity', () => {
  it('derives every brand string from the shared airline config', () => {
    expect(site.name).toBe(airline.name);
    expect(site.shortName).toBe(airline.shortName);
    expect(site.tagline).toBe('Beyond every horizon.');
    expect(site.disclaimer).toBe(airline.disclaimer);
    expect(footerNav.map((group) => group.title)).toContain('Velasia');
  });

  it('uses the agreed default title and description', () => {
    expect(site.title).toBe('Velasia Airways | Beyond Every Horizon');
    expect(site.description).toBe(
      'Explore destinations and discover your next journey with Velasia Airways, a fictional modern airline retailing experience.',
    );
  });
});

describe('pageMetadata', () => {
  it('keeps the canonical path and the brand social card', () => {
    const metadata = pageMetadata({ title: 'Help centre', description: 'Help.', path: '/help' });
    expect(metadata.alternates).toEqual({ canonical: '/help' });
    expect(metadata.openGraph).toMatchObject({
      siteName: 'Velasia Airways',
      title: 'Help centre | Velasia Airways',
      url: '/help',
      images: [site.brand.socialPreview],
    });
    expect(metadata.twitter).toMatchObject({
      card: 'summary_large_image',
      images: [site.brand.socialPreview],
    });
  });

  it('lets a page supply its own social image and title', () => {
    const image = { url: '/images/destinations/cebu.jpg', alt: 'Cebu' };
    const metadata = pageMetadata({
      title: 'Cebu',
      description: 'Islands.',
      socialTitle: 'Cebu with Velasia Airways',
      image,
    });
    expect(metadata.alternates).toBeUndefined();
    expect(metadata.openGraph).toMatchObject({
      title: 'Cebu with Velasia Airways',
      images: [image],
    });
  });
});

describe('brand assets', () => {
  const svgs = [
    'velasia-symbol.svg',
    'velasia-logo.svg',
    'velasia-logo-light.svg',
    'velasia-logo-dark.svg',
    'velasia-wordmark.svg',
    'velasia-favicon.svg',
  ];

  it.each(svgs)('%s is a small, self-contained, titled SVG', (file) => {
    const svg = readFileSync(path.join(publicDir, 'brand', file), 'utf8');
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="[\d. ]+"/);
    expect(svg).toContain('<title>Velasia Airways</title>');
    expect(svg).not.toMatch(/<image|<script|<text|href=|@import|url\(/);
    expect(svg.length).toBeLessThan(8_000);
  });

  function pngSize(file: string) {
    const png = readFileSync(path.join(publicDir, file));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), bytes: png.length };
  }

  it('ships a valid 1200×630 social preview under 200 KB', () => {
    const { width, height, bytes } = pngSize(site.brand.socialPreview.url);
    expect({ width, height }).toEqual({ width: 1200, height: 630 });
    expect(bytes).toBeLessThan(200_000);
  });

  it('ships valid square app icons', () => {
    expect(pngSize(site.brand.appleTouchIcon)).toMatchObject({ width: 180, height: 180 });
    expect(pngSize(site.brand.icon512)).toMatchObject({ width: 512, height: 512 });
  });
});

/*
 * Guard against the retired AeroNova identity creeping back in. Every match must be listed here
 * with the reason it is kept; see docs/MILESTONE-2.5-REBRANDING.md.
 */
const LEGACY_BRAND = /aero\s*-?\s*nova/i;
const ALLOWED: { file: string; pattern: RegExp; why: string }[] = [
  {
    file: '.env.example',
    pattern: /INVENTORY_SEED=aeronova/,
    why: 'stable seed',
  },
  {
    file: '.env.production.example',
    pattern: /INVENTORY_SEED=aeronova/,
    why: 'stable seed (Milestone 7 production template)',
  },
  { file: 'apps/retailing-api/src/app.ts', pattern: /seed: 'aeronova'/, why: 'stable seed' },
  {
    file: 'apps/retailing-api/src/config.ts',
    pattern: /default\('aeronova'\)/,
    why: 'stable seed',
  },
  { file: 'apps/retailing-api/test/helpers.ts', pattern: /'aeronova'/, why: 'stable seed' },
  {
    file: 'apps/retailing-api/test/flights-api.test.ts',
    pattern: /'aeronova'/,
    why: 'stable seed',
  },
  {
    file: '.railway/railway.ts',
    pattern: /^const INVENTORY_SEED = 'aeronova';$/,
    why: 'stable seed (Milestone 9 Railway configuration)',
  },
  { file: 'apps/web/test/brand.test.ts', pattern: /./, why: 'this guard' },
];

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', 'apps', 'packages', 'tests', '*.*'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((file) => /\.(ts|tsx|mjs|js|json|css|svg|ya?ml|example)$/.test(file))
    .filter((file) => file !== 'pnpm-lock.yaml');
}

describe('legacy brand guard', () => {
  it('has no unexplained AeroNova references in source, config, or tests', () => {
    const offenders: string[] = [];
    for (const file of trackedFiles()) {
      const lines = readFileSync(path.join(repoRoot, file), 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!LEGACY_BRAND.test(line)) return;
        const allowed = ALLOWED.some((entry) => entry.file === file && entry.pattern.test(line));
        if (!allowed) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('uses no retired `ember-*` colour tokens (they would silently render unstyled)', () => {
    const offenders = trackedFiles()
      .filter((file) => /\.(tsx?|css)$/.test(file) && file !== 'apps/web/test/brand.test.ts')
      .filter((file) =>
        /\bember-\d{2,3}\b|tone="ember"/.test(readFileSync(path.join(repoRoot, file), 'utf8')),
      );
    expect(offenders).toEqual([]);
  });
});
