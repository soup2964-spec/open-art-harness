-- One row per device SWITCH of a user in the Amplitude export: the device (oa_device_id) and
-- the time from which it was the user's current device. "The device most recently seen at time
-- t" is the latest row with device_since <= t, exactly: every event before t belongs to the run
-- that started at or before it. Far smaller than joining every ledger event to every earlier
-- Amplitude event (fct_conversion_ledger device_at_event; BigQuery cost review).
with ordered as (

    select
        user_id,
        device_id,
        event_time,
        event_uuid,
        lag(device_id) over (partition by user_id order by event_time, event_uuid) as previous_device_id
    from {{ ref('stg_amplitude__events') }}
    where user_id is not null
      and {{ amplitude_history_filter() }}

)

select
    user_id,
    device_id,
    event_time as device_since,
    event_uuid as device_since_event_uuid
from ordered
where previous_device_id is null
   or previous_device_id <> device_id
