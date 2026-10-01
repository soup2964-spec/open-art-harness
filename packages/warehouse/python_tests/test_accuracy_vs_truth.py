"""PLUMBING check against the SYNTHETIC cohort ground truth (python_tests/truth.py), computed
independently from the raw fixture files.

1. The warehouse's REALISED arm economics (fixed 90-day horizon from the first exposure, matured
   users only) equal the independent Python truth to the cent: joins, windows, costs, fees,
   refunds, disputes, FX.
2. Exposed and matured user counts equal the truth's (intention to treat: everyone exposed).
3. The purchase value score's realised outcomes (int_pvs__outcomes) equal the truth per purchase.

No assertion here concerns predictive skill: that is python_tests/test_oot_eval.py, out of time.
"""

from __future__ import annotations

import accuracy
from truth import Cohort


def test_realised_arm_economics_match_the_independent_truth(con):  # noqa: ARG001
    report = accuracy.build_report()
    accuracy.write_report(report)
    for flag, f in report["flags"].items():
        for arm in f["arms"]:
            assert arm["warehouse_exposed_users"] == arm["exposed_users"], (flag, arm["arm"])
            assert arm["warehouse_matured_users"] == arm["matured_users"], (flag, arm["arm"])
            assert arm["warehouse_realised_profit_per_exposed_usd"] is not None, (flag, arm["arm"])
            assert abs(arm["warehouse_realised_profit_per_exposed_usd"] - arm["truth_realised_profit_per_exposed_usd"]) < 0.005, (flag, arm)
            assert arm["predicted_profit_per_exposed_usd"] is not None


def test_purchase_outcomes_match_the_independent_truth(con):
    cohort = Cohort()
    rows = con.execute(
        """select o.event_id, o.user_id, o.occurred_at, o.realized_profit_90d, o.realized_revenue_90d, o.is_horizon_complete
           from openart_signal_intermediate.int_pvs__outcomes o
           join openart_signal_marts.fct_conversion_ledger l using (event_id)
           where not l.is_qa_account"""
    ).fetchall()
    assert len(rows) > 200
    checked = 0
    for event_id, user_id, occurred_at, profit, revenue, complete in rows:
        if not complete:
            continue
        start = occurred_at.replace(tzinfo=cohort.as_of.tzinfo)
        w = cohort.window(user_id, start, start + cohort.horizon)
        assert abs(w.gross_usd - revenue) < 0.005, (event_id, w.gross_usd, revenue)
        assert abs(w.profit_usd - profit) < 0.005, (event_id, w.profit_usd, profit)
        checked += 1
    assert checked > 40
