/** Deterministic classifier-driven specialist role selection — v3 port of
 * `pr_reviewer/role_selection.py` (#633 logic, #675 migration).
 *
 * In `deep_review=auto` this decides which of the three fixed specialist
 * roles (`correctness` / `security` / `tests` — the closed set) are worth
 * running. A pure lookup on the deterministic classification data the
 * pipeline already produces before the specialist phase: no model call, no
 * network, no command execution. Identical classification input produces
 * byte-identical selection output.
 *
 * Conservative fallback: unusable/malformed classification, the classifier's
 * `unknown`-kind failure placeholder, a usable kind matching no lane, or
 * undetermined linked metadata all fail toward MORE scrutiny — all three
 * roles run with explicit reasons. Zero selection is only ever allowed by an
 * explicit, documented trivial gate. */

import type { PRClassification } from "./classify.js";

/** Version of the selection artifact. Bump on any shape change. */
export const SELECTION_ARTIFACT_VERSION = 1;

/** The closed set of fixed specialist roles, in evaluation order. */
export const SPECIALIST_ROLES_ORDER: readonly string[] = ["correctness", "security", "tests"];

/** classification.json's changed_files_summary is capped by the classifier's
 * max_summary_files default (50). At the cap the list may be truncated, so
 * the docs/meta-only trivial gate conservatively does not fire. */
export const SUMMARY_FILE_CAP = 50;

/** Security lane: pr_kind values AND risk-flag names that select the
 * `security` specialist. */
const SECURITY_SIGNALS: readonly string[] = [
  "auth_changes",
  "public_route_changes",
  "file_serving_changes",
  "path_handling_changes",
  "secret_handling_changes",
  "linked_security_issue",
  "linked_audit_issue",
];

/** Tests lane: pr_kind values (no risk flag name collides — kind-only lane). */
const TESTS_SIGNALS: readonly string[] = ["dependency_upgrade", "db_or_migration_changes"];

/** Correctness lane: pr_kind values AND risk-flag names. `app_code` is the
 * substantive catch-all (subject to the docs/meta-only trivial gate); a
 * P0/P1 linked issue demands treat-as-critical scrutiny. */
const CORRECTNESS_SIGNALS: readonly string[] = [
  "app_code",
  "k8s_manifest",
  "linked_priority_p0",
  "linked_priority_p1",
];

/** Inert `.github` metadata that is safe to treat as trivial — an explicit
 * enumeration on purpose: unknown `.github/**` content is treated as
 * NON-trivial (#633 review fix, round 2). */
const INERT_GITHUB_PATH_PATTERNS: readonly RegExp[] = [
  /^\.github\/CODEOWNERS$/i,
  /^\.github\/ISSUE_TEMPLATE\//i,
  /^\.github\/PULL_REQUEST_TEMPLATE(\/|$)/i,
  /^\.github\/pull_request_template\./i,
  /^\.github\/FUNDING\.ya?ml$/i,
  /^\.github\/dependabot\.ya?ml$/i,
];

/** The documented trivial-path class for the docs/meta-only zero-selection
 * gate. Deliberately NOT matched: source code, manifests, lockfiles, IaC,
 * anything under `.github` outside the inert enumeration, or any path the
 * classifier's kind/risk pattern sets target. */
const TRIVIAL_PATH_PATTERNS: readonly RegExp[] = [
  ...INERT_GITHUB_PATH_PATTERNS,
  /^(docs|doc|documentation)\//i,
  /\.(md|markdown|rst|adoc|txt)$/i,
  /^(license|licence|notice|codeowners|code_of_conduct|contributing)(\..*)?$/i,
  /^\.(editorconfig|gitignore|gitattributes|prettierrc|eslintrc|nvmrc)(\..*)?$/i,
  /^(renovate\.json5?|\.renovaterc(\.json)?|dependabot\.ya?ml)$/i,
];

/** Executable/behavioral `.github` content is never trivial: workflows and
 * composite actions ARE code. This check runs before the trivial patterns so
 * a future edit to that list cannot silently re-classify executable content
 * as trivial; unknown `.github/**` paths match neither list and are
 * non-trivial by construction (#633 review fix). */
const NON_TRIVIAL_PATH_PATTERNS: readonly RegExp[] = [
  /^\.github\/(workflows|actions)\//i,
];

/** Roles in evaluation order with their signal sets: the explicit, documented
 * selection mapping. */
const ROLE_LANES: readonly { role: string; signals: readonly string[] }[] = [
  { role: "correctness", signals: CORRECTNESS_SIGNALS },
  { role: "security", signals: SECURITY_SIGNALS },
  { role: "tests", signals: TESTS_SIGNALS },
];

/** The classifier's own failure fallback (classification.sh writes
 * `pr_kind: "unknown"` when classification fails). An unknown kind carries no
 * lane signal, so like unusable input it gets the conservative fallback. */
const UNKNOWN_PR_KIND = "unknown";

export interface RoleDecision {
  role: string;
  selected: boolean;
  signals: string[];
  reason: string;
}

/** The typed version-1 specialist selection (#675): consumers receive this
 * canonical object, never a re-read scratch file. Internal fields are
 * camelCase (#669); the persisted artifact shape is produced only by
 * `selectionToArtifact`. */
export interface SpecialistSelection {
  version: number;
  mode: "auto";
  classificationAvailable: boolean;
  prKind: string;
  riskFlags: string[];
  metadataUncertain: boolean;
  metadataUncertaintyReasons: string[];
  selectedRoles: string[];
  skippedRoles: string[];
  decisions: RoleDecision[];
  zeroSelectionReason: string;
}

/** Serialize the internal selection to the persisted v2-identical snake_case
 * artifact (`role-selection.json`). Key order mirrors the v2 artifact; the
 * parity harness compares `sort_keys` canonical JSON, so the bytes are
 * v2-identical regardless. */
export function selectionToArtifact(selection: SpecialistSelection): Record<string, unknown> {
  return {
    version: selection.version,
    mode: selection.mode,
    classification_available: selection.classificationAvailable,
    pr_kind: selection.prKind,
    risk_flags: selection.riskFlags,
    metadata_uncertain: selection.metadataUncertain,
    metadata_uncertainty_reasons: selection.metadataUncertaintyReasons,
    selected_roles: selection.selectedRoles,
    skipped_roles: selection.skippedRoles,
    decisions: selection.decisions,
    zero_selection_reason: selection.zeroSelectionReason,
  };
}

/** The uncertainty sentinel for a `linked_metadata_uncertain` artifact whose
 * reason list is missing or entirely unusable. */
const UNDETERMINED_METADATA = "linked metadata could not be fully determined";

/** Deserialization boundary: rebuild the internal classification from the
 * persisted v2 snake_case artifact (`classification.json`), or return null
 * when the artifact is unusable — which the selector maps onto its
 * conservative all-roles fallback (`classification_available: false`),
 * exactly like v2 reading the same file. The usability rule is verbatim:
 * `pr_kind` must be a string whose trim is non-empty; `pr_kind` text that
 * fails the control-character check still counts as usable (with an empty
 * kind), matching v2's clean/usable split. Changed-file entries are kept
 * verbatim (a tampered artifact may carry non-strings) and cast here only
 * because the selector consumes them opaquely — an unusable entry is never
 * scored as trivial. */
export function classificationFromArtifact(raw: unknown): PRClassification | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.pr_kind !== "string" || rec.pr_kind.trim() === "") return null;
  let uncertainty: string[] = [];
  if (rec.linked_metadata_uncertain === true) {
    const rawReasons = rec.linked_metadata_uncertainty;
    if (!Array.isArray(rawReasons)) {
      uncertainty = [UNDETERMINED_METADATA];
    } else {
      const reasons = cleanStrList(rawReasons);
      uncertainty = reasons.length > 0 ? reasons : [UNDETERMINED_METADATA];
    }
  }
  const rawFlagsWithFiles = rec.risk_flags_with_files;
  const riskFlagsWithFiles: Record<string, string[]> = {};
  if (rawFlagsWithFiles !== null && typeof rawFlagsWithFiles === "object" && !Array.isArray(rawFlagsWithFiles)) {
    for (const [flag, files] of Object.entries(rawFlagsWithFiles as Record<string, unknown>)) {
      const cleaned = cleanStrList(files);
      if (cleaned.length > 0) riskFlagsWithFiles[flag] = cleaned;
      else if (Array.isArray(files)) riskFlagsWithFiles[flag] = [];
    }
  }
  return {
    prKind: cleanStr(rec.pr_kind),
    riskFlags: cleanStrList(rec.risk_flags),
    riskFlagsWithFiles,
    routeSignals: cleanStrList(rec.route_signals),
    changedFilesSummary: Array.isArray(rec.changed_files_summary) ? (rec.changed_files_summary as string[]) : [],
    linkedIssueLabels: cleanStrList(rec.linked_issue_labels),
    mustCheck: cleanStrList(rec.must_check),
    linkedMetadataUncertain: rec.linked_metadata_uncertain === true,
    linkedMetadataUncertainty: uncertainty,
    // #749 provenance is a diagnostic, not a selection input: the persisted
    // artifact's provenance is not consumed here.
    pathHandlingProvenance: { fired: false, signals: [], discounted: [] },
  };
}

/** Bounded, control-character-free string for reason text; empty when
 * unusable. */
function cleanStr(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text) return "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return "";
  }
  return text;
}

function cleanStrList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = cleanStr(item);
    if (text) out.push(text);
  }
  return out;
}

/** True only for a usable string in the documented trivial-path class.
 * Unusable entries are never trivial, so they keep the docs/meta-only gate
 * from firing; executable `.github` content is explicitly non-trivial. */
function isTrivialPath(path: unknown): boolean {
  if (typeof path !== "string" || !path || path !== path.trim()) return false;
  for (const char of path) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  if (NON_TRIVIAL_PATH_PATTERNS.some((pattern) => pattern.test(path))) return false;
  return TRIVIAL_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/** Attributed signal tokens for a lane, in a deterministic order:
 * `pr_kind=<kind>` first (when it matches), then risk flags in their
 * classification order. */
function attributedSignals(kind: string, flags: readonly string[], signals: readonly string[]): string[] {
  const attributed: string[] = [];
  if (kind && signals.includes(kind)) attributed.push(`pr_kind=${kind}`);
  for (const flag of flags) {
    if (signals.includes(flag)) attributed.push(`risk_flag=${flag}`);
  }
  return attributed;
}

function classificationSummary(kind: string, flags: readonly string[]): string {
  return `pr_kind=${kind || "none"}; risk_flags=${flags.length > 0 ? flags.join(",") : "none"}`;
}

/** The zero-selection reason for a documented trivial class, or null when the
 * lanes should be evaluated. Checked before the lanes; the gates require NO
 * risk flags so any linked/file signal wins over them. */
function trivialZeroReason(kind: string, flags: readonly string[], files: readonly unknown[]): string | null {
  if (flags.length > 0) return null;
  if (kind === "renovate_digest_only") {
    return (
      "trivial class: digest-only lockfile change with no risk " +
      "signals — no role has a meaningful lane (documented " +
      "zero-selection gate)"
    );
  }
  if (
    kind === "app_code" &&
    files.length > 0 &&
    files.length < SUMMARY_FILE_CAP &&
    files.every((file) => isTrivialPath(file))
  ) {
    return (
      "trivial class: only docs/meta files changed with no risk " +
      "signals — no role has a meaningful lane (documented " +
      "zero-selection gate)"
    );
  }
  return null;
}

function conservativeFallback(usable: boolean, kind: string): boolean {
  /** True when the classification gives no deterministic basis to skip a
   * role: unusable input, or the `unknown` failure placeholder. */
  return !usable || kind === UNKNOWN_PR_KIND;
}

/** Select specialist roles from classification data. Pure and deterministic.
 * Takes the canonical internal classification — `null` (or a classification
 * rebuilt from an unusable artifact via `classificationFromArtifact`) fails
 * conservatively to all roles with `classificationAvailable: false`. Never
 * throws. */
export function selectSpecialistRoles(classification: PRClassification | null): SpecialistSelection {
  const usable = classification !== null;
  const kind = usable ? cleanStr(classification.prKind) : "";
  const flags = usable ? classification.riskFlags : [];
  // Files stay RAW for the trivial gate (an unusable entry must never be
  // scored as trivial); only their count feeds the cap check.
  const files: readonly unknown[] = usable ? classification.changedFilesSummary : [];

  const decisions: RoleDecision[] = [];
  const selectedRoles: string[] = [];
  const skippedRoles: string[] = [];
  let zeroReason = "";
  // Metadata uncertainty (usable classifications only — the unavailable
  // fallback already covers unusable input).
  const uncertaintyReasons = usable ? classification.linkedMetadataUncertainty : [];

  if (conservativeFallback(usable, kind)) {
    // Both fallback shapes report the classification as unavailable.
    const fallbackReason =
      "classification unavailable — defaulting to all roles " +
      "(conservative fallback: no deterministic basis to skip a role)";
    for (const role of SPECIALIST_ROLES_ORDER) {
      decisions.push({ role, selected: true, signals: [], reason: `selected: ${fallbackReason}` });
      selectedRoles.push(role);
    }
    return finalize(false);
  }

  if (uncertaintyReasons.length > 0) {
    // Conservative uncertainty fallback: a failed GitHub/Linear metadata
    // lookup may be hiding security/audit/priority signals — run all three
    // roles rather than treat missing metadata as absent. This defeats the
    // trivial gates too.
    const reason =
      "selected: linked-issue/Linear selection metadata could not " +
      `be fully determined (${uncertaintyReasons.join("; ")}) — defaulting ` +
      "to all roles (conservative fallback: missing signals are " +
      "not absent signals)";
    for (const role of SPECIALIST_ROLES_ORDER) {
      decisions.push({ role, selected: true, signals: [], reason });
      selectedRoles.push(role);
    }
    return finalize(true);
  }

  const gateReason = trivialZeroReason(kind, flags, files);
  if (gateReason !== null) {
    zeroReason = gateReason;
    for (const role of SPECIALIST_ROLES_ORDER) {
      decisions.push({ role, selected: false, signals: [], reason: `skipped: ${gateReason}` });
      skippedRoles.push(role);
    }
    return finalize(true);
  }

  for (const { role, signals } of ROLE_LANES) {
    const matched = attributedSignals(kind, flags, signals);
    if (matched.length > 0) {
      decisions.push({
        role,
        selected: true,
        signals: matched,
        reason: `selected: ${role}-lane signals matched: ${matched.join(", ")}`,
      });
      selectedRoles.push(role);
    } else {
      decisions.push({
        role,
        selected: false,
        signals: [],
        reason: `skipped: no ${role}-lane signal in classification (${classificationSummary(kind, flags)})`,
      });
      skippedRoles.push(role);
    }
  }
  if (selectedRoles.length === 0) {
    // Conservative no-match fallback: a usable classification whose kind
    // matches no lane (a future classifier value) must fail toward MORE
    // scrutiny — zero selection requires a documented trivial gate.
    const noMatchReason =
      "selected: no role lane matched the classification " +
      `signals (${classificationSummary(kind, flags)}) — ` +
      "defaulting to all roles (conservative fallback: zero " +
      "selection requires a documented trivial gate)";
    // The fallback REPLACES the per-lane decisions (v2 semantics).
    decisions.length = 0;
    for (const role of SPECIALIST_ROLES_ORDER) {
      decisions.push({ role, selected: true, signals: [], reason: noMatchReason });
      selectedRoles.push(role);
    }
    skippedRoles.length = 0;
  }
  return finalize(true);

  function finalize(available: boolean): SpecialistSelection {
    return {
      version: SELECTION_ARTIFACT_VERSION,
      mode: "auto",
      classificationAvailable: available,
      prKind: kind,
      riskFlags: flags,
      metadataUncertain: uncertaintyReasons.length > 0,
      metadataUncertaintyReasons: uncertaintyReasons,
      selectedRoles: selectedRoles,
      skippedRoles: skippedRoles,
      decisions,
      zeroSelectionReason: zeroReason,
    };
  }
}
