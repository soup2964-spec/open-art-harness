#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["duckdb==1.5.6"]
# ///
"""Load the contracts fixtures, the synthetic cohort and the warehouse's synthetic platform
fixtures into DuckDB raw schemas that mirror the BigQuery raw tables they stand in for.

  raw table                              real-world counterpart (see README "Raw layer")
  -------------------------------------  ---------------------------------------------------
  raw_stripe.events                      Stripe webhook sink (one row per Event delivery;
                                         `data` JSON). Stripe Data Pipeline plugs in through
                                         a staging adapter instead.
  raw_amplitude.events                   Amplitude -> BigQuery export, EVENTS_<project_id>
                                         (documented columns; JSON event/user properties)
  raw_app.credit_ledger                  Replica of the credit ledger in the entry shape of
                                         GET /suite/api/credits/logs (Firestore extension, CDC
                                         or nightly export)
  raw_app.ad_click_ids                   Persisted POST /api/user/ad-click-ids bodies
  raw_app.users                          my-info subset (id, email, account_created_at, provider)
  raw_app.invoice_lookups                SYNTHETIC log of checkout-session-invoice responses
  raw_hubspot.form_submissions           Form Integrations API submissions of the /enterprise form
  raw_hubspot.contact_property_changes   HubSpot webhook contact.propertyChange events
  raw_platforms.daily_conversions        SYNTHETIC platform reports (make_platform_reports.py)
  raw_synthetic.cohort_truth             Ground truth of the synthetic cohort (tests only)

Every table gets two loader columns: _source_file (lineage) and _loaded_at.
The load is a full refresh and is idempotent: it also drops the schemas dbt built from the previous
load, so the local build (append-only logs included) always starts from the fixtures alone.

Usage: uv run scripts/load_fixtures.py [--db target/local.duckdb]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import duckdb

WAREHOUSE = Path(__file__).resolve().parents[1]
CONTRACTS_FIXTURES = WAREHOUSE.parent / "contracts" / "fixtures"
SYNTHETIC = WAREHOUSE / "fixtures" / "synthetic"
DEFAULT_DB = WAREHOUSE / "target" / "local.duckdb"
STAGE_DIR = WAREHOUSE / "target" / "raw_load"
DBT_SCHEMAS = tuple(f"openart_signal_{layer}" for layer in ("staging", "intermediate", "marts", "seeds", "reporting"))

HUBSPOT_PORTAL_ID = 244977254  # OBSERVED (research/00 B1)
ENTERPRISE_FORM_GUID = "9f0b1fda-34f1-4364-93d5-bdc196c44004"  # OBSERVED (research/00 B1)

# The hand-written click-id payloads carry no uid (the backend knows it from the session).
# Their ids name the scenario user they belong to; this is that mapping (SYNTHETIC).
CLICK_ID_PAYLOAD_OWNERS = {
    ("current_payloads.json", 0): "SynthU01StarterMonA1",
    ("current_payloads.json", 1): "SynthU03PlusAddUpgC3",
    ("extended_payloads.json", 0): "SynthU01StarterMonA1",
    ("extended_payloads.json", 1): "SynthU04ChargebackD4",
}


def rel(path: Path) -> str:
    return str(path.resolve().relative_to(WAREHOUSE.parent.parent))


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def read_jsonl(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def write_stage(name: str, rows: list[dict]) -> Path:
    STAGE_DIR.mkdir(parents=True, exist_ok=True)
    path = STAGE_DIR / f"{name}.jsonl"
    with path.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, separators=(",", ":"), sort_keys=True) + "\n")
    return path


def load_table(con: duckdb.DuckDBPyConnection, table: str, rows: list[dict], columns: dict[str, str], select_sql: str) -> int:
    """Stage rows as NDJSON, then CREATE OR REPLACE the raw table from a typed SELECT."""
    stage = write_stage(table.replace(".", "__"), rows)
    col_spec = "{" + ", ".join(f"'{name}': '{typ}'" for name, typ in columns.items()) + "}"
    con.execute(
        f"create or replace table {table} as "
        f"select {select_sql}, current_timestamp::timestamp as _loaded_at "
        f"from read_json('{stage}', format = 'newline_delimited', columns = {col_spec})"
    )
    return con.execute(f"select count(*) from {table}").fetchone()[0]


ISO_TS = "cast(timezone('UTC', cast({col} as timestamptz)) as timestamp)"


def stripe_events() -> list[dict]:
    rows = []
    for path in sorted((CONTRACTS_FIXTURES / "stripe").glob("*.json")):
        for event in read_json(path):
            rows.append({**event, "_source_file": rel(path)})
    for event in read_jsonl(CONTRACTS_FIXTURES / "cohort" / "stripe_events.jsonl"):
        rows.append({**event, "_source_file": rel(CONTRACTS_FIXTURES / "cohort" / "stripe_events.jsonl")})
    return rows


def amplitude_events() -> list[dict]:
    rows = []
    for path in sorted((CONTRACTS_FIXTURES / "amplitude").glob("*.jsonl")):
        rows.extend({**r, "_source_file": rel(path)} for r in read_jsonl(path))
    for name in ("amplitude_events.jsonl", "amplitude_exposures.jsonl"):
        path = CONTRACTS_FIXTURES / "cohort" / name
        rows.extend({**r, "_source_file": rel(path)} for r in read_jsonl(path))
    # SYNTHETIC page views carrying the golden rows' device ids for U03 / U04 (fixtures/scenario_users)
    path = WAREHOUSE / "fixtures" / "scenario_users" / "amplitude_events.jsonl"
    rows.extend({k: v for k, v in r.items() if k != "data_origin"} | {"_source_file": rel(path)} for r in read_jsonl(path))
    return rows


def ledger_entries() -> list[dict]:
    rows = []
    for path in sorted((CONTRACTS_FIXTURES / "credit_ledger").glob("*.json")):
        response = read_json(path)
        rows.extend({**entry, "_source_file": rel(path)} for entry in response["entries"])
    path = CONTRACTS_FIXTURES / "cohort" / "credit_ledger.jsonl"
    rows.extend({**entry, "_source_file": rel(path)} for entry in read_jsonl(path))
    return rows


def click_id_posts() -> list[dict]:
    rows = []
    for name in ("current_payloads.json", "extended_payloads.json"):
        path = CONTRACTS_FIXTURES / "click_ids" / name
        for idx, payload in enumerate(read_json(path)):
            owner = CLICK_ID_PAYLOAD_OWNERS[(name, idx)]
            captured = [v for k, v in payload.items() if k.endswith("_created_at") or k == "context_captured_at"]
            received_ms = max(captured) + 60_000  # SYNTHETIC: posted a minute after the last capture
            rows.append(
                {
                    "user_id": owner,
                    "received_at_ms": received_ms,
                    "payload": payload,
                    "_source_file": rel(path),
                }
            )
    return rows


def app_users() -> list[dict]:
    path = CONTRACTS_FIXTURES / "cohort" / "app_users.jsonl"
    rows = [{**r, "_source_file": rel(path)} for r in read_jsonl(path)]
    # SYNTHETIC app accounts for the contracts' scenario users (fixtures/scenario_users/README.md)
    scenario = WAREHOUSE / "fixtures" / "scenario_users" / "app_users.jsonl"
    rows += [{k: v for k, v in r.items() if k != "data_origin"} | {"_source_file": rel(scenario)} for r in read_jsonl(scenario)]
    return rows


def hubspot_submissions() -> list[dict]:
    path = CONTRACTS_FIXTURES / "hubspot" / "enterprise_form_submissions.json"
    return [
        {**s, "portal_id": HUBSPOT_PORTAL_ID, "form_guid": ENTERPRISE_FORM_GUID, "_source_file": rel(path)}
        for s in read_json(path)
    ]


def hubspot_property_changes() -> list[dict]:
    path = CONTRACTS_FIXTURES / "hubspot" / "contact_lifecycle_changes.json"
    return [{**c, "_source_file": rel(path)} for c in read_json(path)]


def invoice_lookups() -> list[dict]:
    path = SYNTHETIC / "invoice_lookups.jsonl"
    return [{**r, "_source_file": rel(path)} for r in read_jsonl(path)]


def platform_reports() -> list[dict]:
    import csv

    path = SYNTHETIC / "platform_daily_conversions.csv"
    with path.open(encoding="utf-8", newline="") as fh:
        return [
            {
                **r,
                "conversions": float(r["conversions"]),
                "conversion_value": float(r["conversion_value"]),
                "_source_file": rel(path),
            }
            for r in csv.DictReader(fh)
        ]


def cohort_truth() -> list[dict]:
    path = CONTRACTS_FIXTURES / "cohort" / "cohort_truth.jsonl"
    return [{**r, "_source_file": rel(path)} for r in read_jsonl(path)]


def main() -> int:
    parser = argparse.ArgumentParser(description="Load fixtures into DuckDB raw schemas")
    parser.add_argument("--db", type=Path, default=Path(os.environ.get("WAREHOUSE_DUCKDB_PATH", DEFAULT_DB)))
    args = parser.parse_args()

    for required in (SYNTHETIC / "invoice_lookups.jsonl", SYNTHETIC / "platform_daily_conversions.csv"):
        if not required.exists():
            print(f"missing {required}: run `uv run scripts/make_platform_reports.py` first", file=sys.stderr)
            return 1

    db = args.db if args.db.is_absolute() else WAREHOUSE / args.db
    db.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(db))
    con.execute("set TimeZone = 'UTC'")
    # A local build starts from nothing: drop what dbt built last time, including the append-only
    # logs (dim_model_parameters, *_log), so every fixture build is reproducible. scripts/build.sh
    # then runs the log models a second time to prove they only append.
    for schema in DBT_SCHEMAS:
        con.execute(f"drop schema if exists {schema} cascade")
    for schema in ("raw_stripe", "raw_amplitude", "raw_app", "raw_hubspot", "raw_platforms", "raw_synthetic"):
        con.execute(f"create schema if not exists {schema}")

    counts: dict[str, int] = {}

    counts["raw_stripe.events"] = load_table(
        con,
        "raw_stripe.events",
        stripe_events(),
        {
            "id": "VARCHAR",
            "object": "VARCHAR",
            "api_version": "VARCHAR",
            "created": "BIGINT",
            "livemode": "BOOLEAN",
            "pending_webhooks": "BIGINT",
            "request": "JSON",
            "type": "VARCHAR",
            "data": "JSON",
            "_source_file": "VARCHAR",
        },
        # A sink records when it received the delivery; fixtures have none, so it equals `created`.
        "id, object, api_version, created, livemode, pending_webhooks, request, type, data, "
        "make_timestamp(created * 1000000) as received_at, _source_file",
    )

    amplitude_columns = {
        "uuid": "VARCHAR",
        "insert_id": "VARCHAR",
        "event_id": "BIGINT",
        "amplitude_id": "BIGINT",
        "app": "BIGINT",
        "event_type": "VARCHAR",
        "event_time": "VARCHAR",
        "client_event_time": "VARCHAR",
        "server_upload_time": "VARCHAR",
        "user_id": "VARCHAR",
        "device_id": "VARCHAR",
        "session_id": "BIGINT",
        "event_properties": "JSON",
        "user_properties": "JSON",
        "groups": "JSON",
        "group_properties": "JSON",
        "data": "JSON",
        "platform": "VARCHAR",
        "os_name": "VARCHAR",
        "os_version": "VARCHAR",
        "device_type": "VARCHAR",
        "device_family": "VARCHAR",
        "country": "VARCHAR",
        "region": "VARCHAR",
        "city": "VARCHAR",
        "language": "VARCHAR",
        "library": "VARCHAR",
        "ip_address": "VARCHAR",
        "_source_file": "VARCHAR",
    }
    counts["raw_amplitude.events"] = load_table(
        con,
        "raw_amplitude.events",
        amplitude_events(),
        amplitude_columns,
        ", ".join(
            ISO_TS.format(col=c) + f" as {c}" if c in ("event_time", "client_event_time", "server_upload_time") else c
            for c in amplitude_columns
        ),
    )

    ledger_columns = {
        "id": "VARCHAR",
        "sequenceId": "BIGINT",
        "type": "VARCHAR",
        "amount": "BIGINT",
        "creditField": "VARCHAR",
        "balanceBefore": "BIGINT",
        "balanceAfter": "BIGINT",
        "previousSequenceId": "BIGINT",
        "reference": "JSON",
        "idempotencyKey": "VARCHAR",
        # Kept as the API's ISO string (the contract); staging parses it.
        "createdAt": "VARCHAR",
        "userId": "VARCHAR",
        "reason": "VARCHAR",
        "teamMemberUserId": "VARCHAR",
        "businessDetails": "JSON",
        "_source_file": "VARCHAR",
    }
    counts["raw_app.credit_ledger"] = load_table(
        con, "raw_app.credit_ledger", ledger_entries(), ledger_columns, ", ".join(f'"{c}"' for c in ledger_columns)
    )

    counts["raw_app.ad_click_ids"] = load_table(
        con,
        "raw_app.ad_click_ids",
        click_id_posts(),
        {"user_id": "VARCHAR", "received_at_ms": "BIGINT", "payload": "JSON", "_source_file": "VARCHAR"},
        "user_id, make_timestamp(received_at_ms * 1000) as received_at, payload, _source_file",
    )

    counts["raw_app.users"] = load_table(
        con,
        "raw_app.users",
        app_users(),
        {"id": "VARCHAR", "email": "VARCHAR", "account_created_at": "VARCHAR", "provider": "VARCHAR", "_source_file": "VARCHAR"},
        f"id, email, {ISO_TS.format(col='account_created_at')} as account_created_at, provider, _source_file",
    )

    counts["raw_app.invoice_lookups"] = load_table(
        con,
        "raw_app.invoice_lookups",
        invoice_lookups(),
        {
            "user_id": "VARCHAR",
            "checkout_session_id": "VARCHAR",
            "requested_at": "VARCHAR",
            "http_status": "BIGINT",
            "response": "JSON",
            "_source_file": "VARCHAR",
        },
        f"user_id, checkout_session_id, {ISO_TS.format(col='requested_at')} as requested_at, http_status, response, _source_file",
    )

    counts["raw_hubspot.form_submissions"] = load_table(
        con,
        "raw_hubspot.form_submissions",
        hubspot_submissions(),
        {
            "portal_id": "BIGINT",
            "form_guid": "VARCHAR",
            "conversionId": "VARCHAR",
            "submittedAt": "BIGINT",
            "pageUrl": "VARCHAR",
            "values": "JSON",
            "_source_file": "VARCHAR",
        },
        'portal_id, form_guid, "conversionId", "submittedAt", "pageUrl", "values", _source_file',
    )

    counts["raw_hubspot.contact_property_changes"] = load_table(
        con,
        "raw_hubspot.contact_property_changes",
        hubspot_property_changes(),
        {
            "eventId": "BIGINT",
            "subscriptionId": "BIGINT",
            "portalId": "BIGINT",
            "appId": "BIGINT",
            "occurredAt": "BIGINT",
            "subscriptionType": "VARCHAR",
            "attemptNumber": "BIGINT",
            "objectId": "BIGINT",
            "propertyName": "VARCHAR",
            "propertyValue": "VARCHAR",
            "changeSource": "VARCHAR",
            "sourceId": "VARCHAR",
            "_source_file": "VARCHAR",
        },
        '"eventId", "subscriptionId", "portalId", "appId", "occurredAt", "subscriptionType", "attemptNumber", '
        '"objectId", "propertyName", "propertyValue", "changeSource", "sourceId", _source_file',
    )

    counts["raw_platforms.daily_conversions"] = load_table(
        con,
        "raw_platforms.daily_conversions",
        platform_reports(),
        {
            "platform": "VARCHAR",
            "account_id": "VARCHAR",
            "report_layer": "VARCHAR",
            "date_basis": "VARCHAR",
            "account_timezone": "VARCHAR",
            "report_date": "DATE",
            "attribution_setting": "VARCHAR",
            "conversions": "DOUBLE",
            "conversion_value": "DOUBLE",
            "currency": "VARCHAR",
            "data_origin": "VARCHAR",
            "_source_file": "VARCHAR",
        },
        "platform, account_id, report_layer, date_basis, account_timezone, report_date, attribution_setting, "
        "conversions, conversion_value, currency, data_origin, _source_file",
    )

    counts["raw_synthetic.cohort_truth"] = load_table(
        con,
        "raw_synthetic.cohort_truth",
        cohort_truth(),
        {
            "user_id": "VARCHAR",
            "signup_at": "VARCHAR",
            "country": "VARCHAR",
            "channel": "VARCHAR",
            "arm_create_image": "VARCHAR",
            "arm_create_video": "VARCHAR",
            "activated": "BOOLEAN",
            "trial_exhausted": "BOOLEAN",
            "converted": "BOOLEAN",
            "plan_tier": "VARCHAR",
            "billing_interval": "VARCHAR",
            "first_purchase_at": "VARCHAR",
            "ended_at": "VARCHAR",
            "end_reason": "VARCHAR",
            "one_time_pack": "BOOLEAN",
            "net_cash_minor": "BIGINT",
            "credits_consumed": "BIGINT",
            "generations": "BIGINT",
            "_source_file": "VARCHAR",
        },
        f"user_id, {ISO_TS.format(col='signup_at')} as signup_at, country, channel, arm_create_image, arm_create_video, "
        f"activated, trial_exhausted, converted, plan_tier, billing_interval, "
        f"{ISO_TS.format(col='first_purchase_at')} as first_purchase_at, {ISO_TS.format(col='ended_at')} as ended_at, "
        f"end_reason, one_time_pack, net_cash_minor, credits_consumed, generations, _source_file",
    )

    # Row-count guard against the cohort manifest: a silently truncated load fails here.
    manifest = read_json(CONTRACTS_FIXTURES / "cohort" / "manifest.json")["counts"]
    expected_cohort = {
        "raw_stripe.events": ("stripe_events.jsonl", "_source_file like '%cohort/stripe_events.jsonl'"),
        "raw_app.credit_ledger": ("credit_ledger.jsonl", "_source_file like '%cohort/credit_ledger.jsonl'"),
        "raw_app.users": ("app_users.jsonl", "_source_file like '%cohort/app_users.jsonl'"),
        "raw_synthetic.cohort_truth": ("cohort_truth.jsonl", "true"),
    }
    for table, (manifest_name, where) in expected_cohort.items():
        got = con.execute(f"select count(*) from {table} where {where}").fetchone()[0]
        if got != manifest[manifest_name]:
            print(f"{table}: loaded {got} cohort rows, manifest says {manifest[manifest_name]}", file=sys.stderr)
            return 1
    amp = con.execute("select count(*) from raw_amplitude.events where _source_file like '%cohort/amplitude_%'").fetchone()[0]
    if amp != manifest["amplitude_events.jsonl"] + manifest["amplitude_exposures.jsonl"]:
        print(f"raw_amplitude.events: loaded {amp} cohort rows, manifest disagrees", file=sys.stderr)
        return 1

    con.close()
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"loaded {db} at {stamp}")
    for table, n in counts.items():
        print(f"  {table:40s} {n:>7,d} rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
