# Self-hosted qualification

This page explains how to run the self-hosted qualification harness. The
harness proves that a self-hosted deployment can receive a forge event,
review a pull request, and publish the review.

## Current state

The harness script is not implemented yet. It is
`tests/self_hosted_e2e_qualification.sh`, and it lands with issue #1482.
The scenario families land one at a time (#1482, #1483, #1484, #1485).

Until the harness lands, a dispatched CI job fails closed: it exits
non-zero instead of reporting a qualification that did not run. The
`make self-hosted-qualification` target reports that the harness is
absent. No qualification has run yet.

The qualification program is issue #739. This page covers the harness and
its run steps only. The deployment of the controller and the worker is
covered by [Self-hosted deployment](self-hosted-deployment.md).

## What the harness must prove

The harness must prove these paths. Each path is one scenario.

- A normal GitHub review through an adopted repository, with no
  per-repository workflow.
- A normal Forgejo review through the same job and engine boundary.
- A duplicate webhook event.
- A webhook burst that settles into one paid review of the newest head.
- A missed webhook event that the reconciler finds, with no duplicate work.
- A new head that arrives while the old review waits in the queue.
- A new head that arrives while the old review runs.
- A stale result that tries to publish.
- A worker that times out.
- A worker that crashes and loses its lease.
- A controller that restarts while jobs wait in the queue.
- A cancelled review.
- A publication that fails, followed by a retry with no second model call.
- Usage and cost accounting that counts one review across retries and
  restarts.
- A primary model failure that falls back to the fallback model.
- A fork pull request and a private repository, with the secret boundary
  intact.
- A publication that replaces the managed review of the same head.

## Rules for the harness

These rules apply to every scenario.

- Every forge read and write travels through the configured forge
  capability. The forge capability is the module that builds each forge
  request. It keeps the credential in the request header, and it refuses
  redirects. Never call a forge CLI such as `gh`, `gj`, `tea`, `gitea`, or
  `forgejo`. Never reach a remote forge API with `curl` or `wget`.
- The harness points only at a disposable Forgejo instance and at a test
  repository that the operator names. It never points at a production
  forge.
- The harness reads every credential from the environment. A credential
  never appears in an argument, in a URL, or in a log line.
- The harness refuses to run unless `SELF_HOSTED_QUALIFICATION=true` is set.
- The harness prints one line per scenario. It exits 0 when every scenario
  passed. It exits non-zero when a scenario failed.

The harness can use a raw HTTP client against its own disposable Forgejo
instance. It provisions that instance and its token, and the forge
capability cannot create either one.

The repository gate `tests/test_self_hosted_qualification.py` checks the
harness script for a forge CLI call and for a raw HTTP client that reaches
a remote forge. The gate checks the CI job for the same.

## Run the harness locally

1. Install Docker and start the Docker daemon.
2. Set the model settings. The harness reads `AI_BASE_URL`, `AI_MODEL`, and
   `AI_API_KEY`.
3. Set the GitHub App settings. The harness reads
   `PR_REVIEWER_GITHUB_APP_ID` and `PR_REVIEWER_GITHUB_APP_PRIVATE_KEY`.
4. Run the harness.

   ```bash
   make self-hosted-qualification
   ```

The make target builds the v3 runtime bundle when `dist/index.js` is
missing. The build needs Node and the packages in `package-lock.json`.

## Run the harness in CI

1. Open the Actions tab of the repository.
2. Select the Self-hosted qualification workflow
   (`.github/workflows/self-hosted-qualification.yaml`).
3. Select Run workflow.
4. Enter the model base URL and the model name.
5. The job `self-hosted-qualification` starts.

The workflow runs only on a manual dispatch. It never runs on a push or a
pull request. The job is not part of the aggregate gate, so it never blocks
a merge. The checkout pins the default branch, so a credential never
reaches unreviewed branch code.

The job reads the model credential from the repository secret
`SELF_HOSTED_AI_API_KEY`. The job reads the GitHub App material from the
repository secrets `SELF_HOSTED_GITHUB_APP_ID` and
`SELF_HOSTED_GITHUB_APP_PRIVATE_KEY`. The job fails when the model
credential is empty.

## Settings the harness reads

| Variable | Meaning | Required |
|---|---|---|
| `SELF_HOSTED_QUALIFICATION` | Opt-in gate. The harness runs only when the value is `true`. | Yes |
| `AI_BASE_URL` | Base URL of the model endpoint. | Yes |
| `AI_MODEL` | Name of the model. | Yes |
| `AI_API_KEY` | Credential for the model endpoint. | Yes |
| `PR_REVIEWER_GITHUB_APP_ID` | Numeric id of the GitHub App that the controller uses. | Only for the GitHub scenarios |
| `PR_REVIEWER_GITHUB_APP_PRIVATE_KEY` | PEM private key of that GitHub App. | Only for the GitHub scenarios |
| `GITHUB_API_URL` | Base URL of the GitHub API. The default is `https://api.github.com`. Set the repository variable `SELF_HOSTED_GITHUB_API_URL` when the GitHub side is not `https://api.github.com`. | No |
| `FORGEJO_TOKEN` | Credential for an existing Forgejo. | Only when the harness drives an existing Forgejo |

These names match the self-hosted runtime. A harness that reads other names
must update this table and the CI workflow in the same change.

The GitHub App credential needs no separate personal access token. The
controller owns the credential lifecycle of the App, and it mints the
installation token for each repository. See
[Post-v3 self-hosted GitHub App ingress](architecture/self-hosted-github-app-ingress.md).

## Known limits

- The execution envelope carries the forge platform and its API base URL. It
  does not carry the model settings (#1496). A worker-driven review cannot
  reach the model until that issue lands. The harness records such a
  scenario as `worker_error`.
- The scenarios land one at a time. A run reports only the scenarios that
  exist on the day of the run.
