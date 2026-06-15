"""Tests for pr_reviewer.evidence_memory — cross-run evidence memory (#265)."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pr_reviewer.evidence_memory import (
    MAX_DIGEST_CHARS,
    MAX_LEDGER_ENTRIES,
    build_evidence_digest,
    load_evidence_memory,
    render_evidence_memory_section,
)


class TestBuildEvidenceDigest:
    def test_prefers_final_text_when_present(self):
        entries = [{"tool": "read_file", "args": {"path": "a"}, "content": "x" * 50}]
        digest = build_evidence_digest(entries, "Talos v1.13.4 supports k8s 1.32-1.36.")
        assert digest == "Talos v1.13.4 supports k8s 1.32-1.36."

    def test_falls_back_to_ledger_without_final_text(self):
        entries = [
            {"tool": "read_file", "args": {"path": "talos/machineconfig.yaml.j2"},
             "content": "install: factory.talos.dev/installer:v1.13.4"},
            {"tool": "web_fetch", "args": {"url": "https://docs.siderolabs.com/matrix"},
             "content": "Kubernetes 1.32 to 1.36 supported on Talos 1.13"},
        ]
        digest = build_evidence_digest(entries, "")
        assert "read_file path=talos/machineconfig.yaml.j2" in digest
        assert "installer:v1.13.4" in digest
        assert "web_fetch url=https://docs.siderolabs.com/matrix" in digest
        assert "1.32 to 1.36 supported" in digest

    def test_empty_when_no_text_and_no_entries(self):
        assert build_evidence_digest([], "") == ""

    def test_ledger_entry_cap(self):
        entries = [
            {"tool": "read_file", "args": {"path": f"f{i}"}, "content": f"c{i}"}
            for i in range(MAX_LEDGER_ENTRIES + 5)
        ]
        digest = build_evidence_digest(entries, "")
        # Exactly MAX_LEDGER_ENTRIES ledger lines are emitted (the rest dropped).
        assert len([ln for ln in digest.splitlines() if ln.startswith("- ")]) == MAX_LEDGER_ENTRIES

    def test_strips_control_and_angle_chars_from_final_text(self):
        digest = build_evidence_digest([], "ok\x00 <script>alert</script> done")
        assert "\x00" not in digest
        assert "<" not in digest and ">" not in digest

    def test_caps_total_chars(self):
        digest = build_evidence_digest([], "z" * (MAX_DIGEST_CHARS + 500))
        assert len(digest) == MAX_DIGEST_CHARS

    def test_skips_malformed_entries(self):
        entries = ["notadict", {"args": {}}, {"tool": ""}, {"tool": "git_grep", "args": {"pattern": "tok"}, "content": "hit"}]
        digest = build_evidence_digest(entries, "")
        assert digest == "- git_grep pattern=tok → hit"


class TestLoadEvidenceMemory:
    def _write(self, tmp_path, obj):
        p = tmp_path / "previous-evidence.json"
        p.write_text(json.dumps(obj), encoding="utf-8")
        return str(p)

    def test_valid_round_trip(self, tmp_path):
        path = self._write(tmp_path, {"digest": "- read_file → v1.13.4", "head_sha": "abc123def456"})
        mem = load_evidence_memory(path)
        assert mem["digest"] == "- read_file → v1.13.4"
        assert mem["head_sha"] == "abc123def456"

    def test_missing_file_returns_none(self, tmp_path):
        assert load_evidence_memory(str(tmp_path / "nope.json")) is None

    def test_non_dict_returns_none(self, tmp_path):
        assert load_evidence_memory(self._write(tmp_path, ["a", "b"])) is None

    def test_blank_digest_returns_none(self, tmp_path):
        assert load_evidence_memory(self._write(tmp_path, {"digest": "   "})) is None

    def test_sanitizes_head_sha_to_hex(self, tmp_path):
        path = self._write(tmp_path, {"digest": "x", "head_sha": "ab; rm -rf /  zz"})
        mem = load_evidence_memory(path)
        # Only hex chars survive: a,b from "ab" and the f from "-rf"; the rest
        # (;, r, m, spaces, /, z) are dropped.
        assert mem["head_sha"] == "abf"

    def test_strips_control_and_angle_chars_on_read(self, tmp_path):
        path = self._write(tmp_path, {"digest": "fact\x07 <b>v1</b>", "head_sha": ""})
        mem = load_evidence_memory(path)
        assert "\x07" not in mem["digest"]
        assert "<" not in mem["digest"] and ">" not in mem["digest"]

    def test_strips_null_bytes_on_read(self, tmp_path):
        # Defense-in-depth: even if a null byte survives the precheck's shell
        # sanitizer, load re-strips it (_CONTROL_CHARS_RE covers \x00) before the
        # digest reaches the corpus.
        path = self._write(tmp_path, {"digest": "v1.13.4\x00 supported", "head_sha": "abc"})
        mem = load_evidence_memory(path)
        assert "\x00" not in mem["digest"]
        assert "v1.13.4 supported" in mem["digest"]

    def test_symlinked_path_is_read_not_traversed(self, tmp_path):
        # The path is hardcoded ('previous-evidence.json'), so there is no
        # user-controlled-path traversal vector. A symlinked file still loads
        # correctly (read-only follow), and its content is sanitized all the same.
        real = tmp_path / "real-evidence.json"
        real.write_text(json.dumps({"digest": "linked <x>fact", "head_sha": "ff"}), encoding="utf-8")
        link = tmp_path / "previous-evidence.json"
        link.symlink_to(real)
        mem = load_evidence_memory(str(link))
        assert mem["digest"] == "linked xfact"
        assert mem["head_sha"] == "ff"


class TestRenderEvidenceMemorySection:
    def test_none_renders_empty(self):
        assert render_evidence_memory_section(None) == ""
        assert render_evidence_memory_section({"digest": ""}) == ""

    def test_includes_digest_sha_and_failsafe_framing(self):
        out = render_evidence_memory_section(
            {"digest": "- read_file → v1.13.4", "head_sha": "abcdef0123456789"}
        )
        assert "Evidence Gathered by the Previous Review" in out
        assert "abcdef012345" in out  # head_sha[:12]
        assert "- read_file → v1.13.4" in out
        # Fail-safe framing: must re-verify the delta, untrusted data.
        assert "re-verify" in out.lower()
        assert "untrusted data" in out.lower()

    def test_no_sha_omits_gathered_at(self):
        out = render_evidence_memory_section({"digest": "fact", "head_sha": ""})
        assert "gathered at" not in out
