import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

/**
 * #1238: the WORKFLOW-side witness for the input-declaration boundary.
 *
 * The action-side witnesses (`action.yml`'s embedded contract and the
 * executing action's own implementation tree) speak for what the ACTION
 * declares. They say nothing about the other half of the mapping: the input
 * names the REVIEWED repository's workflow actually passes to the action.
 * A claim about that half — "the workflow's credential input is named
 * `ai-key`, so GitHub drops the credential" — is about the reviewed
 * repository's own workflow files, read at the EXACT reviewed head.
 *
 * The witness is PER FILE and speaks ONLY FROM POSITIVE EVIDENCE. For
 * every reviewed-repository workflow file this reader could read
 * COMPLETELY (the blob was fetched whole and the YAML parsed) AND that
 * contains at least one step invoking the action under review, it reports
 * the lowercased `with:` input names those DIRECT action steps pass. A
 * file whose action step passes no input at all gets an entry with an
 * EMPTY name set.
 *
 * The witness CORROBORATES; it NEVER REFUTES. It grounds a workflow-scoped
 * claim about the mapping when the cited file's direct action step passes
 * that name, and it says NOTHING about the mapping otherwise. The reader
 * sees only the DIRECT action steps of a file, so "this file does not
 * pass X" is NOT an absence the reader can establish: a local composite
 * action, a reusable workflow or a remote composite can pass an input name
 * to the action through a surface the reader never sees. An uncorroborated
 * claim therefore stays undecided — never refuted — and the review fails
 * closed on it.
 *
 * The boundary anchors the witness to the file the FINDING itself cited: a
 * file with no entry (never read whole, unparsable, or without a direct
 * action step) is a file the witness says NOTHING about, so the claim
 * there stays undecided. The same holds for a finding whose message names
 * a DIFFERENT workflow file: the witness speaks for the finding's own
 * cited file only.
 *
 * This module is the sibling of `action-source.ts` and keeps its posture:
 * read-only, offline, bounded, argv-only, and fail-closed. Every path it
 * reads comes from git's own listing of the reviewed revision — never from
 * a finding, a model message, or any other untrusted text — and a file it
 * could not read or parse contributes NO ENTRY rather than a partial view
 * of itself. The review pipeline therefore behaves exactly as it does
 * today whenever this witness is unavailable.
 */
export type WorkflowInputNamesByFile = ReadonlyMap<string, ReadonlySet<string>>;

export interface WorkflowInputReaderOptions {
  /** The REVIEWED repository's checkout path. */
  workspace: string;
  /** The exact reviewed head (40/64 hex). Anything else is no witness. */
  revision: string | null | undefined;
  /** "owner/repo" of the action under review — the join key between the
   * reviewed repository's workflows and the action they invoke. */
  actionSlug: string | null | undefined;
  /** Per-git-invocation timeout in seconds. */
  timeoutSec?: number;
  /** Upper bound on the workflow files one read parses. */
  maxFiles?: number;
  /** Upper bound on the bytes one workflow file may contribute. */
  maxBytes?: number;
}

/**
 * Upper bound on the workflow files one read parses. GitHub's own workflow
 * directory holds a handful of files; the cap keeps a repository that
 * commits thousands of workflow-shaped files from turning the boundary into
 * a subprocess farm.
 */
export const MAX_WORKFLOW_FILES = 64;
/**
 * Upper bound on the bytes one workflow file may contribute. Workflow files
 * are kilobytes; the cap keeps a pathological file from becoming a memory
 * sink. A file over the cap is skipped (unknown evidence), never fatal.
 */
export const MAX_WORKFLOW_FILE_BYTES = 256 * 1024;
/**
 * Upper bound on the tree listing one read pulls. A repository with a very
 * large tree listing fails the read — which is no witness, not an absence.
 */
const MAX_TREE_LISTING_BYTES = 4 * 1024 * 1024;
const DEFAULT_GIT_TIMEOUT_SEC = 10;

/**
 * The workflow directories the reviewed repository's forge runs, and the
 * DIRECT children of them that are workflow files.
 *
 * Only a direct child counts: GitHub executes nothing nested deeper, so a
 * nested file's `with:` keys are not evidence of what the runner passes.
 * The Gitea and Forgejo workflow directories are included so the witness
 * does not depend on the forge the review runs against — the product is
 * forge agnostic, and the reviewed repository's workflow shape is the same
 * claim either way.
 */
const WORKFLOW_PATH_RE = /^(?:\.github|\.gitea|\.forgejo)\/workflows\/[^/]+\.(?:yml|yaml)$/i;

/**
 * The YAML merge key. The parser resolves it when the merge source is a
 * map (`merge: true`); a `<<` that survives parsing means the `with:`
 * block's names are only PART of what the runner passes.
 */
const YAML_MERGE_KEY = "<<";


/**
 * The shape of an action slug: "owner/repo", with the character set GitHub
 * allows in an owner and a repository name. Anything else is not a slug,
 * and a slug that is not a slug matches no workflow step.
 */
const ACTION_SLUG_RE = /^[a-z0-9._-]+\/[a-z0-9._-]+$/;

/**
 * A tree path this reader is willing to hand to git. The paths come from
 * git's own listing, but a crafted tree object can carry a path git itself
 * would refuse to check out (".." segments, a leading "-", a backslash).
 * The shape check keeps such a path out of the argv and out of the reader.
 */
function safeWorkflowPath(path: string): boolean {
  if (path === "") return false;
  if (path.length > 512) return false;
  if (path.startsWith("-")) return false;
  if (path.includes("\0") || path.includes("\\")) return false;
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  return WORKFLOW_PATH_RE.test(path);
}

/**
 * Run one git command with a fixed argv. Returns null on ANY failure:
 * a missing binary, a timeout, an unreadable object, an oversized buffer —
 * all of them are "no evidence", never "the file is absent".
 */
function runGit(args: readonly string[], workspace: string, timeoutSec: number, maxBuffer: number): Buffer | null {
  try {
    return execFileSync("git", [...args], {
      cwd: workspace,
      timeout: timeoutSec * 1000,
      maxBuffer,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

/** A workflow step, reduced to the two fields the witness reads. */
interface WorkflowStep {
  uses: string;
  withKeys: readonly string[];
}

/**
 * The steps of a parsed workflow, read defensively: `jobs` may be absent or
 * malformed, and a step may be a scalar. Nothing here throws.
 *
 * `mergeKey` reports that a step's `with:` block STILL carries a YAML merge
 * key (`<<`) after parsing. A merge key that survived parsing means the
 * block's input names are only PART of what the runner passes — the rest
 * arrives through the merged source the parser could not resolve — so the
 * FILE is not readable for the witness and contributes no entry.
 */
function workflowSteps(parsed: unknown): { steps: readonly WorkflowStep[]; mergeKey: boolean } {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { steps: [], mergeKey: false };
  const jobs = (parsed as Record<string, unknown>).jobs;
  if (typeof jobs !== "object" || jobs === null || Array.isArray(jobs)) return { steps: [], mergeKey: false };
  const steps: WorkflowStep[] = [];
  let mergeKey = false;
  for (const job of Object.values(jobs as Record<string, unknown>)) {
    if (typeof job !== "object" || job === null || Array.isArray(job)) continue;
    const jobSteps = (job as Record<string, unknown>).steps;
    if (!Array.isArray(jobSteps)) continue;
    for (const raw of jobSteps) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
      const step = raw as Record<string, unknown>;
      if (typeof step.uses !== "string") continue;
      const withKeys: string[] = [];
      const withBlock = step.with;
      if (typeof withBlock === "object" && withBlock !== null && !Array.isArray(withBlock)) {
        for (const key of Object.keys(withBlock as Record<string, unknown>)) {
          // A merge key that survived parsing: the `with:` block is a
          // PARTIAL view of what the runner passes, so the file is not
          // readable for the witness.
          if (key === YAML_MERGE_KEY) mergeKey = true;
          withKeys.push(key);
        }
      }
      steps.push({ uses: step.uses, withKeys });
    }
  }
  return { steps, mergeKey };
}

/**
 * Does this step invoke the action under review?
 *
 * A workflow names the action as "owner/repo@ref" (or "owner/repo" when it
 * pins no ref), so the slug is the part before the FIRST "@" — or the whole
 * string when there is none. The comparison is case-insensitive: repository
 * and owner names are not case sensitive.
 */
function stepUsesAction(uses: string, slug: string): boolean {
  const at = uses.indexOf("@");
  const named = at === -1 ? uses : uses.slice(0, at);
  return named.trim().toLowerCase() === slug;
}

/**
 * The workflow input names the reviewed repository passes to the action,
 * per reviewed-repository file, at the exact reviewed head — or null when
 * there is no witness.
 *
 * "No witness" covers every failure: no slug, no exact revision, a
 * revision the workspace's object DB does not hold, an unreadable tree
 * listing, and — the ordinary case — a repository whose workflows never
 * invoke the action under review. The caller then keeps the pre-witness
 * behavior unchanged.
 *
 * The returned map holds one entry per workflow file that was read
 * completely, parsed, and found to invoke the action directly. A file that
 * was skipped contributes NO entry: the witness never carries a partial
 * view of a file it could not read whole, and a `with:` block that still
 * carries a YAML merge key after parsing is exactly such a partial view.
 */
export async function readWorkflowInputNamesByFile(
  options: WorkflowInputReaderOptions,
): Promise<WorkflowInputNamesByFile | null> {
  const slug = typeof options.actionSlug === "string" ? options.actionSlug.trim().toLowerCase() : "";
  if (!ACTION_SLUG_RE.test(slug)) return null;
  const revision = typeof options.revision === "string" ? options.revision.trim().toLowerCase() : "";
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision)) return null;
  const workspace = typeof options.workspace === "string" ? options.workspace.trim() : "";
  if (workspace === "") return null;
  const timeoutSec = options.timeoutSec ?? DEFAULT_GIT_TIMEOUT_SEC;
  const maxFiles = options.maxFiles ?? MAX_WORKFLOW_FILES;
  const maxBytes = options.maxBytes ?? MAX_WORKFLOW_FILE_BYTES;
  if (maxFiles <= 0 || maxBytes <= 0) return null;

  // Pre-flight: the SHA must resolve to a commit in THIS workspace's object
  // DB. A well-formed hex SHA does not prove that commit is local — without
  // this check a non-repository workspace, a corrupt object DB, or a SHA
  // that simply does not exist in this checkout all surface as the same
  // failure, and the reader would have to guess whether the workflows it
  // did not read exist.
  if (runGit(["cat-file", "-e", `${revision}^{commit}`], workspace, timeoutSec, 1_000_000) === null) return null;

  const listing = runGit(["ls-tree", "-r", "-z", "--name-only", revision], workspace, timeoutSec, MAX_TREE_LISTING_BYTES);
  if (listing === null) return null;

  const candidates: string[] = [];
  for (const record of listing.toString("utf8").split("\0")) {
    if (record === "") continue;
    if (!safeWorkflowPath(record)) continue;
    // The file-count bound keeps the FIRST files in git's (sorted) listing:
    // the order is deterministic, so the witness does not depend on the
    // order in which the tree happens to be walked.
    if (candidates.length >= maxFiles) break;
    candidates.push(record);
  }

  const byFile = new Map<string, ReadonlySet<string>>();
  for (const path of candidates) {
    // A file that cannot be read WHOLE (unreadable blob, oversize) is
    // skipped: it contributes no entry, never a partial view of itself.
    const content = runGit(["show", `${revision}:${path}`], workspace, timeoutSec, maxBytes);
    if (content === null) continue;
    let parsed: unknown;
    try {
      // A workflow that does not parse is skipped, never fatal: one broken
      // file must not blind the witness to the rest of the repository. The
      // parser's alias budget and the silent log level keep a hostile
      // document from expanding without bound or writing to the action's
      // stderr. `merge: true` resolves the YAML merge key (`<<`) so a
      // `with:` block that inherits its input names from an anchor reports
      // the REAL names the runner passes.
      parsed = parseYaml(content.toString("utf8"), { merge: true, logLevel: "silent" });
    } catch {
      continue;
    }
    const { steps, mergeKey } = workflowSteps(parsed);
    // A `with:` block that STILL carries a merge key after parsing is a
    // PARTIAL view of what the runner passes: the file is not readable for
    // the witness and contributes NO entry (never a partial view of
    // itself).
    if (mergeKey) continue;
    const names = new Set<string>();
    let invokesAction = false;
    for (const step of steps) {
      if (!stepUsesAction(step.uses, slug)) continue;
      invokesAction = true;
      // Only the NAMES are evidence. A `with:` VALUE is untrusted data: it
      // is never interpreted, never parsed as YAML, and never compared to
      // anything — a value can neither add an input name nor fake a step.
      for (const key of step.withKeys) names.add(key.toLowerCase());
    }
    // No DIRECT step invoking the action: this file says nothing about
    // what the runner passes to the action (a composite action or a
    // reusable workflow may do that instead), so it contributes no entry.
    if (!invokesAction) continue;
    byFile.set(path, names);
  }

  // No entry anywhere: the repository's workflows never invoke the action
  // under review, so there is nothing for the boundary to decide with.
  if (byFile.size === 0) return null;
  return byFile;
}

/**
 * The slug of the action THIS run executes: the runner's
 * `GITHUB_ACTION_REPOSITORY` ("owner/repo"), a standard runner variable.
 *
 * It is the identity the reviewed repository's workflow writes in its
 * `uses:` line, so it is the join key between the two sides of the
 * mapping. Absent, blank, or malformed, there is no witness: the reader
 * cannot know which action the workflows invoke.
 */
export function resolveActionSlug(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.GITHUB_ACTION_REPOSITORY;
  if (typeof raw !== "string") return null;
  const slug = raw.trim().toLowerCase();
  if (!ACTION_SLUG_RE.test(slug)) return null;
  return slug;
}
