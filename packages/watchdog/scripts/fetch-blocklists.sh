#!/usr/bin/env bash
# Fetch uBlock Origin's DEFAULT network lists (the set its assets.json enables out of the box) for the
# ubo_blocked journey, under the file names src/ubo/engine.ts expects. Used by the Docker build and
# CI; locally the watchdog falls back to the frozen 2026-09-29 copies in the research tree
# (crawl/teardown2/blocklists). Sources are uBO's own CDN URLs from assets.json (cdnURLs).
#   bash scripts/fetch-blocklists.sh [destDir]
set -euo pipefail
DEST="${1:-$(cd "$(dirname "$0")/.." && pwd)/blocklists}"
mkdir -p "$DEST"
CDN="https://ublockorigin.github.io/uAssetsCDN"
JSD="https://cdn.jsdelivr.net/gh/uBlockOrigin/uAssetsCDN@main"
fetch() { # name url [fallback]
  local name="$1" url="$2" alt="${3:-}"
  if ! curl -fsSL --retry 3 --max-time 60 -o "$DEST/$name" "$url"; then
    [ -n "$alt" ] && curl -fsSL --retry 3 --max-time 60 -o "$DEST/$name" "$alt"
  fi
  [ -s "$DEST/$name" ] || { echo "empty list: $name" >&2; exit 1; }
}
fetch ubo_filters_all.txt     "$CDN/filters/filters.min.txt"        "$JSD/filters/filters.min.txt"
fetch ubo_badware.txt         "$CDN/filters/badware.min.txt"        "$JSD/filters/badware.min.txt"
fetch ubo_privacy.txt         "$CDN/filters/privacy.min.txt"        "$JSD/filters/privacy.min.txt"
fetch ubo_quick_fixes.txt     "$CDN/filters/quick-fixes.min.txt"    "$JSD/filters/quick-fixes.min.txt"
fetch ubo_unbreak.txt         "$CDN/filters/unbreak.min.txt"        "$JSD/filters/unbreak.min.txt"
fetch ubo_resource_abuse.txt  "$CDN/filters/resource-abuse.txt"     "$JSD/filters/resource-abuse.txt"
fetch easylist.txt            "$JSD/thirdparties/easylist.txt"      "https://easylist.to/easylist/easylist.txt"
fetch easyprivacy.txt         "$JSD/thirdparties/easyprivacy.txt"   "https://easylist.to/easylist/easyprivacy.txt"
fetch peterlowe.txt           "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=1&mimetype=plaintext"
{
  echo "fetched: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  (cd "$DEST" && shasum -a 256 ./*.txt 2>/dev/null || sha256sum ./*.txt)
} > "$DEST/SOURCES.txt"
echo "blocklists in $DEST"
