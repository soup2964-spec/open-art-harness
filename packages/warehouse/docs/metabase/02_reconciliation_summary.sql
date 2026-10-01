-- Metabase native question: "Reconciliation: Stripe vs warehouse vs platform, by platform"
-- Visualization: Table (conditional formatting on gap_vs_stripe_pct), or grouped bar of the three
-- value columns by platform.
-- Variables:
--   @param report_layer  Text  default 'ads_attributed'
--   @param period_month  Date  optional
with steps as (

    select *
    from openart_signal_reporting.rpt_reconciliation
    where report_layer = {{report_layer}}
      [[and period_month = {{period_month}}]]

)

select
    platform,
    sum(case when step_name = 'stripe_truth' then conversions_delta else 0 end) as stripe_purchases,
    round(sum(case when step_name = 'stripe_truth' then value_usd_delta else 0 end), 2) as stripe_net_usd,
    round(sum(case when step_name in ('stripe_truth', 'warehouse_vs_stripe') then value_usd_delta else 0 end), 2) as warehouse_net_usd,
    sum(case when step_name = 'platform_reported' then conversions_delta else 0 end) as platform_conversions,
    round(sum(case when step_name = 'platform_reported' then value_usd_delta else 0 end), 2) as platform_value_usd,
    round(
        100.0 * (sum(case when step_name = 'platform_reported' then value_usd_delta else 0 end)
                 - sum(case when step_name = 'stripe_truth' then value_usd_delta else 0 end))
        / nullif(sum(case when step_name = 'stripe_truth' then value_usd_delta else 0 end), 0),
        1
    ) as gap_vs_stripe_pct,
    round(sum(case when step_name = 'residual' then value_usd_delta else 0 end), 2) as unexplained_usd,
    max(platform_data_origin) as platform_data_origin
from steps
group by platform
order by platform
