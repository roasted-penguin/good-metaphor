"""설치 토큰별 요청 한도. 최근 window초 안의 요청 수가 limit을 넘으면 막는다(미끄러지는 창)."""
from __future__ import annotations

import math
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

    def retry_after(self, token: str) -> int:
        """지금 막혔다면 가장 오래된 기록이 창 밖으로 나갈 때까지 남은 초(올림, 최소 1). 막히지 않았으면 0.

        읽기만 한다(기록을 지우거나 더하지 않는다). allow 와 같은 기준(now - 기록 >= window 면 창 밖)을 쓴다.
        """
        hits = self._hits.get(token)
        if not hits:
            return 0
        now = self._clock()
        inside = [t for t in hits if now - t < self.window]
        if len(inside) < self.limit:
            return 0
        # 창 안 기록이 limit 개 이상이면, 앞에서부터 (len - limit + 1)번째 기록이 나가야 한 자리가 빈다
        oldest = inside[len(inside) - self.limit]
        return max(1, math.ceil(oldest + self.window - now))
