"""The out-of-time backtest runs, is labelled synthetic, evaluates against INDEPENDENT realised
outcomes, and reports every metric the ML review asked for with bootstrap CIs. No assertion here
says the scores are good: the numbers are what they are (target/oot_backtest_report.md).

What IS asserted:
  * protocol: every out-of-time fit trains only on earlier signup weeks (also a dbt singular test),
    every test unit has complete 90-day outcomes, and there are several weeks;
  * plumbing: the realised outcomes the backtest uses (truth.py, from raw files) equal the
    warehouse's own realised outcomes (int_pp__user_outcomes) for the test users;
  * structure: calibration (slope, intercept), deciles, top-decile lift, capped MAE, each with a
    95% CI, for both scores and their baselines; interval coverage for the purchase value score
    and for the arm readout, both between 0 and 1.
"""

from __future__ import annotations

import math

import oot_eval
from truth import Cohort

METRICS = ["calibration_intercept", "calibration_slope", "top_decile_lift", "capped_mae"]


def test_backtest_report_is_complete_and_labelled_synthetic(con):
    report = oot_eval.evaluate()
    json_path, md_path = oot_eval.write_report(report)
    assert json_path.exists() and md_path.exists()
    assert "SYNTHETIC" in report["data_origin"] and "SYNTHETIC" in md_path.read_text(encoding="utf-8")
    assert len(report["weeks"]) >= 3

    for score, variants in (("score_24h", ["signals_only", "with_arm_terms", "cash_24h", "conversion_only"]), ("purchase_value_score", ["purchase_value_score", "first_charge_revenue", "training_mean"])):
        pooled = report[score]["pooled"]
        for name in variants:
            m = pooled[name]
            assert m["n"] > 20, (score, name)
            for metric in METRICS:
                assert metric in m and f"{metric}_ci95" in m, (score, name, metric)
                lo, hi = m[f"{metric}_ci95"]
                if m[metric] is not None:
                    assert lo is not None and hi is not None and lo <= hi, (score, name, metric)
            assert 1 <= len(m["deciles"]) <= 10
        for week, block in report[score]["by_week"].items():
            assert block[variants[0]]["n"] > 0, (score, week)

    pvs_cov = report["purchase_value_score"]["interval_coverage"]
    assert 0 <= pvs_cov["realised"] <= 1 and pvs_cov["n"] > 20
    arm_cov = report["arm_readout_interval_coverage"]
    assert arm_cov["cells"] >= 15
    assert 0 <= arm_cov["sampling_only_coverage"] <= 1 and 0 <= arm_cov["with_model_error_coverage"] <= 1
    # the model-error interval is wider than the sampling-only one, so it can only cover more
    assert arm_cov["with_model_error_coverage"] >= arm_cov["sampling_only_coverage"]


def test_backtest_outcomes_are_independent_of_the_warehouse_yet_equal_to_it(con):
    cohort = Cohort()
    rows = con.execute(
        """select s.user_id, o.realized_profit_90d
           from openart_signal_intermediate.int_pp__scores s
           join openart_signal_intermediate.int_pp__user_outcomes o using (user_id)
           where s.purpose = 'oot_test'"""
    ).fetchall()
    assert len(rows) > 500
    for user_id, warehouse_profit in rows:
        start, end = cohort.signup_window(user_id)
        assert cohort.is_mature(start), user_id
        assert abs(cohort.window(user_id, start, end).profit_usd - warehouse_profit) < 0.005, user_id


def test_out_of_time_fits_never_see_their_test_week(con):
    leaks = con.execute(
        """select count(*) from openart_signal_intermediate.int_pp__fit_sets f
           join openart_signal_intermediate.int_pp__user_outcomes o using (user_id)
           where f.fit_kind in ('out_of_time', 'out_of_time_crossfit') and o.signup_week >= f.test_week_start"""
    ).fetchone()[0]
    assert leaks == 0
    served_in_sample = con.execute(
        """select count(*) from openart_signal_intermediate.int_pp__scores s
           join openart_signal_intermediate.int_pp__fit_sets f on f.fit_id = s.fit_id and f.user_id = s.user_id
           where s.purpose = 'serve'"""
    ).fetchone()[0]
    assert served_in_sample == 0


def test_metrics_are_finite_where_defined():
    report = oot_eval.evaluate()
    m = report["purchase_value_score"]["pooled"]["purchase_value_score"]
    assert m["capped_mae"] is not None and not math.isnan(m["capped_mae"])
    assert m["calibration_slope"] is not None
