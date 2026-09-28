import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { guardedWrite, resolveArtifactPath } from "../gates/guarded-write.js";
import { decodeUtf8Ignore } from "../corpus/truncate.js";

/**
 * The run workspace (#809): the typed in-memory artifact bus the orchestrator
 * passes between stages, write-through persisted to the run directory so the
 * artifacts outputs, evals, diagnostics and the shadow comparison read stay
 * on disk exactly where v2 put them (same names, same directory semantics).
 *
 * In-memory state is authoritative — a stage can never observe a stale file
 * from a previous run through this bus, which is the property v2 approximated
 * by truncating each artifact before its build. Disk persistence is a mirror,
 * not the source of truth: a refused write (workspace escape/symlink) keeps
 * the in-memory value and is surfaced by `persistFailures`.
 */

export class RunWorkspace {
  private readonly files = new Map<string, Uint8Array>();
  /** Artifact names whose disk mirror could not be written (never silently dropped). */
  readonly persistFailures: string[] = [];

  constructor(
    readonly root: string,
    private readonly persist = true,
  ) {}

  write(name: string, data: Uint8Array | string): void {
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
    this.files.set(name, bytes);
    if (this.persist && resolveArtifactPath(name, this.root) !== null) {
      // CodeQL js/http-to-file-access: these bytes are the run's diagnostic
      // artifacts (model output, CI evidence, corpus sections) — untrusted
      // PR/model data written to the run directory is the pipeline's whole
      // purpose. The trust boundary holds downstream: publication sanitizes
      // (stripReservedMarkers/neutralization), corpus sections are fenced,
      // and the artifacts are never executed or dereferenced as paths.
      try {
        const target = resolveArtifactPath(name, this.root)!;
        writeFileSync(target, bytes);
      } catch {
        this.persistFailures.push(name);
      }
    } else if (this.persist) {
      this.persistFailures.push(name);
    }
  }

  writeText(name: string, text: string): void {
    this.write(name, text);
  }

  /** Guarded text write (v2 shell parity): returns false instead of throwing
   * on a refused path. Used where v2 itself fail-softs the write. */
  writeGuarded(name: string, text: string): boolean {
    if (!guardedWrite(this.root, name, text)) return false;
    this.files.set(name, Buffer.from(text, "utf8"));
    return true;
  }

  read(name: string): Uint8Array | null {
    const memory = this.files.get(name);
    if (memory !== undefined) return memory;
    if (!this.persist) return null;
    try {
      // Read-through: artifacts written by earlier pipeline steps (precheck)
      // or by self-persisting ports (evidence, gates) are visible here.
      const bytes = readFileSync(`${this.root}/${name}`);
      this.files.set(name, bytes);
      return bytes;
    } catch {
      return null;
    }
  }

  /** `$(<file)` semantics: utf-8 with errors="replace", null when absent. */
  readText(name: string): string | null {
    const bytes = this.read(name);
    return bytes === null ? null : decodeUtf8Ignore(bytes);
  }

  /** Raw bytes for the PromptWorkspace seam. */
  readBytes(name: string): Buffer | null {
    const bytes = this.read(name);
    return bytes === null ? null : Buffer.from(bytes);
  }

  isFile(name: string): boolean {
    return this.read(name) !== null;
  }

  isNonEmpty(name: string): boolean {
    const bytes = this.read(name);
    return bytes !== null && bytes.length > 0;
  }

  /** Drop the in-memory entry so the next read re-reads the disk mirror —
   * for artifacts written directly to disk by self-persisting ports (the
   * evidence phase, the CI gate). */
  refresh(name: string): void {
    this.files.delete(name);
  }

  /** Drop an in-memory entry AND its disk mirror (the v2 `rm -f` paths). */
  remove(name: string): void {
    this.files.delete(name);
    if (this.persist) {
      try {
        const target = resolveArtifactPath(name, this.root);
        if (target !== null) unlinkSync(target);
      } catch {
        // Absent is fine; a refused unlink leaves the mirror but the
        // in-memory state already dropped it.
      }
    }
  }

  snapshot(): ReadonlyMap<string, Uint8Array> {
    return new Map(this.files);
  }
}
