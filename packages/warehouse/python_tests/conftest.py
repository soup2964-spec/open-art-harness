"""Shared fixtures. The Python checks run after scripts/build.sh (or load_fixtures.py + dbt build)."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import duckdb
import pytest

WAREHOUSE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
# Same override as profiles.yml and scripts/export_contract_rows.py.
DB = Path(os.environ.get("WAREHOUSE_DUCKDB_PATH", WAREHOUSE / "target" / "local.duckdb"))


@pytest.fixture(scope="session")
def con():
    if not DB.exists():
        pytest.fail(f"{DB} missing: run packages/warehouse/scripts/build.sh first")
    connection = duckdb.connect(str(DB), read_only=True)
    connection.execute("set TimeZone = 'UTC'")
    yield connection
    connection.close()
