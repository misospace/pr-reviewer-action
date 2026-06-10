#!/usr/bin/env python3
"""Tests that run_tool_harness.run_chat_completion keeps the API key out of
curl argv, passing it via a 0600 --config file that is removed afterwards."""

import json
import os
import stat
import sys
import types
from pathlib import Path
from unittest import mock

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import pytest

import run_tool_harness as rth


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
    with mock.patch.object(rth, "safe_run", cap.fake_safe_run):
        result = rth.run_chat_completion(
            base_url="http://localhost:11434/v1",
            api_format=api_format,
            model="m",
            api_key=api_key,
            system_prompt="sys",
            user_prompt="user",
            timeout_sec=5,
            max_tokens=100,
        )
    return cap, result


class TestApiKeyOutOfArgv:
    def test_key_not_in_argv(self):
        cap, result = _call()
        assert result == "planned"
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
