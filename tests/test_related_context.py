"""Tests for the deterministic related-code scanner (#572)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from pr_reviewer import related_context  # noqa: E402
from pr_reviewer.related_context import (  # noqa: E402
    ARTIFACT_VERSION,
    MAX_JSON_BYTES,
    MAX_MANIFESTS_PER_FILE,
    MAX_REFERENCES,
    MAX_REFERENCES_PER_SYMBOL,
    MAX_SYMBOLS,
    build_related_context,
    render_related_context_json,
    render_related_context_markdown,
)


def _git(root: Path, *args: str) -> None:
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "test",
        "GIT_AUTHOR_EMAIL": "test@example.invalid",
        "GIT_COMMITTER_NAME": "test",
        "GIT_COMMITTER_EMAIL": "test@example.invalid",
    }
    subprocess.run(["git", *args], cwd=root, env=env, check=True, capture_output=True)


def make_repo(tmp_path: Path, files: dict[str, str]) -> Path:
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init", "-q", "-b", "main")
    for name, content in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    _git(root, "add", "--", *files)
    _git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "init")
    return root


def anchors(*files: dict) -> dict:
    return {"version": 1, "files": list(files), "anchors": [], "truncated": False}


def source_file(path: str, *symbols: tuple[str, str] | str, deleted: bool = False) -> dict:
    values = []
    for value in symbols:
        if isinstance(value, tuple):
            name, confidence = value
        else:
            name, confidence = value, "high"
        values.append({"name": name, "kind": "function", "confidence": confidence, "line": 1})
    result = {"path": path, "language": "python", "symbols": values, "imports": [], "identifiers": []}
    if deleted:
        result["deleted"] = True
    return result


def test_python_reference_excludes_changed_paths_and_discovers_tests_and_manifests(tmp_path):
    root = make_repo(
        tmp_path,
        {
            "pyproject.toml": "[project]\n",
            "src/pyproject.toml": "[project]\n",
            "src/pkg/module.py": "def target():\n    return 1\n",
            "src/pkg/consumer.py": "from module import target\ntarget()\n",
            "tests/test_module.py": "from src.pkg.module import target\ntarget()\n",
            "src/pkg/module_test.py": "target()\n",
        },
    )
    result = build_related_context(
        anchors(source_file("src/pkg/module.py", "target")),
        root,
        [{"filename": "src/pkg/module.py", "status": "modified"}],
    )
    file_result = result["files"][0]
    refs = file_result["symbols"][0]["references"]
    assert result["version"] == ARTIFACT_VERSION == 1
    assert [ref["path"] for ref in refs] == [
        "src/pkg/consumer.py",
        "src/pkg/consumer.py",
        "src/pkg/module_test.py",
        "tests/test_module.py",
        "tests/test_module.py",
    ]
    assert "src/pkg/module.py" not in [ref["path"] for ref in refs]
    assert file_result["tests"] == ["src/pkg/module_test.py", "tests/test_module.py"]
    assert file_result["manifests"] == ["src/pyproject.toml", "pyproject.toml"]


def test_only_self_reference_has_no_references(tmp_path):
    root = make_repo(tmp_path, {"module.py": "def target():\n    return target\n"})
    result = build_related_context(anchors(source_file("module.py", "target")), root)
    assert result["files"][0]["symbols"] == [{"name": "target", "references": []}]
    assert result["truncated"] is False


def test_only_high_confidence_symbols_are_searched(tmp_path, monkeypatch):
    root = make_repo(tmp_path, {"module.py": "target()\nother()\n"})
    calls: list[str] = []

    def fake_grep(symbol, workspace, *, excluded_paths, timeout, max_hits):
        calls.append(symbol)
        return [], False, None

    monkeypatch.setattr(related_context, "git_grep_references", fake_grep)
    result = build_related_context(
        anchors(source_file("module.py", ("target", "high"), ("other", "medium"))),
        root,
    )
    assert calls == ["target"]
    assert [item["name"] for item in result["files"][0]["symbols"]] == ["target"]


def test_reference_caps_are_hard_and_explicit(tmp_path):
    files = {"module.py": "target()\n"}
    for index in range(6):
        files[f"refs/ref{index}.py"] = "target()\n"
    root = make_repo(tmp_path, files)
    result = build_related_context(
        anchors(source_file("module.py", "target")),
        root,
        max_references_per_symbol=2,
        max_references=2,
    )
    refs = result["files"][0]["symbols"][0]["references"]
    assert len(refs) == 2
    assert result["truncated"] is True
    assert "reference_cap" in result["truncation"]["reasons"]
    assert result["truncation"]["omitted_references"] >= 1


def test_symbol_and_reference_order_is_deterministic(tmp_path):
    root = make_repo(
        tmp_path,
        {
            "module.py": "first()\nsecond()\n",
            "z.py": "second()\nfirst()\n",
            "a.py": "first()\nsecond()\n",
        },
    )
    data = anchors(source_file("module.py", "first", "second"))
    first = build_related_context(data, root)
    second = build_related_context(data, root)
    assert first == second
    refs = first["files"][0]["symbols"]
    assert [item["name"] for item in refs] == ["first", "second"]
    assert [ref["path"] for ref in refs[0]["references"]] == ["a.py", "z.py"]


def test_test_conventions_include_go_and_js_pairings(tmp_path):
    root = make_repo(
        tmp_path,
        {
            "pkg/service.go": "func Serve() {}\n",
            "pkg/service_test.go": "func TestServe() {}\n",
            "web/app.ts": "export function render() {}\n",
            "web/app.test.ts": "render()\n",
            "web/app.spec.ts": "render()\n",
        },
    )
    data = anchors(source_file("pkg/service.go", "Serve"), source_file("web/app.ts", "render"))
    result = build_related_context(data, root)
    by_path = {entry["path"]: entry for entry in result["files"]}
    assert by_path["pkg/service.go"]["tests"] == ["pkg/service_test.go"]
    assert by_path["web/app.ts"]["tests"] == ["web/app.spec.ts", "web/app.test.ts"]


def test_deleted_changed_files_are_skipped(tmp_path):
    root = make_repo(tmp_path, {"gone.py": "target()\n", "other.py": "target()\n"})
    result = build_related_context(
        anchors(source_file("gone.py", "target", deleted=True)),
        root,
        [{"filename": "gone.py", "status": "removed"}],
    )
    assert result["files"] == []


def test_no_anchors_still_discovers_no_relationships(tmp_path):
    root = make_repo(tmp_path, {"module.py": "target()\n", "pyproject.toml": "[project]\n"})
    result = build_related_context({"version": 1, "files": [], "anchors": []}, root)
    assert result["version"] == 1
    assert result["files"] == []
    assert result["errors"] == []


def test_git_failure_degrades_to_error_artifact(tmp_path):
    nongit = tmp_path / "not-a-repo"
    nongit.mkdir()
    result = build_related_context(anchors(source_file("module.py", "target")), nongit)
    assert result["truncated"] is True
    assert result["errors"]
    assert "git ls-files" in result["errors"][0]
    assert result["files"][0]["symbols"][0]["references"] == []


def test_git_timeout_degrades_to_explicit_error(tmp_path, monkeypatch):
    root = make_repo(tmp_path, {"module.py": "target()\n"})

    def timeout(*args, **kwargs):
        return None, "", "command timed out: after 0.1s"

    monkeypatch.setattr(related_context, "_run_git", timeout)
    result = build_related_context(anchors(source_file("module.py", "target")), root, git_timeout_sec=0.1)
    assert result["truncated"] is True
    assert any("timed out" in error for error in result["errors"])


def test_secret_redaction_and_hostile_markdown_are_safe(tmp_path):
    snippet = "token=supersecret123 ` ```` boundary\nnext"
    related = {
        "version": 1,
        "files": [{
            "path": "weird`path\n.py",
            "symbols": [{"name": "target", "references": [{"path": "hostile`path.py", "line": 2, "snippet": snippet}]}],
            "tests": ["tests/test_`hostile.py"],
            "manifests": ["pyproject.toml"],
        }],
        "truncated": False,
        "errors": [],
    }
    markdown = render_related_context_markdown(related)
    assert "supersecret123" not in markdown
    assert "[REDACTED]" in markdown
    assert "\nnext" not in markdown
    assert "weird`path\\n.py" in markdown
    assert "`` weird`path\\n.py ``" in markdown
    assert "````` [REDACTED] ` ```` boundary\\nnext `````" in markdown


def test_caps_expose_default_bounds():
    assert (MAX_SYMBOLS, MAX_REFERENCES_PER_SYMBOL, MAX_REFERENCES, MAX_MANIFESTS_PER_FILE) == (
        40, 20, 200, 20
    )


def test_changed_hits_do_not_consume_reference_cap(tmp_path):
    files = {"changed.py": "target()\n"}
    for index in range(22):
        files[f"changed_{index:02d}.py"] = "target()\n"
    files["external_00.py"] = "target()\n"
    files["external_01.py"] = "target()\n"
    root = make_repo(tmp_path, files)
    result = build_related_context(
        anchors(source_file("changed.py", "target")),
        root,
        [
            {"filename": path, "status": "modified"}
            for path in ["changed.py", *[f"changed_{index:02d}.py" for index in range(22)]]
        ],
        max_references_per_symbol=1,
        max_references=1,
    )
    refs = result["files"][0]["symbols"][0]["references"]
    assert [ref["path"] for ref in refs] == ["external_00.py"]
    assert result["truncation"]["omitted_references"] == 1


def test_global_reference_cap_marks_later_symbols_unsearched(tmp_path):
    root = make_repo(
        tmp_path,
        {
            "module.py": "first()\nsecond()\n",
            "a_reference.py": "first()\n",
            "z_reference.py": "second()\n",
        },
    )
    result = build_related_context(
        anchors(source_file("module.py", "first", "second")),
        root,
        max_references_per_symbol=1,
        max_references=1,
    )
    symbols = result["files"][0]["symbols"]
    assert symbols == [
        {"name": "first", "references": [{"path": "a_reference.py", "line": 1, "snippet": "first()"}]},
        {"name": "second", "references": []},
    ]
    assert result["truncated"] is True
    assert "reference_cap" in result["truncation"]["reasons"]
    assert result["truncation"]["omitted_references"] == 1


def test_manifest_cap_is_explicit_and_deterministic(tmp_path):
    files = {"module.py": "target()\n"}
    for index in range(MAX_MANIFESTS_PER_FILE + 1):
        files[f"Dockerfile.{index:02d}"] = "FROM scratch\n"
    root = make_repo(tmp_path, files)
    result = build_related_context(anchors(source_file("module.py", "target")), root)
    manifests = result["files"][0]["manifests"]
    assert len(manifests) == MAX_MANIFESTS_PER_FILE
    assert manifests == [f"Dockerfile.{index:02d}" for index in range(MAX_MANIFESTS_PER_FILE)]
    assert result["truncation"]["omitted_manifests"] == 1
    assert "manifest_cap" in result["truncation"]["reasons"]


def test_json_cap_preserves_valid_json_and_hard_limit():
    related = {
        "version": 1,
        "files": [{
            "path": "module.py",
            "symbols": [{"name": "target", "references": [
                {"path": f"ref_{index}.py", "line": index, "snippet": "x" * 1000}
                for index in range(300)
            ]}],
            "tests": [],
            "manifests": [],
        }],
        "truncated": False,
        "errors": [],
        "truncation": {"truncated": False, "reasons": []},
    }
    rendered = render_related_context_json(related)
    assert len(rendered.encode("utf-8")) <= MAX_JSON_BYTES
    parsed = json.loads(rendered)
    assert parsed["truncated"] is True
    assert "json_cap" in parsed["truncation"]["reasons"]


def test_load_json_errors_do_not_render_oserror_details(tmp_path, monkeypatch):
    sensitive = "/sensitive/path/with-secret-token.json"

    def fail_read_text(*args, **kwargs):
        raise OSError(f"permission denied: {sensitive}")

    monkeypatch.setattr(Path, "read_text", fail_read_text)
    _, error = related_context._load_json(sensitive)
    assert error == "could not read JSON"
    assert sensitive not in error


def test_cli_writes_versioned_json_and_markdown(tmp_path):
    root = make_repo(tmp_path, {"module.py": "def target():\n    return 1\n"})
    anchor_path = tmp_path / "change-anchors.json"
    anchor_path.write_text(json.dumps(anchors(source_file("module.py", "target"))), encoding="utf-8")
    json_out = tmp_path / "related-code.json"
    md_out = tmp_path / "related-code.md"
    proc = subprocess.run(
        [
            sys.executable,
            str(PROJECT_ROOT / "scripts" / "build_related_context.py"),
            "--workspace",
            str(root),
            "--anchors",
            str(anchor_path),
            "--json",
            str(root / "related-code.json"),
            "--markdown",
            str(root / "related-code.md"),
        ],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    assert json.loads((root / "related-code.json").read_text(encoding="utf-8"))["version"] == 1
    assert "# Related Code (v1)" in (root / "related-code.md").read_text(encoding="utf-8")
    assert "related_context:" in proc.stdout
