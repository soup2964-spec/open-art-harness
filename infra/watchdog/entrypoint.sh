#!/usr/bin/env bash
# Container entrypoint (Cloud Run job task / docker run): one watchdog run → GCS (+ optional
# BigQuery) → Slack alert on FAIL/ERROR, container change or unreadable container, run errors,
# unlisted first-party requests, or an unproven zero-leak.
# Exit codes (from packages/watchdog/src/cli.ts EXIT):
#   0 ran (contract FAILs are findings, not job failures — maxRetries: 0 keeps live traffic bounded)
#   2 zero-leak proof NOT proven   3 crashed (incl. a failed seal self-test: nothing touched openart.ai)
#   4 an alert was due but could not be delivered (missing/invalid webhook, Slack non-2xx)
set -uo pipefail
cd /app

OUT="/tmp/watchdog/$(date -u +%Y%m%dT%H%M%SZ)"
# WATCHDOG_RUN_ARGS: extra CLI flags, e.g. "--journeys meta_one_hop,spa_pageviews" or patch flags.
# shellcheck disable=SC2086
npx --no-install tsx packages/watchdog/src/cli.ts run --target "${WATCHDOG_TARGET:-live}" --fail-on never --out "$OUT" ${WATCHDOG_RUN_ARGS:-}
code=$?

alert=0
if [ -f "$OUT/results.json" ]; then
  if [ -n "${WATCHDOG_BUCKET:-}" ]; then
    node infra/watchdog/upload.mjs "$OUT" || echo "watchdog: upload failed" >&2
  fi
  if [ -f "$OUT/upload.json" ]; then
    WATCHDOG_REPORT_URL="$(node -e 'try { console.log(require(process.argv[1]).reportUrl || "") } catch (e) {}' "$OUT/upload.json")"
    export WATCHDOG_REPORT_URL
  fi
  # Always evaluated: with no SLACK_WEBHOOK_URL a due alert makes the task exit 4 instead of passing silently.
  npx --no-install tsx packages/watchdog/src/cli.ts alert --in "$OUT/results.json" --slack-webhook-env SLACK_WEBHOOK_URL
  alert=$?
fi
if [ "$code" -ne 0 ]; then exit "$code"; fi
exit "$alert"
