/**
 * Derived architectural obligations as review-owned obligation rows (#1449).
 *
 * The #1448 pre-pass derives the cross-path obligations a change IMPLIES
 * (identity/dedupe keys, converging producers, persistence/recovery, trust
 * boundaries, ordering, compatibility). Until now that output was
 * PRESENTATION only: the corpus section showed the obligations to the
 * reviewer and the review carried on regardless of whether any of them held.
 * This module is the ENFORCEMENT half — it turns the pre-pass artifact into
 * rows that join the #1381 obligation contract, so an unresolved derived
 * obligation withholds a trusted native APPROVE (never by fabricating a
 * blocker finding: an unresolved obligation is a coverage statement, not a
 * defect claim).
 *
 * Two properties shape the code:
 *
 * 1. The artifact is UNTRUSTED DATA. Its obligation text and paths are model
 *    output, so a row id is COMPUTED here (`derived-<n>`, the 1-based index
 *    of the obligation in the artifact's own `obligations` array, through the
 *    shared id function in `src/derived/types.ts`) and never read from the
 *    artifact — untrusted text can never forge a row id, and it is rendered
 *    inside the enforcement fence, so it can never forge a heading either.
 *    The resolver is defensive throughout: unusable rows are skipped (never
 *    repaired), the row count is capped, the anchor count and every anchor's
 *    length are bounded, an anchor that does not look like a location is
 *    dropped, control characters are flattened to keep a row one line, and
 *    the resolver never throws.
 *
 * 2. COVERAGE is a first-class answer. "The derivation found nothing" and
 *    "the derivation never completed" are different states, and the second
 *    must never read as clean coverage — so the resolver fails toward
 *    `incomplete` with a closed reason, and the engine turns that into
 *    exactly ONE synthetic coverage-marker row (never a defect claim).
 */
import {
  derivedObligationId,
  MAX_DERIVED_OBLIGATIONS,
  MAX_OBLIGATION_CHARS,
  MAX_PATH_CHARS,
  MAX_PATHS_PER_OBLIGATION,
} from "../derived/types.js";

/** How much of the derived-obligation space this run actually covered. */
export type DerivedCoverage = "disabled" | "complete" | "incomplete";

/** One derived obligation, in the shape the enforcement layer consumes. */
export interface DerivedObligationRow {
  /** `derived-<n>`, n being the 1-based index in the artifact's array. */
  id: string;
  /** The derived obligation statement (trimmed, bounded, single line). */
  text: string;
  /** The derivation's declared locations (`path:symbol` or a bare path). */
  anchors: string[];
}

export interface DerivedObligationResolution {
  /** False when the feature is off: no rows, no coverage claim at all. */
  enabled: boolean;
  coverage: DerivedCoverage;
  /** Why coverage is incomplete (null when it is complete or disabled). */
  reason: string | null;
  rows: DerivedObligationRow[];
}

/** The id of the synthetic coverage-marker row (see #1449). */
export const DERIVED_COVERAGE_ROW_ID = "derived-coverage";

/**
 * #1449: the closed marker list of an UNAMBIGUOUS failure assertion.
 *
 * A `satisfied` disposition whose rationale says the obligation FAILS is not
 * a satisfaction — it is a negative answer dressed as a positive one, and the
 * deterministic layer would discharge the row on it.
 *
 * The list is PHRASE-level on purpose. A bare-word list missed the
 * equivalent negative phrasings ("the invariant does not hold", "the
 * invariant is not met", "the identity is missing before the hash"), so a
 * "satisfied" rationale that denied the obligation still discharged the row.
 * The list stays deliberately narrow: the deterministic layer does not judge
 * semantics, so it only catches the phrases that leave no other reading. A
 * rationale that merely sounds unsure ("could not confirm the invariant
 * holds") carries no marker and is left to the reviewer's own discipline —
 * and to the eval corpus.
 */
const DERIVED_FAILURE_MARKERS: readonly string[] = [
  "fails", "failed", "failing",
  "violates", "violated", "violation",
  "breaches", "breached",
  "counterexample", "counterexamples",
  "not satisfied",
  "does not satisfy", "doesn't satisfy", "do not satisfy",
  "does not hold", "do not hold", "doesn't hold",
  "cannot hold", "can not hold", "can't hold",
  "is not met", "are not met", "not met",
  "missing",
  "does not place", "do not place", "doesn't place",
  "does not include", "doesn't include",
  "never place", "never places",
  "never hash", "never hashes",
  "never pass", "never passes",
  "broken",
];

/**
 * #1449: the negations that turn a marker into a POSITIVE answer.
 *
 * A marker whose IMMEDIATELY PRECEDING word is one of these is not an
 * assertion: "no counterexample found" and "the obligation is not
 * violated" report that the obligation HOLDS, so they must never withhold
 * a row (no false withholding). A word ending in "n't" counts too
 * ("doesn't", "won't", "can't").
 */
const DERIVED_NEGATIONS: ReadonlySet<string> = new Set([
  "no", "not", "never", "without", "nor", "neither", "nothing", "none",
  "cannot", "can't", "hardly", "barely",
]);

/** A word character for the boundary rules: an identifier character. */
function isWordCharacter(value: string): boolean {
  return value !== "" && /[A-Za-z0-9_]/.test(value);
}

/**
 * #1449: does `text` name `token` on IDENTIFIER boundaries?
 *
 * A match must not be preceded or followed by a word character, so "get"
 * does not match "getUser" and "src/a.ts" does not match "src/a.tsx" — a
 * rationale that merely CONTAINS the anchor's text is not evidence that
 * the reviewer checked the flagged location.
 */
function mentionsToken(text: string, token: string): boolean {
  if (token === "") return false;
  let from = 0;
  for (;;) {
    const index = text.indexOf(token, from);
    if (index === -1) return false;
    const before = index === 0 ? "" : text[index - 1]!;
    const after = text[index + token.length] ?? "";
    if (!isWordCharacter(before) && !isWordCharacter(after)) return true;
    from = index + 1;
  }
}

/** The word immediately before `index`, lowercased ("" at the start). */
function precedingWord(text: string, index: number): string {
  const match = /([A-Za-z][A-Za-z']*)\s*$/.exec(text.slice(0, index));
  return match === null ? "" : match[1]!.toLowerCase();
}

/** Is this word a negation? */
function isNegationWord(word: string): boolean {
  if (word === "") return false;
  return DERIVED_NEGATIONS.has(word) || word.endsWith("n't");
}

/**
 * #1449: does this rationale ASSERT a failure?
 *
 * Used ONLY for derived rows: a `satisfied` answer that carries one of the
 * closed markers keeps its row unresolved (fail-closed), because the
 * deterministic layer cannot judge the semantics of a rationale and must not
 * let a self-contradicting one close a row. The `must_check` and
 * `trusted_base_guidance` sources keep their own rules untouched.
 *
 * The match is NEGATION-AWARE: a marker whose immediately preceding word
 * is a negation is not an assertion ("no counterexample found" and "the
 * obligation is not violated" are positive answers, not failures).
 */
export function rationaleAssertsFailure(text: string): boolean {
  if (typeof text !== "string" || text === "") return false;
  const lower = text.toLowerCase();
  for (const marker of DERIVED_FAILURE_MARKERS) {
    let from = 0;
    for (;;) {
      const index = lower.indexOf(marker, from);
      if (index === -1) break;
      const before = index === 0 ? "" : lower[index - 1]!;
      const after = lower[index + marker.length] ?? "";
      if (!isWordCharacter(before) && !isWordCharacter(after)
        && !isNegationWord(precedingWord(lower, index))) return true;
      from = index + 1;
    }
  }
  return false;
}

/**
 * #1449: the extension-less repository files that ARE locations.
 *
 * A `Makefile`, `Dockerfile`, `LICENSE` or `README` is a real file a
 * reviewer can check, but it carries no extension, so the extension rule
 * alone never called it path-like — and a derived row whose only anchor was
 * one of them could not be discharged by a rationale citing it. The set is
 * closed and small: only well-known repository files.
 */
const EXTENSIONLESS_LOCATIONS: ReadonlySet<string> = new Set([
  "makefile", "dockerfile", "license", "readme", "changelog", "codeowners",
  "gemfile", "rakefile", "procfile", "justfile",
]);

/**
 * #1449: the Bazel-style workspace files, matched EXACTLY.
 *
 * `BUILD` and `WORKSPACE` are locations only in their canonical uppercase
 * spelling; the lowercase words are ordinary English, and a rationale that
 * merely says "the build" must not pass as a cited location.
 */
const CASE_SENSITIVE_EXTENSIONLESS_LOCATIONS: ReadonlySet<string> = new Set([
  "BUILD", "WORKSPACE",
]);

/**
 * #1449: does this string look like a LOCATION?
 *
 * Path-like means: it contains a "/" OR its last dot-segment looks like a
 * file extension (a dot followed by 1-8 letters/digits — `reconcile.ts`,
 * `package.json`) OR it is one of the well-known extension-less repository
 * files (`Makefile`, `LICENSE`, ...). A bare `a`, or a trivial `a:b`, is NOT
 * path-like.
 *
 * WHY this rule exists: the derivation is model output over untrusted PR
 * content, so its "locations" can be anything at all. A row may only be
 * discharged by evidence that names a real location, so an anchor that does
 * not even look like one must never be usable — otherwise a trivial anchor
 * (`a:b`) would let any prose that happens to contain the same letters
 * discharge the row.
 */
function looksLikeLocation(part: string): boolean {
  if (part === "") return false;
  if (part.includes("/")) return true;
  const lastDot = part.lastIndexOf(".");
  if (lastDot === -1) {
    if (CASE_SENSITIVE_EXTENSIONLESS_LOCATIONS.has(part)) return true;
    return EXTENSIONLESS_LOCATIONS.has(part.toLowerCase());
  }
  return /^[A-Za-z0-9]{1,8}$/.test(part.slice(lastDot + 1));
}

/**
 * #1449: the PATH part of an anchor — the part before the anchor's LAST
 * ":" (`src/ingress/reconcile.ts:mintFoundJob` → `src/ingress/reconcile.ts`).
 */
function anchorPathPart(anchor: string): string {
  const separator = anchor.lastIndexOf(":");
  return separator === -1 ? anchor : anchor.slice(0, separator);
}

/**
 * #1449: is this anchor usable as the location a derived row must be
 * discharged against? An anchor whose path part does not look like a
 * location is dropped by the resolver (never repaired): the derivation
 * named nothing checkable, and a row that names nothing checkable is
 * discharged by the weaker path-like-rationale rule instead.
 */
function anchorIsUsable(anchor: string): boolean {
  return looksLikeLocation(anchorPathPart(anchor));
}

/**
 * #1449: does this text NAME a path-like token?
 *
 * The rationale is split on whitespace and punctuation, each token's part
 * before the first ":" is taken, and the token counts when that part is
 * path-like (see `looksLikeLocation`). This is the ONE definition the
 * resolver and the fold share: a derived row with no usable anchor is
 * discharged only by a rationale that names a real location, so the
 * reviewer must still cite a file it checked — a derivation that named
 * nothing must not brick the review.
 */
export function namesPathLikeToken(text: string): boolean {
  if (typeof text !== "string" || text === "") return false;
  for (const token of text.match(/[A-Za-z0-9_./\\:-]+/g) ?? []) {
    const part = token.split(":")[0] ?? "";
    if (looksLikeLocation(part)) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The pre-pass status as a closed token. The artifact is written by the
 * action itself, but the resolver treats it as data: an absent or
 * unrecognized status never reads as a successful derivation.
 */
function statusToken(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const token = value.trim().toLowerCase();
  return /^[a-z0-9_-]{1,40}$/.test(token) ? token : "unknown";
}

/**
 * Flatten untrusted text to ONE bounded line: control characters (a newline
 * among them) become spaces, runs of whitespace collapse, and the result is
 * trimmed and capped. A row must never break the one-row-per-line rendering
 * of the enforcement section, and the cap bounds what a single row can say.
 */
function boundedLine(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const flattened = value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  return flattened.length > limit ? flattened.slice(0, limit).trim() : flattened;
}

/**
 * The declared locations of one derived obligation, bounded and
 * deduplicated. An anchor that does not look like a LOCATION is dropped
 * (#1449): the derivation is untrusted model output, so a trivial anchor
 * (`a:b`) must never become the thing a row is discharged against.
 */
function boundedAnchors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const anchors: string[] = [];
  for (const raw of value) {
    if (anchors.length >= MAX_PATHS_PER_OBLIGATION) break;
    const anchor = boundedLine(raw, MAX_PATH_CHARS);
    if (anchor === "" || anchors.includes(anchor)) continue;
    if (!anchorIsUsable(anchor)) continue;
    anchors.push(anchor);
  }
  return anchors;
}

/**
 * One row per usable obligation, bounded to `MAX_DERIVED_OBLIGATIONS`. The
 * id carries the obligation's index in the artifact array (not a counter of
 * accepted rows), so an id always names the same obligation the artifact
 * does — even when an earlier row was skipped as unusable, and even when
 * the cap dropped the later ones (capping never renumbers a row).
 */
function obligationRows(value: unknown): DerivedObligationRow[] {
  if (!Array.isArray(value)) return [];
  const rows: DerivedObligationRow[] = [];
  for (let index = 0; index < value.length && rows.length < MAX_DERIVED_OBLIGATIONS; index++) {
    const entry = value[index];
    if (!isRecord(entry)) continue;
    const text = boundedLine(entry.obligation, MAX_OBLIGATION_CHARS);
    if (text === "") continue;
    rows.push({ id: derivedObligationId(index), text, anchors: boundedAnchors(entry.paths) });
  }
  return rows;
}

/**
 * Resolve the derived-obligation coverage of one run.
 *
 * `enabled` is the operator gate (`derived-obligations`); when it is off the
 * resolver answers `disabled` with no rows and no coverage claim, so a
 * disabled run is byte-identical to a run without this feature.
 *
 * Coverage is `incomplete` (with a closed reason) when:
 * - the artifact is missing or unparsable (`artifact-missing`);
 * - its status is not `ok`/`empty` (`derivation-<status>`, e.g.
 *   `derivation-error`, `derivation-timeout`, `derivation-skipped`);
 * - `input_complete` is not exactly `true` (`input-incomplete`) — a
 *   derivation that never saw the whole change cannot claim coverage;
 * - the obligation set was truncated (`obligation-set-truncated`);
 * - the artifact carries nonempty normalization `errors`
 *   (`derivation-malformed`) — the normalizer records every entry it had to
 *   DISCARD (a malformed obligation is never repaired), so a nonempty list
 *   means at least one derived obligation was dropped and the surviving rows
 *   are a PARTIAL answer, never complete coverage (#1449: malformed
 *   derivation output fails toward partial, not native APPROVE).
 *
 * Otherwise the coverage is `complete` — including a clean `empty` over a
 * complete input, which is complete coverage with ZERO rows.
 */
export function resolveDerivedObligations(record: unknown, enabled: boolean): DerivedObligationResolution {
  if (!enabled) return { enabled: false, coverage: "disabled", reason: null, rows: [] };
  if (!isRecord(record)) return { enabled: true, coverage: "incomplete", reason: "artifact-missing", rows: [] };
  const rows = obligationRows(record.obligations);
  const status = statusToken(record.status);
  if (status !== "ok" && status !== "empty") {
    return { enabled: true, coverage: "incomplete", reason: `derivation-${status}`, rows };
  }
  if (record.input_complete !== true) {
    return { enabled: true, coverage: "incomplete", reason: "input-incomplete", rows };
  }
  if (record.truncated === true) {
    return { enabled: true, coverage: "incomplete", reason: "obligation-set-truncated", rows };
  }
  // Fail closed on DISCARDED entries: the normalizer keeps the usable rows
  // and records what it dropped in `errors`, so a nonempty list means the
  // surviving rows do not cover the derivation's full answer. Declaring
  // complete coverage here would let a partially malformed derivation that
  // lost an obligation publish a native APPROVE once the survivors were
  // discharged (#1449) — so any recorded error makes the coverage
  // incomplete, with the surviving rows still carried for disclosure.
  if (Array.isArray(record.errors) && record.errors.length > 0) {
    return { enabled: true, coverage: "incomplete", reason: "derivation-malformed", rows };
  }
  return { enabled: true, coverage: "complete", reason: null, rows };
}

/**
 * #1449: the basenames that name no particular file.
 *
 * The basename fallback in `anchorCoveredBy` exists so a rationale may cite
 * `reconcile.ts` for the anchor `src/ingress/reconcile.ts` — but a generic
 * basename ("index.ts", "main.ts", "config.ts") names a file in EVERY
 * directory, so accepting it would let a rationale that never reached the
 * flagged file discharge the row.
 */
const GENERIC_BASENAMES: ReadonlySet<string> = new Set([
  "index", "main", "mod", "lib", "util", "utils", "common", "shared", "core",
  "config", "settings", "app", "server", "client", "api", "types", "constants",
  "init", "setup", "helper", "helpers", "test", "tests", "spec",
]);

/** A file name's stem — its name without the extension, lowercased. */
function fileStem(name: string): string {
  const lower = name.toLowerCase();
  const lastDot = lower.lastIndexOf(".");
  return lastDot <= 0 ? lower : lower.slice(0, lastDot);
}

/**
 * #1449: does `text` (a reviewer's rationale) name the location the derivation
 * flagged?
 *
 * An anchor is a derivation location: `src/ingress/reconcile.ts:mintFoundJob`
 * (path and symbol) or a bare path `src/ingress/reconcile.ts`. The anchor is
 * split at its LAST ":" into a path part and a symbol part. The candidate
 * covers the anchor when it names the symbol part AND (the full path part OR
 * the path part's basename); a bare-path anchor needs only the path part or
 * its basename. Matching is case-sensitive and happens on IDENTIFIER
 * boundaries, and an empty symbol or path never covers anything.
 *
 * WHY the boundaries matter: a raw substring match let "src/db.ts:getUser"
 * discharge the anchor "src/db.ts:get" — the rationale named a DIFFERENT
 * symbol that merely starts with the flagged one, so the evidence never
 * reached the flagged location.
 *
 * WHY the basename fallback is limited: a generic basename ("index.ts") names
 * a file in every directory, so it never stands in for the flagged path.
 *
 * WHY this rule exists: a derived obligation may only be CLOSED by evidence
 * that names the location the derivation flagged, so "the daemon passed the
 * identity to the callback" cannot close "the reconciliation mint site must
 * place the identity before hashing" — the callback receiving a value is
 * not the production site placing it.
 */
export function anchorCoveredBy(text: string, anchor: string): boolean {
  if (typeof text !== "string" || typeof anchor !== "string") return false;
  const candidate = text.trim();
  const trimmed = anchor.trim();
  if (candidate === "" || trimmed === "") return false;
  const separator = trimmed.lastIndexOf(":");
  const path = separator === -1 ? trimmed : trimmed.slice(0, separator);
  const symbol = separator === -1 ? "" : trimmed.slice(separator + 1);
  if (path === "") return false;
  const basename = path.split(/[\\/]/).pop() ?? "";
  // A generic basename names no particular file: it never stands in for the
  // flagged path.
  const basenameUsable = basename !== "" && !GENERIC_BASENAMES.has(fileStem(basename));
  const namesPath = mentionsToken(candidate, path) || (basenameUsable && mentionsToken(candidate, basename));
  // A bare-path anchor (no symbol part) is covered by the path alone.
  if (separator === -1) return namesPath;
  // A degenerate `path:` anchor names no symbol and covers nothing.
  if (symbol === "") return false;
  return mentionsToken(candidate, symbol) && namesPath;
}

/**
 * The text of the synthetic coverage-marker row. It states that coverage is
 * unavailable and why, and that it is a coverage marker rather than a
 * defect claim — the row never reads as a finding.
 */
export function derivedCoverageObligationText(reason: string): string {
  const safeReason = boundedLine(reason, 80) || "unknown";
  return (
    "Derived-obligation coverage is unavailable (reason: " + safeReason + "): the architectural "
    + "obligations this change implies could not be fully derived, so their verification "
    + "coverage is unknown. This row marks missing coverage, not a defect."
  );
}

/** The synthetic coverage-marker row. */
export interface DerivedCoverageRow {
  id: string;
  text: string;
  /** The only cause this row ever carries (#1449). */
  cause: "derivation-incomplete";
}

/**
 * The ONE synthetic row an incomplete coverage answer adds to the
 * obligation contract, or null when the coverage is complete or the feature
 * is off. It is a coverage marker, never a defect claim: it names the reason
 * the coverage is unavailable and carries the `derivation-incomplete` cause.
 *
 * It carries NO anchors, so no disposition can discharge it (a derived row
 * is discharged only by evidence naming one of its locations) — the
 * unavailable-coverage state cannot be argued away.
 */
export function derivedCoverageRow(resolution: DerivedObligationResolution): DerivedCoverageRow | null {
  if (resolution.coverage !== "incomplete") return null;
  return {
    id: DERIVED_COVERAGE_ROW_ID,
    text: derivedCoverageObligationText(resolution.reason ?? "unknown"),
    cause: "derivation-incomplete",
  };
}

/**
 * #1449: the reason token that explains the DISCLOSED derived state.
 *
 * The disclosure is a closed vocabulary:
 * - `null` — the feature is off, or the derivation completed and every
 *   derived row was discharged (the state speaks for itself);
 * - the resolver's closed COVERAGE reason (`artifact-missing`,
 *   `derivation-error`, `derivation-timeout`, `derivation-skipped`,
 *   `derivation-malformed`, `input-incomplete`, `obligation-set-truncated`)
 *   — the derivation never completed (or dropped a malformed entry), so the
 *   coverage is unknown;
 * - `not-discharged` — the coverage is complete but at least one derived row
 *   was not satisfied, so the coverage is known AND the obligation is open.
 *
 * The reason used to be the coverage reason alone, which reported `null`
 * for the common case (coverage complete, rows undischarged) — a disclosure
 * that said nothing about the state it accompanied.
 */
export function derivedObligationStateReason(
  resolution: DerivedObligationResolution,
  obligations: readonly { source: string; status: string }[],
): string | null {
  if (!resolution.enabled) return null;
  if (resolution.coverage === "incomplete") return resolution.reason ?? "artifact-missing";
  const rows = obligations.filter((obligation) => obligation.source === "derived");
  if (rows.some((obligation) => obligation.status !== "satisfied")) return "not-discharged";
  return null;
}
