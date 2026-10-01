-- No negative value in any column that feeds a value sent to an ad platform (platforms reject
-- negative conversion values; Meta LOOKALIKE_VALUE must be >= 0).
select 'fct_conversion_ledger.cash_value_minor (purchases)' as feeding_column, event_id as row_key, cast(cash_value_minor as {{ type_double() }}) as value
from {{ ref('fct_conversion_ledger') }}
where event_name like 'purchase%' and (cash_value_minor < 0 or cash_value_minor is null)

union all
select 'fct_conversion_ledger.restated_order_value_minor (adjustments)', event_id, cast(restated_order_value_minor as {{ type_double() }})
from {{ ref('fct_conversion_ledger') }}
where event_name in ('refund', 'chargeback') and (restated_order_value_minor < 0 or restated_order_value_minor is null)

union all
select 'fct_purchase_value_score.platform_value', event_id, platform_value
from {{ ref('fct_purchase_value_score') }}
where platform_value < 0 or platform_value is null

union all
select 'fct_purchase_value_score.cash_value', event_id, cash_value
from {{ ref('fct_purchase_value_score') }}
where cash_value < 0 or cash_value is null

union all
select 'fct_predicted_profit_24h.predicted_revenue', user_id, predicted_revenue
from {{ ref('fct_predicted_profit_24h') }}
where predicted_revenue < 0

union all
select 'fct_audience_candidates.seed_value_usd', user_id, seed_value_usd
from {{ ref('fct_audience_candidates') }}
where candidate_role = 'seed' and (seed_value_usd < 0 or seed_value_usd is null)

union all
select 'int_reconciliation__purchase_platform.sent_value_usd', event_id || ':' || platform, sent_value_usd
from {{ ref('int_reconciliation__purchase_platform') }}
where sent_value_usd < 0
