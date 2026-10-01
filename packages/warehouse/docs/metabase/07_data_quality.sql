-- Metabase native question: "Data quality quarantine"
-- Visualization: Table; alert when any row has severity = 'excluded' (money the ledger left out).
-- @allow_empty  (no rows = nothing quarantined, which is what the fixture build shows)
-- Variables:
--   @param since  Date  optional
select
    issue_date,
    issue,
    severity,
    source_model,
    sum(records) as records,
    round(sum(money_minor) / 100.0, 2) as money_major_approx,
    sum(ledger_cash_difference_minor) as ledger_cash_difference_minor
from openart_signal_reporting.rpt_data_quality
where 1 = 1
  [[and issue_date >= {{since}}]]
group by issue_date, issue, severity, source_model
order by issue_date desc, records desc
