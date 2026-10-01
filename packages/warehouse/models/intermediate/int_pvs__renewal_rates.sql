-- P(a monthly subscription charge renews within 45 days), per FIT x plan tier x country bucket,
-- from every renewal decision already observable (charge + 45 days <= as-of): survival data, so
-- it learns from purchases whose 90 days are not complete yet. Two-level empirical Bayes:
--   tier    (renewals + k_t * prior) / (opportunities + k_t)        prior = pp_monthly_retention
--   cell    (renewals + k_c * tier rate) / (opportunities + k_c)    country buckets shrink to the tier
-- Purchases of the fit's users only (int_pp__fit_sets), non-QA.
with fits as (

    select distinct fit_id from {{ ref('int_pp__fit_sets') }}

),

tiers as (

    select distinct plan_tier from {{ ref('plan_catalog') }} where item_type = 'plan' and plan_tier is not null

),

buckets as (

    select 'us' as country_bucket union all select 'tier1' union all select 'rest' union all select 'unknown'

),

opportunities as (

    select
        s.fit_id,
        f.plan_tier,
        f.country_bucket,
        o.renewed_within_45d
    from {{ ref('int_pp__fit_sets') }} as s
    inner join {{ ref('int_pvs__features') }} as f on f.user_id = s.user_id and not f.is_qa_account
    inner join {{ ref('int_pvs__outcomes') }} as o on o.event_id = f.event_id
    where o.is_renewal_opportunity
      and o.is_renewal_observable

),

by_tier as (

    select fit_id, plan_tier, count(*) as opportunities, sum(case when renewed_within_45d then 1 else 0 end) as renewals
    from opportunities
    group by fit_id, plan_tier

),

by_cell as (

    select fit_id, plan_tier, country_bucket, count(*) as opportunities, sum(case when renewed_within_45d then 1 else 0 end) as renewals
    from opportunities
    group by fit_id, plan_tier, country_bucket

),

tier_rates as (

    select
        f.fit_id,
        t.plan_tier,
        coalesce(bt.opportunities, 0) as tier_opportunities,
        (coalesce(bt.renewals, 0) + {{ var('pvs_renewal_prior_strength') }} * {{ var('pp_monthly_retention') }})
            / (coalesce(bt.opportunities, 0) + {{ var('pvs_renewal_prior_strength') }}) as tier_renewal_prob
    from fits as f
    cross join tiers as t
    left join by_tier as bt on bt.fit_id = f.fit_id and bt.plan_tier = t.plan_tier

)

select
    tr.fit_id,
    tr.plan_tier,
    b.country_bucket,
    coalesce(bc.opportunities, 0) as opportunities,
    coalesce(bc.renewals, 0) as renewals,
    tr.tier_opportunities,
    round(tr.tier_renewal_prob, 9) as tier_renewal_prob,
    round(
        (coalesce(bc.renewals, 0) + {{ var('pvs_renewal_country_prior_strength') }} * tr.tier_renewal_prob)
        / (coalesce(bc.opportunities, 0) + {{ var('pvs_renewal_country_prior_strength') }}),
        9
    ) as renewal_prob
from tier_rates as tr
cross join buckets as b
left join by_cell as bc on bc.fit_id = tr.fit_id and bc.plan_tier = tr.plan_tier and bc.country_bucket = b.country_bucket
