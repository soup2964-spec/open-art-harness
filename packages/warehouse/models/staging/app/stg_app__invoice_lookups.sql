-- GET /legacy/api/stripe/checkout-session-invoice outcomes, one row per Checkout Session.
-- The Suite retries once; the purchase is valued from the first successful attempt, and a
-- session with no successful attempt falls back to the stale price table (research/02 §3.2).
with attempts as (

    select
        user_id,
        checkout_session_id,
        requested_at,
        http_status,
        response,
        (http_status = 200 and coalesce({{ json_bool('response', '$.isValidInvoice') }}, false)) as attempt_ok
    from {{ source('app', 'invoice_lookups') }}
    where requested_at <= {{ as_of_ts() }}

),

ranked as (

    select
        *,
        row_number() over (
            partition by checkout_session_id
            order by case when attempt_ok then 0 else 1 end, requested_at
        ) as attempt_rank,
        count(*) over (partition by checkout_session_id) as attempts
    from attempts

)

select
    checkout_session_id,
    user_id,
    requested_at as first_useful_attempt_at,
    attempts,
    attempt_ok as lookup_ok,
    {{ json_str('response', '$.invoiceId') }} as invoice_id,
    {{ json_bool('response', '$.isFirstPurchase') }} as is_first_purchase,
    {{ json_bool('response', '$.isValidInvoice') }} as is_valid_invoice,
    {{ json_bool('response', '$.isBusiness') }} as is_business,
    {{ json_int('response', '$.amountMinor') }} as amount_minor,
    upper({{ json_str('response', '$.currency') }}) as currency,
    {{ json_float('response', '$.ltvValueMajor') }} as ltv_value_major,
    upper({{ json_str('response', '$.ltvCurrency') }}) as ltv_currency
from ranked
where attempt_rank = 1
