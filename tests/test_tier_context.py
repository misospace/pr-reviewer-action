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
build_review_corpus primary
cp review-corpus.md review-corpus.truncated.md
# If the smart builder ever uses the primary corpus, it would consume this
# marker instead of the original deterministic inputs.
printf '\nPOISONED_PRIMARY_CORPUS_658\n' >> review-corpus.truncated.md
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
    assert "POISONED_PRIMARY_CORPUS_658" not in smart
    assert "PRIMARY_SECRET_658" not in smart
    for marker in ("STANDARDS_658", "LEDGER_658", "SPECIALISTS_658", "EVIDENCE_658"):
        assert smart.count(marker) == 1
    assert len(smart.encode()) > len(primary.encode())
    assert len(smart.encode()) <= 87000  # (40000 - 1000 - 2000) * 3


def test_only_smart_override_keeps_primary_legacy_budget(tmp_path):
    config = (ROOT / "scripts/sections/config.sh").read_text()
    func = config[config.index("apply_context_limits() {"):config.index("# Truncate SRC")]
    (tmp_path / "limits.sh").write_text(func)
    script = '''error() { :; }; log() { :; }
AI_MAX_TOKENS=8192; CONTEXT_LIMIT_MODE=normal
PRIMARY_MODEL_CONTEXT_TOKENS=""; PRIMARY_REQUEST_SHAPE=default; SMART_REQUEST_SHAPE=default
SMART_MODEL_CONTEXT_TOKENS=100000
source ./limits.sh
[[ "$PRIMARY_MAX_CORPUS:$PRIMARY_MAX_DIFF:$PRIMARY_MAX_FILES" == "220000:140000:70000" ]] || exit 1
[[ "$SMART_MAX_CORPUS:$SMART_MAX_DIFF:$SMART_MAX_FILES" == "269424:161654:40413" ]] || exit 2
[[ "$MAX_CORPUS:$MAX_DIFF:$MAX_FILES" == "220000:140000:70000" ]] || exit 3'''
    result = subprocess.run(["bash", "-c", script], cwd=tmp_path, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_primary_override_does_not_change_inherited_smart_budget(tmp_path):
    config = (ROOT / "scripts/sections/config.sh").read_text()
    func = config[config.index("apply_context_limits() {"):config.index("# Truncate SRC")]
    (tmp_path / "limits.sh").write_text(func)
    script = '''error() { :; }; log() { :; }
AI_MAX_TOKENS=8192; CONTEXT_LIMIT_MODE=normal; MODEL_CONTEXT_TOKENS=""
PRIMARY_MODEL_CONTEXT_TOKENS=20000; SMART_MODEL_CONTEXT_TOKENS=""
PRIMARY_REQUEST_SHAPE=default; SMART_REQUEST_SHAPE=default
source ./limits.sh
[[ "$PRIMARY_MAX_CORPUS:$PRIMARY_MAX_DIFF:$PRIMARY_MAX_FILES" == "29424:17654:4413" ]] || exit 1
[[ "$SMART_MAX_CORPUS:$SMART_MAX_DIFF:$SMART_MAX_FILES" == "220000:140000:70000" ]] || exit 2'''
    result = subprocess.run(["bash", "-c", script], cwd=tmp_path, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_legacy_small_context_floor_and_explicit_override_failure(tmp_path):
    config = (ROOT / "scripts/sections/config.sh").read_text()
    func = config[config.index("apply_context_limits() {"):config.index("# Truncate SRC")]
    (tmp_path / "limits.sh").write_text(func)
    script = '''error() { :; }; log() { :; }
AI_MAX_TOKENS=8192; CONTEXT_LIMIT_MODE=normal; MODEL_CONTEXT_TOKENS=8192
PRIMARY_MODEL_CONTEXT_TOKENS=""; SMART_MODEL_CONTEXT_TOKENS=""
PRIMARY_REQUEST_SHAPE=default; SMART_REQUEST_SHAPE=default
source ./limits.sh
[[ "$MAX_CORPUS:$MAX_DIFF:$MAX_FILES" == "6000:3600:1000" ]] || exit 1
[[ "$PRIMARY_MAX_CORPUS:$SMART_MAX_CORPUS" == "6000:6000" ]] || exit 2
apply_context_limits 8192 tier && exit 3
apply_context_limits 8192 || exit 4
[[ "$MAX_CORPUS:$MAX_DIFF:$MAX_FILES" == "6000:3600:1000" ]] || exit 5'''
    result = subprocess.run(["bash", "-c", script], cwd=tmp_path, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


@pytest.mark.skipif(not shutil.which("jq"), reason="jq required")
@pytest.mark.parametrize("route,profile,expected_shape,expected_sentinel", [
    ("smart", "smart", "trailing_task", True),
    ("primary", "primary", "default", False),
])
def test_initial_route_corpus_and_request_use_effective_profile(
    tmp_path, route, profile, expected_shape, expected_sentinel
):
    corpus_script = (ROOT / "scripts/sections/corpus.sh").read_text()
    assembly = corpus_script[corpus_script.index("build_bounded_repo_map() {"):corpus_script.index('\nsection_timer_start "corpus-building"')]
    (tmp_path / "assembly.sh").write_text(assembly)
    routing_script = (ROOT / "scripts/sections/classification.sh").read_text()
    routing = routing_script[routing_script.index("resolve_review_route() {"):routing_script.index("# Tailor the default system prompt")]
    (tmp_path / "routing.sh").write_text(routing)
    for name, content in {
        "pr.json": '{"number":1,"title":"test"}',
        "classification.json": json.dumps({"pr_kind": "app_code", "route_signals": ["security"] if route == "smart" else []}),
        "pr-files.json": "[]", "pr-files.truncated.json": "[]", "corpus.md": "",
    }.items():
        (tmp_path / name).write_text(content)
    (tmp_path / "pr.diff").write_text("filler\n" * 3000 + "DIRECT_SMART_SENTINEL_658\n")
    script = '''log() { :; }; error() { :; }
source "$SCRIPT_DIR/sections/config.sh"
source ./assembly.sh
source ./routing.sh
truncate_clean pr.diff pr.diff.truncated "$PRIMARY_MAX_DIFF"
build_review_corpus "$REVIEW_CONTEXT_PROFILE" primary
cp review-corpus.md review-corpus.truncated.md
SYSTEM_PROMPT=sys; STREAM_BOOL=false
AI_REQUEST_TIMEOUT_SEC=1; AI_CONNECT_TIMEOUT_SEC=1
AI_PRIMARY_RETRIES=1; AI_PRIMARY_RETRY_DELAY_SEC=1
curl_model() { printf '{"choices":[{"message":{"content":"ok"}}]}' > "$5"; }
parse_and_validate() { return 0; }
call_model_tier primary task review-corpus.truncated.md ai-request.primary.json ai-response.primary.json
[[ "$REVIEW_ROUTE" == "$EXPECTED_ROUTE" && "$REVIEW_CONTEXT_PROFILE" == "$EXPECTED_PROFILE" ]]'''
    env = dict(os.environ, SCRIPT_DIR=str(ROOT / "scripts"), REPO="x/y", PR_NUMBER="1",
               AI_BASE_URL="http://example.invalid", AI_MODEL="p", GH_TOKEN="test",
               AI_API_FORMAT="openai", AI_API_KEY="", AI_PRIMARY_MODEL="p", AI_SMART_MODEL="s",
               REVIEW_ROUTING_MODE="auto", ESCALATE_ON_RISK_FLAGS="security",
               EXPECTED_ROUTE=route, EXPECTED_PROFILE=profile,
               PRIMARY_MODEL_CONTEXT_TOKENS="11000", SMART_MODEL_CONTEXT_TOKENS="40000",
               PRIMARY_REQUEST_SHAPE="default", SMART_REQUEST_SHAPE="trailing_task",
               AI_MAX_TOKENS="1000", STANDARDS_FILE="AGENTS.md", CI_CHECKS_FILE="")
    # The call site keeps the initial-review artifact slot, even for smart routing.
    script = f'source "{ROOT}/scripts/model_call.sh"\n' + script
    result = subprocess.run(["bash", "-c", script], cwd=tmp_path, env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    corpus = (tmp_path / "review-corpus.truncated.md").read_text()
    assert ("DIRECT_SMART_SENTINEL_658" in corpus) is expected_sentinel
    assert (tmp_path / "review-corpus.smart.truncated.md").exists() is False
    payload = json.loads((tmp_path / "ai-request.primary.json").read_text())
    assert payload["model"] == ("s" if route == "smart" else "p")
    user = payload["messages"][-1]["content"]
    assert (user.index("task") > user.index("# PR Diff")) is (expected_shape == "trailing_task")


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


@pytest.mark.skipif(not shutil.which("jq"), reason="jq required")
def test_trailing_task_has_identical_user_content_across_transports(tmp_path):
    (tmp_path / "corpus.md").write_text("CONTEXT\nwith unicode: caf\u00e9\n")
    script = f'''source "{ROOT}/scripts/model_call.sh"
build_model_request openai model system 'STRICT JSON' corpus.md openai.json false trailing_task
build_model_request anthropic model system 'STRICT JSON' corpus.md anthropic.json false trailing_task'''
    result = subprocess.run(["bash", "-c", script], cwd=tmp_path, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    openai = json.loads((tmp_path / "openai.json").read_text())
    anthropic = json.loads((tmp_path / "anthropic.json").read_text())
    assert openai["messages"][-1]["content"].encode() == anthropic["messages"][-1]["content"].encode()


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
