/** Controller-side secret vault for #735: an in-memory reference → material
 * store implementing the `CredentialBroker` seam.
 *
 * WHY IN-MEMORY ONLY: the vault is the controller's hand, not its memory.
 * Long-lived secrets enter through operator configuration and are held in a
 * private field that no serializer, accessor, or error message can reach —
 * the durable queue/ledger state (#731) carries the opaque REFERENCES, never
 * these values, so a leaked queue snapshot leaks no credential. A future
 * controller daemon (#736) that needs cross-restart secret state must
 * reintroduce it from the operator's secret store at startup, re-deriving
 * the same bindings — never by persisting this map.
 *
 * Binding discipline: every entry is bound to an exact `SecretScope`
 * (platform, installation, repository, purpose). Resolution compares every
 * field exactly — a credential minted for installation A can never satisfy
 * a request for installation B, a model credential can never answer a
 * forge_clone request, and a repo-scoped credential can never serve a
 * repo-unscoped caller. This exact-match rule is the multi-installation /
 * cross-repo isolation mechanism the issue's acceptance criteria name.
 *
 * Lifetime discipline: an expired material is never handed out. When a
 * refresh source is configured (e.g. the short-lived installation-token
 * mint in `src/ingress/github-app-auth.ts`), an expired entry is refreshed
 * ONCE per resolution attempt — the refreshed material replaces the stored
 * one only after it passes the same scope binding — so the worker always
 * receives material that outlives the handoff, and a revoked or unrefreshable
 * credential fails closed instead of degrading.
 */
import {
  CredentialPlanError,
  isPlatformName,
  isSecretPurpose,
  isValidCredentialRef,
  type CredentialBroker,
  type ResolutionRefusalCode,
  type ResolutionRequest,
  type ResolveResult,
  type SecretMaterial,
  type SecretScope,
} from "./types.js";

/** One stored binding: an opaque reference, the exact scope it serves, and
 * the (initially provisioned) material. */
export interface VaultEntry {
  readonly reference: string;
  readonly scope: SecretScope;
  readonly material: SecretMaterial;
}

export interface InMemorySecretVaultOptions {
  /** Injected clock, epoch milliseconds (injected for deterministic tests
   * and so the controller's own clock source is explicit). */
  readonly now?: (() => number) | undefined;
  /** Injected refresh source for expired entries. Given the reference, it
   * returns fresh material (from whatever short-lived mint the operator
   * wired up) or null when it cannot. A throwing refresh is treated as a
   * null answer — the resolution refuses `expired`, never leaks the
   * throw. */
  readonly refresh?: ((reference: string) => Promise<SecretMaterial | null>) | undefined;
}

/** Upper bound on stored entries, so one operator configuration mistake
 * cannot turn the vault into an unbounded in-memory secret dump. */
const MAX_VAULT_ENTRIES = 1024;

interface VaultRecord {
  scope: SecretScope;
  material: SecretMaterial;
  revoked: boolean;
}

export class InMemorySecretVault implements CredentialBroker {
  readonly #secrets: Map<string, VaultRecord>;
  readonly #now: () => number;
  readonly #refresh: ((reference: string) => Promise<SecretMaterial | null>) | undefined;

  constructor(entries: readonly VaultEntry[], options: InMemorySecretVaultOptions = {}) {
    if (entries.length > MAX_VAULT_ENTRIES) {
      throw new CredentialPlanError(
        `credential vault accepts at most ${MAX_VAULT_ENTRIES} entries`,
      );
    }
    const secrets = new Map<string, VaultRecord>();
    for (const entry of entries) {
      validateVaultEntry(entry);
      if (secrets.has(entry.reference)) {
        throw new CredentialPlanError(
          `credential vault: reference '${entry.reference}' provided more than once`,
        );
      }
      secrets.set(entry.reference, {
        scope: Object.freeze({ ...entry.scope }),
        material: Object.freeze({ ...entry.material }),
        revoked: false,
      });
    }
    this.#secrets = secrets;
    this.#now = options.now ?? Date.now;
    this.#refresh = options.refresh;
  }

  /** {@inheritDoc CredentialBroker.resolve} */
  async resolve(reference: string, request: ResolutionRequest): Promise<ResolveResult> {
    if (!isValidCredentialRef(reference)) {
      return refusal("invalid_request", "credential reference is malformed");
    }
    if (!validateResolutionRequest(request)) {
      return refusal("invalid_request", "resolution request is malformed");
    }
    const record = this.#secrets.get(reference);
    if (record === undefined) {
      return refusal("unknown_reference", "credential reference is not held by this broker");
    }
    if (record.revoked) {
      return refusal("revoked", "credential reference has been revoked");
    }
    const mismatch = scopeMismatch(record.scope, request);
    if (mismatch !== "") {
      return refusal("scope_mismatch", mismatch);
    }
    if (record.material.expiresAtMs !== 0 && this.#now() >= record.material.expiresAtMs) {
      return this.#refreshExpired(reference, record);
    }
    return { ok: true, material: record.material };
  }

  /** Refresh an expired entry once: a success replaces the stored material
   * (the scope binding belongs to the reference, not the material) and is
   * returned; anything else refuses `expired`. */
  async #refreshExpired(reference: string, record: VaultRecord): Promise<ResolveResult> {
    if (this.#refresh === undefined) {
      return refusal("expired", "credential material has expired and no refresh source is configured");
    }
    let fresh: SecretMaterial | null = null;
    try {
      fresh = await this.#refresh(reference);
    } catch {
      fresh = null;
    }
    if (fresh === null || !isValidSecretMaterial(fresh)) {
      return refusal("expired", "credential material has expired and could not be refreshed");
    }
    record.material = Object.freeze({ ...fresh });
    return { ok: true, material: record.material };
  }

  /** {@inheritDoc CredentialBroker.revoke} */
  revoke(reference: string): boolean {
    const record = this.#secrets.get(reference);
    if (record === undefined || record.revoked) return false;
    record.revoked = true;
    record.material = Object.freeze({ value: "", expiresAtMs: 0 });
    return true;
  }

  /** {@inheritDoc CredentialBroker.describe} */
  describe(): readonly string[] {
    return Object.freeze([...this.#secrets.keys()].sort());
  }
}

function refusal(code: ResolutionRefusalCode, reason: string): ResolveResult {
  return Object.freeze({ ok: false as const, code, reason });
}

function validateVaultEntry(entry: VaultEntry): void {
  if (!isValidCredentialRef(entry.reference)) {
    throw new CredentialPlanError("credential vault: entry reference is malformed");
  }
  if (!isValidSecretMaterial(entry.material)) {
    throw new CredentialPlanError("credential vault: entry material is malformed");
  }
  if (!isSecretPurpose(entry.scope.purpose)) {
    throw new CredentialPlanError("credential vault: entry scope purpose is malformed");
  }
  if (!isPlatformName(entry.scope.platform)) {
    throw new CredentialPlanError("credential vault: entry scope platform is malformed");
  }
  if (typeof entry.scope.installationId !== "string" ||
      typeof entry.scope.repoFullName !== "string") {
    throw new CredentialPlanError("credential vault: entry scope identity fields must be strings");
  }
}

function isValidSecretMaterial(material: SecretMaterial): boolean {
  return (
    typeof material === "object" &&
    material !== null &&
    typeof material.value === "string" &&
    material.value !== "" &&
    !material.value.includes("\n") &&
    !material.value.includes("\r") &&
    typeof material.expiresAtMs === "number" &&
    Number.isFinite(material.expiresAtMs) &&
    material.expiresAtMs >= 0
  );
}

function validateResolutionRequest(request: ResolutionRequest): boolean {
  return (
    isSecretPurpose(request.purpose) &&
    isPlatformName(request.platform) &&
    typeof request.installationId === "string" &&
    typeof request.repoFullName === "string"
  );
}

/** Scope compatibility: a NON-EMPTY stored dimension must equal the
 * request's field exactly; a stored `""` is the operator's declaration that
 * the credential is NOT restricted on that dimension (a model profile
 * credential serves every repository; a forge token is bound to exactly
 * one). The asymmetry is deliberate and one-directional: a repo-scoped
 * credential can never serve another repository, while an operator-declared
 * unscoped credential serves the request it was provisioned for. Purpose is
 * ALWAYS exact — a credential minted for one purpose never serves another.
 * Returns "" when the stored scope satisfies the request, otherwise a
 * fixed, bounded mismatch reason that names the FIELD only — never the
 * reference, the material, or which other installation/repo the credential
 * belongs to. */
function scopeMismatch(stored: SecretScope, request: ResolutionRequest): string {
  if (stored.purpose !== request.purpose) {
    return "credential is bound to a different purpose";
  }
  if (stored.platform !== "" && stored.platform !== request.platform) {
    return "credential is bound to a different platform";
  }
  if (stored.installationId !== "" && stored.installationId !== request.installationId) {
    return "credential is bound to a different installation";
  }
  if (stored.repoFullName !== "" && stored.repoFullName !== request.repoFullName) {
    return "credential is bound to a different repository";
  }
  return "";
}
