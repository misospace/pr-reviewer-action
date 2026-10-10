export type EvidenceRepresentation =
  | "committed_source"
  | "sanitized_source"
  | "untrusted_text";

export interface EvidenceProvenance {
  representation: EvidenceRepresentation;
  synthesized: boolean;
  redactionCount: number;
  file: string | null;
  revision: string | null;
}

export function committedSourceProvenance(file?: string | null, revision?: string | null): EvidenceProvenance {
  return { representation: "committed_source", synthesized: false, redactionCount: 0, file: file ?? null, revision: revision ?? null };
}

export function sanitizedSourceProvenance(redactionCount: number, file?: string | null, revision?: string | null): EvidenceProvenance {
  const count = Math.max(0, redactionCount);
  return { representation: "sanitized_source", synthesized: count > 0, redactionCount: count, file: file ?? null, revision: revision ?? null };
}

export function untrustedTextProvenance(): EvidenceProvenance {
  return { representation: "untrusted_text", synthesized: false, redactionCount: 0, file: null, revision: null };
}

export function isSynthesized(provenance: EvidenceProvenance): boolean {
  return provenance.synthesized;
}

export function authorizesLiteralClaim(
  provenance: EvidenceProvenance,
  expectedRevision: string | null | undefined,
): boolean {
  return provenance.representation === "committed_source"
    && !provenance.synthesized
    && typeof provenance.revision === "string"
    && provenance.revision.length > 0
    && typeof expectedRevision === "string"
    && expectedRevision.length > 0
    && provenance.revision === expectedRevision;
}

export function verifySourceSpan(text: string, needle: string): { present: boolean } {
  return { present: needle.trim().length > 0 && text.includes(needle) };
}

export function provenanceAttributes(provenance: EvidenceProvenance): string {
  if (provenance.representation === "untrusted_text") return "";
  const count = Number.isFinite(provenance.redactionCount)
    ? Math.min(2_147_483_647, Math.max(0, Math.trunc(provenance.redactionCount)))
    : 0;
  const representation = provenance.representation === "sanitized_source" ? "sanitized_source" : "committed_source";
  let attributes = ` representation="${representation}" synthesized="${provenance.synthesized ? "true" : "false"}" redaction_count="${count}"`;
  if (typeof provenance.file === "string" && provenance.file.length > 0) {
    const file = provenance.file.replace(/[^A-Za-z0-9._/-]/g, "").slice(0, 200);
    if (file) attributes += ` source_file="${file}"`;
  }
  if (typeof provenance.revision === "string" && provenance.revision.length > 0) {
    const revision = provenance.revision.replace(/[^A-Za-z0-9]/g, "").slice(0, 64);
    if (revision) attributes += ` source_revision="${revision}"`;
  }
  return attributes;
}
