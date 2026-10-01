{#- Fails on every negative value. Used on every column that feeds a value sent to an ad
    platform: platforms reject negative conversion values (research/04 §5.7). -#}
{% test not_negative(model, column_name) %}
select {{ column_name }}
from {{ model }}
where {{ column_name }} < 0
{% endtest %}
