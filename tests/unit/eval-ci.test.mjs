import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRESETS, PRESET_NAMES, resolveRuns, splitArgs, keyLines, summaryMarkdown } from '../../tools/eval-ci-lib.mjs';
import { interestArgError } from '../../tools/eval-lib.mjs';
import { commonInterest } from '../../extension/lib/graph.js';
import { interestFromArgv } from '../../tools/load-graph.mjs';

test('resolveRuns: guard는 가드 + 여유 가드 한 번', () => {
  assert.deepEqual(resolveRuns(['guard']), { preset: 'guard', runs: [{ name: 'maple-guard', args: ['--guard', '--margin-guard'] }] });
});

test('resolveRuns: full은 메이플 가드·홀드아웃과 식당 가드·홀드아웃', () => {
  const { runs } = resolveRuns(['full']);
  assert.deepEqual(runs.map(r => r.args.join(' ')), [
    '--guard --margin-guard',
    '--holdout',
    '--interest restaurant --guard',
    '--interest restaurant --holdout'
  ]);
});

test('resolveRuns: 추가 인자는 모든 실행 뒤에, --args-string은 나눠서', () => {
  assert.deepEqual(resolveRuns(['full', '-v']).runs.map(r => r.args.at(-1)), ['-v', '-v', '-v', '-v']);
  assert.deepEqual(resolveRuns(['guard', '--args-string', '-v --margin 0.004']).runs[0].args, ['--guard', '--margin-guard', '-v', '--margin', '0.004']);
  assert.deepEqual(resolveRuns(['guard', '--args-string', '']).runs[0].args, ['--guard', '--margin-guard']);
});

test('resolveRuns: custom은 인자 그대로, 없으면 오류', () => {
  assert.deepEqual(resolveRuns(['custom', '--args-string', '--guard --margin-guard']).runs, [{ name: 'custom', args: ['--guard', '--margin-guard'] }]);
  assert.throws(() => resolveRuns(['custom']), /custom/);
});

test('resolveRuns: 모르는 프리셋·빈 인자는 오류', () => {
  assert.throws(() => resolveRuns([]), /프리셋/);
  assert.throws(() => resolveRuns(['nope']), /모르는 프리셋/);
});

test('프리셋: 식당 실행에 메이플 전용 플래그가 없다(eval.mjs가 멈추지 않게)', () => {
  for (const [name, runs] of Object.entries(PRESETS)) {
    for (const r of runs) {
      const interest = commonInterest(interestFromArgv(r.args));
      assert.equal(interestArgError(r.args, interest), null, `${name}/${r.name}`);
    }
  }
});

test('워크플로 suites 선택지가 프리셋 이름과 같다', () => {
  const yml = readFileSync('.github/workflows/eval.yml', 'utf8');
  const block = yml.match(/suites:[\s\S]*?options:\n((?:\s+- .+\n)+)/);
  assert.ok(block, 'suites options 블록');
  const options = block[1].trim().split('\n').map(l => l.trim().replace(/^- /, '').replace(/['"]/g, ''));
  assert.deepEqual([...options].sort(), [...PRESET_NAMES].sort());
});

test('splitArgs: 공백·따옴표', () => {
  assert.deepEqual(splitArgs('  --guard   -v '), ['--guard', '-v']);
  assert.deepEqual(splitArgs(`--retrieval '{"nodeTextMode":"desc"}'`), ['--retrieval', '{"nodeTextMode":"desc"}']);
  assert.deepEqual(splitArgs('--a "b c" ""'), ['--a', 'b c', '']);
  assert.deepEqual(splitArgs(undefined), []);
  assert.throws(() => splitArgs('"열림'), /따옴표/);
});

test('keyLines: hit@1·회귀·여유 가드 줄만 남긴다', () => {
  const log = [
    '관심사: 메이플스토리 (maplestory 2026.10.11-1)',
    '확장 안에서 모델 준비 중: x',
    '[평가셋] 문장 44개 · 임베더: e5 · 브라우저',
    '',
    '혼합                hit@1 91%  hit@3 98%  slang 9/9',
    '  alias-negative 6/6',
    '  회귀 없음',
    '  ⚠ 회귀(잘 맞던 문장이 틀림): 어떤 문장',
    '여유 작은 문장(< 0.005): 1개',
    '  +0.0010  어떤 문장',
    '여유 가드: 실패 1 · 아는 얇은 문장 2 · 목록에서 뺄 수 있음 0 (임계값 0.005)',
    '  ✗ +0.0010 (새로 얇아짐)  어떤 문장',
    '  · +0.0020 (바닥 +0.0015, T-150)  다른 문장',
    '회귀 1건'
  ].join('\n');
  assert.deepEqual(keyLines(log), [
    '관심사: 메이플스토리 (maplestory 2026.10.11-1)',
    '[평가셋] 문장 44개 · 임베더: e5 · 브라우저',
    '혼합                hit@1 91%  hit@3 98%  slang 9/9',
    '  alias-negative 6/6',
    '  회귀 없음',
    '  ⚠ 회귀(잘 맞던 문장이 틀림): 어떤 문장',
    '여유 가드: 실패 1 · 아는 얇은 문장 2 · 목록에서 뺄 수 있음 0 (임계값 0.005)',
    '  ✗ +0.0010 (새로 얇아짐)  어떤 문장',
    '  · +0.0020 (바닥 +0.0015, T-150)  다른 문장',
    '회귀 1건'
  ]);
});

test('summaryMarkdown: 표에 통과·실패, 실행별 요약 줄', () => {
  const md = summaryMarkdown({
    preset: 'full',
    results: [
      { name: 'maple-guard', args: ['--guard'], code: 0, ms: 61000, log: '혼합  hit@1 91%  hit@3 98%' },
      { name: 'maple-holdout', args: ['--holdout'], code: 1, ms: 2000, log: '회귀 2건' }
    ],
    extra: ['벡터: 바뀜']
  });
  assert.match(md, /eval:ci full\) — 실패/);
  assert.match(md, /\| maple-guard \| `--guard` \| 통과 \| 61초 \|/);
  assert.match(md, /실패\(종료 코드 1\)/);
  assert.match(md, /벡터: 바뀜/);
  assert.match(md, /### maple-holdout\n\n```\n회귀 2건\n```/);
});
