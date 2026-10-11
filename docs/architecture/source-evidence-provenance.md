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

### Byte-identity binding for source-derived reads

The provenance the harness attaches is only meaningful when the bytes the masker saw are byte-equal to the blob at the recorded revision. A checkout at HEAD can have tracked files modified on disk during build/test/preparation; reading those working-tree bytes and stamping them `committed_source @ HEAD` would let `authorizesLiteralClaim(provenance, HEAD)` succeed for a literal that does not exist at HEAD — directly defeating the literal-claim guarantee.

To keep the guarantee honest, the source-derived tool executors (`read_file`, `git_grep`, `git_blame`) bind their reads to the recorded revision when one is available:

- `read_file` reads from `git show <sourceRevision>:<path>` and stamps `committed_source` only when that call returned the bytes. A failure to bind (no SHA, file not in tree, git transport refused) falls through to the working tree read so the model still sees content, but the provenance is degraded to `untrusted_text` so a downstream literal-claim verifier cannot authorize on unverified bytes.
- `git_grep` searches the tree at `<sourceRevision>` (`git grep <pattern> <rev>`); without a SHA it preserves the historical whole-worktree shape byte-for-byte so existing byte-exact assertions stay green. The `-z` output prefix `<rev>:` on every path is stripped so the redaction policy and the model-visible match line see the real workspace-relative path.
- `git_blame` attributes against `<sourceRevision>` (`git blame <rev> -- <path>`), so the line content is read from that revision's tree rather than the working tree.

A SHA is treated as an exact revision only when it parses as a full 40/64-character hex token; a branch name, ref, or unparseable string fails closed to a working-tree read with `untrusted_text` provenance. The regression test `source reads bind to the committed tree, never the working tree` exercises this end-to-end against a real git repo.

## Safe span verification

When a claim needs verification after masking, the caller may fetch source at the exact expected revision and check whether a requested span occurs in that fetched text. The verification result is only `{ present: boolean }`; it never returns or echoes the span or source text. The call is bounded to already-fetched evidence and does not add an alternate retrieval route. A blank or whitespace-only span is reported absent rather than matching everything.

## Envelope rendering

Evidence envelopes can render provenance as space-prefixed attributes. The renderer emits the representation, a boolean synthesized flag, and the redaction count; it appends the file only when a path survives sanitizing to the safe path charset and appends the revision only when it survives sanitizing to the alphanumeric charset. Sanitizing strips rather than escapes, so a hostile file or revision value cannot close an attribute or introduce a new one, and untrusted text renders no provenance attributes at all.

## Scope

The provenance module is pure: no I/O, no network, no repository access, and no import of the redactor. It records and checks the origin and transform facts that callers supply; fetching and masking stay in their existing seams.

This change carries provenance on the **tool-evidence path** (file reads, grep, blame, repository-contents reads, and decoded API file reads) into the model-visible `untrusted_tool_result` envelope. It deliberately does **not** wire the authority predicates into a verdict-side gate: #1015 owns the provenance and safe verification *inputs*, not final verdict policy. `authorizesLiteralClaim` and `verifySourceSpan` are the boundary primitives a later policy consumer calls.

Two source surfaces are intentionally out of scope here and are tracked separately: the related-code **corpus snippets** (`src/context/related-context.ts`), which redact via `redactSourceText` but render into the corpus rather than a tool envelope, and the **PR diff** (`pr.diff`), which is the literal bytes the author committed and is treated as untrusted text, never re-redacted.

## Source-safe compatibility

The source-safe redactor continues to mask credential values while preserving syntax and expression references. In particular, `apiKey: config.apiKey` remains unchanged, as do delimiters and surrounding code structure. This preserves the #876 guarantee while ensuring that actual redaction is visible to downstream authority checks instead of being misrepresented as committed bytes.
