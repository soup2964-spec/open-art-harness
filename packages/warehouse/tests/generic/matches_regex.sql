{#- Fails on every non-NULL value that does not match the anchored pattern. -#}
{% test matches_regex(model, column_name, pattern) %}
select {{ column_name }}
from {{ model }}
where {{ column_name }} is not null
  and not {{ regexp_like(column_name, pattern) }}
{% endtest %}
