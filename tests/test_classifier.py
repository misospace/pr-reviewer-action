"""Tests for pr_reviewer.classifier — deterministic PR classification."""

from __future__ import annotations

import json
import os
import sys

import tempfile
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT))

import pytest

from pr_reviewer.classifier import (
    PRClassification,
    classify_pr,
    classify_from_files,
    _classify_pr_kind,
    _detect_risk_flags,
    _build_must_check,
)


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


def _make_file(filename: str, status: str = "modified") -> dict:
    return {"filename": filename, "status": status}


# ---------------------------------------------------------------------------
# pr_kind tests
# ---------------------------------------------------------------------------

class TestPRKindRenovateDigestOnly:
    def test_detects_digest_only(self):
        files = [
            _make_file("package-lock.json"),
            _make_file("yarn.lock"),
        ]
        diff = '"a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"'
        kind = _classify_pr_kind(files, diff)
        assert kind == "renovate_digest_only"

    def test_not_digest_when_version_bump(self):
        files = [_make_file("package-lock.json")]
        diff = '"version": "2.0.0"\n"a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"'
        kind = _classify_pr_kind(files, diff)
        assert kind != "renovate_digest_only"

    def test_not_digest_when_mixed_with_code(self):
        # A lockfile plus a real source change must NOT be treated as trivial.
        files = [
            _make_file("package-lock.json"),
            _make_file("src/app/handler.ts"),
        ]
        diff = '"a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"'
        kind = _classify_pr_kind(files, diff)
        assert kind != "renovate_digest_only"

    def test_not_digest_when_yaml_version_bump(self):
        # Helm/YAML version bumps (unquoted) must defeat the digest-only path.
        files = [_make_file("Chart.yaml")]
        diff = "-appVersion: 1.2.3\n+appVersion: 1.3.0\n"
        kind = _classify_pr_kind(files, diff)
        assert kind != "renovate_digest_only"


class TestPRKindMultiLanguage:
    """Auth/route/DB heuristics should fire beyond Python."""

    def test_auth_typescript(self):
        assert _classify_pr_kind([_make_file("src/auth.ts")], "") == "auth_changes"

    def test_auth_controller_java(self):
        # AuthController.java should be flagged (auth takes precedence over route).
        assert _classify_pr_kind(
            [_make_file("src/main/java/AuthController.java")], ""
        ) == "auth_changes"

    def test_route_typescript(self):
        assert _classify_pr_kind(
            [_make_file("src/routes.ts")], ""
        ) == "public_route_changes"

    def test_model_go(self):
        assert _classify_pr_kind(
            [_make_file("internal/models.go")], ""
        ) == "db_or_migration_changes"

    def test_auth_risk_flag_typescript(self):
        flags, _ = _detect_risk_flags([_make_file("src/auth.ts")], "", [])
        assert "auth_changes" in flags


class TestPRKindDependencyUpgrade:
    def test_package_lock_with_version_bump(self):
        files = [_make_file("package-lock.json")]
        diff = '"version": "1.2.3"'
        kind = _classify_pr_kind(files, diff)
        assert kind == "dependency_upgrade"

    def test_go_mod(self):
        files = [_make_file("go.mod"), _make_file("go.sum")]
        kind = _classify_pr_kind(files, "")
        assert kind == "dependency_upgrade"

    def test_pipfile_lock(self):
        files = [_make_file("Pipfile.lock")]
        kind = _classify_pr_kind(files, "")
        assert kind == "dependency_upgrade"

    def test_workflow_semver_text_is_not_dependency_upgrade(self):
        files = [_make_file(".github/workflows/manual-release.yml")]
        diff = "Release version (for example 2.0.2 or v2.0.2)"
        kind = _classify_pr_kind(files, diff)
        assert kind == "app_code"

    def test_source_version_constant_is_not_dependency_upgrade(self):
        files = [_make_file("src/version.py")]
        diff = '-VERSION = "1.2.3"\n+VERSION = "1.2.4"'
        kind = _classify_pr_kind(files, diff)
        assert kind == "app_code"


class TestPRKindK8sManifest:
    @pytest.mark.parametrize("fname", [
        "helmrelease.yaml",
        "deployment.yaml",
        "statefulset.yml",
        "kustomization.yaml",
        "configmap.yaml",
        "secret.yaml",
        "service.yaml",
        "ingress.yaml",
        ".k8s.yaml",
        "k8s/deployment.yaml",
        "helm/templates/deployment.yaml",
    ])
    def test_k8s_manifest_variants(self, fname):
        files = [_make_file(fname)]
        kind = _classify_pr_kind(files, "")
        assert kind == "k8s_manifest"


class TestPRKindAuthChanges:
    @pytest.mark.parametrize("fname", [
        "auth.py",
        "login_handler.py",
        "middleware_auth.py",
        "permissions.yaml",
        "rbac.yaml",
        ".env.example",
    ])
    def test_auth_file_patterns(self, fname):
        files = [_make_file(fname)]
        kind = _classify_pr_kind(files, "")
        assert kind == "auth_changes"


class TestPRKindPublicRouteChanges:
    @pytest.mark.parametrize("fname", [
        "routes.py",
        "urls.py",
        "api/endpoints.py",
        "api.go",
        "controller.py",
    ])
    def test_route_file_patterns(self, fname):
        files = [_make_file(fname)]
        kind = _classify_pr_kind(files, "")
        assert kind == "public_route_changes"

    def test_bare_route_ts_is_not_public_route(self):
        # Next.js App Router mandates the name `route.ts` for every API
        # handler, so the filename carries no routing-layer signal and must
        # not match. See #531.
        files = [
            _make_file("src/app/api/groomer/route.ts"),
            _make_file("src/app/api/status/route.ts"),
        ]
        kind = _classify_pr_kind(files, "")
        assert kind != "public_route_changes"

    def test_routes_ts_still_public_route(self):
        # The plural `routes.<ext>` is a chosen name and still matches.
        files = [_make_file("src/routes.ts")]
        kind = _classify_pr_kind(files, "")
        assert kind == "public_route_changes"


class TestPRKindFileServingChanges:
    @pytest.mark.parametrize("fname", [
        "static_handler.py",
        "public/assets.js",
        "uploads/media.go",
    ])
    def test_file_serving_patterns(self, fname):
        files = [_make_file(fname)]
        kind = _classify_pr_kind(files, "")
        assert kind == "file_serving_changes"


class TestPRKindPathHandlingChanges:
    # #749: positive controls — each of these is a real untrusted-path
    # surface (traversal literals, containment/sanitization identifiers,
    # archive extraction, symlink operations) and must keep firing.
    @pytest.mark.parametrize("pattern", [
        "sanitize_path",
        "..\\..\\etc/passwd",
        "os.path.join(base, request.args['p'])",
        "tarfile",
        "extractall(dest)",
        "os.symlink(link, dest)",
        "realpath",
    ])
    def test_path_handling_in_diff(self, pattern):
        files = [_make_file("utils.py")]
        kind = _classify_pr_kind(files, pattern)
        assert kind == "path_handling_changes"

    # #749: negative controls — trusted path scaffolding and API mentions
    # with no untrusted input flow must not classify path handling by
    # themselves (the PR #748 false-positive class).
    @pytest.mark.parametrize("pattern", [
        "pathlib",
        "import pathlib\nROOT = Path(__file__).resolve().parent.parent",
        "path_join(base, 'static')",
        "os.path.join(base, 'templates')",
        'Path("/etc/myapp/config.yaml")',
        "os.environ.get('OUTPUT_DIR')",
    ])
    def test_trusted_path_scaffolding_is_not_path_handling(self, pattern):
        files = [_make_file("utils.py")]
        kind = _classify_pr_kind(files, pattern)
        assert kind == "app_code"
        flags, _ = _detect_risk_flags(files, pattern, [])
        assert "path_handling_changes" not in flags

    def test_esm_import_specifiers_are_not_traversal(self):
        # #679 review false positive: a cross-directory TypeScript import is
        # module resolution, not filesystem traversal.
        diff = "\n".join([
            '+import { runProcess } from "../runtime/subprocess.js";',
            '+} from "../gates/gates.js";',
            '+const mod = require("../lib/util.js");',
            '+await import("../lib/lazy.js");',
        ])
        assert _classify_pr_kind([_make_file("src/runtime/subprocess.ts")], diff) == "app_code"

    def test_doc_prose_is_not_a_path_signal(self):
        diff = "+The helper sanitizes all user-provided paths before use.\n"
        assert _classify_pr_kind([_make_file("README.md")], diff) == "app_code"

    def test_identifier_shaped_path_code_still_fires(self):
        diff = "+def sanitize_path(p):\n+    return resolvePath(p)\n"
        assert _classify_pr_kind([_make_file("src/x.py")], diff) == "path_handling_changes"

    def test_same_line_specifier_and_traversal_still_fires(self):
        # Specifier neutralization is literal-scoped: a real traversal on the
        # same source line as a require/import specifier must still count.
        diff = "\n".join([
            '+const x = require("../lib"); fs.readFile("../../etc/passwd");',
            '+import { a } from "../lib"; fs.readFile("../../etc/shadow");',
            '+import { runProcess } from "../runtime/subprocess.js";',
        ])
        files = [_make_file("src/app.ts")]
        assert _classify_pr_kind(files, diff) == "path_handling_changes"
        flags, attribution = _detect_risk_flags(files, diff, [])
        assert "path_handling_changes" in flags
        checks = _build_must_check("app_code", ["path_handling_changes"])
        assert any("path traversal" in c for c in checks)
        assert any("edge-case paths" in c for c in checks)


class TestPRKindSecretHandlingChanges:
    @pytest.mark.parametrize("fname", [
        "secrets.yaml",
        "secret_handler.py",
        "vault_config.json",
    ])
    def test_secret_file_patterns(self, fname):
        files = [_make_file(fname)]
        kind = _classify_pr_kind(files, "")
        assert kind == "secret_handling_changes"


class TestPRKindDBMigrationChanges:
    @pytest.mark.parametrize("fname", [
        "migrations/001_add_users.py",
        "schema.py",
        "models.py",
        "db.sql",
        "alembic/versions/001.py",
        "prisma/schema.prisma",
    ])
    def test_db_migration_patterns(self, fname):
        files = [_make_file(fname)]
        kind = _classify_pr_kind(files, "")
        assert kind == "db_or_migration_changes"


class TestPRKindDefault:
    def test_app_code_default(self):
        files = [_make_file("app.py"), _make_file("utils/helper.js")]
        kind = _classify_pr_kind(files, "")
        assert kind == "app_code"


# ---------------------------------------------------------------------------
# Risk flags tests
# ---------------------------------------------------------------------------

class TestRiskFlags:
    def test_linked_security_issue(self):
        issues = [{"labels": [{"name": "security"}]}]
        flags, _ = _detect_risk_flags([], "", issues)
        assert "linked_security_issue" in flags

    def test_linked_audit_issue(self):
        issues = [{"labels": [{"name": "audit"}]}]
        flags, _ = _detect_risk_flags([], "", issues)
        assert "linked_audit_issue" in flags

    def test_linked_priority_p1(self):
        issues = [{"labels": [{"name": "priority/p1"}]}]
        flags, _ = _detect_risk_flags([], "", issues)
        assert "linked_priority_p1" in flags

    @pytest.mark.parametrize(
        ("priority", "expected_flag"),
        [(1, "linked_priority_p0"), (2, "linked_priority_p1")],
    )
    def test_linear_native_priority(self, priority, expected_flag):
        issues = [{"source": "linear", "priority": priority, "labels": []}]
        flags, _ = _detect_risk_flags([], "", issues)
        assert expected_flag in flags

    @pytest.mark.parametrize("priority", [0, 3, 4, None, True])
    def test_linear_non_escalating_priorities(self, priority):
        issues = [{"source": "linear", "priority": priority, "labels": []}]
        flags, _ = _detect_risk_flags([], "", issues)
        assert "linked_priority_p0" not in flags
        assert "linked_priority_p1" not in flags

    def test_native_priority_is_linear_only(self):
        issues = [{"source": "github", "priority": 1, "labels": []}]
        flags, _ = _detect_risk_flags([], "", issues)
        assert "linked_priority_p0" not in flags

    def test_no_risk_flags(self):
        issues = [{"labels": [{"name": "bug"}]}]
        flags, _ = _detect_risk_flags([], "", issues)
        assert not any(
            f.startswith("linked_") for f in flags
        ), f"Expected no linked risk flags, got {flags}"

    def test_file_serving_flag(self):
        files = [_make_file("static/handler.py")]
        flags, _ = _detect_risk_flags(files, "", [])
        assert "file_serving_changes" in flags


# ---------------------------------------------------------------------------
# Risk flag file attribution tests
# ---------------------------------------------------------------------------

class TestRiskFlagsWithFiles:
    """Tests for risk_flags_with_files — per-flag file attribution (issue #297)."""

    def test_auth_flag_attributes_triggering_file(self):
        # auth.py triggers auth_changes; the file should appear in attribution.
        files = [_make_file("auth.py"), _make_file("utils.py")]
        flags, attribution = _detect_risk_flags(files, "", [])
        assert "auth_changes" in flags
        assert "auth_changes" in attribution
        assert "auth.py" in attribution["auth_changes"]
        # utils.py did NOT trigger the flag
        assert "utils.py" not in attribution["auth_changes"]

    def test_secret_flag_attributes_multiple_files(self):
        # Two secret-related files both appear in the attribution list.
        files = [
            _make_file("secrets.yaml"),
            _make_file("vault_config.json"),
            _make_file("main.py"),
        ]
        flags, attribution = _detect_risk_flags(files, "", [])
        assert "secret_handling_changes" in flags
        attributed = attribution.get("secret_handling_changes", [])
        assert "secrets.yaml" in attributed
        assert "vault_config.json" in attributed
        assert "main.py" not in attributed

    def test_path_handling_diff_only_has_empty_file_list(self):
        # Flag fires only from diff content → attribution list is empty (no file names matched).
        files = [_make_file("app.py")]
        diff = "import pathlib\nresult = pathlib.Path(user_input)"
        flags, attribution = _detect_risk_flags(files, diff, [])
        assert "path_handling_changes" in flags
        # app.py itself did not match any path-handling filename pattern
        assert attribution.get("path_handling_changes", None) == []

    def test_linked_flags_absent_from_attribution(self):
        # Issue-linked flags have no file attribution and must not appear in mapping.
        issues = [{"labels": [{"name": "security"}, {"name": "priority/p0"}]}]
        flags, attribution = _detect_risk_flags([], "", issues)
        assert "linked_security_issue" in flags
        assert "linked_priority_p0" in flags
        assert "linked_security_issue" not in attribution
        assert "linked_priority_p0" not in attribution

    def test_classify_pr_exposes_risk_flags_with_files(self):
        # End-to-end: classify_pr should populate risk_flags_with_files on the result.
        files = [_make_file("src/auth_service.py"), _make_file("app.py")]
        result = classify_pr(files, diff_text="", linked_issues=[])
        assert isinstance(result.risk_flags_with_files, dict)
        assert "auth_changes" in result.risk_flags_with_files
        assert "src/auth_service.py" in result.risk_flags_with_files["auth_changes"]
        assert "app.py" not in result.risk_flags_with_files["auth_changes"]

    def test_risk_flags_with_files_in_serialized_dict(self):
        # risk_flags_with_files must survive to_dict() so run_review.sh can jq it.
        files = [_make_file("static/serve.py")]
        result = classify_pr(files)
        d = result.to_dict()
        assert "risk_flags_with_files" in d
        assert isinstance(d["risk_flags_with_files"], dict)
        assert "file_serving_changes" in d["risk_flags_with_files"]
        assert "static/serve.py" in d["risk_flags_with_files"]["file_serving_changes"]

    def test_no_file_based_flags_produces_empty_attribution(self):
        # A PR with only linked-issue flags and no file-pattern hits has empty attribution.
        files = [_make_file("README.md")]
        issues = [{"labels": [{"name": "audit"}]}]
        flags, attribution = _detect_risk_flags(files, "", issues)
        assert "linked_audit_issue" in flags
        # No file-based flags fired, so attribution only contains file-based entries
        file_based_flags = {"file_serving_changes", "path_handling_changes",
                            "auth_changes", "secret_handling_changes"}
        for flag in attribution:
            assert flag in file_based_flags


# ---------------------------------------------------------------------------
# Must-check tests
# ---------------------------------------------------------------------------

class TestMustCheck:
    def test_renovate_must_check(self):
        checks = _build_must_check("renovate_digest_only", [])
        assert any("lockfile" in c for c in checks)

    def test_dependency_must_check(self):
        checks = _build_must_check("dependency_upgrade", [])
        assert any("breaking" in c or "test suite" in c for c in checks)

    def test_security_flag_adds_check(self):
        checks = _build_must_check(
            "app_code", ["linked_security_issue"])
        assert any("security issue" in c for c in checks)

    def test_risk_flag_adds_checks_beyond_pr_kind(self):
        # An auth_changes flag on an app_code PR must still pull in the auth
        # checklist (#157) — checks are not keyed off pr_kind alone.
        checks = _build_must_check("app_code", ["auth_changes"])
        assert any("auth flow" in c for c in checks)
        assert any("session token" in c for c in checks)

    def test_multiple_risk_flags_union(self):
        checks = _build_must_check(
            "app_code", ["auth_changes", "path_handling_changes"])
        assert any("auth flow" in c for c in checks)
        assert any("path traversal" in c for c in checks)

    def test_kind_equal_to_flag_deduplicates(self):
        # auth_changes as both pr_kind and risk flag yields each check once.
        checks = _build_must_check("auth_changes", ["auth_changes"])
        assert len(checks) == len(set(checks))
        assert sum(1 for c in checks if "auth flow" in c) == 1

    def test_pr_kind_checks_come_first(self):
        checks = _build_must_check("file_serving_changes", ["auth_changes"])
        assert "sanitization" in checks[0] or "traversal" in checks[0]


# ---------------------------------------------------------------------------
# Full classify_pr integration tests
# ---------------------------------------------------------------------------

class TestClassifyPR:
    def test_basic_classification(self):
        files = [_make_file("app.py")]
        result = classify_pr(files, diff_text="", linked_issues=[])
        assert isinstance(result, PRClassification)
        assert result.pr_kind == "app_code"
        assert isinstance(result.risk_flags, list)
        assert isinstance(result.changed_files_summary, list)

    def test_renovate_classification(self):
        files = [_make_file("package-lock.json")]
        result = classify_pr(files, diff_text="", linked_issues=[])
        assert result.pr_kind == "renovate_digest_only"

    def test_k8s_with_risk_flags(self):
        files = [_make_file("k8s/deployment.yaml")]
        issues = [{"labels": [{"name": "priority/p1"}]}]
        result = classify_pr(
            files, diff_text="", linked_issues=issues)
        assert result.pr_kind == "k8s_manifest"
        assert "linked_priority_p1" in result.risk_flags

    def test_must_check_populated(self):
        files = [_make_file("migrations/001.py")]
        result = classify_pr(
            files, diff_text="", linked_issues=[])
        assert len(result.must_check) > 0
        assert any("migration" in c.lower() for c in result.must_check)

    def test_changed_files_summary_truncated(self):
        files = [_make_file(f"file_{i}.py") for i in range(100)]
        result = classify_pr(files, max_summary_files=50)
        assert len(result.changed_files_summary) == 50

    def test_linked_issue_labels_collected(self):
        issues = [
            {"labels": [{"name": "priority/p1"}, {"name": "bug"}]},
            {"labels": [{"name": "security"}, {"name": "audit"}]},
        ]
        result = classify_pr([], linked_issues=issues)
        assert "priority/p1" in result.linked_issue_labels
        assert "security" in result.linked_issue_labels
        assert "audit" in result.linked_issue_labels

    def test_to_dict(self):
        files = [_make_file("app.py")]
        result = classify_pr(files)
        d = result.to_dict()
        assert "pr_kind" in d
        assert "risk_flags" in d
        assert "risk_flags_with_files" in d
        assert "changed_files_summary" in d
        assert "linked_issue_labels" in d
        assert "must_check" in d


# ---------------------------------------------------------------------------
# classify_from_files CLI integration
# ---------------------------------------------------------------------------

class TestClassifyFromFile:
    def test_writes_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmppath = Path(tmp)
            pr_files = tmppath / "pr-files.json"
            pr_files.write_text(json.dumps([
                {"filename": "app.py", "status": "modified"}
            ]))
            diff_file = tmppath / "pr.diff"
            diff_file.write_text("changed some code\n")
            issues_file = tmppath / "linked-issues.json"
            issues_file.write_text(json.dumps([
                {"labels": [{"name": "priority/p1"}]}
            ]))
            output_file = tmppath / "classification.json"

            classify_from_files(
                pr_files_path=pr_files,
                diff_path=diff_file,
                issues_path=issues_file,
                output_path=output_file,
            )

            assert output_file.exists()
            data = json.loads(output_file.read_text())
            assert "pr_kind" in data
            assert isinstance(data["risk_flags"], list)
            assert data["pr_kind"] == "app_code"

    def test_renovate_from_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmppath = Path(tmp)
            pr_files = tmppath / "pr-files.json"
            pr_files.write_text(json.dumps([
                {"filename": "package-lock.json", "status": "modified"}
            ]))
            diff_file = tmppath / "pr.diff"
            diff_file.write_text('"a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"')
            output_file = tmppath / "classification.json"

            classify_from_files(
                pr_files_path=pr_files,
                diff_path=diff_file,
                issues_path="",
                output_path=output_file,
            )

            data = json.loads(output_file.read_text())
            assert data["pr_kind"] == "renovate_digest_only"


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------

class TestEdgeCases:
    def test_empty_pr_files(self):
        result = classify_pr([], diff_text="", linked_issues=[])
        assert result.pr_kind == "app_code"
        assert result.changed_files_summary == []

    def test_empty_diff_text(self):
        files = [_make_file("app.py")]
        result = classify_pr(files, diff_text="")
        assert isinstance(result, PRClassification)

    def test_multiple_linked_issues_labels_dedup(self):
        issues = [
            {"labels": [{"name": "priority/p1"}]},
            {"labels": [{"name": "priority/p1"}, {"name": "bug"}]},
        ]
        result = classify_pr([], linked_issues=issues)
        # Labels should be deduplicated
        assert result.linked_issue_labels.count("priority/p1") <= 1


class TestPathHandlingSignalModel:
    """#749: classification requires a real untrusted-path surface.

    Trusted path scaffolding (repository-root discovery, fixture paths,
    path-library usage with no untrusted input flow) must not classify
    path_handling_changes; genuine attacker-controlled path behavior must.
    Every firing decision is explainable from the bounded
    path_handling_provenance artifact."""

    # -- Negative: the exact PR #748 false-positive shape -------------------

    def test_repo_root_scaffolding_is_not_path_handling(self):
        # PR #748: ordinary repository-root discovery in test scaffolding
        # injected path-traversal / edge-case-path must_check items.
        diff = "\n".join([
            "+from pathlib import Path",
            "+",
            "+_ROOT = Path(__file__).resolve().parent.parent",
            "+sys.path.insert(0, str(_ROOT))",
        ])
        files = [_make_file("scripts/fork_review_gate.py"), _make_file("tests/test_gate.py")]
        result = classify_pr(files, diff_text=diff)
        assert result.pr_kind != "path_handling_changes"
        assert "path_handling_changes" not in result.risk_flags
        assert not any("path traversal" in c for c in result.must_check)
        assert not any("edge-case paths" in c for c in result.must_check)
        assert result.path_handling_provenance["fired"] is False
        assert result.path_handling_provenance["signals"] == []

    def test_node_repo_root_scaffolding_is_not_path_handling(self):
        # The JS/TS shape of the same trusted bookkeeping, including a `../`
        # literal inside a trusted-anchor join (module-relative resolution).
        diff = "\n".join([
            "+const templates = path.resolve(__dirname, \"../templates\");",
            '+export const ROOT = Path(__file__).resolve().parent.parent;',
            "+const dataFile = os.path.join(os.path.dirname(__file__), \"data.json\");",
        ])
        result = classify_pr([_make_file("src/app.ts")], diff_text=diff)
        assert result.pr_kind != "path_handling_changes"
        assert "path_handling_changes" not in result.risk_flags

    def test_anchor_join_with_static_arguments_is_not_path_handling(self):
        # Anchor + demonstrably static arguments = trusted bookkeeping, even
        # when a static directory name contains a word from the untrusted
        # vocabulary ("uploads") — quoted literals are static data.
        diff = "\n".join([
            '+const uploadsDir = path.join(__dirname, "uploads");',
            '+const up = os.path.join(__dirname, "../uploads");',
            '+const tpl = path.resolve(__dirname, `templates`, "base.html");',
        ])
        result = classify_pr([_make_file("src/app.ts")], diff_text=diff)
        assert result.pr_kind != "path_handling_changes"
        assert "path_handling_changes" not in result.risk_flags

    # -- Refusal: anchor + untrusted operand is a real surface --------------

    def test_anchor_join_with_request_arg_fires(self):
        diff = '+target = os.path.join(__dirname, request.args["path"])\n'
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"
        fired = result.path_handling_provenance["signals"]
        assert any(s["signal"] == "untrusted_source_join" for s in fired)

    def test_anchor_call_with_express_query_fires(self):
        diff = '+const p = path.resolve(__dirname, req.query.path);\n'
        result = classify_pr([_make_file("src/app.ts")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"
        assert "path_handling_changes" in result.risk_flags

    def test_anchor_call_with_user_input_fires(self):
        diff = '+dest = os.path.join(__dirname, user_supplied_name)\n'
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"

    def test_anchor_call_with_upload_operand_fires_via_direct_flow(self):
        # The one-hop upload case (line above) has a direct-operand sibling:
        # an untrusted request operand inside the anchor call fires directly.
        diff = '+const dest = path.join(__dirname, req.query.name);\n'
        result = classify_pr([_make_file("src/app.ts")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"

    def test_anchor_call_with_argv_fires(self):
        diff = '+const target = path.resolve(__dirname, process.argv[2]);\n'
        result = classify_pr([_make_file("src/app.ts")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"

    def test_pathlib_chain_joinpath_with_untrusted_arg_fires(self):
        # The pathlib anchor chain neutralizes only static joinpath arguments.
        diff = '+out = Path(__file__).resolve().parent.joinpath(user_name)\n'
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"

    def test_interpolated_literal_arg_fails_toward_detection(self):
        # An interpolation-shaped quoted argument is NOT treated as static:
        # its inner text stays visible to the untrusted-token check.
        diff = '+dest = path.join(__dirname, f"{user_path}")\n'
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"

    def test_pathlib_import_with_constant_path_is_not_path_handling(self):
        diff = "+CONFIG = Path('/etc/myapp/config.yaml')\n"
        result = classify_pr([_make_file("src/config.py")], diff_text=diff)
        assert result.pr_kind == "app_code"
        assert "path_handling_changes" not in result.risk_flags

    def test_doc_prose_about_sanitization_is_not_path_handling(self):
        diff = "+Operators must sanitize any configured paths before use.\n"
        result = classify_pr([_make_file("docs/guide.md")], diff_text=diff)
        assert result.pr_kind == "app_code"

    def test_constant_join_is_not_path_handling(self):
        diff = "+layout = os.path.join(base, 'templates')\n"
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "app_code"

    # -- Negative: test-file content discount -------------------------------

    def test_traversal_literal_in_test_file_is_discounted(self):
        # Static fixture paths under test directories are trusted bookkeeping:
        # a `../` literal only inside tests/test_*.py must not classify path
        # handling, but it must stay visible as a discounted signal.
        diff = "\n".join([
            "diff --git a/tests/test_gate.py b/tests/test_gate.py",
            "+++ b/tests/test_gate.py",
            "+HOSTILE = ('../../etc/passwd',)",
        ])
        result = classify_pr([_make_file("tests/test_gate.py")], diff_text=diff)
        assert result.pr_kind == "app_code"
        assert "path_handling_changes" not in result.risk_flags
        discounted = result.path_handling_provenance["discounted"]
        assert any(
            s["signal"] == "traversal_literal" and s["source"] == "diff_test_file"
            and "tests/test_gate.py" in s["files"]
            for s in discounted
        )

    def test_material_signal_in_production_file_still_fires_despite_tests(self):
        # The discount is per-file: test-file fixture paths never mask a real
        # untrusted surface in a production chunk of the same PR.
        diff = "\n".join([
            "diff --git a/src/upload.py b/src/upload.py",
            "+++ b/src/upload.py",
            "+dest = os.path.join(UPLOAD_DIR, request.args['name'])",
            "diff --git a/tests/test_upload.py b/tests/test_upload.py",
            "+++ b/tests/test_upload.py",
            "+FIXTURE = '../../etc/passwd'",
        ])
        result = classify_pr(
            [_make_file("src/upload.py"), _make_file("tests/test_upload.py")],
            diff_text=diff,
        )
        assert result.pr_kind == "path_handling_changes"
        fired = result.path_handling_provenance["signals"]
        assert any(
            s["signal"] == "untrusted_source_join" and "src/upload.py" in s["files"]
            for s in fired
        )

    def test_headerless_diff_is_treated_conservatively(self):
        # A diff without git headers cannot be attributed per file. When every
        # changed file is a test file the whole diff is test content
        # (discounted); any non-test changed file fires conservatively —
        # unknown attribution keeps scrutiny, never drops it.
        diff = "+HOSTILE = '../../etc/passwd'\n"
        result = classify_pr([_make_file("tests/test_x.py")], diff_text=diff)
        assert result.pr_kind == "app_code"  # tests-only diff discounts
        raw_kind = _classify_pr_kind([_make_file("src/x.py")], diff)
        assert raw_kind == "path_handling_changes"  # non-test file fires

    # -- Positive: genuine untrusted-path surfaces --------------------------

    def test_untrusted_join_fires_with_provenance(self):
        diff = "+target = os.path.join(base, request.args['path'])\n"
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"
        assert "path_handling_changes" in result.risk_flags
        assert any("path traversal" in c for c in result.must_check)
        fired = result.path_handling_provenance["signals"]
        assert any(s["signal"] == "untrusted_source_join" for s in fired)

    def test_untrusted_join_across_adjacent_line_fires(self):
        diff = "+name = request.args['path']\n+target = os.path.join(base, name)\n"
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"

    # -- One-hop def/use into trusted-anchor constructions -------------------

    def test_anchor_call_with_adjacent_one_hop_variable_fires(self):
        # The anchor call must NOT be neutralized when one of its operands is
        # assigned by an adjacent untrusted-source line: the construction
        # must survive to be detected.
        diff = "+name = request.args['path']\n+target = path.resolve(__dirname, name)\n"
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"
        fired = result.path_handling_provenance["signals"]
        assert any(s["signal"] == "untrusted_source_join" for s in fired)

    def test_anchor_join_with_adjacent_one_hop_variable_fires(self):
        diff = "+name = request.args['path']\n+target = os.path.join(os.path.dirname(__file__), name)\n"
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"
        assert "path_handling_changes" in result.risk_flags

    def test_pathlib_chain_with_adjacent_one_hop_variable_fires(self):
        diff = "+name = request.args['path']\n+out = Path(__file__).resolve().parent.joinpath(name)\n"
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"

    def test_trusted_anchor_with_non_untrusted_adjacent_identifier_stays_clean(self):
        # The adjacent assignment exists but its line carries no untrusted
        # token — no one-hop edge, the anchor call stays trusted bookkeeping.
        diff = "+title = config['title']\n+templates = path.resolve(__dirname, title)\n"
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "app_code"
        assert result.path_handling_provenance["fired"] is False

    # -- Adjacency is not flow (co-occurrence false positive) ----------------

    def test_unrelated_adjacent_request_line_does_not_fire(self):
        # `request_id` is assigned from a request one line above, but the
        # constant join never uses it — adjacency alone is not flow.
        diff = "+request_id = request.args['id']\n+target = os.path.join(base, 'static')\n"
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "app_code"
        assert "path_handling_changes" not in result.risk_flags
        assert result.path_handling_provenance["fired"] is False
        assert result.path_handling_provenance["signals"] == []

    def test_unrelated_adjacent_token_without_assignment_does_not_fire(self):
        # An untrusted token nearby with no assignment target yields no
        # one-hop edge either.
        diff = "+log.info('request received: %s', sid)\n+target = os.path.join(base, 'static')\n"
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "app_code"

    def test_same_line_quoted_untrusted_word_does_not_fire(self):
        # A static string literal containing untrusted vocabulary is data,
        # not an operand.
        diff = '+target = os.path.join(base, "request")\n'
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "app_code"

    def test_lhs_lexical_request_word_does_not_fire(self):
        # Same-line detection inspects the construction EXPRESSION, not the
        # assignment target: `request_cache_path` is the LHS being bound, not
        # an untrusted operand.
        diff = '+request_cache_path = os.path.join(BASE, "static")\n'
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "app_code"
        assert result.path_handling_provenance["fired"] is False

    def test_quoted_adjacent_label_does_not_create_flow(self):
        # `label = "request"` is a static quoted word: the adjacent one-hop
        # check reads the assignment and tests the quote-stripped RHS, so no
        # def/use edge exists.
        diff = '+label = "request"\n+target = path.resolve(__dirname, label)\n'
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "app_code"
        assert result.path_handling_provenance["fired"] is False

    def test_trailing_comment_does_not_donate_untrusted_token(self):
        # Same-line detection reads the construction's OPERANDS only: the
        # word "request" in a trailing comment is prose, not input.
        diff = '+target = os.path.join(BASE, "static")  # request cache path\n'
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "app_code"
        assert result.path_handling_provenance["fired"] is False

    def test_sibling_statement_does_not_donate_untrusted_token(self):
        # `audit(request.id)` after the join is a sibling expression —
        # outside the construction's operands — and must not make the static
        # join fire.
        diff = '+const target = path.join(BASE, "static"); audit(request.id);\n'
        result = classify_pr([_make_file("src/app.ts")], diff_text=diff)
        assert result.pr_kind == "app_code"
        assert result.path_handling_provenance["fired"] is False

    def test_bare_filename_identifier_is_not_a_source(self):
        # `.filename` ATTRIBUTE ACCESS is the unsafe-upload operand shape; a
        # bare `filename` identifier (a trusted constant propagated into a
        # path) is bookkeeping, not proof of attacker influence.
        diff = '+filename = "config.json"\n+dest = os.path.join(BASE, filename)\n'
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "app_code"
        assert result.path_handling_provenance["fired"] is False

    def test_multiline_join_direct_operand_fires(self):
        # A construction call left open across the line break accumulates its
        # continuation lines (bounded) — they ARE the operand list.
        diff = "+target = os.path.join(\n+    BASE,\n+    request.args['p'],\n+)\n"
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"
        fired = result.path_handling_provenance["signals"]
        assert any(s["signal"] == "untrusted_source_join" for s in fired)

    def test_multiline_closer_line_comment_is_clean(self):
        # Continuation lines are scanned only through the closing paren: a
        # trailing comment after the closer cannot donate a token.
        diff = "+target = os.path.join(\n+    BASE,\n+)  # request cache path\n"
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "app_code"
        assert result.path_handling_provenance["fired"] is False

    def test_multiline_sibling_statement_after_closer_is_clean(self):
        diff = '+const target = path.join(\n+  BASE,\n+); audit(request.id);\n'
        result = classify_pr([_make_file("src/app.ts")], diff_text=diff)
        assert result.pr_kind == "app_code"
        assert result.path_handling_provenance["fired"] is False

    def test_multiline_head_line_comment_is_clean(self):
        diff = "+target = os.path.join(  # request cache\n+    BASE,\n+)\n"
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "app_code"
        assert result.path_handling_provenance["fired"] is False

    def test_multiline_nested_construction_fires(self):
        # Nested parens are tracked: a nested call closing mid-list never
        # ends the scan while outer operands (a later untrusted argument)
        # remain.
        diff = ("+target = os.path.join(\n"
                "+    os.path.dirname(__file__),\n"
                "+    request.args['name'],\n"
                "+)\n")
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"
        fired = result.path_handling_provenance["signals"]
        assert any(s["signal"] == "untrusted_source_join" for s in fired)

    def test_multiline_opening_line_nested_paren_depth(self):
        # The opening line's REMAINDER contributes its paren balance to the
        # initial depth: the nested `foo(` means the `safe)` closer must not
        # terminate the scan before the later untrusted operand.
        diff = "+target = os.path.join(foo(\n+    safe), request.args['x']\n+)\n"
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"
        fired = result.path_handling_provenance["signals"]
        assert any(s["signal"] == "untrusted_source_join" for s in fired)

    # -- Adversarial-review regressions (F1-F8) ------------------------------

    def test_fstring_adjacent_quotes_still_fire(self):
        # The static-literal lexer pairs quotes correctly: the span between
        # two adjacent quotes must not swallow `, request.args[`.
        diff = "+ target = os.path.join(base, f'{x}', request.args['p'])\n"
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"
        fired = result.path_handling_provenance["signals"]
        assert any(s["signal"] == "untrusted_source_join" for s in fired)

    def test_deep_nesting_one_liner_fires(self):
        # Balanced-paren extraction has no nesting-depth limit: the OUTER
        # call's operands are scanned through any number of nested calls.
        diff = "+ x = os.path.join(os.path.dirname(os.path.realpath(os.path.join(BASE, 'safe'))), request.args['p'])\n"
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"

    def test_pathlib_division_fires(self):
        # `/` is pathlib's path-join operator: Path(__file__).parent /
        # request.args['p'] is a real untrusted-path surface. The anchor
        # chain refuses neutralization so the Path( head survives, and the
        # operand scan extends through the division.
        diff = "+ x = Path(__file__).parent / request.args['p']\n"
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"
        assert "path_handling_changes" in result.risk_flags

    def test_pathlib_division_non_anchor_fires(self):
        diff = "+ p = Path(BASE) / request.args['x']\n"
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"

    def test_pathlib_division_one_hop_fires(self):
        diff = "+name = request.args['p']\n+x = Path(__file__).parent / name\n"
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"

    def test_pathlib_trusted_division_is_clean(self):
        diff = '+ x = Path(__file__).parent / "static"\n'
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "app_code"
        assert result.path_handling_provenance["fired"] is False

    def test_req_bracket_access_fires(self):
        # Express.js bracket access: `req` is a request object in either
        # access form.
        diff = "+ const target = path.join(base, req['path']);\n"
        result = classify_pr([_make_file("src/app.ts")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"

    def test_vocabulary_near_misses_are_clean(self):
        # Word-bounded source vocabulary: benign identifier near-misses are
        # not untrusted sources.
        for operand in ("requester_id", "username", "queryset", "payloads", "params_dict", "userdata"):
            diff = f"+ x = os.path.join(base, {operand})\n"
            result = classify_pr([_make_file("src/app.py")], diff_text=diff)
            assert result.pr_kind == "app_code", operand
            assert result.path_handling_provenance["fired"] is False, operand

    def test_user_prefix_identifier_conservative_fire(self):
        # `user_id`/`user_input`-shaped operands stay sources (user-owned
        # path components are the classic traversal surface).
        diff = "+ x = os.path.join(base, user_id)\n"
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"

    def test_typed_annotation_one_hop_fires(self):
        diff = "+ name: str = request.args['p']\n+ x = os.path.join(base, name)\n"
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"

    def test_typed_const_ts_one_hop_fires(self):
        diff = "+ const n: string = request.query.x;\n+ const t = path.join(base, n);\n"
        result = classify_pr([_make_file("src/app.ts")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"

    def test_four_plus_operand_multiline_fires(self):
        # The continuation cap (8 lines) is a boundedness horizon, not a
        # precision filter: operands beyond the third line still fire.
        diff = "+ x = os.path.join(\n+     BASE,\n+     'a',\n+     'b',\n+     request.args['p'],\n+ )\n"
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"

    def test_deep_nested_multiline_fires(self):
        diff = ("+ x = os.path.join(\n"
                "+     os.path.dirname(\n"
                "+         os.path.realpath(__file__),\n"
                "+     ),\n"
                "+     request.args['p'],\n"
                "+ )\n")
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"

    def test_string_join_is_not_path_construction(self):
        # `", ".join(...)` is a string method on delimited text, not a
        # filesystem path construction.
        diff = '+csv = ", ".join(request.rows)\n'
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "app_code"

    def test_filename_attribute_access_through_one_hop_fires(self):
        diff = "+name = upload.filename\n+target = path.resolve(__dirname, name)\n"
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"

    def test_user_controlled_path_constructor_fires(self):
        diff = "+dest = pathlib.Path(user_input)\n"
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"

    def test_upload_filename_operand_fires(self):
        # `file.filename` is the untrusted operand — the reason this fires —
        # not upload vocabulary in the assignment target or directory name.
        diff = "+dest = os.path.join(base, file.filename)\n"
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"
        fired = result.path_handling_provenance["signals"]
        assert any(s["signal"] == "untrusted_source_join" for s in fired)

    def test_upload_vocabulary_without_operand_is_clean(self):
        # `upload`-named targets/directories are trusted bookkeeping: without
        # an untrusted operand the join never fires.
        diff = "+upload_path = os.path.join(UPLOAD_DIR, 'static')\n"
        result = classify_pr([_make_file("src/app.py")], diff_text=diff)
        assert result.pr_kind == "app_code"
        assert result.path_handling_provenance["fired"] is False

    def test_anchor_call_with_upload_operand_fires_via_flow(self):
        # An upload-named OPERAND fires through the one-hop def/use edge, not
        # through the lexical `upload` word.
        diff = "+const uploadName = req.query.name;\n+const dest = path.join(__dirname, uploadName);\n"
        result = classify_pr([_make_file("src/app.ts")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"

    def test_containment_check_fires(self):
        diff = "+resolved = os.path.realpath(target)\n+if not resolved.startswith(BASE):\n+    abort(400)\n"
        result = classify_pr([_make_file("src/serve.py")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"
        fired = result.path_handling_provenance["signals"]
        assert any(s["signal"] == "path_containment_or_sanitization" for s in fired)

    def test_archive_extraction_fires(self):
        diff = "+with tarfile.open(archive) as tf:\n+    tf.extractall(dest)\n"
        result = classify_pr([_make_file("src/ingest.py")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"

    def test_symlink_operation_fires(self):
        diff = "+os.symlink(target, link_path)\n"
        result = classify_pr([_make_file("src/fsutil.py")], diff_text=diff)
        assert result.pr_kind == "path_handling_changes"

    def test_filename_backed_signal_routes_and_attributes(self):
        result = classify_pr([_make_file("src/path_join.py")], diff_text="")
        assert result.pr_kind == "path_handling_changes"
        assert result.risk_flags_with_files.get("path_handling_changes") == ["src/path_join.py"]
        assert "path_handling_changes" in result.route_signals
        fired = result.path_handling_provenance["signals"]
        assert any(s["source"] == "filename" for s in fired)

    def test_filename_backed_signal_in_test_file_is_discounted(self):
        result = classify_pr([_make_file("tests/test_filepath.py")], diff_text="")
        assert result.pr_kind == "app_code"
        assert result.path_handling_provenance["fired"] is False
        assert result.path_handling_provenance["discounted"]

    # -- Provenance hygiene -------------------------------------------------

    def test_provenance_samples_are_bounded_and_control_char_free(self):
        hostile = "+x = os.path.join(base, request.args['p' * 400 + '\\x00\\x01\\x02'])\n"
        result = classify_pr([_make_file("src/app.py")], diff_text=hostile)
        for signal in result.path_handling_provenance["signals"]:
            assert len(signal["samples"]) <= 3
            for sample in signal["samples"]:
                assert len(sample) <= 160
                assert not any(ord(ch) < 0x20 and ch != " " for ch in sample)
                assert "\x7f" not in sample

    def test_provenance_signal_count_is_capped(self):
        # Many distinct signal classes could flood the artifact; the model
        # caps total buckets per list. (12 distinct constructions here map
        # onto 6 classes at most — the cap assertion guards regressions.)
        lines = [
            "+a%d = os.path.join(base, request.args['p'])" % i for i in range(40)
        ]
        result = classify_pr([_make_file("src/app.py")], diff_text="\n".join(lines) + "\n")
        assert len(result.path_handling_provenance["signals"]) <= 8

    def test_provenance_files_per_signal_capped(self):
        # MAX_PATH_FILES: one signal bucket attributes at most 8 files even
        # when more changed files carry the vocabulary.
        files = [_make_file(f"src/filepath_{i}.py") for i in range(10)]
        result = classify_pr(files)
        signals = result.path_handling_provenance["signals"]
        assert len(signals) == 1
        assert len(signals[0]["files"]) == 8


class TestRouteSignals:
    """route_signals drives smart routing and must exclude content-only matches
    (the over-escalation fix)."""

    def test_content_only_path_match_not_in_route_signals(self):
        # A genuine untrusted-path join in an ordinary file still flags the PR
        # for checks, but a content-only match must not route (#159) — routing
        # stays filename-gated under the #749 signal model.
        result = classify_pr(
            [_make_file("app.py")], diff_text="x = os.path.join(a, request.args['p'])"
        )
        assert "path_handling_changes" in result.risk_flags       # still flagged for checks
        assert result.route_signals == []                          # but not for routing

    def test_real_auth_filename_in_route_signals(self):
        result = classify_pr([_make_file("auth.py")], diff_text="")
        assert "auth_changes" in result.route_signals

    def test_filename_backed_file_serving_in_route_signals(self):
        result = classify_pr([_make_file("static/handler.py")], diff_text="")
        assert "file_serving_changes" in result.route_signals

    def test_linked_security_issue_in_route_signals(self):
        issues = [{"labels": [{"name": "security"}]}]
        result = classify_pr([_make_file("app.py")], diff_text="", linked_issues=issues)
        assert result.route_signals == ["linked_security_issue"]

    @pytest.mark.parametrize(
        ("priority", "expected_signal"),
        [(1, "linked_priority_p0"), (2, "linked_priority_p1")],
    )
    def test_linear_native_priority_in_route_signals(self, priority, expected_signal):
        issues = [{"source": "linear", "priority": priority, "labels": []}]
        result = classify_pr([_make_file("app.py")], diff_text="", linked_issues=issues)
        assert result.route_signals == [expected_signal]

    def test_app_code_default_not_in_route_signals(self):
        result = classify_pr([_make_file("app.py")], diff_text="print('hi')")
        assert result.route_signals == []
