# Evidence: harness obligations on vs off (#796)

Backs the `harness-obligations` default (`false`). Generated 2026-09-29 with
`scripts/eval_harness.py --corpus <shard> --modes native_loop`, one model
(`MiniMax-M3`, anthropic format, no fallback or smart route), 3 runs per PR per
arm, arms interleaved per run.

- Corpus: the 37 entries of `evals/corpus-human-findings.json` where a
  context-only pass showed an obligation naming the defect file.
- `on`: obligations injected into the requirement ledger.
- `off`: the same build with obligations suppressed; all other context identical.

## Files

- `summary.json`: per-PR per-arm counts, the automatic scores, and the
  adjudicated totals (`adjudicated`).
- `adjudication.json`: every finding (468) with its arm, run, and a manual
  label: `same_defect` (yes/partial/no against the human finding) and, for
  blocker/major findings that are not the defect, `fp_label` (real /
  false_positive), each with a one-line evidence note from the code at the
  reviewed head. Labels were assigned blind: arms stripped and findings
  shuffled before adjudication, unblinded after. Hostnames are redacted.

## Result

No recall gain, no false-positive improvement.

| | on | off |
| --- | --- | --- |
| Runs that caught the human defect (adjudicated) | 24/111 (21.6%) | 27/111 (24.3%) |
| ...counting partial catches | 38/111 (34.2%) | 33/111 (29.7%) |
| Blocker/major findings | 146 | 138 |
| ...false positives | 47 (0.42/run) | 43 (0.39/run) |
| ...real, other than the defect | 59 | 59 |
| Automatic strict hit (line match) | 32.4% | 34.2% |

Paired per-PR deltas (on minus off, 95% bootstrap CI): catches -2.7pp
(-12.6 to +7.2), catches incl. partial +4.5pp (-2.7 to +11.7), blocker/major
false positives +0.04/run (-0.14 to +0.22). Obligations point reviews at the
right code slightly more often (partials) without turning that into catches.
The sample cannot resolve effects smaller than about 10pp.

The automatic line-match score overstates catches by about half relative to
adjudication (32-34% vs 22-24%): a finding near the defect lines is not the
same finding.

## Corpus caveats (affect both arms equally)

- `joryirving/home-ops#5853`: the replay's PR file list comes from later
  commits than the pinned head, so some findings describe files that do not
  exist at that head (labelled false_positive).
- `joryirving/home-ops#9075`: the pinned head already contains the fix.
