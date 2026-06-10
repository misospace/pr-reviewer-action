#!/usr/bin/env python3
"""Shared secret-redaction helpers for tool harness and evidence providers."""

from __future__ import annotations

import re


# ---------------------------------------------------------------------------
# Patterns that match common credential / token formats.
# ---------------------------------------------------------------------------

# GitHub personal access tokens (classic & fine-grained)
_RE_GHP = re.compile(r"ghp_[A-Za-z0-9]{30,}")
_RE_GITHUB_PAT = re.compile(r"github_pat_[A-Za-z0-9_]{20,}")

# Bearer / Basic auth headers and inline tokens
_RE_BEARER = re.compile(r"Bearer\s+[A-Za-z0-9._-]{20,}", re.IGNORECASE)
_RE_BASIC = re.compile(r"Basic\s+[A-Za-z0-9+/=]{20,}", re.IGNORECASE)

# Generic key=value / key: value patterns (common in logs, env dumps, configs)
_RE_KV_SECRET = re.compile(
    r"(?i)(api[_-]?key|token|password|secret|access[_-]?key|auth[_-]?token)"
    r"\s*[:=]\s*['\"]?[^\s'\"]{8,}"
)

# AWS-style access keys
_RE_AWS_KEY = re.compile(r"AKIA[0-9A-Z]{16}")

# Kubernetes / kubeconfig credentials. Only credential-bearing keys are
# matched: the old (server|username|...) form redacted every ordinary
# `server:` line in YAML evidence output, destroying legitimate review
# context for zero secrecy gain (server URLs and usernames are not secrets).
_RE_KUBE_CRED = re.compile(
    r"(?i)(password|client-certificate-data|client-key-data|"
    r"certificate-authority-data|bearer[_-]?token)\s*:\s*\S+"
)


def mask_secrets(text: str | None) -> str:
    """Return *text* with credential-like values replaced by ``[REDACTED]``.

    This is best-effort heuristic redaction; it will not catch every
    possible secret format and may occasionally false-positive on
    non-secret strings that happen to look similar.
    """
    if not text:
        return text or ""

    redacted = text

    for pattern in (
        _RE_GHP,
        _RE_GITHUB_PAT,
        _RE_BEARER,
        _RE_BASIC,
        _RE_KV_SECRET,
        _RE_AWS_KEY,
        _RE_KUBE_CRED,
    ):
        redacted = re.sub(pattern, "[REDACTED]", redacted)

    return redacted


def mask_and_truncate(text: str | None, max_bytes: int) -> tuple[str, bool]:
    """Redact secrets then truncate to *max_bytes*.

    Returns ``(masked_text, was_truncated)``.
    Truncation is performed **after** masking so the byte-length of the
    output reflects the redacted content (which may be shorter or longer
    than the original).
    """
    masked = mask_secrets(text)
    raw = masked.encode("utf-8", errors="replace")
    if len(raw) <= max_bytes:
        return masked, False

    clipped = raw[:max_bytes].decode("utf-8", errors="replace")
    return clipped + "\n[truncated]", True
