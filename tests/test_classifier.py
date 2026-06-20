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
        "router.py",
    ])
    def test_route_file_patterns(self, fname):
        files = [_make_file(fname)]
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
    @pytest.mark.parametrize("pattern", [
        "pathlib",
        "sanitize_path",
        "..\\..\\etc/passwd",
        "path_join",
    ])
    def test_path_handling_in_diff(self, pattern):
        files = [_make_file("utils.py")]
        kind = _classify_pr_kind(files, pattern)
        assert kind == "path_handling_changes"


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
                body_path="",
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
                body_path="",
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
