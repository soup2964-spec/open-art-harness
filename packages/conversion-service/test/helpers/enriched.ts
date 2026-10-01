import { getPlatformMapping, renderDedupKey, unknownConsent } from '@openart-signal/contracts';
import type { ConversionLedgerEvent, Platform } from '@openart-signal/contracts';
import { DEFAULT_CONSENT_POLICY, decidePlatformConsent } from '../../src/adapters/consent-resolver.js';
import { demoConfig } from '../../src/config.js';
import type { ServiceConfig } from '../../src/config.js';
import { hashIdentity } from '../../src/identity.js';
import { PLATFORM_MODULES } from '../../src/platforms/registry.js';
import type { BuildResult, SendConsent } from '../../src/platforms/types.js';
import type { EnrichedEvent, RequestContext, ResolvedValue } from '../../src/types.js';

export const SYNTH_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 (synthetic)';
export const SYNTH_IP = '203.0.113.7';

export function enrichedFrom(
  row: ConversionLedgerEvent,
  opts: { email?: string; phone?: string; context?: RequestContext; fbc?: string | null; value?: ResolvedValue | null } = {},
): EnrichedEvent {
  return {
    row,
    identity: hashIdentity({ email: opts.email ?? null, phone: opts.phone ?? null }, row.user_id),
    context: opts.context ?? { client_user_agent: SYNTH_UA, client_ip_address: SYNTH_IP },
    fbc: opts.fbc ?? null,
    value: opts.value === undefined ? null : opts.value,
  };
}

export function sendConsent(platform: Platform, consent = unknownConsent('US')): SendConsent {
  const d = decidePlatformConsent(consent, platform, DEFAULT_CONSENT_POLICY, { client_ip_address: SYNTH_IP });
  if (!d.send) throw new Error(`consent blocks ${platform}: ${d.reason}`);
  return d;
}

/** A ResolvedValue with neutral defaults (cash basis, USD, not floored, not pending). */
export function valueOf(v: Partial<ResolvedValue> & { value: number }): ResolvedValue {
  return {
    currency: 'USD',
    basis: 'cash',
    floored: false,
    raw_value: v.value,
    model_version: null,
    predicted_ltv: null,
    in_reporting_currency: true,
    pending: false,
    ...v,
  };
}

export const PREDICTED_22_11: ResolvedValue = valueOf({ value: 22.11, basis: 'predicted_profit_90d', predicted_ltv: 22.11, model_version: 'purchase-value-illustrative-0.1' });
export const CASH_14: ResolvedValue = valueOf({ value: 14 });

export function testConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return demoConfig('/tmp/unused', overrides);
}

export function dedupKeyFor(row: ConversionLedgerEvent, platform: Platform): string {
  const mapping = getPlatformMapping(row.event_name, platform);
  return renderDedupKey(mapping.dedup_key_template!, {
    user_id: row.user_id,
    invoice_id: row.invoice_id,
    event_id: row.event_id,
    order_id: row.order_id,
    adjusts_order_id: row.adjusts_order_id,
  });
}

export function build(platform: Platform, event: EnrichedEvent, config = testConfig(), url = 'https://openart.ai/suite/subscriptions'): BuildResult {
  const mapping = getPlatformMapping(event.row.event_name, platform);
  return PLATFORM_MODULES[platform].buildEvent({
    event,
    mapping,
    consent: sendConsent(platform, event.row.consent),
    config,
    dedupKey: dedupKeyFor(event.row, platform),
    eventSourceUrl: url,
  });
}

export function requestFor(platform: Platform, result: BuildResult, config = testConfig(), action: 'SEND' | 'ADJUST' = 'SEND') {
  if (!result.ok) throw new Error(`build failed: ${result.reason}`);
  return PLATFORM_MODULES[platform].buildRequest(action, result.batchKey, [result.item], config);
}
