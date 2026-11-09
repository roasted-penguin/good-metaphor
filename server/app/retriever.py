"""검색기 인터페이스, 후보(Candidate), 실제 LightRAG 검색기 골격.

Candidate 필드는 확장 extension/lib/retrieval.js retrieve() 결과 항목과 같다.
LightRAG 맥락 속 개체는 공통 그래프 노드로 바꿔서만 쓴다. 그래프에 없는 개체는 버린다(근거 밖 사실 금지).
LazyLightRAGRetriever는 시드된 인덱스(T-403)를 첫 검색 때 한 번만 열어 LightRAGRetriever에 넘긴다.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Protocol

log = logging.getLogger(__name__)


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
    """검색 인덱스가 없거나 준비되지 않았을 때(503).

    reason은 사용자에게 그대로 보여 줄 한국어 안내(무엇을 해야 하는지)다. 내부 오류처럼 보여 줄 게 없으면 None.
    """

    def __init__(self, message: str, reason: str | None = None) -> None:
        super().__init__(message)
        self.reason = reason


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
        # 리랭커 모델을 두지 않는다(켜 두면 매 검색마다 "모델 없음" 경고가 남는다)
        param = QueryParam(mode="hybrid", hl_keywords=hl, ll_keywords=ll, only_need_context=True,
                           enable_rerank=False)
        try:
            context = await self._rag.aquery(sentence, param=param)
        except Exception as e:  # LightRAG 내부 오류는 종류가 많아 한 가지로 감싼다
            raise RetrieverError(f"LightRAG 검색 실패: {type(e).__name__}") from e
        return context_to_candidates(context if isinstance(context, str) else "", self._graph, hl, top_k)


class LazyLightRAGRetriever:
    """설정의 작업 디렉터리에 시드된 인덱스가 있으면 첫 검색 때 LightRAG를 열어 검색한다.

    - 앱 생성·import 때는 아무것도 열지 않는다.
    - 인덱스 파일이 없거나 seed-meta.json이 지금 설정과 다르면 RetrieverUnavailable(503, 이유 포함). 없다는 결과는 기억하지 않아, 나중에 시드하면 재시작 없이 쓴다.
      없을 때 열지 않으므로 빈 인덱스를 만들지도 않는다.
    - 동시에 들어온 첫 요청들은 잠금으로 줄 세워 LightRAG를 한 번만 연다.
    - 열다가 실패하면 RetrieverUnavailable(503)로 바꾸고, 다음 요청 때 다시 시도한다.
    - 시드 주입과 같은 open_rag(토크나이저·임베딩 함수)를 쓴다. 차원·토크나이저가 달라지면 벡터가 안 맞는다.
    """

    def __init__(self, settings: Any, graph: dict[str, Any]) -> None:
        self._settings = settings
        self._graph = graph
        self._rag: Any = None
        self._inner: LightRAGRetriever | None = None
        self._lock: asyncio.Lock | None = None

    async def _ensure(self) -> LightRAGRetriever:
        if self._inner is not None:
            return self._inner
        if self._lock is None:
            self._lock = asyncio.Lock()
        async with self._lock:
            if self._inner is not None:  # 기다리는 동안 다른 요청이 열었다
                return self._inner
            # lightrag는 무거워서 실제로 열 때만 불러온다
            from . import rag as rag_mod

            # 인덱스 파일과 시드 기록(seed-meta.json)이 지금 설정(그래프 판본·임베딩)과 맞을 때만 연다(T-140).
            # 안 맞으면 열지 않는다(차원이 다른 벡터를 섞거나 옛 그래프로 답하지 않게)
            ready, reason = rag_mod.index_status(self._settings)
            if not ready:
                raise RetrieverUnavailable(f"인덱스 준비 안 됨: {reason}", reason=reason)
            try:
                rag = await rag_mod.open_rag(self._settings)
            except Exception as e:  # 저장소 파일 손상·권한 등
                log.error("LightRAG를 열지 못함: %s: %s", type(e).__name__, e)
                raise RetrieverUnavailable(f"LightRAG를 열지 못했어요: {type(e).__name__}") from e
            self._rag = rag
            self._inner = LightRAGRetriever(rag=rag, graph=self._graph)
            log.info("LightRAG 인덱스를 열었어요: %s", rag_mod.workspace_dir(self._settings))
            return self._inner

    async def candidates(self, sentence: str, hl: list[str], ll: list[str], top_k: int = 3) -> list[Candidate]:
        inner = await self._ensure()
        return await inner.candidates(sentence, hl, ll, top_k)

    async def close(self) -> None:
        """앱 종료 때 저장소를 닫는다. 열지 않았으면 아무것도 하지 않는다."""
        rag, self._rag, self._inner = self._rag, None, None
        if rag is not None:
            await rag.finalize_storages()
