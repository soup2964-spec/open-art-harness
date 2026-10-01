-- Credit ledger entries (API entry shape). businessType '<model>:<mode>' on CONSUME rows is the
-- capability id that model_costs.csv joins on (research/10 §3.3, contracts credit-ledger-entry).
-- Rows without a userId cannot belong to anyone: they are listed in fct_data_quality_quarantine
-- instead of reaching the models. As-of: entries created after the as-of instant are ignored.
with entries as (

    select
        *,
        row_number() over (partition by id order by createdAt) as copy_number
    from {{ source('app', 'credit_ledger') }}
    where userId is not null
      and {{ ts_from_iso('createdAt') }} <= {{ as_of_ts() }}

),

typed as (

    select
        id as ledger_entry_id,
        userId as user_id,
        type as entry_type,
        amount,
        creditField as credit_field,
        balanceBefore as balance_before,
        balanceAfter as balance_after,
        sequenceId as sequence_id,
        previousSequenceId as previous_sequence_id,
        {{ json_str('reference', '$.businessType') }} as business_type,
        {{ json_str('reference', '$.businessId') }} as business_id,
        idempotencyKey as idempotency_key,
        {{ ts_from_iso('createdAt') }} as created_at,
        reason,
        teamMemberUserId as team_member_user_id,
        businessDetails as business_details
    from entries
    where copy_number = 1

)

select
    *,
    (entry_type = 'CONSUME' and {{ regexp_like('business_type', '^[A-Za-z0-9.-]+:[A-Za-z0-9-]+$') }}) as is_generation,
    -- GPT Image 2.5 variants bill under gpt-image-2-5-<variant> but are one model (contracts model-catalog).
    {{ regexp_replace_all(split_part_or_null('business_type', ':', 1), '^gpt-image-2-5-(flare|sunburst)$', 'gpt-image-2-5') }} as model_id,
    {{ split_part_or_null('business_type', ':', 2) }} as generation_mode,
    case
        when {{ split_part_or_null('business_type', ':', 2) }} like '%video%'
            or {{ split_part_or_null('business_type', ':', 2) }} in ('lipSync', 'motion-sync') then 'video'
        when {{ split_part_or_null('business_type', ':', 2) }} like '%image%' then 'image'
        when {{ split_part_or_null('business_type', ':', 2) }} like '%speech%'
            or {{ split_part_or_null('business_type', ':', 2) }} like '%music%'
            or {{ split_part_or_null('business_type', ':', 2) }} like '%sfx%' then 'audio'
        when {{ split_part_or_null('business_type', ':', 2) }} is not null then 'other'
    end as media_type
from typed
