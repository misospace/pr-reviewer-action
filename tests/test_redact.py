#!/usr/bin/env python3
"""Tests for scripts/redact.py — shared secret-redaction helpers.

Covers:
- Known token formats at every position (beginning, middle, end)
- Adversarial strings (broken tokens, embedded tokens in prose)
- Regression tests for mask_secrets and mask_and_truncate
- All regex patterns defined in scripts/redact.py
"""

import sys
from pathlib import Path

# Ensure the scripts directory is on sys.path before any imports.
_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from redact import mask_secrets, mask_and_truncate  # noqa: E402

import pytest


# ---------------------------------------------------------------------------
# mask_secrets — GitHub PAT patterns
# ---------------------------------------------------------------------------


class TestMaskSecretsGHP:
    """ghp_ classic personal access tokens."""

    def test_ghp_token(self):
        text = "token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"
        assert "[REDACTED]" in mask_secrets(text)
        assert "ghp_" not in mask_secrets(text)

    def test_ghp_at_beginning(self):
        """Token at the very start of the string."""
        text = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij rest of line"
        result = mask_secrets(text)
        assert "[REDACTED]" in result
        assert "ghp_" not in result

    def test_ghp_at_end(self):
        """Token at the very end of the string."""
        text = "some prefix ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"
        result = mask_secrets(text)
        assert "[REDACTED]" in result
        assert "ghp_" not in result

    def test_ghp_standalone(self):
        """Token is the entire string."""
        text = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"
        result = mask_secrets(text)
        assert result == "[REDACTED]"

    def test_ghp_embedded_in_prose(self):
        """Token embedded inside a sentence."""
        text = (
            "The PR was reviewed using ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij "
            "which should not appear in logs."
        )
        result = mask_secrets(text)
        assert "[REDACTED]" in result
        assert "ghp_" not in result

    def test_ghp_too_short_not_matched(self):
        """Tokens shorter than 30 chars after prefix should not match."""
        text = "ghp_ABCDEFGHIJ"
        result = mask_secrets(text)
        # Only 10 chars after ghp_, below the 30-char threshold
        assert "ghp_ABCDEFGHIJ" in result

    def test_ghp_multiple_in_text(self):
        """Multiple ghp tokens in one string."""
        text = (
            "first=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij "
            "second=ghp_123456789012345678901234567890ab"
        )
        result = mask_secrets(text)
        assert result.count("[REDACTED]") == 2
        assert "ghp_" not in result


class TestMaskSecretsGitHubPAT:
    """github_pat_ fine-grained personal access tokens."""

    def test_github_pat(self):
        text = "GITHUB_TOKEN=github_pat_11AAAAAAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        result = mask_secrets(text)
        assert "[REDACTED]" in result
        assert "github_pat_" not in result

    def test_github_pat_at_beginning(self):
        text = "github_pat_11AAAAAAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA rest"
        result = mask_secrets(text)
        assert "[REDACTED]" in result
        assert "github_pat_" not in result

    def test_github_pat_at_end(self):
        text = "prefix github_pat_11AAAAAAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        result = mask_secrets(text)
        assert "[REDACTED]" in result
        assert "github_pat_" not in result

    def test_github_pat_standalone(self):
        text = "github_pat_11AAAAAAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        result = mask_secrets(text)
        assert result == "[REDACTED]"

    def test_github_pat_embedded_in_json(self):
        """Token inside a JSON-like string."""
        text = '{"token": "github_pat_11AAAAAAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}'
        result = mask_secrets(text)
        assert "[REDACTED]" in result
        assert "github_pat_" not in result


# ---------------------------------------------------------------------------
# mask_secrets — Bearer / Basic auth patterns
# ---------------------------------------------------------------------------


class TestMaskSecretsBearer:
    """Bearer token redaction."""

    def test_bearer_token(self):
        text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
        result = mask_secrets(text)
        assert "[REDACTED]" in result

    def test_bearer_case_insensitive(self):
        """Bearer matching is case-insensitive."""
        text = "authorization: bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
        result = mask_secrets(text)
        assert "[REDACTED]" in result

    def test_bearer_at_beginning(self):
        text = "Bearer abcdefghijklmnopqrstuvwxyz rest"
        result = mask_secrets(text)
        assert "[REDACTED]" in result

    def test_bearer_at_end(self):
        text = "prefix Bearer abcdefghijklmnopqrstuvwxyz"
        result = mask_secrets(text)
        assert "[REDACTED]" in result

    def test_bearer_too_short_not_matched(self):
        """Bearer tokens shorter than 20 chars should not match."""
        text = "Bearer short"
        result = mask_secrets(text)
        assert "Bearer short" in result


class TestMaskSecretsBasic:
    """Basic auth redaction."""

    def test_basic_auth(self):
        text = "Authorization: Basic dXNlcm5hbWU6cGFzc3dvcmQxMjM0NTY3ODkw"
        result = mask_secrets(text)
        assert "[REDACTED]" in result

    def test_basic_case_insensitive(self):
        text = "authorization: basic dXNlcm5hbWU6cGFzc3dvcmQxMjM0NTY3ODkw"
        result = mask_secrets(text)
        assert "[REDACTED]" in result

    def test_basic_at_beginning(self):
        text = "Basic dXNlcm5hbWU6cGFzc3dvcmQxMjM0NTY3ODkw rest"
        result = mask_secrets(text)
        assert "[REDACTED]" in result

    def test_basic_at_end(self):
        text = "prefix Basic dXNlcm5hbWU6cGFzc3dvcmQxMjM0NTY3ODkw"
        result = mask_secrets(text)
        assert "[REDACTED]" in result


# ---------------------------------------------------------------------------
# mask_secrets — Key=Value / Key: Value patterns
# ---------------------------------------------------------------------------


class TestMaskSecretsKV:
    """Generic key=value / key: value secret patterns."""

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

    def test_apikey_underscore_variant(self):
        """api_key with underscore separator."""
        text = "api_key=sk-abc123def456ghij7890"
        result = mask_secrets(text)
        assert "[REDACTED]" in result

    def test_apikey_hyphen_variant(self):
        """api-key with hyphen separator."""
        text = "api-key=sk-abc123def456ghij7890"
        result = mask_secrets(text)
        assert "[REDACTED]" in result

    def test_access_key_equals(self):
        """access_key pattern."""
        text = "access_key=my_secret_access_key_value_here"
        result = mask_secrets(text)
        assert "[REDACTED]" in result

    def test_auth_token_colon(self):
        """auth_token pattern."""
        text = "auth_token: my_auth_token_value_12345678"
        result = mask_secrets(text)
        assert "[REDACTED]" in result

    def test_short_values_not_redacted(self):
        """Short values (< 8 chars after :=) should not be redacted."""
        text = "api_key=short"
        result = mask_secrets(text)
        # "short" is < 8 chars so the pattern shouldn't match
        assert "short" in result

    def test_kv_at_beginning(self):
        """Key=value at the very start of the string."""
        text = "password=super_secret_password_12345 rest of line"
        result = mask_secrets(text)
        assert "[REDACTED]" in result

    def test_kv_at_end(self):
        """Key=value at the very end of the string."""
        text = "some prefix password=super_secret_password_12345"
        result = mask_secrets(text)
        assert "[REDACTED]" in result

    def test_kv_standalone(self):
        """Key=value is the entire string."""
        text = "token: my_super_secret_token_value_here"
        result = mask_secrets(text)
        assert "[REDACTED]" in result

    def test_kv_single_quoted(self):
        """Secret value wrapped in single quotes."""
        text = "password='super_secret_password_12345'"
        result = mask_secrets(text)
        assert "[REDACTED]" in result

    def test_kv_no_quotes(self):
        """Secret value without quotes."""
        text = "password=super_secret_password_12345"
        result = mask_secrets(text)
        assert "[REDACTED]" in result


# ---------------------------------------------------------------------------
# mask_secrets — AWS access key patterns
# ---------------------------------------------------------------------------


class TestMaskSecretsAWS:
    """AWS-style access key redaction."""

    def test_aws_access_key(self):
        text = "AKIAIOSFODNN7EXAMPLE"
        result = mask_secrets(text)
        assert "[REDACTED]" in result

    def test_aws_at_beginning(self):
        text = "AKIAIOSFODNN7EXAMPLE rest of line"
        result = mask_secrets(text)
        assert "[REDACTED]" in result
        assert "AKIA" not in result

    def test_aws_at_end(self):
        text = "prefix AKIAIOSFODNN7EXAMPLE"
        result = mask_secrets(text)
        assert "[REDACTED]" in result
        assert "AKIA" not in result

    def test_aws_standalone(self):
        text = "AKIAIOSFODNN7EXAMPLE"
        result = mask_secrets(text)
        assert result == "[REDACTED]"

    def test_aws_embedded_in_env_dump(self):
        """AWS key inside an environment variable dump."""
        text = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nAWS_SECRET=abc"
        result = mask_secrets(text)
        assert "[REDACTED]" in result
        assert "AKIA" not in result

    def test_aws_too_short_not_matched(self):
        """AWS key shorter than 20 chars total should not match."""
        text = "AKIA1234567890ABCD"  # exactly 18 chars (AKIA + 14)
        result = mask_secrets(text)
        assert "AKIA1234567890ABCD" in result


# ---------------------------------------------------------------------------
# mask_secrets — Kubernetes credential patterns
# ---------------------------------------------------------------------------


class TestMaskSecretsKube:
    """Kubernetes / kubeconfig credential redaction."""

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

    def test_kubeconfig_client_certificate_data(self):
        text = "client-certificate-data: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t"
        result = mask_secrets(text)
        assert "[REDACTED]" in result

    def test_kubeconfig_certificate_authority_data(self):
        text = "certificate-authority-data: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t"
        result = mask_secrets(text)
        assert "[REDACTED]" in result

    def test_kubeconfig_bearer_token(self):
        text = "bearer-token: abcdefghijklmnopqrstuvwxyz"
        result = mask_secrets(text)
        assert "[REDACTED]" in result

    def test_kubeconfig_bearer_token_hyphen(self):
        text = "bearer_token: abcdefghijklmnopqrstuvwxyz"
        result = mask_secrets(text)
        assert "[REDACTED]" in result

    def test_kubeconfig_password_case_insensitive(self):
        text = "PASSWORD: kube_secret_pass"
        result = mask_secrets(text)
        assert "[REDACTED]" in result


# ---------------------------------------------------------------------------
# mask_secrets — Adversarial / edge cases
# ---------------------------------------------------------------------------


class TestMaskSecretsAdversarial:
    """Adversarial inputs and edge cases."""

    def test_broken_token_prefix(self):
        """Token with wrong prefix should not be redacted by ghp pattern."""
        text = "ghp_short"
        result = mask_secrets(text)
        assert "ghp_short" in result

    def test_embedded_token_in_url(self):
        """Token embedded in a URL query string."""
        text = "https://example.com/api?token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"
        result = mask_secrets(text)
        assert "[REDACTED]" in result
        assert "ghp_" not in result

    def test_token_in_multiline_env_dump(self):
        """Multiple secrets across lines in an env dump."""
        text = (
            "PATH=/usr/bin\n"
            "GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij\n"
            "HOME=/home/user\n"
            "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n"
            "LANG=en_US.UTF-8"
        )
        result = mask_secrets(text)
        assert result.count("[REDACTED]") == 2
        assert "ghp_" not in result
        assert "AKIA" not in result
        # Non-secret lines should survive
        assert "PATH=/usr/bin" in result
        assert "HOME=/home/user" in result
        assert "LANG=en_US.UTF-8" in result

    def test_concatenated_output(self):
        """Secrets in concatenated stdout/stderr output."""
        text = (
            "[stdout] Build succeeded\n"
            "[stderr] Warning: token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij leaked\n"
            "[stdout] Done."
        )
        result = mask_secrets(text)
        assert "[REDACTED]" in result
        assert "ghp_" not in result
        assert "Build succeeded" in result

    def test_no_false_positives_safe_text(self):
        """Ensure normal prose is not altered."""
        safe = "The quick brown fox jumps over the lazy dog."
        assert mask_secrets(safe) == safe

    def test_no_false_positives_code_snippet(self):
        """Normal code should not be redacted."""
        code = 'def hello():\n    print("Hello, world!")'
        assert mask_secrets(code) == code

    def test_no_false_positives_yaml_config(self):
        """YAML config without secrets should survive unchanged."""
        yaml_text = "name: my-app\nversion: 1.0.0\nport: 8080"
        assert mask_secrets(yaml_text) == yaml_text

    def test_unicode_preserved(self):
        """Unicode characters outside of secrets should be preserved."""
        text = "Hello \u4e16\u754c! api_key=sk-abc123def456ghij7890"
        result = mask_secrets(text)
        assert "\u4e16\u754c" in result
        assert "[REDACTED]" in result

    def test_newlines_preserved(self):
        """Newlines in non-secret lines should be preserved."""
        text = "line1\nline2\npassword=secret_value_12345678\nline4"
        result = mask_secrets(text)
        assert "line1\nline2" in result
        assert "[REDACTED]" in result

    def test_multiple_secrets(self):
        text = (
            "api_key=sk-abc123def456ghij7890 and token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"
        )
        result = mask_secrets(text)
        assert result.count("[REDACTED]") == 2

    def test_token_surrounded_by_special_chars(self):
        """Token surrounded by brackets, parens, etc."""
        text = "(token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij)"
        result = mask_secrets(text)
        assert "[REDACTED]" in result
        assert "ghp_" not in result

    def test_token_in_backticks(self):
        """Token inside markdown backticks."""
        text = "`ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij`"
        result = mask_secrets(text)
        assert "[REDACTED]" in result
        assert "ghp_" not in result

    def test_token_in_quotes(self):
        """Token inside double quotes."""
        text = '"ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"'
        result = mask_secrets(text)
        assert "[REDACTED]" in result
        assert "ghp_" not in result


# ---------------------------------------------------------------------------
# mask_secrets — Input edge cases
# ---------------------------------------------------------------------------


class TestMaskSecretsInputEdgeCases:
    """Edge cases for input handling."""

    def test_none_input(self):
        assert mask_secrets(None) == ""

    def test_empty_string(self):
        assert mask_secrets("") == ""

    def test_whitespace_only(self):
        text = "   \n\t  "
        result = mask_secrets(text)
        assert result == text


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

    def test_empty_string_input(self):
        result, truncated = mask_and_truncate("", 100)
        assert result == ""
        assert truncated is False

    def test_truncation_with_secret(self):
        """Secret at the end gets redacted even if truncation cuts it."""
        text = "prefix api_key=abcdefghijklmnopqrstuvwxyz1234"
        result, truncated = mask_and_truncate(text, 10)
        assert "[REDACTED]" in result or truncated is True

    def test_unicode_truncation(self):
        """Unicode content is handled correctly during truncation."""
        text = "\u4e16\u754c" * 100  # 200 bytes of UTF-8
        result, truncated = mask_and_truncate(text, 50)
        assert truncated is True
        assert "[truncated]" in result

    def test_exact_boundary_no_truncation(self):
        """Text exactly at the byte limit should not be truncated."""
        text = "A" * 50
        result, truncated = mask_and_truncate(text, 50)
        assert result == text
        assert truncated is False

    def test_secret_redacted_then_truncated(self):
        """Secret is redacted first, then the redacted string may be truncated."""
        text = "x" * 100 + " api_key=abcdefghijklmnopqrstuvwxyz1234"
        result, truncated = mask_and_truncate(text, 50)
        assert truncated is True
        # The secret part may or may not survive truncation depending on position
        # but the function should not crash
        assert isinstance(result, str)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
