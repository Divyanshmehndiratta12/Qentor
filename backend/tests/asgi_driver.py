"""A minimal ASGI driver for tests: one request through the real FastAPI/Starlette stack, as uvicorn would make it.

``httpx`` (and so ``TestClient``) is not a project dependency, so a request with a body, a status code and the JSON on the wire is
driven by hand. Shared by the newer API tests; ``test_api_assessments`` keeps its own identical copy from before this module existed.
"""

from __future__ import annotations

import asyncio

from qentor.api import app as app_module


def http(
    method: str,
    path: str,
    body: bytes | None = None,
    content_type: str = "application/json",
    headers: dict[str, str] | None = None,
    client: tuple[str, int] = ("127.0.0.1", 1234),
) -> tuple[int, bytes]:
    async def run() -> tuple[int, bytes]:
        sent: list[dict] = []
        pending = [{"type": "http.request", "body": body or b"", "more_body": False}]

        async def receive() -> dict:
            return pending.pop(0) if pending else {"type": "http.disconnect"}

        async def send(message: dict) -> None:
            sent.append(message)

        header_list = [(b"host", b"testserver")]
        if body is not None:
            header_list += [(b"content-type", content_type.encode()), (b"content-length", str(len(body)).encode())]
        for name, value in (headers or {}).items():
            header_list.append((name.lower().encode(), value.encode()))
        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": method,
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "headers": header_list,
            "server": ("testserver", 80),
            "client": client,
            "root_path": "",
        }
        await app_module.app(scope, receive, send)
        start = next(m for m in sent if m["type"] == "http.response.start")
        return start["status"], b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")

    return asyncio.run(run())
