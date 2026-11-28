// 노드 파이프라인 익숙함 검사(T-213): "보통 사람이 이 장면을 바로 떠올리나"를 LLM에 yes/no + 이유로 묻는다. no면 실패(unfamiliar).
// 사용자 결정(2026-11-23): 비유의 받는 쪽(식당 장면)은 사용자에게 익숙해야 한다. 간이과세·소액부징수 같은 조문은 그 자체가 낯설어
// 비유를 들어도 이해가 안 된다. 같은 호출에서 특정 가게·브랜드·앱 이름이나 실존 인물이 들어갔는지도 묻는다(storeName, 실패).
//
// 판정(직접 정함):
//   - 후보 하나에 LLM 한 번(태그 적합성 다음, 실패 후보에는 묻지 않음). 관심사 설정 rules.familiarity가 true일 때만(식당)
//   - 답이 없거나 꼴이 틀리면, 호출 상한·LLM 오류면 확인 사유 familiarPending(다음 실행에 캐시로 이어 감)
//   - 판정과 이유는 결과 familiar에 남긴다(리뷰 시트 "익숙함" 줄)
// 순수 함수 + 주입한 complete(system, user) → 답 글.

export function buildFamiliarPrompt({ domain, node }) {
  const system = [
    `너는 비유 검색용 개념 그래프를 검수하는 도우미다. 이 개념은 낯선 문장을 "${domain}" 장면에 빗대 설명할 때 받는 쪽으로 쓰인다. 받는 쪽이 낯설면 비유가 오히려 어려워진다.`,
    '두 가지를 판단한다.',
    `1. familiar: 한국에 사는 보통 성인(그 업계 사람이 아닌 손님)이 이 개념의 이름과 사실을 읽고, 직접 겪었거나 흔히 본 ${domain} 장면을 바로 떠올릴 수 있으면 yes. 법 조문·세금 제도·행정 절차·업계 전문 용어처럼 설명을 들어야 아는 것이면 no.`,
    '2. named: 이름이나 사실에 특정 가게·브랜드·앱·회사의 이름, 또는 실존 인물의 이름이 들어 있으면 yes, 없으면 no. "배달앱", "어떤 가게" 같은 일반 명사는 no.',
    'JSON 객체만 출력한다. 형식: {"familiar": "yes" 또는 "no", "reason": "한국어 한 문장, 80자 이내", "named": "yes" 또는 "no"}'
  ].join('\n');
  const user = [`[개념] ${node.label || node.id}`, ...(node.facts || []).map(f => `- ${f}`)].join('\n');
  return { system, user };
}

// 답 → { familiar, named, reason } 또는 null(꼴 틀림)
export function parseFamiliar(text) {
  try {
    const t = String(text || '').replace(/```(?:json)?/gi, '').trim();
    const v = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
    if (!['yes', 'no'].includes(v.familiar) || !['yes', 'no'].includes(v.named)) return null;
    return { familiar: v.familiar, named: v.named, reason: String(v.reason || '').slice(0, 160) };
  } catch { return null; }
}

const statusOf = r => (r.fails.length ? 'fail' : r.warns.length ? 'warn' : 'pass');

/**
 * 검사 결과에 익숙함 판정을 더한다(결과 객체를 고친다)
 * @returns {Promise<{ asked, yes, no, named, pending }>}
 */
export async function applyFamiliar(results, { complete, domain, model = '', log = () => {} }) {
  const stat = { asked: 0, yes: 0, no: 0, named: 0, pending: 0 };
  let stopped = false;
  const pend = (r, note) => {
    r.familiar = { status: 'pending', note };
    if (!r.warns.includes('familiarPending')) r.warns.push('familiarPending');
    r.status = statusOf(r);
    stat.pending++;
  };
  for (const r of results) {
    if (r.status === 'fail') continue;
    if (stopped) { pend(r, stopped); continue; }
    const { system, user } = buildFamiliarPrompt({ domain, node: r.node });
    let answer;
    try { answer = await complete(system, user); }
    catch (e) {
      if (e.budget) { stopped = '호출 상한'; pend(r, stopped); continue; }
      log(`익숙함 LLM 실패 ${r.node.id}: ${String(e.message || e).slice(0, 80)}`);
      if (e.status === 429) stopped = '429';
      pend(r, e.status === 429 ? '429' : 'LLM 오류');
      continue;
    }
    stat.asked++;
    const got = parseFamiliar(answer);
    if (!got) { pend(r, '답 꼴 틀림'); continue; }
    r.familiar = { status: 'done', model, ...got };
    if (got.familiar === 'no') { r.fails.push('unfamiliar'); stat.no++; } else stat.yes++;
    if (got.named === 'yes') { r.fails.push('storeName'); stat.named++; }
    r.status = statusOf(r);
  }
  return stat;
}
