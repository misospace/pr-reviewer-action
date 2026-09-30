"""Tests for scripts/eval_adjudicate.py (#841).

Covers: blinding (packets carry no arm/rep), exact-once verdict validation,
the pack->verdict->score round trip on small synthetic reports (both the
single-run-dict and #860 list-of-runs report shapes), and a regression that
feeding the committed harness-obligations adjudication back through the
scorer reproduces the committed summary.json adjudicated totals.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import eval_adjudicate as ea

REPORT_DIR = Path(__file__).resolve().parent.parent / "evals" / "reports" / "harness-obligations"


def _scenario(repo, number, head_sha, defect_desc, runs):
    return {
        "repo_full_name": repo,
        "number": number,
        "head_sha": head_sha,
        "id": f"{repo}#{number}",
        "defect": {"description": defect_desc, "file": "a.py", "line_range": [1, 5], "severity": "major"},
        "runs": runs,
    }


def _finding(severity, message, file="a.py", line=3, category="correctness"):
    return {"severity": severity, "category": category, "file": file, "line": line, "message": message}


def _write(path: Path, obj) -> None:
    path.write_text(json.dumps(obj), encoding="utf-8")


@pytest.fixture()
def synthetic_reports(tmp_path):
    """Two small synthetic eval_harness.py-shaped reports: one report where
    runs[mode] is a single dict per run (runs-per-mode == 1, "on" arm), one
    where runs[mode] is a list of run dicts (#860 shape, "off" arm)."""
    on_report = {
        "per_scenario_results": [
            _scenario(
                "acme/widgets", 1, "a" * 40, "off-by-one in the loop bound",
                runs={
                    "native_loop": {
                        "findings": [
                            _finding("blocker", "off by one in loop bound"),
                            _finding("minor", "unrelated formatting nit"),
                        ]
                    }
                },
            ),
            _scenario(
                "acme/widgets", 2, "b" * 40, "missing null check",
                runs={"native_loop": {"findings": []}},
            ),
        ]
    }
    off_report = {
        "per_scenario_results": [
            _scenario(
                "acme/widgets", 1, "a" * 40, "off-by-one in the loop bound",
                runs={
                    "native_loop": [
                        {"findings": [_finding("major", "loop runs one too many times")]},
                        {"findings": []},
                    ]
                },
            ),
            _scenario(
                "acme/widgets", 2, "b" * 40, "missing null check",
                runs={"native_loop": [{"findings": []}, {"findings": []}]},
            ),
        ]
    }
    on_path = tmp_path / "on.json"
    off_path = tmp_path / "off.json"
    _write(on_path, on_report)
    _write(off_path, off_report)
    return on_path, off_path


def test_pack_strips_arm_and_rep(tmp_path, synthetic_reports):
    on_path, off_path = synthetic_reports
    out_dir = tmp_path / "packets"
    ea.main(
        [
            "pack",
            "--arm", f"on={on_path}",
            "--arm", f"off={off_path}",
            "--packets", "2",
            "--out-dir", str(out_dir),
        ]
    )

    unblind_key = json.loads((out_dir / "unblind-key.json").read_text())
    roster = json.loads((out_dir / "roster.json").read_text())

    # Blinding: no packet mentions "arm" or "rep" anywhere in its JSON, and
    # every fid from a packet resolves through the (separate) unblind key.
    all_fids = set()
    for k in (1, 2):
        packet = json.loads((out_dir / f"packet{k}.json").read_text())
        blob = json.dumps(packet)
        assert '"arm"' not in blob
        assert '"rep"' not in blob
        for group in packet:
            assert set(group["meta"]) == {"id", "repo", "number", "head_sha", "defect"}
            for finding in group["findings"]:
                assert set(finding) == {"fid", "severity", "category", "file", "line", "message"}
                all_fids.add(finding["fid"])

    assert all_fids == set(unblind_key)
    # 2 findings (on, PR#1 run "r1") + 1 finding (off, PR#1 run "r1" of its
    # 2-run list) = 3 labelled findings; PR #2 contributes none.
    assert len(all_fids) == 3

    # Roster covers every run, including the zero-finding ones: on has 1 run
    # for PR#1 (single dict) + 1 run for PR#2 = 2 runs; off has 2+2 = 4 runs
    # (list-of-2 shape) for a total of 6.
    assert len(roster) == 6
    assert sum(1 for r in roster if r["arm"] == "on") == 2
    assert sum(1 for r in roster if r["arm"] == "off") == 4


def test_pack_is_seed_deterministic(tmp_path, synthetic_reports):
    on_path, off_path = synthetic_reports
    out_a = tmp_path / "a"
    out_b = tmp_path / "b"
    for out_dir in (out_a, out_b):
        ea.main(
            [
                "pack",
                "--arm", f"on={on_path}",
                "--arm", f"off={off_path}",
                "--packets", "1",
                "--seed", "7",
                "--out-dir", str(out_dir),
            ]
        )
    assert (out_a / "packet1.json").read_text() == (out_b / "packet1.json").read_text()


def _fake_verdict(fid, same_defect, fp_label=None, note=""):
    return {"fid": fid, "same_defect": same_defect, "fp_label": fp_label, "note": note}


def test_score_round_trip(tmp_path, synthetic_reports):
    on_path, off_path = synthetic_reports
    out_dir = tmp_path / "packets"
    ea.main(
        [
            "pack",
            "--arm", f"on={on_path}",
            "--arm", f"off={off_path}",
            "--packets", "2",
            "--out-dir", str(out_dir),
        ]
    )

    unblind_key = json.loads((out_dir / "unblind-key.json").read_text())
    packets = [str(out_dir / "packet1.json"), str(out_dir / "packet2.json")]

    # Build verdicts by unblinding ourselves (in a real run, adjudicators
    # never see arm/rep -- we do here only to script deterministic labels).
    findings_by_fid = {}
    for p in packets:
        for group in json.loads(Path(p).read_text()):
            for f in group["findings"]:
                findings_by_fid[f["fid"]] = f

    verdicts = []
    for fid, key in unblind_key.items():
        f = findings_by_fid[fid]
        if "off by one" in f["message"] or "one too many" in f["message"]:
            verdicts.append(_fake_verdict(fid, "yes"))
        else:
            verdicts.append(_fake_verdict(fid, "no"))

    verdicts_path = tmp_path / "verdicts1.json"
    _write(verdicts_path, verdicts)

    summary_path = tmp_path / "summary.json"
    adjudication_path = tmp_path / "adjudication.json"
    ea.main(
        [
            "score",
            "--packets", *packets,
            "--unblind-key", str(out_dir / "unblind-key.json"),
            "--verdicts", str(verdicts_path),
            "--runs", str(out_dir / "roster.json"),
            "--out-summary", str(summary_path),
            "--out-adjudication", str(adjudication_path),
        ]
    )

    summary = json.loads(summary_path.read_text())
    assert summary["totals"]["on"]["runs"] == 2
    assert summary["totals"]["on"]["semantic_catch"] == 1
    assert summary["totals"]["off"]["runs"] == 4
    assert summary["totals"]["off"]["semantic_catch"] == 1

    adjudication = json.loads(adjudication_path.read_text())
    assert len(adjudication) == 3
    assert all(set(row) >= {"pr", "arm", "run", "severity", "file", "line", "message", "same_defect", "fp_label", "note"} for row in adjudication)


def test_score_rejects_missing_verdict(tmp_path, synthetic_reports):
    on_path, off_path = synthetic_reports
    out_dir = tmp_path / "packets"
    ea.main(
        [
            "pack",
            "--arm", f"on={on_path}",
            "--arm", f"off={off_path}",
            "--packets", "1",
            "--out-dir", str(out_dir),
        ]
    )
    unblind_key = json.loads((out_dir / "unblind-key.json").read_text())
    fids = list(unblind_key)
    # Label only the first fid: the rest are missing.
    verdicts_path = tmp_path / "verdicts.json"
    _write(verdicts_path, [_fake_verdict(fids[0], "no")])

    with pytest.raises(SystemExit, match="no verdict"):
        ea.main(
            [
                "score",
                "--packets", str(out_dir / "packet1.json"),
                "--unblind-key", str(out_dir / "unblind-key.json"),
                "--verdicts", str(verdicts_path),
                "--runs", str(out_dir / "roster.json"),
            ]
        )


def test_score_rejects_duplicate_verdict(tmp_path, synthetic_reports):
    on_path, off_path = synthetic_reports
    out_dir = tmp_path / "packets"
    ea.main(
        [
            "pack",
            "--arm", f"on={on_path}",
            "--arm", f"off={off_path}",
            "--packets", "1",
            "--out-dir", str(out_dir),
        ]
    )
    unblind_key = json.loads((out_dir / "unblind-key.json").read_text())
    fids = list(unblind_key)

    verdicts = [_fake_verdict(fid, "no") for fid in fids]
    # Duplicate the first fid across two files.
    verdicts_path_a = tmp_path / "verdicts_a.json"
    verdicts_path_b = tmp_path / "verdicts_b.json"
    _write(verdicts_path_a, verdicts)
    _write(verdicts_path_b, [_fake_verdict(fids[0], "yes")])

    with pytest.raises(SystemExit, match="labelled more than once"):
        ea.main(
            [
                "score",
                "--packets", str(out_dir / "packet1.json"),
                "--unblind-key", str(out_dir / "unblind-key.json"),
                "--verdicts", str(verdicts_path_a), str(verdicts_path_b),
                "--runs", str(out_dir / "roster.json"),
            ]
        )


def test_score_rejects_fp_label_on_non_blocker_major(tmp_path, synthetic_reports):
    on_path, off_path = synthetic_reports
    out_dir = tmp_path / "packets"
    ea.main(
        [
            "pack",
            "--arm", f"on={on_path}",
            "--arm", f"off={off_path}",
            "--packets", "1",
            "--out-dir", str(out_dir),
        ]
    )
    unblind_key = json.loads((out_dir / "unblind-key.json").read_text())
    packets = json.loads((out_dir / "packet1.json").read_text())
    findings_by_fid = {f["fid"]: f for group in packets for f in group["findings"]}
    minor_fid = next(fid for fid, f in findings_by_fid.items() if f["severity"] == "minor")

    verdicts = [_fake_verdict(fid, "no") for fid in unblind_key]
    for v in verdicts:
        if v["fid"] == minor_fid:
            v["fp_label"] = "real"
    verdicts_path = tmp_path / "verdicts.json"
    _write(verdicts_path, verdicts)

    with pytest.raises(SystemExit, match="not blocker/major"):
        ea.main(
            [
                "score",
                "--packets", str(out_dir / "packet1.json"),
                "--unblind-key", str(out_dir / "unblind-key.json"),
                "--verdicts", str(verdicts_path),
                "--runs", str(out_dir / "roster.json"),
            ]
        )


# ---------------------------------------------------------------------------
# Regression: reproduce the #796 committed adjudication totals


@pytest.mark.skipif(not REPORT_DIR.exists(), reason="harness-obligations report not present")
def test_reproduces_796_adjudicated_totals(tmp_path):
    adjudication = json.loads((REPORT_DIR / "adjudication.json").read_text())
    summary = json.loads((REPORT_DIR / "summary.json").read_text())
    expected = summary["adjudicated"]

    # Build packets/unblind-key/verdicts/roster straight from adjudication.json
    # (it already carries pr/arm/run plus the finding content and labels).
    prs = sorted({row["pr"] for row in adjudication})
    reps = ("r1", "r2", "r3")
    arms = ("on", "off")

    unblind_key = {}
    packets_content = []
    verdicts = []
    roster = [{"arm": arm, "pr": pr, "rep": rep} for arm in arms for pr in prs for rep in reps]

    for i, row in enumerate(adjudication):
        fid = f"fid{i}"
        unblind_key[fid] = {"arm": row["arm"], "rep": row["run"], "pr": row["pr"]}
        packets_content.append(
            {
                "meta": {"id": row["pr"], "repo": None, "number": None, "head_sha": None, "defect": None},
                "findings": [
                    {
                        "fid": fid,
                        "severity": row["severity"],
                        "category": None,
                        "file": row["file"],
                        "line": row["line"],
                        "message": row["message"],
                    }
                ],
            }
        )
        verdicts.append(_fake_verdict(fid, row["same_defect"], row["fp_label"], row.get("note", "")))

    unblind_key_path = tmp_path / "unblind-key.json"
    packets_path = tmp_path / "packet1.json"
    verdicts_path = tmp_path / "verdicts1.json"
    roster_path = tmp_path / "roster.json"
    _write(unblind_key_path, unblind_key)
    _write(packets_path, packets_content)
    _write(verdicts_path, verdicts)
    _write(roster_path, roster)

    summary_out_path = tmp_path / "out-summary.json"
    ea.main(
        [
            "score",
            "--packets", str(packets_path),
            "--unblind-key", str(unblind_key_path),
            "--verdicts", str(verdicts_path),
            "--runs", str(roster_path),
            "--out-summary", str(summary_out_path),
        ]
    )
    out = json.loads(summary_out_path.read_text())

    for arm in ("on", "off"):
        got = out["totals"][arm]
        want = expected["totals"][arm]
        assert got["runs"] == want["runs"] == 111
        assert got["semantic_catch"] == want["semantic_catch"]
        assert got["catch_incl_partial"] == want["catch_incl_partial"]
        assert got["blocker_major"] == want["blocker_major"]
        assert got["bm_false_positive"] == want["bm_false_positive"]
        assert got["bm_real_other"] == want["bm_real_other"]
        assert got["runs_with_bm_fp"] == want["runs_with_bm_fp"]

    assert out["totals"]["on"]["semantic_catch"] == 24
    assert out["totals"]["on"]["catch_incl_partial"] == 38
    assert out["totals"]["on"]["bm_false_positive"] == 47
    assert out["totals"]["off"]["semantic_catch"] == 27
    assert out["totals"]["off"]["catch_incl_partial"] == 33
    assert out["totals"]["off"]["bm_false_positive"] == 43

    paired = out["paired"]["metrics"]
    assert paired["catch"]["prs_on_better"] == expected["prs_on_better"] == 8
    assert paired["catch"]["prs_on_worse"] == expected["prs_on_worse"] == 9
