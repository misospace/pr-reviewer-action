# Release notes style guide

How to turn a release-please changelog into the polished release notes this repository publishes. The raw changelog is the record; these notes are the explanation. Run this manually after each release publishes (release-please output is always raw); `gh release edit vX.Y.Z --notes-file <file>` replaces the body.

Exemplars, in ascending richness: [v3.0.1](https://github.com/misospace/pr-reviewer-action/releases/tag/v3.0.1) (patch), [v3.3.0](https://github.com/misospace/pr-reviewer-action/releases/tag/v3.3.0) (feature minor), [v3.5.0](https://github.com/misospace/pr-reviewer-action/releases/tag/v3.5.0) (large minor).

## Structure

1. **Opening paragraph naming the release's theme** — "3.5.0 is about **lanes**", "3.3.0 is about **precision**". Pick the one idea that unifies the changes; if a release has no unifying idea, open with what it does ("A patch release with two fixes, one of which matters to…"). State the reader's takeaway, not the commit list.
2. **A yaml example** (minors and larger, when the release adds configuration): one realistic block showing the new inputs together, exactly like a user would write it.
3. **Thematic `##` sections**, not feature/fix categories. Each bullet is:
   - **Bold claim** (#pr, closes #issue): one to three sentences of what changed, why it existed as a problem, and the behavior after. Cite issue and PR separately when they differ; verify the `closes` relation from the PR body, not the commit subject.
4. **`## Upgrading`** (minors and larger). Pin guidance (`vX.Y.Z` or floating `v3`; immutable/SHA pins bump deliberately), then every honest behavior note — including changes *toward blocking less* and default changes that cost tokens. "Nothing breaks" is allowed but must be true in the fingerprint sense too.
5. **`**Full changelog:**` compare link** for the exact range.
6. **`<details><summary>Generated changelog (release-please)</summary>`** with the raw release body **verbatim**.

## Rules

- **The details block is never edited.** It is labeled "generated" and must stay byte-faithful to what release-please produced, mangling included. Mangled fragments usually come from commit subjects with wrapped lines — fix the subject hygiene problem, not the pasted record.
- **Every factual claim is sourced** from the PR body, `docs/inputs.md`, the contract, or the diff — not inferred from a commit title. If a claim can't be verified, drop it or verify it. Check schema examples (like `pr-reviewer-routing.yml`) against the parser source before publishing them.
- **Scale to the release.** A patch gets a couple of sentences and bullets; a minor gets the full structure. Never pad.
- **No marketing.** No "seamless", "powerful", "robust". Honest tradeoffs belong in the notes ("expect materially larger context, and token spend comes with it" — v3.2.0).
- **Groundwork is labeled as groundwork.** Controller/daemon libraries not wired into the Action runtime get their own section saying exactly that, so Action users know nothing is expected of them.
- **Attribute behavior changes to their boundary**: say which lane, tier, mode, or policy a change applies to — most fixes in this repo are scoped, and a scoping-less claim reads as a breaking change.

## Process

1. `gh release view vX.Y.Z --json body` → save as the verbatim source.
2. Read the PR bodies for every non-chore entry; read the diff when the body is thin.
3. Diff `docs/inputs.md` against the previous tag to enumerate new/changed inputs — this is the Upgrading section's checklist.
4. Write the notes to a scratch file, splice the verbatim changelog into the details block, then `gh release edit`. (`gh release view/edit` needs the repo context — run from a checkout, not `/tmp`.)
