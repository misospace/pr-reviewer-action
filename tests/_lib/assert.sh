#!/usr/bin/env bash
# Shared assertion helpers for tests/test_*.sh
#
# Usage: source this file after declaring PASS and FAIL counters.
#
# Provided functions:
#   check          desc result expected        — exact equality
#   check_contains desc haystack needle        — substring test
#   check_not_contains desc haystack needle    — absent-substring test
#   check_ne       desc result not_expected    — exact inequality
#   check_exists   desc count                  — count > 0

check() {
  local desc="$1" result="$2" expected="$3"
  if [[ "$result" == "$expected" ]]; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (got '$result', expected '$expected')"
    FAIL=$((FAIL + 1))
  fi
}

check_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (expected to contain '$needle')"
    FAIL=$((FAIL + 1))
  fi
}

check_not_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (should not contain '$needle')"
    FAIL=$((FAIL + 1))
  fi
}

check_ne() {
  local desc="$1" result="$2" not_expected="$3"
  if [[ "$result" != "$not_expected" ]]; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (got '$result', should not be '$not_expected')"
    FAIL=$((FAIL + 1))
  fi
}

check_exists() {
  local desc="$1" result="$2"
  if [[ "$result" -gt 0 ]]; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (expected to exist)"
    FAIL=$((FAIL + 1))
  fi
}
