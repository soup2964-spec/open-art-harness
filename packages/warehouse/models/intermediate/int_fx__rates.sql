-- FX rates as validity ranges in the REPORTING currency (var reporting_currency, default USD):
-- one row per (currency, [valid_from, valid_to)), reporting_per_unit = major units of the
-- reporting currency per major unit of `currency`, plus the currency's minor-unit exponent
-- (JPY and KRW have none: Stripe's amount 1400 JPY is 1,400 yen, not 14.00).
-- seeds/fx_rates.csv holds ILLUSTRATIVE placeholder rates expressed in USD; in production point
-- the seed (or a replacement model with the same columns) at a daily reference-rate feed.
-- A money event whose currency has no rate gets NULL reporting values and is listed in
-- fct_data_quality_quarantine (never silently converted at 1.0).
with rates as (

    select
        upper(currency) as currency,
        cast(rate_date as date) as valid_from,
        lead(cast(rate_date as date)) over (partition by upper(currency) order by rate_date) as valid_to,
        cast(usd_per_unit as {{ type_double() }}) as usd_per_unit,
        source as rate_source
    from {{ ref('fx_rates') }}

),

reporting as (

    select valid_from, valid_to, usd_per_unit
    from rates
    where currency = '{{ var("reporting_currency") }}'

)

select
    r.currency,
    '{{ var("reporting_currency") }}' as reporting_currency,
    -- the range where both this currency's rate and the reporting currency's rate are valid
    {{ greatest_of('r.valid_from', 'rp.valid_from', "cast('1900-01-01' as date)") }} as valid_from,
    case
        when r.valid_to is null then rp.valid_to
        when rp.valid_to is null then r.valid_to
        when r.valid_to < rp.valid_to then r.valid_to
        else rp.valid_to
    end as valid_to,
    r.usd_per_unit / rp.usd_per_unit as reporting_per_unit,
    cast(coalesce(mu.minor_unit_digits, 2) as {{ dbt.type_int() }}) as minor_unit_digits,
    mu.currency is not null as minor_unit_digits_known,
    r.rate_source
from rates as r
inner join reporting as rp
    on rp.valid_from < coalesce(r.valid_to, cast('9999-12-31' as date))
   and r.valid_from < coalesce(rp.valid_to, cast('9999-12-31' as date))
left join {{ ref('currency_minor_units') }} as mu on upper(mu.currency) = r.currency
