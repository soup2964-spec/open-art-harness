"""Run the week-1 sizing queries (docs/week1-sizing-queries.md) on the synthetic fixtures.

Every ```sql block is ported to DuckDB by week1_port (sqlglot, BigQuery -> DuckDB) and executed
against the raw fixture relations only: raw_amplitude.events, raw_app.credit_ledger,
raw_stripe.events (as a TEMP view shaped like Stripe's `invoices` table) and the model_costs seed.
The expected values are recomputed here in plain Python from the files scripts/load_fixtures.py
loads (packages/contracts/fixtures), and checked against cohort_truth.jsonl where it has the
answer. Nothing reads a dbt staging, intermediate or mart relation.
"""

from __future__ import annotations

import csv
import json
import re
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from functools import cache
from pathlib import Path

import pytest
import sqlglot
from sqlglot import exp

import week1_port as wk1

FIXTURES = wk1.WAREHOUSE.parent / "contracts" / "fixtures"
# SYNTHETIC rows the warehouse adds for the contracts' scenario users (fixtures/scenario_users/README.md)
SCENARIO = wk1.WAREHOUSE / "fixtures" / "scenario_users"
IMAGE, VIDEO = FLAGS = ("suite-default-model-create-image", "suite-default-model-create-video")
HOUR, DAY = timedelta(hours=1), timedelta(days=1)
AMPLITUDE = "`YOUR_PROJECT.amplitude.EVENTS_YOUR_AMPLITUDE_PROJECT_ID`"
MODEL_COSTS = "`YOUR_PROJECT.openart_signal_seeds.model_costs`"

BLOCKS = wk1.sql_blocks()
DOC = " ".join(wk1.doc_text().split())  # prose with line breaks folded, for quoted numbers


def ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def utc(value: str) -> datetime:
    return datetime.fromisoformat(value).replace(tzinfo=timezone.utc)


def epoch(seconds: int) -> datetime:
    return datetime.fromtimestamp(seconds, timezone.utc)


AS_OF = utc(wk1.AS_OF)


def cohort_range(name: str, overrides: dict[str, str] | None = None) -> tuple[datetime, datetime]:
    """The block's [cohort_start, cohort_end) (DECLARE defaults, then overrides) as UTC datetimes."""
    declared = {**wk1.declared(BLOCKS[name]), **(overrides or {})}
    start, end = (re.fullmatch(r"TIMESTAMP\('([^']+)'\)", declared[k]).group(1) for k in ("cohort_start", "cohort_end"))
    return utc(start), utc(end)


def close(actual: float | None, expected: float, decimals: int) -> bool:
    """The query ROUNDs to `decimals`; the expectation is unrounded."""
    return actual is not None and abs(actual - expected) <= 0.5 * 10**-decimals + 1e-9


# ------------------------------------------------------------------ raw fixture files


def read_jsonl(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


@cache
def amplitude_events() -> tuple[dict, ...]:
    paths = [
        *sorted((FIXTURES / "amplitude").glob("*.jsonl")),
        FIXTURES / "cohort" / "amplitude_events.jsonl",
        FIXTURES / "cohort" / "amplitude_exposures.jsonl",
        SCENARIO / "amplitude_events.jsonl",
    ]
    rows = [row for path in paths for row in read_jsonl(path)]
    for row in rows:
        row["_t"] = ts(row["event_time"])
    return tuple(rows)


@cache
def ledger_entries() -> tuple[dict, ...]:
    rows = [
        entry
        for path in sorted((FIXTURES / "credit_ledger").glob("*.json"))
        for entry in json.loads(path.read_text(encoding="utf-8"))["entries"]
    ]
    return tuple(rows + read_jsonl(FIXTURES / "cohort" / "credit_ledger.jsonl"))


@cache
def stripe_events() -> tuple[dict, ...]:
    rows = [e for path in sorted((FIXTURES / "stripe").glob("*.json")) for e in json.loads(path.read_text(encoding="utf-8"))]
    return tuple(rows + read_jsonl(FIXTURES / "cohort" / "stripe_events.jsonl"))


@cache
def cohort_truth() -> dict[str, dict]:
    return {row["user_id"]: row for row in read_jsonl(FIXTURES / "cohort" / "cohort_truth.jsonl")}


@cache
def model_cost_rows() -> tuple[dict, ...]:
    with (FIXTURES / "seeds" / "model_costs.csv").open(encoding="utf-8", newline="") as fh:
        return tuple(csv.DictReader(fh))


@cache
def list_costs() -> dict[tuple[str, int], float | None]:
    """Highest list cost per (capability, credits), as Q4's `costs` CTE keeps it (None: no price)."""
    out: dict[tuple[str, int], float | None] = {}
    for row in model_cost_rows():
        key = (row["business_type"], int(row["credits"]))
        prices = [p for p in (out.get(key), float(row["list_cost_usd"]) if row["list_cost_usd"] else None) if p is not None]
        out[key] = max(prices) if prices else None
    return out


@cache
def invoices() -> tuple[dict, ...]:
    """What Stripe's `invoices` table holds: the latest invoice.paid state of each invoice."""
    latest: dict[str, tuple[tuple, dict]] = {}
    for event in stripe_events():
        if event["type"] != "invoice.paid" or not event["livemode"]:
            continue
        invoice = event["data"]["object"]
        order = (event["created"], event["id"])
        if invoice["id"] not in latest or order > latest[invoice["id"]][0]:
            latest[invoice["id"]] = (order, invoice)
    return tuple(invoice for _, invoice in latest.values())


@cache
def signups() -> dict[str, datetime]:
    """user -> trial grant time (the ledger's USER_SIGNUP_TRIAL ADD)."""
    out: dict[str, datetime] = {}
    for entry in ledger_entries():
        if entry["type"] == "ADD" and (entry.get("reference") or {}).get("businessType") == "USER_SIGNUP_TRIAL":
            at = ts(entry["createdAt"])
            out[entry["userId"]] = min(at, out.get(entry["userId"], at))
    return out


def cohort(start: datetime, end: datetime, follow: timedelta, as_of: datetime = AS_OF) -> dict[str, datetime]:
    return {u: at for u, at in signups().items() if start <= at < end and at + follow <= as_of}


# ------------------------------------------------------------------ independent expectations


def expected_q4(start: datetime, end: datetime, as_of: datetime = AS_OF) -> dict[tuple[str, str], dict]:
    members = cohort(start, end, 31 * DAY, as_of)
    first: dict[tuple[str, str], tuple[tuple, str]] = {}
    for event in amplitude_events():
        user = event.get("user_id")
        if user not in members or not members[user] <= event["_t"] < members[user] + 30 * DAY:
            continue
        candidates = []
        if event["event_type"] == "$exposure":
            props = event.get("event_properties") or {}
            candidates.append((props.get("flag_key"), props.get("variant"), 1))
        user_props = event.get("user_properties") or {}
        candidates += [(flag, user_props.get(f"ab_{flag}"), 2) for flag in FLAGS]
        for flag, arm, priority in candidates:
            if flag in FLAGS and arm is not None:
                order = (priority, event["_t"], event["uuid"])
                if (user, flag) not in first or order < first[(user, flag)][0]:
                    first[(user, flag)] = (order, arm)

    refunded = {
        (e["userId"], e["reference"]["businessType"], e["reference"]["businessId"])
        for e in ledger_entries()
        if e["type"] == "REFUND"
    }
    generations: dict[str, list[tuple[datetime, int, float | None]]] = defaultdict(list)
    for entry in ledger_entries():
        user, ref = entry["userId"], entry.get("reference") or {}
        if entry["type"] != "CONSUME" or user not in members:
            continue
        if (user, ref.get("businessType"), ref.get("businessId")) in refunded:
            continue
        at = ts(entry["createdAt"])
        if not members[user] <= at < members[user] + 31 * DAY:
            continue
        for detail in entry.get("businessDetails") or []:
            price = list_costs().get((ref["businessType"], detail["unitCredits"]))
            cost = None if price is None else price * detail["quantity"]
            generations[user].append((at, detail["quantity"] * detail["unitCredits"], cost))

    sums: dict[tuple[str, str], Counter] = defaultdict(Counter)
    for (user, flag), ((_, exposed_at, _), arm) in first.items():
        s = sums[(flag, arm)]
        s["users"] += 1
        for at, credits, cost in generations[user]:
            if exposed_at <= at < exposed_at + 24 * HOUR:
                s["credits_24h"] += credits
                s["cost_24h"] += cost or 0.0
            if at < members[user] + 30 * DAY:
                s["credits_30d"] += credits
                s["cost_30d"] += cost or 0.0
    return {
        key: {
            "exposed_users": s["users"],
            "credits_24h_per_exposed": s["credits_24h"] / s["users"],
            "list_cost_24h_per_exposed_usd": s["cost_24h"] / s["users"],
            "credits_30d_per_exposed": s["credits_30d"] / s["users"],
            "list_cost_30d_per_exposed_usd": s["cost_30d"] / s["users"],
            "arms_by_user": {u: a for (u, f), (_, a) in first.items() if f == key[0]},
        }
        for key, s in sums.items()
    }


def expected_q5() -> dict[str, tuple[int, int]]:
    """revenue_kind -> (invoices, cents)."""
    paid = [i for i in invoices() if i["status"] == "paid" and i["amount_paid"] > 0 and i["currency"].lower() == "usd"]
    first_at: dict[str, int] = {}
    for invoice in paid:
        first_at[invoice["customer"]] = min(invoice["created"], first_at.get(invoice["customer"], invoice["created"]))
    out: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for invoice in paid:
        kind = "first_purchase" if invoice["created"] == first_at[invoice["customer"]] else f"after_first: {invoice['billing_reason']}"
        out[kind][0] += 1
        out[kind][1] += invoice["amount_paid"]
    return {kind: (n, cents) for kind, (n, cents) in out.items()}


def q6_bucket(hours: float) -> str:
    for limit, label in ((0, "before signup (check the join)"), (24, "0-24h"), (72, "1-3d"), (168, "3-7d"), (336, "7-14d"), (720, "14-30d")):
        if hours < limit:
            return label
    return "30-60d"


def first_subscriptions() -> dict[str, dict]:
    out: dict[str, dict] = {}
    for invoice in sorted(invoices(), key=lambda i: (i["created"], i["id"])):
        if invoice["status"] == "paid" and invoice["amount_paid"] > 0 and invoice["billing_reason"] == "subscription_create":
            out.setdefault(invoice["customer"], invoice)
    return out


def expected_q6(start: datetime, end: datetime) -> dict[str, tuple[int, int]]:
    """purchase_timing -> (first subscriptions, USD cents)."""
    members = cohort(start, end, 60 * DAY)
    out: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for user, invoice in first_subscriptions().items():
        if user not in members or epoch(invoice["created"]) >= members[user] + 60 * DAY:
            continue
        bucket = out[q6_bucket((epoch(invoice["created"]) - members[user]).total_seconds() / 3600)]
        bucket[0] += 1
        bucket[1] += invoice["amount_paid"] if invoice["currency"].lower() == "usd" else 0
    return {label: (n, cents) for label, (n, cents) in out.items()}


def expected_q8_users(start: datetime, end: datetime) -> dict[tuple[str, str], dict]:
    members = cohort(start, end, 30 * DAY)
    seen: dict[tuple[str, str], list[tuple[datetime, str, str]]] = defaultdict(list)
    for event in amplitude_events():
        user, props = event.get("user_id"), event.get("event_properties") or {}
        if event["event_type"] != "$exposure" or user not in members:
            continue
        if not members[user] <= event["_t"] < members[user] + 30 * DAY:
            continue
        if props.get("flag_key") in FLAGS and props.get("variant") is not None:
            seen[(user, props["flag_key"])].append((event["_t"], event["uuid"], props["variant"]))
    return {
        key: {
            "first_arm": min(events)[2],
            "exposure_date": min(events)[0].date(),
            "arms_seen": len({arm for _, _, arm in events}),
            "slice": "holdout" if key[0][-1] in "012345" else "bandit",
        }
        for key, events in seen.items()
    }


def new_devices(start: datetime, end: datetime, as_of: datetime = AS_OF) -> tuple[dict[str, datetime], dict[str, list[dict]]]:
    """Devices first seen in [start, end) (90-day look-back, complete 7-day windows) and their window events."""
    first: dict[str, datetime] = {}
    for event in amplitude_events():
        device = event.get("device_id")
        if device is not None and start - 90 * DAY <= event["_t"] < end:
            first[device] = min(event["_t"], first.get(device, event["_t"]))
    devices = {d: at for d, at in first.items() if at >= start and at + 7 * DAY <= as_of}
    window: dict[str, list[dict]] = defaultdict(list)
    for event in amplitude_events():
        device = event.get("device_id")
        if device in devices and start <= event["_t"] < end + 7 * DAY and event["_t"] < devices[device] + 7 * DAY:
            window[device].append(event)
    return devices, window


def amplitude_with(con, view: str, rows: list[dict], exclude_user: str | None = None) -> str:
    """TEMP view: raw_amplitude.events (minus `exclude_user`'s rows) plus copies of existing rows
    (`template` uuid) with some columns replaced, to put events where the fixtures have none."""
    base = "select * from raw_amplitude.events" + (f" where user_id is distinct from '{exclude_user}'" if exclude_user else "")
    parts = [base]
    for i, row in enumerate(rows):
        replaced = [f"'{view}-{i}' as uuid", f"timestamp '{row['event_time']:%Y-%m-%d %H:%M:%S.%f}' as event_time"]
        if "user_id" in row:
            replaced.append(f"'{row['user_id']}' as user_id")
        if "event_properties" in row:
            replaced.append(f"'{json.dumps(row['event_properties'])}'::json as event_properties")
        parts.append(f"select * replace ({', '.join(replaced)}) from raw_amplitude.events where uuid = '{row['template']}'")
    con.execute(f"create or replace temp view {view} as " + " union all ".join(parts))
    return view


# Q1/Q3 runs: the doc's range; a range that starts after June (June devices are not new in July,
# even though they have July events); and an earlier "today" (only complete 7-day windows).
DEVICE_CASES = [
    pytest.param({}, wk1.AS_OF, id="defaults"),
    pytest.param({"cohort_start": "TIMESTAMP('2026-07-01')"}, wk1.AS_OF, id="returning-devices-are-not-new"),
    pytest.param({}, "2026-06-10 00:00:00", id="complete-windows-only"),
]


# ------------------------------------------------------------------ coverage and inputs


@pytest.fixture(scope="module")
def wcon(con):
    wk1.install(con)
    return con


def test_every_block_is_checked_here():
    # A new block needs its own result check below.
    assert set(BLOCKS) == {"Q0", "Q1", "Q2", "Q3", "Q4", "Q5a", "Q5b", "Q6", "Q7", "Q8a", "Q8b", "Q8c"}


def test_every_placeholder_has_a_local_relation():
    assert set().union(*(wk1.placeholders(sql) for sql in BLOCKS.values())) == set(wk1.TABLES)


def test_raw_relations_hold_exactly_the_fixture_files(con):
    counts = {
        "raw_amplitude.events": len(amplitude_events()),
        "raw_app.credit_ledger": len(ledger_entries()),
        "raw_stripe.events": len(stripe_events()),
        "openart_signal_seeds.model_costs": len(model_cost_rows()),
    }
    for relation, expected in counts.items():
        assert con.execute(f"select count(*) from {relation}").fetchone()[0] == expected, relation


def test_amplitude_reads_bound_event_time_with_constants():
    """Partition pruning: each read of the export has `event_time >= <constant>`, never DATE(event_time)."""
    for name, sql in BLOCKS.items():
        assert not re.search(r"DATE\(\s*(\w+\.)?event_time\s*\)", sql), name
        if AMPLITUDE not in sql:
            continue
        statements = [s for s in sqlglot.parse(sql, read="bigquery") if s is not None]
        variables = {i.name for s in statements if isinstance(s, exp.Declare) for item in s.expressions for i in item.this}
        tables = [t for s in statements for t in s.find_all(exp.Table) if t.name == "EVENTS_YOUR_AMPLITUDE_PROJECT_ID"]
        assert tables, name
        for table in tables:
            where = table.find_ancestor(exp.Select).args.get("where")
            assert where is not None, name
            assert any(
                isinstance(cmp.this, exp.Column)
                and cmp.this.name == "event_time"
                and all(c.name in variables for c in cmp.expression.find_all(exp.Column))
                for cmp in where.find_all(exp.GTE)
            ), f"{name}: no constant lower bound on event_time"


@pytest.mark.parametrize("name", sorted(BLOCKS))
def test_block_runs_and_returns_rows(wcon, name):
    assert wk1.run(wcon, BLOCKS[name]), f"{name} returned no rows on the fixtures"


# ------------------------------------------------------------------ Q0-Q3


def test_q0_counts_the_last_seven_days(wcon):
    since = AS_OF - 7 * DAY
    expected = Counter(e["event_type"] for e in amplitude_events() if e["_t"] >= since)
    rows = wk1.run(wcon, BLOCKS["Q0"])
    assert {r["event_type"]: r["events"] for r in rows} == expected


@pytest.mark.parametrize("overrides, as_of", DEVICE_CASES)
def test_q1_without_page_views_every_meta_device_is_never_reached_app(wcon, overrides, as_of):
    start, end = cohort_range("Q1", overrides)
    devices, window = new_devices(start, end, utc(as_of))
    page_views = [e for events in window.values() for e in events if e["event_type"] in ("[Amplitude] Page Viewed", "openforge_page_viewed")]
    assert not page_views  # fixture limitation documented under Q1
    meta = {d for d, events in window.items() if any((e.get("user_properties") or {}).get("initial_fbclid") for e in events)}
    assert 0 < len(meta) < len(devices)
    rows = wk1.run(wcon, BLOCKS["Q1"], as_of=as_of, overrides=overrides)
    assert rows == [{"journey_type": "never_reached_app", "devices": len(meta), "pct_of_meta_devices": 100.0}]


@pytest.mark.parametrize("as_of", [wk1.AS_OF, "2026-07-15 00:00:00"])
def test_q2_matches_signups_amplitude_and_payers(wcon, as_of):
    start, end = cohort_range("Q2")
    members = cohort(start, end, 7 * DAY, utc(as_of))
    with_events = {
        e["user_id"]
        for e in amplitude_events()
        if e.get("user_id") in members
        and start - DAY <= e["_t"] < end + 7 * DAY
        and members[e["user_id"]] - DAY <= e["_t"] < members[e["user_id"]] + 7 * DAY
    }
    payers = {i["customer"] for i in invoices() if i["status"] == "paid" and i["amount_paid"] > 0}
    expected: dict[date, Counter] = defaultdict(Counter)
    for user, at in members.items():
        week = expected[at.date() - timedelta(days=at.weekday())]
        week["signups"] += 1
        week["signups_without_amplitude"] += user not in with_events
        week["payers"] += user in payers
        week["payers_without_amplitude"] += user in payers and user not in with_events
    rows = wk1.run(wcon, BLOCKS["Q2"], as_of=as_of)
    got = {
        r["signup_week"].date() if isinstance(r["signup_week"], datetime) else r["signup_week"]: Counter(
            {k: r[k] for k in ("signups", "signups_without_amplitude", "payers", "payers_without_amplitude")}
        )
        for r in rows
    }
    assert got == expected
    # the one scenario user with no Amplitude events at all is also a payer
    assert sum(w["payers_without_amplitude"] for w in expected.values()) == 1
    if as_of != wk1.AS_OF:  # the earlier "today" really leaves out signups whose 7 days have not ended
        assert 0 < len(members) < len(cohort(start, end, 7 * DAY))


def test_q2_looks_for_amplitude_events_only_around_each_signup(wcon):
    start, end = cohort_range("Q2")
    members = cohort(start, end, 7 * DAY)
    # one member with all their Amplitude rows removed: a signup without Amplitude, by construction
    user = sorted(members)[0]
    template = next(e["uuid"] for e in amplitude_events() if e.get("user_id") != user)
    plain = wk1.run(wcon, BLOCKS["Q2"], tables={AMPLITUDE: amplitude_with(wcon, "wk1_amp_none", [], exclude_user=user)})
    late = amplitude_with(wcon, "wk1_amp_late", [{"template": template, "user_id": user, "event_time": members[user] + 8 * DAY}], exclude_user=user)
    assert wk1.run(wcon, BLOCKS["Q2"], tables={AMPLITUDE: late}) == plain
    soon = amplitude_with(wcon, "wk1_amp_soon", [{"template": template, "user_id": user, "event_time": members[user] + HOUR}], exclude_user=user)
    rows = wk1.run(wcon, BLOCKS["Q2"], tables={AMPLITUDE: soon})
    assert sum(r["signups_without_amplitude"] for r in rows) == sum(r["signups_without_amplitude"] for r in plain) - 1


@pytest.mark.parametrize("overrides, as_of", DEVICE_CASES)
def test_q3_puts_every_fixture_device_in_other(wcon, overrides, as_of):
    start, end = cohort_range("Q3", overrides)
    devices, window = new_devices(start, end, utc(as_of))
    paid_click = signed_in = 0
    for events in window.values():
        first = min(events, key=lambda e: (e["_t"], e["uuid"]))
        props = first.get("user_properties") or {}
        ua_hint = f"{first.get('os_name') or ''} {first.get('device_family') or ''}".lower()
        referrer = (props.get("initial_referring_domain") or "").lower()
        assert not re.search(r"instagram|facebook|fban|fbav|tiktok|musical_ly|bytedance", ua_hint)
        assert not re.search(r"(^|\.)(instagram|facebook|tiktok)\.com$", referrer)
        paid_click += bool(props.get("initial_fbclid") or props.get("initial_ttclid"))
        signed_in += any(e.get("user_id") is not None for e in events)
    assert wk1.run(wcon, BLOCKS["Q3"], as_of=as_of, overrides=overrides) == [
        {
            "landing_context": "other",
            "devices": len(devices),
            "devices_with_paid_social_click": paid_click,
            "devices_signed_in": signed_in,
            "pct_signed_in_on_same_device": round(100 * signed_in / len(devices), 2),
            "paid_social_devices_never_signed_in": 0,
        }
    ]


# ------------------------------------------------------------------ Q4


def check_q4(rows: list[dict], expected: dict[tuple[str, str], dict]) -> None:
    assert {(r["flag_key"], r["arm"]) for r in rows} == set(expected)
    for row in rows:
        want = expected[(row["flag_key"], row["arm"])]
        assert row["exposed_users"] == want["exposed_users"], row
        for column, decimals in (
            ("credits_24h_per_exposed", 1),
            ("credits_30d_per_exposed", 1),
            ("list_cost_24h_per_exposed_usd", 4),
            ("list_cost_30d_per_exposed_usd", 4),
        ):
            assert close(row[column], want[column], decimals), (row["arm"], column, row[column], want[column])
        assert row["pct_generations_priced"] == 100.0


def test_q4_credits_and_cost_per_arm_match_the_ledger(wcon):
    start, end = cohort_range("Q4")
    expected = expected_q4(start, end)
    rows = wk1.run(wcon, BLOCKS["Q4"])
    check_q4(rows, expected)

    # The first-exposed arms agree with the generator's ground truth for every cohort user.
    truth = cohort_truth()
    for (flag, _), want in expected.items():
        column = "arm_create_image" if flag == IMAGE else "arm_create_video"
        for user, arm in want["arms_by_user"].items():
            if user in truth:
                assert truth[user][column] == arm, (user, flag)
    # Every cohort user with Amplitude events in their first 30 days is exposed to both flags.
    members = cohort(start, end, 31 * DAY)
    tracked = {
        e["user_id"]
        for e in amplitude_events()
        if e.get("user_id") in members and members[e["user_id"]] <= e["_t"] < members[e["user_id"]] + 30 * DAY
    }
    for flag in FLAGS:
        assert sum(v["exposed_users"] for (f, _), v in expected.items() if f == flag) == len(tracked) == len(members) - 1

    # Numbers quoted in the doc; the trailing-window version returned 296 for gpt-image-2-5 and
    # ranked nano-banana-pro second on 24-hour credits.
    got = {r["arm"]: r for r in rows if r["flag_key"] == IMAGE}
    assert got["gpt-image-2-5"]["credits_24h_per_exposed"] == 15.5 and "against a true 15.5" in DOC
    low, high = min(r["credits_24h_per_exposed"] for r in got.values()), max(r["credits_24h_per_exposed"] for r in got.values())
    assert f"({len(tracked):,} exposed users per flag) the image arms burn {low} to {high} credits" in DOC
    for column in ("credits_24h_per_exposed", "credits_30d_per_exposed", "list_cost_30d_per_exposed_usd"):
        ranking = sorted(got, key=lambda arm: expected[(IMAGE, arm)][column])
        assert ranking[0] == "nano-banana-pro", column
        assert sorted(got, key=lambda arm: got[arm][column]) == ranking, column


def test_q4_keeps_only_signups_with_complete_windows(wcon):
    """With today = 2026-08-15, July signups after Jul 15 have not had 31 days yet."""
    as_of = "2026-08-15 00:00:00"
    overrides = {"cohort_start": "TIMESTAMP('2026-07-01')", "cohort_end": "TIMESTAMP('2026-08-01')"}
    expected = expected_q4(utc("2026-07-01"), utc("2026-08-01"), utc(as_of))
    rows = wk1.run(wcon, BLOCKS["Q4"], as_of=as_of, overrides=overrides)
    check_q4(rows, expected)
    included = sum(r["exposed_users"] for r in rows if r["flag_key"] == IMAGE)
    july = [at for at in signups().values() if utc("2026-07-01") <= at < utc("2026-08-01")]
    assert 0 < included < len(july)
    assert included == sum(1 for at in july if at + 31 * DAY <= utc(as_of))


def test_q4_reads_exposures_only_in_the_first_30_days(wcon):
    """A $exposure for another arm before signup or on day 30 changes nothing; one at signup moves the user."""
    start, end = cohort_range("Q4")
    members, truth = cohort(start, end, 31 * DAY), cohort_truth()
    user = min(u for u in members if u in truth and truth[u]["arm_create_image"] == "gpt-image-2")
    template = min(
        (e for e in amplitude_events() if e.get("user_id") == user and e["event_type"] == "$exposure" and e["event_properties"]["flag_key"] == IMAGE),
        key=lambda e: e["_t"],
    )
    other_arm = {"flag_key": IMAGE, "variant": "nano-banana-pro"}
    plain = wk1.run(wcon, BLOCKS["Q4"])
    outside = amplitude_with(
        wcon,
        "wk1_amp_outside",
        [
            {"template": template["uuid"], "event_time": members[user] - HOUR, "event_properties": other_arm},
            {"template": template["uuid"], "event_time": members[user] + 30 * DAY, "event_properties": other_arm},
        ],
    )
    assert wk1.run(wcon, BLOCKS["Q4"], tables={AMPLITUDE: outside}) == plain
    inside = amplitude_with(wcon, "wk1_amp_inside", [{"template": template["uuid"], "event_time": members[user], "event_properties": other_arm}])
    before = {(r["flag_key"], r["arm"]): r["exposed_users"] for r in plain}
    after = {(r["flag_key"], r["arm"]): r["exposed_users"] for r in wk1.run(wcon, BLOCKS["Q4"], tables={AMPLITUDE: inside})}
    assert after[(IMAGE, "gpt-image-2")] == before[(IMAGE, "gpt-image-2")] - 1
    assert after[(IMAGE, "nano-banana-pro")] == before[(IMAGE, "nano-banana-pro")] + 1


def test_q4_cost_join_does_not_fan_out(wcon):
    """A second setting with the same (capability, credits) and a lower price changes nothing."""
    wcon.execute(
        """
        create or replace temp view wk1_model_costs_with_duplicates as
        select * from openart_signal_seeds.model_costs
        union all
        select * replace (setting || ' (cheaper duplicate)' as setting, list_cost_usd / 2 as list_cost_usd)
        from openart_signal_seeds.model_costs
        """
    )
    plain = wk1.run(wcon, BLOCKS["Q4"])
    duplicated = wk1.run(wcon, BLOCKS["Q4"], tables={MODEL_COSTS: "wk1_model_costs_with_duplicates"})
    assert duplicated == plain


# ------------------------------------------------------------------ Q5


def test_q5_splits_first_and_later_invoices(wcon):
    expected = expected_q5()
    rows = wk1.run(wcon, BLOCKS["Q5a"])
    assert {r["revenue_kind"]: (r["invoices"], round(r["revenue_usd"] * 100)) for r in rows} == expected

    later = [v for k, v in expected.items() if k != "first_purchase"]
    later_n, later_cents = sum(n for n, _ in later), sum(c for _, c in later)
    total_n, total_cents = later_n + expected["first_purchase"][0], later_cents + expected["first_purchase"][1]
    assert (later_n, total_n, later_cents, total_cents) == (119, 216, 505_777, 2_922_513)
    # the prose under Q5 quotes exactly these numbers
    assert f"{later_n} later ones" in DOC and f"{total_n} paid invoices" in DOC
    assert f"${later_cents / 100:,.2f} of ${total_cents / 100:,.2f} ({100 * later_cents / total_cents:.1f}%)" in DOC

    by_month = wk1.run(wcon, BLOCKS["Q5b"])
    assert round(sum(r["revenue_usd"] for r in by_month) * 100) == total_cents
    assert round(sum(r["revenue_invisible_to_ad_platforms_usd"] for r in by_month) * 100) == later_cents


# ------------------------------------------------------------------ Q6


def test_q6_buckets_first_subscriptions_by_time_since_signup(wcon):
    start, end = cohort_range("Q6")
    expected = expected_q6(start, end)
    rows = wk1.run(wcon, BLOCKS["Q6"])
    assert [r["purchase_timing"] for r in rows] == [b for b in ("0-24h", "1-3d", "3-7d", "7-14d", "14-30d", "30-60d") if b in expected]
    assert {r["purchase_timing"]: (r["first_subscriptions"], round(r["first_charge_usd"] * 100)) for r in rows} == expected

    # Ground truth: the generator's first_purchase_at is the subscription invoice's `created`.
    members = cohort(start, end, 60 * DAY)
    truth, firsts = cohort_truth(), first_subscriptions()
    for user in members.keys() & truth.keys():
        if truth[user]["converted"]:
            assert epoch(firsts[user]["created"]) == ts(truth[user]["first_purchase_at"]), user
        else:
            assert user not in firsts, user

    total = sum(n for n, _ in expected.values())
    after = total - expected.get("0-24h", (0, 0))[0]
    cents = sum(c for _, c in expected.values())
    after_cents = cents - expected.get("0-24h", (0, 0))[1]
    assert (after, total) == (90, 94)
    assert f"{after} of {total} first subscriptions ({100 * after / total:.1f}%)" in DOC
    assert f"{100 * after_cents / cents:.1f}% of their first-charge revenue" in DOC


# ------------------------------------------------------------------ Q7


def test_q7_fixture_invoices_are_usd_without_tax(wcon):
    start, end = cohort_range("Q7")
    in_range = [
        i
        for i in invoices()
        if i["status"] == "paid" and i["amount_paid"] > 0 and start <= epoch(i["created"]) < end
    ]
    assert {i["currency"] for i in in_range} == {"usd"}
    assert all(i["total"] == i["total_excluding_tax"] for i in in_range)
    assert wk1.run(wcon, BLOCKS["Q7"]) == [
        {
            "currency": "usd",
            "invoices": len(in_range),
            "amount_paid_minor": sum(i["amount_paid"] for i in in_range),
            "total_minor": sum(i["total"] for i in in_range),
            "total_excluding_tax_minor": sum(i["total_excluding_tax"] for i in in_range),
            "invoices_without_tax_split": 0,
            "pct_tax_of_total": 0.0,
            "amount_paid_usd": round(sum(i["amount_paid"] for i in in_range) / 100, 2),
            "pct_revenue_non_usd": 0.0,
            "pct_tax_all_currencies": 0.0,
        }
    ]


def test_q7_converts_a_second_currency_and_its_tax(wcon):
    """Two synthetic invoices (EUR with 20% tax, rate added to `fx`) move both headline shares."""
    wcon.execute(
        f"""
        create or replace temp view wk1_invoices_eur as
        select * from {wk1.INVOICES_VIEW_NAME}
        union all
        select 'in_test_eur_' || cast(n as varchar), 'cus_test', null, 'subscription_create', 'paid',
               12000, 'eur', 12000, 10000, timestamp '2026-07-01 12:00:00'
        from range(2) as t(n)
        """
    )
    sql = BLOCKS["Q7"].replace(
        "SELECT 'usd' AS currency, 100 AS minor_per_major, 1.0 AS usd_per_major",
        "SELECT 'usd' AS currency, 100 AS minor_per_major, 1.0 AS usd_per_major UNION ALL SELECT 'eur', 100, 1.1",
    )
    assert sql != BLOCKS["Q7"]
    rows = {r["currency"]: r for r in wk1.run(wcon, sql, tables={"`YOUR_PROJECT.stripe.invoices`": "wk1_invoices_eur"})}
    usd, eur = rows["usd"], rows["eur"]
    eur_paid_usd, eur_tax_usd = 2 * 120.0 * 1.1, 2 * 20.0 * 1.1
    assert eur["invoices"] == 2 and eur["pct_tax_of_total"] == round(100 * 4000 / 24000, 2)
    assert close(eur["amount_paid_usd"], eur_paid_usd, 2)
    assert close(eur["pct_revenue_non_usd"], 100 * eur_paid_usd / (usd["amount_paid_minor"] / 100 + eur_paid_usd), 2)
    assert close(eur["pct_tax_all_currencies"], 100 * eur_tax_usd / (usd["total_minor"] / 100 + eur_paid_usd), 2)
    assert usd["pct_revenue_non_usd"] == eur["pct_revenue_non_usd"]  # headline shares repeat on every row


# ------------------------------------------------------------------ Q8


def test_q8_exposure_hygiene_per_arm_and_slice(wcon):
    start, end = cohort_range("Q8a")
    users = expected_q8_users(start, end)
    counts = Counter((flag, u["slice"], u["first_arm"]) for (_, flag), u in users.items())
    contaminated = Counter((flag, u["slice"], u["first_arm"]) for (_, flag), u in users.items() if u["arms_seen"] > 1)
    rows = wk1.run(wcon, BLOCKS["Q8a"])
    assert {(r["flag_key"], r["allocation_slice"], r["first_arm"]): r["users"] for r in rows} == counts
    assert {(r["flag_key"], r["allocation_slice"], r["first_arm"]): r["contaminated_users"] for r in rows} == {
        key: contaminated.get(key, 0) for key in counts
    }
    for flag in FLAGS:
        flag_users = sum(n for (f, _, _), n in counts.items() if f == flag)
        holdout = sum(n for (f, s, _), n in counts.items() if f == flag and s == "holdout")
        for row in rows:
            if row["flag_key"] == flag and row["allocation_slice"] == "holdout":
                assert close(row["slice_pct_of_flag"], 100 * holdout / flag_users, 2)
    # numbers quoted under Q8
    image_users = sum(n for (f, _, _), n in counts.items() if f == IMAGE)
    image_holdout = sum(n for (f, s, _), n in counts.items() if f == IMAGE and s == "holdout")
    # 2,000: the two scenario users' $exposure events precede their trial grant
    assert not contaminated and (image_holdout, image_users) == (178, 2000)
    assert f"{image_holdout} of {image_users:,}" in DOC


def test_q8_counts_contamination_and_keeps_the_first_arm(wcon):
    """A later $exposure for another arm marks the user contaminated; they stay in their first arm."""
    start, end = cohort_range("Q8a")
    users = expected_q8_users(start, end)
    user, flag = min(key for key, u in users.items() if key[1] == IMAGE and u["first_arm"] == "gpt-image-2")
    template = min(
        (e for e in amplitude_events() if e.get("user_id") == user and e["event_type"] == "$exposure" and e["event_properties"]["flag_key"] == IMAGE),
        key=lambda e: e["_t"],
    )
    view = amplitude_with(
        wcon,
        "wk1_amp_contaminated",
        [
            {
                "template": template["uuid"],
                "event_time": template["_t"] + 2 * DAY,
                "event_properties": {"flag_key": IMAGE, "variant": "nano-banana-pro"},
            }
        ],
    )
    plain = {(r["flag_key"], r["allocation_slice"], r["first_arm"]): r for r in wk1.run(wcon, BLOCKS["Q8a"])}
    rows = {(r["flag_key"], r["allocation_slice"], r["first_arm"]): r for r in wk1.run(wcon, BLOCKS["Q8a"], tables={AMPLITUDE: view})}
    key = (IMAGE, users[(user, flag)]["slice"], "gpt-image-2")
    assert rows[key]["users"] == plain[key]["users"]
    assert rows[key]["contaminated_users"] == plain[key]["contaminated_users"] + 1
    assert sum(r["contaminated_users"] for r in rows.values()) == 1


def test_q8_daily_first_exposures(wcon):
    start, end = cohort_range("Q8b")
    users = expected_q8_users(start, end)
    expected = Counter((u["exposure_date"], flag, u["slice"], u["first_arm"]) for (_, flag), u in users.items())
    rows = wk1.run(wcon, BLOCKS["Q8b"])
    assert {(r["exposure_date"], r["flag_key"], r["allocation_slice"], r["first_arm"]): r["first_exposures"] for r in rows} == expected


def test_q8_exposure_property_keys(wcon):
    start, end = cohort_range("Q8c")
    expected: Counter = Counter()
    for event in amplitude_events():
        if event["event_type"] == "$exposure" and start <= event["_t"] < end:
            props = event.get("event_properties") or {}
            expected.update((props.get("flag_key"), key) for key in props)
    rows = wk1.run(wcon, BLOCKS["Q8c"])
    assert {(r["flag_key"], r["property_key"]): r["exposure_events"] for r in rows} == expected
    assert {key for _, key in expected} == {"flag_key", "variant"}  # no propensity or rollout weight logged
