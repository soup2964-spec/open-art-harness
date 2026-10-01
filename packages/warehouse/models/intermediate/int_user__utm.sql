-- First-touch UTMs per (user, UTM key, source), with when each became known. Preference
-- (source_priority): the extended /api/user/ad-click-ids record (first-party capture), else
-- Amplitude's initial_utm_*. Both are kept so a consumer can ask "what was known at time t".
with store as (

    {% for key in var('utm_keys') -%}
    select user_id, '{{ key }}' as utm_key, {{ key }} as utm_value, coalesce(context_captured_at, received_at) as captured_at, received_at as known_at
    from {{ ref('stg_app__ad_click_id_posts') }}
    where {{ key }} is not null and user_id is not null
    {% if not loop.last %}union all{% endif %}
    {% endfor %}

),

store_first as (

    select user_id, utm_key, utm_value, captured_at, known_at
    from (
        select *, row_number() over (partition by user_id, utm_key order by captured_at, known_at, utm_value) as value_rank
        from store
    ) as ranked
    where value_rank = 1

),

amplitude as (

    {% for key in var('utm_keys') -%}
    select user_id, '{{ key }}' as utm_key, up_initial_{{ key }} as utm_value, event_time as captured_at, event_uuid
    from {{ ref('stg_amplitude__events') }}
    where user_id is not null
      and up_initial_{{ key }} is not null
      and {{ amplitude_history_filter() }}
    {% if not loop.last %}union all{% endif %}
    {% endfor %}

),

amplitude_first as (

    select user_id, utm_key, utm_value, captured_at, captured_at as known_at
    from (
        select *, row_number() over (partition by user_id, utm_key order by captured_at, event_uuid) as value_rank
        from amplitude
    ) as ranked
    where value_rank = 1

)

select user_id, utm_key, utm_value, captured_at, known_at, 'ad_click_id_store' as utm_source_system, 1 as source_priority
from store_first
union all
select user_id, utm_key, utm_value, captured_at, known_at, 'amplitude_initial_user_property', 2
from amplitude_first
