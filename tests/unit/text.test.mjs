import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withJosa, buildAnalogyPrompt, demoAnswer } from '../../extension/lib/prompt.js';
import { parseJSONLoose } from '../../extension/lib/providers.js';
import { hashEmbed } from '../../extension/lib/fallback-embed.js';

test('받침에 따른 조사', () => {
  assert.equal(withJosa('경매장', '과', '와'), '경매장과');
  assert.equal(withJosa('메소', '과', '와'), '메소와');
  assert.equal(withJosa('큐브(잠재능력 재설정)', '과', '와'), '큐브(잠재능력 재설정)과');
});

test('모델 응답에서 JSON만 뽑는다', () => {
  assert.deepEqual(parseJSONLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJSONLoose('설명입니다 {"a":2} 끝'), { a: 2 });
  assert.equal(parseJSONLoose('JSON 아님'), null);
});

const cand = [{ id: 'starforce', label: '스타포스 강화', facts: ['사실1'], tag: { id: 'prob_upgrade', label: '확률형 강화', desc: 'd' }, otherTags: [], neighbors: [] }];

test('비유 프롬프트에 근거 규칙과 후보 id가 들어간다', () => {
  const { system, user } = buildAnalogyPrompt({ sentence: '문장', domain: '메이플스토리', analogyPrefix: '메이플로 치면', candidates: cand });
  assert.match(system, /근거에 없는/);
  assert.match(user, /id=starforce/);
});

test('데모 응답은 1위 후보를 근거로 쓴다', () => {
  const a = demoAnswer({ candidates: cand, analogyPrefix: '메이플로 치면' });
  assert.equal(a.nodeId, 'starforce');
  assert.match(a.analogy, /^메이플로 치면 스타포스 강화와/);
});

test('대체 임베더는 정규화된 512차원', () => {
  const v = hashEmbed('변동금리');
  assert.equal(v.length, 512);
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-6);
});
