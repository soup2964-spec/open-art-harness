{#- Fails on every row where `expression` is not TRUE (NULL counts as a failure). -#}
{% test expression_is_true(model, expression, where_clause=none) %}
select *
from {{ model }}
where not coalesce(({{ expression }}), false)
{% if where_clause %}  and ({{ where_clause }}){% endif %}
{% endtest %}
