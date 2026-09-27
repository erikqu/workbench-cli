import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await build({ entryPoints: ['services/relay/main.ts', 'services/host/main.ts'], outdir: 'dist/services', outbase: 'services',
  outExtension: { '.js': '.mjs' }, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24', sourcemap: true });
await mkdir('dist/services/relay', { recursive: true });
await copyFile('services/relay/schema.sql', 'dist/services/relay/schema.sql');
