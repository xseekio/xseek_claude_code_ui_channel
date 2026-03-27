import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'fs';

const html = readFileSync('channel/ui/index.html', 'utf-8');
writeFileSync('channel/_ui_html.ts', `export const uiHtml = ${JSON.stringify(html)};`);

await build({
  entryPoints: ['channel/server_bundle.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/server.cjs',
  banner: { js: '#!/usr/bin/env node' },
});

console.log('Bundle created: dist/server.cjs');
