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
def vocab() -> list[str]:
    return build_extraction_config(load_common_graph(COMMON_GRAPH))["vocabulary"]


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


def _row(game, linked, ents=4, rels=2, secs=10.0, other=0, outside=0, raw=4, copied=()):
    return {"seconds": secs, "promptTokens": 3000, "outputTokens": 500, "metrics": {
        "entities": ents, "relationships": rels, "rawEntities": raw, "rawRelationships": rels,
        "typeOther": other, "typeOutside": outside, "dropped": 0, "gameEntities": game,
        "linkedGame": linked, "tags": 1, "copiedExamples": list(copied), "ungroundedGame": 0, "seedNameHits": []}}


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
    assert ab.choose_default({"a": slow_good, "b": good, "c": low_link}) == "b"  # 연결률 같으면 빠른 쪽
    assert ab.choose_default({"c": low_link, "d": fails}) is None


def test_format_table_has_row_per_combo():
    s = {ab.combo_key("gemma4:12b", False): ab.summarize([_row(10, 8)] * 2)}
    table = ab.format_table(s, {ab.combo_key("gemma4:12b", False): {"psSize": 9.6e9, "rss": 4e8}})
    lines = table.splitlines()
    assert len(lines) == 3 and "gemma4:12b think=off" in lines[2]
    assert "9.6GB" in lines[2] and "통과" in lines[2]


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
