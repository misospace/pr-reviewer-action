import { gunzipSync } from "node:zlib";

/**
 * Tangled pull patch decoding (#586).
 *
 * The deterministic, pure half of the Tangled backend work: it selects the
 * current reviewable round of a Tangled pull and decodes the round's blob
 * into the unified-diff + changed-files shape the review engine already
 * consumes. Three steps, no network, no I/O:
 *
 *   pull record ── selectLatestPullRound ──▶ TangledPullRound
 *   blob bytes  ── decodeTangledPatchBlob ─▶ patch text (UTF-8, BOM-stripped)
 *   patch text  ── normalizeGitFormatPatch─▶ { diff, files, headSha }
 *
 * Tangled/AT-Protocol facts this module relies on (verified, do not
 * re-derive):
 * - a `sh.tangled.repo.pull` record value carries `rounds`, an APPEND-ONLY
 *   list of `{ createdAt, patchBlob }` — newer rounds are appended, so the
 *   current round is always the LAST element;
 * - a `patchBlob` in JSON is a BlobRef: an object carrying the CID under
 *   `$link` or `ref`, with optional `mimeType`/`size`;
 * - a round's blob content is GZIPPED text-based `git format-patch` output:
 *   one mail per commit, each starting with the mbox `From` line
 *   `From <sha> Mon Sep 17 00:00:00 1997` and ending with git's signature
 *   trailer (`-- ` line + version line).
 *
 * Trust posture: the record, the blob bytes, and the patch text are all
 * UNTRUSTED content. This module is pure and fails closed:
 * - it only ever throws `TangledPatchError` (one kind per failure);
 * - it NEVER falls back to an older round — a corrupt current round is a
 *   hard failure naming the round index and the problem;
 * - it never reports an empty diff as success (an envelope without any diff
 *   section is "empty-patch", and an empty blob stream is the same);
 * - it accepts exactly one grammar: the `git format-patch` mail envelope.
 *   Bare diffs without the envelope are "malformed-patch";
 * - the patch text is data: it is parsed and returned, never executed,
 *   fetched, or interpreted as instructions.
 *
 * No npm dependencies beyond stdlib `node:zlib`; the fetch side (downloading
 * the blob bytes from a Knot) is a later ticket and is deliberately not
 * imported here.
 */

export type TangledPatchFailure =
  | "no-round"
  | "invalid-round"
  | "undecodable-blob"
  | "patch-too-large"
  | "malformed-patch"
  | "empty-patch";

export class TangledPatchError extends Error {
  readonly kind: TangledPatchFailure;

  constructor(kind: TangledPatchFailure, message: string) {
    super(message);
    this.name = "TangledPatchError";
    this.kind = kind;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// ── round selection ─────────────────────────────────────────────────────

export interface TangledPullRound {
  index: number;
  createdAt: string;
  blobCid: string;
  mimeType: string | undefined;
  size: number | undefined;
}

/**
 * Select the CURRENT (last) round of a `sh.tangled.repo.pull` record value.
 * The rounds list is append-only, so "latest" is the last element; the
 * selection never inspects or falls back to an earlier round. Any
 * malformation of the last round is a fail-closed "invalid-round" whose
 * message names the round index and the problem.
 */
export function selectLatestPullRound(record: Record<string, unknown>): TangledPullRound {
  const rounds = record.rounds;
  if (!Array.isArray(rounds) || rounds.length === 0) {
    throw new TangledPatchError(
      "no-round",
      "pull record has no non-empty rounds array (append-only round list)",
    );
  }
  const index = rounds.length - 1;
  const round = asRecord(rounds[index]);
  if (round === undefined) {
    throw new TangledPatchError("invalid-round", `round ${index} is not an object`);
  }
  const createdAt = str(round.createdAt);
  if (createdAt === undefined || createdAt === "") {
    throw new TangledPatchError("invalid-round", `round ${index} has no non-empty createdAt string`);
  }
  const blob = asRecord(round.patchBlob);
  if (blob === undefined) {
    throw new TangledPatchError("invalid-round", `round ${index} has no patchBlob object`);
  }
  const cid = str(blob.$link) ?? str(blob.ref);
  if (cid === undefined || cid === "") {
    throw new TangledPatchError(
      "invalid-round",
      `round ${index} patchBlob has no non-empty CID (neither $link nor ref)`,
    );
  }
  const mimeType = str(blob.mimeType);
  const size = num(blob.size);
  return { index, createdAt, blobCid: cid, mimeType: mimeType, size: size };
}

// ── blob decoding ─────────────────────────────────────────────────────────

/** Hard cap on a decoded patch blob (bytes after gunzip). */
export const MAX_GUNZIP_BYTES = 64 * 1024 * 1024;

/**
 * Gunzip a Tangled patch blob and return its UTF-8 text (leading BOM
 * stripped). Fail-closed mapping of zlib outcomes to one kind each:
 * - input does not start with the gzip magic (0x1f 0x8b) → "undecodable-blob";
 * - zlib fails because the decompressed output exceeds `maxBytes`
 *   (default `MAX_GUNZIP_BYTES`). On Node this surfaces as a `RangeError`
 *   "Cannot create a Buffer larger than <limit> bytes" (code
 *   ERR_BUFFER_TOO_LARGE) → "patch-too-large";
 * - any other zlib failure (corrupt stream, truncated input, bad header,
 *   bad CRC — e.g. "incorrect data check", "unexpected end of file") →
 *   "undecodable-blob".
 */
export function decodeTangledPatchBlob(bytes: Uint8Array, maxBytes?: number): string {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new TangledPatchError(
      "undecodable-blob",
      "patch blob does not start with the gzip magic (0x1f 0x8b)",
    );
  }
  const limit = maxBytes ?? MAX_GUNZIP_BYTES;
  let decoded: Uint8Array;
  try {
    decoded = gunzipSync(bytes, { maxOutputLength: limit });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Cannot create a Buffer larger than \d+ bytes/.test(message)) {
      throw new TangledPatchError(
        "patch-too-large",
        `patch blob decompresses beyond the ${limit} byte limit: ${message}`,
      );
    }
    throw new TangledPatchError("undecodable-blob", `gunzip failed: ${message}`);
  }
  // Non-fatal UTF-8: a hostile/foreign blob with bad bytes decodes
  // deterministically (U+FFFD) and then fails closed in
  // normalizeGitFormatPatch, which accepts only the mail-envelope grammar.
  const text = new TextDecoder("utf-8").decode(decoded);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ── git format-patch normalization ────────────────────────────────────────

/** Hard cap on the decoded patch text (characters): 32 MiB. Bigger input is
 * "malformed-patch" before any parsing is attempted (bounded work). */
const MAX_PATCH_CHARS = 32 * 1024 * 1024;

/** The one accepted envelope line: the git format-patch mbox `From` line.
 * Any ctime date/year is accepted (git's canonical shape is
 * `Mon Sep 17 00:00:00 1997`, with the optional `[+-]\d{4}` timezone
 * tolerated); the SHA is a 40-hex commit id. A line is a mail-unit
 * boundary ONLY if it matches here AND the immediately following line is
 * a real mail header (`From: ` / `Date: ` / `Subject: `) — untrusted
 * commit-message text can contain fake `From` lines and git does not
 * escape them. */
const FROM_LINE =
  /^From ([0-9a-f]{40}) \w{3} \w{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}( [+-]\d{4})?$/;
/** The three real mail-header prefixes that must follow a `From` line for
 * it to count as a mail-unit boundary. */
const MAIL_HEADER_STARTS = ["From: ", "Date: ", "Subject: "];
const DIFF_GIT = "diff --git ";

export interface TangledChangedFile {
  filename: string;
  status: "added" | "modified" | "removed" | "renamed" | "changed";
  additions: number;
  deletions: number;
  changes: number;
  patch: string;
  previous_filename: string | null;
}

export interface TangledNormalizedPatch {
  diff: string;
  files: TangledChangedFile[];
  headSha: string | undefined;
}

/**
 * Parse a `git format-patch` mail stream into a pure unified diff plus the
 * per-file entries in the engine's GitHub-REST shape.
 *
 * Grammar (one unambiguous shape, fail-closed — the only thrown error is
 * `TangledPatchError`):
 * - text longer than `MAX_PATCH_CHARS` (32 MiB) → "patch-too-large" before
 *   any parsing is attempted;
 * - non-whitespace text before the first VALID mail boundary →
 *   "malformed-patch" (bare diffs without the mail envelope are NOT
 *   accepted); a boundary is a `From <40-hex> <ctime>` line whose
 *   immediately following line is a real mail header (`From: `/`Date: `/
 *   `Subject: `) — fake `From` lines inside commit messages do not count;
 * - each mail unit runs to the next valid boundary (or end of text); its
 *   diff body starts at the first `diff --git ` line and runs to the end
 *   of the unit, minus the git signature trailer (a `--`/`-- ` marker line
 *   followed by the version line, e.g. "2.39.5 (Apple Git-154)") when that
 *   pair is the very last two lines and the last line does not look like
 *   hunk content (space/`+`/`-`/`@`/`\`), so hunk content is never
 *   stripped;
 * - a unit with no `diff --git ` section (cover letter / empty commit)
 *   contributes nothing; if no unit yields one → "empty-patch" (never an
 *   empty diff as a success);
 * - `headSha` is the SHA of the LAST valid boundary;
 * - file sections split the concatenated diff bodies at each line starting
 *   with `diff --git `; per section: the per-file old/new names come from
 *   the section's `--- ` / `+++ ` lines (C-style quoting decoded,
 *   `a/`/`b/` prefixes stripped, a `/dev/null` side takes the other
 *   side's name); the `diff --git` header is split ONLY as a fallback when
 *   no `---`/`+++` pair is present (binary sections); quoted paths decode
 *   \\, \", \a \b \v \f \r, \n, \t, \NNN octal → UTF-8 (unparseable →
 *   "malformed-patch"); the extended headers (`new file mode`,
 *   `deleted file mode`, `rename from`/`rename to`) fix the status, with
 *   the rename lines staying authoritative for renames (an incomplete
 *   rename pair → "malformed-patch");
 *   additions/deletions count `+`/`-` lines; the `+++`/`---` exclusion
 *   applies only BEFORE the first `@@` (inside hunks every `+`/`-` line
 *   counts, and `\` lines are excluded naturally); binary sections
 *   ("GIT binary patch" / "Binary files … differ") keep zero counts;
 * - `diff` is the file sections joined, each ending in exactly one "\n", so
 *   re-splitting at lines that start with `diff --git ` recovers the
 *   sections; it carries no mail headers, no signature, no diffstat.
 */
export function normalizeGitFormatPatch(patchText: string): TangledNormalizedPatch {
  if (patchText.length > MAX_PATCH_CHARS) {
    throw new TangledPatchError(
      "patch-too-large",
      `patch text is ${patchText.length} characters, over the ${MAX_PATCH_CHARS} hard cap`,
    );
  }
  const lines = patchText.split(/\r\n|\n/);

  // A line is a mail-unit boundary ONLY if it matches the mbox `From` line
  // AND the immediately following line is a real mail header: untrusted
  // commit-message text can contain fake `From` lines (git does not
  // escape them), so a `From` line with no header after it is data, not a
  // boundary.
  const fromLineAt: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!FROM_LINE.test(lines[i]!)) continue;
    const next = lines[i + 1];
    if (next === undefined) continue;
    if (MAIL_HEADER_STARTS.some((h) => next.startsWith(h))) fromLineAt.push(i);
  }
  if (fromLineAt.length === 0) {
    // No valid mail envelope at all. Bare diffs are not an accepted input.
    if (lines.some((l) => l.trim() !== "")) {
      throw new TangledPatchError(
        "malformed-patch",
        'no valid "From <sha> <ctime>" mail boundary (a From line must be followed by a From:/Date:/Subject: header); bare diffs are not accepted',
      );
    }
    throw new TangledPatchError("empty-patch", "patch text is empty");
  }

  // Only whitespace may precede the first valid boundary (e.g. a stray
  // leading blank). Anything else — including a fake `From` line — is a
  // malformed stream.
  const firstFrom = fromLineAt[0]!;
  for (let i = 0; i < firstFrom; i++) {
    const l = lines[i]!;
    if (l.trim() !== "") {
      throw new TangledPatchError(
        "malformed-patch",
        `non-envelope text before the first mail: ${l}`,
      );
    }
  }

  // Mail units: each runs from its From line to the next From line (or EOF).
  const bodies: string[][] = [];
  let headSha: string | undefined;
  for (let u = 0; u < fromLineAt.length; u++) {
    const start = fromLineAt[u]!;
    const end = u + 1 < fromLineAt.length ? fromLineAt[u + 1]! : lines.length;
    const unit = lines.slice(start, end);
    const fromMatch = FROM_LINE.exec(unit[0]!);
    const fromSha = fromMatch?.[1];
    if (fromSha !== undefined) headSha = fromSha;

    let bodyStart = -1;
    for (let i = 0; i < unit.length; i++) {
      if (unit[i]!.startsWith(DIFF_GIT)) {
        bodyStart = i;
        break;
      }
    }
    if (bodyStart === -1) continue; // cover letter / empty commit: contributes nothing

    let body = unit.slice(bodyStart);
    while (body.length > 0 && body[body.length - 1] === "") body.pop(); // line-terminator blanks
    // Git's trailing signature trailer, when it is the very last two lines
    // of the unit (handles \r\n and \n via the split above): a `--`/`-- `
    // marker line followed by the version line, e.g. "2.39.5 (Apple Git-
    // 154)". The last line must not look like hunk content (a line
    // starting with a space, `+`, `-`, `@`, or `\`), so a hunk that ends
    // in such a line is never stripped — `-- ` in particular must not be
    // mistaken for a deletion.
    if (
      body.length >= 2 &&
      (body[body.length - 2] === "-- " || body[body.length - 2] === "--") &&
      !isHunkContentLine(body[body.length - 1]!)
    ) {
      body = body.slice(0, body.length - 2);
    }
    bodies.push(body);
  }

  const allLines = bodies.flat();
  const sectionStarts: number[] = [];
  for (let i = 0; i < allLines.length; i++) {
    if (allLines[i]!.startsWith(DIFF_GIT)) sectionStarts.push(i);
  }
  if (sectionStarts.length === 0) {
    throw new TangledPatchError("empty-patch", "no mail unit yields a diff section");
  }

  const files: TangledChangedFile[] = [];
  for (let s = 0; s < sectionStarts.length; s++) {
    const sStart = sectionStarts[s]!;
    const sEnd = s + 1 < sectionStarts.length ? sectionStarts[s + 1]! : allLines.length;
    files.push(parseFileSection(allLines.slice(sStart, sEnd)));
  }
  return {
    diff: files.map((f) => f.patch).join(""),
    files,
    headSha,
  };
}

/** True for a line that looks like unified-diff hunk content: a context
 * line (leading space), an addition (`+`), a deletion (`-`), a hunk
 * header (`@`), or an escape marker (`\`, e.g. "no newline at end of
 * file"). An empty line is treated as hunk content too, so a trailer
 * strip never removes one. */
function isHunkContentLine(line: string): boolean {
  if (line === "") return true;
  const c = line.charAt(0);
  return c === " " || c === "+" || c === "-" || c === "@" || c === "\\";
}

/** Parse one file section (from a `diff --git ` line to the next). */
function parseFileSection(sectionIn: string[]): TangledChangedFile {
  let end = sectionIn.length;
  while (end > 0 && sectionIn[end - 1] === "") end--; // trailing blanks are not content
  const section = sectionIn.slice(0, end);
  const header = section[0]!;

  // Extended headers are the lines between the `diff --git` line and the
  // first hunk (`@@`); a section without a hunk (mode change, binary) has
  // them all.
  let hunkStart = -1;
  for (let i = 0; i < section.length; i++) {
    if (section[i]!.startsWith("@@")) {
      hunkStart = i;
      break;
    }
  }
  const extended = hunkStart === -1 ? section.slice(1) : section.slice(1, hunkStart);
  let added = false;
  let removed = false;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let minusPath: string | undefined;
  let plusPath: string | undefined;
  for (const line of extended) {
    if (/^new file mode \d{6}$/.test(line)) added = true;
    else if (/^deleted file mode \d{6}$/.test(line)) removed = true;
    else if (line.startsWith("rename from "))
      renameFrom = decodeRenameValue(line.slice("rename from ".length));
    else if (line.startsWith("rename to "))
      renameTo = decodeRenameValue(line.slice("rename to ".length));
    else if (line.startsWith("--- ")) minusPath = parseSidePath(line.slice("--- ".length));
    else if (line.startsWith("+++ ")) plusPath = parseSidePath(line.slice("+++ ".length));
  }

  let oldPath: string;
  let newPath: string;
  if (minusPath !== undefined && plusPath !== undefined) {
    // The `--- ` / `+++ ` file-header lines are the unambiguous per-file
    // names (exactly one path per line); the `diff --git` header is
    // ambiguous for unquoted paths that contain spaces (e.g. a file named
    // `x b/y`). A `/dev/null` side carries no name: take the other side.
    oldPath = minusPath;
    newPath = plusPath;
    if (oldPath === "/dev/null") oldPath = newPath;
    if (newPath === "/dev/null") newPath = oldPath;
  } else {
    // No `---`/`+++` pair (binary / header-only section): fall back to
    // the `diff --git` header split.
    ({ oldPath, newPath } = parseDiffGitPaths(header.slice(DIFF_GIT.length)));
  }

  const label = stripSide(newPath) || stripSide(oldPath);
  let status: TangledChangedFile["status"];
  let filename: string;
  let previousFilename: string | null = null;
  if (removed) {
    // The B side is /dev/null for a deleted file; the name is the A side.
    status = "removed";
    filename = stripSide(oldPath);
  } else if (added) {
    status = "added";
    filename = stripSide(newPath);
  } else if (renameFrom !== undefined || renameTo !== undefined) {
    if (renameFrom === undefined || renameTo === undefined) {
      throw new TangledPatchError(
        "malformed-patch",
        `incomplete rename pair in section for ${label}: only one of "rename from"/"rename to"`,
      );
    }
    status = "renamed";
    filename = stripSide(renameTo);
    previousFilename = stripSide(renameFrom);
  } else {
    status = "modified";
    filename = stripSide(newPath);
  }

  const binary = section.some(
    (l) => l.startsWith("GIT binary patch") || l.startsWith("Binary files "),
  );
  let additions = 0;
  let deletions = 0;
  if (!binary) {
    // The `+++`/`---` file-header exclusion applies only BEFORE the first
    // hunk; inside hunks every `+`/`-` line counts (a `+++` in a hunk is a
    // deletion of a `+` line), and `\` lines (e.g. "no newline") are
    // excluded naturally.
    for (let i = 0; i < section.length; i++) {
      const line = section[i]!;
      if (hunkStart === -1 || i < hunkStart) {
        if (line.startsWith("+") && !line.startsWith("+++")) additions++;
        else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
      } else {
        if (line.startsWith("+")) additions++;
        else if (line.startsWith("-")) deletions++;
      }
    }
  }

  return {
    filename,
    status,
    additions,
    deletions,
    changes: additions + deletions,
    patch: section.join("\n") + "\n",
    previous_filename: previousFilename,
  };
}

/** Strip the `a/` prefix from an A-side path, the `b/` prefix from a B-side
 * path; `/dev/null` and un-prefixed paths pass through unchanged. */
function stripSide(path: string): string {
  if (path === "/dev/null") return path;
  if (path.startsWith("a/")) return path.slice("a/".length);
  if (path.startsWith("b/")) return path.slice("b/".length);
  return path;
}

/**
 * Split the two paths of a `diff --git <A> <B>` header. Git C-style quoting
 * is the only quoting dialect: an unquoted path is printable text (spaces
 * allowed — git does not quote them), a quoted path is `"` … `"` with `\`,
 * `"`, `\n`, `\t`, and `\NNN` octal escapes. Any other shape is
 * "malformed-patch".
 */
function parseDiffGitPaths(rest: string): { oldPath: string; newPath: string } {
  if (rest.startsWith('"')) {
    const a = decodeQuotedPath(rest, 0);
    if (a.end >= rest.length || rest.charAt(a.end) !== " ") {
      throw new TangledPatchError(
        "malformed-patch",
        `unparseable path quoting in diff header: ${rest}`,
      );
    }
    const tail = rest.slice(a.end + 1);
    if (tail === "") {
      throw new TangledPatchError("malformed-patch", `diff header has no second path: ${rest}`);
    }
    if (tail.startsWith('"')) {
      const b = decodeQuotedPath(tail, 0);
      if (b.end !== tail.length) {
        throw new TangledPatchError(
          "malformed-patch",
          `trailing content after quoted path in diff header: ${rest}`,
        );
      }
      return { oldPath: a.value, newPath: b.value };
    }
    return { oldPath: a.value, newPath: tail };
  }

  // A is unquoted. An unquoted path never contains a raw `"` (git would
  // quote it), so the first quote in the line, if any, opens B.
  const quoteAt = rest.indexOf('"');
  if (quoteAt !== -1) {
    if (rest.charAt(quoteAt - 1) !== " ") {
      throw new TangledPatchError(
        "malformed-patch",
        `unparseable path quoting in diff header: ${rest}`,
      );
    }
    const b = decodeQuotedPath(rest, quoteAt);
    if (b.end !== rest.length) {
      throw new TangledPatchError(
        "malformed-patch",
        `trailing content after quoted path in diff header: ${rest}`,
      );
    }
    return { oldPath: rest.slice(0, quoteAt - 1), newPath: b.value };
  }

  // No quoting at all. Prefer the separator space whose left side carries
  // the A-side marker and whose right side carries the B-side marker — the
  // true separator in well-formed output; first such space wins (paths may
  // contain spaces, so a naive first/last split would be ambiguous).
  const candidates: number[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest.charAt(i) !== " ") continue;
    if (i === 0 || i === rest.length - 1) continue;
    const left = rest.slice(0, i);
    const right = rest.slice(i + 1);
    const leftOk = left === "/dev/null" || left.startsWith("a/");
    const rightOk = right === "/dev/null" || right.startsWith("b/");
    if (leftOk && rightOk) candidates.push(i);
  }
  if (candidates.length > 0) {
    const i = candidates[0]!;
    return { oldPath: rest.slice(0, i), newPath: rest.slice(i + 1) };
  }
  // No side markers: last space is the only deterministic split.
  const sp = rest.lastIndexOf(" ");
  if (sp === -1 || sp === 0 || sp === rest.length - 1) {
    throw new TangledPatchError("malformed-patch", `expected two paths after "diff --git": ${rest}`);
  }
  return { oldPath: rest.slice(0, sp), newPath: rest.slice(sp + 1) };
}

/** Parse the single path of a `--- ` / `+++ ` file-header line. Git
 * appends a trailing tab when the path is quoted or carries a space; a
 * quoted path goes through the C-style decoder and must be the whole
 * (tab-stripped) value. */
function parseSidePath(raw: string): string {
  const rest = raw.endsWith("\t") ? raw.slice(0, -1) : raw;
  if (!rest.startsWith('"')) return rest;
  const r = decodeQuotedPath(rest, 0);
  if (r.end !== rest.length) {
    throw new TangledPatchError(
      "malformed-patch",
      `trailing content after quoted path in file-header line: ${raw}`,
    );
  }
  return r.value;
}

/** Decode a `rename from` / `rename to` value: a value starting with `"`
 * goes through the C-style quoted-path decoder (and must be fully
 * consumed); unquoted values pass through unchanged. */
function decodeRenameValue(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const r = decodeQuotedPath(raw, 0);
  if (r.end !== raw.length) {
    throw new TangledPatchError(
      "malformed-patch",
      `trailing content after quoted path in rename line: ${raw}`,
    );
  }
  return r.value;
}

/** Decode a C-style quoted path starting at `from` (which must be `"`).
 * Recognized escapes: `\\`, `"`, `\a`, `\b`, `\v`, `\f`, `\r`, `\n`,
 * `\t`, and `\NNN` octal. Returns the decoded string and the index just
 * past the closing quote. */
function decodeQuotedPath(s: string, from: number): { value: string; end: number } {
  if (s.charAt(from) !== '"') {
    throw new TangledPatchError("malformed-patch", "unparseable path quoting (missing open quote)");
  }
  const bytes: number[] = [];
  let i = from + 1;
  let closed = false;
  for (;;) {
    if (i >= s.length) break;
    const c = s.charAt(i);
    if (c === '"') {
      closed = true;
      break;
    }
    if (c !== "\\") {
      i += pushCodePointUtf8(bytes, s, i);
      continue;
    }
    const n = s.charAt(i + 1);
    if (n === "") break; // dangling backslash: unterminated
    if (n === "n") {
      bytes.push(0x0a);
      i += 2;
    } else if (n === "t") {
      bytes.push(0x09);
      i += 2;
    } else if (n === "r") {
      bytes.push(0x0d);
      i += 2;
    } else if (n === "a") {
      bytes.push(0x07);
      i += 2;
    } else if (n === "b") {
      bytes.push(0x08);
      i += 2;
    } else if (n === "v") {
      bytes.push(0x0b);
      i += 2;
    } else if (n === "f") {
      bytes.push(0x0c);
      i += 2;
    } else if (n === '"') {
      bytes.push(0x22);
      i += 2;
    } else if (n === "\\") {
      bytes.push(0x5c);
      i += 2;
    } else if (n >= "0" && n <= "7") {
      let octal = n;
      let j = i + 2;
      while (octal.length < 3 && j < s.length) {
        const d = s.charAt(j);
        if (d >= "0" && d <= "7") {
          octal += d;
          j++;
        } else break;
      }
      bytes.push(parseInt(octal, 8));
      i = j;
    } else {
      throw new TangledPatchError(
        "malformed-patch",
        `unparseable path quoting: unknown escape \\${n}`,
      );
    }
  }
  if (!closed) {
    throw new TangledPatchError("malformed-patch", "unparseable path quoting: unterminated quoted path");
  }
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    throw new TangledPatchError(
      "malformed-patch",
      "unparseable path quoting: decoded path bytes are not valid UTF-8",
    );
  }
  return { value, end: i + 1 };
}

/** Append the UTF-8 bytes of the code point at index `i` of `s` and
 * return the number of UTF-16 units consumed (1, or 2 for a surrogate
 * pair). Code points — not code units — are the unit of encoding (as
 * `Array.from` sees the string), so astral characters (emoji, …) survive
 * the fatal UTF-8 decode; a lone surrogate still encodes to invalid
 * UTF-8 and fails that decode, which is the fail-closed outcome. */
function pushCodePointUtf8(bytes: number[], s: string, i: number): number {
  const cp = s.codePointAt(i)!;
  const consumed = cp >= 0x10000 ? 2 : 1;
  if (cp < 0x80) bytes.push(cp);
  else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
  else if (cp < 0x10000)
    bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  else
    bytes.push(
      0xf0 | (cp >> 18),
      0x80 | ((cp >> 12) & 0x3f),
      0x80 | ((cp >> 6) & 0x3f),
      0x80 | (cp & 0x3f),
    );
  return consumed;
}
