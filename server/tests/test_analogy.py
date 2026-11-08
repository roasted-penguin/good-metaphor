"""/v1/analogy 파이프라인 테스트. 가짜 LLM·검색기를 주입해 네트워크·키 없이 돈다."""
import asyncio
import json
import logging
from dataclasses import replace
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import load_common_graph
from fakes import FakeLLM, FakeRetriever

REPO_ROOT = Path(__file__).resolve().parents[2]
COMMON_GRAPH = REPO_ROOT / "extension" / "data" / "common" / "maplestory.json"
GRAPH = load_common_graph(COMMON_GRAPH)  # 태그 파일까지 합친 공통 그래프(T-304)

REJECTED = "모델이 근거 목록에 없는 개념을 골라서 비유를 숨겼어요."
GROUNDING_REJECTED = "근거에 없는 내용이 섞여 있어서 비유를 숨겼어요."
TOKEN = {"X-Install-Token": "install-a"}


def _settings(**kw):
    from app.config import Settings

    base = dict(gemini_api_key=None, workspace="common_maplestory", workspace_version="v1",
                rate_limit_per_min=30, common_graph_path=str(COMMON_GRAPH))
    base.update(kw)
    return Settings(**base)


def _client(settings=None, **deps):
    from app.main import create_app

    llm = deps.pop("llm", None) or FakeLLM()
    retriever = deps.pop("retriever", None) or FakeRetriever(GRAPH)
    app = create_app(deps={"settings": settings or _settings(), "llm": llm, "retriever": retriever, **deps})
    return TestClient(app), app, llm, retriever


def _post(client, sentence, headers=TOKEN, **extra):
    return client.post("/v1/analogy", json={"sentence": sentence, **extra}, headers=headers)


# --- 응답 모양 ---

def test_response_has_extension_shape():
    client, _, llm, retriever = _client()
    res = _post(client, "강화할 때마다 확률이 낮아지는 구조예요.", word="강화", context="앞 문장이에요.",
                pageTitle="테스트 페이지")
    assert res.status_code == 200
    body = res.json()
    for key in ("meaning", "analogy", "mapping", "rejected", "evidence", "domain", "theme",
                "feedbackApplied", "debug"):
        assert key in body, key
    assert body["meaning"] == "테스트 뜻 풀이예요."
    assert body["analogy"].startswith("메이플로 치면")
    assert body["rejected"] is None
    assert body["domain"] == GRAPH["domain"] and body["theme"] == GRAPH["theme"]
    assert body["feedbackApplied"] is False

    ev = body["evidence"]
    assert set(ev) == {"nodeId", "nodeLabel", "source", "tagLabel", "verifiedAt"}
    top = body["debug"]["candidates"][0]
    assert ev["nodeId"] == top["id"] and ev["nodeLabel"] == top["label"]
    assert ev["source"] == "common"
    # 공통 노드의 검수 날짜를 근거에 싣는다(T-118). 말풍선이 "검수 YYYY-MM"으로 보인다
    node = next(n for n in GRAPH["nodes"] if n["id"] == ev["nodeId"])
    assert ev["verifiedAt"] == node["verifiedAt"]

    debug = body["debug"]
    assert debug["provider"] == "server/gemini-3.5-flash-lite"
    assert isinstance(debug["ms"], int) and debug["ms"] >= 0
    assert 1 <= len(debug["candidates"]) <= 3
    for c in debug["candidates"]:
        assert set(c) == {"id", "label", "score", "direct", "tag", "tagSim", "source"}
    # 확장 debug에 있지만 서버에 없는 값도 키는 둔다
    for key in ("feedback", "topTags", "abstractText", "embedderId", "embedderStatus", "fallbacks",
                "llmRetries", "user"):
        assert key in debug, key

    # 키워드 → 검색기(상위 3) → 비유, 키워드 hl은 통제 어휘만(규칙 9)
    assert llm.count("keyword") == 1 and llm.count("analogy") == 1
    assert retriever.calls[0]["hl"] == ["확률형 강화"]
    assert retriever.calls[0]["ll"] == ["강화", "확률"]
    assert retriever.calls[0]["top_k"] == 3
    # 키워드 프롬프트의 태그 목록은 공통 그래프 tags에서 만든다
    kw_system = next(c["system"] for c in llm.calls if "검색용 키워드" in c["system"])
    for t in GRAPH["tags"]:
        assert t["label"] in kw_system
    # 비유 프롬프트에 요청 값이 들어간다
    an_user = next(c["user"] for c in llm.calls if "검색용 키워드" not in c["system"])
    assert "테스트 페이지" in an_user and "앞 문장이에요." in an_user and "커서가 가리킨 단어: 강화" in an_user


def test_out_of_candidates_node_hides_analogy():
    client, *_ = _client()
    body = _post(client, "Leverage magnifies both gains and losses.").json()
    assert body["analogy"] == ""
    assert body["rejected"] == REJECTED
    assert body["evidence"] is None
    assert body["meaning"] == "테스트 뜻 풀이예요."


def test_normal_answer_passes_grounding_check():
    client, _, llm, _ = _client()
    body = _post(client, "강화할 때마다 확률이 낮아지는 구조예요.").json()
    assert body["analogy"].startswith("메이플로 치면")
    assert body["rejected"] is None
    assert body["evidence"] is not None
    assert body["debug"]["grounding"] == {"ok": True}
    # 비유 프롬프트에 usedFact 규칙이 들어간다
    an_system = next(c["system"] for c in llm.calls if "검색용 키워드" not in c["system"])
    assert "usedFact에 글자 그대로 옮긴다" in an_system


def test_number_outside_facts_hides_analogy():
    client, *_ = _client()
    body = _post(client, "입장횟수테스트 이 적금은 한 달에 한 번만 넣을 수 있다.").json()
    assert body["analogy"] == ""
    assert body["rejected"] == GROUNDING_REJECTED
    assert body["evidence"] is None
    assert body["meaning"] == "테스트 뜻 풀이예요."
    assert body["debug"]["grounding"] == {"ok": False, "reason": "number-outside"}


def test_used_fact_outside_facts_hides_analogy():
    client, *_ = _client()
    body = _post(client, "사실조작테스트 강화 문장이에요.").json()
    assert body["analogy"] == ""
    assert body["rejected"] == GROUNDING_REJECTED
    assert body["evidence"] is None
    assert body["debug"]["grounding"] == {"ok": False, "reason": "fact-mismatch"}


def test_grounding_check_skipped_when_node_check_rejects_or_no_analogy():
    client, *_ = _client()
    leverage = _post(client, "Leverage magnifies both gains and losses.").json()
    assert leverage["rejected"] == REJECTED
    assert "grounding" not in leverage["debug"]
    penguin = _post(client, "펭귄은 남극에 살아요.").json()
    assert "grounding" not in penguin["debug"]


# --- 금칙어 필터(T-114): 규칙 1·근거 검사 뒤, meaning·analogy·mapping 검사 ---

BLOCKED_REJECTED = "부적절한 표현이 섞여 있어서 비유를 숨겼어요."
# 실제 금칙어 대신 테스트용 가짜 낱말
_TEST_BL = [{"term": "금칙테스트말", "variants": ["금칙우회말"], "meaning": "테스트용", "category": "D",
             "links": [], "first_seen": "2026-10-11", "sources": [], "status": "승인"},
            {"term": "제안테스트말", "variants": [], "meaning": "테스트용", "category": "D",
             "links": [], "first_seen": "2026-10-11", "sources": [], "status": "제안"}]


class _PatchLLM(FakeLLM):
    """FakeLLM 비유 답의 필드 끝에 글을 덧붙인다."""

    def __init__(self, **suffix):
        super().__init__()
        self.suffix = suffix

    async def complete(self, system, user, json):
        raw = await super().complete(system, user, json)
        if "검색용 키워드" in system:
            return raw
        import json as _j
        ans = _j.loads(raw.strip().removeprefix("```json").removesuffix("```"))
        for k, v in self.suffix.items():
            ans[k] = (ans.get(k) or "") + v
        return _j.dumps(ans, ensure_ascii=False)


@pytest.mark.parametrize("field", ["analogy", "mapping"])
def test_blocked_analogy_or_mapping_is_hidden(field):
    client, *_ = _client(llm=_PatchLLM(**{field: " 금.칙 테스트말"}), blocklist=_TEST_BL)
    res = _post(client, "강화할 때마다 확률이 낮아지는 구조예요.")
    body = res.json()
    assert body["analogy"] == "" and body["mapping"] == ""
    assert body["meaning"] == "테스트 뜻 풀이예요."
    assert body["rejected"] == BLOCKED_REJECTED
    assert body["evidence"] is None
    assert body["debug"]["blocked"] == {"field": field, "term": "(가림)"}
    assert "테스트말" not in res.text


def test_blocked_meaning_clears_meaning_too():
    client, *_ = _client(llm=_PatchLLM(meaning=" 금칙우회말"), blocklist=_TEST_BL)
    res = _post(client, "강화할 때마다 확률이 낮아지는 구조예요.")
    body = res.json()
    assert body["meaning"] == "" and body["analogy"] == "" and body["mapping"] == ""
    assert body["rejected"] == BLOCKED_REJECTED
    assert body["debug"]["blocked"] == {"field": "meaning", "term": "(가림)"}
    assert "우회말" not in res.text


def test_suggested_terms_and_clean_answers_pass():
    client, *_ = _client(llm=_PatchLLM(analogy=" (제안테스트말)"), blocklist=_TEST_BL)
    body = _post(client, "강화할 때마다 확률이 낮아지는 구조예요.").json()
    assert body["analogy"].endswith("(제안테스트말)")
    assert body["rejected"] is None
    assert "blocked" not in body["debug"]


def test_default_blocklist_file_is_loaded():
    # 주입 없이 실제 blocklist.json(DEFAULT_BLOCKLIST_PATH)을 읽는다. 우회 표기도 잡는다
    client, *_ = _client(llm=_PatchLLM(analogy=" 리.선.족"))
    res = _post(client, "강화할 때마다 확률이 낮아지는 구조예요.")
    body = res.json()
    assert body["analogy"] == "" and body["rejected"] == BLOCKED_REJECTED
    assert "선.족" not in res.text and "리선족" not in res.text


BLOCKLIST_MISSING = "금칙어 목록을 읽지 못해 비유를 멈췄어요."


def test_missing_blocklist_file_fails_closed(tmp_path):
    # 승인 카드가 하나도 없으면 비유를 내지 않는다(503, 한국어 JSON). LLM도 부르지 않는다
    client, _, llm, _ = _client(settings=_settings(blocklist_path=str(tmp_path / "없음.json")))
    res = _post(client, "강화할 때마다 확률이 낮아지는 구조예요.")
    assert res.status_code == 503
    assert res.json() == {"error": BLOCKLIST_MISSING}
    assert llm.calls == []


def test_injected_empty_or_unapproved_blocklist_fails_closed():
    for bl in ([], [{"term": "가나다", "variants": [], "status": "제안"}]):
        client, *_ = _client(blocklist=bl)
        res = _post(client, "강화할 때마다 확률이 낮아지는 구조예요.")
        assert res.status_code == 503
        assert res.json() == {"error": BLOCKLIST_MISSING}


def test_null_node_means_no_analogy():
    client, *_ = _client()
    body = _post(client, "펭귄은 남극에 살아요.").json()
    assert body["analogy"] == ""
    assert body["evidence"] is None
    assert body["rejected"] is None


def test_non_json_answer_is_502():
    client, *_ = _client()
    res = _post(client, "깨진응답이 오는 문장이에요.")
    assert res.status_code == 502
    assert res.json() == {"error": "AI 응답을 해석하지 못했어요. 잠시 뒤 다시 시도해 주세요."}


class _FailingLLM:
    async def complete(self, system, user, json):
        from app.llm import LLMError
        raise LLMError("upstream 500", status=500)


def test_llm_error_is_502():
    client, *_ = _client(llm=_FailingLLM())
    res = _post(client, "강화 문장이에요.")
    assert res.status_code == 502
    assert res.json() == {"error": "AI 서버를 부르지 못했어요. 잠시 뒤 다시 시도해 주세요."}


# --- 캐시 ---

def test_same_sentence_uses_cache_and_version_change_misses():
    client, app, llm, _ = _client()
    first = _post(client, "강화할 때마다 확률이 낮아져요.").json()
    calls = len(llm.calls)
    second = _post(client, "  강화할 때마다 확률이 낮아져요.  ").json()  # 앞뒤 공백은 같은 문장
    assert len(llm.calls) == calls
    assert second["cached"] is True
    assert second["meaning"] == first["meaning"]

    app.state.settings = replace(app.state.settings, workspace_version="v2")
    _post(client, "강화할 때마다 확률이 낮아져요.")
    assert len(llm.calls) == calls * 2


def test_same_sentence_different_word_misses_cache():
    client, _, llm, _ = _client()
    _post(client, "강화할 때마다 확률이 낮아져요.", word="강화")
    calls = len(llm.calls)
    assert _post(client, "강화할 때마다 확률이 낮아져요.", word="강화").json()["cached"] is True
    assert len(llm.calls) == calls
    res = _post(client, "강화할 때마다 확률이 낮아져요.", word="확률").json()
    assert "cached" not in res
    assert len(llm.calls) == calls * 2


def test_cache_key_and_eviction():
    import hashlib

    from app.cache import ResultCache, cache_key

    assert cache_key("  문장 ", None, "v1") == hashlib.sha1("문장\x1f".encode("utf-8")).hexdigest() + ":v1"
    assert cache_key("문장", "강화", "v1") == hashlib.sha1("문장\x1f강화".encode("utf-8")).hexdigest() + ":v1"
    assert cache_key("문장", "강화", "v1") != cache_key("문장", "확률", "v1")
    c = ResultCache(max_size=2)
    c.put("a", {"n": 1})
    c.put("b", {"n": 2})
    assert c.get("a") == {"n": 1}
    c.put("c", {"n": 3})  # 가장 오래된 b가 빠진다(a는 방금 읽어 최신)
    assert c.get("b") is None
    assert c.get("a") == {"n": 1} and c.get("c") == {"n": 3}
    assert ResultCache().max_size == 1000


def test_cache_key_without_version_warns(caplog):
    from app.cache import UNVERSIONED, cache_key

    with caplog.at_level(logging.WARNING):
        key = cache_key("문장", None, None)
    assert key.endswith(":" + UNVERSIONED)
    assert "None" not in key
    assert any("버전" in r.getMessage() for r in caplog.records)


def test_cached_result_is_not_mutated_by_caller():
    from app.cache import ResultCache

    c = ResultCache()
    c.put("k", {"debug": {"ms": 1}})
    got = c.get("k")
    got["debug"]["ms"] = 999
    assert c.get("k")["debug"]["ms"] == 1


# --- 요청 한도·토큰 ---

def test_rate_limit_per_token():
    client, *_ = _client(settings=_settings(rate_limit_per_min=2))
    assert _post(client, "강화 문장 하나예요.").status_code == 200
    assert _post(client, "강화 문장 둘이에요.").status_code == 200
    res = _post(client, "강화 문장 셋이에요.")
    assert res.status_code == 429
    assert res.json() == {"error": "요청이 너무 많아요. 잠시 뒤 다시 시도해 주세요."}
    other = _post(client, "강화 문장 셋이에요.", headers={"X-Install-Token": "install-b"})
    assert other.status_code == 200


def test_rate_limiter_window_slides():
    from app.ratelimit import RateLimiter

    now = [1000.0]
    rl = RateLimiter(limit=2, window=60, clock=lambda: now[0])
    assert rl.allow("t") and rl.allow("t")
    assert not rl.allow("t")
    now[0] += 61
    assert rl.allow("t")


def test_missing_token_is_400():
    client, *_ = _client()
    res = _post(client, "강화 문장이에요.", headers={})
    assert res.status_code == 400
    assert res.json() == {"error": "설치 토큰(X-Install-Token)이 필요해요."}


def test_empty_sentence_is_400():
    client, *_ = _client()
    res = _post(client, "   ")
    assert res.status_code == 400
    assert res.json() == {"error": "설명할 문장이 비어 있어요."}


def test_real_parts_without_key_is_503(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    from app.main import create_app

    client = TestClient(create_app(deps={"settings": _settings(gemini_api_key=None)}))
    res = _post(client, "강화 문장이에요.")
    assert res.status_code == 503
    assert res.json() == {"error": "서버에 AI 키가 설정되지 않았어요."}


def test_real_parts_with_key_but_no_index_is_503(tmp_path):
    """키는 있어도 LightRAG 인덱스(T-403)가 없으면 검색 단계에서 명확히 막는다. 네트워크는 쓰지 않는다."""
    from app.main import create_app

    # 기본 작업 디렉터리(server/rag_storage)에 로컬 시드가 있어도 흔들리지 않게 빈 임시 디렉터리를 쓴다
    settings = _settings(gemini_api_key="dummy-not-a-key", lightrag_working_dir=str(tmp_path / "rag"))
    app = create_app(deps={"settings": settings, "llm": FakeLLM()})
    res = _post(TestClient(app), "강화 문장이에요.")
    assert res.status_code == 503
    assert res.json() == {"error": "검색 인덱스가 아직 준비되지 않았어요."}


# --- 후보(Candidate) ---

def test_build_analogy_prompt_accepts_candidate_objects():
    from app.prompts import build_analogy_prompt
    from app.retriever import Candidate, build_candidate

    node = next(n for n in GRAPH["nodes"] if n["id"] == "starforce")
    cand = build_candidate(node, GRAPH, tag_id="prob_upgrade", score=0.9, direct=0.5, tag_sim=0.8)
    assert isinstance(cand, Candidate)
    as_dict = {
        "id": cand.id, "label": cand.label, "source": cand.source, "facts": cand.facts,
        "tag": cand.tag, "otherTags": cand.otherTags, "neighbors": cand.neighbors,
    }
    obj_prompt = build_analogy_prompt("문장", None, None, None, "메이플스토리", "메이플로 치면", [cand])
    dict_prompt = build_analogy_prompt("문장", None, None, None, "메이플스토리", "메이플로 치면", [as_dict])
    assert obj_prompt == dict_prompt
    user = obj_prompt[1]
    assert "[1] id=starforce | 스타포스 강화" in user
    assert "맞은 추상 태그: 확률형 강화 (id=prob_upgrade)" in user
    assert "메소(비용으로 메소를 씀)" in user  # neighbors


def test_build_candidate_fields_match_extension_retrieve():
    from app.retriever import build_candidate

    node = next(n for n in GRAPH["nodes"] if n["id"] == "starforce")
    c = build_candidate(node, GRAPH, tag_id="prob_upgrade", score=0.91234, direct=0.51234, tag_sim=0.81234)
    assert c.source == "common"
    assert c.score == 0.9123 and c.direct == 0.5123
    assert c.tag == {"id": "prob_upgrade", "label": "확률형 강화",
                     "desc": next(t["desc"] for t in GRAPH["tags"] if t["id"] == "prob_upgrade"),
                     "sim": 0.8123}
    assert "확률형 강화" not in c.otherTags and "단계별 비용 증가" in c.otherTags
    assert {"label": "메소", "rel": "비용으로 메소를 씀", "dir": "out"} in c.neighbors
    assert {"label": "샤이닝 스타포스 타임", "rel": "비용·확률 혜택을 줌", "dir": "in"} in c.neighbors
    assert build_candidate(node, GRAPH).tag is None


# --- LightRAG 맥락 → 후보 변환 ---

FAKE_CONTEXT = """
Knowledge Graph Data (Entity):

```json
{"entity": "스타포스 강화", "type": "system", "description": "강화", "created_at": "2026-11-01 00:00:00", "file_path": "maplestory.json"}
{"entity": "모르는 개체", "type": "unknown", "description": "그래프에 없음", "created_at": "UNKNOWN", "file_path": "x"}
{"entity": "cube", "type": "system", "description": "큐브", "created_at": "UNKNOWN", "file_path": "x"}
{"entity": "스타포스 강화", "type": "system", "description": "중복", "created_at": "UNKNOWN", "file_path": "x"}
{"entity": "메소", "type": "currency", "description": "돈", "created_at": "UNKNOWN", "file_path": "x"}
{"entity": "파티 플레이", "type": "system", "description": "넷째", "created_at": "UNKNOWN", "file_path": "x"}
```

Knowledge Graph Data (Relationship):

```json
{"entity1": "스타포스 강화", "entity2": "메소", "description": "비용"}
```

Document Chunks (Each entry has a reference_id):

```json
{"reference_id": "1", "content": "{\\"entity\\": \\"경매장\\"} 청크 안의 글은 개체로 보지 않아요"}
```
"""


def test_context_to_candidates_maps_entities_to_common_nodes():
    from app.retriever import context_to_candidates, parse_context_entities

    assert parse_context_entities(FAKE_CONTEXT) == ["스타포스 강화", "모르는 개체", "cube", "메소", "파티 플레이"]
    cands = context_to_candidates(FAKE_CONTEXT, GRAPH, hl=["확률형 강화"], top_k=3)
    assert [c.id for c in cands] == ["starforce", "cube", "meso"]  # 라벨·id 모두로 찾고, 모르는 개체·중복은 뺀다
    assert cands[0].tag["label"] == "확률형 강화"  # hl 태그가 노드 태그에 있으면 맞은 태그
    assert cands[0].score > cands[1].score > cands[2].score
    assert all(c.source == "common" for c in cands)
    assert context_to_candidates("", GRAPH, hl=[], top_k=3) == []
    assert context_to_candidates("아무 맥락도 없음", GRAPH, hl=[], top_k=3) == []


def test_lightrag_retriever_queries_with_hybrid_context_only():
    from app.retriever import LightRAGRetriever

    class _FakeRag:
        def __init__(self):
            self.calls = []

        async def aquery(self, query, param=None, system_prompt=None):
            self.calls.append((query, param))
            return FAKE_CONTEXT

    rag = _FakeRag()
    r = LightRAGRetriever(rag=rag, graph=GRAPH)
    cands = asyncio.run(r.candidates("문장", ["확률형 강화"], ["강화"], top_k=2))
    assert [c.id for c in cands] == ["starforce", "cube"]
    query, param = rag.calls[0]
    assert query == "문장"
    assert param.mode == "hybrid"
    assert param.hl_keywords == ["확률형 강화"] and param.ll_keywords == ["강화"]
    assert param.only_need_context is True


def test_lightrag_retriever_without_index_raises():
    from app.retriever import LightRAGRetriever, RetrieverUnavailable

    with pytest.raises(RetrieverUnavailable):
        asyncio.run(LightRAGRetriever(rag=None, graph=GRAPH).candidates("문장", [], []))


# --- GeminiLLM (httpx 가짜 전송, 네트워크 없음) ---

def test_gemini_llm_request_and_text():
    from app.llm import GeminiLLM

    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [
            {"text": "생각 중", "thought": True}, {"text": '{"a": '}, {"text": "1}"}]}}]})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    llm = GeminiLLM(api_key="dummy-not-a-key", model="gemini-3.5-flash-lite", client=client)
    text = asyncio.run(llm.complete("시스템", "사용자", json=True))
    assert text == '{"a": 1}'
    req = seen[0]
    assert req.url.path.endswith("/models/gemini-3.5-flash-lite:generateContent")
    assert req.headers["x-goog-api-key"] == "dummy-not-a-key"
    body = json.loads(req.content)
    assert body["systemInstruction"]["parts"][0]["text"] == "시스템"
    assert body["contents"][0]["parts"][0]["text"] == "사용자"
    assert body["generationConfig"]["responseMimeType"] == "application/json"


def test_gemini_llm_retries_without_thinking_config_on_400():
    from app.llm import GeminiLLM

    bodies = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        bodies.append(body)
        if "thinkingConfig" in body["generationConfig"]:
            return httpx.Response(400, json={"error": {"message": "thinking is not supported"}})
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": "좋아요"}]}}]})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    llm = GeminiLLM(api_key="dummy-not-a-key", model="m", client=client)
    assert asyncio.run(llm.complete("s", "u", json=False)) == "좋아요"
    assert len(bodies) == 2 and "thinkingConfig" not in bodies[1]["generationConfig"]


def test_gemini_llm_error_status_raises_llm_error():
    from app.llm import GeminiLLM, LLMError

    client = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda r: httpx.Response(429, json={"error": {"message": "quota"}})))
    llm = GeminiLLM(api_key="dummy-not-a-key", model="m", client=client)
    with pytest.raises(LLMError) as e:
        asyncio.run(llm.complete("s", "u", json=False))
    assert e.value.status == 429


def test_settings_model_defaults(monkeypatch):
    for name in ("GEMINI_KEYWORD_MODEL", "GEMINI_ANALOGY_MODEL"):
        monkeypatch.delenv(name, raising=False)
    from app.config import Settings

    s = _settings()
    assert s.keyword_model == "gemini-3.5-flash-lite" and s.analogy_model == "gemini-3.5-flash-lite"
    monkeypatch.setenv("GEMINI_ANALOGY_MODEL", "gemini-3.8-flash")
    assert Settings.from_env().analogy_model == "gemini-3.8-flash"


# --- 오류는 항상 한국어 JSON (맨 500 금지) ---

def test_gemini_non_json_200_raises_llm_error_502():
    from app.llm import GeminiLLM, LLMError

    client = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda r: httpx.Response(200, text="<html>프록시 오류</html>")))
    llm = GeminiLLM(api_key="dummy-not-a-key", model="m", client=client)
    with pytest.raises(LLMError) as e:
        asyncio.run(llm.complete("s", "u", json=False))
    assert e.value.status == 502
    assert "Gemini" in str(e.value)


def test_gemini_non_json_200_endpoint_returns_json_502():
    from app.llm import GeminiLLM

    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, text="not json")))
    llm = GeminiLLM(api_key="dummy-not-a-key", model="m", client=client)
    c, *_ = _client(llm=llm)
    res = _post(c, "강화 문장이에요.")
    assert res.status_code == 502
    assert res.json() == {"error": "AI 서버를 부르지 못했어요. 잠시 뒤 다시 시도해 주세요."}


class _BrokenRag:
    async def aquery(self, query, param=None, system_prompt=None):
        raise RuntimeError("vector db down")


def test_lightrag_aquery_error_is_wrapped():
    from app.retriever import LightRAGRetriever, RetrieverError

    with pytest.raises(RetrieverError):
        asyncio.run(LightRAGRetriever(rag=_BrokenRag(), graph=GRAPH).candidates("문장", ["확률형 강화"], []))


def test_lightrag_aquery_error_endpoint_returns_json_502():
    from app.main import create_app

    app = create_app(deps={"settings": _settings(), "llm": FakeLLM(), "rag": _BrokenRag()})
    res = _post(TestClient(app, raise_server_exceptions=False), "강화 문장이에요.")
    assert res.status_code == 502
    assert res.json() == {"error": "검색 중에 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요."}


# --- LightRAG 자체 키워드 LLM을 부르지 않게(규칙 8·9) ---

def test_lightrag_never_gets_both_keyword_lists_empty():
    from app.retriever import LightRAGRetriever

    params = []

    class _Rag:
        async def aquery(self, query, param=None, system_prompt=None):
            params.append(param)
            return FAKE_CONTEXT

    r = LightRAGRetriever(rag=_Rag(), graph=GRAPH)
    asyncio.run(r.candidates("빈 키워드 문장", [], []))
    asyncio.run(r.candidates("hl만 있는 문장", ["확률형 강화"], []))
    for p in params:
        assert p.hl_keywords or p.ll_keywords
    assert params[0].hl_keywords == [] and params[0].ll_keywords == ["빈 키워드 문장"]
    assert params[1].ll_keywords == []  # 하나라도 있으면 그대로 둔다


def test_unexpected_error_is_korean_json_500():
    class _Boom:
        async def candidates(self, sentence, hl, ll, top_k=3):
            raise RuntimeError("예상 못 한 오류")

    from app.main import create_app

    app = create_app(deps={"settings": _settings(), "llm": FakeLLM(), "retriever": _Boom()})
    res = _post(TestClient(app, raise_server_exceptions=False), "강화 문장이에요.")
    assert res.status_code == 500
    assert res.json() == {"error": "서버에서 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요."}


def test_evidence_verified_at_is_none_without_field():
    """그래프 노드에 verifiedAt이 없으면 None(확장은 표시하지 않는다) (T-118)."""
    import copy as _copy

    from app.main import create_app

    graph = _copy.deepcopy(GRAPH)
    for n in graph["nodes"]:
        n.pop("verifiedAt", None)
    app = create_app(deps={"settings": _settings(), "llm": FakeLLM(), "retriever": FakeRetriever(graph), "graph": graph})
    body = TestClient(app).post("/v1/analogy", json={"sentence": "강화할 때마다 확률이 낮아지는 구조예요."}, headers=TOKEN).json()
    assert body["evidence"] is not None
    assert body["evidence"]["verifiedAt"] is None
