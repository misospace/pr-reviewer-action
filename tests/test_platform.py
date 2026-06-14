"""Tests for pr_reviewer.platform — the Python side of the #221 seam."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from pr_reviewer.platform import PlatformUnsupported, gh_argv, resolve_platform


def _env(**kwargs):
    return patch.dict("os.environ", kwargs, clear=False)


class TestResolvePlatform(unittest.TestCase):
    def test_default_is_github(self):
        with _env(PLATFORM=""):
            self.assertEqual(resolve_platform(), "github")

    def test_explicit_values(self):
        with _env(PLATFORM="github"):
            self.assertEqual(resolve_platform(), "github")
        with _env(PLATFORM="Forgejo"):
            self.assertEqual(resolve_platform(), "forgejo")

    def test_auto_github_com(self):
        with _env(PLATFORM="auto", GITHUB_SERVER_URL="https://github.com"):
            self.assertEqual(resolve_platform(), "github")

    def test_auto_custom_host_is_forgejo(self):
        with _env(PLATFORM="auto", GITHUB_SERVER_URL="https://forgejo.example.com"):
            self.assertEqual(resolve_platform(), "forgejo")

    def test_auto_forgejo_api_url_wins(self):
        with _env(
            PLATFORM="auto",
            FORGEJO_API_URL="https://forgejo.example.com",
            GITHUB_SERVER_URL="https://github.com",
        ):
            self.assertEqual(resolve_platform(), "forgejo")

    def test_auto_no_server_is_github(self):
        with _env(PLATFORM="auto", GITHUB_SERVER_URL="", FORGEJO_API_URL=""):
            self.assertEqual(resolve_platform(), "github")

    def test_invalid_raises(self):
        with _env(PLATFORM="gitlab"):
            with self.assertRaises(ValueError):
                resolve_platform()


class TestGhArgv(unittest.TestCase):
    def test_github_argv_is_byte_identical(self):
        with _env(PLATFORM="github"):
            self.assertEqual(
                gh_argv(["api", "graphql", "-f", "query=Q"]),
                ["gh", "api", "graphql", "-f", "query=Q"],
            )

    def test_forgejo_raises_unsupported(self):
        with _env(PLATFORM="forgejo"):
            with self.assertRaises(PlatformUnsupported):
                gh_argv(["api", "graphql"])


if __name__ == "__main__":
    unittest.main()
