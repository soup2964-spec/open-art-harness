-- contact.propertyChange webhooks for lifecyclestage. Retries share eventId (attemptNumber > 0).
with ranked as (

    select
        *,
        row_number() over (partition by eventId order by attemptNumber) as attempt_rank
    from {{ source('hubspot', 'contact_property_changes') }}
    where propertyName = 'lifecyclestage'
      and {{ ts_from_unix_millis('occurredAt') }} <= {{ as_of_ts() }}

)

select
    cast(eventId as {{ dbt.type_string() }}) as hubspot_event_id,
    portalId as portal_id,
    cast(objectId as {{ dbt.type_string() }}) as contact_id,
    {{ ts_from_unix_millis('occurredAt') }} as occurred_at,
    propertyValue as lifecycle_stage,
    changeSource as change_source
from ranked
where attempt_rank = 1
