-- Cross-engine behaviour the models rely on: epoch conversions, ISO parsing in UTC, time-zone
-- dates, elapsed seconds, JSON extraction of hyphenated keys. Timestamps are compared through
-- ts_to_iso_ms so the check reads the same on BigQuery and DuckDB.
with checks as (

    select 'unix seconds' as check_name,
           {{ ts_to_iso_ms(ts_from_unix_seconds(1780459780)) }} as actual,
           '2026-06-03T04:09:40.000Z' as expected
    union all
    select 'unix millis', {{ ts_to_iso_ms(ts_from_unix_millis(1780412260000)) }}, '2026-06-02T14:57:40.000Z'
    union all
    select 'iso Z', {{ ts_to_iso_ms(ts_from_iso("'2026-07-01T10:05:00.000Z'")) }}, '2026-07-01T10:05:00.000Z'
    union all
    select 'date in LA', cast({{ date_in_tz(ts_from_iso("'2026-07-01T03:00:00Z'"), "'America/Los_Angeles'") }} as {{ dbt.type_string() }}), '2026-06-30'
    union all
    select 'date in UTC', cast({{ date_in_tz(ts_from_iso("'2026-07-01T03:00:00Z'"), "'UTC'") }} as {{ dbt.type_string() }}), '2026-07-01'
    union all
    select 'elapsed seconds', cast(cast({{ ts_diff_seconds(ts_from_unix_seconds(1780459790), ts_from_unix_seconds(1780459780)) }} as {{ dbt.type_int() }}) as {{ dbt.type_string() }}), '10'
    union all
    select 'add a day', {{ ts_to_iso_ms(ts_add_seconds(ts_from_unix_seconds(1780459780), 86400)) }}, '2026-06-04T04:09:40.000Z'
    union all
    select 'hyphenated json key', {{ json_str(json_parse("'{\"ab_suite-default-model-create-image\":\"nano-banana-pro\"}'"), '$."ab_suite-default-model-create-image"') }}, 'nano-banana-pro'
    union all
    select 'json int', cast({{ json_int(json_parse("'{\"a\":1789748400000}'"), '$.a') }} as {{ dbt.type_string() }}), '1789748400000'
    union all
    select 'month start', cast({{ month_start("cast('2026-07-19' as date)") }} as {{ dbt.type_string() }}), '2026-07-01'
    union all
    select 'split part out of range is null', coalesce({{ split_part_or_null("'a:b'", ':', 3) }}, 'NULL'), 'NULL'

)

select * from checks where actual is null or actual <> expected
