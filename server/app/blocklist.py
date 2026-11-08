"""금칙어 필터(T-114, 규칙 11). 확장 extension/lib/blocklist.js와 같은 규칙이다.

목록 원본은 extension/data/common/blocklist.json(ADR 0007 용어 카드). status가 "승인"인 카드만 쓴다.
공유 사례 tests/fixtures/blocklist-cases.json으로 두 언어가 같은 결과를 내는지 확인한다.
"""
from __future__ import annotations

import json
import logging
import os
import unicodedata
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

BLOCKED_REJECTED_TEXT = "부적절한 표현이 섞여 있어서 비유를 숨겼어요."

# JS 정규식 \s 중 Z* 범주가 아닌 글자 + 제로폭·소프트 하이픈·단어 결합자·한글 채움 문자
_EXTRA_STRIP = set("\t\n\v\f\r﻿​‌‍­⁠ᅟᅠㅤﾠ")


def _strip(ch: str) -> bool:
    # JS [\s\p{P}\p{S}...] 와 같게: 공백(Zs·Zl·Zp), 문장부호(P*), 기호(S*)
    cat = unicodedata.category(ch)
    return cat[0] in "PS" or cat in ("Zs", "Zl", "Zp") or ch in _EXTRA_STRIP


def normalize_for_block(text: Any) -> str:
    """NFKC → 소문자 → 사이에 끼워 넣은 공백·점·기호 제거."""
    t = unicodedata.normalize("NFKC", "" if text is None else str(text)).lower()
    return "".join(ch for ch in t if not _strip(ch))


def active_terms(data: Any) -> list[dict[str, Any]]:
    """배열이나 {"terms": [...]}를 받아 승인된 카드만 돌려준다."""
    terms = data if isinstance(data, list) else (data or {}).get("terms") if isinstance(data, dict) else None
    return [c for c in (terms or []) if isinstance(c, dict) and c.get("status") == "승인"]


def find_blocked(text: Any, terms: Any) -> str | None:
    """정규화한 text 안에 승인된 term 또는 variant가 있으면 그 term. 정규화해 빈 항목은 건너뛴다."""
    t = normalize_for_block(text)
    if not t:
        return None
    for card in active_terms(terms):
        for w in [card.get("term"), *(card.get("variants") or [])]:
            n = normalize_for_block(w)
            if n and n in t:
                return card.get("term")
    return None


def load_blocklist(path: str | os.PathLike) -> list[dict[str, Any]]:
    """파일에서 승인된 카드만 읽는다. 없거나 깨졌으면 오류를 남기고 빈 목록(프롬프트 규칙은 그대로 남는다)."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        log.error("금칙어 목록을 읽지 못함: %s", e)
        return []
    return active_terms(data)
