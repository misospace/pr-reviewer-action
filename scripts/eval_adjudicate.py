#!/usr/bin/env python3
"""Blind adjudication for real-PR recall claims (#841).

`scripts/eval_harness.py`'s real-PR scorer counts a "strict hit" when a
finding lands on the defect file within the defect's line range (plus
tolerance). #796's manual adjudication showed that overstates real catches
by about half: a finding near the defect lines is often a *different* issue
than the one the human found. This tool packages that manual process --
blind, semantic labeling of findings against the defect description -- so
future recall claims can cite adjudicated numbers instead of the line-match
score alone. See `evals/reports/harness-obligations/` for the #796 worked
example this tool reproduces.

Pipeline
--------

1. ``pack``: read one or more `scripts/eval_harness.py` report JSONs (each
   tagged with an arm label by the caller, e.g. ``--arm on=a.json,b.json
   --arm off=c.json``), strip every finding of its arm/run identity, shuffle
   PRs and findings with a fixed seed, and split them into N blind packets
   for adjudicators. Writes ``unblind-key.json`` (which finding belongs to
   which arm/run/PR) and ``roster.json`` (every run that existed, including
   runs with zero findings) separately -- adjudicators never see either.

2. Adjudicators (human or agent) read a ``packet{k}.json`` and write a
   matching ``verdicts{k}.json``: a list of
   ``{"fid": ..., "same_defect": "yes|partial|no", "fp_label":
   "real|false_positive|unverifiable"|null, "note": "..."}``.

   Rubric (verbatim -- give this to adjudicators):

     - ``same_defect`` is judged against the scenario's defect description,
       not the defect's file/line anchor: "yes" if the finding describes the
       same underlying defect a human reviewer flagged, "partial" if it
       overlaps or describes one facet of it, "no" otherwise.
     - ``fp_label`` is set ONLY for findings at ``blocker``/``major``
       severity that are NOT ``same_defect: yes``. Check the finding against
       the code at the PR's ``head_sha``: "real" if it describes an actual,
       verifiable problem unrelated to the defect being measured,
       "false_positive" if it does not hold up against the code (wrong file
       state, misreads the diff, hallucinated), "unverifiable" if the code
       needed to check it isn't available. Leave ``fp_label`` null for
       ``same_defect: yes`` findings and for minor/info findings.
     - ``note`` is a one-line citation of the evidence (e.g. a file:line and
       what's actually there) backing the label above.

3. ``score``: validate every fid is labelled exactly once, unblind using
   ``unblind-key.json``, and compute per-arm adjudicated totals, rates, and
   paired per-PR deltas (with a 95% bootstrap CI) between two named arms.
   Also exports ``adjudication.json`` -- the #796 report's own format.

Everything here is pure stdlib: no network, no model calls.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import sys
from pathlib import Path
from typing import Any, Iterable

DEFAULT_SEED = 42
DEFAULT_ITERS = 10000
BLOCKER_MAJOR = {"blocker", "major"}
VALID_SAME_DEFECT = {"yes", "partial", "no"}
VALID_FP_LABEL = {"real", "false_positive", "unverifiable"}


# ---------------------------------------------------------------------------
# shared helpers


def _pr_id(scenario: dict[str, Any]) -> str:
    return f"{scenario['repo_full_name']}#{scenario['number']}@{scenario['head_sha']}"


def _scenario_meta(scenario: dict[str, Any]) -> dict[str, Any]:
    meta: dict[str, Any] = {
        "id": scenario.get("id"),
        "repo": scenario.get("repo_full_name"),
        "number": scenario.get("number"),
        "head_sha": scenario.get("head_sha"),
    }
    defect = scenario.get("defect")
    if isinstance(defect, dict):
        meta["defect"] = defect.get("description")
    return meta


def _iter_runs(runs_by_mode: dict[str, Any]) -> Iterable[tuple[str, int, dict[str, Any]]]:
    """Yield (mode, 1-based rep index, run dict) for every run in a
    scenario's ``runs`` mapping, whether a given mode's value is a single run
    dict (runs-per-mode == 1) or a list of run dicts (#860, runs-per-mode >
    1) -- both shapes are supported.
    """
    for mode, run_or_list in runs_by_mode.items():
        runs_list = run_or_list if isinstance(run_or_list, list) else [run_or_list]
        for idx, run in enumerate(runs_list, start=1):
            yield mode, idx, run


def _rep_label(mode: str, idx: int, multi_mode: bool) -> str:
    return f"{mode}.r{idx}" if multi_mode else f"r{idx}"


def _load_json(path: str) -> Any:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _write_json(path: Path, obj: Any) -> None:
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# pack


def _parse_arm_arg(spec: str) -> tuple[str, list[str]]:
    if "=" not in spec:
        raise argparse.ArgumentTypeError(f"--arm must be LABEL=path1,path2,...; got {spec!r}")
    label, paths = spec.split("=", 1)
    label = label.strip()
    path_list = [p.strip() for p in paths.split(",") if p.strip()]
    if not label or not path_list:
        raise argparse.ArgumentTypeError(f"--arm must be LABEL=path1,path2,...; got {spec!r}")
    return label, path_list


def cmd_pack(args: argparse.Namespace) -> int:
    arms: list[tuple[str, list[str]]] = [_parse_arm_arg(spec) for spec in args.arm]

    pr_groups: dict[str, dict[str, Any]] = {}
    unblind_key: dict[str, dict[str, str]] = {}
    roster: list[dict[str, str]] = []
    fid_counter: dict[str, int] = {}

    for arm_label, paths in arms:
        for path in paths:
            report = _load_json(path)
            for scenario in report.get("per_scenario_results", []):
                pr = _pr_id(scenario)
                meta = _scenario_meta(scenario)
                group = pr_groups.setdefault(pr, {"meta": meta, "findings": []})
                if group["meta"] != meta:
                    raise SystemExit(
                        f"pack: conflicting metadata for {pr} between reports "
                        f"({group['meta']!r} vs {meta!r})"
                    )

                runs_by_mode = scenario.get("runs", {})
                multi_mode = len(runs_by_mode) > 1
                for mode, idx, run in _iter_runs(runs_by_mode):
                    rep = _rep_label(mode, idx, multi_mode)
                    roster.append({"arm": arm_label, "pr": pr, "rep": rep})
                    findings = run.get("findings") or []
                    for i, finding in enumerate(findings):
                        raw = f"{pr}|{arm_label}|{rep}|{i}"
                        fid = hashlib.sha256(raw.encode()).hexdigest()[:16]
                        if fid in fid_counter:
                            # Extremely unlikely (would need a truncated-hash
                            # collision), but never silently merge findings.
                            raise SystemExit(f"pack: fid collision for {raw!r}")
                        fid_counter[fid] = 1
                        pr_groups[pr]["findings"].append(
                            {
                                "fid": fid,
                                "severity": finding.get("severity"),
                                "category": finding.get("category"),
                                "file": finding.get("file"),
                                "line": finding.get("line"),
                                "message": finding.get("message"),
                            }
                        )
                        unblind_key[fid] = {"arm": arm_label, "rep": rep, "pr": pr}

    rng = random.Random(args.seed)
    pr_order = sorted(pr_groups.keys())
    rng.shuffle(pr_order)
    for pr in pr_order:
        pr_groups[pr]["findings"].sort(key=lambda f: f["fid"])
        rng.shuffle(pr_groups[pr]["findings"])

    n = args.packets
    packets: list[list[dict[str, Any]]] = [[] for _ in range(n)]
    for i, pr in enumerate(pr_order):
        packets[i % n].append(pr_groups[pr])

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for k, packet in enumerate(packets, start=1):
        _write_json(out_dir / f"packet{k}.json", packet)
    _write_json(out_dir / "unblind-key.json", unblind_key)
    roster.sort(key=lambda r: (r["arm"], r["pr"], r["rep"]))
    _write_json(out_dir / "roster.json", roster)

    total_findings = sum(len(g["findings"]) for g in pr_groups.values())
    print(
        f"pack: {len(pr_groups)} PRs, {len(roster)} runs, {total_findings} findings "
        f"-> {n} packets in {out_dir}",
        file=sys.stderr,
    )
    return 0


# ---------------------------------------------------------------------------
# score


def _load_packets(paths: list[str]) -> dict[str, dict[str, Any]]:
    """fid -> finding content ({severity, category, file, line, message})."""
    by_fid: dict[str, dict[str, Any]] = {}
    for path in paths:
        for group in _load_json(path):
            for finding in group.get("findings", []):
                fid = finding["fid"]
                if fid in by_fid:
                    raise SystemExit(f"score: fid {fid!r} appears in more than one packet")
                by_fid[fid] = {
                    "severity": finding.get("severity"),
                    "category": finding.get("category"),
                    "file": finding.get("file"),
                    "line": finding.get("line"),
                    "message": finding.get("message"),
                }
    return by_fid


def _load_verdicts(paths: list[str]) -> dict[str, dict[str, Any]]:
    by_fid: dict[str, dict[str, Any]] = {}
    for path in paths:
        for verdict in _load_json(path):
            fid = verdict["fid"]
            if fid in by_fid:
                raise SystemExit(f"score: fid {fid!r} labelled more than once across --verdicts")
            same_defect = verdict.get("same_defect")
            fp_label = verdict.get("fp_label")
            if same_defect not in VALID_SAME_DEFECT:
                raise SystemExit(f"score: {fid} has invalid same_defect {same_defect!r}")
            if fp_label is not None and fp_label not in VALID_FP_LABEL:
                raise SystemExit(f"score: {fid} has invalid fp_label {fp_label!r}")
            by_fid[fid] = {
                "same_defect": same_defect,
                "fp_label": fp_label,
                "note": verdict.get("note", ""),
            }
    return by_fid


def _validate(unblind_key: dict[str, Any], packets: dict[str, Any], verdicts: dict[str, Any]) -> None:
    key_fids = set(unblind_key)
    verdict_fids = set(verdicts)
    missing = key_fids - verdict_fids
    extra = verdict_fids - key_fids
    if missing:
        raise SystemExit(f"score: {len(missing)} fid(s) in unblind-key have no verdict: {sorted(missing)[:5]}...")
    if extra:
        raise SystemExit(f"score: {len(extra)} verdict fid(s) not in unblind-key: {sorted(extra)[:5]}...")
    packet_fids = set(packets)
    unmatched = key_fids - packet_fids
    if unmatched:
        raise SystemExit(f"score: {len(unmatched)} fid(s) in unblind-key not found in --packets: {sorted(unmatched)[:5]}...")

    for fid in key_fids:
        finding = packets[fid]
        verdict = verdicts[fid]
        if verdict["fp_label"] is not None:
            if finding.get("severity") not in BLOCKER_MAJOR:
                raise SystemExit(
                    f"score: {fid} has fp_label={verdict['fp_label']!r} but severity "
                    f"{finding.get('severity')!r} is not blocker/major"
                )
            if verdict["same_defect"] == "yes":
                raise SystemExit(f"score: {fid} has fp_label set but same_defect is 'yes'")


def _build_runs_map(
    roster: list[dict[str, str]],
    unblind_key: dict[str, dict[str, str]],
    packets: dict[str, dict[str, Any]],
    verdicts: dict[str, dict[str, Any]],
) -> dict[tuple[str, str, str], list[dict[str, Any]]]:
    runs_map: dict[tuple[str, str, str], list[dict[str, Any]]] = {
        (r["arm"], r["pr"], r["rep"]): [] for r in roster
    }
    for fid, key in unblind_key.items():
        run_key = (key["arm"], key["pr"], key["rep"])
        if run_key not in runs_map:
            # A run that produced findings but wasn't in the roster: still
            # score it, but this means --runs is incomplete.
            runs_map[run_key] = []
        merged = {**packets[fid], **verdicts[fid], "fid": fid}
        runs_map[run_key].append(merged)
    return runs_map


def _arm_totals(runs_map: dict[tuple[str, str, str], list[dict[str, Any]]], arm: str) -> dict[str, Any]:
    keys = [k for k in runs_map if k[0] == arm]
    runs = len(keys)
    semantic_catch = sum(1 for k in keys if any(f["same_defect"] == "yes" for f in runs_map[k]))
    catch_incl_partial = sum(
        1 for k in keys if any(f["same_defect"] in ("yes", "partial") for f in runs_map[k])
    )
    bm = [f for k in keys for f in runs_map[k] if f.get("severity") in BLOCKER_MAJOR]
    bm_false_positive = sum(1 for f in bm if f["fp_label"] == "false_positive")
    bm_real_other = sum(1 for f in bm if f["fp_label"] == "real")
    runs_with_bm_fp = sum(
        1
        for k in keys
        if any(f.get("severity") in BLOCKER_MAJOR and f["fp_label"] == "false_positive" for f in runs_map[k])
    )

    def _rate(n: int, d: int) -> float | None:
        return round(n / d, 4) if d else None

    return {
        "runs": runs,
        "semantic_catch": semantic_catch,
        "catch_incl_partial": catch_incl_partial,
        "blocker_major": len(bm),
        "bm_false_positive": bm_false_positive,
        "bm_real_other": bm_real_other,
        "runs_with_bm_fp": runs_with_bm_fp,
        "semantic_catch_rate": _rate(semantic_catch, runs),
        "catch_incl_partial_rate": _rate(catch_incl_partial, runs),
        "bm_false_positive_per_run": _rate(bm_false_positive, runs),
    }


def _per_pr_metric(
    runs_map: dict[tuple[str, str, str], list[dict[str, Any]]],
    arm: str,
    pr: str,
    reps: list[str],
    metric: str,
) -> int:
    total = 0
    for rep in reps:
        findings = runs_map.get((arm, pr, rep), [])
        if metric == "catch":
            total += 1 if any(f["same_defect"] == "yes" for f in findings) else 0
        elif metric == "catch_incl_partial":
            total += 1 if any(f["same_defect"] in ("yes", "partial") for f in findings) else 0
        elif metric == "bm_fp":
            total += sum(
                1 for f in findings if f.get("severity") in BLOCKER_MAJOR and f["fp_label"] == "false_positive"
            )
        else:
            raise ValueError(metric)
    return total


def _paired_delta(
    runs_map: dict[tuple[str, str, str], list[dict[str, Any]]],
    roster: list[dict[str, str]],
    arm_a: str,
    arm_b: str,
    metric: str,
    seed: int,
    iters: int,
) -> dict[str, Any]:
    reps_by_pr_arm: dict[tuple[str, str], list[str]] = {}
    for r in roster:
        reps_by_pr_arm.setdefault((r["arm"], r["pr"]), []).append(r["rep"])

    prs_a = {r["pr"] for r in roster if r["arm"] == arm_a}
    prs_b = {r["pr"] for r in roster if r["arm"] == arm_b}
    prs = sorted(prs_a & prs_b)
    if not prs:
        return {"prs_compared": 0}

    base: list[tuple[int, int, int, int]] = []  # (count_a, reps_a, count_b, reps_b)
    for pr in prs:
        reps_a = reps_by_pr_arm.get((arm_a, pr), [])
        reps_b = reps_by_pr_arm.get((arm_b, pr), [])
        count_a = _per_pr_metric(runs_map, arm_a, pr, reps_a, metric)
        count_b = _per_pr_metric(runs_map, arm_b, pr, reps_b, metric)
        base.append((count_a, len(reps_a), count_b, len(reps_b)))

    def rate_delta(item: tuple[int, int, int, int]) -> float:
        count_a, reps_a, count_b, reps_b = item
        rate_a = count_a / reps_a if reps_a else 0.0
        rate_b = count_b / reps_b if reps_b else 0.0
        return rate_a - rate_b

    deltas = [rate_delta(item) for item in base]
    better = sum(1 for d in deltas if d > 0)
    worse = sum(1 for d in deltas if d < 0)
    tied = sum(1 for d in deltas if d == 0)

    rng = random.Random(seed)
    n = len(base)
    boot: list[float] = []
    for _ in range(iters):
        sample = [base[rng.randrange(n)] for _ in range(n)]
        boot.append(sum(rate_delta(item) for item in sample) / n)
    boot.sort()
    lo_idx = max(0, int(0.025 * iters))
    hi_idx = min(iters - 1, int(0.975 * iters))

    return {
        "prs_compared": n,
        "mean": round(sum(deltas) / n, 4),
        "ci95": [round(boot[lo_idx], 4), round(boot[hi_idx], 4)],
        f"prs_{arm_a}_better": better,
        f"prs_{arm_a}_worse": worse,
        "prs_tied": tied,
    }


def _redact(message: str | None, pattern: re.Pattern[str] | None) -> str | None:
    if message is None or pattern is None:
        return message
    return pattern.sub("<host>", message)


def cmd_score(args: argparse.Namespace) -> int:
    unblind_key = _load_json(args.unblind_key)
    packets = _load_packets(args.packets)
    verdicts = _load_verdicts(args.verdicts)
    roster = _load_json(args.runs)

    _validate(unblind_key, packets, verdicts)
    runs_map = _build_runs_map(roster, unblind_key, packets, verdicts)

    arms = sorted({r["arm"] for r in roster})
    totals = {arm: _arm_totals(runs_map, arm) for arm in arms}

    paired: dict[str, Any] = {}
    if args.arm_a in arms and args.arm_b in arms:
        for metric in ("catch", "catch_incl_partial", "bm_fp"):
            paired[metric] = _paired_delta(
                runs_map, roster, args.arm_a, args.arm_b, metric, args.seed, args.iters
            )

    summary = {
        "arms": arms,
        "totals": totals,
        "paired": {"arm_a": args.arm_a, "arm_b": args.arm_b, "metrics": paired} if paired else None,
    }

    output_text = json.dumps(summary, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
    if args.out_summary:
        Path(args.out_summary).write_text(output_text, encoding="utf-8")
    else:
        print(output_text)

    if args.out_adjudication:
        pattern = re.compile(args.redact_host_pattern) if args.redact_host_pattern else None
        rows = []
        for (arm, pr, rep), findings in runs_map.items():
            for f in findings:
                rows.append(
                    {
                        "pr": pr,
                        "arm": arm,
                        "run": rep,
                        "severity": f.get("severity"),
                        "file": f.get("file"),
                        "line": f.get("line"),
                        "message": _redact(f.get("message"), pattern),
                        "same_defect": f.get("same_defect"),
                        "fp_label": f.get("fp_label"),
                        "note": f.get("note", ""),
                    }
                )
        rows.sort(key=lambda r: (r["pr"], r["arm"], r["run"], r["file"] or "", r["line"] or 0))
        Path(args.out_adjudication).write_text(
            json.dumps(rows, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )

    return 0


# ---------------------------------------------------------------------------
# CLI


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="eval_adjudicate.py",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    pack_p = sub.add_parser("pack", help="Blind-pack real-PR harness reports into adjudication packets.")
    pack_p.add_argument(
        "--arm",
        action="append",
        required=True,
        metavar="LABEL=path1,path2",
        help="Tag one or more eval_harness.py report JSONs with an arm label. Repeatable.",
    )
    pack_p.add_argument("--packets", type=int, required=True, help="Number of packets to split findings into.")
    pack_p.add_argument("--out-dir", required=True, help="Directory to write packet{k}.json, unblind-key.json, roster.json.")
    pack_p.add_argument("--seed", type=int, default=DEFAULT_SEED, help=f"Shuffle seed (default {DEFAULT_SEED}).")
    pack_p.set_defaults(func=cmd_pack)

    score_p = sub.add_parser("score", help="Unblind adjudicated verdicts and compute recall/FP numbers.")
    score_p.add_argument("--packets", nargs="+", required=True, help="packet*.json files (any subset covering the labelled fids).")
    score_p.add_argument("--unblind-key", required=True, help="unblind-key.json from pack.")
    score_p.add_argument("--verdicts", nargs="+", required=True, help="verdicts*.json files from adjudicators.")
    score_p.add_argument("--runs", required=True, help="roster.json from pack (every run, including zero-finding runs).")
    score_p.add_argument("--arm-a", default="on", help="First arm for paired deltas (default 'on').")
    score_p.add_argument("--arm-b", default="off", help="Second arm for paired deltas (default 'off').")
    score_p.add_argument("--seed", type=int, default=DEFAULT_SEED, help=f"Bootstrap seed (default {DEFAULT_SEED}).")
    score_p.add_argument("--iters", type=int, default=DEFAULT_ITERS, help=f"Bootstrap resamples (default {DEFAULT_ITERS}).")
    score_p.add_argument(
        "--redact-host-pattern",
        default=None,
        help="Regex matched in exported adjudication.json messages and replaced with <host>.",
    )
    score_p.add_argument("--out-summary", default=None, help="Write the summary JSON here instead of stdout.")
    score_p.add_argument("--out-adjudication", default=None, help="Write the per-finding adjudication.json export here.")
    score_p.set_defaults(func=cmd_score)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
