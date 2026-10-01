#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["tzdata>=2024.1"]
# ///
"""Generate the SYNTHETIC platform-side fixtures used by fct_reconciliation.

Nothing here comes from an ad platform. The files mimic what each platform would report
TODAY for the synthetic contracts cohort, given the tag behaviour observed in the research:

  * Google Ads x2 accounts: every new subscription checkout, first-invoice amount, same
    oid in both accounts (so summing the accounts double counts); stale list-price fallback
    value when the invoice lookup fails; click-date reporting.
  * Meta: first valid purchase only, valued at ltvValueMajor when present; nothing when the
    invoice lookup fails.
  * TikTok: first valid purchase only (LTV else amount).
  * Reddit / Microsoft UET: every checkout at the invoice amount.
  * LinkedIn: every checkout, no value.
  * X: every checkout counted twice (tw-qwghh-13vj24 plus the automatic gtm_purchase).

The per-platform rules (scope, value rule, events per purchase, click window, date basis,
account time zone) are read from seeds/platform_reporting_rules.csv: the same file the dbt
reconciliation reads, so the two independent implementations must agree to the cent.

Outputs (fixtures/synthetic/, every row carries data_origin = synthetic):
  invoice_lookups.jsonl          SYNTHETIC log of GET /legacy/api/stripe/checkout-session-invoice
                                 responses (shape: contracts invoice-lookup-response.schema.json)
  platform_daily_conversions.csv SYNTHETIC platform reports, one row per platform x account x
                                 report layer x report date
  MANIFEST.json                  parameters, input hashes and output hashes

ILLUSTRATIVE parameters (the only numbers not taken from the rules seed):
  LOOKUP_FAILURE_RATE   share of checkout returns whose invoice lookup fails (retry included)
  LTV_MULTIPLIER_MONTHLY  ltvValueMajor = first monthly invoice x 4.375; annual -> null.
                          Reproduces both examples in contracts fixtures/app_api/
                          checkout_session_invoice.json ($14 -> 61.25; Wonder annual -> null).

Usage: uv run scripts/make_platform_reports.py [--out DIR] [--check]
  --check  regenerate into a temp dir and fail if the committed files differ.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import sys
import tempfile
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

WAREHOUSE = Path(__file__).resolve().parents[1]
COHORT = WAREHOUSE.parent / "contracts" / "fixtures" / "cohort"
SEEDS = WAREHOUSE / "seeds"
DEFAULT_OUT = WAREHOUSE / "fixtures" / "synthetic"

GENERATOR_VERSION = "1.0.0"
LOOKUP_FAILURE_RATE = 0.05  # ILLUSTRATIVE
LTV_MULTIPLIER_MONTHLY = Decimal("4.375")  # ILLUSTRATIVE (see module docstring)
LOOKUP_DELAY_SECONDS = 3  # ILLUSTRATIVE: Stripe redirect -> Suite lookup request

INPUT_FILES = {
    "cohort/stripe_events.jsonl": COHORT / "stripe_events.jsonl",
    "cohort/amplitude_events.jsonl": COHORT / "amplitude_events.jsonl",
    "cohort/amplitude_exposures.jsonl": COHORT / "amplitude_exposures.jsonl",
    "seeds/platform_reporting_rules.csv": SEEDS / "platform_reporting_rules.csv",
    "seeds/fallback_price_table.csv": SEEDS / "fallback_price_table.csv",
    "seeds/plan_catalog.csv": SEEDS / "plan_catalog.csv",
}


def cents(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_jsonl(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as fh:
        return list(csv.DictReader(fh))


def lookup_fails(invoice_id: str) -> bool:
    """Deterministic ILLUSTRATIVE failure draw: first 32 bits of SHA-256 as a uniform."""
    digest = hashlib.sha256(f"invoice-lookup-failure|{invoice_id}".encode()).hexdigest()
    return int(digest[:8], 16) / 0xFFFFFFFF < LOOKUP_FAILURE_RATE


def iso_z(epoch_seconds: int) -> str:
    return datetime.fromtimestamp(epoch_seconds, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def local_date(ts: datetime, tz_name: str) -> str:
    return ts.astimezone(ZoneInfo(tz_name)).date().isoformat()


@dataclass(frozen=True)
class Purchase:
    """A subscription checkout (billing_reason subscription_create), the only purchase any tag sees."""

    invoice_id: str
    user_id: str
    paid_at: datetime
    amount_minor: int
    plan_tier: str
    billing_interval: str
    is_first_purchase: bool
    checkout_session_id: str | None
    checkout_completed_at: int | None


def load_purchases(stripe_events: list[dict], plan_prices: dict[str, dict[str, str]]) -> list[Purchase]:
    invoices: dict[str, dict] = {}
    sessions_by_invoice: dict[str, tuple[str, int]] = {}
    for event in sorted(stripe_events, key=lambda e: (e["created"], e["id"])):
        obj = event["data"]["object"]
        if event["type"] == "invoice.paid" and obj["id"] not in invoices:
            invoices[obj["id"]] = obj
        elif event["type"] == "checkout.session.completed" and obj.get("invoice"):
            sessions_by_invoice.setdefault(obj["invoice"], (obj["id"], event["created"]))

    paid = [inv for inv in invoices.values() if inv["status"] == "paid" and inv["amount_paid"] > 0]

    def paid_at(inv: dict) -> int:
        return (inv.get("status_transitions") or {}).get("paid_at") or inv["created"]

    first_invoice_by_user: dict[str, str] = {}
    for inv in sorted(paid, key=lambda i: (paid_at(i), i["id"])):
        first_invoice_by_user.setdefault(inv["customer"], inv["id"])

    purchases = []
    for inv in paid:
        if inv["billing_reason"] != "subscription_create":
            continue
        plan_lines = [
            line
            for line in inv["lines"]["data"]
            if line["amount"] > 0 and plan_prices.get(line["pricing"]["price_details"]["price"], {}).get("item_type") == "plan"
        ]
        if len(plan_lines) != 1:
            raise SystemExit(f"{inv['id']}: expected exactly one positive plan line, found {len(plan_lines)}")
        price = plan_prices[plan_lines[0]["pricing"]["price_details"]["price"]]
        session = sessions_by_invoice.get(inv["id"])
        purchases.append(
            Purchase(
                invoice_id=inv["id"],
                user_id=inv["customer"],
                paid_at=datetime.fromtimestamp(paid_at(inv), tz=timezone.utc),
                amount_minor=inv["amount_paid"],
                plan_tier=price["plan_tier"],
                billing_interval=price["billing_interval"],
                is_first_purchase=first_invoice_by_user[inv["customer"]] == inv["id"],
                checkout_session_id=session[0] if session else None,
                checkout_completed_at=session[1] if session else None,
            )
        )
    return sorted(purchases, key=lambda p: (p.paid_at, p.invoice_id))


def first_seen_click_ids(amplitude_rows: list[dict], keys: set[str]) -> dict[tuple[str, str], datetime]:
    """(user_id, click_id_key) -> first Amplitude event_time whose user_properties carry initial_<key>."""
    seen: dict[tuple[str, str], datetime] = {}
    for row in amplitude_rows:
        user = row.get("user_id")
        props = row.get("user_properties") or {}
        if not user:
            continue
        at = parse_iso(row["event_time"])
        for key in keys:
            if props.get(f"initial_{key}"):
                current = seen.get((user, key))
                if current is None or at < current:
                    seen[(user, key)] = at
    return seen


def build(out_dir: Path) -> dict[str, str]:
    stripe_events = read_jsonl(INPUT_FILES["cohort/stripe_events.jsonl"])
    amplitude_rows = read_jsonl(INPUT_FILES["cohort/amplitude_events.jsonl"]) + read_jsonl(
        INPUT_FILES["cohort/amplitude_exposures.jsonl"]
    )
    rules = read_csv(INPUT_FILES["seeds/platform_reporting_rules.csv"])
    fallback = {
        (r["plan_tier"], r["billing_interval"]): Decimal(r["fallback_value_usd"])
        for r in read_csv(INPUT_FILES["seeds/fallback_price_table.csv"])
    }
    plan_prices = {r["price_id"]: r for r in read_csv(INPUT_FILES["seeds/plan_catalog.csv"])}

    purchases = load_purchases(stripe_events, plan_prices)
    users_with_amplitude = {row["user_id"] for row in amplitude_rows if row.get("user_id")}
    click_keys = {key for rule in rules for key in rule["click_id_keys"].split("|")}
    clicks = first_seen_click_ids(amplitude_rows, click_keys)

    # ---- SYNTHETIC invoice lookup log (one request per return from a subscription Checkout)
    lookups: dict[str, dict] = {}
    lookup_rows = []
    for p in purchases:
        failed = lookup_fails(p.invoice_id)
        amount_major = Decimal(p.amount_minor) / 100
        ltv = cents(amount_major * LTV_MULTIPLIER_MONTHLY) if p.billing_interval == "month" else None
        response = None
        if not failed:
            response = {
                "invoiceId": p.invoice_id,
                "isFirstPurchase": p.is_first_purchase,
                "isValidInvoice": True,
                "isBusiness": False,
                "amountMinor": p.amount_minor,
                "amountMajor": float(amount_major),
                "currency": "usd",
                "ltvValueMajor": float(ltv) if ltv is not None else None,
                "ltvCurrency": "usd" if ltv is not None else None,
            }
        lookups[p.invoice_id] = {"ok": not failed, "ltv": ltv}
        requested = (p.checkout_completed_at or int(p.paid_at.timestamp())) + LOOKUP_DELAY_SECONDS
        lookup_rows.append(
            {
                "user_id": p.user_id,
                "checkout_session_id": p.checkout_session_id,
                "requested_at": iso_z(requested),
                "http_status": 502 if failed else 200,
                "response": response,
                "data_origin": "synthetic",
            }
        )

    # ---- SYNTHETIC platform reports
    totals: dict[tuple[str, str, str, str, str, str, str], list] = defaultdict(lambda: [0, Decimal("0")])
    for rule in rules:
        platform = rule["platform"]
        accounts = rule["account_ids"].split("|")
        events_per_purchase = int(rule["events_per_purchase"])
        if events_per_purchase % len(accounts):
            raise SystemExit(f"{platform}: events_per_purchase must split evenly across accounts")
        per_account = events_per_purchase // len(accounts)
        tz = rule["account_timezone"]
        window_seconds = int(rule["click_window_days"]) * 86_400
        keys = rule["click_id_keys"].split("|")
        attribution = f"{rule['click_window_days']}d_click"
        for p in purchases:
            if rule["scope"] == "first_valid_purchase" and not p.is_first_purchase:
                continue
            if p.user_id not in users_with_amplitude:  # blocker proxy: browser tags never ran
                continue
            lookup = lookups[p.invoice_id]
            if not lookup["ok"] and rule["accepts_fallback_value"] != "true":
                continue
            amount = Decimal(p.amount_minor) / 100
            if rule["value_rule"] == "none":
                value = Decimal("0")
            elif not lookup["ok"]:
                value = fallback[(p.plan_tier, p.billing_interval)]
            elif rule["value_rule"] == "ltv_else_amount" and lookup["ltv"] is not None:
                value = lookup["ltv"]
            else:
                value = amount
            value = cents(value)

            def add(layer: str, basis: str, report_date: str, setting: str) -> None:
                for account in accounts:
                    bucket = totals[(platform, account, layer, basis, tz, report_date, setting)]
                    bucket[0] += per_account
                    bucket[1] += value * per_account

            add("tag_received", "conversion", local_date(p.paid_at, tz), "none")

            candidate_clicks = [clicks[(p.user_id, k)] for k in keys if (p.user_id, k) in clicks]
            candidate_clicks = [c for c in candidate_clicks if c <= p.paid_at]
            if not candidate_clicks:
                continue
            click_at = max(candidate_clicks)
            if (p.paid_at - click_at).total_seconds() > window_seconds:
                continue
            basis_ts = click_at if rule["date_basis"] == "click" else p.paid_at
            add("ads_attributed", rule["date_basis"], local_date(basis_ts, tz), attribution)

    out_dir.mkdir(parents=True, exist_ok=True)
    lookups_path = out_dir / "invoice_lookups.jsonl"
    lookups_path.write_text(
        "".join(json.dumps(r, sort_keys=True, separators=(",", ":")) + "\n" for r in lookup_rows), encoding="utf-8"
    )

    report_path = out_dir / "platform_daily_conversions.csv"
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(
        [
            "platform",
            "account_id",
            "report_layer",
            "date_basis",
            "account_timezone",
            "report_date",
            "attribution_setting",
            "conversions",
            "conversion_value",
            "currency",
            "data_origin",
        ]
    )
    for key in sorted(totals):
        platform, account, layer, basis, tz, report_date, setting = key
        conversions, value = totals[key]
        writer.writerow([platform, account, layer, basis, tz, report_date, setting, conversions, f"{value:.2f}", "USD", "synthetic"])
    report_path.write_text(buf.getvalue(), encoding="utf-8")

    manifest = {
        "data_origin": "SYNTHETIC - generated from the contracts cohort; no ad platform or OpenArt data",
        "generator": "packages/warehouse/scripts/make_platform_reports.py",
        "generator_version": GENERATOR_VERSION,
        "illustrative_parameters": {
            "LOOKUP_FAILURE_RATE": LOOKUP_FAILURE_RATE,
            "LTV_MULTIPLIER_MONTHLY": str(LTV_MULTIPLIER_MONTHLY),
            "LOOKUP_DELAY_SECONDS": LOOKUP_DELAY_SECONDS,
        },
        "rules_seed": "seeds/platform_reporting_rules.csv (shared with dbt fct_reconciliation)",
        "inputs": {name: sha256_file(path) for name, path in sorted(INPUT_FILES.items())},
        "outputs": {
            "invoice_lookups.jsonl": sha256_file(lookups_path),
            "platform_daily_conversions.csv": sha256_file(report_path),
        },
        "counts": {
            "subscription_checkouts": len(purchases),
            "invoice_lookups_failed": sum(1 for r in lookup_rows if r["http_status"] != 200),
            "report_rows": len(totals),
        },
    }
    (out_dir / "MANIFEST.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return {name: sha256_file(out_dir / name) for name in ("invoice_lookups.jsonl", "platform_daily_conversions.csv", "MANIFEST.json")}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--check", action="store_true", help="fail if committed outputs differ from a fresh build")
    args = parser.parse_args()
    if args.check:
        with tempfile.TemporaryDirectory() as tmp:
            fresh = build(Path(tmp))
        committed = {name: sha256_file(args.out / name) if (args.out / name).exists() else None for name in fresh}
        stale = sorted(name for name in fresh if fresh[name] != committed[name])
        if stale:
            print(f"stale synthetic fixtures (re-run scripts/make_platform_reports.py): {', '.join(stale)}", file=sys.stderr)
            return 1
        print("synthetic platform fixtures are up to date")
        return 0
    hashes = build(args.out)
    for name, digest in hashes.items():
        print(f"wrote {args.out / name}  sha256={digest[:12]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
