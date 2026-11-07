"""검색기 인터페이스, 후보(Candidate), 실제 LightRAG 검색기 골격.

Candidate 필드는 확장 extension/lib/retrieval.js retrieve() 결과 항목과 같다.
LightRAG 맥락 속 개체는 공통 그래프 노드로 바꿔서만 쓴다. 그래프에 없는 개체는 버린다(근거 밖 사실 금지).
실제 인덱스 만들기는 T-403. 여기서는 생성자와 "맥락 문자열 → 후보" 변환까지다.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass
class Candidate:
    id: str
    label: str
    source: str
    facts: list[str]
    score: float
    direct: float
    tag: dict[str, Any] | None  # {id, label, desc, sim}
    otherTags: list[str] = field(default_factory=list)
    neighbors: list[dict[str, Any]] = field(default_factory=list)  # {label, rel, dir}


class Retriever(Protocol):
    async def candidates(self, sentence: str, hl: list[str], ll: list[str], top_k: int = 3) -> list[Candidate]: ...


class RetrieverUnavailable(Exception):
    """검색 인덱스가 없거나 준비되지 않았을 때(503)."""


class RetrieverError(Exception):
    """검색 중 LightRAG 쪽에서 예외가 났을 때(502)."""


def build_candidate(node: dict[str, Any], graph: dict[str, Any], tag_id: str | None = None,
                    score: float = 0.0, direct: float = 0.0, tag_sim: float = 0.0) -> Candidate:
    """공통 그래프 노드 하나를 retrieve() 결과 항목 모양으로 바꾼다."""
    tag_by_id = {t["id"]: t for t in graph.get("tags", [])}
    label_by_id = {n["id"]: n["label"] for n in graph.get("nodes", [])}
    node_tags = node.get("tags", [])
    if tag_id not in node_tags:
        tag_id = None
    tag = None
    if tag_id:
        t = tag_by_id.get(tag_id, {})
        tag = {"id": tag_id, "label": t.get("label"), "desc": t.get("desc"), "sim": round(tag_sim, 4)}
    neighbors = []
    for e in graph.get("edges", []):
        if e.get("from") == node["id"] or e.get("to") == node["id"]:
            out = e.get("from") == node["id"]
            other = e.get("to") if out else e.get("from")
            neighbors.append({"label": label_by_id.get(other), "rel": e.get("rel"), "dir": "out" if out else "in"})
    return Candidate(
        id=node["id"],
        label=node["label"],
        # 서버는 공통 그래프만 다룬다(오버레이는 L3 이후, 규칙 3)
        source=node.get("source", "common"),
        facts=list(node.get("facts", [])),
        score=round(score, 4),
        direct=round(direct, 4),
        tag=tag,
        otherTags=[tag_by_id[t]["label"] for t in node_tags if t != tag_id and t in tag_by_id],
        neighbors=neighbors,
    )


_ENTITY_BLOCK = re.compile(r"Knowledge Graph Data \(Entity\):\s*```(?:json)?\s*\n(.*?)```", re.S)


def parse_context_entities(context: str) -> list[str]:
    """LightRAG 맥락(kg_query_context)의 개체 블록에서 개체 이름을 순서대로(중복 없이)꺼낸다.

    문서 청크 블록 안의 글은 보지 않는다.
    """
    m = _ENTITY_BLOCK.search(context or "")
    if not m:
        return []
    names: list[str] = []
    for line in m.group(1).splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        name = obj.get("entity") if isinstance(obj, dict) else None
        if isinstance(name, str) and (name := name.strip()) and name not in names:
            names.append(name)
    return names


def _norm(s: str) -> str:
    return re.sub(r"\s+", "", s).lower()


def context_to_candidates(context: str, graph: dict[str, Any], hl: list[str], top_k: int = 3) -> list[Candidate]:
    """맥락 속 개체를 공통 그래프 노드(id 또는 라벨로 찾음)로 바꿔 상위 top_k개.

    LightRAG 맥락에는 노드별 점수가 없어서 순위로 점수를 매긴다(1위 1.0, 아래로 0.1씩).
    direct(직접 유사도)는 알 수 없어 0으로 둔다. hl 태그가 노드 태그에 있으면 그것을 맞은 태그로 본다.
    """
    lookup: dict[str, dict[str, Any]] = {}
    for n in graph.get("nodes", []):
        lookup.setdefault(_norm(n["id"]), n)
        lookup.setdefault(_norm(n["label"]), n)
    hl_set = set(hl)
    tag_label = {t["id"]: t.get("label") for t in graph.get("tags", [])}

    out: list[Candidate] = []
    seen: set[str] = set()
    for name in parse_context_entities(context):
        node = lookup.get(_norm(name))
        if not node or node["id"] in seen:
            continue
        seen.add(node["id"])
        rank = len(out)
        tag_id = next((t for t in node.get("tags", []) if tag_label.get(t) in hl_set), None)
        out.append(build_candidate(node, graph, tag_id=tag_id, score=max(0.0, 1.0 - 0.1 * rank),
                                   direct=0.0, tag_sim=1.0 if tag_id else 0.0))
        if len(out) >= top_k:
            break
    return out


class LightRAGRetriever:
    """LightRAG 인스턴스(aquery를 가진 객체)에 맥락만 물어 공통 그래프 후보로 바꾼다.

    rag가 None이면 인덱스가 아직 없는 것(T-403 전)이라 RetrieverUnavailable을 던진다.
    """

    def __init__(self, rag: Any, graph: dict[str, Any]) -> None:
        self._rag = rag
        self._graph = graph

    async def candidates(self, sentence: str, hl: list[str], ll: list[str], top_k: int = 3) -> list[Candidate]:
        if self._rag is None:
            raise RetrieverUnavailable("LightRAG 인덱스가 없어요.")
        # 무거운 패키지라 실제로 물을 때만 불러온다(앱 생성·import 때는 안 부른다)
        from lightrag import QueryParam

        hl, ll = list(hl), list(ll)
        if not hl and not ll:
            # 둘 다 비면 LightRAG가 자기 키워드 LLM(get_keywords_from_query)을 부른다.
            # 그러면 클라우드 밖 LLM·통제 어휘 밖 키워드가 끼어들 수 있어(규칙 8·9) 문장 자체를 ll로 넘긴다
            ll = [sentence]
        param = QueryParam(mode="hybrid", hl_keywords=hl, ll_keywords=ll, only_need_context=True)
        try:
            context = await self._rag.aquery(sentence, param=param)
        except Exception as e:  # LightRAG 내부 오류는 종류가 많아 한 가지로 감싼다
            raise RetrieverError(f"LightRAG 검색 실패: {type(e).__name__}") from e
        return context_to_candidates(context if isinstance(context, str) else "", self._graph, hl, top_k)
