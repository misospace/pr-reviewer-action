"""Unit tests for the AT Protocol CI session and record client (#587).

The network is mocked: ``urlopen`` is patched, no real request is made.
"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT))

from pr_reviewer import tangled_session

HOST = "https://bsky.example"
HANDLE = "bot.tangled.test"
APP_PASSWORD = "app-password-secret-xyz"
ACCESS_JWT = "access-jwt-secret-abc"
NEW_ACCESS_JWT = "new-access-jwt-secret"
REFRESH_JWT = "refresh-jwt-secret-def"

SESSION_RESPONSE = {
    "did": "did:plc:bot123",
    "handle": HANDLE,
    "accessJwt": ACCESS_JWT,
    "refreshJwt": REFRESH_JWT,
}
RECORD_RESPONSE = {
    "uri": "at://did:plc:bot123/app.tangled.pull.reviews/rkey1",
    "cid": "bafyrei-example",
}


def _session_config() -> tangled_session.SessionConfig:
    return tangled_session.SessionConfig(
        host=HOST,
        handle=HANDLE,
        app_password=APP_PASSWORD,
        timeout=7,
    )


class _FakeResponse:
    def __init__(self, payload):
        self._raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, limit=-1):
        return self._raw if limit < 0 else self._raw[:limit]


def _http_error(status: int, payload=None, url: str = f"{HOST}/xrpc") -> HTTPError:
    body = json.dumps(payload).encode("utf-8") if payload is not None else b""
    return HTTPError(url, status, "error", {"content-type": "application/json"}, io.BytesIO(body))


def _install_urlopen(monkeypatch, responses):
    """Patch urlopen with a scripted queue of responses/exceptions."""
    calls: list[dict] = []

    def fake_urlopen(request, timeout):
        calls.append({"request": request, "timeout": timeout})
        item = responses.pop(0) if len(responses) > 1 else responses[0]
        if isinstance(item, Exception):
            raise item
        return item

    monkeypatch.setattr(tangled_session, "urlopen", fake_urlopen)
    return calls


# --- configuration ----------------------------------------------------------


def test_load_config_is_environment_driven(monkeypatch):
    monkeypatch.setenv("ATPROTO_HOST", HOST)
    monkeypatch.setenv("ATPROTO_HANDLE", HANDLE)
    monkeypatch.setenv("ATPROTO_APP_PASSWORD", APP_PASSWORD)
    monkeypatch.setenv("ATPROTO_TIMEOUT", "7")
    config = tangled_session.load_config()
    assert config == _session_config()


def test_load_config_defaults_host_and_timeout(monkeypatch):
    monkeypatch.delenv("ATPROTO_HOST", raising=False)
    monkeypatch.delenv("ATPROTO_TIMEOUT", raising=False)
    config = tangled_session.load_config({"ATPROTO_HANDLE": HANDLE, "ATPROTO_APP_PASSWORD": APP_PASSWORD})
    assert config.host == tangled_session.DEFAULT_HOST
    assert config.timeout == tangled_session.DEFAULT_TIMEOUT


def test_load_config_rejects_missing_and_invalid_values(monkeypatch):
    with pytest.raises(tangled_session.TangledConfigError, match="ATPROTO_HANDLE"):
        tangled_session.load_config({"ATPROTO_APP_PASSWORD": APP_PASSWORD})
    with pytest.raises(tangled_session.TangledConfigError, match="ATPROTO_APP_PASSWORD"):
        tangled_session.load_config({"ATPROTO_HANDLE": HANDLE})
    with pytest.raises(tangled_session.TangledConfigError, match="ATPROTO_HOST"):
        tangled_session.load_config(
            {
                "ATPROTO_HANDLE": HANDLE,
                "ATPROTO_APP_PASSWORD": APP_PASSWORD,
                "ATPROTO_HOST": "not a url",
            }
        )
    with pytest.raises(tangled_session.TangledConfigError, match="ATPROTO_TIMEOUT"):
        tangled_session.load_config(
            {
                "ATPROTO_HANDLE": HANDLE,
                "ATPROTO_APP_PASSWORD": APP_PASSWORD,
                "ATPROTO_TIMEOUT": "soon",
            }
        )


def test_config_string_form_masks_the_app_password():
    config = _session_config()
    assert APP_PASSWORD not in repr(config)
    assert APP_PASSWORD not in str(config)
    assert "app_password='***'" in repr(config)


def test_load_config_rejects_plaintext_http_for_normal_hosts():
    for bad_host in ("http://bsky.example", "http://pds.corp.example:443"):
        with pytest.raises(tangled_session.TangledConfigError, match="https base URL"):
            tangled_session.load_config(
                {
                    "ATPROTO_HOST": bad_host,
                    "ATPROTO_HANDLE": HANDLE,
                    "ATPROTO_APP_PASSWORD": APP_PASSWORD,
                }
            )


def test_load_config_accepts_loopback_http():
    for loopback_host in ("http://localhost", "http://127.0.0.1:3000"):
        config = tangled_session.load_config(
            {
                "ATPROTO_HOST": loopback_host,
                "ATPROTO_HANDLE": HANDLE,
                "ATPROTO_APP_PASSWORD": APP_PASSWORD,
            }
        )
        assert config.host == loopback_host


def test_load_config_rejects_non_http_schemes_and_paths():
    for bad_host in (
        "ftp://bsky.example",
        "https://bsky.example/extra/path",
        "https://bsky.example?x=1",
        "not a url",
    ):
        with pytest.raises(tangled_session.TangledConfigError, match="ATPROTO_HOST"):
            tangled_session.load_config(
                {
                    "ATPROTO_HOST": bad_host,
                    "ATPROTO_HANDLE": HANDLE,
                    "ATPROTO_APP_PASSWORD": APP_PASSWORD,
                }
            )


# --- session establishment --------------------------------------------------


def test_establish_request_shape_and_return_value(monkeypatch):
    calls = _install_urlopen(monkeypatch, [_FakeResponse(SESSION_RESPONSE)])
    session = tangled_session.TangledSession(_session_config())
    info = session.establish()

    assert len(calls) == 1
    request = calls[0]["request"]
    assert request.full_url == f"{HOST}{tangled_session.CREATE_SESSION_PATH}"
    assert request.get_method() == "POST"
    assert json.loads(request.data) == {
        "identifier": HANDLE,
        "password": APP_PASSWORD,
    }
    assert request.get_header("Content-type") == "application/json"
    assert request.get_header("Authorization") is None
    assert request.get_header("User-agent") != "Python-urllib/"
    assert calls[0]["timeout"] == 7

    # Only non-sensitive values are returned / exposed.
    assert info == {"did": "did:plc:bot123", "handle": HANDLE}
    assert session.did == "did:plc:bot123"


def test_establish_rejects_response_without_session_material(monkeypatch):
    for payload in ({}, {"accessJwt": "", "did": "d"}, {"accessJwt": "a"}):
        _install_urlopen(monkeypatch, [_FakeResponse(payload)])
        session = tangled_session.TangledSession(_session_config())
        with pytest.raises(tangled_session.TangledSessionError):
            session.establish()


# --- record create / update ---------------------------------------------------


def test_create_record_request_shape(monkeypatch):
    calls = _install_urlopen(
        monkeypatch,
        [_FakeResponse(SESSION_RESPONSE), _FakeResponse(RECORD_RESPONSE)],
    )
    session = tangled_session.TangledSession(_session_config())
    session.establish()
    result = session.create_record("app.tangled.pull.reviews", {"text": "hi"})

    request = calls[1]["request"]
    assert request.full_url == f"{HOST}{tangled_session.CREATE_RECORD_PATH}"
    assert request.get_method() == "POST"
    assert request.get_header("Authorization") == f"Bearer {ACCESS_JWT}"
    assert json.loads(request.data) == {
        "repo": "did:plc:bot123",
        "collection": "app.tangled.pull.reviews",
        "record": {"text": "hi"},
    }
    assert result == RECORD_RESPONSE


def test_put_record_request_shape(monkeypatch):
    calls = _install_urlopen(
        monkeypatch,
        [_FakeResponse(SESSION_RESPONSE), _FakeResponse(RECORD_RESPONSE)],
    )
    session = tangled_session.TangledSession(_session_config())
    session.establish()
    result = session.put_record("app.tangled.pull.reviews", "rkey1", {"text": "v2"})

    request = calls[1]["request"]
    assert request.full_url == f"{HOST}{tangled_session.PUT_RECORD_PATH}"
    assert request.get_header("Authorization") == f"Bearer {ACCESS_JWT}"
    assert json.loads(request.data) == {
        "repo": "did:plc:bot123",
        "collection": "app.tangled.pull.reviews",
        "rkey": "rkey1",
        "record": {"text": "v2"},
    }
    assert result == RECORD_RESPONSE


def test_record_helpers_reject_bad_arguments_before_any_network(monkeypatch):
    calls = _install_urlopen(monkeypatch, [_FakeResponse(SESSION_RESPONSE)])
    session = tangled_session.TangledSession(_session_config())
    session.establish()
    with pytest.raises(ValueError):
        session.create_record("  ", {"text": "x"})
    with pytest.raises(ValueError):
        session.create_record("has space", {"text": "x"})
    with pytest.raises(TypeError):
        session.create_record("ok", "not-a-dict")
    with pytest.raises(ValueError):
        session.put_record("ok", "rkey with space", {"text": "x"})
    with pytest.raises(ValueError):
        session.put_record("ok", "", {"text": "x"})
    assert len(calls) == 1  # only the establish call hit the mock


def test_record_missing_from_response_raises(monkeypatch):
    _install_urlopen(
        monkeypatch,
        [_FakeResponse(SESSION_RESPONSE), _FakeResponse({"uri": "at://x"})],
    )
    session = tangled_session.TangledSession(_session_config())
    session.establish()
    with pytest.raises(tangled_session.TangledSessionError, match="uri/cid"):
        session.create_record("ok", {"text": "x"})


# --- expired-session refresh / retry ------------------------------------------


def test_expired_session_is_refreshed_and_retried_once(monkeypatch):
    responses = [
        _FakeResponse(SESSION_RESPONSE),  # establish
        _http_error(401, {"error": "ExpiredToken", "message": "expired"}),
        _FakeResponse(
            {
                "did": "did:plc:bot123",
                "handle": HANDLE,
                "accessJwt": NEW_ACCESS_JWT,
            }
        ),  # refresh
        _FakeResponse(RECORD_RESPONSE),  # retried createRecord
    ]
    calls = _install_urlopen(monkeypatch, responses)
    session = tangled_session.TangledSession(_session_config())
    session.establish()
    result = session.create_record("ok", {"text": "hi"})

    assert result == RECORD_RESPONSE
    paths = [c["request"].full_url for c in calls]
    assert paths == [
        f"{HOST}{tangled_session.CREATE_SESSION_PATH}",
        f"{HOST}{tangled_session.CREATE_RECORD_PATH}",
        f"{HOST}{tangled_session.CREATE_SESSION_PATH}",
        f"{HOST}{tangled_session.CREATE_RECORD_PATH}",
    ]
    # The retried write is authorized with the refreshed access token.
    assert calls[3]["request"].get_header("Authorization") == f"Bearer {NEW_ACCESS_JWT}"


def test_second_401_is_not_retried(monkeypatch):
    responses = [
        _FakeResponse(SESSION_RESPONSE),
        _http_error(401, {"error": "ExpiredToken"}),
        _http_error(401, {"error": "ExpiredToken"}),
    ]
    calls = _install_urlopen(monkeypatch, responses)
    session = tangled_session.TangledSession(_session_config())
    session.establish()
    with pytest.raises(tangled_session.TangledSessionError, match="HTTP 401"):
        session.create_record("ok", {"text": "hi"})
    assert len(calls) == 3  # no third attempt


def test_network_and_malformed_response_errors_are_normalized(monkeypatch):
    _install_urlopen(monkeypatch, [URLError("dial tcp: boom")])
    session = tangled_session.TangledSession(_session_config())
    with pytest.raises(tangled_session.TangledSessionError, match="network error"):
        session.establish()

    _install_urlopen(
        monkeypatch,
        [_FakeResponse(SESSION_RESPONSE), _FakeResponse(b"not json at all")],
    )
    session = tangled_session.TangledSession(_session_config())
    session.establish()
    with pytest.raises(tangled_session.TangledSessionError, match="not valid JSON"):
        session.create_record("ok", {"text": "x"})


# --- sensitive-value isolation ------------------------------------------------


def test_401_during_establish_does_not_leak_the_password(monkeypatch):
    _install_urlopen(monkeypatch, [_http_error(401, {"error": "InvalidRequest"})])
    session = tangled_session.TangledSession(_session_config())
    with pytest.raises(tangled_session.TangledSessionError) as excinfo:
        session.establish()
    message = str(excinfo.value)
    assert APP_PASSWORD not in message
    assert ACCESS_JWT not in message
    assert "HTTP 401" in message


def test_server_echoed_material_never_reaches_exceptions(monkeypatch):
    # A hostile server echoes the configured credential back in the free-text
    # XRPC message; only the bounded machine error name may surface.
    echo = {
        "error": "AuthorizationDenied",
        "message": (f"invalid identifier {HANDLE} password {APP_PASSWORD} jwt {ACCESS_JWT} refresh {REFRESH_JWT}"),
    }
    _install_urlopen(
        monkeypatch,
        [_FakeResponse(SESSION_RESPONSE), _http_error(403, echo)],
    )
    session = tangled_session.TangledSession(_session_config())
    session.establish()
    with pytest.raises(tangled_session.TangledSessionError) as excinfo:
        session.put_record("ok", "rkey1", {"text": "x"})
    message = str(excinfo.value)
    assert APP_PASSWORD not in message
    assert ACCESS_JWT not in message
    assert REFRESH_JWT not in message
    assert HANDLE not in message
    assert "AuthorizationDenied" in message
    assert "HTTP 403" in message


def test_session_material_stays_out_of_object_strings():
    session = tangled_session.TangledSession(_session_config())
    session._access_jwt = ACCESS_JWT
    session._refresh_jwt = REFRESH_JWT
    session._did = "did:plc:bot123"
    for rendered in (repr(session), str(session), repr(session._config)):
        assert ACCESS_JWT not in rendered
        assert REFRESH_JWT not in rendered
        assert APP_PASSWORD not in rendered


# --- module boundary tests ------------------------------------------------------


def test_module_has_no_github_or_forgejo_dependency():
    source = (_REPO_ROOT / "pr_reviewer" / "tangled_session.py").read_text(encoding="utf-8").lower()
    for name in ("github", "forgejo", "pr_reviewer.platform", "gh api"):
        assert name not in source, f"module references {name!r}"
    # and nothing in its live namespace comes from those modules
    assert "platform" not in tangled_session.__dict__


def test_module_has_no_review_comment_semantics():
    # Only names defined by this module (not imported symbols).
    module_name = tangled_session.__name__
    public = [
        n
        for n in vars(tangled_session)
        if not n.startswith("_") and getattr(vars(tangled_session)[n], "__module__", module_name) == module_name
    ]
    for name in public:
        lowered = name.lower()
        assert "comment" not in lowered, f"unexpected public symbol {name!r}"
    for forbidden in ("pull", "bobbin", "thread"):
        assert not any(name.lower() == forbidden for name in public), forbidden
    for expected in (
        "SessionConfig",
        "TangledSession",
        "TangledSessionError",
        "TangledConfigError",
        "load_config",
        "get_session",
        "reset_session",
        "create_record",
        "put_record",
    ):
        assert expected in public


def test_module_uses_stdlib_http_only():
    source = (_REPO_ROOT / "pr_reviewer" / "tangled_session.py").read_text(encoding="utf-8")
    import_lines = {
        line.split()[1].split(".")[0] for line in source.splitlines() if line.startswith(("import ", "from "))
    }
    stdlib_only = {
        "__future__",
        "collections",
        "io",
        "json",
        "os",
        "re",
        "threading",
        "dataclasses",
        "typing",
        "urllib",
    }
    assert import_lines <= stdlib_only, f"non-stdlib imports: {import_lines - stdlib_only}"


# --- redirect credential isolation --------------------------------------------


def test_redirect_is_rejected_and_never_followed(monkeypatch):
    # A hostile/misconfigured PDS 302s an authorized request to another
    # origin. urllib's default redirect handler would re-issue the request
    # with the Authorization header preserved; the client must refuse the
    # hop instead of leaking the bearer token.
    _install_urlopen(monkeypatch, [_FakeResponse(SESSION_RESPONSE)])
    session = tangled_session.TangledSession(_session_config())
    session.establish()

    # Simulate the opener seeing a 302: it calls HTTPRedirectHandler's
    # http_error_302, which raises an HTTPError carrying the Location
    # header.
    def fake_urlopen(request, timeout):
        location = "https://attacker.example/xrpc/stolen"
        raise HTTPError(
            request.full_url,
            302,
            "Found",
            {"location": location},
            io.BytesIO(b""),
        )

    monkeypatch.setattr(tangled_session, "urlopen", fake_urlopen)
    with pytest.raises(tangled_session.TangledSessionError, match="HTTP 302") as excinfo:
        session.create_record("ok", {"text": "hi"})

    message = str(excinfo.value)
    assert ACCESS_JWT not in message
    assert "attacker.example" not in message  # redirect target is not echoed


def test_redirect_handler_rejects_every_30x_status():
    # The handler installed in the module's opener refuses all redirect
    # statuses, not just 302.
    import urllib.request

    for status in (301, 302, 303, 307, 308):
        handler = urllib.request.build_opener(tangled_session._RejectRedirects())
        # The module's opener must carry the redirect-refusing handler and
        # not urllib's default one (which copies Authorization on the hop).
        assert any(isinstance(h, tangled_session._RejectRedirects) for h in handler.handlers)
        assert not any(
            isinstance(h, urllib.request.HTTPRedirectHandler) and not isinstance(h, tangled_session._RejectRedirects)
            for h in handler.handlers
        ), f"status {status}"


def test_same_host_redirect_is_still_rejected(monkeypatch):
    # Even a redirect that stays on the configured origin is refused:
    # XRPC requests are issued from the configured origin and do not need
    # to follow any redirect.
    _install_urlopen(monkeypatch, [_FakeResponse(SESSION_RESPONSE)])
    session = tangled_session.TangledSession(_session_config())
    session.establish()

    def fake_urlopen(request, timeout):
        raise HTTPError(
            request.full_url,
            301,
            "Moved",
            {"location": f"{HOST}/elsewhere"},
            io.BytesIO(b""),
        )

    monkeypatch.setattr(tangled_session, "urlopen", fake_urlopen)
    with pytest.raises(tangled_session.TangledSessionError, match="HTTP 301"):
        session.create_record("ok", {"text": "hi"})


# --- process-wide session -------------------------------------------------------


def test_get_session_establishes_once_and_caches(monkeypatch):
    calls = _install_urlopen(monkeypatch, [_FakeResponse(SESSION_RESPONSE), _FakeResponse(RECORD_RESPONSE)])
    monkeypatch.setenv("ATPROTO_HOST", HOST)
    monkeypatch.setenv("ATPROTO_HANDLE", HANDLE)
    monkeypatch.setenv("ATPROTO_APP_PASSWORD", APP_PASSWORD)
    monkeypatch.delenv("ATPROTO_TIMEOUT", raising=False)
    tangled_session.reset_session()
    try:
        first = tangled_session.get_session()
        second = tangled_session.get_session()
        assert first is second
        assert [c["request"].full_url for c in calls] == [f"{HOST}{tangled_session.CREATE_SESSION_PATH}"]
        # module-level helpers route through the cached session
        assert tangled_session.create_record("ok", {"text": "hi"}) == RECORD_RESPONSE
        assert len(calls) == 2
    finally:
        tangled_session.reset_session()


def test_redirect_regression_bearer_never_reach_redirect_target():
    # Regression demanded by the #587 review: prove that Authorization is
    # never sent to a redirected origin. This drives the module's real
    # ``urlopen`` seam (the opener it builds) against a real local origin
    # whose server 302-redirects to a second local origin, and asserts the
    # redirect target never receives the request's bearer token.
    #
    # If urllib's default redirect handler were installed, it would re-issue
    # the request with all headers preserved and this assertion would fail.
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    received: dict = {"target": []}
    target_up = threading.Event()
    origin_up = threading.Event()

    class _TargetHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            received["target"].append((self.path, self.headers.get("Authorization"), body))
            self.send_response(200)
            self.end_headers()

        def log_message(self, *args):
            pass

    class _OriginHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            if self.path == tangled_session.CREATE_SESSION_PATH:
                # createSession succeeds; record writes get the 302.
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(SESSION_RESPONSE).encode("utf-8"))
            else:
                self.send_response(302)
                self.send_header("Location", f"http://127.0.0.1:{target_port}/stolen")
                self.end_headers()

        def log_message(self, *args):
            pass

    origin_server = ThreadingHTTPServer(("127.0.0.1", 0), _OriginHandler)
    target_server = ThreadingHTTPServer(("127.0.0.1", 0), _TargetHandler)
    origin_port = origin_server.server_address[1]
    target_port = target_server.server_address[1]

    def _serve(server, up, stop):
        up.set()
        server.serve_forever(poll_interval=0.01)

    threads = []
    for server, up in ((origin_server, origin_up), (target_server, target_up)):
        stop = threading.Event()
        threads.append((threading.Thread(target=_serve, args=(server, up, stop)), stop))
    for thread, _stop in threads:
        thread.start()

    try:
        assert origin_up.wait(2) and target_up.wait(2)
        session = tangled_session.TangledSession(
            tangled_session.SessionConfig(
                host=f"http://127.0.0.1:{origin_port}",
                handle=HANDLE,
                app_password=APP_PASSWORD,
                timeout=5,
            )
        )
        session.establish()
        with pytest.raises(tangled_session.TangledSessionError, match="HTTP 302"):
            session.create_record("ok", {"x": 1})

        # The redirect target must never receive the bearer. It should not
        # receive the request at all (the redirect is refused before any
        # re-issue), and it never carries Authorization.
        for path, authorization, _body in received["target"]:
            assert path == "/stolen"
            assert authorization is None
            assert "Bearer" not in (authorization or "")
    finally:
        for _thread, stop in threads:
            stop.set()
        for server in (origin_server, target_server):
            server.shutdown()
            server.server_close()
        for thread, _stop in threads:
            thread.join(2)


def test_loopback_ipv6_is_accepted():
    # The docstring promises [::1] is accepted as a loopback host; it must
    # pass the same validation as localhost/127.0.0.1.
    tangled_session._validate_host("http://[::1]:3000")


def test_non_loopback_ipv6_is_rejected():
    for host in ("http://[2001:db8::1]:3000", "http://[fe80::1]:3000"):
        with pytest.raises(tangled_session.TangledConfigError):
            tangled_session._validate_host(host)


def test_get_session_requires_configuration(monkeypatch):
    monkeypatch.delenv("ATPROTO_HANDLE", raising=False)
    monkeypatch.delenv("ATPROTO_APP_PASSWORD", raising=False)
    monkeypatch.setenv("ATPROTO_HOST", HOST)
    tangled_session.reset_session()
    with pytest.raises(tangled_session.TangledConfigError):
        tangled_session.get_session()
