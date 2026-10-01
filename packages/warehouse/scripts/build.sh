#!/usr/bin/env bash
# End-to-end local build and every check, from packages/warehouse:
#   scripts/build.sh                  everything, including the offline BigQuery compile check
#   scripts/build.sh --skip-bigquery  skip step 7 (it downloads dbt-bigquery the first time)
# Nothing is sent anywhere: dbt telemetry is off, no dbt packages, the platform reports are
# SYNTHETIC, and the BigQuery check runs with a dummy token behind a dead proxy.
set -euo pipefail
cd "$(dirname "$0")/.."
export DO_NOT_TRACK=1 DBT_SEND_ANONYMOUS_USAGE_STATS=False

echo "== 1/7 synthetic platform fixtures are current"
uv run --quiet scripts/make_platform_reports.py --check

echo "== 2/7 load contracts fixtures + cohort into DuckDB raw schemas"
uv run --quiet scripts/load_fixtures.py

echo "== 3/7 dbt build --target local (seeds, models, data tests, unit tests)"
scripts/dbt.sh build --target local
echo "   append-only logs: a second run must add nothing and still pass their tests"
scripts/dbt.sh build --target local --select dim_model_parameters fct_purchase_value_score_log fct_predicted_profit_24h_log

echo "== 4/7 export contract-shaped rows"
uv run --quiet scripts/export_contract_rows.py

echo "== 5/7 python checks: plumbing vs cohort ground truth, out-of-time backtest, docs SQL, week-1 queries, raw layer, synthetic fixtures, parameters, metrics"
uv run --quiet --with pytest --with "duckdb==1.5.6" --with pyyaml --with tzdata --with sqlglot pytest python_tests -q
echo "   plumbing check: target/accuracy_report.md; out-of-time backtest (SYNTHETIC): target/oot_backtest_report.md"

echo "== 6/7 contracts validators on every exported row (vitest: zod + ajv from packages/contracts)"
WAREHOUSE_REQUIRE_EXPORT=1 ../../node_modules/.bin/vitest run

if [[ "${1:-}" != "--skip-bigquery" ]]; then
  echo "== 7/7 BigQuery: prod profile parses; every model and test compiles and parses as BigQuery (offline)"
  scripts/check_bigquery_compile.sh
fi
echo "== all checks passed"
