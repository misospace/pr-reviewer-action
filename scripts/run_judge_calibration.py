#!/usr/bin/env python3
"""#661 semantic-judge offline calibration / adversarial runner.

This is a MANUALLY-INVOKED measurement instrument (never wired into normal CI):
it drives an OpenAI-compatible judge model over
``evals/judge-calibration-corpus.json`` and gates on 100% disposition
agreement, the precondition for freezing the judge for live A/B use.

Design:
  * The classification primitives (message building, tolerant parse, verbatim
    citation validation, corpus validation) live in the pure module
    ``pr_reviewer.semantic_judge``. This runner owns only orchestration and the
    HTTP glue.
  * ``run_calibration`` takes an injected ``judge_call(messages) -> str`` so it
    is unit-testable with fakes and never contacts the network in tests. The
    production transport (``pr_reviewer.transport.run_chat_request``) is built
    only in ``main`` behind ``_openai_judge_call``.
  * Fail-closed: a reference passes ONLY when the judge output parses to exactly
    one of the five dispositions, matches the declared ``expected_disposition``,
    carries a verbatim citation span for every non-``not_found`` disposition, and
    every citation appears in the reviewer text. Any parse error, citation miss,
    or transport failure is a miss — never a silent pass.
"""
from __future__ import annotations

import argparse
import json
import os
import time
import sys
from pathlib import Path
from typing import Any, Callable, Optional

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from pr_reviewer import semantic_judge  # noqa: E402

DEFAULT_CORPUS = _REPO_ROOT / "evals" / "judge-calibration-corpus.json"
DEFAULT_MAX_TOKENS = 4096
_EXCERPT_LIMIT = 300

JudgeCall = Callable[[list[dict], int], str]
# A judge turn is re-attempted only on a transport fault or unparseable/empty
# output — never because the (parseable) disposition was wrong. This hardens the
# instrument against transient model output glitches (a dropped JSON head)
# without letting it fish for a favourable answer.
_MAX_ATTEMPTS = 3
# glm-5.3-flash is a reasoning model: reasoning tokens count against the
# completion budget, and long live inputs previously exhausted a 1024-token
# budget with finish_reason=length before any verdict text was emitted.
_MAX_JUDGE_TOKENS = 16384
# The first judge attempt runs at temperature 0.0; a reformat re-attempt (only
# ever on an unusable output: transport fault, unparseable JSON, or citations
# that do not appear verbatim — never on a well-formed verdict that simply
# disagrees) re-rolls the sample, because at temperature 0 an output-adherence
# glitch (e.g. a dropped string quote) reproduces identically forever.
_RETRY_TEMPERATURE = 0.7


def _attempt_temperature(attempt: int) -> float:
    return 0.0 if attempt == 0 else _RETRY_TEMPERATURE

# Transport retries back off: transient cluster-DNS/gateway blips under load
# resolve within seconds, and immediate re-hits reproduce the failure window.
_ATTEMPT_BACKOFF_SEC = (2.0, 5.0)


def _response_text(reference: dict) -> str:
    """The reviewer text a citation must be drawn from.

    Delegates to the shared ``semantic_judge.response_text_for_citation`` so the
    haystack can never drift from what ``build_judge_messages`` actually shows
    the judge (a narrower haystack would wrongly fail a legitimate citation)."""
    return semantic_judge.response_text_for_citation(reference.get("response") or {})


def _excerpt(text: str) -> str:
    if not isinstance(text, str):
        text = str(text)
    return text[:_EXCERPT_LIMIT]


def grade_reference(
    answer_key: dict,
    reference: dict,
    judge_call: JudgeCall,
    sleep: Callable[[float], None] = time.sleep,
) -> dict:
    """Attempt one reference (transport-adherence retries only) and grade it
    fail-closed.

    Returns a report row: PASS rows carry only ``passed``; miss rows carry the
    expected/got dispositions, any parse/citation errors, the transport flag, and
    a bounded raw excerpt.
    """
    messages = semantic_judge.build_judge_messages(
        answer_key, reference.get("response") or {}
    )
    transport_error = True  # fail closed until any attempt yields content
    raw = ""
    parsed: Optional[dict] = None
    parse_errors: list[str] = []
    citation_errors: list[str] = []
    for attempt in range(_MAX_ATTEMPTS):
        if attempt:
            sleep(_ATTEMPT_BACKOFF_SEC[min(attempt - 1, len(_ATTEMPT_BACKOFF_SEC) - 1)])
        try:
            raw = judge_call(messages, attempt)
        except Exception:  # noqa: BLE001 - transport/HTTP/JSON fault: re-attempt
            continue
        transport_error = False
        parsed, parse_errors = semantic_judge.parse_judge_output(raw)
        if parsed is None:
            continue  # unparseable output: re-attempt
        citation_errors = semantic_judge.validate_citations(
            parsed["citations"], _response_text(reference)
        )
        if citation_errors or (
            parsed["disposition"] != "not_found" and not parsed["citations"]
        ):
            continue  # citation-adherence fault: re-attempt
        break  # well-formed verdict with valid citations; a wrong disposition
        # is a genuine judgment and is NEVER retried.
    got: Optional[str] = parsed["disposition"] if parsed is not None else None
    disposition_ok = parsed is not None and got == reference["expected_disposition"]
    citation_rule_ok = parsed is not None and (
        got == "not_found" or len(parsed["citations"]) >= 1
    )
    passed = bool(disposition_ok and not parse_errors and not citation_errors
                 and citation_rule_ok and not transport_error)

    if passed:
        return {"ref_id": reference["ref_id"], "passed": True}
    return {
        "ref_id": reference["ref_id"],
        "passed": False,
        "scenario_number": answer_key.get("_scenario_number"),
        "origin": reference.get("origin"),
        "expected": reference["expected_disposition"],
        "got": got,
        "parse_errors": parse_errors,
        "citation_errors": citation_errors,
        "transport_error": transport_error,
        "judge_raw_excerpt": _excerpt(raw),
    }


def run_calibration(
    corpus: dict,
    judge_call: JudgeCall,
    judge_model: str,
    base_url: str,
    sleep: Callable[[float], None] = time.sleep,
) -> dict:
    """Grade every reference across every scenario. Fail-closed; never raises for
    a judge/transport fault (only for malformed corpus, which callers gate
    first)."""
    rows: list[dict] = []
    for scenario in corpus["scenarios"]:
        answer_key = dict(scenario["answer_key"])
        answer_key["_scenario_number"] = scenario["number"]
        for reference in scenario["references"]:
            rows.append(grade_reference(answer_key, reference, judge_call, sleep))

    total = len(rows)
    passed_rows = [row for row in rows if row["passed"]]
    by_origin: dict[str, dict[str, int]] = {}
    by_disposition: dict[str, dict[str, int]] = {}
    failures: list[dict] = []
    # Recompute the origin/disposition tallies from the corpus expectations so a
    # miss still lands in the right bucket with its expected disposition.
    index = {
        reference["ref_id"]: (scenario["number"], reference)
        for scenario in corpus["scenarios"]
        for reference in scenario["references"]
    }
    for row in rows:
        _number, reference = index[row["ref_id"]]
        origin = reference.get("origin", "unknown")
        expected = reference["expected_disposition"]
        origin_bucket = by_origin.setdefault(origin, {"total": 0, "passed": 0})
        disp_bucket = by_disposition.setdefault(expected, {"total": 0, "passed": 0})
        origin_bucket["total"] += 1
        disp_bucket["total"] += 1
        if row["passed"]:
            origin_bucket["passed"] += 1
            disp_bucket["passed"] += 1
        else:
            failures.append(row)

    return {
        "judge_prompt_version": semantic_judge.JUDGE_PROMPT_VERSION,
        "judge_model": judge_model,
        "base_url": base_url,
        "total": total,
        "passed": len(passed_rows),
        "agreement_rate": round(len(passed_rows) / total, 4) if total else 0.0,
        "transport_errors": sum(1 for row in rows if not row["passed"]
                                and _row_is_transport(corpus, row)),
        "by_origin": {k: dict(v) for k, v in sorted(by_origin.items())},
        "by_disposition": {k: dict(v) for k, v in sorted(by_disposition.items())},
        "failures": failures,
    }


def _row_is_transport(corpus: dict, row: dict) -> bool:
    return bool(row.get("transport_error"))


def _openai_judge_call(
    judge_model: str, base_url: str, api_key: str, timeout_sec: int
) -> JudgeCall:
    """Production transport: build a single-turn OpenAI chat payload for the
    judge messages and return the assistant text. Mirrors how
    scripts/run_specialists.py drives pr_reviewer.transport.run_chat_request."""
    from pr_reviewer.transport import run_chat_request

    def _call(messages: list[dict], attempt: int) -> str:
        system = ""
        user = ""
        for message in messages:
            if message.get("role") == "system":
                system = message.get("content", "")
            elif message.get("role") == "user":
                user = message.get("content", "")
        payload = {
            "model": judge_model,
            "stream": False,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "max_tokens": _MAX_JUDGE_TOKENS,
            "temperature": _attempt_temperature(attempt),
            "response_format": {"type": "json_object"},
        }
        response = run_chat_request(base_url, "openai", payload, api_key, timeout_sec)
        return _extract_text(response)

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
                    block.get("text", "")
                    for block in content
                    if isinstance(block, dict) and isinstance(block.get("text"), str)
                )
    content = response.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and isinstance(block.get("text"), str)
        )
    return ""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run the #661 semantic judge offline calibration/adversarial suite.",
    )
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    parser.add_argument("--judge-model", default=os.environ.get("JUDGE_MODEL"))
    parser.add_argument("--base-url", default=os.environ.get("JUDGE_BASE_URL"))
    parser.add_argument("--api-key", default=os.environ.get("JUDGE_API_KEY", ""))
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--timeout", type=int, default=120)
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    if not args.corpus.exists():
        print(f"Error: corpus file not found: {args.corpus}", file=sys.stderr)
        return 2
    if not args.judge_model or not args.base_url:
        print("Error: --judge-model and --base-url (or JUDGE_MODEL/JUDGE_BASE_URL) "
              "are required", file=sys.stderr)
        return 2

    try:
        corpus = semantic_judge.load_calibration_corpus(args.corpus)
    except semantic_judge.SemanticJudgeError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    errors = semantic_judge.validate_calibration_corpus(corpus)
    if errors:
        print("Calibration corpus is invalid:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 2

    judge_call = _openai_judge_call(
        args.judge_model, args.base_url, args.api_key, args.timeout
    )
    report = run_calibration(corpus, judge_call, args.judge_model, args.base_url)

    for row in report["failures"]:
        print(
            f"FAIL {row['ref_id']} expected={row['expected']} got={row['got']} "
            f"transport={row['transport_error']} "
            f"parse={row['parse_errors']} citations={row['citation_errors']}",
            file=sys.stderr,
        )
    passed_total = report["passed"]
    print(
        f"judge calibration: {passed_total}/{report['total']} "
        f"({report['agreement_rate']:.1%}) agreement; "
        f"{report['transport_errors']} transport errors",
        file=sys.stderr,
    )

    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        print(f"report written to {args.output}", file=sys.stderr)

    if report["total"] > 0 and report["agreement_rate"] == 1.0:
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
