-- Per FIT: the 90-day value of a new subscriber who had not paid within 24h (users whose horizon
-- is complete), shrunk towards the ILLUSTRATIVE priors, plus two cost inputs MEASURED from the
-- ledger (ML review 4: no more "100% default model" assumption):
--   paid_video_credit_share  share of paid credits spent on video by the fit's users
--   trial_cost_per_credit    serving cost per trial credit
-- both shrunk towards the var priors (pp_video_credit_share, default_cost_per_credit_usd).
with fits as (

    select distinct fit_id from {{ ref('int_pp__fit_sets') }}

),

converters as (

    select s.fit_id, o.*
    from {{ ref('int_pp__fit_sets') }} as s
    inner join {{ ref('int_pp__user_outcomes') }} as o on o.user_id = s.user_id
    where o.is_horizon_complete
      and o.converted_in_horizon
      and o.segment <> 'paid_24h'

),

observed as (

    select
        fit_id,
        count(*) as matured_converters,
        coalesce(sum(gross_revenue_horizon_usd), 0) as sum_revenue_usd,
        coalesce(sum(charges_horizon), 0) as sum_charges,
        coalesce(sum(paid_credits_horizon), 0) as sum_paid_credits
    from converters
    group by fit_id

),

usage as (

    select
        s.fit_id,
        sum(case when g.credit_field <> 'trial_credit_balance' then g.credits_costed else 0 end) as paid_credits,
        sum(case when g.credit_field <> 'trial_credit_balance' and g.media_type = 'video' then g.credits_costed else 0 end) as paid_video_credits,
        sum(case when g.credit_field = 'trial_credit_balance' then g.credits_costed else 0 end) as trial_credits,
        sum(case when g.credit_field = 'trial_credit_balance' then g.cost_usd else 0 end) as trial_cost_usd
    from {{ ref('int_pp__fit_sets') }} as s
    inner join {{ ref('fct_generation_cost') }} as g
        on g.user_id = s.user_id
       and not g.is_failed_generation
    group by s.fit_id

)

select
    f.fit_id,
    coalesce(o.matured_converters, 0) as matured_converters,
    {{ var('pp_value_prior_strength_converters') }} as prior_strength_converters,
    round((coalesce(o.sum_revenue_usd, 0) + {{ var('pp_value_prior_strength_converters') }} * {{ var('pp_prior_revenue_per_converter_usd') }})
        / (coalesce(o.matured_converters, 0) + {{ var('pp_value_prior_strength_converters') }}), 9) as revenue_per_converter_usd,
    round((coalesce(o.sum_charges, 0) + {{ var('pp_value_prior_strength_converters') }} * {{ var('pp_prior_charges_per_converter') }})
        / (coalesce(o.matured_converters, 0) + {{ var('pp_value_prior_strength_converters') }}), 9) as charges_per_converter,
    round((coalesce(o.sum_paid_credits, 0) + {{ var('pp_value_prior_strength_converters') }} * {{ var('pp_prior_paid_credits_per_converter') }})
        / (coalesce(o.matured_converters, 0) + {{ var('pp_value_prior_strength_converters') }}), 9) as paid_credits_per_converter,
    coalesce(u.paid_credits, 0) as measured_paid_credits,
    round((coalesce(u.paid_video_credits, 0) + {{ var('pp_cpc_prior_strength_credits') }} * {{ var('pp_video_credit_share') }})
        / (coalesce(u.paid_credits, 0) + {{ var('pp_cpc_prior_strength_credits') }}), 9) as paid_video_credit_share,
    coalesce(u.trial_credits, 0) as measured_trial_credits,
    round((coalesce(u.trial_cost_usd, 0) + {{ var('pp_cpc_prior_strength_credits') }} * {{ var('default_cost_per_credit_usd') }})
        / (coalesce(u.trial_credits, 0) + {{ var('pp_cpc_prior_strength_credits') }}), 9) as trial_cost_per_credit_usd
from fits as f
left join observed as o on o.fit_id = f.fit_id
left join usage as u on u.fit_id = f.fit_id
