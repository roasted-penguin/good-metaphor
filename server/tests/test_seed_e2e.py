"""시드 인덱스로 /v1/analogy 끝까지(T-403). 가짜 LLM + 실제 LightRAG 검색기 + 해시 임베딩, 네트워크 없이 임시 디렉터리에서."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import rag as rag_mod
from app.config import Settings, load_common_graph
from app.seed import graph_to_custom_kg, seed
from fakes import FakeLLM

REPO_ROOT = Path(__file__).resolve().parents[2]
COMMON_GRAPH = REPO_ROOT / "extension" / "data" / "common" / "maplestory.json"
GRAPH = load_common_graph(COMMON_GRAPH)
NODE_IDS = {n["id"] for n in GRAPH["nodes"]}
TOKEN = {"X-Install-Token": "install-e2e"}
SENTENCE = "강화할 때마다 확률이 낮아지는 구조예요."
UNAVAILABLE = "검색 인덱스가 아직 준비되지 않았어요."


def make_settings(working_dir: Path) -> Settings:
    return Settings.from_env({
        "LIGHTRAG_WORKING_DIR": str(working_dir), "EMBEDDING_PROVIDER": "hash", "EMBEDDING_DIM": "64",
        "COMMON_GRAPH_PATH": str(COMMON_GRAPH),
    })


@pytest.fixture(scope="module")
def seeded_dir(tmp_path_factory) -> Path:
    wd = tmp_path_factory.mktemp("seeded") / "rag"
    asyncio.run(seed(make_settings(wd)))
    return wd


@pytest.fixture
def llm_calls(monkeypatch) -> list:
    """LightRAG에 넘긴 llm_model_func 감시. 검색 중 한 번이라도 불리면 실패."""
    calls: list = []
    real = rag_mod.forbidden_llm

    async def spy(*args, **kwargs):
        calls.append((args, kwargs))
        return await real(*args, **kwargs)

    monkeypatch.setattr(rag_mod, "forbidden_llm", spy)
    return calls


@pytest.fixture
def query_params(monkeypatch) -> list:
    """실제 LightRAG.aquery를 감싸 넘어간 QueryParam을 모은다(동작은 그대로)."""
    from lightrag import LightRAG

    seen: list = []
    real = LightRAG.aquery

    async def wrapped(self, query, param=None, *args, **kwargs):
        seen.append((query, param))
        return await real(self, query, param, *args, **kwargs)

    monkeypatch.setattr(LightRAG, "aquery", wrapped)
    return seen


def _app(settings: Settings, llm: FakeLLM | None = None):
    from app.main import create_app

    # 검색기·rag는 주입하지 않는다 → 앱이 설정의 작업 디렉터리에서 실제 LightRAG를 연다
    return create_app(deps={"settings": settings, "llm": llm or FakeLLM()})


# ── 인덱스 감지 ──────────────────────────────────────────


def test_index_exists_only_after_seed(tmp_path, seeded_dir):
    assert rag_mod.index_exists(make_settings(seeded_dir)) is True
    assert rag_mod.index_exists(make_settings(tmp_path / "없음")) is False
    # 빈 워크스페이스 폴더만 있으면(열기만 한 흔적) 인덱스가 아니다
    (tmp_path / "빈" / "common_maplestory").mkdir(parents=True)
    assert rag_mod.index_exists(make_settings(tmp_path / "빈")) is False


# ── 끝까지 ──────────────────────────────────────────────


def test_analogy_uses_seeded_lightrag_index(seeded_dir, llm_calls, query_params):
    llm = FakeLLM()
    with TestClient(_app(make_settings(seeded_dir), llm)) as client:
        res = client.post("/v1/analogy", json={"sentence": SENTENCE}, headers=TOKEN)
    assert res.status_code == 200, res.text
    body = res.json()

    ids = [c["id"] for c in body["debug"]["candidates"]]
    assert 1 <= len(ids) <= 3
    assert set(ids) <= NODE_IDS  # 공통 그래프 노드만(태그 엔티티·그래프 밖 개체는 버린다)
    assert "starforce" in ids  # 확률형 강화 태그의 대표 노드
    assert body["evidence"]["nodeId"] in ids
    assert body["evidence"]["source"] == "common"
    assert body["rejected"] is None
    assert body["analogy"].startswith("메이플로 치면")

    # 키워드 LLM의 hl(통제 어휘만 남긴 것)이 실제 QueryParam까지 갔다
    assert len(query_params) == 1
    query, param = query_params[0]
    assert query == SENTENCE
    assert param.mode == "hybrid" and param.only_need_context is True
    assert param.hl_keywords == ["확률형 강화"]
    assert param.ll_keywords == ["강화", "확률"]
    assert param.enable_rerank is False  # 리랭커 모델이 없다

    assert llm.count("keyword") == 1 and llm.count("analogy") == 1
    assert llm_calls == []  # LightRAG가 LLM을 부르지 않았다


def test_seeded_entities_become_candidates_through_real_context(seeded_dir, llm_calls):
    """실제 aquery(only_need_context) 맥락 문자열 → retriever 변환이 시드 엔티티 이름을 노드로 바꾼다."""
    from app.retriever import context_to_candidates, parse_context_entities

    async def go():
        from lightrag import QueryParam

        rag = await rag_mod.open_rag(make_settings(seeded_dir))
        try:
            return await rag.aquery(SENTENCE, param=QueryParam(
                mode="hybrid", hl_keywords=["확률형 강화"], ll_keywords=["강화"], only_need_context=True,
                enable_rerank=False))
        finally:
            await rag.finalize_storages()

    context = asyncio.run(go())
    names = parse_context_entities(context)
    kg_names = {e["entity_name"] for e in graph_to_custom_kg(GRAPH)["entities"]}
    assert names and set(names) <= kg_names
    cands = context_to_candidates(context, GRAPH, ["확률형 강화"], top_k=3)
    assert cands and {c.id for c in cands} <= NODE_IDS
    assert llm_calls == []


# ── 인덱스 없음·열기 실패 ──────────────────────────────


def test_no_index_returns_503_and_does_not_create_one(tmp_path):
    wd = tmp_path / "rag"
    with TestClient(_app(make_settings(wd))) as client:
        res = client.post("/v1/analogy", json={"sentence": SENTENCE}, headers=TOKEN)
    assert res.status_code == 503
    assert res.json() == {"error": UNAVAILABLE}
    assert not wd.exists()  # 열어 보다가 빈 인덱스를 만들지 않는다


def test_open_failure_returns_korean_503(seeded_dir, monkeypatch):
    async def broken(settings):
        raise OSError("디스크 오류")

    monkeypatch.setattr(rag_mod, "open_rag", broken)
    with TestClient(_app(make_settings(seeded_dir))) as client:
        res = client.post("/v1/analogy", json={"sentence": SENTENCE}, headers=TOKEN)
    assert res.status_code == 503
    assert res.json() == {"error": UNAVAILABLE}


def test_index_seeded_after_start_is_picked_up(tmp_path):
    """처음엔 인덱스가 없어 503이어도, 나중에 시드하면 재시작 없이 검색한다(없음은 기억하지 않는다)."""
    wd = tmp_path / "rag"
    s = make_settings(wd)
    with TestClient(_app(s)) as client:
        assert client.post("/v1/analogy", json={"sentence": SENTENCE}, headers=TOKEN).status_code == 503
        asyncio.run(seed(s))
        res = client.post("/v1/analogy", json={"sentence": SENTENCE + " "}, headers=TOKEN)
    assert res.status_code == 200, res.text


# ── 한 번만 연다 ──────────────────────────────────────────


def test_concurrent_first_requests_open_lightrag_once(seeded_dir, monkeypatch):
    from app.retriever import LazyLightRAGRetriever

    opened: list = []
    real = rag_mod.open_rag

    async def counting(settings):
        opened.append(settings)
        await asyncio.sleep(0.05)  # 여는 동안 다른 요청이 끼어들게 한다
        return await real(settings)

    monkeypatch.setattr(rag_mod, "open_rag", counting)
    r = LazyLightRAGRetriever(make_settings(seeded_dir), GRAPH)

    async def go():
        try:
            return await asyncio.gather(*[r.candidates(SENTENCE, ["확률형 강화"], ["강화"]) for _ in range(5)])
        finally:
            await r.close()

    results = asyncio.run(go())
    assert len(opened) == 1
    assert all(res and {c.id for c in res} <= NODE_IDS for res in results)


def test_creating_app_does_not_open_lightrag(seeded_dir, monkeypatch):
    def boom(settings):
        raise AssertionError("앱 생성 때 LightRAG를 열면 안 돼요")

    monkeypatch.setattr(rag_mod, "open_rag", boom)
    _app(make_settings(seeded_dir))
