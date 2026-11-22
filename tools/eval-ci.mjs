// 실제 크롬 평가 묶음 실행 (T-200). 프리셋을 eval.mjs 실행 여러 개로 바꿔 차례로 돌리고, 요약을 남긴다.
//   npm run eval:ci -- guard                 # 회귀 가드 + 여유 가드
//   npm run eval:ci -- full                  # 메이플 가드·여유 가드·홀드아웃 + 식당 가드·홀드아웃
//   npm run eval:ci -- precomputed           # 동봉 벡터로 채점 + 가드 (T-193)
//   npm run eval:ci -- precise-judge-offline # 정밀 판정 캐시만으로 (키 없이)
//   npm run eval:ci -- custom --guard -v     # eval 인자 그대로
//   [추가 인자]                              # 프리셋의 모든 실행 뒤에 붙는다(예 -v). 워크플로는 --args-string "<문자열>"
// 로그는 .tmp/eval-ci/<순번>-<이름>.log, 요약은 .tmp/eval-ci/summary.md (GITHUB_STEP_SUMMARY가 있으면 거기에도).
// 실행 하나가 실패해도 나머지를 돌리고, 하나라도 실패(가드·여유 가드 포함)면 종료 코드 1
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { resolveRuns, summaryMarkdown } from './eval-ci-lib.mjs';

const { preset, runs } = resolveRuns(process.argv.slice(2));
const outDir = '.tmp/eval-ci';
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

function runEval(args) {
  return new Promise(resolve => {
    const chunks = [];
    const p = spawn(process.execPath, ['tools/eval.mjs', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const tee = (stream, out) => stream.on('data', d => { chunks.push(d); out.write(d); });
    tee(p.stdout, process.stdout);
    tee(p.stderr, process.stderr);
    p.on('close', code => resolve({ code: code ?? 1, log: Buffer.concat(chunks).toString('utf8') }));
  });
}

const results = [];
for (const [i, run] of runs.entries()) {
  console.log(`\n=== eval:ci ${preset} ${i + 1}/${runs.length}: ${run.name} (npm run eval -- ${run.args.join(' ')}) ===`);
  const t = Date.now();
  const { code, log } = await runEval(run.args);
  results.push({ ...run, code, ms: Date.now() - t, log });
  writeFileSync(`${outDir}/${i + 1}-${run.name}.log`, log);
}

// 워크플로가 넘기는 덧붙임(예: 벡터 다시 만들기 결과)
const extra = process.env.EVAL_CI_EXTRA ? [process.env.EVAL_CI_EXTRA] : [];
const md = summaryMarkdown({ preset, results, extra });
writeFileSync(`${outDir}/summary.md`, md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
console.log(`\n${md}`);
process.exit(results.every(r => r.code === 0) ? 0 : 1);
