// 확장 페이지(CSP: wasm-unsafe-eval)에서 onnxruntime wasm이 로컬 파일로 뜨는지 확인하는 스모크 테스트
import * as ort from 'onnxruntime-web/webgpu';
ort.env.wasm.wasmPaths = {
  mjs: chrome.runtime.getURL('vendor/ort-wasm-simd-threaded.asyncify.mjs'),
  wasm: chrome.runtime.getURL('vendor/ort-wasm-simd-threaded.asyncify.wasm')
};
ort.env.wasm.numThreads = 1;
(async () => {
  try {
    const buf = await (await fetch(chrome.runtime.getURL('add.onnx'))).arrayBuffer();
    const s = await ort.InferenceSession.create(new Uint8Array(buf), { executionProviders: ['wasm'] });
    const out = await s.run({ x: new ort.Tensor('float32', new Float32Array([1, 2, 3]), [3]) });
    document.title = 'ORT_OK ' + Array.from(out.y.data).join(',');
  } catch (e) { document.title = 'ORT_FAIL ' + e.message; }
})();
