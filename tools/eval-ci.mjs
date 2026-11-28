// 실제 크롬 평가 묶음 실행 (T-200). 프리셋을 eval.mjs 실행 여러 개로 바꿔 차례로 돌리고, 요약을 남긴다.
//   npm run eval:ci -- guard                 # 회귀 가드 + 여유 가드
//   npm run eval:ci -- full                  # 메이플 가드·여유 가드·홀드아웃 + 식당 가드·홀드아웃
//   npm run eval:ci -- precomputed           # 동봉 벡터로 채점 + 가드 (T-193)
//   npm run eval:ci -- precise-judge-offline # 정밀 판정 캐시만으로 (키 없이)
//   npm run eval:ci -- custom --guard -v     # eval 인자 그대로
//   node tools/eval-ci.mjs --gate "<관문 인자; 관문 인자>"   # 노드 관문을 실제 확장으로(T-196). 로그 .tmp/eval-ci/gate-<순번>.log, 결과는 .tmp/node-pipeline/*-browser.*
//   [추가 인자]                              # 프리셋의 모든 실행 뒤에 붙는다(예 -v). 워크플로는 --args-string "<문자열>"
// 로그는 .tmp/eval-ci/<순번>-<이름>.log, 요약은 .tmp/eval-ci/summary.md (GITHUB_STEP_SUMMARY가 있으면 거기에도).
// 실행 하나가 실패해도 나머지를 돌리고, 하나라도 실패(가드·여유 가드 포함)면 종료 코드 1
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { resolveRuns, summaryMarkdown, gateRuns } from './eval-ci-lib.mjs';

const outDir = '.tmp/eval-ci';

function runEval(args, script = 'tools/eval.mjs') {
  return new Promise(resolve => {
    const chunks = [];
    const p = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const tee = (stream, out) => stream.on('data', d => { chunks.push(d); out.write(d); });
    tee(p.stdout, process.stdout);
    tee(p.stderr, process.stderr);
    p.on('close', code => resolve({ code: code ?? 1, log: Buffer.concat(chunks).toString('utf8') }));
  });
}

// 노드 관문 모드(T-196): eval 프리셋과 따로 돈다(로그 폴더는 지우지 않는다, 같은 잡의 eval 로그와 함께 올림)
if (process.argv[2] === '--gate') {
  const runs = gateRuns(process.argv[3]);
  mkdirSync(outDir, { recursive: true });
  let ok = true;
  const md = ['## 노드 관문 (실제 확장)', ''];
  for (const [i, args] of runs.entries()) {
    console.log(`\n=== 노드 관문 ${i + 1}/${runs.length}: npm run node-pipeline:gate -- ${args.join(' ')} ===`);
    const { code, log } = await runEval(['gate', ...args], 'tools/node-pipeline/cli.mjs');
    writeFileSync(`${outDir}/gate-${i + 1}.log`, log);
    ok &&= code === 0;
    md.push(`### ${args.join(' ')} — ${code === 0 ? '끝남' : `실패(종료 코드 ${code})`}`, '', '```', ...log.split(/\r?\n/).filter(l => /^\[gate\]|^  뺌 /.test(l)), '```', '');
  }
  md.push('결과 파일은 아티팩트 `node-gate`에 있어요.');
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n');
  process.exit(ok ? 0 : 1);
}

const { preset, runs } = resolveRuns(process.argv.slice(2));
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

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
