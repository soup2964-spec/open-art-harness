"""OUT-OF-TIME evaluation of both scores on the SYNTHETIC cohort (ML review 2).

For every backtest week (int_pp__oot_weeks: a signup week whose 90-day outcomes are complete), the
warehouse fits its parameters on users who signed up BEFORE the week (fit oot_<week>) and scores
the week's users with them (int_pp__scores / int_pvs__scores, purpose 'oot_test'). This module
evaluates those scores against realised outcomes computed INDEPENDENTLY from the raw fixture files
(python_tests/truth.py), pooled over the weeks and per week:

    24h score (fct_predicted_profit_24h estimand: unconditional E[90d profit per exposed user])
        unit = user; realised = profit over [signup, signup + 90d)
        baselines: cash_24h (what the user paid within 24h, else 0)
                   conversion_only (the fit's P(subscribe) x the training users' mean realised
                   profit per unit of P: no value, no cost information)
    purchase value score (fct_purchase_value_score estimand: E[gross_profit_90d | purchase])
        unit = purchase (users of the test week, complete 90 days from the purchase);
        realised = profit over [purchase, purchase + 90d)
        baselines: first_charge_revenue (the purchase's own tax-exclusive revenue as the value)
                   training_mean (every purchase valued at the training purchases' mean profit)

Metrics (python_tests/metrics.py): decile calibration table, calibration intercept and slope,
top-decile lift, capped MAE (cap = var oot_mae_cap_usd), each with a 95% bootstrap CI over units.
Interval coverage: the share of matured test purchases whose realised profit lies inside the
purchase value interval (nominal var pvs_interval_coverage), and, for the arm readout, the share of
(week, flag, arm) cells whose 95% prediction interval (sampling + cross-fitted model error, as
fct_experiment_profit_by_arm builds it) covers the realised mean of the week's users in that arm.

Everything here is SYNTHETIC: the cohort generator's behaviour, not OpenArt's. The numbers say
how well the estimators recover a generator they were not fit on; they say nothing about
production accuracy until the shadow period and backtest of docs/VALIDATION_PLAN.md.

Run directly:  uv run --with duckdb==1.5.6 --with pyyaml python python_tests/oot_eval.py
"""

from __future__ import annotations

import json
import math
import os
import sys
from collections import defaultdict
from datetime import timezone
from pathlib import Path
from statistics import fmean, pvariance

import duckdb

import metrics
from truth import FLAGS, WAREHOUSE, Cohort

DB = Path(os.environ.get("WAREHOUSE_DUCKDB_PATH", WAREHOUSE / "target" / "local.duckdb"))
I = "openart_signal_intermediate"
REPLICATES = 300
SEED = 20260930
Z = 1.96


def _utc(ts):
    return ts.replace(tzinfo=timezone.utc)


def evaluate(db: Path = DB) -> dict:
    cohort = Cohort()
    v = cohort.vars
    cap = float(v["oot_mae_cap_usd"])
    con = duckdb.connect(str(db), read_only=True)
    con.execute("set TimeZone = 'UTC'")
    weeks = {fit: (start, end, users) for fit, start, end, users in con.execute(f"select fit_id, test_week_start, test_week_end, test_week_users from {I}.int_pp__oot_weeks order by 1").fetchall()}

    # ---------------------------------------------------------------- 24h score, out of time
    rows_24h = con.execute(
        f"""select s.fit_id, s.user_id, s.signup_at, s.sig_predicted_profit, s.cal_predicted_profit, s.p_convert,
                   s.paid_within_24h, coalesce(s.first_purchase_value_usd, 0), s.arm_create_image, s.arm_create_video
            from {I}.int_pp__scores s
            where s.purpose = 'oot_test'"""
    ).fetchall()
    train_24h = con.execute(
        f"""select s.fit_id, s.user_id, s.sig_predicted_profit, s.p_convert
            from {I}.int_pp__scores s where s.purpose = 'oot_train_crossfit'"""
    ).fetchall()

    # realised profit over the signup window, independently, for every user involved
    realised_user: dict[str, float] = {}

    def realised(user_id: str) -> float:
        if user_id not in realised_user:
            start, end = cohort.signup_window(user_id)
            realised_user[user_id] = cohort.window(user_id, start, end).profit_usd
        return realised_user[user_id]

    # training users per test week (signup before the week): the conversion-only baseline's scale
    # and the cross-fitted residual variance for the arm-level prediction intervals
    train_by_fit: dict[str, list[tuple[str, float, float]]] = defaultdict(list)
    for fit_id, user_id, pred, p in train_24h:
        base_fit = fit_id.split("_xf")[0]
        if cohort.is_mature(cohort.signup[user_id]):
            train_by_fit[base_fit].append((user_id, pred, p))
    scale_by_fit: dict[str, float] = {}
    resid_var_by_fit: dict[str, float] = {}
    for fit_id, rows in train_by_fit.items():
        mean_real = fmean(realised(u) for u, _, _ in rows)
        mean_p = fmean(p for _, _, p in rows)
        scale_by_fit[fit_id] = mean_real / mean_p if mean_p > 0 else 0.0
        resid = [realised(u) - pred for u, pred, _ in rows]
        resid_var_by_fit[fit_id] = pvariance(resid) if len(resid) > 1 else 0.0

    per_user = []
    for fit_id, user_id, signup_at, sig, cal, p, paid_24h, cash_24h, arm_img, arm_vid in rows_24h:
        assert cohort.is_mature(_utc(signup_at)), (fit_id, user_id)
        per_user.append(
            {
                "fit_id": fit_id,
                "user_id": user_id,
                "realised": realised(user_id),
                "signals_only": sig,
                "with_arm_terms": cal,
                "cash_24h": cash_24h if paid_24h else 0.0,
                "conversion_only": p * scale_by_fit.get(fit_id, 0.0),
                "arm_create_image": arm_img,
                "arm_create_video": arm_vid,
            }
        )

    def block(units: list[dict], real_key: str, variants: list[str]) -> dict:
        real = [u[real_key] for u in units]
        return {name: metrics.summarize([u[name] for u in units], real, cap, REPLICATES, SEED) for name in variants}

    variants_24h = ["signals_only", "with_arm_terms", "cash_24h", "conversion_only"]
    score_24h = {
        "estimand": "unconditional E[90d profit per exposed user], scored at signup + 24h",
        "unit": "user of a backtest week (fit on earlier signup weeks)",
        "pooled": block(per_user, "realised", variants_24h),
        "by_week": {fit: block([u for u in per_user if u["fit_id"] == fit], "realised", variants_24h) for fit in weeks},
    }

    # arm-level prediction intervals (sampling + cross-fitted model error), coverage of the realised mean
    cells = []
    for fit_id in weeks:
        for flag, col in FLAGS.items():
            arm_col = "arm_create_image" if col == "arm_create_image" else "arm_create_video"
            by_arm: dict[str, list[dict]] = defaultdict(list)
            for u in per_user:
                if u["fit_id"] == fit_id and u[arm_col]:
                    by_arm[u[arm_col]].append(u)
            for arm, members in by_arm.items():
                preds = [u["signals_only"] for u in members]
                reals = [u["realised"] for u in members]
                n = len(preds)
                if n < 2:
                    continue
                sampling_var = pvariance(preds) * n / (n - 1) / n
                model_var = resid_var_by_fit.get(fit_id, 0.0) / max(1, len(train_by_fit.get(fit_id, [])))
                # model error of the arm mean: the residual variance scaled to this arm's n
                model_var_arm = resid_var_by_fit.get(fit_id, 0.0) / n
                half_sampling = Z * math.sqrt(sampling_var)
                half_full = Z * math.sqrt(sampling_var + model_var_arm)
                mp, mr = fmean(preds), fmean(reals)
                cells.append(
                    {
                        "fit_id": fit_id, "flag_key": flag, "arm": arm, "n": n,
                        "mean_predicted": mp, "mean_realised": mr,
                        "sampling_only_covers": abs(mp - mr) <= half_sampling,
                        "with_model_error_covers": abs(mp - mr) <= half_full,
                        "half_width_sampling": half_sampling, "half_width_with_model_error": half_full,
                        "_unused_model_var": model_var,
                    }
                )
    for c in cells:
        c.pop("_unused_model_var")
    arm_coverage = {
        "nominal": 0.95,
        "cells": len(cells),
        "sampling_only_coverage": fmean(c["sampling_only_covers"] for c in cells) if cells else math.nan,
        "with_model_error_coverage": fmean(c["with_model_error_covers"] for c in cells) if cells else math.nan,
        "detail": cells,
    }

    # ---------------------------------------------------------------- purchase value score, out of time
    rows_pvs = con.execute(
        f"""select s.fit_id, s.event_id, s.user_id, s.occurred_at, s.purchase_kind, s.predicted_profit_90d,
                   s.interval_low, s.interval_high, s.revenue_reporting
            from {I}.int_pvs__scores s
            where s.purpose = 'oot_test' and s.predicted_profit_90d is not null"""
    ).fetchall()
    train_pvs = con.execute(
        f"""select f.fit_id, o.user_id, o.occurred_at
            from {I}.int_pp__fit_sets f
            join {I}.int_pvs__features o on o.user_id = f.user_id
            join {I}.int_pvs__outcomes oc on oc.event_id = o.event_id
            where f.fit_kind = 'out_of_time' and oc.is_horizon_complete and not o.is_qa_account"""
    ).fetchall()
    train_mean_by_fit: dict[str, float] = {}
    for fit_id, group in _group(train_pvs, key=lambda r: r[0]).items():
        vals = [cohort.window(u, _utc(at), _utc(at) + cohort.horizon).profit_usd for _, u, at in group]
        train_mean_by_fit[fit_id] = fmean(vals) if vals else 0.0
    per_purchase = []
    for fit_id, event_id, user_id, occurred_at, kind, pred, lo, hi, revenue in rows_pvs:
        start = _utc(occurred_at)
        w = cohort.window(user_id, start, start + cohort.horizon)
        per_purchase.append(
            {
                "fit_id": fit_id, "event_id": event_id, "purchase_kind": kind,
                "realised": w.profit_usd, "purchase_value_score": pred,
                "first_charge_revenue": revenue, "training_mean": train_mean_by_fit.get(fit_id, 0.0),
                "interval_low": lo, "interval_high": hi,
                "covered": lo - 1e-9 <= w.profit_usd <= hi + 1e-9,
            }
        )
    variants_pvs = ["purchase_value_score", "first_charge_revenue", "training_mean"]
    score_pvs = {
        "estimand": "E[gross_profit_90d | purchase], scored at the purchase",
        "unit": "purchase by a user of a backtest week, with complete 90 days from the purchase",
        "pooled": block(per_purchase, "realised", variants_pvs),
        "by_week": {fit: block([u for u in per_purchase if u["fit_id"] == fit], "realised", variants_pvs) for fit in weeks},
        "by_kind": {kind: block([u for u in per_purchase if u["purchase_kind"] == kind], "realised", variants_pvs) for kind in sorted({u["purchase_kind"] for u in per_purchase})},
        "interval_coverage": {
            "nominal": float(v["pvs_interval_coverage"]),
            "realised": fmean(u["covered"] for u in per_purchase) if per_purchase else math.nan,
            "n": len(per_purchase),
            "mean_width": fmean(u["interval_high"] - u["interval_low"] for u in per_purchase) if per_purchase else math.nan,
        },
    }
    con.close()
    return metrics.clean(
        {
            "data_origin": "SYNTHETIC contracts cohort (2,000 users); realised outcomes computed in python_tests/truth.py",
            "protocol": "fit on signups before each test week (int_pp__fit_sets oot_<week>), score the week's users, evaluate on their complete 90 days",
            "weeks": {fit: {"test_week_start": str(s), "test_week_end": str(e), "users": n} for fit, (s, e, n) in weeks.items()},
            "capped_mae_cap_usd": cap,
            "bootstrap_replicates": REPLICATES,
            "score_24h": score_24h,
            "arm_readout_interval_coverage": arm_coverage,
            "purchase_value_score": score_pvs,
        }
    )


def _group(rows, key):
    out = defaultdict(list)
    for r in rows:
        out[key(r)].append(r)
    return out


def _fmt(x, digits=2) -> str:
    return "n/a" if x is None else f"{x:.{digits}f}"


def _ci(m: dict, name: str, digits=2) -> str:
    lo, hi = m[f"{name}_ci95"]
    return f"{_fmt(m[name], digits)} ({_fmt(lo, digits)} to {_fmt(hi, digits)})"


def _metric_table(block: dict, variants: list[str]) -> list[str]:
    lines = ["| predictor | n | mean predicted | mean realised | calib. slope (95% CI) | calib. intercept | top-decile lift | capped MAE $ |", "|---|---:|---:|---:|---|---|---|---|"]
    for name in variants:
        m = block[name]
        lines.append(f"| {name} | {m['n']} | {_fmt(m['mean_predicted'])} | {_fmt(m['mean_realised'])} | {_ci(m, 'calibration_slope')} | {_ci(m, 'calibration_intercept')} | {_ci(m, 'top_decile_lift')} | {_ci(m, 'capped_mae')} |")
    return lines


def _decile_table(m: dict) -> list[str]:
    lines = ["| decile | n | mean predicted | mean realised |", "|---:|---:|---:|---:|"]
    for d in m["deciles"]:
        lines.append(f"| {d['bin']} | {d['n']} | {_fmt(d['mean_predicted'])} | {_fmt(d['mean_realised'])} |")
    return lines


def write_report(report: dict) -> tuple[Path, Path]:
    out = WAREHOUSE / "target"
    out.mkdir(exist_ok=True)
    json_path = out / "oot_backtest_report.json"
    json_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    s24, pvs, cov = report["score_24h"], report["purchase_value_score"], report["arm_readout_interval_coverage"]
    lines = [
        "# Out-of-time backtest (SYNTHETIC cohort)",
        "",
        f"Data: {report['data_origin']}. Protocol: {report['protocol']}.",
        "Weeks: " + ", ".join(f"{w['test_week_start']} ({w['users']} users)" for w in report["weeks"].values()) + ".",
        f"Capped MAE cap ${report['capped_mae_cap_usd']:.0f}; 95% CIs from {report['bootstrap_replicates']} bootstrap resamples of units.",
        "",
        "These numbers describe how the estimators recover the synthetic generator's behaviour when fit on",
        "earlier signups only. They are not production accuracy: see docs/VALIDATION_PLAN.md.",
        "",
        "## Purchase value score (ad values): E[gross_profit_90d | purchase]",
        "",
        f"Unit: {pvs['unit']}. Pooled over the weeks:",
        "",
        *_metric_table(pvs["pooled"], ["purchase_value_score", "first_charge_revenue", "training_mean"]),
        "",
        "Decile calibration of the purchase value score (pooled):",
        "",
        *_decile_table(pvs["pooled"]["purchase_value_score"]),
        "",
        f"Interval coverage: {pvs['interval_coverage']['realised']:.1%} of {pvs['interval_coverage']['n']} matured purchases fall inside the score's interval "
        f"(nominal {pvs['interval_coverage']['nominal']:.0%}; mean width ${pvs['interval_coverage']['mean_width']:.2f}).",
        "",
        "By purchase kind (purchase value score):",
        "",
        "| kind | n | mean predicted | mean realised | calib. slope (95% CI) | capped MAE $ | first-charge baseline MAE $ |",
        "|---|---:|---:|---:|---|---|---|",
    ]
    for kind, b in pvs["by_kind"].items():
        m = b["purchase_value_score"]
        lines.append(f"| {kind} | {m['n']} | {_fmt(m['mean_predicted'])} | {_fmt(m['mean_realised'])} | {_ci(m, 'calibration_slope')} | {_ci(m, 'capped_mae')} | {_ci(b['first_charge_revenue'], 'capped_mae')} |")
    lines += [
        "",
        "Per week (purchase value score):",
        "",
        "| week | n | mean predicted | mean realised | calib. slope (95% CI) | capped MAE $ |",
        "|---|---:|---:|---:|---|---|",
    ]
    for fit, b in pvs["by_week"].items():
        m = b["purchase_value_score"]
        lines.append(f"| {report['weeks'][fit]['test_week_start']} | {m['n']} | {_fmt(m['mean_predicted'])} | {_fmt(m['mean_realised'])} | {_ci(m, 'calibration_slope')} | {_ci(m, 'capped_mae')} |")
    lines += [
        "",
        "## 24h score (experiment readouts): unconditional E[90d profit per exposed user]",
        "",
        f"Unit: {s24['unit']}. Pooled over the weeks (signals_only is what fct_predicted_profit_24h serves):",
        "",
        *_metric_table(s24["pooled"], ["signals_only", "with_arm_terms", "cash_24h", "conversion_only"]),
        "",
        "Decile calibration of the signals-only 24h score (pooled):",
        "",
        *_decile_table(s24["pooled"]["signals_only"]),
        "",
        "Per week (signals-only):",
        "",
        "| week | n | mean predicted | mean realised | calib. slope (95% CI) | top-decile lift | capped MAE $ |",
        "|---|---:|---:|---:|---|---|---|",
    ]
    for fit, b in s24["by_week"].items():
        m = b["signals_only"]
        lines.append(f"| {report['weeks'][fit]['test_week_start']} | {m['n']} | {_fmt(m['mean_predicted'])} | {_fmt(m['mean_realised'])} | {_ci(m, 'calibration_slope')} | {_ci(m, 'top_decile_lift')} | {_ci(m, 'capped_mae')} |")
    lines += [
        "",
        "## Arm-readout interval coverage",
        "",
        f"Over {cov['cells']} (week, flag, arm) cells, the 95% interval of the arm's mean 24h score covers the realised mean of the week's users "
        f"in {cov['with_model_error_coverage']:.0%} of cells with the cross-fitted model-error term (fct_experiment_profit_by_arm predicted_profit_ci_*) "
        f"and in {cov['sampling_only_coverage']:.0%} of cells treating predictions as independent draws (the old interval, predicted_profit_sampling_ci_*).",
        "",
    ]
    md_path = out / "oot_backtest_report.md"
    md_path.write_text("\n".join(lines), encoding="utf-8")
    return json_path, md_path


if __name__ == "__main__":
    rep = evaluate()
    paths = write_report(rep)
    print((WAREHOUSE / "target" / "oot_backtest_report.md").read_text(encoding="utf-8"))
    print(f"wrote {paths[0]} and {paths[1]}", file=sys.stderr)
