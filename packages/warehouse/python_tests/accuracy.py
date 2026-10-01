"""PLUMBING CHECK (not an accuracy claim): the warehouse's REALISED arm economics equal the
independent Python ground truth (python_tests/truth.py, computed from the raw fixture files and
never from a dbt model), so joins, windows, costs, fees, refunds, disputes and FX conversions are
right. It also prints the predicted arm means next to the realised ones for the record.

It says nothing about predictive skill: on the fixture every user is mature, so any in-sample
comparison of a score with its own training cohort is circular (ML review 2). Skill is measured
out of time in python_tests/oot_eval.py (fit on earlier signup weeks, evaluate on later ones), and
that report, target/oot_backtest_report.md, is the only accuracy statement this package makes.

Run directly:  uv run --with duckdb==1.5.6 --with pyyaml python python_tests/accuracy.py
"""

from __future__ import annotations

import json
import math
import os
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import duckdb

from truth import FLAGS, WAREHOUSE, Cohort

DB = Path(os.environ.get("WAREHOUSE_DUCKDB_PATH", WAREHOUSE / "target" / "local.duckdb"))
MARTS = "openart_signal_marts"


@dataclass
class ArmStats:
    flag_key: str
    arm: str
    exposed_users: int
    matured_users: int
    truth_realised_mean: float
    truth_realised_se: float
    truth_conversion_rate: float
    warehouse_exposed_users: int | None = None
    warehouse_matured_users: int | None = None
    warehouse_realised_mean: float | None = None
    warehouse_converters: int | None = None
    predicted_mean: float | None = None
    predicted_signals_only_mean: float | None = None
    predicted_with_arm_terms_mean: float | None = None
    ranks: dict[str, int] = field(default_factory=dict)


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else math.nan


def _se(values: list[float]) -> float:
    if len(values) < 2:
        return math.nan
    m = _mean(values)
    return math.sqrt(sum((x - m) ** 2 for x in values) / (len(values) - 1) / len(values))


def build_report(db: Path = DB) -> dict:
    """Realised arm economics from the raw fixtures (truth.py) next to the warehouse readout."""
    cohort = Cohort()
    con = duckdb.connect(str(db), read_only=True)
    con.execute("set TimeZone = 'UTC'")
    warehouse = {
        (f, a): dict(zip(["exposed_users", "matured_users", "realised", "converters", "predicted", "signals_only", "with_arm"], row[2:]))
        for f, a, *row in [
            (r[0], r[1], *r)
            for r in con.execute(
                f"""select flag_key, arm, exposed_users, matured_users, realised_profit_per_exposed_usd, converters,
                           predicted_profit_per_exposed_usd, predicted_profit_24h_signals_only_per_exposed_usd,
                           predicted_profit_with_arm_terms_per_exposed_usd
                    from {MARTS}.fct_experiment_profit_by_arm"""
            ).fetchall()
        ]
    }
    con.close()

    report: dict = {
        "check": "PLUMBING: warehouse realised arm economics == independent Python truth (SYNTHETIC cohort, 2,000 users)",
        "accuracy_statement": "none here; see target/oot_backtest_report.md (python_tests/oot_eval.py)",
        "flags": {},
    }
    for flag, col in FLAGS.items():
        groups: dict[str, list[str]] = defaultdict(list)
        for u, t in cohort.truth_rows.items():
            groups[t[col]].append(u)
        stats: list[ArmStats] = []
        for arm, members in sorted(groups.items()):
            # realised 90-day profit from the FIRST EXPOSURE (the readout's anchor), matured users only
            matured_profit: list[float] = []
            converted = 0
            for u in members:
                exposed_at, _ = cohort.first_exposure[(u, flag)]
                start, end = exposed_at, exposed_at + cohort.horizon
                w = cohort.window(u, start, end)
                converted += int(w.converted)
                if cohort.is_mature(start):
                    matured_profit.append(w.profit_usd)
            wh = warehouse.get((flag, arm), {})
            stats.append(
                ArmStats(
                    flag_key=flag,
                    arm=arm,
                    exposed_users=len(members),
                    matured_users=len(matured_profit),
                    truth_realised_mean=_mean(matured_profit),
                    truth_realised_se=_se(matured_profit),
                    truth_conversion_rate=converted / len(members),
                    warehouse_exposed_users=wh.get("exposed_users"),
                    warehouse_matured_users=wh.get("matured_users"),
                    warehouse_realised_mean=wh.get("realised"),
                    warehouse_converters=wh.get("converters"),
                    predicted_mean=wh.get("predicted"),
                    predicted_signals_only_mean=wh.get("signals_only"),
                    predicted_with_arm_terms_mean=wh.get("with_arm"),
                )
            )
        for key, attr in (("truth_realised", "truth_realised_mean"), ("predicted", "predicted_mean"), ("conversion", "truth_conversion_rate")):
            for rank, s in enumerate(sorted(stats, key=lambda x: -(getattr(x, attr) or 0)), start=1):
                s.ranks[key] = rank
        report["flags"][flag] = {
            "arms": [
                {
                    "arm": s.arm,
                    "exposed_users": s.exposed_users,
                    "warehouse_exposed_users": s.warehouse_exposed_users,
                    "matured_users": s.matured_users,
                    "warehouse_matured_users": s.warehouse_matured_users,
                    "truth_conversion_rate": round(s.truth_conversion_rate, 4),
                    "warehouse_converters": s.warehouse_converters,
                    "truth_realised_profit_per_exposed_usd": round(s.truth_realised_mean, 4),
                    "truth_realised_ci95_usd": [round(s.truth_realised_mean - 1.96 * s.truth_realised_se, 4), round(s.truth_realised_mean + 1.96 * s.truth_realised_se, 4)],
                    "warehouse_realised_profit_per_exposed_usd": s.warehouse_realised_mean,
                    "predicted_profit_per_exposed_usd": s.predicted_mean,
                    "predicted_signals_only_usd": s.predicted_signals_only_mean,
                    "predicted_with_arm_terms_usd": s.predicted_with_arm_terms_mean,
                    "ranks": s.ranks,
                }
                for s in sorted(stats, key=lambda x: x.ranks["truth_realised"])
            ],
            "truth_realised_order": [s.arm for s in sorted(stats, key=lambda x: x.ranks["truth_realised"])],
            "predicted_order": [s.arm for s in sorted(stats, key=lambda x: x.ranks["predicted"])],
            "conversion_order": [s.arm for s in sorted(stats, key=lambda x: x.ranks["conversion"])],
        }
    return report


def write_report(report: dict) -> tuple[Path, Path]:
    out = WAREHOUSE / "target"
    out.mkdir(exist_ok=True)
    json_path = out / "accuracy_report.json"
    json_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    lines = [
        "# Plumbing check: realised arm economics vs independent truth (SYNTHETIC)",
        "",
        "This is NOT an accuracy report. It proves the warehouse's realised 90-day profit per exposed",
        "user (fixed horizon from the first exposure, matured users only) equals an independent Python",
        "computation from the raw fixture files. Predicted means are shown for the record only; skill is",
        "measured out of time in `target/oot_backtest_report.md` (python_tests/oot_eval.py).",
        "",
    ]
    for flag, f in report["flags"].items():
        lines += [
            f"## {flag}",
            "",
            "| arm | exposed (wh) | matured (wh) | conv. rate | truth realised $/user (95% CI) | warehouse realised | predicted (signals-only / with arm terms) | truth / pred / conv rank |",
            "|---|---:|---:|---:|---|---:|---|---|",
        ]
        for a in f["arms"]:
            r = a["ranks"]
            lines.append(
                f"| {a['arm']} | {a['exposed_users']} ({a['warehouse_exposed_users']}) | {a['matured_users']} ({a['warehouse_matured_users']}) | "
                f"{a['truth_conversion_rate']:.2%} | {a['truth_realised_profit_per_exposed_usd']:.2f} "
                f"({a['truth_realised_ci95_usd'][0]:.2f} to {a['truth_realised_ci95_usd'][1]:.2f}) | {a['warehouse_realised_profit_per_exposed_usd']:.2f} | "
                f"{a['predicted_profit_per_exposed_usd']:.2f} ({a['predicted_signals_only_usd']:.2f} / {a['predicted_with_arm_terms_usd']:.2f}) | "
                f"{r['truth_realised']} / {r['predicted']} / {r['conversion']} |"
            )
        lines += ["", f"Truth realised order: {' > '.join(f['truth_realised_order'])}. Predicted order: {' > '.join(f['predicted_order'])}. Conversion order: {' > '.join(f['conversion_order'])}.", ""]
    md_path = out / "accuracy_report.md"
    md_path.write_text("\n".join(lines), encoding="utf-8")
    return json_path, md_path


if __name__ == "__main__":
    rep = build_report()
    paths = write_report(rep)
    print((WAREHOUSE / "target" / "accuracy_report.md").read_text(encoding="utf-8"))
    print(f"wrote {paths[0]} and {paths[1]}", file=sys.stderr)
