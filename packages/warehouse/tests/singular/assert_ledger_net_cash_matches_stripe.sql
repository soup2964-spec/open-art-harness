-- SUM(cash_value_minor) over the ledger reconciles to what Stripe moved (the contract's promise),
-- record by record differences accounted for in fct_data_quality_quarantine:
--   Stripe net  = money in (paid invoices + payment-mode Checkouts) - refund steps
--                 - disputes whose funds are lost (open or lost; won ones were reinstated)
--   ledger net  = Stripe net + sum(quarantine.ledger_cash_difference_minor)
-- (an unclassified purchase is left out of the ledger; a dispute takes only what refunds left).
with stripe_net as (

    select
        (select coalesce(sum(amount_paid_minor), 0) from {{ ref('stg_stripe__invoices') }}
          where invoice_status = 'paid' and amount_paid_minor > 0)
      + (select coalesce(sum(amount_total_minor), 0) from {{ ref('stg_stripe__checkout_sessions') }}
          where checkout_mode = 'payment' and payment_status = 'paid' and invoice_id is null)
      - (select coalesce(sum(refund_step_minor), 0) from {{ ref('stg_stripe__refunds') }})
      - (select coalesce(sum(amount_minor), 0) from {{ ref('stg_stripe__disputes') }} where is_money_lost) as net_minor

),

ledger_net as (

    select coalesce(sum(cash_value_minor), 0) as net_minor
    from {{ ref('fct_conversion_ledger') }}

),

accounted as (

    select coalesce(sum(ledger_cash_difference_minor), 0) as difference_minor
    from {{ ref('fct_data_quality_quarantine') }}

)

select s.net_minor as stripe_net_minor, l.net_minor as ledger_net_minor, a.difference_minor
from stripe_net as s
cross join ledger_net as l
cross join accounted as a
where l.net_minor <> s.net_minor + a.difference_minor
