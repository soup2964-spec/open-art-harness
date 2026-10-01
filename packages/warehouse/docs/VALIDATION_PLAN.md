# Validation plan: from synthetic backtest to production evidence

Everything this package reports today is measured on the SYNTHETIC contracts cohort. The
out-of-time backtest (`target/oot_backtest_report.md`, `python_tests/oot_eval.py`) shows the
estimators recover the generator they were not fit on; it says nothing about OpenArt's users.
This plan is the order in which real evidence is collected before either score changes a bid
or a traffic split. Each stage has an exit criterion; a stage that fails stops the next.

| Stage | Weeks | What runs | Who acts on it | Exit criterion |
|---|---|---|---|---|
| 0. Data checks | 0–1 | `docs/week1-sizing-queries.md` Q0–Q8 on OpenArt's BigQuery | nobody | the sources exist in the documented shape; `fct_data_quality_quarantine` shows no `excluded` rows after the first full build |
| 1. Shadow | 2–4 | dbt daily; both scores logged (`fct_purchase_value_score_log`, `fct_predicted_profit_24h_log`); nothing sent | nobody: platforms keep receiving cash values, the bandit stays in dry run | 14+ days of logged scores; `assert_score_logs_are_reproducible` green every day; run-to-run drift of the fitted parameters (`dim_model_parameters`) documented |
| 2. Out-of-time backtest on real data | 4–8 | `int_pp__oot_weeks` fills as signup weeks mature; `python_tests/oot_eval.py` against the real ledger (independent truth = the raw Stripe / ledger tables) | growth data engineer | purchase value score: calibration slope CI includes 1, top-decile lift > first-charge baseline, capped MAE < first-charge baseline, interval coverage within 10pp of nominal, on 3+ weeks; 24h score: calibration slope CI includes 1 and arm-readout coverage within 10pp of nominal |
| 3. Replay of past A/Bs | 6–9 | `fct_experiment_profit_by_arm` on the historical default-model exposures; compare the readout's winner and CIs with what the matured realised profit says | growth + product | for every finished flag the 24h readout (predicted, with model error) and the realised 90-day readout agree on the winner or overlap; the sampling-only interval is not used |
| 4. Lift test of the values | 8–14 | a geo or campaign split: half the campaigns receive `fct_purchase_value_score.platform_value`, half keep cash values (`packages/conversion-service` chooses per campaign) | growth | 90-day realised profit per ad dollar in the value arm >= the cash arm, with a pre-registered minimum detectable effect; no rise in refund / chargeback rate |
| 5. Bandit in the open | 12+ | `packages/bandit-allocator` moves weights daily from `fct_experiment_profit_by_arm_daily`, holdout rule fixed | growth | holdout vs bandit realised profit per exposed user compared monthly; SRM alerts silent; stop-loss never triggered by a data defect |

## What the shadow period must show before stage 2

- **Reproducibility.** A logged score, its `fitted_params_ref` and `features_snapshot` reproduce
  the value (`assert_score_logs_are_reproducible`); the ref changes only when a fitted value or a var changes.
- **Point in time.** `assert_features_known_before_anchor` and `assert_backtest_never_trains_on_its_test_week`
  stay green on real data; the click-id store's `received_at` never precedes `created_at` by
  more than the clock skew allowance.
- **Money.** `assert_ledger_net_cash_matches_stripe` closes every day with the quarantine
  explaining every cent of difference; non-USD share and tax share (week-1 Q7) match what
  `int_fx__rates` and `revenue_minor` assume; the FX seed is replaced by a rate feed before any
  non-USD value is sent.
- **Coverage.** Every exposed user is scored at 24h (`scored_users = exposed_users` in the daily mart);
  contaminated users stay below 1% per arm; the holdout key predicate matches the LaunchDarkly
  context key (README, bandit-allocator).

## What decides the estimand is right

The ad value is `E[gross_profit_90d | purchase]` at purchase time. Stage 4 is the only test of
that choice: if the value arm does not beat cash values on realised profit per ad dollar, the
platforms are told cash again and the score stays a reporting metric. The 24h score never becomes
an ad value whatever stage 2 shows; its job is the experiment readout and the bandit's reward,
and stage 3 and 5 are its tests.

## Reporting

Each stage ends with a short note in this directory (`validation/<stage>-<date>.md`): the query
or report it used, the numbers, the decision. Numbers from the synthetic cohort are always
labelled synthetic.
