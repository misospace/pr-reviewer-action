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
        from pr_reviewer import linked_sources
        from scripts import run_enrichment

        calls = []

        def fake_fetch(url, timeout=25):
            calls.append(url)
            return b"data"

        # render_linked_sources looks up fetch_url in its own module.
        monkeypatch.setattr(linked_sources, "fetch_url", fake_fetch)
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


class TestSkippedSourceCollapse:
    """render_linked_sources (#372): sources that yield only a skip notice are
    collapsed into ONE trailing summary line instead of a full ## Source N
    block. Fetched / enriched sources keep their numbering and full sections."""

    def _render(self, monkeypatch, urls, allowed_hosts, fetch_map=None):
        from pr_reviewer import linked_sources

        fetch_map = fetch_map or {}

        def fake_fetch(url, timeout=25):
            return fetch_map.get(url)

        monkeypatch.setattr(linked_sources, "fetch_url", fake_fetch)
        monkeypatch.setattr(linked_sources, "gh_api_call", lambda *a, **k: None)
        budget = linked_sources.BudgetTracker(max_seconds=60)
        return linked_sources.render_linked_sources(
            urls, set(allowed_hosts), None, "", [], None, budget
        )

    def test_multiple_skipped_hosts_collapse_to_one_sorted_line(self, monkeypatch):
        md = self._render(
            monkeypatch,
            ["https://evil.com/a", "https://bad.net/b", "https://evil.com/c"],
            allowed_hosts=[],  # nothing allowlisted → all three are skips
        )
        # No per-source boilerplate for any of them.
        assert "## Source" not in md
        assert "(Skipped non-allowlisted URL" not in md
        # One summary line, count = number of skipped sources, hosts deduped+sorted.
        assert (
            "(3 sources skipped — non-allowlisted or non-fetchable hosts: "
            "bad.net, evil.com)"
        ) in md

    def test_mixed_skipped_and_fetched_ordering(self, monkeypatch):
        md = self._render(
            monkeypatch,
            ["https://example.com/page", "https://evil.com/x"],
            allowed_hosts=["example.com"],
            fetch_map={"https://example.com/page": b"<html>hello world</html>"},
        )
        # The allowlisted fetched source keeps its full section and its index.
        assert "## Source 1" in md
        assert "URL: https://example.com/page" in md
        # The skipped source's "## Source 2" block is gone, folded into summary.
        assert "## Source 2" not in md
        assert (
            "(1 source skipped — non-allowlisted or non-fetchable hosts: evil.com)"
            in md
        )

    def test_no_skipped_sources_leaves_summary_absent(self, monkeypatch):
        md = self._render(
            monkeypatch,
            ["https://example.com/page"],
            allowed_hosts=["example.com"],
            fetch_map={"https://example.com/page": b"<html>hi</html>"},
        )
        assert "## Source 1" in md
        assert "skipped —" not in md


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


class TestBudgetTracker:
    """BudgetTracker.ok(): time-boxes enrichment, warns once when exhausted."""

    def test_ok_true_before_expiry(self):
        from pr_reviewer.budget import BudgetTracker
        assert BudgetTracker(max_seconds=60).ok() is True

    def test_ok_false_after_expiry(self):
        from pr_reviewer.budget import BudgetTracker
        assert BudgetTracker(max_seconds=0).ok() is False

    def test_warning_logged_at_most_once(self, capsys):
        from pr_reviewer.budget import BudgetTracker
        bt = BudgetTracker(max_seconds=0)
        bt.ok()
        bt.ok()
        err = capsys.readouterr().err
        assert err.count("enrichment budget exceeded") == 1


class TestGhApiCall:
    """gh_api_call: parse JSON on success, fail soft (None) otherwise."""

    def test_parses_json_on_success(self, monkeypatch):
        from pr_reviewer import http_client

        class _R:
            returncode = 0
            stdout = '{"tag_name": "v1.2.3"}'

        monkeypatch.setattr(http_client.subprocess, "run", lambda *a, **k: _R())
        assert http_client.gh_api_call("repos/o/r/releases") == {"tag_name": "v1.2.3"}

    def test_returns_none_on_nonzero_exit(self, monkeypatch):
        from pr_reviewer import http_client

        class _R:
            returncode = 1
            stdout = "gh: not found"

        monkeypatch.setattr(http_client.subprocess, "run", lambda *a, **k: _R())
        assert http_client.gh_api_call("repos/o/r") is None

    def test_returns_none_on_invalid_json(self, monkeypatch):
        from pr_reviewer import http_client

        class _R:
            returncode = 0
            stdout = "not json"

        monkeypatch.setattr(http_client.subprocess, "run", lambda *a, **k: _R())
        assert http_client.gh_api_call("repos/o/r") is None

    def test_returns_none_on_exception(self, monkeypatch):
        from pr_reviewer import http_client

        def _boom(*a, **k):
            raise OSError("gh missing")

        monkeypatch.setattr(http_client.subprocess, "run", _boom)
        assert http_client.gh_api_call("repos/o/r") is None


class TestReleasesCache:
    """render_linked_sources fetches a repo's releases list at most once."""

    def test_single_releases_fetch_per_repo(self, monkeypatch):
        from pr_reviewer import linked_sources

        endpoints = []

        def fake_gh_api(endpoint, token=None):
            endpoints.append(endpoint)
            if endpoint.endswith("/releases/tags/v1.2.3"):
                return {"tag_name": "v1.2.3"}
            if "releases?per_page=30" in endpoint:
                return [{"tag_name": "v1.2.3"}]
            return None

        # The github.com URL is never HTML-fetched, but stub fetch_url anyway.
        monkeypatch.setattr(linked_sources, "gh_api_call", fake_gh_api)
        monkeypatch.setattr(linked_sources, "fetch_url", lambda url, timeout=25: None)

        budget = linked_sources.BudgetTracker(max_seconds=60)
        linked_sources.render_linked_sources(
            ["https://github.com/owner/repo/releases/tag/v1.2.3"],
            {"github.com"},
            None,
            "",
            [],
            None,
            budget,
        )

        # Phase 2 ("Recent Releases") and Phase 3 (repo-candidate enrichment)
        # share one cached fetch of the releases list.
        releases_calls = [e for e in endpoints if "releases?per_page=30" in e]
        assert len(releases_calls) == 1


class TestLinkedSourcesFanout:
    """Phase 2-4 gh_api_call fan-out (#371): concurrent fetch, ordered render."""

    URLS = [
        "https://github.com/o1/r1/releases/tag/v1.0",
        "https://github.com/o2/r2/releases/tag/v2.0",
    ]

    @staticmethod
    def _data_for(endpoint: str):
        """Pure function of endpoint so results are stable across timings."""
        if endpoint.endswith("/releases/tags/v1.0"):
            return {"tag_name": "v1.0", "name": "R1"}
        if endpoint.endswith("/releases/tags/v2.0"):
            return {"tag_name": "v2.0", "name": "R2"}
        if "o1/r1/releases?per_page=30" in endpoint:
            return [{"tag_name": "v1.0", "name": "R1"}]
        if "o2/r2/releases?per_page=30" in endpoint:
            return [{"tag_name": "v2.0", "name": "R2"}]
        return None

    def _render(self, monkeypatch, gh_stub):
        from pr_reviewer import linked_sources

        monkeypatch.setattr(linked_sources, "gh_api_call", gh_stub)
        monkeypatch.setattr(linked_sources, "fetch_url", lambda url, timeout=25: None)
        budget = linked_sources.BudgetTracker(max_seconds=60)
        return linked_sources.render_linked_sources(
            self.URLS, {"github.com"}, None, "", [], None, budget,
        )

    def test_output_identical_when_calls_complete_out_of_order(self, monkeypatch):
        """Determinism: parallelism changes only WHEN a call runs, not output."""
        import time

        def instant(endpoint, token=None):
            return self._data_for(endpoint)

        def out_of_order(endpoint, token=None):
            # Make the first source's calls finish LAST so completion order is
            # the reverse of source order; the render must be unaffected.
            if "o1/r1" in endpoint:
                time.sleep(0.05)
            return self._data_for(endpoint)

        instant_md = self._render(monkeypatch, instant)
        shuffled_md = self._render(monkeypatch, out_of_order)

        assert shuffled_md == instant_md
        # Sections stay in source order regardless of fetch completion order.
        assert shuffled_md.index("## Source 1") < shuffled_md.index("## Source 2")
        assert "R1" in shuffled_md and "R2" in shuffled_md

    def test_fan_out_dedups_endpoints(self, monkeypatch):
        """Each unique endpoint is fetched once even across prewarm + render."""
        calls = []

        def counting(endpoint, token=None):
            calls.append(endpoint)
            return self._data_for(endpoint)

        self._render(monkeypatch, counting)

        # Two repos × {release-tag lookup, releases list} = 4 unique calls, each once.
        assert sorted(calls) == sorted(set(calls))
        assert len(calls) == 4

    def test_budget_drop_stops_remaining_sources(self, monkeypatch):
        """Once the budget is exhausted the render drops remaining sources,
        and the budget is only ever consulted on the main thread."""
        from pr_reviewer import linked_sources

        class FakeBudget:
            def __init__(self, allowed):
                self.allowed = allowed
                self.calls = 0

            def ok(self):
                self.calls += 1
                return self.calls <= self.allowed

        # Non-allowlisted, non-github URLs: no fetch, no fan-out, exactly one
        # budget.ok() per source at the loop top — so the drop point is precise.
        urls = [f"https://skip{i}.example.com/x" for i in range(4)]
        monkeypatch.setattr(linked_sources, "fetch_url", lambda url, timeout=25: None)

        budget = FakeBudget(allowed=2)
        md = linked_sources.render_linked_sources(
            urls, set(), None, "", [], None, budget,
        )

        # Skip-only sections are collapsed into the trailing summary (#372), so
        # the budget drop shows up as which HOSTS made it into that line: the
        # two rendered before exhaustion, and none after.
        assert "skip0.example.com" in md
        assert "skip1.example.com" in md
        assert "skip2.example.com" not in md
        assert "skip3.example.com" not in md
        assert "(2 sources skipped" in md
