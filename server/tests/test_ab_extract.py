"""20청크 추출 A/B 하네스(T-413) 순수 함수 테스트. 네트워크·Ollama 호출 없음."""
import json
from pathlib import Path

import pytest

from app.config import load_common_graph
from app.extract import build_extraction_config
from tools import ab_extract as ab

REPO_ROOT = Path(__file__).resolve().parents[2]
COMMON_GRAPH = REPO_ROOT / "extension" / "data" / "common" / "maplestory.json"


@pytest.fixture(scope="module")
def graph() -> dict:
    return load_common_graph(COMMON_GRAPH)


@pytest.fixture(scope="module")
def vocab(graph) -> list[str]:
    return build_extraction_config(graph)["vocabulary"]


def test_html_to_text_takes_only_target_block_and_skips_script():
    html = """<div class="top">메뉴</div>
    <div class="guide_content"><h3>스타포스</h3><p>메소를&nbsp;써서 <b>강화</b></p>
    <script>var x = 1;</script><div><p>파괴될 수 있음</p></div></div>
    <div class="reply_text">댓글은 빼야 해요</div>"""
    text = ab.html_to_text(html, "guide_content")
    assert text.splitlines()[0] == "스타포스"
    assert "메소를 써서 강화" in text and "파괴될 수 있음" in text
    assert "메뉴" not in text and "var x" not in text and "댓글" not in text


def test_pick_chunk_counts_distinct_terms_and_prefers_earlier_on_tie():
    terms = ["스타포스 강화", "메소", "결정석"]
    chunks = ["메소 메소 메소 메소", "스타포스강화에 메소를 쓰고 결정석을 판다", "메소와 결정석"]
    assert ab.pick_chunk(chunks, terms) == 1  # 되풀이보다 종류 수, 띄어쓰기 무시
    assert ab.pick_chunk(["메소", "결정석"], terms) == 0


def test_example_entity_names_are_game_entities_from_prompt_examples():
    names = ab.example_entity_names()
    assert {"스타포스 강화", "메소", "주간 보스", "결정석"} <= names
    assert "확률형 강화" not in names  # 추상구조는 통제 어휘라 베끼기 검사에서 뺀다


def test_chunk_metrics_link_rate_types_and_example_copy(vocab):
    text = "몬스터파크는 하루 입장 횟수가 정해진 사냥터다. 메소를 내고 입장한다."
    ents = [
        {"name": "몬스터파크", "type": "게임시스템"},
        {"name": "메소", "type": "재화"},
        {"name": "결정석", "type": "아이템"},  # 원문에 없는 예시 엔티티(베낌)
        {"name": "기간당 한도", "type": "추상구조"},
        {"name": "목록밖구조", "type": "추상구조"},  # 후처리가 버림(목록 밖 추상구조)
        {"name": "입장권", "type": "Other"},  # 후처리가 버림(목록 밖 유형, T-413)
        {"name": "사냥", "type": "활동"},
    ]
    rels = [
        {"source": "몬스터파크", "target": "기간당 한도"},
        {"source": "메소", "target": "목록밖구조"},  # 버려진 엔티티와의 관계도 버림
        {"source": "결정석", "target": "확률형 강화"},  # 엔티티로 선언 안 했어도 통제 어휘 끝이면 연결
    ]
    m = ab.chunk_metrics(text, ents, rels, vocab, seed_labels=["몬스터 파크", "메소"],
                         example_names=ab.example_entity_names())
    assert m["rawEntities"] == 7 and m["entities"] == 4 and m["dropped"] == 3  # 목록밖구조·Other·활동
    assert m["relationships"] == 2
    assert m["typeOther"] == 1 and m["typeOutside"] == 2
    # 게임 개념 = 몬스터파크·메소·결정석(Other·활동은 목록 밖이라 뺌), 연결 = 몬스터파크·결정석
    assert m["gameEntities"] == 3 and m["linkedGame"] == 2 and m["tags"] == 1
    assert m["copiedExamples"] == ["결정석"]  # 메소는 원문에 있어 베낌이 아니다
    assert m["ungroundedGame"] == 1
    assert m["seedNameHits"] == ["메소"]


def test_chunk_metrics_relationship_direction_and_type_normalized(vocab):
    # 유형은 LightRAG처럼 공백을 지워 비교하고, 관계는 방향과 상관없이 연결로 센다
    ents = [{"name": "스타포스 강화", "type": "게임 시스템"}, {"name": "확률형 강화", "type": "추상구조"}]
    rels = [{"source": "확률형 강화", "target": "스타포스 강화"}]
    m = ab.chunk_metrics("스타포스 강화", ents, rels, vocab)
    assert m["gameEntities"] == 1 and m["linkedGame"] == 1


def _row(game, linked, ents=4, rels=2, secs=10.0, other=0, outside=0, raw=4, copied=(), systems=None,
         linked_sys=None, gp=0, ga=0, json_mode=None):
    """systems·linked_sys를 안 주면 게임 개념이 모두 게임시스템인 청크로 본다."""
    return {"seconds": secs, "promptTokens": 3000, "outputTokens": 500, "jsonMode": json_mode, "metrics": {
        "entities": ents, "relationships": rels, "rawEntities": raw, "rawRelationships": rels,
        "typeOther": other, "typeOutside": outside, "dropped": 0, "gameEntities": game,
        "linkedGame": linked, "gameSystems": game if systems is None else systems,
        "linkedSystems": linked if linked_sys is None else linked_sys, "graphPairs": gp, "graphAgree": ga,
        "tags": 1, "copiedExamples": list(copied), "ungroundedGame": 0, "seedNameHits": []}}


def test_summarize_pools_link_rate_and_excludes_failures():
    rows = [_row(4, 3), _row(6, 4, other=1, outside=2, raw=10, copied=["결정석"]),
            {"seconds": 600.0, "error": "ReadTimeout"}]
    s = ab.summarize(rows)
    assert s["chunks"] == 3 and s["parseFail"] == 1 and s["parseFailRate"] == pytest.approx(1 / 3)
    assert s["linkRate"] == pytest.approx(7 / 10) and s["chunksWithLink"] == 2
    assert s["entitiesPerChunk"] == 4 and s["relationshipsPerChunk"] == 2
    assert s["typeOtherRate"] == pytest.approx(1 / 14) and s["typeOutsideRate"] == pytest.approx(2 / 14)
    assert s["copiedExamples"] == 1
    assert s["secondsPerChunk"] == pytest.approx(620 / 3) and s["secondsMax"] == 600


def test_passes_and_choose_default():
    good = ab.summarize([_row(10, 8)] * 20)
    slow_good = ab.summarize([_row(10, 8, secs=50)] * 20)
    low_link = ab.summarize([_row(10, 6)] * 20)
    fails = ab.summarize([_row(10, 9)] * 18 + [{"seconds": 1, "error": "parse"}] * 2)  # 10% 실패
    assert ab.passes(good) and not ab.passes(low_link) and not ab.passes(fails)
    assert ab.passes(ab.summarize([_row(10, 7)] * 19 + [{"seconds": 1, "error": "x"}]))  # 경계: 5%·70%
    assert ab.gate_misses(good) == [] and ab.gate_misses(fails) == ["파싱"]
    assert ab.choose_default({"a": slow_good, "b": good, "c": low_link}) == "b"  # 연결률 같으면 빠른 쪽
    assert ab.choose_default({"c": low_link, "d": fails}) is None


def test_gate_uses_system_link_rate_not_all_entities():
    """T-209 관문: 분모는 게임시스템만. 아이템·지역 나열이 많아도 시스템이 이어져 있으면 통과."""
    # 청크마다 게임 개념 10개(시스템 2 + 아이템·지역 8), 시스템 2개 모두 연결 → 전체 20%, 시스템 100%
    s = ab.summarize([_row(10, 2, systems=2, linked_sys=2)] * 20)
    assert s["linkRate"] == pytest.approx(0.2) and s["systemLinkRate"] == 1.0
    assert ab.passes(s)
    # 반대로 아이템만 잔뜩 잇고 시스템은 안 이으면 전체 연결률이 높아도 미달
    s = ab.summarize([_row(10, 8, systems=2, linked_sys=0)] * 20)
    assert s["linkRate"] == pytest.approx(0.8) and not ab.passes(s) and ab.gate_misses(s) == ["시스템 연결"]


def test_gate_requires_chunk_coverage():
    """시스템을 거의 안 뽑아 비율만 높은 조합을 막는다: 태그 연결 청크가 80% 미만이면 미달."""
    rows = [_row(3, 1, systems=1, linked_sys=1)] * 15 + [_row(3, 0, systems=0, linked_sys=0)] * 5
    s = ab.summarize(rows)
    assert s["systemLinkRate"] == 1.0 and s["chunkLinkRate"] == pytest.approx(0.75)
    assert not ab.passes(s) and ab.gate_misses(s) == ["청크"]
    assert ab.passes(ab.summarize([_row(3, 1, systems=1, linked_sys=1)] * 16 + [_row(3, 0, systems=0, linked_sys=0)] * 4))


def test_summarize_graph_agree_and_json_mode():
    s = ab.summarize([_row(4, 3, gp=3, ga=2, json_mode=True), _row(4, 3, gp=1, ga=0, json_mode=False),
                      {"seconds": 1, "error": "parse", "jsonMode": True}])
    assert s["graphPairs"] == 4 and s["graphAgree"] == 2 and s["graphAgreeRate"] == 0.5
    assert s["jsonModeChunks"] == 2  # 실패한 청크도 JSON 모드로 보냈으면 센다


def test_chunk_metrics_counts_systems_and_graph_agreement(vocab, graph):
    known = ab.graph_tag_pairs(graph)
    text = "스타포스 강화는 메소를 내고 별을 붙인다. 버닝 필드는 추가 경험치를 준다. 솔 에르다가 필요하다."
    ents = [
        {"name": "스타포스 강화", "type": "게임시스템"},
        {"name": "버닝 필드", "type": "게임시스템"},
        {"name": "솔 에르다", "type": "아이템"},
        {"name": "솔 에르다", "type": "게임시스템"},  # 같은 이름을 시스템으로도 선언하면 시스템으로 센다
        {"name": "메소", "type": "재화"},
    ]
    rels = [
        {"source": "스타포스 강화", "target": "확률형 강화"},  # 그래프 starforce tags에 있음
        {"source": "스타포스 강화", "target": "최소 요구 조건"},  # 그래프에 없는 짝
        {"source": "확률형 강화", "target": "스타포스 강화"},  # 방향만 반대인 같은 짝은 한 번
        {"source": "메소", "target": "화폐 가치 하락"},  # 메소 tags에 있음, 재화라 시스템 연결은 아님
    ]
    m = ab.chunk_metrics(text, ents, rels, vocab, known_pairs=known)
    assert m["gameSystems"] == 3 and m["linkedSystems"] == 1
    assert m["gameEntities"] == 4 and m["linkedGame"] == 2
    assert m["graphPairs"] == 3 and m["graphAgree"] == 2
    # known_pairs가 없으면 그래프 일치는 0
    assert ab.chunk_metrics(text, ents, rels, vocab)["graphPairs"] == 0


def test_graph_tag_pairs_maps_labels_and_aliases_to_tag_labels(graph):
    known = ab.graph_tag_pairs(graph)
    assert {"확률형강화", "단계별비용증가"} <= known["스타포스강화"]
    assert known["프텍"] == known["스타포스강화"]  # 별칭도 같은 태그
    assert "시간당효율" in known["주간보스와결정석"]


def test_combo_key_keeps_v1_key_and_suffixes_other_prompts():
    assert ab.combo_key("gemma4:12b", False) == "gemma4:12b think=off"  # T-413·T-185 결과 줄과 같은 키
    assert ab.combo_key("gemma4:12b", False, "v1") == "gemma4:12b think=off"
    assert ab.combo_key("gemma4:12b-it-qat", False, "v2") == "gemma4:12b-it-qat think=off prompt=v2"


def test_example_entity_names_per_prompt():
    assert "파티" in ab.example_entity_names("v2") and "파티" not in ab.example_entity_names("v1")
    assert "확률형 강화" not in ab.example_entity_names("v2")


def test_main_rejects_unknown_prompt(tmp_path):
    with pytest.raises(SystemExit):
        ab.main(["--prompt", "v9", "--out", str(tmp_path)])


def test_format_table_has_row_per_combo():
    s = {ab.combo_key("gemma4:12b", False): ab.summarize([_row(10, 8)] * 2)}
    table = ab.format_table(s, {ab.combo_key("gemma4:12b", False): {"psSize": 9.6e9, "rss": 4e8}})
    lines = table.splitlines()
    assert len(lines) == 3 and "gemma4:12b think=off" in lines[2]
    assert "9.6GB" in lines[2] and "통과" in lines[2]
    s = {ab.combo_key("qwen3.5:9b", False): ab.summarize([_row(10, 8, systems=4, linked_sys=1)] * 2)}
    assert "미달(시스템 연결)" in ab.format_table(s).splitlines()[2]


def test_fixture_is_official_sources_only_and_chunk_sized():
    data = json.loads(ab.FIXTURE.read_text(encoding="utf-8"))
    chunks = data["chunks"]
    assert len(chunks) == 20 and len({c["id"] for c in chunks}) == 20
    assert sum(c["kind"] == "guide" for c in chunks) == 14 and sum(c["kind"] == "patch" for c in chunks) == 6
    for c in chunks:
        assert c["url"].startswith("https://maplestory.nexon.com/")  # D-5: 공식 출처만
        assert 0 < len(c["text"]) <= 1200  # 운영 청크 크기(chunk_text)


def test_hopeless_when_failures_exceed_allowed():
    # 20청크 × 5% = 1개까지 허용
    assert not ab.hopeless(1, 20) and ab.hopeless(2, 20)
    assert ab.hopeless(1, 10)  # 10청크면 0개 허용


def test_pending_chunks_skips_rows_already_recorded_for_that_combo():
    chunks = [{"id": "a"}, {"id": "b"}, {"id": "c"}]
    on, off = ab.combo_key("gemma4:12b", True), ab.combo_key("gemma4:12b", False)
    rows = [{"combo": on, "chunk": "a"}, {"combo": on, "chunk": "c", "error": "ReadTimeout"},
            {"combo": off, "chunk": "b"}]
    # 실패 줄도 기록된 것이라 다시 돌리지 않는다(결과를 덮지 않게). 다른 조합 줄은 상관없다
    assert [c["id"] for c in ab.pending_chunks(chunks, rows, on)] == ["b"]
    assert [c["id"] for c in ab.pending_chunks(chunks, rows, off)] == ["a", "c"]
    assert ab.pending_chunks(chunks, [], ab.combo_key("qwen3.5:9b", True)) == chunks


def test_run_one_records_json_mode_from_chat():
    async def chat(text):
        return {"message": {"content": '{"entities": [], "relationships": []}'}, "eval_count": 3}

    chat.json_mode = lambda: True
    r = ab.run_one(chat, "글")
    assert r["jsonMode"] is True and r["entitiesRaw"] == [] and "error" not in r

    async def plain(text):
        return {"message": {"content": "아님"}}

    r = ab.run_one(plain, "글")
    assert r["jsonMode"] is None and r["error"].startswith("parse")


def test_deadline_from_next_occurrence_crosses_midnight():
    from datetime import datetime

    assert ab.deadline_from(datetime(2026, 11, 23, 23, 5), "06:40") == datetime(2026, 11, 24, 6, 40)
    assert ab.deadline_from(datetime(2026, 11, 24, 1, 0), "06:40") == datetime(2026, 11, 24, 6, 40)
    with pytest.raises(ValueError):
        ab.deadline_from(datetime(2026, 11, 24, 1, 0), "25:00")


def test_should_abort_on_lost_connection_or_config_but_not_timeout():
    import httpx

    from app.extract_worker import ExtractConfigError, ExtractConnectionError

    def wrapped(cause):
        try:
            raise ExtractConnectionError("끊김") from cause
        except ExtractConnectionError as e:
            return e

    assert ab.should_abort(wrapped(httpx.ConnectError("refused")))
    assert ab.should_abort(ExtractConfigError("404 모델 없음"))
    assert not ab.should_abort(wrapped(httpx.ReadTimeout("느림")))  # 느린 건 그 청크 실패로 센다
    assert not ab.should_abort(ValueError("parse"))


def test_run_one_marks_abort_without_hiding_error():
    import httpx

    from app.extract_worker import ExtractConnectionError

    async def down(text):
        raise ExtractConnectionError("맥 Ollama 연결이 끊겼어요") from httpx.ConnectError("refused")

    r = ab.run_one(down, "글")
    assert r["abort"] is True and "ExtractConnectionError" in r["error"]


def test_run_ab_prompts_resume_abort_and_deadline(tmp_path):
    """가짜 Ollama로 run_ab: 프롬프트별 조합 키·줄, 이어 돌리기, 모델 없음(404)·마감이면 줄 없이 멈춤(T-209)."""
    from datetime import datetime, timedelta

    from tests.test_extract_worker import FakeOllama

    fake = FakeOllama()
    fake.start()
    try:
        ab.run_ab(["m"], [False], 2, tmp_path, base=fake.url, prompts=["v1", "v2"])
        rows = ab._load_rows(tmp_path / "rows.jsonl")
        assert [(r["combo"], r["prompt"]) for r in rows] == [("m think=off", "v1")] * 2 + [("m think=off prompt=v2", "v2")] * 2
        assert all(r["jsonMode"] is True and not r.get("error") for r in rows)
        systems = [c["messages"][0]["content"] for c in fake.chat_calls]
        assert sum("[관계 규칙]" in s for s in systems) == 3  # v2 데움 1 + 청크 2
        calls = len(fake.chat_calls)
        ab.run_ab(["m"], [False], 2, tmp_path, base=fake.url, prompts=["v1", "v2"])  # 이어 돌리기: 할 것 없음
        assert len(fake.chat_calls) == calls
        ab.run_ab(["p"], [False], 2, tmp_path, base=fake.url, deadline=datetime.now() - timedelta(minutes=1))
        assert len(fake.chat_calls) == calls  # 마감이 지나 시작하지 않음
        fake.chat_status = 404  # 모델을 안 받음
        ab.run_ab(["n"], [False], 2, tmp_path, base=fake.url)
        assert len(ab._load_rows(tmp_path / "rows.jsonl")) == 4  # 실패 줄을 남기지 않음
    finally:
        fake.stop()
