{#- Run-level context shared by every model. -#}

{# True on the local fixture target (synthetic sources and ground-truth tests enabled). #}
{% macro is_fixture_mode() -%}
  {%- set explicit = var('fixture_mode', none) -%}
  {%- if explicit is not none -%}
    {{ return(explicit in [true, 'true', 'True', 1, '1']) }}
  {%- else -%}
    {{ return(target.name == 'local') }}
  {%- endif -%}
{%- endmacro %}

{#-
  The "as of" instant for anything that depends on how old a user or subscription is
  (maturity windows, active subscriptions, censoring). Pinned for fixture runs so outputs are
  deterministic; CURRENT_TIMESTAMP in production unless --vars as_of_timestamp is given.
-#}
{% macro as_of_ts() -%}
  {%- set pinned = var('as_of_timestamp', none) -%}
  {%- if pinned -%}
    {{ ts_literal(pinned) }}
  {%- elif is_fixture_mode() -%}
    {{ ts_literal(var('fixture_as_of_timestamp')) }}
  {%- else -%}
    {{ current_ts_utc() }}
  {%- endif -%}
{%- endmacro %}

{#-
  on-run-start guard for local runs: fail fast with instructions when the raw schemas have
  not been loaded, instead of 40 "table does not exist" errors. Renders nothing elsewhere.
-#}
{% macro assert_raw_sources_loaded() -%}
  {%- if execute and is_fixture_mode() and target.type == 'duckdb' -%}
    {%- set required = [
      ('raw_stripe', 'events'), ('raw_amplitude', 'events'), ('raw_app', 'credit_ledger'),
      ('raw_app', 'ad_click_ids'), ('raw_app', 'users'), ('raw_app', 'invoice_lookups'),
      ('raw_hubspot', 'form_submissions'), ('raw_hubspot', 'contact_property_changes'),
      ('raw_platforms', 'daily_conversions'), ('raw_synthetic', 'cohort_truth')
    ] -%}
    {%- set found = run_query(
      "select table_schema || '.' || table_name from information_schema.tables "
      ~ "where table_schema like 'raw_%'"
    ).columns[0].values() -%}
    {%- set missing = [] -%}
    {%- for schema, table in required -%}
      {%- if (schema ~ '.' ~ table) not in found -%}{%- do missing.append(schema ~ '.' ~ table) -%}{%- endif -%}
    {%- endfor -%}
    {%- if missing -%}
      {{ exceptions.raise_compiler_error(
        "Raw fixtures not loaded (missing " ~ missing | join(', ') ~ "). From packages/warehouse run: "
        ~ "uv run scripts/make_platform_reports.py && uv run scripts/load_fixtures.py (or scripts/build.sh)."
      ) }}
    {%- endif -%}
  {%- endif -%}
{%- endmacro %}

{# TRUE when the user is a QA/test account (seeds/qa_accounts.csv); never NULL. #}
{% macro qa_account_flag(user_id_expr) -%}
  coalesce({{ user_id_expr }} in (select qa.user_id from {{ ref('qa_accounts') }} as qa), false)
{%- endmacro %}
