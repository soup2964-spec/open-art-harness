{{ config(materialized='view') }}
-- BI view (aggregate only): purchase values (the ad value) by month, channel and purchase kind.
select
    {{ month_start('cast(occurred_at as date)') }} as purchase_month,
    acquisition_channel,
    purchase_kind,
    model_version,
    count(*) as purchases,
    sum(cash_value) as cash_value,
    sum(revenue_value) as revenue_value,
    sum(predicted_profit_90d) as predicted_profit_90d,
    sum(platform_value) as platform_value,
    avg(predicted_profit_90d) as mean_predicted_profit_90d,
    avg(interval_high - interval_low) as mean_interval_width,
    sum(case when predicted_profit_90d < 0 then 1 else 0 end) as negative_value_purchases
from {{ ref('fct_purchase_value_score') }}
where not is_qa_account
group by {{ month_start('cast(occurred_at as date)') }}, acquisition_channel, purchase_kind, model_version
