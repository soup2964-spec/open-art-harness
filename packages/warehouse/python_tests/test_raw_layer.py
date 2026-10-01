"""The raw layer mirrors the fixture files exactly (no silent truncation or duplication)."""

from __future__ import annotations

import json
from pathlib import Path

CONTRACTS = Path(__file__).resolve().parents[2] / "contracts" / "fixtures"
# SYNTHETIC scenario-user rows the warehouse adds (fixtures/scenario_users/README.md)
SCENARIO = Path(__file__).resolve().parents[1] / "fixtures" / "scenario_users"


def _lines(path: Path) -> int:
    return sum(1 for line in path.read_text(encoding="utf-8").splitlines() if line.strip())


def test_raw_row_counts_match_fixture_files(con):
    stripe_scenarios = sum(len(json.loads(p.read_text())) for p in (CONTRACTS / "stripe").glob("*.json"))
    ledger_scenarios = sum(len(json.loads(p.read_text())["entries"]) for p in (CONTRACTS / "credit_ledger").glob("*.json"))
    amplitude_scenarios = sum(_lines(p) for p in (CONTRACTS / "amplitude").glob("*.jsonl"))
    expected = {
        "raw_stripe.events": stripe_scenarios + _lines(CONTRACTS / "cohort" / "stripe_events.jsonl"),
        "raw_app.credit_ledger": ledger_scenarios + _lines(CONTRACTS / "cohort" / "credit_ledger.jsonl"),
        "raw_amplitude.events": amplitude_scenarios
        + _lines(CONTRACTS / "cohort" / "amplitude_events.jsonl")
        + _lines(CONTRACTS / "cohort" / "amplitude_exposures.jsonl")
        + _lines(SCENARIO / "amplitude_events.jsonl"),
        "raw_app.users": _lines(CONTRACTS / "cohort" / "app_users.jsonl") + _lines(SCENARIO / "app_users.jsonl"),
        "raw_synthetic.cohort_truth": _lines(CONTRACTS / "cohort" / "cohort_truth.jsonl"),
        "raw_hubspot.form_submissions": len(json.loads((CONTRACTS / "hubspot" / "enterprise_form_submissions.json").read_text())),
        "raw_hubspot.contact_property_changes": len(json.loads((CONTRACTS / "hubspot" / "contact_lifecycle_changes.json").read_text())),
    }
    for table, n in expected.items():
        assert con.execute(f"select count(*) from {table}").fetchone()[0] == n, table


def test_raw_timestamps_are_utc(con):
    # 2026-06-01T00:20:15.000Z must load as 00:20:15, not shifted by the machine's zone.
    got = con.execute(
        "select min(event_time) from raw_amplitude.events where uuid = '282cfd5b-4eb9-46f1-9805-7747c5a0ffb0'"
    ).fetchone()[0]
    assert got.isoformat() == "2026-06-01T00:20:15"
