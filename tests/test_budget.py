"""Tests for pr_reviewer.budget helpers."""

import os
import time

from pr_reviewer.budget import BudgetTracker, DeadlineBudget


def test_budget_tracker_ok_within_budget():
    tracker = BudgetTracker(max_seconds=60)
    assert tracker.ok() is True


def test_budget_tracker_exceeded():
    tracker = BudgetTracker(max_seconds=0)
    # max_seconds=0 means budget already exceeded
    tracker.ok()  # triggers warning
    assert tracker.ok() is False


def test_deadline_budget_disabled():
    db = DeadlineBudget(max_seconds=0)
    assert db.deadline is None
    assert db.exceeded() is False


def test_deadline_budget_negative():
    db = DeadlineBudget(max_seconds=-1)
    assert db.deadline is None
    assert db.exceeded() is False


def test_deadline_budget_positive():
    db = DeadlineBudget(max_seconds=60)
    assert db.deadline is not None
    assert db.exceeded() is False


def test_deadline_budget_from_env_default():
    name = "_TEST_DEADLINE_BUDGET_ENV"
    os.environ.pop(name, None)
    try:
        db = DeadlineBudget.from_env(name, default=30)
        assert db.deadline is not None
    finally:
        os.environ.pop(name, None)


def test_deadline_budget_from_env_zero():
    name = "_TEST_DEADLINE_BUDGET_ZERO"
    os.environ[name] = "0"
    try:
        db = DeadlineBudget.from_env(name, default=30)
        assert db.deadline is None
    finally:
        del os.environ[name]


def test_deadline_budget_from_env_bad_value():
    name = "_TEST_DEADLINE_BUDGET_BAD"
    os.environ[name] = "not-a-number"
    try:
        db = DeadlineBudget.from_env(name, default=30)
        assert db.deadline is not None  # falls back to default
    finally:
        del os.environ[name]
