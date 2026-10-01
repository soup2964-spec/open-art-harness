import { describe, expect, it } from 'vitest';
import { readFixture } from '../../test-utils/fixtures';
import { CONSENT_REGIONS, parseTemplateSections, renderConsentTemplate } from '../../consent/src/consent-defaults';
import { buildImport, FOLDER_ID, renderImportJson, TEMPLATE_ID } from '../src/build-import';
import { GtmExportSchema, validateGtmExport } from '../src/export-schema';
import { BUILTIN_TRIGGERS, FIX_ID_BASE, IDS, PREFIX, TAGS, TRIGGERS, V, VARIABLES } from '../src/fixpack';

type Json = Record<string, any>;

const committed = readFixture(import.meta.url, '../import/openart-gtm-fixpack.json');
const V25 = JSON.parse(readFixture(import.meta.url, './fixtures/gtm_56CMP8K.js.json')) as { resource: { tags: Array<{ tag_id: number }> } };

function fresh(): Json {
  return JSON.parse(JSON.stringify(buildImport())) as Json;
}

function tagByName(exp: Json, part: string): Json {
  const t = exp.containerVersion.tag.find((x: Json) => String(x.name).includes(part));
  if (!t) throw new Error(`no tag ${part}`);
  return t;
}

const param = (item: Json, key: string): string | undefined => item.parameter.find((p: Json) => p.key === key)?.value;

describe('gtm/import/openart-gtm-fixpack.json', () => {
  it('is up to date with the fix pack definition', () => {
    expect(committed).toBe(renderImportJson());
  });

  it('is a valid GTM export (exportFormatVersion 2): schema, references, code', () => {
    expect(validateGtmExport(JSON.parse(committed), { requirePrefix: PREFIX })).toEqual([]);
  });

  it('contains only new OA-FIX items, all inside one folder', () => {
    const cv = fresh().containerVersion;
    expect(cv.tag).toHaveLength(TAGS.length);
    expect(cv.trigger).toHaveLength(TRIGGERS.length);
    expect(cv.variable).toHaveLength(VARIABLES.length);
    for (const item of [...cv.tag, ...cv.trigger, ...cv.variable]) {
      expect(item.name.startsWith(PREFIX)).toBe(true);
      expect(item.parentFolderId).toBe(FOLDER_ID);
    }
    expect(cv.folder).toEqual([expect.objectContaining({ folderId: FOLDER_ID, name: `${PREFIX} openart-signal` })]);
    expect(cv.container.publicId).toBe('GTM-56CMP8K');
  });

  it('uses ids above FIX_ID_BASE, clear of every v25 tag_id (names are what GTM matches; ids are defence in depth)', () => {
    const cv = fresh().containerVersion;
    const ids = [
      ...cv.tag.map((x: Json) => x.tagId),
      ...cv.trigger.map((x: Json) => x.triggerId),
      ...cv.variable.map((x: Json) => x.variableId),
      ...cv.folder.map((x: Json) => x.folderId),
      ...cv.customTemplate.map((x: Json) => x.templateId),
    ].map(Number);
    expect(ids.every((n) => n > FIX_ID_BASE)).toBe(true);
    const existing = new Set(V25.resource.tags.map((t) => t.tag_id));
    expect(Math.max(...existing)).toBeLessThan(FIX_ID_BASE);
    // The proof's compiled tag_id for each new tag equals its export tagId.
    TAGS.forEach((def, i) => expect(tagByName({ containerVersion: cv }, def.name).tagId).toBe(String(FIX_ID_BASE + i + 1)));
  });

  it('retriggers the Google Ads signup conversion on signup with order id and user-provided data', () => {
    const exp = fresh();
    const tag = tagByName(exp, 'signup conversion (rVk2)');
    expect(tag.type).toBe('awct');
    expect(param(tag, 'conversionId')).toBe(IDS.googleAdsPrimary);
    expect(param(tag, 'conversionLabel')).toBe(IDS.googleAdsSignupLabel);
    expect(param(tag, 'orderId')).toBe(`{{${V.regEventId}}}`);
    expect(param(tag, 'enableEnhancedConversion')).toBe('true');
    expect(param(tag, 'cssProvidedEnhancedConversionValue')).toBe(`{{${V.upd}}}`);
    const trigger = exp.containerVersion.trigger.find((t: Json) => t.triggerId === tag.firingTriggerId[0]);
    expect(trigger.customEventFilter[0].parameter[1].value).toBe('signup');
    const upd = exp.containerVersion.variable.find((v: Json) => v.name === V.upd);
    expect(upd).toMatchObject({ type: 'awec' });
    expect(param(upd, 'mode')).toBe('MANUAL');
    expect(param(upd, 'email')).toBe(`{{${V.email}}}`);
  });

  it('consumes business_subscription with a separate, placeholder-labelled Google Ads action', () => {
    const tag = tagByName(fresh(), 'business_subscription');
    expect(param(tag, 'conversionLabel')).toBe(IDS.googleAdsBusinessLabelPlaceholder);
    expect(param(tag, 'conversionValue')).toBe(`{{${V.value}}}`);
    expect(param(tag, 'orderId')).toBe(`{{${V.transactionId}}}`);
  });

  it('puts the Consent Mode template on Consent Initialization, and ad_storage checks on X/TikTok', () => {
    const exp = fresh();
    const consent = tagByName(exp, 'Consent Mode v2');
    expect(consent.type).toBe(`cvt_${IDS.containerId}_${TEMPLATE_ID}`);
    expect(consent.firingTriggerId).toEqual([BUILTIN_TRIGGERS.consentInit.id]);
    expect(exp.containerVersion.customTemplate[0].templateData).toBe(renderConsentTemplate());
    // The tag sets every template field, including the GPC / US opt-out switch (on).
    const templateFields = (JSON.parse(parseTemplateSections(renderConsentTemplate()).TEMPLATE_PARAMETERS!) as Array<{ name: string }>).map((p) => p.name);
    expect(consent.parameter.map((p: Json) => p.key)).toEqual(templateFields);
    expect(param(consent, 'respectOptOut')).toBe('true');
    expect(param(consent, 'regulatedRegions')!.split(',')).toEqual([...CONSENT_REGIONS]);
    for (const part of ['X - base', 'TikTok - base', 'TikTok - page']) {
      expect(tagByName(exp, part).consentSettings).toEqual({
        consentStatus: 'NEEDED',
        consentType: { type: 'LIST', list: [{ type: 'TEMPLATE', value: 'ad_storage' }] },
      });
    }
    expect(tagByName(exp, 'UET - base').consentSettings).toEqual({ consentStatus: 'NOT_SET' }); // bat.js reads Google consent itself
  });

  it('the X and TikTok signup tags send the email, so they also require ad_user_data (review finding)', () => {
    const exp = fresh();
    for (const part of ['X - signup', 'TikTok - CompleteRegistration']) {
      const tag = tagByName(exp, part);
      expect(param(tag, 'html')).toContain(`{{${V.email}}}`);
      expect(tag.consentSettings).toEqual({
        consentStatus: 'NEEDED',
        consentType: { type: 'LIST', list: [{ type: 'TEMPLATE', value: 'ad_storage' }, { type: 'TEMPLATE', value: 'ad_user_data' }] },
      });
    }
  });

  it('every OA-FIX tag that sends user data (email) requires ad_user_data', () => {
    for (const def of TAGS) {
      if (def.kind !== 'html') continue;
      if (def.html((n) => `{{${n}}}`).includes(`{{${V.email}}}`)) expect(def.consent, def.name).toEqual(['ad_storage', 'ad_user_data']);
    }
  });

  it('ships the LinkedIn lintrk value variant paused', () => {
    expect(tagByName(fresh(), 'LinkedIn - purchase').paused).toBe(true);
  });

  it('ships LinkedIn option b (server-only purchases via conversion-service) as a documented, paused alternative', () => {
    const tag = tagByName(fresh(), 'LinkedIn - server-only purchases');
    expect(tag.paused).toBe(true);
    expect(tag.type).toBe('html');
    expect(tag.notes).toMatch(/pause tag_id 58/i);
    expect(tag.notes).toMatch(/conversion-service/);
    expect(tag.notes).toMatch(/keeps the Insight Tag event/);
    // It sends nothing to LinkedIn itself.
    expect(param(tag, 'html')).not.toMatch(/lintrk\(|px\.ads\.linkedin\.com|new Image/);
  });

  it('fires the route settler on All Pages + History Change and the page-view tags on virtual_page_view', () => {
    const exp = fresh();
    const idOf = (name: string) => exp.containerVersion.trigger.find((t: Json) => t.name === name)?.triggerId;
    const settler = tagByName(exp, 'Route settler');
    expect(settler.firingTriggerId).toEqual([BUILTIN_TRIGGERS.allPages.id, idOf(`${PREFIX} HC - route change`)]);
    expect(exp.containerVersion.trigger.find((t: Json) => t.type === 'HISTORY_CHANGE')).toBeTruthy();
    for (const part of ['Google Ads - page_view', 'UET - page_view', 'X - base', 'TikTok - page']) {
      expect(tagByName(exp, part).firingTriggerId).toContain(idOf(`${PREFIX} CE - virtual_page_view`));
    }
  });
});

describe('validateGtmExport catches broken exports', () => {
  const issues = (mutate: (e: Json) => void): string[] => {
    const e = fresh();
    mutate(e);
    return validateGtmExport(e).map((i) => i.message);
  };

  it('unknown trigger ids and unresolved variables', () => {
    expect(issues((e) => (e.containerVersion.tag[1].firingTriggerId = ['999']))).toContain('unknown trigger id 999');
    expect(issues((e) => (e.containerVersion.variable = e.containerVersion.variable.filter((v: Json) => v.name !== V.upd)))).toEqual(
      expect.arrayContaining([`unresolved variable {{${V.upd}}}`]),
    );
  });

  it('ES2015 syntax in Custom HTML and malformed custom JavaScript', () => {
    const html = (e: Json) => e.containerVersion.tag.find((t: Json) => t.type === 'html');
    expect(issues((e) => (html(e).parameter[0].value = '<script>const x = () => 1;</script>')).join(' ')).toContain('not ES5');
    const js = (e: Json) => e.containerVersion.variable.find((v: Json) => v.type === 'jsm');
    expect(issues((e) => (js(e).parameter[0].value = 'return 1;'))).toContain('Custom JavaScript must be a single function() { … }');
  });

  it('schema violations: bad BOOLEAN, missing EQUALS on custom events, duplicate names, bad template type', () => {
    expect(issues((e) => (e.containerVersion.tag[1].parameter[0].value = 'yes')).join(' ')).toContain('BOOLEAN');
    expect(issues((e) => (e.containerVersion.trigger[0].customEventFilter[0].type = 'CONTAINS'))).toContain(
      'CUSTOM_EVENT needs customEventFilter EQUALS {{_event}} <name>',
    );
    expect(issues((e) => (e.containerVersion.tag[2].name = e.containerVersion.tag[1].name)).join(' ')).toContain('duplicate tag name');
    expect(issues((e) => (e.containerVersion.customTemplate = []))).toContain(`unknown tag type cvt_${IDS.containerId}_${TEMPLATE_ID}`);
  });

  it('rejects anything that is not exportFormatVersion 2', () => {
    const e = fresh();
    e.exportFormatVersion = 1;
    expect(GtmExportSchema.safeParse(e).success).toBe(false);
  });
});
