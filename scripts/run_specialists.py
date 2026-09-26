#!/usr/bin/env python3
"""Deep review: run the three fixed specialist roles concurrently (#608).

The execution layer for the advisory specialist passes defined by the #607
contract module (:mod:`pr_reviewer.specialists`). Invoked from
``scripts/sections/corpus.sh`` behind the ``DEEP_REVIEW=true|auto`` gate —
launched as a background job before the final reviewer path and reaped
fail-soft *before* that path enters, so later tickets can feed the leads into
the final synthesis; the three roles are concurrent with each other (internal
daemon threads), not with the reviewer.

``DEEP_REVIEW=true`` (v2.5 semantics, preserved exactly) runs all three fixed
roles. ``DEEP_REVIEW=auto`` (#633) first resolves a deterministic,
classifier-driven role selection (:mod:`pr_reviewer.role_selection` — a pure
lookup on ``classification.json``'s ``pr_kind`` / ``risk_flags`` /
changed-file classes, **no model call**) and runs only the selected roles;
skipped roles are telemetry (aggregate entries with status ``skipped`` and
the deterministic reason), never errors and never per-role artifacts. An
empty selection still writes the aggregate plus empty section/signal
artifacts, so the downstream corpus stays byte-identical to a disabled run.

One model call per role (correctness / security / tests — the closed set in
``SPECIALIST_ROLES_ORDER``) runs **concurrently** on daemon threads, reusing
the resolved primary model settings from the environment and the shared
transport (:func:`pr_reviewer.transport.run_chat_request`) — no second HTTP
client. Each role receives the same bounded **specialist corpus** plus its
small role prompt (``load_specialist_prompt``); responses are normalized
through :func:`pr_reviewer.specialists.parse_specialist_response`, so malformed
model output degrades to an ``errors`` entry and never an exception.

The specialist corpus (#632) is a compact deterministic subset of the collected
artifacts, built once by ``scripts/build_specialist_corpus.py`` (module
:mod:`pr_reviewer.specialist_corpus`) and handed to the runner via
``--corpus`` (default ``specialist-corpus.md``). It is NOT the final review
corpus — that corpus keeps its own bytes and budgets, and the final reviewer
remains its only consumer. The specialist completion
budget comes from ``DEEP_REVIEW_MAX_TOKENS`` (default
:data:`pr_reviewer.specialists.DEFAULT_SPECIALIST_MAX_TOKENS`, 4096); it does
not inherit ``AI_MAX_TOKENS``.

Artifacts (all resolved under the workspace root, symlink-refused):
``specialist-<role>.request.json`` / ``specialist-<role>.response.json`` /
``specialist-<role>.json`` (the pure version-1 contract artifact) and the
deterministic aggregate ``specialists.json`` (fixed role order, per-role
status / error_kind / elapsed / lead counts, plus #632 corpus/output-budget
and provider-usage telemetry: ``specialist_corpus_bytes``,
``specialist_max_tokens`` and a per-role ``usage`` object when the provider
exposed token counts). The #609 corpus feed adds
``specialists.md`` (the bounded "Specialist Review Leads" section rendered
from the per-role version-1 artifacts, capped by
``SPECIALISTS_SECTION_MAX_BYTES``) and ``specialist-leads-present.txt``
(byte count of the section when it is non-empty, else empty — the
lockstep signal the system-prompt fragment gate reads).

``DEEP_REVIEW_EXECUTION`` (#635, benchmark-only, default ``three_call`` =
the production architecture above) selects the request shape:
``combined_scout`` runs ONE model call whose role-keyed response is split
into the regular per-role artifacts, and ``prime_then_fanout`` runs the
standard three calls with the first role completing before the remaining
two launch (a sequential prime for prefix-cache ordering). The aggregate
records the shape as ``execution`` plus ACTUAL transport totals metered
per wire attempt (``request_count``, ``request_bytes``,
``usage_totals`` — retries included, never re-summed from role entries:
the scout's single call is shared by three roles). Role entries carry
``request_bytes``/``usage`` only for their own request in the three-call
shapes; combined_scout role entries carry neither. These modes are never
enabled by any action input.

Bounds: each attempt is capped by ``min(AI_REQUEST_TIMEOUT_SEC, remaining
aggregate deadline)``; the whole phase is capped by ``DEEP_REVIEW_TIMEOUT_SEC``
(default 600). Threads are daemons and a cancelled straggler never races the
main thread's timeout artifacts, so the process can never outlive the deadline
by more than the transport's own subprocess slack. A transport failure is
retried once (never a timeout, never a contract/parse outcome — those are
deterministic), mirroring the repo's parse-failure principle.

Fail-soft: no role failure propagates. The exit code is 0 whenever the
aggregate artifact was written — even if every role failed — because the leads
are advisory: they never touch the verdict, enforcement, or the published
review body. Secrets are redacted from every error string and artifact; the
API key is passed only through the transport's 0600 curl-config file and is
never serialized into a request artifact, a log line, or the aggregate.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

# The scripts dir hosts redact.py (mirrors pr_reviewer/transport.py's own
# path setup); the project root hosts the pr_reviewer package.
_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))
_PROJECT_ROOT = _SCRIPTS_DIR.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from pr_reviewer.role_selection import select_specialist_roles  # noqa: E402
from pr_reviewer.specialists import (  # noqa: E402
    ARTIFACT_VERSION,
    DEFAULT_SPECIALIST_MAX_TOKENS,
    MAX_INPUT_BYTES,
    SPECIALIST_ROLES_ORDER,
    _empty_artifact,
    _resolve_artifact_path,
    extract_specialist_json,
    load_specialist_prompt,
    normalize_specialist_output,
    parse_specialist_response,
    render_specialist_leads_section,
)
from pr_reviewer.transport import run_chat_request  # noqa: E402
from redact import redact_text  # noqa: E402

#: Total attempts per role (1 initial + 1 retry) on a transport failure.
#: Timeouts and contract (parse) outcomes are never retried.
MAX_ATTEMPTS = 2
#: Base delay between the retry attempts; further clamped to the deadline.
RETRY_DELAY_SEC = 5.0
#: Floor for a per-attempt curl timeout. curl --max-time 0 means *unlimited*,
#: so a nonpositive remaining budget must never reach the transport.
MIN_ATTEMPT_TIMEOUT_SEC = 0.1

#: Specialist-phase execution shapes for the #635 benchmark. The default
#: (``three_call``) is the production architecture and is the ONLY value the
#: action's documented surface uses; the other two are benchmark-only,
#: opt-in via the (deliberately unfingerprinted, untyped) ``DEEP_REVIEW_EXECUTION``
#: environment variable, and exist so the #610 harness can measure request
#: shapes without changing any production default:
#:
#: - ``three_call``       — three concurrent role calls (current behavior).
#: - ``combined_scout``   — ONE model call returning a role-keyed lead object
#:   ``{"correctness": {"leads": [...]}, ...}``; the response is split into the
#:   regular per-role contract artifacts, so every downstream consumer (the
#:   #609 corpus section, harness telemetry) is unchanged.
#: - ``prime_then_fanout`` — the same three payloads as ``three_call`` but the
#:   first role (fixed order) completes before the remaining two launch, a
#:   sequential "prime once, then fan out" variant for backends whose prefix
#:   cache needs an ordered first request.
EXECUTION_MODES = ("three_call", "combined_scout", "prime_then_fanout")
DEFAULT_EXECUTION_MODE = "three_call"

#: Serializes every artifact write in the process. Workers race the collector
#: at the aggregate deadline: without this, a straggler that clears its
#: cancel check microseconds before the reaper could interleave with (or
#: clobber) the timeout record the main thread is writing — concurrent
#: write_text calls on one path can also tear. The lock makes each write
#: atomic w.r.t. every other write, which also closes the is_symlink
#: check-vs-write window. Ordering disagreement between a straggler's
#: artifact and the aggregate timeout entry remains possible and is
#: harmless (advisory telemetry; the aggregate is authoritative for status).
_ARTIFACT_LOCK = threading.Lock()

#: Fixed instruction channel in front of the corpus in every role's user
#: message. Static text (no PR/secret material) so it cannot inject.
_USER_PREFIX = (
    "Analyze the following PR review corpus within your specialist lane "
    "and return your leads as strict JSON."
)


def _env_str(name: str, default: str = "") -> str:
    return os.environ.get(name, default) or default


def _env_int(name: str, default: int, lo: int = 1) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(lo, value)


def _env_temperature() -> Optional[float]:
    """AI_TEMPERATURE passthrough: empty means *omit the field* (mirrors
    build_model_request — some newer models reject any explicit value)."""
    raw = os.environ.get("AI_TEMPERATURE", "").strip()
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def _env_bool(name: str, default: str = "false") -> bool:
    return _env_str(name, default).strip().lower() == "true"


def _json_text(obj: Any) -> str:
    """Deterministic artifact serialization: stable key order, trailing
    newline. Key *insertion* order is preserved for dicts (dicts are ordered
    and no sort is applied to the contract artifacts, whose key order is
    already fixed by pr_reviewer.specialists)."""
    return json.dumps(obj, indent=2, ensure_ascii=False) + "\n"


def _guarded_write(
    workspace_root: Path,
    rel_name: str,
    text: str,
    *,
    abort: Optional[threading.Event] = None,
) -> bool:
    """Write ``text`` to ``rel_name`` under *workspace_root* only.

    Reuses the #607 path guard (relative paths are workspace-root-relative,
    not cwd-relative; escapes are refused) and additionally refuses a
    pre-existing symlink at the target — the same PR-controlled-symlink class
    ``scripts/artifact_paths.sh`` guards on the shell side (the lists must
    agree; tests/test_deep_review_wiring.sh pins them). The symlink check and
    the write run under the shared artifact lock, and a cancelled worker
    (``abort`` set — the reaper already recorded the timeout) writes nothing.
    """
    target = _resolve_artifact_path(rel_name, workspace_root)
    if target is None:
        return False
    with _ARTIFACT_LOCK:
        if abort is not None and abort.is_set():
            return False
        if target.is_symlink():
            return False
        try:
            target.write_text(text, encoding="utf-8")
        except OSError:
            return False
    return True


def _build_payload(
    *,
    api_format: str,
    model: str,
    system: str,
    user: str,
    max_tokens: int,
    temperature: Optional[float],
    response_format: str,
    tokens_param: str,
    stream: bool,
) -> dict[str, Any]:
    """Render a wire-ready single-turn payload for one specialist. Mirrors
    ``build_model_request`` (scripts/model_call.sh) minus the verdict schema:
    the specialist response contract is different and looser, so an
    operator-configured ``json_schema`` on the primary call downgrades to
    plain ``json_object`` here and nothing else is carried over."""
    if api_format == "anthropic":
        payload: dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            "stream": stream,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        }
        if temperature is not None:
            payload["temperature"] = temperature
        return payload

    token_field = (
        "max_completion_tokens"
        if tokens_param == "max_completion_tokens"
        else "max_tokens"
    )
    payload = {
        "model": model,
        "stream": stream,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        token_field: max_tokens,
    }
    if temperature is not None:
        payload["temperature"] = temperature
    if response_format in ("json_object", "json_schema"):
        payload["response_format"] = {"type": "json_object"}
    if stream:
        payload["stream_options"] = {"include_usage": True}
    return payload


def _extract_text(response: Any) -> str:
    """Pull the assistant's text out of a (re)assembled chat response.

    Deliberately independent of the final-review parser: specialists answer
    with a lead object, not a verdict, and their raw text goes through
    ``parse_specialist_response`` instead. Handles the OpenAI
    ``choices[0].message.content`` shape and the Anthropic ``content`` text-
    block shape (also what the SSE reassembler emits for both formats).
    """
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
                parts = [
                    block.get("text", "")
                    for block in content
                    if isinstance(block, dict) and isinstance(block.get("text"), str)
                ]
                if parts:
                    return "".join(parts)
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


def _extract_usage(response: Any) -> Optional[dict[str, Optional[int]]]:
    """Normalize provider token usage from a (re)assembled chat response.

    Handles the OpenAI shape (``usage.prompt_tokens`` / ``completion_tokens`` /
    ``total_tokens`` and ``usage.prompt_tokens_details.cached_tokens``) and the
    Anthropic shape (``usage.input_tokens`` / ``output_tokens`` /
    ``cache_read_input_tokens``). Returns ``None`` when the provider exposed no
    usage fields, so telemetry stays fail-soft for endpoints that omit them.
    """
    if not isinstance(response, dict):
        return None
    usage = response.get("usage")
    if not isinstance(usage, dict):
        return None

    def _int(value: Any) -> Optional[int]:
        if isinstance(value, bool) or not isinstance(value, int):
            return None
        return value

    prompt = _int(usage.get("prompt_tokens"))
    completion = _int(usage.get("completion_tokens"))
    total = _int(usage.get("total_tokens"))
    cached: Optional[int] = None
    details = usage.get("prompt_tokens_details")
    if isinstance(details, dict):
        cached = _int(details.get("cached_tokens"))
    if prompt is None:
        prompt = _int(usage.get("input_tokens"))
    if completion is None:
        completion = _int(usage.get("output_tokens"))
    if cached is None:
        cached = _int(usage.get("cache_read_input_tokens"))
    if cached is None:
        cached = _int(usage.get("cache_creation_input_tokens"))
    if total is None and prompt is not None and completion is not None:
        total = prompt + completion
    if prompt is None and completion is None and total is None and cached is None:
        return None
    return {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "cached_tokens": cached,
        "total_tokens": total,
    }


class _RequestMeter:
    """Counts ACTUAL transport behavior for the aggregate (#635).

    Wraps the transport's ``request_fn`` so every real wire attempt is
    metered exactly once regardless of execution shape: attempts (including
    retries), serialized request-payload bytes, and provider usage merged
    across responses. Thread-safe (three_call fans out concurrently). The
    aggregate's ``request_count`` / ``request_bytes`` / ``usage_totals``
    come from here — never from summing role entries, which in
    ``combined_scout`` mode would multiply the one shared call by three.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.count = 0
        self.bytes = 0
        self.usage: Optional[dict[str, Optional[int]]] = None

    def wrap(self, fn: Callable[..., Any]) -> Callable[..., Any]:
        def wrapped(base_url, api_format, payload, api_key, timeout_sec):
            payload_bytes = len(json.dumps(payload).encode("utf-8"))
            with self._lock:
                self.count += 1
                self.bytes += payload_bytes
            response = fn(base_url, api_format, payload, api_key, timeout_sec)
            usage = _extract_usage(response)
            if usage is not None:
                with self._lock:
                    self._merge_usage(usage)
            return response

        return wrapped

    def _merge_usage(self, usage: dict[str, Optional[int]]) -> None:
        if self.usage is None:
            self.usage = dict(usage)
            return
        for key, value in usage.items():
            if isinstance(value, bool) or not isinstance(value, int):
                continue
            current = self.usage.get(key)
            if isinstance(current, bool) or not isinstance(current, int):
                self.usage[key] = value
            else:
                self.usage[key] = current + value


def _status_of(result: dict[str, Any]) -> str:
    """ok / degraded for a contract artifact the model actually answered.

    ``degraded`` when the #607 parse reported errors (malformed leads,
    unusable entries) or truncation — the artifact is still valid and
    bounded, but a consumer should know it is partial.
    """
    if result.get("errors"):
        return "degraded"
    if result.get("truncated"):
        return "degraded"
    truncation = result.get("truncation")
    if isinstance(truncation, dict) and truncation.get("truncated"):
        return "degraded"
    return "ok"


def _role_entry(
    role: str,
    artifact: dict[str, Any],
    *,
    status: str,
    error_kind: Optional[str],
    elapsed_sec: float,
    usage: Optional[dict[str, Optional[int]]] = None,
    request_bytes: Optional[int] = None,
) -> dict[str, Any]:
    leads = artifact.get("leads")
    errors = artifact.get("errors")
    return {
        "role": role,
        "status": status,
        "error_kind": error_kind,
        "elapsed_sec": round(elapsed_sec, 3),
        "lead_count": len(leads) if isinstance(leads, list) else 0,
        "errors_count": len(errors) if isinstance(errors, list) else 0,
        "usage": usage,
        # #635: serialized request-body size (bytes) for request-shape A/B
        # telemetry. None when no request was built (input/guard failures).
        "request_bytes": request_bytes,
    }


def _skipped_entry(role: str, reason: str) -> dict[str, Any]:
    """Aggregate entry for a role deterministically skipped by auto
    selection (#633). Skipped roles are telemetry, not failures: no error
    kind, no lead, and the deterministic reason the selector gave."""
    return {
        "role": role,
        "status": "skipped",
        "error_kind": None,
        "elapsed_sec": 0.0,
        "lead_count": 0,
        "errors_count": 0,
        "reason": reason,
        "request_bytes": None,
    }


def _write_role_failure_artifacts(
    workspace_root: Path,
    role: str,
    artifact: dict[str, Any],
    message: str,
    *,
    cancel: Optional[threading.Event] = None,
) -> None:
    """Write the fail-soft artifact pair for a role that never answered:
    the empty contract artifact carrying ``message`` in ``errors`` plus the
    raw response record. Shared by the worker crash guard and the deadline
    timeout reaper so both write the identical pair."""
    _guarded_write(
        workspace_root,
        f"specialist-{role}.json",
        _json_text(artifact),
        abort=cancel,
    )
    _guarded_write(
        workspace_root,
        f"specialist-{role}.response.json",
        _json_text({"error": message}),
        abort=cancel,
    )


class _RoleFailure(Exception):
    """Internal control flow: a role failed at ``kind`` with a masked
    message. Caught inside the worker; never escapes the thread."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message


def _run_role(
    role: str,
    *,
    workspace_root: Path,
    user_message: str,
    base_url: str,
    api_format: str,
    model: str,
    api_key: str,
    max_tokens: int,
    temperature: Optional[float],
    response_format: str,
    tokens_param: str,
    stream: bool,
    role_timeout_sec: int,
    deadline: float,
    cancel: threading.Event,
    request_fn: Callable[..., Any],
    system_variant: str = "",
    corpus_source: str = "standard",
) -> dict[str, Any]:
    """Run one specialist role end-to-end and return its aggregate entry.

    Never raises: every failure mode (prompt, guard, transport, timeout,
    contract) lands as a fail-soft entry plus guarded artifacts. ``cancel``
    is checked before every artifact write and every attempt so a straggler
    thread never races the main thread's deadline-timeout writes.
    """
    started = time.monotonic()
    # Set once the wire payload exists; every entry this role publishes after
    # that point (including deadline-timeout entries) carries the size.
    request_bytes_cell: list[int] = []

    def finish(
        artifact: dict[str, Any],
        *,
        status: str,
        error_kind: Optional[str],
        usage: Optional[dict[str, Optional[int]]] = None,
    ) -> dict[str, Any]:
        request_bytes = (
            request_bytes_cell[0] if request_bytes_cell else None
        )

        def tagged(entry: dict[str, Any]) -> dict[str, Any]:
            # #758: which corpus (and prompt family) this role ran against —
            # telemetry only, never a behavior switch downstream.
            entry["corpus_source"] = corpus_source
            return entry

        if cancel.is_set():
            return tagged(_role_entry(
                role, artifact, status="error",
                error_kind=error_kind or "timeout",
                elapsed_sec=time.monotonic() - started,
                usage=usage,
                request_bytes=request_bytes,
            ))
        if not _guarded_write(
            workspace_root, f"specialist-{role}.json", _json_text(artifact),
            abort=cancel,
        ):
            if cancel.is_set():
                # The reaper won the race for this write and recorded the
                # timeout; not a guard refusal.
                return tagged(_role_entry(
                    role, artifact, status="error", error_kind="timeout",
                    elapsed_sec=time.monotonic() - started,
                    usage=usage,
                    request_bytes=request_bytes,
                ))
            guard_artifact = _empty_artifact(role)
            guard_artifact["errors"].append(
                "refused to write the role artifact: workspace escape or symlink"
            )
            if not _guarded_write(
                workspace_root, f"specialist-{role}.json", _json_text(guard_artifact)
            ):
                # Cannot even record the refusal (path itself is hostile);
                # the entry still reports it.
                pass
            return tagged(_role_entry(
                role, guard_artifact, status="error", error_kind="guard",
                elapsed_sec=time.monotonic() - started,
                usage=usage,
                request_bytes=request_bytes,
            ))
        return tagged(_role_entry(
            role, artifact, status=status, error_kind=error_kind,
            elapsed_sec=time.monotonic() - started,
            usage=usage,
            request_bytes=request_bytes,
        ))

    try:
        try:
            system = (
                load_specialist_prompt(role, system_variant)
                if system_variant
                else load_specialist_prompt(role)
            )
        except (OSError, ValueError) as exc:
            raise _RoleFailure("input", f"role prompt fragment unavailable: {redact_text(str(exc))}")

        payload = _build_payload(
            api_format=api_format,
            model=model,
            system=system,
            user=user_message,
            max_tokens=max_tokens,
            temperature=temperature,
            response_format=response_format,
            tokens_param=tokens_param,
            stream=stream,
        )
        request_bytes_cell.append(
            len(json.dumps(payload).encode("utf-8"))
        )
        # The request artifact is the payload itself — structurally secret-
        # free (the key travels only in the transport's 0600 curl config).
        if not _guarded_write(
            workspace_root, f"specialist-{role}.request.json", _json_text(payload),
            abort=cancel,
        ):
            raise _RoleFailure("guard", "refused to write the request artifact")

        last_error: Optional[_RoleFailure] = None
        for attempt in range(1, MAX_ATTEMPTS + 1):
            if cancel.is_set():
                raise _RoleFailure("timeout", "specialist phase deadline exceeded")
            remaining = deadline - time.monotonic()
            if remaining < MIN_ATTEMPT_TIMEOUT_SEC:
                raise _RoleFailure("timeout", "specialist phase deadline exceeded")
            attempt_timeout = min(float(role_timeout_sec), remaining)
            try:
                response = request_fn(
                    base_url, api_format, payload, api_key, attempt_timeout
                )
            except Exception as exc:  # noqa: BLE001 - fail-soft by design
                masked = str(redact_text(str(exc)))[:500]
                if "timed out" in masked.lower():
                    raise _RoleFailure("timeout", masked)
                last_error = _RoleFailure("transport", masked)
                if attempt < MAX_ATTEMPTS:
                    delay = min(RETRY_DELAY_SEC, max(0.0, deadline - time.monotonic()))
                    if delay > 0:
                        if cancel.wait(delay):
                            raise _RoleFailure(
                                "timeout", "specialist phase deadline exceeded"
                            )
                    continue
                raise last_error

            # A 200 whose body is an error object is a transport failure
            # (some gateways do this); never parse it as a lead set.
            if isinstance(response, dict) and response.get("error"):
                raise _RoleFailure(
                    "transport",
                    f"endpoint returned an error body: {redact_text(str(response['error']))[:500]}",
                )

            # Reaped stragglers never write artifacts past the deadline: the
            # main thread already recorded the timeout, so writing here would
            # race it (response.json could disagree with the timeout record).
            if cancel.is_set():
                raise _RoleFailure("timeout", "specialist phase deadline exceeded")

            if not _guarded_write(
                workspace_root,
                f"specialist-{role}.response.json",
                _json_text(
                    response
                    if isinstance(response, (dict, list))
                    else {"raw_response": str(response)}
                ),
            ):
                raise _RoleFailure("guard", "refused to write the response artifact")

            text = _extract_text(response)
            artifact = parse_specialist_response(text, role=role)
            return finish(
                artifact,
                status=_status_of(artifact),
                error_kind=None,
                usage=_extract_usage(response),
            )

        raise last_error or _RoleFailure("transport", "no attempt completed")

    except _RoleFailure as failure:
        failure_artifact = _empty_artifact(role)
        failure_artifact["errors"].append(f"{failure.kind}: {failure.message}")
        _guarded_write(
            workspace_root,
            f"specialist-{role}.response.json",
            _json_text({"error": f"{failure.kind}: {failure.message}"}),
            abort=cancel,
        )
        return finish(
            failure_artifact, status="error", error_kind=failure.kind
        )


# ---------------------------------------------------------------------------
# #635 combined-scout execution mode (benchmark-only; three_call stays the
# production default)
# ---------------------------------------------------------------------------

#: Static instruction header for the combined scout pass. Static text only —
#: no PR/secret material — so it cannot inject.
_SCOUT_HEADER = (
    "You are performing three specialist review passes in one combined pass "
    "over the same PR review corpus. Apply each specialist lane below to the "
    "corpus, then return one role-keyed JSON object."
)

#: Required response shape, reusing the #607 per-role lead contract.
_SCOUT_SHAPE = (
    'Return strict JSON exactly in this shape (no prose, no fences):\n'
    '{\n'
    '  "correctness": {"leads": [...]},\n'
    '  "security": {"leads": [...]},\n'
    '  "tests": {"leads": []}\n'
    '}\n'
    'Each lead object follows the same schema as the individual specialist '
    'passes (severity/category/file/line/message). A role with no leads '
    'returns an empty leads array. Never invent a role key.'
)


def _build_scout_system() -> str:
    """Compose the combined-scout system prompt from the three role fragments.

    Same fragments the individual roles load, plus the role-keyed output
    shape, so the scout's instructions differ from three-call only in
    packaging (that is the comparison the benchmark wants)."""
    parts = [_SCOUT_HEADER]
    for role in SPECIALIST_ROLES_ORDER:
        parts.append(f"## {role} lane\n\n{load_specialist_prompt(role)}")
    parts.append(_SCOUT_SHAPE)
    return "\n\n".join(parts)


def _parse_scout_response(
    text: str | None,
    roles: tuple[str, ...],
) -> dict[str, dict[str, Any]]:
    """Split a scout response into per-role #607 contract artifacts.

    Tolerant end to end (never raises): the role-keyed object is extracted
    with the shared ``extract_specialist_json``; a role value that is a bare
    lead list is accepted (wrapped as ``{"leads": [...]}``); a missing role
    key or undecodable JSON degrades that role to an artifact with a visible
    error and empty leads. Normalization itself goes through
    :func:`pr_reviewer.specialists.normalize_specialist_output`, so severity
    capping, dedupe, and byte caps apply identically to the three-call path.
    """
    payload = extract_specialist_json(text)
    out: dict[str, dict[str, Any]] = {}
    if not isinstance(payload, dict):
        for role in roles:
            artifact = _empty_artifact(role)
            artifact["errors"].append(
                "malformed JSON: no decodable role-keyed lead object found"
            )
            out[role] = artifact
        return out
    for role in roles:
        role_value = payload.get(role)
        if isinstance(role_value, list):
            role_value = {"leads": role_value}
        artifact = normalize_specialist_output(role_value, role=role)
        if role not in payload:
            artifact["errors"].append(f"scout response omitted the {role!r} role")
        out[role] = artifact
    return out


def _run_scout(
    *,
    workspace_root: Path,
    user_message: str,
    roles: tuple[str, ...],
    base_url: str,
    api_format: str,
    model: str,
    api_key: str,
    max_tokens: int,
    temperature: Optional[float],
    response_format: str,
    tokens_param: str,
    stream: bool,
    role_timeout_sec: int,
    deadline: float,
    cancel: threading.Event,
    request_fn: Callable[..., Any],
) -> list[dict[str, Any]]:
    """Run the ONE combined scout call and return per-role aggregate entries.

    Mirrors ``_run_role``'s fail-soft contract (transport retry-once, deadline
    honored, guarded writes, masked errors) but for a single request whose
    response is split into per-role artifacts. Never raises. Every role
    entry shares the call's elapsed time, usage, and request size; per-role
    status reflects that role's own normalization outcome.
    """
    started = time.monotonic()
    try:
        system = _build_scout_system()
    except (OSError, ValueError) as exc:
        message = f"input: scout prompt unavailable: {redact_text(str(exc))}"
        return [
            _scout_failure_entry(workspace_root, role, message, started)
            for role in roles
        ]

    payload = _build_payload(
        api_format=api_format,
        model=model,
        system=system,
        user=user_message,
        max_tokens=max_tokens,
        temperature=temperature,
        response_format=response_format,
        tokens_param=tokens_param,
        stream=stream,
    )

    # The request artifact is the payload itself — structurally secret-free
    # (the key travels only in the transport's 0600 curl config). A refused
    # write skips the call, mirroring _run_role's guard contract.
    if not _guarded_write(
        workspace_root, "specialist-scout.request.json", _json_text(payload),
        abort=cancel,
    ):
        message = "guard: refused to write the scout request artifact"
        return [
            _scout_failure_entry(
                workspace_root, role, message, started, cancel=cancel,
            )
            for role in roles
        ]

    last_error: Optional[str] = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        if cancel.is_set():
            last_error = "timeout: specialist phase deadline exceeded"
            break
        remaining = deadline - time.monotonic()
        if remaining < MIN_ATTEMPT_TIMEOUT_SEC:
            last_error = "timeout: specialist phase deadline exceeded"
            break
        attempt_timeout = min(float(role_timeout_sec), remaining)
        try:
            response = request_fn(
                base_url, api_format, payload, api_key, attempt_timeout
            )
        except Exception as exc:  # noqa: BLE001 - fail-soft by design
            masked = str(redact_text(str(exc)))[:500]
            if "timed out" in masked.lower():
                last_error = f"timeout: {masked}"
                break
            last_error = f"transport: {masked}"
            if attempt < MAX_ATTEMPTS:
                delay = min(RETRY_DELAY_SEC, max(0.0, deadline - time.monotonic()))
                if delay > 0:
                    if cancel.wait(delay):
                        last_error = "timeout: specialist phase deadline exceeded"
                        break
                continue
            break

        if isinstance(response, dict) and response.get("error"):
            last_error = (
                "transport: endpoint returned an error body: "
                f"{redact_text(str(response['error']))[:500]}"
            )
            break

        if cancel.is_set():
            last_error = "timeout: specialist phase deadline exceeded"
            break

        if not _guarded_write(
            workspace_root,
            "specialist-scout.response.json",
            _json_text(
                response
                if isinstance(response, (dict, list))
                else {"raw_response": str(response)}
            ),
        ):
            last_error = "guard: refused to write the scout response artifact"
            break

        artifacts = _parse_scout_response(_extract_text(response), roles)
        elapsed = time.monotonic() - started
        entries: list[dict[str, Any]] = []
        for role in roles:
            artifact = artifacts[role]
            # Role entries carry NO usage/request_bytes: the one shared call
            # belongs to no single role, and copying it would multiply it by
            # three when consumers sum role entries (#635). The aggregate's
            # request meter owns the transport accounting.
            if not _guarded_write(
                workspace_root, f"specialist-{role}.json", _json_text(artifact),
                abort=cancel,
            ):
                if cancel.is_set():
                    entries.append(_role_entry(
                        role, artifact, status="error", error_kind="timeout",
                        elapsed_sec=elapsed,
                    ))
                    continue
                artifact = _empty_artifact(role)
                artifact["errors"].append(
                    "refused to write the role artifact: workspace escape or symlink"
                )
                entries.append(_role_entry(
                    role, artifact, status="error", error_kind="guard",
                    elapsed_sec=elapsed,
                ))
                continue
            entries.append(_role_entry(
                role, artifact, status=_status_of(artifact), error_kind=None,
                elapsed_sec=elapsed,
            ))
        return entries

    # Every failure path lands here: all roles share the one failure record.
    message = last_error or "transport: no attempt completed"
    return [
        _scout_failure_entry(
            workspace_root,
            role,
            message,
            started,
            cancel=cancel,
        )
        for role in roles
    ]


def _scout_failure_entry(
    workspace_root: Path,
    role: str,
    message: str,
    started: float,
    *,
    cancel: Optional[threading.Event] = None,
) -> dict[str, Any]:
    """Fail-soft entry + artifact pair for a role when the ONE scout call
    failed (or the whole phase was cancelled). Mirrors
    ``_write_role_failure_artifacts`` but returns the entry."""
    artifact = _empty_artifact(role)
    artifact["errors"].append(message)
    _guarded_write(
        workspace_root,
        f"specialist-{role}.json",
        _json_text(artifact),
        abort=cancel,
    )
    return _role_entry(
        role, artifact, status="error",
        error_kind=message.split(":", 1)[0],
        elapsed_sec=time.monotonic() - started,
    )


def _read_corpus(corpus_path: str) -> tuple[Optional[str], Optional[str], int]:
    """Read the review corpus. Returns (text, error, raw_bytes); a missing,
    unreadable, or over-cap corpus is a soft input error, never an exception.
    ``raw_bytes`` is the on-disk size (0 on failure) for corpus-size telemetry."""
    try:
        raw = Path(corpus_path).read_bytes()
    except FileNotFoundError:
        return None, f"corpus not found: {corpus_path}", 0
    except OSError as exc:
        return None, f"corpus unreadable: {redact_text(str(exc))}", 0
    if len(raw) > MAX_INPUT_BYTES:
        return None, f"corpus exceeds {MAX_INPUT_BYTES} byte input cap", 0
    if not raw.strip():
        return None, f"specialist corpus is empty: {corpus_path}", 0
    return raw.decode("utf-8", errors="replace"), None, len(raw)


def _read_role_artifacts(
    workspace_root: Path,
) -> dict[str, Optional[dict[str, Any]]]:
    """Reload the per-role normalized version-1 artifacts just written as
    ``specialist-<role>.json``. This is the canonical, already-normalized lead
    data for the #609 corpus section, so the section renders exactly the
    contract artifact (not a second, drift-prone in-memory copy). A missing,
    unreadable, or non-object file degrades that role to ``None``; the render
    then simply omits it. Never raises."""
    role_results: dict[str, Optional[dict[str, Any]]] = {}
    for role in SPECIALIST_ROLES_ORDER:
        path = workspace_root / f"specialist-{role}.json"
        try:
            raw = path.read_bytes()
            parsed = json.loads(raw.decode("utf-8", errors="replace"))
        except (OSError, ValueError):
            role_results[role] = None
            continue
        role_results[role] = parsed if isinstance(parsed, dict) else None
    return role_results


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run the deep-review specialist passes (#608)."
    )
    parser.add_argument(
        "--corpus",
        default="specialist-corpus.md",
        help="Bounded specialist corpus handed to every specialist role.",
    )
    parser.add_argument(
        "--adversarial-corpus",
        default="",
        help=(
            "#758: author-blinded adversarial corpus (built with "
            "build_specialist_corpus.py --mode adversarial_correctness). When "
            "non-empty and readable, the CORRECTNESS role runs against this "
            "corpus with the adversarial prompt variant; security/tests keep "
            "the standard corpus. Empty (default) keeps every role on the "
            "standard corpus and the default prompts."
        ),
    )
    parser.add_argument(
        "--workspace-root",
        default="",
        help="Root for all artifact writes (default: $GITHUB_WORKSPACE or cwd).",
    )
    parser.add_argument(
        "--classification",
        default="classification.json",
        help=(
            "Classification artifact driving deep_review=auto role selection "
            "(#633); resolved under the workspace root. Ignored in true mode."
        ),
    )
    args = parser.parse_args(argv)

    # true = all three roles (v2.5 semantics); auto = deterministic
    # classifier-driven selection (#633), possibly zero roles. Anything else
    # is disabled — review.sh/corpus.sh validate too; this guards direct
    # calls so the disabled path is provably call-free and write-free.
    deep_mode = _env_str("DEEP_REVIEW", "false").strip().lower()
    if deep_mode not in ("true", "auto"):
        print("deep_review disabled; no specialist passes run")
        return 0

    # #635 benchmark execution shape. three_call (the default) is the
    # production architecture; the other values are benchmark-only. An
    # invalid value falls back loudly rather than silently re-shaping a
    # benchmark run.
    execution = (
        _env_str("DEEP_REVIEW_EXECUTION", DEFAULT_EXECUTION_MODE).strip().lower()
    )
    if execution not in EXECUTION_MODES:
        print(
            f"ERROR: invalid DEEP_REVIEW_EXECUTION {execution!r}; "
            f"using {DEFAULT_EXECUTION_MODE}",
            file=sys.stderr,
        )
        execution = DEFAULT_EXECUTION_MODE

    workspace_root = Path(
        args.workspace_root or os.environ.get("GITHUB_WORKSPACE") or os.getcwd()
    ).resolve()

    # ── #633 auto role selection ───────────────────────────────────────────
    # Deterministic classification lookup (no model call). Fail-soft: an
    # unreadable classification artifact selects zero roles with an explicit
    # reason — never an exception, never a partially-run phase.
    selection_artifact: Optional[dict[str, Any]] = None
    roles_to_run: tuple[str, ...] = SPECIALIST_ROLES_ORDER
    skipped_reasons: dict[str, str] = {}
    if deep_mode == "auto":
        classification: Any = None
        classification_path = _resolve_artifact_path(
            args.classification, workspace_root
        )
        if classification_path is not None:
            try:
                classification = json.loads(
                    classification_path.read_text(encoding="utf-8")
                )
            except (OSError, ValueError):
                classification = None
        selection_artifact = select_specialist_roles(classification)
        selected = set(selection_artifact["selected_roles"])
        roles_to_run = tuple(
            role for role in SPECIALIST_ROLES_ORDER if role in selected
        )
        for decision in selection_artifact["decisions"]:
            if not decision.get("selected"):
                skipped_reasons[decision["role"]] = decision["reason"]
        selection_note = (
            f"deep review mode auto: selected roles "
            f"[{', '.join(roles_to_run) if roles_to_run else 'none'}]"
        )
        if not roles_to_run and selection_artifact["zero_selection_reason"]:
            selection_note += f" — {selection_artifact['zero_selection_reason']}"
        print(selection_note)

    base_url = _env_str("AI_BASE_URL")
    api_format = _env_str("AI_API_FORMAT", "openai").strip().lower()
    model = _env_str("AI_MODEL")
    api_key = _env_str("AI_API_KEY")
    # #632: the specialist output budget is independent of the final reviewer's
    # AI_MAX_TOKENS — a narrow advisory scout needs only a short JSON lead set.
    max_tokens = _env_int("DEEP_REVIEW_MAX_TOKENS", DEFAULT_SPECIALIST_MAX_TOKENS)
    temperature = _env_temperature()
    response_format = _env_str("AI_RESPONSE_FORMAT", "off").strip().lower()
    tokens_param = _env_str("AI_TOKENS_PARAM", "max_tokens").strip().lower()
    stream = _env_bool("AI_STREAM", "true")
    role_timeout_sec = _env_int("AI_REQUEST_TIMEOUT_SEC", 300)
    phase_timeout_sec = _env_int("DEEP_REVIEW_TIMEOUT_SEC", 600)

    phase_started = time.monotonic()
    deadline = phase_started + phase_timeout_sec

    # #635: meter every ACTUAL transport attempt (any execution shape,
    # retries included) once for the aggregate; role entries keep their own
    # per-role telemetry and the combined-scout entries carry none, so
    # aggregate totals can never double-count a shared call.
    meter = _RequestMeter()
    metered_request_fn = meter.wrap(run_chat_request)

    entries: list[dict[str, Any]] = []
    corpus, corpus_error, corpus_bytes = _read_corpus(args.corpus)
    # #758: the adversarial-correctness corpus is optional and fail-soft — an
    # unreadable/empty adversarial corpus keeps the correctness role on the
    # standard corpus and the default prompt (never blocks the phase).
    adversarial_corpus, adversarial_error, adversarial_bytes = ("", None, 0)
    adversarial_active = False
    if args.adversarial_corpus:
        adversarial_corpus, adversarial_error, adversarial_bytes = _read_corpus(
            args.adversarial_corpus
        )
        adversarial_active = bool(adversarial_corpus)
        if adversarial_error and not adversarial_corpus:
            print(
                f"WARNING: adversarial corpus unreadable ({adversarial_error}); "
                "correctness falls back to the standard corpus",
                flush=True,
            )
    if adversarial_active and execution == "combined_scout":
        # The #635 scout shares ONE call across roles with one user message;
        # a per-role corpus cannot be expressed in that shape. Degrade loudly
        # to three_call rather than silently feeding the correctness role the
        # standard corpus.
        execution = "three_call"
        print(
            "WARNING: adversarial correctness corpus is incompatible with "
            "DEEP_REVIEW_EXECUTION=combined_scout; forcing three_call",
            flush=True,
        )
    if corpus is None:
        # No corpus means no calls at all: every SELECTED role is recorded as
        # a soft input failure and skipped roles keep their skip telemetry;
        # the aggregate is still written.
        for role in SPECIALIST_ROLES_ORDER:
            if role not in roles_to_run:
                entries.append(_skipped_entry(role, skipped_reasons[role]))
                continue
            artifact = _empty_artifact(role)
            artifact["errors"].append(f"input: {corpus_error}")
            _guarded_write(workspace_root, f"specialist-{role}.json", _json_text(artifact))
            entries.append(
                _role_entry(
                    role, artifact, status="error", error_kind="input", elapsed_sec=0.0
                )
            )
    else:
        user_message = f"{_USER_PREFIX}\n\n{corpus}"

        if execution == "combined_scout":
            # #635: ONE model call returns the role-keyed lead object; the
            # response is split into the regular per-role artifacts so every
            # downstream consumer (#609 section, harness telemetry) is
            # unchanged. Not-selected roles keep their skip telemetry.
            scout_results = _run_scout(
                workspace_root=workspace_root,
                user_message=user_message,
                roles=tuple(roles_to_run),
                base_url=base_url,
                api_format=api_format,
                model=model,
                api_key=api_key,
                max_tokens=max_tokens,
                temperature=temperature,
                response_format=response_format,
                tokens_param=tokens_param,
                stream=stream,
                role_timeout_sec=role_timeout_sec,
                deadline=deadline,
                cancel=threading.Event(),
                request_fn=metered_request_fn,
            )
            by_role = {entry["role"]: entry for entry in scout_results}
            entries = []
            for role in SPECIALIST_ROLES_ORDER:
                if role in by_role:
                    entries.append(by_role[role])
                elif role not in roles_to_run:
                    entries.append(_skipped_entry(role, skipped_reasons[role]))
        else:
            cancels = {role: threading.Event() for role in roles_to_run}
            results: dict[str, dict[str, Any]] = {}
            threads: dict[str, threading.Thread] = {}

            def worker(role: str) -> None:
                # _run_role is designed never to raise, but a latent bug must
                # still not leave the collector without an entry: catch anything
                # that escapes and publish a fail-soft record with the full
                # artifact set. Exception (not BaseException) so a
                # KeyboardInterrupt / SystemExit still propagates.
                try:
                    results[role] = _run_role_inner(role)
                except Exception as exc:  # noqa: BLE001 - last-resort guard
                    message = (
                        f"transport: specialist worker crashed: "
                        f"{redact_text(str(exc))[:500]}"
                    )
                    artifact = _empty_artifact(role)
                    artifact["errors"].append(message)
                    _write_role_failure_artifacts(
                        workspace_root, role, artifact, message,
                        cancel=cancels[role],
                    )
                    results[role] = _role_entry(
                        role, artifact, status="error", error_kind="transport",
                        elapsed_sec=time.monotonic() - phase_started,
                    )

            def _run_role_inner(role: str) -> dict[str, Any]:
                # #758: the correctness role runs blinded (adversarial corpus +
                # adversarial prompt variant) when the adversarial corpus is
                # active; security/tests always see the standard corpus and
                # the default prompt.
                role_user_message = user_message
                system_variant = ""
                corpus_source = "standard"
                if role == "correctness" and adversarial_active:
                    role_user_message = f"{_USER_PREFIX}\n\n{adversarial_corpus}"
                    system_variant = "adversarial"
                    corpus_source = "adversarial"
                entry = _run_role(
                    role,
                    workspace_root=workspace_root,
                    user_message=role_user_message,
                    system_variant=system_variant,
                    corpus_source=corpus_source,
                    base_url=base_url,
                    api_format=api_format,
                    model=model,
                    api_key=api_key,
                    max_tokens=max_tokens,
                    temperature=temperature,
                    response_format=response_format,
                    tokens_param=tokens_param,
                    stream=stream,
                    role_timeout_sec=role_timeout_sec,
                    deadline=deadline,
                    cancel=cancels[role],
                    request_fn=metered_request_fn,
                )
                return entry

            threads_by_role: dict[str, threading.Thread] = {}
            for role in roles_to_run:
                thread = threading.Thread(
                    target=worker, args=(role,), name=f"specialist-{role}", daemon=True
                )
                threads_by_role[role] = thread

            if execution == "prime_then_fanout" and threads_by_role:
                # #635: sequential "prime once, then fan out" — the first
                # selected role (fixed order) completes before the remaining
                # two launch, for backends whose prefix cache needs an
                # ordered first request. Roles past the deadline after the
                # prime are still started: each attempt checks the deadline
                # and fails fast to a timeout record instead of being
                # silently missing from the aggregate.
                first = next(r for r in SPECIALIST_ROLES_ORDER if r in threads_by_role)
                threads_by_role[first].start()
                threads_by_role[first].join(
                    timeout=max(0.0, deadline - time.monotonic())
                )
                if threads_by_role[first].is_alive():
                    cancels[first].set()
                for role in roles_to_run:
                    if role != first:
                        threads_by_role[role].start()
            else:
                for role in roles_to_run:
                    threads_by_role[role].start()
            threads = threads_by_role

            entries = []
            # Collect in fixed role order against the ONE aggregate deadline: a
            # straggler past it is cancelled (its thread is a daemon and checks
            # the flag before writing, so it cannot race the timeout record) and
            # never extends the phase. Skipped roles keep their fixed-order
            # telemetry slots without having run.
            for role in SPECIALIST_ROLES_ORDER:
                if role not in threads:
                    entries.append(_skipped_entry(role, skipped_reasons[role]))
                    continue
                remaining = deadline - time.monotonic()
                threads[role].join(timeout=max(0.0, remaining))
                if threads[role].is_alive():
                    cancels[role].set()
                    timeout_message = (
                        f"timeout: specialist phase exceeded {phase_timeout_sec}s"
                    )
                    artifact = _empty_artifact(role)
                    artifact["errors"].append(timeout_message)
                    _write_role_failure_artifacts(
                        workspace_root, role, artifact, timeout_message
                    )
                    results[role] = _role_entry(
                        role,
                        artifact,
                        status="error",
                        error_kind="timeout",
                        elapsed_sec=time.monotonic() - phase_started,
                    )
                entries.append(results[role])

    aggregate_elapsed = time.monotonic() - phase_started
    print(
        f"specialist corpus: {corpus_bytes} bytes; "
        f"specialist max_tokens: {max_tokens}"
    )
    for entry in entries:
        suffix = f" ({entry['error_kind']})" if entry.get("error_kind") else ""
        usage = entry.get("usage")
        usage_note = ""
        if isinstance(usage, dict):
            usage_note = (
                f", tokens in/out={usage.get('prompt_tokens')}/"
                f"{usage.get('completion_tokens')}"
                f" cached={usage.get('cached_tokens')}"
            )
        reason = f" — {entry['reason']}" if entry.get("reason") else ""
        print(
            f"specialist {entry['role']}: {entry['status']}{suffix}{reason} — "
            f"{entry['lead_count']} lead(s), {entry['errors_count']} error(s), "
            f"{entry['elapsed_sec']}s{usage_note}"
        )

    aggregate = {
        "version": ARTIFACT_VERSION,
        "enabled": True,
        # Requested deep-review mode ("true" = all roles, "auto" = the
        # deterministic #633 selection below). Part of the config
        # fingerprint via DEEP_REVIEW, so a mode switch invalidates a stale
        # comment.
        "deep_review_mode": deep_mode,
        # #635 benchmark telemetry: which specialist execution shape ran
        # (three_call is the production default).
        "execution": execution,
        # ACTUAL transport totals metered per wire attempt (retries
        # included): never derived from role entries — combined_scout shares
        # one call across three roles, and summing role entries would
        # multiply it by three. usage_totals merges the provider usage of
        # every response (None when no provider exposed token counts).
        "request_count": meter.count,
        "request_bytes": meter.bytes,
        "usage_totals": meter.usage,
        "model": f"{model}@{base_url} ({api_format})",
        "aggregate_elapsed_sec": round(aggregate_elapsed, 3),
        "specialist_corpus_bytes": corpus_bytes,
        # #758: whether the adversarial-correctness arm was active and which
        # corpus the correctness role actually ran against.
        "adversarial_correctness_active": adversarial_active,
        "adversarial_corpus_bytes": adversarial_bytes if adversarial_active else None,
        "specialist_max_tokens": max_tokens,
        "total_leads": sum(entry["lead_count"] for entry in entries),
        # Skipped roles are telemetry, not failures: they never set
        # any_errors (#633).
        "any_errors": any(
            entry["status"] not in ("ok", "skipped") or entry["errors_count"]
            for entry in entries
        ),
        "roles": entries,
    }
    if selection_artifact is not None:
        aggregate["selection"] = selection_artifact
    if not _guarded_write(workspace_root, "specialists.json", _json_text(aggregate)):
        print(
            "ERROR: refused to write specialists.json (workspace escape or "
            "symlink at the aggregate path)",
            file=sys.stderr,
        )
        return 1
    print(
        f"deep review complete: {aggregate['total_leads']} lead(s) across "
        f"{len(entries)} roles in {aggregate['aggregate_elapsed_sec']}s"
    )

    # --- #609: bounded "Specialist Review Leads" corpus section + presence
    # ---   signal, rendered from the per-role version-1 artifacts and capped
    # ---   by SPECIALISTS_SECTION_MAX_BYTES. Fail-soft: any render/write
    # ---   problem here is a stderr note and a continue — never an aggregate
    # ---   change, never an exit-code change (the section is advisory corpus
    # ---   feed, not a verdict input). Both artifacts are written on the
    # ---   enabled path (empty content where there is no section), so a
    # ---   reused workspace can never present a prior run's section/signal
    # ---   as this run's.
    try:
        max_bytes = _env_int("SPECIALISTS_SECTION_MAX_BYTES", 12000)
        role_results = _read_role_artifacts(workspace_root)
        section = render_specialist_leads_section(
            role_results,
            max_bytes=max_bytes,
            # Auto-skipped roles render no block at all — they ran no pass,
            # so a zero-lead note would falsely imply they did (#633).
            skipped_roles=frozenset(skipped_reasons),
        )
        # Fit sanity: a section that cannot fit the corpus budget is dropped
        # rather than allowed to crowd the rest of the corpus into
        # truncation.
        max_corpus = 0
        raw_max_corpus = os.environ.get("MAX_CORPUS", "").strip()
        if raw_max_corpus:
            try:
                value = int(raw_max_corpus)
            except ValueError:
                value = 0
            if value > 0:
                max_corpus = value
        if max_corpus > 0 and len(section.encode("utf-8")) >= max_corpus:
            section = ""
        section_bytes = len(section.encode("utf-8"))
        _guarded_write(workspace_root, "specialists.md", section)
        _guarded_write(
            workspace_root,
            "specialist-leads-present.txt",
            f"{section_bytes}\n" if section else "",
        )
    except Exception:
        print(
            "note: specialist-leads section render/write failed; "
            "continuing without the #609 corpus feed",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
