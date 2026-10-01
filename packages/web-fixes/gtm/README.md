# gtm/: the GTM-56CMP8K change pack

**What it fixes (live container v25).**

- The dead Google Ads signup conversion.
- Missing or unstable dedup ids on TikTok, Reddit, LinkedIn and X.
- X's automatic duplicate purchase.
- The unconsumed `business_subscription` event.
- Page views per SPA route change: 0 on some platforms, up to 3 on others.
- Google tag form auto-events.
- The absence of Consent Mode.

**Integration steps for OpenArt:** [`CHANGES.md`](CHANGES.md), click by click.

## Files

| Path | What it is |
|---|---|
| `CHANGES.md` | GTM UI, Google tag and Google Ads steps: import, pause, edits, trigger swaps, QA, rollback |
| `import/openart-gtm-fixpack.json` | GTM container export (`exportFormatVersion: 2`) holding only the new items: 14 tags, 5 triggers, 13 variables, 1 custom template, 1 folder. Import with **Merge → Rename conflicting**. |
| `proof/patched_resource.json` | The compiled v25 `resource` with the change pack applied, for `watchdog --patch-container` |
| `proof/variants/patched_resource.linkedin-server-only.json` | The same, with the LinkedIn purchase conversion (tag 58) paused: LinkedIn purchases go server-only through conversion-service, with value (CHANGES.md B3 option b) |
| `proof/variants/patched_resource.linkedin-lintrk-value.json` | The same, with LinkedIn purchase sent through `lintrk` with value (CHANGES.md B3 option c) |
| `proof/patched_gtag_config.js` | Google tag config `AW-11252321380` v4 with only `enableForm` turned off, for `watchdog --patch-gtag-config` |
| `proof/inject_web_fixes.min.js` | One document-start script for `watchdog --inject-script`: consent defaults, click-ID shim, and stand-ins for the app patches (`../app-patches/src/proof-simulations.ts`) |
| `proof/patch-report.json` | Every macro, predicate and tag added, paused or edited in the proof |
| `src/fixpack.ts` | The change pack as data. One definition drives the import file and the proof. |
| `src/build-import.ts` | Renders the import file |
| `src/export-schema.ts` | zod schema and reference checks for GTM exports: ids, triggers, variables, ES5 code, template sections |
| `src/patch-container.ts` | Applies the pack to a compiled resource. It refuses to run if a guarded original has changed. |
| `src/patch-gtag-config.ts` | Flips `vtp_enableForm` in `__ogt_auto_events`. Idempotent. |
| `src/container-js.ts` | Finds and splices the `resource` block inside a `gtm.js` body |
| `src/es5.ts` | TypeScript-AST ES5 checker for Custom HTML and Custom JavaScript |

## Rebuild and verify

From `packages/web-fixes`:

```bash
npx tsx scripts/build.ts          # rewrites import/, proof/ and the dist bundles
npx tsx scripts/build.ts --check  # exit 1 if any committed output is stale
npx vitest run gtm                # schema, proof freshness, rule evaluation, vendor-code tests
```

**What the tests establish**

- The originals the pack replaces are byte-identical to v25: tags 74, 38 and 77.
- Each fix changes one statement.
- All Custom HTML and Custom JavaScript is ES5.
- The custom JavaScript variables return the right ids for real and fallback transaction ids.
- The X fix is checked by executing the real `uwt.js` 2.4.11 modules (shipped: one `gtm_purchase`; fixed: none).
- The TikTok fix is checked against the shipped SDK gate.
- Rule evaluation of the patched resource shows exactly which tags fire for `gtm.js`, `signup`, `new_user_signed_up`, `purchase` (invoice id and fallback id), `first_purchase`, `business_subscription` and `virtual_page_view`, before and after.

## Using the proof with the watchdog

```bash
cd packages/watchdog
npx tsx src/cli.ts run --target patched \
  --patch-container   ../web-fixes/gtm/proof/patched_resource.json \
  --patch-gtag-config ../web-fixes/gtm/proof/patched_gtag_config.js \
  --inject-script     ../web-fixes/gtm/proof/inject_web_fixes.min.js \
  --out reports/patched-$(date -u +%F)
```

To test LinkedIn value, use `proof/variants/patched_resource.linkedin-lintrk-value.json` as `--patch-container`. The watchdog README's example paths (`../web-fixes/dist/…`) are placeholders for these files.

**Not in the proof.** Two parts of the pack need runtime code that v25 does not ship:

- **The consent template.** The inject script pushes the same defaults.
- **The History Change listener behind the route settler.** The inject script's page-view stand-in pushes `virtual_page_view`.

The proof also leaves out additional-consent-check metadata. See CHANGES.md §E.
