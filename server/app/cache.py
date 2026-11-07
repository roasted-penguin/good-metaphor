"""비유 결과 캐시. 키 = sha1(앞뒤 공백 뺀 문장 + "\x1f" + 커서 단어) + ":" + 워크스페이스 버전.

커서 단어가 다르면 설명할 대상이 달라지므로 키에 넣는다(확장 캐시 키도 word를 넣는다).

그래프 판본(버전)이 바뀌면 키가 달라져 예전 결과를 저절로 안 쓴다.
"""
from __future__ import annotations

import copy
import hashlib
import logging
from collections import OrderedDict
from typing import Any

log = logging.getLogger(__name__)

# 워크스페이스 버전을 모를 때 쓰는 고정 문자열("None"이 키에 섞이지 않게)
UNVERSIONED = "unversioned"


def cache_key(sentence: str, word: str | None, workspace_version: str | None) -> str:
    if not workspace_version:
        log.warning("워크스페이스 버전을 몰라 캐시 키에 '%s'를 써요. 그래프가 바뀌어도 캐시가 안 비워질 수 있어요.",
                    UNVERSIONED)
        workspace_version = UNVERSIONED
    raw = sentence.strip() + "\x1f" + (word or "")
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()
    return f"{digest}:{workspace_version}"


class ResultCache:
    """최대 max_size개. 넘치면 가장 오래 안 쓴 것부터 버린다."""

    def __init__(self, max_size: int = 1000) -> None:
        self.max_size = max_size
        self._items: OrderedDict[str, dict[str, Any]] = OrderedDict()

    def get(self, key: str) -> dict[str, Any] | None:
        if key not in self._items:
            return None
        self._items.move_to_end(key)
        # 꺼낸 쪽이 고쳐도 캐시 안의 값은 그대로 남게 사본을 준다
        return copy.deepcopy(self._items[key])

    def put(self, key: str, value: dict[str, Any]) -> None:
        self._items[key] = copy.deepcopy(value)
        self._items.move_to_end(key)
        while len(self._items) > self.max_size:
            self._items.popitem(last=False)

    def __len__(self) -> int:
        return len(self._items)
