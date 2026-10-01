# Documentation

Start with the [quick start](../README.md#-quick-start); the defaults are the recommended setup.

## Using the action

| Page | Covers |
|---|---|
| [Inputs and outputs](inputs.md) | Every input and output with its default (generated from the action contract) |
| [Context and evidence](context-and-evidence.md) | Classification, standards and prompt files, linked issues, evidence providers, CI wait |
| [Tool loop](tool-loop.md) | The native tool loop, its tools, budgets, stop reasons and partial coverage |
| [Deep review](deep-review.md) | Specialist passes and how `deep-review: auto` picks them |
| [Verdicts and publishing](verdicts-and-publishing.md) | Verdict policies, publish modes, approvals, re-reviews, the unchanged-diff skip |
| [Models and routing](models-and-routing.md) | Endpoint setup, fallback models, fast/smart routing and escalation |
| [Telemetry](telemetry.md) | Review marker fields and the step summary |
| [Opt-in features](opt-in-features.md) | Default-off experimental features and their status |
| [Troubleshooting](troubleshooting.md) | Local models, proxy timeouts, common misconfigurations |
| [Repository config](repository-config.md) | The repository-owned config file that can narrow the operator's inputs |
| [Required checks](required-checks.md) | Required-check completeness validation |
| [Fork reviews](fork-review.md) | Privilege-separated reviews of fork pull requests |
| [v2 → v3 migration](v3-migration.md) | Upgrading from v2 |

## Contributing

| Page | Covers |
|---|---|
| [Architecture](architecture/) | Code map, pipeline and review-corpus internals |
| [Evals](evals.md) | Eval harness, corpora and the semantic gate |
| [v3 teardown audit](v3-teardown-audit.md) | History of the v2 runtime removal |
