"""Two resource guards for the one server process, as plain ASGI middleware (no dependency, no queue, no second process).

``BodySizeLimitMiddleware`` refuses a request body over a fixed size with ``413`` before the application parses it. Every real request here is
small (a 500-operation circuit is under 100 KB), so the limit protects memory, not a legitimate use.

``HeavyWorkGate`` lets only a few of the CPU-heavy requests (running circuits, traces, equivalence checks, multi-input tests, backend
comparisons, the variational demo, reasoning analyses, challenge checks) run at once. The rest wait in the event loop, using no worker thread
while they wait, and a request that has waited too long is answered ``503`` with a plain message instead of piling up. Measured worst cases
(docs/BUILD_STATE.md "Resource limits") run from a fraction of a second to about ten seconds, so an unbounded crowd of them would saturate the CPU;
this keeps the server answering the light requests (lessons, health, the page itself) while the heavy ones queue.

Both answer in the shape every other error uses: ``{"detail": {"code", "message"}}``. Neither changes any result.
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Awaitable, Callable

Scope = dict
Receive = Callable[[], Awaitable[dict]]
Send = Callable[[dict], Awaitable[None]]

MAX_BODY_BYTES = 1_000_000
REQUEST_TOO_LARGE = "REQUEST_TOO_LARGE"
SERVER_BUSY = "SERVER_BUSY"
HEAVY_WAIT_SECONDS = 30.0

_BODY_METHODS = {"POST", "PUT", "PATCH"}
# POST requests under these paths run a backend or a verifier. Reads (GET lists, health, the page) are never gated.
HEAVY_PREFIXES = (
    "/api/execute",
    "/api/verify/",
    "/api/optimize",
    "/api/test/",
    "/api/compare/",
    "/api/variational/",
    "/api/noise/",
    "/api/reasoning/",
    "/api/debug",
    "/api/challenges/",
)


def default_heavy_limit() -> int:
    """How many heavy requests may run at once: the ``QENTOR_MAX_HEAVY_REQUESTS`` setting, else the CPU count clamped to 2..4."""
    raw = os.environ.get("QENTOR_MAX_HEAVY_REQUESTS", "").strip()
    if raw.isdigit() and int(raw) >= 1:
        return int(raw)
    return max(2, min(4, os.cpu_count() or 2))


async def _reject(send: Send, status: int, code: str, message: str, headers: list[tuple[bytes, bytes]] | None = None) -> None:
    body = json.dumps({"detail": {"code": code, "message": message}}).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()), *(headers or [])],
        }
    )
    await send({"type": "http.response.body", "body": body})


class _TooLarge(Exception):
    pass


class BodySizeLimitMiddleware:
    def __init__(self, app, max_bytes: int = MAX_BODY_BYTES) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope.get("method") not in _BODY_METHODS:
            await self.app(scope, receive, send)
            return
        message = f"the request body is over the {self.max_bytes // 1000} KB limit"
        declared = dict(scope.get("headers") or []).get(b"content-length")
        if declared is not None and declared.isdigit() and int(declared) > self.max_bytes:
            await _reject(send, 413, REQUEST_TOO_LARGE, message)
            return

        seen = 0
        started = False

        async def counting_receive() -> dict:
            nonlocal seen
            event = await receive()
            if event.get("type") == "http.request":
                seen += len(event.get("body", b""))
                if seen > self.max_bytes:  # a body that did not declare its size, or lied about it
                    raise _TooLarge
            return event

        async def tracking_send(event: dict) -> None:
            nonlocal started
            if event["type"] == "http.response.start":
                started = True
            await send(event)

        try:
            await self.app(scope, counting_receive, tracking_send)
        except _TooLarge:
            if not started:
                await _reject(send, 413, REQUEST_TOO_LARGE, message)


class HeavyWorkGate:
    def __init__(self, app, limit: int | None = None, wait_seconds: float = HEAVY_WAIT_SECONDS, prefixes: tuple[str, ...] = HEAVY_PREFIXES) -> None:
        self.app = app
        self.limit = limit if limit is not None else default_heavy_limit()
        self.wait_seconds = wait_seconds
        self.prefixes = prefixes
        self._loop: asyncio.AbstractEventLoop | None = None
        self._semaphore: asyncio.Semaphore | None = None

    def _semaphore_for_this_loop(self) -> asyncio.Semaphore:
        loop = asyncio.get_running_loop()
        if self._semaphore is None or self._loop is not loop:  # one server loop in production; tests start a loop per request
            self._loop, self._semaphore = loop, asyncio.Semaphore(self.limit)
        return self._semaphore

    def _is_heavy(self, scope: Scope) -> bool:
        return scope["type"] == "http" and scope.get("method") == "POST" and scope.get("path", "").startswith(self.prefixes)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not self._is_heavy(scope):
            await self.app(scope, receive, send)
            return
        semaphore = self._semaphore_for_this_loop()
        try:
            await asyncio.wait_for(semaphore.acquire(), timeout=self.wait_seconds)
        except asyncio.TimeoutError:
            await _reject(
                send,
                503,
                SERVER_BUSY,
                "the server is busy with other circuit work; nothing was run. Try again in a moment.",
                [(b"retry-after", b"5")],
            )
            return
        try:
            await self.app(scope, receive, send)
        finally:
            semaphore.release()
