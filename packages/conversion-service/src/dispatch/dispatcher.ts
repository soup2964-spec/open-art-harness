/**
 * Dispatcher: one canonical row -> one outbox record per platform (pending, held or skipped).
 * Skips are recorded too, so every (platform, event_id) decision is auditable, including
 * "refund -> Meta: no adjustment API, skipped". Platforms are decided concurrently.
 *
 * Every record carries what its send-time re-checks need, without PII:
 *  - user_id and the row's consent (consent is decided again right before sending, against the
 *    user's current state), plus the consent mode the item was built under;
 *  - the value it carries (value, value_currency, value_basis, value_floored, ...), which also
 *    survives the payload being blanked once the record is terminal (adjustments restate from it);
 *  - for an acquisition purchase still waiting for its purchase-time score (value.pending), the
 *    record is HELD on value_score and the cash needed for a cash_fallback decision.
 * A gate hold (web fix, multi-source, Reddit dedup) is due at its deadline: it is only read again
 * then, or when the gate configuration changes.
 */

import { ADJUSTMENT_EVENT_NAMES, PLATFORMS, getPlatformMapping, renderDedupKey } from '@openart-signal/contracts';
import type { ConversionLedgerEvent, Platform } from '@openart-signal/contracts';
import { decidePlatformConsent } from '../adapters/consent-resolver.js';
import type { DocumentStore } from '../adapters/document-store.js';
import type { Ledger } from '../adapters/ledger.js';
import { LEDGER_LOOKBACK_DAYS } from '../adapters/ledger.js';
import type { ServiceConfig } from '../config.js';
import { STRIPE_STATE, cumulativeFromRefundEventId } from '../ingest/stripe-mapper.js';
import { minorToMajor, roundMajor } from '../money.js';
import type { Outbox } from '../outbox/outbox.js';
import { TERMINAL } from '../outbox/outbox.js';
import { PLATFORM_MODULES } from '../platforms/registry.js';
import type { MetaValue } from '../platforms/types.js';
import type { Clock } from '../time.js';
import { DAY_MS } from '../time.js';
import { outboxKey } from '../types.js';
import type { EnrichedEvent, HoldGate, OutboxAction, OutboxRecord, OutboxStatus, ResolvedValue } from '../types.js';
import { sanitizeEventSourceUrl } from '../url.js';
import { GOOGLE_ADJUSTMENT, MAX_FUTURE_SKEW_MS, MICROSOFT_ADJUSTMENT, evaluateGates, gatesFor, sendWindow } from './policy.js';

const ADJUSTMENTS = new Set<string>(ADJUSTMENT_EVENT_NAMES);

export interface DispatchDeps {
  config: ServiceConfig;
  clock: Clock;
  ledger: Ledger;
  outbox: Outbox;
  store: DocumentStore;
}

function dedupValues(row: ConversionLedgerEvent): Record<string, string | null> {
  return { user_id: row.user_id, invoice_id: row.invoice_id, event_id: row.event_id, order_id: row.order_id, adjusts_order_id: row.adjusts_order_id };
}

/** The value a record carries, as outbox meta (no PII; kept after the payload is blanked). */
export function valueMeta(v: ResolvedValue): Record<string, MetaValue> {
  return {
    value: v.value,
    value_currency: v.currency,
    value_basis: v.basis,
    value_floored: v.floored,
    value_raw: v.raw_value,
    value_model_version: v.model_version,
    value_in_reporting_currency: v.in_reporting_currency,
  };
}

/** Next re-check of a send held for its purchase-time value: every recheckMs, and at the SLA's end. */
export function valueRecheckAt(occurredMs: number, nowMs: number, config: ServiceConfig): number {
  return Math.max(nowMs + 1_000, Math.min(occurredMs + config.value.scoreSlaMs, nowMs + config.value.recheckMs));
}

export class Dispatcher {
  constructor(private readonly deps: DispatchDeps) {}

  /** Decide and enqueue for every platform (concurrently); returns the records now stored for this event. */
  async dispatch(event: EnrichedEvent): Promise<OutboxRecord[]> {
    return Promise.all(
      PLATFORMS.map(async (platform) => {
        const record = await this.decide(event, platform);
        const created = await this.deps.outbox.enqueue(record);
        return created ? record : ((await this.deps.outbox.get(record.key))?.data ?? record);
      }),
    );
  }

  private base(event: EnrichedEvent, platform: Platform, action: OutboxAction): OutboxRecord {
    const now = this.deps.clock();
    const row = event.row;
    const meta: Record<string, MetaValue> = {};
    if (action === 'SEND' && event.value) {
      Object.assign(meta, valueMeta(event.value));
      if (event.value.pending && row.cash_value_minor !== null && row.currency !== null) {
        Object.assign(meta, { value_pending: true, value_cash_minor: row.cash_value_minor, value_cash_currency: row.currency });
      }
    }
    return {
      key: outboxKey(platform, action, row.event_id),
      platform,
      action,
      event_id: row.event_id,
      canonical_event: row.event_name,
      user_id: row.user_id,
      consent: row.consent,
      occurred_at_ms: Date.parse(row.occurred_at),
      status: 'pending',
      reason: null,
      hold_gate: null,
      attempts: 0,
      next_attempt_at_ms: now,
      not_before_ms: null,
      deadline_ms: null,
      lease_until_ms: null,
      batch_key: '',
      item: null,
      meta,
      created_at_ms: now,
      updated_at_ms: now,
      last_error: null,
      history: [],
      expire_at: '',
    };
  }

  private finish(record: OutboxRecord, status: OutboxStatus, reason: string | null, extra: Partial<OutboxRecord> = {}): OutboxRecord {
    const now = this.deps.clock();
    const r: OutboxRecord = { ...record, ...extra, meta: { ...record.meta, ...(extra.meta ?? {}) }, status, reason };
    r.history = [{ at_ms: now, status, reason }];
    // A decision that ends here never needs the platform payload.
    if (TERMINAL.has(status)) r.item = null;
    return r;
  }

  async decide(event: EnrichedEvent, platform: Platform): Promise<OutboxRecord> {
    const { config, clock } = this.deps;
    const row = event.row;
    const mapping = getPlatformMapping(row.event_name, platform);
    const isAdjustment = ADJUSTMENTS.has(row.event_name);
    const action: OutboxAction = mapping.delivery === 'server_adjustment' ? 'ADJUST' : 'SEND';
    const rec = this.base(event, platform, action);

    if (!config.enabledPlatforms.has(platform)) return this.finish(rec, 'skipped', 'platform_disabled');
    if (!mapping.send) {
      return this.finish(rec, 'skipped', isAdjustment ? 'no_adjustment_api' : 'not_sent_by_mapping', { meta: { note: mapping.notes } });
    }
    if (action === 'ADJUST') return this.decideAdjustment(event, platform, rec);

    // Meta and TikTok browser Purchase fire for the FIRST valid purchase only; keep one definition.
    if (row.event_name === 'purchase_first' && (platform === 'meta' || platform === 'tiktok') && row.is_first_purchase !== true) {
      return this.finish(rec, 'skipped', 'not_first_purchase');
    }

    const consent = decidePlatformConsent(row.consent, platform, config.consent, event.context);
    if (!consent.send) return this.finish(rec, 'skipped', consent.reason);

    const now = clock();
    const window = sendWindow(platform, mapping, rec.occurred_at_ms, config);
    const meta: Record<string, MetaValue> = { max_age_ms: window.maxAgeMs, twin_window_ms: window.twinWindowMs, browser_twin: mapping.browser_twin !== null };
    if (rec.occurred_at_ms > now + MAX_FUTURE_SKEW_MS) return this.finish(rec, 'skipped', 'event_time_in_future', { meta });
    if (now > window.deadlineMs) {
      return this.finish(rec, 'skipped', window.twinWindowMs !== null && now - rec.occurred_at_ms <= window.maxAgeMs ? 'twin_window_expired' : 'window_expired', {
        meta,
        deadline_ms: window.deadlineMs,
      });
    }

    let dedupKey: string;
    try {
      dedupKey = renderDedupKey(mapping.dedup_key_template!, dedupValues(row));
    } catch {
      return this.finish(rec, 'skipped', 'dedup_key_unavailable', { meta });
    }
    const built = PLATFORM_MODULES[platform].buildEvent({
      event,
      mapping,
      consent,
      config,
      dedupKey,
      // https only, never a query string or fragment; else the configured canonical page.
      eventSourceUrl: sanitizeEventSourceUrl(event.context.event_source_url) ?? config.eventSourceUrls[row.event_name],
    });
    if (!built.ok) return this.finish(rec, 'skipped', built.reason, { meta });

    const withItem: Partial<OutboxRecord> = {
      item: built.item,
      batch_key: built.batchKey,
      deadline_ms: window.deadlineMs,
      meta: {
        ...meta,
        ...(built.meta ?? {}),
        dedup_key: dedupKey,
        consent_mode: consent.mode,
        has_client_ip: Boolean(event.context.client_ip_address),
      },
    };
    const verdict = evaluateGates(gatesFor(platform, mapping), { event: row.event_name, platform, occurredMs: rec.occurred_at_ms }, config);
    if (verdict.kind === 'drop') return this.finish(rec, 'skipped', verdict.reason, withItem);
    if (verdict.kind === 'hold') {
      // Due only at the deadline (to expire it); a gate opening is picked up by the drainer's full scan.
      return this.finish(rec, 'held', `awaiting_${verdict.gate}`, { ...withItem, hold_gate: verdict.gate as HoldGate, next_attempt_at_ms: window.deadlineMs });
    }
    if (event.value?.pending) {
      return this.finish(rec, 'held', 'awaiting_value_score', { ...withItem, hold_gate: 'value_score', next_attempt_at_ms: valueRecheckAt(rec.occurred_at_ms, now, config) });
    }
    return this.finish(rec, 'pending', null, withItem);
  }

  private async decideAdjustment(event: EnrichedEvent, platform: Platform, rec: OutboxRecord): Promise<OutboxRecord> {
    const { config, ledger, outbox, store, clock } = this.deps;
    const row = event.row;
    if (platform === 'google_ads' && config.google.adjustments === 'off') return this.finish(rec, 'skipped', 'google_adjustments_disabled');
    if (platform === 'microsoft' && config.microsoft.adjustments === 'off') return this.finish(rec, 'skipped', 'microsoft_adjustments_disabled');
    if (!row.adjusts_event_id || !row.adjusts_order_id || row.cash_value_minor === null) return this.finish(rec, 'skipped', 'adjusted_purchase_unknown');
    const adjustmentMs = Date.parse(row.occurred_at);
    const original = await ledger.get(row.adjusts_event_id, { fromMs: adjustmentMs - LEDGER_LOOKBACK_DAYS * DAY_MS, toMs: adjustmentMs + DAY_MS });
    if (!original || original.cash_value_minor === null || original.currency === null) return this.finish(rec, 'skipped', 'adjusted_purchase_unknown');

    const consent = decidePlatformConsent(row.consent, platform, config.consent, event.context);
    if (!consent.send) return this.finish(rec, 'skipped', consent.reason);

    // Supersession: a lower cumulative refund processed after a higher one must not raise the value back.
    // Checked here and again right before sending (the higher refund may be recorded in between).
    let deductionMinor: number;
    const refundMeta: Record<string, MetaValue> = {};
    if (row.event_name === 'refund') {
      const cumulative = cumulativeFromRefundEventId(row.event_id) ?? -row.cash_value_minor;
      const max = row.charge_id ? (await store.get<{ max_cumulative_refunded: number }>(STRIPE_STATE.chargeRefunds, row.charge_id))?.data.max_cumulative_refunded : undefined;
      if (max !== undefined && cumulative < max) return this.finish(rec, 'skipped', 'superseded_by_later_refund');
      deductionMinor = cumulative;
      if (row.charge_id) Object.assign(refundMeta, { charge_id: row.charge_id, cumulative_refunded: cumulative });
    } else {
      deductionMinor = -row.cash_value_minor;
    }

    // Which value did the platform record? Ours if we sent one (kept in meta), else the cash the browser tag sent.
    const originalKey = outboxKey(platform, 'SEND', original.event_id);
    const originalDoc = await outbox.get(originalKey);
    const originalMeta = originalDoc?.data.meta ?? {};
    const legacyItem = (originalDoc?.data.item ?? null) as Record<string, any> | null;
    const sentValue: number | null =
      typeof originalMeta.value === 'number'
        ? originalMeta.value
        : platform === 'google_ads'
          ? (typeof legacyItem?.conversionValue === 'number' ? legacyItem.conversionValue : null)
          : typeof legacyItem?.customData?.value === 'number'
            ? legacyItem.customData.value
            : null;
    const sentCurrency: string =
      (typeof originalMeta.value_currency === 'string' ? originalMeta.value_currency : null) ??
      (platform === 'google_ads' ? legacyItem?.currency : legacyItem?.customData?.currency) ??
      original.currency;
    const cashMajor = minorToMajor(original.cash_value_minor, original.currency);
    const baseValue = sentValue ?? cashMajor;
    const baseCurrency = sentValue === null ? original.currency : sentCurrency;
    const remainingMinor = Math.max(0, original.cash_value_minor - deductionMinor);
    // The ratio is unitless: the restated value stays in the currency the original was sent in.
    const restated = original.cash_value_minor > 0 ? roundMajor((baseValue * remainingMinor) / original.cash_value_minor, baseCurrency) : 0;
    const full = remainingMinor === 0;

    const originalMs = Date.parse(original.occurred_at);
    const now = clock();
    const notBefore = platform === 'google_ads' ? originalMs + GOOGLE_ADJUSTMENT.notBeforeMs : null;
    const deadline = originalMs + (platform === 'google_ads' ? GOOGLE_ADJUSTMENT.maxAgeMs : MICROSOFT_ADJUSTMENT.maxAgeMs);
    const meta: Record<string, MetaValue> = {
      depends_on: originalKey,
      original_event_id: original.event_id,
      original_value: baseValue,
      original_value_source: sentValue === null ? 'cash' : 'sent',
      remaining_cash_minor: remainingMinor,
      within_bidding_window: platform === 'google_ads' ? now - originalMs <= GOOGLE_ADJUSTMENT.biddingWindowMs : null,
      // Microsoft: the UET tag records every purchase's transaction_id, so a first purchase is always there to adjust.
      original_recorded_by_tag: platform === 'microsoft' && original.event_name === 'purchase_first',
      consent_mode: consent.mode,
      has_client_ip: Boolean(event.context.client_ip_address),
      ...refundMeta,
    };
    if (now > deadline) return this.finish(rec, 'skipped', 'adjustment_window_expired', { meta });

    const built = PLATFORM_MODULES[platform].buildAdjustment!({ event, original, restatedValue: restated, currency: baseCurrency, full, consent, config });
    if (!built.ok) return this.finish(rec, 'skipped', built.reason, { meta });
    return this.finish(rec, 'pending', null, {
      item: built.item,
      batch_key: built.batchKey,
      not_before_ms: notBefore,
      next_attempt_at_ms: Math.max(now, notBefore ?? now),
      deadline_ms: deadline,
      meta: { ...meta, ...(built.meta ?? {}) },
    });
  }
}

/**
 * Is the conversion an adjustment points at known to exist on the platform?
 * Adjusting an unknown transactionId in the Data Manager API CREATES a conversion ("treated as a
 * new conversion upload"), so a LIVE adjustment needs our own send to have been recorded: only
 * `sent` counts. A dry_run or validated original never confirms a live adjustment (the platform
 * never recorded it); it confirms only a dry-run preview of the adjustment.
 */
export function adjustmentDependency(record: OutboxRecord, originalStatus: OutboxStatus | null, liveAdjustment = false): 'ready' | 'wait' | 'unconfirmed' {
  if (record.meta.original_recorded_by_tag === true) return 'ready';
  if (originalStatus === 'sent') return 'ready';
  if ((originalStatus === 'dry_run' || originalStatus === 'validated') && !liveAdjustment) return 'ready';
  if (originalStatus === 'pending' || originalStatus === 'held' || originalStatus === 'in_flight') return 'wait';
  return 'unconfirmed';
}
