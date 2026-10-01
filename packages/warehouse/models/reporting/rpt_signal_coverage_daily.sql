{{ config(materialized='view') }}
-- BI view (aggregate only): what share of each day's events carries each identifier.
select
    cast(occurred_at as date) as event_date,
    event_name,
    count(*) as events,
    avg(case when has_any_click_id then 1.0 else 0.0 end) as share_any_click_id,
    avg(case when has_google_click_id then 1.0 else 0.0 end) as share_google_click_id,
    avg(case when has_meta_fbclid then 1.0 else 0.0 end) as share_meta_fbclid,
    avg(case when meta_fbc_buildable then 1.0 else 0.0 end) as share_meta_fbc_buildable,
    avg(case when has_tiktok_ttclid then 1.0 else 0.0 end) as share_tiktok_ttclid,
    avg(case when has_utm_source then 1.0 else 0.0 end) as share_utm_source,
    avg(case when device_id is not null then 1.0 else 0.0 end) as share_device_id,
    avg(case when has_experiment_arm then 1.0 else 0.0 end) as share_experiment_arm,
    avg(case when consent_region_known then 1.0 else 0.0 end) as share_consent_region_known,
    max(case when requires_web_fix then web_fix_platforms end) as web_fix_platforms
from {{ ref('fct_conversion_ledger') }}
where not is_qa_account
group by cast(occurred_at as date), event_name
