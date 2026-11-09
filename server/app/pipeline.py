"""/v1/analogy 파이프라인: 키워드 LLM → 검색기(상위 3) → 비유 LLM → 근거 검증 → 확장 explain() 모양 응답.

규칙 1: LLM이 고른 nodeId가 후보에 없으면 비유를 숨긴다(문구는 확장 background.js와 같다).
그 뒤 근거 검사(T-123): usedFact·숫자가 고른 노드 facts 밖이면 비유를 숨긴다(app/grounding.py).
마지막으로 금칙어 검사(T-114, 규칙 11): meaning·analogy·mapping에 승인된 금칙어가 있으면 숨긴다(app/blocklist.py).
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any

from .blocklist import BLOCKED_REJECTED_TEXT, active_terms, find_blocked
from .grounding import GROUNDING_REJECTED_TEXT, check_grounding
from .llm import LLM, LLMError
from .prompts import build_analogy_prompt, build_keyword_prompt, parse_json_object, parse_keywords
from .retriever import Retriever, RetrieverError, RetrieverUnavailable

log = logging.getLogger(__name__)

REJECTED_TEXT = "모델이 근거 목록에 없는 개념을 골라서 비유를 숨겼어요."
TOP_K = 3


class PipelineError(Exception):
    """HTTP 상태와 사용자에게 보일 한국어 문구."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass
class AnalogyRequest:
    sentence: str
    word: str | None = None
    context: str | None = None
    page_title: str | None = None


class AnalogyPipeline:
    def __init__(self, graph: dict[str, Any], keyword_llm: LLM, analogy_llm: LLM, retriever: Retriever,
                 analogy_model: str, blocklist: list[dict[str, Any]] | None = None) -> None:
        self.graph = graph
        self.keyword_llm = keyword_llm
        self.analogy_llm = analogy_llm
        self.retriever = retriever
        self.analogy_model = analogy_model
        # 승인된 금칙어 카드만(없으면 빈 목록)
        self.blocklist = active_terms(blocklist or [])
        self.tags = [t for t in graph.get("tags", []) if t.get("label")]
        self.tag_labels = [t["label"] for t in self.tags]
        # 노드 id -> 검수 날짜(T-118). sources·verifiedAt은 사실이 아니라 시드(KG)에는 넣지 않는다
        self.verified_at = {n["id"]: n.get("verifiedAt") for n in graph.get("nodes", []) if n.get("id")}

    async def _complete(self, llm: LLM, system: str, user: str, json: bool) -> str:
        try:
            return await llm.complete(system, user, json=json)
        except LLMError as e:
            log.warning("LLM 호출 실패: %s", e)
            raise PipelineError(502, "AI 서버를 부르지 못했어요. 잠시 뒤 다시 시도해 주세요.") from e

    async def run(self, req: AnalogyRequest) -> dict[str, Any]:
        t0 = time.monotonic()
        graph = self.graph

        # 1) 질의 키워드. hl은 공통 그래프 태그 라벨만 남긴다(규칙 9). 해석 실패면 키워드 없이 검색한다
        system, user = build_keyword_prompt(req.sentence, req.page_title, self.tags)
        hl, ll = parse_keywords(await self._complete(self.keyword_llm, system, user, json=True), self.tag_labels)

        # 2) 검색(상위 3)
        try:
            candidates = await self.retriever.candidates(req.sentence, hl, ll, top_k=TOP_K)
        except RetrieverUnavailable as e:
            log.warning("검색기 준비 안 됨: %s", e)
            reason = getattr(e, "reason", None)
            message = "검색 인덱스가 아직 준비되지 않았어요."
            raise PipelineError(503, f"{message} {reason}" if reason else message) from e
        except RetrieverError as e:
            log.warning("검색 실패: %s", e)
            raise PipelineError(502, "검색 중에 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.") from e
        candidates = list(candidates)[:TOP_K]

        # 3) 비유
        system, user = build_analogy_prompt(req.sentence, req.context, req.word, req.page_title,
                                            graph.get("domain", ""), graph.get("analogyPrefix", ""), candidates)
        raw = await self._complete(self.analogy_llm, system, user, json=True)
        answer = parse_json_object(raw)
        if not isinstance(answer, dict):
            log.warning("비유 응답을 해석하지 못함: %r", raw[:120])
            raise PipelineError(502, "AI 응답을 해석하지 못했어요. 잠시 뒤 다시 시도해 주세요.")

        # 4) 근거 검증(규칙 1): 후보에 없는 노드를 댔으면 비유를 버린다
        chosen = next((c for c in candidates if c.id == answer.get("nodeId")), None)
        analogy = answer.get("analogy") or ""
        rejected = answer.get("rejected") or None
        if analogy and not chosen:
            analogy = ""
            rejected = REJECTED_TEXT

        # 5) 근거 검사(T-123): 비유가 고른 노드 facts 밖 사실·숫자를 쓰면 숨긴다. 비유가 비었으면 건너뛴다
        grounding = None
        if analogy and chosen:
            labels = [chosen.label, *[n.get("label") for n in (chosen.neighbors or [])]]
            ok, reason = check_grounding(analogy, answer.get("usedFact"), chosen.facts, req.sentence,
                                         req.context, labels=labels)
            grounding = {"ok": True} if ok else {"ok": False, "reason": reason}
            if not ok:
                analogy = ""
                rejected = GROUNDING_REJECTED_TEXT
                chosen = None

        # 6) 금칙어 검사(T-114): 출력 직전. 어느 필드든 걸리면 비유·대응을 숨기고, 뜻에서 걸리면 뜻도 지운다.
        # debug에는 필드 이름만 남긴다(금칙어 자체는 쓰지 않는다)
        meaning = answer.get("meaning") or ""
        mapping = answer.get("mapping") or ""
        blocked = None
        for field, value in (("meaning", meaning), ("analogy", analogy), ("mapping", mapping)):
            if not find_blocked(value, self.blocklist):
                continue
            blocked = blocked or {"field": field, "term": "(가림)"}
            if field == "meaning":
                meaning = ""
        if blocked:
            analogy = ""
            mapping = ""
            rejected = BLOCKED_REJECTED_TEXT
            chosen = None

        tag_label_by_id = {t["id"]: t.get("label") for t in graph.get("tags", [])}
        evidence = None
        if chosen:
            evidence = {
                "nodeId": chosen.id,
                "nodeLabel": chosen.label,
                "source": chosen.source,
                "tagLabel": tag_label_by_id.get(answer.get("tagId")) or (chosen.tag or {}).get("label"),
                # 공통 노드의 검수 날짜(T-118). 확장 말풍선이 "검수 YYYY-MM"으로 보인다. 없으면 None
                "verifiedAt": self.verified_at.get(chosen.id) if chosen.source == "common" else None,
            }

        return {
            "meaning": meaning,
            "analogy": analogy,
            "mapping": mapping,
            "rejected": rejected,
            "evidence": evidence,
            "domain": graph.get("domain"),
            "theme": graph.get("theme"),
            "feedbackApplied": False,
            "debug": {
                # 서버에 없는 값도 확장 debug와 키를 맞춘다
                "feedback": {"excluded": [], "pinned": None, "similar": []},
                "candidates": [
                    {"id": c.id, "label": c.label, "score": c.score, "direct": c.direct,
                     "tag": (c.tag or {}).get("label"), "tagSim": (c.tag or {}).get("sim"), "source": c.source}
                    for c in candidates
                ],
                "topTags": [],
                "abstractText": None,
                "embedderId": None,
                "embedderStatus": None,
                "provider": f"server/{self.analogy_model}",
                "fallbacks": [],
                "llmRetries": 0,
                "user": None,
                "keywords": {"hl": hl, "ll": ll},
                **({"grounding": grounding} if grounding is not None else {}),
                **({"blocked": blocked} if blocked is not None else {}),
                "ms": int((time.monotonic() - t0) * 1000),
            },
        }
