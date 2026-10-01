{{
  config(
    partition_by={'field': 'occurred_at', 'data_type': 'timestamp', 'granularity': 'day'} if target.type == 'bigquery' else none,
    cluster_by=['event_name', 'user_id'] if target.type == 'bigquery' else none
  )
}}
-- The canonical conversion ledger: one row per canonical event, conforming to the
-- ConversionLedgerEvent contract (packages/contracts/src/schemas/conversion-ledger-event.schema.json).
-- The first 33 columns are exactly the contract's, in CONVERSION_LEDGER_COLUMNS order; the
-- columns after them are warehouse-only lineage and QA fields (the contract exporter drops them).
--
-- Ids reuse what OpenArt's browser already sends so server events dedupe with the pixels:
--   signup reg_<uid> | purchases purchase_<invoiceId> + order sub_<invoiceId> | refunds
--   refund_<charge>_<cumulative> | chargebacks chargeback_<dispute> (contracts src/event-ids.ts).
-- Attribution fields are what was known at event time (+ attribution_clock_skew_seconds);
-- refunds and chargebacks carry none of their own: attribution lives on the purchase they adjust.

{% set skew = var('attribution_clock_skew_seconds') %}

with events as (

    select * from {{ ref('int_conversion_ledger__events') }}

),

profile as (

    select * from {{ ref('int_user__profile') }}

),

device_at_event as (

    -- oa_device_id (= Amplitude device_id) most recently seen for the user at event time: the
    -- latest device switch at or before it (int_user__device_timeline, one row per switch).
    select event_id, device_id
    from (
        select
            e.event_id,
            t.device_id,
            row_number() over (partition by e.event_id order by t.device_since desc, t.device_id desc) as device_rank
        from events as e
        inner join {{ ref('int_user__device_timeline') }} as t
            on t.user_id = e.user_id
           and t.device_since <= {{ ts_add_seconds('e.occurred_at', skew) }}
    ) as ranked
    where device_rank = 1

),

click_per_key_at_event as (

    -- per click-id key: the most recent click at or before the event (store before Amplitude).
    -- Every stored click is kept upstream, so a re-click AFTER the event cannot hide the one before.
    select event_id, click_id_key, click_id_value, click_id_created_at
    from (
        select
            e.event_id,
            c.click_id_key,
            c.click_id_value,
            c.click_id_created_at,
            row_number() over (
                partition by e.event_id, c.click_id_key
                order by c.source_priority, c.click_id_created_at desc, c.click_id_value
            ) as click_rank
        from events as e
        inner join {{ ref('int_user__click_ids') }} as c
            on c.user_id = e.user_id
           and c.click_id_created_at <= {{ ts_add_seconds('e.occurred_at', skew) }}
        where e.event_name not in ('refund', 'chargeback')
    ) as ranked
    where click_rank = 1

),

click_ids_at_event as (

    select
        event_id,
        {{ json_object_agg(
            'click_id_key',
            "json_object('value', click_id_value, 'created_at', " ~ ts_to_iso_ms('click_id_created_at') ~ ")"
        ) }} as click_ids
    from click_per_key_at_event
    group by event_id

),

utm_per_key_at_event as (

    select event_id, utm_key, utm_value
    from (
        select
            e.event_id,
            u.utm_key,
            u.utm_value,
            row_number() over (partition by e.event_id, u.utm_key order by u.source_priority, u.captured_at) as utm_rank
        from events as e
        inner join {{ ref('int_user__utm') }} as u
            on u.user_id = e.user_id
           and u.captured_at <= {{ ts_add_seconds('e.occurred_at', skew) }}
        where e.event_name not in ('refund', 'chargeback')
    ) as ranked
    where utm_rank = 1

),

utm_at_event as (

    select
        event_id,
        {{ json_object_agg('utm_key', 'utm_value') }} as utm
    from utm_per_key_at_event
    group by event_id

),

arms_at_event as (

    select
        e.event_id,
        {{ json_object_agg('x.flag_key', 'x.arm') }} as experiment_arms
    from events as e
    inner join {{ ref('int_experiment__exposures') }} as x
        on x.user_id = e.user_id
       and x.first_exposed_at <= {{ ts_add_seconds('e.occurred_at', skew) }}
    group by e.event_id

),

web_fix as (

    -- Platforms whose browser twin must be patched (packages/web-fixes) before this event is
    -- sent server-side, or the two copies cannot dedupe (contracts platform_event_mapping.csv).
    select
        canonical_event,
        {{ dbt.listagg('platform', "','", 'order by platform') }} as web_fix_platforms
    from {{ ref('platform_event_mapping') }}
    where send and requires_web_fix
    group by canonical_event

),

ledger as (

select
    1 as schema_version,
    e.event_id,
    e.event_name,
    e.occurred_at,
    e.source_system,
    e.source_event_id,
    e.user_id,
    coalesce(d.device_id, p.first_device_id) as device_id,
    e.order_id,
    e.adjusts_event_id,
    e.adjusts_order_id,
    e.cash_value_minor,
    e.currency,
    e.invoice_id,
    e.subscription_id,
    e.checkout_session_id,
    e.charge_id,
    e.plan_tier,
    e.plan_tier_code,
    e.billing_interval,
    e.previous_plan_tier,
    e.credit_pack_quantity,
    e.is_first_purchase,
    e.is_business,
    e.generation,
    e.lead,
    coalesce(e.lead_click_ids, c.click_ids, {{ json_empty_object() }}) as click_ids,
    coalesce(u.utm, {{ json_empty_object() }}) as utm,
    e.ga_client_id,
    e.ga_session_id,
    e.tolt_referral,
    -- No CMP today: every signal is 'unknown', source 'none' (research/11 §3.3, gcd=13l3l3l3l1l1).
    json_object(
        'ad_storage', 'unknown',
        'ad_user_data', 'unknown',
        'ad_personalization', 'unknown',
        'analytics_storage', 'unknown',
        'region', p.country_code,
        'source', 'none'
    ) as consent,
    coalesce(x.experiment_arms, {{ json_empty_object() }}) as experiment_arms,

    -- ---------------------------------------------------- warehouse-only columns
    w.web_fix_platforms is not null as requires_web_fix,
    w.web_fix_platforms,
    -- What the Reddit pixel sends as m.conversionId: SHA-256 of the order id (research/11 S3).
    case when e.order_id is not null then {{ sha256_hex('e.order_id') }} end as reddit_pixel_conversion_id,
    e.restated_order_value_minor,
    e.classification_rule,
    -- money in the reporting currency (FX at the event date; tax-exclusive revenue for profit)
    '{{ var("reporting_currency") }}' as reporting_currency,
    e.cash_value_reporting,
    e.revenue_reporting,
    p.country_code,
    coalesce(p.is_qa_account, {{ qa_account_flag('e.user_id') }}) as is_qa_account
from events as e
left join profile as p on p.user_id = e.user_id
left join device_at_event as d on d.event_id = e.event_id
left join click_ids_at_event as c on c.event_id = e.event_id
left join utm_at_event as u on u.event_id = e.event_id
left join arms_at_event as x on x.event_id = e.event_id
left join web_fix as w on w.canonical_event = e.event_name

)

select
    ledger.*,
    -- signal-coverage flags (portable columns for Metabase; see docs/metabase/03_signal_coverage.sql)
    {% for key in var('click_id_keys') -%}
    {{ json_str('click_ids', '$.' ~ key ~ '.value') }} is not null{% if not loop.last %} or {% endif %}
    {%- endfor %} as has_any_click_id,
    ({{ json_str('click_ids', '$.gclid.value') }} is not null
        or {{ json_str('click_ids', '$.gbraid.value') }} is not null
        or {{ json_str('click_ids', '$.wbraid.value') }} is not null) as has_google_click_id,
    {{ json_str('click_ids', '$.fbclid.value') }} is not null as has_meta_fbclid,
    -- Meta server-side fbc = fb.1.<first-seen ms>.<fbclid>: needs the first-seen time too (research/12 C6)
    ({{ json_str('click_ids', '$.fbclid.value') }} is not null
        and {{ json_str('click_ids', '$.fbclid.created_at') }} is not null) as meta_fbc_buildable,
    {{ json_str('click_ids', '$.ttclid.value') }} is not null as has_tiktok_ttclid,
    {{ json_str('utm', '$.utm_source') }} is not null as has_utm_source,
    {% for flag in var('experiment_flags') -%}
    {{ json_str('experiment_arms', '$."' ~ flag ~ '"') }} is not null{% if not loop.last %} or {% endif %}
    {%- endfor %} as has_experiment_arm,
    {{ json_str('consent', '$.region') }} is not null as consent_region_known
from ledger
