{{
  config(
    materialized=('incremental' if target.type == 'bigquery' else 'table'),
    incremental_strategy=('insert_overwrite' if target.type == 'bigquery' else none),
    partition_by=({'field': 'event_time', 'data_type': 'timestamp', 'granularity': 'day'} if target.type == 'bigquery' else none),
    cluster_by=(['user_id', 'event_type'] if target.type == 'bigquery' else none),
    require_partition_filter=(target.type == 'bigquery'),
    on_schema_change='append_new_columns'
  )
}}
-- Amplitude export rows, deduplicated on uuid (the export can repeat rows; research/08 §6.2),
-- reduced to the typed properties the warehouse reads.
--
-- PII: the raw event_properties / user_properties JSON (page URLs, referrers, free-text
-- properties) is NOT persisted; only the extracts below are.
-- Cost (BigQuery): incremental insert_overwrite on event_time day, clustered by (user_id,
-- event_type), require_partition_filter. Each run rebuilds, in full, every event day that
-- received rows in the last var amplitude_lookback_days of server_upload_time (late rows
-- included); rows arriving more than var amplitude_max_late_days after their event_time are
-- not picked up by incremental runs (a --full-refresh does). DuckDB builds a table.
-- As-of: rows uploaded after the as-of instant are ignored.
{%- set late_s = 86400 * var('amplitude_max_late_days') %}
{%- set lookback_s = 86400 * var('amplitude_lookback_days') %}

with source_rows as (

    select
        uuid,
        event_type,
        event_time,
        client_event_time,
        server_upload_time,
        user_id,
        device_id,
        session_id,
        platform,
        os_name,
        device_type,
        country,
        library,
        event_properties,
        user_properties
    from {{ source('amplitude', 'events') }}
    where server_upload_time <= {{ as_of_ts() }}
    {% if openart_is_incremental() %}
      and event_time >= {{ ts_add_seconds(as_of_ts(), -late_s) }}
      and cast(event_time as date) in (
          select distinct cast(event_time as date)
          from {{ source('amplitude', 'events') }}
          where server_upload_time >= {{ ts_add_seconds(as_of_ts(), -lookback_s) }}
            and server_upload_time <= {{ as_of_ts() }}
            and event_time >= {{ ts_add_seconds(as_of_ts(), -late_s) }}
      )
    {% endif %}

),

ranked as (

    select
        *,
        row_number() over (partition by uuid order by server_upload_time, event_time) as copy_number
    from source_rows

)

select
    uuid as event_uuid,
    event_type,
    event_time,
    client_event_time,
    server_upload_time,
    user_id,
    device_id,
    session_id,
    platform,
    os_name,
    device_type,
    country,
    library,

    -- asset_created (research/02 §3.6; model + credits_num per generation)
    {{ json_str('event_properties', '$.model') }} as ep_model,
    {{ json_str('event_properties', '$.creation_mode') }} as ep_creation_mode,
    {{ json_int('event_properties', '$.credits_num') }} as ep_credits_num,
    {{ json_int('event_properties', '$.asset_num') }} as ep_asset_num,
    {{ json_str('event_properties', '$.feature_name') }} as ep_feature_name,
    -- viewport-based 'pc' | 'mobile': the only device signal on standard events (research/01 T9)
    {{ json_str('event_properties', '$.device') }} as ep_device,

    -- $exposure
    {{ json_str('event_properties', '$.flag_key') }} as ep_flag_key,
    {{ json_str('event_properties', '$.variant') }} as ep_variant,

    -- subscription_started (checkout intent)
    {{ json_str('event_properties', '$.subscription_tier') }} as ep_subscription_tier,
    {{ json_str('event_properties', '$.subscription_interval') }} as ep_subscription_interval,
    {{ json_str('event_properties', '$.click_source') }} as ep_click_source,

    -- conversion_reported (client-side per-channel send telemetry)
    {{ json_str('event_properties', '$.channel') }} as ep_channel,
    {{ json_str('event_properties', '$.conversion_type') }} as ep_conversion_type,
    {{ json_bool('event_properties', '$.fired') }} as ep_fired,
    {{ json_str('event_properties', '$.outcome') }} as ep_outcome,

    -- experiment arms as user properties (ab_<flag>, logged by the Suite)
    {% for flag in var('experiment_flags') -%}
    {{ json_str('user_properties', '$."ab_' ~ flag ~ '"') }} as up_ab_{{ flag | replace('-', '_') }},
    {% endfor -%}

    -- attribution plugin: $setOnce first-touch click ids and UTMs (research/01 §2 "initial_*")
    {% for key in var('click_id_keys') -%}
    {{ json_str('user_properties', '$.initial_' ~ key) }} as up_initial_{{ key }},
    {% endfor -%}
    {% for key in var('utm_keys') -%}
    {{ json_str('user_properties', '$.initial_' ~ key) }} as up_initial_{{ key }},
    {% endfor -%}
    {{ json_str('user_properties', '$.initial_referring_domain') }} as up_initial_referring_domain,
    {{ json_str('user_properties', '$.initial_ref') }} as up_initial_ref,
    {{ json_str('user_properties', '$.tolt_referral') }} as up_tolt_referral,
    {{ json_bool('user_properties', '$.subscription_active') }} as up_subscription_active
from ranked
where copy_number = 1
