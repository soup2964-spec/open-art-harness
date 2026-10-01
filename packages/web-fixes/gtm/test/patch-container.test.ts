import { describe, expect, it } from 'vitest';
import { readFixture } from '../../test-utils/fixtures';
import { parseContainerData, spliceResourceIntoContainerJs, findTopLevelValue } from '../src/container-js';
import { NEW_TAG_ID_BASE, patchContainerResource, type GtmResource } from '../src/patch-container';
import { evalMacro, firedTagIds, renderTemplate } from './helpers';

const CONTAINER = JSON.parse(readFixture(import.meta.url, './fixtures/gtm_56CMP8K.js.json')) as {
  resource: GtmResource;
  runtime: Array<[number, string]>;
  permissions: Record<string, unknown>;
};
const EXECUTED_JS = readFixture(import.meta.url, './fixtures/gtm_56CMP8K_v25_executed.js');
const { resource: PATCHED, report } = patchContainerResource(CONTAINER.resource);

/** Function types whose code ships in the v25 container: sandboxed runtime + main-script built-ins. */
const AVAILABLE_FUNCTIONS = new Set([...CONTAINER.runtime.filter((r) => r[0] === 50).map((r) => r[1]), '__awct', '__gclidw']);

const EMAIL = 'seal.test@example.com';
const UID = 'dOp6BlUh0AgkVu3ILV59';

describe('proof files', () => {
  it('gtm/proof/patched_resource.json and patch-report.json are up to date', () => {
    expect(readFixture(import.meta.url, '../proof/patched_resource.json')).toBe(`${JSON.stringify(PATCHED, null, 2)}\n`);
    expect(readFixture(import.meta.url, '../proof/patch-report.json')).toBe(`${JSON.stringify(report, null, 2)}\n`);
  });

  it('the LinkedIn value variant is up to date', () => {
    const variant = patchContainerResource(CONTAINER.resource, { variant: 'linkedin-lintrk-value' }).resource;
    expect(readFixture(import.meta.url, '../proof/variants/patched_resource.linkedin-lintrk-value.json')).toBe(`${JSON.stringify(variant, null, 2)}\n`);
  });

  it('the LinkedIn server-only variant (CHANGES.md B3 option b) is up to date', () => {
    const variant = patchContainerResource(CONTAINER.resource, { variant: 'linkedin-server-only' }).resource;
    expect(readFixture(import.meta.url, '../proof/variants/patched_resource.linkedin-server-only.json')).toBe(`${JSON.stringify(variant, null, 2)}\n`);
  });

  it('does not modify its input', () => {
    const again = JSON.parse(readFixture(import.meta.url, './fixtures/gtm_56CMP8K.js.json')) as { resource: GtmResource };
    expect(CONTAINER.resource).toEqual(again.resource);
  });
});

describe('structural integrity on the v25 runtime', () => {
  const macroRefs = (value: unknown, out: number[] = []): number[] => {
    if (Array.isArray(value)) {
      if (value[0] === 'macro' && typeof value[1] === 'number') out.push(value[1]);
      for (const v of value) macroRefs(v, out);
    } else if (value && typeof value === 'object') for (const v of Object.values(value)) macroRefs(v, out);
    return out;
  };

  it('uses only function types the container runtime already contains', () => {
    for (const t of PATCHED.tags) expect(AVAILABLE_FUNCTIONS.has(t.function), t.function).toBe(true);
    for (const m of PATCHED.macros) expect(AVAILABLE_FUNCTIONS.has(m.function), m.function).toBe(true);
    for (const p of PATCHED.predicates) expect(['_eq', '_re']).toContain(p.function);
  });

  it('every macro, predicate and tag reference resolves', () => {
    for (const i of macroRefs([PATCHED.tags, PATCHED.macros, PATCHED.predicates])) expect(i).toBeLessThan(PATCHED.macros.length);
    for (const rule of PATCHED.rules) {
      for (const clause of rule) {
        const [op, ...ids] = clause;
        const limit = op === 'if' || op === 'unless' ? PATCHED.predicates.length : PATCHED.tags.length;
        for (const id of ids) expect(id).toBeLessThan(limit);
      }
    }
  });

  it('keeps the original arrays as a prefix (indices of existing entities never move)', () => {
    expect(PATCHED.tags.slice(0, CONTAINER.resource.tags.length).map((t) => t.tag_id)).toEqual(CONTAINER.resource.tags.map((t) => t.tag_id));
    expect(PATCHED.macros.slice(0, CONTAINER.resource.macros.length)).toEqual(CONTAINER.resource.macros);
    expect(PATCHED.predicates.slice(0, CONTAINER.resource.predicates.length)).toEqual(CONTAINER.resource.predicates);
    expect(new Set(PATCHED.tags.map((t) => t.tag_id)).size).toBe(PATCHED.tags.length);
  });

  it('reports what it did', () => {
    expect(report.paused.map((p) => p.tag_id).sort((a, b) => a - b)).toEqual([17, 38, 74, 76, 77, 79]);
    expect(report.edited.map((e) => e.tag_id).sort((a, b) => a - b)).toEqual([15, 19, 34, 35, 52, 57, 58, 72, 75]);
    expect(report.skippedNotInProof).toEqual([
      'OA-FIX Consent Mode v2 - defaults (EEA/UK/CH denied)',
      'OA-FIX LinkedIn - purchase 29290225 via lintrk (value variant, paused)',
      'OA-FIX Route settler (History Change -> virtual_page_view)',
      'OA-FIX LinkedIn - server-only purchases via conversion-service (option b, paused)',
    ]);
  });

  it('the default proof keeps every compiled tag_id (the option-b tag is appended, never inserted)', () => {
    expect(report.addedTags.map((t) => t.tag_id)).toEqual([1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010, 1011]);
  });
});

describe('LinkedIn option b: purchases server-only via conversion-service (review: LinkedIn keeps the browser event)', () => {
  const { resource: B, report: reportB } = patchContainerResource(CONTAINER.resource, { variant: 'linkedin-server-only' });
  const PURCHASE = { event: 'purchase', data: { eventModel: { transaction_id: 'sub_in_1QxYz', value: 56, currency: 'USD' }, user_data: { email: EMAIL } } };
  const liPurchaseTags = (r: GtmResource, ids: number[]) =>
    r.tags.filter((t) => ids.includes(t.tag_id) && /29290225/.test(JSON.stringify(t)) && t.tag_id !== reportB.addedTags.find((a) => a.name.includes('server-only'))?.tag_id);

  it('pauses the browser LinkedIn purchase conversion (tag 58) and sends no LinkedIn purchase from the browser', () => {
    expect(reportB.paused.map((p) => p.tag_id)).toContain(58);
    const fired = firedTagIds(B, PURCHASE);
    expect(fired).not.toContain(58);
    expect(liPurchaseTags(B, fired)).toEqual([]);
    // Every other purchase tag still fires, exactly as in the default proof.
    expect(fired.filter((id) => id < NEW_TAG_ID_BASE)).toEqual([15, 19, 35, 75]);
  });

  it('keeps the LinkedIn signup conversion and page views (tags 72 and 52)', () => {
    expect(firedTagIds(B, { event: 'signup', data: { user_id: UID, user_data: { email: EMAIL } } })).toContain(72);
    expect(firedTagIds(B, { event: 'virtual_page_view' })).toContain(52);
  });

  it('leaves the default proof unchanged: tag 58 still fires there with eventId sub_<invoiceId>', () => {
    expect(firedTagIds(PATCHED, PURCHASE)).toContain(58);
    expect(report.paused.map((p) => p.tag_id)).not.toContain(58);
  });
});

describe('which tags fire (rule evaluation of the patched resource)', () => {
  const before = (ctx: Parameters<typeof firedTagIds>[1]) => firedTagIds(CONTAINER.resource, ctx);
  const after = (ctx: Parameters<typeof firedTagIds>[1]) => firedTagIds(PATCHED, ctx);
  const newId = (namePart: string) => report.addedTags.find((t) => t.name.includes(namePart))!.tag_id;

  it('page load (gtm.js): same vendors, with the X, UET and TikTok base tags replaced', () => {
    expect(before({ event: 'gtm.js' })).toEqual([10, 34, 38, 52, 74, 77]);
    expect(after({ event: 'gtm.js' })).toEqual([10, 34, 52, newId('X - base'), newId('UET - base'), newId('TikTok - base')].sort((a, b) => a - b));
  });

  it('S1 signup: Google Ads signup conversion now fires; TikTok/X use the new tags', () => {
    const ctx = { event: 'signup', data: { user_id: UID, user_data: { email: EMAIL } } };
    expect(before(ctx)).toEqual([57, 72, 76, 79]); // no Google Ads (research/11 claim 1)
    expect(after(ctx)).toEqual([57, 72, newId('signup conversion'), newId('X - signup'), newId('TikTok')].sort((a, b) => a - b));
  });

  it('S1 with today’s push (no user_id): the reg id still resolves from oa_signup_uid', () => {
    const regMacro = report.addedMacros.find((m) => m.for === 'OA-FIX CJS - reg event_id')!.index;
    expect(evalMacro(PATCHED, regMacro, { event: 'signup', data: { user_data: { email: EMAIL } }, cookies: { oa_signup_uid: `${UID}:${EMAIL}` } })).toBe(`reg_${UID}`);
  });

  it('S2 new_user_signed_up fires nothing any more', () => {
    expect(before({ event: 'new_user_signed_up' })).toEqual([17]);
    expect(after({ event: 'new_user_signed_up' })).toEqual([]);
  });

  it('S3 purchase with an invoice-derived id: the same five tags fire', () => {
    const ctx = { event: 'purchase', data: { eventModel: { transaction_id: 'sub_SEALTEST_1', value: 56, currency: 'USD' } } };
    expect(before(ctx)).toEqual([15, 19, 35, 58, 75]);
    expect(after(ctx)).toEqual([15, 19, 35, 58, 75]);
  });

  it('X purchase (tag 75, unchanged) sends conversion_id = transaction id; LinkedIn 58 gets eventId sub_<invoiceId>', () => {
    const ctx = { event: 'purchase', data: { eventModel: { transaction_id: 'sub_in_1QxYz', value: 56, currency: 'USD' }, user_data: { email: EMAIL } } };
    const x = PATCHED.tags.find((t) => t.tag_id === 75)!;
    expect(x).toEqual(CONTAINER.resource.tags.find((t) => t.tag_id === 75));
    expect(renderTemplate(PATCHED, x.vtp_html, ctx)).toContain('conversion_id:"sub_in_1QxYz"');
    const li = PATCHED.tags.find((t) => t.tag_id === 58)!;
    expect(evalMacro(PATCHED, (li.vtp_eventId as [string, number])[1], ctx)).toBe('sub_in_1QxYz');
  });

  it('purchase with today’s unstable fallback id reaches no ad platform from the browser', () => {
    const ctx = { event: 'purchase', data: { eventModel: { transaction_id: 'sub_Essential_1000_u1_1790700000000', value: 7, currency: 'USD' } } };
    expect(before(ctx)).toEqual([15, 19, 35, 58, 75]);
    expect(after(ctx)).toEqual([]);
  });

  it('S5 business_subscription is consumed by the business conversion', () => {
    const ctx = { event: 'business_subscription', data: { eventModel: { transaction_id: 'sub_SEALTEST_3', value: 227, currency: 'USD' } } };
    expect(before(ctx)).toEqual([]);
    expect(after(ctx)).toEqual([newId('business_subscription')]);
  });

  it('first_purchase is unchanged (TikTok Purchase, event_id sub_<invoiceId>)', () => {
    const ctx = { event: 'first_purchase', data: { eventModel: { transaction_id: 'sub_SEALTEST_2' } } };
    expect(after(ctx)).toEqual(before(ctx));
  });

  it('virtual_page_view: one page-view tag per platform (Google Ads, Reddit, LinkedIn, X, UET, TikTok)', () => {
    expect(before({ event: 'virtual_page_view' })).toEqual([]);
    expect(after({ event: 'virtual_page_view' })).toEqual(
      [34, 52, newId('Google Ads - page_view'), newId('X - base'), newId('UET - page_view'), newId('TikTok - page')].sort((a, b) => a - b),
    );
    const reddit = PATCHED.tags.find((t) => t.tag_id === 34)!;
    expect(reddit.once_per_event).toBe(true);
    expect(reddit.once_per_load).toBeUndefined();
  });

  it('template edits: LinkedIn event ids and Reddit SignUp conversionId point at the new variables', () => {
    const macroOf = (tagId: number, field: string) => (PATCHED.tags.find((t) => t.tag_id === tagId)![field] as [string, number])[1];
    const byName = (n: string) => report.addedMacros.find((m) => m.for === n)!.index;
    expect(macroOf(58, 'vtp_eventId')).toBe(byName('OA-FIX CJS - purchase order_id'));
    expect(macroOf(72, 'vtp_eventId')).toBe(byName('OA-FIX CJS - reg event_id'));
    expect(macroOf(57, 'vtp_conversionId')).toBe(byName('OA-FIX CJS - reg event_id'));
  });

  it('the new signup conversion carries order id reg_<uid> and manual user-provided data', () => {
    const tag = PATCHED.tags.find((t) => t.tag_id === newId('signup conversion'))!;
    expect(tag).toMatchObject({ function: '__awct', vtp_conversionId: '11252321380', vtp_conversionLabel: 'rVk2CJ7Ot8EZEOSYw_Up', vtp_enableEnhancedConversion: true });
    const upd = PATCHED.macros[(tag.vtp_cssProvidedEnhancedConversionValue as [string, number])[1]]!;
    expect(upd).toEqual({ function: '__awec', vtp_mode: 'MANUAL', vtp_email: ['macro', 5] });
  });
});

describe('guards', () => {
  it('refuses a container whose tags changed', () => {
    const changed = JSON.parse(JSON.stringify(CONTAINER.resource)) as GtmResource;
    changed.tags.find((t) => t.tag_id === 17)!.vtp_conversionLabel = 'somethingElse';
    expect(() => patchContainerResource(changed)).toThrow(/tag_id 17/);
    const missing = JSON.parse(JSON.stringify(CONTAINER.resource)) as GtmResource;
    missing.tags = missing.tags.filter((t) => t.tag_id !== 74);
    expect(() => patchContainerResource(missing)).toThrow(/tag_id 74/);
  });

  it('refuses to patch twice and rejects non-resources', () => {
    expect(() => patchContainerResource(PATCHED)).toThrow(/already contains fix-pack tags/);
    expect(() => patchContainerResource({ tags: [] })).toThrow(/not a compiled GTM resource/);
    expect(PATCHED.tags.some((t) => t.tag_id > NEW_TAG_ID_BASE)).toBe(true);
  });

  it('variant: LinkedIn purchase goes through lintrk and the template tag is paused', () => {
    const { resource, report: r } = patchContainerResource(CONTAINER.resource, { variant: 'linkedin-lintrk-value' });
    expect(r.paused.map((p) => p.tag_id)).toContain(58);
    expect(r.edited.map((e) => e.tag_id)).not.toContain(58);
    const lintrk = r.addedTags.find((t) => t.name.includes('LinkedIn'))!;
    const ctx = { event: 'purchase', data: { eventModel: { transaction_id: 'sub_SEALTEST_1', value: 56, currency: 'USD' } } };
    expect(firedTagIds(resource, ctx)).toContain(lintrk.tag_id);
    expect(firedTagIds(resource, ctx)).not.toContain(58);
  });
});

describe('splicing into the container script (watchdog --patch-container)', () => {
  it('replaces only the resource block of the executed v25 script', () => {
    const spliced = spliceResourceIntoContainerJs(EXECUTED_JS, PATCHED);
    const original = parseContainerData(EXECUTED_JS);
    const data = parseContainerData(spliced);
    expect(data.resource).toEqual(PATCHED);
    expect(data.runtime).toEqual(original.runtime);
    expect(data.permissions).toEqual(original.permissions);
    const span = findTopLevelValue(EXECUTED_JS, 'resource');
    expect(spliced.slice(0, span.start)).toBe(EXECUTED_JS.slice(0, span.start));
    expect(spliced.slice(spliced.length - (EXECUTED_JS.length - span.end))).toBe(EXECUTED_JS.slice(span.end));
  });
});
