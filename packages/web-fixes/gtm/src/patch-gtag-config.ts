/**
 * Turns off the Google tag's automatic form-interaction events in the compiled Google tag config
 * (AW-11252321380 config v4, served first-party at /4vu8/C_mYUAFo… and at gtag/js?id=AW-11252321380).
 *
 * Where the setting lives: tag `__ogt_auto_events` (tag_id 19) carries one flag per automatic
 * event (enableForm, enableHistoryEvents, enableScroll, …). Its sandboxed code writes an
 * autoEventBlockSchema product setting for every destination whose flag is false, and
 * `__ccd_em_form` (one per Ads destination) returns early when that setting is set, instead of
 * listening for gtm.formInteract / gtm.formSubmit and sending form_start / form_submit.
 * In the UI this is the Google tag's "Manage automatic event detection" -> "Form interactions".
 *
 * The patch flips exactly that one flag and leaves every other byte of the script untouched.
 */
import { findDataObject, scanJsonValue } from './container-js';

export interface GtagConfigPatchResult {
  js: string;
  before: boolean;
  after: boolean;
}

export function patchGtagConfig(js: string): GtagConfigPatchResult {
  const data = findDataObject(js);
  const needle = '{"function":"__ogt_auto_events"';
  const first = js.indexOf(needle, data.start);
  if (first < 0 || first > data.end) throw new Error('__ogt_auto_events tag not found in the Google tag config');
  if (js.indexOf(needle, first + 1) > -1 && js.indexOf(needle, first + 1) < data.end) throw new Error('more than one __ogt_auto_events tag');
  const tagEnd = scanJsonValue(js, first);
  const tagText = js.slice(first, tagEnd);
  const tag = JSON.parse(tagText) as Record<string, unknown>;
  if (typeof tag.vtp_enableForm !== 'boolean') throw new Error('__ogt_auto_events has no vtp_enableForm flag');
  const before = tag.vtp_enableForm;
  if (!before) return { js, before, after: false };
  const occurrences = tagText.split('"vtp_enableForm":true').length - 1;
  if (occurrences !== 1) throw new Error(`expected one "vtp_enableForm":true, found ${occurrences}`);
  const patchedTag = tagText.replace('"vtp_enableForm":true', '"vtp_enableForm":false');
  const out = js.slice(0, first) + patchedTag + js.slice(tagEnd);
  const check = JSON.parse(out.slice(first, first + patchedTag.length)) as Record<string, unknown>;
  if (check.vtp_enableForm !== false) throw new Error('patch verification failed');
  return { js: out, before, after: false };
}
