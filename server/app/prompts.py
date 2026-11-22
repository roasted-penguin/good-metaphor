"""프롬프트. 비유 프롬프트는 확장 extension/lib/prompt.js의 buildAnalogyPrompt를 그대로 옮긴 것이다.

규칙 문장을 고치면 prompt.js도 함께 고친다(tests/test_prompts.py가 두 파일의 고정 문구를 비교한다).
핵심 규칙: 관심사 쪽 내용은 [근거]에 있는 사실만 쓴다(규칙 1). 쓴 사실은 usedFact로 옮긴다(규칙 7, T-123).
"""
from __future__ import annotations

import json
import re
from typing import Any, Iterable, Mapping

# 치환 자리. prompt.js의 ${domain}, ${analogyPrefix}에 해당한다.
_DOMAIN = "{domain}"
_PREFIX = "{prefix}"

_ANALOGY_SYSTEM_LINES = [
    f'너는 사용자가 이해하기 어려워하는 문장을, 사용자가 잘 아는 "{_DOMAIN}"에 빗대 짧게 설명하는 도우미다.',
    "규칙:",
    f"1. {_DOMAIN}에 관한 내용은 아래 [근거] 후보의 사실(facts)과 연결(neighbors)만 쓴다. 근거에 없는 {_DOMAIN}의 수치, 이름, 규칙을 지어내지 않는다.",
    "2. 후보 중 원문 개념과 추상 구조(태그)가 가장 잘 맞는 하나를 고른다. 겉보기 단어가 비슷한 것보다 구조가 같은 것을 우선한다.",
    "3. 구조가 맞는 후보가 없으면 analogy를 빈 문자열로 두고 nodeId를 null로 둔다. 억지 비유는 틀린 설명보다 나쁘다.",
    f'4. analogy는 "{_PREFIX}" 문구로 시작하는 1~2문장, 120자 안쪽. 원문과 {_DOMAIN}의 어떤 부분이 대응하는지 드러나게 쓴다.',
    "5. meaning은 원문 문장의 뜻을 중학생도 알 쉬운 말로 1문장. 원문이 영어여도 한국어로 쓴다.",
    "6. meaning과 analogy의 모든 문장은 해요체(~요)로 끝낸다. ~습니다·~ㅂ니다(합쇼체)나 ~다(해라체)는 어떤 경우에도 쓰지 않는다. JSON 객체만 출력한다. 필드는 meaning, analogy, nodeId, tagId, usedFact, mapping 순서로 쓴다.",
    f"7. analogy에 쓴 {_DOMAIN} 쪽 사실은 고른 후보의 facts 문장 하나를 usedFact에 글자 그대로 옮긴다. 비유가 없으면 usedFact는 빈 문자열이다.",
    "8. 커뮤니티 멸칭이나 실존 인물 이름·별명은 쓰지 않는다.",
    '출력 형식: {"meaning": string, "analogy": string, "nodeId": string|null, "tagId": string|null, "usedFact": string, "mapping": string}',
    'mapping은 "원문 개념 ↔ 관심사 개념" 형태의 짧은 대응 한 줄이다.',
    '끝맺음 예: "보상이 줄어들어요."(O) / "보상이 줄어듭니다."(X) / "보상이 줄어든다."(X)',
]


def analogy_system_static_fragments() -> list[str]:
    """비유 system 프롬프트에서 치환 자리를 뺀 고정 문구 조각들(규칙 비교 테스트용)."""
    frags: list[str] = []
    for line in _ANALOGY_SYSTEM_LINES:
        for part in re.split(r"\{domain\}|\{prefix\}", line):
            if part.strip():
                frags.append(part)
    return frags


def analogy_system_section(js_text: str) -> str:
    """prompt.js에서 buildAnalogyPrompt의 system 배열 부분만 잘라 낸다. 못 찾으면 빈 문자열.

    파일 전체와 비교하면 "규칙:"처럼 짧은 조각이 다른 함수 문장에 우연히 걸릴 수 있어 범위를 좁힌다.
    """
    start = js_text.find("export function buildAnalogyPrompt")
    if start == -1:
        return ""
    end = js_text.find("].join(", start)
    return js_text[start:end] if end != -1 else ""


def missing_fragments(js_text: str) -> list[str]:
    """고정 문구 중 prompt.js의 buildAnalogyPrompt system 부분에 그대로 없는 것. 빈 목록이면 규칙이 같다."""
    section = analogy_system_section(js_text)
    return [f for f in analogy_system_static_fragments() if f not in section]


def _field(obj: Any, name: str, default: Any = None) -> Any:
    """후보가 dict여도, 속성을 가진 객체(dataclass 등)여도 값을 꺼낸다."""
    if isinstance(obj, Mapping):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _format_candidate(i: int, c: Any) -> str:
    tag = _field(c, "tag")
    other_tags = _field(c, "otherTags") or []
    facts = _field(c, "facts") or []
    neighbors = _field(c, "neighbors") or []
    lines = [
        f"[{i}] id={_field(c, 'id')} | {_field(c, 'label')}",
        f"  맞은 추상 태그: {_field(tag, 'label')} (id={_field(tag, 'id')}) — {_field(tag, 'desc')}" if tag else "",
        f"  다른 태그: {', '.join(other_tags)}" if other_tags else "",
        "  facts:",
        *[f"   - {f}" for f in facts],
        "  neighbors: " + "; ".join(f"{_field(n, 'label')}({_field(n, 'rel')})" for n in neighbors) if neighbors else "",
    ]
    return "\n".join(s for s in lines if s)


def build_analogy_prompt(sentence: str, context: str | None, word: str | None, page_title: str | None,
                         domain: str, analogy_prefix: str, candidates: Iterable[Any]) -> tuple[str, str]:
    """(system, user). prompt.js buildAnalogyPrompt와 같은 문장·서식."""
    system = "\n".join(
        line.replace(_DOMAIN, domain).replace(_PREFIX, analogy_prefix) for line in _ANALOGY_SYSTEM_LINES
    )
    cand = "\n".join(_format_candidate(i, c) for i, c in enumerate(candidates, start=1))
    user_lines = [
        f"페이지 제목: {page_title or '(제목 없음)'}",
        f"앞 문장: {context}" if context else "",
        f"설명할 문장: {sentence}",
        f"커서가 가리킨 단어: {word}" if word else "",
        "",
        "[근거]",
        cand,
    ]
    # prompt.js처럼 빈 줄은 모두 뺀다.
    user = "\n".join(s for s in user_lines if s != "")
    return system, user


# --- 끝맺음 검사(T-122). 확장 prompt.js impoliteEnding·endingIssues와 같은 규칙 ---

_TRAIL = re.compile(r"[\s.!?。…~\"'”’)\]」』>*]+$")
_SPLIT = re.compile(r"(?<=[.!?。])\s+|\n+")
_JONG_B = 17  # ㅂ 받침(습·합·입·됩…)


def _has_jong(ch: str, jong: int) -> bool:
    code = ord(ch) - 0xAC00 if ch else -1
    return 0 <= code <= 11171 and code % 28 == jong


def _sentence_ending(sentence: str) -> str | None:
    s = _TRAIL.sub("", sentence)
    if not s or s[-1] in "요죠":
        return None
    if len(s) >= 3 and s[-2:] in ("니다", "니까") and _has_jong(s[-3], _JONG_B):
        return "formal"
    if s.endswith("시오"):
        return "formal"
    if s[-1] in "다냐":
        return "plain"
    return None


def impolite_ending(text: str | None) -> str | None:
    """합쇼체면 "formal", 해라체면 "plain", 다 해요체(또는 명사 조각)면 None. 여러 문장이면 합쇼체 우선."""
    if not text:
        return None
    styles = [st for st in (_sentence_ending(x) for x in _SPLIT.split(str(text))) if st]
    if "formal" in styles:
        return "formal"
    return styles[0] if styles else None


def ending_issues(answer: Mapping[str, Any] | None) -> list[dict[str, str]]:
    """말풍선에 보이는 meaning·analogy 중 해요체가 아닌 필드. mapping은 조각이라 보지 않는다."""
    if not answer:
        return []
    out = []
    for field in ("meaning", "analogy"):
        style = impolite_ending(answer.get(field))
        if style:
            out.append({"field": field, "style": style})
    return out


# --- 질의 키워드(LightRAG hl/ll) 프롬프트. 확장에는 없는 서버 전용 내부 프롬프트 ---

def vocabulary_tags(tags: Iterable[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """통제 어휘가 되는 태그들(라벨 있는 것만, 파일 순서 그대로). 규칙 9의 단일 원본.

    질의 키워드 프롬프트와 추출 프롬프트(app/extract.py)가 모두 이 함수로 목록을 만든다.
    """
    return [t for t in tags if t.get("label")]


def tag_lines(tags: Iterable[Mapping[str, Any]]) -> list[str]:
    """프롬프트에 넣는 통제 어휘 줄. "- 라벨: 설명"(설명 없으면 "- 라벨")."""
    return [f"- {t['label']}: {t['desc']}" if t.get("desc") else f"- {t['label']}" for t in vocabulary_tags(tags)]


def build_keyword_prompt(sentence: str, page_title: str | None,
                         tags: Iterable[Mapping[str, Any]]) -> tuple[str, str]:
    """(system, user). tags는 공통 그래프의 tags 목록을 그대로 받는다(규칙 9: 하드코딩 금지)."""
    lines = tag_lines(tags)
    if not lines:
        raise ValueError("추상 태그 목록이 비어 있어요. 공통 그래프의 tags를 넘겨 주세요.")
    system = "\n".join([
        "너는 문장에서 검색용 키워드를 뽑는 도우미다.",
        "hl_keywords: 문장의 핵심 개념이 가진 추상 구조를 아래 [추상 태그] 목록의 라벨 중에서만 0~3개 고른다. 목록에 없는 말을 만들지 않는다.",
        "ll_keywords: 문장에 나온 구체적인 낱말(고유명사, 전문용어, 핵심 명사)을 1~5개 원문 그대로 적는다.",
        "설명이나 머리말 없이 JSON 객체만 출력한다.",
        '출력 형식: {"hl_keywords": [string], "ll_keywords": [string]}',
        "",
        "[추상 태그]",
        *lines,
    ])
    user = f"페이지: {page_title or '(제목 없음)'}\n문장: {sentence}"
    return system, user


def _extract_json_object(text: str) -> Any:
    """코드블록·머리말이 섞인 응답에서 첫 JSON 객체를 꺼낸다. 없거나 깨졌으면 None."""
    if not text:
        return None
    start = text.find("{")
    while start != -1:
        try:
            obj, _ = json.JSONDecoder().raw_decode(text, start)
            return obj
        except ValueError:
            start = text.find("{", start + 1)
    return None


def parse_json_object(text: str) -> Any:
    """비유 응답 등에서 첫 JSON 객체를 꺼낸다(확장 parseJSONLoose에 해당). 없으면 None."""
    return _extract_json_object(text)


def _clean_list(value: Any) -> list[str]:
    """문자열만, 앞뒤 공백 제거, 빈 값·중복 제거(순서 유지)."""
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for v in value:
        if isinstance(v, str) and (s := v.strip()) and s not in out:
            out.append(s)
    return out


def parse_keywords(text: str, allowed_labels: Iterable[str]) -> tuple[list[str], list[str]]:
    """(hl_keywords, ll_keywords). hl은 허용 목록 안의 태그 라벨만 남긴다(목록 밖 추상구조는 버린다)."""
    obj = _extract_json_object(text)
    if not isinstance(obj, dict):
        return [], []
    allowed = set(allowed_labels)
    hl = [k for k in _clean_list(obj.get("hl_keywords")) if k in allowed]
    ll = _clean_list(obj.get("ll_keywords"))
    return hl, ll
