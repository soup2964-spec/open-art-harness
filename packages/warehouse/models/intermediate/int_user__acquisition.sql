-- Acquisition channel per user as known at the as-of instant: the latest click id, else
-- first-touch UTMs, else organic (macros/openart/acquisition.sql). Point-in-time features use
-- the same macro with their own anchor (fct_user_features_24h: signup + 24h; purchase value
-- score: the purchase), so a later click can never change the channel a score was built on.
-- Channel names follow the cohort's (google_cpc, meta_paid_social, tiktok_paid_social,
-- affiliate, organic, ...).
with anchors as (

    select user_id as anchor_key, user_id, {{ as_of_ts() }} as anchor_at
    from {{ ref('int_user__profile') }}

),

{{ acquisition_as_of_ctes('anchors', '<=', 'cur') }}

select
    anchor_key as user_id,
    acquisition_channel,
    acquisition_platform,
    acquisition_click_id_key,
    acquisition_click_at,
    acquisition_click_known_at,
    utm_source,
    utm_medium,
    utm_campaign,
    utm_known_at,
    {% for key in var('click_id_keys') -%}
    has_{{ key }}{% if not loop.last %},{% endif %}
    {% endfor %}
from cur_acquisition
