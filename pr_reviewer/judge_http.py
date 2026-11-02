"""OpenAI-compatible chat call for the semantic-judge tooling.

The judge runners (``scripts/live_judge_score.py``,
``scripts/run_judge_calibration.py``) need one non-streaming chat completion.
The API key rides only the ``Authorization`` header, never the URL, the body,
or an error message. An endpoint URL that carries a credential in its userinfo
(``https://user:pass@host``) is resolved before the request: the request
target is the credential-free URL and the credential rides the
``Authorization`` header (#1414). Redirects are refused: urllib's default
handler copies request headers (including ``Authorization``) onto the
redirected request, even across origins.
"""

from __future__ import annotations

import base64
import http.client
import json
import urllib.error
import urllib.request
from typing import Any, Optional

from pr_reviewer.http_safe import (
    OPENER_NO_REDIRECT,
    UnsafeEndpointUrl,
    resolve_endpoint,
)


class JudgeHTTPError(RuntimeError):
    """The endpoint could not be reached or returned a non-2xx status."""


def chat_completion(
    base_url: str,
    payload: dict[str, Any],
    api_key: str,
    timeout_sec: int,
    basic_credential: Optional[str] = None,
) -> Any:
    """POST one chat completion to the judge endpoint.

    The request target never carries a credential: a URL userinfo is moved
    into the ``Authorization`` header (#1414 — credentials travel only in HTTP
    auth headers, never in a request URL, whose ``Host`` value would carry
    them). ``basic_credential`` is the userinfo a caller already split out;
    any userinfo still present in ``base_url`` is split here, so no caller
    can smuggle one through.
    """
    try:
        endpoint = resolve_endpoint(base_url)
    except UnsafeEndpointUrl as error:
        raise JudgeHTTPError(str(error)) from None
    credential = basic_credential or endpoint.credential
    if basic_credential and endpoint.credential:
        # Two distinct credentials for one request: one request carries one
        # Authorization header, so one of them would be dropped silently.
        raise JudgeHTTPError(
            "judge endpoint carries a URL credential and a separate credential; "
            "use exactly one credential channel"
        )
    if credential and api_key:
        # One request carries one Authorization header: the URL credential and
        # the API key cannot both ride in it, and silently dropping either
        # would send the request without the credential the operator chose.
        raise JudgeHTTPError(
            "judge endpoint carries a URL credential and an API key; use "
            "exactly one credential channel"
        )
    url = endpoint.url.rstrip("/") + "/chat/completions"
    headers = {"Content-Type": "application/json"}
    if credential:
        headers["Authorization"] = "Basic " + base64.b64encode(
            credential.encode("utf-8")
        ).decode("ascii")
    elif api_key:
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
    except http.client.InvalidURL:
        # An unusable request target (a control character, a bad port). Never
        # echo the offending value: an endpoint URL can carry a credential.
        raise JudgeHTTPError("judge endpoint URL is not usable") from None
    except http.client.HTTPException as error:
        raise JudgeHTTPError(f"judge endpoint unreachable: {type(error).__name__}") from None
