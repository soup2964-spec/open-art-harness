{{ config(enabled=is_fixture_mode()) }}
-- Ground truth: exposed users and converters per arm in the readout equal the generator's
-- (every cohort subscriber converts within 14 days, so the 90-day window is complete for it).
with truth as (

    select 'suite-default-model-create-image' as flag_key, arm_create_image as arm, count(*) as users,
           sum(case when converted then 1 else 0 end) as converters
    from {{ source('synthetic', 'cohort_truth') }}
    group by arm_create_image
    union all
    select 'suite-default-model-create-video', arm_create_video, count(*),
           sum(case when converted then 1 else 0 end)
    from {{ source('synthetic', 'cohort_truth') }}
    group by arm_create_video

)

select t.flag_key, t.arm, t.users, e.exposed_users, t.converters, e.converters as warehouse_converters
from truth as t
full outer join {{ ref('fct_experiment_profit_by_arm') }} as e on e.flag_key = t.flag_key and e.arm = t.arm
where e.arm is null or t.arm is null or e.exposed_users <> t.users or e.converters <> t.converters
