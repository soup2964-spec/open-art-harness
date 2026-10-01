import { describe, expect, it } from 'vitest';
import { readFixture } from '../../test-utils/fixtures';
import { parseContainerData } from '../src/container-js';
import { patchGtagConfig } from '../src/patch-gtag-config';

/** Google tag AW-11252321380 config v4 exactly as the sealed replay executed it (/4vu8/C_mYUAFo…). */
const CONFIG = readFixture(import.meta.url, './fixtures/gtag_AW-11252321380_v4_executed.js');
const { js: PATCHED, before, after } = patchGtagConfig(CONFIG);

type Tag = Record<string, unknown> & { function: string };

describe('patchGtagConfig', () => {
  it('turns off automatic form-interaction events and nothing else', () => {
    expect(before).toBe(true);
    expect(after).toBe(false);
    expect(PATCHED.length).toBe(CONFIG.length + 1); // "true" -> "false"
    const a = parseContainerData(CONFIG);
    const b = parseContainerData(PATCHED);
    const tagsA = (a.resource.tags as Tag[]).map((t) => ({ ...t }));
    const tagsB = b.resource.tags as Tag[];
    const auto = tagsB.find((t) => t.function === '__ogt_auto_events')!;
    expect(auto.vtp_enableForm).toBe(false);
    expect(auto.vtp_enableHistoryEvents).toBe(true); // other automatic events untouched
    tagsA.find((t) => t.function === '__ogt_auto_events')!.vtp_enableForm = false;
    expect(tagsB).toEqual(tagsA);
    expect(b.runtime).toEqual(a.runtime);
    expect(b.permissions).toEqual(a.permissions);
  });

  it('is idempotent', () => {
    const again = patchGtagConfig(PATCHED);
    expect(again.before).toBe(false);
    expect(again.js).toBe(PATCHED);
  });

  it('gtm/proof/patched_gtag_config.js is up to date', () => {
    expect(readFixture(import.meta.url, '../proof/patched_gtag_config.js')).toBe(PATCHED);
  });

  it('the flag is what gates form_start/form_submit (runtime wiring in the same file)', () => {
    const runtime = parseContainerData(CONFIG).runtime as unknown[];
    const find = (name: string) => JSON.stringify(runtime.find((r) => Array.isArray(r) && r[1] === name));
    // __ogt_auto_events: for a false flag it sets the autoEventBlockSchema "B" (form) product setting per destination.
    const auto = find('__ogt_auto_events');
    expect(auto).toContain('internal.setProductSettingsParameter');
    expect(auto).toContain('["f",[17,[15,"a"],"enableForm"],[17,[15,"d"],"B"]]');
    // __ccd_em_form (one per Ads destination) returns before registering listeners when "B" is set.
    const form = find('__ccd_em_form');
    expect(form).toContain('[52,"o",[17,[15,"h"],"B"]]');
    expect(form).toContain('[22,["d",[15,"u"],[15,"o"]],[46,[53,[2,[15,"a"],"gtmOnSuccess",[7]],[36]]]]');
    expect(form).toContain('"form_start"');
    expect(form).toContain('"form_submit"');
  });

  it('refuses scripts without the auto-events tag', () => {
    expect(() => patchGtagConfig('var data = {"resource":{"tags":[]}};')).toThrow(/__ogt_auto_events/);
  });
});
