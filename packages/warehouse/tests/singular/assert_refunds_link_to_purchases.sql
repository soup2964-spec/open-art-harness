{{ config(severity='warn') }}
-- Every refund and chargeback links to a purchase row of the same user in the ledger, and the
-- linked purchase is the one the charge paid for (same invoice when both are known).
-- Warn only: an unlinkable adjustment is data, not a pipeline bug; it is listed in
-- fct_data_quality_quarantine and must not stop the build (database review 2).
select
    a.event_id,
    a.event_name,
    a.adjusts_event_id,
    p.event_id as linked_purchase,
    p.event_name as linked_event_name
from {{ ref('fct_conversion_ledger') }} as a
left join {{ ref('fct_conversion_ledger') }} as p on p.event_id = a.adjusts_event_id
where a.event_name in ('refund', 'chargeback')
  and (
      a.adjusts_event_id is null
      or p.event_id is null
      or p.event_name not like 'purchase%'
      or p.order_id <> a.adjusts_order_id
      or coalesce(p.user_id, '') <> coalesce(a.user_id, '')
      or (a.invoice_id is not null and p.invoice_id is not null and a.invoice_id <> p.invoice_id)
      -- cannot take back more than the purchase paid
      or a.restated_order_value_minor < 0
  )
