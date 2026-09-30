"""Safe HTTP client that refuses redirects and prevents token leakage.

The API key/token rides only the Authorization header, never the URL, the body,
or an error message. Redirects are refused: urllib's default handler copies
request headers (including Authorization) onto the redirected request,
even across origins.

This module provides a shared opener and helper for all tooling that sends
tokens via Authorization headers.
"""

from __future__ import annotations

import urllib.error
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
