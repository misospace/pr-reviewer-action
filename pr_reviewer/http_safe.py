"""Safe HTTP client that refuses redirects and prevents token leakage.

The API key/token rides only the Authorization header, never the URL, the body,
or an error message. Redirects are refused: urllib's default handler copies
request headers (including Authorization) onto the redirected request,
even across origins.

A credential rides only the Authorization header and never the process
argument list either: an argument list is readable by every other process on
the host. An endpoint URL that carries a credential is therefore taken from the
environment, never from a command-line argument.

This module provides a shared opener and helper for all tooling that sends
tokens via Authorization headers.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Iterable, Optional


class _RefuseRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse all HTTP redirects to prevent token leakage across origins."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ARG002
        return None


# Shared opener that refuses redirects
OPENER_NO_REDIRECT = urllib.request.build_opener(_RefuseRedirect)


def open_no_redirect(request: urllib.request.Request, timeout: float) -> any:
    """Open a URL safely, refusing redirects.

    Args:
        request: urllib.request.Request object.
        timeout: Timeout in seconds.

    Returns:
        The response object (similar to urllib.request.urlopen).

    Raises:
        urllib.error.HTTPError: If a redirect (3xx) is encountered.
    """
    return OPENER_NO_REDIRECT.open(request, timeout=timeout)


def redact_url_userinfo(url: object) -> str:
    """#1414: Return a URL safe to record or print, with any userinfo
    (``https://user:pass@host`` -> ``https://***@host``) replaced.

    A URL is a credential carrier: an operator endpoint can embed a secret in
    its userinfo, and reports/error messages are shared artifacts. A verifiable
    value keeps everything except the userinfo verbatim (including the
    scheme-less authority form, which urllib parses as a bogus scheme), so the
    redacted form still identifies the host and path for diagnostics.
    Fail-closed rule: a value whose userinfo position cannot be verified
    over-redacts to a bare marker ``***`` rather than risk echoing a credential
    — a non-string value (containers stringify to an opaque path hiding any
    embedded URL), an authority urllib refuses to parse, a string carrying a
    second absolute URL (a nested authority is never inspected), a string
    with ``@`` but no identifiable authority (stringified payload,
    prose-wrapped URL), and an ``@`` outside the authority — a password
    carrying an unencoded ``/`` ends the authority early, so the userinfo
    lands where no check can attribute it (#1419). A string containing no
    ``@`` cannot carry userinfo and stays byte-identical.
    """
    if not isinstance(url, str):
        return "***"
    text = url
    if text.count("://") > 1:
        # A second absolute URL embedded in the path or query carries its own
        # authority that no check below inspects; its userinfo is unverifiable.
        return "***"
    try:
        parts = urllib.parse.urlsplit(text)
    except ValueError:
        return "***"
    if "@" not in parts.netloc and "@" in urllib.parse.unquote(parts.netloc):
        # An ENCODED '@' hides the userinfo position from the authority
        # split, and urllib unquotes the authority into the request's Host
        # value — so the credential would still ride the request. The
        # position cannot be verified: over-redact.
        return "***"
    if not parts.scheme and not parts.netloc:
        # No authority identified at all: any '@' — literal or encoded — could
        # be userinfo hiding in an unparseable prefix (stringified payload,
        # prose-wrapped URL).
        if "@" in text or "@" in urllib.parse.unquote(text):
            return "***"
        return text
    if "@" not in parts.netloc:
        # A scheme-less authority (``user:pass@host/v1``) parses as a bogus
        # scheme with an empty netloc, hiding the userinfo from the netloc
        # check; redact the leading authority segment too.
        if parts.scheme and not parts.netloc:
            rest = text[len(parts.scheme) + 1 :].lstrip("/")
            authority_end = rest.find("/")
            head = rest if authority_end == -1 else rest[:authority_end]
            if "@" in head:
                host = head.rsplit("@", 1)[1]
                tail = "" if authority_end == -1 else rest[authority_end:]
                return f"***@{host}{tail}" if host else f"***{tail}"
            # '@' deeper in the path with no authority to anchor it.
            return "***" if "@" in rest else text
        # An '@' outside the authority is a credential whose position cannot
        # be verified: a password carrying an unencoded '/' ends the
        # authority early, so the userinfo lands in the path
        # (``https://user:p/ss@host/v1``) and the value would be echoed
        # verbatim. Over-redact (#1419).
        if "@" in text or "@" in urllib.parse.unquote(text):
            return "***"
        return text

    host = parts.netloc.rsplit("@", 1)[1]
    netloc = f"***@{host}" if host else "***"
    return urllib.parse.urlunsplit(
        (parts.scheme, netloc, parts.path, parts.query, parts.fragment)
    )


def redact_echo_value(value: object) -> str:
    """#1418: Render any untrusted artifact field value for echoing in a
    diagnostic message. Generalizes the #1414 rule to every echoed field, not
    just endpoint URLs: the message must still identify the field, but no
    echoed value may carry a credential.

    Scalars that cannot structurally hold text (bool/int/float/None) keep
    their ``repr``. Strings go through :func:`redact_url_userinfo` (fail-closed
    there: verifiable userinfo is masked, unverifiable payloads over-redact to
    ``***``) and keep ``repr``-style quoting, which also neutralizes control
    characters a hostile value could use to forge terminal/log lines. Any other
    value (dict/list and other containers) stringifies to an opaque blob that
    can hide a credential URL at any depth, so it is replaced by a bare type
    marker instead of being recursively scanned; the diagnostic's own field
    name stays the identifying information. Assumes JSON-decoded data (native
    types only): a ``str`` subclass with a custom ``__repr__`` is outside the
    trust model."""
    if value is None or isinstance(value, (bool, int, float)):
        try:
            return repr(value)
        except ValueError:
            # CPython refuses int->str beyond ~4300 digits (3.11+); a hostile
            # artifact must not turn the fail-closed diagnostic into a crash.
            return f"<{type(value).__name__}>"
    if isinstance(value, str):
        return repr(redact_url_userinfo(value))
    return f"<{type(value).__name__}>"


def normalize_base_url(url: object) -> str:
    """Normalize an API endpoint for identity comparison: strip surrounding
    whitespace and trailing slashes only. A ``/v1`` path segment stays
    significant, so the same model alias behind a different gateway is never
    treated as equal."""
    if not isinstance(url, str):
        return ""
    return url.strip().rstrip("/")


def base_url_identity_digest(url: object) -> str:
    """SHA-256 of the normalized *full* endpoint URL. Lets a shared report
    bind an exact endpoint identity (userinfo included) without recording the
    credential a userinfo would carry (#1414)."""
    return hashlib.sha256(normalize_base_url(url).encode("utf-8")).hexdigest()


class CredentialInProcessArguments(ValueError):
    """A credential was supplied through the process argument list.

    The message never echoes the offending value: an endpoint URL can carry a
    secret in its userinfo, and an argument list is readable by every other
    process on the host.
    """


ARGV_CREDENTIAL_MESSAGE = (
    "a base URL on the command line must not carry a credential or an '@'; "
    "set JUDGE_BASE_URL in the environment instead"
)


class BaseUrlArgumentAction(argparse.Action):
    """Record every ``--base-url`` occurrence, not only the effective one.

    A credential in an earlier occurrence still sits in the process argument
    list — a later occurrence does not remove it — so every occurrence is
    checked (#1414).
    """

    def __call__(self, parser, namespace, values, option_string=None):  # noqa: ANN001
        seen = list(getattr(namespace, "base_url_values", None) or [])
        seen.append(values)
        namespace.base_url_values = seen
        setattr(namespace, self.dest, values)


def carries_url_credential(url: object) -> bool:
    """True when a URL value may carry a credential in its userinfo.

    Fail-closed: any ``@`` — literal or percent-encoded, because urllib
    unquotes an authority — marks the value as credential-bearing, including
    an ``@`` outside the authority, where the userinfo position cannot be
    verified. A value that is not a string cannot be verified either.
    """
    if not isinstance(url, str):
        return True
    # urllib unquotes an authority, so an encoded '@' hides the credential
    # from a plain scan.
    return "@" in urllib.parse.unquote(url.strip())


def select_base_url(cli_values: Iterable[object], env_value: object) -> str:
    """Choose the endpoint URL from the command-line values and the environment.

    A credential must never ride in the process argument list: every other
    process on the host can read it. A command-line base URL that carries a
    credential is therefore refused — every occurrence of it, not only the
    effective one — and the operator moves the endpoint to the environment
    variable, where the judge key lives too. The credential the environment
    value carries is moved into the ``Authorization`` header by
    :func:`resolve_endpoint`, never into the request URL.

    The command-line value wins when one is given: an operator who passes
    ``--base-url`` gets exactly that endpoint, and an empty value is an error
    rather than a silent fall back to the environment.
    """
    values = list(cli_values or [])
    for value in values:
        if carries_url_credential(value):
            raise CredentialInProcessArguments(ARGV_CREDENTIAL_MESSAGE)
    if values:
        last = values[-1]
        return last if isinstance(last, str) else ""
    if isinstance(env_value, str):
        return env_value
    return ""


class UnsafeEndpointUrl(ValueError):
    """An endpoint URL cannot be used as a request target.

    The message never echoes the offending value: an endpoint URL is a
    credential carrier and the value may carry a secret in its userinfo.
    """


@dataclass(frozen=True)
class Endpoint:
    """A resolved endpoint: the request target plus the credential it carried.

    ``url`` never carries a userinfo, so it is safe to use as a request
    target. ``credential`` is the decoded userinfo the URL carried (or
    ``None``); it must travel in an ``Authorization`` header, never in the
    URL. The credential is excluded from ``repr`` so a stray log line or
    traceback cannot echo it.
    """

    url: str
    credential: Optional[str] = field(default=None, repr=False)


def resolve_endpoint(url: object) -> Endpoint:
    """Resolve an endpoint URL into a credential-free request target plus the
    credential it carried (#1414).

    A URL userinfo (``https://user:pass@host``) is a credential carrier, and a
    credential must never ride in a request URL: Python's urllib keeps the
    userinfo inside the request's ``Host`` value, so it reaches the outbound
    request header and every proxy log on the way out. The resolved ``url``
    is safe as a request target; the returned ``credential`` is the decoded
    userinfo (or ``None``) and belongs in an ``Authorization`` header.

    Fail-closed: a value that is not a string, is not an absolute http(s)
    URL, carries a query or a fragment (the transport appends the
    completion path, and a query would ride the request line), hides the
    userinfo behind an encoded ``@`` (urllib unquotes the authority into the
    request's ``Host`` value), carries an ``@`` outside its authority (a
    password with an unencoded ``/`` ends the authority early, so the
    userinfo lands in the path), or has an authority that cannot be
    attributed raises :class:`UnsafeEndpointUrl` instead of being used as a
    request target.
    """
    if not isinstance(url, str):
        raise UnsafeEndpointUrl("endpoint URL must be a string")
    try:
        parts = urllib.parse.urlsplit(url.strip())
    except ValueError:
        raise UnsafeEndpointUrl("endpoint URL could not be parsed") from None
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise UnsafeEndpointUrl("endpoint URL must be an absolute http(s) URL")
    if parts.query or parts.fragment:
        # The transport appends the completion path to the base path, so a
        # query or a fragment has no place in the endpoint — and a query can
        # carry a credential into the request line.
        raise UnsafeEndpointUrl("endpoint URL must not carry a query or a fragment")
    try:
        parts.port  # noqa: B018 - validates the port; raises for a bad one
    except ValueError:
        raise UnsafeEndpointUrl("endpoint URL carries an invalid port") from None
    netloc = parts.netloc
    if "@" not in netloc:
        if "@" in urllib.parse.unquote(netloc):
            # An ENCODED '@' hides the userinfo from the authority split, and
            # urllib unquotes the authority into the request's Host value —
            # the credential would still ride the request. Refuse.
            raise UnsafeEndpointUrl("endpoint URL carries an encoded credential")
        if "@" in parts.path or "@" in urllib.parse.unquote(parts.path):
            # An '@' outside the authority cannot be attributed to a userinfo:
            # a password carrying an unencoded '/' ends the authority early,
            # so the userinfo lands in the path and would ride the request
            # line. Refuse rather than send it (#1419).
            raise UnsafeEndpointUrl(
                "endpoint URL carries a credential outside its authority"
            )
        return Endpoint(_unsplit(parts, netloc), None)
    # The userinfo is everything before the LAST '@' of the authority.
    userinfo, _, host = netloc.rpartition("@")
    if not host:
        raise UnsafeEndpointUrl("endpoint URL carries an unparseable credential")
    credential = urllib.parse.unquote(userinfo) if userinfo else None
    return Endpoint(_unsplit(parts, host), credential)


def _unsplit(parts: urllib.parse.SplitResult, netloc: str) -> str:
    return urllib.parse.urlunsplit(
        (parts.scheme, netloc, parts.path, parts.query, parts.fragment)
    )


class ConflictingCredentialChannels(ValueError):
    """An endpoint URL and a separate credential both carry a secret.

    One request carries one credential, so the two channels cannot both be
    honored. The message never echoes either value: an endpoint URL is a
    credential carrier and the value may carry a secret in its userinfo.
    """


def resolve_credential_channel(url: object, api_key: object = "") -> tuple[str, str]:
    """Split an endpoint into a credential-free request target and the
    credential the request carries in its authentication header (#1417).

    A credential rides exactly one channel, and that channel is an HTTP
    authentication header. A credential in the endpoint URL's userinfo is
    moved into the credential channel, and the request target keeps the
    endpoint's identity — scheme, host, port and path — unchanged, so the
    run still contacts the intended endpoint.

    Supplying a credential in the URL and a separate API key at the same time
    is refused (:class:`ConflictingCredentialChannels`): one request carries
    one credential, so honoring both would drop one of them silently.

    Fail-closed: an endpoint that cannot be used as a request target raises
    :class:`UnsafeEndpointUrl` (see :func:`resolve_endpoint`).
    """
    endpoint = resolve_endpoint(url)
    credential = endpoint.credential or ""
    key = api_key if isinstance(api_key, str) else ""
    if credential and key:
        raise ConflictingCredentialChannels(
            "the endpoint URL carries a credential and a separate model "
            "credential is configured; one request carries one credential"
        )
    return endpoint.url, credential or key


# A URL-shaped token in free text: an absolute URL with its scheme. Only an
# absolute URL is recognized, because that is the shape the runtime records
# (``model@https://user:pass@host/v1``) and the shape a client accepts.
_URL_IN_TEXT = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://[^\s\"'<>]+")


def redact_urls_in_text(text: str) -> str:
    """#1417: Redact the userinfo of every absolute URL in free text.

    Runtime artifacts and captured stderr can embed the operator endpoint
    (``model@https://user:pass@host/v1``), and those strings reach shared eval
    reports. Each URL-shaped token goes through :func:`redact_url_userinfo`;
    text that carries no URL is returned unchanged.
    """
    if not isinstance(text, str):
        return text
    return _URL_IN_TEXT.sub(lambda match: redact_url_userinfo(match.group(0)), text)
