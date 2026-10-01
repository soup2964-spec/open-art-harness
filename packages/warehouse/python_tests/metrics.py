"""Evaluation metrics for the out-of-time backtest (ML review 2), in plain Python so they can be
unit-tested on toy data (python_tests/test_metrics.py):

    calibration   OLS of realised on predicted over units: intercept and slope (1 and 0 = calibrated)
    deciles       units sorted by prediction into (up to) 10 equal bins: mean predicted vs realised
    top-decile lift   mean realised in the top predicted decile / mean realised overall
    capped MAE    mean |clip(pred) - clip(realised)| with both clipped to [-cap, cap] (heavy tails)
    bootstrap     percentile CI from resampling units with replacement (seeded, deterministic)
"""

from __future__ import annotations

import math
import random
from collections.abc import Callable, Sequence
from statistics import fmean


def ols(x: Sequence[float], y: Sequence[float]) -> tuple[float, float]:
    """Intercept and slope of y ~ a + b x (NaN slope when x has no variance)."""
    n = len(x)
    if n < 2:
        return math.nan, math.nan
    mx, my = fmean(x), fmean(y)
    sxx = sum((xi - mx) ** 2 for xi in x)
    if sxx == 0:
        return math.nan, math.nan
    slope = sum((xi - mx) * (yi - my) for xi, yi in zip(x, y)) / sxx
    return my - slope * mx, slope


def deciles(pred: Sequence[float], real: Sequence[float], bins: int = 10) -> list[dict]:
    """Equal-count bins by prediction (fewer than 10 when there are fewer than 10 units)."""
    order = sorted(range(len(pred)), key=lambda i: (pred[i], i))
    k = max(1, min(bins, len(order)))
    out = []
    for b in range(k):
        idx = order[b * len(order) // k:(b + 1) * len(order) // k]
        if not idx:
            continue
        out.append({"bin": b + 1, "n": len(idx), "mean_predicted": fmean(pred[i] for i in idx), "mean_realised": fmean(real[i] for i in idx)})
    return out


def top_decile_lift(pred: Sequence[float], real: Sequence[float]) -> float:
    overall = fmean(real)
    if overall <= 0:
        return math.nan
    top_n = max(1, math.ceil(len(pred) / 10))
    top = sorted(range(len(pred)), key=lambda i: (-pred[i], i))[:top_n]
    return fmean(real[i] for i in top) / overall


def capped_mae(pred: Sequence[float], real: Sequence[float], cap: float) -> float:
    clip = lambda v: max(-cap, min(cap, v))  # noqa: E731
    return fmean(abs(clip(p) - clip(r)) for p, r in zip(pred, real))


def bootstrap(stat: Callable[[list[int]], float], n: int, replicates: int, seed: int, alpha: float = 0.05) -> tuple[float, float]:
    """Percentile CI of stat(indices) over bootstrap resamples of range(n)."""
    rng = random.Random(seed)
    draws = []
    for _ in range(replicates):
        sample = [rng.randrange(n) for _ in range(n)]
        value = stat(sample)
        if not math.isnan(value):
            draws.append(value)
    if not draws:
        return math.nan, math.nan
    draws.sort()
    lo = draws[max(0, int(math.floor(alpha / 2 * len(draws))))]
    hi = draws[min(len(draws) - 1, int(math.ceil((1 - alpha / 2) * len(draws))) - 1)]
    return lo, hi


def summarize(pred: Sequence[float], real: Sequence[float], cap: float, replicates: int, seed: int) -> dict:
    """Every backtest metric with its 95% bootstrap CI."""
    pred, real = list(pred), list(real)
    n = len(pred)
    intercept, slope = ols(pred, real)

    def on(idx: list[int], f: Callable[[list[float], list[float]], float]) -> float:
        return f([pred[i] for i in idx], [real[i] for i in idx])

    metrics = {
        "n": n,
        "mean_predicted": fmean(pred) if n else math.nan,
        "mean_realised": fmean(real) if n else math.nan,
        "calibration_intercept": intercept,
        "calibration_slope": slope,
        "top_decile_lift": top_decile_lift(pred, real) if n else math.nan,
        "capped_mae": capped_mae(pred, real, cap) if n else math.nan,
    }
    fns: dict[str, Callable[[list[float], list[float]], float]] = {
        "calibration_intercept": lambda p, r: ols(p, r)[0],
        "calibration_slope": lambda p, r: ols(p, r)[1],
        "top_decile_lift": top_decile_lift,
        "capped_mae": lambda p, r: capped_mae(p, r, cap),
    }
    for name, f in fns.items():
        lo, hi = bootstrap(lambda idx, f=f: on(idx, f), n, replicates, seed) if n > 1 else (math.nan, math.nan)
        metrics[f"{name}_ci95"] = [lo, hi]
    metrics["deciles"] = deciles(pred, real)
    return metrics


def clean(value):
    """JSON-safe: NaN -> None, floats rounded."""
    if isinstance(value, float):
        return None if math.isnan(value) or math.isinf(value) else round(value, 4)
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items()}
    if isinstance(value, list):
        return [clean(v) for v in value]
    return value
