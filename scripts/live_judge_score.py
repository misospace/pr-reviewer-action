#!/usr/bin/env python3
"""#661 live A/B scorer: grade blinded reviewer outputs with the frozen judge.

MANUALLY-INVOKED measurement instrument (never wired into normal CI — normal CI
keeps the deterministic phrase scorer in ``pr_reviewer.semantic_eval``).

It consumes the blinded live responses emitted by the A/B driver
(``liveblinded-<arm>.json``: per scenario, per rep, ``findings`` +
``review_markdown`` only) and the answer-key rubrics frozen in
``evals/judge-calibration-corpus.json`` (which were authored solely from fixture
answer keys and adversarial paraphrases, never from live outputs). Every run —
baseline and treatment alike — is scored through the identical frozen judge
(``pr_reviewer.semantic_judge`` + the injected ``judge_call``) with the same
blinding, so the instrument contributes no arm-dependent signal.

Outputs, per arm:
  * vulnerable detection rate — share of vulnerable-fixture runs whose
    disposition is ``correct`` (found the key chain with a sound remediation);
  * the full disposition breakdown, including the #661 miss sub-modes
    ``suppressed_pre_existing`` and ``invalid_remediation`` and the
    ``speculative_false_positive`` hallucination rate;
  * negative-control false-positive rate — share of control runs asserting any
    defect (any disposition other than ``not_found``).

Fail-closed: an unparseable judge verdict (after the bounded reformat retry) or a
classification whose verbatim citations do not appear in the reviewer text is
recorded as ``judge_unavailable`` and counted as a miss, never as a pass.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Callable, Optional

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from pr_reviewer import semantic_judge  # noqa: E402

DEFAULT_CORPUS = _REPO_ROOT / "evals" / "judge-calibration-corpus.json"
_MAX_ATTEMPTS = 3
# Transport retries back off on transient cluster-DNS/gateway blips.
_ATTEMPT_BACKOFF_SEC = (2.0, 5.0)
JudgeCall = Callable[[list[dict], int], str]

_VULNERABLE = "vulnerable"
_CONTROL = "negative_control"


def _answer_key_index(corpus: dict) -> dict[int, dict]:
    return {s["number"]: s["answer_key"] for s in corpus["scenarios"]}


def _response_text(response: dict) -> str:
    """The reviewer text a citation may quote — the shared haystack from
    ``semantic_judge.response_text_for_citation`` (never a narrower local copy,
    which would wrongly fail a citation of a judge-visible field)."""
    return semantic_judge.response_text_for_citation(response)


def judge_disposition(
    answer_key: dict,
    response: dict,
    judge_call: JudgeCall,
    sleep: Callable[[float], None] = time.sleep,
) -> dict:
    """One blinded run -> {"disposition", "citations_valid", "transport_error",
    "parse_errors", "excerpt"}. Fail-closed; never raises for a judge fault."""
    messages = semantic_judge.build_judge_messages(answer_key, response)
    raw = ""
    parsed: Optional[dict] = None
    parse_errors: list[str] = []
    citation_errors: list[str] = []
    transport_error = True
    for attempt in range(_MAX_ATTEMPTS):
        if attempt:
            sleep(_ATTEMPT_BACKOFF_SEC[min(attempt - 1, len(_ATTEMPT_BACKOFF_SEC) - 1)])
        try:
            raw = judge_call(messages, attempt)
        except Exception:  # noqa: BLE001 - transport fault: re-attempt
            continue
        transport_error = False
        parsed, parse_errors = semantic_judge.parse_judge_output(raw)
        if parsed is None:
            continue  # unparseable output: re-attempt
        citation_errors = semantic_judge.validate_citations(
            parsed["citations"], _response_text(response)
        )
        if citation_errors or (
            parsed["disposition"] != "not_found" and not parsed["citations"]
        ):
            continue  # citation-adherence fault: re-attempt
        break  # well-formed verdict with valid citations
    if parsed is None:
        return {
            "disposition": None, "citations_valid": False,
            "transport_error": transport_error, "parse_errors": parse_errors,
            "excerpt": raw[:_MAX_EXCERPT],
        }
    citations_valid = (
        not citation_errors
        and (parsed["disposition"] == "not_found" or len(parsed["citations"]) >= 1)
    )
    return {
        "disposition": parsed["disposition"] if citations_valid else None,
        "citations_valid": citations_valid,
        "transport_error": False, "parse_errors": parse_errors,
        "citation_errors": citation_errors,
        "excerpt": raw[:_MAX_EXCERPT],
    }


_MAX_EXCERPT = 240


def score_arm(
    arm_payload: dict,
    answer_keys: dict[int, dict],
    judge_call: JudgeCall,
    sleep: Callable[[float], None] = time.sleep,
) -> dict:
    dispositions = {d: 0 for d in semantic_judge.MERGE_SAFETY_DISPOSITIONS_ORDER}
    dispositions["judge_unavailable"] = 0
    per_scenario: dict[int, dict[str, int]] = {}
    vulnerable_runs = vulnerable_correct = 0
    control_runs = control_fp = 0
    failures: list[dict] = []
    for scenario_entry in arm_payload["scenarios"]:
        number = scenario_entry["scenario"]
        answer_key = answer_keys[number]
        kind = answer_key["kind"]
        bucket = per_scenario.setdefault(number, {})
        for run in scenario_entry["runs"]:
            result = judge_disposition(answer_key, run["response"], judge_call, sleep)
            disposition = result["disposition"] or "judge_unavailable"
            dispositions[disposition] += 1
            bucket[disposition] = bucket.get(disposition, 0) + 1
            if kind == _VULNERABLE:
                vulnerable_runs += 1
                if disposition == "correct":
                    vulnerable_correct += 1
            elif disposition != "judge_unavailable":
                # An unjudged control run is not a hallucination: exclude it from
                # the false-positive rate (it is already reported separately and
                # makes main() exit nonzero) so the rate is not inflated.
                control_runs += 1
                if disposition != "not_found":
                    control_fp += 1
            if disposition in {"judge_unavailable"}:
                failures.append({
                    "scenario": number, "rep": run.get("rep"),
                    "reason": "judge_unavailable" if result["transport_error"]
                              else "judge_invalid",
                    "parse_errors": result.get("parse_errors", []),
                    "citation_errors": result.get("citation_errors", []),
                    "excerpt": result.get("excerpt", ""),
                })
    return {
        "arm": arm_payload.get("arm"),
        "reps": arm_payload.get("reps"),
        "vulnerable_runs": vulnerable_runs,
        "vulnerable_correct": vulnerable_correct,
        "vulnerable_detection_rate": round(
            vulnerable_correct / vulnerable_runs, 4
        ) if vulnerable_runs else 0.0,
        "control_runs": control_runs,
        "control_false_positives": control_fp,
        "control_false_positive_rate": round(
            control_fp / control_runs, 4
        ) if control_runs else 0.0,
        "dispositions": dispositions,
        "per_scenario": {str(k): dict(v) for k, v in sorted(per_scenario.items())},
        "judge_unavailable": dispositions["judge_unavailable"],
        "failures": failures,
    }


def _openai_judge_call(
    judge_model: str, base_url: str, api_key: str, timeout_sec: int
) -> JudgeCall:
    from pr_reviewer.transport import run_chat_request

    def _call(messages: list[dict], attempt: int) -> str:
        system = next((m["content"] for m in messages if m["role"] == "system"), "")
        user = next((m["content"] for m in messages if m["role"] == "user"), "")
        payload = {
            "model": judge_model, "stream": False,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "max_tokens": semantic_judge.JUDGE_MAX_TOKENS,
            "temperature": (
                semantic_judge.JUDGE_FIRST_TEMPERATURE
                if attempt == 0
                else semantic_judge.JUDGE_RETRY_TEMPERATURE
            ),
            "response_format": {"type": "json_object"},
        }
        return _extract_text(run_chat_request(base_url, "openai", payload, api_key, timeout_sec))

    return _call


def _extract_text(response: Any) -> str:
    if not isinstance(response, dict):
        return ""
    choices = response.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        message = choices[0].get("message")
        if isinstance(message, dict):
            content = message.get("content")
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                return "".join(
                    block.get("text", "") for block in content
                    if isinstance(block, dict) and isinstance(block.get("text"), str)
                )
    content = response.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            block.get("text", "") for block in content
            if isinstance(block, dict) and isinstance(block.get("text"), str)
        )
    return ""


def compare(arms: list[dict]) -> dict:
    by_arm = {a["arm"]: a for a in arms}
    baseline = by_arm.get("baseline")
    treatment = by_arm.get("treatment")
    delta = {}
    if baseline and treatment:
        delta = {
            "vulnerable_detection_rate": round(
                treatment["vulnerable_detection_rate"]
                - baseline["vulnerable_detection_rate"], 4
            ),
            "control_false_positive_rate": round(
                treatment["control_false_positive_rate"]
                - baseline["control_false_positive_rate"], 4
            ),
        }
    return {"arms": by_arm, "delta_treatment_minus_baseline": delta}


def validate_arms(baseline: dict, treatment: dict) -> list[str]:
    """Fail-closed structural comparability check for a live A/B.

    An incomplete or asymmetric arm must be REJECTED, never scored: the two arms
    have to describe the same experiment (identical scenario set, identical
    rep ids/counts per scenario) or the delta is meaningless. Also rejects
    duplicate scenario ids and duplicate rep ids within a scenario, and requires
    each payload to declare its arm role.
    """
    errors: list[str] = []
    if not isinstance(baseline, dict) or baseline.get("arm") != "baseline":
        errors.append("--baseline payload must declare arm: baseline")
    if not isinstance(treatment, dict) or treatment.get("arm") != "treatment":
        errors.append("--treatment payload must declare arm: treatment")
    if not isinstance(baseline, dict) or not isinstance(treatment, dict):
        return errors

    def scenario_map(payload: dict, label: str) -> dict[int, dict]:
        scenarios = payload.get("scenarios")
        if not isinstance(scenarios, list) or not scenarios:
            errors.append(f"{label} has no scenarios")
            return {}
        index: dict[int, dict] = {}
        for position, entry in enumerate(scenarios):
            if not isinstance(entry, dict) or not isinstance(entry.get("scenario"), int):
                errors.append(f"{label} scenario {position} has no integer scenario id")
                continue
            number = entry["scenario"]
            if number in index:
                errors.append(f"{label} has duplicate scenario {number}")
            index[number] = entry
        return index

    base_map = scenario_map(baseline, "baseline")
    treat_map = scenario_map(treatment, "treatment")
    if not base_map or not treat_map:
        return errors
    if set(base_map) != set(treat_map):
        errors.append(
            "arms cover different scenario sets: "
            f"baseline-only={sorted(set(base_map) - set(treat_map))}, "
            f"treatment-only={sorted(set(treat_map) - set(base_map))}"
        )

    def rep_ids(entry: dict, label: str, number: int) -> list[int]:
        runs = entry.get("runs")
        if not isinstance(runs, list) or not runs:
            errors.append(f"{label} scenario {number} has no runs")
            return []
        ids: list[int] = []
        for position, run in enumerate(runs):
            if not isinstance(run, dict) or not isinstance(run.get("rep"), int):
                errors.append(
                    f"{label} scenario {number} run {position} has no integer rep"
                )
                continue
            if not isinstance(run.get("response"), dict):
                errors.append(
                    f"{label} scenario {number} run rep {run['rep']} has no response object"
                )
            ids.append(run["rep"])
        if len(set(ids)) != len(ids):
            errors.append(f"{label} scenario {number} has duplicate rep ids")
        return ids

    for number in sorted(set(base_map) & set(treat_map)):
        base_reps = rep_ids(base_map[number], "baseline", number)
        treat_reps = rep_ids(treat_map[number], "treatment", number)
        if set(base_reps) != set(treat_reps) or len(base_reps) != len(treat_reps):
            errors.append(
                f"scenario {number}: arms have different rep ids/counts "
                f"(baseline={sorted(base_reps)}, treatment={sorted(treat_reps)})"
            )
    return errors


def _load_verified_calibration(
    artifact_path: Path, judge_model: str, corpus_path: Path
) -> tuple[Optional[dict], list[str]]:
    """Load the calibration artifact and prove it is the SAME frozen instrument
    this live run is about to use. A different prompt version, judge model,
    judge setting, or calibration corpus fails closed."""
    try:
        artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return None, [f"cannot read calibration artifact {artifact_path}: {exc}"]
    errors: list[str] = []
    if not isinstance(artifact, dict):
        return None, [f"calibration artifact {artifact_path} is not a JSON object"]
    total = artifact.get("total")
    if not isinstance(total, int) or total <= 0:
        errors.append("calibration artifact records no scored references")
    if artifact.get("agreement_rate") != 1.0 or artifact.get("passed") != total:
        errors.append(
            "calibration artifact did not record 100% agreement "
            f"(passed={artifact.get('passed')!r}, total={total!r}, "
            f"agreement_rate={artifact.get('agreement_rate')!r})"
        )
    expected = semantic_judge.judge_config_identity(judge_model, corpus_path)
    errors.extend(semantic_judge.verify_judge_config(artifact.get("judge_config"), expected))
    return artifact, errors


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Score blinded #661 live A/B outputs with the frozen semantic judge.",
    )
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--treatment", type=Path, required=True)
    parser.add_argument(
        "--calibration-artifact", type=Path, required=True,
        help="judge calibration report (from scripts/run_judge_calibration.py) "
             "that must match this run's frozen judge identity, or scoring is refused",
    )
    parser.add_argument("--judge-model", default=os.environ.get("JUDGE_MODEL"))
    parser.add_argument("--base-url", default=os.environ.get("JUDGE_BASE_URL"))
    parser.add_argument("--api-key", default=os.environ.get("JUDGE_API_KEY", ""))
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--output", type=Path, default=None)
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    for path in (args.corpus, args.baseline, args.treatment, args.calibration_artifact):
        if not path.exists():
            print(f"Error: file not found: {path}", file=sys.stderr)
            return 2
    if not args.judge_model or not args.base_url:
        print("Error: --judge-model and --base-url are required", file=sys.stderr)
        return 2
    corpus = semantic_judge.load_calibration_corpus(args.corpus)
    errors = semantic_judge.validate_calibration_corpus(corpus)
    if errors:
        print("Corpus invalid:", *errors, sep="\n  ", file=sys.stderr)
        return 2
    baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
    treatment = json.loads(args.treatment.read_text(encoding="utf-8"))
    arm_errors = validate_arms(baseline, treatment)
    if arm_errors:
        print("Arms are not comparable — refusing to score:",
              *arm_errors, sep="\n  ", file=sys.stderr)
        return 2
    answer_keys = _answer_key_index(corpus)
    arm_numbers = {
        entry["scenario"]
        for payload in (baseline, treatment)
        for entry in payload.get("scenarios", [])
        if isinstance(entry, dict) and isinstance(entry.get("scenario"), int)
    }
    unknown = sorted(arm_numbers - set(answer_keys))
    if unknown:
        print(
            f"Arms reference scenarios absent from the frozen corpus: {unknown} — "
            "refusing to score", file=sys.stderr,
        )
        return 2
    artifact, calibration_errors = _load_verified_calibration(
        args.calibration_artifact, args.judge_model, args.corpus
    )
    if calibration_errors:
        print("Calibration artifact does not match this frozen judge — "
              "refusing to score:", *calibration_errors, sep="\n  ", file=sys.stderr)
        return 2
    judge_call = _openai_judge_call(
        args.judge_model, args.base_url, args.api_key, args.timeout
    )
    report = compare([
        score_arm(baseline, answer_keys, judge_call),
        score_arm(treatment, answer_keys, judge_call),
    ])
    if artifact is not None:
        report["calibration_artifact"] = {
            "judge_config": artifact.get("judge_config"),
            "agreement_rate": artifact.get("agreement_rate"),
            "total": artifact.get("total"),
        }
    print(json.dumps(report, indent=2, ensure_ascii=False))
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
    # Fail the run if any judge verdict was unusable — the measurement must not
    # silently proceed on unjudged runs.
    unavailable = sum(a["judge_unavailable"] for a in report["arms"].values())
    return 0 if unavailable == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
