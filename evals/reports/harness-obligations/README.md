# Evidence: harness obligations on vs off (#796)

`summary.json` backs the `harness-obligations` default (`false`). Generated
2026-09-29 with `scripts/eval_harness.py --corpus <shard> --modes native_loop`,
one model (`MiniMax-M3`, anthropic format, no fallback or smart route), 3 runs
per PR per arm, arms interleaved per run.

- Corpus: the 37 entries of `evals/corpus-human-findings.json` where a
  context-only pass showed an obligation naming the defect file.
- `on`: the build at the time, obligations injected into the requirement ledger.
- `off`: the same build with obligations suppressed; all other context identical.

Result: no recall gain. Strict recall 32.4% on vs 34.2% off; the paired per-PR
delta is -1.8pp (95% bootstrap CI -11.7 to +7.2), 8 PRs better, 8 worse, 21
tied. Tool calls and findings per run are unchanged; request_changes rises
4.5pp. The sample cannot resolve effects smaller than about 10pp.
