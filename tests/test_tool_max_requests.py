"""Tests for issue #103 and #701: tool_max_requests in the tool harness.

Acceptance criteria:
  - Explicit TOOL_MAX_REQUESTS values are honoured and clamped to 1..20.
  - Invalid/missing values fall back to the tier-aware default (#701):
    primary 8, smart 16, escalated 20.
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
    """Test that the tier-aware resolver keeps the hard bounds (#701)."""

    def setUp(self):
        self.mod = _import_harness()

    def test_resolver_is_used_in_main(self):
        """main() must resolve the budget via the tier-aware resolver."""
        harness_path = _SCRIPTS_DIR / "run_tool_harness.py"
        source = harness_path.read_text(encoding="utf-8")
        # #702: main() uses the provenance-aware resolver (which
        # resolve_tool_max_requests delegates to), so the artifact carries
        # where the ceiling came from.
        self.assertIn("max_requests = resolve_tool_budget(tier)", source)
        # The legacy fixed default must not come back as a single undifferentiated ceiling.
        self.assertNotIn('env_int_bounded("TOOL_MAX_REQUESTS", 4, 1, 20)', source)


class TestTierAwareRequestBudget(TestCase):
    """#701: the effective request budget follows the review route."""

    def setUp(self):
        self.mod = _import_harness()

    def _resolve(self, env, tier="primary"):
        with mock.patch.dict(os.environ, env, clear=True):
            return self.mod.resolve_tool_max_requests(tier)

    def test_primary_default_is_8(self):
        self.assertEqual(self._resolve({}), 8)

    def test_routed_smart_profile_gets_16(self):
        self.assertEqual(self._resolve({"REVIEW_CONTEXT_PROFILE": "smart"}), 16)

    def test_smart_tier_gets_16(self):
        self.assertEqual(self._resolve({}, tier="smart"), 16)

    def test_escalated_tier_gets_20(self):
        self.assertEqual(
            self._resolve({"TOOL_ESCALATION": "true"}, tier="smart"), 20
        )

    def test_explicit_value_overrides_every_tier(self):
        self.assertEqual(self._resolve({"TOOL_MAX_REQUESTS": "5"}), 5)
        self.assertEqual(
            self._resolve({"TOOL_MAX_REQUESTS": "5"}, tier="smart"), 5
        )
        self.assertEqual(
            self._resolve(
                {"TOOL_MAX_REQUESTS": "5", "TOOL_ESCALATION": "true"}, tier="smart"
            ),
            5,
        )

    def test_explicit_value_clamped_to_hard_bounds(self):
        self.assertEqual(self._resolve({"TOOL_MAX_REQUESTS": "99"}), 20)
        self.assertEqual(self._resolve({"TOOL_MAX_REQUESTS": "0"}), 1)
        self.assertEqual(self._resolve({"TOOL_MAX_REQUESTS": "-3"}), 1)

    def test_smart_override_wins_on_smart_tiers(self):
        self.assertEqual(
            self._resolve(
                {"SMART_TOOL_MAX_REQUESTS": "10", "TOOL_MAX_REQUESTS": "3"},
                tier="smart",
            ),
            10,
        )
        self.assertEqual(
            self._resolve(
                {
                    "SMART_TOOL_MAX_REQUESTS": "10",
                    "TOOL_MAX_REQUESTS": "3",
                    "TOOL_ESCALATION": "true",
                },
                tier="smart",
            ),
            10,
        )

    def test_smart_override_ignored_on_primary(self):
        self.assertEqual(
            self._resolve({"SMART_TOOL_MAX_REQUESTS": "10"}), 8
        )

    def test_invalid_explicit_value_falls_back_to_tier_default(self):
        self.assertEqual(self._resolve({"TOOL_MAX_REQUESTS": "abc"}), 8)
        self.assertEqual(
            self._resolve({"TOOL_MAX_REQUESTS": "abc"}, tier="smart"), 16
        )

    def test_route_classification(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(self.mod.tool_budget_route("primary"), "primary")
            self.assertEqual(self.mod.tool_budget_route("smart"), "smart")
        with mock.patch.dict(os.environ, {"TOOL_ESCALATION": "true"}, clear=True):
            self.assertEqual(self.mod.tool_budget_route("smart"), "escalated")
        with mock.patch.dict(
            os.environ, {"REVIEW_CONTEXT_PROFILE": "smart"}, clear=True
        ):
            self.assertEqual(self.mod.tool_budget_route("primary"), "smart")
            # An escalated run is tier=smart regardless of the (primary) profile.
            self.assertEqual(self.mod.tool_budget_route("smart"), "smart")


if __name__ == "__main__":
    unittest_main()
