#!/usr/bin/env python3
"""Deep review: run the three fixed specialist roles concurrently (#608).

The execution layer for the advisory specialist passes defined by the #607
contract module (:mod:`pr_reviewer.specialists`). Invoked from
``scripts/sections/review.sh`` behind the ``DEEP_REVIEW=true`` gate — launched
as a background job before the final reviewer path and reaped fail-soft
*before* that path enters, so later tickets can feed the leads into the
final synthesis; the three roles are concurrent with each other (internal
daemon threads), not with the reviewer.

One model call per role (correctness / security / tests — the closed set in
``SPECIALIST_ROLES_ORDER``) runs **concurrently** on daemon threads, reusing
the resolved primary model settings from the environment and the shared
transport (:func:`pr_reviewer.transport.run_chat_request`) — no second HTTP
client. Each role receives the same bounded review corpus plus its small role
prompt (``load_specialist_prompt``); responses are normalized through
:func:`pr_reviewer.specialists.parse_specialist_response`, so malformed model
output degrades to an ``errors`` entry and never an exception.

Artifacts (all resolved under the workspace root, symlink-refused):
``specialist-<role>.request.json`` / ``specialist-<role>.response.json`` /
``specialist-<role>.json`` (the pure version-1 contract artifact) and the
deterministic aggregate ``specialists.json`` (fixed role order, per-role
status / error_kind / elapsed / lead counts). The #609 corpus feed adds
``specialists.md`` (the bounded "Specialist Review Leads" section rendered
from the per-role version-1 artifacts, capped by
``SPECIALISTS_SECTION_MAX_BYTES``) and ``specialist-leads-present.txt``
(byte count of the section when it is non-empty, else empty — the
lockstep signal the system-prompt fragment gate reads).

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

from pr_reviewer.specialists import (  # noqa: E402
    ARTIFACT_VERSION,
    MAX_INPUT_BYTES,
    SPECIALIST_ROLES_ORDER,
    _empty_artifact,
    _resolve_artifact_path,
    load_specialist_prompt,
    parse_specialist_response,
    render_specialist_leads_section,
)
from pr_reviewer.transport import run_chat_request  # noqa: E402
from redact import mask_secrets  # noqa: E402

#: Total attempts per role (1 initial + 1 retry) on a transport failure.
#: Timeouts and contract (parse) outcomes are never retried.
MAX_ATTEMPTS = 2
#: Base delay between the retry attempts; further clamped to the deadline.
RETRY_DELAY_SEC = 5.0
#: Floor for a per-attempt curl timeout. curl --max-time 0 means *unlimited*,
#: so a nonpositive remaining budget must never reach the transport.
MIN_ATTEMPT_TIMEOUT_SEC = 0.1

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
) -> dict[str, Any]:
    """Run one specialist role end-to-end and return its aggregate entry.

    Never raises: every failure mode (prompt, guard, transport, timeout,
    contract) lands as a fail-soft entry plus guarded artifacts. ``cancel``
    is checked before every artifact write and every attempt so a straggler
    thread never races the main thread's deadline-timeout writes.
    """
    started = time.monotonic()

    def finish(
        artifact: dict[str, Any],
        *,
        status: str,
        error_kind: Optional[str],
    ) -> dict[str, Any]:
        if cancel.is_set():
            return _role_entry(
                role, artifact, status="error",
                error_kind=error_kind or "timeout",
                elapsed_sec=time.monotonic() - started,
            )
        if not _guarded_write(
            workspace_root, f"specialist-{role}.json", _json_text(artifact),
            abort=cancel,
        ):
            if cancel.is_set():
                # The reaper won the race for this write and recorded the
                # timeout; not a guard refusal.
                return _role_entry(
                    role, artifact, status="error", error_kind="timeout",
                    elapsed_sec=time.monotonic() - started,
                )
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
            return _role_entry(
                role, guard_artifact, status="error", error_kind="guard",
                elapsed_sec=time.monotonic() - started,
            )
        return _role_entry(
            role, artifact, status=status, error_kind=error_kind,
            elapsed_sec=time.monotonic() - started,
        )

    try:
        try:
            system = load_specialist_prompt(role)
        except (OSError, ValueError) as exc:
            raise _RoleFailure("input", f"role prompt fragment unavailable: {mask_secrets(str(exc))}")

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
                masked = str(mask_secrets(str(exc)))[:500]
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
                    f"endpoint returned an error body: {mask_secrets(str(response['error']))[:500]}",
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
            return finish(artifact, status=_status_of(artifact), error_kind=None)

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


def _read_corpus(corpus_path: str) -> tuple[Optional[str], Optional[str]]:
    """Read the review corpus. Returns (text, error); a missing, unreadable,
    or over-cap corpus is a soft input error, never an exception."""
    try:
        raw = Path(corpus_path).read_bytes()
    except FileNotFoundError:
        return None, f"corpus not found: {corpus_path}"
    except OSError as exc:
        return None, f"corpus unreadable: {mask_secrets(str(exc))}"
    if len(raw) > MAX_INPUT_BYTES:
        return None, f"corpus exceeds {MAX_INPUT_BYTES} byte input cap"
    return raw.decode("utf-8", errors="replace"), None


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
        default="review-corpus.truncated.md",
        help="Review corpus handed verbatim to every specialist role.",
    )
    parser.add_argument(
        "--workspace-root",
        default="",
        help="Root for all artifact writes (default: $GITHUB_WORKSPACE or cwd).",
    )
    args = parser.parse_args(argv)

    if not _env_bool("DEEP_REVIEW"):
        # Off by default. review.sh already gates the invocation; this guards
        # direct calls so the disabled path is provably call-free and
        # write-free (no artifacts, no aggregate).
        print("deep_review disabled; no specialist passes run")
        return 0

    workspace_root = Path(
        args.workspace_root or os.environ.get("GITHUB_WORKSPACE") or os.getcwd()
    ).resolve()

    base_url = _env_str("AI_BASE_URL")
    api_format = _env_str("AI_API_FORMAT", "openai").strip().lower()
    model = _env_str("AI_MODEL")
    api_key = _env_str("AI_API_KEY")
    max_tokens = _env_int("AI_MAX_TOKENS", 8192)
    temperature = _env_temperature()
    response_format = _env_str("AI_RESPONSE_FORMAT", "off").strip().lower()
    tokens_param = _env_str("AI_TOKENS_PARAM", "max_tokens").strip().lower()
    stream = _env_bool("AI_STREAM", "true")
    role_timeout_sec = _env_int("AI_REQUEST_TIMEOUT_SEC", 300)
    phase_timeout_sec = _env_int("DEEP_REVIEW_TIMEOUT_SEC", 600)

    phase_started = time.monotonic()
    deadline = phase_started + phase_timeout_sec

    entries: list[dict[str, Any]] = []
    corpus, corpus_error = _read_corpus(args.corpus)
    if corpus is None:
        # No corpus means no calls at all: every role is recorded as a soft
        # input failure and the aggregate is still written.
        for role in SPECIALIST_ROLES_ORDER:
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
        cancels = {role: threading.Event() for role in SPECIALIST_ROLES_ORDER}
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
                    f"{mask_secrets(str(exc))[:500]}"
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
            return _run_role(
                role,
                workspace_root=workspace_root,
                user_message=user_message,
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
                request_fn=run_chat_request,
            )

        for role in SPECIALIST_ROLES_ORDER:
            thread = threading.Thread(
                target=worker, args=(role,), name=f"specialist-{role}", daemon=True
            )
            threads[role] = thread
            thread.start()

        # Collect in fixed role order against the ONE aggregate deadline: a
        # straggler past it is cancelled (its thread is a daemon and checks
        # the flag before writing, so it cannot race the timeout record) and
        # never extends the phase.
        for role in SPECIALIST_ROLES_ORDER:
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
    for entry in entries:
        suffix = f" ({entry['error_kind']})" if entry.get("error_kind") else ""
        print(
            f"specialist {entry['role']}: {entry['status']}{suffix} — "
            f"{entry['lead_count']} lead(s), {entry['errors_count']} error(s), "
            f"{entry['elapsed_sec']}s"
        )

    aggregate = {
        "version": ARTIFACT_VERSION,
        "enabled": True,
        "model": f"{model}@{base_url} ({api_format})",
        "aggregate_elapsed_sec": round(aggregate_elapsed, 3),
        "total_leads": sum(entry["lead_count"] for entry in entries),
        "any_errors": any(
            entry["status"] != "ok" or entry["errors_count"] for entry in entries
        ),
        "roles": entries,
    }
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
            role_results, max_bytes=max_bytes
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
