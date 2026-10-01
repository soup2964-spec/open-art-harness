{{ config(materialized='view') }}
-- BI view (aggregate only): the per-arm experiment readout, unchanged.
select * from {{ ref('fct_experiment_profit_by_arm') }}
