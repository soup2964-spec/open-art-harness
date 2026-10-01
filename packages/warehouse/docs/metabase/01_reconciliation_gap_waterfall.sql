-- Metabase native question: "Reconciliation: gap waterfall (Stripe -> platform)"
-- Visualization: Waterfall. X = step_name (keep step_order sort), Y = value_usd. "Show total" ON:
-- the total bar equals what the platform reports. Add a second card with Y = conversions.
-- Variables:
--   @param platform      Text     default 'meta'            (google_ads, meta, tiktok, reddit, linkedin, x, microsoft)
--   @param report_layer  Text     default 'ads_attributed'  (tag_received = what the tag recorded; ads_attributed = what Ads Manager credits)
--   @param period_month  Date     optional                   (first day of a month; empty = all months summed)
-- Reads openart_signal_reporting.rpt_reconciliation. On the local fixture target the platform
-- numbers are SYNTHETIC (platform_data_origin = 'synthetic').
select
    step_order,
    step_name,
    step_group,
    sum(value_usd_delta) as value_usd,
    sum(conversions_delta) as conversions,
    max(platform_data_origin) as platform_data_origin
from openart_signal_reporting.rpt_reconciliation
where platform = {{platform}}
  and report_layer = {{report_layer}}
  -- the waterfall starts at Stripe truth; Metabase draws the platform-reported total itself
  and step_name not in ('modeled_platform_report', 'platform_reported')
  [[and period_month = {{period_month}}]]
group by step_order, step_name, step_group
order by step_order
