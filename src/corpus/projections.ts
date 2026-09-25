/** Byte-exact TS emulation of the two `jq -c` projections build_review_corpus
 * applies while assembling the corpus body (#676):
 *
 * 1. PR Metadata (corpus.sh): `{number, title, author: (.author.login //
 *    .author), baseRefName, headRefName, headRefOid, changedFiles,
 *    additions, deletions, url, body: ((.body // "")[0:4000])}`
 * 2. PR Classification (corpus.sh): `{pr_kind, risk_flags,
 *    risk_flags_with_files, changed_files_summary: (.changed_files_summary |
 *    .[0:20]), linked_issue_labels, must_check}` piped through `head -c 8000`.
 *
 * Failure semantics are the production contract, not jq-lenient ones:
 * production executes `build_review_corpus` under `set -euo pipefail`, so a
 * jq parse error, a missing input file, or a jq type error inside the
 * projection ABORTS the review (fail-closed). These helpers therefore throw
 * `ProjectionError` in exactly the cases jq would exit nonzero, and the
 * corpus builder treats that as a build failure. The one non-error shape is
 * an existing-but-EMPTY input file: jq receives zero input documents, exits
 * 0, and writes nothing at all — modeled as empty output bytes, never a bare
 * newline.
 *
 * Semantics pinned empirically against jq (1.8.2) and encoded here:
 * - `a // b` falls back to `b` only when `a` is `null` or `false`;
 * - string slices cut by Unicode code points (not UTF-16 units), array
 *   slices cut by elements, and `null | .[0:n]` stays `null`;
 * - compact serialization matches `jq -c`: insertion-ordered keys, `"`/`\`
 *   and the `\b \f \n \r \t` shorthands, `\u00xx` (lowercase hex) for the
 *   remaining control characters, and non-ASCII passed through as UTF-8 —
 *   which is exactly `JSON.stringify`'s escaping for these shapes. */

export class ProjectionError extends Error {}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function parseJson(text: string): Json {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProjectionError("parse error");
  }
  return parsed as Json;
}

/** jq truthiness: only `null` and `false` are falsy. */
function jqTruthy(value: Json): boolean {
  return value !== null && value !== false;
}

function indexField(value: Json, key: string): Json {
  if (value === null) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as { [key: string]: Json };
    // Own-property check: a hostile "__proto__" key must read the JSON-parsed
    // own value, never the prototype getter.
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return record[key] as Json;
    }
    return null;
  }
  // Indexing a number/string/array/boolean with a string key is a jq type error.
  throw new ProjectionError(`Cannot index ${jqTypeName(value)} with string ("${key}")`);
}

function jqTypeName(value: Json): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "boolean": return "boolean";
    case "number": return "number";
    case "string": return "string";
    default: return "object";
  }
}

/** jq `.[start:end]`: strings slice by code points, arrays by elements,
 * `null` slices to `null`, everything else is a type error. */
function slice(value: Json, start: number, end: number): Json {
  if (value === null) return null;
  if (typeof value === "string") {
    return Array.from(value).slice(start, end).join("");
  }
  if (Array.isArray(value)) {
    return value.slice(start, end);
  }
  throw new ProjectionError(`Cannot index ${jqTypeName(value)} with object`);
}

function projectPrMetadata(parsed: Json): string {
  const author = indexField(parsed, "author");
  let authorValue: Json;
  if (author === null) {
    authorValue = null;
  } else {
    const login = indexField(author, "login");
    authorValue = jqTruthy(login) ? login : author;
  }
  const rawBody = indexField(parsed, "body");
  const body = jqTruthy(rawBody) ? rawBody : "";
  const fields: { [key: string]: Json } = {
    number: indexField(parsed, "number"),
    title: indexField(parsed, "title"),
    author: authorValue,
    baseRefName: indexField(parsed, "baseRefName"),
    headRefName: indexField(parsed, "headRefName"),
    headRefOid: indexField(parsed, "headRefOid"),
    changedFiles: indexField(parsed, "changedFiles"),
    additions: indexField(parsed, "additions"),
    deletions: indexField(parsed, "deletions"),
    url: indexField(parsed, "url"),
    body: slice(body, 0, 4000),
  };
  return jqCompactSerialize(fields);
}

/** `jq -c '{number, title, author: (.author.login // .author), baseRefName,
 * headRefName, headRefOid, changedFiles, additions, deletions, url,
 * body: ((.body // "")[0:4000])}' pr.json`.
 *
 * `null` input (missing file), invalid UTF-8, or a parse/type failure throws
 * `ProjectionError` — under production `set -euo pipefail` that aborts the
 * review, so the port fails closed the same way. An empty (zero-byte) input
 * file is jq's zero-documents success: empty output bytes. Success returns
 * the exact stdout bytes (one compact line plus jq's trailing newline). */
export function prMetadataLine(prJsonText: Uint8Array | null): Uint8Array {
  if (prJsonText === null) {
    // Missing file: jq exits 2 ("No such file"), the review aborts.
    throw new ProjectionError("missing input");
  }
  if (prJsonText.length === 0) {
    // Existing but empty file: zero input documents, exit 0, no output.
    return new Uint8Array(0);
  }
  const line = projectPrMetadata(parseJson(strictUtf8Decode(prJsonText)));
  return Buffer.from(`${line}\n`, "utf8");
}

function projectClassification(parsed: Json): string {
  const fields: { [key: string]: Json } = {
    pr_kind: indexField(parsed, "pr_kind"),
    risk_flags: indexField(parsed, "risk_flags"),
    risk_flags_with_files: indexField(parsed, "risk_flags_with_files"),
    changed_files_summary: slice(indexField(parsed, "changed_files_summary"), 0, 20),
    linked_issue_labels: indexField(parsed, "linked_issue_labels"),
    must_check: indexField(parsed, "must_check"),
  };
  return jqCompactSerialize(fields);
}

/** `jq -c '{pr_kind, risk_flags, risk_flags_with_files, changed_files_summary:
 * (.changed_files_summary | .[0:20]), linked_issue_labels, must_check}'
 * classification.json | head -c 8000`.
 *
 * A parse/type failure throws `ProjectionError` (production `set -o pipefail`
 * propagates jq's nonzero exit and aborts the review); a missing file is
 * NEVER seen here — corpus.sh guards it with `[ -f classification.json ]`
 * and emits the explicit unavailable placeholder instead, which stays the
 * intentional unavailable path. An empty (zero-byte) input file is jq's
 * zero-documents success: empty output bytes. Success returns the exact
 * piped bytes: the compact line plus jq's trailing newline, cut at 8000
 * bytes (possibly mid-line or mid-escape, exactly like `head -c`). */
export function classificationLine(classificationText: Uint8Array | null): Uint8Array {
  if (classificationText === null) {
    // Unreachable from build_review_corpus (guarded by -f); fail closed.
    throw new ProjectionError("missing input");
  }
  if (classificationText.length === 0) {
    // Existing but empty file: zero input documents, exit 0, no output.
    return new Uint8Array(0);
  }
  const line = projectClassification(parseJson(strictUtf8Decode(classificationText)));
  return Buffer.concat([Buffer.from(line, "utf8"), Buffer.from("\n", "utf8")]).subarray(0, 8000);
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** jq rejects input that is not valid UTF-8; so does this port — surfaced as
 * the same ProjectionError a parse failure would be. */
function strictUtf8Decode(data: Uint8Array): string {
  try {
    return strictUtf8.decode(data);
  } catch {
    throw new ProjectionError("invalid UTF-8 input");
  }
}

/** Compact jq-compatible serialization for the JSON shapes these projections
 * produce (null / bool / number / string / array / object). */
function jqCompactSerialize(value: Json): string {
  return JSON.stringify(value);
}
