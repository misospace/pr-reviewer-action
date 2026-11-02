"""pr_reviewer.http_safe URL-identity helpers (#1414).

Adversarial-boundary convention (#252): the redactor is fed the boundary
token itself — a URL carrying userinfo — not just benign URLs, so a mock
cannot encode away the exact leak it is supposed to close.
"""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import pytest  # noqa: E402

from pr_reviewer.http_safe import (  # noqa: E402
    CredentialInProcessArguments,
    UnsafeEndpointUrl,
    base_url_identity_digest,
    carries_url_credential,
    normalize_base_url,
    redact_url_userinfo,
    resolve_endpoint,
    select_base_url,
)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        # The boundary token itself: userinfo must never survive.
        ("https://user:pass@host", "https://***@host"),
        ("https://user:pass@host/v1", "https://***@host/v1"),
        ("https://user:pass@host/v1?model=x#frag", "https://***@host/v1?model=x#frag"),
        ("http://user@host:8443/v1", "http://***@host:8443/v1"),
        ("https://@host", "https://***@host"),
        ("HTTPS://USER:PASS@HOST/V1", "https://***@HOST/V1"),  # scheme lowercases
        # userinfo is only what precedes the LAST @ of the authority.
        ("https://u:p@a@host/v1", "https://***@host/v1"),
        # scheme-relative authority still carries userinfo.
        ("//user:pass@host/v1", "//***@host/v1"),
        # scheme-less authority parses as a bogus scheme; userinfo still redacted.
        ("user:pass@host/v1", "***@host/v1"),
        ("user:pass@host", "***@host"),
        ("user:p@host/v1?x=y", "***@host/v1?x=y"),
        # unverifiable authority strings fail closed: no identified authority
        # means any '@' could be userinfo (stringified payload, prose wrap).
        ('["https://user:pass@host/v1"]', "***"),
        ('{"u": "https://user:pass@host"}', "***"),
        ("prefix https://user:pass@host/v1", "***"),
        ("user@example.com", "***"),
        # a second absolute URL nested in path/query carries its own userinfo.
        ("https://host/https://admin:s3cret@evil/v1", "***"),
        ("https://host/p?next=https://admin:s3cret@evil/v1", "***"),
        # a password carrying an unencoded '/' ends the authority early, so
        # the userinfo lands in the path where no check can attribute it.
        ("https://admin:s3cret/pass@host/v1", "***"),
        # single-slash scheme keeps the host, drops the userinfo.
        ("https:/user:pass@host", "***@host"),
        ("https:/user:pass@host/v1", "***@host/v1"),
        ("foo:/a@b", "***@b"),
        # benign forms stay byte-identical.
        ("http://x", "http://x"),
        ("https://host/v1", "https://host/v1"),
        ("http://host:8080/v1?a=b", "http://host:8080/v1?a=b"),
        ("http://[::1]:8080/v1", "http://[::1]:8080/v1"),
        ("u", "u"),
        ("", ""),
        # An '@' outside the authority cannot be attributed to a userinfo: a
        # password carrying an unencoded '/' ends the authority early, so the
        # userinfo lands in the path. Over-redact rather than echo it.
        ("https://host/a@b", "***"),
        ("https://host:8080/a@b", "***"),
    ],
)
def test_redact_url_userinfo(raw: str, expected: str) -> None:
    assert redact_url_userinfo(raw) == expected


def test_redact_url_userinfo_never_leaks_password() -> None:
    for raw in (
        "https://admin:hunter2@gw.internal/v1",
        "https://admin:hunter2%40x@gw.internal/v1",
        "https://admin:%F0%9F%94%91@gw.internal/v1",
        "admin:hunter2@gw.internal/v1",
    ):
        out = redact_url_userinfo(raw)
        assert "hunter2" not in out
        assert "admin" not in out
        assert "%F0%9F%94%91" not in out
        assert out.endswith("@gw.internal/v1")


def test_redact_url_userinfo_unparseable_fails_closed() -> None:
    # An authority urllib refuses to parse cannot be shown verbatim.
    assert redact_url_userinfo("http://[::1") == "***"
    assert redact_url_userinfo("https://us:er@pa:ss@host/v1") == "https://***@host/v1"


def test_redact_url_userinfo_over_redacts_an_encoded_userinfo() -> None:
    # An ENCODED '@' hides the userinfo from the authority split, and urllib
    # unquotes the authority into the request's Host value — so the credential
    # would still ride the request. The userinfo position cannot be verified:
    # over-redact rather than echo it.
    out = redact_url_userinfo("https://judge-operator%3Ahunter2%40judge.internal/v1")
    assert out == "***"
    assert "hunter2" not in out
    assert "judge-operator" not in out
    # The same holds for a value with no authority at all.
    assert redact_url_userinfo("judge-operator%3Ahunter2%40judge.internal") == "***"


def test_redact_url_userinfo_non_string_input_fails_closed() -> None:
    # A non-string value cannot be verified as URL structure; ``str()`` of a
    # container would parse as an opaque path and echo any embedded credential
    # URL verbatim, so every non-string over-redacts to the bare marker.
    assert redact_url_userinfo(None) == "***"
    assert redact_url_userinfo(42) == "***"
    for malformed in (
        ["https://judge-operator:hunter2@judge.internal/v1"],
        {"base_url": "https://judge-operator:hunter2@judge.internal/v1"},
        ("https://judge-operator:hunter2@judge.internal/v1",),
    ):
        out = redact_url_userinfo(malformed)
        assert out == "***"
        assert "hunter2" not in out and "judge-operator" not in out


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("http://x", "http://x"),
        ("  http://x/  ", "http://x"),
        ("http://x//", "http://x"),
        ("/", ""),
        ("", ""),
        (None, ""),
        (123, ""),
        # a /v1 segment stays significant
        ("http://x/v1", "http://x/v1"),
    ],
)
def test_normalize_base_url(raw: object, expected: str) -> None:
    assert normalize_base_url(raw) == expected


def test_base_url_identity_digest_is_full_value_identity() -> None:
    full = "https://user:pass@host/v1"
    digest = base_url_identity_digest(full)
    assert digest == hashlib.sha256(full.encode("utf-8")).hexdigest()
    # trailing slash normalizes equal; a different userinfo does NOT.
    assert base_url_identity_digest("https://user:pass@host/v1/") == digest
    assert base_url_identity_digest("https://host/v1") != digest
    assert base_url_identity_digest("https://other:pw@host/v1") != digest


# ── endpoint resolution: the credential never rides in a request URL ────────

def test_resolve_endpoint_separates_the_credential_from_the_request_target() -> None:
    endpoint = resolve_endpoint("https://judge-operator:hunter2@judge.internal/v1")
    assert endpoint.url == "https://judge.internal/v1"
    assert endpoint.credential == "judge-operator:hunter2"


def test_resolve_endpoint_keeps_a_credential_free_url_intact() -> None:
    endpoint = resolve_endpoint("http://127.0.0.1:8080/v1")
    assert endpoint.url == "http://127.0.0.1:8080/v1"
    assert endpoint.credential is None


def test_resolve_endpoint_never_reveals_the_credential_in_its_repr() -> None:
    # A stray log line or traceback must not echo the credential.
    endpoint = resolve_endpoint("https://judge-operator:hunter2@judge.internal/v1")
    assert "hunter2" not in repr(endpoint)
    assert "judge-operator" not in repr(endpoint)


def test_resolve_endpoint_decodes_the_credential() -> None:
    # A percent-encoded credential is decoded for the Authorization header.
    endpoint = resolve_endpoint("https://admin:hunter2%40x@gw.internal/v1")
    assert endpoint.url == "https://gw.internal/v1"
    assert endpoint.credential == "admin:hunter2@x"


def test_resolve_endpoint_takes_the_userinfo_before_the_last_at() -> None:
    endpoint = resolve_endpoint("https://u:p@a@host/v1")
    assert endpoint.url == "https://host/v1"
    assert endpoint.credential == "u:p@a"


@pytest.mark.parametrize(
    "raw",
    [
        None,
        42,
        ["https://host/v1"],
        {"url": "https://host/v1"},
        "u",  # not absolute
        "/v1",
        "judge-operator:hunter2@host/v1",  # scheme-less authority
        "ftp://host/v1",  # not http(s)
        "https:/host/v1",  # single slash: no authority
        "https://host:notaport/v1",  # invalid port
        "http://[::1",  # authority urllib refuses to parse
        "https://host/v1?api_key=secret",  # a query rides the request line
        "https://host/v1#frag",  # a fragment has no place in an endpoint
        # An ENCODED '@' hides the userinfo from the authority split, and
        # urllib unquotes the authority into the request's Host value.
        "https://judge-operator%3Ahunter2%40judge.internal/v1",
        # An '@' outside the authority: a password carrying an unencoded '/'
        # ends the authority early, so the userinfo lands in the path and
        # would ride the request line.
        "https://judge-operator:hunter2/pass@judge.internal/v1",
        "https://judge-operator:1234/pass@judge.internal/v1",
        "https://judge-operator/pass@judge.internal/v1",
    ],
)
def test_resolve_endpoint_rejects_unusable_values(raw: object) -> None:
    with pytest.raises(UnsafeEndpointUrl):
        resolve_endpoint(raw)


def test_resolve_endpoint_errors_never_echo_the_credential() -> None:
    for raw in (
        "https://judge-operator:hunter2@host:notaport/v1",
        "https://judge-operator:hunter2@[::1/v1",
        "judge-operator:hunter2@host/v1",
        "https://judge-operator:hunter2@/v1",
        "https://judge-operator%3Ahunter2%40host/v1",
    ):
        with pytest.raises(UnsafeEndpointUrl) as caught:
            resolve_endpoint(raw)
        assert "hunter2" not in str(caught.value)
        assert "judge-operator" not in str(caught.value)


# ── the shared redactor over-redacts an unattributable userinfo (#1419) ────

def test_redact_url_userinfo_over_redacts_a_password_with_an_unencoded_slash() -> None:
    """#1419: an unencoded '/' ends the authority early, so the userinfo lands
    in the path and no check can attribute it. The helper must over-redact
    instead of echoing the credential."""
    for raw in (
        "https://judge-operator:hunter2/pass@judge.internal/v1",
        "https://judge-operator:hunter2/pass@judge.internal",
        # A numeric password parses as a host and a port, so the authority
        # split cannot tell the two apart — the credential still lands in
        # the path and must not be echoed.
        "https://judge-operator:1234/pass@judge.internal/v1",
        # A user name without a password is indistinguishable from a host.
        "https://judge-operator/pass@judge.internal/v1",
    ):
        out = redact_url_userinfo(raw)
        assert out == "***"
        assert "hunter2" not in out
        assert "judge-operator" not in out
    # A percent-encoded '/' keeps the userinfo inside the authority, so the
    # ordinary redaction applies there.
    out = redact_url_userinfo(
        "https://judge-operator:hunter2%2Fpass@judge.internal/v1"
    )
    assert out == "https://***@judge.internal/v1"
    assert "hunter2" not in out


# ── the credential never rides in the process argument list ────────────────

@pytest.mark.parametrize(
    "value",
    [
        "https://judge-operator:hunter2@judge.internal/v1",
        "https://judge-operator%3Ahunter2%40judge.internal/v1",
        "https://judge-operator:hunter2/pass@judge.internal/v1",
        "https://judge-operator:hunter2@judge.internal/v1?x=y",
    ],
)
def test_carries_url_credential_flags_every_credential_shape(value: str) -> None:
    assert carries_url_credential(value) is True


@pytest.mark.parametrize(
    "value",
    [
        "https://judge.internal/v1",
        "http://127.0.0.1:8080/v1",
        "",
    ],
)
def test_carries_url_credential_accepts_a_credential_free_url(value: str) -> None:
    assert carries_url_credential(value) is False


def test_carries_url_credential_fails_closed_on_an_unverifiable_value() -> None:
    assert carries_url_credential(None) is True
    assert carries_url_credential(["https://judge-operator:hunter2@host/v1"]) is True


def test_select_base_url_refuses_a_credential_bearing_command_line_value() -> None:
    with pytest.raises(CredentialInProcessArguments) as caught:
        select_base_url(["https://judge-operator:hunter2@judge.internal/v1"], None)
    message = str(caught.value)
    assert "must not carry a credential" in message
    assert "JUDGE_BASE_URL" in message
    assert "hunter2" not in message
    assert "judge-operator" not in message


def test_select_base_url_refuses_a_credential_in_any_command_line_occurrence() -> None:
    # A later occurrence does not remove an earlier one from the argument
    # list, so every occurrence is checked.
    with pytest.raises(CredentialInProcessArguments) as caught:
        select_base_url(
            ["https://judge-operator:hunter2@judge.internal/v1", "http://host/v1"],
            None,
        )
    assert "hunter2" not in str(caught.value)


def test_select_base_url_takes_a_credential_bearing_environment_value() -> None:
    # The environment is the only channel that may carry the credential; the
    # transport moves it into the Authorization header.
    url = "https://judge-operator:hunter2@judge.internal/v1"
    assert select_base_url((), url) == url
    assert select_base_url(None, url) == url


def test_select_base_url_prefers_the_command_line_value() -> None:
    assert select_base_url(["http://cli/v1"], "http://env/v1") == "http://cli/v1"


def test_select_base_url_treats_an_empty_command_line_value_as_an_error() -> None:
    # An explicit empty value is the operator's choice, not a request to use
    # the environment value.
    assert select_base_url([""], "http://env/v1") == ""


def test_select_base_url_without_any_value_is_empty() -> None:
    assert select_base_url((), None) == ""
