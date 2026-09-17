"""CI-safe AT Protocol (XRPC) session and record client for Tangled.

The Tangled publish path talks to AT Protocol records. This module is the
small client the publish scripts need:

- establish one bot session per process from environment configuration
  (``ATPROTO_HOST``, ``ATPROTO_HANDLE``, ``ATPROTO_APP_PASSWORD``,
  ``ATPROTO_TIMEOUT``) so Spindle can inject private configuration at
  runtime;
- expose narrow helpers to create and update the bot's own records;
- centralize request headers, timeouts, and HTTP/XRPC error
  normalization, including refresh-and-retry when the server reports an
  expired session (HTTP 401).

Isolation guarantees (issue #587):

- Session/access material (the app password, the access JWT, the refresh
  JWT) lives in process memory only: it is never written to disk, never
  logged, and never appears in exception messages. This module performs
  no logging at all.
- Requests are TLS-only in production: ``ATPROTO_HOST`` must be ``https``
  for every host except loopback, which is accepted solely so local test
  and development PDS instances can be pointed at.
- Redirects are never followed. Python's default redirect handler copies
  request headers — including ``Authorization`` — onto the redirected
  request, so a redirect from the configured server (misconfigured or
  hostile) would hand the bot's session bearer token to the redirect
  target. AT Protocol XRPC endpoints are served from the configured
  origin, so a redirect is treated as a failure.
- Standard-library HTTP only (``urllib``); no third-party dependency.
- No dependency on this repo's platform-seam modules.
- No Tangled pull, Bobbin, or managed-message lookup semantics: this
  client only creates and updates records for the session's own account
  and knows nothing about how a message is represented.
"""

from __future__ import annotations

import io
import json
import os
import re
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

DEFAULT_HOST = "https://bsky.social"
DEFAULT_TIMEOUT = 30
MAX_RESPONSE_BYTES = 1_000_000

USER_AGENT = "ai-pr-reviewer/1.0"

CREATE_SESSION_PATH = "/xrpc/com.atproto.server.createSession"
CREATE_RECORD_PATH = "/xrpc/com.atproto.repo.createRecord"
PUT_RECORD_PATH = "/xrpc/com.atproto.repo.putRecord"

# Plaintext http is accepted for these hosts only (local PDS instances).
LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})

_XRPC_ERROR_CODE_RE = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{0,63}")


class _RejectRedirects(HTTPRedirectHandler):
    """Refuse every 30x instead of following it.

    Subclassing :class:`~urllib.request.HTTPRedirectHandler` (and passing
    the instance to ``build_opener``) replaces urllib's default handler,
    which would re-issue the request to the redirect target with all
    headers preserved — leaking the ``Authorization`` bearer token to any
    origin the configured server points at.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # The HTTPError raised here is what the XRPC layer sees: it carries
        # only the original URL and the status, never the redirect target,
        # and its body is an empty file-like object so response-body
        # normalization can read it. The request is never re-issued to
        # ``newurl``.
        raise HTTPError(req.full_url, code, msg, headers, io.BytesIO(b""))


_OPENER = build_opener(_RejectRedirects())


def _urlopen(request: Request, timeout: int):
    return _OPENER.open(request, timeout=timeout)


urlopen = _urlopen  # name preserved: it is the single seam tests patch


class TangledSessionError(RuntimeError):
    """Raised when an AT Protocol session or record operation fails.

    Messages are normalized and never include the configured
    credentials, the handle, or session material returned by the server.
    """


class TangledConfigError(TangledSessionError):
    """Raised when the environment lacks usable session configuration."""


@dataclass(frozen=True)
class SessionConfig:
    """Environment-driven session configuration.

    The app password is the only sensitive field; the string form of a
    config masks it.
    """

    host: str
    handle: str
    app_password: str
    timeout: int

    def __repr__(self) -> str:
        return f"SessionConfig(host={self.host!r}, handle={self.handle!r}, app_password='***', timeout={self.timeout})"

    __str__ = __repr__


def _validate_host(host: str) -> None:
    """Validate an ``ATPROTO_HOST`` base URL.

    The host must be an ``http(s)`` base URL with a syntactically valid
    hostname and no path or query. Plaintext ``http`` is rejected except
    for loopback hosts (localhost / 127.0.0.1 / ::1), which exist for
    local test and development PDS instances: production AT Protocol
    servers are always TLS, and a plaintext endpoint would carry the
    app password and session bearer tokens unencrypted.
    """
    try:
        parts = urlsplit(host)
    except ValueError:
        raise TangledConfigError("ATPROTO_HOST must be a valid http(s) base URL") from None
    if parts.scheme == "http" and (parts.hostname or "").lower() not in LOOPBACK_HOSTS:
        raise TangledConfigError(
            "ATPROTO_HOST must be an https base URL; plaintext http is accepted for loopback hosts only"
        )
    if parts.scheme not in ("http", "https"):
        raise TangledConfigError("ATPROTO_HOST must be an http(s) base URL")
    hostname = (parts.hostname or "").lower()
    if not hostname:
        raise TangledConfigError("ATPROTO_HOST must include a hostname")
    # Bare IPv6 literals (e.g. [::1]) are only accepted when they are
    # loopback; everything else must match the ordinary hostname shape.
    if hostname not in LOOPBACK_HOSTS and not re.fullmatch(
        r"(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*",
        hostname,
    ):
        raise TangledConfigError("ATPROTO_HOST has an invalid hostname")
    if parts.path not in ("", "/") or parts.query or parts.fragment:
        raise TangledConfigError("ATPROTO_HOST must be a base URL without a path")


def load_config(env: Mapping[str, str] | None = None) -> SessionConfig:
    """Build a :class:`SessionConfig` from environment variables.

    Spindle injects these at runtime; this function never reads files.
    """
    if env is None:
        env = os.environ
    host = (env.get("ATPROTO_HOST") or DEFAULT_HOST).strip().rstrip("/")
    _validate_host(host)
    handle = (env.get("ATPROTO_HANDLE") or "").strip()
    if not handle:
        raise TangledConfigError("ATPROTO_HANDLE is required")
    if any(ch.isspace() for ch in handle):
        raise TangledConfigError("ATPROTO_HANDLE must not contain whitespace")
    app_password = env.get("ATPROTO_APP_PASSWORD") or ""
    if not app_password:
        raise TangledConfigError("ATPROTO_APP_PASSWORD is required")
    raw_timeout = (env.get("ATPROTO_TIMEOUT") or "").strip()
    timeout = DEFAULT_TIMEOUT
    if raw_timeout:
        try:
            timeout = max(1, int(raw_timeout))
        except ValueError:
            raise TangledConfigError("ATPROTO_TIMEOUT must be an integer number of seconds") from None
    return SessionConfig(host=host, handle=handle, app_password=app_password, timeout=timeout)


def _safe_xrpc_error_code(http_error: HTTPError) -> str | None:
    """Extract the server's short machine error name, best effort.

    Only the bounded ``error`` name is taken from the body. Free-text
    ``message`` fields are never surfaced, so a hostile server cannot
    echo configured material back into our exception strings.
    """
    try:
        payload = json.loads(http_error.read(4096))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    code = payload.get("error")
    if isinstance(code, str) and _XRPC_ERROR_CODE_RE.fullmatch(code):
        return code
    return None


def _describe_failure(path: str, status: int, code: str | None) -> str:
    detail = f"HTTP {status}"
    if code:
        detail += f" (XRPC error {code})"
    return f"ATProto XRPC {path} failed: {detail}"


def _validate_collection(collection: str) -> str:
    if not isinstance(collection, str) or not collection.strip() or len(collection) > 512:
        raise ValueError("collection must be a non-empty string of at most 512 characters")
    if any(ch.isspace() or ord(ch) < 0x20 for ch in collection):
        raise ValueError("collection must not contain whitespace or control characters")
    return collection


def _validate_rkey(rkey: str) -> str:
    if not isinstance(rkey, str) or not rkey.strip() or len(rkey) > 255:
        raise ValueError("rkey must be a non-empty string of at most 255 characters")
    if any(ch.isspace() or ord(ch) < 0x20 for ch in rkey):
        raise ValueError("rkey must not contain whitespace or control characters")
    return rkey


def _validate_record(record: Any) -> dict[str, Any]:
    if not isinstance(record, dict):
        raise TypeError("record must be a JSON object")
    return record


def _require_record_result(data: dict[str, Any], path: str) -> dict[str, Any]:
    uri = data.get("uri")
    cid = data.get("cid")
    if not isinstance(uri, str) or not uri or not isinstance(cid, str) or not cid:
        raise TangledSessionError(f"ATProto XRPC {path} response did not include a record uri/cid")
    return data


class TangledSession:
    """One AT Protocol session for a CI bot account.

    Session material (app password, access JWT, refresh JWT) is held in
    instance attributes only: never written anywhere, and excluded from
    the string form of the object.
    """

    def __init__(self, config: SessionConfig):
        self._config = config
        self._access_jwt: str | None = None
        self._refresh_jwt: str | None = None
        self._did: str | None = None

    @property
    def did(self) -> str:
        """The session account's DID (the ``repo`` for record writes)."""
        if self._did is None:
            raise TangledSessionError("session not established; call establish() first")
        return self._did

    def establish(self) -> dict[str, str]:
        """Create a server session (``com.atproto.server.createSession``).

        Returns only the non-sensitive ``did``/``handle``. Call again to
        refresh an expired session.
        """
        payload = {
            "identifier": self._config.handle,
            "password": self._config.app_password,
        }
        try:
            data = self._xrpc_post(CREATE_SESSION_PATH, payload, authorized=False)
        except TangledSessionError as exc:
            raise TangledSessionError(f"ATProto session establishment failed: {exc}") from exc
        access_jwt = data.get("accessJwt")
        if not isinstance(access_jwt, str) or not access_jwt:
            raise TangledSessionError("ATProto session response did not include an access token")
        did = data.get("did")
        if not isinstance(did, str) or not did:
            raise TangledSessionError("ATProto session response did not include a did")
        refresh_jwt = data.get("refreshJwt")
        self._access_jwt = access_jwt
        self._refresh_jwt = refresh_jwt if isinstance(refresh_jwt, str) else None
        self._did = did
        handle = data.get("handle")
        return {
            "did": did,
            "handle": handle if isinstance(handle, str) else self._config.handle,
        }

    def create_record(self, collection: str, record: dict[str, Any]) -> dict[str, Any]:
        """Create a record in the session account's repository.

        Returns the server's result (``uri``/``cid``).
        """
        collection = _validate_collection(collection)
        _validate_record(record)
        data = self._xrpc_post(
            CREATE_RECORD_PATH,
            {"repo": self.did, "collection": collection, "record": record},
        )
        return _require_record_result(data, CREATE_RECORD_PATH)

    def put_record(self, collection: str, rkey: str, record: dict[str, Any]) -> dict[str, Any]:
        """Replace an existing record by its rkey.

        Returns the server's result (``uri``/``cid``).
        """
        collection = _validate_collection(collection)
        rkey = _validate_rkey(rkey)
        _validate_record(record)
        data = self._xrpc_post(
            PUT_RECORD_PATH,
            {
                "repo": self.did,
                "collection": collection,
                "rkey": rkey,
                "record": record,
            },
        )
        return _require_record_result(data, PUT_RECORD_PATH)

    def _xrpc_post(
        self,
        path: str,
        payload: dict[str, Any],
        *,
        authorized: bool = True,
        _retried: bool = False,
    ) -> dict[str, Any]:
        headers = {
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        }
        if authorized:
            if self._access_jwt is None:
                raise TangledSessionError("session not established")
            headers["Authorization"] = f"Bearer {self._access_jwt}"
        request = Request(
            self._config.host + path,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            method="POST",
            headers=headers,
        )
        try:
            with urlopen(request, timeout=self._config.timeout) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
        except HTTPError as exc:
            code = _safe_xrpc_error_code(exc)
            if exc.code == 401 and authorized and not _retried:
                # The server says the session is expired/invalid: refresh
                # exactly once and retry the original request.
                self.establish()
                return self._xrpc_post(path, payload, authorized=True, _retried=True)
            raise TangledSessionError(_describe_failure(path, exc.code, code)) from None
        except (URLError, TimeoutError, OSError) as exc:
            raise TangledSessionError(f"ATProto request to {self._config.host} failed: network error") from exc
        if len(raw) > MAX_RESPONSE_BYTES:
            raise TangledSessionError(f"ATProto response to {path} exceeded the size limit")
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise TangledSessionError(f"ATProto response to {path} was not valid JSON") from exc
        if not isinstance(data, dict):
            raise TangledSessionError(f"ATProto response to {path} was not a JSON object")
        return data

    def __repr__(self) -> str:
        state = "established" if self._access_jwt is not None else "unestablished"
        return f"TangledSession(host={self._config.host!r}, did={self._did!r}, state={state})"

    __str__ = __repr__


_session: TangledSession | None = None
_session_lock = threading.Lock()


def get_session() -> TangledSession:
    """Return the process-wide session, establishing it on first use."""
    global _session
    with _session_lock:
        if _session is None:
            session = TangledSession(load_config())
            session.establish()
            _session = session
        return _session


def reset_session() -> None:
    """Drop the cached session (test hook)."""
    global _session
    with _session_lock:
        _session = None


def create_record(collection: str, record: dict[str, Any]) -> dict[str, Any]:
    """Create a record using the process-wide session."""
    return get_session().create_record(collection, record)


def put_record(collection: str, rkey: str, record: dict[str, Any]) -> dict[str, Any]:
    """Replace a record using the process-wide session."""
    return get_session().put_record(collection, rkey, record)
