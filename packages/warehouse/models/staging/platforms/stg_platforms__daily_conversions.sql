-- Platform-reported conversions (SYNTHETIC locally). One row per platform x account x
-- report layer x report date, in the account's time zone and date basis.
select
    platform,
    account_id,
    report_layer,
    date_basis,
    account_timezone,
    report_date,
    {{ month_start('report_date') }} as report_month,
    attribution_setting,
    cast(conversions as {{ type_double() }}) as conversions,
    cast(conversion_value as {{ type_double() }}) as conversion_value,
    upper(currency) as currency,
    data_origin
from {{ source('platforms', 'daily_conversions') }}
where report_date <= cast({{ as_of_ts() }} as date)
