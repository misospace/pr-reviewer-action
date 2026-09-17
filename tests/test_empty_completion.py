"""An empty completion must be distinguishable from a malformed one.

A model that returns HTTP 200 with no content and zero completion tokens has
generated nothing -- retrying it with the same input produces the same nothing.
That is a different failure from a garbled or truncated answer, where a retry
is worth spending. The parser signals the difference with a dedicated exit
code so model_call.sh can escalate to the next tier immediately.

Regression for a dsv4f review that burned its whole parse-failure budget on
two identical empty responses.
"""
import json
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
EMPTY_COMPLETION_EXIT = 3

CASES = [
    (
        "empty content, zero completion tokens -> dedicated exit code",
        {"choices": [{"index": 0, "message": {"role": "assistant", "content": ""},
                      "finish_reason": "stop"}],
         "usage": {"prompt_tokens": 14903, "completion_tokens": 0, "total_tokens": 14903}},
        EMPTY_COMPLETION_EXIT,
    ),
    (
        "anthropic output_tokens spelling is recognised too",
        {"content": [], "stop_reason": "end_turn",
         "usage": {"input_tokens": 900, "output_tokens": 0}},
        EMPTY_COMPLETION_EXIT,
    ),
    (
        "non-JSON prose is still an ordinary parse failure, not empty",
        {"choices": [{"index": 0, "message": {"role": "assistant",
                      "content": "here is my review, not json"},
                      "finish_reason": "stop"}],
         "usage": {"prompt_tokens": 100, "completion_tokens": 8, "total_tokens": 108}},
        1,
    ),
    (
        "empty content but tokens were billed -> ordinary parse failure",
        {"choices": [{"index": 0, "message": {"role": "assistant", "content": ""},
                      "finish_reason": "stop"}],
         "usage": {"prompt_tokens": 100, "completion_tokens": 42, "total_tokens": 142}},
        1,
    ),
    (
        "a valid verdict still parses",
        {"choices": [{"index": 0, "message": {"role": "assistant", "content":
                      '{"verdict":"approve","review_markdown":"looks fine"}'},
                      "finish_reason": "stop"}],
         "usage": {"prompt_tokens": 100, "completion_tokens": 12, "total_tokens": 112}},
        0,
    ),
]

failures = 0
for label, payload, want in CASES:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(payload, fh)
        path = fh.name
    proc = subprocess.run(
        [sys.executable, "-c",
         "from pr_reviewer.response_parser import parse_response_file;"
         f"parse_response_file({path!r})"],
        cwd=ROOT, capture_output=True, text=True,
        env={"PYTHONPATH": str(ROOT), "PATH": "/usr/bin:/bin"},
    )
    got = proc.returncode
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}: exit={got} want={want}")
    if not ok:
        failures += 1
        print(f"     stderr: {proc.stderr.strip()[:200]}")

if failures:
    raise SystemExit(f"{failures} case(s) failed")
print("all empty-completion cases passed")
