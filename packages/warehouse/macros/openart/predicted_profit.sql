{#- Shared pieces of the v0 predicted-profit estimator (fct_predicted_profit_24h). -#}

{# The behavioural segment a user is in at 24 hours. Each segment has its own P(subscribe). #}
{% macro pp_segment(features_alias) -%}
  case
    when {{ features_alias }}.paid_within_24h then 'paid_24h'
    when not {{ features_alias }}.activated_24h then 'not_activated'
    when {{ features_alias }}.trial_depleted_24h then 'activated_depleted'
    else 'activated'
  end
{%- endmacro %}

{# The priors for the three unpaid segments, as a portable inline table. #}
{% macro pp_segment_priors() -%}
  select 'not_activated' as segment, cast({{ var('pp_prior_p_convert_not_activated') }} as {{ type_double() }}) as prior_rate
  union all
  select 'activated', cast({{ var('pp_prior_p_convert_activated') }} as {{ type_double() }})
  union all
  select 'activated_depleted', cast({{ var('pp_prior_p_convert_depleted') }} as {{ type_double() }})
{%- endmacro %}

{#-
  The 24h score (fct_predicted_profit_24h), as CTEs over a `rows` CTE that carries every
  fct_user_features_24h column plus `purpose` and `fit_id`. Every fitted input is joined on
  fit_id, so one implementation serves production (fit xf<fold>: cross-fitted), the out-of-time
  backtest (fit oot_<week>) and the backtest's own cross-fitted residuals. Ends in `pp_scored`.
    P(subscribe)   paid within 24h -> 1; otherwise the 24h behaviour segment's rate; the `cal`
                   variant also multiplies by the arms' EB-shrunk conversion multipliers
    revenue        paid: first charge + expected monthly renewals (pp_monthly_retention);
                   unpaid: P x 90-day revenue of a new subscriber (x arm value multipliers in `cal`)
    serving cost   cost incurred in 24h + leftover trial credits (measured trial $/credit) +
                   expected paid credits x the MEASURED $/credit of the user's arms, mixed by the
                   measured paid video credit share (int_pp__cost_per_credit, int_pp__converter_value)
    fees, risk     payment % + fixed per charge + affiliate commission; refund/chargeback loss
  Decomposition (ML review 8): predicted_profit = p_convert * value_if_converted - unconditional_cost,
  where unconditional_cost is what the user costs whether or not they convert (24h cost + leftover
  trial credits) and value_if_converted = everything else divided by p_convert.
-#}
{% macro pp_score_24h_ctes(rows) -%}
{%- set r = var('pp_monthly_retention') -%}
{%- set q = var('pp_refund_prob_per_charge') + var('pp_chargeback_prob_per_charge') -%}
pp_plan_credits as (

    select plan_tier, max(monthly_credits) as monthly_credits
    from {{ ref('plan_catalog') }}
    where item_type = 'plan'
    group by plan_tier

),

pp_pack_credits as (

    select max(credits_per_unit) as credits_per_pack
    from {{ ref('plan_catalog') }}
    where item_type = 'one_time_pack'

),

pp_cpc_pooled as (

    select fit_id, media_type, max(pooled_cost_per_credit_usd) as pooled_cost_per_credit_usd
    from {{ ref('int_pp__cost_per_credit') }}
    group by fit_id, media_type

),

pp_inputs as (

    select
        rw.*,
        {{ pp_segment('rw') }} as segment,
        sr.p_convert as segment_p_convert,
        coalesce(mi.conversion_multiplier, 1.0) * coalesce(mv.conversion_multiplier, 1.0) as conversion_multiplier,
        coalesce(mi.value_multiplier, 1.0) * coalesce(mv.value_multiplier, 1.0) as value_multiplier,
        cv.revenue_per_converter_usd,
        cv.charges_per_converter,
        cv.paid_credits_per_converter,
        cv.paid_video_credit_share,
        cv.trial_cost_per_credit_usd,
        coalesce(cpi.cost_per_credit_usd, ppi.pooled_cost_per_credit_usd, {{ var('default_cost_per_credit_usd') }}) as image_cost_per_credit_usd,
        coalesce(cpv.cost_per_credit_usd, ppv.pooled_cost_per_credit_usd, {{ var('default_cost_per_credit_usd') }}) as video_cost_per_credit_usd,
        cv.paid_video_credit_share * coalesce(cpv.cost_per_credit_usd, ppv.pooled_cost_per_credit_usd, {{ var('default_cost_per_credit_usd') }})
            + (1 - cv.paid_video_credit_share) * coalesce(cpi.cost_per_credit_usd, ppi.pooled_cost_per_credit_usd, {{ var('default_cost_per_credit_usd') }})
            as cost_per_credit_mix_usd,
        pl.monthly_credits as plan_monthly_credits,
        pk.credits_per_pack,
        -- what a payer-within-24h is expected to pay / burn over the horizon
        case
            when rw.first_purchase_event_name = 'purchase_one_time_pack' then 1.0
            when rw.billing_interval = 'month' then 1.0 + {{ r }} + {{ r }} * {{ r }}
            else 1.0
        end as paid_charges,
        case
            when rw.first_purchase_event_name = 'purchase_one_time_pack' then rw.first_purchase_value_usd
            when rw.billing_interval = 'month' then rw.first_purchase_value_usd * (1.0 + {{ r }} + {{ r }} * {{ r }})
            else rw.first_purchase_value_usd
        end as paid_revenue,
        case
            when rw.first_purchase_event_name = 'purchase_one_time_pack' then pk.credits_per_pack * {{ var('pp_plan_utilization') }}
            when rw.billing_interval = 'month' then pl.monthly_credits * {{ var('pp_plan_utilization') }} * (1.0 + {{ r }} + {{ r }} * {{ r }})
            -- annual plans refill monthly: three refills inside a 90-day horizon
            else pl.monthly_credits * {{ var('pp_plan_utilization') }} * 3.0
        end as paid_credits
    from {{ rows }} as rw
    left join {{ ref('int_pp__segment_rates') }} as sr on sr.fit_id = rw.fit_id and sr.segment = {{ pp_segment('rw') }}
    left join {{ ref('int_pp__arm_multipliers') }} as mi
        on mi.fit_id = rw.fit_id and mi.flag_key = 'suite-default-model-create-image' and mi.arm = rw.arm_create_image
    left join {{ ref('int_pp__arm_multipliers') }} as mv
        on mv.fit_id = rw.fit_id and mv.flag_key = 'suite-default-model-create-video' and mv.arm = rw.arm_create_video
    left join {{ ref('int_pp__cost_per_credit') }} as cpi
        on cpi.fit_id = rw.fit_id and cpi.flag_key = 'suite-default-model-create-image' and cpi.arm = rw.arm_create_image
    left join {{ ref('int_pp__cost_per_credit') }} as cpv
        on cpv.fit_id = rw.fit_id and cpv.flag_key = 'suite-default-model-create-video' and cpv.arm = rw.arm_create_video
    left join pp_cpc_pooled as ppi on ppi.fit_id = rw.fit_id and ppi.media_type = 'image'
    left join pp_cpc_pooled as ppv on ppv.fit_id = rw.fit_id and ppv.media_type = 'video'
    left join {{ ref('int_pp__converter_value') }} as cv on cv.fit_id = rw.fit_id
    left join pp_plan_credits as pl on pl.plan_tier = rw.plan_tier
    cross join pp_pack_credits as pk

),

pp_expectations as (

    select
        i.*,
        {% for v in ['cal', 'sig'] -%}
        {%- set conv = 'i.conversion_multiplier' if v == 'cal' else '1.0' -%}
        {%- set val = 'i.value_multiplier' if v == 'cal' else '1.0' -%}
        case when i.paid_within_24h then 1.0
             else {{ least_of('i.segment_p_convert * ' ~ conv, 1.0) }} end as {{ v }}_p_convert,
        case when i.paid_within_24h then i.paid_revenue
             else {{ least_of('i.segment_p_convert * ' ~ conv, 1.0) }} * i.revenue_per_converter_usd * {{ val }} end as {{ v }}_revenue,
        case when i.paid_within_24h then i.paid_charges
             else {{ least_of('i.segment_p_convert * ' ~ conv, 1.0) }} * i.charges_per_converter end as {{ v }}_charges,
        -- bigger plans burn more credits, so paid credits scale with the value term too
        case when i.paid_within_24h then i.paid_credits
             else {{ least_of('i.segment_p_convert * ' ~ conv, 1.0) }} * i.paid_credits_per_converter * {{ val }} end as {{ v }}_paid_credits{% if not loop.last %},{% endif %}
        {% endfor %}
    from pp_inputs as i

),

pp_money as (

    select
        e.*,
        -- cost whether or not the user converts: realised 24h cost + leftover trial credits
        round(
            e.generation_cost_24h_usd
            + coalesce(e.trial_credits_remaining_24h, 0) * {{ var('pp_trial_leftover_use_share') }} * e.trial_cost_per_credit_usd,
            6
        ) as unconditional_cost,
        {% for v in ['cal', 'sig'] -%}
        round(coalesce(e.{{ v }}_revenue, 0), 6) as {{ v }}_predicted_revenue,
        round(
            e.generation_cost_24h_usd
            + coalesce(e.trial_credits_remaining_24h, 0) * {{ var('pp_trial_leftover_use_share') }} * e.trial_cost_per_credit_usd
            + coalesce(e.{{ v }}_paid_credits, 0) * e.cost_per_credit_mix_usd,
            6
        ) as {{ v }}_predicted_generation_cost,
        round(
            coalesce(e.{{ v }}_revenue, 0) * {{ var('payment_fee_pct') }}
            + coalesce(e.{{ v }}_charges, 0) * {{ var('payment_fee_fixed_usd') }}
            + case when e.acquisition_channel = 'affiliate' then coalesce(e.{{ v }}_revenue, 0) * {{ var('affiliate_commission_pct') }} else 0 end,
            6
        ) as {{ v }}_predicted_fees,
        round(
            coalesce(e.{{ v }}_revenue, 0) * {{ q }}
            + coalesce(e.{{ v }}_charges, 0) * {{ var('pp_chargeback_prob_per_charge') }} * {{ var('dispute_fee_usd') }},
            6
        ) as {{ v }}_predicted_refund_risk,
        -- P(at least one refund or chargeback over the expected charges)
        1 - power(1 - {{ q }}, coalesce(e.{{ v }}_charges, 0)) as {{ v }}_refund_probability{% if not loop.last %},{% endif %}
        {% endfor %}
    from pp_expectations as e

),

pp_scored as (

    select
        m.*,
        {% for v in ['cal', 'sig'] -%}
        round(
            m.{{ v }}_predicted_revenue - m.{{ v }}_predicted_generation_cost
            - m.{{ v }}_predicted_fees - m.{{ v }}_predicted_refund_risk,
            6
        ) as {{ v }}_predicted_profit{% if not loop.last %},{% endif %}
        {% endfor %}
    from pp_money as m

)
{%- endmacro %}

{#-
  Registry of every model parameter, its label and where the value comes from. Rendered into
  dim_model_parameters; a test fails if a pp_* / fee / cost var is missing from it.
  label: ILLUSTRATIVE (assumption) | OBSERVED (research or platform docs) | CONFIG (plumbing)
-#}
{% macro model_parameter_registry() -%}
  {{ return([
    {'name': 'pp_horizon_days', 'label': 'CONFIG', 'used_in': 'fct_predicted_profit_24h, fct_purchase_value_score', 'source': 'PredictedProfit and PurchaseValueScore contracts (horizon_days const 90)'},
    {'name': 'pp_conversion_maturity_days', 'label': 'ILLUSTRATIVE', 'used_in': 'int_pp__segment_rates, int_pp__arm_multipliers', 'source': 'assumption: users this old have finished converting'},
    {'name': 'pp_crossfit_folds', 'label': 'CONFIG', 'used_in': 'int_pp__fit_sets (every score is cross-fitted)', 'source': 'cross-fitting folds (ML review 4/5)'},
    {'name': 'pp_backtest_max_weeks', 'label': 'CONFIG', 'used_in': 'int_pp__oot_weeks', 'source': 'out-of-time backtest folds kept (ML review 2)'},
    {'name': 'oot_mae_cap_usd', 'label': 'CONFIG', 'used_in': 'python_tests/oot_eval.py', 'source': 'capped MAE clip of the backtest'},
    {'name': 'pp_cpc_prior_strength_credits', 'label': 'ILLUSTRATIVE', 'used_in': 'int_pp__cost_per_credit, int_pp__converter_value', 'source': 'EB pseudo-credits pulling a measured arm $/credit to the pooled rate'},
    {'name': 'pvs_interval_coverage', 'label': 'CONFIG', 'used_in': 'int_pvs__scores', 'source': 'nominal coverage of the purchase value interval'},
    {'name': 'pvs_renewal_prior_strength', 'label': 'ILLUSTRATIVE', 'used_in': 'int_pvs__renewal_rates', 'source': 'EB pseudo-opportunities (tier -> pp_monthly_retention)'},
    {'name': 'pvs_renewal_country_prior_strength', 'label': 'ILLUSTRATIVE', 'used_in': 'int_pvs__renewal_rates', 'source': 'EB pseudo-opportunities (country bucket -> tier)'},
    {'name': 'pvs_prior_addon_revenue_per_month_usd', 'label': 'ILLUSTRATIVE', 'used_in': 'int_pvs__params', 'source': 'prior; shrunk towards observed add-on + upgrade revenue'},
    {'name': 'pvs_addon_prior_strength_months', 'label': 'ILLUSTRATIVE', 'used_in': 'int_pvs__params', 'source': 'EB pseudo-months'},
    {'name': 'pvs_util_prior_strength_credits', 'label': 'ILLUSTRATIVE', 'used_in': 'int_pvs__params', 'source': 'EB pseudo-credits of capacity (utilization -> pp_plan_utilization)'},
    {'name': 'pvs_prior_burn_cv', 'label': 'ILLUSTRATIVE', 'used_in': 'int_pvs__params', 'source': 'prior CV of monthly burn when < 5 subscribers are observed'},
    {'name': 'pvs_prior_pack_future_revenue_usd', 'label': 'ILLUSTRATIVE', 'used_in': 'int_pvs__params', 'source': 'prior; shrunk towards matured one-time packs'},
    {'name': 'pvs_prior_pack_future_revenue_q90_usd', 'label': 'ILLUSTRATIVE', 'used_in': 'int_pvs__params', 'source': 'prior 90th percentile when < 10 matured packs'},
    {'name': 'pvs_pack_prior_strength', 'label': 'ILLUSTRATIVE', 'used_in': 'int_pvs__params', 'source': 'EB pseudo-packs'},
    {'name': 'pvs_rate_prior_strength_charges', 'label': 'ILLUSTRATIVE', 'used_in': 'int_pvs__params', 'source': 'EB pseudo-charges (refund, chargeback rates)'},
    {'name': 'pvs_cpc_prior_strength_credits', 'label': 'ILLUSTRATIVE', 'used_in': 'int_pvs__scores', 'source': 'pseudo-credits of the arm $/credit against the own history of the user'},
    {'name': 'pvs_burn_prior_strength_months', 'label': 'ILLUSTRATIVE', 'used_in': 'int_pvs__scores', 'source': 'pseudo-months of plan utilization against the own burn of the subscriber'},
    {'name': 'readout_bootstrap_replicates', 'label': 'CONFIG', 'used_in': 'fct_experiment_profit_by_arm', 'source': 'Poisson bootstrap replicates (null: 200 on fixtures, off in prod)'},
    {'name': 'readout_min_matured_for_arm_error', 'label': 'ILLUSTRATIVE', 'used_in': 'fct_experiment_profit_by_arm', 'source': 'below this many matured scored users an arm borrows the pooled residual variance of the flag'},
    {'name': 'cuped_prior_strength_users', 'label': 'ILLUSTRATIVE', 'used_in': 'int_experiment__user_readout', 'source': 'EB pseudo-users of the CUPED segment covariate'},
    {'name': 'reporting_currency', 'label': 'CONFIG', 'used_in': 'int_fx__rates and every *_reporting column', 'source': 'seeds/fx_rates.csv is ILLUSTRATIVE (placeholder rates in USD)'},
    {'name': 'bandit_value_cap_usd', 'label': 'CONFIG', 'used_in': 'fct_experiment_profit_by_arm_daily', 'source': 'bandit-allocator DEFAULT_VALUE_CAP_USD (winsorised matured value)'},
    {'name': 'holdout_key_pattern', 'label': 'CONFIG', 'used_in': 'int_experiment__user_readout', 'source': 'bandit-allocator launchdarkly.ts HOLDOUT_KEY_PATTERN'},
    {'name': 'pp_prior_p_convert_not_activated', 'label': 'ILLUSTRATIVE', 'used_in': 'int_pp__segment_rates', 'source': 'prior; shrunk towards observed matured users'},
    {'name': 'pp_prior_p_convert_activated', 'label': 'ILLUSTRATIVE', 'used_in': 'int_pp__segment_rates', 'source': 'prior; shrunk towards observed matured users'},
    {'name': 'pp_prior_p_convert_depleted', 'label': 'ILLUSTRATIVE', 'used_in': 'int_pp__segment_rates', 'source': 'prior; shrunk towards observed matured users'},
    {'name': 'pp_prior_strength_users', 'label': 'ILLUSTRATIVE', 'used_in': 'int_pp__segment_rates', 'source': 'empirical-Bayes pseudo-users'},
    {'name': 'pp_use_arm_calibration', 'label': 'CONFIG', 'used_in': 'fct_predicted_profit_24h', 'source': 'switch: false = signals-only (ML review 4); true = cross-fitted EB arm multipliers'},
    {'name': 'pp_prior_revenue_per_converter_usd', 'label': 'ILLUSTRATIVE', 'used_in': 'int_pp__converter_value', 'source': 'prior; shrunk towards matured converters'},
    {'name': 'pp_prior_paid_credits_per_converter', 'label': 'ILLUSTRATIVE', 'used_in': 'int_pp__converter_value', 'source': 'prior; shrunk towards matured converters'},
    {'name': 'pp_prior_charges_per_converter', 'label': 'ILLUSTRATIVE', 'used_in': 'int_pp__converter_value', 'source': 'prior; shrunk towards matured converters'},
    {'name': 'pp_value_prior_strength_converters', 'label': 'ILLUSTRATIVE', 'used_in': 'int_pp__converter_value', 'source': 'empirical-Bayes pseudo-subscribers; weak because the three priors are uninformed guesses'},
    {'name': 'pp_monthly_retention', 'label': 'ILLUSTRATIVE', 'used_in': 'fct_predicted_profit_24h', 'source': 'renewal probability of a payer-within-24h monthly plan'},
    {'name': 'pp_plan_utilization', 'label': 'ILLUSTRATIVE', 'used_in': 'fct_predicted_profit_24h', 'source': 'research/04 §5: utilisation u is the margin driver; value assumed'},
    {'name': 'pp_video_credit_share', 'label': 'ILLUSTRATIVE', 'used_in': 'int_pp__converter_value', 'source': 'prior of the MEASURED paid video credit share (videos cost 10-100x an image in credits, research/04 §3)'},
    {'name': 'pp_trial_leftover_use_share', 'label': 'ILLUSTRATIVE', 'used_in': 'fct_predicted_profit_24h', 'source': 'assumption'},
    {'name': 'pp_refund_prob_per_charge', 'label': 'ILLUSTRATIVE', 'used_in': 'fct_predicted_profit_24h', 'source': 'assumption (research/12 Q3: refunds happen, rate unknown)'},
    {'name': 'pp_chargeback_prob_per_charge', 'label': 'ILLUSTRATIVE', 'used_in': 'fct_predicted_profit_24h', 'source': 'assumption (research/12 Q2: card-testing chargebacks exist, rate unknown)'},
    {'name': 'payment_fee_pct', 'label': 'ILLUSTRATIVE', 'used_in': 'fct_predicted_profit_24h, fct_experiment_profit_by_arm', 'source': 'research/04 §0: about 3.6% plus $0.30 per charge'},
    {'name': 'payment_fee_fixed_usd', 'label': 'ILLUSTRATIVE', 'used_in': 'fct_predicted_profit_24h, fct_experiment_profit_by_arm', 'source': 'research/04 §0'},
    {'name': 'affiliate_commission_pct', 'label': 'OBSERVED', 'used_in': 'fct_predicted_profit_24h, fct_experiment_profit_by_arm', 'source': 'Tolt default terms 20% (research/12 A4)'},
    {'name': 'dispute_fee_usd', 'label': 'ILLUSTRATIVE', 'used_in': 'fct_predicted_profit_24h, fct_experiment_profit_by_arm', 'source': 'assumption'},
    {'name': 'vendor_discount_pct', 'label': 'ILLUSTRATIVE', 'used_in': 'int_model_costs__priced', 'source': 'research/04 §0.7: the thesis flips only at >= 40%'},
    {'name': 'failed_generation_cost_share', 'label': 'ILLUSTRATIVE', 'used_in': 'fct_generation_cost', 'source': 'assumption: failed generations are not billed by vendors'},
    {'name': 'default_cost_per_credit_usd', 'label': 'OBSERVED', 'used_in': 'fct_generation_cost', 'source': 'research/04: median list $/credit over 110 priced settings'},
    {'name': 'trial_min_generation_credits', 'label': 'OBSERVED', 'used_in': 'fct_user_features_24h', 'source': 'cheapest default image arm = 5 credits (research/12 V2)'},
    {'name': 'attribution_clock_skew_seconds', 'label': 'ILLUSTRATIVE', 'used_in': 'fct_conversion_ledger, fct_user_features_24h', 'source': 'assumption: Amplitude logs a few seconds after the page bootstrap'},
    {'name': 'audience_seed_top_share', 'label': 'ILLUSTRATIVE', 'used_in': 'fct_audience_candidates', 'source': 'assumption'},
    {'name': 'audience_seed_min_profit_usd', 'label': 'ILLUSTRATIVE', 'used_in': 'fct_audience_candidates', 'source': 'assumption'},
    {'name': 'audience_low_profit_threshold_usd', 'label': 'ILLUSTRATIVE', 'used_in': 'fct_audience_candidates', 'source': 'assumption'},
    {'name': 'ci_z', 'label': 'CONFIG', 'used_in': 'fct_experiment_profit_by_arm', 'source': '95% two-sided normal approximation'}
  ]) }}
{%- endmacro %}

{# Scalar fitted columns of int_pvs__params (registered in int_model_parameters__current). #}
{% macro pvs_param_columns() -%}
  {{ return(['addon_revenue_per_month_usd', 'plan_utilization', 'burn_cv', 'pack_utilization', 'pack_future_revenue_usd', 'pack_future_revenue_q90_usd', 'refund_rate_per_charge', 'chargeback_rate_per_charge']) }}
{%- endmacro %}
