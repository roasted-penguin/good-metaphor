// 웹스토어 빌드 변환(T-303). 순수 함수만 둔다. 파일 읽기·쓰기·zip은 scripts/build-store.mjs 가 한다.
// 원본 객체는 바꾸지 않고 새 객체를 돌려준다.

const DEMO = 'demo';

/**
 * admin.json → 스토어용 admin.json
 *  - userStore.adapter 가 local-dev(개발용 로그인)면 none 으로
 *  - allowedProviders 에서 demo 제거(없으면 providerIds 에서 demo 뺀 목록)
 *  - fallbackChain 에서 demo 항목 제거(나머지 순서·길이는 그대로, 순위는 앞으로 더 붙는다)
 *  - defaultProvider 가 demo 면 체인의 첫 실제 제공자로, 체인이 비면 허용 목록 첫 항목으로
 * @param {object} admin
 * @param {string[]} providerIds PROVIDERS 의 키
 */
export function transformAdmin(admin, providerIds) {
  const out = structuredClone(admin);
  if (out.userStore?.adapter === 'local-dev') out.userStore.adapter = 'none';
  const allowed = (Array.isArray(out.allowedProviders) ? out.allowedProviders : providerIds).filter(id => id !== DEMO);
  out.allowedProviders = allowed;
  if (Array.isArray(out.fallbackChain)) out.fallbackChain = out.fallbackChain.filter(e => e?.provider !== DEMO);
  if (out.defaultProvider === DEMO) {
    const fromChain = (out.fallbackChain || []).map(e => e.provider).find(id => allowed.includes(id));
    out.defaultProvider = fromChain || allowed[0];
  }
  return out;
}

/** manifest.json → 스토어용. 표시 이름에서 " (PoC)" 만 뺀다 */
export function transformManifest(manifest) {
  const out = structuredClone(manifest);
  if (typeof out.name === 'string') out.name = out.name.replace(/\s*\(PoC\)\s*$/, '');
  return out;
}

// 스토어 zip 에 들어가면 안 되는 파일: e2e 사본 전용 파일, 소스맵, 테스트, 맥 메타 파일
const FORBIDDEN = [
  /(^|\/)e2e-hook\.js$/,
  /(^|\/)ort-smoke\.(html|js)$/,
  /(^|\/)add\.onnx$/,
  /\.map$/,
  /(^|\/)tests?\//,
  /\.(test|spec)\.m?js$/,
  /(^|\/)\.DS_Store$/
];

/** 상대 경로 목록 중 금지 파일만 (입력 순서대로) */
export function forbiddenFiles(paths) {
  return paths.filter(p => FORBIDDEN.some(re => re.test(p)));
}

export function zipName(version) {
  return `good-metaphor-${version}.zip`;
}
