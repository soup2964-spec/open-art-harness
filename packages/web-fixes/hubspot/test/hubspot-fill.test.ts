// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { createTestWindow, type TestWindow } from '../../test-utils/dom';
import { readFixture } from '../../test-utils/fixtures';
import { readAttributionSnapshot } from '../../app-patches/src/attribution-snapshot';
import {
  ENTERPRISE_FORM_ID,
  FIELD_MAP,
  HS_READY_EVENT,
  collectFieldValues,
  fillForm,
  installHubSpotFill,
  type FillReport,
  type FillWindow,
  type HubSpotFieldValue,
  type HubSpotFormInstance,
  type HubSpotFormsV4Api,
} from '../src/hubspot-fill';

const DEFINITION = JSON.parse(readFixture(import.meta.url, './fixtures/hs_form_render_definition.json')) as {
  form: { modules: unknown[] };
};

function hiddenFields(): Array<{ propertyReference: string; values?: string[] }> {
  const out: Array<{ propertyReference: string; values?: string[] }> = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string; propertyReference?: string; values?: string[]; modules?: unknown[] };
    if (n.type === 'hidden' && n.propertyReference) out.push({ propertyReference: n.propertyReference, values: n.values });
    for (const child of n.modules ?? []) walk(child);
  };
  for (const m of DEFINITION.form.modules) walk(m);
  return out;
}

/** A v4 form instance as HubSpot documents it, recording setFieldValue calls. */
function fakeForm(formId: string, fields: Record<string, HubSpotFieldValue>, instanceId = 'inst-1') {
  const sets: Array<[string, HubSpotFieldValue]> = [];
  const form: HubSpotFormInstance = {
    getFormId: () => formId,
    getInstanceId: () => instanceId,
    getFormFieldValues: async () => Object.entries(fields).map(([name, value]) => ({ name, value })),
    setFieldValue: (name, value) => {
      sets.push([name, value]);
      fields[name] = value;
    },
  };
  return { form, sets, fields };
}

/** Fields of the live form (render definition) after FORM_FIX.md is applied. */
function enterpriseFieldsAfterFix(): Record<string, HubSpotFieldValue> {
  const fields: Record<string, HubSpotFieldValue> = {
    '0-1/firstname': '',
    '0-1/lastname': '',
    '0-1/company': '',
    '0-1/email': '',
    '0-1/lead_source': [],
    '0-1/lead_source_detail': [],
    '0-1/latest_form_submit_url': ['https://openart.ai/enterprise/#contact'],
    '0-1/gclid': [],
    '0-1/gbraid': [],
    '0-1/wbraid': [],
  };
  for (const f of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'li_fat_id', 'fbclid', 'ttclid']) fields[`0-1/${f}`] = [];
  return fields;
}

const opened: TestWindow[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

function enterprisePage(): TestWindow {
  const t = createTestWindow({ url: 'https://openart.ai/enterprise/' });
  opened.push(t);
  t.jar.seed(
    'oa_ad_clids',
    encodeURIComponent(
      JSON.stringify({ gclid: { v: 'KJAUDIT_G', ts: 1 }, gbraid: { v: 'KJAUDIT_GB', ts: 1 }, li_fat_id: { v: 'KJAUDIT_L', ts: 1 }, ttclid: { v: 'KJAUDIT_T', ts: 1 } }),
    ),
  );
  t.jar.seed('_fbc', 'fb.1.1790701395081.KJAUDIT_F');
  t.jar.seed('oa_utm', encodeURIComponent(JSON.stringify({ utm_source: 'linkedin', utm_medium: 'paid_social', utm_campaign: 'enterprise_q4', ts: 1 })));
  return t;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('field map vs the live form definition (raw/enterprise/hs_form_render_definition.json)', () => {
  it('targets the three click-id hidden fields that exist today, by their exact names', () => {
    const existing = hiddenFields().map((h) => h.propertyReference);
    for (const name of ['0-1/gclid', '0-1/gbraid', '0-1/wbraid']) {
      expect(existing).toContain(name);
      expect(FIELD_MAP.map((m) => m.field)).toContain(name);
    }
  });

  it('never writes lead_source / lead_source_detail (their hard-coded defaults are removed in HubSpot instead)', () => {
    const defaults = Object.fromEntries(hiddenFields().map((h) => [h.propertyReference, h.values]));
    expect(defaults['0-1/lead_source']).toEqual(['Event']);
    expect(defaults['0-1/lead_source_detail']).toEqual(['Brandweek']);
    expect(FIELD_MAP.map((m) => m.field)).not.toContain('0-1/lead_source');
    expect(FIELD_MAP.map((m) => m.field)).not.toContain('0-1/lead_source_detail');
  });
});

describe('installHubSpotFill', () => {
  it('fills the hidden fields from first-party stores when HubSpot fires on-ready', async () => {
    const t = enterprisePage();
    const { form, sets } = fakeForm(ENTERPRISE_FORM_ID, enterpriseFieldsAfterFix());
    const api: HubSpotFormsV4Api = { getForms: () => [], getFormFromEvent: () => form };
    const w = t.window as unknown as FillWindow;
    w.HubSpotFormsV4 = api;
    const reports: FillReport[] = [];
    installHubSpotFill(w, { onFilled: (r) => reports.push(r) });

    t.window.dispatchEvent(new t.window.CustomEvent(HS_READY_EVENT, { detail: { formId: ENTERPRISE_FORM_ID, instanceId: 'inst-1' } }));
    await flush();

    expect(Object.fromEntries(sets)).toEqual({
      '0-1/gclid': ['KJAUDIT_G'],
      '0-1/gbraid': ['KJAUDIT_GB'],
      '0-1/fbclid': ['KJAUDIT_F'],
      '0-1/ttclid': ['KJAUDIT_T'],
      '0-1/li_fat_id': ['KJAUDIT_L'],
      '0-1/utm_source': ['linkedin'],
      '0-1/utm_medium': ['paid_social'],
      '0-1/utm_campaign': ['enterprise_q4'],
    });
    expect(reports[0]).toMatchObject({ formId: ENTERPRISE_FORM_ID, listedFields: true });
    expect(reports[0]!.missingOnForm).toEqual(['0-1/fbc']); // optional field not on the form: skipped
  });

  describe('respects GPC and US opt-out signals (review: consent consistency)', () => {
    const UTM_ONLY = { '0-1/utm_source': ['linkedin'], '0-1/utm_medium': ['paid_social'], '0-1/utm_campaign': ['enterprise_q4'] };
    const WITHHELD = ['0-1/gclid', '0-1/gbraid', '0-1/fbclid', '0-1/ttclid', '0-1/li_fat_id', '0-1/fbc'];
    const setups: Array<[string, (t: TestWindow) => void]> = [
      ['Global Privacy Control', (t) => Object.defineProperty(t.window.navigator, 'globalPrivacyControl', { configurable: true, value: true })],
      ['usprivacy=1YYN', (t) => t.jar.seed('usprivacy', '1YYN')],
      ['oa_consent opt_out_sale_sharing (with ad_storage granted)', (t) => t.jar.seed('oa_consent', encodeURIComponent(JSON.stringify({ ad_storage: 'granted', opt_out_sale_sharing: true })))],
      ['an explicit ad_storage denial', (t) => t.jar.seed('oa_consent', encodeURIComponent(JSON.stringify({ ad_storage: 'denied' })))],
    ];
    for (const [label, setup] of setups) {
      it(`fills only the UTM fields under ${label}`, async () => {
        const t = enterprisePage();
        setup(t);
        const { form, sets } = fakeForm(ENTERPRISE_FORM_ID, enterpriseFieldsAfterFix());
        const w = t.window as unknown as FillWindow;
        w.HubSpotFormsV4 = { getForms: () => [form], getFormFromEvent: () => form };
        const reports: FillReport[] = [];
        installHubSpotFill(w, { onFilled: (r) => reports.push(r) });
        await flush();
        expect(Object.fromEntries(sets)).toEqual(UTM_ONLY);
        expect(reports[0]!.withheld.sort()).toEqual([...WITHHELD].sort());
      });
    }

    it('an explicit grant over GPC fills the click ids (the visitor opted back in)', async () => {
      const t = enterprisePage();
      Object.defineProperty(t.window.navigator, 'globalPrivacyControl', { configurable: true, value: true });
      t.jar.seed('oa_consent', encodeURIComponent(JSON.stringify({ ad_storage: 'granted' })));
      const { form, sets } = fakeForm(ENTERPRISE_FORM_ID, enterpriseFieldsAfterFix());
      const w = t.window as unknown as FillWindow;
      w.HubSpotFormsV4 = { getForms: () => [form], getFormFromEvent: () => form };
      installHubSpotFill(w);
      await flush();
      expect(sets.map(([n]) => n)).toContain('0-1/gclid');
    });

    it('collectFieldValues drops click ids and fbc when ad identifiers are not allowed', () => {
      const t = enterprisePage();
      const snapshot = readAttributionSnapshot({ cookie: t.window.document.cookie });
      expect(Object.keys(collectFieldValues(snapshot, {}, { adIdentifiers: false })).sort()).toEqual(Object.keys(UTM_ONLY).sort());
      expect(Object.keys(collectFieldValues(snapshot))).toContain('0-1/gclid');
    });
  });

  it('works on today’s form too: only gclid/gbraid/wbraid exist, everything else is reported missing', async () => {
    const t = enterprisePage();
    const today: Record<string, HubSpotFieldValue> = { '0-1/email': '', '0-1/gclid': [], '0-1/gbraid': [], '0-1/wbraid': [] };
    const { form, sets } = fakeForm(ENTERPRISE_FORM_ID, today);
    const w = t.window as unknown as FillWindow;
    w.HubSpotFormsV4 = { getForms: () => [form], getFormFromEvent: () => form };
    installHubSpotFill(w); // form already ready when the script runs
    await flush();
    expect(sets.map((s) => s[0])).toEqual(['0-1/gclid', '0-1/gbraid']);
  });

  it('ignores other forms, fills each instance once and keeps query-string pre-fills', async () => {
    const t = enterprisePage();
    const other = fakeForm('00000000-0000-0000-0000-000000000000', { '0-1/gclid': [] });
    const fields = enterpriseFieldsAfterFix();
    fields['0-1/utm_source'] = ['from_query_string'];
    const mine = fakeForm(ENTERPRISE_FORM_ID, fields);
    let next: HubSpotFormInstance = other.form;
    const w = t.window as unknown as FillWindow;
    w.HubSpotFormsV4 = { getForms: () => [], getFormFromEvent: () => next };
    installHubSpotFill(w);
    t.window.dispatchEvent(new t.window.CustomEvent(HS_READY_EVENT, { detail: { formId: 'other' } }));
    next = mine.form;
    t.window.dispatchEvent(new t.window.CustomEvent(HS_READY_EVENT, { detail: { formId: ENTERPRISE_FORM_ID } }));
    t.window.dispatchEvent(new t.window.CustomEvent(HS_READY_EVENT, { detail: { formId: ENTERPRISE_FORM_ID } }));
    await flush();
    expect(other.sets).toEqual([]);
    expect(mine.sets.filter(([n]) => n === '0-1/gclid')).toHaveLength(1);
    expect(mine.fields['0-1/utm_source']).toEqual(['from_query_string']);
  });

  it('uninstall removes the listener', async () => {
    const t = enterprisePage();
    const { form, sets } = fakeForm(ENTERPRISE_FORM_ID, enterpriseFieldsAfterFix());
    const w = t.window as unknown as FillWindow;
    w.HubSpotFormsV4 = { getForms: () => [], getFormFromEvent: () => form };
    installHubSpotFill(w)();
    t.window.dispatchEvent(new t.window.CustomEvent(HS_READY_EVENT, { detail: { formId: ENTERPRISE_FORM_ID } }));
    await flush();
    expect(sets).toEqual([]);
  });
});

describe('fillForm', () => {
  it('sets best-effort when the field list cannot be read and never throws', async () => {
    const sets: string[] = [];
    const form: HubSpotFormInstance = {
      getFormId: () => ENTERPRISE_FORM_ID,
      getFormFieldValues: async () => {
        throw new Error('not ready');
      },
      setFieldValue: (name) => {
        if (name === '0-1/ttclid') throw new Error('unknown field');
        sets.push(name);
      },
    };
    const report = await fillForm(form, { '0-1/gclid': 'G', '0-1/ttclid': 'T' });
    expect(report.listedFields).toBe(false);
    expect(sets).toEqual(['0-1/gclid']);
    expect(report.missingOnForm).toEqual(['0-1/ttclid']);
  });

  it('adds static fields only when asked', () => {
    const snapshot = readAttributionSnapshot({ cookie: '' });
    expect(collectFieldValues(snapshot)).toEqual({});
    expect(collectFieldValues(snapshot, { '0-1/lead_source_detail': 'enterprise_contact_form' })).toEqual({
      '0-1/lead_source_detail': 'enterprise_contact_form',
    });
  });
});
