#!/usr/bin/env python3
"""Credential-transport tests for the eval harness (#1410).

The harness must never carry a model API key or a forge token in a process
argument list: a secret in argv is visible to every other process on the
host and lands in shell history and CI logs. Credentials travel in the
environment only (AGENTS.md).

These tests pin both halves of that contract:

  - the CLI refuses credential arguments outright, naming only the flag
    (never the value) and pointing at the environment variables,
  - the review subprocess receives the credentials through its environment,
    and its argv carries neither of them.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
_SCRIPTS_DIR = ROOT / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import eval_harness


HARNESS = _SCRIPTS_DIR / "eval_harness.py"
CORPUS = ROOT / "evals" / "corpus-agentic.json"

# Distinct sentinels: a leak of either one into a message, a log or an argv
# is the failure these tests exist to catch.
API_KEY_SECRET = "sk-test-secret-9f3a2b"
TOKEN_SECRET = "ghp-test-token-4c7d1e"

REPO = "misospace/pr-reviewer-action"
PR_NUMBER = 547
REPO_DIR_NAME = REPO.replace("/", "-")
PR_ENTRY = {"number": PR_NUMBER, "repo_full_name": REPO}

# The fake orchestrator: records its own argv and the credential-bearing
# environment it was handed, so the test can assert where each credential
# traveled. Modelled on the fake orchestrator in
# tests/test_eval_harness_boundary.py.
RECORDER_SCRIPT = """#!/usr/bin/env bash
set -u
python3 - <<'PY'
import json, os, sys
snapshot = {
    "argv": sys.argv,
    "env": {
        key: os.environ.get(key)
        for key in ("AI_API_KEY", "GITHUB_TOKEN", "GH_TOKEN")
    },
}
with open("child-snapshot.json", "w", encoding="utf-8") as handle:
    json.dump(snapshot, handle)
PY
exit 0
"""

# The node shim: stands in for the runtime's interpreter and records the
# argv the harness invoked it with, plus the credential-bearing environment
# it received. Modelled on the shim in tests/test_eval_harness_boundary.py.
# It also drops a marker file, so a test can prove the harness never
# spawned a runtime at all.
NODE_SHIM = """#!/usr/bin/env bash
set -u
printf '%s\\n' "$@" > argv.txt
if [ -n "${HARNESS_RUNTIME_MARKER:-}" ]; then
  : > "$HARNESS_RUNTIME_MARKER"
fi
python3 - <<'PY'
import json, os
with open("child-env.json", "w", encoding="utf-8") as handle:
    json.dump(
        {k: os.environ.get(k) for k in ("AI_API_KEY", "GITHUB_TOKEN", "GH_TOKEN")},
        handle,
    )
PY
exit 0
"""


def _git(path: Path, *args: str) -> str:
    """Run a git command in `path`; return stripped stdout (checked)."""
    env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
    result = subprocess.run(
        ["git", "-C", str(path), *args],
        check=True, capture_output=True, text=True, env=env,
    )
    return result.stdout.strip()


def _work_dir_with_repo(tmp_path: Path) -> Path:
    """Materialize the run's repo dir as a clone of a local origin.

    The origin advertises refs/pull/<PR>/head, so the harness materializes
    the corpus PR's exact head with no network access.
    """
    origin = tmp_path / "origin"
    origin.mkdir()
    _git(origin, "init", "-b", "main")
    _git(origin, "config", "user.email", "eval@test")
    _git(origin, "config", "user.name", "eval")
    (origin / "marker.txt").write_text("base\n", encoding="utf-8")
    _git(origin, "add", "marker.txt")
    _git(origin, "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "commit", "-m", "base")
    base_sha = _git(origin, "rev-parse", "HEAD")
    (origin / "marker.txt").write_text(f"{PR_NUMBER}\n", encoding="utf-8")
    _git(origin, "add", "marker.txt")
    _git(origin, "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "commit", "-m", "pr")
    _git(origin, "update-ref", f"refs/pull/{PR_NUMBER}/head", "HEAD")
    _git(origin, "update-ref", "refs/heads/main", base_sha)
    _git(tmp_path, "clone", str(origin), REPO_DIR_NAME)
    return tmp_path / REPO_DIR_NAME


def _harness_env(marker_dir: Path) -> dict[str, str]:
    """A sanitized environment for the harness subprocess.

    The ambient credentials are stripped (the harness must not need them to
    refuse a credential argument) and a fake `node` shim is put first on
    PATH so a spawned runtime would leave a marker behind.
    """
    env = {
        key: value
        for key, value in os.environ.items()
        if key not in ("AI_API_KEY", "GITHUB_TOKEN", "GH_TOKEN")
    }
    shim_dir = marker_dir / "bin"
    shim_dir.mkdir(parents=True, exist_ok=True)
    shim = shim_dir / "node"
    shim.write_text(NODE_SHIM, encoding="utf-8")
    shim.chmod(0o755)
    env["PATH"] = str(shim_dir) + os.pathsep + env.get("PATH", "")
    env["HARNESS_RUNTIME_MARKER"] = str(marker_dir / "runtime-spawned")
    return env


def _run_harness_cli(args: list[str], env: dict[str, str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(HARNESS), *args],
        capture_output=True, text=True, cwd=str(ROOT), env=env, timeout=120,
    )


class TestCredentialArgumentsRefused:
    """A credential passed as an argument must be refused, not used."""

    def test_harness_refuses_api_key_argument(self, tmp_path: Path) -> None:
        env = _harness_env(tmp_path)
        report_path = tmp_path / "report.json"

        result = _run_harness_cli(
            [
                "--corpus", str(CORPUS),
                "--dry-run",
                "--output", str(report_path),
                "--api-key", API_KEY_SECRET,
            ],
            env,
        )

        assert result.returncode != 0
        assert result.returncode == 2
        # The refusal names the flag...
        assert "--api-key" in result.stderr
        # ...and points at the environment variables that carry it.
        assert "AI_API_KEY" in result.stderr
        assert "GITHUB_TOKEN" in result.stderr
        # The secret itself never reaches a message, a log or an artifact.
        assert API_KEY_SECRET not in result.stderr
        assert API_KEY_SECRET not in result.stdout
        assert not report_path.exists()
        # The harness refused before planning or spawning anything.
        assert "Would run" not in result.stdout
        assert "Loaded" not in result.stderr
        # The runtime was never spawned.
        assert not (tmp_path / "runtime-spawned").exists()

    def test_harness_refuses_github_token_argument(self, tmp_path: Path) -> None:
        env = _harness_env(tmp_path)
        report_path = tmp_path / "report.json"

        result = _run_harness_cli(
            [
                "--corpus", str(CORPUS),
                "--dry-run",
                "--output", str(report_path),
                "--github-token", TOKEN_SECRET,
            ],
            env,
        )

        assert result.returncode != 0
        assert result.returncode == 2
        assert "--github-token" in result.stderr
        assert "GITHUB_TOKEN" in result.stderr
        assert "GH_TOKEN" in result.stderr
        assert TOKEN_SECRET not in result.stderr
        assert TOKEN_SECRET not in result.stdout
        assert not report_path.exists()
        assert "Would run" not in result.stdout
        assert "Loaded" not in result.stderr
        # The runtime was never spawned.
        assert not (tmp_path / "runtime-spawned").exists()

    def test_abbreviated_credential_argument_is_refused_by_the_cli(
        self, tmp_path: Path
    ) -> None:
        """The CLI must not echo the value of a refused abbreviation.

        argparse accepts an unambiguous abbreviation of an option, and its
        "unrecognized arguments" message prints the value. The harness
        refuses the argument itself, so the secret stays out of the log.
        """
        env = _harness_env(tmp_path)

        result = _run_harness_cli(
            [
                "--corpus", str(CORPUS),
                "--dry-run",
                "--api-k", API_KEY_SECRET,
            ],
            env,
        )

        assert result.returncode == 2
        assert "--api-key" in result.stderr
        assert API_KEY_SECRET not in result.stderr
        assert API_KEY_SECRET not in result.stdout
        # The runtime was never spawned.
        assert not (tmp_path / "runtime-spawned").exists()

    def test_inline_credential_argument_is_refused_without_echoing_it(self) -> None:
        """The `--flag=value` form is refused too, and its value is dropped."""
        message = eval_harness._refuse_unrecognized_arguments(
            [f"--api-key={API_KEY_SECRET}", "--modes", "tools_off"]
        )

        assert message is not None
        assert "--api-key" in message
        assert API_KEY_SECRET not in message
        assert "AI_API_KEY" in message

    def test_abbreviated_credential_argument_is_refused_without_echoing_it(self) -> None:
        """An abbreviation of a credential flag is refused as well.

        argparse accepted every unambiguous abbreviation of `--api-key`
        before the option was removed, so the abbreviation is a credential
        argument too. argparse's own "unrecognized arguments" message echoes
        the value, which is why the harness refuses the argument itself.
        """
        message = eval_harness._refuse_unrecognized_arguments(
            ["--api-k", API_KEY_SECRET]
        )

        assert message is not None
        assert "--api-key" in message
        assert API_KEY_SECRET not in message
        assert "AI_API_KEY" in message

    def test_unknown_argument_is_refused_without_echoing_it(self) -> None:
        """An argument the harness does not know is refused, not echoed.

        An unknown argument may be a credential the operator mistyped, so
        the refusal names no argument at all.
        """
        message = eval_harness._refuse_unrecognized_arguments(
            ["--not-a-flag", "some-value"]
        )

        assert message is not None
        assert "--not-a-flag" not in message
        assert "some-value" not in message

    def test_clean_argv_is_not_rejected(self) -> None:
        assert eval_harness._refuse_unrecognized_arguments([]) is None

    def test_parser_exposes_no_credential_option(self) -> None:
        option_strings = {
            option
            for action in eval_harness.build_parser()._actions
            for option in action.option_strings
        }

        assert "--api-key" not in option_strings
        assert "--github-token" not in option_strings


class TestCredentialsTravelInTheEnvironment:
    """The review subprocess is handed the credentials, never the argv."""

    def test_harness_reads_credentials_from_environment(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("AI_API_KEY", API_KEY_SECRET)
        monkeypatch.setenv("GITHUB_TOKEN", TOKEN_SECRET)
        monkeypatch.delenv("GH_TOKEN", raising=False)
        repo_path = _work_dir_with_repo(tmp_path)
        script = tmp_path / "recorder.sh"
        script.write_text(RECORDER_SCRIPT, encoding="utf-8")
        script.chmod(0o755)

        model_config = {
            "model": "dummy-model",
            "base_url": "http://localhost:9/v1",
            "api_key": os.environ.get("AI_API_KEY", ""),
            "github_token": eval_harness._resolve_forge_token(),
        }

        run = eval_harness.run_review_for_pr(
            PR_ENTRY, "native_loop", tmp_path, model_config,
            deep_review=False, review_script=script,
        )

        assert run.error is None
        snapshot = json.loads(
            (repo_path / "child-snapshot.json").read_text(encoding="utf-8")
        )
        # The credentials reached the child through the environment...
        assert snapshot["env"]["AI_API_KEY"] == API_KEY_SECRET
        assert snapshot["env"]["GITHUB_TOKEN"] == TOKEN_SECRET
        assert snapshot["env"]["GH_TOKEN"] == TOKEN_SECRET
        # ...and through neither of its argv.
        argv_text = " ".join(snapshot["argv"])
        assert API_KEY_SECRET not in argv_text
        assert TOKEN_SECRET not in argv_text

    def test_ambient_forge_token_survives_an_empty_resolved_token(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A caller that resolves no token leaves the ambient token alone.

        ``run_review_for_pr`` is a seam other tooling calls. When the
        resolved token is empty, the child keeps the ambient token instead of
        inheriting an empty name.
        """
        monkeypatch.setenv("AI_API_KEY", API_KEY_SECRET)
        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        monkeypatch.setenv("GH_TOKEN", TOKEN_SECRET)
        repo_path = _work_dir_with_repo(tmp_path)
        script = tmp_path / "recorder.sh"
        script.write_text(RECORDER_SCRIPT, encoding="utf-8")
        script.chmod(0o755)

        model_config = {
            "model": "dummy-model",
            "base_url": "http://localhost:9/v1",
            "api_key": os.environ.get("AI_API_KEY", ""),
            "github_token": "",
        }

        run = eval_harness.run_review_for_pr(
            PR_ENTRY, "native_loop", tmp_path, model_config,
            deep_review=False, review_script=script,
        )

        assert run.error is None
        snapshot = json.loads(
            (repo_path / "child-snapshot.json").read_text(encoding="utf-8")
        )
        assert snapshot["env"]["GH_TOKEN"] == TOKEN_SECRET
        # The empty resolution does not blank out a name the child needs.
        assert snapshot["env"]["GITHUB_TOKEN"] is None

    def test_harness_child_command_has_no_credential_in_argv(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The production command (`node <bundle> run`) carries no credential."""
        monkeypatch.setenv("AI_API_KEY", API_KEY_SECRET)
        monkeypatch.setenv("GITHUB_TOKEN", TOKEN_SECRET)
        monkeypatch.delenv("GH_TOKEN", raising=False)
        repo_path = _work_dir_with_repo(tmp_path)

        entrypoint = tmp_path / "dist" / "index.js"
        entrypoint.parent.mkdir()
        entrypoint.write_text("// test placeholder\n", encoding="utf-8")
        monkeypatch.setattr(eval_harness, "RUNTIME_ENTRYPOINT", entrypoint)
        shim_dir = tmp_path / "bin"
        shim_dir.mkdir()
        shim = shim_dir / "node"
        shim.write_text(NODE_SHIM, encoding="utf-8")
        shim.chmod(0o755)
        monkeypatch.setenv(
            "PATH", str(shim_dir) + os.pathsep + os.environ.get("PATH", "")
        )

        model_config = {
            "model": "dummy-model",
            "base_url": "http://localhost:9/v1",
            "api_key": os.environ.get("AI_API_KEY", ""),
            "github_token": eval_harness._resolve_forge_token(),
        }

        run = eval_harness.run_review_for_pr(
            PR_ENTRY, "tools_off", tmp_path, model_config,
        )

        assert run.error is None
        argv = (repo_path / "argv.txt").read_text(encoding="utf-8").splitlines()
        assert argv == [str(entrypoint), "run"]
        argv_text = " ".join(argv)
        assert API_KEY_SECRET not in argv_text
        assert TOKEN_SECRET not in argv_text
        # The same credentials are in the child's environment instead.
        child_env = json.loads(
            (repo_path / "child-env.json").read_text(encoding="utf-8")
        )
        assert child_env["AI_API_KEY"] == API_KEY_SECRET
        assert child_env["GITHUB_TOKEN"] == TOKEN_SECRET
        assert child_env["GH_TOKEN"] == TOKEN_SECRET


class TestMainResolvesCredentialsFromEnvironment:
    """The CLI path resolves both credentials from the environment."""

    def test_main_passes_environment_credentials_to_the_review(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("AI_API_KEY", API_KEY_SECRET)
        monkeypatch.setenv("GITHUB_TOKEN", TOKEN_SECRET)
        monkeypatch.delenv("GH_TOKEN", raising=False)
        captured: dict[str, dict] = {}

        def fake_run_review_for_pr(pr, mode, work_dir, model_config, **kwargs):
            captured["model_config"] = model_config
            return eval_harness.ReviewRun(
                mode=mode, pr_number=pr["number"],
                repo_full_name=pr["repo_full_name"],
            )

        corpus_path = tmp_path / "corpus.json"
        corpus_path.write_text(
            json.dumps({
                "benchmark_corpus": [
                    {"number": 1, "repo_full_name": "test/repo",
                     "url": "https://github.com/test/repo/pull/1",
                     "known_findings": []},
                ],
            }),
            encoding="utf-8",
        )
        output_path = tmp_path / "report.json"
        monkeypatch.setattr(eval_harness, "run_review_for_pr", fake_run_review_for_pr)
        monkeypatch.setattr(sys, "argv", [
            "eval_harness.py",
            "--corpus", str(corpus_path),
            "--modes", "tools_off",
            "--output", str(output_path),
        ])

        exit_code = eval_harness.main()

        assert exit_code == 0
        model_config = captured["model_config"]
        assert model_config["api_key"] == API_KEY_SECRET
        assert model_config["github_token"] == TOKEN_SECRET

    def test_forge_token_falls_back_to_gh_token(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        monkeypatch.setenv("GH_TOKEN", TOKEN_SECRET)

        assert eval_harness._resolve_forge_token() == TOKEN_SECRET


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
