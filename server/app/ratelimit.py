"""설치 토큰별 요청 한도. 최근 window초 안의 요청 수가 limit을 넘으면 막는다(미끄러지는 창)."""
from __future__ import annotations

import time
from collections import deque
from typing import Callable


class RateLimiter:
    def __init__(self, limit: int, window: float = 60.0, clock: Callable[[], float] = time.monotonic) -> None:
        self.limit = limit
        self.window = window
        self._clock = clock
        self._hits: dict[str, deque[float]] = {}

    def allow(self, token: str) -> bool:
        now = self._clock()
        hits = self._hits.setdefault(token, deque())
        while hits and now - hits[0] >= self.window:
            hits.popleft()
        if len(hits) >= self.limit:
            return False
        hits.append(now)
        return True
