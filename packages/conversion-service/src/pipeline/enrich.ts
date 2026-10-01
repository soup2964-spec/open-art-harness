/**
 * Enrichment: NormalizedEvent -> EnrichedEvent.
 *   1. user context (their user store): device id, CMP consent/region, raw identity, last-seen UA/IP/cookies
 *   2. consent block for the row (source > stored CMP state > unknown in known region)
 *   3. click ids + UTMs from the ad-click-ids store; fbc from the request or built from fbclid
 *   4. contracts validator (cross-field id invariants) — an invalid row is never written or sent
 *   5. identity hashed per platform (raw PII dropped here)
 *   6. value (the purchase-time value decision, or provisional cash while it is pending)
 * The three lookups (1, 3, 6) are independent and run concurrently.
 */

import { ConversionLedgerEventSchema } from '@openart-signal/contracts';
import type { ConversionLedgerEvent } from '@openart-signal/contracts';
import type { ClickIdResolver } from '../adapters/click-id-resolver.js';
import { resolveRowConsent } from '../adapters/consent-resolver.js';
import type { UserContextReader } from '../adapters/user-context.js';
import type { ValueResolver } from '../adapters/value-resolver.js';
import { hashIdentity } from '../identity.js';
import type { Logger } from '../log.js';
import type { EnrichedEvent, HashedIdentity, NormalizedEvent, RequestContext } from '../types.js';

export interface EnrichDeps {
  userContext: UserContextReader;
  clickIds: Pick<ClickIdResolver, 'resolve'>;
  values: Pick<ValueResolver, 'resolve'>;
  log?: Logger;
}

export type EnrichResult = { ok: true; event: EnrichedEvent } | { ok: false; errors: string[] };

/** The contracts flag-key and arm rules (validators.ts experiment_arms). */
const FLAG_KEY = /^[A-Za-z0-9._-]{1,128}$/;

/** Keep only arms the contract accepts: one bad entry from the user store must not cost a purchase. */
function validArms(arms: Record<string, unknown>): { kept: Record<string, string>; dropped: number } {
  const kept: Record<string, string> = {};
  let dropped = 0;
  for (const [flag, arm] of Object.entries(arms)) {
    if (FLAG_KEY.test(flag) && typeof arm === 'string' && arm.length > 0) kept[flag] = arm;
    else dropped += 1;
  }
  return { kept, dropped };
}

function mergeIdentity(primary: HashedIdentity, fallback: HashedIdentity | undefined): HashedIdentity {
  if (!fallback) return primary;
  return {
    email: Object.keys(primary.email).length > 0 ? primary.email : fallback.email,
    phone: Object.keys(primary.phone).length > 0 ? primary.phone : fallback.phone,
    external_id: primary.external_id ?? fallback.external_id,
  };
}

export async function enrich(n: NormalizedEvent, deps: EnrichDeps, nowMs: number): Promise<EnrichResult> {
  const row: ConversionLedgerEvent = structuredClone(n.row);
  const [user, clicks, value] = await Promise.all([
    row.user_id ? deps.userContext.get(row.user_id) : Promise.resolve(null),
    deps.clickIds.resolve(row, n.context.fbc ?? null),
    deps.values.resolve(row, nowMs),
  ]);

  row.consent = resolveRowConsent(row.consent, n.consentFromSource, user);
  if (!row.device_id && user?.device_id) row.device_id = user.device_id;
  if (Object.keys(row.experiment_arms).length === 0 && user?.experiment_arms) {
    const { kept, dropped } = validArms(user.experiment_arms);
    row.experiment_arms = kept;
    if (dropped > 0) deps.log?.warn('enrich.experiment_arms_dropped', { event_id: row.event_id, dropped });
  }
  row.click_ids = clicks.click_ids;
  row.utm = clicks.utm;

  const parsed = ConversionLedgerEventSchema.safeParse(row);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '/'}: ${i.message}`) };

  const identity = mergeIdentity(
    hashIdentity({ email: n.identity.email ?? user?.email ?? null, phone: n.identity.phone ?? user?.phone ?? null }, row.user_id),
    n.hashedIdentity,
  );
  const context: RequestContext = {
    client_ip_address: user?.client_ip_address ?? null,
    client_user_agent: user?.client_user_agent ?? null,
    fbp: user?.fbp ?? null,
    ttp: user?.ttp ?? null,
    rdt_uuid: user?.rdt_uuid ?? null,
  };
  for (const [k, v] of Object.entries(n.context) as Array<[keyof RequestContext, string | null | undefined]>) {
    if (typeof v === 'string' && v.length > 0) context[k] = v;
  }
  return { ok: true, event: { row, identity, context, fbc: clicks.fbc, value } };
}
