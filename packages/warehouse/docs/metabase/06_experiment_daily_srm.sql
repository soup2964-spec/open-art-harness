-- Metabase native question: "Default-model experiment: daily first exposures per arm and slice"
-- Visualization: Line, X = exposure_date, Y = exposed_users, series = arm; filter allocation_slice
-- = 'holdout' to eyeball the sample-ratio mismatch the bandit-allocator tests formally.
-- Variables:
--   @param flag_key          Text  default 'suite-default-model-create-image'
--   @param allocation_slice  Text  optional  (holdout | bandit)
select
    exposure_date,
    arm,
    allocation_slice,
    exposed_users,
    scored_users,
    contaminated_users,
    matured_users,
    round(predicted_profit_per_scored_usd, 2) as predicted_profit_per_scored_usd,
    round(realised_profit_per_matured_usd, 2) as realised_profit_per_matured_usd
from openart_signal_reporting.rpt_experiment_profit_daily
where flag_key = {{flag_key}}
  [[and allocation_slice = {{allocation_slice}}]]
order by exposure_date, arm, allocation_slice
