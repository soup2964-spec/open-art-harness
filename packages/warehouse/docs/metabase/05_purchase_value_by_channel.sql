-- Metabase native question: "Purchase value (the ad value) by acquisition channel and month"
-- Visualization: Stacked bar, X = purchase_month, Y = platform_value, series = acquisition_channel;
-- second card: Table of purchases, cash vs predicted 90-day profit and the mean interval width.
-- fct_purchase_value_score is E[90-day gross profit | purchase], scored at the purchase
-- (model_version on every row); platform_value = max(profit, 0) is what may be sent to ad platforms.
-- Variables:
--   @param model_version  Text  optional
select
    purchase_month,
    acquisition_channel,
    purchase_kind,
    sum(purchases) as purchases,
    round(sum(cash_value), 2) as cash_value_usd,
    round(sum(predicted_profit_90d), 2) as predicted_profit_90d_usd,
    round(sum(platform_value), 2) as platform_value_usd,
    round(sum(predicted_profit_90d) / nullif(sum(purchases), 0), 2) as mean_predicted_profit_90d_usd,
    round(sum(mean_interval_width * purchases) / nullif(sum(purchases), 0), 2) as mean_interval_width_usd,
    sum(negative_value_purchases) as negative_value_purchases
from openart_signal_reporting.rpt_purchase_value_by_channel_month
where 1 = 1
  [[and model_version = {{model_version}}]]
group by purchase_month, acquisition_channel, purchase_kind
order by purchase_month, acquisition_channel, purchase_kind
