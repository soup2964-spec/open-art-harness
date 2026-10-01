/**
 * Fill the /enterprise contact form's hidden attribution fields from OpenArt's first-party
 * stores (oa_ad_clids, _fbc, oa_utm; vendor/Amplitude cookies as fallback).
 *
 * The page (raw/enterprise/enterprise_page.html) embeds a form built in HubSpot's new forms
 * editor ("v4" embed):
 *   <script src="https://js-na2.hsforms.net/forms/embed/244977254.js" defer></script>
 *   <div class="hs-form-frame" data-region="na2" data-form-id="9f0b1fda-…" data-portal-id="244977254"></div>
 * The form renders in a cross-origin iframe, so the parent page cannot touch its inputs. HubSpot
 * documents a parent-page API for exactly this (developers.hubspot.com/docs/api-reference/latest/
 * marketing/forms/global-form-events, fetched 2026-09-29):
 *   - window events `hs-form-event:on-ready`, `…:on-submission:success`, … with
 *     `event.detail = { formId, instanceId }`
 *   - `window.HubSpotFormsV4.getFormFromEvent(event)` / `.getForms()` return form instances
 *   - instance methods `getFormId()`, async `getFormFieldValues()`, `setFieldValue(name, value)`;
 *     field names are `<objectTypeId>/<property>` (e.g. "0-1/gclid"); hidden fields take string[]
 *   - "define any hs-form-event:on-ready listeners on your page before the form embed code is
 *     executed" — so this script must be placed above the embed <script>.
 *
 * Consent (../consent/CONSENT.md): the click ids and fbc are ad identifiers. Under an explicit
 * ad_storage denial, Global Privacy Control or a US sale/sharing opt-out (the order
 * ../consent/src/privacy-signals.ts applies, shared with the shim and edge-attribution) only the
 * non-identifying UTM fields are filled.
 */
import { readAttributionSnapshot, type AttributionEnv, type AttributionSnapshot } from '../../app-patches/src/attribution-snapshot';
import { adConsentDecision, allowsAdIdentifiers, readPrivacySignals, type PrivacySignalWindow } from '../../consent/src/privacy-signals';

export const HUBSPOT_PORTAL_ID = 244977254;
export const ENTERPRISE_FORM_ID = '9f0b1fda-34f1-4364-93d5-bdc196c44004';
export const HS_READY_EVENT = 'hs-form-event:on-ready';

export interface FieldMapping {
  /** HubSpot field name as used by the v4 API: "<objectTypeId>/<property internal name>". */
  field: string;
  source: (snapshot: AttributionSnapshot) => string | undefined;
  /** An advertising identifier (click id, fbc): withheld without ad consent. UTMs are not. */
  adIdentifier: boolean;
}

/**
 * gclid / gbraid / wbraid exist on the form today (never filled); the rest are the hidden fields
 * FORM_FIX.md adds. `fbc` and `msclkid` are optional extras, filled only if the form has them.
 */
export const FIELD_MAP: readonly FieldMapping[] = [
  { field: '0-1/gclid', source: (s) => s.clickIds.gclid, adIdentifier: true },
  { field: '0-1/gbraid', source: (s) => s.clickIds.gbraid, adIdentifier: true },
  { field: '0-1/wbraid', source: (s) => s.clickIds.wbraid, adIdentifier: true },
  { field: '0-1/fbclid', source: (s) => s.clickIds.fbclid, adIdentifier: true },
  { field: '0-1/ttclid', source: (s) => s.clickIds.ttclid, adIdentifier: true },
  { field: '0-1/li_fat_id', source: (s) => s.clickIds.li_fat_id, adIdentifier: true },
  { field: '0-1/utm_source', source: (s) => s.utm.utm_source, adIdentifier: false },
  { field: '0-1/utm_medium', source: (s) => s.utm.utm_medium, adIdentifier: false },
  { field: '0-1/utm_campaign', source: (s) => s.utm.utm_campaign, adIdentifier: false },
  { field: '0-1/utm_term', source: (s) => s.utm.utm_term, adIdentifier: false },
  { field: '0-1/utm_content', source: (s) => s.utm.utm_content, adIdentifier: false },
  { field: '0-1/fbc', source: (s) => s.fbc, adIdentifier: true },
  { field: '0-1/msclkid', source: (s) => s.clickIds.msclkid, adIdentifier: true },
];

export type HubSpotFieldValue = string | string[] | number | boolean;

export interface HubSpotFormInstance {
  getFormId: () => string;
  getInstanceId?: () => string;
  getFormFieldValues: () => Promise<Array<{ name: string; value: HubSpotFieldValue }>>;
  setFieldValue: (name: string, value: HubSpotFieldValue) => void;
}

export interface HubSpotFormsV4Api {
  getForms: () => HubSpotFormInstance[];
  getFormFromEvent: (event: Event) => HubSpotFormInstance | undefined;
}

export interface FillWindow {
  document: { cookie: string };
  navigator?: PrivacySignalWindow['navigator'];
  __oaConsent?: PrivacySignalWindow['__oaConsent'];
  localStorage?: Pick<Storage, 'getItem'> | null;
  HubSpotFormsV4?: HubSpotFormsV4Api;
  addEventListener: (type: string, listener: (event: Event) => void) => void;
  removeEventListener: (type: string, listener: (event: Event) => void) => void;
}

export interface FillOptions {
  formId?: string;
  /** Extra constant hidden values, e.g. {"0-1/lead_source_detail": "enterprise_contact_form"}. Off by default. */
  staticFields?: Record<string, string>;
  /** Overwrite values that are already present (default false: keep query-string pre-fills). */
  overwrite?: boolean;
  onFilled?: (report: FillReport) => void;
}

export interface FillReport {
  formId: string;
  instanceId: string | undefined;
  /** Field names that were set (values are never reported). */
  set: string[];
  /** Mapped fields with a value that the form does not have. */
  missingOnForm: string[];
  /** Fields left alone because they already had a value. */
  keptExisting: string[];
  /** Ad-identifier fields with a value that were not filled (no ad consent, GPC or an opt-out). */
  withheld: string[];
  listedFields: boolean;
}

/**
 * Field -> value for everything we have, from the attribution snapshot. With
 * `adIdentifiers: false` the click ids and fbc are left out.
 */
export function collectFieldValues(
  snapshot: AttributionSnapshot,
  staticFields: Record<string, string> = {},
  opts: { adIdentifiers?: boolean } = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { field, source, adIdentifier } of FIELD_MAP) {
    if (adIdentifier && opts.adIdentifiers === false) continue;
    const value = source(snapshot);
    if (value) out[field] = value;
  }
  for (const [field, value] of Object.entries(staticFields)) if (value) out[field] = value;
  return out;
}

/** Ad-identifier fields that have a value in the snapshot (for the report; names only). */
function adIdentifierFieldsWithValue(snapshot: AttributionSnapshot): string[] {
  return FIELD_MAP.filter((m) => m.adIdentifier && !!m.source(snapshot)).map((m) => m.field);
}

function isEmpty(value: HubSpotFieldValue | undefined): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value)) return value.every((v) => v === '' || v === undefined || v === null);
  return false;
}

/** Set every attribution field the form has. Hidden fields get string[] (HubSpot docs table). */
export async function fillForm(form: HubSpotFormInstance, values: Record<string, string>, opts: Pick<FillOptions, 'overwrite'> = {}): Promise<FillReport> {
  const report: FillReport = {
    formId: form.getFormId(),
    instanceId: form.getInstanceId?.(),
    set: [],
    missingOnForm: [],
    keptExisting: [],
    withheld: [],
    listedFields: false,
  };
  let existing: Map<string, HubSpotFieldValue> | null = null;
  try {
    const listed = await form.getFormFieldValues();
    existing = new Map(listed.map((f) => [f.name, f.value]));
    report.listedFields = true;
  } catch {
    existing = null; // fall back to best-effort sets
  }
  for (const [field, value] of Object.entries(values)) {
    if (existing && !existing.has(field)) {
      report.missingOnForm.push(field);
      continue;
    }
    const current = existing?.get(field);
    if (existing && !opts.overwrite && !isEmpty(current)) {
      report.keptExisting.push(field);
      continue;
    }
    try {
      // Hidden fields are string[] in the v4 API; plain text fields are strings.
      form.setFieldValue(field, typeof current === 'string' ? value : [value]);
      report.set.push(field);
    } catch {
      report.missingOnForm.push(field);
    }
  }
  return report;
}

/**
 * Register the listener (call before the HubSpot embed script executes) and fill any form that
 * is already ready. Returns an uninstall function.
 */
export function installHubSpotFill(win: FillWindow, opts: FillOptions = {}): () => void {
  const formId = opts.formId ?? ENTERPRISE_FORM_ID;
  const done = new Set<string>();

  const handle = async (form: HubSpotFormInstance | undefined): Promise<void> => {
    if (!form) return;
    let id: string;
    try {
      id = form.getFormId();
    } catch {
      return;
    }
    if (id !== formId) return;
    const key = `${id}:${form.getInstanceId?.() ?? ''}`;
    if (done.has(key)) return;
    done.add(key);
    const env: AttributionEnv = { cookie: win.document.cookie, localStorage: win.localStorage ?? null };
    const snapshot = readAttributionSnapshot(env);
    // Read at fill time: the CMP may have recorded a choice since the page loaded.
    const adIdentifiers = allowsAdIdentifiers(adConsentDecision(readPrivacySignals(win)));
    const values = collectFieldValues(snapshot, opts.staticFields, { adIdentifiers });
    const report = await fillForm(form, values, { overwrite: opts.overwrite });
    if (!adIdentifiers) report.withheld = adIdentifierFieldsWithValue(snapshot);
    opts.onFilled?.(report);
  };

  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<{ formId?: string }>).detail;
    if (detail?.formId && detail.formId !== formId) return;
    void handle(win.HubSpotFormsV4?.getFormFromEvent(event)).catch(() => undefined);
  };
  win.addEventListener(HS_READY_EVENT, listener);

  // The embed may already have rendered (script placed late, or a client-side re-mount).
  try {
    for (const form of win.HubSpotFormsV4?.getForms() ?? []) void handle(form).catch(() => undefined);
  } catch {
    // API not there yet: the ready event will arrive
  }

  return () => win.removeEventListener(HS_READY_EVENT, listener);
}
