"""Tests for pr_reviewer/credential_argv.py (#1413 credential-free argv).

A secret in an argument list is visible to every other process on the host, so
the judge runners read the judge key from the environment only and refuse an
argument they do not know without echoing it.
"""
from __future__ import annotations

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import pytest  # noqa: E402

from pr_reviewer.credential_argv import (  # noqa: E402
    ValueSafeArgumentParser,
    credential_argument_refusal,
    refusal_for_unrecognized_arguments,
)

CREDENTIAL_REFUSAL = (
    "Error: --api-key must not be passed as an argument. "
    "A secret in an argument list is visible to every process on the host. "
    "Set JUDGE_API_KEY in the environment and run the script again."
)
GENERIC_REFUSAL = (
    "Error: the script refuses 1 unrecognized argument. "
    "An unrecognized argument can carry a secret, so the script does not "
    "echo it. Run the script with --help to list the accepted flags."
)
SECRET = "sk-secret-value"


def _refusal(extras: list[str]) -> str | None:
    return refusal_for_unrecognized_arguments(
        extras,
        credential_flags=("--api-key",),
        credential_env="JUDGE_API_KEY",
    )


def test_no_extras_is_no_refusal() -> None:
    assert _refusal([]) is None


def test_exact_credential_flag_is_refused() -> None:
    message = _refusal(["--api-key", SECRET])
    assert message == CREDENTIAL_REFUSAL


def test_credential_flag_with_equals_form_is_refused() -> None:
    message = _refusal([f"--api-key={SECRET}"])
    assert message == CREDENTIAL_REFUSAL


@pytest.mark.parametrize("abbreviation", ["--api", "--api-k", "--api-ke"])
def test_credential_flag_abbreviation_is_refused(abbreviation: str) -> None:
    message = _refusal([abbreviation, SECRET])
    assert message == CREDENTIAL_REFUSAL


def test_short_prefix_is_still_refused_as_the_credential_flag() -> None:
    # argparse accepted every unambiguous abbreviation of the removed option,
    # so a short prefix such as "--a" names the credential flag as well.
    message = _refusal(["--a", SECRET])
    assert message == CREDENTIAL_REFUSAL


def test_unrelated_extra_gets_the_generic_refusal() -> None:
    message = _refusal(["--mystery-flag", SECRET])
    assert message is not None
    assert "refuses 2 unrecognized arguments" in message


def test_generic_refusal_counts_the_refused_arguments() -> None:
    message = _refusal(["--mystery-flag"])
    assert message == GENERIC_REFUSAL


def test_generic_refusal_uses_the_singular_for_one_argument() -> None:
    message = _refusal(["--mystery-flag"])
    assert message is not None
    assert "1 unrecognized argument." in message
    assert "1 unrecognized arguments" not in message


@pytest.mark.parametrize(
    "extras",
    [
        ["--api-key", SECRET],
        [f"--api-key={SECRET}"],
        ["--api-k", SECRET],
        ["--api", SECRET],
        ["--mystery-flag", SECRET],
        [SECRET],
    ],
)
def test_no_refusal_ever_echoes_a_value(extras: list[str]) -> None:
    message = _refusal(extras)
    assert message is not None
    assert SECRET not in message


# ── the pre-scan over the whole argument list ───────────────────────────────


def test_credential_refusal_finds_the_flag_in_a_full_argument_list() -> None:
    message = credential_argument_refusal(
        ["--corpus", "c.json", "--api-key", SECRET],
        credential_flags=("--api-key",),
        credential_env="JUDGE_API_KEY",
    )
    assert message == CREDENTIAL_REFUSAL


def test_credential_refusal_ignores_a_list_without_a_credential_flag() -> None:
    assert credential_argument_refusal(
        ["--corpus", "c.json", "--timeout", "30"],
        credential_flags=("--api-key",),
        credential_env="JUDGE_API_KEY",
    ) is None


def test_credential_refusal_never_echoes_a_value() -> None:
    message = credential_argument_refusal(
        ["--api-key", SECRET],
        credential_flags=("--api-key",),
        credential_env="JUDGE_API_KEY",
    )
    assert message is not None
    assert SECRET not in message


# ── the value-safe parser ────────────────────────────────────────────────────


def test_parser_error_does_not_quote_the_value(
    capsys: pytest.CaptureFixture[str],
) -> None:
    parser = ValueSafeArgumentParser(prog="judge", add_help=False)
    parser.add_argument("--count", type=int)
    with pytest.raises(SystemExit) as excinfo:
        parser.parse_args(["--count", SECRET])
    assert excinfo.value.code == 2
    err = capsys.readouterr().err
    assert SECRET not in err
    assert "command line is not valid" in err


def test_parser_error_still_names_the_options(
    capsys: pytest.CaptureFixture[str],
) -> None:
    parser = ValueSafeArgumentParser(prog="judge", add_help=False)
    parser.add_argument("--count", type=int)
    with pytest.raises(SystemExit):
        parser.parse_args(["--count", SECRET])
    err = capsys.readouterr().err
    assert "--count" in err
