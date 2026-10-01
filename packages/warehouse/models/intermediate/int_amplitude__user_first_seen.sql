-- One row per Amplitude user: what the export knew about them FIRST, and when. Every "first"
-- value comes with the time it became known, so point-in-time features can bound it:
-- a value first seen after an anchor was not knowable at that anchor.
--   first_country / first_device_*   first non-NULL value (int_user__profile, features)
--   segment_*                        the bandit-allocator's segment from the user's EARLIEST row
--                                    (bandit cohort-inputs.ts segmentsFromAmplitude), known at
--                                    first_event_at
-- One grouped scan plus one ranked scan of stg_amplitude__events (BigQuery cost review).
with events as (

    select *
    from {{ ref('stg_amplitude__events') }}
    where user_id is not null
      and {{ amplitude_history_filter() }}

),

firsts as (

    select
        user_id,
        count(*) as amplitude_events,
        min(event_time) as first_event_at,
        {{ first_by('country', 'event_time, event_uuid') }} as first_country,
        {{ first_by('event_time', 'event_time, event_uuid', where='country is not null') }} as first_country_at,
        {{ first_by('ep_device', 'event_time, event_uuid') }} as first_device_class,
        {{ first_by('event_time', 'event_time, event_uuid', where='ep_device is not null') }} as first_device_class_at,
        {{ first_by('device_type', 'event_time, event_uuid', where='ep_device is not null') }} as first_device_type,
        {{ first_by('os_name', 'event_time, event_uuid', where='ep_device is not null') }} as first_os_name,
        {{ first_by('platform', 'event_time, event_uuid', where='ep_device is not null') }} as first_platform
    from events
    group by user_id

),

earliest as (

    select *
    from (
        select
            e.*,
            row_number() over (partition by e.user_id order by e.event_time, e.event_uuid) as event_rank
        from events as e
    ) as ranked
    where event_rank = 1

)

select
    f.user_id,
    f.amplitude_events,
    f.first_event_at,
    e.event_uuid as first_event_uuid,
    e.device_id as first_device_id,
    f.first_country,
    f.first_country_at,
    f.first_device_class,
    f.first_device_class_at,
    f.first_device_type,
    f.first_os_name,
    f.first_platform,
    -- bandit segment (known at first_event_at)
    {{ segment_country_bucket('e.country', 'cb.country_bucket') }} as segment_country_bucket,
    {{ segment_device('e.platform', 'e.os_name', 'e.device_type') }} as segment_device,
    {{ segment_channel('e.up_') }} as segment_acquisition_channel
from firsts as f
inner join earliest as e on e.user_id = f.user_id
left join {{ ref('segment_country_buckets') }} as cb on cb.country_key = {{ segment_country_key('e.country') }}
