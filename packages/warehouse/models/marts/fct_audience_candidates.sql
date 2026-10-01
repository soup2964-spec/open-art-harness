-- Audience candidates, one row per (user, list): the warehouse's decision layer for
-- packages/audience-sync, which hashes identifiers per platform and uploads (dry-run by default).
--
-- Values are CUSTOMER values: the purchase value score of the user's first purchase
-- (fct_purchase_value_score, E[90-day gross profit | purchase], scored at that purchase). The 24h
-- score (fct_predicted_profit_24h) is an unconditional per-exposed-user estimate for experiment
-- readouts only and is never used for targeting or values (ML review 1). So only purchasers are
-- scored here; predicted_profit is NULL for everyone else.
--   seed        oa_high_predicted_profit_90d      top audience_seed_top_share of purchasers by value and
--                                                 >= audience_seed_min_profit_usd; never a refunder,
--                                                 charge-backer or fraud dispute. value = platform_value
--   exclusions  oa_paying_customers_suppress      active subscribers (stop paying to re-acquire them)
--               oa_refund_or_chargeback_suppress  any refund, chargeback or fraud dispute
--               oa_low_predicted_profit_suppress  purchasers valued below audience_low_profit_threshold_usd
--                                                 (reason negative_... when below zero, else low_...)
-- Consent: OpenArt runs no CMP, so every row is 'unknown'. Users in a consent-required region
-- (seeds/consent_required_regions.csv = contracts CONSENT_REQUIRED_REGIONS) and users with no known
-- region are withheld from upload (fail closed).
-- PII (database review 8): no hashed identifier is materialised next to the uid; audience-sync
-- hashes per platform at upload. external_id_sha256 stays as an always-NULL column only because
-- audience-sync's adapter schema still lists it.

with first_purchase_value as (

    select user_id, predicted_profit_90d, platform_value, model_version
    from (
        select
            s.*,
            row_number() over (partition by s.user_id order by s.occurred_at, s.event_id) as purchase_rank
        from {{ ref('fct_purchase_value_score') }} as s
        where not s.is_qa_account
    ) as ranked
    where purchase_rank = 1

),

scored as (

    select
        v.user_id,
        v.predicted_profit_90d as predicted_profit,
        v.platform_value,
        v.model_version,
        percent_rank() over (order by v.predicted_profit_90d) as predicted_profit_percentile
    from first_purchase_value as v

),

money_out as (

    select
        l.user_id,
        max(case when l.event_name = 'refund' then 1 else 0 end) = 1 as has_refund,
        max(case when l.event_name = 'chargeback' then 1 else 0 end) = 1 as has_chargeback,
        max(case when a.dispute_reason = 'fraudulent' then 1 else 0 end) = 1 as has_fraud_dispute
    from {{ ref('fct_conversion_ledger') }} as l
    left join {{ ref('int_stripe__adjustments') }} as a on a.event_id = l.event_id
    where l.event_name in ('refund', 'chargeback')
      and l.occurred_at <= {{ as_of_ts() }}
    group by l.user_id

),

active as (

    select distinct user_id
    from {{ ref('int_stripe__subscription_status') }}
    where status_as_of = 'active'

),

users as (

    select
        s.*,
        a.user_id is not null as is_active_subscriber,
        coalesce(m.has_refund, false) as has_refund,
        coalesce(m.has_chargeback, false) as has_chargeback,
        coalesce(m.has_fraud_dispute, false) as has_fraud_dispute,
        s.predicted_profit < {{ var('audience_low_profit_threshold_usd') }} as is_low_predicted_profit,
        p.country_code as consent_region,
        coalesce(p.is_eea_uk_ch, false) as is_eea_uk_ch,
        cr.iso2 is not null as requires_consent
    from scored as s
    left join active as a on a.user_id = s.user_id
    left join money_out as m on m.user_id = s.user_id
    left join {{ ref('int_user__profile') }} as p on p.user_id = s.user_id
    left join {{ ref('consent_required_regions') }} as cr on cr.iso2 = p.country_code

),

memberships as (

    select user_id, 'oa_high_predicted_profit_90d' as list_name, 'seed' as candidate_role,
           'high_predicted_profit' as reason, platform_value as seed_value_usd
    from users
    where predicted_profit_percentile >= 1 - {{ var('audience_seed_top_share') }}
      and predicted_profit >= {{ var('audience_seed_min_profit_usd') }}
      and not has_refund and not has_chargeback and not has_fraud_dispute

    union all

    select user_id, 'oa_paying_customers_suppress', 'exclusion', 'paying_customer_suppression', cast(null as {{ type_double() }})
    from users
    where is_active_subscriber

    union all

    select user_id, 'oa_refund_or_chargeback_suppress', 'exclusion', 'refund_or_chargeback_suppression', cast(null as {{ type_double() }})
    from users
    where has_refund or has_chargeback or has_fraud_dispute

    union all

    select
        user_id,
        'oa_low_predicted_profit_suppress',
        'exclusion',
        case when predicted_profit < 0 then 'negative_predicted_profit_suppression' else 'low_predicted_profit_suppression' end,
        cast(null as {{ type_double() }})
    from users
    where is_low_predicted_profit

)

select
    m.user_id,
    m.list_name,
    m.candidate_role,
    m.reason,
    'add' as action,
    round(m.seed_value_usd, 6) as seed_value_usd,
    round(u.predicted_profit, 6) as predicted_profit,
    round(u.predicted_profit_percentile, 6) as predicted_profit_percentile,
    u.model_version,
    u.is_active_subscriber,
    u.has_refund,
    u.has_chargeback,
    u.has_fraud_dispute,
    u.is_low_predicted_profit,
    -- consent (no CMP today: research/11 §3.3)
    u.consent_region,
    u.is_eea_uk_ch,
    u.requires_consent,
    'none' as consent_source,
    'unknown' as ad_user_data,
    'unknown' as ad_personalization,
    case
        when u.consent_region is null then false
        when u.requires_consent then false
        else true
    end as upload_allowed,
    case
        when u.consent_region is null then 'region_unknown'
        when u.requires_consent then 'consent_required_region_without_consent'
    end as upload_block_reason,
    cast(null as {{ dbt.type_string() }}) as external_id_sha256,
    {{ as_of_ts() }} as computed_at
from memberships as m
inner join users as u on u.user_id = m.user_id
