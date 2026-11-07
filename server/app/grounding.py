"""근거 검사 (T-123): 비유가 고른 노드 facts 밖의 사실(지어낸 수치·규칙)을 쓰는지 본다.

확장 extension/lib/grounding.js를 그대로 옮긴 것이다. 규칙·임계값·문구·reason을 함께 고친다.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Any, Iterable

GROUNDING_REJECTED_TEXT = "근거에 없는 내용이 섞여 있어서 비유를 숨겼어요."

# usedFact와 fact를 "같은 문장"으로 볼 글자 3-gram 자카드 하한
FACT_JACCARD_MIN = 0.6

# JS \d는 ASCII 숫자만 본다. Python \d는 유니코드 숫자까지 보므로 [0-9]를 쓴다
_THOUSANDS = re.compile(r"([0-9]),(?=[0-9]{3}(?![0-9]))")
_DIGITS = re.compile(r"[0-9]+")


def _str(value: Any) -> str:
    return "" if value is None else str(value)


def normalize_text(text: Any) -> str:
    """공백·문장부호·기호를 지운다(비교용). JS의 [\\s\\p{P}\\p{S}] 제거와 같다."""
    s = unicodedata.normalize("NFC", _str(text))
    return "".join(ch for ch in s if not (ch.isspace() or unicodedata.category(ch)[0] in "PS"))


def numbers_in(text: Any) -> list[str]:
    """아라비아 숫자 연속. 천 단위 쉼표는 붙이고, NFKC로 전각 숫자도 같게 본다."""
    s = _THOUSANDS.sub(r"\1", unicodedata.normalize("NFKC", _str(text)))
    return _DIGITS.findall(s)


def _trigrams(text: Any) -> set[str]:
    t = normalize_text(text)
    return {t[i:i + 3] for i in range(len(t) - 2)}


def char_jaccard(a: Any, b: Any) -> float:
    """글자 3-gram 자카드 유사도(정규화 후). 둘 다 비면 0."""
    A, B = _trigrams(a), _trigrams(b)
    union = len(A | B)
    return len(A & B) / union if union else 0


def _matches_fact(used_fact: str, facts: list[str]) -> bool:
    """정규화 후 fact가 usedFact를 포함하거나 자카드 ≥ 0.6."""
    used = normalize_text(used_fact)
    for f in facts:
        fact = normalize_text(f)
        if (fact and used in fact) or char_jaccard(used_fact, f) >= FACT_JACCARD_MIN:
            return True
    return False


def _strings(value: Any) -> list[str]:
    return [v for v in value if isinstance(v, str)] if isinstance(value, list) else []


def check_grounding(analogy: Any, used_fact: Any, facts: Any, sentence: Any, context: Any,
                    labels: Iterable[Any] | None = None) -> tuple[bool, str | None]:
    """(ok, reason). reason은 'fact-mismatch' | 'number-outside' | None.

    - labels: 고른 노드 label과 이웃 label. 숫자 검사의 허용 숫자에만 쓰고 usedFact 대조에는 쓰지 않는다.
    - 비유가 비었으면 검사하지 않는다.
    - usedFact가 있으면 facts 중 하나와 일치해야 한다. 없거나 비었으면 숫자 검사만 한다(옛 모델 호환).
    - 비유의 숫자가 facts·labels·원문 문장·앞 문장 어디에도 없으면 number-outside.
    """
    if not normalize_text(analogy):
        return True, None
    fact_list = _strings(facts)

    if normalize_text(used_fact) and not _matches_fact(_str(used_fact), fact_list):
        return False, "fact-mismatch"

    label_list = _strings(list(labels) if labels is not None else [])
    known = {n for t in [*fact_list, *label_list, sentence, context] for n in numbers_in(t)}
    if any(n not in known for n in numbers_in(analogy)):
        return False, "number-outside"
    return True, None
