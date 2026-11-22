// eval:ci 순수 함수 (T-200): 프리셋 → `tools/eval.mjs` 실행 목록, 로그 → 요약 줄, 요약 마크다운.
// 워크플로(.github/workflows/eval.yml)와 로컬(`npm run eval:ci -- <프리셋>`)이 같은 목록을 쓴다. 단위 테스트는 tests/unit/eval-ci.test.mjs

// 프리셋마다 eval.mjs 실행 여러 개. 각 실행은 { name, args }.
// 메이플 전용 플래그(--margin-guard 등)는 식당 실행에 넣지 않는다(eval.mjs가 오류로 멈춘다)
export const PRESETS = {
  // 회귀 가드 + 여유 가드(메이플 평가셋·검증셋). 묶음 판정 기본
  guard: [
    { name: 'maple-guard', args: ['--guard', '--margin-guard'] }
  ],
  // 메이플 평가·검증·가드·여유 가드 + 홀드아웃(은어 홀드아웃 포함, 그룹 slang 줄) + 식당 평가·가드·홀드아웃
  full: [
    { name: 'maple-guard', args: ['--guard', '--margin-guard'] },
    { name: 'maple-holdout', args: ['--holdout'] },
    { name: 'restaurant-guard', args: ['--interest', 'restaurant', '--guard'] },
    { name: 'restaurant-holdout', args: ['--interest', 'restaurant', '--holdout'] }
  ],
  // 동봉 벡터(extension/data/vectors)로 채점 + 가드 (T-193). build_vectors와 함께 쓰면 새로 만든 벡터로
  precomputed: [
    { name: 'maple-precomputed', args: ['--precomputed', '--guard', '--margin-guard'] },
    { name: 'restaurant-precomputed', args: ['--interest', 'restaurant', '--precomputed', '--guard'] }
  ],
  // 정밀 모드 판정(T-184)을 캐시(.tmp/judge-precise-*.json)만으로. 키 없이 돈다. 캐시 없는 문장은 "판정 빠짐"
  'precise-judge-offline': [
    { name: 'maple-precise-judge', args: ['--judge', 'precise', '--judge-offline'] }
  ]
};

// none(T-196): 평가 없이(워크플로가 노드 관문 gate_args·벡터 만들기만 돌릴 때). 실행 목록은 비어 있다
export const PRESET_NAMES = [...Object.keys(PRESETS), 'custom', 'none'];

/**
 * 따옴표를 아는 간단한 인자 나누기(워크플로 입력 문자열용). 셸 확장(글로브·변수)은 하지 않는다
 * @param {string} s
 * @returns {string[]}
 */
export function splitArgs(s) {
  const out = [];
  let cur = '', quote = null, has = false;
  for (const ch of String(s ?? '')) {
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch; has = true;
    } else if (/\s/.test(ch)) {
      if (has) { out.push(cur); cur = ''; has = false; }
    } else {
      cur += ch; has = true;
    }
  }
  if (quote) throw new Error(`닫히지 않은 따옴표가 있어요: ${s}`);
  if (has) out.push(cur);
  return out;
}

/**
 * eval:ci 명령줄 → 실행 목록.
 *   <프리셋> [추가 인자...]          추가 인자는 프리셋의 모든 실행 뒤에 붙는다(예 -v)
 *   custom <eval 인자...>            인자 그대로 한 번
 *   ... --args-string "<문자열>"     워크플로 입력용. 문자열을 나눠 위의 추가 인자로 쓴다
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{ preset: string, runs: { name: string, args: string[] }[] }}
 */
export function resolveRuns(argv) {
  const [preset, ...rest0] = argv;
  if (!preset) throw new Error(`프리셋을 주세요: ${PRESET_NAMES.join(', ')}`);
  if (!PRESET_NAMES.includes(preset)) throw new Error(`모르는 프리셋이에요: ${preset} (가능: ${PRESET_NAMES.join(', ')})`);
  let rest = rest0;
  const at = rest.indexOf('--args-string');
  if (at >= 0) rest = [...rest.slice(0, at), ...splitArgs(rest[at + 1] ?? ''), ...rest.slice(at + 2)];
  if (preset === 'none') return { preset, runs: [] };
  if (preset === 'custom') {
    if (!rest.length) throw new Error('custom은 eval 인자가 있어야 해요(예: custom --guard --margin-guard)');
    return { preset, runs: [{ name: 'custom', args: rest }] };
  }
  return { preset, runs: PRESETS[preset].map(r => ({ name: r.name, args: [...r.args, ...rest] })) };
}

// 요약에 남길 줄: 관심사·셋 머리, hit@1 줄, 회귀·음성·여유 가드·미리 계산 벡터·태그 정확도·정밀 판정 요약
const KEY_LINE = /^(관심사:|\[.+\] 문장 |.*hit@1 |  ⚠ 회귀|  회귀 없음|  alias-negative |여유 가드:|  ✗ [+-]\d|  · [+-]\d|미리 계산 벡터 |추상 태그 top-1|회귀 \d+건|  합침 호출 지연|판정기 .*쓸 수 없어요|Error:|브라우저 임베더가 준비되지)/;

/**
 * 로그에서 요약 줄만
 * @param {string} log
 * @returns {string[]}
 */
export function keyLines(log) {
  return String(log).split(/\r?\n/).filter(l => KEY_LINE.test(l)).map(l => l.replace(/\s+$/, ''));
}

/**
 * 실행 결과 → 요약 마크다운(GitHub 잡 요약)
 * @param {{ preset: string, results: { name: string, args: string[], code: number, ms: number, log: string }[], extra?: string[] }} p
 */
export function summaryMarkdown({ preset, results, extra = [] }) {
  const ok = results.every(r => r.code === 0);
  const lines = [
    `## 실제 크롬 평가 (eval:ci ${preset}) — ${ok ? '통과' : '실패'}`,
    '',
    '| 실행 | 인자 | 결과 | 시간 |',
    '| --- | --- | --- | --- |',
    ...results.map(r => `| ${r.name} | \`${r.args.join(' ')}\` | ${r.code === 0 ? '통과' : `실패(종료 코드 ${r.code})`} | ${Math.round(r.ms / 1000)}초 |`),
    ''
  ];
  for (const e of extra) lines.push(e, '');
  for (const r of results) {
    lines.push(`### ${r.name}`, '', '```', ...keyLines(r.log), '```', '');
  }
  lines.push('전체 로그는 아티팩트 `eval-logs`에 있어요.');
  return lines.join('\n') + '\n';
}

/**
 * 노드 관문 실행 목록(T-196). 워크플로 입력 gate_args: `;`로 나눈 node-pipeline:gate 인자 묶음.
 * 실행마다 `--embedder browser`로 고정한다(대체 임베더 관문은 맥에서 돌림, CI는 실제 확장 판정만)
 * @param {string} s  예 "--interest maplestory --results tools/node-pipeline/batches/t196-maplestory.json; --interest restaurant --results ..."
 * @returns {string[][]}  빈 문자열이면 []
 */
export function gateRuns(s) {
  return String(s ?? '').split(';').map(splitArgs).filter(a => a.length).map(a => {
    const out = [];
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '--embedder') { i++; continue; }
      out.push(a[i]);
    }
    if (!out.includes('--interest')) throw new Error(`관문 실행마다 --interest가 있어야 해요: ${a.join(' ')}`);
    return [...out, '--embedder', 'browser'];
  });
}
