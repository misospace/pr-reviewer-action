/** Run-scoped worker credential sets for #735: the explicit allowlist one
 * review run may draw on, and the late, all-or-nothing resolution that turns
 * it into live material at the final handoff.
 *
 * Two properties carry the issue's security requirements:
 *
 * - STRUCTURAL ISOLATION: the plan input takes exactly ONE model credential
 *   reference (the selected profile's) — a different model profile's
 *   credential is not filtered out at handoff, it is structurally impossible
 *   to include. The same one-slot discipline applies to every purpose. Fork
 *   policy is structural AND durable: the plan carries the
 *   `forkEvidencePolicy` it was built under, and `validateCredentialPlan`
 *   refuses a fork plan with policy `off` that carries an `evidence` entry —
 *   so the boundary holds wherever the plan is proven (builder, resolver, or
 *   any future consumer that validates a plan from durable state), not just
 *   at the moment of construction.
 * - LATE RESOLUTION: `buildWorkerCredentialPlan` handles names and
 *   references only — safe to build early and embed into durable state. The
 *   material exists only after `resolveWorkerCredentials`, which the
 *   controller calls at the last moment before the worker handoff, and which
 *   is ALL-OR-NOTHING: a worker is never handed a partial credential set
 *   (a run that cannot get its full allowlist fails before launch).
 *
 * The plan shape deliberately keeps the model credential a single swappable
 * named entry bound to the plan's claimed `modelProfileName`, so a future
 * #765 run-scoped gateway token can replace the direct model credential
 * without changing the `ExecutionRequest` contract or the engine's model
 * semantics — same name, different (gateway-scoped) reference.
 */
import {
  CREDENTIAL_REF_RE,
  CredentialPlanError,
  WORKER_CREDENTIAL_PURPOSES,
  isSecretShapedValue,
  validateCredentialPlan,
  type CredentialBroker,
  type CredentialRef,
  type ResolutionRefusalCode,
  type ResolutionRequest,
  type SecretPurpose,
  type WorkerCredentialPlan,
} from "./types.js";
import { type MintedResultChannelToken, type ResultChannelAuth } from "./result-channel.js";
import { createSecretRedactor, type SecretRedactor } from "./redact.js";

/** How the worker obtains its model access. `direct_worker` is the shipped
 * mode: the worker receives the selected profile's own credential. A future
 * gateway mode (#765) would mint a run-scoped gateway capability instead —
 * same plan slot, different reference — so this union exists as the seam,
 * with exactly one member today. */
export type WorkerModelMode = "direct_worker";

/** Input to the plan builder: the job/run identity plus the operator's
 * profile selection. Every credential field is an opaque REFERENCE from
 * operator configuration (`src/config/instance-config.ts`) — never an
 * inline secret. Empty-string forge/evidence references mean "this run does
 * not draw on that purpose" and produce no entry; the model reference is
 * REQUIRED in `direct_worker` mode — a review run without its model
 * credential must fail closed here, not launch half-credentialed. */
export interface WorkerCredentialPlanInput {
  readonly jobId: string;
  readonly runId: string;
  readonly platform: "github" | "forgejo";
  readonly repoFullName: string;
  readonly installationId: string;
  /** The producing job's fork flag. Fork policy: the `evidence` reference
   * is included ONLY when `allowForkEvidence` is true — private
   * enrichment/evidence credentials never reach a fork worker unless the
   * policy explicitly and safely permits it (#730/#725 fork trust
   * boundary). The decision is recorded in the plan's
   * `forkEvidencePolicy` so every later consumer enforces it too. */
  readonly fork: boolean;
  readonly modelMode: WorkerModelMode;
  /** The model profile the run claims ("" when the operator does not bind
   * model credentials per-profile). */
  readonly modelProfileName: string;
  /** The evidence profile the run claims ("" when none). */
  readonly evidenceProfileName: string;
  /** The selected model profile's credential reference. Required (non-empty)
   * in `direct_worker` mode. */
  readonly modelCredentialRef: string;
  /** The selected evidence profile's credential reference; "" when the run
   * uses no credentialed evidence provider. */
  readonly evidenceCredentialRef: string;
  /** The forge clone credential reference (short-lived repository/
   * installation read token); "" when acquisition already produced the
   * workspace controller-side. */
  readonly forgeCloneCredentialRef: string;
  /** The forge publish credential reference (repository-scoped write
   * identity); "" when publication happens controller-side. */
  readonly forgePublishCredentialRef: string;
  /** Whether the worker needs the run-scoped result-channel token. */
  readonly resultChannel: boolean;
  /** Fork evidence policy: see `fork`. Ignored (treated as false) for
   * non-fork jobs. */
  readonly allowForkEvidence: boolean;
}

/** The resolved worker credential set: name → live material, plus the
 * redactor that scrubs those values out of logs and artifacts. Built only
 * at the final handoff. The material is deliberately hard to serialize:
 * `JSON.stringify` on the set yields the credential NAMES only (via
 * `toJSON`), because the natural controller diagnostic of logging the set
 * must not become a secret dump. */
export interface WorkerSecretSet {
  readonly ok: true;
  readonly entries: readonly {
    readonly name: string;
    readonly material: { readonly value: string; readonly expiresAtMs: number };
  }[];
  /** Scrubber bound to exactly this run's material values. */
  readonly redactor: SecretRedactor;
  /** Serialization guard: the set JSON-stringifies to credential names
   * only, never material (mirror of the vault's no-serialization rule). */
  readonly toJSON: () => Record<string, unknown>;
}

/** A failed handoff: one credential in the allowlist refused, so the whole
 * set is withheld (fail closed — no partial handoff). */
export interface WorkerResolutionFailure {
  readonly ok: false;
  readonly name: string;
  readonly code: ResolutionRefusalCode;
  readonly reason: string;
}

const FIXED_PURPOSE_BY_NAME: ReadonlyMap<string, SecretPurpose> = new Map(
  Object.entries(WORKER_CREDENTIAL_PURPOSES),
);

/** Build the run-scoped worker credential plan: names + opaque references
 * only. Applies the structural isolation and fork policy rules; every
 * emitted entry passes the executor-compatible grammars. Throws
 * `CredentialPlanError` on any malformed input (fail closed — a mistake
 * here must never produce a quietly narrower allowlist). */
export function buildWorkerCredentialPlan(input: WorkerCredentialPlanInput): WorkerCredentialPlan {
  const credentials: CredentialRef[] = [];

  const add = (name: string, reference: string): void => {
    if (reference === "") return;
    if (!CREDENTIAL_REF_RE.test(reference)) {
      throw new CredentialPlanError(
        `worker credential plan: '${name}' reference must match the credential-reference grammar`,
      );
    }
    if (isSecretShapedValue(reference)) {
      throw new CredentialPlanError(
        `worker credential plan: '${name}' reference looks like secret material, not an opaque reference`,
      );
    }
    const purpose = FIXED_PURPOSE_BY_NAME.get(name);
    if (purpose === undefined) {
      throw new CredentialPlanError(`worker credential plan: unknown credential name '${name}'`);
    }
    credentials.push(Object.freeze({ name, reference }));
  };

  if (input.modelMode !== "direct_worker") {
    throw new CredentialPlanError("worker credential plan: unknown model mode");
  }
  if (input.modelCredentialRef === "") {
    // Fail closed: a review run without its selected model credential must
    // be refused at plan time, never launched half-credentialed.
    throw new CredentialPlanError(
      "worker credential plan: direct_worker mode requires a model credential reference",
    );
  }
  // Fork policy, structurally: the evidence slot is consulted only when the
  // run is not a fork, or when the operator policy explicitly permits fork
  // evidence. There is no code path that adds the evidence reference for a
  // fork run without passing through this decision — and the decision is
  // recorded in the plan, so validation enforces it later too.
  const includeEvidence = !input.fork || input.allowForkEvidence === true;
  const forkEvidenceAllowed = input.fork && input.allowForkEvidence === true;

  add("forge-clone", input.forgeCloneCredentialRef);
  add("forge-publish", input.forgePublishCredentialRef);
  add("model", input.modelCredentialRef);
  add("evidence", includeEvidence ? input.evidenceCredentialRef : "");
  if (input.resultChannel) {
    // The result-channel reference is run-scoped by construction: the
    // controller derives it from (runId, jobId), so it can only ever be
    // resolved for THIS correlation identity.
    add("result-channel", `result-channel:${input.runId}`);
  }

  return validateCredentialPlan({
    jobId: input.jobId,
    runId: input.runId,
    platform: input.platform,
    repoFullName: input.repoFullName,
    installationId: input.installationId,
    fork: input.fork,
    forkEvidencePolicy: forkEvidenceAllowed ? "allowed" : "off",
    modelProfileName: input.modelProfileName,
    evidenceProfileName: input.evidenceProfileName,
    credentials,
  });
}

/** LATE RESOLUTION: turn a plan into the live worker credential set, at the
 * last moment before handoff. Every vault entry is resolved against the
 * run's exact identity (including the plan's claimed profile names); the
 * run-scoped result-channel token is MINTED here from the controller's
 * result-channel authority (it is derived from the correlation identity,
 * not stored anywhere); ANY refusal withholds the whole set (returns the
 * failure) so a worker never launches with a partial allowlist. */
export async function resolveWorkerCredentials(
  broker: CredentialBroker,
  plan: WorkerCredentialPlan,
  opts: { resultChannel?: ResultChannelAuth } = {},
): Promise<WorkerSecretSet | WorkerResolutionFailure> {
  // Re-validate: a plan that arrived from durable state or across a
  // boundary is proven, not assumed — including the fork trust boundary and
  // the profile bindings the plan claims. A validation failure is a typed
  // handoff refusal (the caller owns the diagnosis), never an uncaught
  // throw from a function whose contract is the closed result union.
  let checked: WorkerCredentialPlan;
  try {
    checked = validateCredentialPlan(plan);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    return failure(
      "",
      "invalid_request",
      `credential plan is invalid: ${detail.slice(0, 200)}`,
    );
  }
  const entries: { name: string; material: { value: string; expiresAtMs: number } }[] = [];
  for (const ref of checked.credentials) {
    const purpose = FIXED_PURPOSE_BY_NAME.get(ref.name);
    if (purpose === undefined) {
      return failure(ref.name, "invalid_request", "credential name has no purpose mapping");
    }
    if (ref.name === "result-channel") {
      // The result-channel credential is not a vault secret: it is minted
      // per run from the controller's signing key and is useful only for
      // this correlation identity. A plan that requests it without a
      // configured authority fails closed.
      if (opts.resultChannel === undefined) {
        return failure(
          ref.name,
          "invalid_request",
          "result-channel credential requested but no result-channel authority is configured",
        );
      }
      const minted: MintedResultChannelToken = opts.resultChannel.mint({
        runId: checked.runId,
        jobId: checked.jobId,
        installationId: checked.installationId,
        repoFullName: checked.repoFullName,
      });
      entries.push({
        name: ref.name,
        material: Object.freeze({ value: minted.token, expiresAtMs: minted.expiresAtMs }),
      });
      continue;
    }
    const request: ResolutionRequest = Object.freeze({
      purpose,
      platform: checked.platform,
      installationId: checked.installationId,
      repoFullName: checked.repoFullName,
      profileName:
        ref.name === "model"
          ? checked.modelProfileName
          : ref.name === "evidence"
            ? checked.evidenceProfileName
            : "",
    });
    const result = await broker.resolve(ref.reference, request);
    if (!result.ok) {
      return failure(ref.name, result.code, result.reason);
    }
    entries.push({ name: ref.name, material: result.material });
  }
  let redactor: SecretRedactor;
  try {
    redactor = createSecretRedactor(entries.map((entry) => entry.material.value));
  } catch {
    // Typed failure, never an untyped throw: material too short to redact
    // reliably withholds the whole handoff. `name` is the "" sentinel —
    // the failure is about the set as a whole, not one credential entry.
    return failure(
      "",
      "invalid_request",
      "credential material cannot be redacted reliably (too short or contains the redaction marker)",
    );
  }
  const names = entries.map((entry) => entry.name);
  // The material value is defined NON-enumerable: `JSON.stringify` of the
  // set (via toJSON) or of any part of it yields names and expiries only —
  // the natural controller diagnostic of dumping the set can never become
  // a secret dump. The value stays readable for the handoff itself.
  const hardenedEntries = entries.map((entry) => {
    const material = {} as { value: string; expiresAtMs: number };
    Object.defineProperty(material, "value", {
      value: entry.material.value,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    Object.defineProperty(material, "expiresAtMs", {
      value: entry.material.expiresAtMs,
      enumerable: true,
      writable: false,
      configurable: false,
    });
    return Object.freeze({ name: entry.name, material: Object.freeze(material) });
  });
  return Object.freeze({
    ok: true as const,
    entries: Object.freeze(hardenedEntries),
    redactor,
    toJSON(): Record<string, unknown> {
      return { ok: true, credentialNames: names };
    },
  });
}

function failure(
  name: string,
  code: WorkerResolutionFailure["code"],
  reason: string,
): WorkerResolutionFailure {
  return Object.freeze({ ok: false as const, name, code, reason });
}
