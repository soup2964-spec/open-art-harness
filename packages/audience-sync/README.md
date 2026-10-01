# @openart-signal/audience-sync

This package builds **consent-filtered** customer lists from predicted profit, hashes identifiers **per destination**, and produces **dry-run** upload requests for three platforms:
- Google Ads Customer Match, through the **Data Manager API** (the Google Ads API stopped taking new Customer Match adopters on 2026-04-01);
- Meta customer-list Custom Audiences;
- TikTok customer-file audiences.

Removals come from a diff against the previous snapshot.

**It never sends anything.** It has no live mode and no transport. `DryRunAudienceClient` only prints and records requests. A test-wide guard fails any network attempt, and a static test asserts that `src/` contains no network code.

## How it plugs into OpenArt

```
fct_predicted_profit_24h + Stripe money-out + subscription status + consent record
      --> fct_audience_candidates (one row per scored user)  +  restricted contact table (email, phone)
      --> [this package, Cloud Run Job, daily] --> Google Data Manager API   (Customer Match lists)
                                               --> Meta /{audience_id}/users (customer-list audiences)
                                               --> TikTok customer files     (dmp/custom_audience)
      <-- snapshot of what each list holds (GCS/BigQuery), next run's --previous
```

- **Ad accounts:**
  - **Google:** Ads customer id(s), digits only. These are not the `AW-11252321380` / `AW-16854695811` conversion ids, which are tag ids. Plus an OAuth client with the `https://www.googleapis.com/auth/datamanager` scope.
  - **Meta:** an ad account with a user token that has `ads_management`.
  - **TikTok:** advertiser `7670743239628161042`, which appears in OpenArt's pixel code, with an `Access-Token`.
- **Creating the lists:** each list is created once on its platform, and its id goes in `fixtures/audience.config.json`, where every id is a placeholder.
  - Google: `userLists.create` with `uploadKeyTypes: [CONTACT_ID]`.
  - Meta: `customaudiences` with `subtype=CUSTOM` and `customer_file_source=USER_PROVIDED_ONLY`, plus `is_value_based=1` for the value seed.
  - TikTok: audiences are created by the first upload of 1,000 or more entries. The id comes back in the create response and is carried forward in `nextAudienceIds` (see below).
- **Consent today.** OpenArt runs no CMP (`gcd=13l3l3l3l1l1`), so every signal is `unknown`:
  - **EEA/UK/CH and the other consent-required regions:** nobody passes until a CMP records explicit `ad_user_data` and `ad_personalization` grants.
  - **Everywhere else:** users pass by default, unless they sent Global Privacy Control, opted out of sale/sharing, or denied any signal.
  - **The catch:** the default only honours opt-outs the warehouse knows about. edge-attribution records `Sec-GPC` and the web-fixes consent defaults record the opt-out. Both must reach `fct_audience_candidates` (the `gpc` and `opt_out_sale_sharing` columns) before any upload, and counsel should confirm the policy per market.
  - The plan report counts default-eligible users with no opt-out signal recorded, and warns. `npx tsx src/cli.ts --demo --consent today_no_cmp` shows it: 1,597 users are eligible by default, all with that warning.

## Inputs

**Native (recommended).** `fct_audience_candidates` at **user grain** (`src/types.ts`, zod-validated), with these columns:
- `user_id`
- `email` and `phone_e164`: plaintext, from the restricted dataset; hashed here
- `country`: ISO-2
- `computed_at`
- `predicted_profit` and `model_version`
- `is_active_subscriber`, `has_refund`, `has_chargeback`, `is_fraud`
- `consent`: the contracts `Consent` block, including the optional `gpc` and `opt_out_sale_sharing`

Email normalisation differs by platform, so a single warehouse-side hash could not serve all three. That is why plaintext comes from the restricted dataset and is hashed here.

**Today's warehouse mart (adapter).** `packages/warehouse` currently builds `fct_audience_candidates` at **(user, warehouse list)** grain, with no contact columns. `src/warehouse-candidates.ts`:
- collapses the list rows to one row per user, rejecting rows that disagree;
- joins a restricted contact table;
- rebuilds `Consent` from the flattened consent columns, including `gpc` and `opt_out_sale_sharing` when the mart carries them;
- applies the warehouse's own `upload_allowed` gate on top of the consent gate;
- cross-checks the mart's `external_id_sha256` against this package's hashing. It matches on the real mart rows.

It also warns about the one gap it cannot fix: the mart only holds users who are on one of the warehouse's lists, so the positive-profit seed is incomplete. The fix is one row per scored user. Run it with `npx tsx src/cli.ts --warehouse-rows fct_audience_candidates.jsonl --contacts contacts.jsonl`.

## Lists (`src/build.ts`)

| List | Role | Rule |
|---|---|---|
| `oa_seed_top_decile_predicted_profit` | seed | Top 10% of predicted profit among **all** scored users (nearest rank `ceil(p x n)` in exact decimal arithmetic, so 7% of 100 is 7, not 8; ties at the threshold included), and > $0 |
| `oa_seed_positive_predicted_profit` | value-based seed | Predicted profit > $0. Value = predicted profit (Meta `LOOKALIKE_VALUE`) |
| `oa_excl_active_subscribers` | suppression | Active paid subscription |
| `oa_excl_fraud_or_chargeback` | suppression | Fraud flag or any dispute |
| `oa_excl_refunded` | suppression | Any refund |
| `oa_excl_low_predicted_profit` | suppression | Predicted profit < `lowPredictedProfitMaxUsd` (default $0; the warehouse uses $1) |

**Rules that apply to every list:**
- **Seeds never include** fraud, chargeback or refunded users.
- **The decile is computed before the consent filter,** so a user's seed membership does not move when consent coverage changes.
- **Every list goes through the consent gate** (`src/consent.ts`). It uses the shared contracts policy (`CONSENT_REQUIRED_REGIONS`, `consent-regions.ts`), not a local country list. The old local list missed RE, GF, GP, MQ, YT, MF and AX. The rules, in order:
  1. **GPC or a sale/sharing opt-out** (`gpc`, `opt_out_sale_sharing`) blocks the user everywhere, a CMP grant included.
  2. **Any explicit `denied`** blocks the user, whatever its source.
  3. **In a consent-required region**, only explicit grants count: `ad_user_data` and `ad_personalization` both `granted` by a CMP.
     - This covers the EEA, the UK, Switzerland, and the EU territories that geolocation reports separately.
     - An unknown region counts as consent-required (fail closed).
     - The stricter of the consent region and the account country wins.
  4. **Everywhere else**, the user is eligible by default.

## Payloads (`src/platforms/`)

| | Google Data Manager API | Meta Custom Audiences | TikTok customer file |
|---|---|---|---|
| Add | `POST /v1/audienceMembers:ingest` | `POST /{v25.0}/{audience_id}/users` | upload `.txt` then `update` with `action: APPEND`, or `create` |
| Remove | `POST /v1/audienceMembers:remove` | `DELETE /{v25.0}/{audience_id}/users` | upload then `update` with `action: REMOVE` |
| Body | `destinations[{operatingAccount, productDestinationId}]`, `audienceMembers[{userData.userIdentifiers[{emailAddress}\|{phoneNumber}], consent GRANTED×2}]`, `encoding: HEX`, `termsOfService` (ingest only), `validateOnly` | `payload={"schema":["EXTERN_ID","EMAIL","PHONE"(,"LOOKALIKE_VALUE")],"data":[[…]]}` (unknown keys blank), or single-key `EMAIL_SHA256`; `session={session_id, batch_seq, last_batch_flag, estimated_num_total}` | multipart `advertiser_id`, `calculate_type=EMAIL_SHA256`, `file_signature` (MD5), `file_name`, file (one SHA-256 per line, no header); then `{advertiser_id, custom_audience_id, file_paths, action}` |
| Hashing (contracts `normalization.ts`) | lowercase, strip whitespace; gmail/googlemail: drop dots and `+suffix`; phone E.164 with `+` | trim + lowercase; phone digits without `+`; `EXTERN_ID` = SHA-256(lower-cased uid), exactly what the pixel sends | trim + lowercase; phone E.164 with `+` |
| Batch limit | 10,000 members/request; 10 identifiers/member | 10,000 users/request in one session | ≤250 MB per file (2M lines default); <50 file paths per call |
| Minimum size | 100 members to target: a **new** list is not uploaded below 100 | 100 people (lookalike/value seed) | 1,000: create needs ≥1,000; APPEND/REMOVE **fail** below 1,000 |

- **Removals always go out.** They are how consent withdrawals are honoured.
- **TikTok below 1,000.** When a removal would leave a TikTok audience below 1,000, TikTok rejects the REMOVE. The audience is deleted instead (`POST /dmp/custom_audience/delete/`, confirmed in TikTok's official SDK), and recreated once the list is back above 1,000.
  - **Id cleared:** the plan returns `nextAudienceIds` with the deleted id set to `null`. The CLI writes it as `audience-ids-<run>.json`; pass it back with `--audience-ids`, and it overrides the config file. The next sync therefore creates a new audience instead of updating the deleted one.
  - **Change log:** every member the delete took off the platform is logged, including the ones who still qualify (`reason: audience_deleted`). They are re-added when the audience is recreated.
- **TikTok operation order.** APPEND runs before REMOVE, so the size never dips below 1,000 part-way through.
- **TikTok `action` is always explicit,** because the server-side default is REPLACE.
- **Sources.** The doc test vectors are Google's `dana@example.com` → `07e2f139…`, Meta's `mary@example.com` → `f1904cf1…` and TikTok's published hash, which is for `janedoe@gmail.com` even though the page labels it johndoe. Each is re-hashed in the tests with `node:crypto`. The research agents fetched the docs on 2026-09-29.

## Diffs and snapshots (`src/diff.ts`, `src/plan.ts`)

- **What gets diffed.** Each (platform, list) is diffed on the **identifiers actually uploaded**. An email change therefore becomes remove-old plus add-new.
- **Values.** A list whose platform stores the value (Meta value-based seeds, `LOOKALIKE_VALUE`) is diffed on **(identifiers, value bucket)**.
  - Buckets are 20% steps of predicted profit, so cent-level noise does not re-upload the list.
  - A member whose value moved to another bucket is an **update**: re-uploaded with the new value (`reason: value_changed`) and stored in the next snapshot.
  - Google and TikTok lists carry no value and ignore value changes.
  - Meta's docs do not say whether a re-added member's value replaces the stored one. If a live check shows it does not, send the update as remove-then-add.
- **Removal reasons.** Every removal is labelled `consent_withdrawn`, `identifier_changed`, `no_longer_a_candidate`, `no_longer_qualifies` or `audience_deleted`, and carries the identifiers that were uploaded before.
- **The next snapshot is what each list will hold after the sync.** Adds held back by a minimum are left out, so the next run retries them. A deleted TikTok audience starts empty.
- **When to save it.** Persist `snapshot-<run>.jsonl` and `audience-ids-<run>.json` only after every request succeeds, then pass them as `--previous` and `--audience-ids`.
- **Contract validation.** Every change row is validated against the contracts `AudienceMember` schema before it is emitted.
- **Never commit outputs.** `out/`, snapshot directories and every CLI output file are ignored by the package `.gitignore`: they hold unsalted identifier hashes, uids and values.

## Demo (ILLUSTRATIVE)

`npx tsx src/cli.ts --demo --out out/` runs on the 2,000-user contracts cohort. The score is realized profit to date. Consent is an **assumed** CMP: a 60% opt-in rate in consent-required regions, and an 8% sale/sharing opt-out rate elsewhere, recorded explicitly.

- **Consent gate:** 1,736 users pass: 251 by CMP grant and 1,485 by default.
  - Excluded: 152 explicit denials and 112 sale/sharing opt-outs.
- **Lists:** the seeds have 98 members, the active-subscriber suppression list 62 and the low-profit suppression list 733.
- **What gets sent:** only the 733-member list clears Google's and Meta's minimum of 100, so it is the only one sent. Every TikTok list is held below 1,000.
- **Why both seed lists are 98:** most synthetic users have no positive realized profit, so the top decile collapses into the positive seed.
- **With `--consent today_no_cmp`:**
  - the 403 users in consent-required regions (GB, DE, FR) are excluded;
  - 1,597 users pass by default, and the report warns that none of them has an opt-out signal recorded;
  - the low-profit suppression list (682) would be sent to Google and Meta. This is dry-run only: nothing may go live until GPC and the opt-out reach the warehouse.

## Access prerequisites

1. **Consent:** the gating item.
   - Outside consent-required regions: GPC and the sale/sharing opt-out must reach the warehouse per user, or opt-outs cannot be honoured.
   - Inside them: a CMP recording explicit grants.
   - Counsel should confirm the default-eligible policy for each market.
2. **Contact data:** a restricted contact table (`user_id → email, phone_e164`), readable only by this job's service account.
3. **Platform accounts and lists:**
   - **Google:** Customer Match eligibility (policy and payment history; the Targeting setting needs 90 days of history and more than $50k lifetime spend) and accepted Customer Match terms.
   - **Meta:** value-based lookalike terms accepted per ad account.
   - **TikTok:** `Access-Token` scope for audience management.
4. **Runtime:** a Cloud Run Job on Cloud Scheduler, after the warehouse run, with its service account granted BigQuery Data Viewer and Job User, Secret Manager access for the platform tokens, and GCS for snapshots. A live sender would be a separate, reviewed addition. It is deliberately absent here.

## Commands and tests

```bash
npx vitest run                  # 78 tests (network blocked)
npx tsc -p tsconfig.json --noEmit
npx tsx src/cli.ts --demo --out out/
```

**What the tests cover:**
- Per-platform hashing vectors, plus the non-portability across platforms.
- The consent matrix, on the contracts region list:
  - the outermost regions and Åland;
  - default eligibility with no signal recorded;
  - GPC and sale/sharing opt-outs overriding grants;
  - explicit denials from any source;
  - unknown region and the stricter-of rule.
- Seed and suppression semantics: decile with exact rounding, ties, taint, unscored users.
- Diffs: consent withdrawal, email change, value-bucket updates, mixed-list guard.
- Batch limits (10,000 / 10,000 / file lines and 50 paths) and minimum sizes.
- TikTok's 1,000 rule, the delete path, the cleared audience id and the change log of a deleted audience.
- The snapshot lifecycle, including held-add retry and value re-uploads.
- Both warehouse interfaces, including the external-id cross-check and GPC passthrough.
- Zero network calls; the package `.gitignore` rules.
