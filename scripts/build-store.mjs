// 웹스토어 빌드(T-303): extension/ → dist/store/ 복사 → admin.json·manifest.json 변환 → 금지 파일 검사 → dist/good-metaphor-<판>.zip
// 실행: npm run build:store  (먼저 npm run build 로 offscreen.js·vendor 를 만들어 둔다. 둘 다 커밋돼 있다)
// zip 은 시스템 zip 명령을 쓴다(의존성 추가 없음. 맥·우분투 CI 기본 제공)
import { cpSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformAdmin, transformManifest, forbiddenFiles, zipName } from './store-transform.mjs';
import { PROVIDERS } from '../extension/lib/providers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'extension');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'store');

for (const need of ['offscreen.js', 'vendor/ort-wasm-simd-threaded.asyncify.wasm', 'vendor/ort-wasm-simd-threaded.asyncify.mjs']) {
  if (!existsSync(path.join(SRC, need))) throw new Error(`extension/${need} 이 없어요. npm run build 를 먼저 돌려 주세요.`);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
cpSync(SRC, OUT, { recursive: true });

const rw = (rel, fn) => {
  const p = path.join(OUT, rel);
  writeFileSync(p, JSON.stringify(fn(JSON.parse(readFileSync(p, 'utf8'))), null, 2) + '\n');
};
rw('config/admin.json', a => transformAdmin(a, Object.keys(PROVIDERS)));
rw('manifest.json', transformManifest);

function walk(dir, base = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const rel = base ? `${base}/${d.name}` : d.name;
    return d.isDirectory() ? walk(path.join(dir, d.name), rel) : [rel];
  });
}
const files = walk(OUT).sort();
const bad = forbiddenFiles(files);
if (bad.length) throw new Error('스토어 빌드에 들어가면 안 되는 파일이 있어요: ' + bad.join(', '));

const { version } = JSON.parse(readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
const zipPath = path.join(DIST, zipName(version));
rmSync(zipPath, { force: true });
// -X: 맥 확장 속성 제외, -q: 조용히. dist/store 안에서 묶어 zip 최상위에 manifest.json 이 오게 한다
execFileSync('zip', ['-r', '-X', '-q', zipPath, '.'], { cwd: OUT });

const kb = n => (n / 1024).toFixed(0) + 'KB';
console.log(`스토어 빌드: ${path.relative(ROOT, OUT)} (${files.length}개 파일)`);
console.log(`zip: ${path.relative(ROOT, zipPath)} (${kb(statSync(zipPath).size)})`);
