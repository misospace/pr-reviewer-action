"""Tests for pr_reviewer/enrichment.py pure extraction functions."""

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest
from pr_reviewer.enrichment import (
    classify_url,
    extract_compare_shas,
    extract_ghcr_images,
    extract_urls,
    extract_version_hints,
    host_allowed,
    normalize_url,
    parse_allowed_hosts,
    select_target_version,
)

# Ensure scripts/ is on sys.path for run_enrichment import.
_repo_root = Path(__file__).resolve().parent.parent
_scripts_dir = _repo_root / "scripts"
for _p in (_repo_root, _scripts_dir):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))


class TestExtractUrls:
    """extract_urls: URLs from body+diff, strip trailing [\".,;], sort unique, limit."""

    def test_empty_inputs(self):
        assert extract_urls("", "") == []

    def test_extracts_http_url_from_body(self):
        urls = extract_urls("See https://example.com/releases", "")
        assert "https://example.com/releases" in urls

    def test_extracts_https_url_from_diff(self):
        urls = extract_urls("", "+url: https://ghcr.io/my/img")
        assert "https://ghcr.io/my/img" in urls

    def test_strips_trailing_punctuation(self):
        body = "Check https://example.com/releases,\" and https://other.org; end."
        urls = extract_urls(body, "")
        assert "https://example.com/releases" in urls
        assert "https://other.org" in urls
        # Should not have trailing punctuation
        for u in urls:
            assert not any(u.endswith(p) for p in '",.;')

    def test_sorts_unique(self):
        body = "https://b.com https://a.com https://b.com"
        urls = extract_urls(body, "")
        assert urls == ["https://a.com", "https://b.com"]

    def test_limits_to_25_by_default(self):
        urls = " ".join(f"https://host{i}.com" for i in range(30))
        result = extract_urls(urls, "")
        assert len(result) == 25

    def test_custom_limit(self):
        urls = " ".join(f"https://host{i}.com" for i in range(10))
        result = extract_urls(urls, "", limit=5)
        assert len(result) == 5

    def test_excludes_urls_in_parens_boundary(self):
        """URLs extracted with space/exclusion boundary (no trailing paren)."""
        urls = extract_urls("link https://example.com/path) done", "")
        assert "https://example.com/path" in urls


class TestNormalizeUrl:
    def test_redirect_github_to_github(self):
        assert normalize_url("https://redirect.github.com/owner/repo") == "https://github.com/owner/repo"

    def test_http_redirect_github(self):
        assert normalize_url("http://redirect.github.com/a/b") == "http://github.com/a/b"

    def test_non_redirect_unchanged(self):
        assert normalize_url("https://github.com/owner/repo") == "https://github.com/owner/repo"

    def test_other_host_unchanged(self):
        assert normalize_url("https://forgejo.example.com/org/proj/releases/tag/v1") == "https://forgejo.example.com/org/proj/releases/tag/v1"

    def test_redirect_github_in_path_unchanged(self):
        url = "https://evil.example/redirect.github.com/owner/repo"
        assert normalize_url(url) == url


class TestParseAllowedHosts:
    def test_comma_separated(self):
        hosts = parse_allowed_hosts("github.com,forgejo.example.com")
        assert "github.com" in hosts
        assert "forgejo.example.com" in hosts

    def test_whitespace_trimmed(self):
        hosts = parse_allowed_hosts(" github.com , forgejo.example.com ")
        assert "github.com" in hosts
        assert "forgejo.example.com" in hosts

    def test_empty_string(self):
        assert parse_allowed_hosts("") == set()

    def test_single_host(self):
        assert parse_allowed_hosts("myhost.io") == {"myhost.io"}


class TestHostAllowed:
    def test_matching_host(self):
        assert host_allowed("https://github.com/owner/repo", {"github.com"}) is True

    def test_non_matching_host(self):
        assert host_allowed("https://evil.com/x", {"github.com"}) is False

    def test_case_insensitive(self):
        assert host_allowed("https://GitHub.com/x", {"github.com"}) is True

    def test_subdomain_not_matched(self):
        assert host_allowed("https://api.github.com/x", {"github.com"}) is False


class TestExtractVersionHints:
    """extract_version_hints: changed lines with image/tag/version/chart/appVersion/digest."""

    SAMPLE_DIFF = """\
--- a/values.yaml
+++ b/values.yaml
@@ -1,5 +1,5 @@
 some context
-image: ghcr.io/owner/img:1.2.3
+image: ghcr.io/owner/img:1.2.4
-tag: app-1.2.4
-chart: mychart-2.0.0
-appVersion: "3.0.0"
-digest: sha256:abcdef1234
-unrelated line
"""

    def test_empty_diff(self):
        assert extract_version_hints("") == []

    def test_extracts_changed_lines(self):
        hints = extract_version_hints(self.SAMPLE_DIFF)
        assert any("image:" in h for h in hints)
        assert any("tag:" in h for h in hints)
        assert any("chart:" in h for h in hints)
        assert any("appVersion:" in h for h in hints)
        assert any("digest:" in h for h in hints)

    def test_only_changed_lines_not_context(self):
        hints = extract_version_hints(self.SAMPLE_DIFF)
        for h in hints:
            assert h.startswith("+") or h.startswith("-"), f"Expected changed line, got: {h!r}"

    def test_limits_to_180_by_default(self):
        lines = "\n".join(f"+image: img{i}:1.0.{i}" for i in range(200))
        hints = extract_version_hints(lines)
        assert len(hints) == 180

    def test_custom_limit(self):
        lines = "\n".join(f"+tag: v{i}" for i in range(10))
        hints = extract_version_hints(lines, limit=5)
        assert len(hints) == 5


class TestSelectTargetVersion:
    """select_target_version: title last version token; fallback hints; empty if none."""

    def test_title_with_version(self):
        assert select_target_version("Upgrade to v2.1.0", []) == "2.1.0"

    def test_title_without_v_prefix(self):
        assert select_target_version("Bump chart 3.2.1", []) == "3.2.1"

    def test_title_last_version_wins(self):
        """When title has multiple version-like strings, last one wins."""
        assert select_target_version("Migrate from 1.0.0 to 2.0.0", []) == "2.0.0"

    def test_no_version_in_title_fallback_to_hints(self):
        hints = ["+tag: app-1.2.3", "+image: img:v2.0.0"]
        result = select_target_version("chore(container): update llama.cpp group", hints)
        assert result == "2.0.0"

    def test_no_version_anywhere_returns_empty(self):
        result = select_target_version("chore(container): update llama.cpp group", [])
        assert result == ""

    def test_renovate_digest_only_no_title_version(self):
        """home-ops #7892: digest-only bump, no version in title, must return empty not crash."""
        hints = [
            "-digest: sha256:aaaa1111",
            "+digest: sha256:bbbb2222",
        ]
        result = select_target_version("chore: update image digests", hints)
        assert result == ""

    def test_no_exception_on_any_input(self):
        """Must never raise, regardless of input."""
        select_target_version("", [])
        select_target_version(None, [])  # type: ignore[arg-type]
        select_target_version("no versions here!", ["no match"])


class TestExtractGhcrImages:
    """extract_ghcr_images: scan version hints + diff for ghcr.io repos, strip tag/digest."""

    def test_empty_inputs(self):
        assert extract_ghcr_images([], "") == []

    def test_from_version_hints(self):
        hints = [
            "+image: ghcr.io/owner/img:1.2.3",
            "-image: ghcr.io/owner/img:1.2.2",
        ]
        result = extract_ghcr_images(hints, "")
        assert "owner/img" in result

    def test_from_diff_context(self):
        hints = []
        diff = "  url: https://ghcr.io/org/charts/mychart-1.0.0.tgz"
        result = extract_ghcr_images(hints, diff)
        # Shell behavior: [^:"@ )]+ captures - and . so we get the full path segment
        assert "org/charts/mychart-1.0.0.tgz" in result

    def test_multi_segment_chart_path(self):
        hints = ["+chart: ghcr.io/a/b/c:1.0"]
        result = extract_ghcr_images(hints, "")
        assert "a/b/c" in result

    def test_strips_tag_and_digest(self):
        hints = [
            "+image: ghcr.io/owner/img:v1.2.3",
            "+image: ghcr.io/owner/img2@sha256:abc",
        ]
        result = extract_ghcr_images(hints, "")
        for r in result:
            assert ":" not in r and "@" not in r

    def test_unique_sorted(self):
        hints = [
            "+image: ghcr.io/b/img:1",
            "+image: ghcr.io/a/img:1",
            "-image: ghcr.io/b/img:0",
        ]
        result = extract_ghcr_images(hints, "")
        assert result == sorted(result)
        assert len(result) == len(set(result))

    def test_oci_prefix(self):
        diff = "oci://ghcr.io/owner/img:latest"
        result = extract_ghcr_images([], diff)
        assert "owner/img" in result


class TestExtractCompareShas:
    """extract_compare_shas: exactly one old + one new hex SHA, different; else None."""

    def test_no_sha_returns_none(self):
        hints = ["-image: img:0.8.19", "+image: img:0.8.21"]
        assert extract_compare_shas(hints) is None

    def test_one_sided_sha_returns_none(self):
        hints = ["-tag: app-1.2.3-abc1234", "+tag: app-1.2.4"]
        assert extract_compare_shas(hints) is None

    def test_ambiguous_multiple_old_returns_none(self):
        hints = [
            "-tag: a-abc1234",
            "-tag: b-def5678",
            "+tag: c-aaa1111",
        ]
        assert extract_compare_shas(hints) is None

    def test_ambiguous_multiple_new_returns_none(self):
        hints = [
            "-tag: a-abc1234",
            "+tag: b-def5678",
            "+tag: c-aaa1111",
        ]
        assert extract_compare_shas(hints) is None

    def test_same_sha_returns_none(self):
        hints = ["-tag: a-abc1234", "+tag: b-abc1234"]
        assert extract_compare_shas(hints) is None

    def test_valid_pair(self):
        hints = ["-tag: llmkube-1.2.3-abc1234", "+tag: llmkube-1.2.4-def89ab"]
        result = extract_compare_shas(hints)
        assert result is not None
        assert result == ("abc1234", "def89ab")

    def test_hex_only_not_all_digits(self):
        """Pure numeric strings like '0.8.19' should NOT be treated as SHAs."""
        hints = ["-chart: llmkube-0.8.19", "+chart: llmkube-0.8.21"]
        assert extract_compare_shas(hints) is None

    def test_long_sha(self):
        hints = [
            "-tag: img-abcdef1234567890abcdef1234567890",
            "+tag: img-1234567890abcdef1234567890abcdef",
        ]
        result = extract_compare_shas(hints)
        assert result is not None
        assert len(result[0]) == 32


class TestClassifyUrl:
    """URL classification for GitHub release, compare, Forgejo release/compare."""

    def test_github_release_url(self):
        result = classify_url("https://github.com/owner/repo/releases/tag/v1.2.3")
        assert result is not None
        assert result["type"] == "github_release"
        assert result["owner"] == "owner"
        assert result["repo"] == "repo"
        assert result["tag"] == "v1.2.3"

    def test_github_compare_url(self):
        result = classify_url("https://github.com/owner/repo/compare/v1...v2")
        assert result is not None
        assert result["type"] == "github_compare"
        assert result["compare_spec"] == "v1...v2"

    def test_github_compare_with_query(self):
        result = classify_url("https://github.com/owner/repo/compare/v1...v2?expand=1")
        assert result is not None
        assert result["type"] == "github_compare"
        assert result["compare_spec"] == "v1...v2"

    def test_github_compare_with_fragment(self):
        result = classify_url("https://github.com/owner/repo/compare/v1...v2#section")
        assert result is not None
        assert result["compare_spec"] == "v1...v2"

    def test_github_compare_with_query_and_fragment(self):
        result = classify_url("https://github.com/owner/repo/compare/v1...v2?expand=1#section")
        assert result is not None
        assert result["compare_spec"] == "v1...v2"

    def test_forgejo_release_url(self):
        result = classify_url("https://forgejo.host/org/proj/releases/tag/v1.0")
        assert result is not None
        assert result["type"] == "forgejo_release"
        assert result["host"] == "forgejo.host"
        assert result["owner"] == "org"
        assert result["repo"] == "proj"
        assert result["tag"] == "v1.0"

    def test_forgejo_compare_url(self):
        result = classify_url("https://forgejo.host/org/proj/compare/feat...main")
        assert result is not None
        assert result["type"] == "forgejo_compare"
        assert result["compare_spec"] == "feat...main"

    def test_forgejo_compare_with_query(self):
        result = classify_url("https://git.example.com/owner/repo/compare/v1...v2?expand=1")
        assert result is not None
        assert result["type"] == "forgejo_compare"
        assert result["compare_spec"] == "v1...v2"

    def test_non_classified_url(self):
        result = classify_url("https://example.com/random/page")
        assert result is None

    def test_github_release_with_query(self):
        """Release URLs with query strings should still match."""
        result = classify_url("https://github.com/owner/repo/releases/tag/v1.0?foo=bar")
        assert result is not None
        assert result["type"] == "github_release"
        assert result["tag"] == "v1.0"


class TestRunEnrichmentMain:
    """Script-level tests for run_enrichment.main() using tmp_path/monkeypatch."""

    @pytest.fixture(autouse=True)
    def _chdir(self, tmp_path, monkeypatch):
        """Change CWD to tmp_path for each test."""
        monkeypatch.chdir(tmp_path)
        monkeypatch.delenv("GH_TOKEN", raising=False)
        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        monkeypatch.delenv("ALLOWED_SOURCE_HOSTS", raising=False)
        monkeypatch.delenv("ENRICHMENT_BUDGET_SEC", raising=False)

    def test_malformed_pr_json_still_writes_artifacts(self, tmp_path):
        """Malformed pr.json should not lose extraction artifacts."""
        (tmp_path / "pr.json").write_text("{invalid json!!!")
        (tmp_path / "pr-body.txt").write_text("See https://example.com/releases")
        (tmp_path / "pr.diff.truncated").write_text("+image: ghcr.io/a/b:1.2.3\n")

        with patch("scripts.run_enrichment.render_linked_sources", return_value=""):
            from scripts import run_enrichment
            run_enrichment.main()

        # All output files should exist
        assert (tmp_path / "urls.all.txt").exists()
        assert (tmp_path / "urls.txt").exists()
        assert (tmp_path / "version-hints.txt").exists()
        assert (tmp_path / "version-hints.truncated.txt").exists()
        assert (tmp_path / "ghcr-images.txt").exists()
        assert (tmp_path / "compare-shas.txt").exists()
        assert (tmp_path / "linked-sources.md").exists()

        # URLs should still be extracted
        urls = (tmp_path / "urls.all.txt").read_text().strip()
        assert "https://example.com/releases" in urls

    def test_output_files_exist_minimal(self, tmp_path):
        """All output files exist even with empty inputs."""
        (tmp_path / "pr.json").write_text("{}")
        (tmp_path / "pr-body.txt").write_text("")
        (tmp_path / "pr.diff.truncated").write_text("")

        with patch("scripts.run_enrichment.render_linked_sources", return_value=""):
            from scripts import run_enrichment
            run_enrichment.main()

        assert (tmp_path / "urls.all.txt").exists()
        assert (tmp_path / "urls.txt").exists()
        assert (tmp_path / "version-hints.txt").exists()
        assert (tmp_path / "version-hints.truncated.txt").exists()
        assert (tmp_path / "linked-sources.md").exists()

    def test_linked_sources_md_written(self, tmp_path):
        """linked-sources.md is written with render output."""
        (tmp_path / "pr.json").write_text("{}")
        (tmp_path / "pr-body.txt").write_text("")
        (tmp_path / "pr.diff.truncated").write_text("")

        rendered_md = "## Source 1\nURL: https://example.com"
        with patch("scripts.run_enrichment.render_linked_sources", return_value=rendered_md):
            from scripts import run_enrichment
            run_enrichment.main()

        assert (tmp_path / "linked-sources.md").read_text() == rendered_md

    def test_urls_all_unbounded(self, tmp_path):
        """urls.all.txt is unbounded while urls.txt is capped at 25."""
        urls = " ".join(f"https://host{i}.com" for i in range(30))
        (tmp_path / "pr.json").write_text("{}")
        (tmp_path / "pr-body.txt").write_text(urls)
        (tmp_path / "pr.diff.truncated").write_text("")

        with patch("scripts.run_enrichment.render_linked_sources", return_value=""):
            from scripts import run_enrichment
            run_enrichment.main()

        all_urls = (tmp_path / "urls.all.txt").read_text().strip().splitlines()
        capped_urls = (tmp_path / "urls.txt").read_text().strip().splitlines()
        assert len(all_urls) == 30, "urls.all.txt should be unbounded"
        assert len(capped_urls) == 25, "urls.txt should be capped at 25"

    def test_version_hints_unbounded(self, tmp_path):
        """version-hints.txt is unbounded while version-hints.truncated.txt is capped."""
        hints = "\n".join(f"+image: img{i}:1.0.{i}" for i in range(200))
        (tmp_path / "pr.json").write_text("{}")
        (tmp_path / "pr-body.txt").write_text("")
        (tmp_path / "pr.diff.truncated").write_text(hints)

        with patch("scripts.run_enrichment.render_linked_sources", return_value=""):
            from scripts import run_enrichment
            run_enrichment.main()

        full_hints = (tmp_path / "version-hints.txt").read_text().strip().splitlines()
        trunc_hints = (tmp_path / "version-hints.truncated.txt").read_text().strip().splitlines()
        assert len(full_hints) == 200, "version-hints.txt should be unbounded"
        assert len(trunc_hints) == 180, "version-hints.truncated.txt should be capped at 180"

    def test_budget_default_is_60(self):
        """ENRICHMENT_BUDGET_SEC default should be 60."""
        from scripts.run_enrichment import BudgetTracker
        bt = BudgetTracker()
        assert bt.max_seconds == 60

    def test_budget_blocks_phase_one_fetch_submission(self, monkeypatch):
        """Expired budget should not submit URL fetch tasks."""
        from scripts import run_enrichment

        calls = []

        def fake_fetch(url, timeout=25):
            calls.append(url)
            return b"data"

        monkeypatch.setattr(run_enrichment, "fetch_url", fake_fetch)
        budget = run_enrichment.BudgetTracker(max_seconds=0)

        md = run_enrichment.render_linked_sources(
            ["https://example.com/a", "https://example.com/b"],
            {"example.com"},
            None,
            "",
            [],
            None,
            budget,
        )

        assert calls == []
        assert md == ""


class TestSelectTargetVersionLastWins:
    """Regression: select_target_version fallback matches tail -n1 semantics."""

    def test_last_semver_in_hints_wins(self):
        """When hints have multiple semvers, last one wins (tail -n1)."""
        hints = [
            "+image: img:1.0.0",
            "+tag: app-2.0.0",
            "+chart: mychart-3.0.0",
        ]
        result = select_target_version("no version here", hints)
        assert result == "3.0.0"

    def test_single_hint_semver(self):
        result = select_target_version("no version", ["+tag: app-1.2.3"])
        assert result == "1.2.3"

    def test_no_title_version_uses_last_hint(self):
        """Title has no version; hints have multiple — last hint semver wins."""
        result = select_target_version("chore: update deps", [
            "+image: old:0.1.0",
            "+image: new:2.5.3",
        ])
        assert result == "2.5.3"
