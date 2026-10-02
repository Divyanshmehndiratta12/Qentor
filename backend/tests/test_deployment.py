"""Production packaging: the health check, the database location, and that nothing secret can end up in git or the image."""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from qentor.api import app as app_module

REPO = Path(__file__).resolve().parents[2]
BACKEND = REPO / "backend"


class TestHealth(unittest.TestCase):
    def test_health_says_only_that_it_is_up(self) -> None:
        self.assertEqual(app_module.health(), {"status": "ok", "service": "qentor"})

    def test_health_is_an_api_route_registered_before_the_static_fallback(self) -> None:
        paths = [getattr(r, "path", None) for r in app_module.app.routes]
        self.assertIn("/api/health", paths)
        self.assertLess(paths.index("/api/health"), paths.index("/{path:path}") if "/{path:path}" in paths else len(paths))
        self.assertEqual(paths.count("/api/health"), 1)


class TestSupportedProcessConfiguration(unittest.TestCase):
    """The supported production process: ONE uvicorn process that imports qentor.api.app (which preloads the native
    backends on the main thread, qentor/execution/runtime.py). No extra worker processes, no reloader."""

    def commands(self) -> dict[str, str]:
        return {
            "Dockerfile": (REPO / "Dockerfile").read_text(encoding="utf-8"),
            "serve_production.sh": (BACKEND / "scripts" / "serve_production.sh").read_text(encoding="utf-8"),
        }

    def test_every_launcher_starts_the_app_module_under_plain_uvicorn(self) -> None:
        for name, text in self.commands().items():
            self.assertIn("uvicorn qentor.api.app:app", text, name)

    def test_no_launcher_adds_a_reloader_or_extra_workers(self) -> None:
        for name, text in self.commands().items():
            for flag in ("--reload", "--workers", "--no-preload"):
                self.assertNotIn(flag, text, f"{name} must not use {flag}")

    def test_importing_the_app_module_is_what_preloads_the_backends(self) -> None:
        source = (BACKEND / "qentor" / "api" / "app.py").read_text(encoding="utf-8")
        self.assertIn("preload_backends()", source)
        self.assertLess(source.index("preload_backends()"), source.index("_adapter = AerAdapter()"))


class TestDatabaseLocation(unittest.TestCase):
    def path_with(self, env_value: str | None) -> str:
        env = {k: v for k, v in os.environ.items() if k != "QENTOR_DB_PATH"}
        if env_value is not None:
            env["QENTOR_DB_PATH"] = env_value
        out = subprocess.run(
            [sys.executable, "-c", "from qentor.storage.db import DEFAULT_DB_PATH; print(DEFAULT_DB_PATH)"],
            cwd=BACKEND, env={**env, "PYTHONPATH": str(BACKEND)}, capture_output=True, text=True, check=True,
        )
        return out.stdout.strip()

    def test_default_is_the_git_ignored_backend_data_directory(self) -> None:
        self.assertEqual(self.path_with(None), str(BACKEND / "data" / "qentor.db"))

    def test_a_deployment_can_point_it_at_a_volume(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = str(Path(tmp) / "vol" / "qentor.db")
            self.assertEqual(self.path_with(target), target)

    def test_an_empty_value_means_the_default(self) -> None:
        self.assertEqual(self.path_with(""), str(BACKEND / "data" / "qentor.db"))


class TestNothingSecretIsPackaged(unittest.TestCase):
    def read(self, name: str) -> str:
        return (REPO / name).read_text(encoding="utf-8")

    def test_runtime_database_and_env_files_are_git_ignored(self) -> None:
        ignore = self.read(".gitignore")
        for entry in ("backend/data/", ".env", "backend/.venv/", "web/dist/"):
            self.assertIn(entry, ignore)

    def test_the_image_build_context_excludes_secrets_data_and_research(self) -> None:
        ignore = self.read(".dockerignore")
        for entry in (".git", "research", "backend/data", "backend/.env", ".env", "backend/.venv", "web/node_modules"):
            self.assertIn(entry, ignore.splitlines())

    def test_no_file_that_ships_holds_a_credential(self) -> None:
        key_like = re.compile(r"(sk-[A-Za-z0-9_-]{16,}|QENTOR_TUTOR_LLM_API_KEY\s*[=:]\s*[\"']?[A-Za-z0-9_-]{8,}|ANTHROPIC_API_KEY\s*[=:]\s*\S{8,})")
        for name in ("Dockerfile", "render.yaml", ".dockerignore", "backend/.env.example", "web/.env.example", "backend/scripts/serve_production.sh"):
            self.assertIsNone(key_like.search(self.read(name)), name)

    def test_the_env_examples_leave_the_key_blank_and_the_llm_off(self) -> None:
        example = self.read("backend/.env.example")
        self.assertRegex(example, r"(?m)^QENTOR_TUTOR_LLM_API_KEY=\s*$")
        self.assertRegex(example, r"(?m)^QENTOR_TUTOR_LLM_ENABLED=false\s*$")

    def test_the_image_runs_as_a_non_root_user_and_serves_the_built_web_app(self) -> None:
        dockerfile = self.read("Dockerfile")
        self.assertIn("USER qentor", dockerfile)
        self.assertIn("COPY --from=web /web/dist web/dist", dockerfile)
        self.assertIn("qentor.api.app:app", dockerfile)
        self.assertIn("/api/health", dockerfile)

    def test_the_blueprint_keeps_the_llm_off_and_the_key_out_of_the_file(self) -> None:
        blueprint = self.read("render.yaml")
        self.assertIn("healthCheckPath: /api/health", blueprint)
        self.assertRegex(blueprint, r'QENTOR_TUTOR_LLM_ENABLED\s*\n\s*value: "false"')
        self.assertNotRegex(blueprint, r"(?m)^\s*-\s*key:\s*QENTOR_TUTOR_LLM_API_KEY")

    def test_git_tracks_no_database_or_env_file(self) -> None:
        tracked = subprocess.run(["git", "ls-files"], cwd=REPO, capture_output=True, text=True).stdout.splitlines()
        if not tracked:
            self.skipTest("not a git checkout")
        for path in tracked:
            self.assertFalse(path.endswith((".db", ".sqlite", ".sqlite3")), path)
            name = Path(path).name
            self.assertFalse(name == ".env" or (name.startswith(".env.") and not name.endswith(".example")), path)


if __name__ == "__main__":
    unittest.main()
