"""Tests for issue #103: respect tool_max_requests in tool harness planner and executor.

Acceptance criteria:
  - TOOL_MAX_REQUESTS=1 limits planner prompt and executor to 1 call.
  - TOOL_MAX_REQUESTS=6 allows up to 6 calls.
  - Invalid/missing values safely fall back to default (4).
  - Values are bounded within a reasonable range (1-20 per env_int_bounded).
"""

import os
import sys
from pathlib import Path
from unittest import TestCase, main as unittest_main
from unittest import mock

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"


def _import_harness():
    """Import run_tool_harness module ensuring scripts is on sys.path."""
    if str(_SCRIPTS_DIR) not in sys.path:
        sys.path.insert(0, str(_SCRIPTS_DIR))
    import run_tool_harness  # noqa: F401
    return run_tool_harness


class TestEnvIntBounded(TestCase):
    """Test the env_int_bounded helper used to parse TOOL_MAX_REQUESTS."""

    def setUp(self):
        self.mod = _import_harness()

    def test_default_value_when_unset(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            # Remove TOOL_MAX_REQUESTS if present
            os.environ.pop("TOOL_MAX_REQUESTS", None)
            result = self.mod.env_int_bounded("TOOL_MAX_REQUESTS", 4, 1, 20)
            self.assertEqual(result, 4)

    def test_custom_value_within_bounds(self):
        with mock.patch.dict(os.environ, {"TOOL_MAX_REQUESTS": "6"}):
            result = self.mod.env_int_bounded("TOOL_MAX_REQUESTS", 4, 1, 20)
            self.assertEqual(result, 6)

    def test_value_one(self):
        with mock.patch.dict(os.environ, {"TOOL_MAX_REQUESTS": "1"}):
            result = self.mod.env_int_bounded("TOOL_MAX_REQUESTS", 4, 1, 20)
            self.assertEqual(result, 1)

    def test_invalid_value_falls_back_to_default(self):
        with mock.patch.dict(os.environ, {"TOOL_MAX_REQUESTS": "not_a_number"}):
            result = self.mod.env_int_bounded("TOOL_MAX_REQUESTS", 4, 1, 20)
            self.assertEqual(result, 4)

    def test_zero_clamped_to_min(self):
        with mock.patch.dict(os.environ, {"TOOL_MAX_REQUESTS": "0"}):
            result = self.mod.env_int_bounded("TOOL_MAX_REQUESTS", 4, 1, 20)
            # 0 is below min_value=1, so clamped to 1
            self.assertEqual(result, 1)

    def test_negative_clamped_to_min(self):
        with mock.patch.dict(os.environ, {"TOOL_MAX_REQUESTS": "-5"}):
            result = self.mod.env_int_bounded("TOOL_MAX_REQUESTS", 4, 1, 20)
            # -5 is below min_value=1, so clamped to 1 (not default)
            self.assertEqual(result, 1)

    def test_upper_bound_capped(self):
        with mock.patch.dict(os.environ, {"TOOL_MAX_REQUESTS": "99"}):
            result = self.mod.env_int_bounded("TOOL_MAX_REQUESTS", 4, 1, 20)
            self.assertEqual(result, 20)

    def test_empty_string_falls_back_to_default(self):
        with mock.patch.dict(os.environ, {"TOOL_MAX_REQUESTS": ""}):
            result = self.mod.env_int_bounded("TOOL_MAX_REQUESTS", 4, 1, 20)
            self.assertEqual(result, 4)


# NOTE: the plan_execute planner was removed in 2.0 (#304), so the former
# TestMaxRequestsInPlanningPrompt / TestMaxRequestsSlicing classes — which
# asserted the planner prompt's "Max requests: {max_requests}" string and the
# planner/file-based [:budget] / [:max_requests] slicing — were dropped along
# with that code. native_loop passes max_requests to the loop driver
# programmatically; the budget cap is exercised in test_run_native_loop_wiring.py.


class TestMaxRequestsBoundedCall(TestCase):
    """Test that max_requests is read with proper bounds."""

    def setUp(self):
        self.mod = _import_harness()

    def test_bounded_call_signature(self):
        """Verify env_int_bounded is called with correct bounds for TOOL_MAX_REQUESTS."""
        harness_path = _SCRIPTS_DIR / "run_tool_harness.py"
        source = harness_path.read_text(encoding="utf-8")

        # Should call env_int_bounded with TOOL_MAX_REQUESTS, default 4, min 1, max 20
        self.assertIn(
            'env_int_bounded("TOOL_MAX_REQUESTS", 4, 1, 20)', source
        )


if __name__ == "__main__":
    unittest_main()
