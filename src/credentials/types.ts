/** Credential broker contracts for #735: the handoff boundary between the
 * long-lived controller and the short-lived review workers.
 *
 * The rule this module enforces: a worker receives ONLY the credentials the
 * current review needs, for the shortest practical lifetime, and everything
 * that crosses the boundary into durable state is an OPAQUE REFERENCE — the
 * material itself is resolved as late as possible, controller-side or at the
 * final handoff, and never serialized.
 *
 * Controller-only credentials (GitHub App private key, global admin tokens,
 * database credentials, controller signing keys, unrelated model credentials)
 * never enter this boundary at all: they live in the controller process, and
 * the short-lived material the controller mints FROM them is what a worker
 * may ever see.
 *
 * Like `ReviewJob`, `JobRecord`, and `ExecutionRequest`, every contract field
 * is required with an explicit sentinel (""/0/false) instead of an optional,
 * so consumers never branch on `undefined`. No runtime I/O lives here.
 */

/** What a credential is FOR. The closed purpose union drives scope binding:
 * a credential minted for one purpose can never satisfy a request for
 * another, even inside the same repository and installation. */
export type SecretPurpose =
  | "forge_clone"
  | "forge_publish"
  | "model"
  | "evidence"
  | "result_channel";

/** The scope dimensions a stored credential can be bound to (or explicitly
 * declared unscoped on — see `SecretScope`). */
export type ScopeDimension =
  | "platform"
  | "installationId"
  | "repoFullName"
  | "profileName";

/** The live secret material a worker is handed. `value` belongs in the
 * worker's runtime environment (or the outbound auth header) and nowhere
 * else: never argv, never a URL, never a durable payload, never a log line
 * (see `redact.ts` for the scrubber that enforces the last of those). */
export interface SecretMaterial {
  readonly value: string;
  /** Epoch ms after which the material must not be handed out again;
   * 0 = the material does not expire within the broker's horizon (the
   * SOURCE still owns its real lifetime — the broker only bounds reuse). */
  readonly expiresAtMs: number;
}

/** The identity a stored secret is bound to. The binding rule is
 * ONE-DIRECTIONAL and default-deny:
 *
 * - A dimension NOT listed in `unscopedDimensions` is BOUND: its field must
 *   be non-empty, and a resolution request satisfies it only when the
 *   request's field equals it exactly. A credential bound to installation A
 *   can never serve installation B; a credential bound to model profile A
 *   can never serve profile B.
 * - A dimension LISTED in `unscopedDimensions` is an EXPLICIT operator
 *   declaration that the credential is not restricted on that dimension:
 *   its field must be `""`, and the request's value is accepted whatever it
 *   is. An omitted/blank field with no declaration is a CONSTRUCTION ERROR,
 *   never a silent unrestricted grant — the blank-template typo that would
 *   otherwise turn a bound token into a global one fails closed.
 *
 * Purpose is ALWAYS exact and never declarable unscoped. This is the
 * multi-installation / cross-repo / cross-profile isolation mechanism
 * (#735). */
export interface SecretScope {
  readonly platform: "" | "github" | "forgejo";
  readonly installationId: string;
  readonly repoFullName: string;
  /** The model/evidence profile identity the credential belongs to; bound
   * credentials carry the profile name from operator config, forge and
   * result-channel credentials declare this dimension unscoped. */
  readonly profileName: string;
  readonly purpose: SecretPurpose;
  readonly unscopedDimensions: readonly ScopeDimension[];
}

/** The identity a resolution is asked to satisfy, taken from the run/job
 * context the caller is acting on — the broker never infers it. */
export interface ResolutionRequest {
  readonly purpose: SecretPurpose;
  readonly platform: "" | "github" | "forgejo";
  readonly installationId: string;
  readonly repoFullName: string;
  /** The model/evidence profile the run claims to use; "" for purposes
   * that have no profile dimension. */
  readonly profileName: string;
}

/** Why a resolution refused, as a closed union. Every refusal is
 * deterministic and explainable from the stored binding — a hostile caller
 * cannot distinguish "secret does not exist" from "secret exists but is
 * bound elsewhere" beyond what these codes already reveal, and no refusal
 * ever carries material. */
export type ResolutionRefusalCode =
  | "unknown_reference"
  | "expired"
  | "revoked"
  | "scope_mismatch"
  | "invalid_request";

/** The discriminated answer every resolution returns. A failure reason is
 * always a FIXED, bounded string — never a URL, a response body, or any
 * credential material (the same no-echo discipline as
 * `src/ingress/github-app-auth.ts`). */
export type ResolveResult =
  | { readonly ok: true; readonly material: SecretMaterial }
  | { readonly ok: false; readonly code: ResolutionRefusalCode; readonly reason: string };

/** The broker seam (#735). The controller-side implementation resolves
 * opaque references to short-lived material; the reference grammar keeps the
 * surface compatible with `ExecutionRequest.credentials` (#733), whose
 * contract already documents "the #735 credential broker resolves references
 * operator-side — no material ever crosses that boundary". */
export interface CredentialBroker {
  /** Resolve an opaque reference for the given request identity. Fails
   * closed: an unknown reference, an expired/revoked one, or one bound to a
   * different scope refuses rather than degrades. */
  resolve(reference: string, request: ResolutionRequest): Promise<ResolveResult>;
  /** Revoke a live reference (idempotent). Returns true when a live entry
   * was revoked; false when the reference was unknown or already dead. */
  revoke(reference: string): boolean;
  /** Reference names held by this broker — for diagnostics only. Never
   * material, never scope detail. */
  describe(): readonly string[];
}

/** Credential-reference grammar: mirrors the instance-config
 * `CREDENTIAL_REF_RE` shape and the executor's `EXECUTION_CREDENTIAL_REF_RE`
 * shape — the same opaque token all three contracts exchange. Defined here
 * (not imported) so the credentials package stays decoupled from the
 * executor and config packages; the regexes are textually identical and any
 * drift is caught by the cross-package tests. */
export const CREDENTIAL_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Execution-id grammar for run/job ids on the result channel: mirrors the
 * executor's `EXECUTION_ID_RE` (bounded, filename-safe identity). Defined
 * locally for the same decoupling reason as `CREDENTIAL_REF_RE`. */
export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Profile-name grammar: the bounded identity a credential can be bound to
 * (or a run can claim). Empty string = "no profile dimension" and is only
 * legal where the purpose has none or the binding declares the dimension
 * unscoped. */
export const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidProfileName(value: string): boolean {
  return value === "" || PROFILE_NAME_RE.test(value);
}

export function isValidCredentialRef(value: string): boolean {
  return CREDENTIAL_REF_RE.test(value) && !isSecretShapedValue(value);
}

/** Screen against the obvious secret SHAPES the repo already knows
 * (`src/context/redact.ts`'s token patterns): a credential REFERENCE is an
 * opaque handle an operator configured, never a literal token. An operator
 * who pastes an API key into the reference field must fail at plan/vault
 * construction — before the value can ride the durable request envelope —
 * not at first use. Heuristic prefix screening only: it catches the common
 * provider shapes and can never whitelist anything. */
export function isSecretShapedValue(value: string): boolean {
  return (
    /^ghp_[A-Za-z0-9]{10,}/.test(value) ||
    /^github_pat_[A-Za-z0-9_]{10,}/.test(value) ||
    /^sk-[A-Za-z0-9_-]{10,}/.test(value) ||
    /^xox[baprs]-/.test(value) ||
    /^glpat-/.test(value) ||
    /^Bearer\s/.test(value) ||
    /^Basic\s/.test(value)
  );
}

export function isSecretPurpose(value: unknown): value is SecretPurpose {
  return (
    value === "forge_clone" ||
    value === "forge_publish" ||
    value === "model" ||
    value === "evidence" ||
    value === "result_channel"
  );
}

export function isPlatformName(value: unknown): value is "" | "github" | "forgejo" {
  return value === "" || value === "github" || value === "forgejo";
}

export function isScopeDimension(value: unknown): value is ScopeDimension {
  return (
    value === "platform" ||
    value === "installationId" ||
    value === "repoFullName" ||
    value === "profileName"
  );
}

/** Fail-closed rejection for a structurally invalid credential plan. */
export class CredentialPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialPlanError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** One opaque, short-lived credential reference the worker will look up by
 * `name`. Shape-compatible with the executor's `ExecutionCredentialRef` —
 * same two fields, same grammars — so a plan can be embedded into an
 * `ExecutionRequest` unchanged. */
export interface CredentialRef {
  readonly name: string;
  readonly reference: string;
}

/** Credential-reference NAME grammar: fixed kebab-case purpose names
 * (`forge-clone`, `forge-publish`, `model`, `evidence`, `result-channel`),
 * mirroring the executor's `EXECUTION_CREDENTIAL_NAME_RE`. */
export const CREDENTIAL_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

/** The fixed credential names a worker credential set may carry. The list is
 * closed: an unknown name cannot ride the handoff, and every name maps to
 * exactly one `SecretPurpose`. */
export const WORKER_CREDENTIAL_NAMES: readonly string[] = Object.freeze([
  "forge-clone",
  "forge-publish",
  "model",
  "evidence",
  "result-channel",
]);

/** The purpose each fixed worker-credential name resolves for. Built on a
 * null prototype so a name like "constructor" or "toString" can never walk
 * the prototype chain into a non-purpose value; the name → purpose mapping
 * is total and invertible — a name that is not a key here cannot appear in
 * a plan. */
export const WORKER_CREDENTIAL_PURPOSES: Readonly<Record<string, SecretPurpose>> =
  Object.freeze(
    Object.assign(Object.create(null), {
      "forge-clone": "forge_clone",
      "forge-publish": "forge_publish",
      model: "model",
      evidence: "evidence",
      "result-channel": "result_channel",
    }),
  );

/** The fork-evidence policy a plan was built under, carried IN the durable
 * plan so the boundary is enforceable at every consumer — not just at the
 * builder. `off` is the default and the fork-safe posture: a fork plan with
 * policy `off` must not carry an `evidence` entry, and validation enforces
 * that invariant wherever the plan is proven. `allowed` is legal only on a
 * fork plan: it records that the operator policy explicitly permitted fork
 * evidence for this run, which is what makes an `evidence` entry on a fork
 * plan legitimate rather than a leak. */
export type ForkEvidencePolicy = "off" | "allowed";

/** The run-scoped worker credential plan (#735): the explicit allowlist of
 * opaque references one review run may draw on. Built once per run from the
 * job identity and the operator's profile selection; embedded (references
 * only) into the durable execution request; material is resolved from it
 * only at the final handoff. */
export interface WorkerCredentialPlan {
  readonly jobId: string;
  readonly runId: string;
  readonly platform: "github" | "forgejo";
  readonly repoFullName: string;
  readonly installationId: string;
  /** The producing job's fork flag (#730/#725 trust metadata). */
  readonly fork: boolean;
  /** The fork-evidence policy this plan was built under (see
   * `ForkEvidencePolicy`) — carried so `validateCredentialPlan` can enforce
   * the fork trust boundary on the DURABLE shape, wherever it is proven. */
  readonly forkEvidencePolicy: ForkEvidencePolicy;
  /** The model profile the run claims ("" when none); the broker checks a
   * bound model credential's `profileName` against it. */
  readonly modelProfileName: string;
  /** The evidence profile the run claims ("" when none). */
  readonly evidenceProfileName: string;
  readonly credentials: readonly CredentialRef[];
}

const PLAN_KEYS = [
  "jobId",
  "runId",
  "platform",
  "repoFullName",
  "installationId",
  "fork",
  "forkEvidencePolicy",
  "modelProfileName",
  "evidenceProfileName",
  "credentials",
] as const;

function boundedIdentity(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length > 128 || hasControlCharacters(value)) {
    throw new CredentialPlanError(`${path} must be a bounded control-free string`);
  }
  return value;
}

function hasControlCharacters(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value);
}

/** Fail-closed validation of a worker credential plan — the ONE definition
 * of what a valid plan is, shared by the builder, the resolver, and any
 * future consumer that accepts a plan across a boundary. Strict and
 * structural: unknown fields REJECTED, ids and refs grammar-checked,
 * secret-shaped references refused, every credential name must be one of
 * the five fixed worker names (null-prototype lookup), each name may appear
 * at most once, and the fork trust boundary is enforced ON THE SHAPE: a
 * fork plan with policy `off` carrying an `evidence` entry is invalid — so
 * a plan that survived a durable round trip cannot smuggle a fork evidence
 * credential through a resolver that only trusts validated plans. Returns a
 * deep-frozen copy — never the caller's own object. Throws
 * `CredentialPlanError` on any problem. */
export function validateCredentialPlan(value: unknown): WorkerCredentialPlan {
  if (!isPlainObject(value)) {
    throw new CredentialPlanError("credential plan must be a mapping");
  }
  for (const key of Object.keys(value)) {
    if (!(PLAN_KEYS as readonly string[]).includes(key)) {
      throw new CredentialPlanError(`credential plan: unsupported field '${key}'`);
    }
  }
  const platform = value["platform"];
  if (platform !== "github" && platform !== "forgejo") {
    throw new CredentialPlanError("credential plan.platform must be 'github' or 'forgejo'");
  }
  const fork = value["fork"];
  if (typeof fork !== "boolean") {
    throw new CredentialPlanError("credential plan.fork must be a boolean");
  }
  const policy = value["forkEvidencePolicy"];
  if (policy !== "off" && policy !== "allowed") {
    throw new CredentialPlanError(
      "credential plan.forkEvidencePolicy must be 'off' or 'allowed'",
    );
  }
  // `allowed` records an explicit fork-evidence permission, which is only
  // meaningful on a fork plan.
  if (policy === "allowed" && fork !== true) {
    throw new CredentialPlanError(
      "credential plan.forkEvidencePolicy 'allowed' is only valid on a fork plan",
    );
  }
  const jobId = value["jobId"];
  const runId = value["runId"];
  if (typeof jobId !== "string" || !RUN_ID_RE.test(jobId)) {
    throw new CredentialPlanError(`credential plan.jobId must match ${RUN_ID_RE.source}`);
  }
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) {
    throw new CredentialPlanError(`credential plan.runId must match ${RUN_ID_RE.source}`);
  }
  const repoFullName = value["repoFullName"];
  if (typeof repoFullName !== "string" || repoFullName === "") {
    throw new CredentialPlanError("credential plan.repoFullName must be a non-empty string");
  }
  const installationId = value["installationId"];
  if (typeof installationId !== "string") {
    throw new CredentialPlanError("credential plan.installationId must be a string");
  }
  const modelProfileName = boundedIdentity(value["modelProfileName"], "credential plan.modelProfileName");
  const evidenceProfileName = boundedIdentity(
    value["evidenceProfileName"],
    "credential plan.evidenceProfileName",
  );
  const credentialsRaw = value["credentials"];
  if (!Array.isArray(credentialsRaw)) {
    throw new CredentialPlanError("credential plan.credentials must be a list");
  }
  const seenNames = new Set<string>();
  let evidencePresent = false;
  const credentials = credentialsRaw.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new CredentialPlanError(`credential plan.credentials[${index}] must be a mapping`);
    }
    for (const key of Object.keys(entry)) {
      if (key !== "name" && key !== "reference") {
        throw new CredentialPlanError(
          `credential plan.credentials[${index}]: unsupported field '${key}'`,
        );
      }
    }
    const name = entry["name"];
    const reference = entry["reference"];
    if (typeof name !== "string" || !CREDENTIAL_NAME_RE.test(name)) {
      throw new CredentialPlanError(
        `credential plan.credentials[${index}].name must match ${CREDENTIAL_NAME_RE.source}`,
      );
    }
    // Object.hasOwn, not `in`: a plain-object purpose map must not let a
    // prototype property name ("constructor", "toString") pass as a
    // credential name (boundary value fed by #252 discipline).
    if (!Object.hasOwn(WORKER_CREDENTIAL_PURPOSES, name)) {
      throw new CredentialPlanError(
        `credential plan.credentials[${index}].name must be one of: ${WORKER_CREDENTIAL_NAMES.join(", ")}`,
      );
    }
    if (name === "evidence") evidencePresent = true;
    if (seenNames.has(name)) {
      throw new CredentialPlanError(
        `credential plan.credentials[${index}].name '${name}' appears more than once`,
      );
    }
    seenNames.add(name);
    if (typeof reference !== "string" || !CREDENTIAL_REF_RE.test(reference)) {
      throw new CredentialPlanError(
        `credential plan.credentials[${index}].reference must match ${CREDENTIAL_REF_RE.source}`,
      );
    }
    if (isSecretShapedValue(reference)) {
      throw new CredentialPlanError(
        `credential plan.credentials[${index}].reference looks like secret material, not an opaque reference`,
      );
    }
    return Object.freeze({ name, reference });
  });
  // The fork trust boundary, enforced on the durable shape: a fork run
  // under policy `off` must not carry the evidence credential.
  if (fork && policy === "off" && evidencePresent) {
    throw new CredentialPlanError(
      "credential plan: a fork plan with forkEvidencePolicy 'off' must not carry an 'evidence' credential",
    );
  }
  return Object.freeze({
    jobId,
    runId,
    platform,
    repoFullName,
    installationId,
    fork,
    forkEvidencePolicy: policy,
    modelProfileName,
    evidenceProfileName,
    credentials: Object.freeze(credentials),
  });
}
