/** Durable cross-process follow-up Q&A budget (#1295).
 *
 * The shared planner's Q&A budget is the `RateLimitStore` seam
 * (`./rate-limit.js`): the deterministic policy owns the DECISION, the host
 * injects the STATE. `InMemoryRateLimitStore` is valid for ONE process; the
 * self-hosted operator controller is a long-lived daemon whose budget must
 * survive RESTARTS, and several controllers may share one state directory.
 * This module is that durable state, on the SAME substrate the durable review
 * queue store uses (`src/queue/store.ts`): a versioned JSON snapshot committed
 * atomically — temp file in the same directory, fsync, rename over the target,
 * best-effort directory fsync — with a sidecar exclusive lock guarding every
 * read-modify-write so concurrent controllers cannot lose or duplicate a
 * charge.
 *
 * Semantics preserved from `consumeFollowUpBudget`:
 * - a DENIED request records nothing: the check never writes, and the commit
 *   phase runs only after EVERY scope allowed — so a denial (crash or not)
 *   leaves the ledger byte-identical;
 * - a replayed commit at the SAME instant never double-charges: one
 *   (key, instant) is recorded at most once, so re-running the commit of an
 *   interrupted single-scope `record` is a no-op;
 * - the atomicity unit of a multi-scope request is now the WHOLE request when
 *   it is consumed through {@link DurableRateLimitStore.consumeScopesAtomically}
 *   — the path `consumeFollowUpBudget` (the planner's) takes over this store:
 *   one lock-held check of every scope against the same loaded snapshot, then
 *   ONE atomic rename for the whole group. A crash strictly before the rename
 *   persists NOTHING, so a retry is a fresh attempt that charges every scope
 *   exactly once — never a half-charge of the scopes a crash left behind and
 *   never a double-charge of the interrupted attempt. (`consumeFollowUpBudget`
 *   still runs its per-scope `countInWindow` rule pre-checks UNLOCKED first —
 *   the shared deterministic policy, whose denials write nothing; the
 *   lock-held check here is the authoritative one that the commit follows.)
 *   The per-scope `record`
 *   seam method remains the seam's single-scope primitive: direct callers of
 *   `record` get per-scope commits (one scope per call, the planner unchanged
 *   by the issue's own scope);
 * - each committed event applies exactly once: every commit re-reads the
 *   CURRENT durable state under the exclusive lock before appending, so two
 *   concurrent controllers' charges both land (no lost update) and neither is
 *   applied twice.
 *
 * RETRY IDEMPOTENCY (the stable request identity):
 * - the atomic transaction takes an OPTIONAL request identity — the stable id
 *   of the logical request (the canonical follow-up comment id, qualified by
 *   the PR it belongs to), the SAME value on every redelivery of that
 *   request. It is persisted as a sha-256 DIGEST, never the raw identity, so
 *   stored state carries no untrusted content;
 * - a retry that carries an ALREADY-CHARGED identity is a NO-OP: the request
 *   was already admitted and charged, so the retry is ALLOWED (it is not
 *   denied as rate-limited — the work was already admitted) and charges
 *   NOTHING. A commit that landed while its acknowledgement was lost can
 *   therefore never be double-charged by the redelivery it triggers. The
 *   guarantee holds for as long as the identity RECORD survives in the
 *   ledger — the IDEMPOTENCY horizon (`idempotencyRetentionMs`, default
 *   7 days), deliberately INDEPENDENT of the budget horizon (`retentionMs`):
 *   the budget stops counting a charge once it leaves every window, but the
 *   identity that proves "this request was already charged" must OUTLIVE it,
 *   or a redelivery arriving after the budget horizon would be charged a
 *   second time. `isRequestCharged` is the read-only probe the seam uses to
 *   re-admit such a redelivery BEFORE the budget pre-check; the charge
 *   itself is re-proved under the lock by the transaction;
 * - two DISTINCT requests are never conflated: distinct identities are
 *   distinct charges even in the SAME millisecond, so the identity — not the
 *   instant — decides what a replay is, and two real questions in one
 *   millisecond are still two charges;
 * - a state that carries the identity on only SOME of the transaction's scopes
 *   is INCONSISTENT (the one-rename commit cannot produce it) and DENIES
 *   without writing — never a half-charge, never a double-charge.
 *
 * Fail-closed posture (`countInWindow` never throws — it returns a count no
 * sane limit can reach, so the planner denies the question):
 * - corrupt, unversioned, structurally unexpected, or over-cap state, and any
 *   unreadable state (permissions, I/O, the lock path in the way of a write):
 *   DENY, deterministically, until the state is repaired or removed (a MISSING
 *   file alone is the well-defined fresh start, exactly like the queue store);
 * - a window WIDER than the store's retention proves nothing: the ledger was
 *   pruned, so coverage cannot be proven and the scope DENIES — a pruned
 *   budget must never silently ALLOW model work;
 * - a key outside the identifier grammar is refused outright, so an upstream
 *   bug can never smuggle secrets or untrusted raw content into stored keys:
 *   durable keys carry only repo/PR/actor identifiers (the planner's
 *   `pr:`/`actor:` scope grammar).
 * - a failed commit (lock exhaustion, I/O, state that cannot be read inside
 *   the lock) LATCHES the store and RETHROWS: while latched, `countInWindow`
 *   DENIES — a budget whose state cannot be written must not keep allowing
 *   work — until a lock probe proves the lock path creatable again (the
 *   probe proves the LOCK path healthy, not every future commit's I/O — but
 *   any commit that then fails latches and rethrows before model work, so
 *   the failure direction stays closed). The
 *   rethrow is what keeps the TRIGGERING request fail-closed too: the throw
 *   aborts `consumeFollowUpBudget` before the planner returns, so the request
 *   can never reach model work on an unpersisted charge; both hosts catch at
 *   their boundary (the operator webhook handler's fixed 500 and the Action's
 *   error exit), so the follow-up lane stays total where it must. The reason
 *   stays available through {@link DurableRateLimitStore.degradedReason}
 *   (sanitized: shape class and path only, never file content). `record`
 *   otherwise THROWS only on programmer-contract violations (malformed key),
 *   which `countInWindow` already denies.
 * - two ADVISORIES carry what a refusal reason cannot: the
 *   {@link DurableRateLimitStore.durabilityAdvisory} (the post-rename
 *   directory fsync of an already-committed charge failed — the charge
 *   stands, its rename may not survive a power loss) and the
 *   {@link DurableRateLimitStore.identityAdvisory} (an atomic consume ran
 *   without a request identity, so it cannot recognize a redelivery). Both
 *   survive a later healthy read, unlike the refusal reason.
 *
 * Instances sharing one ledger file MUST be configured with the SAME
 * `retentionMs`/`maxKeys`: a narrower config than the stored state cannot
 * prove the wider window or validate the over-cap scope count, so the store
 * denies until the file is repaired or removed (fail closed, never
 * under-count into an allow). The `idempotencyRetentionMs` must match too,
 * but a mismatch there is NOT a denial — the ledger carries no fingerprint of
 * the horizons it was written under: a controller that prunes the identity
 * records EARLIER than its peer simply loses the retry guarantee for the
 * records it pruned (a conservative OVER-charge, never an under-count).
 * Residual, stated honestly: the
 * identity-less single-scope `record` primitive still dedupes by `(key,
 * instant)`, so two DISTINCT identity-less charges in the SAME millisecond
 * for the same scope collapse to one (the price of interface-level replay
 * idempotency for a seam that carries no request identity); the atomic path —
 * the one the planner uses — never collapses distinct requests, because the
 * identity decides. The retry guarantee is bounded by TWO bounds, both
 * stated: the IDEMPOTENCY horizon (a redelivery arriving after the identity
 * record was pruned is no longer recognized and is charged again) and the
 * ledger's SCOPE CAP (an evicted scope takes its identity record with it, so
 * a redelivery of a request whose scopes were evicted is charged again —
 * again a conservative over-charge, never an under-count; eviction drops the
 * scopes that carry no identity record first, so a live identity is the last
 * thing the bounded ledger gives up). The identity records also make the
 * ledger's FOOTPRINT scale with the idempotency horizon (a retained record
 * is a digest per charged scope, and every commit rewrites the whole file) —
 * the horizon and the scope cap are the operator's levers on that.
 * A process crashing mid-`saveLedger` may leave a `<file>.tmp.<pid>.<uuid>`
 * remnant — a temp file is never read as state, and removal is safe. The
 * commit's temp file is created EXCLUSIVELY under an unpredictable name, so
 * a planted symlink can never redirect a write and a planted name can never
 * be overwritten or deleted. A directory fsync AFTER the rename is ADVISORY:
 * the charge is already committed, so a failure there is recorded as a
 * durability advisory (never reported as a failed commit — a thrown commit
 * would deny work that was paid for) and never latches the store. Lock release is
 * token- AND inode-verified, and every durable write re-verifies lock
 * ownership by inode identity immediately before the rename, so a stolen
 * holder's stale snapshot cannot land over a thief's commit; the residual is
 * the POSIX-level gap between the final verification syscall and the
 * rename/unlink itself — a holder that overruns `lockStaleMs` (violating the
 * documented staleness invariant) losing that microsecond race is the honest
 * floor without a kernel lock primitive, and the failure direction is a
 * latched, aborted commit — never a silently accepted stale write.
 */

import {
  closeSync,
  fsyncSync,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { dirname } from "node:path";
import { MAX_RATE_LIMIT_KEYS, type RateLimitScope, type RateLimitStore } from "./rate-limit.js";

/** The count returned when the budget cannot be proven: `consumeFollowUpBudget`
 * denies once the count reaches the scope's limit, so any count at or above
 * every sane limit denies the request (same sentinel as the forge-backed
 * store). */
const DENY = Number.MAX_SAFE_INTEGER;

/** Default ledger retention: events older than this are pruned and can no
 * longer be counted. Far above the default 15-minute Q&A window; a scope whose
 * window exceeds the retention denies (the ledger cannot prove its coverage). */
export const DEFAULT_RATE_LIMIT_RETENTION_MS = 24 * 60 * 60_000;

/** Default IDEMPOTENCY horizon: how long a charge's request-identity RECORD
 * survives in the ledger. Deliberately far longer than the budget retention:
 * the budget stops counting a charge once it leaves every window, but the
 * identity that proves "this request was already charged" must outlive it —
 * otherwise a redelivery arriving after the budget horizon would be charged a
 * second time. The horizon is a BOUND (a ledger cannot keep every identity
 * forever); it is configurable, and it is never shorter than the budget
 * retention. */
export const DEFAULT_RATE_LIMIT_IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Default exclusive-lock staleness horizon: a lock file whose mtime is older
 * than this belongs to a dead holder and is stolen. */
export const DEFAULT_RATE_LIMIT_LOCK_STALE_MS = 30_000;

/** The durable key grammar: printable identifier characters only — the shape
 * the planner's `pr:<platform>:<repo>#<pr>` / `actor:...:<actor>` scope keys
 * (and nothing richer, e.g. no whitespace, quotes, backslash, `+`/`=`/`%`)
 * live in. Keys outside it are refused, so stored keys can only ever embed
 * repo/PR/actor identifiers, never secrets or untrusted raw content. */
const KEY_PATTERN = /^[A-Za-z0-9:._/#-]{1,256}$/;

const SNAPSHOT_KEYS: readonly string[] = ["version", "scopes"];
const SCOPE_KEYS: readonly string[] = ["key", "events"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    typeof (err as { code?: unknown })["code"] === "string"
  );
}

/** The only file error a load may paper over: a genuinely missing file is the
 * well-defined fresh start. Anything else (permissions, I/O, a directory in
 * the way) is uncertain state and fails closed. */
function isMissingFileError(err: unknown): boolean {
  return isNodeError(err) && err.code === "ENOENT";
}

/** Synchronous sleep between lock attempts (no busy spin, no async boundary —
 * the store interface is synchronous). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Write the WHOLE buffer, looping over short writes — a short write would
 * otherwise leave a truncated ledger that every later load denies. */
function writeAll(fd: number, body: string): void {
  const buffer = Buffer.from(body, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset);
  }
}

/** The lock file's token content, or null when it cannot be read (absent or
 * mid-creation). Never throws. */
function readLockToken(lockPath: string): string | null {
  try {
    return readFileSync(lockPath, "utf8").trim();
  } catch {
    return null;
  }
}

/** The default directory-durability step: fsync the ledger's directory so
 * the rename itself survives a crash. The explicit 0600 mode is required even
 * though this open never CREATES anything (the mode applies only at
 * creation, so it is inert for the read-only directory fd): the CWE-377
 * insecure-temporary-file rule flags ANY `fs.open`/`writeFile*` on a path
 * tainted by the OS temp dir — an `os.tmpdir()` call or a "/tmp/..."
 * literal, e.g. the ingress-host test's "/tmp/unused.json" ledger path —
 * unless the call carries a restrictive mode ("Insecure creation of file in
 * the os temp dir", CodeQL alert 278). The mode makes the never-world-
 * accessible intent explicit and is what the rule requires; the temp-file and
 * lock opens pass 0600 because they CREATE files that must stay private. */
function fsyncDirectory(dir: string): void {
  const dirFd = openSync(dir, "r", 0o600);
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

/** The default temp file name of a commit: UNPREDICTABLE (the pid alone is
 * guessable, so the random component matters) and always beside the ledger
 * (the rename must stay inside one filesystem). */
function defaultTempName(ledgerPath: string): string {
  return `${ledgerPath}.tmp.${process.pid}.${randomUUID()}`;
}

/** Configuration for {@link DurableRateLimitStore}. */
export interface DurableRateLimitStoreOptions {
  /** Path of the durable ledger file. The constructor performs NO I/O. */
  filePath: string;
  /** Ledger retention in ms (default 24h). Events older than the retention
   * are pruned; a scope whose window EXCEEDS the retention denies, because a
   * pruned ledger cannot prove the window's count. */
  retentionMs?: number;
  /** IDEMPOTENCY horizon in ms: how long a charge's request-identity RECORD
   * survives (default 7 days, never shorter than `retentionMs`). The budget
   * horizon prunes what can no longer be COUNTED; this one prunes what can no
   * longer be RECOGNIZED as an already-charged request — the two horizons are
   * deliberately independent, so a redelivery that arrives after the budget
   * horizon is still recognized and charged nothing. A value SHORTER than
   * `retentionMs` is refused at construction: an identity that died with the
   * budget window would let a redelivery be charged twice. */
  idempotencyRetentionMs?: number;
  /** Cap on distinct tracked scopes (default `MAX_RATE_LIMIT_KEYS`). An
   * over-cap insert evicts the scope with the OLDEST last activity (ties by
   * key) — after every scope that carries no request-identity record, so a
   * live identity is the last thing evicted — bounding the ledger
   * deterministically. */
  maxKeys?: number;
  /** A lock file older than this (mtime vs the injected clock — the clock and
   * the state directory's filesystem must agree within this margin) is
   * abandoned by its dead holder and stolen (default
   * `DEFAULT_RATE_LIMIT_LOCK_STALE_MS`). Must exceed a healthy commit's
   * worst-case duration. */
  lockStaleMs?: number;
  /** Lock acquisition attempts before the commit fails closed (default 40). */
  lockAttempts?: number;
  /** Delay between lock attempts in ms (default 25). */
  lockRetryDelayMs?: number;
  /** Epoch-ms clock used ONLY for lock staleness. The budget's own instants
   * are caller-supplied and never read from it. Default `Date.now`. */
  clock?: () => number;
  /** The directory-durability step of a commit (fsync the ledger's directory
   * after the rename). Injectable so the failure handling is pinnable in a
   * test; defaults to the real fsync. A failure here is ADVISORY — the
   * charge is already committed — so it is recorded as a durability advisory
   * and never reported as a failed commit. */
  directoryFsync?: (dir: string) => void;
  /** The temp file name a commit uses (beside the ledger path). Injectable
   * so the EXCLUSIVE-create fence can be exercised against a KNOWN path in a
   * test (the repo's adversarial-boundary rule: the hostile token itself
   * must be fed to the fence). Defaults to an unpredictable
   * `<ledger>.tmp.<pid>.<uuid>` name. */
  tempName?: (ledgerPath: string) => string;
}

/** One scope's recorded charges, ascending by instant — the shape this store
 * both loads and writes (a foreign state in another shape is corrupt, never
 * silently normalized). */
type Ledger = Map<string, LedgerEvent[]>;

/** One recorded charge: the instant it was committed and, when the request
 * carried a stable identity, the DIGEST of that identity (never the identity
 * itself — stored state carries no untrusted content). An identity-less event
 * (the `record` primitive) carries no `id`. */
interface LedgerEvent {
  /** The committed instant (epoch ms). */
  at: number;
  /** sha-256 digest (64 lowercase hex chars) of the request identity, or
   * undefined for an identity-less charge. */
  id?: string;
}

/** The persisted snapshot version this store writes. */
const LEDGER_VERSION = 2;

/** The oldest persisted snapshot version this store still reads: its events
 * are bare instants and are MIGRATED on load into identity-less events. */
const LEDGER_VERSION_LEGACY = 1;

/** The digest shape of a persisted request identity. */
const ID_PATTERN = /^[0-9a-f]{64}$/;

/** The persisted form of a request identity: a sha-256 digest, so the ledger
 * carries a fixed-shape identifier and NEVER the caller's raw identity (no
 * untrusted content in stored state, and no length growth per request). */
function requestDigest(requestId: string): string {
  return createHash("sha256").update(requestId, "utf8").digest("hex");
}

/** The outcome of the lock-held phase of an atomic multi-scope consume:
 * `denied` covers BOTH an input-validation refusal (its shape-class reason is
 * already in {@link DurableRateLimitStore.degradedReason}) and an ordinary
 * count denial (nothing was written either way) — neither may trip the
 * commit-failure catch, so it travels out of the lock as a VALUE, never a
 * throw. */
type AtomicOutcome = { kind: "committed" } | { kind: "denied" };

/** A structural/shape rejection of the durable state. The message names the
 * violated shape class only — never the offending content. */
class LedgerError extends Error {}

/** Parse and validate the persisted snapshot. Strict fail-closed validation:
 * exactly the known envelope keys, a supported `version`, scopes an array of
 * exactly-`{key,events}` entries, keys matching the identifier grammar and
 * unique, events a non-empty ascending array of well-formed charges, and no
 * more scopes than `maxKeys`. Anything else throws {@link LedgerError}. A
 * missing file is NOT handled here (the caller maps it to the empty ledger).
 *
 * Version 1 (the shape this store wrote before the request-identity field
 * existed) is MIGRATED on load: its bare instants become identity-less
 * charges. Any other version or shape is corrupt — never silently
 * normalized. */
function parseLedger(raw: string, maxKeys: number): Ledger {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LedgerError("rate-limit ledger: corrupt (unparseable JSON)");
  }
  if (!isPlainObject(parsed)) {
    throw new LedgerError("rate-limit ledger: top-level value must be a plain object");
  }
  for (const key of Object.keys(parsed)) {
    if (!SNAPSHOT_KEYS.includes(key)) {
      // Shape class only: an unknown ENVELOPE key is file content — never
      // echo it (the same sanitized-diagnostics rule as this module's
      // `degradedReason` contract).
      throw new LedgerError("rate-limit ledger: unknown top-level key present");
    }
  }
  const version = parsed["version"];
  if (version !== LEDGER_VERSION && version !== LEDGER_VERSION_LEGACY) {
    throw new LedgerError("rate-limit ledger: unsupported version");
  }
  const scopes = parsed["scopes"];
  if (!Array.isArray(scopes)) {
    throw new LedgerError("rate-limit ledger: scopes must be an array");
  }
  if (scopes.length > maxKeys) {
    throw new LedgerError("rate-limit ledger: scope count exceeds the configured cap");
  }
  const ledger: Ledger = new Map();
  for (const element of scopes) {
    if (!isPlainObject(element)) {
      throw new LedgerError("rate-limit ledger: malformed scope entry");
    }
    const entryKeys = Object.keys(element);
    if (
      entryKeys.length !== SCOPE_KEYS.length ||
      !SCOPE_KEYS.every((k) => entryKeys.includes(k))
    ) {
      throw new LedgerError("rate-limit ledger: malformed scope entry");
    }
    const key = element["key"];
    const events = element["events"];
    if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
      throw new LedgerError("rate-limit ledger: malformed scope key");
    }
    if (ledger.has(key)) {
      throw new LedgerError("rate-limit ledger: duplicate scope key");
    }
    if (!Array.isArray(events) || events.length === 0) {
      throw new LedgerError("rate-limit ledger: events must be a non-empty array");
    }
    const charges: LedgerEvent[] = [];
    for (const rawEvent of events) {
      const event = parseEvent(rawEvent, version);
      if (charges.length > 0) {
        // The charges of one scope are in CANONICAL order (ascending by
        // instant, then by identity) and strictly increasing — a repeat of
        // the same (instant, identity) is a duplicate the state a replayed
        // commit would never produce. A non-canonical order is a FOREIGN
        // state: corrupt, never silently normalized.
        if (compareCharges(charges[charges.length - 1]!, event) >= 0) {
          throw new LedgerError("rate-limit ledger: events must be ascending and unique");
        }
      }
      charges.push(event);
    }
    ledger.set(key, charges);
  }
  return ledger;
}

/** Parse ONE persisted charge. Version 1 carries a bare instant; version 2
 * carries `{at, id?}` with the identity's digest. */
function parseEvent(raw: unknown, version: number): LedgerEvent {
  if (version === LEDGER_VERSION_LEGACY) {
    if (
      typeof raw !== "number" ||
      !Number.isSafeInteger(raw) ||
      raw < 0
    ) {
      throw new LedgerError("rate-limit ledger: malformed event instant");
    }
    return { at: raw };
  }
  if (!isPlainObject(raw)) {
    throw new LedgerError("rate-limit ledger: malformed event");
  }
  const eventKeys = Object.keys(raw);
  if (eventKeys.some((k) => k !== "at" && k !== "id")) {
    throw new LedgerError("rate-limit ledger: malformed event");
  }
  const at = raw["at"];
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at < 0) {
    throw new LedgerError("rate-limit ledger: malformed event instant");
  }
  const id = raw["id"];
  if (id === undefined) return { at };
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new LedgerError("rate-limit ledger: malformed event identity");
  }
  return { at, id };
}

/** Serialize the ledger to canonical JSON: scopes sorted by key, charges in
 * their canonical order, keys in a fixed order, so equal ledgers are
 * byte-identical across commits. */
function serializeLedger(ledger: Ledger): string {
  const scopes = [...ledger.entries()]
    .filter(([, charges]) => charges.length > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, charges]) => ({
      key,
      events: charges.map((charge) =>
        charge.id === undefined ? { at: charge.at } : { at: charge.at, id: charge.id },
      ),
    }));
  return JSON.stringify({ version: LEDGER_VERSION, scopes }, null, 2) + "\n";
}

/** Drop the charges that can no longer matter, and any scope thereby emptied.
 * TWO horizons, deliberately different:
 * - an IDENTITY-LESS charge (the `record` primitive) is dropped once it
 *   leaves the BUDGET horizon (`retentionMs`): every count window is bounded
 *   by the retention, so nothing can count it again;
 * - an IDENTITY-BEARING charge is dropped once it leaves the IDEMPOTENCY
 *   horizon (`idempotencyRetentionMs`), which is never shorter than the
 *   budget horizon: the identity is what proves "this request was already
 *   charged", so it must outlive the budget counting — otherwise a redelivery
 *   arriving after the budget horizon would be charged a second time.
 *
 * Retaining an aged-out identity charge NEVER changes a count: a charge at or
 * before the budget horizon is outside every provable window (all windows are
 * bounded by the retention), so it is counted by nobody and only its identity
 * digest is still meaningful.
 *
 * Mutates and returns the same ledger. */
function pruneLedger(
  ledger: Ledger,
  nowMs: number,
  retentionMs: number,
  idempotencyRetentionMs: number,
): void {
  const budgetHorizon = nowMs - retentionMs;
  const idempotencyHorizon = nowMs - idempotencyRetentionMs;
  for (const [key, charges] of ledger) {
    const kept = charges.filter((charge) =>
      charge.id === undefined
        ? charge.at > budgetHorizon
        : charge.at > idempotencyHorizon,
    );
    if (kept.length === 0) ledger.delete(key);
    else if (kept.length !== charges.length) ledger.set(key, kept);
  }
}

/** The canonical order of charges: ascending by instant, and for equal
 * instants by identity (an identity-less charge sorts first). */
function compareCharges(a: LedgerEvent, b: LedgerEvent): number {
  if (a.at !== b.at) return a.at - b.at;
  const left = a.id ?? "";
  const right = b.id ?? "";
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Insert one charge into `charges` (kept in canonical order). Returns false
 * (no mutation) when the exact charge — same instant AND same identity — is
 * already recorded: the idempotency that makes a replayed commit never
 * double-charge, while two DISTINCT requests (distinct identities) at the
 * same instant stay two charges. */
function insertCharge(charges: LedgerEvent[], charge: LedgerEvent): boolean {
  let index = 0;
  while (index < charges.length && compareCharges(charges[index]!, charge) <= 0) index += 1;
  if (index > 0) {
    const previous = charges[index - 1]!;
    if (compareCharges(previous, charge) === 0) return false;
  }
  charges.splice(index, 0, charge);
  return true;
}

/** Evict scopes (oldest last activity first, ties by key) until the ledger
 * fits `maxKeys`. The keys in `protectedKeys` are never evicted — a
 * multi-scope commit protects ALL of its transaction's keys, so evicting for
 * one scope can never evict another scope of the same transaction.
 *
 * A scope that still carries an IDENTITY-BEARING charge (a request-identity
 * record, retained for the idempotency horizon) is evicted AFTER every scope
 * without one: a live identity record is the last thing this bounded ledger
 * gives up, so a cap eviction drops it only when there is nothing else to
 * drop. */
function evictToCap(
  ledger: Ledger,
  maxKeys: number,
  protectedKeys: ReadonlySet<string>,
): void {
  if (ledger.size <= maxKeys) return;
  const ordered = [...ledger.entries()]
    .filter(([key]) => !protectedKeys.has(key))
    .map(([key, charges]) => ({
      key,
      // A scope holding an identity record holds a live "this request was
      // already charged" proof — the last thing to evict.
      hasIdentity: charges.some((charge) => charge.id !== undefined),
      lastAt: charges[charges.length - 1]!.at,
    }))
    .sort((a, b) => {
      if (a.hasIdentity !== b.hasIdentity) return a.hasIdentity ? 1 : -1;
      if (a.lastAt !== b.lastAt) return a.lastAt - b.lastAt;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
  for (const { key } of ordered) {
    if (ledger.size <= maxKeys) break;
    ledger.delete(key);
  }
}

/** A durable, cross-process `RateLimitStore` over an atomically-committed
 * JSON ledger. See the module header for the preserved semantics and the
 * fail-closed posture. */
export class DurableRateLimitStore implements RateLimitStore {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly retentionMs: number;
  /** How long a request-identity record survives in the ledger (never
   * shorter than the budget retention). */
  private readonly idempotencyRetentionMs: number;
  private readonly maxKeys: number;
  private readonly lockStaleMs: number;
  private readonly lockAttempts: number;
  private readonly lockRetryDelayMs: number;
  private readonly clock: () => number;
  private readonly directoryFsync: (dir: string) => void;
  private readonly tempName: (ledgerPath: string) => string;
  private degraded: string | null = null;
  /** The last ADVISORY durability note of a commit (a directory fsync that
   * failed AFTER the rename already committed the charge). Kept apart from
   * {@link degradedReason} so a later healthy read cannot erase the only
   * evidence that the last commit's durability step failed. */
  private durability: string | null = null;
  /** The last ADVISORY identity note: an atomic consume ran WITHOUT a
   * request identity, so it cannot recognize a redelivery of that request. */
  private identityNote: string | null = null;
  /** A failed COMMIT latches the store: while set, `countInWindow` denies —
   * a budget whose writes are not landing must not keep allowing model work —
   * until a lock probe proves the lock path creatable again. */
  private commitUnreliable = false;

  constructor(options: DurableRateLimitStoreOptions) {
    if (typeof options.filePath !== "string" || options.filePath === "") {
      throw new RangeError("DurableRateLimitStore: filePath must be a non-empty string");
    }
    const positive = (name: string, value: number): number => {
      if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
        throw new RangeError(
          `DurableRateLimitStore: ${name} must be a positive integer, got ${String(value)}`,
        );
      }
      return value;
    };
    this.retentionMs = positive(
      "retentionMs",
      options.retentionMs ?? DEFAULT_RATE_LIMIT_RETENTION_MS,
    );
    // The IDEMPOTENCY horizon — how long a request-identity record survives —
    // is never shorter than the budget retention: an identity that died with
    // the budget window would let a redelivery be charged a second time, the
    // exact failure the stable identity exists to prevent. The default widens
    // with the retention (an operator asking for a wider window gets a wider
    // idempotency horizon); an explicit shorter value is REFUSED.
    this.idempotencyRetentionMs = positive(
      "idempotencyRetentionMs",
      options.idempotencyRetentionMs ??
        Math.max(this.retentionMs, DEFAULT_RATE_LIMIT_IDEMPOTENCY_RETENTION_MS),
    );
    if (this.idempotencyRetentionMs < this.retentionMs) {
      throw new RangeError(
        "DurableRateLimitStore: idempotencyRetentionMs must not be shorter than retentionMs",
      );
    }
    this.maxKeys = positive("maxKeys", options.maxKeys ?? MAX_RATE_LIMIT_KEYS);
    this.lockStaleMs = positive(
      "lockStaleMs",
      options.lockStaleMs ?? DEFAULT_RATE_LIMIT_LOCK_STALE_MS,
    );
    this.lockAttempts = positive(
      "lockAttempts",
      options.lockAttempts ?? 40,
    );
    this.lockRetryDelayMs = positive(
      "lockRetryDelayMs",
      options.lockRetryDelayMs ?? 25,
    );
    const clock = options.clock ?? Date.now;
    if (typeof clock !== "function") {
      throw new RangeError("DurableRateLimitStore: clock must be a function");
    }
    this.clock = clock;
    const directoryFsync = options.directoryFsync ?? fsyncDirectory;
    if (typeof directoryFsync !== "function") {
      throw new RangeError("DurableRateLimitStore: directoryFsync must be a function");
    }
    this.directoryFsync = directoryFsync;
    const tempName = options.tempName ?? defaultTempName;
    if (typeof tempName !== "function") {
      throw new RangeError("DurableRateLimitStore: tempName must be a function");
    }
    this.tempName = tempName;
    this.filePath = options.filePath;
    this.lockPath = `${options.filePath}.lock`;
  }

  /** Why the store last refused to trust the durable state (shape class and
   * path only, never file content), or null when the last check was healthy.
   * Every DENY path in {@link DurableRateLimitStore.countInWindow} records
   * its reason here, so an operator lane can surface WHY a question was
   * rate-limited. Diagnostic text carries absolute paths — never render it
   * into a forge-visible surface. */
  get degradedReason(): string | null {
    return this.degraded;
  }

  /** The last ADVISORY durability note about this store's own commits — a
   * directory fsync that failed AFTER the rename already committed the
   * charge, so the charge stands but its rename may not survive a power
   * loss. Kept apart from {@link DurableRateLimitStore.degradedReason}
   * (which explains REFUSALS and is cleared by the next healthy read) so
   * the evidence survives it. `null` when the last commit's durability step
   * succeeded. */
  get durabilityAdvisory(): string | null {
    return this.durability;
  }

  /** The last ADVISORY identity note: an atomic consume ran WITHOUT a
   * request identity, so it deduplicates by instant alone and cannot
   * recognize a redelivery of that request. An advisory, never a refusal. */
  get identityAdvisory(): string | null {
    return this.identityNote;
  }

  /** Is this request identity ALREADY charged on EVERY one of `scopes`?
   * A read-only probe (never throws; an unprovable answer is `false`): the
   * seam uses it to RE-ADMIT a redelivery of an already-charged request
   * instead of refusing it as rate-limited. The charge itself is re-proved
   * under the lock by the transaction.
   *
   * The probe answers from the CURRENT durable state, so it is bounded by
   * the state as of the last COMMIT: an identity record that has aged past
   * the idempotency horizon is still reported as charged until the next
   * commit prunes it. That direction is the safe one (a redelivery is
   * re-admitted and charged nothing; it is never charged twice). */
  isRequestCharged(scopes: readonly RateLimitScope[], requestId: string): boolean {
    if (typeof requestId !== "string" || requestId === "") return false;
    if (!Array.isArray(scopes) || scopes.length === 0) return false;
    const digest = requestDigest(requestId);
    let ledger: Ledger | null;
    try {
      ledger = this.loadLedgerUnlocked();
    } catch {
      // Unprovable state: the seam's pre-check denies it (fail closed).
      return false;
    }
    if (ledger === null) return false;
    for (const scope of scopes) {
      if (!isPlainObject(scope) || typeof scope["key"] !== "string") return false;
      const charges = ledger.get(scope["key"]) ?? [];
      if (!charges.some((charge) => charge.id === digest)) return false;
    }
    return true;
  }

  /** Count `key`'s events in `(nowMs - windowMs, nowMs]`, exactly the
   * in-memory store's semantics for well-formed queries. NEVER throws: any
   * state the budget cannot prove — unwritable (latched), unreadable,
   * corrupt, an untrusted key or query, a window wider than the retention —
   * returns a DENY count so the planner ignores the question. */
  countInWindow(key: string, windowMs: number, nowMs: number): number {
    // An untrusted key or a malformed query proves nothing: deny without even
    // reading state (a `record` on the SAME malformed input is a programmer
    // error and throws — but it can never be reached through a denied
    // count, so the planner lane stays total).
    if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
      this.degraded = "rate-limit ledger: scope key outside the identifier grammar";
      return DENY;
    }
    // The SAME instant grammar `record` commits: a count that answers a
    // query `record` could never charge would silently allow work the
    // ledger cannot bill — accept here exactly what survives there.
    if (
      typeof windowMs !== "number" ||
      !Number.isFinite(windowMs) ||
      windowMs <= 0 ||
      typeof nowMs !== "number" ||
      !Number.isSafeInteger(nowMs) ||
      nowMs < 0
    ) {
      this.degraded = "rate-limit ledger: malformed count query";
      return DENY;
    }
    // A window wider than the retention cannot be proven against a pruned
    // ledger: fail closed like the forge-backed store's unprovable coverage.
    if (windowMs > this.retentionMs) {
      this.degraded = "rate-limit ledger: window exceeds the ledger retention";
      return DENY;
    }
    // A failed commit latches the budget shut: a ledger that could not be
    // written must not keep proving headroom. Probe the write path (an
    // acquire-and-release of the commit lock); only when it is healthy again
    // may counts be answered again.
    if (this.commitUnreliable) {
      try {
        this.withLock(() => undefined);
      } catch (err) {
        this.degraded = err instanceof Error ? err.message : String(err);
        return DENY;
      }
      this.commitUnreliable = false;
    }
    let ledger: Ledger | null;
    try {
      ledger = this.loadLedgerUnlocked();
    } catch (err) {
      this.degraded = err instanceof Error ? err.message : String(err);
      return DENY;
    }
    this.degraded = null;
    if (ledger === null) return 0;
    const windowStart = nowMs - windowMs;
    let count = 0;
    for (const charge of ledger.get(key) ?? []) {
      // The window is `(nowMs - windowMs, nowMs]` — the SAME closed-upper
      // bound the forge-backed store counts: a future-dated instant (clock
      // skew, a forged event) is not inside the window and must not consume
      // budget the present has not reached yet.
      if (charge.at > windowStart && charge.at <= nowMs) count += 1;
    }
    return count;
  }

  /** Commit ONE event for `key` at `nowMs` to durable state. Contract
   * violations (malformed key or instant) throw — and `countInWindow` denies
   * the same inputs before any record, so no planner path can throw on THEM.
   * Every OTHER failure (lock exhaustion, I/O, corrupt state inside the lock)
   * is recorded in {@link degradedReason}, LATCHES the store fail-closed, and
   * RETHROWS: the charge is not spent, no further request is allowed until
   * the write path proves healthy again, and the TRIGGERING request aborts
   * before the planner returns — it can never reach model work on an
   * unpersisted charge. The host boundaries catch (the operator webhook
   * handler's fixed 500, the Action's error exit), so the follow-up lane
   * stays total where it must. A corrupt ledger can never be reset into a
   * fresh budget by a commit that walks past the corruption: the commit only
   * ever writes a ledger it just READ and validated, and only while it still
   * verifiably holds the exclusive lock. */
  record(key: string, nowMs: number): void {
    if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
      throw new RangeError(
        "DurableRateLimitStore: scope key must match the identifier grammar",
      );
    }
    if (
      typeof nowMs !== "number" ||
      !Number.isSafeInteger(nowMs) ||
      nowMs < 0
    ) {
      throw new RangeError(
        `DurableRateLimitStore: nowMs must be a non-negative safe integer, got ${String(nowMs)}`,
      );
    }
    try {
      this.withLock((assertHolder, lockFd) => {
        // Re-read INSIDE the lock: concurrent commits serialize here, so no
        // charge is lost and none is applied twice.
        const ledger = this.loadLedgerUnlocked();
        // A healthy load clears a stale reason. The commit's own advisory
        // note (a failed directory fsync) is set later and stays visible.
        this.degraded = null;
        if (ledger === null) {
          // A missing file inside the lock is the well-defined empty state —
          // but a corrupted one must not be silently replaced either.
            const fresh: Ledger = new Map();
            fresh.set(key, [{ at: nowMs }]);
          assertHolder();
          this.saveLedger(fresh, lockFd);
          return;
        }
        const existing = ledger.get(key);
        if (existing === undefined) {
          ledger.set(key, [{ at: nowMs }]);
          evictToCap(ledger, this.maxKeys, new Set([key]));
        } else if (!insertCharge(existing, { at: nowMs })) {
          // Exact replay of an already-committed (key, instant): charge once.
          return;
        }
        pruneLedger(ledger, nowMs, this.retentionMs, this.idempotencyRetentionMs);
        assertHolder();
        this.saveLedger(ledger, lockFd);
      });
      this.commitUnreliable = false;
    } catch (err) {
      this.degraded = err instanceof Error ? err.message : String(err);
      this.commitUnreliable = true;
      // Fail the TRIGGERING request closed: a swallowed commit failure would
      // let this request run model work on an unpersisted charge. The host
      // boundary catches (fixed 500 / action error exit); the latch denies
      // everything until the write path proves healthy again.
      throw err;
    }
  }

  /** Commit one event per scope for a WHOLE multi-scope request as ONE
   * all-or-nothing transaction, under the same exclusive lock `record` uses:
   * check every scope's rule against the SAME loaded snapshot and, ONLY when
   * every scope is under its limit, insert one instant per scope and commit
   * the ledger with ONE atomic rename. This is the capability
   * `consumeFollowUpBudget` delegates to over this store — the atomicity unit
   * is the WHOLE multi-scope request, so a crash strictly before the rename
   * persists NOTHING and a retry is a fresh attempt that charges every scope
   * exactly once (never a half-charge, never a double-charge of the
   * interrupted attempt).
   *
   * `requestId` is the OPTIONAL stable identity of the logical request (the
   * SAME value on every redelivery of it). It is persisted as a sha-256
   * digest — never the raw identity — and it decides what a replay is:
   * - a retry of an ALREADY-CHARGED request is ALLOWED and charges NOTHING
   *   (the request was already admitted, so it is not denied as rate-limited
   *   either): a commit whose acknowledgement was lost can never be
   *   double-charged by the redelivery it triggers, for as long as the
   *   identity record survives (the store's IDEMPOTENCY horizon — never
   *   shorter than its budget horizon, so the record outlives the budget
   *   window it no longer counts in);
   * - two DISTINCT requests stay distinct charges even in the SAME
   *   millisecond, so no real question is ever collapsed into another;
   * - a state that carries the identity on only SOME of the transaction's
   *   scopes is INCONSISTENT and DENIES without writing.
   *
   * Failure posture, mirroring `record` exactly:
   * - input-validation refusals (malformed `nowMs`, a structurally broken
   *   scope list, a key outside the identifier grammar, a window over the
   *   retention) happen BEFORE the lock is acquired — they set
   *   {@link degradedReason} to a shape-class reason and return `false`
   *   WITHOUT writing, latching, or throwing, and never depend on lock
   *   availability;
   * - a corrupt/unreadable ledger inside the lock, and any commit failure
   *   (lock exhaustion, I/O, a stolen lock), set {@link degradedReason},
   *   LATCH the store fail-closed, and RETHROW — the charge is not spent and
   *   the triggering request aborts before the planner returns; and
   * - an ordinary denial (a scope at or over its limit, including a floored
   *   limit <= 0 as defense in depth) returns `false` having written nothing.
   */
  consumeScopesAtomically(
    scopes: readonly RateLimitScope[],
    nowMs: number,
    requestId?: string,
  ): boolean {
    // Input validation FIRST, before the lock is even acquired: a shape-class
    // refusal writes nothing, latches nothing, and throws nothing (the same
    // reasons/messages `countInWindow` denies with) — a malformed request
    // must never depend on lock availability, and a structurally broken
    // scope list is a refusal, not a programmer-contract throw. The
    // validated projection below is what the lock-held phase consumes.
    if (
      typeof nowMs !== "number" ||
      !Number.isSafeInteger(nowMs) ||
      nowMs < 0
    ) {
      this.degraded = "rate-limit ledger: malformed count query";
      return false;
    }
    if (!Array.isArray(scopes)) {
      this.degraded = "rate-limit ledger: malformed count query";
      return false;
    }
    const validated: { key: string; windowMs: number; limit: number }[] = [];
    for (const scope of scopes) {
      if (
        !isPlainObject(scope) ||
        typeof scope["key"] !== "string" ||
        !KEY_PATTERN.test(scope["key"]) ||
        !isPlainObject(scope["rule"])
      ) {
        this.degraded = "rate-limit ledger: scope key outside the identifier grammar";
        return false;
      }
      const windowMs = scope["rule"]["windowMs"];
      if (typeof windowMs !== "number" || !Number.isFinite(windowMs) || windowMs <= 0) {
        this.degraded = "rate-limit ledger: malformed count query";
        return false;
      }
      // A window wider than the retention cannot be proven against a
      // pruned ledger: fail closed like `countInWindow` does.
      if (windowMs > this.retentionMs) {
        this.degraded = "rate-limit ledger: window exceeds the ledger retention";
        return false;
      }
      const rawLimit = scope["rule"]["limit"];
      const flooredLimit =
        typeof rawLimit === "number" ? Math.floor(rawLimit) : Number.NaN;
      if (!Number.isFinite(flooredLimit) || flooredLimit <= 0) {
        // Defense in depth — `consumeFollowUpBudget` already validated the
        // rules; this is an ordinary denial, not an input refusal.
        return false;
      }
      validated.push({ key: scope["key"], windowMs, limit: flooredLimit });
    }
    // The request's stable identity, in its persisted form: a digest, so the
    // ledger carries a fixed-shape identifier and never the caller's value.
    // An absent or non-string identity means an IDENTITY-LESS charge (the
    // seam's `record` primitive), which dedupes by instant as before.
    const digest =
      typeof requestId === "string" && requestId !== ""
        ? requestDigest(requestId)
        : undefined;
    try {
      const outcome = this.withLock((assertHolder, lockFd) => {
        // Re-read INSIDE the lock: the check and the commit see the SAME
        // snapshot, so no concurrent commit can slip between them. A corrupt
        // or unreadable ledger throws out of the lock — the catch below
        // latches and rethrows, exactly like `record`'s.
        const loaded = this.loadLedgerUnlocked();
        const ledger: Ledger = loaded ?? new Map();
        this.degraded = null;
        // RETRY IDEMPOTENCY: an identity that is already charged on EVERY
        // scope of this transaction means the request was already admitted
        // and charged. The retry is ALLOWED (not rate-limited — the work was
        // already admitted) and charges NOTHING: the redelivery of a commit
        // whose acknowledgement was lost can never double-charge.
        if (digest !== undefined) {
          let chargedScopes = 0;
          let presentButMissing = false;
          for (const scope of validated) {
            const charges = ledger.get(scope.key);
            if (charges === undefined) {
              // The scope is ABSENT from the ledger: it never had a charge,
              // or the cap eviction dropped it. (An absent scope counts as
              // neither a charge nor a present-but-missing one, so the
              // refusal reason below names the eviction.)
              continue;
            }
            if (charges.some((charge) => charge.id === digest)) chargedScopes += 1;
            else presentButMissing = true;
          }
          if (chargedScopes === validated.length) {
            // Already charged: the durable state already IS the committed
            // outcome — save nothing.
            return { kind: "committed" } as AtomicOutcome;
          }
          if (chargedScopes > 0) {
            // INCONSISTENT: the one-rename commit charges every scope or
            // none, so a partial charge is a state this store cannot produce.
            // Fail closed: charge neither the missing scope nor the present
            // one again. The reason names the likely cause: a scope the cap
            // eviction dropped (absent from the ledger) or a state edited
            // under the store's feet (the scope is present, but without the
            // charge).
            this.degraded = presentButMissing
              ? "rate-limit ledger: inconsistent request charge"
              : "rate-limit ledger: request charge partially evicted";
            return { kind: "denied" } as AtomicOutcome;
          }
        } else {
          // An IDENTITY-LESS consume cannot recognize a redelivery: the
          // charge is deduplicated by instant alone. Say so — the trap is
          // invisible otherwise. It is an ADVISORY, not a refusal: the
          // consume itself is correct.
          this.identityNote =
            "rate-limit ledger: consume without a request identity; a redelivery is not idempotent";
        }
        // Count every scope against the SAME snapshot. A denial consumes
        // nothing anywhere.
        for (const scope of validated) {
          const windowStart = nowMs - scope.windowMs;
          let count = 0;
          for (const charge of ledger.get(scope.key) ?? []) {
            // The window is `(nowMs - windowMs, nowMs]` — the SAME closed
            // bounds `countInWindow` counts: a future-dated instant never
            // consumes budget the present has not reached yet.
            if (charge.at > windowStart && charge.at <= nowMs) count += 1;
          }
          if (count >= scope.limit) return { kind: "denied" } as AtomicOutcome;
        }
        // Every scope allowed: insert one charge per scope. An exact-replay
        // insert (the same (instant, identity) already committed) is a no-op.
        let changed = false;
        const transactionKeys = new Set<string>();
        for (const scope of validated) {
          transactionKeys.add(scope.key);
          const charge: LedgerEvent =
            digest === undefined ? { at: nowMs } : { at: nowMs, id: digest };
          const existing = ledger.get(scope.key);
          if (existing === undefined) {
            ledger.set(scope.key, [charge]);
            changed = true;
          } else if (insertCharge(existing, charge)) {
            changed = true;
          }
        }
        if (!changed) {
          // Pure replay of an already-committed request: charge once, save
          // nothing — the durable state already IS the committed outcome.
          return { kind: "committed" } as AtomicOutcome;
        }
        // ONE eviction for the whole transaction, protecting ALL of its
        // keys — evicting for one scope can never evict another scope of
        // the same transaction. If the transaction's own distinct keys
        // exceed the cap, the committed ledger would be over-cap and
        // rejected by every later load — deny instead of self-bricking.
        evictToCap(ledger, this.maxKeys, transactionKeys);
        if (ledger.size > this.maxKeys) return { kind: "denied" } as AtomicOutcome;
        pruneLedger(ledger, nowMs, this.retentionMs, this.idempotencyRetentionMs);
        assertHolder();
        this.saveLedger(ledger, lockFd);
        return { kind: "committed" } as AtomicOutcome;
      });
      if (outcome.kind === "denied") return false;
      // The degraded reason is NOT cleared here: a healthy load already
      // cleared any stale one inside the lock, and a commit's own advisory
      // note (a failed directory fsync on an already-committed charge) must
      // stay visible.
      this.commitUnreliable = false;
      return true;
    } catch (err) {
      this.degraded = err instanceof Error ? err.message : String(err);
      this.commitUnreliable = true;
      // Fail the TRIGGERING request closed: the whole group is uncommitted
      // (a crash before the rename persists nothing), so no scope may be
      // treated as charged. The host boundary catches (fixed 500 / action
      // error exit); the latch denies everything until the write path
      // proves healthy again.
      throw err;
    }
  }

  /** Read the durable ledger: a missing file is null (the well-defined fresh
   * start), any corrupt or unreadable state throws (the caller fails closed). */
  private loadLedgerUnlocked(): Ledger | null {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (err) {
      if (isMissingFileError(err)) return null;
      throw err;
    }
    return parseLedger(raw, this.maxKeys);
  }

  /** Atomic durable commit: temp file in the SAME directory (0600), fsync,
   * rename over the target, best-effort directory fsync. Every failure path
   * removes the temp file, so no partial state is ever left behind. The
   * commit requires the caller's lock fd and re-verifies ownership by INODE
   * IDENTITY immediately before the rename — the last possible moment — so a
   * lock stolen between the token assertion and this point aborts instead of
   * renaming a stale snapshot over the thief's commit. */
  private saveLedger(ledger: Ledger, lockFd: number): void {
    const body = serializeLedger(ledger);
    const dir = dirname(this.filePath);
    // An UNPREDICTABLE temp name: the pid alone is guessable, so a planted
    // path could be aimed at this process. The random component makes the
    // name unguessable, and the EXCLUSIVE create below (`wx` = O_CREAT |
    // O_EXCL | O_WRONLY) makes the write safe even if a name IS guessed:
    // O_EXCL fails on ANY existing path — including a symlink — so the write
    // can never be redirected through a planted link, and a planted file is
    // never overwritten (nor deleted: only a temp file this commit created
    // is ever removed).
    const tmp = this.tempName(this.filePath);
    let created = false;
    try {
      const fd = openSync(tmp, "wx", 0o600);
      created = true;
      try {
        writeAll(fd, body);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      // Ownership, re-proven at the last possible moment: the token check in
      // `assertHolder` reads content; this compares the lock file's inode
      // with the fd WE created, so a stolen-and-replaced lock file (or a
      // removed one) fails here, before a single byte of the ledger moves.
      // `statSync` throwing (lock gone, unreadable) fails closed the same way.
      const lockStat = statSync(this.lockPath);
      const fdStat = fstatSync(lockFd);
      if (lockStat.dev !== fdStat.dev || lockStat.ino !== fdStat.ino) {
        throw new Error(
          "rate-limit ledger: commit lock was stolen mid-commit; refusing to write",
        );
      }
      renameSync(tmp, this.filePath);
      created = false;
      // The charge is COMMITTED from here on. The directory fsync only makes
      // the RENAME itself survive a power loss, so a failure here is a
      // durability hint — NEVER a commit failure: reporting it as one would
      // abort a request that was already paid for and invite the redelivery
      // that (with the request identity) is idempotent anyway. It is
      // recorded as an ADVISORY and the commit stands. Residual, stated
      // honestly: a power loss right here can lose the rename, so that one
      // charge may not survive — the same narrow residual the queue store
      // accepts, and the reason it is never reported as a failure.
      try {
        this.directoryFsync(dir);
        this.durability = null;
      } catch {
        this.durability = "rate-limit ledger: committed, but the directory fsync failed";
      }
    } catch (err) {
      if (created) {
        // Only a temp file THIS commit created is removed — a planted name
        // (or another writer's temp file) is never touched.
        try {
          rmSync(tmp, { force: true });
        } catch {
          // best effort: cleanup must not mask the original failure
        }
      }
      throw err;
    }
  }

  /** Run `fn` holding the exclusive sidecar lock. The lock file is created
   * exclusively (`wx`) with a fresh per-acquisition TOKEN; `fn` receives an
   * `assertHolder` callback it must invoke immediately before any durable
   * write, and the lock fd (whose inode `saveLedger` re-verifies at the
   * rename); release unlinks the lock ONLY while the token AND the inode
   * still prove THIS acquisition holds it. A lock whose mtime is older than
   * `lockStaleMs` belongs to a dead holder and is stolen. Consequences:
   * - a commit whose lock was stolen mid-flight aborts at `assertHolder` or
   *   at `saveLedger`'s pre-rename inode check (never renaming a stale
   *   snapshot over the thief's commit), and the failed commit latches the
   *   store fail-closed;
   * - a release never unlinks a lock acquired by someone else.
   * Lock exhaustion THROWS — the caller never writes without the lock. */
  private withLock<T>(fn: (assertHolder: () => void, lockFd: number) => T): T {
    let fd: number | null = null;
    let token = "";
    for (let attempt = 0; attempt < this.lockAttempts && fd === null; attempt += 1) {
      try {
        fd = openSync(this.lockPath, "wx", 0o600);
        token = `${process.pid} ${randomUUID()}`;
        try {
          writeAll(fd, `${token}\n`);
        } catch (err) {
          // The lock exists but its token never landed: release and fail the
          // whole acquisition — committing without verifiable ownership is
          // not an option.
          try {
            closeSync(fd);
          } catch {
            // best effort
          }
          try {
            rmSync(this.lockPath, { force: true });
          } catch {
            // best effort
          }
          throw err;
        }
      } catch (err) {
        if (!isNodeError(err) || err.code !== "EEXIST") throw err;
        fd = null;
        token = "";
        let mtimeMs: number | null = null;
        try {
          mtimeMs = statSync(this.lockPath).mtimeMs;
        } catch {
          // The holder released between our create and stat: just retry.
          continue;
        }
        const ageMs = this.clock() - mtimeMs;
        if (Number.isFinite(ageMs) && ageMs > this.lockStaleMs) {
          // The holder is gone (crashed mid-commit): steal its lock file. A
          // concurrent stealer that wins the race makes our next create fail
          // EEXIST, which simply retries again.
          try {
            rmSync(this.lockPath, { force: true });
          } catch {
            // best effort: the retry below re-checks the state
          }
          continue;
        }
        if (attempt + 1 < this.lockAttempts) sleepSync(this.lockRetryDelayMs);
      }
    }
    if (fd === null) {
      throw new Error(
        `rate-limit ledger: commit lock busy (${this.lockPath}) after ${this.lockAttempts} attempts`,
      );
    }
    const assertHolder = (): void => {
      if (readLockToken(this.lockPath) !== token) {
        throw new Error(
          "rate-limit ledger: commit lock was stolen mid-commit; refusing to write",
        );
      }
    };
    try {
      return fn(assertHolder, fd);
    } finally {
      // Capture our fd's identity while it is still open — the release proof
      // compares the on-disk lock file against THIS fd's inode.
      let ownIdentity: { dev: number; ino: number } | null = null;
      try {
        const fdStat = fstatSync(fd);
        ownIdentity = { dev: fdStat.dev, ino: fdStat.ino };
      } catch {
        // best effort: without a provable identity there is nothing to release
      }
      try {
        closeSync(fd);
      } catch {
        // best effort
      }
      // Ownership-verified release, by token AND inode: never unlink a lock
      // another acquisition holds (a stolen holder's late cleanup must not
      // open a third writer). The inode compare closes the content-only gap
      // a copied token would slip through; the residual POSIX gap between
      // the verification and the unlink is the documented floor.
      let owned = false;
      if (ownIdentity !== null) {
        try {
          const lockStat = statSync(this.lockPath);
          owned =
            lockStat.dev === ownIdentity.dev &&
            lockStat.ino === ownIdentity.ino &&
            readLockToken(this.lockPath) === token;
        } catch {
          owned = false;
        }
      }
      if (owned) {
        try {
          rmSync(this.lockPath, { force: true });
        } catch {
          // best effort
        }
      }
    }
  }
}
