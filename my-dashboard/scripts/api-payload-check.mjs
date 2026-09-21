/**
 * Bundles api-payload-check.entry.mjs for Node and runs it.
 * Same reasoning as render-smoke.mjs: the entry imports real app modules,
 * so it needs Vite-equivalent resolution (JSX, import.meta.env, CSS).
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'api-payload-'));
const outfile = join(outDir, 'check.cjs');

try {
  await build({
    entryPoints: [join(here, 'api-payload-check.entry.mjs')],
    bundle: true, platform: 'node', format: 'cjs', outfile,
    logLevel: 'error', jsx: 'automatic',
    loader: { '.js': 'jsx', '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
    define: {
      'import.meta.env': JSON.stringify({
        VITE_API_URL: 'http://localhost:8000', MODE: 'test', DEV: false, PROD: true,
      }),
    },
  });
  execFileSync(process.execPath, [outfile], { stdio: 'inherit' });
} catch (error) {
  if (typeof error?.status === 'number') process.exit(error.status);
  console.error(error);
  process.exit(1);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
