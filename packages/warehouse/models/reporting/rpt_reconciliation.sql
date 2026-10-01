{{ config(materialized='view') }}
-- BI view (aggregate only): the reconciliation waterfall, unchanged.
select * from {{ ref('fct_reconciliation') }}
