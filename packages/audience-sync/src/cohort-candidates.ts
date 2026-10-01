/**
 * fct_audience_candidates rows computed from the contracts' synthetic cohort, so this
 * package can be tested without the warehouse. ILLUSTRATIVE throughout:
 *   - predicted_profit is the user's REALIZED contribution to date (cash in - refunds -
 *     generation cost at vendor list price - Stripe fees - Tolt commission for affiliates),
 *     standing in for fct_predicted_profit_24h;
 *   - consent is synthesised. `today_no_cmp` reproduces OpenArt today: no CMP, so every signal is
 *     unknown and nothing records GPC or opt-outs; users in consent-required regions are never
 *     uploadable, everyone else is default-eligible (and the plan warns that opt-outs are not
 *     recorded). `illustrative_cmp` assumes a CMP with a 60% opt-in rate in consent-required regions
 *     and an 8% sale/sharing opt-out rate elsewhere, recorded explicitly (assumed rates, not
 *     measurements).
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parseModelCostsCsv, requiresConsent, sha256Hex, unknownConsent, type Consent } from '@openart-signal/contracts';
import type { LedgerEntry, StripeEvent } from '@openart-signal/contracts/builders';
import type { CohortOutput } from '@openart-signal/contracts/cohort';
import type { AudienceCandidateRow } from './types.js';

const require = createRequire(import.meta.url);

/** Amplitude/cohort country names -> ISO 3166-1 alpha-2 (the countries the cohort uses). */
export const COHORT_COUNTRY_ISO2: Readonly<Record<string, string>> = {
  'United States': 'US',
  'United Kingdom': 'GB',
  Germany: 'DE',
  Brazil: 'BR',
  India: 'IN',
  Japan: 'JP',
  France: 'FR',
  Canada: 'CA',
};

export type ConsentScenario = 'today_no_cmp' | 'illustrative_cmp';
export const ILLUSTRATIVE_CONSENT_RATES = { eeaUkChCmpGrantRate: 0.6, elsewhereOptOutRate: 0.08 } as const;
const FEES = { stripePercent: 0.029, stripeFixedUsd: 0.3, affiliateCommission: 0.2 } as const;

type CohortLike = Pick<CohortOutput, 'appUsers' | 'stripeEvents' | 'ledgerEntries' | 'truth'>;

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as T);
}

/** The committed 2,000-user cohort (packages/contracts/fixtures/cohort). */
export function loadFixtureCohort(): CohortLike & { simulationEnd: string } {
  const dir = dirname(require.resolve('@openart-signal/contracts/fixtures/cohort/manifest.json'));
  return {
    appUsers: readJsonl(join(dir, 'app_users.jsonl')),
    stripeEvents: readJsonl(join(dir, 'stripe_events.jsonl')),
    ledgerEntries: readJsonl(join(dir, 'credit_ledger.jsonl')),
    truth: readJsonl(join(dir, 'cohort_truth.jsonl')),
    simulationEnd: '2026-09-28T00:00:00Z',
  };
}

function consentFor(uid: string, iso: string, scenario: ConsentScenario): Consent {
  if (scenario === 'today_no_cmp') return unknownConsent(iso);
  const u = Number.parseInt(sha256Hex(`${uid}|consent`).slice(0, 8), 16) / 2 ** 32;
  if (requiresConsent(iso)) {
    const state = u < ILLUSTRATIVE_CONSENT_RATES.eeaUkChCmpGrantRate ? 'granted' : 'denied';
    return { ad_storage: state, ad_user_data: state, ad_personalization: state, analytics_storage: state, region: iso, source: 'cmp', gpc: false, opt_out_sale_sharing: false };
  }
  const optedOut = u < ILLUSTRATIVE_CONSENT_RATES.elsewhereOptOutRate;
  const state = optedOut ? 'denied' : 'granted';
  return { ad_storage: state, ad_user_data: state, ad_personalization: state, analytics_storage: state, region: iso, source: 'regional_default', gpc: false, opt_out_sale_sharing: optedOut };
}

type Obj = Record<string, unknown>;

export function candidatesFromCohort(cohort: CohortLike, o: { consent: ConsentScenario; computedAt: string }): AudienceCandidateRow[] {
  const costRows = parseModelCostsCsv(readFileSync(require.resolve('@openart-signal/contracts/fixtures/seeds/model_costs.csv'), 'utf8'));
  const cost = new Map(costRows.filter((r) => r.list_cost_usd !== null).map((r) => [`${r.business_type}|${r.credits}`, r.list_cost_usd!]));
  const email = new Map(cohort.appUsers.map((u) => [u.id, u.email]));

  const invoiceCustomer = new Map<string, string>();
  const piInvoice = new Map<string, string>();
  for (const e of cohort.stripeEvents as StripeEvent[]) {
    const obj = e.data.object as Obj;
    if (e.type === 'invoice.paid') invoiceCustomer.set(String(obj.id), String(obj.customer));
    if (e.type === 'invoice_payment.paid') piInvoice.set(String((obj.payment as Obj).payment_intent), String(obj.invoice));
  }
  const money = new Map<string, { gross: number; refunds: number; charges: number; refunded: boolean; disputed: boolean; fraud: boolean }>();
  const acct = (uid: string) => {
    let a = money.get(uid);
    if (!a) money.set(uid, (a = { gross: 0, refunds: 0, charges: 0, refunded: false, disputed: false, fraud: false }));
    return a;
  };
  for (const e of cohort.stripeEvents as StripeEvent[]) {
    const obj = e.data.object as Obj;
    if (e.type === 'invoice.paid' || (e.type === 'checkout.session.completed' && obj.mode === 'payment')) {
      const amount = Number(e.type === 'invoice.paid' ? obj.amount_paid : obj.amount_total);
      const a = acct(String(obj.customer));
      a.gross += amount;
      if (amount > 0) a.charges += 1;
    } else if (e.type === 'charge.refunded') {
      const a = acct(String(obj.customer));
      a.refunds += Number(obj.amount_refunded) - Number((e.data.previous_attributes as Obj | undefined)?.amount_refunded ?? 0);
      a.refunded = true;
    } else if (e.type === 'charge.dispute.created') {
      const customer = invoiceCustomer.get(piInvoice.get(String(obj.payment_intent)) ?? '');
      if (!customer) throw new Error(`dispute ${String(obj.id)} cannot be joined to a customer`);
      const a = acct(customer);
      a.refunds += Number(obj.amount);
      a.disputed = true;
      if (obj.reason === 'fraudulent') a.fraud = true;
    }
  }
  const refundedGen = new Set((cohort.ledgerEntries as LedgerEntry[]).filter((l) => l.type === 'REFUND').map((l) => `${l.userId}|${l.reference.businessId}`));
  const genCost = new Map<string, number>();
  for (const l of cohort.ledgerEntries as LedgerEntry[]) {
    if (l.type !== 'CONSUME' || refundedGen.has(`${l.userId}|${l.reference.businessId}`)) continue;
    const d = l.businessDetails?.[0];
    const unit = cost.get(`${l.reference.businessType}|${d?.unitCredits ?? -l.amount}`);
    if (unit === undefined) throw new Error(`no model_costs row for ${l.reference.businessType}`);
    genCost.set(l.userId, (genCost.get(l.userId) ?? 0) + unit * (d?.quantity ?? 1));
  }

  return cohort.truth.map((t) => {
    const iso = COHORT_COUNTRY_ISO2[t.country];
    if (!iso) throw new Error(`no ISO code for cohort country ${t.country}`);
    const a = money.get(t.user_id) ?? { gross: 0, refunds: 0, charges: 0, refunded: false, disputed: false, fraud: false };
    const gross = a.gross / 100;
    const net = gross - a.refunds / 100;
    const fees = gross * FEES.stripePercent + a.charges * FEES.stripeFixedUsd + (t.channel === 'affiliate' ? FEES.affiliateCommission * Math.max(0, net) : 0);
    const profit = net - (genCost.get(t.user_id) ?? 0) - fees;
    return {
      user_id: t.user_id,
      email: email.get(t.user_id) ?? null,
      phone_e164: null,
      country: iso,
      computed_at: o.computedAt,
      predicted_profit: Math.round(profit * 100) / 100,
      model_version: 'illustrative-realized-to-date-v1',
      is_active_subscriber: t.converted && t.ended_at === null,
      has_refund: a.refunded,
      has_chargeback: a.disputed,
      is_fraud: a.fraud,
      consent: consentFor(t.user_id, iso, o.consent),
    };
  });
}
