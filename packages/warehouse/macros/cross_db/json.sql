{#-
  JSON helpers. Every function the models need that is spelled differently on BigQuery and
  DuckDB goes through adapter.dispatch, so one model file compiles on both engines.

  Paths are JSONPath strings that both engines accept, e.g. '$.object.id' or
  '$."ab_suite-default-model-create-image"' (double-quote keys with special characters).
  Inputs may be a JSON column or a STRING holding JSON on either engine.
-#}

{# Scalar at path as STRING (NULL for JSON null / missing). Only use on scalars. #}
{% macro json_str(expr, path) -%}
  {{ return(adapter.dispatch('json_str', 'openart_signal')(expr, path)) }}
{%- endmacro %}
{% macro default__json_str(expr, path) -%}
  json_extract_string({{ expr }}, '{{ path }}')
{%- endmacro %}
{% macro bigquery__json_str(expr, path) -%}
  json_value({{ expr }}, '{{ path }}')
{%- endmacro %}

{# Scalar at path as a 64-bit integer (NULL when missing or not an integer). #}
{% macro json_int(expr, path) -%}
  {{ return(adapter.dispatch('json_int', 'openart_signal')(expr, path)) }}
{%- endmacro %}
{% macro default__json_int(expr, path) -%}
  try_cast(json_extract_string({{ expr }}, '{{ path }}') as bigint)
{%- endmacro %}
{% macro bigquery__json_int(expr, path) -%}
  safe_cast(json_value({{ expr }}, '{{ path }}') as int64)
{%- endmacro %}

{# Scalar at path as a double. #}
{% macro json_float(expr, path) -%}
  {{ return(adapter.dispatch('json_float', 'openart_signal')(expr, path)) }}
{%- endmacro %}
{% macro default__json_float(expr, path) -%}
  try_cast(json_extract_string({{ expr }}, '{{ path }}') as double)
{%- endmacro %}
{% macro bigquery__json_float(expr, path) -%}
  safe_cast(json_value({{ expr }}, '{{ path }}') as float64)
{%- endmacro %}

{# Scalar at path as a boolean. #}
{% macro json_bool(expr, path) -%}
  {{ return(adapter.dispatch('json_bool', 'openart_signal')(expr, path)) }}
{%- endmacro %}
{% macro default__json_bool(expr, path) -%}
  try_cast(json_extract_string({{ expr }}, '{{ path }}') as boolean)
{%- endmacro %}
{% macro bigquery__json_bool(expr, path) -%}
  safe_cast(json_value({{ expr }}, '{{ path }}') as bool)
{%- endmacro %}

{# Object or array at path, as JSON. #}
{% macro json_query(expr, path) -%}
  {{ return(adapter.dispatch('json_query', 'openart_signal')(expr, path)) }}
{%- endmacro %}
{% macro default__json_query(expr, path) -%}
  json_extract({{ expr }}, '{{ path }}')
{%- endmacro %}
{% macro bigquery__json_query(expr, path) -%}
  json_query({{ expr }}, '{{ path }}')
{%- endmacro %}

{# Number of elements of the array at path (NULL when not an array). #}
{% macro json_array_length(expr, path) -%}
  {{ return(adapter.dispatch('json_array_length', 'openart_signal')(expr, path)) }}
{%- endmacro %}
{% macro default__json_array_length(expr, path) -%}
  json_array_length({{ expr }}, '{{ path }}')
{%- endmacro %}
{% macro bigquery__json_array_length(expr, path) -%}
  array_length(json_query_array({{ expr }}, '{{ path }}'))
{%- endmacro %}

{#-
  FROM-clause fragment that fans a row out over the elements of a JSON array:
    from invoices as i {{ json_array_join('i.lines', '$.data', 'line') }}
  exposes `line` (JSON element) and `line_idx` (0-based position). Rows whose array is
  missing or empty are dropped, identically on both engines.
-#}
{% macro json_array_join(expr, path, alias) -%}
  {{ return(adapter.dispatch('json_array_join', 'openart_signal')(expr, path, alias)) }}
{%- endmacro %}
{% macro default__json_array_join(expr, path, alias) -%}
  cross join lateral (
    select
      unnest(_arr) as {{ alias }},
      unnest(range(len(_arr))) as {{ alias }}_idx
    from (select cast(json_extract({{ expr }}, '{{ path }}') as json[]) as _arr)
  ) as {{ alias }}_unnested
{%- endmacro %}
{% macro bigquery__json_array_join(expr, path, alias) -%}
  cross join unnest(json_query_array({{ expr }}, '{{ path }}')) as {{ alias }} with offset as {{ alias }}_idx
{%- endmacro %}

{# JSON object literal '{}' of JSON type. #}
{% macro json_empty_object() -%}
  {{ return(adapter.dispatch('json_empty_object', 'openart_signal')()) }}
{%- endmacro %}
{% macro default__json_empty_object() -%}
  cast('{}' as json)
{%- endmacro %}
{% macro bigquery__json_empty_object() -%}
  json '{}'
{%- endmacro %}

{# JSON null / SQL NULL typed as JSON (for UNION branches). #}
{% macro json_null() -%}
  {{ return(adapter.dispatch('json_null', 'openart_signal')()) }}
{%- endmacro %}
{% macro default__json_null() -%}
  cast(null as json)
{%- endmacro %}
{% macro bigquery__json_null() -%}
  cast(null as json)
{%- endmacro %}

{#-
  Aggregate key/value rows into one JSON object, keys sorted, NULL keys skipped:
    {{ json_object_agg('flag_key', 'arm') }}
  Returns NULL when every key is NULL; wrap in coalesce(..., json_empty_object()).
  value_expr may be a scalar or a JSON value (JSON values stay nested, not stringified).
-#}
{% macro json_object_agg(key_expr, value_expr) -%}
  {{ return(adapter.dispatch('json_object_agg', 'openart_signal')(key_expr, value_expr)) }}
{%- endmacro %}
{% macro default__json_object_agg(key_expr, value_expr) -%}
  {#- json_group_object is a macro in DuckDB (no FILTER / ORDER BY, errors on NULL keys), so build
      an ordered MAP from a filtered list aggregate and serialise it. Keys must be unique per group. -#}
  to_json(map_from_entries(
    list(struct_pack(k := {{ key_expr }}, v := {{ value_expr }}) order by {{ key_expr }})
      filter (where {{ key_expr }} is not null)
  ))
{%- endmacro %}
{% macro bigquery__json_object_agg(key_expr, value_expr) -%}
  if(
    count({{ key_expr }}) = 0,
    null,
    json_object(
      array_agg(if({{ key_expr }} is null, null, {{ key_expr }}) ignore nulls order by {{ key_expr }}),
      array_agg(if({{ key_expr }} is null, null, to_json({{ value_expr }})) ignore nulls order by {{ key_expr }})
    )
  )
{%- endmacro %}

{# Parse a STRING into JSON. #}
{% macro json_parse(expr) -%}
  {{ return(adapter.dispatch('json_parse', 'openart_signal')(expr)) }}
{%- endmacro %}
{% macro default__json_parse(expr) -%}
  cast({{ expr }} as json)
{%- endmacro %}
{% macro bigquery__json_parse(expr) -%}
  safe.parse_json({{ expr }})
{%- endmacro %}

{# Serialise JSON to a STRING (for equality checks and exports). #}
{% macro json_to_string(expr) -%}
  {{ return(adapter.dispatch('json_to_string', 'openart_signal')(expr)) }}
{%- endmacro %}
{% macro default__json_to_string(expr) -%}
  cast({{ expr }} as varchar)
{%- endmacro %}
{% macro bigquery__json_to_string(expr) -%}
  to_json_string({{ expr }})
{%- endmacro %}
