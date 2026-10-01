-- One row per dispute, with its state as of the as-of instant (stg_stripe__events drops later
-- deliveries). charge.dispute.created withdraws the disputed amount; the dispute then moves
-- through charge.dispute.updated / funds_withdrawn / funds_reinstated / closed:
--   won (funds reinstated)      -> no money lost
--   lost / still open           -> the amount stays withdrawn
--   warning_* (an inquiry)      -> never a chargeback: no funds are withdrawn
{%- set dispute_types = ['charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated'] %}
with dispute_events as (

    select
        object_id as dispute_id,
        stripe_event_id,
        event_type,
        created_at,
        event_object as dp
    from {{ ref('stg_stripe__events') }}
    where event_type in {{ sql_in(dispute_types) }}

),

opened as (

    -- the creation event (or, if it never arrived, the earliest event of the dispute)
    select *
    from (
        select
            *,
            row_number() over (
                partition by dispute_id
                order by case when event_type = 'charge.dispute.created' then 0 else 1 end, created_at, stripe_event_id
            ) as open_rank
        from dispute_events
    ) as ranked
    where open_rank = 1

),

latest as (

    select *
    from (
        select
            dispute_id,
            {{ json_str('dp', '$.status') }} as dispute_status,
            row_number() over (partition by dispute_id order by created_at desc, stripe_event_id desc) as latest_rank
        from dispute_events
    ) as ranked
    where latest_rank = 1

),

lifecycle as (

    select
        dispute_id,
        min(case when event_type = 'charge.dispute.closed' then created_at end) as closed_at,
        max(case when event_type = 'charge.dispute.funds_reinstated' then 1 else 0 end) = 1 as has_funds_reinstated_event
    from dispute_events
    group by dispute_id

)

select
    o.dispute_id,
    o.stripe_event_id,
    {{ ts_from_unix_seconds(json_int('o.dp', '$.created')) }} as disputed_at,
    {{ json_str('o.dp', '$.charge') }} as charge_id,
    {{ json_str('o.dp', '$.payment_intent') }} as payment_intent_id,
    {{ json_int('o.dp', '$.amount') }} as amount_minor,
    upper({{ json_str('o.dp', '$.currency') }}) as currency,
    {{ json_str('o.dp', '$.reason') }} as dispute_reason,
    coalesce(l.dispute_status, {{ json_str('o.dp', '$.status') }}) as dispute_status,
    lc.closed_at,
    coalesce(l.dispute_status like 'warning%', false) as is_inquiry,
    (coalesce(l.dispute_status, '') = 'won' or lc.has_funds_reinstated_event) as is_funds_reinstated,
    -- funds actually withdrawn and not given back, as of as-of
    not (coalesce(l.dispute_status like 'warning%', false) or coalesce(l.dispute_status, '') = 'won' or lc.has_funds_reinstated_event) as is_money_lost
from opened as o
left join latest as l on l.dispute_id = o.dispute_id
left join lifecycle as lc on lc.dispute_id = o.dispute_id
