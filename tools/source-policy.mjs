// 공통 그래프 출처 정책(D-5·D-8, ADR 0016). 원본은 tools/source-policy.json 한 곳이고,
// 그래프 단위 테스트·노드 파이프라인(sources.mjs·check.mjs)이 이 모듈로, 서버 테스트는 같은 JSON을 직접 읽는다.
// - official: 공식·공공 원문(메이플 maplestory.nexon.com, 식당 *.go.kr 등)
// - community: 사실 확인용 커뮤니티·블로그·뉴스(메이플: 나무위키 /w/·인벤 메이플, 식당: 나무위키·티스토리·브런치·다음 뉴스).
//   원문은 저장하지 않고 우리 문장만 쓴다. 사이트 id가 독립 출처 단위(같은 플랫폼의 두 글은 한 곳)
// 교차 확인(corroboration): 커뮤니티 출처가 하나라도 있는 노드는 ① 공식 출처 1개 이상, 또는 ② 서로 다른 커뮤니티 사이트 2곳 이상
// 이 있어야 한다. 같은 사이트의 두 문서(나무위키 두 쪽)는 독립 출처로 치지 않는다.
import { readFileSync } from 'node:fs';

export const SOURCE_POLICY = JSON.parse(readFileSync(new URL('./source-policy.json', import.meta.url), 'utf8'));
export const SOURCE_KINDS = ['official', 'community'];

export function sourcePolicy(interest) {
  const p = SOURCE_POLICY.interests[interest];
  if (!p) throw new Error(`출처 정책에 없는 관심사: ${interest}`);
  return p;
}

const hostMatch = (rule, host) => (rule.host ? host === rule.host : rule.suffix ? host.endsWith(rule.suffix) : false);
const pathMatch = (rule, path) => !rule.paths || rule.paths.some(p => path.startsWith(p));

/**
 * 출처 주소 하나 → { kind: 'official'|'community', site } 또는 null(https 아님·허용 밖)
 * site: 공식은 'official', 커뮤니티는 사이트 id(namuwiki·inven). 교차 확인에서 독립 출처를 셀 때 쓴다
 */
export function classifySource(url, interest) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const p = sourcePolicy(interest);
  if ((p.official || []).some(r => hostMatch(r, u.hostname) && pathMatch(r, u.pathname))) return { kind: 'official', site: 'official' };
  const c = (p.community || []).find(r => hostMatch(r, u.hostname) && pathMatch(r, u.pathname));
  return c ? { kind: 'community', site: c.site } : null;
}

// 공식 호스트인가(목록·초안은 공식만 돈다: 커뮤니티는 수집하지 않는다)
export function isOfficialHost(host, interest) {
  return (sourcePolicy(interest).official || []).some(r => hostMatch(r, host));
}

/**
 * 출처 목록의 교차 확인 판정(순수 함수)
 * @param {Array<{kind, site}|null>} classes  classifySource 결과
 * @returns {{ sourceKind: 'official'|'community', corroborated: boolean, official: number, communitySites: string[] }}
 */
export function corroboration(classes) {
  const ok = classes.filter(Boolean);
  const official = ok.filter(c => c.kind === 'official').length;
  const communitySites = [...new Set(ok.filter(c => c.kind === 'community').map(c => c.site))];
  const sourceKind = communitySites.length ? 'community' : 'official';
  const corroborated = sourceKind === 'official' ? official >= 1 : official >= 1 || communitySites.length >= 2;
  return { sourceKind, corroborated, official, communitySites };
}

/**
 * 공통 그래프 노드의 출처 정책 검사. 빈 배열이면 통과
 * 오류 코드: sourceMissing, sourceNotAllowed(주소마다 한 줄), communityUncorroborated, sourceKindMissing(커뮤니티인데 표시 없음),
 *           sourceKindMismatch(community라 적었는데 커뮤니티 출처가 없음), sourceKindInvalid
 */
export function checkNodeSources(node, interest) {
  const errors = [];
  const sources = Array.isArray(node?.sources) ? node.sources : [];
  if (!sources.length) return ['sourceMissing'];
  const classes = sources.map(u => classifySource(u, interest));
  sources.forEach((u, i) => { if (!classes[i]) errors.push(`sourceNotAllowed:${u}`); });
  if (errors.length) return errors; // 허용 밖 주소가 있으면 종류·교차 확인은 따지지 않는다(주소부터 고친다)
  const c = corroboration(classes);
  if (c.sourceKind === 'community' && !c.corroborated) errors.push('communityUncorroborated');
  const marked = node.sourceKind;
  if (marked !== undefined && !SOURCE_KINDS.includes(marked)) errors.push('sourceKindInvalid');
  else if (c.sourceKind === 'community' && marked !== 'community') errors.push('sourceKindMissing');
  else if (c.sourceKind === 'official' && marked === 'community') errors.push('sourceKindMismatch');
  return errors;
}
