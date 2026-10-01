/**
 * Drainer: claims due outbox records, re-checks everything that can change between queueing and
 * sending, batches per platform destination, validates each request against the platform's
 * documented schema, and sends through the transport.
 *
 * Re-checked right before sending (a record can wait for hours or days):
 *   gates and windows       held records are released or expired; nothing past its send-by deadline goes
 *   purchase-time value     a send held on value_score is patched with the value decision (the score, or
 *                           cash_fallback once VALUE_SCORE_SLA_MS has passed)
 *   adjustment dependency   a LIVE adjustment needs a truly `sent` original (never dry_run or validated)
 *   refund supersession     a partial refund superseded by a larger one recorded later is skipped
 *   consent                 the row's consent merged with the user's CURRENT state (a withdrawal, GPC or a
 *                           sale/sharing opt-out stops the send); the item is sent only if its consent
 *                           claims are no more permissive than what is allowed now
 * Records are evaluated concurrently (OUTBOX_CLAIM_CONCURRENCY) in a deterministic order.
 *
 * Leases: claimed records' leases are renewed every OUTBOX_LEASE_RENEW_MS while the drain is still
 * sending, and again before each chunk, so a slow send never lets another drain reclaim (and resend)
 * them. A record whose renewal fails was taken by someone else and is left alone.
 *
 * Failure handling:
 *   retryable (network, 408, 429, 5xx, platform-specific transient codes)
 *       -> back off (exponential, full jitter, Retry-After honoured) until max attempts or the
 *          record's send-by deadline, then dead-letter.
 *   credential (401/403, Meta 190/10/2xx, TikTok token codes, a token that cannot be minted)
 *       -> retried like the above but never exhausts attempts: it waits for the fixed credential
 *          until its send-by deadline.
 *   rejected batch of >1 event (Google and Meta reject a whole request for one bad event)
 *       -> every record is retried ALONE so the poison event is isolated.
 *   rejected single event / schema-invalid event -> dead-letter with the error.
 * A 2xx for a validation-only request (Google validateOnly, test_event_code, test_id) is recorded as
 * `validated`, never `sent`.
 */

import { getPlatformMapping } from '@openart-signal/contracts';
import type { Consent } from '@openart-signal/contracts';
import { CONSENT_MODE_RANK, decidePlatformConsent, mergeConsentForSend } from '../adapters/consent-resolver.js';
import type { DocumentStore, StoredDoc } from '../adapters/document-store.js';
import type { UserContext, UserContextReader } from '../adapters/user-context.js';
import type { PurchaseValueInput, ValueResolver } from '../adapters/value-resolver.js';
import { mapLimit, serialQueue } from '../concurrency.js';
import type { ServiceConfig } from '../config.js';
import { adjustmentDependency, valueMeta, valueRecheckAt } from '../dispatch/dispatcher.js';
import { evaluateGates, gatesFor } from '../dispatch/policy.js';
import { STRIPE_STATE } from '../ingest/stripe-mapper.js';
import type { Logger } from '../log.js';
import { PLATFORM_MODULES, validateRequest } from '../platforms/registry.js';
import type { PlatformRequest, SendOutcome } from '../platforms/types.js';
import type { Clock } from '../time.js';
import { DAY_MS, HOUR_MS } from '../time.js';
import type { OutboxRecord } from '../types.js';
import { Outbox, backoffMs } from './outbox.js';
import type { Transport } from './transport.js';

export interface DrainReport {
  sent: number;
  validated: number;
  dry_run: number;
  retried: number;
  dead: number;
  skipped: number;
  released: number;
  still_held: number;
  waiting: number;
  requests: number;
}

export interface DrainerDeps {
  outbox: Outbox;
  transport: Transport;
  config: ServiceConfig;
  clock: Clock;
  log: Logger;
  rng?: () => number;
  /** The user's current consent state (send-time re-check). */
  userContext: UserContextReader;
  /** Purchase-time value decisions for sends held on value_score. */
  values: ValueResolver;
  /** Stripe refund state (supersession re-check). */
  store: DocumentStore;
}

type Claimed = StoredDoc<OutboxRecord>;

/** A record this drain claimed; `doc` follows every lease renewal. */
interface Claim {
  doc: Claimed;
  settled: boolean;
  /** Someone else changed the record (lease reclaimed): never send or settle it. */
  lost: boolean;
}

/** Gate configuration; when it changes every held record is looked at once. */
export function gateFingerprint(config: ServiceConfig): string {
  return JSON.stringify({
    web: [...config.webFixesLive.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    multiSource: config.google.multiSourceConfirmed,
    redditDedup: config.reddit.dedupVerified,
  });
}

function emptyReport(): DrainReport {
  return { sent: 0, validated: 0, dry_run: 0, retried: 0, dead: 0, skipped: 0, released: 0, still_held: 0, waiting: 0, requests: 0 };
}

/** The value decision input a held send carries in its meta. */
function valueInputOf(record: OutboxRecord): PurchaseValueInput | null {
  const cash = record.meta.value_cash_minor;
  const currency = record.meta.value_cash_currency;
  if (typeof cash !== 'number' || typeof currency !== 'string') return null;
  return { event_id: record.event_id, user_id: record.user_id, occurred_at_ms: record.occurred_at_ms, cash_minor: cash, currency, acquisition: true };
}

export class Drainer {
  private readonly rng: () => number;
  private lastFingerprint: string | null = null;

  constructor(private readonly deps: DrainerDeps) {
    this.rng = deps.rng ?? Math.random;
  }

  async drain(options: { budgetMs?: number; limit?: number } = {}): Promise<DrainReport> {
    const { outbox, config, clock, log } = this.deps;
    const report = emptyReport();
    const started = clock();
    const budget = options.budgetMs ?? config.outbox.drainBudgetMs;
    const fingerprint = gateFingerprint(config);
    const candidates = await outbox.candidates(options.limit ?? 5000, { allHeld: fingerprint !== this.lastFingerprint });
    this.lastFingerprint = fingerprint;
    const users = new Map<string, Promise<UserContext | null>>();

    const prepared = await mapLimit(candidates, config.outbox.claimConcurrency, async (doc) => {
      if (budget > 0 && clock() - started > budget) return null;
      try {
        return await this.prepare(doc, report, users);
      } catch (err) {
        // One bad record never blocks the rest of the drain.
        log.error('outbox.prepare_failed', { key: doc.key, error: (err as Error).message });
        return null;
      }
    });
    const claims: Claim[] = prepared.filter((d): d is Claimed => d !== null).map((doc) => ({ doc, settled: false, lost: false }));
    if (claims.length === 0) return report;

    const serial = serialQueue();
    const timer = setInterval(() => {
      void serial(() => this.renew(claims)).catch((err: unknown) => log.error('outbox.lease_renewal_failed', { error: (err as Error).message }));
    }, config.outbox.leaseRenewMs);
    timer.unref?.();
    try {
      for (const chunk of this.chunks(claims)) await this.sendChunk(chunk, report, serial);
    } finally {
      clearInterval(timer);
      await serial(async () => undefined);
    }
    return report;
  }

  /** Re-check one due record; returns it claimed (in_flight), or null when it is not sent now. */
  private async prepare(doc: Claimed, report: DrainReport, users: Map<string, Promise<UserContext | null>>): Promise<Claimed | null> {
    const { outbox, config, clock } = this.deps;
    const now = clock();
    let current: Claimed | null = doc;
    const patch: Partial<OutboxRecord> = {};

    if (current.data.status === 'held') {
      const mapping = getPlatformMapping(current.data.canonical_event, current.data.platform);
      const verdict = evaluateGates(gatesFor(current.data.platform, mapping), { event: current.data.canonical_event, platform: current.data.platform, occurredMs: current.data.occurred_at_ms }, config);
      if (verdict.kind === 'hold') {
        if (current.data.deadline_ms !== null && now > current.data.deadline_ms) {
          if (await outbox.transition(current, 'skipped', { reason: 'window_expired_while_held' })) report.skipped += 1;
        } else {
          if (current.data.hold_gate !== verdict.gate) {
            await outbox.transition(current, 'held', { hold_gate: verdict.gate, reason: `awaiting_${verdict.gate}`, next_attempt_at_ms: current.data.deadline_ms ?? now + DAY_MS });
          }
          report.still_held += 1;
        }
        return null;
      }
      if (verdict.kind === 'drop') {
        if (await outbox.transition(current, 'skipped', { reason: verdict.reason })) report.skipped += 1;
        return null;
      }
      if (current.data.hold_gate !== 'value_score') {
        current = await outbox.transition(current, 'pending', { reason: 'gate_released', hold_gate: null, next_attempt_at_ms: now });
        if (!current) return null;
        report.released += 1;
      }
    }

    if (current.data.deadline_ms !== null && now > current.data.deadline_ms) {
      const reason = current.data.attempts > 0 ? 'retry_window_exhausted' : 'window_expired';
      if (await outbox.transition(current, current.data.attempts > 0 ? 'dead' : 'skipped', { reason })) {
        if (current.data.attempts > 0) report.dead += 1;
        else report.skipped += 1;
      }
      return null;
    }
    if (current.data.not_before_ms !== null && now < current.data.not_before_ms) {
      report.waiting += 1;
      return null;
    }

    if (current.data.meta.value_pending === true) {
      const input = valueInputOf(current.data);
      const decided = input ? await this.deps.values.decide(input, now, 'server', { force: false }) : null;
      if (!decided) {
        const next = valueRecheckAt(current.data.occurred_at_ms, now, config);
        if (current.data.status !== 'held' || current.data.hold_gate !== 'value_score' || current.data.next_attempt_at_ms <= now) {
          await outbox.transition(current, 'held', { hold_gate: 'value_score', reason: 'awaiting_value_score', next_attempt_at_ms: next });
        }
        report.still_held += 1;
        return null;
      }
      patch.item = PLATFORM_MODULES[current.data.platform].applyValue(current.data.item as Record<string, unknown>, decided, config);
      patch.meta = { ...current.data.meta, ...valueMeta(decided), value_pending: false };
      patch.hold_gate = null;
      if (current.data.status === 'held') report.released += 1;
    }

    const dependsOn = current.data.meta.depends_on;
    if (typeof dependsOn === 'string') {
      const original = await outbox.get(dependsOn);
      const live = config.mode === 'live' && config.livePlatforms.has(current.data.platform);
      const dep = adjustmentDependency(current.data, original?.data.status ?? null, live);
      if (dep === 'unconfirmed') {
        if (await outbox.transition(current, 'skipped', { reason: 'original_conversion_not_confirmed' })) report.skipped += 1;
        return null;
      }
      if (dep === 'wait') {
        await outbox.transition(current, 'pending', { next_attempt_at_ms: now + HOUR_MS, reason: 'waiting_for_original_conversion' });
        report.waiting += 1;
        return null;
      }
    }

    const chargeId = current.data.meta.charge_id;
    const cumulative = current.data.meta.cumulative_refunded;
    if (current.data.action === 'ADJUST' && typeof chargeId === 'string' && typeof cumulative === 'number') {
      const state = await this.deps.store.get<{ max_cumulative_refunded?: number }>(STRIPE_STATE.chargeRefunds, chargeId);
      const max = state?.data.max_cumulative_refunded;
      if (typeof max === 'number' && cumulative < max) {
        if (await outbox.transition(current, 'skipped', { reason: 'superseded_by_later_refund' })) report.skipped += 1;
        return null;
      }
    }

    const consent = await this.consentAtSend(current.data, users);
    if (consent === 'unavailable') return null;
    if (consent !== 'ok') {
      if (await outbox.transition(current, 'skipped', { reason: consent })) report.skipped += 1;
      return null;
    }

    return outbox.transition(current, 'in_flight', {
      ...patch,
      attempts: current.data.attempts + 1,
      lease_until_ms: now + config.outbox.leaseMs,
      reason: null,
    });
  }

  /**
   * The consent decision right before sending: 'ok', a skip reason, or 'unavailable' (the user's
   * state could not be read: leave the record queued rather than send without the check).
   */
  private async consentAtSend(record: OutboxRecord, users: Map<string, Promise<UserContext | null>>): Promise<string> {
    const { config, log } = this.deps;
    if (!record.consent) return 'ok';
    let current: Consent | null = null;
    if (record.user_id) {
      let lookup = users.get(record.user_id);
      if (!lookup) {
        lookup = this.deps.userContext.get(record.user_id);
        users.set(record.user_id, lookup);
      }
      try {
        current = (await lookup)?.consent ?? null;
      } catch (err) {
        log.warn('outbox.consent_lookup_failed', { key: record.key, error: (err as Error).message });
        return 'unavailable';
      }
    }
    const merged = mergeConsentForSend(record.consent, current);
    const decision = decidePlatformConsent(merged, record.platform, config.consent, { client_ip_address: record.meta.has_client_ip === true ? 'present' : null });
    if (!decision.send) return `${decision.reason}_at_send`;
    const queuedMode = record.meta.consent_mode;
    if (typeof queuedMode === 'string' && queuedMode in CONSENT_MODE_RANK) {
      if (CONSENT_MODE_RANK[queuedMode as keyof typeof CONSENT_MODE_RANK] > CONSENT_MODE_RANK[decision.mode]) return 'consent_changed_since_enqueue';
    }
    return 'ok';
  }

  /** Renew the leases of claims still being worked on; a failed renewal means someone else has the record. */
  private async renew(claims: Claim[]): Promise<void> {
    const { outbox, config } = this.deps;
    await Promise.all(
      claims
        .filter((c) => !c.settled && !c.lost)
        .map(async (c) => {
          const renewed = await outbox.renewLease(c.doc, config.outbox.leaseMs);
          if (renewed) c.doc = renewed;
          else c.lost = true;
        }),
    );
  }

  /** Group by platform + action + batch key; isolate records that were part of a rejected batch. */
  private chunks(claims: Claim[]): Claim[][] {
    const groups = new Map<string, Claim[]>();
    for (const claim of claims) {
      const d = claim.doc.data;
      const solo = d.meta.solo === true;
      const key = `${d.platform}|${d.action}|${d.batch_key}${solo ? `|solo:${claim.doc.key}` : ''}`;
      const list = groups.get(key) ?? [];
      list.push(claim);
      groups.set(key, list);
    }
    const out: Claim[][] = [];
    for (const list of groups.values()) {
      const first = list[0]!.doc.data;
      const size = PLATFORM_MODULES[first.platform].maxBatchSize[first.action] ?? 1;
      for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    }
    return out;
  }

  private build(chunk: Claim[]): PlatformRequest {
    const first = chunk[0]!.doc.data;
    return PLATFORM_MODULES[first.platform].buildRequest(
      first.action,
      first.batch_key,
      chunk.map((c) => c.doc.data.item as Record<string, unknown>),
      this.deps.config,
    );
  }

  private async sendChunk(chunk: Claim[], report: DrainReport, serial: <T>(fn: () => Promise<T>) => Promise<T>): Promise<void> {
    const { outbox, log, config, clock } = this.deps;
    // Earlier chunks may have taken a while: renew leases that are past half-life before sending.
    await serial(() => this.renew(chunk.filter((c) => (c.doc.data.lease_until_ms ?? 0) - clock() < config.outbox.leaseMs / 2)));
    let valid = chunk.filter((c) => !c.lost);
    if (valid.length === 0) return;
    let request = this.build(valid);
    const check = validateRequest(request);
    if (!check.valid) {
      // Find the offending events one by one; dead-letter them and send the rest.
      const good: Claim[] = [];
      await serial(async () => {
        for (const claim of valid) {
          const single = validateRequest(this.build([claim]));
          if (single.valid) {
            good.push(claim);
            continue;
          }
          claim.settled = true;
          if (await outbox.transition(claim.doc, 'dead', { reason: 'request_schema_invalid', last_error: single.errors.join('; ') })) {
            report.dead += 1;
            log.error('outbox.schema_invalid', { key: claim.doc.key, errors: single.errors });
          }
        }
      });
      if (good.length === 0) return;
      valid = good;
      request = this.build(valid);
    }

    report.requests += 1;
    let outcome: SendOutcome;
    try {
      outcome = await this.deps.transport.send(request);
    } catch (err) {
      outcome = { kind: 'retry', status: null, error: `transport: ${(err as Error).message}` };
    }
    await serial(() => this.settle(valid, outcome, request.validationOnly, report));
  }

  private async settle(claims: Claim[], outcome: SendOutcome, validationOnly: boolean, report: DrainReport): Promise<void> {
    const { outbox, config, clock, log } = this.deps;
    const now = clock();
    await Promise.all(
      claims.map(async (claim) => {
        if (claim.lost) return;
        claim.settled = true;
        const doc = claim.doc;
        if (outcome.kind === 'ok') {
          const status = outcome.dryRun ? 'dry_run' : validationOnly ? 'validated' : 'sent';
          if (await outbox.transition(doc, status, { reason: null, lease_until_ms: null, last_error: null })) report[status] += 1;
          return;
        }
        if (outcome.kind === 'fail' && claims.length > 1) {
          // Whole-batch rejection: isolate the poison event by retrying every event on its own.
          await outbox.transition(doc, 'pending', { next_attempt_at_ms: now, lease_until_ms: null, last_error: outcome.error, meta: { ...doc.data.meta, solo: true }, reason: 'batch_rejected_isolating' });
          report.retried += 1;
          return;
        }
        if (outcome.kind === 'retry') {
          const delay = Math.max(outcome.retryAfterMs ?? 0, backoffMs(doc.data.attempts, config.outbox.baseBackoffMs, config.outbox.maxBackoffMs, this.rng));
          const next = now + delay;
          // A credential failure waits for the fix: only the send-by deadline ends it.
          const outOfAttempts = outcome.auth !== true && doc.data.attempts >= config.outbox.maxAttempts;
          const exhausted = outOfAttempts || (doc.data.deadline_ms !== null && next > doc.data.deadline_ms);
          if (exhausted) {
            if (await outbox.transition(doc, 'dead', { reason: 'retries_exhausted', last_error: outcome.error, lease_until_ms: null })) report.dead += 1;
            log.error('outbox.dead_letter', { key: doc.key, error: outcome.error });
          } else if (await outbox.transition(doc, 'pending', { next_attempt_at_ms: next, last_error: outcome.error, lease_until_ms: null, reason: outcome.auth ? 'credential_retry_scheduled' : 'retry_scheduled' })) {
            report.retried += 1;
            if (outcome.auth) log.error('outbox.credential_failure', { key: doc.key, platform: doc.data.platform, error: outcome.error });
          }
          return;
        }
        if (await outbox.transition(doc, 'dead', { reason: 'rejected_by_platform', last_error: outcome.error, lease_until_ms: null })) report.dead += 1;
        log.error('outbox.dead_letter', { key: doc.key, error: outcome.error });
      }),
    );
  }
}
