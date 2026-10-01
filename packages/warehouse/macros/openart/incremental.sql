{#- Incremental helpers. -#}

{#-
  is_incremental() asks the warehouse whether the target table exists. The offline BigQuery
  compile check has no warehouse to ask, so it pins the answer with
  --vars '{compile_check_force_incremental: true}' (the incremental branch is the one worth
  syntax-checking). Everywhere else this is plain is_incremental().
-#}
{% macro openart_is_incremental() -%}
  {%- set forced = var('compile_check_force_incremental', none) -%}
  {%- if forced is not none -%}
    {{ return(forced in [true, 'true', 'True', 1, '1']) }}
  {%- elif this is none -%}
    {#- unit tests render models without a target relation: never incremental there -#}
    {{ return(false) }}
  {%- else -%}
    {{ return(is_incremental()) }}
  {%- endif -%}
{%- endmacro %}

{#-
  stg_amplitude__events is partitioned by event_time day with require_partition_filter on
  BigQuery, so every reader states the history it scans. Readers that need a user's whole
  history (first touch, first exposure) scan from var amplitude_history_start on purpose.
-#}
{% macro amplitude_history_filter(alias=none) -%}
  {{ (alias ~ '.') if alias else '' }}event_time >= {{ ts_literal(var('amplitude_history_start')) }}
{%- endmacro %}

{# Incremental strategy for append-only logs: dbt-duckdb appends; dbt-bigquery merges with no key (= insert). #}
{% macro append_only_strategy() -%}
  {{ return('merge' if target.type == 'bigquery' else 'append') }}
{%- endmacro %}
