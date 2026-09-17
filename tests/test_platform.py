"""Tests for pr_reviewer.platform — the Python side of the #221 seam."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from pr_reviewer.platform import (
    PlatformUnsupported,
    _tangled_runtime_signal_present,
    gh_argv,
    resolve_platform,
)
from pr_reviewer.tangled_context import (
    TANGLED_REQUIRED_RUNTIME_VARS,
    TangledContextError,
    load_tangled_context,
    tangled_context_or_none,
)


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
        with _env(PLATFORM="Tangled"):
            self.assertEqual(resolve_platform(), "tangled")

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

    def test_auto_tangled_runtime_signal_wins(self):
        # A non-empty TANGLED_PIPELINE_ID (or any stable TANGLED_* signal)
        # flips ``auto`` to ``tangled`` BEFORE the non-github.com host
        # fallback runs (#583). This is the primary regression test for
        # the issue's "Auto-detection must prefer a real Tangled/Spindle
        # signal before the current generic non-github.com host =>
        # forgejo fallback" requirement.
        with _env(
            PLATFORM="auto",
            TANGLED_PIPELINE_ID="at://did:plc:abc/sh.tangled.repo.pull/rkey",
            GITHUB_SERVER_URL="https://knot.tangled.org",
        ):
            self.assertEqual(resolve_platform(), "tangled")

    def test_auto_tangled_signal_wins_over_forgejo_api_url(self):
        # The Tangled check must also beat the Forgejo URL fallback, so a
        # user that has both FORGEJO_API_URL set (from a previous run) and
        # now runs under Spindle still resolves to tangled.
        with _env(
            PLATFORM="auto",
            TANGLED_REPO_DID="did:plc:abc",
            TANGLED_REPO_NAME="core",
            FORGEJO_API_URL="https://forgejo.example.com",
        ):
            self.assertEqual(resolve_platform(), "tangled")

    def test_auto_no_tangled_signal_falls_through(self):
        # Without any TANGLED_* env var the resolver must NOT advertise
        # Tangled — even when GITHUB_SERVER_URL is some non-github host.
        # This is the explicit "Tangled is never misclassified as Forgejo"
        # guard: with no Tangled signal, a non-github.com host stays
        # forgejo (existing behaviour).
        with _env(
            PLATFORM="auto",
            GITHUB_SERVER_URL="https://knot.tangled.org",
            FORGEJO_API_URL="",
        ):
            self.assertEqual(resolve_platform(), "forgejo")

    def test_invalid_raises(self):
        with _env(PLATFORM="gitlab"), self.assertRaises(ValueError):
            resolve_platform()

    def test_explicit_tangled_does_not_require_runtime_signal(self):
        # resolve_platform is a pure identity resolver; it does not gate
        # explicit ``tangled`` on the runtime context. That gate lives in
        # load_tangled_context (tangled_context.py) so a missing-runtime
        # error is reported once with a descriptive message, not silently
        # flipped to another backend.
        with _env(PLATFORM="tangled"):
            self.assertEqual(resolve_platform(), "tangled")


class TestResolvePlatformOverrides(unittest.TestCase):
    """The optional overrides added for #367 (forgejo_backend delegation)."""

    def test_platform_override_beats_env(self):
        # An explicit platform argument is authoritative over the env var.
        with _env(PLATFORM="forgejo"):
            self.assertEqual(resolve_platform(platform="github"), "github")

    def test_forgejo_api_url_override_drives_auto(self):
        # auto + a non-empty forgejo_api_url override → forgejo, regardless of
        # the (unset) FORGEJO_API_URL env var.
        with _env(
            PLATFORM="", FORGEJO_API_URL="", GITHUB_SERVER_URL="https://github.com"
        ):
            self.assertEqual(
                resolve_platform(platform="auto", forgejo_api_url="https://f.example"),
                "forgejo",
            )

    def test_empty_forgejo_api_url_override_falls_back_to_server(self):
        # An empty override means "no configured Forgejo URL"; the server-host
        # inference still applies on auto.
        with _env(GITHUB_SERVER_URL="https://forgejo.example.com"):
            self.assertEqual(
                resolve_platform(platform="auto", forgejo_api_url=""), "forgejo"
            )
        with _env(GITHUB_SERVER_URL="https://github.com"):
            self.assertEqual(
                resolve_platform(platform="auto", forgejo_api_url=""), "github"
            )

    def test_empty_platform_override_defaults_to_github(self):
        with _env(PLATFORM="forgejo"):
            self.assertEqual(resolve_platform(platform=""), "github")


class TestGhArgv(unittest.TestCase):
    def test_github_argv_is_byte_identical(self):
        with _env(PLATFORM="github"):
            self.assertEqual(
                gh_argv(["api", "graphql", "-f", "query=Q"]),
                ["gh", "api", "graphql", "-f", "query=Q"],
            )

    def test_forgejo_raises_unsupported(self):
        with _env(PLATFORM="forgejo"), self.assertRaises(PlatformUnsupported):
            gh_argv(["api", "graphql"])

    def test_tangled_raises_unsupported(self):
        # gh CLI is a GitHub-specific binary; Tangled has no equivalent.
        # PlatformUnsupported is the existing signal consumers already
        # understand — no new exception type is needed yet because Tangled
        # consumers do not exist (#583 explicitly stops before that).
        with _env(PLATFORM="tangled"), self.assertRaises(PlatformUnsupported):
            gh_argv(["api", "graphql"])


class TestTangledRuntimeSignalDetection(unittest.TestCase):
    """The detection rule must match the shell mirror in scripts/platform_api.sh."""

    def test_signal_present_when_pipeline_id_set(self):
        self.assertTrue(
            _tangled_runtime_signal_present(
                env={
                    "TANGLED_PIPELINE_ID": "at://did:plc:abc/sh.tangled.repo.pull/rkey"
                }
            )
        )

    def test_signal_present_when_pr_source_branch_set(self):
        # PR-only env vars count too, since they unambiguously identify a
        # Tangled pipeline (a non-Tangled runtime never sets them).
        self.assertTrue(
            _tangled_runtime_signal_present(env={"TANGLED_PR_SOURCE_BRANCH": "feature"})
        )

    def test_signal_absent_on_empty_env(self):
        self.assertFalse(_tangled_runtime_signal_present(env={}))

    def test_empty_value_does_not_count(self):
        # An env var exported as empty string is treated as absent — this
        # matches the shell-side [[ -n "${VAR:-}" ]] guard and prevents a
        # misconfigured workflow from accidentally flipping auto to
        # tangled. PR_NUMBER-style numeric identity is also not accepted
        # (TANGLED_PIPELINE_ID is an AT URI, not a number).
        self.assertFalse(
            _tangled_runtime_signal_present(env={"TANGLED_PIPELINE_ID": ""})
        )

    def test_unrelated_env_does_not_match(self):
        # A GitHub-style numeric PR_NUMBER must NOT be treated as a
        # Tangled signal (#583 explicitly warns against this).
        self.assertFalse(_tangled_runtime_signal_present(env={"PR_NUMBER": "42"}))


def _minimal_tangled_env(**overrides):
    """Build an env dict containing the four required Tangled runtime vars,
    ready to override with optional fields per-test.

    Pulling this into a helper keeps the TangledContext tests focused on
    the field they care about rather than re-listing the required set
    every time.
    """
    base = {
        "TANGLED_PIPELINE_ID": "at://did:plc:abc/sh.tangled.repo.pull/rkey",
        "TANGLED_PIPELINE_KIND": "pull_request",
        "TANGLED_REPO_DID": "did:plc:abc",
        "TANGLED_REPO_NAME": "core",
        "TANGLED_REPO_KNOT": "knot.tangled.org",
    }
    base.update(overrides)
    return base


class TestLoadTangledContext(unittest.TestCase):
    """The runtime-context normalizer for PLATFORM=tangled (#583)."""

    def test_returns_populated_context_on_full_env(self):
        env = _minimal_tangled_env(
            TANGLED_REPO_URL="https://tangled.org/did:plc:abc/core",
            TANGLED_REPO_DEFAULT_BRANCH="master",
            TANGLED_PR_SOURCE_BRANCH="feature-x",
            TANGLED_PR_TARGET_BRANCH="master",
            TANGLED_PR_SOURCE_SHA="deadbeef" * 5,
            TANGLED_BOBBIN_URL="https://bobbin.tangled.org",
        )
        ctx = load_tangled_context(env=env)
        self.assertEqual(ctx.pipeline_id, "at://did:plc:abc/sh.tangled.repo.pull/rkey")
        self.assertEqual(ctx.pipeline_kind, "pull_request")
        self.assertEqual(ctx.repo_did, "did:plc:abc")
        self.assertEqual(ctx.repo_name, "core")
        self.assertEqual(ctx.repo_knot, "knot.tangled.org")
        self.assertEqual(ctx.repo_url, "https://tangled.org/did:plc:abc/core")
        self.assertEqual(ctx.repo_default_branch, "master")
        self.assertEqual(ctx.source_branch, "feature-x")
        self.assertEqual(ctx.target_branch, "master")
        self.assertEqual(ctx.source_sha, "deadbeef" * 5)
        self.assertEqual(ctx.bobbin_url, "https://bobbin.tangled.org")
        self.assertTrue(ctx.is_pull_request)
        self.assertEqual(ctx.repo_identity, "did:plc:abc/core")

    def test_missing_required_var_raises_with_descriptive_error(self):
        # A bare env missing any required var must produce an explicit
        # error that names the missing variable — never silently fall
        # through. The acceptance criterion ("Missing required Tangled
        # context produces a descriptive failure rather than silently
        # resolving another backend") is asserted here.
        env = _minimal_tangled_env()
        env.pop("TANGLED_REPO_NAME")
        with self.assertRaises(TangledContextError) as cm:
            load_tangled_context(env=env)
        message = str(cm.exception)
        self.assertIn("TANGLED_REPO_NAME", message)
        self.assertIn("refusing to fall back", message)

    def test_all_required_vars_required(self):
        # The required set must NOT silently degrade — drop each in turn
        # and confirm the error names it. Guards against accidentally
        # shrinking the required set in a future refactor.
        for required in TANGLED_REQUIRED_RUNTIME_VARS:
            env = _minimal_tangled_env()
            env.pop(required)
            with self.subTest(missing=required):
                with self.assertRaises(TangledContextError) as cm:
                    load_tangled_context(env=env)
                self.assertIn(required, str(cm.exception))

    def test_push_pipeline_has_none_pr_fields(self):
        # A push pipeline legitimately lacks the TANGLED_PR_* vars. The
        # PR-only fields come back as None, never as empty string, so
        # downstream ``is None`` checks (not ``== ""``) work correctly.
        env = _minimal_tangled_env(TANGLED_PIPELINE_KIND="push")
        ctx = load_tangled_context(env=env)
        self.assertEqual(ctx.pipeline_kind, "push")
        self.assertFalse(ctx.is_pull_request)
        self.assertIsNone(ctx.source_branch)
        self.assertIsNone(ctx.target_branch)
        self.assertIsNone(ctx.source_sha)

    def test_manual_pipeline_keeps_required_fields(self):
        env = _minimal_tangled_env(TANGLED_PIPELINE_KIND="manual")
        ctx = load_tangled_context(env=env)
        self.assertEqual(ctx.pipeline_kind, "manual")
        # Manual pipelines do not target a PR — same None-for-PR-fields
        # behaviour as push.
        self.assertIsNone(ctx.source_branch)

    def test_pr_number_is_not_a_tangled_signal(self):
        # Tangled pull identity is an AT URI / rkey (#564). PR_NUMBER on
        # its own must not promote the context into a valid pull-request
        # identity. We assert this by populating only the bare required
        # set with pipeline_kind=pull_request — the PR-specific fields
        # come back None even though the pipeline declares itself a PR,
        # because Spindle must export TANGLED_PR_* separately. This
        # mirrors the pre-#564 warning in the issue body: ``PR_NUMBER``
        # must not pretend to be a numeric Tangled pull identifier.
        env = _minimal_tangled_env(TANGLED_PIPELINE_KIND="pull_request", PR_NUMBER="42")
        ctx = load_tangled_context(env=env)
        self.assertTrue(ctx.is_pull_request)
        self.assertIsNone(ctx.source_branch)
        self.assertIsNone(ctx.target_branch)
        self.assertIsNone(ctx.source_sha)


class TestTangledContextOrNone(unittest.TestCase):
    """The opportunistic loader used by auto-resolution callers."""

    def test_returns_context_when_required_vars_present(self):
        ctx = tangled_context_or_none(env=_minimal_tangled_env())
        self.assertIsNotNone(ctx)
        self.assertEqual(ctx.repo_did, "did:plc:abc")

    def test_returns_none_when_required_vars_missing(self):
        # The whole point of this helper is to let the auto path fall
        # through cleanly. A partial env (only some required vars) still
        # returns None rather than raising — that's ``load_tangled_context``'s
        # job for the explicit-mode path.
        env = {"TANGLED_PIPELINE_ID": "at://did:plc:abc/sh.tangled.repo.pull/rkey"}
        self.assertIsNone(tangled_context_or_none(env=env))

    def test_returns_none_on_empty_env(self):
        self.assertIsNone(tangled_context_or_none(env={}))


if __name__ == "__main__":
    unittest.main()
