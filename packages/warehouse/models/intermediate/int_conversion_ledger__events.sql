-- All canonical conversion events with their ids, before per-user enrichment (device, click
-- ids, UTMs, consent, experiment arms), which fct_conversion_ledger adds.
-- Event-id rules: contracts src/event-ids.ts (reg_/purchase_/sub_ reuse the browser's ids).

with plan_codes as (

    select distinct plan_tier, plan_tier_code
    from {{ ref('plan_catalog') }}
    where item_type = 'plan'

),

signups as (

    -- The trial grant (USER_SIGNUP_TRIAL ADD) is the signup (integration-map §2.9) ...
    select *
    from (
        select
            user_id,
            created_at as occurred_at,
            'credit_ledger' as source_system,
            ledger_entry_id as source_event_id,
            row_number() over (partition by user_id order by created_at, ledger_entry_id) as grant_rank
        from {{ ref('stg_app__credit_ledger') }}
        where entry_type = 'ADD' and business_type = 'USER_SIGNUP_TRIAL'
    ) as ranked
    where grant_rank = 1

    union all

    -- ... and an app account without a trial grant still signed up (app backend source).
    select
        u.user_id,
        u.account_created_at as occurred_at,
        'app_backend' as source_system,
        u.user_id as source_event_id,
        1 as grant_rank
    from {{ ref('stg_app__users') }} as u
    where u.account_created_at is not null
      -- NOT EXISTS, not NOT IN: one NULL user id in the ledger would make NOT IN return nothing
      and not exists (
          select 1 from {{ ref('stg_app__credit_ledger') }} as l
          where l.user_id = u.user_id
            and l.entry_type = 'ADD' and l.business_type = 'USER_SIGNUP_TRIAL'
      )

),

activations as (

    -- The first generation debit (CONSUME) per user.
    select *
    from (
        select
            user_id,
            created_at as occurred_at,
            ledger_entry_id as source_event_id,
            business_type,
            model_id,
            -amount as credits,
            row_number() over (partition by user_id order by created_at, ledger_entry_id) as generation_rank
        from {{ ref('stg_app__credit_ledger') }}
        where is_generation
    ) as ranked
    where generation_rank = 1

),

checkouts as (

    -- Amplitude subscription_started = checkout intent. The Checkout Session does not exist
    -- yet when it fires, so the id is the Amplitude uuid (stable at event time).
    select
        a.event_uuid,
        a.event_time as occurred_at,
        a.user_id,
        case when lower(a.ep_subscription_tier) in ('essential', 'advanced', 'infinite', 'wonder', 'team', 'business')
             then lower(a.ep_subscription_tier) end as plan_tier,
        case when a.ep_subscription_interval in ('month', 'year') then a.ep_subscription_interval end as billing_interval
    from {{ ref('stg_amplitude__events') }} as a
    where a.event_type = 'subscription_started'
      and {{ amplitude_history_filter('a') }}

),

lead_click_ids as (

    select
        conversion_id,
        {{ json_object_agg('click_id_key', "json_object('value', click_id_value, 'created_at', null)") }} as click_ids
    from (
        select conversion_id, 'gclid' as click_id_key, gclid as click_id_value from {{ ref('stg_hubspot__form_submissions') }} where gclid is not null
        union all
        select conversion_id, 'gbraid', gbraid from {{ ref('stg_hubspot__form_submissions') }} where gbraid is not null
        union all
        select conversion_id, 'wbraid', wbraid from {{ ref('stg_hubspot__form_submissions') }} where wbraid is not null
    ) as form_click_ids
    group by conversion_id

),

stage_changes as (

    select
        c.*,
        lag(c.lifecycle_stage) over (partition by c.contact_id order by c.occurred_at, c.hubspot_event_id) as previous_lifecycle_stage,
        row_number() over (partition by c.contact_id, c.lifecycle_stage order by c.occurred_at, c.hubspot_event_id) as stage_rank
    from {{ ref('stg_hubspot__lifecycle_changes') }} as c

),

unioned as (

    select
        'reg_' || s.user_id as event_id,
        'signup' as event_name,
        s.occurred_at,
        s.source_system,
        s.source_event_id,
        s.user_id,
        cast(null as {{ dbt.type_string() }}) as order_id,
        cast(null as {{ dbt.type_string() }}) as adjusts_event_id,
        cast(null as {{ dbt.type_string() }}) as adjusts_order_id,
        cast(null as {{ dbt.type_int() }}) as cash_value_minor,
        cast(null as {{ dbt.type_string() }}) as currency,
        cast(null as {{ dbt.type_string() }}) as invoice_id,
        cast(null as {{ dbt.type_string() }}) as subscription_id,
        cast(null as {{ dbt.type_string() }}) as checkout_session_id,
        cast(null as {{ dbt.type_string() }}) as charge_id,
        cast(null as {{ dbt.type_string() }}) as plan_tier,
        cast(null as {{ dbt.type_int() }}) as plan_tier_code,
        cast(null as {{ dbt.type_string() }}) as billing_interval,
        cast(null as {{ dbt.type_string() }}) as previous_plan_tier,
        cast(null as {{ dbt.type_int() }}) as credit_pack_quantity,
        cast(null as {{ dbt.type_boolean() }}) as is_first_purchase,
        cast(null as {{ dbt.type_boolean() }}) as is_business,
        {{ json_null() }} as generation,
        {{ json_null() }} as lead,
        {{ json_null() }} as lead_click_ids,
        cast(null as {{ dbt.type_string() }}) as ga_client_id,
        cast(null as {{ dbt.type_string() }}) as ga_session_id,
        cast(null as {{ dbt.type_string() }}) as tolt_referral,
        cast(null as {{ dbt.type_int() }}) as restated_order_value_minor,
        cast(null as {{ dbt.type_string() }}) as classification_rule,
        cast(null as {{ type_double() }}) as cash_value_reporting,
        cast(null as {{ type_double() }}) as revenue_reporting
    from signups as s

    union all

    select
        'activation_' || a.user_id,
        'activation_first_generation',
        a.occurred_at,
        'credit_ledger',
        a.source_event_id,
        a.user_id,
        null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
        json_object('business_type', a.business_type, 'model_id', a.model_id, 'credits', a.credits),
        {{ json_null() }},
        {{ json_null() }},
        null, null, null, null, null,
        null, null
    from activations as a

    union all

    select
        'checkout_' || c.event_uuid,
        'checkout_started',
        c.occurred_at,
        'amplitude',
        c.event_uuid,
        c.user_id,
        null, null, null, null, null, null, null, null, null,
        c.plan_tier,
        pc.plan_tier_code,
        c.billing_interval,
        null, null, null, null,
        {{ json_null() }},
        {{ json_null() }},
        {{ json_null() }},
        null, null, null, null, null,
        null, null
    from checkouts as c
    left join plan_codes as pc on pc.plan_tier = c.plan_tier

    union all

    select
        p.event_id,
        p.event_name,
        p.occurred_at,
        'stripe',
        p.source_event_id,
        p.user_id,
        p.order_id,
        null,
        null,
        p.cash_value_minor,
        p.currency,
        p.invoice_id,
        p.subscription_id,
        p.checkout_session_id,
        p.charge_id,
        p.plan_tier,
        p.plan_tier_code,
        p.billing_interval,
        p.previous_plan_tier,
        p.credit_pack_quantity,
        p.is_first_purchase,
        p.is_business,
        {{ json_null() }},
        {{ json_null() }},
        {{ json_null() }},
        p.ga_client_id,
        p.ga_session_id,
        p.tolt_referral,
        null,
        p.classification_rule,
        p.cash_value_reporting,
        p.revenue_reporting
    from {{ ref('int_stripe__purchases') }} as p
    where p.event_name is not null

    union all

    select
        a.event_id,
        a.event_name,
        a.occurred_at,
        'stripe',
        a.source_event_id,
        a.user_id,
        null,
        a.adjusts_event_id,
        a.adjusts_order_id,
        a.ledger_cash_value_minor,
        a.currency,
        a.invoice_id,
        a.subscription_id,
        null,
        a.charge_id,
        a.plan_tier,
        a.plan_tier_code,
        a.billing_interval,
        null, null, null, null,
        {{ json_null() }},
        {{ json_null() }},
        {{ json_null() }},
        null, null, null,
        a.restated_order_value_minor,
        null,
        a.cash_value_reporting,
        a.revenue_reporting
    from {{ ref('int_stripe__adjustments') }} as a
    -- disputes that took nothing (won, inquiries, after a full refund) are not ledger events
    where a.is_ledger_event

    union all

    select
        'lead_' || f.conversion_id,
        'enterprise_lead',
        f.submitted_at,
        'hubspot',
        f.conversion_id,
        null,
        null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
        {{ json_null() }},
        json_object(
            'hubspot_portal_id', f.portal_id,
            'form_id', f.form_guid,
            'contact_id', cast(null as {{ dbt.type_string() }}),
            'lifecycle_stage', cast(null as {{ dbt.type_string() }}),
            'previous_lifecycle_stage', cast(null as {{ dbt.type_string() }}),
            'lead_source', f.lead_source,
            'lead_source_detail', f.lead_source_detail,
            'company_size', f.company_size
        ),
        lc.click_ids,
        null, null, null, null, null,
        null, null
    from {{ ref('stg_hubspot__form_submissions') }} as f
    left join lead_click_ids as lc on lc.conversion_id = f.conversion_id

    union all

    select
        'leadstage_' || s.contact_id || '_' || s.lifecycle_stage,
        'lead_stage_change',
        s.occurred_at,
        'hubspot',
        s.hubspot_event_id,
        null,
        null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
        {{ json_null() }},
        json_object(
            'hubspot_portal_id', s.portal_id,
            'form_id', cast(null as {{ dbt.type_string() }}),
            'contact_id', s.contact_id,
            'lifecycle_stage', s.lifecycle_stage,
            'previous_lifecycle_stage', s.previous_lifecycle_stage,
            'lead_source', cast(null as {{ dbt.type_string() }}),
            'lead_source_detail', cast(null as {{ dbt.type_string() }}),
            'company_size', cast(null as {{ dbt.type_string() }})
        ),
        {{ json_null() }},
        null, null, null, null, null,
        null, null
    from stage_changes as s
    where s.stage_rank = 1

)

select * from unioned
