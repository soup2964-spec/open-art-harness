-- businessDetails[] of generation rows: one line per sub-generation (quantity x unitCredits).
-- unitCredits = 0 means an "Unlimited" campaign; originalUnitCredits/discountPct describe promos.
select
    l.ledger_entry_id,
    l.user_id,
    l.created_at,
    l.business_type,
    detail_idx as detail_position,
    {{ json_int('detail', '$.quantity') }} as quantity,
    {{ json_int('detail', '$.unitCredits') }} as unit_credits,
    {{ json_str('detail', '$.subBusinessType') }} as sub_business_type,
    {{ json_str('detail', '$.metadata.projectId') }} as project_id,
    {{ json_str('detail', '$.metadata.mediaType') }} as detail_media_type,
    {{ json_str('detail', '$.metadata.source') }} as generation_source,
    {{ json_float('detail', '$.metadata.discountPct') }} as discount_pct,
    {{ json_int('detail', '$.metadata.originalUnitCredits') }} as original_unit_credits
from {{ ref('stg_app__credit_ledger') }} as l
{{ json_array_join('l.business_details', '$', 'detail') }}
where l.is_generation
