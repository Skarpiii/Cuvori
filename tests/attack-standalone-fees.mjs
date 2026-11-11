// Standalone fees: how Stripe charges its fees once funds segregation is on (for the whole account, every payment), and
// for some accounts anyway. A payment's balance entry then shows a fee of 0 and the whole amount; the real fee comes later
// as a daily total, and per payment only in Stripe's Fees report (report type all_fees.incurred_at.itemized.2, within 96
// hours). Cuvori read the fee from the balance entry: with 0 there, it sent the client's whole card fee back (today's
// prices charge it and refund what Stripe did not take), recorded Stripe's fee as 0 on the payment line for good (update
// 36's ledger lets it be set once), and sent a late payment back in full. These checks prove that a 0 there means "not
// known yet": nothing goes back and nothing is recorded until the Fees report has the real fee, and then exactly the
// surplus goes back, once.
// S1 a payment under standalone fees, S2 the hourly run before the report has it, S3 the report is asked for once, S4 the
// finished report settles it, S5 tax on the fee and cents read exactly, S6 a report without the payment's row, S7 a
// first payment line added from Stripe's record, S8 a late payment, S9 the report file needs the secret key and a Stripe
// address, S10 a top-up's line.
// Run: node tests/attack-standalone-fees.mjs
import { DB, STRIPE, hooks, req, call, mk, fund, pay, signed, reset, fns, moneyOut, finishReport } from "./fn-harness.mjs";
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const logs = []; const realError = console.error; console.error = (...a) => logs.push(a.map(String).join(" "));
const fx = await fns();
const REPORT = "all_fees.incurred_at.itemized.2";
const now = () => Math.floor(Date.now() / 1000);
const DAY = 86400;
const hourly = () => call(fx.autoRelease, req("POST", "x", {}));
const webhook = (s) => call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: s } })));
const checkout = (c) => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
const fundRow = (c, pi) => DB.order_payments.find(p => p.order_id === c.id && p.kind === "fund" && (!pi || p.provider_ref === pi));
const feeRefunds = (pi) => STRIPE.refunds.filter(r => r.payment_intent === pi && r.metadata.kind === "fee_surplus");
const chargeOf = (pi) => STRIPE.charges[STRIPE.intents[pi].latest_charge];
const collectedOf = (s, price) => s.amount_total - price - Number(s.metadata && s.metadata.connect_cents || 0);
const runs = () => STRIPE.reports.runs.filter(r => r.report_type === REPORT);
// a new scenario starts with no reports at Stripe (their request keys gone too, or Stripe would hand back the last scenario's)
const fresh = () => { STRIPE.reports = { end: 0, runs: [], instant: false }; for (const k of [...STRIPE.idem.keys()]) if (k.startsWith("feereport:")) STRIPE.idem.delete(k); };
// days pass: the payment and its ledger line are this many days old
const age = (pi, row, days) => { const ch = chargeOf(pi); ch.created = now() - days * DAY; for (const r of STRIPE.feeRows) if (r.incurred_by === ch.id) r.created = ch.created;
  if (row) row.created_at = new Date(Date.now() - days * DAY * 1000).toISOString(); };

let s1;
{ // S1 a €100 payment under today's prices, standalone fees: the balance entry says fee 0, Stripe really takes 175
  fresh(); const c = mk({ amount_cents: 10000 }); const f = await fund(fx, c, { standalone: true, fee: 175 });
  const pi = f.session.payment_intent, row = fundRow(c, pi);
  vuln(f.webhook.status !== 200 || c.funded_cents !== 10000 || !row || feeRefunds(pi).length !== 0 || row.provider_fee_cents != null || Number.isInteger(row.fee_refund_cents),
    `S1 a payment whose balance entry shows fee 0 -> paid ${f.webhook.status}, funded ${c.funded_cents}; card-fee refunds ${feeRefunds(pi).map(r => r.amount)} (must be none: the real fee is not known yet); Stripe's fee recorded ${row && row.provider_fee_cents} (must stay empty, not 0)`);
  s1 = { c, pi, row, collected: collectedOf(f.session, 10000) };
}
{ // S2 the hourly run, while the Fees report does not reach the payment yet: nothing goes back, no report is asked for
  const { pi, row } = s1; age(pi, row, 5); STRIPE.reports.end = chargeOf(pi).created;      // the report's data ends just before it
  const h = await hourly();
  vuln(h.status !== 200 || feeRefunds(pi).length !== 0 || row.provider_fee_cents != null || runs().length !== 0,
    `S2 the hourly run before the report has the payment -> ${h.status}; refunds ${feeRefunds(pi).length}, Stripe's fee ${row.provider_fee_cents}, reports asked for ${runs().length} (must be none, empty, none)`);
}
{ // S3 the report's data reaches the payment: the hourly run asks Stripe for the report once, and waits for it
  const { pi, row } = s1; STRIPE.reports.end = now() - 3600;
  const h1 = await hourly(); const asked = runs().length, r = runs()[0];
  STRIPE.reports.end = now() - 1800;                                          // an hour later Stripe's data reaches further
  const h2 = await hourly();
  const p = r && r.parameters || {};
  vuln(h1.status !== 200 || h2.status !== 200 || asked !== 1 || runs().length !== 1 || !(p.interval_start <= chargeOf(pi).created && p.interval_end > chargeOf(pi).created) || !["incurred_by", "amount", "tax", "currency"].every(x => (p.columns || []).includes(x)) || feeRefunds(pi).length !== 0 || row.provider_fee_cents != null,
    `S3 the report reaches the payment -> reports asked for ${asked}, then ${runs().length} after another hour (must be 1, 1: one request waiting at a time); it covers the payment: ${!!(p.interval_start <= chargeOf(pi).created && p.interval_end > chargeOf(pi).created)}, columns ${JSON.stringify(p.columns)}; refunds ${feeRefunds(pi).length}, Stripe's fee ${row.provider_fee_cents}`);
}
{ // S4 the report is ready: the hourly run records Stripe's real fee and sends exactly the surplus back, once
  const { c, pi, row, collected } = s1; if (runs()[0]) finishReport(runs()[0]);
  const h1 = await hourly(); const h2 = await hourly();
  vuln(h1.status !== 200 || row.provider_fee_cents !== 175 || row.fee_refund_cents !== collected - 175 || feeRefunds(pi).length !== 1 || feeRefunds(pi)[0].amount !== collected - 175 || c.funded_cents !== 10000 || moneyOut(c).refunded !== 0,
    `S4 the finished report -> Stripe's fee ${row.provider_fee_cents} (must be 175), refunds ${JSON.stringify(feeRefunds(pi).map(r => r.amount))} after two hourly runs (must be one of ${collected - 175}); the Order still holds ${c.funded_cents}`);
  reset();
}
{ // S5 tax on Stripe's fee counts (Stripe: add amount and tax), and amounts in euros become exact cents
  fresh(); const c = mk({ amount_cents: 25990 }); const f = await fund(fx, c, { standalone: true, fee: 415, feeTax: 79 });
  const pi = f.session.payment_intent, row = fundRow(c, pi); age(pi, row, 5); STRIPE.reports.end = now() - 3600; STRIPE.reports.instant = true;
  await hourly(); await hourly();
  const collected = collectedOf(f.session, 25990);
  vuln(row.provider_fee_cents !== 494 || feeRefunds(pi).length !== 1 || feeRefunds(pi)[0].amount !== collected - 494,
    `S5 a fee of €4.15 plus €0.79 tax -> Stripe's fee recorded ${row.provider_fee_cents} (must be 494), refund ${JSON.stringify(feeRefunds(pi).map(r => r.amount))} (must be ${collected - 494})`);
  reset();
}
{ // S6 a finished report that has no row for the payment: nothing is guessed, nothing goes back
  fresh(); const c = mk({ amount_cents: 10000 }); const f = await fund(fx, c, { standalone: true, fee: 175 });
  const pi = f.session.payment_intent, row = fundRow(c, pi), ch = chargeOf(pi).id; age(pi, row, 5);
  STRIPE.feeRows = STRIPE.feeRows.filter(r => r.incurred_by !== ch); STRIPE.reports.end = now() - 3600; STRIPE.reports.instant = true;
  await hourly(); await hourly();
  vuln(feeRefunds(pi).length !== 0 || row.provider_fee_cents != null || Number.isInteger(row.fee_refund_cents),
    `S6 the report has no row for the payment -> refunds ${feeRefunds(pi).length}, Stripe's fee ${row.provider_fee_cents}, card fee settled ${row.fee_refund_cents} (must be none, empty, not settled)`);
  reset();
}
{ // S7 the first payment's line could not be saved: the hourly run adds it from Stripe's record, with Stripe's fee empty, not 0
  fresh(); const c = mk({ amount_cents: 10000 });
  const res = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  hooks.db = async (method, table, search, body) => method === "POST" && table === "order_payments" && /"kind":"fund"/.test(String(body || "")) ? res(503, { message: "connection reset" }) : null;
  const f = await fund(fx, c, { standalone: true, fee: 175 }); hooks.db = null;
  const pi = f.session.payment_intent; c.funded_at = new Date(Date.now() - 3 * 60e3).toISOString();
  await hourly();
  const row = fundRow(c, pi);
  vuln(!row || row.provider_fee_cents != null || feeRefunds(pi).length !== 0,
    `S7 the first payment's line added from Stripe's record -> line ${!!row}, Stripe's fee ${row && row.provider_fee_cents} (must be empty, not 0), card-fee refunds ${feeRefunds(pi).length} (must be none yet)`);
  reset();
}
{ // S8 a late payment (the Order changed in the instant before the charge): all but Stripe's fee goes back, once it is known
  fresh(); const c = mk({ amount_cents: 10000 }); await checkout(c); const s = pay(c.stripe_checkout_id, { standalone: true, fee: 175 });
  hooks.stripe = async (p, m) => { if (m === "POST" && /\/capture$/.test(p)) { hooks.stripe = null; c.status = "cancelled"; } return null; };
  await webhook(s); hooks.stripe = null;
  const back = () => STRIPE.refunds.filter(r => r.payment_intent === s.payment_intent).reduce((a, r) => a + r.amount, 0);
  const early = back();
  age(s.payment_intent, null, 5); STRIPE.reports.end = now() - 3600; STRIPE.reports.instant = true;
  await hourly(); await hourly();
  vuln(early !== 0 || back() !== s.amount_total - 175,
    `S8 a late payment under standalone fees -> sent back at once ${early} (must be 0: Stripe's fee not known yet), after the report ${back()} (must be ${s.amount_total - 175}: all but Stripe's fee)`);
  reset();
}
{ // S9 the report's file is fetched only from Stripe's file address, with the secret key
  const fileCalls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => { if (String(url).includes("files.stripe.com")) fileCalls.push({ url: String(url), auth: (init.headers || {}).Authorization || "" }); return realFetch(url, init); };
  fresh(); const c = mk({ amount_cents: 10000 }); const f = await fund(fx, c, { standalone: true, fee: 175 });
  const pi = f.session.payment_intent, row = fundRow(c, pi); age(pi, row, 5); STRIPE.reports.end = now() - 3600; STRIPE.reports.instant = true;
  // (the report one hourly run asks for is read in the next: the older payments waiting no longer go first, check of 2 November)
  await hourly(); await hourly();
  globalThis.fetch = realFetch;
  vuln(!fileCalls.length || fileCalls.some(x => !/^https:\/\/files\.stripe\.com\/v1\/files\/file_[A-Za-z0-9]+\/contents$/.test(x.url) || x.auth !== "Bearer " + process.env.STRIPE_SECRET_KEY) || row.provider_fee_cents !== 175,
    `S9 the report's file -> fetched ${fileCalls.length} time(s) from ${JSON.stringify(fileCalls.map(x => x.url))}, with the secret key: ${fileCalls.every(x => x.auth === "Bearer " + process.env.STRIPE_SECRET_KEY)}; Stripe's fee ${row.provider_fee_cents}`);
  // a report whose file address is not Stripe's is never fetched (the key would go with it)
  fresh(); const c2 = mk({ amount_cents: 10000 }); const f2 = await fund(fx, c2, { standalone: true, fee: 175 });
  const pi2 = f2.session.payment_intent, row2 = fundRow(c2, pi2); age(pi2, row2, 5); STRIPE.reports.end = now() - 3600;
  await hourly();
  const run = runs()[0]; if (run) { finishReport(run); run.result.url = "https://evil.example/v1/files/" + run.result.id + "/contents"; }
  const sent = [];
  globalThis.fetch = async (url, init = {}) => { if (String(url).includes("evil.example")) sent.push(String(url)); return realFetch(url, init); };
  await hourly(); globalThis.fetch = realFetch;
  vuln(!run || sent.length || row2.provider_fee_cents != null || feeRefunds(pi2).length,
    `S9 a report whose file address is not Stripe's -> requests to it ${sent.length} (must be none), Stripe's fee ${row2.provider_fee_cents}, refunds ${feeRefunds(pi2).length} (must stay empty, none)`);
  reset();
}
{ // S10 a top-up's line under standalone fees: Stripe's fee empty, not 0, and no card-fee refund yet
  fresh(); const c = mk({ amount_cents: 10000 }); await fund(fx, c, { standalone: true, fee: 175 });
  Object.assign(c, { amount_cents: 15000, price: 150 });
  const f = await fund(fx, c, { standalone: true, fee: 100 });
  const pi = f.session && f.session.payment_intent, row = pi && fundRow(c, pi);
  vuln(!row || row.provider_fee_cents != null || feeRefunds(pi).length !== 0 || c.funded_cents !== 15000,
    `S10 a €50 top-up under standalone fees -> line ${!!row}, Stripe's fee ${row && row.provider_fee_cents} (must be empty), card-fee refunds ${pi ? feeRefunds(pi).length : "-"} (must be none yet), funded ${c.funded_cents}`);
  reset();
}

console.error = realError;
console.log(out.join("\n"));
const bad = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${bad} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(bad ? 1 : 0);
