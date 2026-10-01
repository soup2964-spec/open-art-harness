-- Long format: one row per (POST, click-id key present). created_at is the {v, ts} capture time
-- in ms, i.e. when OpenArt first saw the click: exactly what Meta's server-side fbc needs.
-- received_at is when the backend stored it (the earliest the warehouse can know it).
-- As-of: POSTs received after the as-of instant are ignored.
{% for key in var('click_id_keys') -%}
select
    user_id,
    received_at,
    '{{ key }}' as click_id_key,
    {{ json_str('payload', '$.' ~ key) }} as click_id_value,
    {{ ts_from_unix_millis(json_int('payload', '$.' ~ key ~ '_created_at')) }} as click_id_created_at
from {{ source('app', 'ad_click_ids') }}
where {{ json_str('payload', '$.' ~ key) }} is not null
  and received_at <= {{ as_of_ts() }}
{% if not loop.last %}union all{% endif %}
{% endfor %}
