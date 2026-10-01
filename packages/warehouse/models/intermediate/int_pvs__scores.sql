-- E[gross profit over the 90 days from the purchase | the purchase], scored AT the purchase from
-- facts known then (int_pvs__features), one row per (purpose, fit_id, event_id):
--   serve      every purchase, fit xf<cf_fold> (cross-fitted: the user's own outcomes never fit it)
--   oot_test   purchases with complete 90 days by users of each backtest week, fit oot_<week>
-- A transparent structural model, every input fitted per fit_id and shrunk to ILLUSTRATIVE priors:
--   monthly   s = P(renew within 45 days | tier, country bucket) (int_pvs__renewal_rates)
--             revenue = this charge + next-period price x (s + s^2) + add-on/upgrade revenue per
--             month x (1 + s + s^2) expected paid months
--   annual    revenue = this charge + add-ons x 2.96 months (no renewal inside 90 days)
--   pack      revenue = this charge + mean revenue that followed a pack (int_pvs__params)
--   cost      expected credits x $/credit. Credits: the subscriber's own paid monthly burn before
--             this purchase (renewals) blended with plan utilization x plan credits; packs: pack
--             credits x pack utilization. $/credit: the user's own pre-purchase $/credit blended
--             with the MEASURED $/credit of their default-model arms (int_pp__cost_per_credit).
--   fees      payment % + fixed per expected charge + affiliate commission (channel known at the
--             purchase) + dispute fee x chargeback rate; refund risk = (refund + chargeback rate) x revenue
-- Interval: the 10th-90th percentile (var pvs_interval_coverage) of the structural outcome
-- distribution: 0, 1 or 2 renewals with probabilities (1-s), s(1-s), s^2, and monthly burn
-- +/- z x burn_cv. Its realised coverage is measured out of time (python_tests/oot_eval.py).
{%- set coverage = var('pvs_interval_coverage') | float %}
{%- set z_table = {0.5: 0.6745, 0.6: 0.8416, 0.7: 1.0364, 0.8: 1.2816, 0.9: 1.6449, 0.95: 1.96} %}
{%- set z = z_table.get(coverage, 1.2816) %}
{%- set alpha = (1 - coverage) / 2 %}
{%- set fee = var('payment_fee_pct') %}
{%- set fixed = var('payment_fee_fixed_usd') %}
{%- set aff = var('affiliate_commission_pct') %}
{%- set dispute_fee = var('dispute_fee_usd') %}
{%- set window_months = var('pp_horizon_days') / 30.4375 %}

with features as (

    select f.*, o.is_horizon_complete
    from {{ ref('int_pvs__features') }} as f
    inner join {{ ref('int_pvs__outcomes') }} as o on o.event_id = f.event_id

),

oot as (

    select fit_id, test_week_start from {{ ref('int_pp__oot_weeks') }}

),

scoring_rows as (

    select 'serve' as purpose, 'xf' || cast(f.cf_fold as {{ dbt.type_string() }}) as fit_id, f.*
    from features as f

    union all

    select 'oot_test' as purpose, o.fit_id, f.*
    from features as f
    inner join oot as o on f.signup_week = o.test_week_start
    where not f.is_qa_account
      and f.is_horizon_complete

),

cpc_pooled as (

    select fit_id, media_type, max(pooled_cost_per_credit_usd) as pooled_cost_per_credit_usd
    from {{ ref('int_pp__cost_per_credit') }}
    group by fit_id, media_type

),

inputs as (

    select
        r.*,
        coalesce(rr.renewal_prob, {{ var('pp_monthly_retention') }}) as renewal_prob,
        pp.addon_revenue_per_month_usd,
        pp.plan_utilization,
        pp.burn_cv,
        pp.pack_utilization,
        pp.pack_future_revenue_usd,
        pp.pack_future_revenue_q90_usd,
        pp.refund_rate_per_charge,
        pp.chargeback_rate_per_charge,
        cv.paid_video_credit_share,
        cv.paid_video_credit_share * coalesce(cpv.cost_per_credit_usd, ppv.pooled_cost_per_credit_usd, {{ var('default_cost_per_credit_usd') }})
            + (1 - cv.paid_video_credit_share) * coalesce(cpi.cost_per_credit_usd, ppi.pooled_cost_per_credit_usd, {{ var('default_cost_per_credit_usd') }})
            as arm_cost_per_credit_usd
    from scoring_rows as r
    left join {{ ref('int_pvs__renewal_rates') }} as rr
        on rr.fit_id = r.fit_id and rr.plan_tier = r.plan_tier and rr.country_bucket = r.country_bucket
    left join {{ ref('int_pvs__params') }} as pp on pp.fit_id = r.fit_id
    left join {{ ref('int_pp__converter_value') }} as cv on cv.fit_id = r.fit_id
    left join {{ ref('int_pp__cost_per_credit') }} as cpi
        on cpi.fit_id = r.fit_id and cpi.flag_key = 'suite-default-model-create-image' and cpi.arm = r.arm_create_image
    left join {{ ref('int_pp__cost_per_credit') }} as cpv
        on cpv.fit_id = r.fit_id and cpv.flag_key = 'suite-default-model-create-video' and cpv.arm = r.arm_create_video
    left join cpc_pooled as ppi on ppi.fit_id = r.fit_id and ppi.media_type = 'image'
    left join cpc_pooled as ppv on ppv.fit_id = r.fit_id and ppv.media_type = 'video'

),

derived as (

    select
        i.*,
        case when i.purchase_kind = 'monthly' then i.renewal_prob else 0.0 end as s,
        -- what the next period costs: the charge itself for first/renewal, else the plan's list price
        case
            when i.event_name in ('purchase_first', 'purchase_renewal') then i.revenue_reporting
            else coalesce(i.list_price_usd, i.revenue_reporting)
        end as renewal_value,
        -- $/credit: own pre-purchase history blended with the arms' measured $/credit
        (coalesce(i.credits_before, 0) * coalesce(i.cost_per_credit_before_usd, i.arm_cost_per_credit_usd)
            + {{ var('pvs_cpc_prior_strength_credits') }} * i.arm_cost_per_credit_usd)
            / (coalesce(i.credits_before, 0) + {{ var('pvs_cpc_prior_strength_credits') }}) as cost_per_credit_usd,
        -- monthly burn: own paid burn per paid month so far, blended with utilization x plan credits
        case
            when i.paid_months_before > 0 then
                (i.paid_credits_before + {{ var('pvs_burn_prior_strength_months') }} * i.plan_utilization * coalesce(i.plan_monthly_credits, 0))
                / (i.paid_months_before + {{ var('pvs_burn_prior_strength_months') }})
            else i.plan_utilization * coalesce(i.plan_monthly_credits, 0)
        end as monthly_burn_credits
    from inputs as i

),

expected as (

    select
        d.*,
        case when d.purchase_kind = 'monthly' then d.s + d.s * d.s else 0.0 end as expected_renewals,
        case d.purchase_kind
            when 'monthly' then 1.0 + d.s + d.s * d.s
            when 'annual' then {{ window_months }}
            else 0.0
        end as expected_paid_months,
        -- renewals on the interval's low and high side (quantiles of 0/1/2 renewals)
        case
            when d.purchase_kind <> 'monthly' then 0
            when 1 - d.s >= {{ alpha }} then 0
            when 1 - d.s * d.s >= {{ alpha }} then 1
            else 2
        end as renewals_low,
        case
            when d.purchase_kind <> 'monthly' then 0
            when 1 - d.s >= {{ 1 - alpha }} then 0
            when 1 - d.s * d.s >= {{ 1 - alpha }} then 1
            else 2
        end as renewals_high,
        -- share of revenue kept after the %-fees and refund risk (fixed fees are per charge)
        1 - {{ fee }} - case when d.is_affiliate then {{ aff }} else 0 end
          - d.refund_rate_per_charge - d.chargeback_rate_per_charge as revenue_keep_share,
        {{ fixed }} + {{ dispute_fee }} * d.chargeback_rate_per_charge as cost_per_charge
    from derived as d

),

money as (

    select
        e.*,
        e.revenue_reporting
          + e.renewal_value * e.expected_renewals
          + case when e.purchase_kind in ('monthly', 'annual') then e.addon_revenue_per_month_usd * e.expected_paid_months else 0 end
          + case when e.purchase_kind = 'pack' then e.pack_future_revenue_usd else 0 end as revenue_90d,
        case
            when e.purchase_kind = 'pack' then coalesce(e.pack_credits, 0) * e.pack_utilization
            else e.monthly_burn_credits * e.expected_paid_months
        end as credits_90d,
        1.0 + e.expected_renewals as charges_90d
    from expected as e

),

priced as (

    select
        m.*,
        round(m.revenue_90d, 6) as predicted_revenue_90d,
        round(m.credits_90d * m.cost_per_credit_usd, 6) as predicted_generation_cost_90d,
        round(
            m.revenue_90d * {{ fee }}
            + m.charges_90d * {{ fixed }}
            + case when m.is_affiliate then m.revenue_90d * {{ aff }} else 0 end
            + m.charges_90d * m.chargeback_rate_per_charge * {{ dispute_fee }},
            6
        ) as predicted_fees_90d,
        round(m.revenue_90d * (m.refund_rate_per_charge + m.chargeback_rate_per_charge), 6) as predicted_refund_risk,
        -- interval ends: renewals at the low/high quantile, burn +/- z x CV
        {% for side, k, factor in [('low', 'm.renewals_low', '(1 + ' ~ z ~ ' * m.burn_cv)'), ('high', 'm.renewals_high', 'greatest(0, 1 - ' ~ z ~ ' * m.burn_cv)')] -%}
        (
            m.revenue_reporting + m.renewal_value * {{ k }}
            + case when m.purchase_kind in ('monthly', 'annual')
                   then m.addon_revenue_per_month_usd * case when m.purchase_kind = 'annual' then {{ window_months }} else 1 + {{ k }} end
                   else 0 end
            + case when m.purchase_kind = 'pack' then {{ '0' if side == 'low' else 'coalesce(m.pack_future_revenue_q90_usd, 0)' }} else 0 end
        ) * m.revenue_keep_share
        - (1 + {{ k }}) * m.cost_per_charge
        - case
              when m.purchase_kind = 'pack' then coalesce(m.pack_credits, 0) * m.pack_utilization
              when m.purchase_kind = 'annual' then m.monthly_burn_credits * {{ window_months }}
              else m.monthly_burn_credits * (1 + {{ k }})
          end * m.cost_per_credit_usd * {{ factor }} as structural_{{ side }}{% if not loop.last %},{% endif %}
        {% endfor %}
    from money as m

)

select
    p.purpose,
    p.fit_id,
    p.event_id,
    p.event_name,
    p.invoice_id,
    p.user_id,
    p.occurred_at,
    p.purchase_kind,
    p.plan_tier,
    p.billing_interval,
    p.country_bucket,
    p.acquisition_channel,
    p.is_affiliate,
    p.arm_create_image,
    p.arm_create_video,
    p.cf_fold,
    p.signup_week,
    p.is_qa_account,
    p.is_horizon_complete,
    p.currency,
    p.cash_value_minor,
    p.cash_value_reporting,
    p.revenue_reporting,
    p.reporting_currency,
    p.credits_before,
    p.video_credit_share_before,
    p.generation_cost_before_usd,
    p.cost_per_credit_before_usd,
    p.paid_months_before,
    p.previous_purchases,
    p.days_since_signup,
    round(p.s, 6) as renewal_prob,
    round(p.expected_renewals, 6) as expected_renewals,
    round(p.expected_paid_months, 6) as expected_paid_months,
    round(p.credits_90d, 3) as expected_credits_90d,
    round(p.cost_per_credit_usd, 8) as cost_per_credit_usd,
    p.predicted_revenue_90d,
    p.predicted_generation_cost_90d,
    p.predicted_fees_90d,
    p.predicted_refund_risk,
    round(p.predicted_revenue_90d - p.predicted_generation_cost_90d - p.predicted_fees_90d - p.predicted_refund_risk, 6) as predicted_profit_90d,
    round({{ least_of('p.structural_low', 'p.predicted_revenue_90d - p.predicted_generation_cost_90d - p.predicted_fees_90d - p.predicted_refund_risk') }}, 6) as interval_low,
    round({{ greatest_of('p.structural_high', 'p.predicted_revenue_90d - p.predicted_generation_cost_90d - p.predicted_fees_90d - p.predicted_refund_risk') }}, 6) as interval_high
from priced as p
