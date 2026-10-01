-- Every click id OpenArt has seen for a user, one row per (user, key, value, source), with WHEN:
--   click_id_created_at  when the click happened ({v, ts} capture time; Amplitude: first event
--                        carrying it, an upper bound)
--   known_at             when the warehouse could know it (store: the POST's received_at)
-- Sources, in order of preference (source_priority):
--   1. the backend store behind POST /api/user/ad-click-ids (every POST is kept: a user can
--      click again later, and "the click known at time t" must not see the later one)
--   2. Amplitude's attribution plugin (initial_<key> user property, $setOnce first touch)
-- Consumers pick per anchor: the best-priority, most recent click whose time is <= the anchor
-- (fct_conversion_ledger, int_reconciliation__purchase_platform, macros/openart/acquisition.sql).
with store as (

    select
        user_id,
        click_id_key,
        click_id_value,
        min(coalesce(click_id_created_at, received_at)) as click_id_created_at,
        min(received_at) as known_at
    from {{ ref('stg_app__ad_click_ids') }}
    where user_id is not null
    group by user_id, click_id_key, click_id_value

),

amplitude_props as (

    {% for key in var('click_id_keys') -%}
    select user_id, '{{ key }}' as click_id_key, up_initial_{{ key }} as click_id_value, event_time, event_uuid
    from {{ ref('stg_amplitude__events') }}
    where user_id is not null
      and up_initial_{{ key }} is not null
      and {{ amplitude_history_filter() }}
    {% if not loop.last %}union all{% endif %}
    {% endfor %}

),

amplitude_first as (

    select user_id, click_id_key, click_id_value, event_time as click_id_created_at, event_time as known_at
    from (
        select
            *,
            row_number() over (partition by user_id, click_id_key order by event_time, event_uuid) as value_rank
        from amplitude_props
    ) as ranked
    where value_rank = 1

),

merged as (

    select user_id, click_id_key, click_id_value, click_id_created_at, known_at, 'ad_click_id_store' as click_id_source, 1 as source_priority
    from store
    union all
    select user_id, click_id_key, click_id_value, click_id_created_at, known_at, 'amplitude_initial_user_property', 2
    from amplitude_first

)

select
    m.user_id,
    m.click_id_key,
    m.click_id_value,
    m.click_id_created_at,
    m.known_at,
    m.click_id_source,
    m.source_priority,
    p.platform,
    p.acquisition_channel,
    p.precedence
from merged as m
inner join {{ ref('click_id_platforms') }} as p on p.click_id_key = m.click_id_key
