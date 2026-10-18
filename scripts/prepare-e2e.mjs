// e2e용 확장 사본: 네트워크 없이 돌도록 대체 임베더 + 가짜 LLM(OpenAI 호환) 주소로 바꾸고,
// onnxruntime wasm 스모크 페이지를 추가한다.
import { build } from 'esbuild';
import { cpSync, rmSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const OUT = '.tmp/ext-e2e';
rmSync(OUT, { recursive: true, force: true });
cpSync('extension', OUT, { recursive: true });

const p = `${OUT}/config/admin.json`;
const admin = JSON.parse(readFileSync(p, 'utf8'));
admin.embedding.model = '__fallback__';
admin.defaultProvider = 'custom';
admin.customBaseUrl = 'http://127.0.0.1:8765/v1';
admin.defaultModels.custom = 'mock-model';
// fallback 체인(T-124): 'mock-busy'(가짜 LLM이 429)를 고르면 mock-model 로 넘어간다
admin.fallbackChain = [{ provider: 'custom', model: 'mock-model' }];
writeFileSync(p, JSON.stringify(admin, null, 2));

await build({ entryPoints: ['tests/e2e/ort-smoke-src.js'], bundle: true, format: 'esm', platform: 'browser', outfile: `${OUT}/ort-smoke.js`, logLevel: 'warning' });
copyFileSync('tests/e2e/add.onnx', `${OUT}/add.onnx`);
writeFileSync(`${OUT}/ort-smoke.html`, '<!doctype html><meta charset="utf-8"><title>ORT_PENDING</title><script type="module" src="ort-smoke.js"></script>');
console.log('prepared', OUT);
