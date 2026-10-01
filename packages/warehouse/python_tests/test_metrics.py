"""The backtest's metric helpers on toy data where the answer is known."""

from __future__ import annotations

import math

import metrics


def test_ols_recovers_a_line():
    x = [1.0, 2.0, 3.0, 4.0]
    y = [3.0 + 2.0 * v for v in x]
    intercept, slope = metrics.ols(x, y)
    assert math.isclose(intercept, 3.0) and math.isclose(slope, 2.0)


def test_ols_without_variance_is_nan():
    assert all(math.isnan(v) for v in metrics.ols([1.0, 1.0], [2.0, 3.0]))


def test_perfect_calibration_and_lift():
    pred = [float(i) for i in range(1, 101)]
    report = metrics.summarize(pred, pred, cap=1e9, replicates=50, seed=1)
    assert math.isclose(report["calibration_slope"], 1.0) and abs(report["calibration_intercept"]) < 1e-9
    assert report["capped_mae"] == 0
    # top decile of 1..100 is 91..100: mean 95.5 over overall mean 50.5
    assert math.isclose(report["top_decile_lift"], 95.5 / 50.5)
    assert len(report["deciles"]) == 10 and report["deciles"][-1]["mean_realised"] == 95.5


def test_capped_mae_clips_both_sides():
    assert metrics.capped_mae([1000.0, -1000.0], [0.0, 0.0], cap=100) == 100


def test_bootstrap_is_deterministic_and_brackets_the_estimate():
    pred = [float(i % 7) for i in range(200)]
    real = [p + (1 if i % 2 else -1) for i, p in enumerate(pred)]
    a = metrics.summarize(pred, real, cap=50, replicates=200, seed=7)
    b = metrics.summarize(pred, real, cap=50, replicates=200, seed=7)
    assert a == b
    lo, hi = a["capped_mae_ci95"]
    assert lo <= a["capped_mae"] <= hi
    lo, hi = a["calibration_slope_ci95"]
    assert lo <= a["calibration_slope"] <= hi


def test_lift_is_undefined_when_nothing_is_earned():
    assert math.isnan(metrics.top_decile_lift([1.0, 2.0], [0.0, 0.0]))
