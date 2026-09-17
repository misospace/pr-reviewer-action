#!/usr/bin/env python3
"""Tests that transport.run_chat_request keeps the API key out of curl argv,
passing it via a 0600 --config file that is removed afterwards."""

import json
import os
import stat
import sys
import types
from pathlib import Path
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent
_SCRIPTS_DIR = _REPO_ROOT / "scripts"
# Both paths: scripts/ for the redact/transport modules' own imports, and the
# repo root so `pr_reviewer` resolves. Previously this came in transitively via
# `import run_tool_harness`; that import was dropped when the test repointed to
# transport directly, so add the root explicitly (CI does not put it on path).
for _p in (str(_SCRIPTS_DIR), str(_REPO_ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import pytest

from pr_reviewer import transport


OPENAI_RESPONSE = json.dumps({"choices": [{"message": {"content": "planned"}}]})


class _Capture:
    def __init__(self):
        self.argv = None
        self.config_path = None
        self.config_content = None
        self.config_mode = None

    def fake_safe_run(self, args, timeout_sec):
        self.argv = list(args)
        if "--config" in args:
            self.config_path = args[args.index("--config") + 1]
            self.config_content = Path(self.config_path).read_text()
            self.config_mode = stat.S_IMODE(os.stat(self.config_path).st_mode)
        return types.SimpleNamespace(returncode=0, stdout=OPENAI_RESPONSE, stderr="")


def _call(api_format="openai", api_key="sk-secret-789"):
    cap = _Capture()
    payload = {
        "model": "m",
        "messages": [{"role": "user", "content": "user"}],
        "max_tokens": 100,
    }
    # The API-key-out-of-argv handling lives in run_chat_request (the production
    # transport primitive); patch safe_run to capture the curl invocation.
    with mock.patch.object(transport, "safe_run", cap.fake_safe_run):
        result = transport.run_chat_request(
            "http://localhost:11434/v1", api_format, payload, api_key, 5
        )
    return cap, result


class TestApiKeyOutOfArgv:
    def test_key_not_in_argv(self):
        cap, result = _call()
        assert result["choices"][0]["message"]["content"] == "planned"
        assert not any("sk-secret-789" in arg for arg in cap.argv)

    def test_config_file_carries_bearer_header(self):
        cap, _ = _call()
        assert cap.config_path is not None
        assert 'header = "Authorization: Bearer sk-secret-789"' in cap.config_content

    def test_anthropic_uses_x_api_key_header(self):
        cap, _ = _call(api_format="anthropic")
        assert 'header = "x-api-key: sk-secret-789"' in cap.config_content
        # The non-secret version header stays in argv.
        assert any("anthropic-version" in arg for arg in cap.argv)
        assert not any("sk-secret-789" in arg for arg in cap.argv)

    def test_config_file_is_0600(self):
        cap, _ = _call()
        assert cap.config_mode == 0o600

    def test_config_file_removed_after_call(self):
        cap, _ = _call()
        assert not Path(cap.config_path).exists()

    def test_no_config_without_key(self):
        cap, _ = _call(api_key="")
        assert "--config" not in cap.argv

    def test_quotes_in_key_are_escaped(self):
        cap, _ = _call(api_key='odd"key')
        assert 'odd\\"key' in cap.config_content


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
