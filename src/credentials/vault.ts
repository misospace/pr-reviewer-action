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
 * Binding discipline: every entry is bound to an exact `SecretScope`. A
 * bound dimension matches a request only when the request's field equals it
 * exactly; a dimension the operator EXPLICITLY declared unscoped
 * (`unscopedDimensions`) matches any request value — and a blank bound
 * field with no declaration is a construction error, never a silent
 * unrestricted grant. Unknown fields anywhere in an entry are rejected, so
 * a misspelled scope dimension cannot quietly unscope a credential, and a
 * stray extra material field cannot ride out unredacted. This is the
 * multi-installation / cross-repo / cross-profile isolation mechanism the
 * issue's acceptance criteria name.
 *
 * Lifetime discipline: an expired (or margin-expiring) material is never
 * handed out. When a refresh source is configured (e.g. the short-lived
 * installation-token mint in `src/ingress/github-app-auth.ts`), an expiring
 * entry is refreshed ONCE per resolution attempt — the refreshed material
 * is re-validated (shape, expiry margin) before it replaces the stored one,
 * whose scope binding belongs to the reference, not the material — so the
 * worker always receives material that outlives the handoff, and a revoked
 * or unrefreshable credential fails closed instead of degrading.
 */
import {
  CredentialPlanError,
  isPlatformName,
  isScopeDimension,
  isSecretPurpose,
  isValidCredentialRef,
  isValidProfileName,
  type CredentialBroker,
  type ResolutionRefusalCode,
  type ResolutionRequest,
  type ResolveResult,
  type ScopeDimension,
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
  /** Minimum remaining lifetime a material must have to be handed out
   * (milliseconds). Mirrors #729's `REFRESH_MARGIN_SECONDS`: a token with
   * less life left than this is treated as expiring — the refresh path
   * runs, and without one the resolution refuses — so a worker never
   * receives a credential that dies mid-review. Default 60_000; `0`
   * disables the margin (expiry checked exactly). */
  readonly minRemainingMs?: number | undefined;
}

/** Upper bound on stored entries, so one operator configuration mistake
 * cannot turn the vault into an unbounded in-memory secret dump. */
const MAX_VAULT_ENTRIES = 1024;

/** Default minimum remaining lifetime (#729 parity). */
const DEFAULT_MIN_REMAINING_MS = 60_000;

const SCOPE_KEYS = [
  "platform",
  "installationId",
  "repoFullName",
  "profileName",
  "purpose",
  "unscopedDimensions",
] as const;

const MATERIAL_KEYS = ["value", "expiresAtMs"] as const;

const ENTRY_KEYS = ["reference", "scope", "material"] as const;

interface VaultRecord {
  scope: SecretScope;
  material: SecretMaterial;
  revoked: boolean;
}

export class InMemorySecretVault implements CredentialBroker {
  readonly #secrets: Map<string, VaultRecord>;
  readonly #now: () => number;
  readonly #refresh: ((reference: string) => Promise<SecretMaterial | null>) | undefined;
  readonly #minRemainingMs: number;

  constructor(entries: readonly VaultEntry[], options: InMemorySecretVaultOptions = {}) {
    if (entries.length > MAX_VAULT_ENTRIES) {
      throw new CredentialPlanError(
        `credential vault accepts at most ${MAX_VAULT_ENTRIES} entries`,
      );
    }
    const secrets = new Map<string, VaultRecord>();
    for (const entry of entries) {
      const checked = validateVaultEntry(entry);
      if (secrets.has(checked.reference)) {
        throw new CredentialPlanError(
          `credential vault: reference '${checked.reference}' provided more than once`,
        );
      }
      secrets.set(checked.reference, {
        scope: checked.scope,
        material: checked.material,
        revoked: false,
      });
    }
    this.#secrets = secrets;
    this.#now = options.now ?? Date.now;
    this.#refresh = options.refresh;
    this.#minRemainingMs = Math.max(
      0,
      typeof options.minRemainingMs === "number" && Number.isFinite(options.minRemainingMs)
        ? options.minRemainingMs
        : DEFAULT_MIN_REMAINING_MS,
    );
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
    if (isExpiring(record.material, this.#now(), this.#minRemainingMs)) {
      return this.#refreshExpiring(reference, record);
    }
    return { ok: true, material: record.material };
  }

  /** Refresh an expiring entry once: a success is re-validated (shape and
   * remaining lifetime) before it replaces the stored material — the scope
   * binding belongs to the reference, not the material — and is returned;
   * anything else refuses `expired`. */
  async #refreshExpiring(reference: string, record: VaultRecord): Promise<ResolveResult> {
    if (this.#refresh === undefined) {
      return refusal(
        "expired",
        "credential material is at or past its refresh margin and no refresh source is configured",
      );
    }
    let fresh: SecretMaterial | null = null;
    try {
      fresh = await this.#refresh(reference);
    } catch {
      fresh = null;
    }
    // Revocation wins the race: `revoke()` can run while the refresh is in
    // flight. Re-checking here ensures the in-flight resolution never stores
    // or hands back live material for a reference revoked during the await
    // (#735 revoked-token behavior is fail-closed, not eventually-consistent).
    if (record.revoked) {
      return refusal("revoked", "credential reference has been revoked");
    }
    if (
      fresh === null ||
      !isValidSecretMaterial(fresh) ||
      isExpiring(fresh, this.#now(), this.#minRemainingMs)
    ) {
      return refusal("expired", "credential material is expiring and could not be refreshed");
    }
    record.material = Object.freeze({ value: fresh.value, expiresAtMs: fresh.expiresAtMs });
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

/** Fail-closed entry validation: unknown fields REJECTED on the entry, the
 * scope, and the material; every field type-checked; unscoped declarations
 * proven consistent (a declared-unscoped field must be blank; a bound field
 * must be non-empty); references grammar-checked AND screened against
 * secret-shaped values. Returns a frozen projected copy — extra fields can
 * never ride into the vault, and therefore never ride back out unredacted. */
function validateVaultEntry(entry: VaultEntry): VaultEntry {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new CredentialPlanError("credential vault: entry must be a mapping");
  }
  for (const key of Object.keys(entry)) {
    if (!(ENTRY_KEYS as readonly string[]).includes(key)) {
      throw new CredentialPlanError(`credential vault: entry has unsupported field '${key}'`);
    }
  }
  if (!isValidCredentialRef(entry.reference)) {
    throw new CredentialPlanError("credential vault: entry reference is malformed");
  }
  const scopeValue = entry.scope as unknown;
  if (typeof scopeValue !== "object" || scopeValue === null || Array.isArray(scopeValue)) {
    throw new CredentialPlanError("credential vault: entry scope must be a mapping");
  }
  const scopeRaw = scopeValue as Record<string, unknown>;
  for (const key of Object.keys(scopeRaw)) {
    if (!(SCOPE_KEYS as readonly string[]).includes(key)) {
      throw new CredentialPlanError(
        `credential vault: entry scope has unsupported field '${key}'`,
      );
    }
  }
  const declaredUnscoped = new Set<ScopeDimension>();
  const dimensionsRaw = scopeRaw["unscopedDimensions"];
  if (!Array.isArray(dimensionsRaw)) {
    throw new CredentialPlanError(
      "credential vault: entry scope.unscopedDimensions must be a list",
    );
  }
  for (const dimension of dimensionsRaw) {
    if (!isScopeDimension(dimension)) {
      throw new CredentialPlanError(
        "credential vault: entry scope.unscopedDimensions entries must be scope dimensions",
      );
    }
    if (declaredUnscoped.has(dimension)) {
      throw new CredentialPlanError(
        `credential vault: entry scope declares '${dimension}' unscoped more than once`,
      );
    }
    declaredUnscoped.add(dimension);
  }
  const platform = scopeRaw["platform"];
  const installationId = scopeRaw["installationId"];
  const repoFullName = scopeRaw["repoFullName"];
  const profileName = scopeRaw["profileName"];
  if (!isPlatformName(platform)) {
    throw new CredentialPlanError("credential vault: entry scope platform is malformed");
  }
  for (const [dimension, value] of [
    ["platform", platform],
    ["installationId", installationId],
    ["repoFullName", repoFullName],
    ["profileName", profileName],
  ] as const) {
    if (typeof value !== "string") {
      throw new CredentialPlanError(
        `credential vault: entry scope ${dimension} must be a string`,
      );
    }
    if (declaredUnscoped.has(dimension as ScopeDimension)) {
      // An explicitly declared-unscoped dimension must be blank — a value
      // there would make the declaration a lie (a stored "github" that
      // matches a forgejo request is exactly the cross-forge confusion the
      // binding exists to prevent).
      if (value !== "") {
        throw new CredentialPlanError(
          `credential vault: entry scope ${dimension} is declared unscoped but carries a value`,
        );
      }
    } else if (value === "") {
      // A blank bound field is a construction error, never a silent
      // unrestricted grant.
      throw new CredentialPlanError(
        `credential vault: entry scope ${dimension} is blank — bind it or declare it unscoped`,
      );
    }
  }
  if (!isSecretPurpose(scopeRaw["purpose"])) {
    throw new CredentialPlanError("credential vault: entry scope purpose is malformed");
  }
  const profileNameChecked = profileName as string;
  if (profileNameChecked !== "" && !isValidProfileName(profileNameChecked)) {
    throw new CredentialPlanError("credential vault: entry scope profileName is malformed");
  }
  const materialValue = entry.material as unknown;
  if (typeof materialValue !== "object" || materialValue === null || Array.isArray(materialValue)) {
    throw new CredentialPlanError("credential vault: entry material must be a mapping");
  }
  const materialRaw = materialValue as Record<string, unknown>;
  for (const key of Object.keys(materialRaw)) {
    if (!(MATERIAL_KEYS as readonly string[]).includes(key)) {
      throw new CredentialPlanError(
        `credential vault: entry material has unsupported field '${key}'`,
      );
    }
  }
  const material: SecretMaterial = Object.freeze({
    value: materialRaw["value"] as string,
    expiresAtMs: materialRaw["expiresAtMs"] as number,
  });
  if (!isValidSecretMaterial(material)) {
    throw new CredentialPlanError("credential vault: entry material is malformed");
  }
  return Object.freeze({
    reference: entry.reference,
    scope: Object.freeze({
      platform,
      installationId: installationId as string,
      repoFullName: repoFullName as string,
      profileName: profileName as string,
      purpose: scopeRaw["purpose"],
      unscopedDimensions: Object.freeze([...(dimensionsRaw as ScopeDimension[])]),
    }),
    material,
  });
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

/** A material is expiring when its expiry is known (non-zero) and the
 * remaining lifetime is at or under the margin — the same posture as #729's
 * `REFRESH_MARGIN_SECONDS`: a token with less life left than the margin is
 * not worth handing to a worker whose run will outlive it. */
function isExpiring(material: SecretMaterial, now: number, minRemainingMs: number): boolean {
  return material.expiresAtMs !== 0 && material.expiresAtMs <= now + minRemainingMs;
}

function validateResolutionRequest(request: ResolutionRequest): boolean {
  return (
    isSecretPurpose(request.purpose) &&
    isPlatformName(request.platform) &&
    typeof request.installationId === "string" &&
    typeof request.repoFullName === "string" &&
    typeof request.profileName === "string"
  );
}

/** Scope compatibility. A BOUND (non-unscoped) stored dimension must equal
 * the request's field exactly; an operator-declared unscoped dimension
 * accepts any request value. Purpose is ALWAYS exact. Returns "" when the
 * stored scope satisfies the request, otherwise a fixed, bounded mismatch
 * reason that names the FIELD only — never the reference, the material, or
 * which other installation/repo/profile the credential belongs to. */
function scopeMismatch(stored: SecretScope, request: ResolutionRequest): string {
  const unscoped = new Set(stored.unscopedDimensions);
  if (stored.purpose !== request.purpose) {
    return "credential is bound to a different purpose";
  }
  if (!unscoped.has("platform") && stored.platform !== request.platform) {
    return "credential is bound to a different platform";
  }
  if (!unscoped.has("installationId") && stored.installationId !== request.installationId) {
    return "credential is bound to a different installation";
  }
  if (!unscoped.has("repoFullName") && stored.repoFullName !== request.repoFullName) {
    return "credential is bound to a different repository";
  }
  if (!unscoped.has("profileName") && stored.profileName !== request.profileName) {
    return "credential is bound to a different profile";
  }
  return "";
}
