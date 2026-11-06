"""Credential-safe handling of command line arguments.

A secret in an argument list is visible to every other process on the host, so
the judge runners read the judge key from the environment only. An argument
the runner does not know is refused without being echoed, because an argument
the operator mistyped may be a credential.
"""
from __future__ import annotations

import argparse
import sys
from typing import NoReturn


def _option_name(argument: str) -> str:
    """Return the option name of an argv element, without its value."""
    return argument.split("=", 1)[0]


def _matching_credential_flag(
    option_name: str, credential_flags: tuple[str, ...]
) -> str | None:
    """Return the credential flag the option name names, or None.

    argparse accepted every unambiguous abbreviation of a long option before
    the option was removed, so an abbreviation must be refused as well. The
    rule is the one the eval harness guard in scripts/eval_harness.py uses.
    """
    for flag in credential_flags:
        if option_name == flag:
            return flag
        if len(option_name) > 2 and flag.startswith(option_name):
            return flag
    return None


def _credential_refusal_text(flag: str, credential_env: str) -> str:
    """Return the refusal message for one credential flag."""
    return (
        f"Error: {flag} must not be passed as an argument. "
        "A secret in an argument list is visible to every process "
        f"on the host. Set {credential_env} in the environment and "
        "run the script again."
    )


def credential_argument_refusal(
    arguments: list[str],
    *,
    credential_flags: tuple[str, ...],
    credential_env: str,
) -> str | None:
    """Return the refusal message when an argument names a credential flag.

    Every argument is checked, not only the ones the parser rejects, so the
    refusal comes before argparse can report an error that quotes a value.
    """
    for argument in arguments:
        flag = _matching_credential_flag(_option_name(argument), credential_flags)
        if flag is not None:
            return _credential_refusal_text(flag, credential_env)
    return None


def refusal_for_unrecognized_arguments(
    extras: list[str],
    *,
    credential_flags: tuple[str, ...],
    credential_env: str,
) -> str | None:
    """Return the refusal message for argv elements the parser does not know.

    Every unrecognized argument is refused here instead of by argparse,
    because argparse's own "unrecognized arguments" message echoes the value.
    Only option names are reported, never a value, so the refusal stays safe
    to log even when the secret itself was already typed on the command line.
    """
    if not extras:
        return None
    refusal = credential_argument_refusal(
        extras, credential_flags=credential_flags, credential_env=credential_env
    )
    if refusal is not None:
        return refusal
    count = len(extras)
    noun = "argument" if count == 1 else "arguments"
    return (
        f"Error: the script refuses {count} unrecognized {noun}. "
        "An unrecognized argument can carry a secret, so the script does not "
        "echo it. Run the script with --help to list the accepted flags."
    )


class ValueSafeArgumentParser(argparse.ArgumentParser):
    """An argument parser whose error message never quotes an argv value.

    argparse's own error message can quote the value of an option, for
    example "invalid int value: 'sk-...'". An operator who types a secret
    into the wrong option would then see the secret in the terminal and in
    the CI log. This parser reports the problem without the value.
    """

    def error(self, message: str) -> NoReturn:
        self.print_usage(sys.stderr)
        print(
            "Error: the command line is not valid. Run the script with "
            "--help to list the accepted flags.",
            file=sys.stderr,
        )
        raise SystemExit(2)
