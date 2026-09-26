/** Review-corpus assembly (#676): byte-exact port of `build_review_corpus`
 * and its corpus.sh neighbors (standards-context preparation, tool-harness
 * placeholder states, bounded repo map, fork gating) from
 * scripts/sections/corpus.sh, preserving #658/#668 behavior:
 *
 * - the smart tier rebuilds its diff/file sections from the RAW `pr.diff` and
 *   `pr-files.json` under the SMART budgets — never from the primary tier's
 *   already-truncated artifacts;
 * - the primary artifact slot stays primary under direct smart routing
 *   (tier=smart, slot=primary writes review-corpus.md and reads
 *   tool-harness.md); only the escalated smart review (tier=smart,
 *   slot=smart) writes review-corpus.smart.truncated.md and the
 *   tool-harness.smart.md slot with the omission notice;
 * - reserved sections cannot be evicted: the standards section is capped
 *   first, the requirement ledger and specialist leads are carved out of the
 *   body budget (dropped entirely when they cannot fit a sane reservation),
 *   and the body takes only what remains;
 * - authority order is standards > requirement ledger > advisory specialist
 *   leads (leads appended last, after the truncated body);
 * - output-token headroom is part of budgeting (see budgets.ts);
 * - stale presence signals are cleared when their section is missing from the
 *   assembled corpus (lockstep with the prompt-fragment substitution).
 *
 * TypeScript in-memory state is primary here: every v2 file write is
 * represented as an entry in the returned artifact map keyed by the exact v2
 * filename. Files are diagnostic/interoperability artifacts, not the
 * internal bus.
 *
 * Byte-accounting note: shell `cat f` emits f's bytes verbatim (a file
 * without a trailing newline can merge with a following fence — preserved
 * deliberately), while `jq -c` emits its one line PLUS a trailing newline;
 * the projection helpers model that trailing newline so the assembled body
 * matches v2 byte-for-byte. */

import { reframeForCorpus } from "../context/repo-map.js";
import { classificationLine, prMetadataLine } from "./projections.js";
import { truncateClean } from "./truncate.js";
import { prioritizeDiff, type PrioritizeDiffOptions } from "./diff-priority.js";

export type CorpusTier = "primary" | "smart";
export type CorpusSlot = "primary" | "smart";

/** Snapshot of every workspace file `build_review_corpus` and its corpus.sh
 * neighbors read. `null` means the file does not exist on disk (v2 `-f`/`-s`
 * gates treat that as empty). */
export interface CorpusWorkspace {
  manifestContextMd: Uint8Array | null;
  prJson: Uint8Array | null;
  classificationJson: Uint8Array | null;
  relatedCodeTruncatedMd: Uint8Array | null;
  repoMapMd: Uint8Array | null;
  prThreadMd: Uint8Array | null;
  reviewThreadsMd: Uint8Array | null;
  linkedIssuesMd: Uint8Array | null;
  /** Content of the file named by $CI_CHECKS_FILE (null = unset/absent). */
  ciChecksContent: Uint8Array | null;
  versionHintsTruncatedTxt: Uint8Array | null;
  toolHarnessMd: Uint8Array | null;
  toolHarnessSmartMd: Uint8Array | null;
  evidenceProvidersMd: Uint8Array | null;
  imageDigestContextMd: Uint8Array | null;
  linkedSourcesMd: Uint8Array | null;
  repoImpactTruncatedMd: Uint8Array | null;
  repoHistoryTruncatedMd: Uint8Array | null;
  /** Raw, un-truncated sources (#658). */
  prDiff: Uint8Array | null;
  prFilesJson: Uint8Array | null;
  /** Primary-tier truncated artifacts written by context.sh. */
  prDiffTruncated: Uint8Array | null;
  prFilesTruncatedJson: Uint8Array | null;
  standardsContextMd: Uint8Array | null;
  requirementLedgerMd: Uint8Array | null;
  specialistsMd: Uint8Array | null;
  requirementLedgerPresent: Uint8Array | null;
  specialistLeadsPresent: Uint8Array | null;
  /** Content of the file $STANDARDS_FILE points at (null = not found). */
  standardsFileContent: Uint8Array | null;
}

export interface CorpusBuildOptions {
  tier: CorpusTier;
  slot: CorpusSlot;
  maxCorpus: number;
  diffBudget: number;
  filesBudget: number;
  repoMapMaxBytes: number;
  /** $STANDARDS_FILE (the resolved path string, possibly empty). */
  standardsFile: string;
  /** $CI_CHECKS_FILE (the env value, possibly empty). */
  ciChecksFile: string;
  /** v2 guard condition: tier==smart, or PRIMARY_/MODEL_CONTEXT_TOKENS set. */
  budgetGuard: boolean;
  /** Paths carrying `linguist-generated` (scripts/prioritize_diff.py reads
   * them with `git check-attr`); ranked last when the diff is truncated. */
  generatedPaths?: ReadonlySet<string>;
}

export interface CorpusBuildResult {
  /** Every file the build wrote, keyed by the exact v2 filename; a later
   * write to the same name replaces the earlier one (last write wins). */
  artifacts: Map<string, Uint8Array>;
  /** The corpus file this build assembled (review-corpus.md or
   * review-corpus.smart.truncated.md). */
  outputName: string;
  /** True when the assembled corpus exceeded its context budget (v2 logs an
   * ERROR and returns 1; the caller aborts the review). The output is still
   * written before the guard fires, exactly like v2. */
  overBudget: boolean;
}

const BODY_FLOOR = 4100;
const STANDARDS_CAP_DEFAULT = 16000;
const DIFF_MARKER = "…[diff truncated to fit context budget]";
const FILES_MARKER = "…[file list truncated]";
const STANDARDS_MARKER = "…[standards truncated]";
const BODY_MARKER = "```\n …[review corpus truncated to fit the model context budget]";
const OFF_MODE_HARNESS_JSON =
  '{"mode":"off","planned_request_count":0,"executed_request_count":0,"tool_results":[]}\n';
const SMART_HARNESS_OMITTED =
  "Primary tool investigation omitted; conduct your own independent review.\n";

const enc = (text: string): Uint8Array => Buffer.from(text, "utf8");
const bytes = (value: Uint8Array | null | undefined): Uint8Array => value ?? new Uint8Array(0);
const nonEmpty = (value: Uint8Array | null | undefined): boolean =>
  value !== null && value !== undefined && value.length > 0;

function concat(...parts: Uint8Array[]): Uint8Array {
  return Buffer.concat(parts.map((part) => Buffer.from(part)));
}

function isNativeLoop(toolMode: string): boolean {
  return toolMode.toLowerCase() === "native_loop";
}

/** corpus.sh lines 122-140: standards-context.md is never empty — it carries
 * an explicit "unavailable" note when no file resolved — so it cannot double
 * as the presence signal the publish step needs; standards-present.txt is
 * that signal. */
export function prepareStandardsContext(
  standardsFile: string,
  standardsFileContent: Uint8Array | null,
): Map<string, Uint8Array> {
  const artifacts = new Map<string, Uint8Array>();
  if (standardsFileContent !== null) {
    artifacts.set(
      "standards-context.md",
      concat(
        enc(
          `# Repository Standards and Conventions\nDerived from ${standardsFile} for this repository.\n\n`,
        ),
        standardsFileContent,
      ),
    );
    artifacts.set("standards-present.txt", enc(`${standardsFile}\n`));
  } else if (standardsFile !== "") {
    artifacts.set("standards-context.md", enc(`(${standardsFile} not found; standards context unavailable.)\n`));
    artifacts.set("standards-present.txt", new Uint8Array(0));
  } else {
    artifacts.set(
      "standards-context.md",
      enc("(no standards file matched any candidate; standards context unavailable.)\n"),
    );
    artifacts.set("standards-present.txt", new Uint8Array(0));
  }
  return artifacts;
}

/** corpus.sh lines 142-182: tool-harness placeholder states. In native_loop
 * mode an empty/missing tool-harness.md gets the planning-pending marker (the
 * planner must see that the harness is pending, and a reused workspace can
 * carry an empty file from an earlier off-mode run); any other mode truncates
 * the markdown and writes the off-mode JSON — a stale JSON would otherwise
 * escalate a review that ran no tools and misattribute the previous run's
 * telemetry. The JSON existence fallback (lines 178-182) checks existence
 * only, not emptiness. */
export function prepareToolHarness(
  toolMode: string,
  existingMd: Uint8Array | null,
  existingJson: Uint8Array | null,
): Map<string, Uint8Array> {
  const artifacts = new Map<string, Uint8Array>();
  if (isNativeLoop(toolMode)) {
    if (!nonEmpty(existingMd)) {
      artifacts.set("tool-harness.md", enc("Tool harness planning pending.\n"));
    }
  } else {
    artifacts.set("tool-harness.md", new Uint8Array(0));
    artifacts.set("tool-harness.json", enc(OFF_MODE_HARNESS_JSON));
  }
  if (existingJson === null) {
    artifacts.set("tool-harness.json", enc(OFF_MODE_HARNESS_JSON));
  }
  return artifacts;
}

/** common.sh `gate_feature_for_forks`: when the PR is from a fork and the
 * feature's enable flag is not "true", write the skip artifacts and report
 * the feature as skipped. Fork gating cannot widen. */
export function gateFeatureForForks(
  enableFlag: string,
  isForkPr: string,
  mdContent: string,
  jsonContent: string,
): { skipped: boolean; artifacts: Map<string, Uint8Array> } {
  if (isForkPr === "true" && enableFlag.toLowerCase() !== "true") {
    const artifacts = new Map<string, Uint8Array>();
    artifacts.set("gate.md", enc(`${mdContent}\n`));
    artifacts.set("gate.json", enc(`${jsonContent}\n`));
    return { skipped: true, artifacts };
  }
  return { skipped: false, artifacts: new Map() };
}

/** corpus.sh `build_bounded_repo_map`: re-frame only, never truncate — the
 * renderer already cut the document to a body budget net of the framing
 * overhead (#599), so the cap is a verified invariant, not a truncation
 * point. A violation (stale/hand-edited artifact, renderer version skew) or
 * an unreadable document emits no map: graceful no-op, never partial data.
 * Decoding is strict/fatal UTF-8, matching v2's
 * `Path.read_text(encoding="utf-8")`: invalid bytes raise and degrade to an
 * empty `repo-map.capped.md` — never U+FFFD-replaced content that could
 * publish a corrupted map. */
export function buildBoundedRepoMap(repoMapMd: Uint8Array | null, repoMapMaxBytes: number): Uint8Array {
  if (repoMapMd === null || repoMapMd.length === 0) {
    return new Uint8Array(0);
  }
  let final: string;
  try {
    final = reframeForCorpus(strictUtf8Decode(repoMapMd));
  } catch {
    return new Uint8Array(0);
  }
  if (Buffer.byteLength(final, "utf8") <= repoMapMaxBytes) {
    return enc(final);
  }
  return new Uint8Array(0);
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

function strictUtf8Decode(data: Uint8Array): string {
  return strictUtf8.decode(data);
}

/** build_review_corpus (corpus.sh lines 212-463). */
export function buildReviewCorpus(
  ws: CorpusWorkspace,
  opts: CorpusBuildOptions,
): CorpusBuildResult {
  const artifacts = new Map<string, Uint8Array>();
  const write = (name: string, data: Uint8Array): void => {
    artifacts.set(name, data);
  };

  let maxCorpus = opts.maxCorpus;
  let outputName = "review-corpus.md";
  let diffFile = "pr.diff.truncated";
  let filesFile = "pr-files.truncated.json";
  let harnessFile = "tool-harness.md";

  // The initial review always owns the primary artifact slot; a directly
  // routed smart model only changes the context profile, not artifact names.
  if (opts.tier === "smart") {
    if (opts.slot === "smart") {
      outputName = "review-corpus.smart.truncated.md";
    }
    diffFile = "pr.diff.smart.truncated";
    filesFile = "pr-files.smart.truncated.json";
    // Smart rebuild: fresh truncation of the RAW sources under the smart
    // budgets — never a re-truncation of the primary's truncated artifacts.
    const diffOptions: PrioritizeDiffOptions = { marker: enc(DIFF_MARKER) };
    if (opts.generatedPaths !== undefined) diffOptions.generated = opts.generatedPaths;
    write(diffFile, prioritizeDiff(bytes(ws.prDiff), opts.diffBudget, diffOptions));
    write(filesFile, truncateClean(bytes(ws.prFilesJson), opts.filesBudget, FILES_MARKER));
    if (opts.slot === "smart") {
      harnessFile = "tool-harness.smart.md";
      if (!nonEmpty(ws.toolHarnessSmartMd) && nonEmpty(ws.toolHarnessMd)) {
        write("tool-harness.smart.md", enc(SMART_HARNESS_OMITTED));
      }
    }
  }
  write("repo-map.capped.md", buildBoundedRepoMap(ws.repoMapMd, opts.repoMapMaxBytes));

  const diffContent = opts.tier === "smart" ? artifacts.get(diffFile)! : bytes(ws.prDiffTruncated);
  const filesContent = opts.tier === "smart" ? artifacts.get(filesFile)! : bytes(ws.prFilesTruncatedJson);
  const harnessContent =
    harnessFile === "tool-harness.md"
      ? bytes(ws.toolHarnessMd)
      : artifacts.has(harnessFile)
        ? artifacts.get(harnessFile)!
        : bytes(ws.toolHarnessSmartMd);

  // Build non-standards body first (this is the portion subject to truncation).
  const body: Uint8Array[] = [];
  const push = (data: Uint8Array): void => {
    body.push(data);
  };
  /** header? + [```lang + content + ```]? + blank line. `content` carries the
   * exact bytes the v2 `cat`/command emitted (jq output includes its own
   * trailing newline; files do not necessarily end with one). */
  const pushSection = (header: string | undefined, content: Uint8Array, fenced?: string): void => {
    if (header !== undefined) push(enc(`${header}\n`));
    if (fenced !== undefined) push(enc(`\`\`\`${fenced}\n`));
    push(content);
    if (fenced !== undefined) push(enc("```\n"));
    push(enc("\n"));
  };

  pushSection("# Changed Manifest Context", bytes(ws.manifestContextMd));
  pushSection("# PR Metadata", prMetadataLine(ws.prJson), "json");
  pushSection(
    "# PR Classification",
    // A missing classification.json is the intentional unavailable-placeholder
    // path (v2 guards it with -f); a PRESENT but malformed one is a jq
    // failure and throws — production `set -euo pipefail` aborts the review.
    ws.classificationJson !== null
      ? classificationLine(ws.classificationJson)
      : enc("(Classification data unavailable for this review)\n"),
  );
  if (nonEmpty(ws.relatedCodeTruncatedMd)) {
    pushSection("# Related Code Context", bytes(ws.relatedCodeTruncatedMd));
  }
  if (nonEmpty(artifacts.get("repo-map.capped.md"))) {
    // repo-map.md carries its own trust-framed "# Repository Map" header.
    pushSection(undefined, artifacts.get("repo-map.capped.md")!);
  }
  if (nonEmpty(ws.prThreadMd)) {
    // pr-thread.md carries its own trust-framed header and is empty when no
    // comment survives filtering: hide the section entirely.
    pushSection(undefined, bytes(ws.prThreadMd));
  }
  if (nonEmpty(ws.reviewThreadsMd)) {
    // review-threads.md carries its own trust-framed header (#766) and is
    // empty when no unresolved thread fits: same gate.
    pushSection(undefined, bytes(ws.reviewThreadsMd));
  }
  if (nonEmpty(ws.linkedIssuesMd)) {
    // context.sh leaves linked-issues.md empty when there's no linked issue
    // so the model sees no section boundary to react to.
    pushSection("# Linked Issue Context", bytes(ws.linkedIssuesMd));
  }
  if (opts.ciChecksFile !== "" && nonEmpty(ws.ciChecksContent)) {
    // Exact-head external checks are authoritative evidence: ahead of the
    // bulky diff so a body-budget truncation cannot turn a completed check
    // into "not verified".
    pushSection("# CI Check Results", bytes(ws.ciChecksContent));
  }
  pushSection("# PR Files (truncated)", filesContent, "json");
  pushSection(
    "# Version Hints from Diff",
    ws.versionHintsTruncatedTxt !== null ? bytes(ws.versionHintsTruncatedTxt) : enc("(none)\n"),
    "text",
  );
  pushSection("# PR Diff (truncated)", diffContent, "diff");
  // High-value evidence comes BEFORE linked sources / repo scans so that when
  // the corpus overflows the budget, the noisy low-value sections at the tail
  // are dropped first instead of this evidence.
  if (nonEmpty(harnessContent)) {
    pushSection("# Tool Harness Findings", harnessContent);
  }
  if (nonEmpty(ws.evidenceProvidersMd)) {
    pushSection("# Evidence Providers", bytes(ws.evidenceProvidersMd));
  }
  pushSection("# Image Digest Provenance", bytes(ws.imageDigestContextMd));
  // Lowest-value sections last — first to be dropped on truncation.
  pushSection("# Linked Sources", bytes(ws.linkedSourcesMd));
  pushSection("# Repository Impact Scan", bytes(ws.repoImpactTruncatedMd));
  pushSection("# Repository History", bytes(ws.repoHistoryTruncatedMd));
  const bodyMd = concat(...body);
  write("review-corpus.body.md", bodyMd);

  // MAX_CORPUS is the total budget (standards + body + reserved ledger +
  // reserved specialist leads). Cap the standards section first, carve out
  // the reserved ledger and specialist-lead sections, then give the body the
  // remaining budget so a large standards file, ledger, or lead section can't
  // silently blow past the model's context window.
  let standardsCap = STANDARDS_CAP_DEFAULT;
  // Leave the body floor and framing room even for a small explicit window.
  if (standardsCap > maxCorpus - BODY_FLOOR) {
    standardsCap = maxCorpus - BODY_FLOOR;
  }
  write(
    "standards-context.capped.md",
    truncateClean(bytes(ws.standardsContextMd), standardsCap, STANDARDS_MARKER),
  );
  const standardsBytes = artifacts.get("standards-context.capped.md")!.length;

  // ── Explicit Requirement Ledger (#624) — reserved, like standards ─────
  // Rebuilt from scratch on EVERY assembly, exactly once: the header line +
  // the exact bytes of requirement-ledger.md + a trailing blank line. Its
  // size is subtracted from the body budget, so the body truncation can never
  // eat it — appended after the truncated body, never truncated itself. The
  // ledger content is already hard-capped by the renderer; the same
  // fits-sanity that gated the presence signal applies here, so signal and
  // section cannot diverge: a ledger that does not fit is dropped from both.
  let ledgerBytes = 0;
  if (nonEmpty(ws.requirementLedgerMd)) {
    const section = concat(
      enc("# Explicit Requirement Ledger\n"),
      bytes(ws.requirementLedgerMd),
      enc("\n"),
    );
    ledgerBytes = section.length;
  }
  if (ledgerBytes > 0 && ledgerBytes >= maxCorpus - standardsBytes - BODY_FLOOR) {
    ledgerBytes = 0;
  }
  write(
    "requirement-ledger.section.md",
    ledgerBytes > 0
      ? concat(enc("# Explicit Requirement Ledger\n"), bytes(ws.requirementLedgerMd), enc("\n"))
      : new Uint8Array(0),
  );

  // ── Specialist Review Leads (#609) — reserved, but LAST ─────────────────
  // Advisory leads appended after the truncated body and after the ledger,
  // never truncated themselves (whole-section granularity). Authority order
  // is deliberate: standards (first) > explicit requirement ledger >
  // advisory leads (last), so specialist content can never evict
  // higher-authority standards/ledger material. The same fits-sanity the
  // ledger applies (drop when it cannot fit a sane reservation) keeps this
  // assembly and the specialist runner's presence signal in lockstep.
  let specialistBytes = 0;
  if (nonEmpty(ws.specialistsMd)) {
    const candidate = bytes(ws.specialistsMd).length;
    if (candidate < maxCorpus - standardsBytes - ledgerBytes - BODY_FLOOR) {
      specialistBytes = candidate;
    }
  }

  // The header and separators are outside the truncated body; reserve their
  // exact bytes, including the newline after an appended specialist section.
  const framingBytes =
    Buffer.byteLength(`# Repository Standards and Conventions (${opts.standardsFile})\n\n`, "utf8") +
    (specialistBytes > 0 ? 1 : 0);
  let bodyBudget = maxCorpus - standardsBytes - ledgerBytes - specialistBytes - framingBytes;
  if (bodyBudget < 0) bodyBudget = 0;
  const bodyTruncated = truncateClean(bodyMd, bodyBudget, BODY_MARKER);
  write("review-corpus.body.truncated.md", bodyTruncated);

  // Prepend the (capped) standards section — first and highest-authority,
  // truncation-exempt — then the truncated body, then the reserved ledger
  // block, then the reserved specialist-lead block (#609) last: lowest
  // authority, appended after everything, never sliced by truncation.
  const output = concat(
    enc(`# Repository Standards and Conventions (${opts.standardsFile})\n`),
    artifacts.get("standards-context.capped.md")!,
    enc("\n"),
    bodyTruncated,
    artifacts.get("requirement-ledger.section.md")!,
    specialistBytes > 0 ? concat(bytes(ws.specialistsMd), enc("\n")) : new Uint8Array(0),
  );
  write(outputName, output);

  const overBudget = opts.budgetGuard && output.length > maxCorpus;

  // Lockstep guards: a non-empty presence signal must correspond to its
  // section in the final corpus. Unreachable by construction (the section's
  // bytes were carved out of the body budget above, and the shared
  // fits-sanity keeps signal and section in step), asserted defensively.
  if (opts.slot !== "smart") {
    const ledgerMarker = enc("# Explicit Requirement Ledger");
    if (nonEmpty(ws.requirementLedgerPresent) && indexOfSub(output, ledgerMarker) < 0) {
      write("requirement-ledger-present.txt", new Uint8Array(0));
    }
    const specialistMarker = enc("# Specialist Review Leads");
    if (nonEmpty(ws.specialistLeadsPresent) && indexOfSub(output, specialistMarker) < 0) {
      write("specialist-leads-present.txt", new Uint8Array(0));
    }
  }

  return { artifacts, outputName, overBudget };
}

function indexOfSub(haystack: Uint8Array, needle: Uint8Array): number {
  return Buffer.from(haystack).indexOf(Buffer.from(needle));
}

