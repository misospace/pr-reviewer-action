from __future__ import annotations

import hashlib
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from pr_reviewer.http_safe import (  # noqa: E402
    ConflictingCredentialChannels,
    redact_url_userinfo,
    resolve_credential_channel,
    UnsafeEndpointUrl,
)

LANE_PLAN_VERSION = 1
SUPPORTED_KINDS = ("primary_only", "same_model_specialists", "heterogeneous_specialists")
SUPPORTED_API_FORMATS = ("openai", "anthropic")
SPECIALIST_ROLES = ("correctness", "security", "tests")
SPECIALIST_ENV_KEYS = (
    "AI_SPECIALIST_MODEL", "AI_SPECIALIST_BASE_URL", "AI_SPECIALIST_API_FORMAT",
    "AI_SPECIALIST_API_KEY", "AI_SPECIALIST_CORRECTNESS_MODEL",
    "AI_SPECIALIST_SECURITY_MODEL", "AI_SPECIALIST_TESTS_MODEL",
)
LANE_ID_PATTERN = re.compile(r"[A-Za-z0-9_.-]+")
# Report-facing URL fields of the lane projection. An operator endpoint can
# carry a credential in its userinfo, and the projection is recorded in shared
# eval reports (#1417), so every URL in it is redacted before it is written.
LANE_URL_FIELDS = frozenset({"base_url", "url", "endpoint"})


class LaneConfigError(ValueError):
    """Invalid or unresolvable operator lane configuration."""


@dataclass(frozen=True)
class Profile:
    name: str
    model: str
    base_url: str
    api_format: str
    api_key_env: str


@dataclass(frozen=True)
class Lane:
    id: str
    kind: str
    primary_profile: str
    specialist_profile: str | None
    role_models: Mapping[str, str]


@dataclass(frozen=True)
class LanePlan:
    version: int
    profiles: Mapping[str, Profile]
    lanes: tuple[Lane, ...]
    source_digest: str


@dataclass(frozen=True)
class ResolvedLane:
    id: str
    kind: str
    model: str
    # #1417: the credential-free request target. The endpoint's identity
    # (scheme, host, port, path) is unchanged; only the userinfo moved to
    # the credential channel, so no credential rides in a request URL.
    base_url: str
    api_format: str
    # The credential the request carries in its provider auth header.
    api_key: str = field(repr=False)
    deep_review: bool
    specialist_env: Mapping[str, str] = field(repr=False)
    public: Mapping[str, Any]


def _object(value: Any, where: str, allowed: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise LaneConfigError(f"{where} must be an object")
    unknown = set(value) - allowed
    if unknown:
        raise LaneConfigError(f"unknown key(s) in {where}: {', '.join(sorted(unknown))}")
    return value


def _nonempty(value: Any, where: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise LaneConfigError(f"{where} must be a nonempty string")
    return value


def load_lane_plan(path: Path) -> LanePlan:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise LaneConfigError(f"could not read lane plan {path}: {exc}") from exc
    data = _object(data, "top level", {"version", "profiles", "lanes"})
    version = data.get("version")
    if type(version) is not int or version != LANE_PLAN_VERSION:
        raise LaneConfigError(f"version must be exactly {LANE_PLAN_VERSION}")
    raw_profiles = data.get("profiles")
    if not isinstance(raw_profiles, dict) or not raw_profiles:
        raise LaneConfigError("profiles must be a nonempty object")
    profiles: dict[str, Profile] = {}
    for name, raw in raw_profiles.items():
        if not isinstance(name, str) or not name.strip():
            raise LaneConfigError("profile names must be nonempty strings")
        raw = _object(raw, f"profile {name}", {"model", "base_url", "api_format", "api_key_env"})
        model = _nonempty(raw.get("model"), f"profile {name} model")
        base_url = raw.get("base_url", "")
        if not isinstance(base_url, str):
            raise LaneConfigError(f"profile {name} base_url must be a string")
        api_format = raw.get("api_format", "openai")
        if api_format not in SUPPORTED_API_FORMATS:
            raise LaneConfigError(f"profile {name} api_format must be openai or anthropic")
        api_key_env = _nonempty(raw.get("api_key_env", "AI_API_KEY"), f"profile {name} api_key_env")
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", api_key_env):
            raise LaneConfigError(f"profile {name} api_key_env must be an environment-variable name")
        profiles[name] = Profile(name, model, base_url, api_format, api_key_env)
    raw_lanes = data.get("lanes")
    if not isinstance(raw_lanes, list) or not raw_lanes:
        raise LaneConfigError("lanes must be a nonempty array")
    lanes: list[Lane] = []
    ids: set[str] = set()
    for index, raw in enumerate(raw_lanes):
        if not isinstance(raw, dict):
            raise LaneConfigError(f"lane {index} must be an object")
        lane_id = _nonempty(raw.get("id"), f"lane {index} id")
        if not LANE_ID_PATTERN.fullmatch(lane_id):
            raise LaneConfigError(f"lane {index} id must match {LANE_ID_PATTERN.pattern}")
        kind = raw.get("kind")
        allowed = {"id", "kind", "primary_profile", "role_models"}
        if kind == "heterogeneous_specialists":
            allowed.add("specialist_profile")
        raw = _object(raw, f"lane {lane_id}", allowed)
        if lane_id in ids:
            raise LaneConfigError(f"duplicate lane id: {lane_id}")
        ids.add(lane_id)
        if kind not in SUPPORTED_KINDS:
            raise LaneConfigError(f"lane {lane_id} kind is unsupported")
        primary = _nonempty(raw.get("primary_profile"), f"lane {lane_id} primary_profile")
        if primary not in profiles:
            raise LaneConfigError(f"lane {lane_id} references missing primary profile {primary}")
        specialist = None
        if kind == "heterogeneous_specialists":
            specialist = _nonempty(raw.get("specialist_profile"), f"lane {lane_id} specialist_profile")
            if specialist not in profiles:
                raise LaneConfigError(f"lane {lane_id} references missing specialist profile {specialist}")
        role_models = raw.get("role_models", {})
        if not isinstance(role_models, dict):
            raise LaneConfigError(f"lane {lane_id} role_models must be an object")
        if kind != "heterogeneous_specialists" and "role_models" in raw:
            raise LaneConfigError(f"lane {lane_id} role_models is only valid for heterogeneous_specialists")
        for role, model in role_models.items():
            if role not in SPECIALIST_ROLES:
                raise LaneConfigError(f"lane {lane_id} has unsupported role_models role {role}")
            _nonempty(model, f"lane {lane_id} role_models.{role}")
        lanes.append(Lane(lane_id, kind, primary, specialist, dict(role_models)))
    canonical = json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    digest = "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return LanePlan(version, profiles, tuple(lanes), digest)


def select_lane(plan: LanePlan, lane_id: str | None) -> Lane:
    if lane_id is None:
        if len(plan.lanes) == 1:
            return plan.lanes[0]
        raise LaneConfigError("multiple lanes are defined; specify --lane")
    for lane in plan.lanes:
        if lane.id == lane_id:
            return lane
    raise LaneConfigError(f"unknown lane id: {lane_id}")


def _profile_public(profile: Profile, name: str) -> dict[str, str]:
    # #1417: the public projection is display/report state, so the profile's
    # base URL is recorded with any userinfo redacted. The run itself uses
    # the credential-free endpoint (ResolvedLane.base_url) and carries the
    # credential in the auth-header channel.
    return {
        "profile": name,
        "model": profile.model,
        "base_url": redact_url_userinfo(profile.base_url),
        "api_format": profile.api_format,
    }


def _resolve_profile_endpoint(
    profile: Profile, environ: Mapping[str, str]
) -> tuple[str, str]:
    """Return the profile's credential-free request target and its credential.

    #1417: a profile base URL may carry a credential in its userinfo. The
    credential never rides in the request URL — it is resolved into the
    credential channel, which the transport sends as the provider's HTTP
    authentication header — and the request target keeps the endpoint's
    identity, so the run still contacts the intended endpoint.

    The profile's credential environment variable stays the declared
    credential channel; a URL credential is used only when that variable
    carries nothing, because one request carries one credential.
    """
    env_credential = environ.get(profile.api_key_env) or ""
    try:
        target, credential = resolve_credential_channel(profile.base_url, env_credential)
    except UnsafeEndpointUrl as exc:
        raise LaneConfigError(
            f"profile {profile.name} base_url is not a usable endpoint: {exc}"
        ) from None
    except ConflictingCredentialChannels:
        raise LaneConfigError(
            f"profile {profile.name} base_url carries a credential and "
            f"{profile.api_key_env} carries one too; one request carries one "
            "credential, so remove one of them"
        ) from None
    if not credential:
        raise LaneConfigError(
            f"missing required credential environment variable {profile.api_key_env}"
        )
    return target, credential


def lane_report_projection(public: Mapping[str, Any]) -> dict[str, Any]:
    """Return the report-facing lane projection with every URL's userinfo
    redacted (#1417).

    The harness records this mapping in the eval report, and a report is a
    shared artifact: an operator endpoint can carry a credential in its
    userinfo (``https://user:pass@host``). Redaction happens here, at the
    report boundary, so no URL reaches the written report even if the
    projection gains a new URL field later.
    """
    def _redact(value: Any, key: str | None) -> Any:
        if isinstance(value, Mapping):
            return {k: _redact(v, k) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [_redact(item, key) for item in value]
        if isinstance(value, str) and key in LANE_URL_FIELDS:
            return redact_url_userinfo(value)
        return value

    return _redact(public, None)


def resolve_lane(plan: LanePlan, lane: Lane, environ: Mapping[str, str]) -> ResolvedLane:
    primary = plan.profiles[lane.primary_profile]
    base_url, api_key = _resolve_profile_endpoint(primary, environ)
    deep_review = lane.kind != "primary_only"
    specialist_env: dict[str, str] = {}
    public: dict[str, Any] = {
        "id": lane.id, "kind": lane.kind,
        "primary": _profile_public(primary, lane.primary_profile),
        "source_digest": plan.source_digest,
    }
    if lane.kind == "heterogeneous_specialists":
        specialist = plan.profiles[lane.specialist_profile]
        specialist_base_url, specialist_key = _resolve_profile_endpoint(specialist, environ)
        specialist_env = {
            "AI_SPECIALIST_MODEL": specialist.model,
            "AI_SPECIALIST_BASE_URL": specialist_base_url,
            "AI_SPECIALIST_API_FORMAT": specialist.api_format,
            "AI_SPECIALIST_API_KEY": specialist_key,
        }
        specialist_env.update({f"AI_SPECIALIST_{role.upper()}_MODEL": model for role, model in lane.role_models.items()})
        public["specialist"] = _profile_public(specialist, lane.specialist_profile)
        public["role_models"] = dict(lane.role_models)
    return ResolvedLane(lane.id, lane.kind, primary.model, base_url, primary.api_format, api_key, deep_review, specialist_env, public)


def lane_plan_public_summary(plan: LanePlan) -> list[dict[str, Any]]:
    summaries = []
    for lane in plan.lanes:
        primary = plan.profiles[lane.primary_profile]
        entry: dict[str, Any] = {
            "id": lane.id, "kind": lane.kind,
            "primary": _profile_public(primary, lane.primary_profile),
            "source_digest": plan.source_digest,
        }
        if lane.kind == "heterogeneous_specialists":
            entry["specialist"] = _profile_public(plan.profiles[lane.specialist_profile], lane.specialist_profile)
            entry["role_models"] = dict(lane.role_models)
        summaries.append(entry)
    return summaries


def format_lane(plan: LanePlan, lane: Lane) -> str:
    return json.dumps(next(item for item in lane_plan_public_summary(plan) if item["id"] == lane.id), indent=2, sort_keys=True)
