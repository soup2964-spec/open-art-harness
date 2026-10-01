-- Out-of-time backtest folds (ML review 2). Each fold is a signup week whose 90-day outcomes
-- are complete at the as-of instant (week start + 7 days + horizon <= as-of) and that has at
-- least one earlier signup week to learn from. The fold's fit (fit_id 'oot_<week>') sees only
-- users who signed up BEFORE the week; the week's users are then scored with it and compared
-- with their realised 90 days. The most recent pp_backtest_max_weeks weeks are kept.
{% set horizon_days = var('pp_horizon_days') %}

with weeks as (

    select signup_week, count(*) as users
    from {{ ref('int_pp__user_outcomes') }}
    group by signup_week

),

eligible as (

    select
        w.signup_week,
        w.users
    from weeks as w
    where {{ date_add_days('w.signup_week', 7 + horizon_days) }} <= cast({{ as_of_ts() }} as date)
      and w.signup_week > (select min(signup_week) from weeks)

)

select
    'oot_' || {{ date_compact('signup_week') }} as fit_id,
    signup_week as test_week_start,
    {{ date_add_days('signup_week', 7) }} as test_week_end,
    users as test_week_users
from (
    select e.*, row_number() over (order by e.signup_week desc) as recency
    from eligible as e
) as ranked
where recency <= {{ var('pp_backtest_max_weeks') }}
