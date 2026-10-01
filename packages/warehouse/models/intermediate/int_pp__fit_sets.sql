-- Which users each fit may learn from (one row per fit x user). Every parameter model of the
-- 24h score and of the purchase value score is computed per fit_id from these sets, so the same
-- SQL serves production and the backtest:
--   all                    every eligible user (reported in dim_model_parameters; never used to score)
--   xf<k>                  cross-fitting: every user whose fold is NOT k. A user in fold k is always
--                          scored with xf<k>, so no score ever uses its own outcome (ML review 4/5)
--   oot_<week>             out-of-time: users who signed up before the test week (ML review 2)
--   oot_<week>_xf<k>       cross-fitting inside an out-of-time fit (its model-error estimate)
-- Eligible = non-QA users with a complete 24h window (int_pp__user_outcomes). Each parameter
-- model then applies its own maturity rule (conversion window, 90-day horizon).
with users as (

    select user_id, cf_fold, signup_week
    from {{ ref('int_pp__user_outcomes') }}

),

folds as (

    {% for k in range(var('pp_crossfit_folds')) -%}
    select {{ k }} as held_out_fold{% if not loop.last %} union all{% endif %}
    {% endfor %}

),

oot as (

    select fit_id as oot_fit_id, test_week_start from {{ ref('int_pp__oot_weeks') }}

)

select 'all' as fit_id, 'all' as fit_kind, u.user_id, cast(null as {{ dbt.type_int() }}) as held_out_fold, cast(null as date) as test_week_start
from users as u

union all

select 'xf' || cast(f.held_out_fold as {{ dbt.type_string() }}), 'crossfit', u.user_id, f.held_out_fold, cast(null as date)
from users as u
cross join folds as f
where u.cf_fold <> f.held_out_fold

union all

select o.oot_fit_id, 'out_of_time', u.user_id, cast(null as {{ dbt.type_int() }}), o.test_week_start
from users as u
inner join oot as o on u.signup_week < o.test_week_start

union all

select o.oot_fit_id || '_xf' || cast(f.held_out_fold as {{ dbt.type_string() }}), 'out_of_time_crossfit', u.user_id, f.held_out_fold, o.test_week_start
from users as u
inner join oot as o on u.signup_week < o.test_week_start
cross join folds as f
where u.cf_fold <> f.held_out_fold
