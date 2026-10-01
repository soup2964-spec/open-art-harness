-- First exposure per (user, flag): the first $exposure event, or else the first row whose
-- user properties carry ab_<flag> (the Suite identifies ab_* props and fires
-- experiment_flags_ready; integration-map §2.11). A $exposure row always wins over a user
-- property row, even a later one (source_priority).
-- n_distinct_arms > 1 marks users who saw more than one arm. They are NOT dropped anywhere:
-- readouts keep them in their first-exposed arm (intention to treat) and count them.
with candidates as (

    {% for flag in var('experiment_flags') -%}
    select
        user_id,
        '{{ flag }}' as flag_key,
        ep_variant as arm,
        event_time,
        event_uuid,
        device_id,
        'amplitude_exposure_event' as source,
        1 as source_priority
    from {{ ref('stg_amplitude__events') }}
    where event_type = '$exposure'
      and ep_flag_key = '{{ flag }}'
      and user_id is not null
      and ep_variant is not null
      and {{ amplitude_history_filter() }}

    union all

    select
        user_id,
        '{{ flag }}' as flag_key,
        up_ab_{{ flag | replace('-', '_') }} as arm,
        event_time,
        event_uuid,
        device_id,
        'amplitude_user_property' as source,
        2 as source_priority
    from {{ ref('stg_amplitude__events') }}
    where user_id is not null
      and up_ab_{{ flag | replace('-', '_') }} is not null
      and {{ amplitude_history_filter() }}
    {% if not loop.last %}union all{% endif %}
    {% endfor %}

),

arm_counts as (

    select user_id, flag_key, count(distinct arm) as n_distinct_arms
    from candidates
    group by user_id, flag_key

),

ranked as (

    select
        *,
        row_number() over (
            partition by user_id, flag_key
            order by source_priority, event_time, event_uuid
        ) as exposure_rank
    from candidates

)

select
    r.user_id,
    r.flag_key,
    r.arm,
    r.event_time as first_exposed_at,
    r.source,
    r.device_id,
    c.n_distinct_arms
from ranked as r
inner join arm_counts as c on c.user_id = r.user_id and c.flag_key = r.flag_key
where r.exposure_rank = 1
