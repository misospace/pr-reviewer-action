"""Production corpus builder and request-shape regressions for tier routing."""

import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(not shutil.which("jq"), reason="jq required")
def test_smart_rebuild_reads_raw_artifacts(tmp_path):
    # Source the production assembly function without executing the pipeline.
    corpus_script = (ROOT / "scripts/sections/corpus.sh").read_text()
    assembly = corpus_script[corpus_script.index("build_bounded_repo_map() {"):corpus_script.index('\nsection_timer_start "corpus-building"')]
    (tmp_path / "assembly.sh").write_text(assembly)
    (tmp_path / "pr.json").write_text('{"number":1,"title":"test"}')
    (tmp_path / "classification.json").write_text('{"pr_kind":"app_code"}')
    (tmp_path / "pr-files.json").write_text('[]')
    (tmp_path / "pr-files.truncated.json").write_text('[]')
    raw_diff = "first\n" + "filler\n" * 3000 + "SMART_SENTINEL_658\n"
    (tmp_path / "pr.diff").write_text(raw_diff)
    for name, content in {
        "standards-context.md": "STANDARDS_658\n",
        "requirement-ledger.md": "LEDGER_658\n",
        "specialists.md": "# Specialist Review Leads\nSPECIALISTS_658\n",
        "evidence-providers.md": "EVIDENCE_658\n",
        "tool-harness.md": "PRIMARY_SECRET_658\n",
        "requirement-ledger-present.txt": "1\n",
        "specialist-leads-present.txt": "1\n",
    }.items():
        (tmp_path / name).write_text(content)
    script = """
log() { :; }
error() { :; }
source "$SCRIPT_DIR/sections/config.sh"
source ./assembly.sh
truncate_clean pr.diff pr.diff.truncated "$PRIMARY_MAX_DIFF" '…[diff truncated to fit context budget]'
build_review_corpus
cp review-corpus.md review-corpus.truncated.md
build_review_corpus smart
"""
    env = dict(os.environ, SCRIPT_DIR=str(ROOT / "scripts"), REPO="x/y", PR_NUMBER="1",
               AI_BASE_URL="http://example.invalid", AI_MODEL="p", GH_TOKEN="test",
               PRIMARY_MODEL_CONTEXT_TOKENS="11000", SMART_MODEL_CONTEXT_TOKENS="40000",
               AI_MAX_TOKENS="1000", STANDARDS_FILE="AGENTS.md", CI_CHECKS_FILE="",
               REPO_MAP_MAX_BYTES="12000")
    result = subprocess.run(["bash", "-c", script], cwd=tmp_path, env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    primary = (tmp_path / "review-corpus.truncated.md").read_text()
    smart = (tmp_path / "review-corpus.smart.truncated.md").read_text()
    assert "SMART_SENTINEL_658" not in primary
    assert "SMART_SENTINEL_658" in smart
    assert "PRIMARY_SECRET_658" not in smart
    for marker in ("STANDARDS_658", "LEDGER_658", "SPECIALISTS_658", "EVIDENCE_658"):
        assert smart.count(marker) == 1
    assert len(smart.encode()) > len(primary.encode())
    assert len(smart.encode()) <= 87000  # (40000 - 1000 - 2000) * 3


@pytest.mark.skipif(not shutil.which("jq"), reason="jq required")
@pytest.mark.parametrize("transport", ["openai", "anthropic"])
def test_trailing_task_preserves_request_contract(tmp_path, transport):
    (tmp_path / "corpus.md").write_text("CORPUS_SENTINEL\n")
    script = f'''source "{ROOT}/scripts/model_call.sh"
AI_RESPONSE_FORMAT=json_schema
AI_MAX_TOKENS=1000
build_model_request {transport} model SYSTEM_SENTINEL 'Return STRICT JSON verdict' corpus.md default.json false
build_model_request {transport} model SYSTEM_SENTINEL 'Return STRICT JSON verdict' corpus.md trailing.json false trailing_task'''
    result = subprocess.run(["bash", "-c", script], cwd=tmp_path, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    default = json.loads((tmp_path / "default.json").read_text())
    trailing = json.loads((tmp_path / "trailing.json").read_text())
    assert default.keys() == trailing.keys()
    assert default.get("response_format") == trailing.get("response_format")
    assert default["max_tokens"] == trailing["max_tokens"]
    assert trailing.get("system", trailing["messages"][0].get("content")) == "SYSTEM_SENTINEL"
    user = trailing["messages"][-1]["content"]
    assert user.index("CORPUS_SENTINEL") < user.index("Return STRICT JSON verdict")
    assert user.count("CORPUS_SENTINEL") == user.count("Return STRICT JSON verdict") == 1


def test_context_limits_default_and_headroom(tmp_path):
    config = (ROOT / "scripts/sections/config.sh").read_text()
    func = config[config.index("apply_context_limits() {"):config.index("# Truncate SRC")]
    (tmp_path / "limits.sh").write_text(func)
    script = '''error() { :; }; log() { :; }
AI_MAX_TOKENS=8192; CONTEXT_LIMIT_MODE=normal
source ./limits.sh
[[ "$PRIMARY_MAX_CORPUS:$SMART_MAX_CORPUS:$MAX_DIFF:$MAX_FILES" == "220000:220000:140000:70000" ]] || exit 1
MODEL_CONTEXT_TOKENS=32768; source ./limits.sh
[[ "$PRIMARY_MAX_CORPUS" == 67728 && "$SMART_MAX_CORPUS" == 67728 ]] || exit 2
SMART_MODEL_CONTEXT_TOKENS=1000000; source ./limits.sh
[[ "$SMART_MAX_CORPUS" -le 500000 ]] || exit 3
[[ $(( SMART_MAX_CORPUS / 3 + AI_MAX_TOKENS + 2000 )) -le "$SMART_MODEL_CONTEXT_TOKENS" ]] || exit 4
SMART_MODEL_CONTEXT_TOKENS=10000; source ./limits.sh
exit 5'''
    result = subprocess.run(["bash", "-c", script], cwd=tmp_path, capture_output=True, text=True)
    # A context smaller than completion + headroom + minimum input must fail.
    assert result.returncode == 1, result.stderr
