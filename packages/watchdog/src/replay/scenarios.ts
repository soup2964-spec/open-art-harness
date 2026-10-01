// The conversion scenarios: the app's REAL dataLayer / gtag calls, reproduced from the shipped Suite
// bundles (verbatim shapes, synthetic WD_TEST data):
//   signup                 82a8baa61b72c9cd.js module 764475: reads cookie oa_signup_uid "<uid>:<email>",
//                          dataLayer.push({event:"signup",user_data:{email}}), THEN removes the cookie.
//                          The server-set one-shot cookies are set first, exactly as the app finds them.
//   new_user_signed_up     not emitted by any shipped code (research G1); replayed as the control that
//                          shows what GTM's Google Ads signup tag would send if it were.
//   purchase               08d6e61a49e7dfba.js K(): gtag('set','user_data',{email}); gtag('event','purchase',n);
//                          gtag('event','conversion_event_purchase',n); uetq.push('event','purchase',{...}).
//   first_purchase         d4f45453351837aa.js eN(): {event:"first_purchase",eventModel:{transaction_id:
//                          "sub_<invoiceId>",value,currency,items},user_data:{email}} (items carry price).
//   business_subscription  d4f45453351837aa.js eA(): same shape with event:"business_subscription".
//   purchase_first         08d6e61a49e7dfba.js Z(): set user_data; gtag('event','purchase_first',n);
//                          gtag('event','conversion_event_purchase_first',n) with the list-price payload
//                          and its unstable fallback transaction id (has_dedup_id:false).
// A different set can be supplied with --scenarios <file.json> (same shape as ReplayScenario below)
// when the app's pushes change; that file is the dataLayer contract the app team owns.
import fs from 'node:fs';
import type { SyntheticData } from '../markers.js';
import type { ReplayScenarioContext } from '../types.js';

export interface ReplayScenario {
  id: string;
  desc: string;
  code: string;
  context: ReplayScenarioContext;
  source: string;
}

// Same definition as the site's gtag-init snippet (and legacy ENSURE_GTAG).
const ENSURE_GTAG = "var __def=false; window.dataLayer=window.dataLayer||[]; if (typeof window.gtag!=='function'){ window.gtag=function gtag(){ window.dataLayer.push(arguments); }; __def=true; }";
const j = (v: unknown) => JSON.stringify(v);

export function defaultScenarios(d: SyntheticData): ReplayScenario[] {
  const email = d.email.trim().toLowerCase();
  const sub = (inv: string) => `sub_${inv}`;
  const purchase = { transaction_id: sub(d.invoices.purchase), value: 56, currency: 'USD', items: [{ item_id: 'pro_monthly', quantity: 1 }] };
  const first = { transaction_id: sub(d.invoices.firstPurchase), value: 300, currency: 'USD', items: [{ item_id: 'pro_yearly', quantity: 1, price: 300 }] };
  const biz = { transaction_id: sub(d.invoices.business), value: 227, currency: 'USD', items: [{ item_id: 'business_monthly', quantity: 1, price: 227 }] };
  const listPrice = { transaction_id: `sub_pro_monthly_${d.uid}_${Date.now()}`, value: 56, currency: 'USD', items: [{ item_id: 'pro_monthly', quantity: 1 }] };
  return [
    {
      id: 'signup',
      desc: "server one-shot cookies; dataLayer.push({event:'signup',user_data:{email}}); cookie removed after the push",
      source: 'Suite 82a8baa61b72c9cd.js (module 764475)',
      context: { uid: d.uid, email },
      code: `(function(){ var uid=${j(d.uid)}, email=${j(email)};
        document.cookie='oa_signup_uid='+encodeURIComponent(uid+':'+email)+'; path=/';
        document.cookie='oa_pixel_signup_uid='+encodeURIComponent(uid)+'; path=/';
        document.cookie='oa_oaiq_signup_uid='+encodeURIComponent(uid)+'; path=/';
        window.dataLayer=window.dataLayer||[]; window.dataLayer.push({event:'signup',user_data:{email:email}});
        document.cookie='oa_signup_uid=; path=/; max-age=0';
        return {pushed:true}; })()`,
    },
    {
      id: 'new_user_signed_up',
      desc: "CONTROL (never emitted by the app): dataLayer.push({event:'new_user_signed_up'})",
      source: 'GTM rule new_user_signed_up → tag 17 (research/02 §2.1)',
      context: {},
      code: `(function(){ window.dataLayer=window.dataLayer||[]; window.dataLayer.push({event:'new_user_signed_up'}); return {pushed:true}; })()`,
    },
    {
      id: 'purchase',
      desc: "gtag('set','user_data',{email}); gtag('event','purchase',n); gtag('event','conversion_event_purchase',n); uetq.push('event','purchase',…)",
      source: 'Suite 08d6e61a49e7dfba.js K() (module 114607)',
      context: { email, transaction_id: purchase.transaction_id, invoice_id: d.invoices.purchase },
      code: `(function(){ ${ENSURE_GTAG} var n=${j(purchase)};
        gtag('set','user_data',{email:${j(email)}}); gtag('event','purchase',n); gtag('event','conversion_event_purchase',n);
        window.uetq=window.uetq||[]; window.uetq.push('event','purchase',{transaction_id:n.transaction_id,revenue_value:n.value,currency:n.currency});
        return {gtagDefinedByHarness:__def}; })()`,
    },
    {
      id: 'first_purchase',
      desc: "dataLayer.push({event:'first_purchase',eventModel:{transaction_id:'sub_<invoiceId>',value,currency,items},user_data:{email}})",
      source: 'Suite d4f45453351837aa.js eN()/ew()',
      context: { email, transaction_id: first.transaction_id, invoice_id: d.invoices.firstPurchase },
      code: `(function(){ window.dataLayer=window.dataLayer||[]; window.dataLayer.push({event:'first_purchase',eventModel:${j(first)},user_data:{email:${j(email)}}}); return {pushed:true}; })()`,
    },
    {
      id: 'business_subscription',
      desc: "dataLayer.push({event:'business_subscription',eventModel:{…},user_data:{email}})",
      source: 'Suite d4f45453351837aa.js eA()',
      context: { email, transaction_id: biz.transaction_id, invoice_id: d.invoices.business },
      code: `(function(){ window.dataLayer=window.dataLayer||[]; window.dataLayer.push({event:'business_subscription',eventModel:${j(biz)},user_data:{email:${j(email)}}}); return {pushed:true}; })()`,
    },
    {
      id: 'purchase_first',
      desc: "gtag('set','user_data',{email}); gtag('event','purchase_first',n); gtag('event','conversion_event_purchase_first',n) (list price, unstable id)",
      source: 'Suite 08d6e61a49e7dfba.js Z() via d4f45453351837aa.js ez()',
      context: { email, transaction_id: listPrice.transaction_id },
      code: `(function(){ ${ENSURE_GTAG} var n=${j(listPrice)};
        gtag('set','user_data',{email:${j(email)}}); gtag('event','purchase_first',n); gtag('event','conversion_event_purchase_first',n);
        return {gtagDefinedByHarness:__def}; })()`,
    },
  ];
}

export function loadScenarios(file: string): ReplayScenario[] {
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list: ReplayScenario[] = Array.isArray(s) ? s : s.scenarios;
  if (!Array.isArray(list) || !list.every((x) => x.id && x.code && x.context)) throw new Error(`${file}: expected [{id, desc, code, context, source}]`);
  return list;
}
