"""금칙어 필터 테스트(T-114). 확장 extension/lib/blocklist.js와 같은 공유 사례로 같은 결과를 낸다."""
import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CASES = json.loads((REPO_ROOT / "tests/fixtures/blocklist-cases.json").read_text("utf-8"))
BLOCKLIST_FILE = REPO_ROOT / "extension/data/common/blocklist.json"
BLOCKLIST = json.loads(BLOCKLIST_FILE.read_text("utf-8"))


def test_rejected_text_matches_extension():
    from app.blocklist import BLOCKED_REJECTED_TEXT

    assert BLOCKED_REJECTED_TEXT == "부적절한 표현이 섞여 있어서 비유를 숨겼어요."


def test_normalize_shared_cases():
    from app.blocklist import normalize_for_block

    for case in CASES["normalize"]:
        assert normalize_for_block(case["input"]) == case["output"], case["input"]


def test_find_shared_cases_with_real_blocklist():
    from app.blocklist import find_blocked

    for case in CASES["find"]:
        assert find_blocked(case["text"], BLOCKLIST["terms"]) == case["expect"], case["text"]


def test_only_approved_terms_are_used():
    from app.blocklist import active_terms, find_blocked

    def card(status=None):
        c = {"term": "가나다라", "variants": ["가나 우회"]}
        if status:
            c["status"] = status
        return c

    assert find_blocked("가나다라", [card("승인")]) == "가나다라"
    assert find_blocked("가나우회", [card("승인")]) == "가나다라"
    for status in ("제안", "폐기", None):
        assert find_blocked("가나다라", [card(status)]) is None
    assert [c["term"] for c in active_terms({"terms": [card("승인"), card("제안")]})] == ["가나다라"]
    assert active_terms(None) == []


def test_empty_term_or_punctuation_variant_never_matches():
    from app.blocklist import find_blocked

    assert find_blocked("아무 문장이에요.", [{"term": "", "variants": ["...", " "], "status": "승인"}]) is None
    assert find_blocked("", BLOCKLIST["terms"]) is None
    assert find_blocked(None, BLOCKLIST["terms"]) is None


def test_load_blocklist_reads_file_and_missing_file_is_empty(tmp_path):
    from app.blocklist import load_blocklist

    terms = load_blocklist(BLOCKLIST_FILE)
    assert terms and all(c["status"] == "승인" for c in terms)
    assert load_blocklist(tmp_path / "없음.json") == []


def test_default_blocklist_path_is_next_to_common_graph():
    from app.config import DEFAULT_BLOCKLIST_PATH, DEFAULT_COMMON_GRAPH_PATH, Settings

    assert DEFAULT_BLOCKLIST_PATH.resolve() == BLOCKLIST_FILE.resolve()
    assert DEFAULT_BLOCKLIST_PATH.parent == DEFAULT_COMMON_GRAPH_PATH.parent
    assert Settings.from_env({}).blocklist_path == str(DEFAULT_BLOCKLIST_PATH)
    assert Settings.from_env({"BLOCKLIST_PATH": "/x/b.json"}).blocklist_path == "/x/b.json"
