-- One row per known user id (ledger, Stripe, Amplitude, app users, click-id store).
-- signup_at: the trial grant (USER_SIGNUP_TRIAL ADD, the canonical signup), else the account
-- creation time. has_amplitude_events = FALSE is the blocker proxy (research/01 §6 item 3).
-- Country and device are the FIRST values Amplitude recorded (int_amplitude__user_first_seen,
-- which also says when each became known, for point-in-time features).
with ids as (

    select user_id from {{ ref('stg_app__credit_ledger') }} where user_id is not null
    union distinct
    select user_id from {{ ref('stg_stripe__invoices') }} where user_id is not null
    union distinct
    select user_id from {{ ref('stg_stripe__checkout_sessions') }} where user_id is not null
    union distinct
    select user_id from {{ ref('int_amplitude__user_first_seen') }}
    union distinct
    select user_id from {{ ref('stg_app__users') }} where user_id is not null
    union distinct
    select user_id from {{ ref('stg_app__ad_click_id_posts') }} where user_id is not null

),

trial_grant as (

    select user_id, min(created_at) as trial_granted_at
    from {{ ref('stg_app__credit_ledger') }}
    where entry_type = 'ADD' and business_type = 'USER_SIGNUP_TRIAL'
    group by user_id

)

select
    ids.user_id,
    coalesce(tg.trial_granted_at, u.account_created_at) as signup_at,
    case
        when tg.trial_granted_at is not null then 'credit_ledger_trial_grant'
        when u.account_created_at is not null then 'app_account_created_at'
    end as signup_source,
    u.auth_provider,
    fs.first_event_at as first_amplitude_event_at,
    coalesce(fs.amplitude_events, 0) as amplitude_events,
    coalesce(fs.amplitude_events, 0) > 0 as has_amplitude_events,
    fs.first_device_id,
    fs.first_country as country,
    fs.first_country_at as country_known_at,
    cc.iso2 as country_code,
    cc.is_eea_uk_ch,
    fs.first_device_class as device_class,
    fs.first_device_class_at as device_known_at,
    fs.first_device_type as device_type,
    fs.first_os_name as os_name,
    fs.first_platform as amplitude_platform,
    {{ qa_account_flag('ids.user_id') }} as is_qa_account
from ids
left join trial_grant as tg on tg.user_id = ids.user_id
left join {{ ref('stg_app__users') }} as u on u.user_id = ids.user_id
left join {{ ref('int_amplitude__user_first_seen') }} as fs on fs.user_id = ids.user_id
left join {{ ref('country_codes') }} as cc on cc.country_name = fs.first_country
