"""Deterministic PR classification and risk-flag detection.

Analyzes a PR's file changes, diff content, linked issues, and metadata to
produce structured classification output that is injected into the review
corpus before model invocation.

All logic is rule-based (no model calls). The output is a JSON object with:
  - pr_kind        : one of the enumerated kinds
  - risk_flags     : list of detected risk indicators
  - changed_files_summary : list of changed file paths (truncated)
  - linked_issue_labels : labels from linked issues when available
  - must_check     : explicit checklist items derived from classification

Usage from run_review.sh::
    python3 scripts/classify_pr.py \
        --pr-files pr-files.json \
        --diff pr.diff.truncated \
        --linked-issues linked-issues.json \
        --output classification.json
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Callable


# ---------------------------------------------------------------------------
# Kinds and flags (authoritative enums)
# ---------------------------------------------------------------------------

PR_KINDS = [
    "renovate_digest_only",
    "dependency_upgrade",
    "app_code",
    "k8s_manifest",
    "auth_changes",
    "public_route_changes",
    "file_serving_changes",
    "path_handling_changes",
    "secret_handling_changes",
    "db_or_migration_changes",
]

RISK_FLAGS = [
    "linked_security_issue",
    "linked_audit_issue",
    "linked_priority_p0",
    "linked_priority_p1",
    "file_serving_changes",
    "path_handling_changes",
    "auth_changes",
    "secret_handling_changes",
]


# ---------------------------------------------------------------------------
# Pattern sets
# ---------------------------------------------------------------------------

# Renovate digest-only: lockfile files that contain only hash/digest changes
# (no version bumps). We detect this by looking for 64-char hex digests in
# the diff when the changed file is a known lockfile.
RENOVATE_DIGEST_FILE_PATTERNS = [
    re.compile(r"package-lock\.json"),
    re.compile(r"npm-shrinkwrap\.json"),
    re.compile(r"yarn\.lock"),
    re.compile(r"pnpm-lock\.yaml"),
]

# 64-character hex digest (SHA-256 style) — common in Renovate digest updates

# Dependency-related files (lockfiles, manifests)
DEPENDENCY_PATTERNS = [
    re.compile(r"(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|"
               r"Pipfile\.lock|requirements\.txt|Gemfile\.lock|Cargo\.lock|"
               r"go\.mod|go\.sum|composer\.lock|mix\.lock|build\.gradle|"
               r"pom\.xml|setup\.py|setup\.cfg|pyproject\.toml|pubspec\.yaml|"
               r"\.npmrc|\.yarnrc)"),
]

# Kubernetes manifest patterns
K8S_PATTERNS = [
    re.compile(r"(helmrelease|deployment|statefulset|daemonset|kustomization)"
               r"\.ya?ml$", re.IGNORECASE),
    re.compile(r"configmap\.ya?ml$"),
    re.compile(r"secret\.ya?ml$"),
    re.compile(r"service\.ya?ml$"),
    re.compile(r"ingress\.ya?ml$"),
    re.compile(r"\.k8s\.ya?ml$"),
    re.compile(r"k8s/"),
    re.compile(r"helm/"),
]

# Common source-file extensions across ecosystems (not just Python), so auth /
# route / DB filename heuristics fire for JS/TS/Go/Java/etc. repos too.
_SRC_EXT = r"(py|js|jsx|ts|tsx|go|rb|java|kt|cs|php|rs|scala|swift)"

# Auth-related changes
AUTH_PATTERNS = [
    re.compile(r"(auth|login|oauth|oidc|saml|jwt|token|mfa|2fa|session)"
               r"[_.-]?\w*\." + _SRC_EXT + r"$", re.IGNORECASE),
    re.compile(r"middleware[_.-]?auth", re.IGNORECASE),
    re.compile(r"permissions?\.ya?ml$"),
    re.compile(r"rbac\.ya?ml$"),
    re.compile(r"role[-_].*binding", re.IGNORECASE),
    re.compile(r"\.env(\.example)?$", re.IGNORECASE),
    re.compile(r"(auth|authn|authz)[-_]?(controller|service|guard|middleware|handler)",
               re.IGNORECASE),
]

# Public route changes
PUBLIC_ROUTE_PATTERNS = [
    # NB: `routes` (plural) only — a bare `route.<ext>` is the mandated name of
    # every Next.js App Router API handler (src/app/api/**/route.ts), so it
    # carries no routing-layer signal and must not match. See #531.
    re.compile(r"(routes|urls?|api|endpoints?|controller)\." + _SRC_EXT + r"$",
               re.IGNORECASE),
    re.compile(r"router[_.-]?py$"),
    re.compile(r"urlpatterns"),
    re.compile(r"app\.route\("),
    re.compile(r"@\w+\.route\("),
    re.compile(r"(registerEndpoint|@(Get|Post|Put|Delete|Patch|RequestMapping))",
               re.IGNORECASE),
]

# File serving changes — match directory names or file patterns
FILE_SERVING_PATTERNS = [
    re.compile(r"^(static|public|assets|uploads|media|files)[/_.-]", re.IGNORECASE),
    re.compile(r"(static|public|assets|uploads|media|files)/", re.IGNORECASE),
    re.compile(r"send_file"),
    re.compile(r"send_from_directory"),
    re.compile(r"FileServer"),
    re.compile(r"serveStatic"),
    re.compile(r"staticfiles?/"),
]

# Path handling changes (#749 signal model) — classification requires a real
# untrusted-path surface. The former model scanned raw diff content for broad
# path-API mentions (`pathlib`, `os.path`, ...), so ordinary trusted path
# scaffolding classified as path_handling_changes and injected traversal /
# edge-case-path must_check items into benign PRs (the PR #748 false
# positive: `ROOT = Path(__file__).resolve().parent.parent` in a test
# helper). The model below distinguishes:
#
#   trusted path bookkeeping (never fires alone)
#     - repository-root discovery: `Path(__file__).resolve().parent...`,
#       `os.path.dirname(os.path.abspath(__file__))`, `__dirname` joins;
#     - module resolution specifiers (`from "../x.js"` — kept from #720);
#     - path-library usage with no untrusted input flow
#       (`Path("/etc/myapp/config.yaml")`, `path_join(base, "static")`);
#     - signals found only in test/fixture files (static fixture paths).
#
#   material path-handling changes (fire the kind, flag, and must_check)
#     - traversal literals outside specifiers and trusted-anchor calls;
#     - path normalization/sanitization/containment logic;
#     - untrusted (request/user/...) values reaching path construction;
#     - archive extraction and symlink-sensitive operations;
#     - identifier-shaped path vocabulary in changed filenames.
#
# Every signal is recorded in the `path_handling_provenance` artifact field
# (bounded, class-categorized — never raw unbounded PR text) so a future
# false positive is debuggable without reading classifier internals.

# Filename-backed signal vocabulary: identifier-shaped path terms in changed
# FILENAMES (e.g. `filepath.ts`, `path_join.py`, `sanitize_path.go`). A
# filename hit means the PR modifies dedicated path-handling code.
PATH_HANDLING_FILENAME_PATTERNS = [
    re.compile(r"filepath|pathname", re.IGNORECASE),
    # Identifier-shaped joins only (sanitize_path, cleanPath, resolvePath):
    # a prose line like "sanitizes ... paths" in documentation must not read
    # as a code signal.
    re.compile(r"sanitize[\w]*path|path[\w]*sanitize|clean[\w]*path", re.IGNORECASE),
    re.compile(r"path_join|joinpath|resolve[\w]*path|path[\w]*resolve", re.IGNORECASE),
]

# Path traversal literals: "../" or "..\". Scanned ONLY over neutralized diff
# text (see _neutralize_path_false_positives): module specifiers and
# trusted-anchor calls are removed first, so neither an ESM import like
# `from "../runtime/subprocess.js"` (#679 false positive) nor trusted
# repository-root joins like `path.resolve(__dirname, "../templates")`
# count as traversal.
PATH_TRAVERSAL_PATTERN = re.compile(r"\.\./|\.\.\\", re.IGNORECASE)

# A module specifier is the quoted path inside an ESM/CJS import construct —
# `from "../x.js"`, `require("../x")`, `import("../x")`, a side-effect
# `import "../x.css"`. Specifier literals are module resolution, not
# filesystem path handling. Only the quoted literal is neutralized: other
# content on the same source line (a real `../` traversal next to a require
# call) must still count as traversal.
_SPECIFIER_QUOTED = re.compile(
    r"""\bfrom\s*(['"])[^'"]*\1"""
    r"""|\brequire\s*\(\s*(['"])[^'"]*\2"""
    r"""|\bimport\s*\(\s*(['"])[^'"]*\3"""
    r"""|\bimport\s+(['"])[^'"]*\4""",
    re.IGNORECASE,
)

# Trusted path anchors: tokens whose value is the location of the source
# file itself. Expressions built from them are repository-root discovery,
# never attacker-controlled path surfaces.
_TRUSTED_ANCHOR_TOKEN = re.compile(
    r"""\b(?:__file__|__dirname|__filename)\b"""
    r"""|\bimport\.meta\.(?:url|dirname|filename)\b""",
)

# A `Path(__file__)...` chain: the anchor plus bounded pure-chaining calls
# (.resolve(), .parent, .parents[N], .joinpath("..."), ...). One level of
# call arguments is consumed; deeper nesting fails to match and stays in the
# scanned text (conservative). joinpath arguments go through the same
# untrusted-refusal check as anchor calls (see
# _refuse_untrusted_anchor_neutralization).
_PATHLIB_ANCHOR_CHAIN = re.compile(
    r"""\bPath\s*\(\s*(?:__file__|__filename)\s*\)"""
    r"""(?:\s*\.\s*(?:resolve|absolute|parent|parents\[\d+\]|joinpath|name|stem|as_posix|as_uri|is_dir|is_file|exists|stat)\b\s*(?:\(\s*[^()]*\))?)*"""
)

# Anchor-anchored path calls: a path construction/resolution call whose FIRST
# argument is a trusted anchor — `path.resolve(__dirname, "../templates")`,
# `os.path.join(os.path.dirname(__file__), "data.json")`, `resolve(__file__)`.
# The whole call is trusted bookkeeping ONLY when the remaining arguments are
# demonstrably static (string literals or plain identifiers from the bounded
# trusted vocabulary): an untrusted operand anywhere in the call REFUSES
# neutralization so the untrusted-join signal can fire on it
# (`path.resolve(__dirname, request.args["path"])` is a real surface).
# Only one argument level is consumed (no nested parens in the tail);
# unmatched forms stay in the scanned text (conservative).
_ANCHOR_PATH_CALL = re.compile(
    r"""(?:[.]|\b)(?:join|resolve|normalize|realpath|abspath|normpath|dirname|basename|joinpath)\s*\(\s*"""
    r"""(?:__file__|__dirname|__filename|import\.meta\.(?:url|dirname|filename)"""
    r"""|(?:os\.path\.)?(?:dirname|basename|abspath|realpath)\s*\(\s*(?:__file__|__dirname|__filename)\s*\)"""
    r"""|Path\s*\(\s*(?:__file__|__filename)\s*\)(?:\.(?:resolve|parent|parents\[\d+\]|absolute)\b)*)"""
    r"""\s*(?:,\s*[^()]*)?\)"""
)

# A quoted string literal with NO interpolation marker (`{`, `$`, `%`): its
# content is static data. Interpolation-shaped literals are deliberately NOT
# stripped, so `f"{user}"` / `` `${x}` `` keep their inner text visible to the
# untrusted-token check (fail toward detection).
_QUOTED_STATIC_LITERAL = re.compile(
    r'"[^"$%{}]*"'
    r"|'[^'$%{}]*'"
    r"|`[^`$%{}]*`"
)

# Simple assignment target: a leading identifier bound with `=` or `:=`
# (const/let/var-style prefixes tolerated; the unified-diff `+`/`-`/space
# marker is skipped). Deliberately NOT a general lvalue grammar — tuples,
# subscripts, and attribute targets yield no one-hop edge.
_UNTRUSTED_ASSIGNMENT = re.compile(
    r"^[+\-]?\s*(?:const|let|var|final|val|my|our|local)?\s*([A-Za-z_]\w*)\s*:?="
)


def _untrusted_assignment_target(line: str) -> str | None:
    """Assignment-target identifier of a line whose QUOTE-STRIPPED RHS
    reaches an untrusted source (a one-hop def/use candidate). None when the
    line is not a simple assignment or its RHS carries no untrusted token —
    static quoted words like ``label = "request"`` are data, not flow, and
    never create an edge."""
    m = _UNTRUSTED_ASSIGNMENT.match(line)
    if not m:
        return None
    rhs = _QUOTED_STATIC_LITERAL.sub('""', line[m.end():])
    if any(pat.search(rhs) for pat in UNTRUSTED_SOURCE_PATTERNS):
        return m.group(1)
    return None


def _one_hop_untrusted_targets(prev_line: str, next_line: str) -> list[str]:
    """Assignment-target identifiers carried by adjacent untrusted-source
    lines: the one-hop def/use candidates for the line being neutralized or
    scanned. Bounded by construction (at most two neighbors)."""
    targets: list[str] = []
    for line in (prev_line, next_line):
        ident = _untrusted_assignment_target(line)
        if ident and ident not in targets:
            targets.append(ident)
    return targets


def _neutralize_path_false_positives(
    line: str,
    prev_line: str = "",
    next_line: str = "",
) -> str:
    """One diff line with trusted path scaffolding neutralized (replaced by
    an empty literal). Line structure is preserved: neutralization is
    literal-scoped, so material signals elsewhere on the same line still
    match. The adjacent RAW lines feed the one-hop def/use check: an anchor
    call is NOT neutralized when one of its operands is a variable that an
    adjacent untrusted-source line assigns — otherwise
    `name = request.args["path"]` / `path.resolve(__dirname, name)` would
    lose its construction call before the untrusted-join scan sees it."""
    one_hop = _one_hop_untrusted_targets(prev_line, next_line)

    def _refuse(match: re.Match) -> str:
        text = match.group(0)
        static_text = _QUOTED_STATIC_LITERAL.sub('""', text)
        if any(pat.search(static_text) for pat in UNTRUSTED_SOURCE_PATTERNS):
            return text
        if any(re.search(rf"\b{re.escape(ident)}\b", static_text) for ident in one_hop):
            return text
        return '""'

    line = _SPECIFIER_QUOTED.sub('""', line)
    line = _ANCHOR_PATH_CALL.sub(_refuse, line)
    line = _PATHLIB_ANCHOR_CHAIN.sub(_refuse, line)
    line = _TRUSTED_ANCHOR_TOKEN.sub('""', line)
    return line


def _neutralize_chunk_lines(lines: list[str]) -> list[str]:
    """Neutralize a diff chunk line by line, feeding each line its adjacent
    RAW neighbors for the one-hop untrusted-flow refusal."""
    return [
        _neutralize_path_false_positives(
            line,
            lines[index - 1] if index > 0 else "",
            lines[index + 1] if index + 1 < len(lines) else "",
        )
        for index, line in enumerate(lines)
    ]


# Material content signal classes: each entry is (signal class, patterns).
# These are usage-shaped signals — a bare path-library import or API mention
# matches none of them. Scanned per diff chunk over neutralized text.
PATH_HANDLING_CONTENT_CLASSES: list[tuple[str, list[re.Pattern]]] = [
    # Explicit traversal literals (outside specifiers/anchor calls).
    ("traversal_literal", [PATH_TRAVERSAL_PATTERN]),
    # Path normalization / sanitization / containment logic: identifier-shaped
    # sanitize/validate/check vocabulary (kept from #720) plus the containment
    # and normalization APIs (`commonpath`, `is_relative_to`, `realpath`,
    # `abspath`, `normpath`, safe-join variants) that appear almost exclusively
    # in real boundary checks. Trusted anchor calls are neutralized before this
    # scans, so `os.path.realpath(__file__)` bookkeeping does not fire.
    ("path_containment_or_sanitization", [
        re.compile(r"sanitize[\w]*path|path[\w]*sanitize|clean[\w]*path|safe[\w]*path|path[\w]*safe", re.IGNORECASE),
        re.compile(r"validate[\w]*path|path[\w]*valid|check[\w]*path|path[\w]*check", re.IGNORECASE),
        re.compile(r"commonpath|is_relative_to", re.IGNORECASE),
        re.compile(r"realpath|abspath|normpath", re.IGNORECASE),
        re.compile(r"safe[_\w]*join|safejoin", re.IGNORECASE),
    ]),
    # Archive extraction: zip-slip surfaces. Member names are attacker-
    # influenceable even when the archive path itself is constant.
    ("archive_extraction", [
        re.compile(r"extractall|unpack_archive|safe_extract", re.IGNORECASE),
        re.compile(r"\b(?:zipfile|tarfile)\b", re.IGNORECASE),
        re.compile(r"\b(?:ZipFile|TarFile)\b", re.IGNORECASE),
        re.compile(r"\bunzip\s*\(", re.IGNORECASE),
    ]),
    # Symlink-sensitive filesystem operations.
    ("symlink_sensitive", [
        re.compile(r"symlink|readlink|lstat|follow_symlinks|O_NOFOLLOW", re.IGNORECASE),
    ]),
    # Identifier-shaped path references (`filepath`, `pathname`) — variables
    # and identifiers named after the path they denote. More specific than the
    # removed `pathlib`/`os.path` mention patterns and kept deliberately.
    ("path_reference_identifier", [
        re.compile(r"filepath|pathname", re.IGNORECASE),
    ]),
]

# Untrusted-source join: a path construction/consumption call that reaches a
# request/user-controlled value. Same-line construction with an untrusted
# operand fires directly; for ADJACENT-line flow the rule is one-hop def/use,
# not co-occurrence: the untrusted line must carry a simple assignment
# (`name = request.args[...]`) whose exact target identifier the construction
# line uses. An unrelated request/user/payload token near a constant join
# never fires. Multi-hop flows through neutral intermediaries are the model
# reviewer's job, not the lexical classifier's.
PATH_CONSTRUCTION_PATTERNS = [
    re.compile(r"os\.path\.(?:join|normpath|realpath|abspath|relpath|commonpath)\b", re.IGNORECASE),
    re.compile(r"\bPath\s*\("),  # pathlib constructor (case-sensitive)
    re.compile(r"\bpath\.(?:join|resolve|normalize|dirname|basename)\s*\(", re.IGNORECASE),
    re.compile(r"\bfilepath\.\w+\s*\(", re.IGNORECASE),
    re.compile(r"\b(?:open|fopen)\s*\(", re.IGNORECASE),
    re.compile(r"\b(?:readFile|writeFile|readFileSync|writeFileSync|appendFile|createReadStream|createWriteStream|openSync)\s*\(", re.IGNORECASE),
    re.compile(r"\b(?:send_file|send_from_directory|sendFile|FileResponse|UploadFile|serveStatic|FileServer|StaticFiles)\b", re.IGNORECASE),
    re.compile(r"\bshutil\.(?:copy|copy2|copyfile|copytree|move|rmtree|unpack_archive)\b", re.IGNORECASE),
    re.compile(r"\bos\.(?:mkdir|makedirs|unlink|rename|remove)\b", re.IGNORECASE),
]

# Values an attacker plausibly controls when they reach a filesystem path:
# HTTP request data, user/model input, CLI arguments, and file-object names
# (`file.filename` — the classic unsafe-upload/join source). Deliberately
# EXCLUDED: environment variables and process cwd — env/config paths are
# operator-owned infrastructure (the PR #748 lesson: CI scripts join
# env-provided output paths constantly and are not attacker surfaces) — and
# `upload` directory vocabulary: `UPLOAD_DIR`/`uploads/` names are ubiquitous
# in TRUSTED paths; the upload risk lives in the filename operand, which has
# its own token.
UNTRUSTED_SOURCE_PATTERNS = [
    re.compile(r"request", re.IGNORECASE),
    re.compile(r"\breq\s*\.", re.IGNORECASE),
    re.compile(r"user", re.IGNORECASE),
    re.compile(r"\binput", re.IGNORECASE),
    re.compile(r"query", re.IGNORECASE),
    re.compile(r"params", re.IGNORECASE),
    re.compile(r"\bform\b|formdata", re.IGNORECASE),
    re.compile(r"payload", re.IGNORECASE),
    re.compile(r"\bheaders?\b", re.IGNORECASE),
    re.compile(r"\bcookies?\b", re.IGNORECASE),
    re.compile(r"\bstdin\b", re.IGNORECASE),
    re.compile(r"\bargv\b", re.IGNORECASE),
    re.compile(r"\bfilename\b", re.IGNORECASE),
    re.compile(r"untrusted|unsanitized|attacker", re.IGNORECASE),
]

# Test/fixture file conventions, cross-language. Signals found only in test
# files are fixture construction ("static paths under test directories"),
# not a shippable untrusted-path surface; they are discounted (recorded in
# provenance as `diff_test_file`, never fire).
TEST_FILE_PATTERNS = [
    re.compile(r"(?:^|/)(?:tests?|testing|spec|specs|__tests__|fixtures?|testdata)/", re.IGNORECASE),
    re.compile(r"(?:^|/)(?:conftest\.py|test_[^/]*\.py|[^/]*_test\.(?:py|go|rs|rb|java|kt|cs)|[^/]*\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts))$", re.IGNORECASE),
]


def _is_test_path(path: str) -> bool:
    """True when a file path follows test/fixture conventions."""
    return any(pat.search(path) for pat in TEST_FILE_PATTERNS)


# Bounded unified-diff chunk header: `diff --git a/<path> b/<path>`. Used to
# attribute diff content to the file it belongs to so test-file signals can
# be discounted. Diffs without git headers (raw synthetic text) form a single
# chunk with an unknown file, which is treated conservatively as non-test.
_DIFF_GIT_HEADER = re.compile(r"^diff --git a/(\S+) b/(\S+)\s*$")


def _split_diff_chunks(diff_text: str) -> list[tuple[str | None, list[str]]]:
    """Split a unified diff into (file_path_or_None, lines) chunks on
    `diff --git` headers. Best-effort: a header line whose paths cannot be
    parsed is kept as content (conservative mis-attribution only ever keeps
    scrutiny, never drops it)."""
    chunks: list[tuple[str | None, list[str]]] = []
    current_file: str | None = None
    current: list[str] = []
    for line in diff_text.splitlines():
        m = _DIFF_GIT_HEADER.match(line)
        if m:
            if current:
                chunks.append((current_file, current))
            current_file = m.group(2)
            current = []
        else:
            current.append(line)
    if current:
        chunks.append((current_file, current))
    return chunks


# Provenance bounds: attacker-controlled diff text is never emitted raw or
# unbounded. Samples are control-character-free bounded line excerpts; counts
# are capped so a pathological diff cannot flood the artifact.
MAX_PATH_SIGNALS = 8
MAX_PATH_FILES = 8
MAX_PATH_SAMPLES = 3
MAX_PATH_SAMPLE_CHARS = 160


def _path_sample(line: str) -> str:
    """Bounded, control-character-free excerpt of a matched line."""
    cleaned = "".join(
        " " if ("\0" <= ch < " " or ch == "\x7f") else ch for ch in line
    ).strip()
    return cleaned[:MAX_PATH_SAMPLE_CHARS]


def _record_signal(
    buckets: dict[tuple[str, str], dict],
    signal: str,
    source: str,
    file: str | None,
    sample: str | None,
) -> None:
    """Merge one raw hit into a signal bucket (dedup by class + backing,
    bounded file/sample lists, stable first-seen order)."""
    key = (signal, source)
    entry = buckets.get(key)
    if entry is None:
        if len(buckets) >= MAX_PATH_SIGNALS:
            return
        entry = {"signal": signal, "source": source, "files": [], "samples": []}
        buckets[key] = entry
    if file and file not in entry["files"] and len(entry["files"]) < MAX_PATH_FILES:
        entry["files"].append(file)
    if sample and sample not in entry["samples"] and len(entry["samples"]) < MAX_PATH_SAMPLES:
        entry["samples"].append(sample)


def evaluate_path_handling_signals(
    filenames: list[str],
    diff_text: str,
) -> tuple[list[dict], list[dict]]:
    """Evaluate the #749 path-handling signal model.

    Returns ``(fired, discounted)``: bounded signal dicts with keys
    ``signal`` (class/category), ``source`` (``filename`` | ``diff`` |
    ``diff_test_file``), ``files`` (attributed file paths), and ``samples``
    (bounded line excerpts). ``fired`` drives the kind/flag/must_check;
    ``discounted`` records trusted-scaffolding and test-file signals that
    were deliberately not allowed to fire, so a future false positive is
    debuggable from the artifact alone.
    """
    fired_buckets: dict[tuple[str, str], dict] = {}
    discounted_buckets: dict[tuple[str, str], dict] = {}

    # 1) Filename-backed signals: identifier-shaped path vocabulary in the
    # changed-file list. Test-file hits are discounted.
    for name in filenames:
        if not any(pat.search(name) for pat in PATH_HANDLING_FILENAME_PATTERNS):
            continue
        source = "filename" if not _is_test_path(name) else "filename_test_file"
        _record_signal(
            discounted_buckets if source == "filename_test_file" else fired_buckets,
            "path_identifier_filename", source, name, None,
        )

    # 2) Diff-content signals, attributed per chunk so test-file content can
    # be discounted. All classes scan neutralized text (trusted scaffolding
    # removed); only the untrusted-join class adds the ±1-line window.
    # A chunk without a git-header filename (headerless/synthetic diff) can
    # still be discounted when EVERY changed file is a test file — the whole
    # diff is then test content. Mixed or unknown file sets fire
    # conservatively.
    all_files_are_tests = bool(filenames) and all(
        _is_test_path(name) for name in filenames
    )
    for chunk_file, lines in _split_diff_chunks(diff_text):
        if not lines:
            continue
        neutralized = _neutralize_chunk_lines(lines)
        if chunk_file is not None:
            is_test = _is_test_path(chunk_file)
        else:
            is_test = all_files_are_tests
        buckets = discounted_buckets if is_test else fired_buckets
        source = "diff_test_file" if is_test else "diff"

        for class_name, patterns in PATH_HANDLING_CONTENT_CLASSES:
            for index, line in enumerate(neutralized):
                if not any(pat.search(line) for pat in patterns):
                    continue
                _record_signal(
                    buckets, class_name, source, chunk_file,
                    _path_sample(lines[index]),
                )
                break  # one bucket entry per class per chunk; samples merge below

        # Untrusted-source join: same-line construction with an untrusted
        # OPERAND fires directly — the scan inspects the construction
        # expression (the assignment LHS is excluded, so a target named
        # `request_cache_path` is not evidence of untrusted input), and
        # static string literals are stripped (a quoted "request" is data).
        # Adjacent lines fire only on a one-hop def/use edge: the untrusted
        # line must carry a simple assignment whose exact target identifier
        # the construction expression uses. Co-occurrence never fires.
        for index, raw_line in enumerate(lines):
            neutral = neutralized[index]
            assign = _UNTRUSTED_ASSIGNMENT.match(neutral)
            expression = neutral[assign.end():] if assign else neutral
            flow_text = _QUOTED_STATIC_LITERAL.sub('""', expression)
            if not any(pat.search(flow_text) for pat in PATH_CONSTRUCTION_PATTERNS):
                continue
            if any(pat.search(flow_text) for pat in UNTRUSTED_SOURCE_PATTERNS):
                _record_signal(
                    buckets, "untrusted_source_join", source, chunk_file,
                    _path_sample(raw_line),
                )
                continue
            for adj_index in (index - 1, index + 1):
                if not 0 <= adj_index < len(lines):
                    continue
                target = _untrusted_assignment_target(lines[adj_index])
                if target and re.search(rf"\b{re.escape(target)}\b", flow_text):
                    _record_signal(
                        buckets, "untrusted_source_join", source, chunk_file,
                        _path_sample(raw_line),
                    )
                    break

    return list(fired_buckets.values()), list(discounted_buckets.values())


def _is_path_handling(filenames: list[str], diff_text: str) -> bool:
    """Path-handling kind rule: fires only when the signal model found a
    material (non-discounted) untrusted-path surface."""
    fired, _ = evaluate_path_handling_signals(filenames, diff_text)
    return bool(fired)

# Secret handling changes
SECRET_HANDLING_PATTERNS = [
    re.compile(r"(secret|credential|password|api.?key|private.?key|token)"
               r"[_.-]?\w*\.(py|js|ts|go|rb|yaml|yml|json)$", re.IGNORECASE),
    re.compile(r"secrets?\.ya?ml$"),
    re.compile(r"vault|hashicorp|aws.?secrets", re.IGNORECASE),
    re.compile(r"base64\.(decode|encode)", re.IGNORECASE),
]

# DB / migration changes
DB_MIGRATION_PATTERNS = [
    re.compile(r"(migration|migrate|migrations?)", re.IGNORECASE),
    re.compile(r"schema\.(py|rb|ts|js|sql|prisma)$", re.IGNORECASE),
    re.compile(r"models?\." + _SRC_EXT + r"$", re.IGNORECASE),
    re.compile(r"(entity|entities|repository)\.(java|kt|cs|ts)$", re.IGNORECASE),
    re.compile(r"\.sql$", re.IGNORECASE),
    re.compile(r"alembic|django.*migrat|sequelize|migrate_", re.IGNORECASE),
    re.compile(r"prisma/schema\.prisma$"),
]


# ---------------------------------------------------------------------------
# Classification result
# ---------------------------------------------------------------------------

@dataclass
class PRClassification:
    pr_kind: str = "app_code"
    risk_flags: list[str] = field(default_factory=list)
    risk_flags_with_files: dict[str, list[str]] = field(default_factory=dict)
    # Subset of (pr_kind + risk_flags) safe to drive smart-model routing:
    # linked-issue flags and any file-based signal backed by an actual changed
    # filename. Content-only pattern matches (e.g. a diff that merely mentions
    # os.path or `token`) are excluded — they over-route benign PRs (#159 fix).
    route_signals: list[str] = field(default_factory=list)
    changed_files_summary: list[str] = field(default_factory=list)
    linked_issue_labels: list[str] = field(default_factory=list)
    must_check: list[str] = field(default_factory=list)
    # #633: linked-metadata completeness for deep_review=auto role selection.
    # True when a selection-relevant metadata source (GitHub linked-issue
    # labels, configured Linear priority/labels) was EXPECTED but could not
    # be determined — missing signals must not be read as absent signals by
    # the deterministic selector (it fails toward scrutiny). Known-disabled
    # state (Linear fork-gated off, no linked issues, no configured
    # identifiers) is NOT uncertainty. Unusable status input degrades to
    # not-uncertain: the stale-review fingerprint has its own conservative
    # failure path for undetermined inputs.
    linked_metadata_uncertain: bool = False
    linked_metadata_uncertainty: list[str] = field(default_factory=list)
    # #749: bounded provenance for the path-handling signal model — why
    # path handling fired (class/category, filename vs diff backing, bounded
    # samples) and which test-file/trusted-scaffolding signals were
    # deliberately discounted. Empty lists when path handling did not fire.
    # Never contains unbounded attacker-controlled text.
    path_handling_provenance: dict = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _has_version_bump(diff_text: str) -> bool:
    """Check if the diff contains a version bump (not just a digest).

    Detects both JSON (`"version": "..."`) and YAML (`version:`/`appVersion:`)
    forms. The YAML check only matches changed (+/-) lines so an unchanged
    `version:` context line in a digest-only update is not a false positive.
    """
    if re.search(r'"version"\s*:\s*"[^"]+"', diff_text):
        return True
    if re.search(r'(?m)^[+-]\s*(?:app)?[Vv]ersion:\s*\S+', diff_text):
        return True
    return False


def _all_files_are_lockfiles(filenames: list[str]) -> bool:
    """True only when every changed file is a known lockfile.

    Guards renovate_digest_only against mixed PRs (code + a lockfile), which
    must not be classified as a trivial digest update.
    """
    if not filenames:
        return False
    return all(
        any(pat.search(f) for pat in RENOVATE_DIGEST_FILE_PATTERNS)
        for f in filenames
    )


# ---------------------------------------------------------------------------
# pr_kind rule table
# ---------------------------------------------------------------------------
#
# Classification is a declarative table of rules evaluated top-to-bottom by one
# engine loop (`_classify_pr_kind`). The FIRST matching rule wins, so TABLE
# ORDER *is* precedence — rows are ordered most-specific first. This replaces
# the former hand-written if-chain; the ordering below is identical to it.
#
# Each rule's `matches(filenames, diff_text) -> bool` predicate is built from a
# pattern set by one of the factories below, except the two compound rules
# (renovate_digest_only, dependency_upgrade) whose conditions don't reduce to a
# single pattern scan and are kept as named predicate functions.

# Pattern-based predicate factories -----------------------------------------

def _filename_matches(patterns: list[re.Pattern]) -> Callable[[list[str], str], bool]:
    """Predicate: any changed filename matches any pattern in the set."""
    def _pred(filenames: list[str], diff_text: str) -> bool:
        return any(any(pat.search(f) for pat in patterns) for f in filenames)
    return _pred


def _filename_or_diff_matches(patterns: list[re.Pattern]) -> Callable[[list[str], str], bool]:
    """Predicate: any pattern matches a changed filename OR the diff content.

    Mirrors the original two-step check (filenames first, then diff) — both
    steps yielded the same kind, so folding them into one OR is behavior-
    preserving while keeping the diff fallback in a single rule.
    """
    def _pred(filenames: list[str], diff_text: str) -> bool:
        if any(any(pat.search(f) for pat in patterns) for f in filenames):
            return True
        return any(pat.search(diff_text) for pat in patterns)
    return _pred


# Compound predicates (don't reduce to a single pattern scan) ----------------

def _is_renovate_digest_only(filenames: list[str], diff_text: str) -> bool:
    """Most specific rule: EVERY changed file is a lockfile and the diff has no
    version bump. Guards against a mixed PR (real code + a lockfile) being
    mislabeled as trivial and steering weaker models toward rubber-stamping it.
    """
    return _all_files_are_lockfiles(filenames) and not _has_version_bump(diff_text)


def _is_dependency_upgrade(filenames: list[str], diff_text: str) -> bool:
    """A dependency/manifest file changed, but NOT a k8s manifest (which happens
    to reference versions and must classify as k8s_manifest instead).
    """
    has_dep_file = any(
        any(pat.search(f) for pat in DEPENDENCY_PATTERNS) for f in filenames
    )
    if not has_dep_file:
        return False
    has_k8s = any(any(pat.search(f) for pat in K8S_PATTERNS) for f in filenames)
    return not has_k8s


@dataclass(frozen=True)
class KindRule:
    """One pr_kind classification rule: a name plus a match predicate."""
    kind: str
    matches: Callable[[list[str], str], bool]


# Precedence encoded as order: first matching rule wins.
KIND_RULES: list[KindRule] = [
    KindRule("renovate_digest_only", _is_renovate_digest_only),
    KindRule("dependency_upgrade", _is_dependency_upgrade),
    KindRule("k8s_manifest", _filename_matches(K8S_PATTERNS)),
    # secret handling before auth (more specific)
    KindRule("secret_handling_changes", _filename_matches(SECRET_HANDLING_PATTERNS)),
    KindRule("db_or_migration_changes", _filename_matches(DB_MIGRATION_PATTERNS)),
    KindRule("auth_changes", _filename_matches(AUTH_PATTERNS)),
    KindRule("public_route_changes", _filename_matches(PUBLIC_ROUTE_PATTERNS)),
    KindRule("file_serving_changes", _filename_or_diff_matches(FILE_SERVING_PATTERNS)),
    KindRule("path_handling_changes", _is_path_handling),
]

# Fallback kind when no rule matches.
DEFAULT_PR_KIND = "app_code"


def _classify_pr_kind(
    files: list[dict],
    diff_text: str,
) -> str:
    """Determine the single best pr_kind from file patterns and diff content.

    Evaluates KIND_RULES in order and returns the first match; falls back to
    DEFAULT_PR_KIND ("app_code") when nothing matches.
    """
    filenames = [f.get("filename", "") for f in files]
    for rule in KIND_RULES:
        if rule.matches(filenames, diff_text):
            return rule.kind
    return DEFAULT_PR_KIND


# ---------------------------------------------------------------------------
# Risk-flag rule tables
# ---------------------------------------------------------------------------

# Linked-issue flags: a flag fires when a linked issue carries ANY of the
# trigger labels (case-insensitive). Order matters — flags are appended in this
# order (deduplicated) as issues are scanned.
LINKED_ISSUE_RULES: list[tuple[frozenset[str], str]] = [
    (frozenset({"security", "vulnerability"}), "linked_security_issue"),
    (frozenset({"audit"}), "linked_audit_issue"),
    (frozenset({"priority/p0", "priority_p0"}), "linked_priority_p0"),
    (frozenset({"priority/p1", "priority_p1"}), "linked_priority_p1"),
]

# File-based flags: a flag fires when any changed filename OR the diff content
# matches the pattern set. Order matters — flags are appended in this order.
# The path_handling entry uses the #749 signal model (evaluate_path_handling_
# signals) instead of a plain pattern scan; its pattern list here backs only
# the filename attribution vocabulary.
FILE_RISK_RULES: list[tuple[list[re.Pattern], str]] = [
    (FILE_SERVING_PATTERNS, "file_serving_changes"),
    (PATH_HANDLING_FILENAME_PATTERNS, "path_handling_changes"),
    (AUTH_PATTERNS, "auth_changes"),
    (SECRET_HANDLING_PATTERNS, "secret_handling_changes"),
]


def _detect_risk_flags(
    files: list[dict],
    diff_text: str,
    linked_issues: list[dict],
) -> tuple[list[str], dict[str, list[str]]]:
    """Detect risk flags based on file patterns and linked issue metadata.

    Driven by two rule tables: LINKED_ISSUE_RULES (scanned first, per issue)
    and FILE_RISK_RULES (scanned second). Flag append order follows table
    order, matching the former hand-written checks.

    Returns
    -------
    flags : list[str]
        Ordered list of detected risk flag names (unchanged semantics).
    flags_with_files : dict[str, list[str]]
        Mapping from each file-based risk flag to the file paths that triggered
        it.  Issue-linked flags (linked_security_issue, etc.) have no file
        attribution and are omitted from this mapping.  When a flag fires only
        from diff content (no filename match), the mapping contains an empty
        list for that flag.
    """
    flags: list[str] = []
    flags_with_files: dict[str, list[str]] = {}
    filenames = [f.get("filename", "") for f in files]

    # Linked security/audit/priority issues (table order, deduplicated).
    # Linear's native priority is numeric (1=Urgent, 2=High). Convert those
    # values to the same synthetic labels recognized for linked issues so teams
    # do not need to duplicate Linear priority as a custom label.
    for issue in linked_issues:
        labels = {lb.get("name", "").lower() for lb in issue.get("labels", [])}
        if str(issue.get("source", "")).lower() == "linear":
            priority = issue.get("priority")
            if type(priority) is int:
                if priority == 1:
                    labels.add("priority/p0")
                elif priority == 2:
                    labels.add("priority/p1")
        for trigger_labels, flag in LINKED_ISSUE_RULES:
            if labels & trigger_labels and flag not in flags:
                flags.append(flag)

    # File-based risk flags (derived from classification patterns).
    for pat_set, flag in FILE_RISK_RULES:
        if flag == "path_handling_changes":
            # #749: the path-handling flag uses the untrusted-surface signal
            # model. Filename attribution keeps the historical semantics —
            # only filename-backed hits populate the file list (content-only
            # matches attribute to an empty list), so smart-model routing is
            # unchanged (#159).
            fired, _ = evaluate_path_handling_signals(filenames, diff_text)
            matches_in_diff = any(s["source"] == "diff" for s in fired)
            triggering_files: list[str] = []
            for signal in fired:
                if signal["source"] != "filename":
                    continue
                for name in signal["files"]:
                    if name not in triggering_files:
                        triggering_files.append(name)
        else:
            # Collect the specific files that triggered this flag
            triggering_files = [
                f for f in filenames
                if any(pat.search(f) for pat in pat_set)
            ]
            matches_in_diff = any(pat.search(diff_text) for pat in pat_set)
        if triggering_files or matches_in_diff:
            if flag not in flags:
                flags.append(flag)
            # Record file attribution (empty list when only diff content matched)
            flags_with_files[flag] = triggering_files

    return flags, flags_with_files


# Checklist items per risk class. Keys are pr_kind values AND the file-based
# risk flags (which share names), so a flag like auth_changes detected on an
# app_code PR still pulls in the auth checklist (#157).
KIND_CHECKS: dict[str, list[str]] = {
    "renovate_digest_only": [
        "verify no functional changes beyond lockfile hashes",
    ],
    "dependency_upgrade": [
        "check for breaking API changes in updated dependencies",
        "run full test suite after upgrade",
    ],
    "k8s_manifest": [
        "validate manifest against target cluster version",
        "check for resource quota / limit changes",
    ],
    "auth_changes": [
        "review auth flow for regression",
        "verify session token handling is correct",
    ],
    "public_route_changes": [
        "verify route access controls are in place",
        "check for unintended public endpoints",
    ],
    "file_serving_changes": [
        "verify file path sanitization",
        "check for directory traversal vulnerabilities",
    ],
    "path_handling_changes": [
        "review for path traversal vulnerabilities",
        "test with edge-case paths (null bytes, symlinks)",
    ],
    "secret_handling_changes": [
        "verify secrets are not logged or exposed in diffs",
        "check secret rotation impact",
    ],
    "db_or_migration_changes": [
        "review migration for data loss risk",
        "test migration on a copy of production schema",
    ],
}

# Checklist items per linked-issue risk flag.
FLAG_CHECKS: dict[str, list[str]] = {
    "linked_security_issue": ["explicitly address the linked security issue"],
    "linked_audit_issue": ["verify audit findings are addressed"],
    "linked_priority_p0": ["treat as critical — verify all changes thoroughly"],
    "linked_priority_p1": ["treat as high priority — verify correctness carefully"],
}


# Kinds whose classification can come from diff CONTENT, not just filenames
# (they use _filename_or_diff_matches). A content-only match of these must not
# drive smart-model routing — only an actual changed filename should.
_CONTENT_CAPABLE_KINDS: dict[str, list[re.Pattern]] = {
    "file_serving_changes": FILE_SERVING_PATTERNS,
    # #749: the path-handling kind fires from the signal model; routing stays
    # filename-gated exactly as before — only a filename vocabulary hit (the
    # same effective subset as the removed mention patterns) may route.
    "path_handling_changes": PATH_HANDLING_FILENAME_PATTERNS,
}


def _route_signals(
    pr_kind: str,
    filenames: list[str],
    risk_flags: list[str],
    risk_flags_with_files: dict[str, list[str]],
) -> list[str]:
    """Signals eligible to route a PR straight to the smart model.

    Excludes content-only matches (which over-route benign PRs): keeps
    linked-issue flags, file-based flags backed by a real changed filename, and
    the pr_kind unless it is a content-only file_serving/path_handling match.
    """
    signals: list[str] = []
    # Linked-issue flags are explicit human signals — always route.
    for flag in risk_flags:
        if flag.startswith("linked_") and flag not in signals:
            signals.append(flag)
    # File-based risk flags only when an actual changed filename matched;
    # content-only matches carry an empty file list.
    for flag, files in risk_flags_with_files.items():
        if files and flag not in signals:
            signals.append(flag)
    # pr_kind routes unless it is the catch-all default or a content-only
    # file_serving/path_handling kind.
    if pr_kind and pr_kind != DEFAULT_PR_KIND and pr_kind not in signals:
        patterns = _CONTENT_CAPABLE_KINDS.get(pr_kind)
        if patterns is None:
            signals.append(pr_kind)
        elif any(any(p.search(fn) for p in patterns) for fn in filenames):
            signals.append(pr_kind)
    return signals


def _build_must_check(pr_kind: str, risk_flags: list[str]) -> list[str]:
    """Generate explicit must-check items based on classification.

    Checks come from the union of the pr_kind and every detected risk flag
    (deduplicated, pr_kind first) — not the pr_kind alone, so secondary risk
    signals still produce their checklists.
    """
    checks: list[str] = []
    seen: set[str] = set()

    for key in [pr_kind, *risk_flags]:
        for check in KIND_CHECKS.get(key, []) + FLAG_CHECKS.get(key, []):
            if check not in seen:
                seen.add(check)
                checks.append(check)

    return checks


def _linked_metadata_uncertainty(
    metadata_status: dict | None,
) -> tuple[bool, list[str]]:
    """Parse the context pipeline's linked-metadata completeness artifact
    (scripts/sections/context.sh) into an uncertainty flag + human reasons
    for the classification contract (#633).

    Uncertain = a selection-relevant metadata source was EXPECTED but could
    not be determined: a GitHub linked-issue fetch failed, or a configured
    Linear lookup failed (adapter failure or per-identifier failure).
    Known-disabled state (``linear_known_disabled`` — Linear fork-gated off)
    is deliberately not uncertainty, and a missing/unusable status artifact
    degrades to not-uncertain (ordinary no-linked-issues reviews must stay
    ordinary; the stale-review fingerprint carries the conservative failure
    path for undetermined inputs). All input text is untrusted: reasons are
    bounded, control-character-free strings."""
    if not isinstance(metadata_status, dict):
        return False, []

    def _clean(value: object) -> str:
        if not isinstance(value, str):
            return ""
        text = value.strip()
        if not text or any("\0" <= ch < " " or ch == "\x7f" for ch in text):
            return ""
        return text[:200]

    reasons: list[str] = []
    failures = metadata_status.get("github_fetch_failures")
    if isinstance(failures, list):
        for ref in failures:
            ref = _clean(ref)
            if ref:
                reasons.append(f"github linked issue {ref} fetch failed")
    linear_failures = metadata_status.get("linear_fetch_failures")
    if isinstance(linear_failures, list):
        for ref in linear_failures:
            ref = _clean(ref)
            if ref:
                reasons.append(f"linear {ref} lookup failed")
    if metadata_status.get("linear_known_disabled") is True:
        pass  # known-disabled: intentionally no Linear data, not uncertainty
    return bool(reasons), reasons


def classify_pr(
    pr_files: list[dict],
    diff_text: str = "",
    linked_issues: list[dict] | None = None,
    max_summary_files: int = 50,
    metadata_status: dict | None = None,
) -> PRClassification:
    """Run deterministic classification on a PR.

    Parameters
    ----------
    pr_files : list[dict]
        PR files array from ``gh api repos/.../pulls/N/files``.
    diff_text : str
        Raw PR diff text (truncated).
    linked_issues : list[dict], optional
        Already-fetched linked issue dicts with ``labels`` keys.
    max_summary_files : int
        Maximum number of files to include in changed_files_summary.

    Returns
    -------
    PRClassification
    """
    if linked_issues is None:
        linked_issues = []

    uncertainty = _linked_metadata_uncertainty(metadata_status)

    # #749: evaluate the path-handling signal model once and share it across
    # the kind rule, the risk-flag rule, and the provenance artifact.
    path_fired, path_discounted = evaluate_path_handling_signals(
        [f.get("filename", "") for f in pr_files], diff_text,
    )
    path_provenance = {
        "fired": bool(path_fired),
        "signals": path_fired,
        "discounted": path_discounted,
    }

    pr_kind = _classify_pr_kind(pr_files, diff_text)
    risk_flags, risk_flags_with_files = _detect_risk_flags(pr_files, diff_text, linked_issues)
    must_check = _build_must_check(pr_kind, risk_flags)

    # Build changed files summary (just filenames, truncated)
    file_names = [f.get("filename", "") for f in pr_files]
    changed_files_summary = file_names[:max_summary_files]
    route_signals = _route_signals(
        pr_kind, file_names, risk_flags, risk_flags_with_files
    )

    # Collect linked issue labels
    linked_issue_labels: list[str] = []
    for issue in linked_issues:
        for lb in issue.get("labels", []):
            name = lb.get("name", "")
            if name and name not in linked_issue_labels:
                linked_issue_labels.append(name)

    return PRClassification(
        pr_kind=pr_kind,
        risk_flags=risk_flags,
        risk_flags_with_files=risk_flags_with_files,
        route_signals=route_signals,
        changed_files_summary=changed_files_summary,
        linked_issue_labels=linked_issue_labels,
        must_check=must_check,
        linked_metadata_uncertain=uncertainty[0],
        linked_metadata_uncertainty=uncertainty[1],
        path_handling_provenance=path_provenance,
    )


def classify_from_files(
    pr_files_path: str | Path,
    diff_path: str | Path = "",
    issues_path: str | Path = "",
    output_path: str | Path = "classification.json",
    metadata_status_path: str | Path = "",
) -> PRClassification:
    """Convenience wrapper that reads from files and writes JSON output.

    Used by run_review.sh to classify a PR during the review pipeline.
    """
    pr_files_path = Path(pr_files_path)
    pr_files = json.loads(pr_files_path.read_text(encoding="utf-8"))

    diff_text = ""
    if diff_path:
        diff_text = Path(diff_path).read_text(encoding="utf-8", errors="replace")

    linked_issues: list[dict] = []
    if issues_path and Path(issues_path).exists():
        linked_issues = json.loads(
            Path(issues_path).read_text(encoding="utf-8"))

    # #633: linked-metadata completeness (fail-soft — a missing or malformed
    # artifact means not-uncertain, never an aborted classification).
    metadata_status: dict | None = None
    if metadata_status_path and Path(metadata_status_path).exists():
        try:
            metadata_status = json.loads(
                Path(metadata_status_path).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            metadata_status = None

    result = classify_pr(pr_files, diff_text, linked_issues,
                         metadata_status=metadata_status)

    output = Path(output_path)
    output.write_text(json.dumps(result.to_dict(), indent=2) + "\n")

    return result


# ---------------------------------------------------------------------------
# CLI entry point (for run_review.sh)
# ---------------------------------------------------------------------------

def main() -> None:
    """CLI: python3 scripts/classify_pr.py --pr-files F --diff D ..."""
    import argparse

    parser = argparse.ArgumentParser(
        description="Deterministic PR classification and risk-flag detection")
    parser.add_argument("--pr-files", required=True,
                        help="Path to pr-files.json")
    parser.add_argument("--diff", default="",
                        help="Path to pr.diff.truncated (optional)")
    parser.add_argument("--linked-issues", default="",
                        help="Path to linked-issues.json (optional)")
    parser.add_argument("--metadata-status", default="",
                        help="Path to linked-metadata-status.json (#633 "
                             "linked-issue/Linear completeness; optional)")
    parser.add_argument("--output", default="classification.json",
                        help="Output path for classification JSON")

    args = parser.parse_args()
    classify_from_files(
        pr_files_path=args.pr_files,
        diff_path=args.diff,
        issues_path=args.linked_issues,
        output_path=args.output,
        metadata_status_path=args.metadata_status,
    )


if __name__ == "__main__":
    main()
