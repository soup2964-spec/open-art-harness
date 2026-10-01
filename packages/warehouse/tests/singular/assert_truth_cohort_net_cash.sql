{{ config(enabled=is_fixture_mode()) }}
-- Ground truth: every cohort user's net cash in the ledger (purchases minus refunds and
-- chargebacks) equals cohort_truth.net_cash_minor from the generator.
with ledger as (

    select user_id, sum(cash_value_minor) as net_minor
    from {{ ref('fct_conversion_ledger') }}
    where cash_value_minor is not null
    group by user_id

)

select t.user_id, t.net_cash_minor as truth_minor, coalesce(l.net_minor, 0) as ledger_minor
from {{ source('synthetic', 'cohort_truth') }} as t
left join ledger as l on l.user_id = t.user_id
where t.net_cash_minor <> coalesce(l.net_minor, 0)
