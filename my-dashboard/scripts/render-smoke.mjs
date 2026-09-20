/**
 * Bundles render-smoke.entry.jsx for Node and runs it.
 *
 * Needs a bundle step because the entry pulls in the real app modules:
 * JSX, `import.meta.env`, and CSS imports all have to be resolved the way
 * Vite would. CJS output because react-dom/server reaches for node
 * built-ins through require().
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'render-smoke-'));
const outfile = join(outDir, 'render-smoke.cjs');

try {
  await build({
    entryPoints: [join(here, 'render-smoke.entry.jsx')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'error',
    // Match Vite: the app uses the automatic JSX runtime, so most
    // components never import React. Compiling to React.createElement
    // instead would fail them with "React is not defined".
    jsx: 'automatic',
    loader: { '.js': 'jsx', '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
    define: {
      'import.meta.env': JSON.stringify({
        VITE_API_URL: 'http://localhost:8000',
        MODE: 'test',
        DEV: false,
        PROD: true,
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
