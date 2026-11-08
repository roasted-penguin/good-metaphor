// 그래프 편집 폼(T-202)의 순수 함수. 설정 화면(options.js)과 단위 테스트가 같이 쓴다
// 원칙: 오버레이를 직접 바꾸지 않고 새 객체를 돌려준다. 폼이 모르는 필드(feedbackBoosts, tags 등)는 그대로 둔다

export const FORM_LIMITS = { label: 40, factLines: 5, factLength: 200, tags: 3, alias: 20 };
export const BOOST_MIN = -0.2;
export const BOOST_MAX = 0.2;

// "예시 노드 넣기"가 폼에 채우는 값
export const SAMPLE_FORM = {
  label: '내 아침 재획 루틴',
  facts: '나는 출근 전 30분 동안 매일 같은 사냥터에서 재획을 한다.\n빠진 날이 생기면 주말에 몰아서 채우기 어렵다.',
  tags: ['daily_accumulation', 'efficiency_metric'],
  aliases: ''
};

/* ───── id ───── */

// 새 노드 id: u: + 라벨의 영문 소문자·숫자 슬러그. 영문이 없으면 u:n + 짧은 무작위. 겹치면 피한다
export function makeNodeId(label, existingIds = [], rand = Math.random) {
  const taken = new Set(existingIds);
  const slug = String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
  if (slug) {
    let id = 'u:' + slug;
    for (let i = 2; taken.has(id); i++) id = `u:${slug}_${i}`;
    return id;
  }
  for (let tries = 0; tries < 50; tries++) {
    const id = 'u:n' + Math.floor(rand() * 36 ** 6).toString(36).padStart(6, '0');
    if (!taken.has(id)) return id;
  }
  return 'u:n' + Date.now().toString(36); // 무작위가 계속 겹칠 때의 마지막 수단
}

/* ───── 폼 ↔ 노드 ───── */

const lines = s => String(s ?? '').split('\n').map(x => x.trim()).filter(Boolean);
const commaList = s => String(s ?? '').split(',').map(x => x.trim()).filter(Boolean);

// 폼 값 → 노드. 오류는 필드별 문구(errors.label 등), 하나라도 있으면 node는 null
// opts: { prev(수정하는 기존 노드) | id(정해진 id) | existingIds(새 id를 만들 때 피할 목록) }
export function formToNode(form, { prev = null, id = null, existingIds = [] } = {}) {
  const L = FORM_LIMITS;
  const errors = {};
  const label = String(form?.label ?? '').trim();
  const facts = lines(form?.facts);
  const tags = [...new Set(form?.tags || [])];
  const aliases = commaList(form?.aliases);

  if (!label) errors.label = '이름을 적어 주세요.';
  else if (label.length > L.label) errors.label = `이름은 ${L.label}자까지 적을 수 있어요.`;

  if (!facts.length) errors.facts = '사실을 한 줄 이상 적어 주세요.';
  else if (facts.length > L.factLines) errors.facts = '사실은 다섯 줄까지 적을 수 있어요.';
  else if (facts.some(f => f.length > L.factLength)) errors.facts = `사실 한 줄은 ${L.factLength}자까지예요.`;

  if (!tags.length) errors.tags = '태그를 하나 이상 골라 주세요.';
  else if (tags.length > L.tags) errors.tags = '태그는 세 개까지 고를 수 있어요.';

  if (aliases.some(a => a.length > L.alias)) errors.aliases = `별칭은 하나에 ${L.alias}자까지예요.`;

  if (Object.keys(errors).length) return { node: null, errors };

  const node = { ...(prev || {}), id: prev?.id || id || makeNodeId(label, existingIds), label, facts, tags };
  if (aliases.length) node.aliases = aliases;
  else delete node.aliases;
  return { node, errors };
}

export function nodeToForm(n) {
  return {
    label: n?.label || '',
    facts: (n?.facts || []).join('\n'),
    tags: [...(n?.tags || [])],
    aliases: (n?.aliases || []).join(', ')
  };
}

/* ───── 오버레이 갱신 ───── */

export function upsertNode(ov, node) {
  const nodes = [...(ov.nodes || [])];
  const i = nodes.findIndex(n => n.id === node.id);
  if (i >= 0) nodes[i] = node; else nodes.push(node);
  return { ...ov, nodes };
}

// 노드를 지우면 손으로 넣은 가중치(nodeBoosts)도 같이 뺀다. feedbackBoosts는 기록이 정하므로 건드리지 않는다
export function removeNode(ov, id) {
  const nodeBoosts = { ...(ov.nodeBoosts || {}) };
  delete nodeBoosts[id];
  return { ...ov, nodes: (ov.nodes || []).filter(n => n.id !== id), nodeBoosts };
}

export function setHidden(ov, id, hidden) {
  const rest = (ov.hiddenNodeIds || []).filter(x => x !== id);
  return { ...ov, hiddenNodeIds: hidden ? [...rest, id] : rest };
}

// 가중치: -0.2~0.2, 소수 둘째 자리. 0이면 키를 지워 JSON을 깔끔하게 둔다
// 가중치 값 하나를 -0.2~0.2, 소수 둘째 자리로. 숫자가 아니면 0 (저장과 화면 표시가 같이 씀)
export function clampBoost(value) {
  return Math.round(Math.min(BOOST_MAX, Math.max(BOOST_MIN, Number(value) || 0)) * 100) / 100;
}

export function setBoost(ov, id, value) {
  const v = clampBoost(value);
  const nodeBoosts = { ...(ov.nodeBoosts || {}) };
  if (v === 0) delete nodeBoosts[id]; else nodeBoosts[id] = v;
  return { ...ov, nodeBoosts };
}

// 칩으로 고를 수 있는 태그: 공통 태그 사전 + 내 태그(고급 JSON으로만 만든다, 규칙 9)
export function tagChoices(commonTags = [], userTags = []) {
  const out = [];
  const seen = new Set();
  for (const [list, source] of [[commonTags || [], 'common'], [userTags || [], 'user']]) {
    for (const t of list) {
      if (!t?.id || seen.has(t.id)) continue;
      seen.add(t.id);
      out.push({ id: t.id, label: t.label || t.id, source });
    }
  }
  return out;
}
