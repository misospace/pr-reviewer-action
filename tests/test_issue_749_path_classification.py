"""#749 qualification regression: path-handling classification requires a
real untrusted-path surface.

Pins, against the production classification entry point, that the PR #748
false-positive class cannot return: trusted repository-root discovery in
test scaffolding must not produce ``path_handling_changes``, the risk flag,
or the traversal / edge-case-path ``must_check`` items, while genuine
attacker-controlled path behavior must still fire. Run by the #681
qualification's production dataflow checks (scripts/run_semantic_eval_ci.py).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT))

from pr_reviewer.classifier import classify_from_files  # noqa: E402

# The exact PR #748 scaffolding shape (scripts/fork_review_gate.py plus its
# test helper): ordinary trusted repository-root discovery.
_SCAFFOLDING_DIFF = """\
+from pathlib import Path
+
+_ROOT = Path(__file__).resolve().parent.parent
+REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
+sys.path.insert(0, str(_ROOT))
"""

_REAL_748_FILES = [
    {"filename": "scripts/fork_review_gate.py"},
    {"filename": "tests/test_fork_review_gate.py"},
    {"filename": "tests/test_fork_review_workflow.py"},
    {"filename": ".github/workflows/fork-ai-review.yaml"},
    {"filename": "docs/fork-review.md"},
]


def _classify(pr_files: list[dict], diff_text: str, tmp_path: Path) -> dict:
    pr_files_path = tmp_path / "pr-files.json"
    pr_files_path.write_text(json.dumps(pr_files), encoding="utf-8")
    diff_path = tmp_path / "pr.diff"
    diff_path.write_text(diff_text, encoding="utf-8")
    output_path = tmp_path / "classification.json"
    result = classify_from_files(
        pr_files_path=pr_files_path,
        diff_path=diff_path,
        output_path=output_path,
    )
    # The persisted artifact (what the corpus/role selector consume) must
    # carry the same verdict as the in-memory result.
    persisted = json.loads(output_path.read_text(encoding="utf-8"))
    assert persisted["pr_kind"] == result.pr_kind
    assert persisted["path_handling_provenance"] == result.path_handling_provenance
    return persisted


def test_scaffolding_does_not_classify_path_handling(tmp_path) -> None:
    result = _classify(_REAL_748_FILES, _SCAFFOLDING_DIFF, tmp_path)
    assert result["pr_kind"] != "path_handling_changes"
    assert "path_handling_changes" not in result["risk_flags"]
    assert not any("path traversal" in c for c in result["must_check"])
    assert not any("edge-case paths" in c for c in result["must_check"])
    assert result["path_handling_provenance"]["fired"] is False


def test_scaffolding_fires_nothing_even_with_test_traversal_literals(tmp_path) -> None:
    # The full PR #748 shape: the only traversal literals in the entire diff
    # are hostile-path FIXTURES inside tests/. With git diff headers the
    # classifier can attribute them to the test file and discount them.
    diff = (
        "diff --git a/scripts/fork_review_gate.py b/scripts/fork_review_gate.py\n"
        "+++ b/scripts/fork_review_gate.py\n"
        "+output_path = os.environ.get(\"GITHUB_OUTPUT\")\n"
        "+with open(output_path, \"a\", encoding=\"utf-8\") as handle:\n"
        "diff --git a/tests/test_fork_review_gate.py b/tests/test_fork_review_gate.py\n"
        "+++ b/tests/test_fork_review_gate.py\n"
        "+TRAVERSAL_40 = \"../\" * 13 + \"x\"\n"
        "+for hostile in (\"../../etc/passwd\",):\n"
    )
    result = _classify(_REAL_748_FILES, diff, tmp_path)
    assert result["pr_kind"] != "path_handling_changes"
    assert "path_handling_changes" not in result["risk_flags"]
    # ...but the discount is visible and explainable in the artifact.
    assert any(
        signal["signal"] == "traversal_literal"
        and signal["source"] == "diff_test_file"
        for signal in result["path_handling_provenance"]["discounted"]
    )


def test_untrusted_surface_still_classifies_path_handling(tmp_path) -> None:
    result = _classify(
        [{"filename": "src/upload.py"}],
        "+dest = os.path.join(UPLOAD_DIR, request.args['name'])\n",
        tmp_path,
    )
    assert result["pr_kind"] == "path_handling_changes"
    assert "path_handling_changes" in result["risk_flags"]
    assert any("path traversal" in c for c in result["must_check"])
    assert result["path_handling_provenance"]["fired"] is True
    assert any(
        signal["signal"] == "untrusted_source_join"
        for signal in result["path_handling_provenance"]["signals"]
    )


def test_containment_and_symlink_surfaces_still_fire(tmp_path) -> None:
    result = _classify(
        [{"filename": "src/serve.py"}],
        "+resolved = os.path.realpath(target)\n"
        "+if not resolved.startswith(BASE):\n"
        "+    abort(400)\n"
        "+os.symlink(target, link_path)\n",
        tmp_path,
    )
    assert result["pr_kind"] == "path_handling_changes"
    signals = {s["signal"] for s in result["path_handling_provenance"]["signals"]}
    assert "path_containment_or_sanitization" in signals
    assert "symlink_sensitive" in signals


def test_node_trusted_anchor_join_is_not_traversal(tmp_path) -> None:
    result = _classify(
        [{"filename": "src/app.ts"}],
        '+const templates = path.resolve(__dirname, "../templates");\n',
        tmp_path,
    )
    assert result["pr_kind"] != "path_handling_changes"
    assert "path_handling_changes" not in result["risk_flags"]


def test_anchor_join_with_static_arguments_is_not_path_handling(tmp_path) -> None:
    # Anchor + static string literals = trusted bookkeeping, even when a
    # directory name contains a word from the untrusted vocabulary.
    result = _classify(
        [{"filename": "src/app.ts"}],
        '+const uploadsDir = path.join(__dirname, "uploads");\n'
        '+const templates = path.resolve(__dirname, "../templates");\n',
        tmp_path,
    )
    assert result["pr_kind"] != "path_handling_changes"
    assert "path_handling_provenance" in result
    assert result["path_handling_provenance"]["fired"] is False


def test_anchor_join_with_untrusted_operand_fires(tmp_path) -> None:
    # The anchor refusal: `path.resolve(__dirname, request.args[...])` must
    # NOT be neutralized as trusted bookkeeping — it is a real surface.
    result = _classify(
        [{"filename": "src/app.ts"}],
        '+const p = path.resolve(__dirname, request.args["path"]);\n',
        tmp_path,
    )
    assert result["pr_kind"] == "path_handling_changes"
    assert any(
        signal["signal"] == "untrusted_source_join"
        for signal in result["path_handling_provenance"]["signals"]
    )


def test_anchor_call_with_adjacent_one_hop_variable_fires(tmp_path) -> None:
    # One-hop def/use into an anchor construction: the neutralization must be
    # refused when the operand is assigned by an adjacent untrusted line.
    result = _classify(
        [{"filename": "src/app.py"}],
        "+name = request.args['path']\n"
        "+target = os.path.join(os.path.dirname(__file__), name)\n",
        tmp_path,
    )
    assert result["pr_kind"] == "path_handling_changes"
    assert any(
        signal["signal"] == "untrusted_source_join"
        for signal in result["path_handling_provenance"]["signals"]
    )


def test_unrelated_adjacent_request_line_does_not_fire(tmp_path) -> None:
    # Adjacency is not flow: the constant join never uses `request_id`.
    result = _classify(
        [{"filename": "src/app.py"}],
        "+request_id = request.args['id']\n"
        "+target = os.path.join(base, 'static')\n",
        tmp_path,
    )
    assert result["pr_kind"] != "path_handling_changes"
    assert "path_handling_changes" not in result["risk_flags"]
    assert result["path_handling_provenance"]["fired"] is False


def test_assignment_lhs_vocabulary_is_not_an_operand(tmp_path) -> None:
    # Same-line detection reads the construction expression, not the LHS:
    # `request_cache_path` is the target being bound, not untrusted input.
    result = _classify(
        [{"filename": "src/app.py"}],
        '+request_cache_path = os.path.join(BASE, "static")\n',
        tmp_path,
    )
    assert result["pr_kind"] != "path_handling_changes"
    assert result["path_handling_provenance"]["fired"] is False


def test_quoted_adjacent_label_creates_no_flow(tmp_path) -> None:
    # `label = "request"` — the quote-stripped RHS has no untrusted token,
    # so the adjacent anchor call stays trusted bookkeeping.
    result = _classify(
        [{"filename": "src/app.py"}],
        '+label = "request"\n'
        "+target = path.resolve(__dirname, label)\n",
        tmp_path,
    )
    assert result["pr_kind"] != "path_handling_changes"
    assert result["path_handling_provenance"]["fired"] is False


def test_upload_filename_operand_fires(tmp_path) -> None:
    # `file.filename` is the reason this fires (the classic unsafe-upload
    # source), not upload vocabulary in the target or directory name.
    result = _classify(
        [{"filename": "src/app.py"}],
        "+dest = os.path.join(base, file.filename)\n",
        tmp_path,
    )
    assert result["pr_kind"] == "path_handling_changes"
    assert any(
        signal["signal"] == "untrusted_source_join"
        for signal in result["path_handling_provenance"]["signals"]
    )


def test_upload_vocabulary_without_operand_is_clean(tmp_path) -> None:
    result = _classify(
        [{"filename": "src/app.py"}],
        "+upload_path = os.path.join(UPLOAD_DIR, 'static')\n",
        tmp_path,
    )
    assert result["pr_kind"] != "path_handling_changes"
    assert result["path_handling_provenance"]["fired"] is False


def test_trailing_comment_and_sibling_statement_are_not_operands(tmp_path) -> None:
    # Operand isolation: prose and sibling expressions cannot donate tokens.
    result = _classify(
        [{"filename": "src/app.py"}, {"filename": "src/app.ts"}],
        '+target = os.path.join(BASE, "static")  # request cache path\n'
        '+const t = path.join(BASE, "static"); audit(request.id);\n',
        tmp_path,
    )
    assert result["pr_kind"] != "path_handling_changes"
    assert result["path_handling_provenance"]["fired"] is False


def test_bare_filename_identifier_is_not_a_source(tmp_path) -> None:
    result = _classify(
        [{"filename": "src/app.py"}],
        '+filename = "config.json"\n'
        "+dest = os.path.join(BASE, filename)\n",
        tmp_path,
    )
    assert result["pr_kind"] != "path_handling_changes"
    assert result["path_handling_provenance"]["fired"] is False


def test_multiline_join_direct_operand_fires(tmp_path) -> None:
    result = _classify(
        [{"filename": "src/app.py"}],
        "+target = os.path.join(\n"
        "+    BASE,\n"
        "+    request.args['p'],\n"
        "+)\n",
        tmp_path,
    )
    assert result["pr_kind"] == "path_handling_changes"
    assert any(
        signal["signal"] == "untrusted_source_join"
        for signal in result["path_handling_provenance"]["signals"]
    )


def test_multiline_closer_line_comment_is_clean(tmp_path) -> None:
    result = _classify(
        [{"filename": "src/app.py"}],
        "+target = os.path.join(\n"
        "+    BASE,\n"
        "+)  # request cache path\n",
        tmp_path,
    )
    assert result["pr_kind"] != "path_handling_changes"
    assert result["path_handling_provenance"]["fired"] is False


def test_multiline_sibling_statement_after_closer_is_clean(tmp_path) -> None:
    result = _classify(
        [{"filename": "src/app.ts"}],
        '+const target = path.join(\n'
        '+  BASE,\n'
        '+); audit(request.id);\n',
        tmp_path,
    )
    assert result["pr_kind"] != "path_handling_changes"
    assert result["path_handling_provenance"]["fired"] is False


def test_multiline_nested_construction_fires(tmp_path) -> None:
    # A nested call closing before a later untrusted operand must not end
    # the operand scan early.
    result = _classify(
        [{"filename": "src/app.py"}],
        "+target = os.path.join(\n"
        "+    os.path.dirname(__file__),\n"
        "+    request.args['name'],\n"
        "+)\n",
        tmp_path,
    )
    assert result["pr_kind"] == "path_handling_changes"
    assert any(
        signal["signal"] == "untrusted_source_join"
        for signal in result["path_handling_provenance"]["signals"]
    )
