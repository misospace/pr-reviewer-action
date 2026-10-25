import { parse as parseYaml } from "yaml";
import { ACTION_GATES } from "./action-gates.js";
import type { ActionSourceReadResult } from "./action-source.js";
import { MAX_ACTION_SOURCE_BYTES } from "./action-source.js";

/**
 * #1238/#1240: the witness for claims that name the CONSUMER-PINNED
 * revision of the action's own repository — the pinned revision, and
 * nothing else.
 *
 * The runner's environment pins the action step exactly:
 * `GITHUB_ACTION_REPOSITORY` ("owner/repo") and `GITHUB_ACTION_REF`
 * (a full commit SHA). This witness fetches the action's own `action.yml`
 * and the registry's gate implementation files at that exact commit
 * through the platform's validated read-only API seam — never the
 * reviewed workspace's filesystem, never a mutable ref. A tag, branch, or
 * short-SHA pin is mutable or ambiguous and admits no witness at all.
 *
 * It fails closed on every undecidable shape: a fetch that errors, a
 * response that is not a decodable file, and a decoded file over the byte
 * cap are all `unavailable`, never evidence for or against a claim. The
 * served set is registry constants only — the manifest plus every
 * `ACTION_GATES[].implementation` path — and the untrusted bytes it
 * serves (a fork's own repository content) can only ever decide claims
 * about themselves.
 */

/** The action slug shape: "owner/repo", GitHub's owner/repository charset. */
const ACTION_SLUG_RE = /^[a-z0-9._-]+\/[a-z0-9._-]+$/;

/** A full commit SHA: exactly 40 hex characters, lowercase. */
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

export interface PinnedActionRevision {
  repository: string;
  revision: string;
}

/**
 * The revision the runner pinned this run's action step to, or null.
 *
 * A witness exists only when `GITHUB_ACTION_REPOSITORY` is a well-formed
 * slug and `GITHUB_ACTION_REF` is a full 40-hex commit SHA (after
 * trim+lowercase): a tag, a branch, or a short SHA is a mutable or
 * ambiguous pin, and a claim naming a revision that can move must not be
 * decided. Never throws.
 *
 * Identity rule (the pinned sibling of the executing reader's `uses: ./`
 * refusal): when the pinned repository IS the repository under review
 * (`GITHUB_REPOSITORY`), the bytes the pin resolves to may be the PR's
 * own, so no witness — a reviewed-workspace commit must never decide a
 * refutation. The comparison is the lowercased slug form of both values.
 */
export function resolvePinnedActionRevision(env: NodeJS.ProcessEnv = process.env): PinnedActionRevision | null {
  const repository = env.GITHUB_ACTION_REPOSITORY;
  const ref = env.GITHUB_ACTION_REF;
  if (typeof repository !== "string" || typeof ref !== "string") return null;
  const repo = repository.trim().toLowerCase();
  if (!ACTION_SLUG_RE.test(repo)) return null;
  const reviewed = typeof env.GITHUB_REPOSITORY === "string" ? env.GITHUB_REPOSITORY.trim().toLowerCase() : "";
  if (reviewed !== "" && reviewed === repo) return null;
  const revision = ref.trim().toLowerCase();
  if (!FULL_SHA_RE.test(revision)) return null;
  return { repository: repo, revision };
}

/** The action's own manifest, as the platform's contents API names it. */
export const ACTION_MANIFEST_PATH = "action.yml";

/**
 * How many DISTINCT file reads one witness may perform through the API
 * seam. The served set is bounded by the registry; the cap keeps a
 * pathological registry growth from turning the witness into an unbounded
 * fetch loop.
 */
export const MAX_PINNED_ACTION_SOURCE_READS = 4;

/**
 * The only paths the witness may serve: the manifest plus every registry
 * implementation path. Both sides are registry constants — a path taken
 * from a finding, a model message, or any other untrusted input can never
 * enter this set.
 */
export function pinnedServedPaths(): ReadonlySet<string> {
  const set = new Set<string>([ACTION_MANIFEST_PATH]);
  for (const gate of ACTION_GATES) set.add(gate.implementation);
  return set;
}

/**
 * The platform's read-only contents-API seam, as the witness may call it:
 * one validated request per call, no method surface beyond that.
 */
export interface GhApiLike {
  (endpoint: string, opts?: { timeoutMs?: number }): Promise<{ data?: unknown; error?: string }>;
}

export interface CreatePinnedWitnessOptions {
  pinned: PinnedActionRevision;
  ghApi: GhApiLike;
}

/**
 * A witness over the consumer-pinned revision's own bytes. Structural
 * mirror of `PinnedActionWitness` in blocker-verification.ts.
 *
 * Every method fails closed: it can only return an `ok` result or an
 * `unavailable` reason (or null), never a throw, and everything it cannot
 * decide stays unknown instead of becoming a refutation.
 */
export interface PinnedActionSource {
  /** The pinned revision, lowercase, as given. */
  readonly revision: string;
  read(relativePath: string): Promise<ActionSourceReadResult>;
  /** The manifest's declared input names (lowercased), or null. */
  declaredInputs(): Promise<ReadonlySet<string> | null>;
}

/**
 * Decode one contents-API response into text, failing closed on every
 * shape it cannot prove: a non-object `data`, a non-file entry, missing
 * inline content (files >1 MB carry none), a base64 body that does not
 * round-trip, and a decode over the byte cap.
 */
function decodeContentsData(data: unknown): ActionSourceReadResult {
  if (data === null || data === undefined || typeof data !== "object" || Array.isArray(data)) {
    return { status: "unavailable", reason: "not-a-file" };
  }
  const record = data as Record<string, unknown>;
  if (record.type !== "file") return { status: "unavailable", reason: "not-a-file" };
  if (typeof record.content !== "string") return { status: "unavailable", reason: "content-missing" };
  // The inline content carries newlines (one per ~72 chars); strip ALL
  // whitespace before decoding, then require a clean round-trip so that
  // non-canonical padding or a truncated body can never masquerade as a
  // valid encode.
  const stripped = record.content.replace(/\s/g, "");
  // An EMPTY content string is how a served response can say "nothing
  // inline" without omitting the field; it must not read as a real, empty
  // file (which would silently decide nothing). Fail closed as missing.
  if (stripped === "") return { status: "unavailable", reason: "content-missing" };
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(stripped)) {
    return { status: "unavailable", reason: "invalid-response" };
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(stripped, "base64");
  } catch {
    return { status: "unavailable", reason: "invalid-response" };
  }
  if (decoded.toString("base64") !== stripped) {
    return { status: "unavailable", reason: "invalid-response" };
  }
  if (decoded.length > MAX_ACTION_SOURCE_BYTES) {
    return { status: "unavailable", reason: "too-large" };
  }
  return { status: "ok", text: decoded.toString("utf8") };
}

/**
 * A witness over the consumer-pinned revision's own `action.yml` and gate
 * implementation files, fetched at that exact commit through the
 * platform's validated read-only API seam.
 *
 * The fetch is one request per distinct path, cached per witness, and
 * bounded by `MAX_PINNED_ACTION_SOURCE_READS`; the revision is a full
 * content-addressed SHA, so the bytes fetched at `?ref=` cannot move
 * under the witness between the fetch and the decision.
 */
export function createPinnedActionWitness(options: CreatePinnedWitnessOptions): PinnedActionSource {
  const pinned = options.pinned;
  const ghApi = options.ghApi;
  const served = pinnedServedPaths();
  // Per-witness cache: a path is fetched at most once, whatever the
  // result, so a hostile or flaky endpoint cannot be hammered.
  const cache = new Map<string, ActionSourceReadResult>();
  let distinctFetched = 0;
  let manifestPromise: Promise<ReadonlySet<string> | null> | null = null;

  const read = async (relativePath: string): Promise<ActionSourceReadResult> => {
    try {
      if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.includes("\0")) {
        return { status: "unavailable", reason: "invalid-path" };
      }
      if (!served.has(relativePath)) return { status: "unavailable", reason: "not-served" };
      const cached = cache.get(relativePath);
      if (cached !== undefined) return cached;
      if (distinctFetched >= MAX_PINNED_ACTION_SOURCE_READS) {
        return { status: "unavailable", reason: "read-budget-exhausted" };
      }
      distinctFetched += 1;
      let result: ActionSourceReadResult;
      try {
        const response = await ghApi(
          `repos/${pinned.repository}/contents/${relativePath}?ref=${pinned.revision}`,
        );
        if (response === null || typeof response !== "object") {
          result = { status: "unavailable", reason: "fetch-error" };
        } else if (response.error !== undefined) {
          // The error text is untrusted response content: it is never
          // carried into the reason, only its presence is.
          result = { status: "unavailable", reason: "fetch-error" };
        } else {
          result = decodeContentsData(response.data);
        }
      } catch {
        result = { status: "unavailable", reason: "fetch-error" };
      }
      cache.set(relativePath, result);
      return result;
    } catch {
      // Fail closed on any unexpected failure of the witness itself.
      return { status: "unavailable", reason: "fetch-error" };
    }
  };

  const declaredInputs = (): Promise<ReadonlySet<string> | null> => {
    if (manifestPromise === null) {
      manifestPromise = (async () => {
        try {
          const manifest = await read(ACTION_MANIFEST_PATH);
          if (manifest.status !== "ok") return null;
          const doc = parseYaml(manifest.text);
          if (doc === null || doc === undefined || typeof doc !== "object" || Array.isArray(doc)) return null;
          const inputs = (doc as Record<string, unknown>).inputs;
          // Absent or null: the manifest declares no inputs — a positive
          // fact, so an empty set, not null.
          if (inputs === undefined || inputs === null) return new Set<string>();
          // Any other shape (string, array, number, boolean) is
          // undecidable: null.
          if (typeof inputs !== "object" || Array.isArray(inputs)) return null;
          const names = new Set<string>();
          for (const key of Object.keys(inputs as object)) names.add(String(key).toLowerCase());
          return names;
        } catch {
          return null;
        }
      })();
    }
    return manifestPromise;
  };

  return {
    revision: pinned.revision,
    read,
    declaredInputs,
  };
}
