# Tangled (experimental)

Tangled support is experimental. The upstream hosting, appview and record interfaces still change, so this page states what the action does on Tangled today.

Three rules hold on every Tangled run:

1. Every forge read and every forge write of the pull goes through the configured forge capability. A Tangled run never calls a GitHub or a Forgejo forge API for the pull, and it never runs a forge command-line tool. The linked-source enrichment is not a pull read. It always targets github.com, so it serves GitHub repositories only.
2. A capability that Tangled does not have fails closed. The runtime names the missing capability and stops. It never guesses a value and never falls back to another forge.
3. A secret travels only in the request that needs it. The app password travels in the body of the AT-Proto session call, and the session tokens travel in the authentication header. Neither appears in a URL, in a process argument or in a log line.

## Current status

A Tangled run does not complete today. The run stops at the first step that Tangled cannot serve:

1. The pull metadata read works. The diff read does not. The read adapter refuses the diff, so the precheck stops the run before the review engine starts.
2. The round-diff read is implemented in `src/platform/tangled-diff.ts`. It is not connected to the read adapter yet, so the wiring lands with the remaining work of [#564](https://github.com/misospace/pr-reviewer-action/issues/564).
3. After that wiring, the publication step fails closed until a trustworthy current-head read exists. See [#1165](https://github.com/misospace/pr-reviewer-action/issues/1165). A review that cannot prove the pull did not advance is never published.

The runner exits with code 1 at the first stop. Read the [support matrix](#support-matrix) before you plan a Tangled rollout.

## Runtime surface

Tangled is not GitHub Actions. The `action.yml` manifest is the GitHub Actions entry point, and it is not the Tangled entry point.

Tangled reviews run on the host-neutral runner:

```bash
node dist/index.js tangled
```

The runner runs precheck, review and publish in one Node process. It needs no `GITHUB_EVENT_PATH`, `GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY` or `RUNNER_TEMP`. It needs no `gh`, no Python and no shell.

The runner pins the platform to `tangled` in the run environment and in the action configuration. A `github` or `forgejo` platform is refused with an error, not ignored. There is no fallback to another forge.

## Setup

The Spindle workflow example is the copyable starting point: [`examples/tangled-workflow.yml`](../examples/tangled-workflow.yml). Copy it to `.tangled/workflows/ai-review.yml` in the repository.

1. Set the public runtime values in the workflow file. Spindle injects them into the runner process.
2. Set the private values as Spindle repository environment variables. Never write a private value in the workflow file.
3. Pin the reviewer release tag. A release tag carries the built `dist/`, so the workflow needs no install step and no build step.

The example pins the `v3` tag, which floats to the latest v3 release. Pin an exact tag in production.

## Configuration

### Public values

These values are identifiers. They are not secrets.

| Variable | Required | Meaning |
|---|---|---|
| `TANGLED_REPO_DID` | Yes | The DID of the repository owner. The platform detection reads it first, so a set value selects Tangled. |
| `TANGLED_REPO_REPO_DID` | Yes | The DID of the repository. The resolver lists the pulls of this repository. |
| `TANGLED_BOBBIN_URL` | Yes | The absolute `https` URL of the Bobbin endpoint that serves the pull metadata. Plain `http` is accepted for loopback hosts only. |
| `TANGLED_REPO_NAME` | No | The name of the repository. |
| `TANGLED_REPO_KNOT` | No | The bare hostname of the knot. It carries no scheme, no port and no path. |
| `TANGLED_PR_SOURCE_BRANCH` | No | The source branch of the pull. |
| `TANGLED_PR_TARGET_BRANCH` | No | The target branch of the pull. |
| `TANGLED_PR_SOURCE_SHA` | No | The source commit of the pull. It is advisory only, because a pull record can declare any commit. |
| `ATPROTO_HOST` | No | The host of the account's repository server. The default is `https://bsky.social`. |
| `ATPROTO_TIMEOUT` | No | The request timeout in seconds. The default is 30. |

The resolver needs at least one of `TANGLED_PR_SOURCE_BRANCH` and `TANGLED_PR_TARGET_BRANCH`.

### Private values

These values are secrets. Store them as Spindle repository environment variables.

| Variable | Required | Meaning |
|---|---|---|
| `ATPROTO_HANDLE` | Yes | The handle of the account that signs the review record. |
| `ATPROTO_APP_PASSWORD` | Yes | The app password of that account. |
| `INPUT_AI-API-KEY` | Yes | The key of the model endpoint. |

The model endpoint and model name use the `ai-base-url` and `ai-model` inputs. The publish mode uses the `publish-mode` input.

Spindle runs pipeline code for a fork pull request, so a fork pull request has no private values. The example skips the review step when a private value is missing, instead of failing the run.

## Identity

A Tangled pull has no number. Its identity is the pull AT URI, the record key and the CID of the record. The AT URI looks like this:

```text
at://<author-did>/sh.tangled.repo.pull/<record-id>
```

The action never invents a numeric pull number. The `pr-number` input stays empty on a Tangled run, and the pull locator reaches the runtime through the DID context.

The resolver picks the pull by repository DID, branch pair and open state. If two open pulls match, the run stops with an ambiguous pull error.

The repository owner DID is a public identifier. The app password is the secret. The runtime never writes the secret into a URL, an argument or a diagnostic message.

## Support matrix

The matrix uses three words:

- **Supported** means the capability works today.
- **Degraded** means the implementation exists, but the runtime does not reach it yet or reaches it with less function.
- **Unsupported** means Tangled has no such capability. The runtime refuses it and never substitutes another forge.

| Feature | Tangled | Notes |
|---|---|---|
| Platform detection | Supported | `auto` selects Tangled when `TANGLED_REPO_DID` is set. An explicit `tangled` requires it. |
| Pull identity and metadata read | Supported | The Bobbin appview answers without a credential. |
| Normal review engine | Degraded | The same engine runs on GitHub and Forgejo, but a Tangled run stops at the diff read before the engine starts. |
| Verdict policy and required-check policy | Degraded | The same deterministic policy runs on every platform, but a Tangled run reaches no verdict. |
| Latest-round diff and changed files | Degraded | The round-diff read is implemented in `src/platform/tangled-diff.ts`, but the read adapter still refuses the diff. The run stops there. |
| Managed top-level review record | Degraded | The record client writes one record per pull and updates it in place on a re-review. The run stops at the diff read today. After that, publication fails closed until a trustworthy current-head read exists. |
| Inline findings on a diff line | Unsupported | Tangled has no inline review object. The findings stay in the review body. |
| Native approve or request-changes objects | Unsupported | Tangled has no native review verdict object. The verdict stays in the review body. |
| Review dismissal and minimization | Unsupported | The managed record is updated in place instead. |
| Review thread resolution | Unsupported | Tangled has no thread API. |
| GitHub GraphQL operations | Unsupported | The runtime never sends a GraphQL request on a Tangled run. |
| The native loop `gh_api` tool | Unsupported | The tool returns an error. There is no XRPC translation for it. |
| The native loop `repo_contents` tool | Unsupported | The file read fails. The checkout stays the source for file content. |
| CI and pipeline status polling | Unsupported | The runner turns the CI gate off. Tangled has no status seam. |
| Reviewer requests | Unsupported | The publish step logs a warning. |
| Label cleanup and ack reactions | Unsupported | Those paths need a GitHub event. The runner has no event. |
| Conversation comment replies | Unsupported | Tangled has no conversation comment surface. The managed review record is the only write. |
| Linked-source enrichment | Degraded | The enrichment client always targets github.com, so it serves GitHub repositories only. |
| Evidence providers | Degraded | The provider commands read the checkout. A provider that calls the GitHub API does not work on Tangled. |

## Guardrails

These guardrails hold on every Tangled run.

- The platform capability decides which client runs. A Tangled run never builds a GitHub or a Forgejo client for the pull. The linked-source enrichment is the only exception, and it always targets github.com.
- The runner refuses a `github` or `forgejo` platform input. A contradictory configuration stops the run.
- The publish step refuses to publish when it cannot prove that the pull did not advance since the review. The launch-time source commit is not a trustworthy source for that proof.
- The CI gate stays off. The runner does not start a status child that Tangled cannot serve.
- The publish step never asks for a native approval. A missing native surface degrades to the managed record.
- The diff is designed to come from the pull round, and the file content from the checkout. The runner does not trust a pull record for the commit that a review covers.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | The run skipped the review, the review published, or a newer head superseded the publication. |
| 1 | The review failed, the publication failed, the run refused a contradictory configuration, or a carried `request_changes` verdict blocked the run. |

## Related pages

- [Inputs and outputs](inputs.md) lists every input and output.
- [v2 to v3 migration](v3-migration.md) explains the platform seam and the removed runtime.
- [Fork reviews](fork-review.md) explains the privilege separation for fork pull requests.
