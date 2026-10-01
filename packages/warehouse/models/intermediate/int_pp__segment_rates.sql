-- P(subscribe after the first 24h, within the maturity window) per behavioural segment and FIT
-- (int_pp__fit_sets), shrunk towards the ILLUSTRATIVE priors: rate = (conversions + k * prior) / (users + k).
with priors as (

    {{ pp_segment_priors() }}

),

fits as (

    select distinct fit_id from {{ ref('int_pp__fit_sets') }}

),

observed as (

    select
        s.fit_id,
        o.segment,
        count(*) as matured_users,
        sum(case when o.converted_after_24h then 1 else 0 end) as conversions
    from {{ ref('int_pp__fit_sets') }} as s
    inner join {{ ref('int_pp__user_outcomes') }} as o on o.user_id = s.user_id
    where o.is_conversion_mature
      and o.segment <> 'paid_24h'
    group by s.fit_id, o.segment

)

select
    f.fit_id,
    p.segment,
    p.prior_rate,
    coalesce(o.matured_users, 0) as matured_users,
    coalesce(o.conversions, 0) as conversions,
    {{ var('pp_prior_strength_users') }} as prior_strength_users,
    round(
        (coalesce(o.conversions, 0) + {{ var('pp_prior_strength_users') }} * p.prior_rate)
        / (coalesce(o.matured_users, 0) + {{ var('pp_prior_strength_users') }}),
        9
    ) as p_convert
from fits as f
cross join priors as p
left join observed as o on o.fit_id = f.fit_id and o.segment = p.segment
