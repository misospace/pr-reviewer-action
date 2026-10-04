# Repository config

The v3 Action can read an optional, repository-owned config file so a
repository can tune review behavior without a wall of workflow `with:`
inputs. This is the same design as the #727 self-hosted-operator repository
config layer, adopted for the Action by #777: same file locations, same
trust rules, same precedence — repository config may only **narrow** the
operator's workflow inputs; it can never create new authority.

Implementation: `src/config/repository-config.ts`. It has no network or
model-generated-text execution surface — it shells out to `git show
<ref>:<path>` (argv-only, bounded, timeout) exactly like
`src/context/repo-map.ts`'s tracked-file listing, then applies a pure,
total precedence function over the parsed YAML.

## File location

The first of these that exists at the trusted ref wins:

1. `.github/pr-reviewer.yml`
2. `.pr-reviewer.yml`

Neither is required. A repository with no config file is reviewed entirely
under the operator's workflow inputs, unchanged from today.

## Trust: read from the base ref, never the PR head

The file (and its content) is resolved from the PR's **base / merge-base
tree**, never from the contributor's PR head. Concretely, the runtime reads
it via `git show <base-ref>:<path>` against the base commit — it never reads
the working tree, and a PR branch can edit or delete the file on its own
head with no effect on the review of that same PR. This is the load-bearing
security property of repository config: a contributor cannot weaken the
review that judges their own PR by editing the config the review reads.

Only a maintainer merging a change to the base branch (main) changes what
repository config future PRs are reviewed under.

A base-ref **read failure** is distinct from genuine absence. If the ref
cannot be resolved to a commit (unknown/garbage ref), the workspace is not a
git repository, or git times out, `readRepositoryConfigFromRef` throws
`RepositoryConfigError` and `resolveRepositoryConfig` degrades to the
operator's inputs **with the warning surfaced** — the same rule
`src/context/standards-file-ref.ts` established for the standards file
(#885), and the #727 rule that a config resolution failure must never be
silently read as "no repository config". Only a *valid* ref with neither
candidate file present is the ordinary, silent "no repository config" case.
`src/config/instructions.ts` applies the same rule when reading the
operator-mode `review-instructions` files from the same trusted ref.

`resolveRepositoryConfig(contract, operatorRaw, { baseRef, workspace })` is
the entry point; `baseRef` must be a trusted base commit-ish (for example the
PR's `base.sha`, as normalized by `src/platform/pr.ts`'s `PrIdentity`) that
the caller resolves — this module never derives a ref itself. Until the #681
orchestrator cutover wires that resolution end to end in `main()`, an unset
`PR_REVIEWER_BASE_REF` simply skips repository config and reviews run purely
on the operator's workflow inputs, exactly as before #777.

## Boundary ownership (`.github/pr-reviewer-owners.yml`)

A sibling, optional file with the same trust model declares which
production/enforcement files own a named security boundary, so
requirement-trace scope keeps that standard in play on a change to its own
file even when the diff repeats none of the standard's prose (#958):

```yaml
requirements:
  fork-privilege-separation:
    owners:
      - .github/workflows/fork-ai-review.yaml
      - scripts/fork_review_gate.py
```

The key is a slug whose tokens of three or more characters must all appear in
the requirement text as whole words; `owners` are exact file paths or narrow
globs (`*`/`?` within a path segment). `**`, absolute paths, `..`, whitespace,
and all-wildcard segments (`src/*/*.ts`) are rejected at parse time, and rules
or paths that fail validation are dropped with a warning. The file is read
from the same trusted base ref as the repository config (never the PR head),
so a contributor cannot escape a boundary's trace by editing it on their
branch; absence is fine, and a malformed file or a resolution failure degrades
to "no owners" with a surfaced warning — it can never broaden scope or crash
the review. See [`opt-in-features.md`](opt-in-features.md) under
`requirement-trace`.

## Keys

Keys are the v3 kebab-case input ids from
[`../contracts/action-v3.yml`](../contracts/action-v3.yml) — the same names
used in workflow `with:` blocks. Only inputs the contract marks
`repo-configurable: true` may be set; every other key (unknown, or a real
input that isn't marked) is a no-op with a visible warning, never a crash or
a partial application of the rest of the file.

Credentials, endpoints/models, network/host allowlists, and anything that
gates tool/MCP/command/fork/approval authority (including `evidence-providers-file`, whose providers run commands) are never repo-configurable — those
stay operator-only workflow inputs. `src/config/contract.ts` enforces this
structurally: `validateContract` rejects a contract where a `required`
input, or an input in `SECRET_INPUTS`, is marked `repo-configurable`.

### Repo-configurable, still a workflow input

A repository may narrow these (see precedence below), and an operator may
still also set them as a workflow `with:` input:

| Key | Type | Narrowing rule |
| --- | --- | --- |
| `fail-on-request-changes` | boolean | operator-explicit wins |
| `verdict-policy` | enum | operator-explicit wins |
| `non-blocking-finding-categories` | string (CSV) | operator-explicit wins |
| `inline-findings` | boolean | operator-explicit wins |
| `inline-findings-max` | integer | ceiling |
| `validate-required-checks` | enum | operator-explicit wins |
| `required-check-validation-mode` | enum | operator-explicit wins |
| `related-code-context` | boolean | operator-explicit wins |
| `harness-obligations` | boolean | operator-explicit wins |
| `system-prompt-mode` | enum | operator-explicit wins |
| `review-verbosity` | enum | operator-explicit wins |
| `standards-file` | string (path) | operator-explicit wins |
| `context-limit-mode` | enum | operator-explicit wins |
| `repo-map-context` | boolean | operator-explicit wins |
| `pr-thread-context` | boolean | operator-explicit wins |
| `review-threads-context` | boolean | operator-explicit wins |
| `deep-review` | enum | operator-explicit wins |
| `deep-review-timeout-sec` | integer | ceiling |
| `deep-review-max-tokens` | integer | ceiling |
| `enrichment-budget-sec` | integer | ceiling |
| `image-digest-budget-sec` | integer | ceiling |
| `sarif-max-findings` | integer | ceiling |
| `evidence-provider-timeout-sec` | integer | ceiling |
| `evidence-provider-max-output-bytes` | integer | ceiling |
| `evidence-provider-parallelism` | integer | ceiling |
| `evidence-blocker-enforcement` | boolean | operator-explicit wins |
| `related-code-max-bytes` | integer | ceiling |
| `repo-map-max-bytes` | integer | ceiling |
| `pr-thread-max-bytes` | integer | ceiling |
| `review-threads-max-bytes` | integer | ceiling |
| `deep-review-corpus-max-bytes` | integer | ceiling |
| `tool-max-response-bytes` | integer | ceiling |

`primary-tool-max-requests` and `smart-tool-max-requests` are deliberately
**not** repo-configurable: their contract default is an empty string on
purpose (a tier-aware budget resolved at harness time, not a fixed number),
so there is no config-time value to narrow against. Falling back to the
type's hard 1..50 range as a synthetic ceiling would let a repository config
file *raise* a budget the operator's workflow never set — the operator's
workflow input must always be the ceiling, so these stay operator-only
workflow inputs, same as before #777.

## Precedence

Two narrowing rules, chosen to be simple and conservative rather than
exhaustive:

1. **Bounded numeric/budget inputs** (byte caps, timeouts, request counts):
   the repository may set any value that does not exceed the operator's
   effective ceiling. The ceiling is the operator's explicit workflow value
   when they set one, or the contract default otherwise — repository config
   can only ever narrow it downward, never past it, whether the operator
   configured anything or not. An input whose ceiling cannot be determined
   this way (an unparseable or empty default with no explicit operator
   value) fails closed — it is simply not marked repo-configurable in the
   contract, as above.
2. **Enums, booleans, and free-form strings** (verdict policy, review
   verbosity, standards file path, feature toggles, …): the repository may
   set any contractually valid value, but **only when the operator did not
   explicitly set that input themselves**. An explicit operator value always
   wins outright; the repository's attempt is ignored with a warning.

Known limitation: GitHub Actions composite inputs give no way to distinguish
"the workflow author wrote `with: foo: <the default value>`" from "the
workflow author didn't set `foo` at all" — both resolve to the same string.
This module treats a workflow value that matches the contract default as
"not explicit", which means an operator who deliberately pins an input to
its own default cannot use that alone to lock out repository narrowing.
Anything that needs a real lock should be enforced upstream in the
operator's own review of what merges to the repository's base branch, or by
simply not marking that input `repo-configurable` in the first place.

### Policy inputs need operator opt-in

Inputs marked `repo-policy` in the contract change what blocks a merge or
what the reviewer is told, not just how much work it does:
`fail-on-request-changes`, `verdict-policy`, `non-blocking-finding-categories`,
`validate-required-checks`, `required-check-validation-mode`,
`evidence-blocker-enforcement`, and `system-prompt-mode`. Under rule 2 a
repository could loosen them whenever the workflow leaves them unset, which
matters when one team owns the workflow and another owns the repository. So
they are ignored (with a warning) unless the operator sets
`allow-repo-policy-overrides: "true"`; rule 2 then applies as usual.

## Unknown and malformed input

- An unrecognized key, or a real contract key that isn't marked
  `repo-configurable` (including any secret or hard-security-policy input),
  produces a visible warning and is ignored — the rest of the file still
  applies.
- A value of the wrong shape for its key (wrong type, out of enum, exceeding
  its ceiling, or a string over 4096 bytes) produces a visible warning for
  that key only and is ignored; other keys in the same file still apply.
- A file that is not valid YAML, or that does not parse to a plain mapping
  (a bare scalar, a list, `null`), is malformed: the **entire file** is
  ignored (with one warning) rather than guessing at partial structure.
- A file over 65536 bytes is treated the same as malformed and ignored.

None of the above ever raises out of `applyRepositoryConfig` or
`resolveRepositoryConfig` — both are total functions that always return a
usable, operator-safe raw input map, even when the repository config is
completely absent or broken.

## Example

```yaml
# .github/pr-reviewer.yml
verdict-policy: findings_severity_gated
non-blocking-finding-categories: "docs,style"
review-verbosity: concise
inline-findings-max: 10
related-code-max-bytes: 8000
```

If the operator's workflow already sets `verdict-policy` explicitly, that
line above is a no-op (with a warning); `inline-findings-max: 10` only takes
effect if the operator's own ceiling (explicit value, or the contract
default of 20) is 10 or higher.

## Operator mode: the same file under #727

This file, its locations, and its trust rules are the repository config
layer shared with the future self-hosted Operator mode (#727). There the
operator's layer is a centrally managed instance config instead of workflow
inputs, and the same file gains operator-mode **extension keys** — profile
selection (`model-profile`, `executor-profile`, `evidence-profile`), path
narrowing (`ignore-paths`, `skip-only-paths`), `review-instructions`,
`require-suggested-fix`, and `enabled` — all of which only narrow, disable,
or select operator-approved profiles. In this Action those extension keys
are unknown keys: warned about and inert, exactly like any other
non-repo-configurable key above. The full model — the three config layers,
the adoption lifecycle, profile resolution, and the effective-config
fingerprint the canonical job contract consumes — is defined in
[`docs/architecture/operator-config-and-adoption.md`](architecture/operator-config-and-adoption.md).
