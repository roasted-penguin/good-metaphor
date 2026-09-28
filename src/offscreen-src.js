// 오프스크린 문서: 브라우저 안에서 다국어 임베딩 모델(transformers.js)을 돌린다.
// 서비스 워커에서는 동적 import 가 막혀 있어서 모델 실행은 여기서 한다.
import { pipeline, env } from '@huggingface/transformers';
import { hashEmbed, FALLBACK_ID } from '../extension/lib/fallback-embed.js';

env.allowLocalModels = false;
env.useWasmCache = false; // blob: URL import 는 확장 CSP 에서 막히므로 끔
env.backends.onnx.wasm.wasmPaths = {
  mjs: chrome.runtime.getURL('vendor/ort-wasm-simd-threaded.asyncify.mjs'),
  wasm: chrome.runtime.getURL('vendor/ort-wasm-simd-threaded.asyncify.wasm')
};
env.backends.onnx.wasm.numThreads = 1;

const state = { status: 'idle', embedderId: null, progress: 0, file: '', error: null };
let extractor = null;
let loading = null;
let cfg = null;

async function load(config) {
  cfg = config;
  if (extractor || state.status === 'fallback') return state;
  if (loading) return loading;
  loading = (async () => {
    if (config.model === '__fallback__') {
      Object.assign(state, { status: 'fallback', embedderId: FALLBACK_ID, error: null });
      return state;
    }
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
      Object.assign(state, { status: 'ready', embedderId: `${config.model}@${config.dtype || 'q8'}`, progress: 1, error: null });
    } catch (e) {
      console.error('[offscreen] 모델 로드 실패', e);
      state.error = String(e?.message || e);
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
  const out = [];
  for (let i = 0; i < inputs.length; i += 16) {
    const t = await extractor(inputs.slice(i, i + 16), { pooling: 'mean', normalize: true });
    out.push(...t.tolist());
  }
  return out;
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
