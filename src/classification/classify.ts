/** Deterministic PR classification — v3 port of `pr_reviewer/classifier.py`
 * (#675).
 *
 * Rule-based only: no model calls, no network. Analyzes changed files, diff
 * content, canonical linked issues, and linked-metadata completeness to
 * produce the structured classification consumed by routing, must-check
 * generation, and the specialist role selector.
 *
 * The pattern sets, rule tables, and their precedence are copied verbatim
 * from the Python module. The internal result is camelCase (#669 naming
 * contract); `classificationToArtifact` is the explicit serializer to the
 * persisted v2-identical snake_case `classification.json` schema. */

import type { ChangedFile, IssueLabel, LinkedIssue } from "../context/types.js";

/** The authoritative pr_kind enumeration (order = documentation order). */
export const PR_KINDS: readonly string[] = [
  "renovate_digest_only",
  "dependency_upgrade",
  "app_code",
  "k8s_manifest",
  "auth_changes",
  "public_route_changes",
  "file_serving_changes",
  "path_handling_changes",
  "secret_handling_changes",
  "db_or_migration_changes",
];

/** The authoritative risk-flag enumeration. */
export const RISK_FLAGS: readonly string[] = [
  "linked_security_issue",
  "linked_audit_issue",
  "linked_priority_p0",
  "linked_priority_p1",
  "file_serving_changes",
  "path_handling_changes",
  "auth_changes",
  "secret_handling_changes",
];

// ---------------------------------------------------------------------------
// Pattern sets (verbatim from pr_reviewer/classifier.py)
// ---------------------------------------------------------------------------

/** Renovate digest-only: lockfile files that contain only hash/digest changes
 * (no version bumps). */
const RENOVATE_DIGEST_FILE_PATTERNS: readonly RegExp[] = [
  /package-lock\.json/,
  /npm-shrinkwrap\.json/,
  /yarn\.lock/,
  /pnpm-lock\.yaml/,
];

/** Dependency-related files (lockfiles, manifests). */
const DEPENDENCY_PATTERNS: readonly RegExp[] = [
  /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|requirements\.txt|Gemfile\.lock|Cargo\.lock|go\.mod|go\.sum|composer\.lock|mix\.lock|build\.gradle|pom\.xml|setup\.py|setup\.cfg|pyproject\.toml|pubspec\.yaml|\.npmrc|\.yarnrc)/,
];

/** Kubernetes manifest patterns. */
const K8S_PATTERNS: readonly RegExp[] = [
  /(helmrelease|deployment|statefulset|daemonset|kustomization)\.ya?ml$/i,
  /configmap\.ya?ml$/,
  /secret\.ya?ml$/,
  /service\.ya?ml$/,
  /ingress\.ya?ml$/,
  /\.k8s\.ya?ml$/,
  /k8s\//,
  /helm\//,
];

/** Common source-file extensions across ecosystems. */
const SRC_EXT = "(py|js|jsx|ts|tsx|go|rb|java|kt|cs|php|rs|scala|swift)";

/** Auth-related changes. */
const AUTH_PATTERNS: readonly RegExp[] = [
  new RegExp(`(auth|login|oauth|oidc|saml|jwt|token|mfa|2fa|session)[_.-]?\\w*\\.${SRC_EXT}$`, "i"),
  /middleware[_.-]?auth/i,
  /permissions?\.ya?ml$/,
  /rbac\.ya?ml$/,
  /role[-_].*binding/i,
  /\.env(\.example)?$/i,
  /(auth|authn|authz)[-_]?(controller|service|guard|middleware|handler)/i,
];

/** Public route changes. NB: `routes` (plural) only — a bare `route.<ext>` is
 * the mandated name of every Next.js App Router API handler and must not
 * match (#531). */
const PUBLIC_ROUTE_PATTERNS: readonly RegExp[] = [
  new RegExp(`(routes|urls?|api|endpoints?|controller)\\.${SRC_EXT}$`, "i"),
  /router[_.-]?py$/,
  /urlpatterns/,
  /app\.route\(/,
  /@\w+\.route\(/,
  /(registerEndpoint|@(Get|Post|Put|Delete|Patch|RequestMapping))/i,
];

/** File serving changes — directory names or file patterns. */
const FILE_SERVING_PATTERNS: readonly RegExp[] = [
  /^(static|public|assets|uploads|media|files)[/_.-]/i,
  /(static|public|assets|uploads|media|files)\//i,
  /send_file/,
  /send_from_directory/,
  /FileServer/,
  /serveStatic/,
  /staticfiles?\//,
];

/** Path handling changes — filenames AND diff content. */
const PATH_HANDLING_PATTERNS: readonly RegExp[] = [
  /pathlib/i,
  /os\.path/i,
  /filepath|pathname/i,
  /\.\.\/|\.\.\\/i,
  /sanitize.*path|clean.*path/i,
  /path_join|joinpath|resolve.*path/i,
];

/** Secret handling changes. */
const SECRET_HANDLING_PATTERNS: readonly RegExp[] = [
  new RegExp("(secret|credential|password|api.?key|private.?key|token)[_.-]?\\w*\\.(py|js|ts|go|rb|yaml|yml|json)$", "i"),
  /secrets?\.ya?ml$/,
  /vault|hashicorp|aws.?secrets/i,
  /base64\.(decode|encode)/i,
];

/** DB / migration changes. */
const DB_MIGRATION_PATTERNS: readonly RegExp[] = [
  /(migration|migrate|migrations?)/i,
  /schema\.(py|rb|ts|js|sql|prisma)$/i,
  new RegExp(`models?\\.${SRC_EXT}$`, "i"),
  /(entity|entities|repository)\.(java|kt|cs|ts)$/i,
  /\.sql$/i,
  /alembic|django.*migrat|sequelize|migrate_/i,
  /prisma\/schema\.prisma$/,
];

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

// ---------------------------------------------------------------------------
// Classification result
// ---------------------------------------------------------------------------

/** The typed canonical classification (#675). Consumers (routing, role
 * selection, corpus) receive this object — never a re-read of
 * `classification.json` with a subtly different schema. Internal fields are
 * camelCase (#669); the persisted artifact shape is produced only by
 * `classificationToArtifact`. */
export interface PRClassification {
  prKind: string;
  riskFlags: string[];
  riskFlagsWithFiles: Record<string, string[]>;
  /** Subset of (prKind + riskFlags) safe to drive smart-model routing:
   * linked-issue flags and any file-based signal backed by an actual changed
   * filename. Content-only pattern matches are excluded (#159). */
  routeSignals: string[];
  changedFilesSummary: string[];
  linkedIssueLabels: string[];
  mustCheck: string[];
  /** #633: true when a selection-relevant metadata source (GitHub
   * linked-issue labels, configured Linear priority/labels) was EXPECTED but
   * could not be determined — missing signals must not be read as absent
   * signals by the deterministic selector. Known-disabled state is NOT
   * uncertainty; unusable status input degrades to not-uncertain. */
  linkedMetadataUncertain: boolean;
  linkedMetadataUncertainty: string[];
}

/** Serialize the internal classification to the persisted v2-identical
 * snake_case artifact (`classification.json`). Key order mirrors the v2
 * dataclass; the parity harness compares `sort_keys` canonical JSON, so the
 * artifact bytes are v2-identical regardless. */
export function classificationToArtifact(classification: PRClassification): Record<string, unknown> {
  return {
    pr_kind: classification.prKind,
    risk_flags: classification.riskFlags,
    risk_flags_with_files: classification.riskFlagsWithFiles,
    route_signals: classification.routeSignals,
    changed_files_summary: classification.changedFilesSummary,
    linked_issue_labels: classification.linkedIssueLabels,
    must_check: classification.mustCheck,
    linked_metadata_uncertain: classification.linkedMetadataUncertain,
    linked_metadata_uncertainty: classification.linkedMetadataUncertainty,
  };
}

// ---------------------------------------------------------------------------
// pr_kind rule table
// ---------------------------------------------------------------------------

/** Classification is a declarative table evaluated top-to-bottom; the FIRST
 * matching rule wins, so table order is precedence (most-specific first). */
type KindPredicate = (filenames: string[], diffText: string) => boolean;
const KIND_RULES: readonly { kind: string; matches: KindPredicate }[] = [
  { kind: "renovate_digest_only", matches: isRenovateDigestOnly },
  { kind: "dependency_upgrade", matches: isDependencyUpgrade },
  { kind: "k8s_manifest", matches: filenameMatches(K8S_PATTERNS) },
  // secret handling before auth (more specific)
  { kind: "secret_handling_changes", matches: filenameMatches(SECRET_HANDLING_PATTERNS) },
  { kind: "db_or_migration_changes", matches: filenameMatches(DB_MIGRATION_PATTERNS) },
  { kind: "auth_changes", matches: filenameMatches(AUTH_PATTERNS) },
  { kind: "public_route_changes", matches: filenameMatches(PUBLIC_ROUTE_PATTERNS) },
  { kind: "file_serving_changes", matches: filenameOrDiffMatches(FILE_SERVING_PATTERNS) },
  { kind: "path_handling_changes", matches: filenameOrDiffMatches(PATH_HANDLING_PATTERNS) },
];

/** Fallback kind when no rule matches. */
export const DEFAULT_PR_KIND = "app_code";

function filenameMatches(patterns: readonly RegExp[]): KindPredicate {
  return (filenames) => filenames.some((name) => matchesAny(name, patterns));
}

function filenameOrDiffMatches(patterns: readonly RegExp[]): KindPredicate {
  return (filenames, diffText) =>
    filenames.some((name) => matchesAny(name, patterns)) || matchesAny(diffText, patterns);
}

/** True only when EVERY changed file is a known lockfile — guards
 * renovate_digest_only against mixed PRs (code + a lockfile). */
function allFilesAreLockfiles(filenames: string[]): boolean {
  if (filenames.length === 0) return false;
  return filenames.every((name) => matchesAny(name, RENOVATE_DIGEST_FILE_PATTERNS));
}

/** True when the diff contains a version bump (JSON or changed YAML form), so
 * a digest-only update with a version change is not mislabeled. */
function hasVersionBump(diffText: string): boolean {
  if (/"version"\s*:\s*"[^"]+"/.test(diffText)) return true;
  if (/^[+-]\s*(?:app)?[Vv]ersion:\s*\S+/m.test(diffText)) return true;
  return false;
}

function isRenovateDigestOnly(filenames: string[], diffText: string): boolean {
  return allFilesAreLockfiles(filenames) && !hasVersionBump(diffText);
}

/** A dependency/manifest file changed, but NOT a k8s manifest (which happens
 * to reference versions and must classify as k8s_manifest instead). */
function isDependencyUpgrade(filenames: string[], _diffText: string): boolean {
  const hasDepFile = filenames.some((name) => matchesAny(name, DEPENDENCY_PATTERNS));
  if (!hasDepFile) return false;
  const hasK8s = filenames.some((name) => matchesAny(name, K8S_PATTERNS));
  return !hasK8s;
}

function classifyPrKind(files: readonly ChangedFile[], diffText: string): string {
  const filenames = files.map((file) => file.filename);
  for (const rule of KIND_RULES) {
    if (rule.matches(filenames, diffText)) return rule.kind;
  }
  return DEFAULT_PR_KIND;
}

// ---------------------------------------------------------------------------
// Risk-flag rule tables
// ---------------------------------------------------------------------------

/** Linked-issue flags: a flag fires when a linked issue carries ANY of the
 * trigger labels (case-insensitive). Order matters — flags append in this
 * order (deduplicated) as issues are scanned. */
const LINKED_ISSUE_RULES: readonly { triggerLabels: readonly string[]; flag: string }[] = [
  { triggerLabels: ["security", "vulnerability"], flag: "linked_security_issue" },
  { triggerLabels: ["audit"], flag: "linked_audit_issue" },
  { triggerLabels: ["priority/p0", "priority_p0"], flag: "linked_priority_p0" },
  { triggerLabels: ["priority/p1", "priority_p1"], flag: "linked_priority_p1" },
];

/** File-based flags: a flag fires when any changed filename OR the diff
 * content matches the pattern set. Order matters. */
const FILE_RISK_RULES: readonly { patterns: readonly RegExp[]; flag: string }[] = [
  { patterns: FILE_SERVING_PATTERNS, flag: "file_serving_changes" },
  { patterns: PATH_HANDLING_PATTERNS, flag: "path_handling_changes" },
  { patterns: AUTH_PATTERNS, flag: "auth_changes" },
  { patterns: SECRET_HANDLING_PATTERNS, flag: "secret_handling_changes" },
];

function issueLabels(issue: LinkedIssue): Set<string> {
  return new Set(issue.labels.map((label: IssueLabel) => label.name.toLowerCase()));
}

function detectRiskFlags(
  files: readonly ChangedFile[],
  diffText: string,
  linkedIssues: readonly LinkedIssue[],
): { flags: string[]; flagsWithFiles: Record<string, string[]> } {
  const flags: string[] = [];
  const flagsWithFiles: Record<string, string[]> = {};
  const filenames = files.map((file) => file.filename);

  // Linked security/audit/priority issues (table order, deduplicated).
  // Linear's native priority is numeric (1=Urgent, 2=High): convert those to
  // the same synthetic labels recognized for linked issues so teams do not
  // need to duplicate Linear priority as a custom label.
  for (const issue of linkedIssues) {
    const labels = issueLabels(issue);
    if (issue.source.toLowerCase() === "linear") {
      // Python: `type(priority) is int` — booleans and floats excluded.
      if (typeof issue.priority === "number" && Number.isInteger(issue.priority)) {
        if (issue.priority === 1) labels.add("priority/p0");
        else if (issue.priority === 2) labels.add("priority/p1");
      }
    }
    for (const { triggerLabels, flag } of LINKED_ISSUE_RULES) {
      if (triggerLabels.some((label) => labels.has(label)) && !flags.includes(flag)) {
        flags.push(flag);
      }
    }
  }

  // File-based risk flags (derived from classification patterns).
  for (const { patterns, flag } of FILE_RISK_RULES) {
    const triggeringFiles = filenames.filter((name) => matchesAny(name, patterns));
    const matchesInDiff = matchesAny(diffText, patterns);
    if (triggeringFiles.length > 0 || matchesInDiff) {
      if (!flags.includes(flag)) flags.push(flag);
      // File attribution (empty list when only diff content matched).
      flagsWithFiles[flag] = triggeringFiles;
    }
  }

  return { flags, flagsWithFiles };
}

// ---------------------------------------------------------------------------
// Checklist derivation
// ---------------------------------------------------------------------------

/** Checklist items per risk class. Keys are pr_kind values AND the file-based
 * risk flags (which share names), so a flag like auth_changes detected on an
 * app_code PR still pulls in the auth checklist (#157). */
const KIND_CHECKS: Readonly<Record<string, readonly string[]>> = {
  renovate_digest_only: ["verify no functional changes beyond lockfile hashes"],
  dependency_upgrade: [
    "check for breaking API changes in updated dependencies",
    "run full test suite after upgrade",
  ],
  k8s_manifest: [
    "validate manifest against target cluster version",
    "check for resource quota / limit changes",
  ],
  auth_changes: ["review auth flow for regression", "verify session token handling is correct"],
  public_route_changes: [
    "verify route access controls are in place",
    "check for unintended public endpoints",
  ],
  file_serving_changes: [
    "verify file path sanitization",
    "check for directory traversal vulnerabilities",
  ],
  path_handling_changes: [
    "review for path traversal vulnerabilities",
    "test with edge-case paths (null bytes, symlinks)",
  ],
  secret_handling_changes: [
    "verify secrets are not logged or exposed in diffs",
    "check secret rotation impact",
  ],
  db_or_migration_changes: [
    "review migration for data loss risk",
    "test migration on a copy of production schema",
  ],
};

/** Checklist items per linked-issue risk flag. */
const FLAG_CHECKS: Readonly<Record<string, readonly string[]>> = {
  linked_security_issue: ["explicitly address the linked security issue"],
  linked_audit_issue: ["verify audit findings are addressed"],
  linked_priority_p0: ["treat as critical — verify all changes thoroughly"],
  linked_priority_p1: ["treat as high priority — verify correctness carefully"],
};

/** Kinds whose classification can come from diff CONTENT (the
 * filenameOrDiffMatches rules). A content-only match of these must not drive
 * smart-model routing — only an actual changed filename should. */
const CONTENT_CAPABLE_KINDS: Readonly<Record<string, readonly RegExp[]>> = {
  file_serving_changes: FILE_SERVING_PATTERNS,
  path_handling_changes: PATH_HANDLING_PATTERNS,
};

function buildMustCheck(prKind: string, riskFlags: readonly string[]): string[] {
  const checks: string[] = [];
  const seen = new Set<string>();
  for (const key of [prKind, ...riskFlags]) {
    for (const check of [...(KIND_CHECKS[key] ?? []), ...(FLAG_CHECKS[key] ?? [])]) {
      if (!seen.has(check)) {
        seen.add(check);
        checks.push(check);
      }
    }
  }
  return checks;
}

function routeSignals(
  prKind: string,
  filenames: readonly string[],
  riskFlags: readonly string[],
  riskFlagsWithFiles: Record<string, string[]>,
): string[] {
  /** Signals eligible to route a PR straight to the smart model. Excludes
   * content-only matches (which over-route benign PRs). */
  const signals: string[] = [];
  // Linked-issue flags are explicit human signals — always route.
  for (const flag of riskFlags) {
    if (flag.startsWith("linked_") && !signals.includes(flag)) signals.push(flag);
  }
  // File-based risk flags only when an actual changed filename matched;
  // content-only matches carry an empty file list.
  for (const flag of Object.keys(riskFlagsWithFiles)) {
    const files = riskFlagsWithFiles[flag] ?? [];
    if (files.length > 0 && !signals.includes(flag)) signals.push(flag);
  }
  // pr_kind routes unless it is the catch-all default or a content-only
  // file_serving/path_handling kind.
  if (prKind && prKind !== DEFAULT_PR_KIND && !signals.includes(prKind)) {
    const patterns = CONTENT_CAPABLE_KINDS[prKind];
    if (patterns === undefined) {
      signals.push(prKind);
    } else if (filenames.some((name) => matchesAny(name, patterns))) {
      signals.push(prKind);
    }
  }
  return signals;
}

// ---------------------------------------------------------------------------
// Linked-metadata uncertainty (#633)
// ---------------------------------------------------------------------------

/** Bounded, control-character-free string for reason text; empty when
 * unusable. Mirrors the Python `_clean` (strip, reject control chars,
 * cap 200 chars). */
function cleanReason(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text) return "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return "";
  }
  return text.slice(0, 200);
}

/** Parse the context pipeline's linked-metadata completeness artifact into an
 * uncertainty flag + human reasons. A GitHub linked-issue fetch failure or a
 * failed configured Linear lookup means missing signals are not absent
 * signals; known-disabled state and unusable input degrade to
 * not-uncertain. */
function linkedMetadataUncertainty(metadataStatus: unknown): { uncertain: boolean; reasons: string[] } {
  if (metadataStatus === null || typeof metadataStatus !== "object" || Array.isArray(metadataStatus)) {
    return { uncertain: false, reasons: [] };
  }
  const status = metadataStatus as Record<string, unknown>;
  const reasons: string[] = [];
  const githubFailures = status.github_fetch_failures;
  if (Array.isArray(githubFailures)) {
    for (const item of githubFailures) {
      const ref = cleanReason(item);
      if (ref) reasons.push(`github linked issue ${ref} fetch failed`);
    }
  }
  const linearFailures = status.linear_fetch_failures;
  if (Array.isArray(linearFailures)) {
    for (const item of linearFailures) {
      const ref = cleanReason(item);
      if (ref) reasons.push(`linear ${ref} lookup failed`);
    }
  }
  // linear_known_disabled: intentionally no Linear data, not uncertainty.
  return { uncertain: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface ClassifyInput {
  prFiles: readonly ChangedFile[];
  diffText?: string | undefined;
  linkedIssues?: readonly LinkedIssue[] | undefined;
  maxSummaryFiles?: number | undefined;
  metadataStatus?: unknown;
}

/** Run deterministic classification on a PR. Pure and synchronous — no model
 * calls, no network, no command execution. */
export function classifyPr(input: ClassifyInput): PRClassification {
  const { prFiles, diffText = "", linkedIssues = [], maxSummaryFiles = 50, metadataStatus = null } = input;

  const uncertainty = linkedMetadataUncertainty(metadataStatus);

  const prKind = classifyPrKind(prFiles, diffText);
  const { flags, flagsWithFiles } = detectRiskFlags(prFiles, diffText, linkedIssues);
  const mustCheck = buildMustCheck(prKind, flags);

  // Build changed files summary (just filenames, truncated).
  const fileNames = prFiles.map((file) => file.filename);
  const changedFilesSummary = fileNames.slice(0, maxSummaryFiles);
  const routeSignalsList = routeSignals(prKind, fileNames, flags, flagsWithFiles);

  // Collect linked issue labels (case-sensitive, encounter order).
  const linkedIssueLabels: string[] = [];
  for (const issue of linkedIssues) {
    for (const label of issue.labels) {
      const name = label.name;
      if (name && !linkedIssueLabels.includes(name)) linkedIssueLabels.push(name);
    }
  }

  return {
    prKind,
    riskFlags: flags,
    riskFlagsWithFiles: flagsWithFiles,
    routeSignals: routeSignalsList,
    changedFilesSummary,
    linkedIssueLabels,
    mustCheck,
    linkedMetadataUncertain: uncertainty.uncertain,
    linkedMetadataUncertainty: uncertainty.reasons,
  };
}
