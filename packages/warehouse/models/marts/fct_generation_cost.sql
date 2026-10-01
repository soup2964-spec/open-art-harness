{{
  config(
    partition_by={'field': 'created_at', 'data_type': 'timestamp', 'granularity': 'day'} if target.type == 'bigquery' else none,
    cluster_by=['user_id', 'business_type'] if target.type == 'bigquery' else none
  )
}}
-- Serving cost of every generation: ledger CONSUME lines x vendor list price
-- (contracts seeds/model_costs.csv via int_model_costs__priced), matched on
-- (capability id, credits per unit).
--
-- cost_basis, in order of precedence:
--   override_setting / override_capability  seeds/generation_cost_overrides.csv: realised
--                                            per-route unit cost, cost per credit or discount (dated)
--   exact_setting                            list price of the setting whose credits match
--   unlimited_original_credits               "Unlimited" promo (unitCredits 0): the vendor still
--                                            bills, so cost the setting of originalUnitCredits
--   unlimited_cheapest_setting               ... or, without it, the cheapest setting (lower bound)
--   capability_mean_per_credit               known capability, unknown setting
--   default_per_credit                       unknown capability: var default_cost_per_credit_usd
-- List-based costs are reduced by the vendor discount (vars vendor_discounts, vendor_discount_pct).
-- Failed generations whose credits were refunded cost var failed_generation_cost_share of it.

with generations as (

    select
        d.ledger_entry_id,
        d.detail_position,
        l.user_id,
        l.created_at,
        l.business_type,
        case
            when {{ regexp_like('d.sub_business_type', '^[A-Za-z0-9.-]+:[A-Za-z0-9-]+$') }} then d.sub_business_type
            else l.business_type
        end as cost_business_type,
        l.model_id,
        l.generation_mode,
        l.media_type,
        l.credit_field,
        l.business_id as history_id,
        d.generation_source,
        d.quantity,
        d.unit_credits,
        d.original_unit_credits,
        d.discount_pct as credit_discount_pct,
        case
            when d.unit_credits > 0 then d.unit_credits
            when d.original_unit_credits > 0 then d.original_unit_credits
        end as costed_unit_credits
    from {{ ref('stg_app__credit_ledger_details') }} as d
    inner join {{ ref('stg_app__credit_ledger') }} as l on l.ledger_entry_id = d.ledger_entry_id
    where l.is_generation

),

failed as (

    -- A failed generation's credits come back as a REFUND referencing the same capability id
    -- and history id (contracts builders/ledger.ts refundGeneration).
    select user_id, business_type, business_id, min(created_at) as refunded_at
    from {{ ref('stg_app__credit_ledger') }}
    where entry_type = 'REFUND'
    group by user_id, business_type, business_id

),

priced_settings as (

    select * from {{ ref('int_model_costs__priced') }}

),

capability_stats as (

    select
        business_type,
        avg(list_cost_per_credit_usd) as mean_list_cost_per_credit_usd,
        max(vendor) as vendor,
        max(vendor_discount_pct) as vendor_discount_pct
    from priced_settings
    group by business_type

),

exact_match as (

    select *
    from (
        select
            g.ledger_entry_id,
            g.detail_position,
            ps.setting,
            ps.list_cost_usd,
            ps.vendor,
            ps.vendor_discount_pct,
            count(*) over (partition by g.ledger_entry_id, g.detail_position) as matching_settings,
            row_number() over (
                partition by g.ledger_entry_id, g.detail_position
                order by ps.list_cost_usd desc, ps.setting
            ) as match_rank
        from generations as g
        inner join priced_settings as ps
            on ps.business_type = g.cost_business_type
           and ps.credits = g.costed_unit_credits
    ) as ranked
    where match_rank = 1

),

cheapest_setting as (

    select *
    from (
        select
            business_type,
            setting,
            list_cost_usd,
            vendor,
            vendor_discount_pct,
            row_number() over (partition by business_type order by credits, list_cost_usd, setting) as setting_rank
        from priced_settings
    ) as ranked
    where setting_rank = 1

),

override_match as (

    select *
    from (
        select
            g.ledger_entry_id,
            g.detail_position,
            o.override_id,
            o.setting as override_setting,
            o.route,
            o.vendor as override_vendor,
            o.unit_cost_usd,
            o.cost_per_credit_usd,
            o.discount_pct,
            row_number() over (
                partition by g.ledger_entry_id, g.detail_position
                -- a setting-specific override beats a capability-wide one; the latest start wins ties
                order by case when o.setting is not null then 0 else 1 end, o.valid_from desc, o.override_id
            ) as override_rank
        from generations as g
        left join exact_match as em
            on em.ledger_entry_id = g.ledger_entry_id and em.detail_position = g.detail_position
        inner join {{ ref('generation_cost_overrides') }} as o
            on o.business_type = g.cost_business_type
           and (o.setting is null or o.setting = em.setting)
           and (o.valid_from is null or o.valid_from <= cast(g.created_at as date))
           and (o.valid_to is null or o.valid_to >= cast(g.created_at as date))
    ) as ranked
    where override_rank = 1

),

priced as (

    select
        g.*,
        f.refunded_at,
        f.refunded_at is not null as is_failed_generation,
        coalesce(em.matching_settings, 0) as matching_settings,
        om.override_id,
        om.route,
        coalesce(om.override_vendor, em.vendor, cs.vendor, cst.vendor, 'unknown') as vendor,
        case
            when om.override_id is not null and om.override_setting is not null then 'override_setting'
            when om.override_id is not null then 'override_capability'
            when em.setting is not null and g.unit_credits > 0 then 'exact_setting'
            when em.setting is not null then 'unlimited_original_credits'
            when g.unit_credits = 0 and cs.business_type is not null then 'unlimited_cheapest_setting'
            when cst.business_type is not null then 'capability_mean_per_credit'
            else 'default_per_credit'
        end as cost_basis,
        coalesce(em.setting, case when g.unit_credits = 0 then cs.setting end) as setting,
        -- list price of ONE unit (asset) at the matched setting
        case
            when em.setting is not null then em.list_cost_usd
            when g.unit_credits = 0 and cs.business_type is not null then cs.list_cost_usd
            when cst.business_type is not null then cst.mean_list_cost_per_credit_usd * g.costed_unit_credits
            else {{ var('default_cost_per_credit_usd') }} * g.costed_unit_credits
        end as list_unit_cost_usd,
        cast(case
            when om.unit_cost_usd is not null or om.cost_per_credit_usd is not null then 0.0
            when om.discount_pct is not null then om.discount_pct
            else coalesce(em.vendor_discount_pct, cs.vendor_discount_pct, cst.vendor_discount_pct, {{ var('vendor_discount_pct') }})
        end as {{ type_double() }}) as discount_pct_applied,
        om.unit_cost_usd as override_unit_cost_usd,
        om.cost_per_credit_usd as override_cost_per_credit_usd
    from generations as g
    left join failed as f
        on f.user_id = g.user_id
       and f.business_type = g.business_type
       and f.business_id = g.history_id
    left join exact_match as em
        on em.ledger_entry_id = g.ledger_entry_id and em.detail_position = g.detail_position
    left join cheapest_setting as cs on cs.business_type = g.cost_business_type
    left join capability_stats as cst on cst.business_type = g.cost_business_type
    left join override_match as om
        on om.ledger_entry_id = g.ledger_entry_id and om.detail_position = g.detail_position

),

costed as (

    select
        p.*,
        cast(case when p.is_failed_generation then {{ var('failed_generation_cost_share') }} else 1.0 end as {{ type_double() }}) as billable_share
    from priced as p

)

select
    ledger_entry_id || ':' || cast(detail_position as {{ dbt.type_string() }}) as generation_id,
    ledger_entry_id,
    detail_position,
    user_id,
    created_at,
    business_type,
    cost_business_type,
    model_id,
    generation_mode,
    media_type,
    credit_field,
    generation_source,
    quantity,
    unit_credits,
    original_unit_credits,
    credit_discount_pct,
    quantity * unit_credits as credits_charged,
    quantity * coalesce(costed_unit_credits, 0) as credits_costed,
    setting,
    matching_settings,
    cost_basis,
    vendor,
    route,
    override_id,
    round(list_unit_cost_usd, 6) as list_unit_cost_usd,
    round(coalesce(list_unit_cost_usd, 0) * quantity, 6) as list_cost_usd,
    discount_pct_applied,
    is_failed_generation,
    refunded_at,
    billable_share,
    round(
        case
            when override_unit_cost_usd is not null then override_unit_cost_usd * quantity
            when override_cost_per_credit_usd is not null then override_cost_per_credit_usd * quantity * coalesce(costed_unit_credits, 0)
            else coalesce(list_unit_cost_usd, 0) * quantity * (1 - discount_pct_applied)
        end * billable_share,
        6
    ) as cost_usd,
    {{ qa_account_flag('user_id') }} as is_qa_account
from costed
