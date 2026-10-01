"""A small in-memory sliding-window rate limiter.

Honest about what it is: a per-process counter keyed by a string (a client address or a learner id). It slows guessing of class codes, class
creation and event floods in ONE server process; it is not a distributed limiter, and behind a reverse proxy every client may share the proxy's
address (documented in docs/ARCHITECTURE.md). The clock is injectable so tests do not sleep.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from typing import Callable

_MAX_KEYS = 20_000


class RateLimiter:
    def __init__(self, limit: int, window_seconds: float, *, clock: Callable[[], float] = time.monotonic) -> None:
        if limit < 1 or window_seconds <= 0:
            raise ValueError("a rate limit needs a positive limit and window")
        self.limit = limit
        self.window = window_seconds
        self._clock = clock
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        """Count one hit for ``key``; ``False`` when it is over the limit for the current window (the hit is not counted then)."""
        now = self._clock()
        cutoff = now - self.window
        with self._lock:
            hits = self._hits.get(key)
            if hits is None:
                if len(self._hits) >= _MAX_KEYS:
                    self._evict(cutoff)
                hits = self._hits[key] = deque()
            while hits and hits[0] <= cutoff:
                hits.popleft()
            if len(hits) >= self.limit:
                return False
            hits.append(now)
            return True

    def retry_after(self, key: str) -> int:
        """Seconds until ``key`` may try again (0 when it may now)."""
        now = self._clock()
        with self._lock:
            hits = self._hits.get(key)
            if not hits or len(hits) < self.limit:
                return 0
            return max(1, int(hits[0] + self.window - now + 0.999))

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()

    def _evict(self, cutoff: float) -> None:
        stale = [k for k, v in self._hits.items() if not v or v[-1] <= cutoff]
        for k in stale:
            del self._hits[k]
        if len(self._hits) >= _MAX_KEYS:  # still full of live keys: drop the oldest half rather than grow without bound
            for k in sorted(self._hits, key=lambda k: self._hits[k][-1])[: _MAX_KEYS // 2]:
                del self._hits[k]
