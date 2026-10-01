-- Per-event field rules of the ConversionLedgerEvent contract (schema allOf + validators.ts).
with l as (select * from {{ ref('fct_conversion_ledger') }}),

violations as (

    select event_id, 'non-cash events carry no cash' as violation
    from l
    where event_name in ('signup', 'activation_first_generation', 'checkout_started', 'enterprise_lead', 'lead_stage_change')
      and cash_value_minor is not null

    union all
    select event_id, 'purchase cash_value_minor must be >= 0 and from Stripe with a user'
    from l where event_name like 'purchase%'
      and (cash_value_minor is null or cash_value_minor < 0 or source_system <> 'stripe' or user_id is null)

    union all
    select event_id, 'subscription purchases need invoice, subscription, plan tier and interval'
    from l where event_name in ('purchase_first', 'purchase_renewal', 'purchase_upgrade', 'purchase_add_on')
      and (invoice_id is null or subscription_id is null or plan_tier is null or billing_interval is null)

    union all
    select event_id, 'purchase_add_on needs credit_pack_quantity'
    from l where event_name = 'purchase_add_on' and credit_pack_quantity is null

    union all
    select event_id, 'refunds and chargebacks: negative cash from Stripe with a charge id, no order id of their own'
    from l where event_name in ('refund', 'chargeback')
      and (cash_value_minor is null or cash_value_minor >= 0 or source_system <> 'stripe' or charge_id is null or order_id is not null)

    union all
    select event_id, 'only refunds and chargebacks adjust a purchase'
    from l where event_name not in ('refund', 'chargeback')
      and (adjusts_event_id is not null or adjusts_order_id is not null)

    union all
    select event_id, 'adjusts_event_id and adjusts_order_id must reference the same purchase'
    from l
    where event_name in ('refund', 'chargeback')
      and (
          (adjusts_event_id is null) <> (adjusts_order_id is null)
          or (adjusts_event_id is not null and substr(adjusts_event_id, 10) <> substr(adjusts_order_id, 5))
      )

    union all
    select event_id, 'activation needs the generation object'
    from l where event_name = 'activation_first_generation'
      and (generation is null or {{ json_str('generation', '$.business_type') }} is null
           or {{ json_int('generation', '$.credits') }} is null or {{ json_int('generation', '$.credits') }} < 0)

    union all
    select event_id, 'lead events come from HubSpot with lead context (and a lifecycle stage for stage changes)'
    from l where event_name in ('enterprise_lead', 'lead_stage_change')
      and (source_system <> 'hubspot' or lead is null
           or (event_name = 'lead_stage_change' and {{ json_str('lead', '$.lifecycle_stage') }} is null))

    union all
    select event_id, 'signups, activations and purchases need a user'
    from l where event_name in ('signup', 'activation_first_generation') and user_id is null

    union all
    select event_id, 'consent region must be ISO 3166-1 alpha-2 (or NULL) and source none/cmp/regional_default'
    from l
    where not coalesce({{ regexp_like(json_str('consent', '$.region'), '^[A-Z]{2}(-[A-Z0-9]{1,3})?$') }}, true)
       or {{ json_str('consent', '$.source') }} not in ('cmp', 'regional_default', 'none')

)

select * from violations
