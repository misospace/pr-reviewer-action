"""OpenAI-compatible chat call for the semantic-judge tooling.

The judge runners (``scripts/live_judge_score.py``,
``scripts/run_judge_calibration.py``) need one non-streaming chat completion.
The API key rides only the ``Authorization`` header, never the URL, the body,
or an error message. Redirects are refused: urllib's default handler copies
request headers (including ``Authorization``) onto the redirected request,
even across origins.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

from pr_reviewer.http_safe import OPENER_NO_REDIRECT


class JudgeHTTPError(RuntimeError):
    """The endpoint could not be reached or returned a non-2xx status."""


def chat_completion(base_url: str, payload: dict[str, Any], api_key: str, timeout_sec: int) -> Any:
    url = base_url.rstrip("/") + "/chat/completions"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    request = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
    try:
        with OPENER_NO_REDIRECT.open(request, timeout=timeout_sec) as response:  # noqa: S310 - operator-configured endpoint
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        if 300 <= error.code < 400:
            raise JudgeHTTPError(f"judge endpoint redirected (HTTP {error.code}); redirects are refused") from None
        raise JudgeHTTPError(f"judge endpoint returned HTTP {error.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise JudgeHTTPError(f"judge endpoint unreachable: {type(error).__name__}") from None
    except json.JSONDecodeError:
        raise JudgeHTTPError("judge endpoint returned invalid JSON") from None
