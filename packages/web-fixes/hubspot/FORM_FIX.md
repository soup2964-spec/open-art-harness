# /enterprise contact form: attribution fix

- Portal **244977254**, form **`9f0b1fda-34f1-4364-93d5-bdc196c44004`** (new forms editor, v4 embed, region `na2`).
- The page `https://openart.ai/enterprise` is an Astro page. The embed script is inside the page's `<main>`.

**Labels**

- **[O]** observed in the captured form definition (`raw/enterprise/hs_form_render_definition.json`) or page.
- **[I]** inference.
- **[U]** unknown from outside.

## What is wrong today [O]

| Field | Today | Problem |
|---|---|---|
| `lead_source` (hidden) | hard-coded `Event` | Every website lead is labelled as an event lead |
| `lead_source_detail` (hidden) | hard-coded `Brandweek` | Every website lead is credited to Brandweek |
| `gclid`, `gbraid`, `wbraid` (hidden) | no value | [I] Filled only when the visitor lands on `/enterprise` with the id in the URL. Most visitors arrive from another page. |
| `utm_*`, `li_fat_id`, `fbclid`, `ttclid` | not on the form | Leads cannot be attributed by channel or campaign. LinkedIn, Meta and TikTok lead conversions have no click id to match on. |
| `latest_form_submit_url` (hidden) | `https://openart.ai/enterprise/#contact` | fine, keep it |

`packages/contracts` maps an enterprise form submission to the canonical `enterprise_lead` event. That event goes to Google (offline/EC for leads), LinkedIn (a LEAD rule, matched on `li_fat_id` or SHA-256 email) and Meta (`Lead`). Only the click ids on the contact make those matches possible.

## Step A: contact properties

**Check first [U].** `utm_*` may already exist in the portal:

```
GET https://api.hubapi.com/crm/properties/2026-09/contacts/utm_source
```

Create only what is missing.

**UI.** Settings → Data Management → Properties → *Contact properties* → **Create property**:

- Group: *OpenArt attribution* (create it under *Groups*).
- Field type: **Single-line text**.
- Tick *Show in forms*.

**API** (scope `crm.schemas.contacts.write`), using [`properties.json`](properties.json):

1. Create the group: `POST https://api.hubapi.com/crm/properties/2026-09/contacts/groups` with the `group` object.
2. Create the properties: `POST https://api.hubapi.com/crm/properties/2026-09/contacts/batch/create` with `{"inputs": [...properties, ...the optionalProperties you want]}`.
   - These are HubSpot's 2026-09 CRM properties API paths and schemas, fetched 2026-09-30.
   - `formField: true` makes a property usable in forms. Do not set `hidden`.

| Internal name | Label | Needed for |
|---|---|---|
| `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content` | UTM source, medium, campaign, term, content | channel and campaign reporting of enterprise leads |
| `li_fat_id` | LinkedIn click id (li_fat_id) | LinkedIn Conversions API `LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID` |
| `fbclid` | Meta click id (fbclid) | Meta CAPI `fbc` for `Lead` |
| `ttclid` | TikTok click id (ttclid) | TikTok Events API `user.ttclid` |
| `fbc` *(optional)* | Meta click cookie (fbc) | `fbc` with its original timestamp (better than rebuilding it from `fbclid`) |
| `msclkid` *(optional)* | Microsoft click id (msclkid) | UET offline conversions or CAPI for leads |

## Step B: the form (Marketing → Forms → the enterprise form → Edit)

1. **Hidden field "Lead source"**: delete the default value `Event`.
   - If the form should still set a website value, pick the property's website option.
   - [U] The option list of `lead_source` is not visible from outside. If it is a free-text property, leave it empty.
2. **Hidden field "Lead source detail"**: delete the default value `Brandweek`.
   - For event forms, keep `Event`/`Brandweek` on a separate event-only form, or pass them in the URL of the event landing page.
3. **Add hidden fields**, all with no default value:
   - `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`;
   - `li_fat_id`, `fbclid`, `ttclid`;
   - optionally `fbc` and `msclkid`.
4. Keep `gclid`, `gbraid`, `wbraid` and `latest_form_submit_url`.
5. **Update** (publish) the form. The embed picks up the new definition; no page change is needed for the fields themselves.

## Step C: fill the hidden fields on the page

The form renders in a cross-origin iframe, so the page cannot write to its inputs directly. HubSpot's v4 embed API is the supported path:

- the window event `hs-form-event:on-ready`;
- `HubSpotFormsV4.getFormFromEvent(event)`;
- `form.getFormFieldValues()` / `form.setFieldValue('0-1/<property>', ['value'])`.

HubSpot's guidance is to register `on-ready` listeners before the embed script executes. Source: HubSpot developer docs, *global form events*, fetched 2026-09-29.

In the Astro enterprise page, paste `dist/openart-hubspot-fill.min.js` into an inline script **above** the embed script:

```html
<script is:inline>/* contents of hubspot/dist/openart-hubspot-fill.min.js */</script>
<script src="https://js-na2.hsforms.net/forms/embed/244977254.js" defer></script>
```

**What the fill does**

- On `on-ready` for form `9f0b1fda-…`, and for any form already ready when it loads, it lists the form's fields.
- For each field that exists on the form and is empty, it sets:

| Field | Source |
|---|---|
| `gclid`, `gbraid`, `wbraid`, `fbclid`, `ttclid`, `li_fat_id`, `msclkid` | `oa_ad_clids` (written by the click-ID shim and the Suite), then vendor first-party cookies (`_gcl_aw`, `_gcl_gb`, `_fbc`, `ttclid`, `li_fat_id`, `_uetmsclkid`) |
| `utm_*` | `oa_utm` (click-ID shim v2), then Amplitude's campaign cookie `AMP_MKTG_3e2fda7a5c` for visitors who landed before the shim update |
| `fbc` | the `_fbc` cookie |

Other behaviour:

- Values already present, such as query-string pre-fills, are kept unless `overwrite: true`.
- Fields that are not on the form are skipped, so the script is safe to deploy before step B.
- It never throws, never sends anything itself, and adds no cookies.
- `lead_source_detail` can be set as a constant through `installHubSpotFill(window, { staticFields: {'0-1/lead_source_detail': 'enterprise_contact_form'} })`. This is off by default.

## Verify

1. Visit `https://openart.ai/?utm_source=test&utm_campaign=oafix&fbclid=TEST_F` in a fresh profile, then open `/enterprise`.
2. Submit the form with a test address.
3. The contact record should show:
   - `utm_source=test`, `utm_campaign=oafix`, `fbclid=TEST_F`, and `fbc=fb.1.<ms>.TEST_F` if added;
   - no `Event`/`Brandweek`.
4. Delete the test contact.
