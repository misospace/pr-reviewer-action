# Synthetic primary artifacts — confidence-scorer calibration pilot (#1074)

**Everything in this directory tree is SYNTHETIC.** These are fabricated
review artifacts (diff, ai-output.json, review-coverage.json) written by
hand for the offline pilot — they are NOT real reviews of real PRs, and no
id here matches any entry in `evals/corpus-real-prs.json` or
`evals/corpus-human-findings.json`. That separation is deliberate: mock
scorer rows must never masquerade as corpus entries, so the report marks
every row produced from this index as `source=fixture`.

`runs.json` mirrors the shape `scripts/confidence_calibration.py review`
writes (mode/work_dir/entries), with two pilot-only additions:
`synthetic: true` on the index and each entry, plus a `defect` object on
the two vulnerable-role entries — the synthetic ground truth the report's
risk-band calibration compares against. `run_dir` values are relative to
this file's directory.

Entry roles:

- `pilot-synth-alpha` — vulnerable role, primary_ok, verdict **approve**,
  **no findings** — the false-green scenario: the primary wrongly approves a
  known defect and the scorer's canned answer says 5/low, so nothing catches
  it (the deterministic ceilings cannot fire on an empty findings list).
- `pilot-synth-blocker` — vulnerable role, primary_ok with a **blocker**
  finding (the deterministic ceiling must cap a raw 5 down to 2).
- `pilot-synth-partial-novel` — vulnerable role, primary_ok with a
  **major** finding, **partial coverage**, and a defect file
  (`src/widget/qux.ts`) that the primary findings never name
  (the major cap fires first and lands the raw 5 at 3, so the recorded
  caps are `["major_cap_3"]` — the incomplete-coverage cap cannot fire
  once the score is already 3 — plus the novel-concern candidate
  scenario).
- `pilot-synth-flip` — clean role, primary_ok, minor finding (repeat pair
  4 then 3 for the flip-rate scenario; the 4 is also the clean-ish
  score-4 scenario).
- `pilot-synth-unscored` — clean role, primary_ok whose canned answers are
  a simulated `http_429` (repeat 0) and a score of 999 (repeat 1), both of
  which must land as unscored rows outside every denominator.
- `pilot-synth-errored` — **primary_errored** (ok=false, no artifacts).
- `pilot-synth-missing` — **primary_artifacts_missing** (ok=true but
  ai-output.json/review-coverage.json absent).

Run the offline demo end to end:

`score` writes its per-row audit files under `<runs-dir>/audit/`, so
point `--runs-dir` at a **copy** of this directory in scratch space, not
at the committed fixtures themselves (a demo run against the committed
tree would leave an untracked `audit/` tree behind).

```bash
python scripts/confidence_calibration.py plan \
  --plan evals/confidence-calibration/sample-plan.json
python scripts/confidence_calibration.py score \
  --plan evals/confidence-calibration/sample-plan.json \
  --runs-dir evals/confidence-calibration/fixtures/primary \
  --out /tmp/confidence-pilot-results.json \
  --condition mock \
  --allow-missing-corpus-entry
python scripts/confidence_calibration.py report \
  --results /tmp/confidence-pilot-results.json
```
