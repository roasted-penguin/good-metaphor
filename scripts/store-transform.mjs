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

/**
 * manifest.json → 스토어용. 표시 이름에서 " (PoC)" 를 빼고,
 * 변환된 admin 의 로그인이 꺼져 있으면(userStore.adapter none) 쓰이지 않는 identity 권한을 뺀다.
 * identity 는 서버 계정 어댑터(remote, stores.js launchWebAuthFlow)만 쓴다. remote 면 남긴다
 * @param {object} manifest
 * @param {object} admin transformAdmin 결과
 */
export function transformManifest(manifest, admin) {
  const out = structuredClone(manifest);
  if (typeof out.name === 'string') out.name = out.name.replace(/\s*\(PoC\)\s*$/, '');
  const adapter = admin?.userStore?.adapter || 'none';
  if (adapter === 'none' && Array.isArray(out.permissions)) out.permissions = out.permissions.filter(p => p !== 'identity');
  return out;
}

// 처리방침은 "확장 제작자 서버로 보내는 정보 없음"이라 적는다. 서버 주소가 들어간 admin 으로는 스토어 빌드를 만들지 않는다
const SERVER_URL_KEYS = [
  ['analogyServer.url', a => a.analogyServer?.url],
  ['commonStore.url', a => a.commonStore?.url],
  ['userStore.baseUrl', a => a.userStore?.baseUrl]
];

/** 비어 있지 않은 서버 주소마다 한국어 오류 한 줄 */
export function serverUrlErrors(admin) {
  return SERVER_URL_KEYS
    .filter(([, get]) => String(get(admin || {}) ?? '').trim())
    .map(([key]) => `admin.json ${key} 에 서버 주소가 있어요. 개인정보 처리방침(§1·§6)을 먼저 고친 뒤 이 검사를 바꿔 주세요.`);
}

// 스토어 zip 에 꼭 있어야 하는 빌드 산출물(npm run build, 커밋돼 있다)
const REQUIRED = ['manifest.json', 'offscreen.js', 'vendor/ort-wasm-simd-threaded.asyncify.wasm', 'vendor/ort-wasm-simd-threaded.asyncify.mjs'];

/**
 * `git ls-files extension` 출력 → extension/ 아래 상대 경로 목록. 추적 안 되는 파일(로컬 임시 파일 등)은 스토어 빌드에 들어가지 않는다.
 * 빌드 산출물이 추적 목록에 없으면 오류
 */
export function trackedExtensionFiles(lsFilesOutput) {
  const files = String(lsFilesOutput).split('\n').map(l => l.trim()).filter(l => l.startsWith('extension/')).map(l => l.slice('extension/'.length));
  const missing = REQUIRED.filter(f => !files.includes(f));
  if (missing.length) throw new Error(`git 에 추적되는 extension/ 파일 중 ${missing.join(', ')} 이 없어요. npm run build 뒤 커밋해 주세요.`);
  return files;
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
