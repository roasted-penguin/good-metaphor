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

# ── 숫자 추출 (T-123, T-143) ──
# 확장 extension/lib/grounding.js와 같은 상수·같은 정규식이어야 한다(공유 사례 tests/fixtures/grounding-numbers.json).
# 한글 수는 오탐이 가장 큰 위험이라("한국", "세계", "일주일") 세는 말 바로 앞이거나 자리 단위와 결합할 때만 바꾼다.

# 세는 말. 정규식에서는 긴 것부터 맞춘다(주일 > 주, 시간 > 시)
COUNTERS = ["번", "회", "개", "명", "마리", "장", "권", "판", "차례", "가지", "시간", "시", "분", "초", "일", "주",
            "주일", "달", "개월", "년", "해", "살", "배", "층", "단계", "등", "위", "칸", "줄", "통", "잔", "대", "곳", "군데",
            "사람", "세트", "묶음", "바퀴"]
# 한자어 수 뒤에만 오는 단위
SINO_UNITS = ["원", "메소", "포인트", "퍼센트", "%"]
# 수와 붙여 쓰면(공백 0개) 다른 낱말이 되는 세는 말: 세일·세대·두통·열등·열위·석회·세분·십분·만회
_ATTACHED_BLOCK = {"일", "대", "통", "등", "위", "분", "판", "회", "살", "배", "주", "년"}
# 고유어 수에는 붙여 써도 되는 세는 말(T-145): 두배·세살·열살. 단, 아래 낱말은 수가 아니다
_NATIVE_ATTACHED_OK = {"배", "살"}
# 고유어 수 + 붙여 쓴 세는 말이 다른 낱말일 때: 넉살은 수가 아님(None), 세배(새해 인사)는 수가 아닐 수도 있음(optional)
_NATIVE_ATTACHED_WORDS = {"넉살": None, "세배": "optional"}
# "네"가 "너의"일 수도 있는 세는 말(T-145): 네 차례, 네 일
_NE_YOUR_COUNTERS = {"차례", "일"}
# 세는 말 바로 뒤에 와도 되는 글자(조사·접미사 첫 글자). 그 밖의 한글이 오면 다른 낱말("두 대상", "네 주인")
_AFTER_COUNTER = "이가을를은는에의도만씩째쯤과와로으까부마밖뿐나랑짜동간께요엔예"
_NATIVE_TENS = {"열": 10, "스물": 20, "스무": 20, "서른": 30, "마흔": 40, "쉰": 50}
_NATIVE_UNITS = {"하나": 1, "한": 1, "둘": 2, "두": 2, "셋": 3, "세": 3, "석": 3, "넷": 4, "네": 4, "넉": 4,
                 "다섯": 5, "여섯": 6, "일곱": 7, "여덟": 8, "아홉": 9}
_SINO_DIGITS = {"일": 1, "이": 2, "삼": 3, "사": 4, "오": 5, "육": 6, "칠": 7, "팔": 8, "구": 9}
_SMALL_UNITS = {"십": 10, "백": 100, "천": 1000}
_BIG_UNITS = {"만": 10000, "억": 100000000}


def _alt(words: Iterable[str]) -> str:
    # JS sort는 안정 정렬이라 같은 길이는 원래 순서를 지킨다. sorted도 안정 정렬
    return "|".join(re.escape(w) for w in sorted(words, key=len, reverse=True))


_AFTER = f"(?=$|[^가-힣]|[{_AFTER_COUNTER}])"
_SP = "[ \\t\\r\\n]"
# 자리 단위. "200만큼"의 만은 단위가 아니다
_UNIT = "(?:[억천백]|만(?!큼))"
_NUMBER_RE = re.compile("|".join([
    # 아라비아 숫자 + 자리 단위: 1만, 3천, 1만 2천, 1.5만, 1천만
    rf"(?P<au>[0-9]+(?:\.[0-9]+)?{_UNIT}(?:{_SP}?[0-9]+(?:\.[0-9]+)?{_UNIT}|{_UNIT})*)",
    r"(?P<d>[0-9]+)",
    # 고유어 수 + 세는 말: 두 번, 열한 번째, 스물두 살, 열 두 번
    rf"(?<![가-힣])(?:(?P<tens>{_alt(_NATIVE_TENS)})(?:{_SP}?(?P<u1>{_alt(_NATIVE_UNITS)}))?"
    rf"|(?P<u2>{_alt(_NATIVE_UNITS)}))(?P<sp1>{_SP}?)(?P<c1>{_alt(COUNTERS)}){_AFTER}",
    # 한자어 수 + 세는 말·단위. 한자어 글자 연속은 통째로만 본다("만일"을 "만"+"일"로 쪼개지 않음)
    # 세는 말이 없어도 "이십일"처럼 일로 끝나면 잡아 두고 코드에서 가린다(T-145)
    rf"(?<![가-힣])(?=(?P<run>[일이삼사오육칠팔구십백천만억]+))(?P=run)(?:(?P<sp2>{_SP}?)"
    rf"(?P<c2>{_alt([*COUNTERS, *SINO_UNITS])}))?{_AFTER}",
]))
# 단독 "N만" 뒤에 세는 말·화폐가 오는지(오면 N×10000 하나, 아니면 "N만(=N뿐)"일 수도 있음)
_COUNTED_AFTER_RE = re.compile(rf"{_SP}?(?:{_alt([*COUNTERS, *SINO_UNITS])}){_AFTER}")
_LONE_MAN_RE = re.compile(r"([0-9]+)만")
_PIECE_RE = re.compile(r"([0-9]+(?:\.[0-9]+)?)?[ \t\r\n]?([억만천백])")


def _eval_pieces(pieces: list[tuple[str | None, str | None]]) -> str | None:
    """자리 단위 계산. 정수가 아니면 None. 소수("1.5만")도 정확하도록 10^소수자리를 곱한 정수로 센다."""
    dec = max([0, *(len(n.split(".")[1]) if n and "." in n else 0 for n, _ in pieces)])
    D = 10 ** dec

    def scaled(n: str) -> int:
        i, _, f = n.partition(".")
        return int(i + f.ljust(dec, "0"))

    # current가 None이면 "수가 없음"(단독 "만" = 1만). 0은 수가 있는 것이다("0만" = 0)
    total = section = 0
    current: int | None = None
    has_section = False
    for num, unit in pieces:
        if num is not None:
            current = scaled(num)
        if unit in _SMALL_UNITS:
            section += (D if current is None else current) * _SMALL_UNITS[unit]
            current, has_section = None, True
        elif unit in _BIG_UNITS:
            base = section + (current or 0) if current is not None or has_section else D
            total += base * _BIG_UNITS[unit]
            section, current, has_section = 0, None, False
    total += section + (current or 0)
    return str(total // D) if total % D == 0 else None


def _sino_value(run: str) -> str | None:
    """한자어 수 글자 연속: 자리 단위가 들어간 2음절 이상, 또는 단독 십·백·천·만일 때만 수로 본다."""
    has_place = any(ch in _SMALL_UNITS or ch in _BIG_UNITS for ch in run)
    if not (has_place if len(run) >= 2 else run in "십백천만"):
        return None
    return _eval_pieces([(str(_SINO_DIGITS[ch]), None) if ch in _SINO_DIGITS else (None, ch) for ch in run])


def _str(value: Any) -> str:
    return "" if value is None else str(value)


def normalize_text(text: Any) -> str:
    """공백·문장부호·기호를 지운다(비교용). JS의 [\\s\\p{P}\\p{S}] 제거와 같다."""
    s = unicodedata.normalize("NFC", _str(text))
    return "".join(ch for ch in s if not (ch.isspace() or unicodedata.category(ch)[0] in "PS"))


def number_groups(text: Any) -> list[dict[str, Any]]:
    """수 표현을 등장 순으로 읽기 후보 묶음 {readings, optional}으로 돌려준다(T-145). 규칙은 확장 numberGroups와 같다.

    - readings: 정수의 10진 표기. 확실하면 하나, 뜻이 둘이면 둘("200만 쓰면" → 2000000 또는 200).
    - optional: 숫자가 아닐 수도 있음("네 차례" = 너의 차례, "세배" = 새해 인사).
    - 아라비아 숫자 연속. 천 단위 쉼표는 붙이고, NFKC로 전각 숫자도 같게 본다.
    - 아라비아 숫자 + 자리 단위("1만 2천" → 12000). 바뀐 수 하나만 낸다.
    - 고유어 수 + 세는 말("두 번" → 2). 단독 "한/하나"는 바꾸지 않는다.
    - 한자어 수 + 세는 말·원·메소 등("삼천 원" → 3000).
    """
    s = _THOUSANDS.sub(r"\1", unicodedata.normalize("NFKC", _str(text)))
    out: list[dict[str, Any]] = []

    def push(readings: list[str], optional: bool = False) -> None:
        out.append({"readings": readings, "optional": optional})

    for m in _NUMBER_RE.finditer(s):
        g = m.groupdict()
        if g["au"]:
            v = _eval_pieces([(p[0] or None, p[1]) for p in _PIECE_RE.findall(g["au"])])
            if v is None:
                for d in _DIGITS.findall(g["au"]):
                    push([d])
                continue
            # 단독 "N만" 뒤에 세는 말·화폐가 없으면 "N뿐"일 수도 있다("레벨 200만 입장")
            lone = _LONE_MAN_RE.fullmatch(g["au"])
            counted = _COUNTED_AFTER_RE.match(s, m.start() + len(g["au"])) is not None
            push([v, str(int(lone.group(1)))] if lone and not counted else [v])
        elif g["d"]:
            push([g["d"]])
        elif g["c1"]:
            unit = g["u1"] or g["u2"]
            if not g["tens"] and _NATIVE_UNITS[g["u2"]] == 1:
                continue
            optional = False
            if not g["sp1"] and g["c1"] in _ATTACHED_BLOCK:
                if g["c1"] not in _NATIVE_ATTACHED_OK:
                    continue
                key = (g["tens"] or "") + (unit or "") + g["c1"]
                if key in _NATIVE_ATTACHED_WORDS and _NATIVE_ATTACHED_WORDS[key] is None:
                    continue
                optional = _NATIVE_ATTACHED_WORDS.get(key) == "optional"
            if not g["tens"] and g["u2"] == "네" and g["c1"] in _NE_YOUR_COUNTERS:
                optional = True
            push([str(_NATIVE_TENS.get(g["tens"] or "", 0) + _NATIVE_UNITS.get(unit or "", 0))], optional)
        elif g["c2"]:
            if not g["sp2"] and g["c2"] in _ATTACHED_BLOCK:
                continue
            v = _sino_value(g["run"])
            if v is not None:
                push([v])
        elif g["run"]:
            # 세는 말 없이 "이십일·삼십일·백일": 21(수 전체) 또는 20+일(날짜 세는 말). 앞 글자가 십·백·천일 때만
            # ("만일"은 "만약"의 뜻이라 빼고, 단독 "일"도 수가 아니다)
            run = g["run"]
            if len(run) < 2 or not run.endswith("일") or run[-2] not in _SMALL_UNITS:
                continue
            whole, day = _sino_value(run), _sino_value(run[:-1])
            if whole is not None and day is not None:
                push([whole, day])
    return out


def numbers_in(text: Any) -> list[str]:
    """숫자를 등장 순으로 뽑아 정수의 10진 표기 리스트로. 모든 묶음의 readings를 펼친 것(허용 숫자 쪽에 쓴다)."""
    return [n for g in number_groups(text) for n in g["readings"]]


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
      뜻이 둘인 수는 둘 중 하나만 있으면 되고, 숫자가 아닐 수도 있는 표현(optional)은 통과(T-145).
    """
    if not normalize_text(analogy):
        return True, None
    fact_list = _strings(facts)

    if normalize_text(used_fact) and not _matches_fact(_str(used_fact), fact_list):
        return False, "fact-mismatch"

    label_list = _strings(list(labels) if labels is not None else [])
    known = {n for t in [*fact_list, *label_list, sentence, context] for n in numbers_in(t)}
    # 비유 쪽은 묶음마다: 읽기 후보 하나라도 허용 숫자에 있거나 숫자가 아닐 수도 있으면(optional) 통과
    if any(not g["optional"] and not any(n in known for n in g["readings"]) for g in number_groups(analogy)):
        return False, "number-outside"
    return True, None
