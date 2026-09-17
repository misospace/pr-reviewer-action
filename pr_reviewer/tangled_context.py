"""Tangled/Spindle runtime-context normalisation (issue #583).

This module is the platform-seam companion to :mod:`pr_reviewer.platform` for
the Tangled backend. It reads the ``TANGLED_*`` runtime variables Spindle
exports on a CI pipeline, normalises them into the small structured surface
the rest of the reviewer pipeline will need (repository identity, source /
target branch, source SHA, stable knot / appview / bobbin location), and
fails loudly when Tangled is explicitly requested but the runtime is missing
the required signals.

The module is intentionally pure: no XRPC calls, no Bobbin fetches, no
ATProto record I/O. Those land in ``#584`` (Bobbin client + canonical pull
resolver) and ``#587`` (ATProto CI session + record client). Tangled
``PR_NUMBER`` is **not** fabricated here — pull identity is an AT URI / rkey
that arrives with the resolver, and pretending a numeric PR number would be
both wrong and a regression for downstream consumers.

The Tangled runtime variables Spindle sets per
https://docs.tangled.org/spindles.html#environment are:

* Always set on every pipeline:
    ``TANGLED_PIPELINE_ID`` — AT URI of the current pipeline
    ``TANGLED_PIPELINE_KIND`` — ``push`` | ``pull_request`` | ``manual``
    ``TANGLED_REPO_KNOT`` — knot hostname hosting the repo
    ``TANGLED_REPO_DID`` — DID of the repository owner
    ``TANGLED_REPO_NAME`` — name of the repository
    ``TANGLED_REPO_DEFAULT_BRANCH`` — default branch of the repository
    ``TANGLED_REPO_URL`` — full URL to the repository

* Set on ``push`` pipelines:
    ``TANGLED_REF``, ``TANGLED_REF_NAME``, ``TANGLED_REF_TYPE``,
    ``TANGLED_SHA`` / ``TANGLED_COMMIT_SHA``.

* Set on ``pull_request`` pipelines:
    ``TANGLED_PR_SOURCE_BRANCH``, ``TANGLED_PR_TARGET_BRANCH``,
    ``TANGLED_PR_SOURCE_SHA``.

Pull-request identity itself (the canonical AT URI / rkey / CID) is **not**
a runtime variable; the resolver in #584 looks it up via the Bobbin XRPC
endpoint ``sh.tangled.repo.pull``. We therefore do not expose any
``PR_NUMBER`` here — issue #564's child #585 carries the pull identity into
the platform contract. The PR-number env var (``PR_NUMBER``) the rest of the
pipeline reads remains unset in Tangled mode until that work lands; this is
deliberate so a misplaced numeric fallback cannot silently route a Tangled
pull through the GitHub-style code paths.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# Required-vs-optional signal set
# ---------------------------------------------------------------------------
#
# These constants are the single source of truth for which TANGLED_* runtime
# variables are mandatory and which are merely advisory. They are also
# re-exported via ``pr_reviewer.platform._TANGLED_RUNTIME_SIGNALS`` so the
# shell and Python resolvers cannot drift apart. Keep the two definitions in
# sync — the shell mirror lives in ``scripts/platform_api.sh``.

# Minimum runtime identity every Tangled pipeline carries. Without these,
# calling into Tangled is impossible: no repo to look up, no pipeline to
# attribute work to. An explicit ``PLATFORM=tangled`` selection with any of
# these unset raises :class:`TangledContextError`.
TANGLED_REQUIRED_RUNTIME_VARS: tuple[str, ...] = (
    "TANGLED_PIPELINE_ID",
    "TANGLED_REPO_DID",
    "TANGLED_REPO_NAME",
    "TANGLED_REPO_KNOT",
)

# Pull-request-only signals. These are checked only when the pipeline is a
# pull_request event — on a push pipeline they are simply absent, and the
# pull-identity fields on :class:`TangledContext` come back as ``None``.
TANGLED_PR_REQUIRED_RUNTIME_VARS: tuple[str, ...] = (
    "TANGLED_PR_SOURCE_BRANCH",
    "TANGLED_PR_TARGET_BRANCH",
    "TANGLED_PR_SOURCE_SHA",
)

# Broader detection set used by ``tangled_context_or_none`` — mirrors the
# platform resolver's auto-detection rule. A Spindle pipeline exports the
# full required set; the PR-only vars alone are also a strong signal that
# we're under Spindle, so they count toward auto-detection too. Mirrors
# the ``_TANGLED_RUNTIME_SIGNALS`` list in ``pr_reviewer/platform.py`` and
# the ``_TANGLED_RUNTIME_SIGNALS`` array in ``scripts/platform_api.sh``.
_AUTO_DETECT_SIGNALS: tuple[str, ...] = TANGLED_REQUIRED_RUNTIME_VARS + (
    "TANGLED_PIPELINE_KIND",
    "TANGLED_PR_SOURCE_BRANCH",
    "TANGLED_PR_TARGET_BRANCH",
    "TANGLED_PR_SOURCE_SHA",
)

# Optional Bobbin / appview / knot overrides an operator can set in the
# Spindle workflow ``environment`` block. Bobbin serves the read-only XRPC
# appview (see https://docs.tangled.org/bobbin.html); ``BOBBIN_URL`` is the
# only one this module actually reads, since it is the XRPC base the #584
# client will use. The others are accepted so an explicit override is
# surfaced in the resolved context without forcing the caller to re-read
# the env. None of these are required — Spindle's defaults are
# ``https://bobbin.tangled.org`` for the public Bobbin appview.
TANGLED_OPTIONAL_RUNTIME_VARS: tuple[str, ...] = (
    "TANGLED_APPVIEW_URL",
    "TANGLED_BOBBIN_URL",
    "TANGLED_KNOT_URL",
)


class TangledContextError(RuntimeError):
    """Raised when Tangled is explicitly requested but required runtime
    identity is missing from the environment.

    The error message is operator-facing: it lists which variables the
    runtime must export so the failure can be debugged without reading this
    module. The message is intentionally explicit — silently resolving to
    another backend on a missing-context failure is exactly the behaviour
    issue #583 was opened to prevent.
    """


@dataclass(frozen=True)
class TangledContext:
    """Normalised view of the Tangled/Spindle runtime.

    Field semantics mirror the Spindle env-var documentation. ``None`` means
    the runtime did not export the variable; the consumer decides whether
    the field is required for the current pipeline kind.

    The dataclass is frozen so accidental mutation cannot leak across
    reviewer runs. ``pipeline_kind`` is the small enum Spindle exports
    (``push`` / ``pull_request`` / ``manual``) — consumers should branch on
    it rather than guessing from the presence / absence of the PR fields.
    """

    pipeline_id: str
    pipeline_kind: str
    repo_did: str
    repo_name: str
    repo_knot: str
    repo_url: str | None = None
    repo_default_branch: str | None = None
    source_branch: str | None = None
    target_branch: str | None = None
    source_sha: str | None = None
    bobbin_url: str | None = None
    appview_url: str | None = None
    knot_url: str | None = None
    # Operator-supplied extras preserved verbatim so later tickets can
    # surface workflow-level metadata without re-reading ``os.environ``.
    extras: Mapping[str, str] = field(default_factory=dict)

    @property
    def repo_identity(self) -> str:
        """Return ``did/name`` — the canonical Tangled repo identity.

        Tangled is atproto-shaped: the repository owner is a DID, not a
        GitHub-style login. Downstream code that wants a single string for
        logging or for cross-referencing records should use this form. It is
        also the form the Bobbin XRPC client will pass to ``sh.tangled.repo``
        lookups in #584.
        """
        return f"{self.repo_did}/{self.repo_name}"

    @property
    def is_pull_request(self) -> bool:
        """Return True iff this pipeline is a Tangled pull request.

        Equivalent to ``pipeline_kind == "pull_request"`` but spelled out so
        call sites don't have to hardcode the string. ``manual`` and
        ``push`` both return False; consumers needing push-only behaviour
        should check ``pipeline_kind`` directly.
        """
        return self.pipeline_kind == "pull_request"


def _stripped(value: str | None) -> str | None:
    """Return ``value`` stripped of surrounding whitespace, or ``None`` if
    the stripped result is empty.

    Spindle exports env vars verbatim; an operator who sets ``TANGLED_X=''``
    in a workflow ``environment`` block should be treated identically to
    someone who never set the variable at all. ``os.environ.get`` returns
    ``None`` only when the variable is unset — empty-string assignments
    still come back as ``""`` — so this helper collapses both into one.
    """
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def load_tangled_context(env: Mapping[str, str] | None = None) -> TangledContext:
    """Build a :class:`TangledContext` from the current Tangled runtime.

    Parameters
    ----------
    env:
        Optional environment mapping. Defaults to ``os.environ``. The
        override exists for tests; production callers should call with no
        arguments so the live runtime is consulted.

    Returns
    -------
    TangledContext
        A populated context with all required fields set and optional fields
        set to ``None`` when their env var is absent.

    Raises
    ------
    TangledContextError
        When one of the variables in ``TANGLED_REQUIRED_RUNTIME_VARS`` is
        unset or empty. Callers that asked for Tangled explicitly (e.g.
        ``PLATFORM=tangled``) must catch this and surface it as a hard
        failure — falling through to GitHub or Forgejo would silently
        misclassify the runtime.
    """
    src = os.environ if env is None else env

    missing = [
        name for name in TANGLED_REQUIRED_RUNTIME_VARS if not _stripped(src.get(name))
    ]
    if missing:
        raise TangledContextError(
            "PLATFORM=tangled requires the following Spindle runtime "
            f"variables to be set: {', '.join(missing)}. Tangled cannot "
            "be selected without a valid runtime identity; refusing to "
            "fall back to another backend."
        )

    pipeline_kind_raw = _stripped(src.get("TANGLED_PIPELINE_KIND")) or ""
    pipeline_kind = pipeline_kind_raw.lower() or "unknown"

    source_branch = _stripped(src.get("TANGLED_PR_SOURCE_BRANCH"))
    target_branch = _stripped(src.get("TANGLED_PR_TARGET_BRANCH"))
    source_sha = _stripped(src.get("TANGLED_PR_SOURCE_SHA"))

    # A pull_request pipeline must carry the PR-specific variables; a push /
    # manual pipeline legitimately lacks them. We do NOT require them here
    # because non-PR pipelines are valid Tangled runs (e.g. CI on main).
    # Downstream consumers that only run on pull requests should call
    # :meth:`TangledContext.is_pull_request` before reading the PR fields.
    extras: dict[str, str] = {}
    for name in TANGLED_OPTIONAL_RUNTIME_VARS:
        value = _stripped(src.get(name))
        if value is not None:
            extras[name] = value

    return TangledContext(
        pipeline_id=_stripped(src.get("TANGLED_PIPELINE_ID")) or "",
        pipeline_kind=pipeline_kind,
        repo_did=_stripped(src.get("TANGLED_REPO_DID")) or "",
        repo_name=_stripped(src.get("TANGLED_REPO_NAME")) or "",
        repo_knot=_stripped(src.get("TANGLED_REPO_KNOT")) or "",
        repo_url=_stripped(src.get("TANGLED_REPO_URL")),
        repo_default_branch=_stripped(src.get("TANGLED_REPO_DEFAULT_BRANCH")),
        source_branch=source_branch,
        target_branch=target_branch,
        source_sha=source_sha,
        bobbin_url=_stripped(src.get("TANGLED_BOBBIN_URL")),
        appview_url=_stripped(src.get("TANGLED_APPVIEW_URL")),
        knot_url=_stripped(src.get("TANGLED_KNOT_URL")),
        extras=extras,
    )


def tangled_context_or_none(
    env: Mapping[str, str] | None = None,
) -> TangledContext | None:
    """Return a :class:`TangledContext` if Tangled signals are present, else ``None``.

    Convenience wrapper used by ``auto``-resolution callers that want to
    opportunistically pick up Tangled context without forcing it. Mirrors
    ``pr_reviewer.platform._tangled_runtime_signal_present`` for the
    detection rule (any stable ``TANGLED_*`` signal counts) so the
    behaviour lines up exactly with what ``platform_resolve`` uses to
    decide "this is a Tangled runtime"; a partial env with only one or
    two required vars returns ``None`` rather than raising, since the
    explicit-mode error path belongs to :func:`load_tangled_context`.
    Returns ``None`` on missing or partial runtime signals so the caller
    can keep falling through to GitHub / Forgejo detection.
    """
    src = os.environ if env is None else env
    # Use the same broad signal set as the platform resolver, not just the
    # required set: a partial required env (e.g. only TANGLED_PIPELINE_ID
    # set, the rest missing) means the runtime is in a half-configured
    # state and the safe auto-mode action is to fall through, not to raise.
    if not any(src.get(name) for name in _AUTO_DETECT_SIGNALS):
        return None
    try:
        return load_tangled_context(env=src)
    except TangledContextError:
        return None


__all__ = [
    "TANGLED_OPTIONAL_RUNTIME_VARS",
    "TANGLED_PR_REQUIRED_RUNTIME_VARS",
    "TANGLED_REQUIRED_RUNTIME_VARS",
    "TangledContext",
    "TangledContextError",
    "load_tangled_context",
    "tangled_context_or_none",
]
