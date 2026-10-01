{#- Fails when the model and compare_model (optionally filtered) have different row counts. -#}
{% test equal_row_count(model, compare_model, where_clause=none, compare_where_clause=none) %}
with a as (
    select count(*) as n from {{ model }} {% if where_clause %}where {{ where_clause }}{% endif %}
),
b as (
    select count(*) as n from {{ compare_model }} {% if compare_where_clause %}where {{ compare_where_clause }}{% endif %}
)
select a.n as model_rows, b.n as compare_rows
from a cross join b
where a.n != b.n
{% endtest %}
