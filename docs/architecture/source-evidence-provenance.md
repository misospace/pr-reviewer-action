# Source evidence provenance

Issue #1015 separates the origin of evidence from the transformations applied to it. Text that began as repository source is not necessarily still a literal representation of committed bytes after credential masking.

## Representations

Source evidence has one of two explicit representations:

- `committed_source` means repository content was read without a sanitizer replacing any span.
- `sanitized_source` means repository content was read but at least one credential value was replaced.
- `untrusted_text` means prose, logs, web content, or other material that is not repository source.

The provenance also records whether the sanitizer synthesized text, the number of replaced spans, and the file and revision when known. Ordinary untrusted tool output retains its existing envelope shape.

## Transform tracking

The source redactor counts replacements at the point each match is processed. A replacement counts only when the generated output differs from the matched text; reference-shaped values that the sanitizer intentionally preserves do not count. Marker text already present in a repository file is not evidence of a transformation and does not make that evidence synthesized.

This distinction is essential: marker presence alone cannot determine whether source bytes were replaced. Existing source masking patterns and output bytes remain unchanged; provenance is additive. Masking remains enabled and no credential masking rule is relaxed.

## Revision authority

A literal or structural claim about committed source is authorized only for unsynthesized `committed_source` evidence whose recorded revision is a non-empty exact match for the expected revision. Missing, stale, or mismatched revisions fail closed. Sanitized source can still provide useful context, but cannot establish that a visible literal or structure was committed verbatim.

Callers bind evidence to the exact head or blob revision they fetched. This module records and checks that binding but performs no repository or network access itself.

## Safe span verification

When a claim needs verification after masking, the caller may fetch source at the exact expected revision and check whether a requested span occurs in that fetched text. The verification result is only `{ present: boolean }`; it never returns or echoes the span or source text. The call is bounded to already-fetched evidence and does not add an alternate retrieval route. A blank or whitespace-only span is reported absent rather than matching everything.

## Envelope rendering

Evidence envelopes can render provenance as space-prefixed attributes. The renderer emits the representation, a boolean synthesized flag, and the redaction count; it appends the file only when a path survives sanitizing to the safe path charset and appends the revision only when it survives sanitizing to the alphanumeric charset. Sanitizing strips rather than escapes, so a hostile file or revision value cannot close an attribute or introduce a new one, and untrusted text renders no provenance attributes at all.

## Scope

The provenance module is pure: no I/O, no network, no repository access, and no import of the redactor. It records and checks the origin and transform facts that callers supply; fetching and masking stay in their existing seams.

## Source-safe compatibility

The source-safe redactor continues to mask credential values while preserving syntax and expression references. In particular, `apiKey: config.apiKey` remains unchanged, as do delimiters and surrounding code structure. This preserves the #876 guarantee while ensuring that actual redaction is visible to downstream authority checks instead of being misrepresented as committed bytes.
