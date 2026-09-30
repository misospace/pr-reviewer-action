"""#906: release-please finds the last release by its source-vX.Y.Z anchor, so
the manifest version's anchor must be published before release-please runs on
every push. Otherwise a release whose publication failed part-way (consumer
tag pushed, anchor missing) makes the next push regenerate a release PR from
the previous version."""
from __future__ import annotations

from pathlib import Path

import yaml

WORKFLOW = Path(__file__).resolve().parent.parent / ".github" / "workflows" / "release-please.yaml"


def _steps() -> list[dict]:
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))["jobs"]["release-please"]["steps"]


def _index(steps: list[dict], predicate) -> int:
    matches = [i for i, step in enumerate(steps) if predicate(step)]
    assert len(matches) == 1, matches
    return matches[0]


def test_anchor_is_published_before_release_please_runs() -> None:
    steps = _steps()
    checkout = _index(steps, lambda s: str(s.get("uses", "")).startswith("actions/checkout@"))
    anchor = _index(steps, lambda s: "converge.sh anchor" in str(s.get("run", "")))
    release_please = _index(steps, lambda s: str(s.get("uses", "")).startswith("googleapis/release-please-action@"))
    assert checkout < anchor < release_please


def test_anchor_step_targets_the_manifest_version_and_commit() -> None:
    run = next(s["run"] for s in _steps() if "converge.sh anchor" in str(s.get("run", "")))
    assert "jq -r '.\".\"' .release-please-manifest.json" in run
    assert "git log -1 --format=%H -- .release-please-manifest.json" in run
    assert 'converge.sh anchor "v$VERSION" "$SHA"' in run


def test_checkout_can_push_the_anchor() -> None:
    steps = _steps()
    checkout = steps[_index(steps, lambda s: str(s.get("uses", "")).startswith("actions/checkout@"))]
    assert checkout["with"].get("token") == "${{ steps.app-token.outputs.token }}"
    assert checkout["with"].get("persist-credentials", True) is not False
    assert checkout["with"].get("fetch-depth") == 0


def test_release_please_tracks_the_source_component() -> None:
    import json

    config = json.loads((WORKFLOW.parent.parent.parent / "release-please-config.json").read_text(encoding="utf-8"))
    package = config["packages"]["."]
    assert package["component"] == "source"
    assert package["include-component-in-tag"] is True
    assert package["include-v-in-tag"] is True
