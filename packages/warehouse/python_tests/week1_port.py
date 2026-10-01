"""Run the BigQuery queries in docs/week1-sizing-queries.md on the local DuckDB fixture build.

The doc targets OpenArt's own tables. Each ```sql block is ported mechanically:

1. every `YOUR_PROJECT...` placeholder is pointed at a raw fixture relation (TABLES). OpenArt's
   Stripe Data Pipeline `invoices` table does not exist locally, so INVOICES_VIEW rebuilds it as a
   TEMP view from the raw Stripe `invoice.paid` events, with Sigma's column names;
2. the block is parsed with sqlglot's BigQuery dialect. DECLARE statements are dropped and each
   script variable is replaced by its DEFAULT (or an override), and CURRENT_DATE() /
   CURRENT_TIMESTAMP() by the fixture as-of (the cohort's simulationEnd, dbt var
   fixture_as_of_timestamp);
3. the statement is transpiled to DuckDB.

Only raw relations and the model_costs seed are read, never staging or marts, so the queries are
checked against the fixtures independently of the dbt models.
"""

from __future__ import annotations

import re
from pathlib import Path

import duckdb
import sqlglot
from sqlglot import exp

WAREHOUSE = Path(__file__).resolve().parents[1]
DOC = WAREHOUSE / "docs" / "week1-sizing-queries.md"

# packages/contracts/src/cohort/params.ts simulationEnd; dbt_project.yml fixture_as_of_timestamp.
AS_OF = "2026-09-28 00:00:00"

INVOICES_VIEW_NAME = "wk1_stripe_invoices"
TABLES = {
    "`YOUR_PROJECT.amplitude.EVENTS_YOUR_AMPLITUDE_PROJECT_ID`": "raw_amplitude.events",
    "`YOUR_PROJECT.app.credit_ledger`": "raw_app.credit_ledger",
    "`YOUR_PROJECT.openart_signal_seeds.model_costs`": "openart_signal_seeds.model_costs",
    "`YOUR_PROJECT.stripe.invoices`": INVOICES_VIEW_NAME,
}

# One row per invoice (its latest invoice.paid delivery), live mode only, like the Sigma table.
INVOICES_VIEW = f"""
create or replace temp view {INVOICES_VIEW_NAME} as
select id, customer_id, subscription_id, billing_reason, status, amount_paid, currency, total,
       total_excluding_tax, created
from (
    select
        e.data->>'$.object.id' as id,
        e.data->>'$.object.customer' as customer_id,
        e.data->>'$.object.parent.subscription_details.subscription' as subscription_id,
        e.data->>'$.object.billing_reason' as billing_reason,
        e.data->>'$.object.status' as status,
        cast(e.data->>'$.object.amount_paid' as bigint) as amount_paid,
        lower(e.data->>'$.object.currency') as currency,
        cast(e.data->>'$.object.total' as bigint) as total,
        cast(e.data->>'$.object.total_excluding_tax' as bigint) as total_excluding_tax,
        make_timestamp(cast(e.data->>'$.object.created' as bigint) * 1000000) as created,
        row_number() over (
            partition by e.data->>'$.object.id' order by e.created desc, e.received_at desc, e.id desc
        ) as delivery_rank
    from raw_stripe.events as e
    where e.type = 'invoice.paid' and e.livemode
)
where delivery_rank = 1
"""

HEADING = re.compile(r"^## (Q\d+)\.", re.M)
SQL_BLOCK = re.compile(r"```sql\n(.*?)```", re.S)


def doc_text() -> str:
    return DOC.read_text(encoding="utf-8")


def sql_blocks(text: str | None = None) -> dict[str, str]:
    """{'Q0': sql, ..., 'Q5a': sql, 'Q5b': sql, ...}: blocks named by the `## Qn.` heading above them."""
    text = doc_text() if text is None else text
    headings = list(HEADING.finditer(text))
    blocks: dict[str, str] = {}
    for i, heading in enumerate(headings):
        end = headings[i + 1].start() if i + 1 < len(headings) else len(text)
        found = SQL_BLOCK.findall(text[heading.end() : end])
        for j, sql in enumerate(found):
            name = heading.group(1) if len(found) == 1 else f"{heading.group(1)}{'abcdefgh'[j]}"
            blocks[name] = sql
    return blocks


def placeholders(sql: str) -> set[str]:
    return set(re.findall(r"`YOUR_PROJECT\.[^`]+`", sql))


def _statements(
    sql: str, tables: dict[str, str] | None = None
) -> tuple[dict[str, exp.Expression], list[exp.Expression]]:
    for placeholder, relation in {**TABLES, **(tables or {})}.items():
        sql = sql.replace(placeholder, relation)
    left = placeholders(sql)
    if left:
        raise ValueError(f"no local relation for {sorted(left)}; add it to TABLES")
    variables: dict[str, exp.Expression] = {}
    body: list[exp.Expression] = []
    for statement in sqlglot.parse(sql, read="bigquery"):
        if statement is None:
            continue
        if isinstance(statement, exp.Declare):
            for item in statement.expressions:
                names = item.this if isinstance(item.this, list) else [item.this]
                for name in names:
                    variables[name.name] = item.args["default"]
        else:
            body.append(statement)
    return variables, body


def declared(sql: str) -> dict[str, str]:
    """DECLARE defaults of a block as BigQuery SQL text, e.g. {'cohort_start': "TIMESTAMP('2026-06-01')"}."""
    variables, _ = _statements(sql)
    return {name: value.sql(dialect="bigquery") for name, value in variables.items()}


def port(
    sql: str,
    *,
    as_of: str = AS_OF,
    overrides: dict[str, str] | None = None,
    tables: dict[str, str] | None = None,
) -> str:
    """Transpile one doc block to a single DuckDB statement.

    as_of: what CURRENT_TIMESTAMP() / CURRENT_DATE() mean, UTC 'YYYY-MM-DD HH:MM:SS'.
    overrides: {variable: BigQuery expression}, e.g. {'cohort_end': "TIMESTAMP('2026-07-01')"}.
    tables: {placeholder: relation} replacing entries of TABLES for this call.
    """
    variables, body = _statements(sql, tables)
    if len(body) != 1:
        raise ValueError(f"expected one query after the DECLAREs, got {len(body)}")
    for name, value in (overrides or {}).items():
        if name not in variables:
            raise KeyError(f"{name} is not DECLAREd in this block")
        variables[name] = sqlglot.parse_one(value, read="bigquery")
    now = sqlglot.parse_one(f"TIMESTAMP('{as_of}+00')", read="bigquery")
    today = sqlglot.parse_one(f"DATE('{as_of[:10]}')", read="bigquery")

    def substitute(node: exp.Expression) -> exp.Expression:
        if isinstance(node, exp.Column) and not node.table and node.name in variables:
            return variables[node.name].copy()
        if isinstance(node, exp.CurrentTimestamp):
            return now.copy()
        if isinstance(node, exp.CurrentDate):
            return today.copy()
        # sqlglot renders BigQuery JSON_KEYS as a function DuckDB lacks; DuckDB's json_keys matches
        # it on flat objects such as event_properties.
        if type(node).__name__ == "JSONKeysAtDepth":
            return exp.Anonymous(this="json_keys", expressions=[node.this.copy()])
        return node

    return body[0].transform(substitute).sql(dialect="duckdb")


def install(con: duckdb.DuckDBPyConnection) -> None:
    """TEMP relations the ported queries need (works on a read-only connection)."""
    con.execute(INVOICES_VIEW)


def run(con: duckdb.DuckDBPyConnection, sql: str, **kwargs) -> list[dict]:
    result = con.execute(port(sql, **kwargs))
    columns = [d[0] for d in result.description]
    return [dict(zip(columns, row)) for row in result.fetchall()]
