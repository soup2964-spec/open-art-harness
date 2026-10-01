-- One row per purchase event (fct_conversion_ledger purchase_*): what was knowable AT the
-- purchase (ML review 1 and 3). Anchor = occurred_at, inclusive; every fact is bounded by it:
--   plan, interval, purchase type, this charge (tax-exclusive, reporting currency)
--   acquisition channel from click ids / UTMs stored at or before the purchase
--   country (first recorded by Amplitude at or before it) and its bandit bucket
--   default-model arms first exposed at or before it
--   pre-purchase usage: generations, credits, video share, serving cost, $/credit, paid credits
--   and paid months before this purchase (renewals: how the subscriber actually burns credits)
-- The *_at / *_known_at columns carry each fact's time; assert_features_known_before_anchor
-- fails if any is after the purchase.
with purchases as (

    select
        l.event_id,
        l.event_name,
        l.occurred_at,
        l.user_id,
        l.invoice_id,
        l.order_id,
        l.subscription_id,
        l.plan_tier,
        l.billing_interval,
        l.credit_pack_quantity,
        l.is_first_purchase,
        l.currency,
        l.cash_value_minor,
        l.cash_value_reporting,
        l.revenue_reporting,
        l.reporting_currency,
        l.is_qa_account
    from {{ ref('fct_conversion_ledger') }} as l
    where l.event_name like 'purchase%'

),

anchors as (

    select event_id as anchor_key, user_id, occurred_at as anchor_at
    from purchases

),

{{ acquisition_as_of_ctes('anchors', '<=', 'atp') }},

usage_before as (

    select
        p.event_id,
        count(*) as generations_before,
        sum(g.credits_costed) as credits_before,
        sum(case when g.media_type = 'video' then g.credits_costed else 0 end) as video_credits_before,
        sum(g.cost_usd) as generation_cost_before_usd,
        sum(case when g.credit_field <> 'trial_credit_balance' then g.credits_costed else 0 end) as paid_credits_before,
        max(g.created_at) as last_generation_before_at
    from purchases as p
    inner join {{ ref('fct_generation_cost') }} as g
        on g.user_id = p.user_id
       and g.created_at < p.occurred_at
       -- a generation refunded after the purchase still looked successful at the purchase
       and not (g.is_failed_generation and g.refunded_at <= p.occurred_at)
    group by p.event_id

),

purchases_before as (

    select
        p.event_id,
        count(*) as previous_purchases,
        sum(case when b.event_name in ('purchase_first', 'purchase_renewal') and b.billing_interval = 'month' then 1 else 0 end) as paid_months_before,
        max(b.occurred_at) as previous_purchase_at
    from purchases as p
    inner join purchases as b
        on b.user_id = p.user_id
       and (b.occurred_at < p.occurred_at or (b.occurred_at = p.occurred_at and b.event_id < p.event_id))
    group by p.event_id

),

arms_at_purchase as (

    select
        p.event_id,
        max(case when x.flag_key = 'suite-default-model-create-image' then x.arm end) as arm_create_image,
        max(case when x.flag_key = 'suite-default-model-create-image' then x.first_exposed_at end) as arm_create_image_exposed_at,
        max(case when x.flag_key = 'suite-default-model-create-video' then x.arm end) as arm_create_video,
        max(case when x.flag_key = 'suite-default-model-create-video' then x.first_exposed_at end) as arm_create_video_exposed_at
    from purchases as p
    inner join {{ ref('int_experiment__exposures') }} as x
        on x.user_id = p.user_id
       and x.first_exposed_at <= p.occurred_at
    group by p.event_id

),

catalog_price as (

    select plan_tier, billing_interval, max(unit_amount_minor) / 100.0 as list_price_usd, max(monthly_credits) as monthly_credits
    from {{ ref('plan_catalog') }}
    where item_type = 'plan'
    group by plan_tier, billing_interval

),

pack as (

    select max(credits_per_unit) as pack_credits
    from {{ ref('plan_catalog') }}
    where item_type = 'one_time_pack'

)

select
    p.event_id,
    p.event_name,
    p.occurred_at,
    p.user_id,
    p.invoice_id,
    p.order_id,
    p.subscription_id,
    p.plan_tier,
    p.billing_interval,
    case
        when p.event_name = 'purchase_one_time_pack' or p.billing_interval is null then 'pack'
        when p.billing_interval = 'year' then 'annual'
        else 'monthly'
    end as purchase_kind,
    p.credit_pack_quantity,
    p.is_first_purchase,
    p.currency,
    p.cash_value_minor,
    p.cash_value_reporting,
    p.revenue_reporting,
    p.reporting_currency,
    cp.list_price_usd,
    cp.monthly_credits as plan_monthly_credits,
    pk.pack_credits,
    -- the cross-fitting fold from the uid itself (same hash as fct_user_features_24h), so every
    -- purchase has one even when its user has no signup record
    mod({{ hex_prefix_to_int(sha256_hex('p.user_id'), 4) }}, {{ var('pp_crossfit_folds') }}) as cf_fold,
    f.signup_week,
    f.signup_at,
    {{ ts_diff_seconds('p.occurred_at', 'f.signup_at') }} / 86400.0 as days_since_signup,
    -- acquisition as known at the purchase
    acq.acquisition_channel,
    acq.acquisition_channel = 'affiliate' as is_affiliate,
    acq.acquisition_click_at,
    acq.acquisition_click_known_at,
    acq.utm_known_at,
    -- country as first recorded at or before the purchase
    case when fs.first_country_at <= p.occurred_at then fs.first_country end as country,
    case when fs.first_country_at <= p.occurred_at then fs.first_country_at end as country_known_at,
    {{ segment_country_bucket('case when fs.first_country_at <= p.occurred_at then fs.first_country end', 'cb.country_bucket') }} as country_bucket,
    -- arms exposed at or before the purchase
    a.arm_create_image,
    a.arm_create_image_exposed_at,
    a.arm_create_video,
    a.arm_create_video_exposed_at,
    -- pre-purchase usage mix and cost
    coalesce(u.generations_before, 0) as generations_before,
    coalesce(u.credits_before, 0) as credits_before,
    {{ safe_divide('u.video_credits_before', 'u.credits_before') }} as video_credit_share_before,
    round(coalesce(u.generation_cost_before_usd, 0), 6) as generation_cost_before_usd,
    {{ safe_divide('u.generation_cost_before_usd', 'u.credits_before') }} as cost_per_credit_before_usd,
    coalesce(u.paid_credits_before, 0) as paid_credits_before,
    u.last_generation_before_at,
    coalesce(pb.previous_purchases, 0) as previous_purchases,
    coalesce(pb.paid_months_before, 0) as paid_months_before,
    pb.previous_purchase_at,
    p.is_qa_account
from purchases as p
left join {{ ref('fct_user_features_24h') }} as f on f.user_id = p.user_id
left join atp_acquisition as acq on acq.anchor_key = p.event_id
left join {{ ref('int_amplitude__user_first_seen') }} as fs on fs.user_id = p.user_id
left join {{ ref('segment_country_buckets') }} as cb
    on cb.country_key = {{ segment_country_key('case when fs.first_country_at <= p.occurred_at then fs.first_country end') }}
left join arms_at_purchase as a on a.event_id = p.event_id
left join usage_before as u on u.event_id = p.event_id
left join purchases_before as pb on pb.event_id = p.event_id
left join catalog_price as cp on cp.plan_tier = p.plan_tier and cp.billing_interval = p.billing_interval
cross join pack as pk
