// Build: esbuild for the Electron main process, preload and the MCP server; Vite for the UI.
import { build } from 'esbuild';
import { build as vite } from 'vite';
import react from '@vitejs/plugin-react';
import { rmSync } from 'node:fs';

const only = process.argv[2];
if (!only) rmSync('dist', { recursive: true, force: true });
const node = { bundle: true, platform: 'node', target: 'node22', sourcemap: 'linked', logLevel: 'warning' };
if (!only || only === 'main') {
  await build({ ...node, entryPoints: ['src/electron/main.ts'], outfile: 'dist/main.js', format: 'esm', external: ['electron', 'openfilm'],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });
  await build({ ...node, entryPoints: ['src/electron/preload.ts'], outfile: 'dist/preload.cjs', format: 'cjs', external: ['electron'] });
  await build({ ...node, entryPoints: ['src/mcp/main.ts'], outfile: 'dist/mcp.js', format: 'esm',
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });
}
if (!only || only === 'ui') {
  await vite({ root: 'src/ui', base: './', logLevel: 'warn', plugins: [react()], build: { outDir: '../../dist/ui', emptyOutDir: true, sourcemap: true } });
}
console.log('built', only ?? 'all');
