-- event_id / order_id formats per contract (contracts src/event-ids.ts and the allOf rules of
-- conversion-ledger-event.schema.json), including the cross-field invariants JSON Schema
-- cannot express (validators.ts ledgerIssues). One row per violation.
with l as (select * from {{ ref('fct_conversion_ledger') }}),

violations as (

    select event_id, 'signup event_id must be reg_<user_id>' as violation
    from l where event_name = 'signup' and (user_id is null or event_id <> 'reg_' || user_id)

    union all
    select event_id, 'activation event_id must be activation_<user_id>'
    from l where event_name = 'activation_first_generation' and (user_id is null or event_id <> 'activation_' || user_id)

    union all
    select event_id, 'checkout_started event_id must be checkout_<cs id or Amplitude uuid>'
    from l where event_name = 'checkout_started' and not {{ regexp_like('event_id', '^checkout_\\S+$') }}

    union all
    select event_id, 'purchase event_id must be purchase_<invoiceId|checkoutSessionId>'
    from l where event_name like 'purchase%'
      and not {{ regexp_like('event_id', '^purchase_(in_[A-Za-z0-9]+|cs_(live|test)_[A-Za-z0-9]+)$') }}

    union all
    select event_id, 'order_id must be sub_<the same id as event_id>'
    from l where event_name like 'purchase%'
      and (order_id is null or substr(order_id, 5) <> substr(event_id, 10))

    union all
    select event_id, 'event_id must use invoice_id when an invoice exists'
    from l where event_name like 'purchase%' and invoice_id is not null and event_id <> 'purchase_' || invoice_id

    union all
    select event_id, 'refund event_id must be refund_<charge_id>_<positive cumulative amount>'
    from l where event_name = 'refund'
      and (charge_id is null
           or not {{ regexp_like('event_id', '^refund_(ch|py)_[A-Za-z0-9]+_[1-9][0-9]*$') }}
           or substr(event_id, 1, length('refund_' || charge_id || '_')) <> 'refund_' || charge_id || '_')

    union all
    select event_id, 'chargeback event_id must be chargeback_<disputeId>'
    from l where event_name = 'chargeback' and not {{ regexp_like('event_id', '^chargeback_\\S+$') }}

    union all
    select event_id, 'enterprise_lead event_id must be lead_<conversionId>'
    from l where event_name = 'enterprise_lead' and not {{ regexp_like('event_id', '^lead_\\S+$') }}

    union all
    select event_id, 'lead_stage_change event_id must be leadstage_<contactId>_<stage>'
    from l where event_name = 'lead_stage_change'
      and event_id <> 'leadstage_' || {{ json_str('lead', '$.contact_id') }} || '_' || {{ json_str('lead', '$.lifecycle_stage') }}

    union all
    select event_id, 'only purchases carry an order_id'
    from l where event_name not like 'purchase%' and order_id is not null

)

select * from violations
