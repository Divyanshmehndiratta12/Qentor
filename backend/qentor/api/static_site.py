"""Serve the production web build from the same FastAPI process as the API.

One process, one port: ``vite build`` output (``web/dist``) is served next to ``/api/*``. No container, no reverse proxy, no
second server. The browser reaches the API with relative URLs, so nothing about the build knows a host or port.

Rules this module keeps:

* **API routes are never shadowed.** Routes registered before ``mount_frontend`` (every ``/api/*`` route, ``/docs``,
  ``/openapi.json``) win. A GET to an unknown ``/api/...`` path is a JSON 404 — never the HTML shell, which would make a
  mistyped API call look like a successful (but wrong) response.
* **SPA fallback for page routes.** A GET for a path that is not a file in the build (``/learn``, ``/progress``, a deep link)
  returns ``index.html`` so the client app can take over. It is sent ``no-cache`` so a new build is picked up.
* **A missing file is a 404, not the HTML shell.** A path whose last segment has a file extension (``/assets/gone.js``,
  ``/favicon.png``) that does not exist is a 404; serving HTML as JavaScript would turn a stale deploy into a blank page with a
  baffling parse error.
* **Hashed assets are cached forever** (``/assets/*`` — Vite content-hashes their names); everything else is revalidated.
* **Nothing outside the build directory is ever served.** Paths are resolved (symlinks included) and must stay inside the build
  directory; dotfiles are refused.
* **Honest when the build is missing.** With no ``index.html`` the API still works and ``/`` says how to build the frontend,
  rather than pretending.

The build directory is ``web/dist`` next to the backend, or ``QENTOR_WEB_DIST`` when set.
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response

WEB_DIST_ENV = "QENTOR_WEB_DIST"
# backend/qentor/api/static_site.py -> repo root is three levels up from this file's directory
_DEFAULT_DIST = Path(__file__).resolve().parents[3] / "web" / "dist"

_IMMUTABLE = "public, max-age=31536000, immutable"
_REVALIDATE = "no-cache"

MISSING_BUILD_MESSAGE = (
    "The web build was not found. Build it with `npm run build` in web/ (expected web/dist/index.html), "
    f"or point {WEB_DIST_ENV} at a build directory. The API under /api is running."
)


def frontend_dist(env: dict[str, str] | None = None) -> Path | None:
    """The build directory if it holds an ``index.html``, else ``None``."""
    environ = os.environ if env is None else env
    configured = environ.get(WEB_DIST_ENV)
    directory = Path(configured) if configured else _DEFAULT_DIST
    return directory if (directory / "index.html").is_file() else None


def _safe_file(root: Path, relative: str) -> Path | None:
    """The file at ``root/relative`` if it is a regular file inside ``root`` and not a dotfile, else ``None``."""
    if not relative or "\x00" in relative or "\\" in relative:
        return None
    segments = relative.split("/")
    if any(segment.startswith(".") for segment in segments):
        return None
    try:
        candidate = (root / relative).resolve()
    except (OSError, ValueError):
        return None
    if not candidate.is_relative_to(root) or not candidate.is_file():
        return None
    return candidate


def mount_frontend(app: FastAPI, dist: Path | None) -> None:
    """Register the fallback route that serves ``dist``. Call it AFTER every API route is registered."""
    if dist is None:

        @app.get("/", include_in_schema=False)
        def missing_build() -> JSONResponse:
            return JSONResponse({"detail": MISSING_BUILD_MESSAGE}, status_code=404)

        return

    root = dist.resolve()
    index = root / "index.html"

    @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def serve_frontend(path: str) -> Response:
        if path == "api" or path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not Found")

        file = _safe_file(root, path)
        if file is not None:
            cache = _IMMUTABLE if file.is_relative_to(root / "assets") else _REVALIDATE
            return FileResponse(file, headers={"Cache-Control": cache})

        if "." in path.rsplit("/", 1)[-1]:
            raise HTTPException(status_code=404, detail="Not Found")

        return FileResponse(index, media_type="text/html", headers={"Cache-Control": _REVALIDATE})
