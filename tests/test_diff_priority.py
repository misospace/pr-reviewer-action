"""Tests for pr_reviewer.diff_priority: class-aware, size-fair diff truncation."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from pr_reviewer.diff_priority import (  # noqa: E402
    DEFAULT_MARKER,
    MIN_CHUNK_BYTES,
    RANK_BULK,
    RANK_GENERATED,
    RANK_SOURCE,
    chunk_paths,
    prioritize_diff,
    rank_path,
    split_chunks,
    truncate_plain,
)

MARKER = DEFAULT_MARKER.decode("utf-8")


def chunk(path: str, lines: int, width: int = 40, dels: int = 0) -> bytes:
    body = [f"diff --git a/{path} b/{path}", "index 1111111..2222222 100644", f"--- a/{path}", f"+++ b/{path}", f"@@ -1,{dels} +1,{lines} @@"]
    body += [f"-{'x' * width}" for _ in range(dels)]
    body += [f"+{i:04d} {'y' * width}" for i in range(lines)]
    return ("\n".join(body) + "\n").encode("utf-8")


def emitted_paths(out: bytes) -> list[str]:
    return [
        line.split(b" b/", 1)[1].decode()
        for line in out.split(b"\n")
        if line.startswith(b"diff --git ")
    ]


def manifest(out: bytes) -> list[str]:
    text = out.decode("utf-8", "replace")
    if "Files omitted from this diff (" not in text:
        return []
    return [line for line in text.split("Files omitted from this diff (", 1)[1].splitlines()[1:] if line.startswith("- ") and not line.startswith("- \u2026 and ")]


def test_fast_path_returns_input_verbatim():
    diff = chunk("a.py", 5) + chunk("b.json", 5)
    assert prioritize_diff(diff, len(diff)) is diff
    assert prioritize_diff(diff, len(diff) + 1) == diff


def test_no_chunk_headers_falls_back_to_plain_truncation():
    data = b"line1\nline2\nline3\n" * 100
    out = prioritize_diff(data, 100)
    assert out == truncate_plain(data, 100)
    assert out.endswith(b"\n" + DEFAULT_MARKER + b"\n")
    assert len(out) <= 100


def test_plain_truncation_mirrors_truncate_clean():
    assert truncate_plain(b"abc", 2) == b".."
    assert truncate_plain(b"abc", 0) == b""
    src = "héllo\nwörld\nxyz\n".encode("utf-8")
    out = truncate_plain(src, 12, b"CUT")
    assert out == "héllo\nCUT\n".encode("utf-8")


def test_split_chunks_and_paths():
    pre = b"preamble line\n"
    diff = pre + chunk("src/a.py", 2) + chunk("docs/b.md", 3)
    preamble, chunks = split_chunks(diff)
    assert preamble == pre
    assert [p for p, _ in chunks] == [b"src/a.py", b"docs/b.md"]
    assert b"".join(d for _, d in chunks) == diff[len(pre):]
    assert chunk_paths(diff) == [b"src/a.py", b"docs/b.md"]


def test_quoted_and_spaced_paths():
    quoted = b'diff --git "a/x y/\\303\\244.py" "b/x y/\\303\\244.py"\n+1\n'
    assert split_chunks(quoted)[1][0][0] == b"x y/\\303\\244.py"
    spaced = b"diff --git a/dir/with space.py b/dir/with space.py\n+1\n"
    assert split_chunks(spaced)[1][0][0] == b"dir/with space.py"


@pytest.mark.parametrize(
    "path, size, expected",
    [
        ("src/app.py", 100, RANK_SOURCE),
        ("k8s/deploy.yaml", 100, RANK_SOURCE),
        ("README.md", 100, RANK_SOURCE),
        ("small.json", 100, RANK_SOURCE),
        ("data/big.json", 40 * 1024, RANK_BULK),
        ("data/big.csv", 40 * 1024, RANK_BULK),
        ("tests/fixtures/x.py", 10, RANK_BULK),
        ("golden/out.txt", 10, RANK_BULK),
        ("a/testdata/b.go", 10, RANK_BULK),
        ("package-lock.json", 10, RANK_GENERATED),
        ("Cargo.lock", 10, RANK_GENERATED),
        ("go.sum", 10, RANK_GENERATED),
        ("app.min.js", 10, RANK_GENERATED),
        ("dist/index.js", 10, RANK_GENERATED),
        ("a/node_modules/b.js", 10, RANK_GENERATED),
        ("x/__snapshots__/y.snap", 10, RANK_GENERATED),
        ("api.generated.ts", 10, RANK_GENERATED),
        ("types_generated.go", 10, RANK_GENERATED),
        ("proto/x.pb.go", 10, RANK_GENERATED),
        ("Build/thing.py", 10, RANK_GENERATED),
    ],
)
def test_rank_path(path, size, expected):
    assert rank_path(path.encode(), size, frozenset()) == expected


def test_generated_attribute_demotes_any_path():
    assert rank_path(b"src/schema.py", 10, frozenset({"src/schema.py"})) == RANK_GENERATED
    assert rank_path(b"src/schema.py", 10, frozenset({"other.py"})) == RANK_SOURCE


def test_source_survives_ahead_of_a_large_fixture_blob():
    blob = chunk("a/fixtures/corpus.json", 3000)
    code = chunk("z/logic.py", 20)
    diff = blob + code
    out = prioritize_diff(diff, 4000)
    assert len(out) <= 4000
    assert emitted_paths(out) == ["z/logic.py", "a/fixtures/corpus.json"]
    assert code in out
    assert out.endswith(b"\n") and DEFAULT_MARKER in out
    lines = manifest(out)
    assert lines == ["- a/fixtures/corpus.json (+3000/-0) clipped"]


def test_large_data_file_ranks_below_source_by_size_alone():
    blob = chunk("evals/data.json", 2000)
    code = chunk("scripts/run.sh", 10)
    out = prioritize_diff(blob + code, 3000)
    assert emitted_paths(out) == ["scripts/run.sh", "evals/data.json"]


def test_water_filling_is_fair_within_a_rank():
    big = chunk("a.py", 400)
    mid = chunk("b.py", 100)
    small = chunk("c.py", 5)
    diff = big + mid + small
    out = prioritize_diff(diff, 8000)
    assert len(out) <= 8000
    assert small in out
    assert emitted_paths(out) == ["a.py", "b.py", "c.py"]
    listed = manifest(out)
    assert listed == ["- a.py (+400/-0) clipped", "- b.py (+100/-0) clipped"]
    sizes = {}
    for path in ("a.py", "b.py"):
        start = out.index(f"diff --git a/{path}".encode())
        end = out.index("…[file diff clipped: ".encode(), start)
        sizes[path] = end - start
    assert abs(sizes["a.py"] - sizes["b.py"]) < 100


def test_clip_lands_on_a_line_boundary_with_note():
    diff = chunk("a.py", 500) + chunk("b.py", 500)
    out = prioritize_diff(diff, 6000)
    for path in ("a.py", "b.py"):
        start = out.index(f"diff --git a/{path}".encode())
        note = out.index("…[file diff clipped: ".encode(), start)
        assert out[note - 1:note] == b"\n"
        more = int(out[note:].split(b": ", 1)[1].split(b" ", 1)[0])
        assert more > 0
    assert len(out) <= 6000


def test_clip_never_splits_a_multibyte_character():
    wide = "\n".join(f"+{'é' * 30}" for _ in range(200))
    diff = f"diff --git a/u.py b/u.py\n--- a/u.py\n+++ b/u.py\n@@ -0,0 +1,200 @@\n{wide}\n".encode("utf-8")
    diff += chunk("v.py", 200)
    out = prioritize_diff(diff, 5000)
    out.decode("utf-8")
    assert len(out) <= 5000


def test_chunk_below_minimum_is_omitted_not_stubbed():
    many = b"".join(chunk(f"f{i}.py", 30) for i in range(20))
    out = prioritize_diff(many, 3000)
    assert len(out) <= 3000
    kept = emitted_paths(out)
    for path in kept:
        start = out.index(f"diff --git a/{path}".encode())
        nxt = out.find(b"\ndiff --git ", start)
        end = nxt + 1 if nxt >= 0 else out.index(DEFAULT_MARKER)
        assert end - start >= MIN_CHUNK_BYTES
    omitted = [line for line in manifest(out) if line.endswith("omitted")]
    assert omitted
    assert len(kept) + len(omitted) == 20
    for line in omitted:
        assert line.split(" ", 2)[1] not in kept

def test_manifest_counts_omitted_and_clipped_and_caps_lines():
    many = b"".join(chunk(f"dir/file{i:03d}.py", 3) for i in range(260))
    out = prioritize_diff(many, 20000)
    assert len(out) <= 20000
    text = out.decode()
    header = text.split("Files omitted from this diff (", 1)[1].split(")", 1)[0]
    lines = manifest(out)
    assert len(lines) == 200
    more = [l for l in text.splitlines() if l.startswith("- … and ")]
    assert len(more) == 1
    assert int(header) == 200 + int(more[0].split(" and ", 1)[1].split(" ", 1)[0])


def test_generated_set_moves_source_file_last():
    gen = chunk("schema.py", 200)
    code = chunk("main.py", 200)
    out = prioritize_diff(gen + code, len(code) + 3000, generated=frozenset({"schema.py"}))
    assert emitted_paths(out) == ["main.py", "schema.py"]


def test_leftover_budget_flows_to_lower_ranks():
    code = chunk("a.py", 5)
    lock = chunk("yarn.lock", 300)
    blob = chunk("x/fixtures/y.json", 300)
    out = prioritize_diff(code + lock + blob, 20000)
    assert emitted_paths(out) == ["a.py", "x/fixtures/y.json", "yarn.lock"]
    assert len(out) <= 20000


def test_preamble_is_preserved_first():
    pre = b"From: someone\nSubject: patch\n\n"
    out = prioritize_diff(pre + chunk("a.py", 200) + chunk("b.py", 200), 4000)
    assert out.startswith(pre)


def test_tiny_budget_matches_truncate_clean_sentinel():
    diff = chunk("a.py", 50)
    assert prioritize_diff(diff, 3) == b"..."
    assert prioritize_diff(diff, 1) == b"."
    assert prioritize_diff(diff, 0) == b""


def test_custom_marker():
    out = prioritize_diff(chunk("a.py", 500) + chunk("b.py", 500), 4000, marker=b"CUT")
    assert b"\nCUT\nFiles omitted from this diff (" in out
    assert DEFAULT_MARKER not in out


def test_deterministic_bytes():
    diff = b"".join(chunk(f"p{i}/f{i}.py", 50 + i) for i in range(30)) + chunk("big/fixtures/z.json", 2000)
    first = prioritize_diff(diff, 12000)
    for _ in range(3):
        assert prioritize_diff(diff, 12000) == first


def test_change_counts_exclude_file_headers():
    diff = chunk("a.py", 7, dels=3) + chunk("b/fixtures/big.json", 900)
    out = prioritize_diff(diff, 3000)
    assert "- b/fixtures/big.json (+900/-0) clipped" in manifest(out) or "- b/fixtures/big.json (+900/-0) omitted" in manifest(out)


def test_cli_matches_library_and_tolerates_no_git(tmp_path: Path):
    diff = chunk("a.py", 20) + chunk("f/fixtures/blob.json", 1500)
    src = tmp_path / "pr.diff"
    dst = tmp_path / "pr.diff.truncated"
    src.write_bytes(diff)
    proc = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "prioritize_diff.py"), str(src), str(dst), "3000", MARKER],
        cwd=tmp_path,
        capture_output=True,
    )
    assert proc.returncode == 0, proc.stderr
    assert dst.read_bytes() == prioritize_diff(diff, 3000)
    subprocess.run([sys.executable, str(ROOT / "scripts" / "prioritize_diff.py"), str(src), str(dst), str(len(diff))], cwd=tmp_path, check=True)
    assert dst.read_bytes() == diff


def test_cli_honours_linguist_generated_attribute(tmp_path: Path):
    def git(*args: str) -> None:
        subprocess.run(["git", *args], cwd=tmp_path, check=True, capture_output=True)

    git("init", "-q")
    (tmp_path / ".gitattributes").write_text("gen.py linguist-generated=true\n")
    diff = chunk("gen.py", 200) + chunk("main.py", 200)
    src = tmp_path / "pr.diff"
    dst = tmp_path / "out"
    src.write_bytes(diff)
    subprocess.run([sys.executable, str(ROOT / "scripts" / "prioritize_diff.py"), str(src), str(dst), "12000"], cwd=tmp_path, check=True)
    assert emitted_paths(dst.read_bytes()) == ["main.py", "gen.py"]
