"""Safe HTTP client that refuses redirects and prevents token leakage.

The API key/token rides only the Authorization header, never the URL, the body,
or an error message. Redirects are refused: urllib's default handler copies
request headers (including Authorization) onto the redirected request,
even across origins.

This module provides a shared opener and helper for all tooling that sends
tokens via Authorization headers.
"""

from __future__ import annotations

import re
import urllib.error
import urllib.parse
import urllib.request


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
    its userinfo, and reports/error messages are shared artifacts. Everything
    except the userinfo stays verbatim (including the scheme-less authority
    form, which urllib parses as a bogus scheme), so the redacted form still
    identifies the host and path for diagnostics. A URL that fails to parse is
    over-redacted to a bare marker rather than risk echoing an unverifiable
    value.
    """
    text = url if isinstance(url, str) else str(url)
    try:
        parts = urllib.parse.urlsplit(text)
    except ValueError:
        return "***"
    if "@" not in parts.netloc:
        # A scheme-less authority (``user:pass@host/v1``) parses as a bogus
        # scheme with an empty netloc, hiding the userinfo from the netloc
        # check; redact the leading authority segment too.
        if parts.scheme and not parts.netloc:
            authority_end = text.find("/")
            head = text if authority_end == -1 else text[:authority_end]
            if "@" in head:
                host = head.rsplit("@", 1)[1]
                rest = "" if authority_end == -1 else text[authority_end:]
                return f"***@{host}{rest}" if host else f"***{rest}"
        return text
    host = parts.netloc.rsplit("@", 1)[1]
    netloc = f"***@{host}" if host else "***"
    return urllib.parse.urlunsplit(
        (parts.scheme, netloc, parts.path, parts.query, parts.fragment)
    )


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
