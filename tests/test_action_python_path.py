from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def test_runtime_scripts_export_action_root_pythonpath() -> None:
    for script_name in ("run_review.sh", "check_review_needed.sh"):
        script = (ROOT / "scripts" / script_name).read_text(encoding="utf-8")
        assert 'export PYTHONPATH="${SCRIPT_DIR}/..${PYTHONPATH:+:${PYTHONPATH}}"' in script
