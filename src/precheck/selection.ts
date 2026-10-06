import type { PlatformAdapter } from "../platform/types.js";
import { deriveIsFork } from "../platform/pr.js";
import { canonicalLinkedIssue, type LinkedIssue } from "../context/types.js";
import { acceptedLinkedIssues, extractLinkedIssueRefs, type LinkedIssueFetchResult, type LinkedIssueRef } from "./linked-issues.js";
import { collectFromPr, extractIssueIdentifiers, parsePrefixes } from "./linear.js";
import { pythonJsonStringify } from "./metadata.js";
import { createHash } from "node:crypto";

/** Build the #633 auto-selection signature for stale-review detection
 * (#674) — TS port of `scripts/build_selection_fingerprint.py`.
 *
 * `deep_review=auto` picks specialist roles partly from inputs the diff
 * fingerprint cannot see: linked-issue labels and Linear state. This hashes
 * every non-diff selection input through the platform adapter's own
 * validated seam (no second interpretation) and folds it into the
 * config-hash half of the broad fingerprint.
 *
 * CONSERVATIVE FAILURE: the signature is null unless EVERY required input
 * was determined. A failed PR fetch, ANY failed linked-issue label fetch,
 * or a failed Linear fetch (when Linear can affect classification) means
 * the selection inputs are UNKNOWN — unknown inputs must never be omitted
 * into a diff-unchanged skip. The caller exports a per-run-unique
 * `unavailable-…` sentinel that cannot match a stored marker, forcing a
 * fresh review; a persistently unfetchable linked issue re-reviews every
 * run — by design. */

function unwrap(response: unknown): unknown {
  if (typeof response === "object" && response !== null && !Array.isArray(response)) {
    const record = response as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] === "data") return record.data;
  }
  return response;
}

export interface SelectionSignatureResult {
  signature: string | null;
  error: string;
}

export interface SelectionOptions {
  linearIssuePrefixes?: string | undefined;
  linearApiKey?: string | undefined;
  linearEnableForForks?: string | undefined;
  linearTimeoutSec?: number | undefined;
  fetchImpl?: import("../platform/http.js").FetchLike | undefined;
  /** Injected Linear collector — the mirror of v2's `linear_collect`
   * injection in `build_signature`; tests supply a fixture-driven collector
   * instead of the network GraphQL call. */
  linearCollect?: typeof collectFromPr | undefined;
}

export async function buildSelectionSignature(
  repo: string,
  prNumber: string,
  adapter: PlatformAdapter,
  options: SelectionOptions = {},
): Promise<SelectionSignatureResult> {
  const pr = unwrap(await adapter.ghApi(`repos/${repo}/pulls/${prNumber}`));
  if (typeof pr !== "object" || pr === null || Array.isArray(pr) || (pr as Record<string, unknown>).error) {
    const message = typeof pr === "object" && pr !== null && !Array.isArray(pr)
      ? String((pr as Record<string, unknown>).error ?? "unusable response")
      : "unusable response";
    return { signature: null, error: `pr fetch failed: ${message}` };
  }
  const record = pr as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title : "";
  const body = typeof record.body === "string" ? record.body : "";

  const issues: { ref: string; repo: string; number: number; labels: string[] }[] = [];
  // Shares acceptedLinkedIssues with buildLinkedIssueContext (#872
  // cross-stage fix): both stages MUST apply the identical accepted-issue
  // cap (a title ref that resolves to a pull request must not consume one
  // of the 8 slots here any more than it does over there), over the same
  // canonically deduped candidate set (a bare `#N` and an explicit
  // same-repo `owner/repo#N` are already merged into one entry upstream, so
  // duplicates never perturb the hashed signature).
  const fetchIssue = async (issueRepo: string, number: number): Promise<LinkedIssueFetchResult> => {
    const fetched = unwrap(await adapter.ghApi(`repos/${issueRepo}/issues/${number}`));
    if (typeof fetched === "object" && fetched !== null && !(fetched as Record<string, unknown>).error) {
      return { ok: true, data: fetched };
    }
    const error = typeof fetched === "object" && fetched !== null && (fetched as Record<string, unknown>).error
      ? String((fetched as Record<string, unknown>).error)
      : "unusable response";
    return { ok: false, error };
  };
  for await (const outcome of acceptedLinkedIssues(extractLinkedIssueRefs(body, repo, title), fetchIssue)) {
    if (outcome.kind === "fetch_failed") {
      // Unknown labels cannot be omitted into a skip: fail the build so the
      // caller forces a fresh review.
      return { signature: null, error: `linked issue ${outcome.ref.ref} fetch failed: ${outcome.error}` };
    }
    if (outcome.kind === "accepted") {
      issues.push(signatureLinkedIssue(outcome.ref, canonicalLinkedIssue(outcome.data, outcome.ref.repo)));
    }
    // A "pull_request_skip" outcome is deliberately NOT recorded here, not
    // even by identity: its content (and any labels fetched to determine
    // it's a PR) must never perturb the signature, so a label change on the
    // rejected pull request itself is inert.
  }

  const linearState = await linearStateFor(title, {
    isFork: deriveIsFork(pr),
    options,
  });
  if (linearState.error) return { signature: null, error: linearState.error };

  // The payload serialization must match Python's
  // `json.dumps(..., sort_keys=True, ensure_ascii=False)` byte for byte, so
  // the resulting hashes stay identical to v2 (pinned by precheck.test.ts).
  const payload = pythonJsonStringify({
    title,
    body,
    linked_issues: issues,
    linear_issues: linearState.issues,
  });
  const digest = createHash("sha256").update(payload, "utf8").digest("hex");
  return { signature: `sha256:${digest}`, error: "" };
}

// ---------------------------------------------------------------------------
// Selection-signature serialization boundary (snake_case, hashed byte form)
// ---------------------------------------------------------------------------

/** The signature payload shapes are v2-identical serialization boundaries:
 * the v2 builder (`scripts/build_selection_fingerprint.py`) hashes the
 * identical `json.dumps(sort_keys=True)` payload, so these converters are the
 * EXPLICIT canonical→boundary mapping — the internal types stay camelCase
 * (#669) and the hashed bytes stay byte-equivalent. */

/** Boundary shape for one GitHub linked issue: identity comes from the
 * extracted reference (v2 hashes the raw `#N` / `owner/repo#N` text), the
 * labels come from the canonical issue with v2's `_labels_of` semantics
 * (trim, drop empties, sort). */
function signatureLinkedIssue(
  ref: LinkedIssueRef,
  issue: LinkedIssue,
): { ref: string; repo: string; number: number; labels: string[] } {
  return {
    ref: ref.ref,
    repo: ref.repo,
    number: ref.number,
    labels: issue.labels.map((label) => label.name.trim()).filter((name) => name !== "").sort(),
  };
}

/** Boundary shape for one Linear issue (v2 `_linear_state`): the identifier
 * is the canonical ref, the native priority is hashed verbatim (classifier
 * maps 1→priority/p0, 2→priority/p1), label names are taken as-is (no trim)
 * when non-empty, sorted. */
function signatureLinearIssue(issue: LinkedIssue): { identifier: string; priority: number | null; labels: string[] } {
  return {
    identifier: issue.ref,
    priority: issue.priority,
    labels: issue.labels.filter((label) => label.name !== "").map((label) => label.name).sort(),
  };
}

async function linearStateFor(
  title: string,
  context: { isFork: boolean; options: SelectionOptions },
): Promise<{ issues: { identifier: string; priority: number | null; labels: string[] }[]; error: string }> {
  const prefixesRaw = (context.options.linearIssuePrefixes ?? "").trim();
  const apiKey = (context.options.linearApiKey ?? "").trim();
  if (!prefixesRaw || !apiKey) return { issues: [], error: "" };
  const forksAllowed = (context.options.linearEnableForForks ?? "").trim().toLowerCase() === "true";
  if (context.isFork && !forksAllowed) {
    // Fail-closed: a fork PR must not query private Linear data unless
    // explicitly opted in — the same semantics as the review pipeline's
    // Linear gate, so the fingerprint fetches exactly what the pipeline
    // would.
    return { issues: [], error: "" };
  }
  let prefixes: string[];
  try {
    prefixes = parsePrefixes(prefixesRaw);
  } catch (error) {
    return { issues: [], error: `linear prefixes invalid: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!extractIssueIdentifiers(title, prefixes).length) return { issues: [], error: "" };
  const collect = context.options.linearCollect ?? collectFromPr;
  try {
    const { issues, errors } = await collect(
      title,
      prefixes,
      apiKey,
      {
        timeout: context.options.linearTimeoutSec ?? 20,
        ...(context.options.fetchImpl !== undefined ? { fetchImpl: context.options.fetchImpl } : {}),
      },
    );
    if (errors.length) {
      const [identifier, message] = errors[0]!;
      return { issues: [], error: `linear fetch failed for ${identifier}: ${message}` };
    }
    return {
      issues: issues.map(signatureLinearIssue),
      error: "",
    };
  } catch (error) {
    return { issues: [], error: `linear fetch failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
