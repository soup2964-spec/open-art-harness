"""Every coefficient var is documented in dim_model_parameters with a label, and vice versa; the
FITTED rows exist for both scores, under one fitted_params_ref per run."""

from __future__ import annotations

from pathlib import Path

import yaml

WAREHOUSE = Path(__file__).resolve().parents[1]
COEFFICIENT_PREFIXES = (
    "pp_", "pvs_", "payment_fee", "affiliate_", "dispute_", "vendor_discount_pct", "failed_generation", "default_cost",
    "audience_", "trial_min", "attribution_clock", "ci_z", "readout_", "cuped_", "oot_", "reporting_currency", "bandit_value_cap",
    "holdout_key_pattern",
)
PLUMBING = {"pp_model_version", "pvs_model_version"}


def test_every_coefficient_is_registered(con):
    variables = yaml.safe_load((WAREHOUSE / "dbt_project.yml").read_text())["vars"]
    coefficients = {k for k in variables if k.startswith(COEFFICIENT_PREFIXES)} - PLUMBING
    current_ref = con.execute("select max(fitted_params_ref) from openart_signal_intermediate.int_model_parameters__current").fetchone()[0]
    rows = con.execute(
        "select parameter_name, label, fit_id from openart_signal_marts.dim_model_parameters where fitted_params_ref = ?", [current_ref]
    ).fetchall()
    registered = {name: label for name, label, _ in rows if label != "FITTED"}
    fitted = {name: fit for name, label, fit in rows if label == "FITTED"}
    assert coefficients - set(registered) == set(), "coefficient vars missing from model_parameter_registry()"
    assert set(registered) - set(variables) == set(), "registry lists vars that no longer exist"
    assert set(registered.values()) <= {"OBSERVED", "ILLUSTRATIVE", "CONFIG"}
    assert sum(1 for label in registered.values() if label == "ILLUSTRATIVE") >= 30
    # fitted values for both scores, for the reference fit and every serving fold
    assert any(n.startswith("fitted.all.segment_rate.") for n in fitted)
    assert any(n.startswith("fitted.xf0.pvs.renewal_prob.") for n in fitted)
    assert any(n.startswith("fitted.xf0.cost_per_credit.") for n in fitted)
    folds = int(variables["pp_crossfit_folds"])
    assert {f"xf{k}" for k in range(folds)} <= set(fitted.values())


def test_scores_reference_the_current_parameter_set(con):
    current_ref = con.execute("select max(fitted_params_ref) from openart_signal_intermediate.int_model_parameters__current").fetchone()[0]
    assert current_ref.startswith("dim_model_parameters@")
    for table in ("fct_predicted_profit_24h", "fct_purchase_value_score"):
        refs = con.execute(f"select distinct fitted_params_ref from openart_signal_marts.{table}").fetchall()
        assert refs == [(current_ref,)], table
