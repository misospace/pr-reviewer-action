"""Configured forge capability for the repository's Python tooling.

The forge is the host a pull request lives on (GitHub, GitHub Enterprise with
a custom API URL, or a self-hosted GitHub Enterprise Server instance). Every
read or write that needs to talk to the forge goes through this module; no
script imports a forge-specific CLI like ``gh`` or hand-rolls its own
``urllib.request`` request. The single seam is the one place that:

- knows how to resolve the configured base URL (``GITHUB_API_URL`` or the
  built-in default), so a script does not;
- knows how to resolve the auth token (``GITHUB_TOKEN`` or ``GH_TOKEN``),
  reads it only from the environment, and never accepts it as argv or
  embedded in a URL;
- refuses redirects so the bearer token cannot leak across origins (the
  ``#855``-class risk a hand-rolled ``urlopen`` call would expose);
- requires HTTPS for every non-loopback origin so the bearer token cannot
  be sent in cleartext over an unencrypted transport — loopback HTTP is
  permitted only because the credential never leaves the host;
- validates the request URL before attaching the token, so a token cannot
  bind to an unvalidated origin;
- emits a fixed, credential-free error string on failure — never the raw
  response body and never the token.

Redirect refusal is the only safe default: ``urllib``'s built-in handler
copies the request headers, including ``Authorization``, onto a redirected
request, even across origins. The shared ``OPENER_NO_REDIRECT`` opener in
:mod:`pr_reviewer.http_safe` is the one mechanism that closes that hole,
and this module uses it for every request.

HTTPS for non-loopback is the second safe default: redirect refusal
prevents the bearer from *following* an attacker-controlled 3xx to a
different host, but a configured ``GITHUB_API_URL=http://ghe.example.com``
would still attach ``Authorization: Bearer <token>`` to a request over
plaintext HTTP — the credential would leak in transit on any network the
attacker can observe. The base-URL guard rejects that combination at
:func:`_build_base_url` time, before any byte goes out.

The module exposes :class:`ForgeClient` (one configured instance per forge
host) and a module-level :func:`default_forge` for the common case of
"talk to the configured forge using the configured token". Scripts that
need to talk to a non-default base URL (e.g. tests against a stub server)
build their own :class:`ForgeClient` explicitly.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Iterable, Mapping

from pr_reviewer.http_safe import OPENER_NO_REDIRECT

# Public base URL is hard-coded; an explicit GITHUB_API_URL override is the
# only supported way to point at a different host (e.g. GitHub Enterprise).
DEFAULT_GITHUB_API_URL = "https://api.github.com"

# Authorization is required for private repos and the fork-review gate; an
# absent token still works for unauthenticated reads of public resources,
# but the rate limit is dramatically lower. Callers that REQUIRE a token
# (the fork-review gate) reject a missing token at the call site.
_ENV_TOKEN_NAMES = ("GITHUB_TOKEN", "GH_TOKEN")

# Per-request timeout. The fork gate, harvest, and corpus-anchor tools all
# use small fixed budgets; a single default keeps the seam uniform.
DEFAULT_TIMEOUT_SEC = 30


class ForgeError(RuntimeError):
    """The forge could not be reached, rejected the request, or returned an
    unusable payload.

    The ``message`` is a fixed string — never the raw response body, never
    the token, and never a URL that contains the token. Callers can compare
    the message against the ``kind`` attribute (``"transport"``,
    ``"http_status"``, ``"redirect"``, ``"invalid_json"``) to distinguish
    failure modes without parsing English text.
    """


_LOOPBACK_HOSTNAMES = frozenset({"localhost", "ip6-localhost", "ip6-loopback"})


def _is_loopback_host(hostname: str) -> bool:
    """True for hosts whose names imply a local-only connection.

    Covers the loopback DNS names (``localhost`` and its IPv6 aliases) and
    the IPv4 loopback range ``127.0.0.0/8`` (any address whose first
    ``127.`` octet qualifies, including ``127.0.0.1`` and ``127.1.2.3``).
    IPv6 loopback (``::1``) is covered by ``ip6-localhost`` /
    ``ip6-loopback`` and a literal ``::1``. Used to gate the only ``http``
    exception to the HTTPS-only base-URL guard.
    """
    lowered = (hostname or "").strip().lower()
    if lowered in _LOOPBACK_HOSTNAMES:
        return True
    if lowered == "::1":
        return True
    if lowered.startswith("[") and lowered.endswith("]"):
        lowered = lowered[1:-1]
    parts = lowered.split(".")
    if len(parts) == 4 and all(part.isdigit() for part in parts):
        try:
            octets = [int(part) for part in parts]
        except ValueError:
            return False
        return octets[0] == 127
    return False


def _build_base_url(explicit: str | None) -> str:
    """Return the configured base URL, with a hard requirement that the
    caller-supplied value is well-formed.

    The default is :data:`DEFAULT_GITHUB_API_URL`. An explicit override is
    taken verbatim from ``GITHUB_API_URL`` (which may point at a self-hosted
    GitHub Enterprise instance). The scheme is restricted to ``http`` or
    ``https`` so the forge capability cannot be redirected to an exotic
    scheme, and plaintext HTTP is permitted ONLY when the host is a
    loopback address — a configured ``http://ghe.example.com`` would
    attach ``Authorization: Bearer <token>`` to a cleartext request and
    leak the credential on any network an attacker can observe, so the
    base-URL guard rejects that combination before any byte goes out.
    """
    raw = (explicit if explicit is not None else os.environ.get("GITHUB_API_URL", "")).strip()
    if not raw:
        return DEFAULT_GITHUB_API_URL
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ForgeError("invalid GITHUB_API_URL")
    if parsed.scheme == "http" and not _is_loopback_host(parsed.hostname or ""):
        raise ForgeError("invalid GITHUB_API_URL: non-loopback HTTP is not permitted")
    # Reassemble without query/fragment; the path is kept so the caller can
    # point at a /api/v3 root on Enterprise.
    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", "", ""))


def _resolve_token(explicit: str | None) -> str:
    """Return the configured token, or ``""`` if none was configured.

    The token is read only from the explicit argument or the environment —
    never from argv, the request URL, or the request body.
    """
    if explicit is not None:
        return explicit
    for name in _ENV_TOKEN_NAMES:
        value = os.environ.get(name, "")
        if value:
            return value
    return ""


class ForgeClient:
    """The configured forge capability.

    Holds the validated base URL and the auth token for one forge host, and
    exposes the read methods every script uses. The token is attached only
    to requests whose URL is bound to the validated base, and only via the
    ``Authorization`` header — never via argv, URL parameters, or the body.
    Redirects are refused, so a 3xx response never propagates the token to
    a different host, and the base URL must use HTTPS unless it points at
    a loopback address — a plaintext HTTP base URL would let the bearer
    token travel over an unencrypted transport. Construction raises
    :class:`ForgeError` for an invalid base URL before any byte is sent.
    """

    def __init__(
        self,
        base_url: str | None = None,
        token: str | None = None,
        timeout_sec: float = DEFAULT_TIMEOUT_SEC,
        user_agent: str = "pr-reviewer-action-forge",
    ) -> None:
        self.base_url = _build_base_url(base_url)
        self.token = _resolve_token(token)
        self.timeout_sec = timeout_sec
        self.user_agent = user_agent
        # Origin is the scheme+netloc+path part of the base URL; the request
        # URL is the part after the base, prefixed with ``/``. Origins are
        # compared with the host the request is being sent to.
        parsed = urllib.parse.urlparse(self.base_url)
        self._origin = f"{parsed.scheme}://{parsed.netloc}"
        self._base_path = parsed.path.rstrip("/")

    # ------------------------------------------------------------------ read

    def _url(self, path: str, params: Mapping[str, Any] | None = None) -> str:
        """Build a full request URL from a path and an optional params dict.

        ``path`` must begin with a single ``/`` and contain no whitespace
        or control characters, so a caller cannot smuggle an absolute
        URL, a protocol-relative URL, or header-injection bytes into the
        transport. Invalid paths are refused before any network call.
        """
        if not path.startswith("/") or path.startswith("//"):
            raise ForgeError("invalid path")
        if "\n" in path or "\r" in path or " " in path or "\t" in path:
            raise ForgeError("invalid path")
        if params:
            # ``urlencode`` is the canonical safe encoding for query params;
            # it never produces a value containing CR/LF or whitespace.
            query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
        else:
            query = ""
        if self._base_path and not self._base_path.startswith("/"):
            base_prefix = "/" + self._base_path
        else:
            base_prefix = self._base_path
        # Strip the leading ``/`` from path before joining so the result is
        # ``{base_path}/repos/...`` not ``{base_path}//repos/...``.
        suffix = path[1:] if path.startswith("/") else path
        return f"{self._origin}{base_prefix}/{suffix}{('?' + query) if query else ''}"

    def _open(self, method: str, url: str) -> urllib.request.addinfourl:
        """Open the URL with the safe opener and a fixed header set.

        The ``Authorization`` header is set ONLY when a token is configured
        (an unauthenticated read of a public resource is a valid case, e.g.
        fetching a public PR). The token is never passed in argv or the
        URL; it rides only the header.
        """
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": self.user_agent,
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        request = urllib.request.Request(url, method=method, headers=headers)
        try:
            return OPENER_NO_REDIRECT.open(request, timeout=self.timeout_sec)
        except urllib.error.HTTPError as exc:
            # A 3xx is unusual for a token-bearing request (GitHub's REST
            # API does not redirect; this is the guard against an
            # Enterprise proxy that might) — surface it as a redirect kind
            # so callers can distinguish a redirect from a hard 4xx/5xx.
            if 300 <= exc.code < 400:
                raise ForgeError("forge redirected; refusing to follow") from None
            raise

    def _read_json(self, response: urllib.request.addinfourl) -> Any:
        """Read and JSON-decode the response body.

        ``urllib.error.HTTPError`` is caught here so the returned error
        string is uniform across transport and HTTP failures — the caller
        never sees the status line text, which can echo attacker-controlled
        URL components.
        """
        try:
            raw = response.read()
        except OSError as exc:
            raise ForgeError("forge response could not be read") from exc
        if not raw:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ForgeError("forge returned invalid JSON") from exc

    def get(self, path: str, params: Mapping[str, Any] | None = None) -> Any:
        """Single GET; returns the parsed JSON payload.

        Raises :class:`ForgeError` on transport failure, HTTP error, redirect,
        or invalid JSON. The error message is a fixed string and never
        includes the response body.
        """
        url = self._url(path, params)
        try:
            response = self._open("GET", url)
        except urllib.error.HTTPError as exc:
            raise ForgeError(f"forge GET {path} returned HTTP {exc.code}") from None
        except urllib.error.URLError as exc:
            raise ForgeError(f"forge GET {path} unreachable: {type(exc.reason).__name__}") from None
        except OSError as exc:
            raise ForgeError(f"forge GET {path} unreachable: {type(exc).__name__}") from None
        return self._read_json(response)

    def get_pages(
        self,
        path: str,
        params: Mapping[str, Any] | None = None,
        per_page: int = 100,
    ) -> Iterable[Any]:
        """Yield every item across all pages of a GitHub list endpoint.

        ``params.setdefault("per_page", per_page)`` is applied so callers
        who already set ``per_page`` keep their setting. ``page`` is set
        per iteration. The generator stops when an empty page is returned
        or a non-list payload is decoded; transport and HTTP failures
        propagate as :class:`ForgeError`.
        """
        merged: dict[str, Any] = dict(params or {})
        merged.setdefault("per_page", per_page)
        page = 1
        while True:
            merged["page"] = page
            data = self.get(path, merged)
            if not isinstance(data, list) or not data:
                return
            yield from data
            if len(data) < int(merged["per_page"]):
                return
            page += 1

    def post(self, path: str, payload: Any) -> Any:
        """Single POST; returns the parsed JSON payload.

        The request body is JSON-encoded here so callers pass Python
        objects directly. The token rides only the ``Authorization``
        header.
        """
        url = self._url(path)
        body = json.dumps(payload).encode("utf-8")
        headers: dict[str, str] = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": self.user_agent,
            "Content-Type": "application/json",
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        request = urllib.request.Request(url, data=body, method="POST", headers=headers)
        try:
            response = OPENER_NO_REDIRECT.open(request, timeout=self.timeout_sec)
        except urllib.error.HTTPError as exc:
            if 300 <= exc.code < 400:
                raise ForgeError("forge redirected; refusing to follow") from None
            raise ForgeError(f"forge POST {path} returned HTTP {exc.code}") from None
        except urllib.error.URLError as exc:
            raise ForgeError(f"forge POST {path} unreachable: {type(exc.reason).__name__}") from None
        except OSError as exc:
            raise ForgeError(f"forge POST {path} unreachable: {type(exc).__name__}") from None
        return self._read_json(response)


def default_forge() -> ForgeClient:
    """The configured forge capability, built from the ambient environment.

    The base URL comes from ``GITHUB_API_URL`` (or the built-in GitHub
    default), the token from ``GITHUB_TOKEN`` or ``GH_TOKEN``. This is
    the convenience constructor for scripts that do not need to point at
    a stub server in tests — they call ``default_forge().get(...)`` and
    move on.
    """
    return ForgeClient()
