"""Class-aware, size-fair diff truncation.

``truncate_clean`` cuts a unified diff at a byte budget in file order, so a
single lockfile or fixture blob early in the alphabet can consume the whole
budget and every source file after it is never seen by the reviewer. This
module keeps the same budget and the same marker but decides *which* bytes
survive:

* the diff is split into per-file chunks at ``diff --git`` boundaries;
* each chunk is ranked by path class — source/config/docs first (rank 0),
  bulk data second (rank 2), generated/lock files last (rank 3);
* within a rank the budget is water-filled: every chunk gets up to the same
  byte level, so one huge file cannot starve its siblings;
* a clipped chunk ends with a visible note, a chunk that would get fewer than
  ``MIN_CHUNK_BYTES`` is omitted instead of stubbed, and the trailer names
  every omitted or clipped file with its +/- counts so the reviewer knows
  what to read with tools.

Pure bytes in, bytes out, deterministic. The v3 TypeScript port
(``src/corpus/diff-priority.ts``) mirrors every branch byte-for-byte and the
parity harness pins it (``tests/fixtures/parity/diff-priority/``).
"""

from __future__ import annotations

from dataclasses import dataclass

DEFAULT_MARKER = "…[diff truncated to fit context budget]".encode("utf-8")
CHUNK_HEADER = b"diff --git "
MIN_CHUNK_BYTES = 512
BULK_DATA_BYTES = 32 * 1024
MANIFEST_MAX_LINES = 200

RANK_SOURCE = 0
RANK_BULK = 2
RANK_GENERATED = 3
_RANKS = (RANK_SOURCE, RANK_BULK, RANK_GENERATED)

_NOTE_PREFIX = "…[file diff clipped: ".encode("utf-8")
_NOTE_SUFFIX = b" more bytes]\n"
_MANIFEST_HEADER_PREFIX = b"Files omitted from this diff ("
_MANIFEST_HEADER_SUFFIX = b"):\n"
_MORE_PREFIX = "- … and ".encode("utf-8")
_MORE_SUFFIX = b" more\n"

_LOCK_BASENAMES = frozenset({
    b"package-lock.json", b"yarn.lock", b"pnpm-lock.yaml", b"cargo.lock",
    b"go.sum", b"poetry.lock", b"gemfile.lock", b"composer.lock",
})
_GENERATED_SUFFIXES = (b".lock", b".min.js", b".min.css", b".snap", b".pb.go")
_GENERATED_DIRS = frozenset({b"dist", b"build", b"vendor", b"node_modules", b"__snapshots__"})
_BULK_TOKENS = (b"fixture", b"testdata", b"snapshot", b"golden")
_DATA_SUFFIXES = (b".json", b".jsonl", b".csv", b".svg", b".txt", b".xml")


@dataclass
class _Chunk:
    index: int
    path: bytes
    data: bytes
    adds: int
    dels: int
    rank: int


def split_chunks(diff: bytes) -> tuple[bytes, list[tuple[bytes, bytes]]]:
    """Split a unified diff into ``(preamble, [(path, chunk_bytes), ...])``.

    A chunk starts at every line that begins with ``diff --git`` and runs to
    the next such line (or EOF). Bytes before the first chunk are the
    preamble. A diff without chunk headers yields an empty chunk list.
    """
    starts: list[int] = []
    pos = 0
    while True:
        found = diff.find(CHUNK_HEADER, pos)
        if found < 0:
            break
        if found == 0 or diff[found - 1:found] == b"\n":
            starts.append(found)
        pos = found + 1
    if not starts:
        return diff, []
    preamble = diff[: starts[0]]
    chunks: list[tuple[bytes, bytes]] = []
    for i, start in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else len(diff)
        data = diff[start:end]
        chunks.append((_chunk_path(data), data))
    return preamble, chunks


def chunk_paths(diff: bytes) -> list[bytes]:
    """Distinct chunk paths in diff order (for attribute lookups)."""
    seen: set[bytes] = set()
    paths: list[bytes] = []
    for path, _data in split_chunks(diff)[1]:
        if path not in seen:
            seen.add(path)
            paths.append(path)
    return paths


def _chunk_path(data: bytes) -> bytes:
    newline = data.find(b"\n")
    header = data[len(CHUNK_HEADER): newline if newline >= 0 else len(data)]
    if header.endswith(b'"'):
        quoted = header.rfind(b' "b/')
        if quoted >= 0:
            return header[quoted + 4:-1]
    plain = header.rfind(b" b/")
    if plain >= 0:
        return header[plain + 3:]
    return header


def _count_changes(data: bytes) -> tuple[int, int]:
    adds = 0
    dels = 0
    pos = 0
    length = len(data)
    while pos < length:
        newline = data.find(b"\n", pos)
        end = newline if newline >= 0 else length
        first = data[pos:pos + 1]
        if first == b"+":
            if data[pos:pos + 4] != b"+++ ":
                adds += 1
        elif first == b"-":
            if data[pos:pos + 4] != b"--- ":
                dels += 1
        pos = end + 1
    return adds, dels


def rank_path(path: bytes, size: int, generated: frozenset[str]) -> int:
    """Rank a chunk: 0 source/config/docs, 2 bulk data, 3 generated/lock."""
    if path.decode("utf-8", "replace") in generated:
        return RANK_GENERATED
    lower = path.lower()
    segments = lower.split(b"/")
    base = segments[-1]
    if base in _LOCK_BASENAMES or base.endswith(_GENERATED_SUFFIXES):
        return RANK_GENERATED
    if any(segment in _GENERATED_DIRS for segment in segments[:-1]):
        return RANK_GENERATED
    if b".generated." in base or b"_generated." in base:
        return RANK_GENERATED
    if any(token in segment for segment in segments for token in _BULK_TOKENS):
        return RANK_BULK
    if base.endswith(_DATA_SUFFIXES) and size > BULK_DATA_BYTES:
        return RANK_BULK
    return RANK_SOURCE


def _water_level(sizes: list[int], avail: int) -> int:
    lo = 0
    hi = max(sizes)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if sum(min(size, mid) for size in sizes) <= avail:
            lo = mid
        else:
            hi = mid - 1
    return lo


def _manifest_line(chunk: _Chunk, status: bytes) -> bytes:
    return (
        b"- " + chunk.path + b" (+" + str(chunk.adds).encode() + b"/-"
        + str(chunk.dels).encode() + b") " + status + b"\n"
    )


def _more_line(count: int) -> bytes:
    return _MORE_PREFIX + str(count).encode() + _MORE_SUFFIX


def _manifest_header(count: int) -> bytes:
    return _MANIFEST_HEADER_PREFIX + str(count).encode() + _MANIFEST_HEADER_SUFFIX


def truncate_plain(data: bytes, budget: int, marker: bytes = DEFAULT_MARKER) -> bytes:
    """Byte-exact ``truncate_clean`` (scripts/sections/config.sh) semantics."""
    if len(data) <= budget:
        return data
    suffix = b"\n" + marker + b"\n"
    if len(suffix) > budget:
        return b"." * min(budget, 3)
    clip = data[: max(0, budget - len(suffix))]
    newline = clip.rfind(b"\n")
    if newline > 0:
        clip = clip[:newline]
    return clip.decode("utf-8", "ignore").encode("utf-8") + suffix


def prioritize_diff(
    diff: bytes,
    budget: int,
    *,
    generated: frozenset[str] = frozenset(),
    marker: bytes = DEFAULT_MARKER,
) -> bytes:
    """Fit ``diff`` into ``budget`` bytes, keeping the highest-value chunks."""
    if len(diff) <= budget:
        return diff
    preamble, raw_chunks = split_chunks(diff)
    if not raw_chunks:
        return truncate_plain(diff, budget, marker)
    if len(marker) + 2 > budget:
        return b"." * min(budget, 3)

    chunks: list[_Chunk] = []
    for index, (path, data) in enumerate(raw_chunks):
        adds, dels = _count_changes(data)
        chunks.append(_Chunk(index, path, data, adds, dels, rank_path(path, len(data), generated)))
    ordered = [chunk for rank in _RANKS for chunk in chunks if chunk.rank == rank]

    # Reserve the trailer at its upper bound: every chunk listed, the 200
    # longest lines, and the overflow line. "omitted" and "clipped" have the
    # same length, so a line's size does not depend on the outcome.
    total = len(chunks)
    line_lengths = sorted((len(_manifest_line(chunk, b"omitted")) for chunk in chunks), reverse=True)
    reserve = 1 + len(marker) + 1 + len(_manifest_header(total)) + sum(line_lengths[:MANIFEST_MAX_LINES])
    if total > MANIFEST_MAX_LINES:
        reserve += len(_more_line(total))

    if len(preamble) + reserve > budget:
        cut = max(0, budget - reserve)
        newline = preamble.rfind(b"\n", 0, cut)
        preamble = preamble[: newline + 1] if newline >= 0 else b""
    avail = budget - len(preamble) - reserve

    emitted: list[bytes] = []
    listed: list[tuple[_Chunk, bytes]] = []
    for rank in _RANKS:
        bucket = [chunk for chunk in ordered if chunk.rank == rank]
        if not bucket:
            continue
        sizes = [len(chunk.data) for chunk in bucket]
        if sum(sizes) <= avail:
            emitted.extend(chunk.data for chunk in bucket)
            avail -= sum(sizes)
            continue
        level = _water_level(sizes, max(0, avail))
        used = 0
        for chunk in bucket:
            size = len(chunk.data)
            if size <= level:
                emitted.append(chunk.data)
                used += size
                continue
            note_max = len(_NOTE_PREFIX) + len(str(size)) + len(_NOTE_SUFFIX)
            limit = level - note_max
            end = -1
            if limit > 0:
                newline = chunk.data.rfind(b"\n", 0, limit)
                if newline >= 0:
                    end = newline + 1
            if end < MIN_CHUNK_BYTES:
                listed.append((chunk, b"omitted"))
                continue
            note = _NOTE_PREFIX + str(size - end).encode() + _NOTE_SUFFIX
            emitted.append(chunk.data[:end] + note)
            used += end + len(note)
            listed.append((chunk, b"clipped"))
        avail -= used

    body = preamble + b"".join(emitted)
    if body and not body.endswith(b"\n"):
        body += b"\n"
    lines = [_manifest_line(chunk, status) for chunk, status in listed]
    while True:
        trailer = marker + b"\n" + _manifest_header(len(listed))
        trailer += b"".join(lines[:MANIFEST_MAX_LINES])
        if len(lines) > MANIFEST_MAX_LINES:
            trailer += _more_line(len(lines) - MANIFEST_MAX_LINES)
        out = body + trailer
        if len(out) <= budget or not lines:
            break
        lines.pop()
    if len(out) > budget:
        return truncate_plain(out, budget, marker)
    return out
