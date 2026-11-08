"""프롬프트 이식 테스트. 확장 prompt.js와 규칙 문장이 같은지, 후보 서식, 키워드 파싱을 확인한다."""
from pathlib import Path

import pytest

from app.config import load_common_graph
from app.prompts import (
    analogy_system_section,
    analogy_system_static_fragments,
    build_analogy_prompt,
    build_keyword_prompt,
    missing_fragments,
    parse_keywords,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
PROMPT_JS = REPO_ROOT / "extension" / "lib" / "prompt.js"
COMMON_GRAPH = REPO_ROOT / "extension" / "data" / "common" / "maplestory.json"


def _js_text() -> str:
    return PROMPT_JS.read_text(encoding="utf-8")


def _graph_tags() -> list[dict]:
    return load_common_graph(COMMON_GRAPH)["tags"]  # 원본은 tags.json(T-304)


CANDIDATES = [
    {
        "id": "starforce",
        "label": "스타포스 강화",
        "tag": {"id": "prob_upgrade", "label": "확률형 강화", "desc": "확률로 갈리는 구조"},
        "otherTags": ["단계별 비용 증가", "손실 위험"],
        "facts": ["메소를 내고 별을 붙인다.", "별이 높을수록 비싸다."],
        "neighbors": [{"label": "메소", "rel": "비용"}],
    },
    {
        "id": "u:note",
        "label": "사용자 메모",
        "tag": None,
        "otherTags": [],
        "facts": ["사용자가 적은 사실이다."],
        "neighbors": [],
    },
]


def _build(**overrides):
    args = dict(
        sentence="금리가 오르면 대출 이자가 커진다.",
        context="앞 문장이에요.",
        word="금리",
        page_title="경제 뉴스",
        domain="메이플스토리",
        analogy_prefix="메이플로 치면",
        candidates=CANDIDATES,
    )
    args.update(overrides)
    return build_analogy_prompt(**args)


# --- 규칙 비교 ---

def test_static_fragments_are_not_trivial():
    frags = analogy_system_static_fragments()
    # 규칙 줄 8개 + 머리 + 출력 형식 + mapping 줄. 치환 자리 앞뒤로 쪼개져 더 많다.
    assert len(frags) >= 11
    assert "억지 비유는 틀린 설명보다 나쁘다." in "".join(frags)
    assert any(f.startswith("출력 형식: {") for f in frags)
    assert all(f.strip() for f in frags)


def test_static_fragments_appear_in_built_system_prompt():
    system, _ = _build()
    for frag in analogy_system_static_fragments():
        assert frag in system


def test_missing_section_reports_every_fragment():
    assert missing_fragments("") == analogy_system_static_fragments()


def test_rules_match_extension_prompt_js():
    assert missing_fragments(_js_text()) == []


def test_rule_comparison_fails_when_prompt_js_changes_by_one_char():
    js = _js_text()
    target = "억지 비유는 틀린 설명보다 나쁘다."
    assert target in js
    assert missing_fragments(js.replace(target, "억지 비유는 틀린 설명보다 나쁘다!")) != []


def test_every_fragment_is_checked_against_prompt_js():
    # 고정 문구마다 한 글자씩 바꿔 보아, 어느 줄이 바뀌어도 비교가 실패하는지 확인한다.
    js = _js_text()
    section_start = js.index(analogy_system_section(js))
    for frag in analogy_system_static_fragments():
        idx = js.index(frag, section_start)
        mid = idx + len(frag) // 2
        changed = js[:mid] + ("X" if js[mid] != "X" else "Y") + js[mid + 1:]
        assert frag in missing_fragments(changed), frag


def test_prompt_forbids_slurs_and_real_people_without_listing_terms():
    # 규칙 11: 규칙 문장만 넣고 금칙어 자체는 프롬프트에 넣지 않는다
    import json as _j
    system, _ = _build()
    assert "커뮤니티 멸칭이나 실존 인물 이름·별명은 쓰지 않는다." in system
    bl = _j.loads((Path(__file__).resolve().parents[2] / "extension/data/common/blocklist.json").read_text("utf-8"))
    for card in bl["terms"]:
        for t in [card["term"], *card["variants"]]:
            assert t not in system and t not in _js_text()


def test_system_prompt_substitutes_domain_and_prefix():
    system, _ = _build(domain="요리", analogy_prefix="요리로 치면")
    assert '잘 아는 "요리"에 빗대' in system
    assert '"요리로 치면" 문구로 시작' in system
    assert "근거에 없는 요리의 수치, 이름, 규칙을 지어내지 않는다." in system


# --- 후보 서식 ---

def test_candidate_formatting_matches_js():
    _, user = _build()
    expected = "\n".join([
        "페이지 제목: 경제 뉴스",
        "앞 문장: 앞 문장이에요.",
        "설명할 문장: 금리가 오르면 대출 이자가 커진다.",
        "커서가 가리킨 단어: 금리",
        "[근거]",
        "[1] id=starforce | 스타포스 강화",
        "  맞은 추상 태그: 확률형 강화 (id=prob_upgrade) — 확률로 갈리는 구조",
        "  다른 태그: 단계별 비용 증가, 손실 위험",
        "  facts:",
        "   - 메소를 내고 별을 붙인다.",
        "   - 별이 높을수록 비싸다.",
        "  neighbors: 메소(비용)",
        "[2] id=u:note | 사용자 메모",
        "  facts:",
        "   - 사용자가 적은 사실이다.",
    ])
    assert user == expected


def test_user_prompt_omits_empty_optional_lines():
    _, user = _build(context="", word="", page_title="")
    assert user.splitlines()[:2] == ["페이지 제목: (제목 없음)", "설명할 문장: 금리가 오르면 대출 이자가 커진다."]
    assert "앞 문장" not in user
    assert "커서가 가리킨 단어" not in user


# --- 키워드 프롬프트 ---

def test_keyword_prompt_lists_graph_tags_and_json_format():
    tags = _graph_tags()
    system, user = build_keyword_prompt("금리가 오르면 이자가 커진다.", "경제 뉴스", tags)
    for t in tags:
        assert t["label"] in system
    assert '{"hl_keywords": [' in system
    assert "ll_keywords" in system
    assert "금리가 오르면 이자가 커진다." in user
    assert "경제 뉴스" in user


def test_keyword_prompt_has_no_tags_outside_given_list():
    tags = [{"id": "a", "label": "가짜 태그", "desc": "설명"}]
    system, _ = build_keyword_prompt("문장", "", tags)
    assert "가짜 태그" in system
    assert "확률형 강화" not in system


def test_keyword_prompt_rejects_empty_tag_list():
    with pytest.raises(ValueError):
        build_keyword_prompt("문장", "", [])


# --- 키워드 파싱 ---

ALLOWED = ["확률형 강화", "단계별 비용 증가"]


def test_parse_keywords_plain_json():
    hl, ll = parse_keywords('{"hl_keywords": ["확률형 강화"], "ll_keywords": ["금리", "이자"]}', ALLOWED)
    assert hl == ["확률형 강화"]
    assert ll == ["금리", "이자"]


def test_parse_keywords_drops_tags_outside_list():
    text = '{"hl_keywords": ["확률형 강화", "지어낸 태그", "단계별 비용 증가"], "ll_keywords": ["금리"]}'
    hl, _ = parse_keywords(text, ALLOWED)
    assert hl == ["확률형 강화", "단계별 비용 증가"]


def test_parse_keywords_code_block():
    text = '```json\n{"hl_keywords": ["단계별 비용 증가"], "ll_keywords": ["대출"]}\n```'
    assert parse_keywords(text, ALLOWED) == (["단계별 비용 증가"], ["대출"])


def test_parse_keywords_preamble_text():
    text = '키워드예요:\n{"hl_keywords": [], "ll_keywords": ["대출"]} 끝'
    assert parse_keywords(text, ALLOWED) == ([], ["대출"])


def test_parse_keywords_dedup_and_strip():
    text = '{"hl_keywords": [" 확률형 강화 ", "확률형 강화"], "ll_keywords": ["금리", " 금리", "", 3]}'
    assert parse_keywords(text, ALLOWED) == (["확률형 강화"], ["금리"])


@pytest.mark.parametrize("text", ["", "아무 말", "{깨진 json", '["배열"]', '{"hl_keywords": "문자열"}'])
def test_parse_keywords_bad_input_returns_empty(text):
    assert parse_keywords(text, ALLOWED) == ([], [])


# --- usedFact 규칙 (T-123) ---

def test_system_prompt_has_used_fact_rule_and_field_order():
    system, _ = _build(domain="요리")
    assert "필드는 meaning, analogy, nodeId, tagId, usedFact, mapping 순서로 쓴다." in system
    assert ("7. analogy에 쓴 요리 쪽 사실은 고른 후보의 facts 문장 하나를 usedFact에 글자 그대로 옮긴다. "
            "비유가 없으면 usedFact는 빈 문자열이다.") in system
    assert '"tagId": string|null, "usedFact": string, "mapping": string}' in system
    # 뜻 먼저 스트리밍(T-117): meaning이 맨 앞
    fmt = next(line for line in system.splitlines() if line.startswith("출력 형식:"))
    assert fmt.index('"meaning"') < fmt.index('"usedFact"')
    # 규칙 1은 그대로
    assert "근거에 없는 요리의 수치, 이름, 규칙을 지어내지 않는다." in system
