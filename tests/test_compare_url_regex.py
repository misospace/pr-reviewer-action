import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Patterns extracted from scripts/sections/enrichment.sh
GITHUB_COMPARE_PATTERN = r"^https?://github\.com/([^/]+)/([^/]+)/compare/([^?#]+)"
FORGEJO_COMPARE_PATTERN = r"^https?://([^/]+)/([^/]+)/([^/]+)/compare/([^?#]+)"

URLS_WITH_QUERY = [
    "https://github.com/owner/repo/compare/v1...v2?expand=1",
]
URLS_WITH_FRAGMENT = [
    "https://github.com/owner/repo/compare/v1...v2#section",
]
URLS_WITH_BOTH = [
    "https://github.com/owner/repo/compare/v1...v2?expand=1#section",
]
URLS_PLAIN = [
    "https://github.com/owner/repo/compare/v1...v2",
]
ALL_GITHUB_URLS = URLS_WITH_QUERY + URLS_WITH_FRAGMENT + URLS_WITH_BOTH + URLS_PLAIN

FORGEJO_URLS_WITH_QUERY = [
    "https://git.example.com/owner/repo/compare/v1...v2?expand=1",
]
FORGEJO_URLS_PLAIN = [
    "https://forgejo.host/org/project/compare/feature...main",
]
ALL_FORGEJO_URLS = FORGEJO_URLS_WITH_QUERY + FORGEJO_URLS_PLAIN


# --- Python re tests (fast, verify capture group semantics) ---


def test_github_plain_url_matches_python():
    m = re.search(GITHUB_COMPARE_PATTERN, URLS_PLAIN[0])
    assert m is not None
    assert m.group(3) == "v1...v2"


def test_github_query_url_matches_python():
    m = re.search(GITHUB_COMPARE_PATTERN, URLS_WITH_QUERY[0])
    assert m is not None
    assert m.group(3) == "v1...v2"


def test_github_fragment_url_matches_python():
    m = re.search(GITHUB_COMPARE_PATTERN, URLS_WITH_FRAGMENT[0])
    assert m is not None
    assert m.group(3) == "v1...v2"


def test_github_both_url_matches_python():
    m = re.search(GITHUB_COMPARE_PATTERN, URLS_WITH_BOTH[0])
    assert m is not None
    assert m.group(3) == "v1...v2"


def test_forgejo_plain_url_matches_python():
    m = re.search(FORGEJO_COMPARE_PATTERN, FORGEJO_URLS_PLAIN[0])
    assert m is not None
    assert m.group(4) == "feature...main"


def test_forgejo_query_url_matches_python():
    m = re.search(FORGEJO_COMPARE_PATTERN, FORGEJO_URLS_WITH_QUERY[0])
    assert m is not None
    assert m.group(4) == "v1...v2"


# --- Bash ERE tests (production environment verification) ---


def _bash_match(pattern: str, url: str) -> tuple[bool, dict, str]:
    """Run bash [[ =~ ]] and return (matched, captures, stderr)."""
    script = f'''
if [[ "{url}" =~ {pattern} ]]; then
  echo "MATCH"
  echo "R0=${{BASH_REMATCH[0]}}"
  echo "R1=${{BASH_REMATCH[1]}}"
  echo "R2=${{BASH_REMATCH[2]}}"
  echo "R3=${{BASH_REMATCH[3]}}"
  echo "R4=${{BASH_REMATCH[4]}}"
else
  echo "NOMATCH"
fi
'''
    result = subprocess.run(["bash", "-c", script], capture_output=True, text=True)
    lines = result.stdout.strip().splitlines()
    matched = len(lines) > 0 and lines[0] == "MATCH"
    captures = {}
    if matched:
        for line in lines[1:]:
            if "=" in line:
                key, val = line.split("=", 1)
                captures[key] = val
    return matched, captures, result.stderr


def test_github_pattern_is_valid_bash_ere():
    """Regression guard: pattern must parse as valid bash ERE."""
    for url in ALL_GITHUB_URLS:
        matched, _, stderr = _bash_match(GITHUB_COMPARE_PATTERN, url)
        # A NOMATCH is fine; an invalid regex prints to stderr and may fail.
        assert "invalid regular expression" not in stderr.lower(), (
            f"GitHub compare pattern is not valid bash ERE: {stderr.strip()}"
        )


def test_forgejo_pattern_is_valid_bash_ere():
    """Regression guard: pattern must parse as valid bash ERE."""
    for url in ALL_FORGEJO_URLS:
        matched, _, stderr = _bash_match(FORGEJO_COMPARE_PATTERN, url)
        assert "invalid regular expression" not in stderr.lower(), (
            f"Forgejo compare pattern is not valid bash ERE: {stderr.strip()}"
        )


def test_github_plain_url_matches_bash():
    matched, captures, _ = _bash_match(GITHUB_COMPARE_PATTERN, URLS_PLAIN[0])
    assert matched, "plain GitHub compare URL must match in bash"
    assert captures.get("R3") == "v1...v2"


def test_github_query_url_matches_bash():
    matched, captures, _ = _bash_match(GITHUB_COMPARE_PATTERN, URLS_WITH_QUERY[0])
    assert matched, "GitHub compare URL with query string must match in bash"
    assert captures.get("R3") == "v1...v2", (
        f"spec capture should exclude query, got: {captures.get('R3')}"
    )


def test_github_fragment_url_matches_bash():
    matched, captures, _ = _bash_match(GITHUB_COMPARE_PATTERN, URLS_WITH_FRAGMENT[0])
    assert matched, "GitHub compare URL with fragment must match in bash"
    assert captures.get("R3") == "v1...v2"


def test_github_both_url_matches_bash():
    matched, captures, _ = _bash_match(GITHUB_COMPARE_PATTERN, URLS_WITH_BOTH[0])
    assert matched, "GitHub compare URL with query+fragment must match in bash"
    assert captures.get("R3") == "v1...v2"


def test_forgejo_plain_url_matches_bash():
    matched, captures, _ = _bash_match(FORGEJO_COMPARE_PATTERN, FORGEJO_URLS_PLAIN[0])
    assert matched, "plain Forgejo compare URL must match in bash"
    assert captures.get("R4") == "feature...main"


def test_forgejo_query_url_matches_bash():
    matched, captures, _ = _bash_match(FORGEJO_COMPARE_PATTERN, FORGEJO_URLS_WITH_QUERY[0])
    assert matched, "Forgejo compare URL with query string must match in bash"
    assert captures.get("R4") == "v1...v2"


# --- Source file presence checks (patterns now in Python) ---


def test_github_compare_pattern_in_python_source():
    content = (ROOT / "pr_reviewer/enrichment.py").read_text(encoding="utf-8")
    assert "github\\.com/([^/]+)/([^/]+)/compare/([^?#]+)" in content, (
        "GitHub compare regex must be present in pr_reviewer/enrichment.py"
    )


def test_forgejo_compare_pattern_in_python_source():
    content = (ROOT / "pr_reviewer/enrichment.py").read_text(encoding="utf-8")
    assert "([^/]+)/([^/]+)/([^/]+)/compare/([^?#]+)" in content, (
        "Forgejo compare regex must be present in pr_reviewer/enrichment.py"
    )


def test_patterns_not_anchored_to_end():
    """Ensure the compare regexes do not end with $ (which would reject query/fragment)."""
    content = (ROOT / "pr_reviewer/enrichment.py").read_text(encoding="utf-8")
    # The old broken pattern had ([^?#]+)$ which rejects query strings.
    assert "compare/([^?#]+)$" not in content, (
        "Compare regexes must not be anchored with $ at the end; "
        "this prevents matching URLs with query strings or fragments"
    )


def test_enrichment_sh_no_longer_has_brittle_grep_pipelines():
    """Verify enrichment.sh is now a thin wrapper, not grep pipelines."""
    content = (ROOT / "scripts/sections/enrichment.sh").read_text(encoding="utf-8")
    assert "run_enrichment.py" in content, (
        "enrichment.sh should delegate to run_enrichment.py"
    )
    # Should not contain the old brittle TARGET_VERSION grep pipeline
    assert 'TARGET_VERSION="$(jq -r' not in content, (
        "enrichment.sh should not contain TARGET_VERSION grep pipeline"
    )


def test_context_sh_no_longer_has_brittle_compare_sha_grep():
    """Verify context.sh no longer has the brittle compare-sha grep pipelines."""
    content = (ROOT / "scripts/sections/context.sh").read_text(encoding="utf-8")
    assert "_old_sha=$(grep" not in content, (
        "context.sh should not contain brittle _old_sha grep pipeline"
    )
    assert "_new_sha=$(grep" not in content, (
        "context.sh should not contain brittle _new_sha grep pipeline"
    )
