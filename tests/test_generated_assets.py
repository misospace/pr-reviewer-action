"""The generated-asset directory must survive a generator run (#1456).

`.v3-generated/` holds one source asset per generator. The node suite runs
`scripts/generate-v3-contract.mjs` in the repository root, and the Python suite
compiles against `.v3-generated/action-source.generated.ts` right after. A
whole-directory wipe in the contract generator deleted that asset, and the next
Python suite run failed with `Cannot find module
'../.v3-generated/action-source.generated.js'`.

The rule the repository keeps now: a generator overwrites the asset it owns and
never deletes a source asset it does not own; the build entry point owns the
directory and clears it before generating, so no stale shadow and no stale
asset of a generator that stopped running can reach a bundle.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import pytest  # noqa: E402

_GENERATED_DIR = _REPO_ROOT / ".v3-generated"
_ACTION_SOURCE_ASSET = _GENERATED_DIR / "action-source.generated.ts"
_CLEAN_SCRIPT = _REPO_ROOT / "scripts/clean-generated-assets.mjs"
_CONTRACT_GENERATOR = _REPO_ROOT / "scripts/generate-v3-contract.mjs"
_ACTION_SOURCE_GENERATOR = _REPO_ROOT / "scripts/generate-action-source.mjs"
_TIMEOUT_SECONDS = 180


def _node() -> str:
    node = os.environ.get("PR_REVIEWER_NODE") or shutil.which("node")
    if node is None:
        pytest.skip("node is required to run the repository generators")
    return node


def _require_dependencies() -> None:
    """The generators load `yaml` and `esbuild` from node_modules."""
    for package in ("yaml", "esbuild"):
        if not (_REPO_ROOT / "node_modules" / package).is_dir():
            pytest.skip(f"node_modules/{package} is required to run the generators")


def _run(node: str, script: Path, cwd: Path) -> None:
    completed = subprocess.run(
        [node, str(script)],
        cwd=cwd,
        # The stamp decides the version asset; an ambient stamp would make
        # this guard depend on the caller's environment.
        env={**os.environ, "PR_REVIEWER_BUILD_STAMP": ""},
        capture_output=True,
        text=True,
        timeout=_TIMEOUT_SECONDS,
        check=False,
    )
    assert completed.returncode == 0, (completed.stdout + completed.stderr)[-2000:]


def test_contract_generator_keeps_the_action_source_asset() -> None:
    """The asset the Python suite compiles against survives the run."""
    node = _node()
    _require_dependencies()
    if not _ACTION_SOURCE_ASSET.exists():
        # The asset is a build product; a checkout without a build has none
        # to preserve. Build it so the guard is never vacuous.
        _run(node, _ACTION_SOURCE_GENERATOR, _REPO_ROOT)
    assert _ACTION_SOURCE_ASSET.exists(), "the action-source generator wrote no asset"
    before = _ACTION_SOURCE_ASSET.read_bytes()

    _run(node, _CONTRACT_GENERATOR, _REPO_ROOT)

    assert _ACTION_SOURCE_ASSET.exists(), (
        "#1456: the contract generator deleted the action-source asset; the next "
        "Python suite run fails with \"Cannot find module "
        "'../.v3-generated/action-source.generated.js'\""
    )
    assert _ACTION_SOURCE_ASSET.read_bytes() == before, (
        "#1456: the contract generator rewrote the action-source asset it does not own"
    )


def test_clean_step_empties_the_generated_directory(tmp_path: Path) -> None:
    """The clear step the build runs removes the whole directory."""
    node = _node()
    generated = tmp_path / ".v3-generated"
    generated.mkdir()
    (generated / "stale.generated.ts").write_text("// stale source asset.\n", encoding="utf-8")
    (generated / "stale.generated.js").write_text("// stale compiled shadow.\n", encoding="utf-8")

    _run(node, _CLEAN_SCRIPT, tmp_path)

    assert not generated.exists(), "the clear step must remove the generated directory"


def test_build_scripts_clear_the_directory_and_run_every_generator() -> None:
    """The build owns the directory, and every generator runs in it."""
    scripts = json.loads((_REPO_ROOT / "package.json").read_text(encoding="utf-8"))["scripts"]
    # A generator that writes into the generated directory owns an asset the
    # clear step deletes, so it has to run in both build scripts. The other
    # generator scripts write elsewhere (action.yml) and are drift-checked
    # on their own.
    generators = sorted(
        path.name
        for path in (_REPO_ROOT / "scripts").glob("generate-*.mjs")
        if ".v3-generated" in path.read_text(encoding="utf-8")
    )
    assert generators, "the repository has no generator for the generated directory"
    for name in ("build", "typecheck"):
        command = scripts[name]
        clear_at = command.find(_CLEAN_SCRIPT.name)
        assert clear_at != -1, f"{name} must clear .v3-generated before generating"
        for generator in generators:
            at = command.find(generator)
            assert at != -1, (
                f"{name} must run {generator}: the clear step deletes the asset a "
                "generator that is left out owns, and the build then fails with "
                "'Could not resolve'"
            )
            assert at > clear_at, f"{name} must generate after clearing the directory"
