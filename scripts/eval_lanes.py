from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

LANE_PLAN_VERSION = 1
SUPPORTED_KINDS = ("primary_only", "same_model_specialists", "heterogeneous_specialists")
SUPPORTED_API_FORMATS = ("openai", "anthropic")
SPECIALIST_ROLES = ("correctness", "security", "tests")
SPECIALIST_ENV_KEYS = (
    "AI_SPECIALIST_MODEL", "AI_SPECIALIST_BASE_URL", "AI_SPECIALIST_API_FORMAT",
    "AI_SPECIALIST_API_KEY", "AI_SPECIALIST_CORRECTNESS_MODEL",
    "AI_SPECIALIST_SECURITY_MODEL", "AI_SPECIALIST_TESTS_MODEL",
)


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
    base_url: str
    api_format: str
    api_key: str
    deep_review: bool
    specialist_env: Mapping[str, str]
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
    return {"profile": name, "model": profile.model, "base_url": profile.base_url, "api_format": profile.api_format}


def resolve_lane(plan: LanePlan, lane: Lane, environ: Mapping[str, str]) -> ResolvedLane:
    primary = plan.profiles[lane.primary_profile]
    api_key = environ.get(primary.api_key_env)
    if not api_key:
        raise LaneConfigError(f"missing required credential environment variable {primary.api_key_env}")
    deep_review = lane.kind != "primary_only"
    specialist_env: dict[str, str] = {}
    public: dict[str, Any] = {
        "id": lane.id, "kind": lane.kind,
        "primary": _profile_public(primary, lane.primary_profile),
        "source_digest": plan.source_digest,
    }
    if lane.kind == "heterogeneous_specialists":
        specialist = plan.profiles[lane.specialist_profile]
        specialist_key = environ.get(specialist.api_key_env)
        if not specialist_key:
            raise LaneConfigError(f"missing required credential environment variable {specialist.api_key_env}")
        specialist_env = {
            "AI_SPECIALIST_MODEL": specialist.model,
            "AI_SPECIALIST_BASE_URL": specialist.base_url,
            "AI_SPECIALIST_API_FORMAT": specialist.api_format,
            "AI_SPECIALIST_API_KEY": specialist_key,
        }
        specialist_env.update({f"AI_SPECIALIST_{role.upper()}_MODEL": model for role, model in lane.role_models.items()})
        public["specialist"] = _profile_public(specialist, lane.specialist_profile)
        public["role_models"] = dict(lane.role_models)
    return ResolvedLane(lane.id, lane.kind, primary.model, primary.base_url, primary.api_format, api_key, deep_review, specialist_env, public)


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
