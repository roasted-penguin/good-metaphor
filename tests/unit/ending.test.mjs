// 끝맺음 검사(T-122): 해요체(~요)가 아닌 합쇼체(~습니다)·해라체(~다)를 잡는다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { impoliteEnding, endingIssues, endingRetryNote, leakedTerms, buildAnalogyPrompt, buildAbstractPrompt } from '../../extension/lib/prompt.js';

test('impoliteEnding: 해요체(~요, ~죠)는 null', () => {
  assert.equal(impoliteEnding('메이플로 치면 주간 보스처럼 한 번만 받을 수 있어요.'), null);
  assert.equal(impoliteEnding('같은 구조예요! 그렇죠?'), null);
  assert.equal(impoliteEnding('손실도 함께 커져요 '), null);
  assert.equal(impoliteEnding('작은 하락에도 원금을 잃을 수 있어요."'), null);
});

test('impoliteEnding: 합쇼체(ㅂ니다·습니다·ㅂ니까)는 formal', () => {
  assert.equal(impoliteEnding('스타포스처럼 실패하면 잃을 수 있습니다.'), 'formal');
  assert.equal(impoliteEnding('같은 구조입니다'), 'formal');
  assert.equal(impoliteEnding('손실이 커집니다.'), 'formal');
  assert.equal(impoliteEnding('그렇게 됩니까?'), 'formal');
});

test('impoliteEnding: 해라체(~다, ~냐)는 plain', () => {
  assert.equal(impoliteEnding('이익과 손실이 함께 커진다.'), 'plain');
  assert.equal(impoliteEnding('같은 구조이다'), 'plain');
  assert.equal(impoliteEnding('그건 아니다.'), 'plain', '아니다는 ㅂ 받침이 아니라 해라체');
});

test('impoliteEnding: 여러 문장 중 하나라도 어기면 잡는다, 숫자 소수점에서 끊지 않는다', () => {
  assert.equal(impoliteEnding('확률이 3.5%예요. 그래서 잃을 수 있습니다.'), 'formal');
  assert.equal(impoliteEnding('잃을 수 있습니다. 조심해요.'), 'formal');
  assert.equal(impoliteEnding('확률이 3.5%예요. 조심해요.'), null);
  assert.equal(impoliteEnding('커진다.\n그래서 조심해요.'), 'plain');
});

test('impoliteEnding: 빈 문자열·명사로 끝난 조각은 잡지 않는다(오탐 없음)', () => {
  assert.equal(impoliteEnding(''), null);
  assert.equal(impoliteEnding(null), null);
  assert.equal(impoliteEnding('메이플로 치면 스타포스 강화.'), null);
  assert.equal(impoliteEnding('바다'), 'plain', '한 단어 "다" 끝은 해라체로 본다(비유·뜻은 문장이라 드묾)');
});

test('endingIssues: meaning·analogy만 보고, 어긴 필드와 문체를 돌려준다', () => {
  assert.deepEqual(endingIssues({ meaning: '뜻이에요.', analogy: '비슷해요.', mapping: '레버리지 ↔ 스타포스다' }), []);
  assert.deepEqual(endingIssues({ meaning: '돈을 잃을 수 있다.', analogy: '스타포스와 같습니다.' }), [
    { field: 'meaning', style: 'plain' },
    { field: 'analogy', style: 'formal' }
  ]);
  assert.deepEqual(endingIssues({ meaning: '뜻이에요.', analogy: '' }), []);
  assert.deepEqual(endingIssues(null), []);
});

test('endingRetryNote: 짧은 교정 문구 + 직전 답을 싣고, 해요체로 다시 쓰라고 한다', () => {
  const prev = { meaning: '잃을 수 있다.', analogy: '같습니다.', nodeId: 'starforce' };
  const note = endingRetryNote(endingIssues(prev), prev);
  assert.match(note, /~요/);
  assert.match(note, /meaning/);
  assert.match(note, /analogy/);
  assert.ok(note.includes(JSON.stringify(prev)), '직전 답을 그대로 싣는다');
  assert.ok(note.length < 400 + JSON.stringify(prev).length, '짧게');
});

test('leakedTerms: 원문 전문용어가 그대로 남았는지(대소문자·띄어쓰기 무시)', () => {
  assert.deepEqual(leakedTerms('빌린 힘으로 얻는 것과 잃는 것이 함께 커진다', ['레버리지']), []);
  assert.deepEqual(leakedTerms('레버리지를 쓰면 손익이 커진다', ['레버리지']), ['레버리지']);
  assert.deepEqual(leakedTerms('분마다 요청 수에 상한을 둔다', ['rate limit', 'rate limiting']), []);
  assert.deepEqual(leakedTerms('A rate-limit caps requests', ['rate limit']), ['rate limit'], '하이픈도 같은 낱말');
  assert.deepEqual(leakedTerms('Rate Limiting은 요청 수를 제한한다', ['rate limit']), ['rate limit']);
  assert.deepEqual(leakedTerms('', ['레버리지']), []);
});

test('비유 프롬프트: 끝맺음 규칙을 명시하고 예시 한 줄을 둔다 (T-122)', () => {
  const { system } = buildAnalogyPrompt({ sentence: 's', domain: '메이플스토리', analogyPrefix: '메이플로 치면', candidates: [] });
  assert.match(system, /meaning과 analogy의 모든 문장은 해요체\(~요\)로 끝낸다/);
  assert.match(system, /~습니다.*~다.*쓰지 않는다/);
  assert.match(system, /예: .*요\./);
});

test('추상화 프롬프트: 원문 전문용어를 옮기지 말라는 규칙과 예시 한 줄 (T-122)', () => {
  const { system } = buildAbstractPrompt({ sentence: '레버리지는 손익을 키운다', word: '', pageTitle: '' });
  assert.match(system, /원문에 나온 전문용어·외래어/);
  assert.match(system, /레버리지/);
  assert.match(system, /예: /);
  // 예시 결과 줄에는 예시 원문의 전문용어가 없어야 한다
  const ex = system.split('\n').find(l => l.startsWith('예: '));
  const [, out] = ex.split('→');
  assert.ok(out && !/인플레이션/.test(out), '예시 결과에 원문 용어가 없어야 함');
});

test('impoliteEnding: 공유 사례(서버 prompts.py와 같은 결과, tests/fixtures/ending-cases.json)', async () => {
  const fs = await import('node:fs');
  const { cases } = JSON.parse(fs.readFileSync(new URL('../fixtures/ending-cases.json', import.meta.url), 'utf8'));
  for (const [text, expected] of cases) assert.equal(impoliteEnding(text), expected, text);
});
