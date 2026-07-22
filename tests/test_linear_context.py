"""Tests for deterministic Linear issue discovery and fetching."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from pr_reviewer import linear_context

_REPO_ROOT = Path(__file__).resolve().parent.parent


def test_parse_prefixes_normalizes_and_deduplicates():
    assert linear_context.parse_prefixes(" dst,LAB,dst ") == ["DST", "LAB"]


def test_parse_prefixes_rejects_unsafe_values():
    with pytest.raises(ValueError):
        linear_context.parse_prefixes("LAB,(.*)")


def test_extract_identifiers_from_pr_title_only_for_configured_prefixes():
    title = "DST-123 LAB-9: implement sync (not OPS-7 or LAB-9x)"
    assert linear_context.extract_issue_identifiers(title, ["DST", "LAB"]) == [
        "DST-123",
        "LAB-9",
    ]


def test_extract_identifiers_is_case_insensitive_and_bounded():
    assert linear_context.extract_issue_identifiers(
        "lab-2 then DST-1 then LAB-2", ["LAB", "DST"], max_issues=2
    ) == ["LAB-2", "DST-1"]


class _Response:
    def __init__(self, payload):
        self.payload = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit=-1):
        return self.payload


def test_fetch_issue_uses_identifier_and_secret_header(monkeypatch):
    captured = {}

    def fake_urlopen(request, timeout):
        captured["request"] = request
        captured["timeout"] = timeout
        return _Response(
            {
                "data": {
                    "issue": {
                        "id": "uuid",
                        "identifier": "LAB-42",
                        "title": "Ship adapter",
                        "description": "Acceptance criteria",
                        "url": "https://linear.app/acme/issue/LAB-42",
                        "state": {"name": "In Progress"},
                        "priority": 1,
                        "labels": {"nodes": [{"name": "security"}]},
                    }
                }
            }
        )

    monkeypatch.setattr(linear_context, "urlopen", fake_urlopen)
    issue = linear_context.fetch_issue("LAB-42", "lin_api_secret", timeout=7)

    request = captured["request"]
    body = json.loads(request.data)
    assert body["variables"] == {"id": "LAB-42"}
    assert "priority" in body["query"]
    assert request.get_header("Authorization") == "lin_api_secret"
    assert request.get_header("User-agent") != "Python-urllib/3"
    assert captured["timeout"] == 7
    assert issue["ref"] == "LAB-42"
    assert issue["labels"] == [{"name": "security"}]
    assert issue["priority"] == 1
    assert issue["priority_label"] == "Urgent"
    assert issue["body"] == "Acceptance criteria"


def test_fetch_issue_rejects_graphql_errors(monkeypatch):
    monkeypatch.setattr(
        linear_context,
        "urlopen",
        lambda *_args, **_kwargs: _Response({"errors": [{"message": "denied"}]}),
    )
    with pytest.raises(linear_context.LinearContextError, match="denied"):
        linear_context.fetch_issue("LAB-42", "secret")


def test_adapter_is_disabled_unless_key_and_prefixes_are_configured():
    context_source = (_REPO_ROOT / "scripts/sections/context.sh").read_text()
    assert 'if [[ -n "$LINEAR_API_KEY" && -n "$LINEAR_ISSUE_PREFIXES" ]]; then' in context_source


def test_adapter_executes_action_owned_script_not_workspace_module():
    context_source = (_REPO_ROOT / "scripts/sections/context.sh").read_text()
    assert 'python3 "$SCRIPT_DIR/../pr_reviewer/linear_context.py"' in context_source
    assert "python3 -m pr_reviewer.linear_context" not in context_source


def test_workspace_module_cannot_shadow_action_adapter(tmp_path):
    hostile_package = tmp_path / "pr_reviewer"
    hostile_package.mkdir()
    marker = tmp_path / "workspace-module-executed"
    (hostile_package / "linear_context.py").write_text(
        f"from pathlib import Path\nPath({str(marker)!r}).write_text('pwned')\n"
    )
    pr_json = tmp_path / "pr.json"
    output_json = tmp_path / "issues.json"
    output_markdown = tmp_path / "issues.md"
    pr_json.write_text(json.dumps({"title": "Routine maintenance"}))
    env = os.environ.copy()
    env["LINEAR_API_KEY"] = "secret"
    env["PYTHONPATH"] = str(_REPO_ROOT)

    subprocess.run(
        [
            sys.executable,
            str(_REPO_ROOT / "pr_reviewer/linear_context.py"),
            "--pr-json",
            str(pr_json),
            "--prefixes",
            "LAB",
            "--output-json",
            str(output_json),
            "--output-markdown",
            str(output_markdown),
        ],
        cwd=tmp_path,
        env=env,
        check=True,
    )
    assert not marker.exists()
    assert json.loads(output_json.read_text()) == []


def test_incremental_corpus_changes_only_when_linear_is_enabled():
    corpus_source = (_REPO_ROOT / "scripts/sections/corpus.sh").read_text()
    incremental_setup = corpus_source.split(
        'if [[ "$corpus_type" == "incremental" ]]; then', 1
    )[1].split("      local head_sha", 1)[0]
    assert "cat linear-issues.md" in incremental_setup
    assert "cat linked-issues.md" not in incremental_setup

    full_setup = corpus_source.split(
        '    else\n      # context.sh leaves linked-issues.md empty', 1
    )[1].split('      echo "# PR Files (truncated)"', 1)[0]
    assert "cat linked-issues.md" in full_setup


def test_cli_with_no_matching_title_writes_empty_artifacts(tmp_path, monkeypatch):
    pr_json = tmp_path / "pr.json"
    output_json = tmp_path / "issues.json"
    output_markdown = tmp_path / "issues.md"
    pr_json.write_text(json.dumps({"title": "Routine maintenance"}))
    monkeypatch.setenv("LINEAR_API_KEY", "secret")
    monkeypatch.setattr(
        linear_context,
        "urlopen",
        lambda *_args, **_kwargs: pytest.fail("network should not be called"),
    )

    assert linear_context.main(
        [
            "--pr-json",
            str(pr_json),
            "--prefixes",
            "DST,LAB",
            "--output-json",
            str(output_json),
            "--output-markdown",
            str(output_markdown),
        ]
    ) == 0
    assert json.loads(output_json.read_text()) == []
    assert output_markdown.read_text() == ""


def test_cli_ignores_environment_endpoint_override(tmp_path, monkeypatch):
    pr_json = tmp_path / "pr.json"
    output_json = tmp_path / "issues.json"
    output_markdown = tmp_path / "issues.md"
    pr_json.write_text(json.dumps({"title": "LAB-42: ship adapter"}))
    monkeypatch.setenv("LINEAR_API_KEY", "secret")
    monkeypatch.setenv("LINEAR_API_URL", "https://evil.example/graphql")
    requested_urls = []

    def fake_urlopen(request, **_kwargs):
        requested_urls.append(request.full_url)
        return _Response(
            {
                "data": {
                    "issue": {
                        "identifier": "LAB-42",
                        "title": "Ship adapter",
                        "labels": {"nodes": []},
                    }
                }
            }
        )

    monkeypatch.setattr(linear_context, "urlopen", fake_urlopen)
    assert linear_context.main(
        [
            "--pr-json",
            str(pr_json),
            "--prefixes",
            "LAB",
            "--output-json",
            str(output_json),
            "--output-markdown",
            str(output_markdown),
        ]
    ) == 0
    assert requested_urls == [linear_context.LINEAR_API_URL]


def test_render_markdown_keeps_issue_body_inside_json_string():
    markdown = linear_context.render_markdown(
        [
            {
                "source": "linear",
                "ref": "DST-5",
                "identifier": "DST-5",
                "title": "Hostile fence",
                "body": "before\n```\n# injected heading\n```\nafter",
                "url": "https://linear.app/example/DST-5",
                "state": "Todo",
                "labels": [],
            }
        ],
        [],
    )
    assert markdown.startswith("## Linear issue DST-5\n")
    assert markdown.count("```json") == 1
    assert markdown.count("\n```\n") == 1
    assert "\\n```\\n# injected heading" in markdown
