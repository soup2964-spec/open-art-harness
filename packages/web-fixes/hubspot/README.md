# hubspot/: /enterprise form attribution

- Stops mislabelling every enterprise lead as `lead_source=Event` / `lead_source_detail=Brandweek`.
- Captures UTMs and ad click ids on the contact, so enterprise leads can be attributed and sent back to LinkedIn, Meta, TikTok and Google as lead conversions.

**Steps for OpenArt:** [`FORM_FIX.md`](FORM_FIX.md):

- A. contact properties;
- B. form editor changes;
- C. the fill script on the page.

| Path | What it is |
|---|---|
| `FORM_FIX.md` | Current state (captured form definition) and click-by-click steps |
| `properties.json` | POST bodies for the new contact properties (group `openart_attribution`), plus the 2026-09 group and batch-create endpoints and the scope |
| `src/hubspot-fill.ts` | `installHubSpotFill(window, opts)`: HubSpot v4 embed API (`hs-form-event:on-ready`, `HubSpotFormsV4`, `getFormFieldValues`, `setFieldValue`). Reads `../app-patches/src/attribution-snapshot.ts`. Under an explicit `ad_storage` denial, Global Privacy Control or a US sale/sharing opt-out (`../consent/src/privacy-signals.ts`), it fills the UTM fields only and reports the withheld click-id fields in `withheld`. |
| `src/entry.ts` | Browser entry. Place the build **above** the HubSpot embed script. |
| `dist/openart-hubspot-fill.min.js` | Paste-in build (7.3 KB) |
| `test/hubspot-fill.test.ts` | happy-dom tests with a fake `HubSpotFormsV4`, checked against the captured form definition. The field map targets the live `gclid`/`gbraid`/`wbraid` and never writes `lead_source*`. It fills on `on-ready` from first-party stores (hidden values as `string[]`). Today's form gets only `gclid`/`gbraid`. Other forms are ignored, each instance is filled once, and query-string pre-fills are kept. Also covers uninstall, a best-effort path when the field list cannot be read, and static fields only on request. |
| `test/properties.test.ts` | `properties.json` covers exactly the fields the fill writes that the live form lacks, and the bodies are valid |
