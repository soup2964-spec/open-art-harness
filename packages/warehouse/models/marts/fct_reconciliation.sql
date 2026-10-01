-- Stripe truth vs warehouse vs platform-reported purchases, per month and ad platform, as an
-- additive waterfall: every step is the change in (conversions, value) from applying one more
-- platform behaviour to the purchases, so
--     stripe_truth + sum(step deltas) = platform_reported      (exactly, by construction)
-- and `residual` is whatever the modelled behaviours do not explain.
--
-- Two layers per platform:
--   tag_received    what the platform's tag/pixel recorded (Events Manager / tag diagnostics)
--   ads_attributed  what the platform credits to its ads (Ads Manager / GAQL), which adds the
--                   attribution steps
-- Steps (research/08 §5.6 discrepancy checklist; platform rules in seeds/platform_reporting_rules.csv):
--   stripe_truth                 money-in from raw Stripe, net of refunds/disputes, by UTC purchase month
--   warehouse_vs_stripe          fct_conversion_ledger minus Stripe truth: pipeline defects (expect 0)
--   refunds_not_netted           platforms keep gross value; nobody sends retractions today
--   out_of_scope_purchase_types  renewals, upgrades, add-ons and packs never reach a tag; Meta/TikTok
--                                count the first valid purchase only
--   blocked_users                purchasers whose browser tags never ran (proxy: no Amplitude events)
--   double_counting              Google: both accounts count the same oid; X: tw-qwghh-13vj24 + gtm_purchase
--   ltv_in_value                 Meta/TikTok value = ltvValueMajor, not cash
--   value_not_sent               LinkedIn receives no value
--   fallback_misvaluation        failed invoice lookup: stale list price and unstable id (Google, Reddit,
--                                X, UET), or no event at all (Meta, TikTok)
--   time_zone                    months cut in the ad account's time zone instead of UTC
--   unattributed_users           purchasers with no click id from this platform
--   attribution_window           purchases outside the platform's click-through window
--   click_vs_conversion_date     platforms that report on the click date (Google) move purchases between months
-- On the local target the platform reports are SYNTHETIC (scripts/make_platform_reports.py).

with {#- (order, name, group, layers, conversions delta, value delta, is_total) -#}
{%- set common_steps = [
    (1, 'stripe_truth', 'source', 'truth_n', 'truth_v', true),
    (2, 'warehouse_vs_stripe', 'pipeline', 'w_n - truth_n', 'w_v - truth_v', false),
    (3, 'refunds_not_netted', 'valuation', '0', 'gross_v - w_v', false),
    (4, 'out_of_scope_purchase_types', 'definition', 'scope_n - w_n', 'scope_v - gross_v', false),
    (5, 'blocked_users', 'delivery', 'sent_n - scope_n', 'sent_v - scope_v', false),
    (6, 'double_counting', 'counting', 'counted_n - sent_n', 'counted_v - sent_v', false),
    (7, 'ltv_in_value', 'valuation', '0', "case when value_rule = 'ltv_else_amount' then valued_v - counted_v else 0 end", false),
    (8, 'value_not_sent', 'valuation', '0', "case when value_rule = 'none' then valued_v - counted_v else 0 end", false),
    (9, 'fallback_misvaluation', 'valuation', 'delivered_n - counted_n', 'delivered_v - valued_v', false),
    (10, 'time_zone', 'reporting', 'tag_n - delivered_n', 'tag_v - delivered_v', false),
] -%}
{%- set tag_steps = [
    (11, 'modeled_platform_report', 'total', 'tag_n', 'tag_v', true),
    (12, 'residual', 'residual', 'actual_tag_n - tag_n', 'actual_tag_v - tag_v', false),
    (13, 'platform_reported', 'total', 'actual_tag_n', 'actual_tag_v', true),
] -%}
{%- set ads_steps = [
    (11, 'unattributed_users', 'attribution', 'attributed_n - tag_n', 'attributed_v - tag_v', false),
    (12, 'attribution_window', 'attribution', 'window_n - attributed_n', 'window_v - attributed_v', false),
    (13, 'click_vs_conversion_date', 'reporting', 'ads_n - window_n', 'ads_v - window_v', false),
    (14, 'modeled_platform_report', 'total', 'ads_n', 'ads_v', true),
    (15, 'residual', 'residual', 'actual_ads_n - ads_n', 'actual_ads_v - ads_v', false),
    (16, 'platform_reported', 'total', 'actual_ads_n', 'actual_ads_v', true),
] %}
steps as (

    {% set branches = [] -%}
    {%- for layer, extra in [('tag_received', tag_steps), ('ads_attributed', ads_steps)] -%}
    {%- for s in common_steps + extra -%}
    {%- do branches.append((layer, s)) -%}
    {%- endfor -%}
    {%- endfor -%}
    {% for layer, s in branches %}
    select
        period_month,
        platform,
        '{{ layer }}' as report_layer,
        {{ s[0] }} as step_order,
        '{{ s[1] }}' as step_name,
        '{{ s[2] }}' as step_group,
        {{ 'true' if s[5] else 'false' }} as is_total,
        cast({{ s[3] }} as {{ type_double() }}) as conversions_delta,
        -- full precision: round in BI only (per-step cent rounding broke the closing identity)
        cast({{ s[4] }} as {{ type_double() }}) as value_usd_delta,
        platform_data_origin
    from {{ ref('int_reconciliation__wide') }}
    {% if not loop.last %}union all{% endif %}
    {% endfor %}

)

select
    s.period_month,
    s.platform,
    s.report_layer,
    s.step_order,
    s.step_name,
    s.step_group,
    s.is_total,
    s.conversions_delta,
    s.value_usd_delta,
    -- running position of the waterfall after this step (totals show their own level)
    case
        when s.is_total then s.conversions_delta
        else sum(case when s.is_total and s.step_name <> 'stripe_truth' then 0 else s.conversions_delta end) over (
            partition by s.period_month, s.platform, s.report_layer
            order by s.step_order
            rows between unbounded preceding and current row
        )
    end as conversions_running,
    case
        when s.is_total then s.value_usd_delta
        else sum(case when s.is_total and s.step_name <> 'stripe_truth' then 0 else s.value_usd_delta end) over (
            partition by s.period_month, s.platform, s.report_layer
            order by s.step_order
            rows between unbounded preceding and current row
        )
    end as value_usd_running,
    coalesce(s.platform_data_origin, 'none') as platform_data_origin
from steps as s
