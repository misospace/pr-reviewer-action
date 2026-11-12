# Self-hosted qualification

This page explains how to run the self-hosted qualification harness. The
harness proves that a self-hosted deployment can receive a forge event,
review a pull request, and publish the review.

## Current state

The harness script is `tests/self_hosted_e2e_qualification.sh`. Its
first scenario family, the two normal-review paths on GitHub and
Forgejo, landed with #1482. The failure, restart, supersession and
idempotency scenario family landed with #1483: a duplicate webhook, a
webhook burst that settles into one paid newest-head review, queued and
running supersession, a stale-result refusal, a worker crash and
requeue, a controller crash with a running worker and with queued
settle-window work, a cancelled review, a publication retry with no
second model call, single-counted usage across those retries and
restarts, a primary model failure, and a missed webhook found by
reconciliation. The engine parity and eval-qualification scenario
family landed with #1484: a harness-owned stub model server, one parity
pull request reviewed through the Action adapter and the self-hosted
local, OCI worker-image and Kubernetes-executor routes with
byte-identical artifacts, and a re-run of the deterministic
eval suite against the same engine build.
The same family re-runs the v3 parity suites, the v3 security suites,
and the broader eval corpus for that build (see
[Qualification suites against the engine build](#qualification-suites-against-the-engine-build)).
The remaining scenario families land one at a time (#1485).

A dispatched CI run executes the harness and reports its pass/fail.
The job still fails closed when the script is absent, so a green run
can never mean a qualification that did not run. The
`make self-hosted-qualification` target builds the v3 runtime bundle
when it is missing and then runs the harness. No qualification has run
yet: only a dispatched run makes one happen. A run now spends roughly
one model call per scenario on the disposable Forgejo instance (a
cancelled, superseded-in-queue, or failed-model scenario spends none).

The engine-parity family also runs on its own, from a workflow file of
its own. The `SELF_HOSTED_QUALIFICATION_FAMILY` setting selects the
scenario family: `all` (the default) runs every scenario the harness
owns, `parity` runs only the engine-parity family. The parity family
reads no operator credential, so the `self-hosted-qualification-parity`
job of the `self-hosted-qualification-parity.yaml` workflow runs it with
no secret and checks out the ref it was dispatched on. The qualification
stays an operator-dispatched run: the credential-free workflow is
dispatched like the credentialed one.

The qualification program is issue #739. This page covers the harness and
its run steps only. The deployment of the controller and the worker is
covered by [Self-hosted deployment](self-hosted-deployment.md).

## What the harness must prove

The harness must prove these paths. Each path is one scenario.

- A normal GitHub review through an adopted repository, with no
  per-repository workflow (#1482).
- A normal Forgejo review through the same job and engine boundary
  (#1482).
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
- Engine parity across the Action adapter and the self-hosted
  executors: one pull request, one head, byte-identical policy-stable
  artifacts (#1484).
- The deterministic eval suites re-run against the self-hosted engine
  build's source tree (#1484).
- The v3 parity suites re-run against the self-hosted engine build's
  source tree (#1484).
- The v3 security suites re-run against the self-hosted engine build's
  source tree (#1484).
- The broader eval corpus re-runs against the self-hosted engine build
  (#1484).
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

## Engine parity and approved nondeterminism

The engine-parity family (#1484) drives one dedicated parity pull
request — one fixture, one head — through four routes that all run the
same `dist/index.js` engine build: the Action adapter (the shipped
JavaScript action entry, driven with the runner's stage environment),
the self-hosted local executor (a webhook controller over a parity
instance config), the OCI worker image (the built worker target
rerunning the controller-written execution envelope over a fresh
exact-head clone), and the Kubernetes executor (the real executor, over
the same worker image).

The fourth route has no cluster behind it. The harness binds the
executor's own injected seams — the Job API and the per-run credential
store — to a harness-owned double
(`tests/harness/kubernetes-route.ts`) that launches the manifest's
container with docker. The executor's manifest building, envelope write,
credential projection, job polling and result collection are the shipped
code, so the route exercises the executor's real path rather than a
re-implementation of it.

What route D proves: the Kubernetes executor's own manifest, credential,
envelope and result-collection path runs end to end over the same worker
image and the same head, and produces the same artifact as the other
three routes.

What route D does not prove: there is no scheduler, no admission
control, no network policy, no kubelet and no real secret store behind
it, and the harness's loopback endpoints (the stub model server and the
disposable Forgejo) are reached over host networking. The double also
enforces none of the pod's own hardening — the container's read-only root
filesystem, its dropped capabilities, its seccomp profile, its resource
limits and its namespace are the cluster's business, not the double's. A
cluster-side defect — a policy that admits the wrong pod, a secret store
that keeps material past its deadline, a scheduler that places the
worker where the model endpoint is unreachable — is outside what this
harness can show. The deployment runbook covers the operator-side
requirements.

The double also stands in for the shared claim's permission model: the
controller writes the execution envelope `0600` as its own uid and the
worker writes the result `0600` as the pod's uid, so the double relaxes
those two files around the launch (the envelope becomes readable for the
worker's uid, the result file is pre-created writable so the controller
can read it back). The shipped chart does not give the controller
(`runAsUser` 1000) and the worker pod (uid 65532, pinned by the
executor) a claim they can both read, so that relaxation is a stand-in,
not a property the deployment has today — see issue #1631. The route
reports whether it relied on the relaxation, so a run never hides it.

A harness-owned stub model server makes the parity assertable: it is a
loopback Node service the harness starts before the parity scenarios
and kills in cleanup, shaped like the disposable Forgejo —
harness-provisioned test infrastructure, not a remote dependency. It
answers OpenAI-format chat-completions requests (streamed as SSE frames
or plain JSON) with a FIXED verdict, so the only variance left between
the routes is the routes themselves. The stub removes model-output
nondeterminism; it never reads or records a credential (a caller may
send one in an Authorization header; the stub ignores it).

The four produced artifacts are normalized to the policy-stable field
set (the fields the persisted review artifact always carries from the
parsed verdict: `verdict`, `review_markdown`, `smart_review_requested`,
`smart_review_reason`, `review_triage_decision`, `review_triage_reason`,
`review_triage_targets`, `findings`, `requirement_coverage`) and must
then be byte-identical. The approved nondeterminism — everything the
comparison deliberately excludes — is: run and job ids and the
forge-confirmed publication identity (comment ids), observed-at
timestamps and resource timings, usage and token accounting, and the
run-dir and workspace paths that leak through diagnostics surfaces.
Everything else must match byte-for-byte.

## Qualification suites against the engine build

The qualification proves that the engine build the self-hosted workers
run is the qualified engine the repository's own suites certify. The
harness re-runs those suites for that build, offline: no model call, no
network, no remote service, and no credential in the environment of the
child processes. The node suites run against the compiled runtime of the
very source tree that produced `dist/index.js`; the bundle-level suites
(the bundle contract, the gate entry points) and the eval-corpus replay
drive `dist/index.js` itself. Nothing in the qualification runs against
a different build.

- The **semantic** suite (`scripts/run_semantic_eval_ci.py` over
  `evals/corpus-historical-dogfood.json`) scores the deterministic
  regression corpus and runs the production-boundary dataflow groups
  against the compiled runtime.
- The **parity** suites (`action-yml`, `bundle`, `entrypoints`,
  `gate-workloads`, `golden-replay`, `platform`) assert the contract
  parity of the shipped artifact: the built bundle embeds the canonical
  contract and runs without the source tree, the generated action
  manifest matches the contract, the recorded golden decisions replay
  identically, the platform seam behaves the same on every forge, and
  the bundle's gate entry points run.
- The **security** suites (`credentials-result-channel`,
  `credentials-vault`, `credentials-worker-set`,
  `executor-kubernetes-credential-store`, `fence`, `findings-safe-path`,
  `ingress-github-app-signature`, `ingress-signature`, `instance-config`,
  `mcp-host`, `mcp-jsonrpc`, `mcp-tools`, `publish-body-bound`,
  `publish-comment-post`, `redact`, `safe-fetch`, `sanitize`,
  `secret-shape`, `tools-executors`, `worker-main`) assert the
  adversarial boundaries of the shipped engine: the sanitizer, the
  secret redaction and its shapes, the adaptive fence, the safe fetch,
  the path safety, the tool allowlists, the credential broker, the
  worker's credential projection, the Kubernetes credential store, the
  read-only MCP surface, the published body bounds, and the ingress
  signatures.
- The **eval corpus** replay drives the built bundle over the retained
  real-PR fixtures: the review context must be assembled from the
  fixture, with the defect file still in the diff, and the model call
  never happens.

The repository gate `tests/test_self_hosted_qualification.py` keeps the
declared suite lists honest: a renamed suite file, or a new
adversarial-boundary suite whose file name carries one of the gate's
vocabulary tokens, fails the gate instead of silently narrowing the
qualification.

## The credential-free parity family

`SELF_HOSTED_QUALIFICATION_FAMILY=parity` runs only the engine-parity
family: scenarios 17 to 25 — the four routes over one head compared
byte for byte, and the offline eval-suite re-runs against the same
engine build. The default family, `all`, runs every scenario the
harness owns.

The parity family reads no operator credential. Its model calls reach
the harness-owned stub model server, and its forge is the disposable
instance the harness starts, so the run needs neither the operator's
model key nor the GitHub App material. That is what lets it qualify
any ref, a pull-request head included: no credential reaches the
unreviewed branch code.

The two families live in two workflow files on purpose. GitHub takes
the workflow file from the ref that was dispatched, and a
`workflow_dispatch` run has no job selection: it runs every job of that
file. A workflow file that binds a secret must therefore never be
dispatched from an unreviewed ref, and a job meant to qualify an
unreviewed ref must never share such a file. The credential-free parity
job therefore has a workflow file of its own
(`.github/workflows/self-hosted-qualification-parity.yaml`), and the
credentialed qualification keeps
(`.github/workflows/self-hosted-qualification.yaml`).

Run it locally:

```bash
make self-hosted-qualification-parity
```

The target builds the v3 runtime bundle when `dist/index.js` is missing,
then runs the harness with `SELF_HOSTED_QUALIFICATION=true` and
`SELF_HOSTED_QUALIFICATION_FAMILY=parity`. The family needs no operator
credential. It needs the harness's own tools: Docker, Node, `curl` and
`jq` (the harness preflight), `git` (routes B, C and D clone the exact
head), and `python3` for the eval-suite scenarios, which skip with a
printed reason when `python3` is absent.

Run it in CI: dispatch the `Self-hosted qualification (engine parity)`
workflow (`.github/workflows/self-hosted-qualification-parity.yaml`)
from the ref to qualify. The job holds no secret and binds no
repository variable, it checks out the dispatched ref's head, and it
runs the parity family only.

GitHub dispatches only a workflow file that exists on the default
branch, so the parity workflow becomes dispatchable once it lands
there. Before that lands, an operator runs the same family locally
with `make self-hosted-qualification-parity` on a host with Docker.

The two jobs are not interchangeable. The credentialed
`self-hosted-qualification` job still pins the default branch, still
reads the operator's model credential and the GitHub App material, and
still runs the `all` family. The parity job qualifies the ref it was
dispatched on; the credentialed job qualifies the default branch. The
credentialed workflow itself is dispatched from the default branch, and
must stay so: it binds a secret, and GitHub takes the workflow file
from the dispatched ref.

## Run the harness locally

1. Install Docker and start the Docker daemon.
2. Set the model settings. The harness reads `AI_BASE_URL`, `AI_MODEL`, and
   `AI_API_KEY`.
3. Set the GitHub App settings. The harness reads
   `PR_REVIEWER_GITHUB_APP_ID` and `PR_REVIEWER_GITHUB_APP_PRIVATE_KEY`.
4. Name the GitHub test repository and the App installation. The harness
   reads `SELF_HOSTED_GITHUB_REPOSITORY` (`owner/name`) and
   `PR_REVIEWER_GITHUB_APP_INSTALLATION_ID`. The App must be installed
   on the repository's owner, and the repository must hold exactly one
   open pull request: the reconciler discovers that pull request through
   the GitHub App capability and the harness reviews it. Keep the test
   repository clean, because a qualification run spends one model call
   per forge.
5. Run the harness.

   ```bash
   make self-hosted-qualification
   ```

The make target builds the v3 runtime bundle when `dist/index.js` is
missing. The build needs Node and the packages in `package-lock.json`.

The `make self-hosted-qualification-parity` target runs the
credential-free parity family instead. See
[The credential-free parity family](#the-credential-free-parity-family).

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
reaches unreviewed branch code. The dispatched run therefore always
qualifies the harness as it stands on the default branch: a pull
request's own harness is qualified after it lands there.

The job reads the model credential from the repository secret
`SELF_HOSTED_AI_API_KEY`. The job reads the GitHub App material from the
repository secrets `SELF_HOSTED_GITHUB_APP_ID` and
`SELF_HOSTED_GITHUB_APP_PRIVATE_KEY`. The job fails when the model
credential is empty. The job reads the GitHub test repository and the
App installation id from the repository variables
`SELF_HOSTED_GITHUB_REPOSITORY` and
`SELF_HOSTED_GITHUB_APP_INSTALLATION_ID`.

The credential-free parity qualification lives in a workflow file of its
own (`.github/workflows/self-hosted-qualification-parity.yaml`): a
dispatch runs every job of the dispatched file, so the file that binds
a secret must never carry a job meant to qualify an unreviewed ref. Its
`self-hosted-qualification-parity` job holds no secret, checks out the
dispatched ref's head, and runs the parity family only. See
[The credential-free parity family](#the-credential-free-parity-family).

## Settings the harness reads

| Variable | Meaning | Required |
|---|---|---|
| `SELF_HOSTED_QUALIFICATION` | Opt-in gate. The harness runs only when the value is `true`. | Yes |
| `SELF_HOSTED_QUALIFICATION_FAMILY` | Which scenario family the harness runs: `all` (the default, every scenario the harness owns) or `parity` (only the engine-parity family, scenarios 17 to 25). | No |
| `AI_BASE_URL` | Base URL of the model endpoint. | Yes, except in the parity family |
| `AI_MODEL` | Name of the model. Defaults to `parity-stub-model` in the parity family. | Yes, except in the parity family |
| `AI_API_KEY` | Credential for the model endpoint. | Yes, except in the parity family |
| `PR_REVIEWER_GITHUB_APP_ID` | Numeric id of the GitHub App that the controller uses. | Only for the GitHub scenarios |
| `PR_REVIEWER_GITHUB_APP_PRIVATE_KEY` | PEM private key of that GitHub App. | Only for the GitHub scenarios |
| `PR_REVIEWER_GITHUB_APP_INSTALLATION_ID` | Installation id of that App on the test repository's owner. The controller mints the installation token itself. | Only for the GitHub scenarios |
| `SELF_HOSTED_GITHUB_REPOSITORY` | `owner/name` of the GitHub test repository. It must hold exactly one open pull request. | Yes, except in the parity family |
| `GITHUB_API_URL` | Base URL of the GitHub API. The default is `https://api.github.com`. Set the repository variable `SELF_HOSTED_GITHUB_API_URL` when the GitHub side is not `https://api.github.com`. | No |
| `FORGEJO_TOKEN` | Credential for the Forgejo side. The harness mints its own token when it provisions the disposable instance, as it does today; the controller reads this name for that token. | Only when the harness drives an existing Forgejo |
| `PR_REVIEWER_CREDENTIAL_GITHUB` | The GitHub forge integration's credential material (`#735` reference `github`): the forge-read material the review run's worker projects. When it is absent, the GitHub review scenario skips with that reason (see Known limits). | Only for the GitHub review scenario |

These names match the self-hosted runtime. A harness that reads other names
must update this table and the CI workflow in the same change.

The harness also reads tunables with safe defaults, each validated before
any container starts: `SELF_HOSTED_FORGEJO_IMAGE` (default
`codeberg.org/forgejo/forgejo:9`), `SELF_HOSTED_POSTGRES_IMAGE` (default
`postgres:16`), the ports `SELF_HOSTED_FORGEJO_PORT`,
`SELF_HOSTED_POSTGRES_PORT`, `SELF_HOSTED_FORGEJO_WEBHOOK_PORT`,
`SELF_HOSTED_FORGEJO_ADMIN_PORT`, `SELF_HOSTED_GITHUB_ADMIN_PORT`,
`SELF_HOSTED_STUB_MODEL_PORT` (the #1484 parity stub model server on the
harness's own loopback), and the
per-scenario budget `SELF_HOSTED_REVIEW_TIMEOUT_SEC` (default `900`).

The GitHub App credential needs no separate personal access token. The
controller owns the credential lifecycle of the App, and it mints the
installation token for each repository. See
[Post-v3 self-hosted GitHub App ingress](architecture/self-hosted-github-app-ingress.md).

## Known limits

- The credential-free parity job qualifies a chosen ref, but no parity
  run has happened yet: the Docker-backed harness has never run in CI.
  The qualification remains an operator-dispatched run. The parity
  workflow becomes dispatchable once it lands on the default branch;
  until then the family runs locally.
- The execution envelope carries the forge platform, its API base URL, and
  the operator's model settings (#1496 landed): the AI base URL, the wire
  model id, and the wire format ride the envelope, and the model
  credential reaches the worker through the #735 projection. The harness
  must therefore configure a model profile that names a `model` id; a
  profile without one refuses the review at composition.
- The scenarios land one at a time. A run reports only the scenarios that
  exist on the day of the run.
- The GitHub scenario cannot receive a webhook on a disposable host, so
  it is driven by the reconciler discovering the open test pull request
  through the GitHub App capability. The webhook intake itself is
  qualified by the Forgejo scenario, whose delivery the controller's own
  HMAC verification accepts.
- The worker-timeout scenario is not drivable in this composition and the
  harness skips it with a printed reason instead of fabricating coverage:
  webhook-minted jobs carry no execution deadline (`buildReviewJob`
  leaves `deadlineAtMs` 0) and the controller composition exposes no
  queue-timing settings, so neither the worker's whole-process deadline
  backstop nor the queue's lease-expiry path (a 30-minute lease by
  default) can be driven inside the scenario budget. The deadline and
  lease-expiry semantics are qualified at the composition level by
  `tests-v3/controller-daemon.test.ts` and
  `tests-v3/queue-recovery-settle.test.ts`.
- The model-fallback leg of the primary-failure scenario is not drivable
  in this composition and is likewise skipped with a printed reason: the
  execution envelope carries ONE model selection (the endpoint, wire
  model id, and wire format of the operator's default model profile —
  #1496), and the worker's engine inputs map no `ai-fallback-*`
  coordinates, so an availability fallback to a second model cannot be
  exercised end-to-end. The scenario drives the primary-failure leg (a
  closed model endpoint exhausts the bounded attempts with no counted
  spend and nothing published) and labels the fallback leg per #739's
  "clearly label externally untestable behavior" rule.
- The Kubernetes-executor route of the engine-parity family (#1484) runs
  the real executor against a harness-owned cluster double, not against a
  cluster: there is no scheduler, no admission control, no network
  policy, no kubelet and no real secret store behind it, and the
  harness's loopback endpoints are reached over host networking. The
  route proves the executor's own manifest, credential, envelope and
  result-collection path, never a cluster's behavior.
- The eval-suite and eval-corpus scenarios of the engine-parity family
  need `python3` on the PATH (the semantic gate and the eval harness are
  Python). When `python3` is absent the scenario prints a
  skip-with-reason line instead of failing; the dispatched runner
  provides `python3`.
- The eval-corpus scenario re-runs the retained real-PR fixtures only
  (#1609): an eval entry without a retained fixture needs a live clone of
  its forge repository, which this harness never does, so the scenario
  covers the fixture-pinned entries and says so. The corpora that need a
  model call are not replayed either: the context-only mode stops before
  the model call.
- The GitHub review scenario's worker leg (#1484) needs the forge
  integration's credential material in the environment
  (`PR_REVIEWER_CREDENTIAL_GITHUB`): the review run's worker projects its
  forge-read material from the instance config's `credential: github`
  reference (#735), and an App-only deployment has no env-defined
  material for it. Without it the worker's publish-purpose resolution
  fails closed (`unknown_reference`), so the scenario skips with that
  reason instead of waiting out a guaranteed-fail review. Wiring the
  controller's per-job installation-token mint into the worker
  projection is the follow-up (#1484-split).
