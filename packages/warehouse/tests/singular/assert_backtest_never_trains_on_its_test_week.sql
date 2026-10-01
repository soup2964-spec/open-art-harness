-- The out-of-time backtest is out of time (ML review 2) and serving is cross-fitted (ML review 4):
--   1. no oot_<week> fit (or its _xf<k> fits) learns from a user who signed up in or after its week
--   2. every oot_test score belongs to a user of that week, with a complete 90-day horizon
--   3. no serving score (24h or purchase value) uses a fit that contains its own user
with oot_train_leak as (

    select 'oot fit trains on its test week or later' as violation, f.fit_id, f.user_id
    from {{ ref('int_pp__fit_sets') }} as f
    inner join {{ ref('int_pp__user_outcomes') }} as o on o.user_id = f.user_id
    where f.fit_kind in ('out_of_time', 'out_of_time_crossfit')
      and o.signup_week >= f.test_week_start

),

oot_test_wrong_week as (

    select 'oot_test user outside its test week or immature', s.fit_id, s.user_id
    from {{ ref('int_pp__scores') }} as s
    inner join {{ ref('int_pp__oot_weeks') }} as w on w.fit_id = s.fit_id
    inner join {{ ref('int_pp__user_outcomes') }} as o on o.user_id = s.user_id
    where s.purpose = 'oot_test'
      and (o.signup_week <> w.test_week_start or not o.is_horizon_complete)

),

serve_in_sample_24h as (

    select '24h serving score fit on its own user', s.fit_id, s.user_id
    from {{ ref('int_pp__scores') }} as s
    inner join {{ ref('int_pp__fit_sets') }} as f on f.fit_id = s.fit_id and f.user_id = s.user_id
    where s.purpose = 'serve'

),

serve_in_sample_pvs as (

    select 'purchase value serving score fit on its own user', s.fit_id, s.user_id
    from {{ ref('int_pvs__scores') }} as s
    inner join {{ ref('int_pp__fit_sets') }} as f on f.fit_id = s.fit_id and f.user_id = s.user_id
    where s.purpose = 'serve'

)

select * from oot_train_leak
union all select * from oot_test_wrong_week
union all select * from serve_in_sample_24h
union all select * from serve_in_sample_pvs
