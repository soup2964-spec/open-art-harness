# @openart-signal/bandit-allocator

A daily job that sets the traffic split of OpenArt's **existing** default-model LaunchDarkly flags, `suite-default-model-create-image` and `suite-default-model-create-video`.

- **Method.** Thompson sampling. The default reward is **p × V − C per exposed user**:
  - p: matured conversion rate (Beta-Binomial);
  - V: value per conversion, pooled across arms and winsorized;
  - C: measured serving cost per exposed user.
- **Output.** Each run emits one LaunchDarkly semantic patch per flag (or an approval request), plus a report that explains every weight and every alert.
- **Fails closed.** A sample-ratio mismatch, a missing input or a check it cannot evaluate means **no patch and an alert**. The CLI then exits 2.

**Nothing is sent by default.** Dry-run is the default and the only mode the tests use. Live writes need `LD_ALLOCATOR_ALLOW_LIVE_WRITES=yes-write-to-launchdarkly`, `LD_API_TOKEN` and an explicitly injected transport. A test-wide guard fails any test that attempts a network call.

## How it plugs into OpenArt (no app change)

```
Suite (unchanged) --LaunchDarkly flag--> default model per user
   --Amplitude ab_suite-default-model-* / $exposure--> warehouse: first exposure per user (intent to treat)
   Stripe + credit ledger + model_costs --> 24h score + matured fixed-horizon outcomes
   fct_experiment_profit_by_arm(_daily) + allocation log --> [this job, Cloud Run Job, daily] --> LaunchDarkly semantic patch
   (weights LaunchDarkly actually served, per day and target)                                  \--> report + alerts (exit 2)
```

- **Flags and arms.** The job only rewrites rollout weights on the two flags that already exist.
  - Image arms: `nano-banana-pro`, `gpt-image-2-5`, `nano-banana-2`, `gpt-image-2`.
  - Video arms: `byte-plus-seedance-2`, `byte-plus-seedance-2-5`, `wan3-0`.
- **Holdout (one-time LaunchDarkly change, no code).** The first rule serves a fixed uniform split to contexts whose key matches `[0-5]$`. The allocator never edits that rule; it is the control of the stop-loss and the guardrails.
  - **The share is gated.** `[0-5]$` matches 6/62 = **9.7%** of base62 uids but 6/16 = **37.5%** of hex keys. The job compares the observed holdout share with the share the predicate should match (`srm.holdoutKeyAlphabet`), and holds on a mismatch.
  - **To confirm with OpenArt:** that the LaunchDarkly context key at generation time is the uid. If it is `oa_device_id` (hex), set the alphabet to `hex` or change the predicate.
  - `allocation_slice` should come from the evaluation reason logged with the exposure, not only from recomputing the regex.
- **Per-segment rules (optional).** Posteriors are kept per segment (country bucket × device × acquisition channel). A rule per country bucket assumes a `country` context attribute, **which is an assumption to confirm**. Without it, delete `ruleTargets` and the job allocates the fallthrough only. `npx tsx src/job.ts --setup` prints the one-time `addRule` approval request.

## Inputs

**1. Native rows** (`src/warehouse.ts`, zod-validated): one row per (`exposure_date`, `flag_key`, `arm`, `country_bucket`, `device`, `acquisition_channel`, `allocation_slice`), intent-to-treat by first exposure.
- **17 required columns:** counts, the 24h score's sum and sum of squares, and its four components.
- **Optional groups** (each all-or-none, NULL when absent):
  - **matured outcomes at a fixed horizon** (default 14 days): `matured_users`, `matured_converted_users`, winsorized `sum(_sq)_matured_value`, `sum(_sq)_matured_cost`, `matured_refunded_users`. A user counts only once the whole horizon has elapsed, so recent days carry 0 matured users rather than partial outcomes;
  - **24h guardrail metrics:** `activated_users`, `generations_24h`, `failed_generations_24h`;
  - **CUPED covariate:** `sum_covariate`, `sum_sq_covariate`, `sum_predicted_profit_x_covariate`, from a PRE-exposure covariate such as the segment's historical score.
- **Sources:** `BigQueryRowSource` (parameterised query through an injected client; it should load the whole sequential window), `JsonlRowSource`, or `--rows`.

**2. The allocation log** (`src/allocation-log.ts`): the rollout weights LaunchDarkly actually served, per (`date`, `flag_key`, `target`, `arm`), in integer units summing to 100000.
- **Targets:** rule-target names, `fallthrough`, and `holdout`.
- **Why it is needed:** SRM checks every bandit slice against it (the current flag snapshot says nothing about past days), and IPW weights users by it.
- **Source of truth:** LaunchDarkly's audit log, expanded per exposure day. When a patch lands mid-day, align the mart's day with the patch time.
- **Missing days:** a day or target without weights **holds** the flag. Backfill the pre-launch split, or add a reset at launch.
- **CLI:** `--allocation-log log.jsonl`. `--allocation-intervals` reads the warehouse's interval format instead (below).

**3. The warehouse's marts** (`packages/warehouse`, being reworked in parallel; adapters for their current columns):
- **`fct_experiment_profit_by_arm_daily`** (`src/warehouse-daily.ts`, `--daily-mart`).
  - **Passes through:** its first 17 columns are the native ones, and since 2026-09-30 it emits the optional groups under the same names (`matured_*` winsorized at `bandit_value_cap_usd`, `activated_users`, `generations_24h`, `failed_generations_24h`, `sum_covariate` …). The default reward, the guardrails and CUPED all run on it.
  - **Maturity caveat:** the mart matures users at `pp_horizon_days` (90 days). Inside the allocator's 56-day lookback nothing is matured, so `decomposed_profit` and `conversion` wait until either the lookback exceeds the horizon or the mart matures these columns at a shorter horizon (the allocator's default is 14 days). The 24h-score reward is unaffected.
  - **Fallback:** an older mart without `sum_covariate*` still gets the CUPED group from its `sum_cuped_covariate*` columns.
  - **Never guessed:** a half-implemented group is rejected by the row schema.
- **`int_experiment__allocation_log`** (valid_from/valid_to intervals per flag, arm and slice; `allocationLogFromIntervals`).
  - It expands to the daily per-target log.
  - It needs a `target` column once per-segment rules exist, and refuses without one.
- **`fct_experiment_profit_by_arm`** (today's flag × arm readout; `src/warehouse-readout.ts`, `--readout`).
  - The adapter still recovers exact sufficient statistics from mean, CI and n.
  - That grain has no holdout slice, so the SRM check cannot run and **the job holds with an alert (no patch)**.

## Algorithm

**Rewards** (`src/posterior.ts`, `src/estimate.ts`). Every reward is **per exposed user**, intent-to-treat: it is the unconditional estimand, not a purchase-conditional ad value.

| `reward` | Model | When the data exists | Per-user SD on the ILLUSTRATIVE cohort |
|---|---|---|---|
| `decomposed_profit` (default) | p ~ Beta-Binomial on matured conversion; C ~ NIG on measured serving cost per exposed user; V pooled across arms (one shared draw per Monte-Carlo sample, so V noise cannot create a spurious winner); μ = p·V − C | after the fixed horizon (14 days) | about $26 |
| `predicted_profit` | NIG on the 24h score, optionally CUPED-adjusted with a pre-exposure covariate | one day after exposure | depends on the score |
| `conversion` | Beta-Binomial on matured conversion | after the horizon | - |

- **Why decompose.** Raw profit per user is heavy-tailed (SD about $90): a converter is worth $10 (monthly) to about $1.2k (annual Wonder). Replacing each converter's own value with the pooled V removes most of that variance.
- **The price** is an assumption: that the default model does not change value per conversion. Validate it against the holdout.
- **Non-subscriber revenue** (one-time packs) is outside p·V − C.

**Non-stationarity** (`src/estimate.ts`):
- **Half-life.** 14 days by default (`halfLifeDays`).
- **Inverse-propensity weighting.** Each user is weighted by 1 / (the logged weight of their arm in their target that day), a Hájek estimator. When the bandit shifts traffic toward an arm, that arm's pooled mean would otherwise over-weight the days it was large on.
- **Kish effective sample size,** (Σw)²/Σw². It drives both the posterior and the minimum-sample rule.
- **Resets.** `resets: [{date, flagKey|null, reason}]` drops earlier exposure days after a default-model or promo change. For the 24h-score reward, a score-model change triggers a reset automatically (only rows scored by the latest model are used).

**Allocation per target** (`src/thompson.ts`):
1. **Stops.**
   - **Stop-loss.** An arm goes to 0% when an always-valid confidence sequence for (arm − control) lies entirely below 0 (`src/sequential.ts`).
     - The test is a normal-mixture mSPRT on day-matched, inverse-variance-weighted differences, and it includes **both** sides' standard errors.
     - The control is the holdout users of the same segments.
     - It is valid over every daily look: P(ever stopping an arm that is not worse) ≤ alpha (0.05 per arm and target), under undecayed data since the reset.
     - The rule it replaces compared the arm's own upper bound with the holdout's **point** estimate. In a 1,000-replication check of null arms, it fired on 21–30% of them per look and on 65–78% over 56 daily looks. The always-valid rule fired on 0–2%. `test/sequential.test.ts` pins both behaviours.
     - The arm's own holdout users count as treatment too, so a stopped arm keeps accruing evidence and can recover.
   - **Guardrails.** The same always-valid test is run on non-profit metrics against the holdout, and an arm is stopped when the confidence sequence shows it worse beyond a margin:
     - activation: 5pp;
     - refunds among converters: 2pp;
     - failed generations: 1pp.
   - **The activation margin is a business choice.** In the ILLUSTRATIVE cohort the profit-best image arm (Nano Banana 2, 20-credit default) activates 2.7pp below the holdout, so a 2pp margin would stop it.
2. **Minimum sample, MDE-based.** An arm is *mature* once its effective n reaches 2(z₁₋α/₂ + z_power)²σ²/MDE², where σ is the pooled per-user SD of the reward.
   - Profit per user is heavy-tailed: **a $2 gap at SD $90 needs about 31,800 users per arm** (alpha 0.05, power 0.8). The decomposed reward needs about 2,700 on the demo cohort.
   - Stopped arms never count toward the rule.
3. **Warm start.** An active arm below the minimum keeps at least `warmStartShare` (10%). A new arm added at 0% is ramped up instead of deadlocking the flag.
4. **Thompson among mature arms.** Weight = P(best), from seeded Monte-Carlo draws (20,000 by default; seeded by config, run date, flag and target, so a re-run is byte-identical).
   - **Expected-loss gate.** Moves happen only while the current split's expected loss, E[max_j μ_j − μ_k] averaged over the current weights, is at least `minExpectedLossToMove` ($0.02 per user). Practically equivalent arms are not churned.
5. **Projection** onto: the floor (5%, or the warm-start share for warming arms), at most ±10pp per day, and a sum of 1.
   - The cap is relaxed only as far as a stop, a floor or a warm start forces, and the report says so.
   - Every active arm can reach its lower bound in one day.
6. **Output.** No patch for moves under 0.5pp. Weights are LaunchDarkly integers summing to exactly 100000, and the patch comment compares integer units.

**Flag-level holds (fail closed, alert):**
- **LaunchDarkly state:**
  - the flag is off;
  - the holdout rule is missing, or a segment rule sits above it;
  - a LaunchDarkly Experimentation rollout;
  - traffic on unmanaged variations.
- **Sample-ratio mismatch** (`src/srm.ts`):
  - the holdout share against the key predicate;
  - the holdout AND every bandit target against the logged weights of each exposure day, as a Pearson test (summing days with different weights keeps it conservative) with Bonferroni across targets;
  - or the check cannot run at all: no holdout slice, too few holdout users, or no allocation log.
- **Differential scoring coverage** across arms.
- **Missing inputs:** the reward's columns, the guardrail columns, the value per conversion, or allocation-log days.

**Robustness:**
- Each flag is isolated: an exception becomes that flag's `error`, and the other flags still run.
- `--min-samples` and `--mde` are validated as positive numbers.
- The config rejects infeasible guardrails at load, for example `maxDailyChange < minExplorationShare` or floors that exceed 100% for a flag.
- `toUnits` throws instead of looping when no weight is positive.
- The report and requests are written **before** any live submit.

## The LaunchDarkly request (`src/launchdarkly.ts`)

Request shapes follow the LaunchDarkly REST docs as fetched on 2026-09-29. The verbatim doc examples are in `test/fixtures/launchdarkly-doc-examples.json`, and the tests validate both those examples and our output against one schema.

- **Direct write:** `PATCH /api/v2/flags/{projectKey}/{flagKey}`, with `Content-Type: application/json; domain-model=launchdarkly.semanticpatch` and body `{environmentKey, comment, instructions}`.
  - The request is all-or-nothing.
  - `?dryRun=true` makes LaunchDarkly validate without persisting.
- **Instructions:** `updateFallthroughVariationOrRollout` and `updateRuleVariationOrRollout {ruleId}`, each with `rolloutWeights` keyed by variation `_id`.
  - Every variation is written explicitly.
  - `addRule` is used only in the one-time setup.
- **Approvals:** in an approval-gated environment a direct PATCH returns 405. Rollout changes then go to `POST /api/v2/projects/{p}/flags/{f}/environments/{e}/approval-requests`. `approvals.mode` selects the path; the default is `approval`.
- **Concurrency:** semantic patch has no version precondition, so live mode re-reads the flag and aborts if the environment version changed.

Example: the fixture cohort's dry run, with small-cohort minimums (`npx tsx src/job.ts --demo --min-samples 50 --mde 100`). At the production MDE nothing on 2,000 users matures, and every target holds. Here the image flag's US and tier-1 rules move toward GPT Image 2.5, capped at +10pp:

```json
POST https://app.launchdarkly.com/api/v2/projects/default/flags/suite-default-model-create-image/environments/production/approval-requests
{
  "description": "Daily default-model allocation for suite-default-model-create-image (2026-08-01), openart-signal bandit-allocator",
  "instructions": [{
    "kind": "updateRuleVariationOrRollout",
    "ruleId": "9d7c1a20-0b4e-4f6a-8c11-1a0000000002",
    "rolloutWeights": { "5b1e…0001": 30000, "5b1e…0002": 30000, "5b1e…0003": 16118, "5b1e…0004": 23882 },
    "rolloutBucketBy": "key",
    "rolloutContextKind": "user"
  }, { "kind": "updateRuleVariationOrRollout", "ruleId": "9d7c1a20-…0003", "…": "…" }],
  "comment": "openart-signal bandit-allocator 2026-08-01 on suite-default-model-create-image: Thompson sampling, reward=decomposed_profit (fct_experiment_profit_by_arm through 2026-07-31), computed from env version 28; holdout rule untouched. rule us: nano-banana-pro 40.0%->30.0% (P(best) 3.9%), gpt-image-2-5 20.0%->30.0% (P(best) 80.1%), nano-banana-2 20.0%->16.1% (P(best) 4.1%), gpt-image-2 20.0%->23.9% (P(best) 11.9%); rule tier1: … Guardrails: floor 5.0%/arm, warm start 10.0%, cap 10.0pp/day, MDE $100/user, always-valid stop-loss (alpha 0.05) vs control, SRM vs logged weights.",
  "notifyTeamKeys": ["growth-data"]
}
```

The flag snapshots in `fixtures/flags/` are **synthetic** (invented `_id`s, salt, rules and weights; only the keys, arm values and edit counts are observed). The fixture cohort was served an equal split, which is its allocation log (`demoAllocationLog`).

## Simulation (`src/simulate.ts`): ILLUSTRATIVE

> Every behavioural number comes from `@openart-signal/contracts/cohort/params`. Those are assumptions, not OpenArt data. The earlier version of this section fed each bandit the realized 90-day profit one day after exposure, from 3 replications; that overstated what a deployment can know and is gone.

**What the bandits see, and when:**
- 60 days, 2,000 signups/day, keys ending in `[0-5]` in the holdout (9.7%), **10 replications** with common random numbers across policies.
- **Day +1:** a signals-only 24h score, fit on 350,000 reference users generated before the experiment under a uniform allocation (paid within 24h, activation, trial credits spent, affiliate channel; no arm feature), plus the 24h guardrail metrics.
- **Day +14:** matured outcomes: conversion, winsorized value, measured serving cost, refunds. A 90-day profit is never fed back.
- The bandits run the real daily job (SRM against the logged allocation, guardrails, always-valid stop-loss, MDE-based minimum) and apply its patch through the in-memory LaunchDarkly emulator, with 4,000 Thompson draws per decision (20,000 in production).
- Policies are scored on **realized 90-day profit**. Regret is against an oracle that serves the best fixed arm pair, calibrated on 50,000 users per arm.
- `npx tsx src/simulate.ts` reproduces it (about 15 minutes; deterministic).

| Policy | Profit / exposed user [95% CI] | Conversion | Serving cost / user | Realized regret vs oracle, $/1k users [95% CI] | Expected regret, $/1k users [95% CI] | Share on NB Pro | Share on Seedance 2.5 | First Thompson move (day) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Today's fixed split (equal) | $10.00 [9.84, 10.16] | 5.0% | $1.29 | 1,699 [1,568, 1,830] | 1,959 [1,955, 1,962] | 25.0% | 33.4% | never |
| Conversion-rewarded bandit | $10.89 [10.70, 11.09] | 5.5% | $1.42 | 808 [624, 992] | 1,099 [1,056, 1,143] | 3.6% | 58.4% | 25 |
| **Profit-rewarded bandit (p·V−C)** | $10.91 [10.71, 11.11] | 5.5% | $1.44 | 791 [624, 958] | 1,010 [955, 1,065] | 3.6% | 62.1% | 18 |
| 24h-score bandit | $10.39 [10.12, 10.67] | 5.2% | $1.27 | 1,308 [1,013, 1,603] | 1,692 [1,537, 1,847] | 3.4% | 36.4% | 2 |
| Oracle (best fixed pair) | $11.70 [11.60, 11.81] | 6.0% | $1.71 | 0 | 0 | 0.0% | 100.0% | never |

**Paired comparisons** (regret of A minus regret of B, $ per 1,000 users, 95% t interval across replications; negative = A better):

| A | B | Realized | Expected | Distinguishable? |
|---|---|---:|---:|---|
| profit bandit | fixed split | −908 [−1,032, −784] | −948 [−1,005, −891] | yes |
| conversion bandit | fixed split | −890 [−1,001, −779] | −859 [−904, −814] | yes |
| 24h-score bandit | fixed split | −391 [−628, −153] | −267 [−423, −110] | yes |
| **profit bandit** | **conversion bandit** | **−18 [−151, 116]** | −89 [−129, −49] | **no** |
| profit bandit | 24h-score bandit | −517 [−766, −268] | −682 [−830, −533] | yes |

**Honest reading:**
- **Both matured-outcome bandits beat the fixed split** by about $0.90 per exposed user, roughly half of the oracle's headroom, and the difference is distinguishable at 95%.
- **The profit bandit and the conversion bandit are not distinguishable** on realized regret: −$18 per 1,000 users with an interval from −$151 to +$116. On expected regret the profit bandit is ahead by $89 per 1,000 users [−129, −49], a small effect. Under these params conversion and profit rank the arms the same way, and every break-even band is 0.13pp wide or less, so no reward could separate them by much.
- **The 24h-score bandit moves on day 2 but ends worse** than the matured bandits (+$517 per 1,000 users). A score with no arm feature mostly says who activated, and it mis-ranks close arms. Its value is speed; on this cohort the matured rewards are worth waiting for.
- **The hypothesised drift is not shown.** The most expensive image default, Nano Banana Pro, is also the worst converter, so every bandit drops it to about 3.5% share. Where profit rewards should matter is where serving cost is not budgeted by credits: unlimited plans, 0-credit promos, heavy free usage.
- **The guardrails cost time.** The matured bandits first move on day 18–25: the 14-day horizon plus the MDE-based minimum. More traffic shortens it. Per run there were 1.0–1.2 guardrail stops and 0.2–0.5 stop-loss stops, and no data holds.

## Operating it: Cloud Run Job + Cloud Scheduler

```bash
# Build once; the job runs `tsx src/job.ts --rows … --allocation-log … --date $(date -u +%F)` or a BigQuery-backed entrypoint.
gcloud run jobs deploy default-model-allocator \
  --image=REGION-docker.pkg.dev/PROJECT/openart-signal/bandit-allocator:TAG \
  --region=us-central1 --tasks=1 --max-retries=0 --task-timeout=10m \
  --service-account=bandit-allocator@PROJECT.iam.gserviceaccount.com \
  --set-secrets=LD_API_TOKEN=launchdarkly-allocator-token:latest
# Daily, after the dbt run that refreshes the mart (e.g. 07:30 UTC):
gcloud scheduler jobs create http default-model-allocator-daily \
  --location=us-central1 --schedule="30 7 * * *" --time-zone=Etc/UTC --http-method=POST \
  --uri="https://run.googleapis.com/v2/projects/PROJECT/locations/us-central1/jobs/default-model-allocator:run" \
  --oauth-service-account-email=scheduler-invoker@PROJECT.iam.gserviceaccount.com
```

- **Alerts.** The CLI exits 2 when the run raised alerts: fail-closed holds, stopped arms or errors. The Cloud Run execution then fails, so alert on failed executions. The report starts with an `ALERTS` section.
- **Idempotency.** Seeded draws plus the minimum-change rule mean a retried run proposes the same patch. In approval mode a retry creates a second approval request, so keep `--max-retries=0`.
- **Outputs.** The report and requests are written to `--out` (GCS) before anything is submitted. `out/` is git-ignored.
- **IAM.** The runtime service account needs BigQuery Data Viewer on the marts dataset, BigQuery Job User, and Secret Manager Secret Accessor. The scheduler account needs Cloud Run Invoker on the job.

## Access prerequisites

1. **LaunchDarkly:**
   - an API access token with a custom role that may update only these two flags in `production`;
   - the approval settings;
   - confirmation that neither flag is a LaunchDarkly Experimentation rollout, and that the context key is the uid (it decides the holdout share);
   - the context attributes available for segment rules;
   - **the audit log of both flags**, which is the allocation log.
2. **Warehouse:** the native grain above, including the 14-day matured group and the 24h guardrail counts (or the daily mart plus those columns). The mart must count every exposed user, including those who never generated.
3. **Governance:** agreed guardrail values (MDE, margins, alpha) and a named approver team (`approvals.notifyTeamKeys`).
4. **Not needed:** an app release, Stripe access or Amplitude write access.

## Commands and tests

```bash
npx vitest run                         # 163 tests (network blocked); ~10 s
npx tsc -p tsconfig.json --noEmit
npx tsx src/job.ts --demo --out out/   # dry run on the fixture cohort (holds: nothing reaches the $2 MDE)
npx tsx src/job.ts --demo --min-samples 50 --mde 100 --out out/   # small-cohort minimums: patches
npx tsx src/simulate.ts --days 10 --users-per-day 300 --replications 2 --calibration-users 4000   # quick look
```

**What the tests cover:**
- Always-valid stop-loss: false-stop rate of null arms over daily looks (new vs old rule), power against a clearly worse arm, and both sides' standard errors.
- Posteriors:
  - NIG closed form and conjugacy;
  - Beta-Binomial;
  - p·V − C as the unconditional estimand, the shared V draw, and the variance reduction over raw profit;
  - the MDE sample size.
- IPW with logged weights removing a time-trend confound; decay; Kish n; resets; CUPED algebra.
- Every guardrail: warm start (no new-arm deadlock), stopped arms outside the minimum-sample rule, expected-loss gate, guardrail stops, feasible projection, `toUnits` guard, cap relaxation, contradiction holds.
- Fail-closed SRM: holdout and bandit targets against logged weights, the holdout-share gate (hex keys), and a missing slice, log or columns.
- Job wiring:
  - per-flag isolation;
  - CLI number validation;
  - integer-unit comments;
  - the report written before a (failing) live submit.
- LaunchDarkly patch format, approvals, emulator round trip, setup idempotence.
- All three warehouse interfaces.
- Cohort inputs: no future leakage, the signals-only score, maturity, winsorization.
- The simulation smoke run, including that matured-outcome bandits never move before their horizon.
- Determinism; the network guard.
