"""테스트용 가짜 부품. 네트워크·LightRAG 없이 /v1/analogy 파이프라인을 돌린다.

FakeLLM은 확장 e2e 가짜 LLM(tests/e2e/servers.mjs)과 비슷한 규칙으로 답한다.
- 키워드 프롬프트("검색용 키워드"): 허용 태그 하나 + 목록 밖 태그 하나 + 문장 낱말
- 비유 프롬프트: 후보 1번을 고르고 usedFact에 후보 1번의 첫 fact를 넣는다
  - 문장에 "입장횟수테스트"가 있으면 facts 밖 숫자를 넣은 비유(숫자 근거 검사 확인용)
  - 문장에 "사실조작테스트"가 있으면 facts에 없는 usedFact(사실 근거 검사 확인용)
  - 문장에 "Leverage"가 있으면 후보 밖 nodeId(근거 검증 확인용)
  - 문장에 "펭귄"이 있으면 맞는 비유 없음(nodeId null)
  - 문장에 "깨진응답"이 있으면 JSON이 아닌 글
"""
from __future__ import annotations

import json as _json
import re

from app.retriever import Candidate, build_candidate

# 공통 그래프에서 고른 작은 시드(노드 3~5개)
SEED_NODE_IDS = ["starforce", "cube", "meso", "exp_coupon", "party"]


class FakeLLM:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def complete(self, system: str, user: str, json: bool) -> str:
        self.calls.append({"system": system, "user": user, "json": json})
        if "검색용 키워드" in system:
            return '{"hl_keywords": ["확률형 강화", "목록에없는태그"], "ll_keywords": ["강화", "확률"]}'
        if "깨진응답" in user:
            return "죄송해요, 지금은 답할 수 없어요."
        m = re.search(r"\[1\] id=(\S+) \| (.+)", user)
        tag = re.search(r"맞은 추상 태그: .+? \(id=(\S+)\)", user)
        if "펭귄" in user or not m:
            return ('```json\n{"meaning": "테스트 뜻 풀이예요.", "analogy": "", "nodeId": null, '
                    '"tagId": null, "usedFact": "", "mapping": ""}\n```')
        node_id, label = m.group(1), m.group(2)
        if "Leverage" in user:
            node_id = "not-a-candidate"
        # 후보 1번 facts의 첫 줄
        first_fact = re.search(r"\[1\] id=.*?\n  facts:\n   - ([^\n]+)", user, re.S)
        used_fact = first_fact.group(1) if first_fact else ""
        analogy = f"메이플로 치면 {label}과 같은 구조예요."
        if "입장횟수테스트" in user:
            analogy = "메이플로 치면 일주일에 7번만 입장할 수 있는 것과 같아요."
        if "사실조작테스트" in user:
            used_fact = "보스는 하루에 세 번까지 입장할 수 있다."
        answer = {"meaning": "테스트 뜻 풀이예요.", "analogy": analogy, "nodeId": node_id,
                  "tagId": tag.group(1) if tag else None, "usedFact": used_fact, "mapping": f"원문 ↔ {label}"}
        return "```json\n" + _json.dumps(answer, ensure_ascii=False) + "\n```"

    def count(self, kind: str) -> int:
        """kind: 'keyword' 또는 'analogy'."""
        is_kw = kind == "keyword"
        return sum(1 for c in self.calls if ("검색용 키워드" in c["system"]) == is_kw)


def _words(text: str) -> set[str]:
    return {w for w in re.split(r"[^0-9A-Za-z가-힣]+", text.lower()) if len(w) >= 2}


class FakeRetriever:
    """시드 노드를 낱말 겹침(문장 + ll 키워드 vs 라벨 + facts)으로 순위를 매긴다."""

    def __init__(self, graph: dict) -> None:
        self.graph = graph
        self.nodes = [n for n in graph["nodes"] if n["id"] in SEED_NODE_IDS]
        self.calls: list[dict] = []

    async def candidates(self, sentence: str, hl: list[str], ll: list[str], top_k: int = 3) -> list[Candidate]:
        self.calls.append({"sentence": sentence, "hl": hl, "ll": ll, "top_k": top_k})
        query = _words(sentence) | {w.lower() for w in ll}
        hl_set = set(hl)
        tag_by_id = {t["id"]: t for t in self.graph["tags"]}
        scored = []
        for n in self.nodes:
            text = _words(n["label"] + " " + " ".join(n["facts"]))
            overlap = sum(1 for q in query if any(q in w for w in text))
            # hl 태그가 노드 태그에 있으면 그 태그를 맞은 태그로 본다
            tag_id = next((t for t in n["tags"] if tag_by_id.get(t, {}).get("label") in hl_set), None)
            scored.append((overlap + (1 if tag_id else 0), n, tag_id))
        scored.sort(key=lambda x: -x[0])
        out = []
        for score, n, tag_id in scored[:top_k]:
            out.append(build_candidate(n, self.graph, tag_id=tag_id, score=float(score),
                                       direct=float(score), tag_sim=1.0 if tag_id else 0.0))
        return out
