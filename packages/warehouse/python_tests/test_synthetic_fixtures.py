"""The SYNTHETIC platform fixtures are reproducible and clearly labelled."""

from __future__ import annotations

import csv
import importlib.util
import json
import sys
from pathlib import Path

WAREHOUSE = Path(__file__).resolve().parents[1]
SYNTHETIC = WAREHOUSE / "fixtures" / "synthetic"


def _generator():
    spec = importlib.util.spec_from_file_location("make_platform_reports", WAREHOUSE / "scripts" / "make_platform_reports.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses resolve annotations through sys.modules
    spec.loader.exec_module(module)
    return module


def test_generator_is_deterministic_and_committed_files_are_current(tmp_path):
    fresh = _generator().build(tmp_path)
    for name, digest in fresh.items():
        committed = (SYNTHETIC / name).read_bytes()
        assert (tmp_path / name).read_bytes() == committed, f"{name} is stale: re-run scripts/make_platform_reports.py"
        assert digest


def test_every_row_is_labelled_synthetic():
    with (SYNTHETIC / "platform_daily_conversions.csv").open(encoding="utf-8", newline="") as fh:
        rows = list(csv.DictReader(fh))
    assert rows and all(r["data_origin"] == "synthetic" for r in rows)
    lookups = [json.loads(line) for line in (SYNTHETIC / "invoice_lookups.jsonl").read_text().splitlines() if line]
    assert lookups and all(r["data_origin"] == "synthetic" for r in lookups)
    manifest = json.loads((SYNTHETIC / "MANIFEST.json").read_text())
    assert manifest["data_origin"].startswith("SYNTHETIC")


def test_research_behaviours_are_present():
    """Google x2 accounts, Meta LTV on first purchase only, LinkedIn no value, X double count."""
    with (SYNTHETIC / "platform_daily_conversions.csv").open(encoding="utf-8", newline="") as fh:
        rows = [r for r in csv.DictReader(fh) if r["report_layer"] == "tag_received"]
    total = lambda p, col: sum(float(r[col]) for r in rows if r["platform"] == p)  # noqa: E731
    checkouts = total("reddit", "conversions")  # every checkout once, invoice amount
    assert total("google_ads", "conversions") == 2 * checkouts
    assert {r["account_id"] for r in rows if r["platform"] == "google_ads"} == {"AW-11252321380", "AW-16854695811"}
    assert total("x", "conversions") == 2 * checkouts
    assert total("linkedin", "conversion_value") == 0 and total("linkedin", "conversions") == checkouts
    assert total("meta", "conversions") < checkouts  # first valid purchase only
    assert total("meta", "conversion_value") > total("reddit", "conversion_value")  # LTV-valued
