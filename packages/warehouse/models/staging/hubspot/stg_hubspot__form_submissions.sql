-- /enterprise form submissions. Only non-personal fields are kept (email, names, company,
-- job title and message stay in the raw layer).
with fields as (

    select
        s.conversionId as conversion_id,
        s.portal_id,
        s.form_guid,
        {{ ts_from_unix_millis('s.submittedAt') }} as submitted_at,
        -- path only: a query string can carry the visitor's email or tokens
        {{ regexp_replace_all('s.pageUrl', '[?#].*$', '') }} as page_url,
        {{ json_str('field', '$.name') }} as field_name,
        {{ json_str('field', '$.value') }} as field_value
    from {{ source('hubspot', 'form_submissions') }} as s
    {{ json_array_join('s.' ~ adapter.quote('values'), '$', 'field') }}
    where {{ ts_from_unix_millis('s.submittedAt') }} <= {{ as_of_ts() }}

)

select
    conversion_id,
    any_value(portal_id) as portal_id,
    any_value(form_guid) as form_guid,
    min(submitted_at) as submitted_at,
    any_value(page_url) as page_url,
    max(case when field_name = 'company_size' then field_value end) as company_size,
    -- Hard-coded hidden defaults on the live form (research/00 B1): every web lead says Event/Brandweek.
    max(case when field_name = 'lead_source' then field_value end) as lead_source,
    max(case when field_name = 'lead_source_detail' then field_value end) as lead_source_detail,
    max(case when field_name = 'latest_form_submit_url' then field_value end) as latest_form_submit_url,
    max(case when field_name = 'gclid' then field_value end) as gclid,
    max(case when field_name = 'gbraid' then field_value end) as gbraid,
    max(case when field_name = 'wbraid' then field_value end) as wbraid
from fields
group by conversion_id
