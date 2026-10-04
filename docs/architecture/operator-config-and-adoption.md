# Operator mode: instance config, repository config, and adoption policy (#727)

This document is the normative definition of the Renovate-style configuration
and adoption model for Operator mode — the self-hosted controller that reviews
many repositories without committing a workflow to any of them (#725). It
defines the three config layers, the trust boundaries between them, the
adoption lifecycle, the profile model, and the effective-config fingerprint
that [#728](https://github.com/misospace/pr-reviewer-action/issues/728)
consumes as the config component of review-job identity.

The scaffolding is implemented and tested in `src/config/` as pure, wired-to-
nothing modules: `instance-config.ts` (operator schema), `adoption.ts`
(adoption state machine), `effective-config.ts` (resolution + fingerprint),
`instructions.ts` (trusted-base reads of referenced instruction files), on
top of `repository-config.ts` and `contract.ts` (the existing Action-mode
repository-config layer from #777). Controller wiring (ingress, queue,
execution) is downstream: #728, #729–#731, #733–#735. The Action's runtime
behavior is unchanged by this contract.

## The three layers and precedence

```text
hard security policy        (structural — what the validators refuse to express)
  > operator policy         (instance config: trusted, validated, fails closed)
    > repository config     (base-side .github/pr-reviewer.yml: untrusted)
      > engine defaults     (the action contract defaults)
```

A lower layer may narrow, disable, or tune only where the higher layer
explicitly permits it. Authority can only ever flow downward and shrink.

### Layer 1 — hard security policy

The hard layer is not a config section; it is what the schema and validators
refuse to express. Enforced structurally:

| Hard rule | Where it is enforced |
| --- | --- |
| Credentials never appear in repository config, instance config, or any derived value — only opaque credential *references* resolved by the credential broker (#735) | `instance-config.ts` (no field exists that could hold a secret; unknown fields are rejected everywhere) |
| No endpoint URL with embedded credentials; http/https only (self-hosted local endpoints stay first-class) | `endpointAt` in `instance-config.ts` |
| Model/provider endpoints are operator-owned; repository config can never set one | `contracts/action-v3.yml` `repo-configurable` marking + `validateContract`; `applyRepositoryConfigValues` |
| Repository config cannot touch tool/MCP/command, network/host, or fork/private-data authority | Same marking: `tool-mode`, `evidence-providers-file`, `*-for-forks`, tokens, and every secret are never `repo-configurable` |
| Executor profiles are a closed `kind` set with bounded scalars — no image, PodSpec, host path, or executable field exists | `validateExecutorProfile` + `rejectUnknown` |
| Budgets and counts carry hard ceilings (file bytes, context tokens, concurrency, list sizes) | `MAX_*` constants in `instance-config.ts` / `effective-config.ts` / `repository-config.ts` |

### Layer 2 — operator instance config

Trusted operator input, validated strictly by `validateInstanceConfig` /
`parseInstanceConfigText`: unknown fields are rejected at every level, and any
problem throws `InstanceConfigError` — the controller must refuse to start
rather than run with a partial policy, because a silently-applied subset of
the operator's policy could only ever be wider than intended, never narrower.

```yaml
version: 1
unknown-profile-policy: reject        # reject | fallback_default (default reject)
forges:                               # optional; forge integrations/installations
  - name: primary
    kind: github                      # github | forgejo
    endpoint: https://github.internal
    credential: forge-primary         # opaque reference, resolved by #735
model-profiles:                       # required, >= 1
  - name: local-fast
    endpoint: http://model.internal:4000
    api-format: openai                # openai | anthropic
    credential: litellm-primary
    context-tokens: 200000            # optional, hard-capped
    pricing:                          # optional cost metadata
      input-per-million: 0.5
      output-per-million: 1.5
      currency: USD
default-model-profile: local-fast
executor-profiles:                    # optional; closed kind set, no specs
  - name: default
    kind: local                       # local | oci | kubernetes
    max-reviews: 4
default-executor-profile: default
evidence-profiles:                    # optional; named operator-owned provider sets
  - name: strict
    providers-file: /etc/pr-reviewer/providers-strict.yml
default-evidence-profile: null
adoption:                             # see "Adoption" below
  mode: allowlist                     # all_allowed | allowlist | opt_in | opt_out
  allowlist: ["org/team-repo"]
  denylist: []
  discovered-default: skip            # adopt | skip (default skip)
reviewer-defaults:                    # the envelope repository config may narrow
  inline-findings-max: 20
  review-verbosity: concise
allow-repo-policy-overrides: false    # operator-mode equivalent of the Action input
queue:
  max-concurrent-reviews: 4
storage:                              # optional operator-owned paths
  state-path: /var/lib/pr-reviewer
  workspace-cache-path: /var/cache/pr-reviewer
```

`reviewer-defaults` keys must be `repo-configurable` contract inputs
(secrets, endpoints, and required inputs are structurally excluded by
`validateContract`), with values validated by the same per-type rules the
repository-config layer applies (`normalizeCandidate`). The envelope is
therefore expressed in the same language both modes share, and the
repository layer narrows it with the exact code the Action uses.

Queue and storage are intentionally minimal in v1; #731 (durable queue) and
#736 (durable state) extend them as additive schema-version work.

### Layer 3 — repository reviewer config

The same file, the same locations, the same trust rules as the Action mode
adopted in [#777](../repository-config.md): `.github/pr-reviewer.yml` or
`.pr-reviewer.yml`, read from the **base / merge-base tree** and never from
the PR head. One repository-config language serves both modes:

- **Contract-input keys** (the existing kebab-case input ids): narrowed
  through `applyRepositoryConfigValues` — the one narrow-not-widen
  implementation shared with the Action path — over the operator envelope.
  In Action mode the operator layer is the workflow `with:` inputs; in
  Operator mode it is `reviewer-defaults`.
- **Operator-mode extension keys** (`REPOSITORY_CONFIG_EXTENSION_KEYS`):

| Key | Type | Narrowing rule |
| --- | --- | --- |
| `enabled` | boolean | may only turn review **off** for the repository; `true` is the default and a no-op |
| `model-profile` | profile name | selects an operator-defined model profile |
| `executor-profile` | profile name | selects an operator-defined executor profile |
| `evidence-profile` | profile name | selects an operator-defined evidence-provider set |
| `ignore-paths` | glob list | paths excluded from review entirely |
| `skip-only-paths` | glob list | review only paths matching; a path matching both lists is ignored |
| `review-instructions` | path list | additional standards/rules files; content is read from the trusted base tree by `src/config/instructions.ts` under the `MAX_INSTRUCTION_FILE_BYTES`/`MAX_INSTRUCTION_TOTAL_BYTES` caps, never from the PR head |
| `require-suggested-fix` | boolean | stricter finding behavior only; `false` is ignored with a warning |

Extension keys are unknown keys to the Action-mode resolver and are inert
there (visible warning, no effect). Globs and instruction paths must be
repository-relative: no leading `/`, no `..` segment, no control characters,
bounded length and count; per-entry problems warn and skip the entry, a
structural problem warns and ignores the key.

Repository config is untrusted, so resolution is total: per-key problems are
visible warnings and the rest of the file still applies; a malformed file is
ignored in its entirety; nothing ever throws except the one explicit case
below. `enabled: false` short-circuits profile resolution — a repository
must always be able to disable itself, even when the rest of its config is
broken.

### Failure semantics

- **Instance config** (trusted): fail closed. A typed
  `InstanceConfigError` for any problem — never a partial application.
- **Repository config** (untrusted): fail conservative. Warn, ignore the
  broken part, and resolve the rest under the operator envelope; a review
  never silently runs with wider authority because its config was broken.
- **Base-ref read failure is not genuine absence** (#727 "if config cannot
  be resolved/parsed: fail conservatively; surface a bounded diagnostic").
  An unresolvable base ref, a non-git workspace, or a git timeout throws a
  typed `RepositoryConfigError` from the read layer; the Action-mode
  `resolveRepositoryConfig` wrapper degrades to the operator's inputs with
  the diagnostic surfaced — it never silently proceeds as "no repository
  config", which would be indistinguishable from an ordinary repository
  that simply has none. Only a *valid* ref with neither candidate file
  present is the ordinary absence case. The same rule applies to referenced
  instruction files (`src/config/instructions.ts`).
- **Unknown profile**: the operator's explicit `unknown-profile-policy` —
  `reject` (default) throws `EffectiveConfigError` for an *enabled*
  repository (no review rather than a review on unapproved infrastructure);
  `fallback_default` resolves the operator's default profile with a warning.
  A disabled repository never throws.

## Profile model

Repository config references **names**, never infrastructure. A profile name
must exist in the instance's table and resolves to the operator-defined
entry (endpoint, credential reference, closed executor kind, providers file).
There is no schema path from repository config to a URL, image, PodSpec,
host path, credential, or executable — an unknown name can only be rejected
or fall back per operator policy, never invented.

## Trust source: base-side resolution

Unchanged from the Action-mode contract and restated here because it is
load-bearing: repository-controlled reviewer config and every file it
references are resolved from the trusted base / effective merge-base tree,
never from the contributor's PR head. A PR cannot weaken the review that
judges it by editing or deleting its own config; only a maintainer merge to
the base branch changes what future PRs are reviewed under. For
`review-instructions`, the referenced files themselves are read from the
same tree by `src/config/instructions.ts`, with the per-file and aggregate
byte caps enforced at read time. See
[Repository config](../repository-config.md) for the resolution mechanics
and their tests.

## Adoption

The controller exposes adoption state as a deterministic ladder:

```text
discovered → eligible → adopted → enabled / disabled
```

`decideAdoption(policy, repository)` in `adoption.ts` is pure and total —
same inputs, same decision — with fixed precedence:

1. **Denylist** is the hard off switch in every mode, over everything.
2. **Mode** decides eligibility: `all_allowed` (every discovered
   repository), `allowlist` (listed repositories only), `opt_in` (only the
   operator's explicit opt-in record, made through the controller API —
   never through repository config), `opt_out` (everyone unless explicitly
   opted out). The allowlist only applies in `allowlist` mode; the denylist
   applies in all of them.
3. **`discovered-default`** decides whether an eligible repository is
   adopted automatically (`adopt`) or held at `eligible` (`skip` — the
   conservative default: nothing reviews until the operator acts).
4. **Repository config** may only disable (`enabled: false` → `disabled`);
   it can never force-enable an adoption the operator policy did not grant.

Forge installation visibility is deliberately not an input: discovery is the
controller reconciler's concern — it feeds every repository an approved
installation can *see* into the ladder. Visibility is not adoption.

Adoption requires no per-repository workflow: a repository with no config
file is adopted and reviewed entirely under operator defaults.

## Effective config and the fingerprint (#728 output contract)

`resolveEffectiveReviewConfig(contract, instance, file)` produces the typed
`EffectiveReviewConfig`: `enabled`, the resolved profiles, the narrowed
`reviewerSettings` (contract-input ids → normalized values, the shape
`loadConfig` consumes downstream), the path lists, the instruction list,
and the fingerprint.

```text
ecfg-v1-<sha256-hex>
```

The fingerprint hashes the **material** effective config with canonical
sorted-key JSON (`pythonJsonStringify`, the byte-exact `json.dumps(sort_keys=True)`
replica): resolved profile contents, narrowed reviewer settings, path sets,
instruction list, and `require-suggested-fix`. Normalization rules:

- `ignore-paths` / `skip-only-paths` are set-like: sorted before hashing, so
  reordering them does not churn job identity.
- `review-instructions` keeps its listed order (instruction precedence is
  behavior), so reordering it is a material change.
- `enabled` is included because it is config state: #728 names this
  fingerprint as the config component of job identity, so an enabled and a
  disabled configuration must not share an identity. The limit is stated
  plainly: this is a deterministic current-state hash, not history — a full
  disable → re-enable cycle hashes back to the original fingerprint.
  [#728](https://github.com/misospace/pr-reviewer-action/issues/728)
  answers the generation question that limit raises as the `adoptionEpoch`
  identity field of `ReviewJob` (`src/jobs/`, documented in
  [forge-events-and-review-jobs.md](forge-events-and-review-jobs.md)),
  layered on top of this fingerprint: a disable → re-enable cycle carries
  a new epoch and therefore a new generation, while the `ecfg-v1-`
  fingerprint stays the current-state hash.
- Warnings and the config file path remain excluded: they describe the run;
  they are not config state.

[#728](https://github.com/misospace/pr-reviewer-action/issues/728) feeds the
fingerprint into review-job identity next to forge/repository/PR/head
identity, so a material config change starts a new review generation while
cosmetic rewrites do not.

## Schema versioning

- `version` is required and must be exactly `1`; unsupported versions are
  rejected, never interpreted loosely.
- Within v1, evolution is additive only (new optional fields with
  conservative defaults); anything that changes the meaning of an existing
  field bumps the version and the fingerprint prefix.
- Unknown fields are rejected everywhere (`rejectUnknown`), so a typo can
  never be silently ignored into a wider-than-intended configuration.

## Security tests

The issue's minimum security-test list maps to pinned cases:

| #727 security property | Pinned by |
| --- | --- |
| repo config can narrow but not widen network/tool/fork policy | `effective-config.test.ts` ("repo config cannot set secrets, models, tool, or fork authority keys", "narrow but never widen" ceiling tests); `repository-config.test.ts` (contract marking tests) |
| PR-head config cannot weaken the review of that same PR | `repository-config.test.ts` (`readRepositoryConfigFromRef` reads the base ref, ignores the working tree); `instructions.test.ts` (a PR-head edit of a referenced file never reaches the base-side read) |
| base-tree config is used even when the PR edits/deletes it | `repository-config.test.ts` (base-ref read/fallback tests); `instructions.test.ts` (base bytes returned, head additions skipped) |
| arbitrary provider URL/credential rejected | `instance-config.test.ts` (endpoint scheme/credential rules, hostile inline credential rejection); `effective-config.test.ts` (repo-side `ai-api-key`/`evidence-providers-file` ignored) |
| arbitrary container image/PodSpec/host path rejected | `instance-config.test.ts` ("closed set" executor-profile test) |
| unknown model/executor profile rejected | `effective-config.test.ts` (reject/fallback policy tests) |
| repository absent config uses operator defaults | `effective-config.test.ts` ("resolves entirely to operator defaults") |
| allow/deny/adoption behavior deterministic | `adoption.test.ts` (determinism + full mode/precedence matrix) |
| config/reference size caps | `instance-config.test.ts` (byte cap, bounds), `effective-config.test.ts` (glob/instruction caps), `instructions.test.ts` (per-file + aggregate byte caps enforced at read time), `repository-config.test.ts` (file cap) |
| malformed config never grants defaults broader than operator policy | `instance-config.test.ts` (malformed instance throws), `effective-config.test.ts` (malformed repo file fails conservative) |
| resolution failure is never silent absence | `repository-config.test.ts` (unresolvable ref / non-git workspace throw; `resolveRepositoryConfig` degrades with the diagnostic), `instructions.test.ts` (same read-failure rule) |

## Deferred wiring

By design, this contract does not yet touch the Action run or a controller:
#726 extracts the engine boundary `ReviewRequest.effectiveConfig` will
carry; #728 consumes the fingerprint in job identity; #729/#730 wire forge
ingress and adoption reconciliation; #735 resolves credential references.
What is implemented here is the full config/adoption contract itself —
schemas, validation, precedence, adoption, the trusted-base instruction
reads with their caps, and the fingerprint. What is deferred is the
*consumption*: feeding `EffectiveReviewConfig` into an engine run, wiring
instruction content into the corpus, and job-identity assembly. Until then
the modules are exercised by `tests-v3/` only, and the Action's behavior is
unchanged.
