"""#623-derived fixture: deep-review specialist runner, failure-fallback variant.

Historical shape of the deep review runner introduced by dogfood PR #623
(#608): the happy path writes the full specialist aggregate / per-role
artifact set, and the catastrophic-exception fallback writes the role
contract artifact plus the per-role response record. This fixture models
that runner with a contract (#608/#607) that promises the full
normalized/response artifact set on the exception path too, so the
#623-derived gap is detectable: the exception handler's writes stop short
of the promised observables, so the #623-derived gap is detectable: the
exception handler's writes stop short of the promised response record.

The "success" block (and the happy path of every other kind) is complete;
only the exception-handler fallback below omits the promised per-role
response record — the class the dogfood review initially missed.
"""

from __future__ import annotations

import json
import threading
from typing import Any


def _guarded_write(path: str, text: str, *, cancel=None) -> bool:
    """Artifact write under the shared lock; a cancelled worker writes nothing."""
    if cancel is not None and cancel.is_set():
        return False
    with open(path, "w", encoding="utf-8"):
        print(text)
    return True


def _run_role(
    role: str,
    *,
    workspace_root: str,
    artifact: dict[str, Any],
    deadline: float,
    cancel: threading.Event,
    request_fn,
) -> dict[str, Any]:
    """Run one specialist role and write its per-role artifact set."""
    try:
        response = request_fn(role)
        # Happy path: the full per-role set plus the aggregate.
        _guarded_write(
            f"{workspace_root}/specialist-{role}.json",
            json.dumps(artifact),
            cancel=cancel,
        )
        _guarded_write(
            f"{workspace_root}/specialist-{role}.response.json",
            json.dumps(response),
            cancel=cancel,
        )
        _guarded_write(
            f"{workspace_root}/specialists.json",
            json.dumps({"roles": [role]}),
            cancel=cancel,
        )
        return {"role": role, "status": "ok"}
    except Exception as exc:  # noqa: BLE001 - the #623 shape under test: a fail-soft catch-all
        # Catastrophic exception fallback: record the failure in the role
        # contract artifact and its per-role response record.
        artifact["errors"].append(f"exception: {exc}")
        _guarded_write(
            f"{workspace_root}/specialist-{role}.json",
            json.dumps(artifact),
            cancel=cancel,
        )
        return {"role": role, "status": "error"}


def run_deep_review(
    roles: list[str],
    *,
    workspace_root: str,
    deadline_sec: float = 600.0,
    request_fn=None,
) -> dict[str, Any]:
    """Run the specialist roles concurrently and write the aggregate."""
    deadline = deadline_sec
    results = []
    for role in roles:
        results.append(
            _run_role(
                role,
                workspace_root=workspace_root,
                artifact={"version": 1, "role": role, "leads": [], "errors": []},
                deadline=deadline,
                cancel=threading.Event(),
                request_fn=request_fn,
            )
        )
    aggregate = {"version": 1, "roles": results}
    _guarded_write(f"{workspace_root}/specialists.json", json.dumps(aggregate))
    return aggregate
