"""Every SQL snippet in the docs is valid BigQuery SQL, and every Metabase question runs.

* docs/metabase/*.sql: variables are substituted from the `@param` header (defaults; optional
  [[ ... ]] clauses are dropped), then the SQL is parsed with sqlglot's BigQuery dialect AND
  executed against the local DuckDB build, where it must return rows.
* docs/week1-sizing-queries.md: every ```sql block parses with the BigQuery dialect (they target
  OpenArt's own tables, which do not exist locally).
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import sqlglot

WAREHOUSE = Path(__file__).resolve().parents[1]
METABASE = sorted((WAREHOUSE / "docs" / "metabase").glob("*.sql"))
PARAM = re.compile(r"^--\s+@param\s+(\w+)\s+\w+\s+(default\s+('[^']*')|optional)", re.M)


def render_metabase(sql: str) -> str:
    params = {name: default for name, _, default in PARAM.findall(sql)}
    # optional clauses: keep them only when every variable inside has a default
    def optional(match: re.Match) -> str:
        names = re.findall(r"\{\{(\w+)\}\}", match.group(1))
        return match.group(1) if all(params.get(n) for n in names) else ""

    sql = re.sub(r"\[\[(.*?)\]\]", optional, sql, flags=re.S)
    missing = [n for n in re.findall(r"\{\{(\w+)\}\}", sql) if not params.get(n)]
    assert not missing, f"required variables without a default: {missing}"
    return re.sub(r"\{\{(\w+)\}\}", lambda m: params[m.group(1)], sql)


def test_metabase_questions_exist():
    assert len(METABASE) >= 7


@pytest.mark.parametrize("path", METABASE, ids=lambda p: p.name)
def test_metabase_question_parses_as_bigquery_and_runs(path, con):
    text = path.read_text(encoding="utf-8")
    sql = render_metabase(text)
    sqlglot.parse_one(sql, read="bigquery")
    rows = con.execute(sql).fetchall()
    # an alerting question (quarantine) is allowed to be empty on a clean build: it says so in its header
    assert rows or "@allow_empty" in text, f"{path.name} returned no rows on the fixture build"


def test_week1_queries_parse_as_bigquery():
    text = (WAREHOUSE / "docs" / "week1-sizing-queries.md").read_text(encoding="utf-8")
    blocks = re.findall(r"```sql\n(.*?)```", text, flags=re.S)
    assert len(blocks) >= 6
    for block in blocks:
        parsed = sqlglot.parse(block, read="bigquery")
        assert parsed and all(p is not None for p in parsed)
        tables = {t.sql(dialect="bigquery") for p in parsed for t in p.find_all(sqlglot.exp.Table)}
        real = {t for t in tables if "YOUR_PROJECT" in t}
        assert real, f"a sizing query must read OpenArt's tables: {block[:80]}"
