-- Metabase native question: "Default-model experiment: profit vs conversion by arm"
-- Visualization: Table, plus a bar chart of predicted_profit_per_exposed_usd by arm with the CI
-- columns (sampling + cross-fitted model error) as a range. Rows where conversion_rank <>
-- predicted_profit_rank are the arms a conversion-only readout would rank wrongly. Realised
-- profit is over a fixed 90-day horizon for matured users only (share_matured).
-- Variables:
--   @param flag_key  Text  optional  (suite-default-model-create-image | suite-default-model-create-video)
select
    flag_key,
    arm,
    exposed_users,
    converters,
    round(100 * conversion_rate, 2) as conversion_rate_pct,
    round(100 * conversion_rate_ci_low, 2) as conversion_rate_ci_low_pct,
    round(100 * conversion_rate_ci_high, 2) as conversion_rate_ci_high_pct,
    round(revenue_per_exposed_usd, 2) as revenue_per_exposed_usd,
    round(generation_cost_per_exposed_usd, 3) as generation_cost_per_exposed_usd,
    matured_users,
    contaminated_users,
    round(realised_profit_per_exposed_usd, 2) as realised_profit_per_exposed_usd,
    round(realised_profit_ci_low, 2) as realised_profit_ci_low,
    round(realised_profit_ci_high, 2) as realised_profit_ci_high,
    round(predicted_profit_per_exposed_usd, 2) as predicted_profit_per_exposed_usd,
    round(predicted_profit_ci_low, 2) as predicted_profit_ci_low,
    round(predicted_profit_ci_high, 2) as predicted_profit_ci_high,
    round(model_error_se_usd, 2) as model_error_se_usd,
    round(ppi_profit_per_exposed_usd, 2) as ppi_profit_per_exposed_usd,
    round(predicted_profit_24h_signals_only_per_exposed_usd, 2) as predicted_24h_signals_only_usd,
    round(predicted_profit_with_arm_terms_per_exposed_usd, 2) as predicted_with_arm_terms_usd,
    conversion_rank,
    predicted_profit_rank,
    realised_profit_rank,
    conversion_and_profit_rank_agree,
    round(profit_left_by_conversion_ranking_usd, 2) as profit_left_by_conversion_ranking_usd,
    share_matured
from openart_signal_reporting.rpt_experiment_profit_by_arm
where 1 = 1
  [[and flag_key = {{flag_key}}]]
order by flag_key, predicted_profit_rank, arm
