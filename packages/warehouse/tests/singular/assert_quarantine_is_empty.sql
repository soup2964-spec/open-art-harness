{{ config(severity='warn') }}
-- Warns (never fails the build) for every record fct_data_quality_quarantine holds: an unhandled
-- Stripe event type, an unknown price, an unclassified or unconvertible purchase, an unlinked or
-- netted adjustment, a ledger entry without a user, a Stripe customer without an app account.
-- Database review 2: data problems are quarantined and alerted on, not build-stopping.
select issue, severity, source_model, record_id, detail
from {{ ref('fct_data_quality_quarantine') }}
