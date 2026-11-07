import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  checkGrounding, GROUNDING_REJECTED_TEXT, normalizeText, numbersIn, numberGroups, charJaccard
} from '../../extension/lib/grounding.js';

// 공통 그래프(maplestory.json)의 실제 facts
const WEEKLY_BOSS = [
  '강한 보스 중 상당수는 일주일에 한 번만 보상을 받을 수 있다.',
  '보스를 잡으면 나오는 결정석(강렬한 힘의 결정)을 상점에 팔아 메소를 번다.',
  '한 주에 팔 수 있는 결정석 개수에는 상한이 있다.'
];
const STARFORCE = [
  '메소를 내고 장비에 별(스타)을 붙여 능력치를 올리는 강화 시스템이다.',
  '별이 높아질수록 성공 확률은 낮아지고 한 번 시도하는 메소 비용은 커진다.',
  '높은 단계에서는 실패하면 장비가 파괴될 수 있고, 남은 흔적을 메소와 같은 장비로 복구해야 한다.'
];
const BOSS_ENTRY = [
  '보스마다 입장할 수 있는 최소 레벨이 정해져 있다.',
  '같은 보스라도 난이도에 따라 필요한 스펙과 받는 보상이 다르다.'
];
const SENTENCE = '이 적금은 한 달에 한 번만 납입할 수 있어요.';
const ANALOGY = '주간 보스처럼 정해진 주기마다 한 번만 보상을 받는 것과 같아요.';

const check = (over) => checkGrounding({
  analogy: ANALOGY, usedFact: WEEKLY_BOSS[0], facts: WEEKLY_BOSS, sentence: SENTENCE, context: '', ...over
});

test('문구는 존댓말 그대로', () => {
  assert.equal(GROUNDING_REJECTED_TEXT, '근거에 없는 내용이 섞여 있어서 비유를 숨겼어요.');
});

test('usedFact가 fact와 글자 그대로 같으면 통과', () => {
  assert.deepEqual(check({}), { ok: true });
});

test('usedFact가 fact의 일부를 그대로 옮긴 것이면 통과', () => {
  assert.deepEqual(check({ usedFact: '일주일에 한 번만 보상을 받을 수 있다' }), { ok: true });
});

test('공백·문장부호만 다르면 통과', () => {
  assert.deepEqual(check({ usedFact: '강한 보스 중  상당수는, 일주일에 한 번만 보상을 받을 수 있다!' }), { ok: true });
  assert.deepEqual(check({ usedFact: '"보스를 잡으면 나오는 결정석 강렬한 힘의 결정을 상점에 팔아 메소를 번다"' }), { ok: true });
});

test('조금 바꿔 말함(3-gram 자카드 0.6 이상)이면 통과', () => {
  const used = '강한 보스 중 상당수는 일주일에 한 번만 보상을 받을 수 있어요.';
  assert.ok(charJaccard(used, WEEKLY_BOSS[0]) >= 0.6);
  assert.deepEqual(check({ usedFact: used }), { ok: true });
});

test('다른 노드의 fact를 인용하면 fact-mismatch', () => {
  assert.deepEqual(check({ usedFact: STARFORCE[1] }), { ok: false, reason: 'fact-mismatch' });
  assert.deepEqual(check({ usedFact: BOSS_ENTRY[0] }), { ok: false, reason: 'fact-mismatch' });
});

test('지어낸 문장이면 fact-mismatch', () => {
  assert.deepEqual(check({ usedFact: '보스는 매주 한 번 보상을 준다' }), { ok: false, reason: 'fact-mismatch' });
});

test('facts가 비어 있는데 usedFact가 있으면 fact-mismatch', () => {
  assert.deepEqual(check({ facts: [] }), { ok: false, reason: 'fact-mismatch' });
  assert.deepEqual(check({ facts: undefined }), { ok: false, reason: 'fact-mismatch' });
});

test('usedFact가 없고(또는 빈 문자열·공백) 숫자도 없으면 통과', () => {
  assert.deepEqual(check({ usedFact: undefined }), { ok: true });
  assert.deepEqual(check({ usedFact: null }), { ok: true });
  assert.deepEqual(check({ usedFact: '' }), { ok: true });
  assert.deepEqual(check({ usedFact: '   ' }), { ok: true });
});

test('비유에 facts·원문·앞 문장 어디에도 없는 숫자가 있으면 number-outside', () => {
  const analogy = '일주일에 7번만 입장할 수 있는 것과 같아요.';
  assert.deepEqual(check({ analogy }), { ok: false, reason: 'number-outside' });
  assert.deepEqual(check({ analogy, usedFact: '' }), { ok: false, reason: 'number-outside' });
});

test('숫자는 토큰 단위로 비교한다 (17이 있어도 7은 밖)', () => {
  const analogy = '7번만 받는 것과 같아요.';
  assert.deepEqual(check({ analogy, sentence: '17일에 한 번 납입해요.' }), { ok: false, reason: 'number-outside' });
});

test('원문 문장이나 앞 문장에 있는 숫자는 통과', () => {
  const analogy = '주간 보스를 1년에 12번 도는 것처럼 한 번씩만 받는 것과 같아요.';
  assert.deepEqual(check({ analogy, sentence: '1년에 12번 이자를 받아요.' }), { ok: true });
  assert.deepEqual(check({ analogy, sentence: '이자를 받아요.', context: '1년에 12번 나눠서 줘요.' }), { ok: true });
});

test('고른 노드 facts에 있는 숫자는 통과', () => {
  const facts = ['길드 스킬은 레벨 10부터 배울 수 있다.'];
  assert.deepEqual(checkGrounding({
    analogy: '레벨 10이 돼야 배우는 것과 같아요.', usedFact: facts[0], facts, sentence: '자격을 갖춰야 해요.', context: ''
  }), { ok: true });
});

test('fact가 맞아도 비유에 밖 숫자가 있으면 number-outside', () => {
  assert.deepEqual(check({ analogy: '주간 보스를 일주일에 3번 잡는 것과 같아요.' }), { ok: false, reason: 'number-outside' });
});

test('fact가 틀리면 숫자보다 fact-mismatch를 먼저 알린다', () => {
  assert.deepEqual(check({ analogy: '7번 같아요.', usedFact: STARFORCE[0] }), { ok: false, reason: 'fact-mismatch' });
});

test('비유가 비었으면 검사 없이 통과', () => {
  assert.deepEqual(check({ analogy: '', usedFact: STARFORCE[0] }), { ok: true });
  assert.deepEqual(check({ analogy: undefined, usedFact: '지어낸 말' }), { ok: true });
  assert.deepEqual(check({ analogy: '   ' }), { ok: true });
});

test('헬퍼: normalizeText는 공백·문장부호를 지운다', () => {
  assert.equal(normalizeText(' 결정석(강렬한 힘의 결정)을, 판다! '), '결정석강렬한힘의결정을판다');
  assert.equal(normalizeText(undefined), '');
});

test('헬퍼: numbersIn은 아라비아 숫자 연속을 뽑고 천 단위 쉼표를 붙인다', () => {
  assert.deepEqual(numbersIn('7번, 12일, 1,000메소'), ['7', '12', '1000']);
  assert.deepEqual(numbersIn('숫자 없음'), []);
  assert.deepEqual(numbersIn(null), []);
});

test('헬퍼: charJaccard', () => {
  assert.equal(charJaccard('같은 문장이에요', '같은 문장이에요'), 1);
  assert.equal(charJaccard('가나다라', '마바사아'), 0);
  assert.equal(charJaccard('', ''), 0);
});

test('numbersIn: 전각 숫자도 아라비아 숫자와 같게 본다(NFKC)', () => {
  assert.deepEqual(numbersIn('확률 １０%'), ['10']);
  assert.deepEqual(numbersIn('１，０００ 메소'), ['1000']);
  assert.equal(check({ analogy: '１０번 시도하는 것과 같아요.', usedFact: '', sentence: '10번까지 할 수 있어요.' }).ok, true);
});

// 컨트롤러 판정(T-123 fix 1): 규칙 1이 neighbors를 허용하므로 노드·이웃 label의 숫자도 숫자 검사에 넣는다
const SOL_ERDA = [
  'HEXA 매트릭스의 스킬을 강화하려면 솔 에르다와 솔 에르다 조각이 필요하다.',
  "솔 에르다는 어센틱 지역 사냥이나 특정 보스로 '솔 에르다의 기운' 게이지를 채워 얻고, 보유할 수 있는 양에 상한이 있다."
];
const solCheck = (over) => checkGrounding({
  analogy: '6차 전직 뒤 HEXA 매트릭스를 키우는 솔 에르다와 같아요.', usedFact: SOL_ERDA[0], facts: SOL_ERDA,
  sentence: SENTENCE, context: '', ...over
});

test('숫자 검사: 이웃 label의 숫자는 통과', () => {
  assert.deepEqual(solCheck({ labels: ['솔 에르다', '6차 전직과 HEXA 매트릭스'] }), { ok: true });
  assert.deepEqual(solCheck(), { ok: false, reason: 'number-outside' }, 'labels 없으면 기존대로');
});

test('숫자 검사: 노드 label의 숫자는 통과', () => {
  assert.deepEqual(checkGrounding({
    analogy: '6차 전직을 해야 새 성장 시스템이 열리는 것과 같아요.', usedFact: '', facts: ['전직하면 새 스킬 성장 시스템이 열린다.'],
    sentence: SENTENCE, labels: ['6차 전직과 HEXA 매트릭스']
  }), { ok: true });
});

test('usedFact가 fact가 아닌 label과 같으면 여전히 fact-mismatch', () => {
  assert.deepEqual(solCheck({ usedFact: '6차 전직과 HEXA 매트릭스', labels: ['솔 에르다', '6차 전직과 HEXA 매트릭스'] }),
    { ok: false, reason: 'fact-mismatch' });
});

// T-143: 한글 수사·만/천 단위 수. 서버 server/tests/test_grounding.py와 같은 공유 사례를 읽는다
const SHARED = JSON.parse(readFileSync(new URL('../fixtures/grounding-numbers.json', import.meta.url), 'utf8'));

// 사례마다 test()를 하나씩 만들어 실패를 사례별로 알린다(Python parametrize와 같게)
for (const { text, numbers } of SHARED.numbers) {
  test(`공유 사례 numbersIn: ${text}`, () => {
    assert.deepEqual(numbersIn(text), numbers);
  });
}

for (const { note, input, ok, reason } of SHARED.checks) {
  test(`공유 사례 checkGrounding: ${note}`, () => {
    assert.deepEqual(checkGrounding(input), ok ? { ok: true } : { ok: false, reason });
  });
}

// T-145: 읽기 후보 묶음(뜻이 둘이면 readings 둘, 숫자가 아닐 수도 있으면 optional)
for (const { text, groups } of SHARED.groups) {
  test(`공유 사례 numberGroups: ${text}`, () => {
    assert.deepEqual(numberGroups(text), groups);
  });
}
