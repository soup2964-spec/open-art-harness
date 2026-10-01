/**
 * User context: what OpenArt's backend already knows about a uid and the conversion
 * senders need but Stripe does not carry (email for matching, device id, CMP consent,
 * country, last-seen IP/UA and first-party cookies).
 *
 * Production: a BigQuery view `conversion_user_context` over the replicated app-user store
 * (see infra/conversion-service/bigquery/tables.sql). Tests: InMemoryUserContext.
 */

import { ConsentSchema } from '@openart-signal/contracts';
import type { Consent } from '@openart-signal/contracts';
import { bqJson, bqScalar, qualifiedTable } from './bigquery.js';
import type { BigQueryPort, TableRef } from './bigquery.js';

export interface UserContext {
  user_id: string;
  email?: string | null;
  phone?: string | null;
  device_id?: string | null;
  /** Latest CMP consent state for the user, if a CMP exists. */
  consent?: Consent | null;
  /** ISO 3166-1 alpha-2 (optionally US-CA style) from the backend's country signal. */
  region?: string | null;
  /** Last-seen browser context (captured by the backend at signup/checkout). */
  client_ip_address?: string | null;
  client_user_agent?: string | null;
  fbp?: string | null;
  ttp?: string | null;
  rdt_uuid?: string | null;
  experiment_arms?: Record<string, string>;
}

export interface UserContextReader {
  get(userId: string): Promise<UserContext | null>;
}

export class InMemoryUserContext implements UserContextReader {
  private readonly byId = new Map<string, UserContext>();

  constructor(contexts: UserContext[] = []) {
    for (const c of contexts) this.byId.set(c.user_id, structuredClone(c));
  }

  set(context: UserContext): void {
    this.byId.set(context.user_id, structuredClone(context));
  }

  async get(userId: string): Promise<UserContext | null> {
    const hit = this.byId.get(userId);
    return hit ? structuredClone(hit) : null;
  }
}

const REGION = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;

/** Exactly the columns the service reads (the view holds raw PII: never SELECT *). */
const USER_CONTEXT_COLUMNS = [
  'email', 'phone', 'device_id', 'consent', 'region', 'client_ip_address', 'client_user_agent', 'fbp', 'ttp', 'rdt_uuid', 'experiment_arms',
] as const;

export class BigQueryUserContextReader implements UserContextReader {
  private readonly table: string;

  constructor(
    private readonly bq: BigQueryPort,
    ref: TableRef,
  ) {
    this.table = qualifiedTable(ref);
  }

  async get(userId: string): Promise<UserContext | null> {
    const rows = await this.bq.query<Record<string, unknown>>(
      `SELECT ${USER_CONTEXT_COLUMNS.join(', ')} FROM ${this.table} WHERE user_id = @user_id ORDER BY updated_at DESC LIMIT 1`,
      { user_id: userId },
    );
    const r = rows[0];
    if (!r) return null;
    const text = (k: string): string | null => {
      const v = bqScalar(r[k]);
      return typeof v === 'string' && v.length > 0 ? v : null;
    };
    const consentRaw = bqJson<unknown>(r.consent, null);
    const consent = consentRaw === null ? null : ConsentSchema.safeParse(consentRaw);
    const region = text('region');
    return {
      user_id: userId,
      email: text('email'),
      phone: text('phone'),
      device_id: text('device_id'),
      consent: consent && consent.success ? consent.data : null,
      region: region && REGION.test(region) ? region : null,
      client_ip_address: text('client_ip_address'),
      client_user_agent: text('client_user_agent'),
      fbp: text('fbp'),
      ttp: text('ttp'),
      rdt_uuid: text('rdt_uuid'),
      experiment_arms: bqJson<Record<string, string>>(r.experiment_arms, {}),
    };
  }
}
