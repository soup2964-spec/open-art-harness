{{ config(enabled=is_fixture_mode()) }}
-- Ground truth: the acquisition channel derived from click ids and UTMs, the signup time, the
-- country and both experiment arms match the generator for every cohort user.
select
    t.user_id,
    t.channel,
    a.acquisition_channel,
    t.signup_at,
    p.signup_at as warehouse_signup_at,
    t.arm_create_image,
    xi.arm as warehouse_arm_image,
    t.arm_create_video,
    xv.arm as warehouse_arm_video
from {{ source('synthetic', 'cohort_truth') }} as t
left join {{ ref('int_user__acquisition') }} as a on a.user_id = t.user_id
left join {{ ref('int_user__profile') }} as p on p.user_id = t.user_id
left join {{ ref('fct_experiment_exposures') }} as xi
    on xi.user_id = t.user_id and xi.flag_key = 'suite-default-model-create-image'
left join {{ ref('fct_experiment_exposures') }} as xv
    on xv.user_id = t.user_id and xv.flag_key = 'suite-default-model-create-video'
where coalesce(a.acquisition_channel, '') <> t.channel
   or p.signup_at is null or p.signup_at <> t.signup_at
   or coalesce(p.country, '') <> t.country
   or coalesce(xi.arm, '') <> t.arm_create_image
   or coalesce(xv.arm, '') <> t.arm_create_video
