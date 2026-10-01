{#-
  Date/time helpers. Convention on both engines: every TIMESTAMP column holds UTC.
  (BigQuery TIMESTAMP is absolute; DuckDB models use TIMESTAMP without zone, and the
  `local` profile pins the session zone to UTC.)
-#}

{# Unix seconds -> TIMESTAMP (UTC). #}
{% macro ts_from_unix_seconds(expr) -%}
  {{ return(adapter.dispatch('ts_from_unix_seconds', 'openart_signal')(expr)) }}
{%- endmacro %}
{% macro default__ts_from_unix_seconds(expr) -%}
  make_timestamp(cast({{ expr }} as bigint) * 1000000)
{%- endmacro %}
{% macro bigquery__ts_from_unix_seconds(expr) -%}
  timestamp_seconds(cast({{ expr }} as int64))
{%- endmacro %}

{# Unix milliseconds -> TIMESTAMP (UTC). #}
{% macro ts_from_unix_millis(expr) -%}
  {{ return(adapter.dispatch('ts_from_unix_millis', 'openart_signal')(expr)) }}
{%- endmacro %}
{% macro default__ts_from_unix_millis(expr) -%}
  make_timestamp(cast({{ expr }} as bigint) * 1000)
{%- endmacro %}
{% macro bigquery__ts_from_unix_millis(expr) -%}
  timestamp_millis(cast({{ expr }} as int64))
{%- endmacro %}

{# RFC 3339 string (e.g. '2026-07-01T10:00:00.000Z') -> TIMESTAMP (UTC). #}
{% macro ts_from_iso(expr) -%}
  {{ return(adapter.dispatch('ts_from_iso', 'openart_signal')(expr)) }}
{%- endmacro %}
{% macro default__ts_from_iso(expr) -%}
  cast(timezone('UTC', cast({{ expr }} as timestamptz)) as timestamp)
{%- endmacro %}
{% macro bigquery__ts_from_iso(expr) -%}
  timestamp({{ expr }})
{%- endmacro %}

{# ts + n seconds (n may be an expression). #}
{% macro ts_add_seconds(ts, seconds) -%}
  {{ return(adapter.dispatch('ts_add_seconds', 'openart_signal')(ts, seconds)) }}
{%- endmacro %}
{% macro default__ts_add_seconds(ts, seconds) -%}
  ({{ ts }} + to_microseconds(cast(cast({{ seconds }} as double) * 1000000 as bigint)))
{%- endmacro %}
{% macro bigquery__ts_add_seconds(ts, seconds) -%}
  timestamp_add({{ ts }}, interval cast(cast({{ seconds }} as float64) * 1000000 as int64) microsecond)
{%- endmacro %}

{# Elapsed seconds end - start as a float (exact; not calendar-boundary counting). #}
{% macro ts_diff_seconds(end_ts, start_ts) -%}
  {{ return(adapter.dispatch('ts_diff_seconds', 'openart_signal')(end_ts, start_ts)) }}
{%- endmacro %}
{% macro default__ts_diff_seconds(end_ts, start_ts) -%}
  ((epoch_us({{ end_ts }}) - epoch_us({{ start_ts }})) / 1000000.0)
{%- endmacro %}
{% macro bigquery__ts_diff_seconds(end_ts, start_ts) -%}
  ((unix_micros({{ end_ts }}) - unix_micros({{ start_ts }})) / 1000000.0)
{%- endmacro %}

{# Calendar date of a UTC timestamp in an IANA time zone (a literal like 'America/Los_Angeles' or a column). #}
{% macro date_in_tz(ts, tz_expr) -%}
  {{ return(adapter.dispatch('date_in_tz', 'openart_signal')(ts, tz_expr)) }}
{%- endmacro %}
{% macro default__date_in_tz(ts, tz_expr) -%}
  cast(timezone({{ tz_expr }}, timezone('UTC', {{ ts }})) as date)
{%- endmacro %}
{% macro bigquery__date_in_tz(ts, tz_expr) -%}
  date({{ ts }}, {{ tz_expr }})
{%- endmacro %}

{# First day of the month of a DATE. #}
{% macro month_start(date_expr) -%}
  {{ return(adapter.dispatch('month_start', 'openart_signal')(date_expr)) }}
{%- endmacro %}
{% macro default__month_start(date_expr) -%}
  cast(date_trunc('month', {{ date_expr }}) as date)
{%- endmacro %}
{% macro bigquery__month_start(date_expr) -%}
  date_trunc({{ date_expr }}, month)
{%- endmacro %}

{# RFC 3339 string with milliseconds and Z, e.g. '2026-06-02T14:57:40.000Z' (contract format). #}
{% macro ts_to_iso_ms(ts) -%}
  {{ return(adapter.dispatch('ts_to_iso_ms', 'openart_signal')(ts)) }}
{%- endmacro %}
{% macro default__ts_to_iso_ms(ts) -%}
  strftime({{ ts }}, '%Y-%m-%dT%H:%M:%S.%gZ')
{%- endmacro %}
{% macro bigquery__ts_to_iso_ms(ts) -%}
  format_timestamp('%Y-%m-%dT%H:%M:%E3SZ', {{ ts }}, 'UTC')
{%- endmacro %}

{# The current instant as a UTC TIMESTAMP. #}
{% macro current_ts_utc() -%}
  {{ return(adapter.dispatch('current_ts_utc', 'openart_signal')()) }}
{%- endmacro %}
{% macro default__current_ts_utc() -%}
  cast(timezone('UTC', current_timestamp) as timestamp)
{%- endmacro %}
{% macro bigquery__current_ts_utc() -%}
  current_timestamp()
{%- endmacro %}

{# UTC timestamp literal from 'YYYY-MM-DD HH:MM:SS'. #}
{% macro ts_literal(value) -%}
  {{ return(adapter.dispatch('ts_literal', 'openart_signal')(value)) }}
{%- endmacro %}
{% macro default__ts_literal(value) -%}
  cast('{{ value }}' as timestamp)
{%- endmacro %}
{% macro bigquery__ts_literal(value) -%}
  timestamp('{{ value }}+00')
{%- endmacro %}

{# Monday of the ISO week of a UTC timestamp, as a DATE. #}
{% macro week_start(ts) -%}
  {{ return(adapter.dispatch('week_start', 'openart_signal')(ts)) }}
{%- endmacro %}
{% macro default__week_start(ts) -%}
  cast(date_trunc('week', {{ ts }}) as date)
{%- endmacro %}
{% macro bigquery__week_start(ts) -%}
  date_trunc(date({{ ts }}), week(monday))
{%- endmacro %}

{# DATE + n days (n may be an expression). #}
{% macro date_add_days(date_expr, days) -%}
  {{ return(adapter.dispatch('date_add_days', 'openart_signal')(date_expr, days)) }}
{%- endmacro %}
{% macro default__date_add_days(date_expr, days) -%}
  cast({{ date_expr }} + to_days(cast({{ days }} as integer)) as date)
{%- endmacro %}
{% macro bigquery__date_add_days(date_expr, days) -%}
  date_add({{ date_expr }}, interval cast({{ days }} as int64) day)
{%- endmacro %}

{# TIMESTAMP (UTC midnight) of a DATE. #}
{% macro date_to_ts(date_expr) -%}
  {{ return(adapter.dispatch('date_to_ts', 'openart_signal')(date_expr)) }}
{%- endmacro %}
{% macro default__date_to_ts(date_expr) -%}
  cast({{ date_expr }} as timestamp)
{%- endmacro %}
{% macro bigquery__date_to_ts(date_expr) -%}
  timestamp({{ date_expr }})
{%- endmacro %}

{# 'YYYYMMDD' string of a DATE (portable, used in ids). #}
{% macro date_compact(date_expr) -%}
  {{ return(adapter.dispatch('date_compact', 'openart_signal')(date_expr)) }}
{%- endmacro %}
{% macro default__date_compact(date_expr) -%}
  strftime({{ date_expr }}, '%Y%m%d')
{%- endmacro %}
{% macro bigquery__date_compact(date_expr) -%}
  format_date('%Y%m%d', {{ date_expr }})
{%- endmacro %}
