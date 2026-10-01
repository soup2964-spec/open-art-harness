SYNTHETIC. App-user rows (my-info shape) for the five hand-written scenario users of
packages/contracts/fixtures (SynthU01..U05), whose Stripe and ledger fixtures exist but whose
users record does not. Every Stripe customer id is an OpenArt uid with an app account, and the
warehouse tests that (fct_data_quality_quarantine, stripe_customer_not_an_app_user).
account_created_at = the trial grant where one exists (U01, U03, U05), else a few minutes before
the user's first checkout (U02, U04). Emails use the reserved .test domain.

amplitude_events.jsonl: one session_start each for U03 (two days before the trial grant, so the
week-1 Q2 query still sees one signup and payer with no Amplitude event in its window) and U04
(SYNTHETIC), on the device ids the contracts' golden ledger rows give them
(packages/contracts/src/fixtures/scenarios.ts U.u03/U.u04 deviceId) but no contracts raw fixture
carries. With them the warehouse derives those rows' device_id and consent region instead of the
golden test skipping device_id. They are not page views: the week-1 Q1/Q3 queries assume the
fixtures have none.
