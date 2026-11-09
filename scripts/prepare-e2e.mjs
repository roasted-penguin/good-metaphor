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
// 서버 모드(T-404·T-141): 기본 사본은 서버 주소 없음(꺼짐 = 의도적 건너뜀, 결과 캐시도 예전 그대로).
// 서버 모드 시험은 아래에서 따로 만드는 SERVER_OUT 사본을 쓴다(extension.spec.mjs serverTest)
admin.analogyServer = { url: '', timeoutMs: 800 };
// AI 초안 전체 마감(T-301): 시험이 빨리 끝나게 짧게. 가짜 LLM의 "초안지연테스트"는 이보다 늦게 답한다
admin.draft = { deadlineMs: 2500 };
writeFileSync(p, JSON.stringify(admin, null, 2));

// 테스트 전용 콘텐츠 스크립트(T-144): 사본 manifest에만 등록한다. 실제 extension/ 은 그대로
copyFileSync('tests/e2e/hook-content.js', `${OUT}/e2e-hook.js`);
const mp = `${OUT}/manifest.json`;
const manifest = JSON.parse(readFileSync(mp, 'utf8'));
// all_frames(T-111): iframe 안에서도 content.js 주입 확인·background 이중 방어(topHost) 확인에 쓴다
manifest.content_scripts.push({ matches: ['http://127.0.0.1:8766/*', 'http://localhost:8766/*'], js: ['e2e-hook.js'], run_at: 'document_start', all_frames: true });
writeFileSync(mp, JSON.stringify(manifest, null, 2));

await build({ entryPoints: ['tests/e2e/ort-smoke-src.js'], bundle: true, format: 'esm', platform: 'browser', outfile: `${OUT}/ort-smoke.js`, logLevel: 'warning' });
copyFileSync('tests/e2e/add.onnx', `${OUT}/add.onnx`);
writeFileSync(`${OUT}/ort-smoke.html`, '<!doctype html><meta charset="utf-8"><title>ORT_PENDING</title><script type="module" src="ort-smoke.js"></script>');

// 서버 모드 사본(T-141): 같은 사본 + 가짜 analogy-api(:8767) 주소와 그 출처 권한.
// 표시어 없는 문장은 가짜 서버가 500 → 서버 실패라 결과를 캐시하지 않는다. 캐시를 보는 시험은 기본 사본을 쓴다.
// 실제 확장은 설정 화면에서 선택 권한을 요청한다. e2e는 요청 창을 누를 수 없어 manifest 에 미리 준다
const SERVER_OUT = '.tmp/ext-e2e-server';
rmSync(SERVER_OUT, { recursive: true, force: true });
cpSync(OUT, SERVER_OUT, { recursive: true });
writeFileSync(`${SERVER_OUT}/config/admin.json`, JSON.stringify({ ...admin, analogyServer: { url: 'http://127.0.0.1:8767', timeoutMs: 800 } }, null, 2));
writeFileSync(`${SERVER_OUT}/manifest.json`, JSON.stringify({ ...manifest, host_permissions: [...manifest.host_permissions, 'http://127.0.0.1:8767/*'] }, null, 2));
console.log('prepared', OUT, SERVER_OUT);
