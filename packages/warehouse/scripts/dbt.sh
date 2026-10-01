#!/usr/bin/env bash
# Run dbt from packages/warehouse with the pinned toolchain. Telemetry is off (DO_NOT_TRACK),
# and no dbt packages are used, so nothing leaves the machine.
#   scripts/dbt.sh build --target local
set -euo pipefail
cd "$(dirname "$0")/.."
export DO_NOT_TRACK=1
export DBT_SEND_ANONYMOUS_USAGE_STATS=False
exec uv run --quiet \
  --with "dbt-core==1.12.5" \
  --with "dbt-duckdb==1.11.0" \
  --with "duckdb==1.5.6" \
  dbt "$@"
