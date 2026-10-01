-- Metabase native question: "Signal coverage by conversion event"
-- Visualization: Table with progress bars (share columns 0-100), or a row chart per column.
-- What share of each server-side conversion carries the identifiers each platform matches on,
-- and how many need a browser patch first (requires_web_fix). Reads the aggregate-only
-- reporting view (no user or device ids reach BI).
-- Variables:
--   @param since  Date  optional  (only events on or after this date)
select
    event_name,
    sum(events) as events,
    round(100.0 * sum(events * share_any_click_id) / sum(events), 1) as pct_any_click_id,
    round(100.0 * sum(events * share_google_click_id) / sum(events), 1) as pct_google_click_id,
    round(100.0 * sum(events * share_meta_fbclid) / sum(events), 1) as pct_meta_fbclid,
    round(100.0 * sum(events * share_meta_fbc_buildable) / sum(events), 1) as pct_meta_fbc_buildable,
    round(100.0 * sum(events * share_tiktok_ttclid) / sum(events), 1) as pct_tiktok_ttclid,
    round(100.0 * sum(events * share_utm_source) / sum(events), 1) as pct_utm_source,
    round(100.0 * sum(events * share_device_id) / sum(events), 1) as pct_device_id,
    round(100.0 * sum(events * share_experiment_arm) / sum(events), 1) as pct_experiment_arm,
    round(100.0 * sum(events * share_consent_region_known) / sum(events), 1) as pct_consent_region_known,
    max(web_fix_platforms) as web_fix_platforms
from openart_signal_reporting.rpt_signal_coverage_daily
where 1 = 1
  [[and event_date >= {{since}}]]
group by event_name
order by events desc
