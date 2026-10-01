{{ config(enabled=is_fixture_mode()) }}
-- On the synthetic platform reports (scripts/make_platform_reports.py, an independent Python
-- implementation of today's platform behaviour) the modelled steps must explain every cent:
-- a non-zero residual means the SQL waterfall and the generator disagree on a rule.
select period_month, platform, report_layer, conversions_delta, value_usd_delta
from {{ ref('fct_reconciliation') }}
where step_name = 'residual'
  and (abs(conversions_delta) > 1e-9 or abs(value_usd_delta) > 0.005)
