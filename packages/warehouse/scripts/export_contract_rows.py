#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["duckdb==1.5.6"]
# ///
"""Export the contract-shaped marts as JSONL so the contracts package's own validators
(zod + ajv, in test/contracts.test.ts) can check every row the warehouse produces.

  target/contract_export/conversion_ledger_events.jsonl  fct_conversion_ledger   (ConversionLedgerEvent)
  target/contract_export/predicted_profit.jsonl          fct_predicted_profit_24h (PredictedProfit)
  target/contract_export/purchase_value_scores.jsonl     fct_purchase_value_score (PurchaseValueScore)
  target/contract_export/purchase_value_score_log.jsonl  fct_purchase_value_score_log (PurchaseValueScore)
  target/contract_export/experiment_exposures.jsonl      fct_experiment_exposures (ExperimentExposure)
  target/contract_export/experiment_profit_by_arm_daily.jsonl  fct_experiment_profit_by_arm_daily
                                                         (the bandit-allocator's 17 input columns)
  target/contract_export/bandit_user_segments.jsonl      int_experiment__user_readout segment + slice per user
  target/contract_export/audience_candidates.jsonl       fct_audience_candidates  (ids, consent gate)
  target/contract_export/ledger_platform_ids.jsonl       fct_conversion_ledger warehouse-only platform id columns
  target/contract_export/MANIFEST.json                   row counts

Only the contract columns are exported (warehouse-only lineage columns are dropped), in the
contract's column order. Timestamps become RFC 3339 UTC strings ending in Z; JSON columns
become nested objects.

Usage: uv run scripts/export_contract_rows.py [--db target/local.duckdb]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

import duckdb

WAREHOUSE = Path(__file__).resolve().parents[1]
OUT = WAREHOUSE / "target" / "contract_export"
MARTS = "openart_signal_marts"

# CONVERSION_LEDGER_COLUMNS (contracts src/canonical-helpers.ts): contract order.
LEDGER_COLUMNS = [
    "schema_version", "event_id", "event_name", "occurred_at", "source_system", "source_event_id",
    "user_id", "device_id", "order_id", "adjusts_event_id", "adjusts_order_id", "cash_value_minor",
    "currency", "invoice_id", "subscription_id", "checkout_session_id", "charge_id", "plan_tier",
    "plan_tier_code", "billing_interval", "previous_plan_tier", "credit_pack_quantity",
    "is_first_purchase", "is_business", "generation", "lead", "click_ids", "utm", "ga_client_id",
    "ga_session_id", "tolt_referral", "consent", "experiment_arms",
]
LEDGER_JSON = {"generation", "lead", "click_ids", "utm", "consent", "experiment_arms"}

PREDICTED_COLUMNS = [
    "user_id", "computed_at", "horizon_days", "feature_window_hours", "currency", "predicted_revenue",
    "predicted_generation_cost", "predicted_fees", "predicted_refund_risk", "refund_probability",
    "predicted_profit", "model_version", "features",
]

# PURCHASE_VALUE_SCORE contract order (contracts src/schemas/purchase-value-score.schema.json).
PURCHASE_VALUE_COLUMNS = [
    "event_id", "invoice_id", "user_id", "occurred_at", "scored_at", "estimand", "horizon_days",
    "predicted_revenue_90d", "predicted_generation_cost_90d", "predicted_fees_90d", "predicted_refund_risk",
    "predicted_profit_90d", "interval_low", "interval_high", "cash_value", "currency", "model_version",
    "run_id", "fitted_params_ref", "features_snapshot",
]

EXPOSURE_COLUMNS = ["user_id", "flag_key", "arm", "first_exposed_at", "source", "device_id"]

# packages/bandit-allocator src/warehouse.ts EXPERIMENT_PROFIT_BY_ARM_COLUMNS, in order.
BANDIT_COLUMNS = [
    "exposure_date", "flag_key", "arm", "country_bucket", "device", "acquisition_channel", "allocation_slice",
    "exposed_users", "scored_users", "converted_users", "sum_predicted_profit", "sum_sq_predicted_profit",
    "sum_predicted_revenue", "sum_predicted_generation_cost", "sum_predicted_fees", "sum_predicted_refund_risk",
    "model_version",
]

# The allocator's optional column groups (warehouse.ts MATURED / GUARDRAIL / COVARIATE columns).
BANDIT_OPTIONAL_COLUMNS = [
    "matured_users", "matured_converted_users", "sum_matured_value", "sum_sq_matured_value", "sum_matured_cost",
    "sum_sq_matured_cost", "matured_refunded_users", "activated_users", "generations_24h", "failed_generations_24h",
    "sum_covariate", "sum_sq_covariate", "sum_predicted_profit_x_covariate",
]

AUDIENCE_COLUMNS = ["user_id", "list_name", "candidate_role", "reason", "seed_value_usd", "external_id_sha256", "upload_allowed", "consent_region", "requires_consent"]

# Warehouse-only ledger columns checked against the contracts' JS implementations.
LEDGER_PLATFORM_ID_COLUMNS = ["event_id", "event_name", "order_id", "reddit_pixel_conversion_id", "requires_web_fix", "web_fix_platforms"]


# Counts the bandit's zod schema requires to be integers (DuckDB sums come back as HUGEINT/float).
INTEGER_COLUMNS = {"exposed_users", "scored_users", "converted_users", "horizon_days", "matured_users", "matured_converted_users", "matured_refunded_users", "activated_users", "generations_24h", "failed_generations_24h"}


def rfc3339(value: datetime) -> str:
    if value.microsecond:
        return value.strftime("%Y-%m-%dT%H:%M:%S.") + f"{value.microsecond // 1000:03d}Z"
    return value.strftime("%Y-%m-%dT%H:%M:%SZ")


def to_json_value(column: str, value, json_columns: set[str]):
    if value is None:
        return None
    if column in json_columns or column == "features":
        return json.loads(value) if isinstance(value, str) else value
    if isinstance(value, float) and value.is_integer() and column in INTEGER_COLUMNS:
        return int(value)
    if isinstance(value, datetime):
        return rfc3339(value)
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value


def export(con: duckdb.DuckDBPyConnection, table: str, columns: list[str], json_columns: set[str], name: str, order_by: str, schema: str = MARTS) -> int:
    rows = con.execute(f"select {', '.join(columns)} from {schema}.{table} order by {order_by}").fetchall()
    path = OUT / name
    with path.open("w", encoding="utf-8") as fh:
        for row in rows:
            record = {c: to_json_value(c, v, json_columns) for c, v in zip(columns, row)}
            fh.write(json.dumps(record, separators=(",", ":")) + "\n")
    return len(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description="Export contract-shaped marts to JSONL")
    parser.add_argument("--db", type=Path, default=Path(os.environ.get("WAREHOUSE_DUCKDB_PATH", WAREHOUSE / "target" / "local.duckdb")))
    args = parser.parse_args()
    db = args.db if args.db.is_absolute() else WAREHOUSE / args.db
    if not db.exists():
        print(f"{db} not found: run scripts/build.sh (or load_fixtures.py + dbt build) first", file=sys.stderr)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(db), read_only=True)
    con.execute("set TimeZone = 'UTC'")
    counts = {
        "conversion_ledger_events.jsonl": export(con, "fct_conversion_ledger", LEDGER_COLUMNS, LEDGER_JSON, "conversion_ledger_events.jsonl", "occurred_at, event_id"),
        "predicted_profit.jsonl": export(con, "fct_predicted_profit_24h", PREDICTED_COLUMNS, {"features"}, "predicted_profit.jsonl", "user_id"),
        "purchase_value_scores.jsonl": export(con, "fct_purchase_value_score", PURCHASE_VALUE_COLUMNS, {"features_snapshot"}, "purchase_value_scores.jsonl", "event_id"),
        "purchase_value_score_log.jsonl": export(con, "fct_purchase_value_score_log", PURCHASE_VALUE_COLUMNS, {"features_snapshot"}, "purchase_value_score_log.jsonl", "event_id, model_version"),
        "experiment_exposures.jsonl": export(con, "fct_experiment_exposures", EXPOSURE_COLUMNS, set(), "experiment_exposures.jsonl", "user_id, flag_key"),
        "experiment_profit_by_arm_daily.jsonl": export(
            con, "fct_experiment_profit_by_arm_daily", BANDIT_COLUMNS, set(), "experiment_profit_by_arm_daily.jsonl",
            "exposure_date, flag_key, arm, country_bucket, device, acquisition_channel, allocation_slice",
        ),
        "experiment_profit_by_arm_daily_full.jsonl": export(
            con, "fct_experiment_profit_by_arm_daily", BANDIT_COLUMNS + BANDIT_OPTIONAL_COLUMNS, set(), "experiment_profit_by_arm_daily_full.jsonl",
            "exposure_date, flag_key, arm, country_bucket, device, acquisition_channel, allocation_slice",
        ),
        "bandit_user_segments.jsonl": export(
            con, "int_experiment__user_readout", ["user_id", "flag_key", "arm", "exposure_date", "country_bucket", "device", "acquisition_channel", "allocation_slice", "is_contaminated"],
            set(), "bandit_user_segments.jsonl", "user_id, flag_key", schema="openart_signal_intermediate",
        ),
        "audience_candidates.jsonl": export(con, "fct_audience_candidates", AUDIENCE_COLUMNS, set(), "audience_candidates.jsonl", "user_id, list_name"),
        "ledger_platform_ids.jsonl": export(con, "fct_conversion_ledger", LEDGER_PLATFORM_ID_COLUMNS, set(), "ledger_platform_ids.jsonl", "event_id"),
    }
    con.close()
    (OUT / "MANIFEST.json").write_text(json.dumps({"source": str(db.relative_to(WAREHOUSE)), "counts": counts}, indent=2) + "\n", encoding="utf-8")
    for name, n in counts.items():
        print(f"exported {n:>6,d} rows -> target/contract_export/{name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
