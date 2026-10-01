# Week-1 sizing queries

Five leaks from the research, each sized with OpenArt's own data before anything is built, plus
three checks on the inputs of the newer marts (purchase-time value, currency and tax, experiment
exposures). Every query is BigQuery SQL written against the schema names OpenArt already has or
would have. None of them depends on this repo except Q4, which joins the `model_costs` seed, and
Q7, which asks for rates from `seeds/fx_rates.csv`.

| # | Leak or check | Why it matters | Reference |
|---|---|---|---|
| Q1 | Meta click id lost on multi-hop and return journeys | No `fbc`, so lower match quality and fewer attributed Meta purchases | register G4; research/01 §4 item 2 |
| Q2 | Users with no Amplitude events (blocker proxy) | These users send nothing to any pixel or to Amplitude | research/01 §4 item 1 and §6 item 3 |
| Q3 | Webview signups | The in-app-browser handoff drops click ids | register G5; research/01 T11 |
| Q4 | Serving cost per default-model arm | The default-model A/B changes COGS, which bidding cannot see | register V2–V3; research/12 V4 |
| Q5 | Share of revenue after the first purchase | Ad platforms learn first-checkout value only | register G3; research/10 §8 |
| Q6 | First subscriptions bought more than 24 hours after signup | A score taken at signup + 24h can only send p × value for them; `fct_purchase_value_score` values the purchase when it happens | `packages/contracts` purchase-value-score schema |
| Q7 | Currency and tax mix of paid invoices | Profit now uses reporting-currency amounts (`seeds/fx_rates.csv`) and tax-exclusive revenue | `seeds/fx_rates.csv` |
| Q8 | Exposure hygiene per default-model flag | `fct_experiment_profit_by_arm_daily` keeps contaminated users in their first arm, relies on the holdout split, and would use logged propensities | `packages/bandit-allocator` README |

## Placeholders and assumptions (replace before running)

| Placeholder | What it is | Status |
|---|---|---|
| `` `YOUR_PROJECT.amplitude.EVENTS_YOUR_AMPLITUDE_PROJECT_ID` `` | Amplitude's BigQuery export table. Columns used: `uuid`, `event_type`, `event_time`, `server_upload_time`, `user_id`, `device_id`, `session_id`, `os_name`, `device_family`, `event_properties`, `user_properties` (JSON or JSON-in-STRING; `JSON_VALUE` reads both, while Q8's `JSON_KEYS` needs JSON: wrap a STRING column in `SAFE.PARSE_JSON`). | Documented export shape. Whether OpenArt enabled it is [U]; see README "Raw layer". |
| `` `YOUR_PROJECT.app.credit_ledger` `` | Ledger replica, fields exactly as `GET /suite/api/credits/logs` returns them: `id`, `userId`, `type`, `amount`, `creditField`, `createdAt`, `reference` {`businessType`, `businessId`}, `businessDetails[]` {`quantity`, `unitCredits`, `subBusinessType`}. | Field names [O]. The replica itself is [U]. If `reference` and `businessDetails` are STRUCT/ARRAY rather than JSON, swap `JSON_VALUE(reference, '$.businessType')` for `reference.businessType` and unnest the array directly. |
| `` `YOUR_PROJECT.stripe.invoices` `` | Stripe Data Pipeline table. Sigma naming: `id`, `customer_id`, `subscription_id`, `billing_reason`, `status`, `amount_paid`, `total`, `total_excluding_tax` (all three in minor units), `currency` (lower case), `created`. | Column names follow Stripe's Sigma schema [I]; check with `SELECT * ... LIMIT 1` first. At OpenArt `customer_id` = the OpenArt uid [O]. |
| `` `YOUR_PROJECT.openart_signal_seeds.model_costs` `` | `packages/contracts/fixtures/seeds/model_costs.csv`, loaded by `dbt seed`. | This repo. |
| `cohort_start`, `cohort_end` | `DECLARE` lines at the top of Q1–Q4 and Q6–Q8: the signups, newly seen devices or (Q7) invoices a block reads fall in `[cohort_start, cohort_end)`. Defaults: June and July 2026. | Edit per run. BigQuery runs a block that starts with `DECLARE` as a script. |

**Cohorts, not trailing windows.** Every query that follows users or devices over time (Q1–Q4,
Q6, Q8) starts from a cohort: signups (the ledger trial grant) or newly seen devices inside
`[cohort_start, cohort_end)`. Each member is followed for a fixed window from its own start, and
members whose window has not ended yet are left out. Taking `MIN(event_time)` over the last N days
as "first seen" instead mixes old users into the cohort and cuts recent users' windows short: on
the fixtures it put GPT Image 2.5's 24-hour credits at 296 per exposed user against a true 15.5.

**Partition pruning.** The export is partitioned by `event_time` date. Every filter on it compares
`event_time` itself with a constant (a script variable or an expression of `CURRENT_TIMESTAMP()`),
never `DATE(event_time)` or only a per-user bound, so BigQuery can prune partitions. Check each
block's bytes-processed estimate before running it.

**Checked on the synthetic fixtures.** `python_tests/test_week1_queries.py` transpiles every block
to DuckDB with sqlglot, runs it on the raw fixture tables with the fixture as-of (2026-09-28) as
today, and compares the results with values computed directly from the fixture files. Q1 and Q3
run there but return a single uninformative row each, because the fixtures have no page views,
referrers or in-app-browser user agents.

---

## Q0. Check first: what the export actually contains

```sql
-- Which event types exist, and whether os_name/device_family are populated at all.
-- research/01 T9 saw no os_name or device fields in the client payloads; the export may still
-- fill them from the user agent server-side.
SELECT
  event_type,
  COUNT(*) AS events,
  COUNTIF(os_name IS NOT NULL) AS with_os_name,
  COUNTIF(device_family IS NOT NULL) AS with_device_family,
  COUNTIF(JSON_VALUE(user_properties, '$.initial_fbclid') IS NOT NULL) AS with_initial_fbclid,
  COUNTIF(JSON_VALUE(user_properties, '$."ab_suite-default-model-create-image"') IS NOT NULL) AS with_image_arm
FROM `YOUR_PROJECT.amplitude.EVENTS_YOUR_AMPLITUDE_PROJECT_ID`
WHERE event_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
GROUP BY event_type
ORDER BY events DESC
LIMIT 100
```

---

## Q1. Meta journeys that lose the click id (multi-hop and return visits)

**What happens.** The Meta pixel runs on the Suite and Legacy apps, not on Astro marketing pages
(research/12 A1). It recovers `fbclid` from the URL or the referrer only on a direct hop from the
ad landing to the app (research/01 §4 item 2). Any intermediate marketing page, or a later return
visit, loses it. The attribution plugin still stores `initial_fbclid`, so Amplitude can see the
journey even though Meta cannot.

**Output.** Devices first seen in the range that arrived from a Meta ad, split into `direct_hop`
(fbc recoverable), `multi_hop_same_session` (lost), `return_visit` (lost) and
`never_reached_app`. Each device is followed for 7 days from its first event, Meta's default click
window.

```sql
-- Devices first seen in [cohort_start, cohort_end), each followed for 7 days from its first event.
-- A device with any event in the 90 days before cohort_start is not new.
DECLARE cohort_start TIMESTAMP DEFAULT TIMESTAMP('2026-06-01');
DECLARE cohort_end TIMESTAMP DEFAULT TIMESTAMP('2026-08-01');

WITH new_devices AS (
  -- the look-back reads only device_id and event_time, so it stays cheap
  SELECT device_id, MIN(event_time) AS first_seen_at
  FROM `YOUR_PROJECT.amplitude.EVENTS_YOUR_AMPLITUDE_PROJECT_ID`
  WHERE event_time >= TIMESTAMP_SUB(cohort_start, INTERVAL 90 DAY)
    AND event_time < cohort_end
    AND device_id IS NOT NULL
  GROUP BY device_id
  HAVING MIN(event_time) >= cohort_start
    AND TIMESTAMP_ADD(MIN(event_time), INTERVAL 7 DAY) <= CURRENT_TIMESTAMP()
),
events AS (
  SELECT
    e.uuid,
    e.event_type,
    e.event_time,
    e.device_id,
    e.session_id,
    JSON_VALUE(e.user_properties, '$.initial_fbclid') AS initial_fbclid,
    JSON_VALUE(e.event_properties, '$."[Amplitude] Page URL"') AS page_url,
    JSON_VALUE(e.event_properties, '$."[Amplitude] Page Path"') AS page_path
  FROM `YOUR_PROJECT.amplitude.EVENTS_YOUR_AMPLITUDE_PROJECT_ID` AS e
  INNER JOIN new_devices AS d ON d.device_id = e.device_id
  WHERE e.event_time >= cohort_start
    AND e.event_time < TIMESTAMP_ADD(cohort_end, INTERVAL 7 DAY)
    AND e.event_time < TIMESTAMP_ADD(d.first_seen_at, INTERVAL 7 DAY)
  QUALIFY ROW_NUMBER() OVER (PARTITION BY e.uuid ORDER BY e.server_upload_time) = 1
),
meta_devices AS (
  -- devices whose first touch carried an fbclid ($setOnce initial_fbclid)
  SELECT DISTINCT device_id
  FROM events
  WHERE initial_fbclid IS NOT NULL
),
page_views AS (
  SELECT
    e.device_id,
    e.event_time,
    e.session_id,
    e.page_url,
    -- app routes run the Meta pixel; everything else is the Astro marketing site
    REGEXP_CONTAINS(IFNULL(e.page_path, ''), r'^/(suite|home|legacy|create|director|pricing)') AS is_app_page,
    ROW_NUMBER() OVER (PARTITION BY e.device_id ORDER BY e.event_time, e.uuid) AS view_number
  FROM events AS e
  INNER JOIN meta_devices AS m ON m.device_id = e.device_id
  WHERE e.event_type IN ('[Amplitude] Page Viewed', 'openforge_page_viewed')
),
landing AS (
  SELECT device_id, session_id AS landing_session_id, view_number AS landing_view
  FROM page_views
  WHERE view_number = 1
),
first_app_view AS (
  SELECT device_id, session_id AS app_session_id, view_number AS app_view, page_url AS app_url
  FROM page_views
  WHERE is_app_page
  QUALIFY ROW_NUMBER() OVER (PARTITION BY device_id ORDER BY view_number) = 1
)
SELECT
  CASE
    WHEN a.device_id IS NULL THEN 'never_reached_app'
    WHEN STRPOS(IFNULL(a.app_url, ''), 'fbclid=') > 0 THEN 'direct_hop'
    WHEN a.app_session_id = l.landing_session_id AND a.app_view - l.landing_view <= 1 THEN 'direct_hop'
    WHEN a.app_session_id = l.landing_session_id THEN 'multi_hop_same_session'
    ELSE 'return_visit'
  END AS journey_type,
  COUNT(*) AS devices,
  ROUND(100 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct_of_meta_devices
FROM meta_devices AS m
LEFT JOIN landing AS l ON l.device_id = m.device_id
LEFT JOIN first_app_view AS a ON a.device_id = m.device_id
GROUP BY journey_type
ORDER BY devices DESC
```

**Read it.** `multi_hop_same_session + return_visit` is the share of Meta traffic that reaches the
app without a pixel `fbc`. Join to purchases (Q5's `invoices` on `user_id`) to weight it by revenue.
The server-side `fbc` (`fb.1.<fbclid_created_at>.<fbclid>`) recovers all of it for users who log in.
On the fixtures, which have no page views, every Meta device lands in `never_reached_app`.

---

## Q2. Signups with no Amplitude events at all (blocker proxy)

**What happens.** uBlock Origin strips click ids and blocks GTM, every pixel, the CAPI Gateway
feed and Amplitude (research/01 §4 item 1). A user who signs up and pays with a blocker leaves
rows in the ledger and in Stripe, but none in Amplitude or on any ad platform.

**Output.** Per signup week: signups, signups with no identified Amplitude event between a day
before and 7 days after their signup, and payers among them.

```sql
-- Signups (trial grants) in [cohort_start, cohort_end) whose 7 days have ended.
DECLARE cohort_start TIMESTAMP DEFAULT TIMESTAMP('2026-06-01');
DECLARE cohort_end TIMESTAMP DEFAULT TIMESTAMP('2026-08-01');

WITH signups AS (
  -- the canonical signup is the trial grant (USER_SIGNUP_TRIAL ADD)
  SELECT user_id, signup_at
  FROM (
    SELECT
      userId AS user_id,
      MIN(SAFE_CAST(createdAt AS TIMESTAMP)) AS signup_at
    FROM `YOUR_PROJECT.app.credit_ledger`
    WHERE type = 'ADD'
      AND JSON_VALUE(reference, '$.businessType') = 'USER_SIGNUP_TRIAL'
    GROUP BY userId
  )
  WHERE signup_at >= cohort_start
    AND signup_at < cohort_end
    AND TIMESTAMP_ADD(signup_at, INTERVAL 7 DAY) <= CURRENT_TIMESTAMP()
),
amplitude_users AS (
  SELECT DISTINCT s.user_id
  FROM `YOUR_PROJECT.amplitude.EVENTS_YOUR_AMPLITUDE_PROJECT_ID` AS e
  INNER JOIN signups AS s ON s.user_id = e.user_id
  WHERE e.event_time >= TIMESTAMP_SUB(cohort_start, INTERVAL 1 DAY)
    AND e.event_time < TIMESTAMP_ADD(cohort_end, INTERVAL 7 DAY)
    AND e.event_time >= TIMESTAMP_SUB(s.signup_at, INTERVAL 1 DAY)
    AND e.event_time < TIMESTAMP_ADD(s.signup_at, INTERVAL 7 DAY)
),
payers AS (
  SELECT DISTINCT customer_id AS user_id
  FROM `YOUR_PROJECT.stripe.invoices`
  WHERE status = 'paid' AND amount_paid > 0
)
SELECT
  DATE_TRUNC(DATE(s.signup_at), WEEK(MONDAY)) AS signup_week,
  COUNT(*) AS signups,
  COUNTIF(a.user_id IS NULL) AS signups_without_amplitude,
  ROUND(100 * COUNTIF(a.user_id IS NULL) / COUNT(*), 2) AS pct_signups_without_amplitude,
  COUNTIF(p.user_id IS NOT NULL) AS payers,
  COUNTIF(p.user_id IS NOT NULL AND a.user_id IS NULL) AS payers_without_amplitude
FROM signups AS s
LEFT JOIN amplitude_users AS a ON a.user_id = s.user_id
LEFT JOIN payers AS p ON p.user_id = s.user_id
GROUP BY signup_week
ORDER BY signup_week
```

**Read it.** `payers_without_amplitude / payers` is a lower bound on the purchases no browser
pixel reported. It is a lower bound because partial blockers let Amplitude through but stop the
pixels. Only server-side sends reach these users.

---

## Q3. Webview signups: paid-social visitors who hit the in-app-browser handoff

**What happens.** In the Instagram, Facebook and TikTok in-app browsers, Google OAuth is blocked
and the "Open page in your browser" handoff carries only the current URL. After the usual
landing → `/home` hop, the click ids and UTMs are gone. Nothing links the webview's
`oa_device_id` to the external browser (research/01 T11).

**Output.** Devices first seen in the range, by landing context: how many had a paid-social click,
and how many signed in on that same device within 7 days of their first event. The gap between
contexts is the handoff loss.

```sql
-- Devices first seen in [cohort_start, cohort_end), each followed for 7 days from its first event.
-- A device with any event in the 90 days before cohort_start is not new.
DECLARE cohort_start TIMESTAMP DEFAULT TIMESTAMP('2026-06-01');
DECLARE cohort_end TIMESTAMP DEFAULT TIMESTAMP('2026-08-01');

WITH new_devices AS (
  SELECT device_id, MIN(event_time) AS first_seen_at
  FROM `YOUR_PROJECT.amplitude.EVENTS_YOUR_AMPLITUDE_PROJECT_ID`
  WHERE event_time >= TIMESTAMP_SUB(cohort_start, INTERVAL 90 DAY)
    AND event_time < cohort_end
    AND device_id IS NOT NULL
  GROUP BY device_id
  HAVING MIN(event_time) >= cohort_start
    AND TIMESTAMP_ADD(MIN(event_time), INTERVAL 7 DAY) <= CURRENT_TIMESTAMP()
),
events AS (
  SELECT e.uuid, e.event_time, e.device_id, e.user_id, e.os_name, e.device_family, e.user_properties
  FROM `YOUR_PROJECT.amplitude.EVENTS_YOUR_AMPLITUDE_PROJECT_ID` AS e
  INNER JOIN new_devices AS d ON d.device_id = e.device_id
  WHERE e.event_time >= cohort_start
    AND e.event_time < TIMESTAMP_ADD(cohort_end, INTERVAL 7 DAY)
    AND e.event_time < TIMESTAMP_ADD(d.first_seen_at, INTERVAL 7 DAY)
),
first_touch AS (
  SELECT
    device_id,
    LOWER(CONCAT(IFNULL(os_name, ''), ' ', IFNULL(device_family, ''))) AS ua_hint,
    LOWER(IFNULL(JSON_VALUE(user_properties, '$.initial_referring_domain'), '')) AS referring_domain,
    JSON_VALUE(user_properties, '$.initial_fbclid') AS fbclid,
    JSON_VALUE(user_properties, '$.initial_ttclid') AS ttclid
  FROM events
  WHERE device_id IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY device_id ORDER BY event_time, uuid) = 1
),
sign_ins AS (
  SELECT device_id, LOGICAL_OR(user_id IS NOT NULL) AS signed_in_on_device
  FROM events
  GROUP BY device_id
)
SELECT
  CASE
    -- works only if the export fills os_name/device_family from the user agent (check with Q0)
    WHEN REGEXP_CONTAINS(f.ua_hint, r'instagram|facebook|fban|fbav|tiktok|musical_ly|bytedance') THEN 'in_app_browser (user agent)'
    -- fallback proxy: first touch referred by a social app domain
    WHEN REGEXP_CONTAINS(f.referring_domain, r'(^|\.)(instagram|facebook|tiktok)\.com$') THEN 'social_referrer (proxy)'
    ELSE 'other'
  END AS landing_context,
  COUNT(*) AS devices,
  COUNTIF(f.fbclid IS NOT NULL OR f.ttclid IS NOT NULL) AS devices_with_paid_social_click,
  COUNTIF(s.signed_in_on_device) AS devices_signed_in,
  ROUND(100 * COUNTIF(s.signed_in_on_device) / COUNT(*), 2) AS pct_signed_in_on_same_device,
  COUNTIF((f.fbclid IS NOT NULL OR f.ttclid IS NOT NULL) AND NOT s.signed_in_on_device) AS paid_social_devices_never_signed_in
FROM first_touch AS f
INNER JOIN sign_ins AS s ON s.device_id = f.device_id
GROUP BY landing_context
ORDER BY devices DESC
```

**Read it.** Compare `pct_signed_in_on_same_device` for in-app browsers against other contexts.
The shortfall times `devices_with_paid_social_click` estimates the paid-social signups that moved
to another browser and lost attribution. Carrying the ids through the handoff (packages/web-fixes
`webview-handoff`) closes it. On the fixtures every device is `other` (no user agent or referrer),
and every fixture event is signed in.

---

## Q4. Serving cost per default-model arm

**What happens.** `suite-default-model-create-image` / `-create-video` assign each visitor a default
model (research/12 V4). Per credit, Nano Banana Pro costs about 3x what GPT Image 2.5 low costs
(research/12 correction 1). The arm therefore changes COGS per user, which revenue-based
bidding cannot see.

**Output.** Signups in the range, by flag and the arm of their first exposure: exposed users,
credits burned and list-price serving cost per exposed user in the 24 hours after the first
exposure and in the first 30 days after signup, and the share of generations the cost seed prices.

```sql
-- Signups (trial grants) in [cohort_start, cohort_end). The first exposure and the generations are
-- read in [signup, signup + 30 days); the 24-hour columns start at the first exposure, so a
-- signup needs 31 days of history to be complete.
DECLARE cohort_start TIMESTAMP DEFAULT TIMESTAMP('2026-06-01');
DECLARE cohort_end TIMESTAMP DEFAULT TIMESTAMP('2026-08-01');

WITH cohort AS (
  SELECT user_id, signup_at
  FROM (
    SELECT
      userId AS user_id,
      MIN(SAFE_CAST(createdAt AS TIMESTAMP)) AS signup_at
    FROM `YOUR_PROJECT.app.credit_ledger`
    WHERE type = 'ADD'
      AND JSON_VALUE(reference, '$.businessType') = 'USER_SIGNUP_TRIAL'
    GROUP BY userId
  )
  WHERE signup_at >= cohort_start
    AND signup_at < cohort_end
    AND TIMESTAMP_ADD(signup_at, INTERVAL 31 DAY) <= CURRENT_TIMESTAMP()
),
cohort_events AS (
  SELECT c.user_id, c.signup_at, e.uuid, e.event_type, e.event_time, e.event_properties, e.user_properties
  FROM `YOUR_PROJECT.amplitude.EVENTS_YOUR_AMPLITUDE_PROJECT_ID` AS e
  INNER JOIN cohort AS c ON c.user_id = e.user_id
  WHERE e.event_time >= cohort_start
    AND e.event_time < TIMESTAMP_ADD(cohort_end, INTERVAL 30 DAY)
    AND e.event_time >= c.signup_at
    AND e.event_time < TIMESTAMP_ADD(c.signup_at, INTERVAL 30 DAY)
),
assignments AS (
  -- a $exposure event names the flag and variant; any event can also carry the arm as the
  -- ab_<flag> user property
  SELECT user_id, signup_at, uuid, event_time,
    JSON_VALUE(event_properties, '$.flag_key') AS flag_key,
    JSON_VALUE(event_properties, '$.variant') AS arm,
    1 AS source_priority
  FROM cohort_events
  WHERE event_type = '$exposure'
  UNION ALL
  SELECT user_id, signup_at, uuid, event_time, 'suite-default-model-create-image',
    JSON_VALUE(user_properties, '$."ab_suite-default-model-create-image"'), 2
  FROM cohort_events
  UNION ALL
  SELECT user_id, signup_at, uuid, event_time, 'suite-default-model-create-video',
    JSON_VALUE(user_properties, '$."ab_suite-default-model-create-video"'), 2
  FROM cohort_events
),
exposures AS (
  -- first exposure per user and flag: the first $exposure event, else the first event that
  -- carries the user property
  SELECT user_id, signup_at, flag_key, arm, event_time AS first_exposed_at
  FROM assignments
  WHERE flag_key IN ('suite-default-model-create-image', 'suite-default-model-create-video')
    AND arm IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY user_id, flag_key ORDER BY source_priority, event_time, uuid) = 1
),
refunded AS (
  -- failed generations come back as REFUND rows on the same capability id and history id
  SELECT DISTINCT userId, JSON_VALUE(reference, '$.businessType') AS business_type, JSON_VALUE(reference, '$.businessId') AS business_id
  FROM `YOUR_PROJECT.app.credit_ledger`
  WHERE type = 'REFUND'
),
generations AS (
  -- successful generations in the cohort's first 31 days
  SELECT
    c.user_id,
    SAFE_CAST(l.createdAt AS TIMESTAMP) AS created_at,
    SAFE_CAST(l.createdAt AS TIMESTAMP) < TIMESTAMP_ADD(c.signup_at, INTERVAL 30 DAY) AS in_first_30d,
    JSON_VALUE(l.reference, '$.businessType') AS business_type,
    SAFE_CAST(JSON_VALUE(detail, '$.unitCredits') AS INT64) AS unit_credits,
    SAFE_CAST(JSON_VALUE(detail, '$.quantity') AS INT64) AS quantity
  FROM `YOUR_PROJECT.app.credit_ledger` AS l
  INNER JOIN cohort AS c ON c.user_id = l.userId
  CROSS JOIN UNNEST(JSON_QUERY_ARRAY(l.businessDetails)) AS detail
  LEFT JOIN refunded AS r
    ON r.userId = l.userId
   AND r.business_type = JSON_VALUE(l.reference, '$.businessType')
   AND r.business_id = JSON_VALUE(l.reference, '$.businessId')
  WHERE l.type = 'CONSUME'
    AND r.userId IS NULL
    AND SAFE_CAST(l.createdAt AS TIMESTAMP) >= c.signup_at
    AND SAFE_CAST(l.createdAt AS TIMESTAMP) < TIMESTAMP_ADD(c.signup_at, INTERVAL 31 DAY)
),
costs AS (
  -- several settings of one model can share a credit price: keep one row per (capability,
  -- credits), at the highest list cost, so the join cannot fan out
  SELECT business_type, credits, MAX(list_cost_usd) AS list_cost_usd
  FROM `YOUR_PROJECT.openart_signal_seeds.model_costs`
  GROUP BY business_type, credits
),
priced AS (
  SELECT
    g.*,
    g.unit_credits * g.quantity AS credits,
    c.list_cost_usd * g.quantity AS list_cost_usd
  FROM generations AS g
  LEFT JOIN costs AS c
    ON c.business_type = g.business_type
   AND c.credits = g.unit_credits
),
windows AS (
  SELECT
    e.flag_key,
    e.arm,
    e.user_id,
    p.credits,
    p.list_cost_usd,
    p.created_at >= e.first_exposed_at AND p.created_at < TIMESTAMP_ADD(e.first_exposed_at, INTERVAL 24 HOUR) AS in_24h,
    p.in_first_30d AS in_30d
  FROM exposures AS e
  LEFT JOIN priced AS p ON p.user_id = e.user_id
)
SELECT
  flag_key,
  arm,
  COUNT(DISTINCT user_id) AS exposed_users,
  ROUND(SUM(IF(in_24h, credits, 0)) / COUNT(DISTINCT user_id), 1) AS credits_24h_per_exposed,
  ROUND(SUM(IF(in_24h, list_cost_usd, 0)) / COUNT(DISTINCT user_id), 4) AS list_cost_24h_per_exposed_usd,
  ROUND(SUM(IF(in_30d, credits, 0)) / COUNT(DISTINCT user_id), 1) AS credits_30d_per_exposed,
  ROUND(SUM(IF(in_30d, list_cost_usd, 0)) / COUNT(DISTINCT user_id), 4) AS list_cost_30d_per_exposed_usd,
  ROUND(SAFE_DIVIDE(SUM(IF(in_30d, list_cost_usd, 0)), SUM(IF(in_30d AND list_cost_usd IS NOT NULL, credits, 0))), 6) AS list_cost_per_credit_usd,
  ROUND(100 * SAFE_DIVIDE(COUNTIF(in_30d AND list_cost_usd IS NOT NULL), COUNTIF(in_30d)), 1) AS pct_generations_priced
FROM windows
GROUP BY flag_key, arm
ORDER BY flag_key, list_cost_30d_per_exposed_usd DESC
```

**Read it.** The spread in `list_cost_30d_per_exposed_usd` across arms is the COGS the flag
decides. Put it next to conversion per arm, as `fct_experiment_profit_by_arm` does. A
`pct_generations_priced` below ~99% names capability ids that `model_costs.csv` still lacks.
Negotiated prices go into `seeds/generation_cost_overrides.csv`, not here. An exposure logged a
moment before the trial grant is ignored, and the arm then comes from the first later event that
carries the `ab_*` property. On the fixtures (2,002 exposed users per flag) the image arms burn
10.8 to 15.6 credits per exposed user in the first 24 hours, and nano-banana-pro is the lowest
image arm on credits in both windows and on 30-day list cost. The trailing-window version of this
query ranked it second on 24-hour credits.

---

## Q5. Share of revenue that arrives after the first purchase

**What happens.** Ad platforms learn first-checkout value only. Renewals, upgrades, add-ons,
one-time packs, refunds and chargebacks reach none of them from the web app (register G3;
research/10 §8). The later money is exactly what a revenue-optimized bid never sees.

**Output.** Revenue by kind (first purchase vs each later `billing_reason`), then the same per
first-purchase cohort and month since the first purchase.

```sql
WITH invoices AS (
  SELECT
    id,
    customer_id,
    billing_reason,
    amount_paid / 100 AS amount_usd,
    created
  FROM `YOUR_PROJECT.stripe.invoices`
  WHERE status = 'paid'
    AND amount_paid > 0
    AND currency = 'usd'
),
firsts AS (
  SELECT customer_id, MIN(created) AS first_paid_at
  FROM invoices
  GROUP BY customer_id
)
SELECT
  CASE
    WHEN i.created = f.first_paid_at THEN 'first_purchase'
    ELSE CONCAT('after_first: ', IFNULL(i.billing_reason, 'unknown'))
  END AS revenue_kind,
  COUNT(*) AS invoices,
  ROUND(SUM(i.amount_usd), 2) AS revenue_usd,
  ROUND(100 * SUM(i.amount_usd) / SUM(SUM(i.amount_usd)) OVER (), 1) AS pct_of_revenue
FROM invoices AS i
INNER JOIN firsts AS f ON f.customer_id = i.customer_id
GROUP BY revenue_kind
ORDER BY revenue_usd DESC
```

```sql
-- The same money by first-purchase cohort and month since the first purchase: the part of each
-- cohort's cash that no ad platform was ever told about.
WITH invoices AS (
  SELECT customer_id, amount_paid / 100 AS amount_usd, created
  FROM `YOUR_PROJECT.stripe.invoices`
  WHERE status = 'paid' AND amount_paid > 0 AND currency = 'usd'
),
firsts AS (
  SELECT customer_id, MIN(created) AS first_paid_at
  FROM invoices
  GROUP BY customer_id
)
SELECT
  DATE_TRUNC(DATE(f.first_paid_at), MONTH) AS first_purchase_month,
  DATE_DIFF(DATE(i.created), DATE(f.first_paid_at), MONTH) AS months_since_first_purchase,
  COUNT(DISTINCT i.customer_id) AS paying_customers,
  ROUND(SUM(i.amount_usd), 2) AS revenue_usd,
  ROUND(SUM(IF(i.created > f.first_paid_at, i.amount_usd, 0)), 2) AS revenue_invisible_to_ad_platforms_usd
FROM invoices AS i
INNER JOIN firsts AS f ON f.customer_id = i.customer_id
GROUP BY first_purchase_month, months_since_first_purchase
ORDER BY first_purchase_month, months_since_first_purchase
```

**Read it.** `pct_of_revenue` outside `first_purchase` is the value today's tags cannot optimize
for. On the synthetic fixtures Q5 returns 216 paid invoices: 97 first purchases and 119 later
ones (103 `subscription_cycle` renewals and 16 `subscription_update` plan changes), and the later
ones are $5,057.77 of $29,225.13 (17.3%). Those counts include the five hand-written scenario
users, which the warehouse treats as QA accounts, and no one-time packs. `fct_reconciliation`
sizes the same leak per ad platform and month in its `out_of_scope_purchase_types` step; that
step leaves QA accounts out and counts packs, so its totals are not Q5's. One-time packs are
payment-mode Checkout Sessions with no invoice; add them from the Data Pipeline
`checkout_sessions` table (`mode = 'payment'`, `payment_status = 'paid'`) if the ratio should
include packs.

---

## Q6. First subscriptions bought more than 24 hours after signup

**What happens.** A value scored 24 hours after signup is p(purchase) × value. For a user who
buys after that point, it is the only value the ad platforms get, and it is unconditional: it
prices a paying user like every other trial user with the same features.
`fct_purchase_value_score` scores E[90-day gross profit | purchase] when the purchase happens. The
more first purchases fall after the 24-hour mark, the more value depends on that purchase-time
score.

**Output.** First subscription purchases (each customer's first paid `subscription_create`
invoice) of signups in the range, by time since the trial grant: 0–24h, 1–3d, 3–7d, 7–14d,
14–30d and 30–60d. Each signup is followed for 60 days. Counts, first-charge USD and each bucket's
share of both.

```sql
-- Signups (trial grants) in [cohort_start, cohort_end) whose 60 days have ended.
DECLARE cohort_start TIMESTAMP DEFAULT TIMESTAMP('2026-06-01');
DECLARE cohort_end TIMESTAMP DEFAULT TIMESTAMP('2026-08-01');

WITH signups AS (
  SELECT user_id, signup_at
  FROM (
    SELECT
      userId AS user_id,
      MIN(SAFE_CAST(createdAt AS TIMESTAMP)) AS signup_at
    FROM `YOUR_PROJECT.app.credit_ledger`
    WHERE type = 'ADD'
      AND JSON_VALUE(reference, '$.businessType') = 'USER_SIGNUP_TRIAL'
    GROUP BY userId
  )
  WHERE signup_at >= cohort_start
    AND signup_at < cohort_end
    AND TIMESTAMP_ADD(signup_at, INTERVAL 60 DAY) <= CURRENT_TIMESTAMP()
),
first_subscriptions AS (
  -- each customer's first paid subscription invoice, over all of history
  SELECT customer_id AS user_id, created AS purchased_at, amount_paid, currency
  FROM `YOUR_PROJECT.stripe.invoices`
  WHERE status = 'paid'
    AND amount_paid > 0
    AND billing_reason = 'subscription_create'
  QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY created, id) = 1
),
timed AS (
  SELECT
    f.amount_paid,
    f.currency,
    TIMESTAMP_DIFF(f.purchased_at, s.signup_at, SECOND) / 3600 AS hours_after_signup
  FROM first_subscriptions AS f
  INNER JOIN signups AS s ON s.user_id = f.user_id
  WHERE f.purchased_at < TIMESTAMP_ADD(s.signup_at, INTERVAL 60 DAY)
)
SELECT
  CASE
    WHEN hours_after_signup < 0 THEN 'before signup (check the join)'
    WHEN hours_after_signup < 24 THEN '0-24h'
    WHEN hours_after_signup < 72 THEN '1-3d'
    WHEN hours_after_signup < 168 THEN '3-7d'
    WHEN hours_after_signup < 336 THEN '7-14d'
    WHEN hours_after_signup < 720 THEN '14-30d'
    ELSE '30-60d'
  END AS purchase_timing,
  COUNT(*) AS first_subscriptions,
  ROUND(100 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct_of_first_subscriptions,
  -- USD invoices only; Q7 shows what that leaves out
  ROUND(SUM(IF(currency = 'usd', amount_paid, 0)) / 100, 2) AS first_charge_usd,
  ROUND(100 * SAFE_DIVIDE(SUM(IF(currency = 'usd', amount_paid, 0)), SUM(SUM(IF(currency = 'usd', amount_paid, 0))) OVER ()), 1) AS pct_of_first_charge_usd
FROM timed
GROUP BY purchase_timing
ORDER BY MIN(hours_after_signup)
```

**Read it.** Every row after `0-24h` is a first purchase that a signup + 24h score sends as
p × value only. On the fixtures 90 of 94 first subscriptions (95.7%) and 87.3% of their
first-charge revenue come more than 24 hours after signup, most of them between day 3 and day 14.
The cohort generator converts users within 14 days of signup, so that shape describes the
synthetic data, not OpenArt.

---

## Q7. Currency and tax mix of paid invoices

**What happens.** `amount_paid` is in the invoice currency's minor units and includes any tax.
Profit in the warehouse now uses amounts converted to one reporting currency with the rates in
`seeds/fx_rates.csv`, and tax-exclusive revenue (`total_excluding_tax`). How much that changes the
numbers depends on how much revenue is not in USD and how much of it is tax.

**Output.** Paid invoices created in the range, by currency: count, `amount_paid`, `total` and
`total_excluding_tax` in minor units, tax as a share of `total`, `amount_paid` in USD, and the two
headline shares, repeated on every row: revenue not in USD, and tax as a share of total across
currencies.

```sql
-- Paid invoices created in [cohort_start, cohort_end).
DECLARE cohort_start TIMESTAMP DEFAULT TIMESTAMP('2026-06-01');
DECLARE cohort_end TIMESTAMP DEFAULT TIMESTAMP('2026-08-01');

WITH fx AS (
  -- Minor units per major unit, and USD per major unit. Add a row for every currency the query
  -- returns, with the rate from seeds/fx_rates.csv; JPY and KRW have minor_per_major = 1. A
  -- currency without a row gets NULL USD columns and is left out of both headline shares.
  SELECT 'usd' AS currency, 100 AS minor_per_major, 1.0 AS usd_per_major
),
invoices AS (
  SELECT
    LOWER(i.currency) AS currency,
    i.amount_paid,
    i.total,
    i.total_excluding_tax,
    fx.usd_per_major / fx.minor_per_major AS usd_per_minor
  FROM `YOUR_PROJECT.stripe.invoices` AS i
  LEFT JOIN fx ON fx.currency = LOWER(i.currency)
  WHERE i.status = 'paid'
    AND i.amount_paid > 0
    AND i.created >= cohort_start
    AND i.created < cohort_end
),
by_currency AS (
  SELECT
    currency,
    COUNT(*) AS invoices,
    SUM(amount_paid) AS amount_paid_minor,
    SUM(total) AS total_minor,
    SUM(total_excluding_tax) AS total_excluding_tax_minor,
    COUNTIF(total_excluding_tax IS NULL) AS invoices_without_tax_split,
    SUM(amount_paid * usd_per_minor) AS amount_paid_usd,
    SUM((total - total_excluding_tax) * usd_per_minor) AS tax_usd,
    SUM(total * usd_per_minor) AS total_usd
  FROM invoices
  GROUP BY currency
)
SELECT
  currency,
  invoices,
  amount_paid_minor,
  total_minor,
  total_excluding_tax_minor,
  invoices_without_tax_split,
  ROUND(100 * SAFE_DIVIDE(total_minor - total_excluding_tax_minor, total_minor), 2) AS pct_tax_of_total,
  ROUND(amount_paid_usd, 2) AS amount_paid_usd,
  ROUND(100 * SAFE_DIVIDE(SUM(IF(currency = 'usd', 0, amount_paid_usd)) OVER (), SUM(amount_paid_usd) OVER ()), 2) AS pct_revenue_non_usd,
  ROUND(100 * SAFE_DIVIDE(SUM(tax_usd) OVER (), SUM(total_usd) OVER ()), 2) AS pct_tax_all_currencies
FROM by_currency
ORDER BY amount_paid_usd DESC
```

**Read it.** If `pct_revenue_non_usd` and `pct_tax_all_currencies` are both close to zero, the
conversion and the tax split barely move profit. A currency with NULL USD columns still needs a
row in `fx`. `invoices_without_tax_split` above zero means `total_excluding_tax` is missing on
some invoices, and the tax share is understated. Q5 and Q6's revenue columns count USD only; this
is what they leave out. On the fixtures every invoice is USD with no tax, so both shares are 0.

---

## Q8. Exposure hygiene per default-model flag

**What happens.** The daily readout `fct_experiment_profit_by_arm_daily` puts each user in the
arm of their first exposure and keeps them there if a later exposure shows another arm (intention
to treat). `packages/bandit-allocator` changes the flag weights daily, and LaunchDarkly re-buckets
some users when weights change, so those users see a second arm. The allocator never touches the
holdout rule, which serves a fixed uniform split to uids matching `[0-5]$` (about 9.7% of base62
uids). If exposure events logged the probability of the arm served, the readout could weight
arms by it while the split moves.

**Output.** (a) Signups in the range, per flag, slice (`holdout` or `bandit`, recomputed from the
uid) and first-exposed arm: users, the arm's share of its slice, the slice's share of the flag,
and contaminated users (`$exposure` events showing more than one arm). (b) The same first
exposures per day, for a daily sample-ratio test. (c) The keys `$exposure` events carry.

```sql
-- Signups (trial grants) in [cohort_start, cohort_end) whose first 30 days have ended, and their
-- $exposure events in those 30 days.
DECLARE cohort_start TIMESTAMP DEFAULT TIMESTAMP('2026-06-01');
DECLARE cohort_end TIMESTAMP DEFAULT TIMESTAMP('2026-08-01');

WITH cohort AS (
  SELECT user_id, signup_at
  FROM (
    SELECT
      userId AS user_id,
      MIN(SAFE_CAST(createdAt AS TIMESTAMP)) AS signup_at
    FROM `YOUR_PROJECT.app.credit_ledger`
    WHERE type = 'ADD'
      AND JSON_VALUE(reference, '$.businessType') = 'USER_SIGNUP_TRIAL'
    GROUP BY userId
  )
  WHERE signup_at >= cohort_start
    AND signup_at < cohort_end
    AND TIMESTAMP_ADD(signup_at, INTERVAL 30 DAY) <= CURRENT_TIMESTAMP()
),
exposure_events AS (
  SELECT
    c.user_id,
    e.uuid,
    e.event_time,
    JSON_VALUE(e.event_properties, '$.flag_key') AS flag_key,
    JSON_VALUE(e.event_properties, '$.variant') AS arm
  FROM `YOUR_PROJECT.amplitude.EVENTS_YOUR_AMPLITUDE_PROJECT_ID` AS e
  INNER JOIN cohort AS c ON c.user_id = e.user_id
  WHERE e.event_type = '$exposure'
    AND e.event_time >= cohort_start
    AND e.event_time < TIMESTAMP_ADD(cohort_end, INTERVAL 30 DAY)
    AND e.event_time >= c.signup_at
    AND e.event_time < TIMESTAMP_ADD(c.signup_at, INTERVAL 30 DAY)
    AND JSON_VALUE(e.event_properties, '$.flag_key') IN ('suite-default-model-create-image', 'suite-default-model-create-video')
    AND JSON_VALUE(e.event_properties, '$.variant') IS NOT NULL
),
users AS (
  SELECT
    user_id,
    flag_key,
    IF(REGEXP_CONTAINS(user_id, r'[0-5]$'), 'holdout', 'bandit') AS allocation_slice,
    ARRAY_AGG(arm ORDER BY event_time, uuid)[OFFSET(0)] AS first_arm,
    COUNT(DISTINCT arm) AS arms_seen
  FROM exposure_events
  GROUP BY user_id, flag_key
)
SELECT
  flag_key,
  allocation_slice,
  first_arm,
  COUNT(*) AS users,
  ROUND(100 * COUNT(*) / SUM(COUNT(*)) OVER (PARTITION BY flag_key, allocation_slice), 2) AS pct_of_slice,
  ROUND(100 * SUM(COUNT(*)) OVER (PARTITION BY flag_key, allocation_slice) / SUM(COUNT(*)) OVER (PARTITION BY flag_key), 2) AS slice_pct_of_flag,
  COUNTIF(arms_seen > 1) AS contaminated_users,
  ROUND(100 * COUNTIF(arms_seen > 1) / COUNT(*), 2) AS pct_contaminated
FROM users
GROUP BY flag_key, allocation_slice, first_arm
ORDER BY flag_key, allocation_slice, first_arm
```

```sql
-- (b) First exposures per UTC day, flag, slice and arm, for the same cohort.
DECLARE cohort_start TIMESTAMP DEFAULT TIMESTAMP('2026-06-01');
DECLARE cohort_end TIMESTAMP DEFAULT TIMESTAMP('2026-08-01');

WITH cohort AS (
  SELECT user_id, signup_at
  FROM (
    SELECT
      userId AS user_id,
      MIN(SAFE_CAST(createdAt AS TIMESTAMP)) AS signup_at
    FROM `YOUR_PROJECT.app.credit_ledger`
    WHERE type = 'ADD'
      AND JSON_VALUE(reference, '$.businessType') = 'USER_SIGNUP_TRIAL'
    GROUP BY userId
  )
  WHERE signup_at >= cohort_start
    AND signup_at < cohort_end
    AND TIMESTAMP_ADD(signup_at, INTERVAL 30 DAY) <= CURRENT_TIMESTAMP()
),
exposure_events AS (
  SELECT
    c.user_id,
    e.uuid,
    e.event_time,
    JSON_VALUE(e.event_properties, '$.flag_key') AS flag_key,
    JSON_VALUE(e.event_properties, '$.variant') AS arm
  FROM `YOUR_PROJECT.amplitude.EVENTS_YOUR_AMPLITUDE_PROJECT_ID` AS e
  INNER JOIN cohort AS c ON c.user_id = e.user_id
  WHERE e.event_type = '$exposure'
    AND e.event_time >= cohort_start
    AND e.event_time < TIMESTAMP_ADD(cohort_end, INTERVAL 30 DAY)
    AND e.event_time >= c.signup_at
    AND e.event_time < TIMESTAMP_ADD(c.signup_at, INTERVAL 30 DAY)
    AND JSON_VALUE(e.event_properties, '$.flag_key') IN ('suite-default-model-create-image', 'suite-default-model-create-video')
    AND JSON_VALUE(e.event_properties, '$.variant') IS NOT NULL
),
first_exposures AS (
  SELECT
    user_id,
    flag_key,
    IF(REGEXP_CONTAINS(user_id, r'[0-5]$'), 'holdout', 'bandit') AS allocation_slice,
    DATE(MIN(event_time)) AS exposure_date,
    ARRAY_AGG(arm ORDER BY event_time, uuid)[OFFSET(0)] AS first_arm
  FROM exposure_events
  GROUP BY user_id, flag_key
)
SELECT
  exposure_date,
  flag_key,
  allocation_slice,
  first_arm,
  COUNT(*) AS first_exposures,
  ROUND(100 * COUNT(*) / SUM(COUNT(*)) OVER (PARTITION BY exposure_date, flag_key, allocation_slice), 1) AS pct_of_slice_that_day
FROM first_exposures
GROUP BY exposure_date, flag_key, allocation_slice, first_arm
ORDER BY exposure_date, flag_key, allocation_slice, first_arm
```

```sql
-- (c) The keys $exposure events carry, per flag. JSON_KEYS needs a JSON column; for a STRING
-- column use JSON_KEYS(SAFE.PARSE_JSON(e.event_properties)).
DECLARE cohort_start TIMESTAMP DEFAULT TIMESTAMP('2026-06-01');
DECLARE cohort_end TIMESTAMP DEFAULT TIMESTAMP('2026-08-01');

SELECT
  JSON_VALUE(e.event_properties, '$.flag_key') AS flag_key,
  property_key,
  COUNT(*) AS exposure_events
FROM `YOUR_PROJECT.amplitude.EVENTS_YOUR_AMPLITUDE_PROJECT_ID` AS e
CROSS JOIN UNNEST(JSON_KEYS(e.event_properties)) AS property_key
WHERE e.event_type = '$exposure'
  AND e.event_time >= cohort_start
  AND e.event_time < cohort_end
GROUP BY flag_key, property_key
ORDER BY flag_key, exposure_events DESC, property_key
```

**Read it.** If LaunchDarkly's context key is the uid, the `holdout` slice gets the fixed uniform
split every day: 25% per image arm, 33.3% per video arm. Test (b) day by day with a chi-square; p
below 0.001 is the sample-ratio mismatch at which the allocator holds the flag. A holdout slice
that follows the bandit's weights instead means the context key is not the uid (if it is
`oa_device_id`, the predicate must change; see the bandit-allocator README). The holdout's
`slice_pct_of_flag` should be near 9.7%; far from it, the uids are not uniform base62 and the
predicate selects a different share. `pct_contaminated` is the share of users the readout keeps
in an arm they later left. If (c) lists only `flag_key` and `variant`, no propensity is logged,
and the readout has to take the split from the flag's change history. On the fixtures no user is
contaminated, the holdout predicate matches 178 of 2,000 exposed users per flag (8.9%; the
generator assigns arms uniformly and has no holdout rule), and `$exposure` carries only
`flag_key` and `variant`.
