-- Point in time (ML review 3): no fact a score was built from may be dated after its anchor.
--   fct_user_features_24h  anchor = signup + 24h (exclusive): every *_at / *_known_at column < anchor
--   int_pvs__features      anchor = the purchase (inclusive): every *_at / *_known_at column <= anchor
-- One row per violation.
{%- set f24_columns = [
    'first_purchase_at', 'checkout_started_at', 'first_generation_at', 'last_generation_at',
    'trial_balance_at', 'arm_create_image_exposed_at', 'arm_create_video_exposed_at',
    'country_known_at', 'device_known_at', 'first_amplitude_event_at',
    'acquisition_click_at', 'acquisition_click_known_at', 'utm_known_at'
] %}
{%- set pvs_columns = [
    'last_generation_before_at', 'arm_create_image_exposed_at', 'arm_create_video_exposed_at',
    'country_known_at', 'acquisition_click_at', 'acquisition_click_known_at', 'utm_known_at',
    'previous_purchase_at', 'signup_at'
] %}
with violations as (

    {% for c in f24_columns -%}
    select 'fct_user_features_24h' as model_name, user_id as row_key, '{{ c }}' as feature, {{ c }} as known_at, feature_window_end as anchor_at
    from {{ ref('fct_user_features_24h') }}
    where {{ c }} >= feature_window_end
    union all
    {% endfor -%}
    {% for c in pvs_columns -%}
    select 'int_pvs__features', event_id, '{{ c }}', {{ c }}, occurred_at
    from {{ ref('int_pvs__features') }}
    where {{ c }} > occurred_at
    {% if not loop.last %}union all{% endif %}
    {% endfor %}

)

select * from violations
