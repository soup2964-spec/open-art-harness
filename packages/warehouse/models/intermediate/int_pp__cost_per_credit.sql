-- Serving cost per credit of each default-model ARM, MEASURED from the ledger per FIT (ML review
-- 4): the realised cost / credits of the paid generations of the fit's users in that arm (image
-- flag: their image generations; video flag: their video generations), whatever model they
-- actually used, shrunk towards the fit's pooled cost per credit of that media type
-- (pp_cpc_prior_strength_credits pseudo-credits). Replaces "every paid credit goes to the arm's
-- default model at list price". Cross-fitted like everything else: a user in fold k is priced
-- with xf<k>, so its own generations never price it.
{%- set flag_media = {'suite-default-model-create-image': 'image', 'suite-default-model-create-video': 'video'} %}

with fits as (

    select distinct fit_id from {{ ref('int_pp__fit_sets') }}

),

paid as (

    select
        s.fit_id,
        o.arm_create_image,
        o.arm_create_video,
        g.media_type,
        g.credits_costed,
        g.cost_usd
    from {{ ref('int_pp__fit_sets') }} as s
    inner join {{ ref('int_pp__user_outcomes') }} as o on o.user_id = s.user_id
    inner join {{ ref('fct_generation_cost') }} as g
        on g.user_id = s.user_id
       and g.credit_field <> 'trial_credit_balance'
       and not g.is_failed_generation
       and g.credits_costed > 0

),

pooled as (

    select
        fit_id,
        media_type,
        sum(cost_usd) as cost_usd,
        sum(credits_costed) as credits
    from paid
    group by fit_id, media_type

),

per_arm as (

    {% for flag, media in flag_media.items() -%}
    select
        fit_id,
        '{{ flag }}' as flag_key,
        arm_create_{{ media }} as arm,
        '{{ media }}' as media_type,
        sum(cost_usd) as cost_usd,
        sum(credits_costed) as credits
    from paid
    where media_type = '{{ media }}'
      and arm_create_{{ media }} is not null
    group by fit_id, arm_create_{{ media }}
    {% if not loop.last %}union all{% endif %}
    {% endfor %}

),

arms as (

    select f.fit_id, a.flag_key, a.arm, case when a.flag_key like '%image' then 'image' else 'video' end as media_type
    from fits as f
    cross join {{ ref('default_model_arms') }} as a

)

select
    a.fit_id,
    a.flag_key,
    a.arm,
    a.media_type,
    coalesce(pa.credits, 0) as measured_credits,
    coalesce(pa.cost_usd, 0) as measured_cost_usd,
    round(coalesce({{ safe_divide('po.cost_usd', 'po.credits') }}, {{ var('default_cost_per_credit_usd') }}), 9) as pooled_cost_per_credit_usd,
    round(
        (coalesce(pa.cost_usd, 0) + {{ var('pp_cpc_prior_strength_credits') }} * coalesce({{ safe_divide('po.cost_usd', 'po.credits') }}, {{ var('default_cost_per_credit_usd') }}))
        / (coalesce(pa.credits, 0) + {{ var('pp_cpc_prior_strength_credits') }}),
        9
    ) as cost_per_credit_usd
from arms as a
left join per_arm as pa on pa.fit_id = a.fit_id and pa.flag_key = a.flag_key and pa.arm = a.arm
left join pooled as po on po.fit_id = a.fit_id and po.media_type = a.media_type
