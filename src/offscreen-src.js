// 오프스크린 문서: 브라우저 안에서 다국어 임베딩 모델(transformers.js)을 돌린다.
// 서비스 워커에서는 동적 import 가 막혀 있어서 모델 실행은 여기서 한다.
import { pipeline, env } from '@huggingface/transformers';
import { hashEmbed, FALLBACK_ID } from '../extension/lib/fallback-embed.js';
import { embedEach } from '../extension/lib/embed-each.js';

env.allowLocalModels = false;
env.useWasmCache = false; // blob: URL import 는 확장 CSP 에서 막히므로 끔
env.backends.onnx.wasm.wasmPaths = {
  mjs: chrome.runtime.getURL('vendor/ort-wasm-simd-threaded.asyncify.mjs'),
  wasm: chrome.runtime.getURL('vendor/ort-wasm-simd-threaded.asyncify.wasm')
};
env.backends.onnx.wasm.numThreads = 1;

// loadError: 모델 로드 실패 원문. 'error'라고 부르지 않는다 — background의 offscreen()은 응답의 error를 요청 실패로 보고 던진다(T-102)
const state = { status: 'idle', embedderId: null, progress: 0, file: '', loadError: null };
let extractor = null;
let loading = null;
let cfg = null;

async function load(config) {
  cfg = config;
  if (extractor || state.status === 'fallback') return state;
  if (loading) return loading;
  loading = (async () => {
    if (config.model === '__fallback__') {
      Object.assign(state, { status: 'fallback', embedderId: FALLBACK_ID, loadError: null });
      return state;
    }
    // 모델 파일(데이터)만 받는 주소. 기본은 Hugging Face, 관리자가 사내 미러를 둘 수 있다(e2e는 느린 가짜 서버)
    if (config.remoteHost) env.remoteHost = config.remoteHost;
    state.status = 'loading';
    try {
      const files = new Map();
      extractor = await pipeline('feature-extraction', config.model, {
        dtype: config.dtype || 'q8',
        device: 'wasm',
        progress_callback: p => {
          if (p.status === 'progress' && p.total) {
            files.set(p.file, [p.loaded, p.total]);
            let l = 0, t = 0;
            for (const [a, b] of files.values()) { l += a; t += b; }
            state.progress = t ? l / t : 0;
            state.file = p.file;
          }
        }
      });
      Object.assign(state, { status: 'ready', embedderId: `${config.model}@${config.dtype || 'q8'}`, progress: 1, loadError: null });
    } catch (e) {
      console.error('[offscreen] 모델 로드 실패', e);
      state.loadError = String(e?.message || e);
      if (config.fallbackOnError !== false) {
        Object.assign(state, { status: 'fallback', embedderId: FALLBACK_ID });
      } else {
        state.status = 'error';
      }
    }
    return state;
  })();
  try { return await loading; } finally { loading = null; }
}

async function embed(texts, kind) {
  const prefix = kind === 'query' ? (cfg?.queryPrefix ?? '') : (cfg?.passagePrefix ?? '');
  const inputs = texts.map(t => prefix + t);
  if (state.status === 'fallback' || !extractor) return inputs.map(hashEmbed);
  // 한 문장씩 (묶으면 q8 벡터가 달라진다, T-128)
  return embedEach(inputs, async batch => (await extractor(batch, { pooling: 'mean', normalize: true })).tolist());
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  (async () => {
    switch (msg.type) {
      case 'init': return load(msg.config);
      case 'status': return { ...state };
      case 'embed': {
        if (!extractor && state.status !== 'fallback') await load(msg.config || cfg);
        return { vectors: await embed(msg.texts, msg.kind), embedderId: state.embedderId };
      }
      default: throw new Error('알 수 없는 요청: ' + msg.type);
    }
  })().then(sendResponse, e => sendResponse({ error: String(e?.message || e) }));
  return true;
});
