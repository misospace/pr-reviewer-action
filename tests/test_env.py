"""Tests for pr_reviewer.env helpers."""

import os

from pr_reviewer.env import env_int


def test_env_int_default_when_unset():
    name = "_TEST_ENV_INT_UNSET"
    os.environ.pop(name, None)
    assert env_int(name, default=5) == 5


def test_env_int_min_value_clamps_default():
    name = "_TEST_ENV_INT_CLAMP"
    os.environ.pop(name, None)
    # min_value > default => clamped to min_value
    assert env_int(name, default=0, min_value=3) == 3


def test_env_int_reads_value():
    name = "_TEST_ENV_INT_VALUE"
    os.environ[name] = "42"
    try:
        assert env_int(name, default=5) == 42
    finally:
        del os.environ[name]


def test_env_int_clamps_to_min():
    name = "_TEST_ENV_INT_MIN"
    os.environ[name] = "0"
    try:
        assert env_int(name, default=5, min_value=1) == 1
    finally:
        del os.environ[name]


def test_env_int_falls_back_on_bad_value():
    name = "_TEST_ENV_INT_BAD"
    os.environ[name] = "not-a-number"
    try:
        assert env_int(name, default=7) == 7
    finally:
        del os.environ[name]
