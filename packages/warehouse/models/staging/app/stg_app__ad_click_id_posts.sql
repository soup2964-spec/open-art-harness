-- One row per POST /api/user/ad-click-ids (current or extended body) with the first-touch UTMs
-- the extended record adds (contracts click-id-store-record-extended.schema.json).
-- PII: the raw payload, landing_url and referrer (URLs can carry emails or tokens in query
-- strings) stay in raw; only the UTM values and the capture time are persisted.
-- As-of: POSTs received after the as-of instant are ignored.
select
    user_id,
    received_at,
    {% for key in var('utm_keys') -%}
    {{ json_str('payload', '$.' ~ key) }} as {{ key }},
    {% endfor -%}
    {{ ts_from_unix_millis(json_int('payload', '$.context_captured_at')) }} as context_captured_at
from {{ source('app', 'ad_click_ids') }}
where received_at <= {{ as_of_ts() }}
