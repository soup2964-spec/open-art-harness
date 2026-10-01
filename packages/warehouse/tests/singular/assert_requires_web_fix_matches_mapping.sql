-- requires_web_fix is exactly "some platform this event is sent to has a browser twin that
-- needs packages/web-fixes" per contracts seeds/platform_event_mapping.csv.
with expected as (

    select canonical_event, max(case when send and requires_web_fix then 1 else 0 end) = 1 as requires_web_fix
    from {{ ref('platform_event_mapping') }}
    group by canonical_event

)

select l.event_id, l.event_name, l.requires_web_fix, e.requires_web_fix as expected
from {{ ref('fct_conversion_ledger') }} as l
inner join expected as e on e.canonical_event = l.event_name
where l.requires_web_fix <> e.requires_web_fix
