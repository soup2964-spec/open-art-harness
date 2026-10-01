{{ config(materialized='view') }}
-- BI view (aggregate only): quarantined records by issue and day (alert when excluded > 0).
select
    cast(coalesce(occurred_at, detected_as_of) as date) as issue_date,
    issue,
    severity,
    source_model,
    count(*) as records,
    sum(coalesce(money_minor, 0)) as money_minor,
    sum(ledger_cash_difference_minor) as ledger_cash_difference_minor
from {{ ref('fct_data_quality_quarantine') }}
group by cast(coalesce(occurred_at, detected_as_of) as date), issue, severity, source_model
