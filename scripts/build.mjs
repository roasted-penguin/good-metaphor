// src/offscreen-src.js → extension/offscreen.js 번들, onnxruntime wasm 복사
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

await build({
  entryPoints: ['src/offscreen-src.js'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  outfile: 'extension/offscreen.js',
  logLevel: 'warning'
});

mkdirSync('extension/vendor', { recursive: true });
for (const ext of ['mjs', 'wasm']) {
  const name = `ort-wasm-simd-threaded.asyncify.${ext}`;
  copyFileSync(`node_modules/onnxruntime-web/dist/${name}`, `extension/vendor/${name}`);
}
console.log('built extension/offscreen.js + vendor wasm');
