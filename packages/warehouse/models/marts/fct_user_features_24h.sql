-- One row per signed-up user: what was KNOWABLE 24 hours after signup. The inputs of
-- fct_predicted_profit_24h and the training table for a future trained model.
--
-- Point in time (ML review 3): every feature is bounded to facts known strictly before
-- feature_window_end = signup_at + 24h. Generations, trial balance, purchases and checkouts by
-- their own timestamps; experiment arms by first exposure; country, device and "has Amplitude
-- events" by when Amplitude first recorded them; the acquisition channel by when each click id
-- or UTM was stored (macros/openart/acquisition.sql). A generation refunded after the window
-- still counts as a success. The *_at / *_known_at columns carry the timestamp of every fact
-- used, and tests/singular/assert_features_known_before_anchor.sql fails if any is not before
-- the window end.
--
-- Folds: cf_fold (0..pp_crossfit_folds-1, from SHA-256 of the uid, identical on BigQuery and
-- DuckDB) assigns the cross-fitting fold; signup_week feeds the out-of-time backtest.

with users as (

    select
        p.user_id,
        p.signup_at,
        p.is_qa_account,
        {{ ts_add_seconds('p.signup_at', 86400) }} as feature_window_end
    from {{ ref('int_user__profile') }} as p
    where p.signup_at is not null

),

anchors as (

    select user_id as anchor_key, user_id, feature_window_end as anchor_at
    from users

),

{{ acquisition_as_of_ctes('anchors', '<', 'w24') }},

generations as (

    select
        u.user_id,
        g.generation_id,
        g.model_id,
        g.business_type,
        g.media_type,
        g.credits_charged,
        g.cost_usd,
        g.created_at,
        (g.is_failed_generation and g.refunded_at < u.feature_window_end) as is_failed_at_window_end
    from users as u
    inner join {{ ref('fct_generation_cost') }} as g
        on g.user_id = u.user_id
       and g.created_at >= u.signup_at
       and g.created_at < u.feature_window_end

),

generation_stats as (

    select
        user_id,
        sum(case when not is_failed_at_window_end then 1 else 0 end) as generations_24h,
        sum(case when is_failed_at_window_end then 1 else 0 end) as failed_generations_24h,
        sum(case when not is_failed_at_window_end and media_type = 'video' then 1 else 0 end) as video_generations_24h,
        sum(case when not is_failed_at_window_end and media_type = 'image' then 1 else 0 end) as image_generations_24h,
        sum(case when not is_failed_at_window_end then credits_charged else 0 end) as credits_consumed_24h,
        sum(case when not is_failed_at_window_end and media_type = 'video' then credits_charged else 0 end) as video_credits_24h,
        sum(cost_usd) as generation_cost_24h_usd,
        count(distinct case when not is_failed_at_window_end then model_id end) as distinct_models_24h,
        min(created_at) as first_generation_at,
        max(created_at) as last_generation_at
    from generations
    group by user_id

),

model_counts as (

    select user_id, model_id, count(*) as generations
    from generations
    where not is_failed_at_window_end
    group by user_id, model_id

),

model_mix as (

    select
        user_id,
        {{ json_object_agg('model_id', 'generations') }} as model_mix_24h
    from model_counts
    group by user_id

),

top_model as (

    select user_id, model_id as top_model_24h
    from (
        select user_id, model_id, row_number() over (partition by user_id order by generations desc, model_id) as model_rank
        from model_counts
    ) as ranked
    where model_rank = 1

),

exposures_24h as (

    -- first exposures that happened before the window end (no clock-skew allowance here)
    select x.user_id, x.flag_key, x.arm, x.first_exposed_at
    from {{ ref('int_experiment__exposures') }} as x
    inner join users as u
        on u.user_id = x.user_id
       and x.first_exposed_at < u.feature_window_end

),

arms as (

    select
        user_id,
        {% for flag in var('experiment_flags') -%}
        {%- set col = 'arm_' ~ (flag | replace('suite-default-model-', '') | replace('-', '_')) %}
        max(case when flag_key = '{{ flag }}' then arm end) as {{ col }},
        max(case when flag_key = '{{ flag }}' then first_exposed_at end) as {{ col }}_exposed_at{% if not loop.last %},{% endif %}
        {% endfor %}
    from exposures_24h
    group by user_id

),

arm_default_use as (

    -- 24h generations that used the default model of an arm the user had ALREADY been exposed
    -- to (a generation before the exposure cannot have been steered by it)
    select
        g.user_id,
        count(distinct case when dm.business_type is not null then g.generation_id end) as default_model_generations
    from generations as g
    left join exposures_24h as x
        on x.user_id = g.user_id
       and x.first_exposed_at <= g.created_at
    left join {{ ref('default_model_arms') }} as dm
        on dm.flag_key = x.flag_key
       and dm.arm = x.arm
       and dm.business_type = g.business_type
    where not g.is_failed_at_window_end
    group by g.user_id

),

trial_balance as (

    -- Trial credits left at the window end (last trial-bucket ledger row before it).
    select user_id, trial_credits_remaining_24h, trial_balance_at
    from (
        select
            u.user_id,
            l.balance_after as trial_credits_remaining_24h,
            l.created_at as trial_balance_at,
            row_number() over (partition by u.user_id order by l.created_at desc, l.ledger_entry_id desc) as row_rank
        from users as u
        inner join {{ ref('stg_app__credit_ledger') }} as l
            on l.user_id = u.user_id
           and l.credit_field = 'trial_credit_balance'
           and l.created_at < u.feature_window_end
    ) as ranked
    where row_rank = 1

),

first_purchase as (

    select *
    from (
        select
            u.user_id,
            l.event_name as first_purchase_event_name,
            l.occurred_at as first_purchase_at,
            l.plan_tier,
            l.billing_interval,
            -- tax-exclusive, in the reporting currency (USD by default)
            l.revenue_reporting as first_purchase_value_usd,
            row_number() over (partition by u.user_id order by l.occurred_at, l.event_id) as purchase_rank
        from users as u
        inner join {{ ref('fct_conversion_ledger') }} as l
            on l.user_id = u.user_id
           and l.event_name like 'purchase%'
           and l.occurred_at < u.feature_window_end
    ) as ranked
    where purchase_rank = 1

),

checkouts as (

    select u.user_id, min(l.occurred_at) as checkout_started_at
    from users as u
    inner join {{ ref('fct_conversion_ledger') }} as l
        on l.user_id = u.user_id
       and l.event_name = 'checkout_started'
       and l.occurred_at < u.feature_window_end
    group by u.user_id

),

geo_device as (

    -- first country / device Amplitude recorded, only if recorded before the window end
    select
        u.user_id,
        case when fs.first_event_at < u.feature_window_end then fs.first_event_at end as first_amplitude_event_at,
        case when fs.first_country_at < u.feature_window_end then fs.first_country end as country,
        case when fs.first_country_at < u.feature_window_end then fs.first_country_at end as country_known_at,
        case when fs.first_device_class_at < u.feature_window_end then fs.first_device_class end as device_class,
        case when fs.first_device_class_at < u.feature_window_end then fs.first_device_type end as device_type,
        case when fs.first_device_class_at < u.feature_window_end then fs.first_os_name end as os_name,
        case when fs.first_device_class_at < u.feature_window_end then fs.first_device_class_at end as device_known_at
    from users as u
    left join {{ ref('int_amplitude__user_first_seen') }} as fs on fs.user_id = u.user_id

)

select
    u.user_id,
    u.signup_at,
    u.feature_window_end,
    u.feature_window_end <= {{ as_of_ts() }} as is_window_complete,
    mod({{ hex_prefix_to_int(sha256_hex('u.user_id'), 4) }}, {{ var('pp_crossfit_folds') }}) as cf_fold,
    {{ week_start('u.signup_at') }} as signup_week,

    -- plan and interval (only when the user paid inside the window)
    fp.first_purchase_event_name,
    fp.first_purchase_at,
    fp.plan_tier,
    fp.billing_interval,
    fp.first_purchase_value_usd,
    fp.user_id is not null as paid_within_24h,
    c.user_id is not null as checkout_started_24h,
    c.checkout_started_at,

    -- first-24h generation behaviour and model mix
    coalesce(gs.generations_24h, 0) as generations_24h,
    coalesce(gs.failed_generations_24h, 0) as failed_generations_24h,
    coalesce(gs.generations_24h, 0) > 0 as activated_24h,
    gs.first_generation_at,
    gs.last_generation_at,
    coalesce(gs.image_generations_24h, 0) as image_generations_24h,
    coalesce(gs.video_generations_24h, 0) as video_generations_24h,
    {{ safe_divide('gs.video_generations_24h', 'gs.generations_24h') }} as video_share_24h,
    coalesce(gs.credits_consumed_24h, 0) as credits_consumed_24h,
    {{ safe_divide('gs.video_credits_24h', 'gs.credits_consumed_24h') }} as video_credit_share_24h,
    round(coalesce(gs.generation_cost_24h_usd, 0), 6) as generation_cost_24h_usd,
    coalesce(gs.distinct_models_24h, 0) as distinct_models_24h,
    tm.top_model_24h,
    coalesce(mm.model_mix_24h, {{ json_empty_object() }}) as model_mix_24h,
    {{ safe_divide('adu.default_model_generations', 'gs.generations_24h') }} as arm_default_share_24h,
    tb.trial_credits_remaining_24h,
    tb.trial_balance_at,
    coalesce(tb.trial_credits_remaining_24h < {{ var('trial_min_generation_credits') }}, false) as trial_depleted_24h,

    -- experiment arms (first exposure before the window end)
    {% for flag in var('experiment_flags') -%}
    {%- set col = 'arm_' ~ (flag | replace('suite-default-model-', '') | replace('-', '_')) %}
    a.{{ col }},
    a.{{ col }}_exposed_at,
    {% endfor -%}

    -- geography and device, as first recorded before the window end
    gd.country,
    cc.iso2 as country_code,
    cc.is_eea_uk_ch,
    gd.country_known_at,
    gd.device_class,
    gd.device_type,
    gd.os_name,
    gd.device_known_at,
    gd.first_amplitude_event_at,
    gd.first_amplitude_event_at is not null as has_amplitude_events,

    -- acquisition as known before the window end (click ids first, then UTMs)
    acq.acquisition_channel,
    acq.acquisition_platform,
    acq.acquisition_click_id_key,
    acq.acquisition_click_at,
    acq.acquisition_click_known_at,
    acq.utm_source,
    acq.utm_medium,
    acq.utm_campaign,
    acq.utm_known_at,
    {% for key in var('click_id_keys') -%}
    acq.has_{{ key }},
    {% endfor -%}
    u.is_qa_account
from users as u
left join generation_stats as gs on gs.user_id = u.user_id
left join model_mix as mm on mm.user_id = u.user_id
left join top_model as tm on tm.user_id = u.user_id
left join arms as a on a.user_id = u.user_id
left join arm_default_use as adu on adu.user_id = u.user_id
left join trial_balance as tb on tb.user_id = u.user_id
left join first_purchase as fp on fp.user_id = u.user_id
left join checkouts as c on c.user_id = u.user_id
left join geo_device as gd on gd.user_id = u.user_id
left join {{ ref('country_codes') }} as cc on cc.country_name = gd.country
left join w24_acquisition as acq on acq.anchor_key = u.user_id
