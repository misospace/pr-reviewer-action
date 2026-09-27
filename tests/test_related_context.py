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


def _enclosing_file(path: str, name: str, line: int, changed_lines: list[list[int]] | None) -> dict:
    entry = {
        "path": path,
        "language": "python",
        "symbols": [{"name": name, "kind": "enclosing", "confidence": "high", "line": line}],
        "imports": [],
        "identifiers": [],
    }
    if changed_lines is not None:
        entry["changed_lines"] = changed_lines
    return entry


def _changed(path: str, changed_lines: list[list[int]]) -> dict:
    return {"path": path, "language": "python", "symbols": [], "imports": [], "identifiers": [],
            "changed_lines": changed_lines}


_JWT_MODULE = (
    "def fetch_jwt():\n"          # 1
    "    with LOCK:\n"            # 2 (added)
    "        return 'a'\n"        # 3 (added)
    "\n"                          # 4
    "\n"                          # 5
    "def get_jwt():\n"            # 6
    "    return fetch_jwt()\n"    # 7
)
_JWT_TEST = (
    "def test_old():\n"           # 1
    "    fetch_jwt()\n"           # 2
    "def test_new():\n"           # 3 (added)
    "    fetch_jwt()\n"           # 4 (added)
)


def test_enclosing_symbol_lists_changed_file_references_after_unchanged(tmp_path):
    root = make_repo(tmp_path, {
        "src/jwt.py": _JWT_MODULE,
        "tests/test_jwt.py": _JWT_TEST,
        "src/prewarm.py": "fetch_jwt()\n",
    })
    result = build_related_context(
        anchors(
            _enclosing_file("src/jwt.py", "fetch_jwt", 1, [[2, 3]]),
            _changed("tests/test_jwt.py", [[3, 4]]),
        ),
        root,
    )
    refs = result["files"][0]["symbols"][0]["references"]
    assert [(r["path"], r["line"], r.get("changed_file", False)) for r in refs] == [
        ("src/prewarm.py", 1, False),
        ("src/jwt.py", 7, True),
        ("tests/test_jwt.py", 2, True),
    ]
    assert result["truncated"] is False
    markdown = render_related_context_markdown(result)
    assert "- `src/jwt.py`:7 (changed file) — `    return fetch_jwt()`" in markdown
    assert "- `src/prewarm.py`:1 — `fetch_jwt()`" in markdown


def test_enclosing_declaration_line_is_never_its_own_reference(tmp_path):
    # The declaration (line 1) sits outside changed_lines, so only the
    # own-declaration rule can drop it; the same-file caller (line 7) stays.
    root = make_repo(tmp_path, {"src/jwt.py": _JWT_MODULE})
    result = build_related_context(anchors(_enclosing_file("src/jwt.py", "fetch_jwt", 1, [[2, 3]])), root)
    refs = [(r["path"], r["line"]) for r in result["files"][0]["symbols"][0]["references"]]
    assert ("src/jwt.py", 1) not in refs
    assert ("src/jwt.py", 7) in refs


def test_changed_file_references_have_their_own_cap(tmp_path):
    root = make_repo(tmp_path, {"src/jwt.py": _JWT_MODULE, "tests/test_jwt.py": _JWT_TEST})
    result = build_related_context(
        anchors(
            _enclosing_file("src/jwt.py", "fetch_jwt", 1, [[2, 3]]),
            _changed("tests/test_jwt.py", [[3, 4]]),
        ),
        root,
        max_changed_references_per_symbol=1,
    )
    refs = result["files"][0]["symbols"][0]["references"]
    assert [(r["path"], r["line"]) for r in refs] == [("src/jwt.py", 7)]
    assert result["truncation"]["reasons"] == ["reference_cap"]
    assert result["truncation"]["omitted_references"] == 1


def test_changed_file_references_need_changed_lines(tmp_path):
    root = make_repo(tmp_path, {"src/jwt.py": _JWT_MODULE})
    result = build_related_context(anchors(_enclosing_file("src/jwt.py", "fetch_jwt", 1, None)), root)
    symbol = result["files"][0]["symbols"][0]
    assert symbol == {"name": "fetch_jwt", "references": []}
    assert "`fetch_jwt`: no references" in render_related_context_markdown(result)


def test_added_declaration_referenced_only_in_changed_files(tmp_path):
    root = make_repo(tmp_path, {"src/jwt.py": _JWT_MODULE, "tests/test_jwt.py": _JWT_TEST})
    entry = _changed("src/jwt.py", [[1, 3]])
    entry["symbols"] = [
        {"name": "fetch_jwt", "kind": "function", "confidence": "high", "line": 1},
        {"name": "test_new", "kind": "function", "confidence": "high", "line": 3},
    ]
    result = build_related_context(anchors(entry, _changed("tests/test_jwt.py", [[3, 4]])), root)
    symbols = result["files"][0]["symbols"]
    assert symbols[0] == {"name": "fetch_jwt", "references": [], "only_in_changed_files": True}
    assert symbols[1] == {"name": "test_new", "references": []}
    markdown = render_related_context_markdown(result)
    assert "- `fetch_jwt`: references only in changed files" in markdown
    assert "- `test_new`: no references" in markdown


def test_changed_lines_hostile_paths_are_literal_pathspecs(tmp_path):
    root = make_repo(tmp_path, {"src/jwt.py": _JWT_MODULE, "src/x.py": "fetch_jwt()\n"})
    result = build_related_context(
        anchors(
            _enclosing_file("src/jwt.py", "fetch_jwt", 1, [[2, 3]]),
            _changed("src/*.py", []),
        ),
        root,
    )
    refs = result["files"][0]["symbols"][0]["references"]
    assert [(r["path"], r["line"]) for r in refs] == [("src/x.py", 1), ("src/jwt.py", 7)]
    assert all(r.get("changed_file") is not True for r in refs if r["path"] == "src/x.py")


def test_changed_test_files_cannot_crowd_out_production_callers(tmp_path):
    test_calls = "".join(f"def test_{i}():\n    fetch_jwt()\n" for i in range(4))
    root = make_repo(tmp_path, {
        "src/jwt.py": _JWT_MODULE,
        "src/__tests__/test_jwt.py": test_calls,
        "src/worker.py": "fetch_jwt()\n",
    })
    files = (
        _enclosing_file("src/jwt.py", "fetch_jwt", 1, [[2, 3]]),
        _changed("src/__tests__/test_jwt.py", []),
        _changed("src/worker.py", []),
    )
    result = build_related_context(anchors(*files), root, max_changed_references_per_symbol=2)
    refs = result["files"][0]["symbols"][0]["references"]
    assert [(r["path"], r["line"]) for r in refs] == [("src/jwt.py", 7), ("src/worker.py", 1)]
    assert result["truncation"]["reasons"] == ["reference_cap"]
    assert result["truncation"]["omitted_references"] == 1

    result = build_related_context(anchors(*files), root, max_changed_references_per_symbol=3)
    refs = result["files"][0]["symbols"][0]["references"]
    assert [(r["path"], r["line"]) for r in refs] == [
        ("src/jwt.py", 7), ("src/worker.py", 1), ("src/__tests__/test_jwt.py", 2),
    ]


# ---------------------------------------------------------------------------
# Consumers of changed keys and referenced counterparts (#791)
# ---------------------------------------------------------------------------

from pr_reviewer.related_context import key_variants  # noqa: E402


def _key_file(path: str, keys: list[tuple[str, str, int]], changed_lines: list[list[int]] | None = None,
              counterparts: list[dict] | None = None) -> dict:
    entry = {"path": path, "language": "unknown", "symbols": [], "imports": [], "identifiers": []}
    if changed_lines is not None:
        entry["changed_lines"] = changed_lines
    if keys:
        entry["keys"] = [{"name": name, "kind": kind, "line": line} for name, kind, line in keys]
    if counterparts:
        entry["counterparts"] = counterparts
    return entry


def _refs(result: dict, key: str) -> list[tuple[str, int, bool]]:
    for consumer in result.get("consumers", []):
        if consumer["key"] == key:
            return [(ref["path"], ref["line"], ref.get("changed_file", False)) for ref in consumer["references"]]
    return []


def test_key_variants():
    assert key_variants("evidence-providers-file") == [
        "evidence-providers-file", "evidence_providers_file", "EVIDENCE_PROVIDERS_FILE", "INPUT_EVIDENCE_PROVIDERS_FILE",
    ]
    assert key_variants("--dry-run-mode") == ["dry-run-mode", "dry_run_mode", "DRY_RUN_MODE", "INPUT_DRY_RUN_MODE"]
    assert key_variants("INPUT_REVIEW_MODE") == ["INPUT_REVIEW_MODE", "review-mode", "review_mode", "REVIEW_MODE"]
    assert key_variants("platform") == []
    assert key_variants("platform", "branch") == ["platform", "PLATFORM"]
    assert key_variants("resolvedPlatform", "branch") == ["resolvedPlatform", "resolved_platform", "RESOLVED_PLATFORM"]


def test_consumers_rank_code_before_docs_and_tests(tmp_path):
    root = make_repo(tmp_path, {
        "contracts/action.yml": "  - id: evidence-providers-file\n    repo-configurable: true\n",
        "scripts/run_providers.py": (
            "import os\n\n"
            "def main():\n"
            '    path = os.getenv("EVIDENCE_PROVIDERS_FILE", "")\n'
            "    return path\n"
        ),
        "docs/inputs.md": "Set `evidence-providers-file` to a path.\n",
        "tests/test_run_providers.py": 'os.environ["EVIDENCE_PROVIDERS_FILE"] = "x"\n',
        "scripts/notes.sh": "# reads EVIDENCE_PROVIDERS_FILE\n",
    })
    result = build_related_context(
        anchors(_key_file("contracts/action.yml", [("evidence-providers-file", "entity", 2)])), root,
        max_consumers_per_key=4,
    )
    assert _refs(result, "evidence-providers-file") == [
        ("scripts/run_providers.py", 4, False),
        ("scripts/notes.sh", 1, False),
        ("docs/inputs.md", 1, False),
        ("tests/test_run_providers.py", 1, False),
    ]
    first = result["consumers"][0]["references"][0]
    assert first["match"] == "EVIDENCE_PROVIDERS_FILE"
    assert first["start"] == 2
    assert first["lines"] == ["", "def main():", '    path = os.getenv("EVIDENCE_PROVIDERS_FILE", "")', "    return path"]
    markdown = render_related_context_markdown(result)
    assert markdown.index("## Consumers of Changed Keys") < markdown.index("## Changed Files")
    assert "- `evidence-providers-file` (entity, `contracts/action.yml`:2):" in markdown
    assert "  - `scripts/run_providers.py`:4 as `EVIDENCE_PROVIDERS_FILE`" in markdown
    assert '    4:     path = os.getenv("EVIDENCE_PROVIDERS_FILE", "")' in markdown


def test_consumer_caps_are_breadth_first_and_explicit(tmp_path):
    files = {"cfg.yml": "a: 1\n"}
    for key in ("alpha_setting", "beta_setting"):
        for index in range(3):
            files[f"src/{key}_{index}.py"] = f'X = os.getenv("{key.upper()}")\n'
    root = make_repo(tmp_path, files)
    data = anchors(_key_file("cfg.yml", [("alpha-setting", "entity", 1), ("beta-setting", "entity", 1)]))
    result = build_related_context(data, root, max_consumers_per_key=2, max_consumers=3)
    assert [len(c["references"]) for c in result["consumers"]] == [2, 1]
    assert "consumer_cap" in result["truncation"]["reasons"]
    assert result["truncated"] is True


def test_too_common_keys_are_dropped(tmp_path, monkeypatch):
    monkeypatch.setattr(related_context, "MAX_CONSUMER_SCAN", 2)
    root = make_repo(tmp_path, {"cfg.yml": "a: 1\n", **{f"s{i}.py": 'os.getenv("COMMON_SETTING")\n' for i in range(3)}})
    result = build_related_context(anchors(_key_file("cfg.yml", [("common-setting", "entity", 1)])), root)
    assert "consumers" not in result


def test_consumer_windows_are_budgeted_breadth_first(tmp_path, monkeypatch):
    monkeypatch.setattr(related_context, "MAX_CONSUMER_WINDOWS", 2)
    root = make_repo(tmp_path, {
        "cfg.yml": "a: 1\n",
        "a.py": 'A = os.getenv("FIRST_SETTING")\nB = os.getenv("FIRST_SETTING")\n',
        "b.py": 'A = os.getenv("FIRST_SETTING")\n',
        "c.py": 'C = os.getenv("SECOND_SETTING")\n',
    })
    data = anchors(_key_file("cfg.yml", [("first-setting", "entity", 1), ("second-setting", "entity", 1)]))
    result = build_related_context(data, root)
    first, second = result["consumers"]
    assert [("lines" in ref, "snippet" in ref) for ref in first["references"]] == [(True, False), (False, True)]
    assert "lines" in second["references"][0]
    assert first["references"][1]["snippet"] == 'A = os.getenv("FIRST_SETTING")'
    assert '  - `b.py`:1 as `FIRST_SETTING` — `A = os.getenv("FIRST_SETTING")`' in render_related_context_markdown(result)


def test_changed_file_consumers_skip_added_lines_and_own_entity_file(tmp_path):
    root = make_repo(tmp_path, {
        "contracts/action.yml": "  - id: evidence-providers-file\n    repo-configurable: true\n# evidence_providers_file\n",
        "action.yml": (
            "inputs:\n"
            "  evidence_providers_file:\n"         # 2 (added)
            "runs:\n"
            "  env:\n"
            "    EVIDENCE_PROVIDERS_FILE: x\n"     # 5
            "    # EVIDENCE_PROVIDERS_FILE docs\n"  # 6 (comment)
        ),
        "README.md": "`evidence_providers_file` input\n",
        "scripts/run.py": 'os.getenv("EVIDENCE_PROVIDERS_FILE")\n',
    })
    data = anchors(
        _key_file("contracts/action.yml", [("evidence-providers-file", "entity", 2)], [[2, 2]]),
        _key_file("action.yml", [], [[2, 2]]),
        _key_file("README.md", [], [[5, 5]]),
    )
    result = build_related_context(data, root)
    assert _refs(result, "evidence-providers-file") == [
        ("scripts/run.py", 1, False),
        ("action.yml", 5, True),
    ]
    assert "  - `action.yml`:5 (changed file) as `EVIDENCE_PROVIDERS_FILE`" in render_related_context_markdown(result)


def test_changed_file_consumers_have_their_own_cap(tmp_path):
    files = {"src/a.py": "X = 1\n"}
    for index in range(4):
        files[f"src/changed_{index}.py"] = 'x = 1\nos.getenv("SHARED_SETTING")\n'
    root = make_repo(tmp_path, files)
    data = anchors(
        _key_file("src/a.py", [("SHARED_SETTING", "env", 1)], [[1, 1]]),
        *[_key_file(f"src/changed_{index}.py", [], [[1, 1]]) for index in range(4)],
    )
    result = build_related_context(data, root, max_changed_consumers_per_key=3)
    # The key's own file is searched too for non-entity keys; one hit per file.
    assert [ref[0] for ref in _refs(result, "SHARED_SETTING")] == [
        "src/changed_0.py", "src/changed_1.py", "src/changed_2.py",
    ]
    assert "consumer_cap" in result["truncation"]["reasons"]
    result = build_related_context(data, root, max_changed_consumers=1)
    assert len(_refs(result, "SHARED_SETTING")) == 1


def test_branch_keys_match_only_branch_sites(tmp_path):
    root = make_repo(tmp_path, {
        "pr_reviewer/platform.py": 'x = 1\nif platform == "tangled":\n    pass\n',
        "scripts/api.sh": (
            '_is_forgejo() {\n  [[ "$(platform_resolve)" == "forgejo" ]]\n}\n'
            'echo "PLATFORM is set"\n'
            'case "$PLATFORM" in\n'
        ),
        "scripts/other.py": (
            'platform = os.getenv("PLATFORM")\n'
            'if os.getenv("PLATFORM", "").lower() == "forgejo":\n'
            '    pass\n'
            'if sys.platform == "win32":\n'
            '    pass\n'
            'if mode == "x" and platform_ok:\n'
        ),
    })
    data = anchors(_key_file("pr_reviewer/platform.py", [("platform", "branch", 2)], [[2, 2]]))
    result = build_related_context(data, root, max_consumers_per_key=5)
    assert _refs(result, "platform") == [
        ("scripts/api.sh", 2, False),
        ("scripts/other.py", 2, False),
    ]
    assert related_context._branch_site('case "$PLATFORM" in', ["PLATFORM"])
    assert related_context._branch_site("  switch (platformName) {", ["platformName"])
    assert related_context._branch_site('[ "$_platform" = "forgejo" ]', ["_platform"])
    assert not related_context._branch_site('echo "PLATFORM is set"', ["PLATFORM"])
    assert not related_context._branch_site('platform = "github"', ["platform"])


def test_hostile_or_invalid_keys_are_ignored(tmp_path):
    root = make_repo(tmp_path, {"a.py": 'os.getenv("SAFE_SETTING")\n'})
    data = anchors(_key_file("cfg.yml", [
        ("SAFE_SETTING`\n## Forged", "env", 1),
        ("-e", "flag", 1),
        ("SAFE_SETTING", "shell", 1),
    ]))
    result = build_related_context(data, root)
    assert "consumers" not in result


def test_underscore_branch_names_are_searched(tmp_path):
    root = make_repo(tmp_path, {"a.sh": '[ "$_platform_name" = "forgejo" ]\n'})
    data = anchors(_key_file("b.sh", [("_platform_name", "branch", 1)]))
    assert _refs(build_related_context(data, root), "_platform_name") == [("a.sh", 1, False)]


_V2 = "def _build_pr_metadata(root):\n" + "".join(f"    step_{i}()\n" for i in range(25)) + "\n\ndef other():\n    pass\n"


def _counterpart(ref_path: str = "pr_reviewer/v2.py", ref_line: int = 1, ref_end: int = 26, **extra) -> dict:
    return {"name": "buildPrMetadata", "line": 3, "ref_path": ref_path, "ref_name": "_build_pr_metadata",
            "ref_line": ref_line, "ref_end": ref_end, **extra}


def test_counterparts_render_bounded_bodies(tmp_path):
    root = make_repo(tmp_path, {"pr_reviewer/v2.py": _V2, "src/v3.ts": "x\n"})
    data = anchors(_key_file("src/v3.ts", [], counterparts=[_counterpart(ref_changed=True)]))
    result = build_related_context(data, root)
    (item,) = result["counterparts"]
    assert item["ref_changed"] is True
    assert item["lines_truncated"] is True
    assert len(item["lines"]) == related_context.MAX_COUNTERPART_LINES
    assert item["lines"][0] == "def _build_pr_metadata(root):"
    markdown = render_related_context_markdown(result)
    assert "- `pr_reviewer/v2.py`:1 `_build_pr_metadata` for `buildPrMetadata` in `src/v3.ts`:3 (also changed in this PR):" in markdown
    assert markdown.index("## Referenced Counterparts") < markdown.index("## Changed Files")


def test_counterparts_must_be_tracked_current_and_capped(tmp_path):
    root = make_repo(tmp_path, {"pr_reviewer/v2.py": _V2, "src/v3.ts": "x\n"})
    (root / "untracked.py").write_text(_V2, encoding="utf-8")
    items = [
        _counterpart("untracked.py"),
        _counterpart(ref_line=2),
        _counterpart("src/v3.ts"),
        _counterpart("../outside.py"),
        _counterpart(),
        _counterpart(),
    ]
    data = anchors(_key_file("src/v3.ts", [], counterparts=items))
    result = build_related_context(data, root, max_counterparts=1)
    assert [(c["ref_path"], c["ref_line"]) for c in result["counterparts"]] == [("pr_reviewer/v2.py", 1)]
    assert "counterpart_cap" in result["truncation"]["reasons"]


def test_anchors_without_keys_or_counterparts_render_as_before(tmp_path):
    root = make_repo(tmp_path, {"src/app.py": "run_pipeline()\n", "src/other.py": "def run_pipeline():\n    pass\n"})
    legacy = anchors(source_file("src/other.py", "run_pipeline"))
    empty = anchors({**source_file("src/other.py", "run_pipeline"), "keys": [], "counterparts": []})
    result = build_related_context(legacy, root)
    assert list(result) == ["version", "files", "truncated", "errors", "truncation"]
    assert result == build_related_context(empty, root)
    markdown = render_related_context_markdown(result)
    assert markdown.startswith(
        "# Related Code (v1)\n\n_Deterministic bounded textual references, test candidates, and nearest "
        "manifests. References are textual matches, not proven runtime callers._\n\n## Changed Files\n"
    )
    assert "Consumers" not in markdown and "Counterparts" not in markdown


def test_consumer_and_counterpart_fences_resist_hostile_lines(tmp_path):
    root = make_repo(tmp_path, {
        "cfg.yml": "a: 1\n",
        "src/use.py": (
            "## Forged heading\n"
            'X = os.getenv("HOSTILE_SETTING")  # ```` ghp_0123456789abcdefghij0123456789abcd\n'
            "````\n"
        ),
        "pkg/v2.py": "def _build_thing(x):\n    return '````'  # ghp_0123456789abcdefghij0123456789abcd\n",
    })
    data = anchors(
        _key_file("cfg.yml", [("HOSTILE_SETTING", "env", 1)]),
        _key_file("src/v3.ts", [], counterparts=[{
            "name": "buildThing", "line": 1, "ref_path": "pkg/v2.py", "ref_name": "_build_thing",
            "ref_line": 1, "ref_end": 2,
        }]),
    )
    markdown = render_related_context_markdown(build_related_context(data, root))
    assert "ghp_0123456789abcdefghij0123456789abcd" not in markdown
    assert "\n## Forged" not in markdown
    lines = markdown.splitlines()
    for indent in ("    ", "  "):
        opens = [i for i, line in enumerate(lines) if line == indent + "`````"]
        assert opens, indent
    assert "````" in markdown


def _open_fence(text: str) -> str | None:
    fence = None
    for line in text.split("\n"):
        stripped = line.strip()
        if fence is None:
            if stripped.startswith(("```", "~~~")):
                fence = stripped[: len(stripped) - len(stripped.lstrip(stripped[0]))]
        elif stripped and stripped == fence[0] * len(stripped) and len(stripped) >= len(fence):
            fence = None
    return fence


def _fenced_result(tmp_path: Path) -> dict:
    root = make_repo(tmp_path, {
        "cfg.yml": "a: 1\n",
        "pr_reviewer/v2.py": _V2,
        "src/v3.ts": "x\n",
        **{f"src/use_{i}.py": f'import os\n\n\ndef read_{i}():\n    return os.getenv("SETTING_{i:02d}")  # ``` run\n' for i in range(6)},
    })
    return build_related_context(anchors(
        _key_file("cfg.yml", [(f"SETTING_{i:02d}", "env", 1) for i in range(6)]),
        _key_file("src/v3.ts", [], counterparts=[_counterpart()]),
    ), root)


def test_markdown_cap_never_splits_consumer_or_counterpart_blocks(tmp_path):
    result = _fenced_result(tmp_path)
    full = render_related_context_markdown(result, max_markdown_bytes=None)
    assert _open_fence(full) is None
    consumers = full.index("## Consumers")
    counterparts = full.index("## Referenced Counterparts")
    naive_open = 0
    for cap in range(consumers, len(full.encode("utf-8")), 11):
        rendered = render_related_context_markdown(result, max_markdown_bytes=cap)
        assert len(rendered.encode("utf-8")) <= cap
        assert _open_fence(rendered) is None, cap
        naive = full.encode("utf-8")[:cap].decode("utf-8", "ignore")
        naive_open += _open_fence(naive.rsplit("\n", 1)[0]) is not None
    assert naive_open > 0 and counterparts < len(full)


def test_clip_markdown_is_fence_safe_and_budget_honest(tmp_path):
    full = render_related_context_markdown(_fenced_result(tmp_path), max_markdown_bytes=None)
    size = len(full.encode("utf-8"))
    assert related_context.clip_markdown(full, size) == full
    for cap in range(40, size, 13):
        clipped = related_context.clip_markdown(full, cap)
        assert len(clipped.encode("utf-8")) <= cap
        assert clipped.endswith(related_context.CLIP_MARKER)
        assert full.startswith(clipped[: -len(related_context.CLIP_MARKER)])
        assert _open_fence(clipped) is None, cap


def test_fence_safe_length():
    fsl = related_context.fence_safe_length
    assert fsl(["a", "  ````", "  1: ``` x", "  ````", "b"]) == 5
    assert fsl(["a", "  ````", "  1: x", "  ```"]) == 1
    assert fsl(["a", "~~~", "x"]) == 1
    assert fsl([]) == 0


def test_clip_cli(tmp_path):
    source = tmp_path / "related-code.md"
    source.write_text("# Related Code (v1)\n\n- `K`:\n  ```\n  1: x\n  2: y\n  3: z\n  4: w\n  ```\n", encoding="utf-8")
    out = tmp_path / "related-code.truncated.md"
    rc = related_context.main(["--clip", str(source), "--clip-output", str(out), "--max-bytes", "62"])
    assert rc == 0
    assert out.read_text(encoding="utf-8") == "# Related Code (v1)\n\n- `K`:\n" + related_context.CLIP_MARKER
    assert related_context.main(["--clip", str(source), "--clip-output", str(out)]) == 2
