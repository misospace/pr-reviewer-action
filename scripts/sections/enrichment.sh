# shellcheck shell=bash
# Sourced by run_review.sh — linked-source enrichment (parallel fetch + GitHub release/compare metadata).
# Verbatim in-order slice of the former monolith (#307); relies on globals/helpers
# set up by the orchestrator. Not executable on its own.

section_timer_start "enrichment"
log "Gathering linked sources..."
: > linked-sources.md
if [ -s urls.txt ]; then
  ENRICHMENT_START_TS=$(date +%s)
  TARGET_VERSION="$(jq -r '.title' pr.json | sed -n 's/.*→ *v\?\([0-9][0-9.]*\).*/\1/p' | head -n1)"
  if [ -z "$TARGET_VERSION" ]; then
    TARGET_VERSION="$(grep -Eo 'v?[0-9]+\.[0-9]+\.[0-9]+' version-hints.truncated.txt 2>/dev/null | sed 's/^v//' | tail -n1 || true)"
  fi

  # Phase 1: fetch every allowlisted URL body in one parallel curl run instead
  # of serially (25 URLs x 25s worst-case each). parallel-max covers the full
  # URL cap so wall-clock is bounded by the single slowest transfer. URLs are
  # space-free by construction (extracted with a space-excluding grep), so the
  # unquoted curl-config value cannot smuggle extra directives.
  : > curl-parallel.cfg
  i=0
  while IFS= read -r url; do
    [ -z "$url" ] && continue
    i=$((i + 1))
    [ "$i" -gt 25 ] && break
    normalized_url="$(printf '%s' "$url" | sed -E 's#^https?://redirect.github.com/#https://github.com/#')"
    rm -f "source.$i.raw"
    host=$(printf '%s' "$normalized_url" | sed -E 's#^https?://([^/]+).*#\1#' | tr '[:upper:]' '[:lower:]')
    # github.com bodies are JS-app shells; phase 2's gh api branches capture
    # the structured data instead, so don't spend a fetch on them at all.
    if [ "$host" != "github.com" ] && url_host_allowed "$normalized_url"; then
      {
        echo "url = $normalized_url"
        echo "output = source.$i.raw"
      } >> curl-parallel.cfg
    fi
  done < urls.txt
  if [ -s curl-parallel.cfg ]; then
    curl -q -fsSL --parallel --parallel-max 25 --max-time 25 --config curl-parallel.cfg 2>/dev/null || true
  fi

  : > seen-repos.txt
  : > repo-candidates.txt
  i=0
  while IFS= read -r url; do
    [ -z "$url" ] && continue
    i=$((i + 1))
    [ "$i" -gt 25 ] && break
    enrichment_budget_ok || break

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

    if url_host_allowed "$normalized_url"; then
      if [ "$host" = "github.com" ]; then
        # Raw github.com pages are JS-app HTML shells with none of the actual
        # content; the gh api branches below capture the release/compare data
        # in structured form instead. Skipping the fetch saves both time and
        # ~5KB of corpus boilerplate per URL.
        echo "(Raw HTML fetch skipped for github.com — structured release/compare metadata is captured below when available)" >> linked-sources.md
      elif [ -s "source.$i.raw" ]; then
        strip_source_to_text "source.$i.raw" source.tmp 4000
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

      if enrichment_budget_ok && github_enrich_api "repos/$owner/$repo/releases/tags/$tag" > gh-release.json 2>/dev/null; then
        jq -c '{tag_name,name,published_at,html_url,body}' gh-release.json > gh-release.filtered.json
        echo '```json' >> linked-sources.md
        head -c 5000 gh-release.filtered.json >> linked-sources.md
        echo >> linked-sources.md
        echo '```' >> linked-sources.md
      else
        echo "(Could not fetch release metadata for tag $tag)" >> linked-sources.md
      fi

      if enrichment_budget_ok && github_enrich_api "repos/$owner/$repo/releases?per_page=8" > gh-releases.json 2>/dev/null; then
        jq -c '[.[] | {tag_name,name,published_at,html_url}]' gh-releases.json > gh-releases.filtered.json
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

      if enrichment_budget_ok && github_enrich_api "repos/$owner/$repo/compare/$compare_spec" > gh-compare.json 2>/dev/null; then
        jq -c '{html_url,status,ahead_by,behind_by,total_commits,commits:[.commits[]? | {sha,commit:{message,author,date}}]}' gh-compare.json > gh-compare.filtered.json
        echo '```json' >> linked-sources.md
        head -c 7000 gh-compare.filtered.json >> linked-sources.md
        echo >> linked-sources.md
        echo '```' >> linked-sources.md

        jq -c '[.files[]? | {filename,status,additions,deletions,changes,patch}]' gh-compare.json > gh-compare.files.json
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
    enrichment_budget_ok || break
    if ! grep -qx "$repo_key" seen-repos.txt 2>/dev/null; then
      echo "$repo_key" >> seen-repos.txt
      owner="${repo_key%/*}"
      repo="${repo_key#*/}"

      echo >> linked-sources.md
      echo "### GitHub Releases Enrichment: $repo_key" >> linked-sources.md

      if enrichment_budget_ok && github_enrich_api "repos/$owner/$repo/releases?per_page=30" > gh-releases.repo.json 2>/dev/null; then
        jq -c '[.[] | {tag_name,name,published_at,html_url}]' gh-releases.repo.json > gh-releases.repo.filtered.json
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
            if enrichment_budget_ok && github_enrich_api "repos/$owner/$repo/tags?per_page=50" > gh-tags.repo.json 2>/dev/null; then
              jq -c '[.[] | {name,commit:.commit.sha}]' gh-tags.repo.json > gh-tags.repo.filtered.json
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
      enrichment_budget_ok || break

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
          if enrichment_budget_ok && github_enrich_api "repos/$owner/$repo/releases/tags/$tag_prefix" > ghcr-release.json 2>/dev/null; then
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
section_timer_end
