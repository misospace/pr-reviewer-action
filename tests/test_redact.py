#!/usr/bin/env python3
"""Tests for scripts/redact.py — shared secret-redaction helpers."""

import sys
from pathlib import Path

# Ensure the scripts directory is on sys.path before any imports.
_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from redact import mask_secrets, mask_and_truncate  # noqa: E402

import pytest


# ---------------------------------------------------------------------------
# mask_secrets
# ---------------------------------------------------------------------------


class TestMaskSecrets:
    """Verify that common credential formats are redacted."""

    def test_ghp_token(self):
        text = "token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"
        assert "[REDACTED]" in mask_secrets(text)
        assert "ghp_" not in mask_secrets(text)

    def test_github_pat(self):
        text = "GITHUB_TOKEN=github_pat_11AAAAAAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        result = mask_secrets(text)
        assert "[REDACTED]" in result
        assert "github_pat_" not in result

    def test_bearer_token(self):
        text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
        result = mask_secrets(text)
        assert "[REDACTED]" in result

    def test_basic_auth(self):
        text = "Authorization: Basic dXNlcm5hbWU6cGFzc3dvcmQxMjM0NTY3ODkw"
        result = mask_secrets(text)
        assert "[REDACTED]" in result

    def test_api_key_equals(self):
        text = "api_key=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890ABCDEF"
        result = mask_secrets(text)
        assert "[REDACTED]" in result

    def test_token_colon(self):
        text = "token: my_super_secret_token_value_that_is_long_enough"
        result = mask_secrets(text)
        assert "[REDACTED]" in result

    def test_password_equals_quoted(self):
        text = 'password="super_secret_password_12345"'
        result = mask_secrets(text)
        assert "[REDACTED]" in result

    def test_secret_equals(self):
        text = "secret: another_secret_value_with_enough_chars"
        result = mask_secrets(text)
        assert "[REDACTED]" in result

    def test_aws_access_key(self):
        text = "AKIAIOSFODNN7EXAMPLE"
        result = mask_secrets(text)
        assert "[REDACTED]" in result

    def test_no_false_positives_safe_text(self):
        """Ensure normal prose is not altered."""
        safe = "The quick brown fox jumps over the lazy dog."
        assert mask_secrets(safe) == safe

    def test_short_values_not_redacted(self):
        """Short values (< 8 chars after :=) should not be redacted."""
        text = "api_key=short"
        result = mask_secrets(text)
        # "short" is < 8 chars so the pattern shouldn't match
        assert "short" in result

    def test_none_input(self):
        assert mask_secrets(None) == ""

    def test_empty_string(self):
        assert mask_secrets("") == ""

    def test_multiple_secrets(self):
        text = (
            "api_key=sk-abc123def456ghij7890 and token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"
        )
        result = mask_secrets(text)
        assert result.count("[REDACTED]") == 2

    def test_kubeconfig_snippet(self):
        text = "server: https://10.0.0.1\nusername: admin\npassword: kube_secret_pass"
        result = mask_secrets(text)
        # password line should be redacted
        assert "[REDACTED]" in result
        # ...but ordinary server/username YAML lines are not secrets and must
        # survive so evidence output stays readable.
        assert "server: https://10.0.0.1" in result
        assert "username: admin" in result

    def test_kubeconfig_certificate_data_redacted(self):
        text = "client-key-data: LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0tLQ=="
        result = mask_secrets(text)
        assert "LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0tLQ" not in result


# ---------------------------------------------------------------------------
# mask_and_truncate
# ---------------------------------------------------------------------------


class TestMaskAndTruncate:
    """Verify that masking + truncation works correctly."""

    def test_no_truncation_needed(self):
        text = "hello world"
        result, truncated = mask_and_truncate(text, 100)
        assert result == "hello world"
        assert truncated is False

    def test_truncation_applied(self):
        long_text = "A" * 200
        result, truncated = mask_and_truncate(long_text, 50)
        assert truncated is True
        assert "[truncated]" in result
        # Byte length of result should be <= limit + overhead
        assert len(result.encode("utf-8", errors="replace")) <= 65

    def test_masking_before_truncation(self):
        """Masking happens first so the truncated output is already redacted."""
        text = "api_key=abcdefghijklmnopqrstuvwxyz1234"
        result, _ = mask_and_truncate(text, 20)
        assert "[REDACTED]" in result

    def test_none_input(self):
        result, truncated = mask_and_truncate(None, 100)
        assert result == ""
        assert truncated is False


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
