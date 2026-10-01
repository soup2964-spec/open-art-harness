import { describe, expect, it } from 'vitest';
import { readFixture } from '../../test-utils/fixtures';
import { FIELD_MAP } from '../src/hubspot-fill';

interface PropertyBody {
  groupName: string;
  name: string;
  label: string;
  type: string;
  fieldType: string;
  formField: boolean;
  description: string;
}

const DOC = JSON.parse(readFixture(import.meta.url, '../properties.json')) as {
  group: { name: string };
  properties: PropertyBody[];
  optionalProperties: PropertyBody[];
};
const FORM = JSON.parse(readFixture(import.meta.url, './fixtures/hs_form_render_definition.json')) as unknown;

/** Every `propertyReference` on the live form (captured render definition). */
function liveFormProperties(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) for (const n of node) liveFormProperties(n, out);
  else if (node && typeof node === 'object') {
    const ref = (node as { propertyReference?: unknown }).propertyReference;
    if (typeof ref === 'string') out.add(ref.replace(/^0-1\//, ''));
    for (const v of Object.values(node)) liveFormProperties(v, out);
  }
  return out;
}

describe('hubspot/properties.json', () => {
  const all = [...DOC.properties, ...DOC.optionalProperties];
  const live = liveFormProperties(FORM);

  it('defines every field the fill script writes that the live form does not have yet', () => {
    const filled = FIELD_MAP.map((f) => f.field.replace(/^0-1\//, ''));
    const missing = filled.filter((name) => !live.has(name));
    expect(all.map((p) => p.name).sort()).toEqual(missing.sort());
    expect(live.has('gclid') && live.has('gbraid') && live.has('wbraid')).toBe(true);
  });

  it('bodies are valid single-line text properties in one group', () => {
    for (const p of all) {
      expect(p).toMatchObject({ groupName: DOC.group.name, type: 'string', fieldType: 'text', formField: true });
      expect(p.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(p.label.length).toBeGreaterThan(0);
      expect(Object.keys(p).sort()).toEqual(['description', 'fieldType', 'formField', 'groupName', 'label', 'name', 'type']);
    }
  });

  it('the brief’s required set is in properties, the extras are optional', () => {
    expect(DOC.properties.map((p) => p.name)).toEqual(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'li_fat_id', 'fbclid', 'ttclid']);
    expect(DOC.optionalProperties.map((p) => p.name)).toEqual(['fbc', 'msclkid']);
  });

  it('the live form hard-codes the lead source defaults FORM_FIX.md removes', () => {
    const text = JSON.stringify(FORM);
    expect(text).toContain('"propertyReference":"0-1/lead_source","values":["Event"]');
    expect(text).toContain('"propertyReference":"0-1/lead_source_detail","values":["Brandweek"]');
  });
});
