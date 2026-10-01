"""Independent ground truth for the SYNTHETIC contracts cohort, computed in plain Python from the raw
fixture files (Stripe events, credit ledger, Amplitude exposures, cohort_truth.jsonl,
model_costs.csv), never from a dbt model, so it can catch errors anywhere in the warehouse.
Parameters shared with the warehouse (fees, discounts, horizon, as-of) come from dbt_project.yml.

    profit over [start, end) = gross revenue of the user's purchases in the window
                               - their refunds / chargebacks that happened in the window (and by as-of)
                               - serving cost of the user's generations in the window
                               - payment fee % x gross + fixed fee per charge
                               - affiliate commission x gross (affiliate users) - dispute fee per chargeback

A dispute takes only what earlier refunds left of the charge, and a won dispute takes nothing (the
same economic rule the ledger applies, implemented separately here). The fixtures are USD with no
tax, so gross = tax-exclusive revenue.
"""

from __future__ import annotations

import csv
import json
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from functools import cached_property
from pathlib import Path

import yaml

WAREHOUSE = Path(__file__).resolve().parents[1]
CONTRACTS = WAREHOUSE.parent / "contracts" / "fixtures"
COHORT = CONTRACTS / "cohort"
FLAGS = {"suite-default-model-create-image": "arm_create_image", "suite-default-model-create-video": "arm_create_video"}


def project_vars() -> dict:
    return yaml.safe_load((WAREHOUSE / "dbt_project.yml").read_text(encoding="utf-8"))["vars"]


def parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def read_jsonl(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


@dataclass(frozen=True)
class Purchase:
    user_id: str
    at: datetime
    cents: int
    key: str  # invoice id, or the Checkout Session id of an invoice-less one-time pack
    event_id: str
    subscription_id: str | None


@dataclass(frozen=True)
class MoneyOut:
    key: str
    at: datetime
    cents: int
    is_chargeback: bool


@dataclass
class Window:
    gross_usd: float = 0.0
    adjustments_usd: float = 0.0
    cost_usd: float = 0.0
    fees_usd: float = 0.0
    charges: int = 0
    converted: bool = False

    @property
    def profit_usd(self) -> float:
        return self.gross_usd - self.adjustments_usd - self.cost_usd - self.fees_usd


@dataclass
class Cohort:
    """The raw fixture cohort, parsed once."""

    vars: dict = field(default_factory=project_vars)

    @cached_property
    def as_of(self) -> datetime:
        return datetime.fromisoformat(self.vars["fixture_as_of_timestamp"]).replace(tzinfo=timezone.utc)

    @cached_property
    def horizon(self) -> timedelta:
        return timedelta(days=int(self.vars["pp_horizon_days"]))

    @cached_property
    def truth_rows(self) -> dict[str, dict]:
        return {t["user_id"]: t for t in read_jsonl(COHORT / "cohort_truth.jsonl")}

    @cached_property
    def signup(self) -> dict[str, datetime]:
        return {u: parse_ts(t["signup_at"]) for u, t in self.truth_rows.items()}

    @cached_property
    def _stripe(self) -> tuple[list[Purchase], list[MoneyOut]]:
        events = sorted(read_jsonl(COHORT / "stripe_events.jsonl"), key=lambda e: (e["created"], e["id"]))
        purchases: list[Purchase] = []
        payment_intent_to_key: dict[str, str] = {}
        # a pack Checkout with invoice_creation also emits invoice.paid: it is one purchase
        pack_invoices = {e["data"]["object"].get("invoice") for e in events if e["type"] == "checkout.session.completed" and e["data"]["object"]["mode"] == "payment"} - {None}
        seen: set[str] = set(pack_invoices)
        for e in events:
            o = e["data"]["object"]
            if e["type"] == "invoice.paid" and o["amount_paid"] > 0 and o["id"] not in seen:
                seen.add(o["id"])
                paid = (o.get("status_transitions") or {}).get("paid_at") or o["created"]
                sub = ((o.get("parent") or {}).get("subscription_details") or {}).get("subscription") or o.get("subscription")
                purchases.append(Purchase(o["customer"], datetime.fromtimestamp(paid, timezone.utc), o["amount_paid"], o["id"], f"purchase_{o['id']}", sub))
            elif e["type"] == "checkout.session.completed" and o["mode"] == "payment" and o["id"] not in seen and o["amount_total"] > 0:
                seen.add(o["id"])
                key = o.get("invoice") or o["id"]
                purchases.append(Purchase(o["customer"], datetime.fromtimestamp(e["created"], timezone.utc), o["amount_total"], key, f"purchase_{key}", None))
                payment_intent_to_key[o["payment_intent"]] = key
            elif e["type"] == "invoice_payment.paid":
                payment_intent_to_key[o["payment"]["payment_intent"]] = o["invoice"]
        charge_cents = {p.key: p.cents for p in purchases}
        won = {e["data"]["object"]["id"] for e in events if e["type"].startswith("charge.dispute.") and e["data"]["object"].get("status") == "won"}
        out: list[MoneyOut] = []
        cumulative: dict[str, int] = defaultdict(int)
        taken: dict[str, int] = defaultdict(int)
        for e in events:
            o = e["data"]["object"]
            at = datetime.fromtimestamp(e["created"], timezone.utc)
            if at > self.as_of:
                continue
            if e["type"] == "charge.refunded":
                key = payment_intent_to_key[o["payment_intent"]]
                step = max(o["amount_refunded"] - cumulative[o["id"]], 0)
                cumulative[o["id"]] = max(cumulative[o["id"]], o["amount_refunded"])
                if step:
                    out.append(MoneyOut(key, at, step, False))
                    taken[key] += step
            elif e["type"] == "charge.dispute.created" and o["id"] not in won and not str(o.get("status", "")).startswith("warning"):
                key = payment_intent_to_key[o["payment_intent"]]
                amount = min(o["amount"], max(charge_cents[key] - taken[key], 0))
                if amount:
                    out.append(MoneyOut(key, at, amount, True))
                    taken[key] += amount
        return purchases, out

    @property
    def purchases(self) -> list[Purchase]:
        return self._stripe[0]

    @property
    def money_out(self) -> list[MoneyOut]:
        return self._stripe[1]

    @cached_property
    def purchases_by_user(self) -> dict[str, list[Purchase]]:
        by: dict[str, list[Purchase]] = defaultdict(list)
        for p in self.purchases:
            by[p.user_id].append(p)
        return by

    @cached_property
    def money_out_by_key(self) -> dict[str, list[MoneyOut]]:
        by: dict[str, list[MoneyOut]] = defaultdict(list)
        for m in self.money_out:
            by[m.key].append(m)
        return by

    @cached_property
    def first_subscription(self) -> dict[str, datetime]:
        """First subscription purchase (invoice billing_reason subscription_create) per user."""
        firsts: dict[str, datetime] = {}
        for e in read_jsonl(COHORT / "stripe_events.jsonl"):
            o = e["data"]["object"]
            if e["type"] == "invoice.paid" and o.get("billing_reason") == "subscription_create" and o["amount_paid"] > 0:
                paid = datetime.fromtimestamp((o.get("status_transitions") or {}).get("paid_at") or o["created"], timezone.utc)
                if o["customer"] not in firsts or paid < firsts[o["customer"]]:
                    firsts[o["customer"]] = paid
        return firsts

    @cached_property
    def generations_by_user(self) -> dict[str, list[tuple[datetime, float]]]:
        v = self.vars
        if v.get("vendor_discounts"):
            raise SystemExit("truth assumes vendor_discounts is empty (global vendor_discount_pct only)")
        discount, failed_share = float(v["vendor_discount_pct"]), float(v["failed_generation_cost_share"])
        list_cost: dict[tuple[str, int], float] = {}
        with (CONTRACTS / "seeds" / "model_costs.csv").open(encoding="utf-8", newline="") as fh:
            for row in csv.DictReader(fh):
                if row["list_cost_usd"]:
                    list_cost.setdefault((row["business_type"], int(row["credits"])), float(row["list_cost_usd"]))
        ledger = read_jsonl(COHORT / "credit_ledger.jsonl")
        refunded = {(x["userId"], x["reference"]["businessType"], x["reference"]["businessId"]) for x in ledger if x["type"] == "REFUND"}
        by: dict[str, list[tuple[datetime, float]]] = defaultdict(list)
        for x in ledger:
            if x["type"] != "CONSUME":
                continue
            share = failed_share if (x["userId"], x["reference"]["businessType"], x["reference"]["businessId"]) in refunded else 1.0
            cost = sum(list_cost[(x["reference"]["businessType"], d["unitCredits"])] * d["quantity"] for d in x["businessDetails"])
            by[x["userId"]].append((parse_ts(x["createdAt"]), cost * (1 - discount) * share))
        return by

    @cached_property
    def first_exposure(self) -> dict[tuple[str, str], tuple[datetime, str]]:
        """(user, flag) -> (first $exposure time, arm) from the raw Amplitude exposures."""
        first: dict[tuple[str, str], tuple[datetime, str]] = {}
        for r in read_jsonl(COHORT / "amplitude_exposures.jsonl"):
            if r["event_type"] != "$exposure" or not r.get("user_id"):
                continue
            key = (r["user_id"], r["event_properties"]["flag_key"])
            at = parse_ts(r["event_time"])
            if key not in first or at < first[key][0]:
                first[key] = (at, r["event_properties"]["variant"])
        return first

    def window(self, user_id: str, start: datetime, end: datetime) -> Window:
        """Realised money of one user over [start, end) (adjustments also bounded by as-of)."""
        v = self.vars
        fee_pct, fee_fixed = float(v["payment_fee_pct"]), float(v["payment_fee_fixed_usd"])
        affiliate_pct, dispute_fee = float(v["affiliate_commission_pct"]), float(v["dispute_fee_usd"])
        w = Window()
        chargebacks = 0
        for p in self.purchases_by_user.get(user_id, []):
            if not (start <= p.at < end):
                continue
            w.gross_usd += p.cents / 100
            w.charges += 1
            for m in self.money_out_by_key.get(p.key, []):
                if m.at < end and m.at <= self.as_of:
                    w.adjustments_usd += m.cents / 100
                    chargebacks += int(m.is_chargeback)
        w.cost_usd = sum(c for at, c in self.generations_by_user.get(user_id, []) if start <= at < end)
        affiliate = self.truth_rows.get(user_id, {}).get("channel") == "affiliate"
        w.fees_usd = w.gross_usd * fee_pct + w.charges * fee_fixed + (w.gross_usd * affiliate_pct if affiliate else 0) + chargebacks * dispute_fee
        first_sub = self.first_subscription.get(user_id)
        w.converted = first_sub is not None and start <= first_sub < end
        return w

    def signup_window(self, user_id: str) -> tuple[datetime, datetime]:
        s = self.signup[user_id]
        return s, s + self.horizon

    def is_mature(self, start: datetime) -> bool:
        return start + self.horizon <= self.as_of
