"""Serving the production web build from the API process (qentor.api.static_site).

httpx/TestClient is not a project dependency, so requests go through the real FastAPI/Starlette stack with a minimal ASGI driver:
the app object is called exactly as uvicorn would call it, and the status, headers and body come back untouched.
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI

from qentor.api import app as app_module
from qentor.api.static_site import (
    MISSING_BUILD_MESSAGE,
    WEB_DIST_ENV,
    _DEFAULT_DIST,
    frontend_dist,
    mount_frontend,
)

INDEX = "<!doctype html><html><body><div id='root'>QENTOR-SHELL</div></body></html>"
ASSET_JS = "console.log('QENTOR-ASSET')"


def request(app: FastAPI, method: str, path: str) -> tuple[int, dict[str, str], bytes]:
    """Drive the ASGI app once. ``path`` is what uvicorn would put in ``scope["path"]`` (already percent-decoded)."""

    async def run() -> tuple[int, dict[str, str], bytes]:
        sent: list[dict] = []

        async def receive() -> dict:
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message: dict) -> None:
            sent.append(message)

        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": method,
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "headers": [(b"host", b"testserver")],
            "server": ("testserver", 80),
            "client": ("127.0.0.1", 1234),
            "root_path": "",
        }
        await app(scope, receive, send)
        start = next(m for m in sent if m["type"] == "http.response.start")
        body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
        headers = {k.decode().lower(): v.decode() for k, v in start["headers"]}
        return start["status"], headers, body

    return asyncio.run(run())


class BuildDirectory(unittest.TestCase):
    """A throwaway build directory inside a throwaway parent, so 'outside the build' really is outside."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.parent = Path(self._tmp.name)
        self.dist = self.parent / "dist"
        (self.dist / "assets").mkdir(parents=True)
        (self.dist / "index.html").write_text(INDEX, encoding="utf-8")
        (self.dist / "favicon.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>", encoding="utf-8")
        (self.dist / "assets" / "index-abc123.js").write_text(ASSET_JS, encoding="utf-8")
        (self.dist / "assets" / "index-abc123.css").write_text("body{color:red}", encoding="utf-8")
        (self.dist / ".env").write_text("SECRET=dotfile", encoding="utf-8")
        (self.parent / "secret.txt").write_text("OUTSIDE-THE-BUILD", encoding="utf-8")

        self.app = FastAPI()

        @self.app.get("/api/ping")
        def ping() -> dict[str, str]:
            return {"pong": "api"}

        @self.app.post("/api/echo")
        def echo() -> dict[str, str]:
            return {"echo": "post"}

        mount_frontend(self.app, self.dist)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def get(self, path: str, method: str = "GET") -> tuple[int, dict[str, str], bytes]:
        return request(self.app, method, path)


class TestServesTheBuild(BuildDirectory):
    def test_root_serves_the_shell_and_is_revalidated(self) -> None:
        status, headers, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn("QENTOR-SHELL", body.decode())
        self.assertTrue(headers["content-type"].startswith("text/html"))
        self.assertEqual(headers["cache-control"], "no-cache")

    def test_hashed_assets_are_served_with_the_right_type_and_cached_forever(self) -> None:
        status, headers, body = self.get("/assets/index-abc123.js")
        self.assertEqual(status, 200)
        self.assertEqual(body.decode(), ASSET_JS)
        self.assertIn("javascript", headers["content-type"])
        self.assertEqual(headers["cache-control"], "public, max-age=31536000, immutable")

        status, headers, _ = self.get("/assets/index-abc123.css")
        self.assertEqual(status, 200)
        self.assertTrue(headers["content-type"].startswith("text/css"))

    def test_other_files_in_the_build_are_served_but_revalidated(self) -> None:
        status, headers, body = self.get("/favicon.svg")
        self.assertEqual(status, 200)
        self.assertIn("svg", body.decode())
        self.assertEqual(headers["cache-control"], "no-cache")

    def test_head_works_like_get_without_a_body(self) -> None:
        status, headers, body = self.get("/", method="HEAD")
        self.assertEqual(status, 200)
        self.assertTrue(headers["content-type"].startswith("text/html"))
        self.assertEqual(body, b"")


class TestSpaFallback(BuildDirectory):
    def test_direct_navigation_to_client_routes_gets_the_shell(self) -> None:
        for path in ("/learn", "/progress", "/lab", "/learn/some-lesson", "/a/b/c/deep/link", "/learn/"):
            with self.subTest(path=path):
                status, headers, body = self.get(path)
                self.assertEqual(status, 200)
                self.assertIn("QENTOR-SHELL", body.decode())
                self.assertEqual(headers["cache-control"], "no-cache")

    def test_a_missing_file_is_a_404_not_the_html_shell(self) -> None:
        for path in ("/assets/gone.js", "/assets/gone.css", "/nope.png", "/assets/index-abc123.js.map"):
            with self.subTest(path=path):
                status, headers, body = self.get(path)
                self.assertEqual(status, 404)
                self.assertNotIn(b"QENTOR-SHELL", body)
                self.assertTrue(headers["content-type"].startswith("application/json"))

    def test_a_directory_is_not_a_file(self) -> None:
        status, _, body = self.get("/assets")
        # "assets" has no extension, so it is a client route like any other — the shell, never a directory listing.
        self.assertEqual(status, 200)
        self.assertIn(b"QENTOR-SHELL", body)
        self.assertNotIn(b"index-abc123", body)

    def test_a_post_to_a_page_route_is_not_answered_with_html(self) -> None:
        status, _, body = self.get("/learn", method="POST")
        self.assertNotEqual(status, 200)
        self.assertNotIn(b"QENTOR-SHELL", body)


class TestApiIsNotShadowed(BuildDirectory):
    def test_api_routes_answer_as_before(self) -> None:
        status, _, body = self.get("/api/ping")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"pong": "api"})
        status, _, body = self.get("/api/echo", method="POST")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"echo": "post"})

    def test_an_unknown_api_path_is_a_json_404_never_the_shell(self) -> None:
        for path in ("/api/nonexistent", "/api/execute/nope", "/api", "/api/", "/api/lessons/extra/segments"):
            with self.subTest(path=path):
                status, headers, body = self.get(path)
                self.assertEqual(status, 404)
                self.assertNotIn(b"QENTOR-SHELL", body)
                self.assertTrue(headers["content-type"].startswith("application/json"))
                self.assertEqual(json.loads(body), {"detail": "Not Found"})

    def test_a_path_that_merely_starts_with_api_is_a_page_route(self) -> None:
        status, _, body = self.get("/apiary")
        self.assertEqual(status, 200)
        self.assertIn(b"QENTOR-SHELL", body)

    def test_the_fallback_is_not_part_of_the_documented_api(self) -> None:
        self.assertNotIn("/{path}", json.dumps(self.app.openapi()["paths"]))
        self.assertEqual(sorted(self.app.openapi()["paths"]), ["/api/echo", "/api/ping"])


class TestNothingOutsideTheBuildIsServed(BuildDirectory):
    def test_path_traversal_is_refused(self) -> None:
        for path in (
            "/../secret.txt",
            "/assets/../../secret.txt",
            "/assets/../../../secret.txt",
            "/%2e%2e/secret.txt",
            "/..%2fsecret.txt",
            "/assets/..%2f..%2fsecret.txt",
            "/....//secret.txt",
        ):
            with self.subTest(path=path):
                status, _, body = self.get(path)
                self.assertNotIn(b"OUTSIDE-THE-BUILD", body)
                self.assertNotEqual(status, 500)

    def test_a_symlink_leading_out_of_the_build_is_not_followed(self) -> None:
        link = self.dist / "leak.txt"
        try:
            link.symlink_to(self.parent / "secret.txt")
        except OSError:
            self.skipTest("symlinks are not available here")
        status, _, body = self.get("/leak.txt")
        self.assertEqual(status, 404)
        self.assertNotIn(b"OUTSIDE-THE-BUILD", body)

    def test_a_symlinked_directory_out_of_the_build_is_not_followed(self) -> None:
        outside = self.parent / "outside_dir"
        outside.mkdir()
        (outside / "inside.txt").write_text("OUTSIDE-THE-BUILD", encoding="utf-8")
        try:
            (self.dist / "assets" / "linked").symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest("symlinks are not available here")
        status, _, body = self.get("/assets/linked/inside.txt")
        self.assertEqual(status, 404)
        self.assertNotIn(b"OUTSIDE-THE-BUILD", body)

    def test_dotfiles_are_refused(self) -> None:
        (self.dist / "assets" / ".hidden").write_text("HIDDEN", encoding="utf-8")
        (self.dist / ".git").mkdir()
        (self.dist / ".git" / "config").write_text("GITCONFIG", encoding="utf-8")
        for path in ("/.env", "/assets/.hidden", "/.git/config"):
            with self.subTest(path=path):
                status, _, body = self.get(path)
                # never the file: a dotfile with an extension-like name is a 404, an extension-less one is just a page route
                self.assertIn(status, (200, 404))
                for secret in (b"dotfile", b"HIDDEN", b"GITCONFIG"):
                    self.assertNotIn(secret, body)
        self.assertEqual(self.get("/.env")[0], 404)
        self.assertEqual(self.get("/assets/.hidden")[0], 404)

    def test_a_file_whose_name_holds_a_backslash_is_never_served(self) -> None:
        # Harmless on POSIX, a directory separator on Windows: refused everywhere so behaviour does not depend on the OS.
        (self.dist / "assets" / "we\ird.js").write_text("BACKSLASH-FILE", encoding="utf-8")
        status, _, body = self.get("/assets/we\ird.js")
        self.assertEqual(status, 404)
        self.assertNotIn(b"BACKSLASH-FILE", body)

    def test_backslashes_and_nul_bytes_are_refused(self) -> None:
        for path in ("/assets\\..\\..\\secret.txt", "/assets/index-abc123.js\x00.png"):
            with self.subTest(path=path):
                status, _, body = self.get(path)
                self.assertNotIn(b"OUTSIDE-THE-BUILD", body)
                self.assertNotEqual(status, 500)


class TestMissingBuild(unittest.TestCase):
    def setUp(self) -> None:
        self.app = FastAPI()

        @self.app.get("/api/ping")
        def ping() -> dict[str, str]:
            return {"pong": "api"}

        mount_frontend(self.app, None)

    def test_the_api_still_works(self) -> None:
        status, _, body = request(self.app, "GET", "/api/ping")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"pong": "api"})

    def test_root_says_how_to_build_instead_of_pretending(self) -> None:
        status, _, body = request(self.app, "GET", "/")
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body), {"detail": MISSING_BUILD_MESSAGE})
        self.assertIn("npm run build", MISSING_BUILD_MESSAGE)

    def test_page_routes_are_plain_404s(self) -> None:
        status, _, _ = request(self.app, "GET", "/learn")
        self.assertEqual(status, 404)


class TestFrontendDist(unittest.TestCase):
    def test_default_is_web_dist_next_to_the_backend(self) -> None:
        self.assertEqual(_DEFAULT_DIST.name, "dist")
        self.assertEqual(_DEFAULT_DIST.parent.name, "web")
        self.assertTrue((_DEFAULT_DIST.parent.parent / "backend" / "qentor").is_dir())

    def test_env_override_is_used_when_it_holds_an_index(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "index.html").write_text(INDEX, encoding="utf-8")
            self.assertEqual(frontend_dist({WEB_DIST_ENV: tmp}), Path(tmp))

    def test_a_directory_without_index_html_is_no_build(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(frontend_dist({WEB_DIST_ENV: tmp}))
        self.assertIsNone(frontend_dist({WEB_DIST_ENV: "/definitely/not/a/directory"}))

    def test_no_env_falls_back_to_the_default_location(self) -> None:
        expected = _DEFAULT_DIST if (_DEFAULT_DIST / "index.html").is_file() else None
        self.assertEqual(frontend_dist({}), expected)


class TestRealApp(unittest.TestCase):
    """The actual qentor app, whether or not a build is present on this machine."""

    def test_api_endpoints_are_still_the_api(self) -> None:
        status, headers, body = request(app_module.app, "GET", "/api/lessons")
        self.assertEqual(status, 200)
        self.assertTrue(headers["content-type"].startswith("application/json"))
        self.assertIn("lessons", json.loads(body))

    def test_an_unknown_api_path_is_a_json_404(self) -> None:
        status, headers, body = request(app_module.app, "GET", "/api/definitely-not-a-route")
        self.assertEqual(status, 404)
        self.assertTrue(headers["content-type"].startswith("application/json"))
        self.assertNotIn(b"<html", body.lower())

    def test_interactive_docs_and_schema_are_untouched(self) -> None:
        status, _, body = request(app_module.app, "GET", "/openapi.json")
        self.assertEqual(status, 200)
        paths = json.loads(body)["paths"]
        self.assertIn("/api/execute", paths)
        self.assertIn("/api/lessons", paths)
        self.assertFalse([p for p in paths if not p.startswith("/api/")])
        status, _, _ = request(app_module.app, "GET", "/docs")
        self.assertEqual(status, 200)

    def test_the_shell_is_served_when_a_build_exists(self) -> None:
        dist = frontend_dist()
        if dist is None:
            self.skipTest("no web/dist build on this machine")
        for path in ("/", "/learn", "/progress"):
            with self.subTest(path=path):
                status, headers, body = request(app_module.app, "GET", path)
                self.assertEqual(status, 200)
                self.assertTrue(headers["content-type"].startswith("text/html"))
                self.assertEqual(body, (dist / "index.html").read_bytes())


if __name__ == "__main__":
    unittest.main()
