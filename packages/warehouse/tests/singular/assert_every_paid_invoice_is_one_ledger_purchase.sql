-- Completeness: every paid invoice with money in, and every paid payment-mode Checkout, is
-- exactly one purchase row in the ledger, with the same amount.
with money_in as (

    select 'purchase_' || invoice_id as expected_event_id, amount_paid_minor as amount_minor
    from {{ ref('stg_stripe__invoices') }}
    where invoice_status = 'paid' and amount_paid_minor > 0
      and invoice_id not in (
          select invoice_id from {{ ref('stg_stripe__checkout_sessions') }}
          where checkout_mode = 'payment' and invoice_id is not null
      )
    union all
    select 'purchase_' || coalesce(invoice_id, checkout_session_id), amount_total_minor
    from {{ ref('stg_stripe__checkout_sessions') }}
    where checkout_mode = 'payment' and payment_status = 'paid' and amount_total_minor > 0

),

ledger as (

    select event_id, cash_value_minor, count(*) over (partition by event_id) as copies
    from {{ ref('fct_conversion_ledger') }}
    where event_name like 'purchase%'

)

select m.expected_event_id, m.amount_minor, l.cash_value_minor, l.copies
from money_in as m
full outer join ledger as l on l.event_id = m.expected_event_id
where l.event_id is null
   or m.expected_event_id is null
   or l.copies <> 1
   or l.cash_value_minor <> m.amount_minor
