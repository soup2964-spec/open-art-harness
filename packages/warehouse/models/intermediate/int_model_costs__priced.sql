-- One row per priced (capability id, setting) of contracts seeds/model_costs.csv with the vendor
-- whose list price it uses and the negotiated discount the vars assign to that vendor.
-- Shared by fct_generation_cost (realised serving cost) and fct_predicted_profit_24h
-- (expected cost per credit of a default-model arm), so both use the same prices.
{%- set vendor_discounts = var('vendor_discounts') or {} %}

with costs as (

    select
        business_type,
        setting,
        credits,
        list_cost_usd,
        source_url,
        notes,
        case
            -- ESTIMATE rows cite a GPU price page; check them first.
            when source_url like 'ESTIMATE%' then 'self_hosted'
            when source_url like '%fal.ai%' then 'fal'
            when source_url like '%byteplus%' then 'byteplus'
            when source_url like '%ai.google.dev%' or source_url like '%cloud.google.com%' then 'google'
            when source_url like '%alibabacloud%' then 'alibaba'
            when source_url like '%openai%' then 'openai'
            when source_url like '%ltx.io%' then 'lightricks'
            else 'unknown'
        end as vendor
    from {{ ref('model_costs') }}
    where list_cost_usd is not null
      and credits > 0

)

select
    business_type,
    setting,
    credits,
    list_cost_usd,
    list_cost_usd / credits as list_cost_per_credit_usd,
    vendor,
    cast(
    {% if vendor_discounts | length > 0 -%}
    case vendor
        {% for vendor, pct in vendor_discounts.items() -%}
        when '{{ vendor }}' then {{ pct }}
        {% endfor -%}
        else {{ var('vendor_discount_pct') }}
    end
    {%- else -%}
    {{ var('vendor_discount_pct') }}
    {%- endif %} as {{ type_double() }}) as vendor_discount_pct,
    source_url,
    notes
from costs
