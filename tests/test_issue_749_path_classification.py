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
import tempfile
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
