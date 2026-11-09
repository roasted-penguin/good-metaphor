// 웹스토어 빌드(T-303): 서버 주소 검사 → git 에 추적되는 extension/ 파일만 dist/store/ 로 복사 → admin.json·manifest.json 변환 → 금지 파일 검사 → dist/good-metaphor-<판>.zip
// 실행: npm run build:store  (먼저 npm run build 로 offscreen.js·vendor 를 만들어 둔다. 둘 다 커밋돼 있다)
// zip 은 시스템 zip 명령을 쓴다(의존성 추가 없음. 맥·우분투 CI 기본 제공)
import { rmSync, readFileSync, writeFileSync, readdirSync, mkdirSync, statSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformAdmin, transformManifest, forbiddenFiles, zipName, serverUrlErrors, trackedExtensionFiles } from './store-transform.mjs';
import { PROVIDERS } from '../extension/lib/providers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'extension');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'store');

// 처리방침과 맞지 않는 서버 주소가 있으면 멈춘다
const srcAdmin = JSON.parse(readFileSync(path.join(SRC, 'config/admin.json'), 'utf8'));
const serverErrors = serverUrlErrors(srcAdmin);
if (serverErrors.length) throw new Error('스토어 빌드를 멈췄어요.\n' + serverErrors.join('\n'));

// git 에 추적되는 파일만 복사한다(작업 트리의 임시·로컬 파일이 섞이지 않게)
const tracked = trackedExtensionFiles(execFileSync('git', ['ls-files', 'extension'], { cwd: ROOT, encoding: 'utf8' }));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
for (const rel of tracked) {
  const to = path.join(OUT, rel);
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(path.join(SRC, rel), to);
}

const rw = (rel, fn) => {
  const p = path.join(OUT, rel);
  writeFileSync(p, JSON.stringify(fn(JSON.parse(readFileSync(p, 'utf8'))), null, 2) + '\n');
};
const storeAdmin = transformAdmin(srcAdmin, Object.keys(PROVIDERS));
rw('config/admin.json', () => storeAdmin);
rw('manifest.json', m => transformManifest(m, storeAdmin));

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
