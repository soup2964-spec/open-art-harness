{{ config(enabled=is_fixture_mode()) }}
-- Ground truth: successful generations and credits burned per cohort user (ledger CONSUME not
-- refunded, as priced in fct_generation_cost) equal the generator's counters; activation too.
with costed as (

    select
        user_id,
        count(*) as generations,
        sum(credits_charged) as credits
    from {{ ref('fct_generation_cost') }}
    where not is_failed_generation
    group by user_id

)

select t.user_id, t.generations, c.generations as warehouse_generations, t.credits_consumed, c.credits as warehouse_credits, t.activated
from {{ source('synthetic', 'cohort_truth') }} as t
left join costed as c on c.user_id = t.user_id
where t.generations <> coalesce(c.generations, 0)
   or t.credits_consumed <> coalesce(c.credits, 0)
   or t.activated <> (coalesce(c.generations, 0) > 0)
