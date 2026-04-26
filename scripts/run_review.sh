#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[$(date +'%Y-%m-%dT%H:%M:%S%z')] $1"
}

error() {
  log "ERROR: $1" >&2
}

sedi() {
  local expr="$1"
  local target="$2"
  if sed --version >/dev/null 2>&1; then
    sed -i "$expr" "$target"
  else
    sed -i '' "$expr" "$target"
  fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${REPO:-${GITHUB_REPOSITORY:-}}"
PR_NUMBER="${PR_NUMBER:-}"
AI_BASE_URL="${AI_BASE_URL:-}"
AI_MODEL="${AI_MODEL:-}"
AI_API_KEY="${AI_API_KEY:-}"
AI_FALLBACK_BASE_URL="${AI_FALLBACK_BASE_URL:-}"
AI_FALLBACK_MODEL="${AI_FALLBACK_MODEL:-}"
AI_FALLBACK_API_KEY="${AI_FALLBACK_API_KEY:-}"
AI_PRIMARY_RETRIES="${AI_PRIMARY_RETRIES:-8}"
AI_PRIMARY_RETRY_DELAY_SEC="${AI_PRIMARY_RETRY_DELAY_SEC:-15}"
ALLOWED_SOURCE_HOSTS="${ALLOWED_SOURCE_HOSTS:-github.com,api.github.com,gitlab.com,registry.terraform.io,artifacthub.io}"
GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
SYSTEM_PROMPT="${SYSTEM_PROMPT:-}"
SYSTEM_PROMPT_FILE="${SYSTEM_PROMPT_FILE:-}"
STANDARDS_FILE="${STANDARDS_FILE:-CLAUDE.md}"
STANDARDS_FILE_CANDIDATES="${STANDARDS_FILE_CANDIDATES:-CLAUDE.md,claude.md,AGENTS.md,agents.md,.github/ai-review-rules.md,.github/ai-review-rules.txt}"
CONTEXT_LIMIT_MODE="${CONTEXT_LIMIT_MODE:-normal}"
EVIDENCE_PROVIDERS_FILE="${EVIDENCE_PROVIDERS_FILE:-}"
EVIDENCE_PROVIDER_TIMEOUT_SEC="${EVIDENCE_PROVIDER_TIMEOUT_SEC:-30}"
EVIDENCE_PROVIDER_MAX_OUTPUT_BYTES="${EVIDENCE_PROVIDER_MAX_OUTPUT_BYTES:-20000}"
EVIDENCE_BLOCKER_ENFORCEMENT="${EVIDENCE_BLOCKER_ENFORCEMENT:-false}"
EVIDENCE_ENABLE_FOR_FORKS="${EVIDENCE_ENABLE_FOR_FORKS:-false}"
TOOL_MODE="${TOOL_MODE:-off}"
TOOL_MAX_REQUESTS="${TOOL_MAX_REQUESTS:-4}"
TOOL_MAX_RESPONSE_BYTES="${TOOL_MAX_RESPONSE_BYTES:-12000}"
TOOL_PLANNING_TIMEOUT_SEC="${TOOL_PLANNING_TIMEOUT_SEC:-30}"
TOOL_PLANNING_MAX_CONTEXT_BYTES="${TOOL_PLANNING_MAX_CONTEXT_BYTES:-50000}"
TOOL_REQUEST_TIMEOUT_SEC="${TOOL_REQUEST_TIMEOUT_SEC:-20}"
TOOL_ALLOWED_GH_API_REPOS="${TOOL_ALLOWED_GH_API_REPOS:-}"
TOOL_FAILURE_ENFORCEMENT="${TOOL_FAILURE_ENFORCEMENT:-false}"
TOOL_MIN_SUCCESSFUL_REQUESTS="${TOOL_MIN_SUCCESSFUL_REQUESTS:-0}"
TOOL_ENABLE_FOR_FORKS="${TOOL_ENABLE_FOR_FORKS:-false}"
OUTPUT_FILE="${GITHUB_OUTPUT:-/dev/null}"

apply_context_limits() {
  case "${CONTEXT_LIMIT_MODE:-normal}" in
    minimal)
      MAX_DIFF=40000; MAX_FILES=20000; MAX_CORPUS=60000 ;;
    low)
      MAX_DIFF=80000; MAX_FILES=40000; MAX_CORPUS=120000 ;;
    normal|*)
      MAX_DIFF=140000; MAX_FILES=70000; MAX_CORPUS=220000 ;;
  esac
}
apply_context_limits

if [[ -z "$REPO" || -z "$PR_NUMBER" || -z "$AI_BASE_URL" || -z "$AI_MODEL" ]]; then
  error "Missing required environment variables: REPO, PR_NUMBER, AI_BASE_URL, or AI_MODEL"
  exit 1
fi

if [[ -z "$GH_TOKEN" ]]; then
  error "Missing GitHub token in GH_TOKEN or GITHUB_TOKEN"
  exit 1
fi

if [[ -n "$AI_FALLBACK_BASE_URL" && -z "$AI_FALLBACK_MODEL" ]]; then
  error "AI_FALLBACK_MODEL is required when AI_FALLBACK_BASE_URL is set"
  exit 1
fi

if [[ -z "$AI_FALLBACK_BASE_URL" && -n "$AI_FALLBACK_MODEL" ]]; then
  error "AI_FALLBACK_BASE_URL is required when AI_FALLBACK_MODEL is set"
  exit 1
fi

resolve_standards_file() {
  if [[ -n "$STANDARDS_FILE" && -f "$STANDARDS_FILE" ]]; then
    return
  fi

  local candidate
  IFS=',' read -ra candidates <<< "$STANDARDS_FILE_CANDIDATES"
  for candidate in "${candidates[@]}"; do
    candidate="$(printf '%s' "$candidate" | xargs)"
    [[ -n "$candidate" ]] || continue
    if [[ -f "$candidate" ]]; then
      STANDARDS_FILE="$candidate"
      return
    fi
  done
}

resolve_system_prompt() {
  if [[ -n "$SYSTEM_PROMPT" ]]; then
    return
  fi

  if [[ -n "$SYSTEM_PROMPT_FILE" ]]; then
    if [[ ! -f "$SYSTEM_PROMPT_FILE" ]]; then
      error "SYSTEM_PROMPT_FILE does not exist: $SYSTEM_PROMPT_FILE"
      exit 1
    fi
    SYSTEM_PROMPT="$(<"$SYSTEM_PROMPT_FILE")"
    return
  fi

  SYSTEM_PROMPT="$(<"$SCRIPT_DIR/default_system_prompt.txt")"
}

resolve_standards_file
resolve_system_prompt

case "$(printf '%s' "$TOOL_MODE" | tr '[:upper:]' '[:lower:]')" in
  off|plan_execute_once) ;;
  *)
    error "Invalid TOOL_MODE '$TOOL_MODE'; defaulting to off"
    TOOL_MODE="off"
    ;;
esac

if [[ ! "$TOOL_MIN_SUCCESSFUL_REQUESTS" =~ ^[0-9]+$ ]]; then
  error "Invalid TOOL_MIN_SUCCESSFUL_REQUESTS '$TOOL_MIN_SUCCESSFUL_REQUESTS'; defaulting to 0"
  TOOL_MIN_SUCCESSFUL_REQUESTS=0
fi

curl_model() {
  local base_url="$1"
  local api_key="$2"
  local payload_file="$3"
  local output_file="$4"

  local args=(
    -fsSL
    "$base_url/chat/completions"
    -H "Content-Type: application/json"
    --data "@$payload_file"
  )

  if [[ -n "$api_key" ]]; then
    args+=( -H "Authorization: Bearer $api_key" )
  fi

  curl "${args[@]}" > "$output_file"
}

parse_and_validate() {
  local response_file="$1"
  jq -r '.choices[0].message.content // empty' "$response_file" > ai-output.raw
  python3 - <<'PY' > ai-output.json
import json
from pathlib import Path

raw = Path("ai-output.raw").read_text(encoding="utf-8", errors="replace")
text = raw.strip()

if text.startswith("```"):
    lines = text.splitlines()
    if lines:
        lines = lines[1:]
    if lines and lines[-1].strip() == "```":
        lines = lines[:-1]
    text = "\n".join(lines).strip()

decoder = json.JSONDecoder()
parsed = None

for start in range(len(text)):
    if text[start] not in "[{":
        continue
    try:
        candidate, end = decoder.raw_decode(text[start:])
        parsed = candidate
        break
    except json.JSONDecodeError:
        continue

if parsed is None:
    raise SystemExit("Could not extract JSON object from model response")

print(json.dumps(parsed))
PY
  jq . ai-output.json > /dev/null
  jq -e '.verdict == "approve" or .verdict == "request_changes"' ai-output.json > /dev/null
  jq -e '.review_markdown and (.review_markdown | length > 0)' ai-output.json > /dev/null
}

log "Collecting PR context for #$PR_NUMBER in $REPO..."

gh pr view "$PR_NUMBER" --repo "$REPO" \
  --json number,title,body,headRefOid,baseRefName,headRefName,author,changedFiles,additions,deletions,files,url > pr.json

IS_FORK_PR="$(gh api "repos/$REPO/pulls/$PR_NUMBER" --jq '((.head.repo.full_name // "") != (.base.repo.full_name // ""))' 2>/dev/null || echo false)"
if [[ "$IS_FORK_PR" == "true" ]]; then
  log "Detected cross-repository pull request"
fi

gh pr diff "$PR_NUMBER" --repo "$REPO" > pr.diff
head -c "$MAX_DIFF" pr.diff > pr.diff.truncated

gh api "repos/$REPO/pulls/$PR_NUMBER/files" --paginate > pr-files.raw.json
jq '[.[] | {filename,status,additions,deletions,changes,previous_filename,patch}]' pr-files.raw.json > pr-files.json
head -c "$MAX_FILES" pr-files.json > pr-files.truncated.json

jq -r '.body // ""' pr.json > pr-body.txt

log "Gathering linked issue context..."
python3 - <<'PY' > linked-issues.json
import json
import os
import re
from pathlib import Path

repo = os.environ["REPO"]
body = Path("pr-body.txt").read_text(encoding="utf-8", errors="replace")
pattern = re.compile(r'(?i)\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?[ \t]+((?:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)?#\d+)')
seen = set()
items = []
for match in pattern.finditer(body):
    ref = match.group(1)
    if ref in seen:
        continue
    seen.add(ref)
    if "/" in ref:
        repo_name, issue_number = ref.split("#", 1)
    else:
        repo_name, issue_number = repo, ref[1:]
    items.append({"ref": ref, "repo": repo_name, "number": int(issue_number)})
print(json.dumps(items[:8]))
PY

: > linked-issues.md
if [ "$(jq 'length' linked-issues.json)" -gt 0 ]; then
  echo "# Linked Issue Context" >> linked-issues.md
  echo >> linked-issues.md
  jq -c '.[]' linked-issues.json | while IFS= read -r item; do
    issue_repo="$(printf '%s' "$item" | jq -r '.repo')"
    issue_number="$(printf '%s' "$item" | jq -r '.number')"
    issue_ref="$(printf '%s' "$item" | jq -r '.ref')"

    echo "## $issue_ref" >> linked-issues.md
    if gh api "repos/$issue_repo/issues/$issue_number" > linked-issue.raw.json 2>/dev/null; then
      jq '{number,title,state,html_url,labels:[.labels[]?.name],body}' linked-issue.raw.json > linked-issue.filtered.json
      echo '```json' >> linked-issues.md
      head -c 12000 linked-issue.filtered.json >> linked-issues.md
      echo >> linked-issues.md
      echo '```' >> linked-issues.md
    else
      echo "(Could not fetch issue $issue_ref from $issue_repo)" >> linked-issues.md
    fi
    echo >> linked-issues.md
  done
else
  echo "No linked issue references found in the PR body." >> linked-issues.md
fi

cat pr-body.txt pr.diff.truncated \
  | grep -Eo 'https?://[^ )]+' \
  | sed 's/[",.;]$//' \
  | sort -u \
  | head -n 25 > urls.txt || true

grep -E '^[+-].*(image:|tag:|version:|chart:|appVersion:|digest:)' pr.diff.truncated > version-hints.txt || true
head -n 180 version-hints.txt > version-hints.truncated.txt || true

grep -Eo 'ghcr\.io/[^/]+/[^:"@ ]+' version-hints.txt | sort -u > ghcr-images.txt || true
sedi 's#ghcr\.io/##' ghcr-images.txt
sedi 's#:.*##' ghcr-images.txt
sort -u ghcr-images.txt -o ghcr-images.txt

log "Gathering changed manifest context..."
CHANGED_MANIFESTS=$(gh api "repos/$REPO/pulls/$PR_NUMBER/files" --paginate --jq '.[] | select(.filename | test("(helmrelease|deployment|statefulset|daemonset|kustomization)\\.ya?ml$"; "i")) | .filename' 2>/dev/null || true)

: > manifest-context.md
if [ -n "$CHANGED_MANIFESTS" ]; then
  echo "# Changed Manifest Context (modified files only)" >> manifest-context.md
  echo >> manifest-context.md

  TOTAL=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ ! -f "$f" ]; then
      echo "## File: $f" >> manifest-context.md
      echo "(file not present in checked-out tree at this ref)" >> manifest-context.md
      echo >> manifest-context.md
      continue
    fi

    LINES=$(wc -l < "$f")
    if [ $((TOTAL + LINES)) -gt 1200 ]; then
      echo "(manifest content truncated - too many total lines)" >> manifest-context.md
      break
    fi

    TOTAL=$((TOTAL + LINES))
    echo "## File: $f (${LINES} lines)" >> manifest-context.md
    echo '```yaml' >> manifest-context.md
    cat "$f" >> manifest-context.md
    echo '```' >> manifest-context.md
    echo >> manifest-context.md
  done <<< "$CHANGED_MANIFESTS"
else
  echo "No common manifest files changed in this PR." >> manifest-context.md
fi

log "Gathering linked sources..."
: > linked-sources.md
if [ -s urls.txt ]; then
  TARGET_VERSION="$(jq -r '.title' pr.json | sed -n 's/.*→ *v\?\([0-9][0-9.]*\).*/\1/p' | head -n1)"
  if [ -z "$TARGET_VERSION" ]; then
    TARGET_VERSION="$(grep -Eo 'v?[0-9]+\.[0-9]+\.[0-9]+' version-hints.truncated.txt 2>/dev/null | sed 's/^v//' | tail -n1 || true)"
  fi

  : > seen-repos.txt
  : > repo-candidates.txt
  i=0
  while IFS= read -r url; do
    [ -z "$url" ] && continue
    i=$((i + 1))
    [ "$i" -gt 25 ] && break

    normalized_url="$(printf '%s' "$url" | sed -E 's#^https?://redirect.github.com/#https://github.com/#')"

    {
      echo "## Source $i"
      echo "URL: $url"
      if [ "$normalized_url" != "$url" ]; then
        echo "Normalized URL: $normalized_url"
      fi
      echo
      echo "### Fetched Content (truncated)"
    } >> linked-sources.md

    host=$(printf '%s' "$normalized_url" | sed -E 's#^https?://([^/]+).*#\1#' | tr '[:upper:]' '[:lower:]')
    allowed=0
    IFS=',' read -ra allowed_hosts <<< "$ALLOWED_SOURCE_HOSTS"
    for raw_host in "${allowed_hosts[@]}"; do
      candidate=$(printf '%s' "$raw_host" | xargs | tr '[:upper:]' '[:lower:]')
      [ -n "$candidate" ] || continue
      if [ "$host" = "$candidate" ]; then
        allowed=1
        break
      fi
    done

    if [ "$allowed" -eq 1 ]; then
      if curl -fsSL -L --max-time 25 "$normalized_url" -o source.raw 2>/dev/null; then
        head -c 5000 source.raw | tr $'\0' ' ' > source.tmp
        if [ -s source.tmp ]; then
          echo '```text' >> linked-sources.md
          cat source.tmp >> linked-sources.md
          echo >> linked-sources.md
          echo '```' >> linked-sources.md
        else
          echo "(No content captured from URL)" >> linked-sources.md
        fi
      else
        echo "(Failed to fetch allowlisted URL content from $host)" >> linked-sources.md
      fi
    else
      echo "(Skipped non-allowlisted URL: $host)" >> linked-sources.md
    fi

    if [[ "$normalized_url" =~ ^https?://github\.com/([^/]+)/([^/]+)/releases/tag/([^/?#]+) ]]; then
      owner="${BASH_REMATCH[1]}"
      repo="${BASH_REMATCH[2]}"
      tag="${BASH_REMATCH[3]}"

      echo >> linked-sources.md
      echo "### GitHub Release Metadata: $owner/$repo@$tag" >> linked-sources.md

      if gh api "repos/$owner/$repo/releases/tags/$tag" > gh-release.json 2>/dev/null; then
        jq '{tag_name,name,published_at,html_url,body}' gh-release.json > gh-release.filtered.json
        echo '```json' >> linked-sources.md
        head -c 5000 gh-release.filtered.json >> linked-sources.md
        echo >> linked-sources.md
        echo '```' >> linked-sources.md
      else
        echo "(Could not fetch release metadata for tag $tag)" >> linked-sources.md
      fi

      if gh api "repos/$owner/$repo/releases?per_page=8" > gh-releases.json 2>/dev/null; then
        jq '[.[] | {tag_name,name,published_at,html_url}]' gh-releases.json > gh-releases.filtered.json
        echo "### Recent Releases" >> linked-sources.md
        echo '```json' >> linked-sources.md
        head -c 3000 gh-releases.filtered.json >> linked-sources.md
        echo >> linked-sources.md
        echo '```' >> linked-sources.md
      fi
    fi

    if [[ "$normalized_url" =~ ^https?://github\.com/([^/]+)/([^/]+)/compare/([^?#]+)$ ]]; then
      owner="${BASH_REMATCH[1]}"
      repo="${BASH_REMATCH[2]}"
      compare_spec="${BASH_REMATCH[3]}"

      echo >> linked-sources.md
      echo "### GitHub Compare Metadata: $owner/$repo@$compare_spec" >> linked-sources.md

      if gh api "repos/$owner/$repo/compare/$compare_spec" > gh-compare.json 2>/dev/null; then
        jq '{html_url,status,ahead_by,behind_by,total_commits,commits:[.commits[]? | {sha,commit:{message,author,date}}]}' gh-compare.json > gh-compare.filtered.json
        echo '```json' >> linked-sources.md
        head -c 7000 gh-compare.filtered.json >> linked-sources.md
        echo >> linked-sources.md
        echo '```' >> linked-sources.md

        jq '[.files[]? | {filename,status,additions,deletions,changes,patch}]' gh-compare.json > gh-compare.files.json
        echo "### GitHub Compare Files" >> linked-sources.md
        echo '```json' >> linked-sources.md
        head -c 7000 gh-compare.files.json >> linked-sources.md
        echo >> linked-sources.md
        echo '```' >> linked-sources.md
      else
        echo "(Could not fetch compare metadata for $owner/$repo@$compare_spec)" >> linked-sources.md
      fi
    fi

    if [[ "$normalized_url" =~ ^https?://github\.com/([^/]+)/([^/?#]+) ]]; then
      owner="${BASH_REMATCH[1]}"
      repo="${BASH_REMATCH[2]}"
      repo_key="$owner/$repo"
      grep -qx "$repo_key" repo-candidates.txt 2>/dev/null || echo "$repo_key" >> repo-candidates.txt
    fi

    echo >> linked-sources.md
  done < urls.txt

  while IFS= read -r repo_key; do
    [ -z "$repo_key" ] && continue
    if ! grep -qx "$repo_key" seen-repos.txt 2>/dev/null; then
      echo "$repo_key" >> seen-repos.txt
      owner="${repo_key%/*}"
      repo="${repo_key#*/}"

      echo >> linked-sources.md
      echo "### GitHub Releases Enrichment: $repo_key" >> linked-sources.md

      if gh api "repos/$owner/$repo/releases?per_page=30" > gh-releases.repo.json 2>/dev/null; then
        jq '[.[] | {tag_name,name,published_at,html_url}]' gh-releases.repo.json > gh-releases.repo.filtered.json
        echo "#### Recent Releases (tags)" >> linked-sources.md
        echo '```json' >> linked-sources.md
        head -c 5000 gh-releases.repo.filtered.json >> linked-sources.md
        echo >> linked-sources.md
        echo '```' >> linked-sources.md

        if [ -n "$TARGET_VERSION" ]; then
          jq --arg v "$TARGET_VERSION" '
            [ .[]
              | select(
                  ((.tag_name // "" | ascii_downcase) == ($v | ascii_downcase))
                  or ((.tag_name // "" | ascii_downcase) == ("v" + ($v | ascii_downcase)))
                  or ((.tag_name // "" | ascii_downcase) | contains(($v | ascii_downcase)))
                  or ((.name // "" | ascii_downcase) | contains(($v | ascii_downcase)))
                )
              | {tag_name,name,published_at,html_url,body}
            ][:5]
          ' gh-releases.repo.json > gh-releases.target.filtered.json
          if [ "$(jq 'length' gh-releases.target.filtered.json)" -gt 0 ]; then
            echo "#### Releases matching target version $TARGET_VERSION" >> linked-sources.md
            echo '```json' >> linked-sources.md
            head -c 8000 gh-releases.target.filtered.json >> linked-sources.md
            echo >> linked-sources.md
            echo '```' >> linked-sources.md
          else
            echo "(No release tags matched target version $TARGET_VERSION in $repo_key)" >> linked-sources.md
            if gh api "repos/$owner/$repo/tags?per_page=50" > gh-tags.repo.json 2>/dev/null; then
              jq '[.[] | {name,commit:.commit.sha}]' gh-tags.repo.json > gh-tags.repo.filtered.json
              echo "#### Recent Tags" >> linked-sources.md
              echo '```json' >> linked-sources.md
              head -c 4000 gh-tags.repo.filtered.json >> linked-sources.md
              echo >> linked-sources.md
              echo '```' >> linked-sources.md
            else
              echo "(Could not fetch tags list for $repo_key)" >> linked-sources.md
            fi
          fi
        fi
      else
        echo "(Could not fetch releases list for $repo_key)" >> linked-sources.md
      fi
    fi
  done < repo-candidates.txt

  log "Probing ghcr.io image paths for upstream GitHub release notes..."
  if [ -s ghcr-images.txt ]; then
    while IFS= read -r img_repo; do
      [ -z "$img_repo" ] && continue

      if grep -qx "$img_repo" seen-repos.txt 2>/dev/null; then
        continue
      fi

      owner="${img_repo%/*}"
      repo="${img_repo#*/}"
      if [ -z "$owner" ] || [ -z "$repo" ] || [[ "$owner" == *"/"* ]]; then
        continue
      fi

      echo >> linked-sources.md
      echo "### GitHub Release Lookup via ghcr.io Path: $owner/$repo" >> linked-sources.md

      if [ -n "$TARGET_VERSION" ]; then
        for tag_prefix in "v$TARGET_VERSION" "$TARGET_VERSION"; do
          if gh api "repos/$owner/$repo/releases/tags/$tag_prefix" > ghcr-release.json 2>/dev/null; then
            echo "#### Matched via ghcr.io path: $owner/$repo@$tag_prefix" >> linked-sources.md
            jq '{tag_name,name,published_at,html_url,body}' ghcr-release.json > ghcr-release.filtered.json
            echo '```json' >> linked-sources.md
            head -c 8000 ghcr-release.filtered.json >> linked-sources.md
            echo >> linked-sources.md
            echo '```' >> linked-sources.md
            break
          fi
        done
        if [ ! -s ghcr-release.json ] || [ ! -s ghcr-release.filtered.json ]; then
          echo "(No release found for $owner/$repo at version $TARGET_VERSION via ghcr.io path inference)" >> linked-sources.md
        fi
      else
        echo "(TARGET_VERSION not set; skipping release lookup for $owner/$repo)" >> linked-sources.md
      fi
    done < ghcr-images.txt
  fi
fi

log "Gathering image digest provenance..."
if ! python3 "$SCRIPT_DIR/image_digest_analysis.py"; then
  error "Image digest analysis failed"
  echo "Image digest provenance analysis failed for this run." > image-digest-context.md
fi

log "Gathering repository impact and history..."
{
  jq -r '.title, (.body // "")' pr.json
  cat version-hints.truncated.txt 2>/dev/null || true
} \
  | tr '[:upper:]' '[:lower:]' \
  | grep -Eo '[a-z0-9][a-z0-9._/-]{2,}' \
  | grep -Ev '^(https?|from|into|that|this|with|without|renovate|pull|request|release|notes|digest|sha|main|chart|image|version|github|com|www|docker|ghcr|io)$' \
  | sort -u \
  | head -n 14 > terms.txt || true

: > repo-impact.md
: > repo-history.md

if [ -s terms.txt ]; then
  while IFS= read -r term; do
    [ -z "$term" ] && continue

    {
      echo "## Term: $term"
      echo
      echo "### git grep hits"
      echo '```text'
      git grep -n -- "$term" -- . 2>/dev/null | head -n 60 || true
      echo '```'
      echo
    } >> repo-impact.md

    {
      echo "## Term: $term"
      echo
      echo "### git log context"
      echo '```text'
      git log --oneline --decorate --grep="$term" -n 10 || true
      echo '```'
      echo
    } >> repo-history.md
  done < terms.txt

  head -c 45000 repo-impact.md > repo-impact.truncated.md
  head -c 20000 repo-history.md > repo-history.truncated.md
else
  echo "No candidate dependency terms extracted." > repo-impact.md
  echo "No candidate dependency terms extracted." > repo-history.md
  cp repo-impact.md repo-impact.truncated.md
  cp repo-history.md repo-history.truncated.md
fi

log "Running optional evidence providers..."
if [[ "$IS_FORK_PR" == "true" ]] && [[ "$(printf '%s' "$EVIDENCE_ENABLE_FOR_FORKS" | tr '[:upper:]' '[:lower:]')" != "true" ]]; then
  cat > evidence-providers.md <<'EOF'
Evidence providers were skipped for a cross-repository pull request. Set evidence_enable_for_forks=true to override.
EOF
  cat > evidence-providers.json <<'EOF'
{"configured": false, "has_blocker": false, "providers": [], "skipped": true, "skip_reason": "fork-pr"}
EOF
else
  if ! python3 "$SCRIPT_DIR/run_evidence_providers.py"; then
    error "Evidence provider execution failed"
    cat > evidence-providers.md <<'EOF'
Evidence providers failed to run in this review.
EOF
    cat > evidence-providers.json <<'EOF'
{"configured": false, "has_blocker": false, "providers": [], "error": "execution failed"}
EOF
  fi
fi

log "Building review corpus..."
: > standards-context.md
if [ -f "$STANDARDS_FILE" ]; then
  echo "# Repository Standards and Conventions" >> standards-context.md
  echo "Derived from $STANDARDS_FILE for this repository." >> standards-context.md
  echo >> standards-context.md
  cat "$STANDARDS_FILE" >> standards-context.md
else
  echo "($STANDARDS_FILE not found; standards context unavailable.)" >> standards-context.md
fi

if [ ! -f tool-harness.md ]; then
  cat > tool-harness.md <<'EOF'
Tool harness disabled.
EOF
fi

if [ ! -f tool-harness.json ]; then
  cat > tool-harness.json <<'EOF'
{"mode":"off","planned_request_count":0,"executed_request_count":0,"tool_results":[]}
EOF
fi

build_review_corpus() {
  {
    echo "# Changed Manifest Context"
    cat manifest-context.md
    echo
    echo "# PR Metadata"
    echo '```json'
    jq . pr.json
    echo '```'
    echo
    echo "# Linked Issue Context"
    cat linked-issues.md
    echo
    echo "# PR Files (truncated)"
    echo '```json'
    cat pr-files.truncated.json
    echo '```'
    echo
    echo "# Version Hints from Diff"
    echo '```text'
    cat version-hints.truncated.txt 2>/dev/null || echo "(none)"
    echo '```'
    echo
    echo "# PR Diff (truncated)"
    echo '```diff'
    cat pr.diff.truncated
    echo '```'
    echo
    echo "# Linked Sources"
    cat linked-sources.md
    echo
    echo "# Evidence Providers"
    cat evidence-providers.md
    echo
    echo "# Tool Harness Findings"
    cat tool-harness.md
    echo
    echo "# Image Digest Provenance"
    cat image-digest-context.md
    echo
    echo "# Repository Impact Scan"
    cat repo-impact.truncated.md
    echo
    echo "# Repository History"
    cat repo-history.truncated.md
    echo
    echo "# Repository Standards and Conventions ($STANDARDS_FILE)"
    cat standards-context.md
  } > review-corpus.md
}

build_review_corpus
head -c "$MAX_CORPUS" review-corpus.md > review-corpus.truncated.md

if [[ "$(printf '%s' "$TOOL_MODE" | tr '[:upper:]' '[:lower:]')" == "plan_execute_once" ]]; then
  if [[ "$IS_FORK_PR" == "true" ]] && [[ "$(printf '%s' "$TOOL_ENABLE_FOR_FORKS" | tr '[:upper:]' '[:lower:]')" != "true" ]]; then
    cat > tool-harness.md <<'EOF'
Tool harness was skipped for a cross-repository pull request. Set tool_enable_for_forks=true to override.
EOF
    cat > tool-harness.json <<'EOF'
{"mode":"plan_execute_once","planned_request_count":0,"executed_request_count":0,"tool_results":[],"skipped":true,"skip_reason":"fork-pr"}
EOF
  else
    log "Running tool harness in mode: $TOOL_MODE"
    if ! python3 "$SCRIPT_DIR/run_tool_harness.py"; then
      error "Tool harness execution failed"
      cat > tool-harness.md <<'EOF'
Tool harness failed to run in this review.
EOF
      cat > tool-harness.json <<'EOF'
{"mode":"plan_execute_once","planned_request_count":0,"executed_request_count":0,"tool_results":[],"error":"execution failed"}
EOF
    fi
  fi
  build_review_corpus
  head -c "$MAX_CORPUS" review-corpus.md > review-corpus.truncated.md
fi

log "Analyzing with $AI_MODEL..."

jq -n \
  --arg model "$AI_MODEL" \
  --arg system "$SYSTEM_PROMPT" \
  --arg user "Analyze this pull request corpus and return STRICT JSON." \
  --rawfile corpus review-corpus.truncated.md \
  '{model:$model,messages:[{role:"system",content:$system},{role:"user",content:($user + "\n\n" + $corpus)}],temperature:0.1}' > ai-request.primary.json

PRIMARY_OK=0
ATTEMPT=1
while [ "$ATTEMPT" -le "$AI_PRIMARY_RETRIES" ]; do
  echo "Primary model attempt ${ATTEMPT}/${AI_PRIMARY_RETRIES}: $AI_MODEL @ $AI_BASE_URL"
  if curl_model "$AI_BASE_URL" "$AI_API_KEY" ai-request.primary.json ai-response.primary.json && \
    parse_and_validate ai-response.primary.json; then
    PRIMARY_OK=1
    break
  fi

  echo "Primary model attempt $ATTEMPT failed; waiting ${AI_PRIMARY_RETRY_DELAY_SEC}s" >&2
  ATTEMPT=$((ATTEMPT + 1))
  sleep "$AI_PRIMARY_RETRY_DELAY_SEC"
done

if [ "$PRIMARY_OK" -eq 1 ]; then
  ANALYSIS_ENGINE="$AI_MODEL@$AI_BASE_URL"
  echo "Primary model succeeded"
else
  if [[ -z "$AI_FALLBACK_BASE_URL" || -z "$AI_FALLBACK_MODEL" ]]; then
    error "Primary model unavailable and no fallback model configured"
    exit 1
  fi

  echo "Primary model unavailable after retries; trying fallback: $AI_FALLBACK_MODEL @ $AI_FALLBACK_BASE_URL" >&2
  head -c 120000 review-corpus.md > review-corpus.fallback.truncated.md
  jq -n \
    --arg model "$AI_FALLBACK_MODEL" \
    --arg system "$SYSTEM_PROMPT" \
    --arg user "Analyze this pull request corpus and return STRICT JSON." \
    --rawfile corpus review-corpus.fallback.truncated.md \
    '{model:$model,messages:[{role:"system",content:$system},{role:"user",content:($user + "\n\n" + $corpus)}],temperature:0.1}' > ai-request.fallback.json

  if curl_model "$AI_FALLBACK_BASE_URL" "$AI_FALLBACK_API_KEY" ai-request.fallback.json ai-response.fallback.json && \
    parse_and_validate ai-response.fallback.json; then
    ANALYSIS_ENGINE="$AI_FALLBACK_MODEL@$AI_FALLBACK_BASE_URL"
    echo "Fallback model succeeded" >&2
  else
    error "Fallback model failed"
    exit 1
  fi
fi

if [[ "$(printf '%s' "$EVIDENCE_BLOCKER_ENFORCEMENT" | tr '[:upper:]' '[:lower:]')" == "true" ]] && \
  jq -e '.has_blocker == true' evidence-providers.json >/dev/null 2>&1; then
  BLOCKER_PROVIDER_IDS="$(jq -r '.providers[]? | select((.provider_severity // "") == "blocker") | .id' evidence-providers.json | paste -sd ', ' -)"
  jq --arg ids "$BLOCKER_PROVIDER_IDS" '
    .verdict = "request_changes"
    | .review_markdown = (
      (.review_markdown // "")
      + "\n\n## Evidence Provider Blockers\n"
      + "One or more configured evidence providers reported blocker-level findings"
      + (if $ids != "" then " (" + $ids + ")" else "" end)
      + ". Resolve blocker findings before approval."
    )
  ' ai-output.json > ai-output.enforced.json
  mv ai-output.enforced.json ai-output.json
  log "Enforced request_changes due to blocker evidence provider findings"
fi

if [[ "$(printf '%s' "$TOOL_MODE" | tr '[:upper:]' '[:lower:]')" == "plan_execute_once" ]] && \
  [[ "$(printf '%s' "$TOOL_FAILURE_ENFORCEMENT" | tr '[:upper:]' '[:lower:]')" == "true" ]]; then
  TOOL_FAILURE_REASON="$(jq -r '
    if .planning_error? != null then
      .planning_error
    elif .error? != null then
      .error
    elif ((.executed_request_count // 0) > 0) and ((([.tool_results[]?.result.status == "ok"] | any) | not)) then
      "all tool requests failed"
    else
      ""
    end
  ' tool-harness.json 2>/dev/null || true)"

  if [[ -n "$TOOL_FAILURE_REASON" ]]; then
    jq --arg reason "$TOOL_FAILURE_REASON" '
    .verdict = "request_changes"
    | .review_markdown = (
      (.review_markdown // "")
      + "\n\n## Tool Harness Failure\n"
      + "The tool harness failed during planning or execution ("
      + $reason
      + "). This workflow is configured fail-closed for tool harness failures; rerun after reducing tool planning context or fixing connectivity."
    )
  ' ai-output.json > ai-output.enforced.json
    mv ai-output.enforced.json ai-output.json
    log "Enforced request_changes due to tool harness failure"
  elif [[ "$TOOL_MIN_SUCCESSFUL_REQUESTS" -gt 0 ]]; then
    SUCCESSFUL_TOOL_REQUESTS="$(jq -r '[.tool_results[]?.result.status == "ok"] | map(select(. == true)) | length' tool-harness.json 2>/dev/null || echo 0)"
    if [[ ! "$SUCCESSFUL_TOOL_REQUESTS" =~ ^[0-9]+$ ]]; then
      SUCCESSFUL_TOOL_REQUESTS=0
    fi

    if [[ "$SUCCESSFUL_TOOL_REQUESTS" -lt "$TOOL_MIN_SUCCESSFUL_REQUESTS" ]]; then
      jq --arg min "$TOOL_MIN_SUCCESSFUL_REQUESTS" --arg got "$SUCCESSFUL_TOOL_REQUESTS" '
        .verdict = "request_changes"
        | .review_markdown = (
          (.review_markdown // "")
          + "\n\n## Tool Harness Insufficient Evidence\n"
          + "This workflow requires at least "
          + $min
          + " successful tool requests, but only "
          + $got
          + " succeeded. Rerun after adjusting tool planning settings."
        )
      ' ai-output.json > ai-output.enforced.json
      mv ai-output.enforced.json ai-output.json
      log "Enforced request_changes due to insufficient successful tool requests"
    fi
  fi
fi

echo "analysis_engine=$ANALYSIS_ENGINE" >> "$OUTPUT_FILE"
echo "verdict=$(jq -r '.verdict' ai-output.json)" >> "$OUTPUT_FILE"

{
  echo 'review_markdown<<EOF'
  jq -r '.review_markdown' ai-output.json
  echo 'EOF'
} >> "$OUTPUT_FILE"

log "Analysis complete. Writing outputs..."
jq -r '.review_markdown' ai-output.json > review-body.md
echo "$(jq -r '.verdict' ai-output.json)" > verdict.txt
echo "$ANALYSIS_ENGINE" > analysis_engine.txt

log "Done."
