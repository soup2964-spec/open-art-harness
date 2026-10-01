-- stripe_truth + every non-total step = platform_reported, per month, platform and layer;
-- and the modelled report equals truth + the modelled steps (so every gap has a named cause).
with steps as (select * from {{ ref('fct_reconciliation') }}),

sums as (

    select
        period_month,
        platform,
        report_layer,
        sum(case when step_name = 'stripe_truth' then conversions_delta else 0 end)
            + sum(case when not is_total then conversions_delta else 0 end) as closing_conversions,
        sum(case when step_name = 'stripe_truth' then value_usd_delta else 0 end)
            + sum(case when not is_total then value_usd_delta else 0 end) as closing_value,
        sum(case when step_name = 'platform_reported' then conversions_delta else 0 end) as reported_conversions,
        sum(case when step_name = 'platform_reported' then value_usd_delta else 0 end) as reported_value,
        sum(case when step_name = 'modeled_platform_report' then conversions_delta else 0 end) as modeled_conversions,
        sum(case when step_name = 'residual' then conversions_delta else 0 end) as residual_conversions,
        sum(case when step_name = 'platform_reported' then 1 else 0 end) as reported_rows
    from steps
    group by period_month, platform, report_layer

)

select *
from sums
where reported_rows <> 1
   or abs(closing_conversions - reported_conversions) > 1e-9
   or abs(closing_value - reported_value) > 0.02
   or abs(modeled_conversions + residual_conversions - reported_conversions) > 1e-9
