{{
  config(
    partition_by={'field': 'occurred_at', 'data_type': 'timestamp', 'granularity': 'day'} if target.type == 'bigquery' else none,
    cluster_by=['user_id'] if target.type == 'bigquery' else none
  )
}}
-- ESTIMAND: E[gross_profit_90d | purchase] = the expected gross profit of the purchase's user over
-- the 90 days from the purchase (this purchase included), GIVEN the purchase and only what was
-- known at it. One row per purchase event. This is the value for ad platforms (ML review 1);
-- fct_predicted_profit_24h is not (it is unconditional and scored at signup + 24h).
-- Conforms to the PurchaseValueScore contract (packages/contracts/src/schemas/purchase-value-score.schema.json):
-- the first 20 columns are the contract's, in order; the rest are warehouse-only.
--   model       int_pvs__scores (structural, EB-shrunk, cross-fitted: purchases of fold-k users are
--               scored with parameters fit on the other folds)
--   features    int_pvs__features, all bounded by occurred_at (features_snapshot.as_of = occurred_at)
--   interval    10th-90th percentile of the model's own outcome distribution (renewals x burn)
--   fitted_params_ref  the exact parameter set (dim_model_parameters, append-only)
--   platform_value     max(predicted_profit_90d, 0): what may be sent (platforms reject negatives)
-- Purchases whose currency has no FX rate cannot be valued and are left out (listed in
-- fct_data_quality_quarantine). Every run's first score of each purchase is also appended to
-- fct_purchase_value_score_log, the record of what was served.
with scores as (

    select * from {{ ref('int_pvs__scores') }} where purpose = 'serve'

),

params as (

    select max(fitted_params_ref) as fitted_params_ref from {{ ref('int_model_parameters__current') }}

)

select
    s.event_id,
    s.invoice_id,
    s.user_id,
    s.occurred_at,
    {{ as_of_ts() }} as scored_at,
    'E[gross_profit_90d | purchase]' as estimand,
    {{ var('pp_horizon_days') }} as horizon_days,
    s.predicted_revenue_90d,
    s.predicted_generation_cost_90d,
    s.predicted_fees_90d,
    s.predicted_refund_risk,
    s.predicted_profit_90d,
    s.interval_low,
    s.interval_high,
    round(s.cash_value_reporting, 6) as cash_value,
    s.reporting_currency as currency,
    '{{ var("pvs_model_version") }}@' || cast(cast({{ as_of_ts() }} as date) as {{ dbt.type_string() }}) as model_version,
    '{{ invocation_id }}' as run_id,
    p.fitted_params_ref,
    json_object(
        'as_of', {{ ts_to_iso_ms('s.occurred_at') }},
        'purchase_kind', s.purchase_kind,
        'event_name', s.event_name,
        'plan_tier', s.plan_tier,
        'billing_interval', s.billing_interval,
        'revenue_usd', s.revenue_reporting,
        'acquisition_channel', s.acquisition_channel,
        'is_affiliate', s.is_affiliate,
        'country_bucket', s.country_bucket,
        'arm_create_image', s.arm_create_image,
        'arm_create_video', s.arm_create_video,
        'credits_before', s.credits_before,
        'video_credit_share_before', s.video_credit_share_before,
        'generation_cost_before_usd', s.generation_cost_before_usd,
        'cost_per_credit_before_usd', s.cost_per_credit_before_usd,
        'paid_months_before', s.paid_months_before,
        'previous_purchases', s.previous_purchases,
        'days_since_signup', round(s.days_since_signup, 4),
        'renewal_prob', s.renewal_prob,
        'expected_renewals', s.expected_renewals,
        'expected_credits_90d', s.expected_credits_90d,
        'cost_per_credit_usd', s.cost_per_credit_usd,
        'fit_id', s.fit_id
    ) as features_snapshot,

    -- ------------------------------------------------ warehouse-only columns
    {{ greatest_of('s.predicted_profit_90d', 0) }} as platform_value,
    s.event_name,
    s.purchase_kind,
    s.plan_tier,
    s.billing_interval,
    s.acquisition_channel,
    s.country_bucket,
    s.arm_create_image,
    s.arm_create_video,
    s.renewal_prob,
    s.expected_renewals,
    s.expected_credits_90d,
    s.cost_per_credit_usd,
    s.revenue_reporting as revenue_value,
    s.cash_value_minor,
    s.currency as charge_currency,
    s.cf_fold,
    s.fit_id,
    s.is_qa_account
from scores as s
cross join params as p
where s.predicted_profit_90d is not null
