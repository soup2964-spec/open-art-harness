{#- Hashing, arithmetic, regex and string helpers that differ between BigQuery and DuckDB. -#}

{# Lower-case hex SHA-256 of a STRING (UTF-8), e.g. Meta external_id = sha256_hex(lower(uid)). #}
{% macro sha256_hex(expr) -%}
  {{ return(adapter.dispatch('sha256_hex', 'openart_signal')(expr)) }}
{%- endmacro %}
{% macro default__sha256_hex(expr) -%}
  sha256({{ expr }})
{%- endmacro %}
{% macro bigquery__sha256_hex(expr) -%}
  to_hex(sha256({{ expr }}))
{%- endmacro %}

{# numerator / denominator, NULL when the denominator is 0 or NULL. Always floating point. #}
{% macro safe_divide(numerator, denominator) -%}
  {{ return(adapter.dispatch('safe_divide', 'openart_signal')(numerator, denominator)) }}
{%- endmacro %}
{% macro default__safe_divide(numerator, denominator) -%}
  (cast({{ numerator }} as double) / nullif(cast({{ denominator }} as double), 0))
{%- endmacro %}
{% macro bigquery__safe_divide(numerator, denominator) -%}
  safe_divide(cast({{ numerator }} as float64), cast({{ denominator }} as float64))
{%- endmacro %}

{# TRUE when the string matches the (RE2-compatible) pattern anywhere; anchor with ^...$. #}
{% macro regexp_like(expr, pattern) -%}
  {{ return(adapter.dispatch('regexp_like', 'openart_signal')(expr, pattern)) }}
{%- endmacro %}
{% macro default__regexp_like(expr, pattern) -%}
  regexp_matches({{ expr }}, '{{ pattern }}')
{%- endmacro %}
{% macro bigquery__regexp_like(expr, pattern) -%}
  regexp_contains({{ expr }}, r'{{ pattern }}')
{%- endmacro %}

{# First capture group of pattern (NULL when no match). #}
{% macro regexp_extract_group(expr, pattern) -%}
  {{ return(adapter.dispatch('regexp_extract_group', 'openart_signal')(expr, pattern)) }}
{%- endmacro %}
{% macro default__regexp_extract_group(expr, pattern) -%}
  nullif(regexp_extract({{ expr }}, '{{ pattern }}', 1), '')
{%- endmacro %}
{% macro bigquery__regexp_extract_group(expr, pattern) -%}
  regexp_extract({{ expr }}, r'{{ pattern }}')
{%- endmacro %}

{# Replace every match of pattern. #}
{% macro regexp_replace_all(expr, pattern, replacement) -%}
  {{ return(adapter.dispatch('regexp_replace_all', 'openart_signal')(expr, pattern, replacement)) }}
{%- endmacro %}
{% macro default__regexp_replace_all(expr, pattern, replacement) -%}
  regexp_replace({{ expr }}, '{{ pattern }}', '{{ replacement }}', 'g')
{%- endmacro %}
{% macro bigquery__regexp_replace_all(expr, pattern, replacement) -%}
  regexp_replace({{ expr }}, r'{{ pattern }}', '{{ replacement }}')
{%- endmacro %}

{# 1-based part of a delimited string, NULL when out of range (BigQuery semantics on both). #}
{% macro split_part_or_null(expr, delimiter, part_number) -%}
  {{ return(adapter.dispatch('split_part_or_null', 'openart_signal')(expr, delimiter, part_number)) }}
{%- endmacro %}
{% macro default__split_part_or_null(expr, delimiter, part_number) -%}
  nullif(split_part({{ expr }}, '{{ delimiter }}', {{ part_number }}), '')
{%- endmacro %}
{% macro bigquery__split_part_or_null(expr, delimiter, part_number) -%}
  nullif(split({{ expr }}, '{{ delimiter }}')[safe_offset({{ part_number }} - 1)], '')
{%- endmacro %}

{# Sample standard deviation (identical name on both, kept here so every stat reads the same). #}
{% macro stddev_samp(expr) -%}
  stddev_samp({{ expr }})
{%- endmacro %}

{# Portable GREATEST/LEAST over two non-NULL-safe inputs: DuckDB ignores NULLs, BigQuery
   returns NULL, so both are coalesced first. #}
{% macro greatest_of(a, b, if_null=0) -%}
  greatest(coalesce({{ a }}, {{ if_null }}), coalesce({{ b }}, {{ if_null }}))
{%- endmacro %}
{% macro least_of(a, b, if_null=0) -%}
  least(coalesce({{ a }}, {{ if_null }}), coalesce({{ b }}, {{ if_null }}))
{%- endmacro %}

{# Portable string literal list for IN (...): {{ sql_in(['a','b']) }} #}
{% macro sql_in(values) -%}
  ({% for v in values %}'{{ v }}'{% if not loop.last %}, {% endif %}{% endfor %})
{%- endmacro %}

{# 64-bit floating point on both engines (dbt.type_float() is 4-byte REAL on DuckDB: never for money). #}
{% macro type_double() -%}
  {{ return(adapter.dispatch('type_double', 'openart_signal')()) }}
{%- endmacro %}
{% macro default__type_double() -%}
  double
{%- endmacro %}
{% macro bigquery__type_double() -%}
  float64
{%- endmacro %}

{#-
  First non-NULL value of `value` ordered by `order_by` (optionally among rows where `where`
  holds), as an aggregate: {{ first_by('country', 'event_time, event_uuid') }}.
-#}
{% macro first_by(value, order_by, where=none) -%}
  {{ return(adapter.dispatch('first_by', 'openart_signal')(value, order_by, where)) }}
{%- endmacro %}
{% macro default__first_by(value, order_by, where) -%}
  (list({{ value }} order by {{ order_by }}) filter (where ({{ value }}) is not null{% if where %} and ({{ where }}){% endif %}))[1]
{%- endmacro %}
{% macro bigquery__first_by(value, order_by, where) -%}
  array_agg({% if where %}if({{ where }}, {{ value }}, null){% else %}{{ value }}{% endif %} ignore nulls order by {{ order_by }} limit 1)[safe_offset(0)]
{%- endmacro %}

{#-
  Integer value of the first n_chars characters of a lower-case hex string, identically on both
  engines (e.g. of sha256_hex(user_id) for a deterministic, portable fold or random number).
-#}
{% macro hex_prefix_to_int(hex_expr, n_chars) -%}
  ({% for i in range(n_chars) -%}
    (strpos('0123456789abcdef', substr({{ hex_expr }}, {{ i + 1 }}, 1)) - 1) * {{ 16 ** (n_chars - 1 - i) }}{% if not loop.last %} + {% endif %}
  {%- endfor %})
{%- endmacro %}

{# Deterministic uniform in [0, 1) from a string key (portable; 8 hex digits = 32 bits). #}
{% macro uniform_from_key(key_expr) -%}
  ({{ hex_prefix_to_int(sha256_hex(key_expr), 8) }} / 4294967296.0)
{%- endmacro %}

{# q-quantile (0..1) of an expression, as an aggregate. BigQuery's is approximate (1/200 grid). #}
{% macro agg_quantile(expr, q) -%}
  {{ return(adapter.dispatch('agg_quantile', 'openart_signal')(expr, q)) }}
{%- endmacro %}
{% macro default__agg_quantile(expr, q) -%}
  quantile_cont({{ expr }}, {{ q }})
{%- endmacro %}
{% macro bigquery__agg_quantile(expr, q) -%}
  approx_quantiles({{ expr }}, 200)[offset({{ (q * 200) | round | int }})]
{%- endmacro %}

{# Natural logarithm (ln on DuckDB, ln on BigQuery: same name, kept for symmetry). #}
{% macro ln_of(expr) -%}
  ln({{ expr }})
{%- endmacro %}
