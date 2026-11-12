// Fixes of 9 November: a chargeback the bank decided for Cuvori ("won") on an Order whose books can't take a payout Stripe
// made (a part's payout whose answer was lost, then a refund in the Stripe dashboard: paid out and given back would be more
// than was paid in). Counting the payouts first, the re-payment step was refused by the database for good: the bank's notice
// failed every time Stripe sent it, the Order kept "chargeback won; re-payment pending" for ever, and nothing moved on it.
// W1 the pull-back was refused (nothing at the freelancer), the chargeback decided won or lost.
// W2 the pull-back went through for one payout only (part 2's), the other refused; decided won or lost. Stripe sends a
//    notice again while it is not answered 200 (here up to 3 more times).
// W3 the hourly run's re-payment (decided won while the freelancer's account couldn't take money), its answer lost, then
//    its count refused for good (a refund in the Stripe dashboard meanwhile), or failing for a moment (counted on the next
//    run, never noted as refused).
// Now the re-payment step goes on with the books as they are when the database refuses the count for good: the Order says
// what can't be counted ("payouts not in the books", for a person). What the chargeback pulled back is paid back in full, the
// part the Order no longer has from Cuvori's own money, said on the Order (the owner's decision of 12 November).
import { DB, DBQ, STRIPE, V56, users, hooks, req, call, mk, reset, fns, pay, signed, uuid, fsReset } from "./fn-harness.mjs";
import { checkLines, reconcile, listed } from "./plan2-ledger.mjs";
import fs from "node:fs";
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const realError = console.error; console.error = () => {};
const guard = async (name, fn) => { try { await fn(); } catch (e) { out.push(`VULNERABLE ${name} threw: ${e && e.stack ? e.stack.split("\n").slice(0, 2).join(" ") : e}`); } finally { reset(); FAULT.pred = null; FAULT.hit = 0; } };
const fx = await fns();
V56.on = true;
STRIPE.balance = 50_000_000_000;
const RealDate = Date; let skew = 0;
globalThis.Date = class extends RealDate { constructor(...a) { if (a.length === 0) super(RealDate.now() + skew); else super(...a); } static now() { return RealDate.now() + skew; } };
const later = (min) => { skew += min * 60e3; };
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(() => { if (Number(ms) > 0) skew += Number(ms); fn(...args); }, 0);
const DAY = 1440;
// one write that lands at Stripe or in the database while its answer is lost (the connection drops), or that is refused
const FAULT = { pred: null, how: null, hit: 0 };
const innerFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (FAULT.pred && FAULT.pred(u, init)) {
    FAULT.pred = null; FAULT.hit++;
    if (FAULT.how === "refused") return u.includes("api.stripe.com")
      ? new Response(JSON.stringify({ error: { type: "api_error", message: "An unknown error occurred" } }), { status: 500, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ message: "canceling statement due to statement timeout" }), { status: 500, headers: { "content-type": "application/json" } });
    await innerFetch(url, init);
    const e = new TypeError("fetch failed"); e.cause = { code: "UND_ERR_SOCKET" }; throw e;
  }
  return innerFetch(url, init);
};
const arm = (how, pred) => { FAULT.how = how; FAULT.pred = pred; };
const bodyOf = (init) => String(init && init.body || "");
const chargeOf = (pi) => STRIPE.charges[STRIPE.intents[pi].latest_charge];
const webhook = (ev) => call(fx.webhook, req("POST", "x", ev));
const hourly = () => call(fx.autoRelease, req("POST", "x", {}));
const NOTE = "Cuvori looked at the chat and the files.";
const checkout = (c) => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
const approve = (c, milestone_id) => call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, ...(milestone_id ? { milestone_id } : {}) } }));
const cancel = (c, extra = {}) => call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id, ...extra } }));
const resolve = (c, decision, extra = {}) => call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision, note: NOTE, ...extra } }));
const completed = (s) => signed({ type: "checkout.session.completed", data: { object: s } });
const cbEvent = (type, ch, extra = {}) => signed({ type, data: { object: { id: extra.id || "dp_" + ch.id, object: "dispute", charge: ch.id, payment_intent: ch.payment_intent, amount: extra.amount || ch.amount, currency: "eur", status: extra.status || "needs_response", reason: "fraudulent",
  created: (STRIPE.disputes[ch.id] && STRIPE.disputes[ch.id].created) || Math.floor(Date.now() / 1000) } } });
const dispute = async (c, ch, status, extra = {}) => {
  STRIPE.disputes[ch.id] = { ...(STRIPE.disputes[ch.id] || {}), id: extra.id || "dp_" + ch.id, status, ...(extra.amount ? { amount: extra.amount } : {}) };
  const type = ["won", "lost", "warning_closed"].includes(status) ? "charge.dispute.closed" : "charge.dispute.created";
  return webhook(cbEvent(type, ch, { status, ...extra }));
};
const mk2 = (o = {}) => mk({ pricing_version: 2, commission_bps: 500, commission_cents: 0, auto_days: 14, ...o });
const mk1 = (o = {}) => mk({ pricing_version: 1, commission_bps: 0, commission_cents: 0, auto_days: 7, ...o });
const row = (c) => DB.contracts.find(x => x.id === c.id) || c;
const lines = (c, kind) => DB.order_payments.filter(p => p.order_id === c.id && (!kind || p.kind === kind));
const tsOf = (c) => STRIPE.transfers.filter(t => t.metadata.contract_id === c.id);
const sent = (c) => tsOf(c).reduce((a, t) => a + t.amount - t.amount_reversed, 0);
const back = (c) => STRIPE.refunds.filter(r => r.contract === c.id && !(r.metadata && ["fee_surplus", "late_payment"].includes(r.metadata.kind))).reduce((a, r) => a + r.amount, 0);
const held = (c) => { const x = row(c); return x.funded_cents - x.released_cents - x.refunded_cents; };
const events = (c, ev) => DB.order_events.filter(e => e.order_id === c.id && (!ev || e.event === ev));
const cards = (c, ev) => DB.messages.filter(m => m.kind === "contract" && m.payload && m.payload.contract_id === c.id && m.payload.event === ev);
const ms = (c, amounts, status = "submitted") => { c.has_milestones = true; return amounts.map((a, i) => { const m = { id: uuid(), order_id: c.id, title: "part " + (i + 1), amount_cents: a, status, position: i + 1 }; DB.order_milestones.push(m); return m; }); };
const ledger = (c) => { const x = row(c); return [...checkLines(DB, [c.id]), ...reconcile(DB, STRIPE, x), ...listed(DB, x)]; };
const report = (p) => p.length ? " — " + p.slice(0, 3).join(" | ") : "";
async function fund2(c) { const r = await checkout(c); if (r.status !== 200) return { checkout: r }; const s = pay(c.stripe_checkout_id); return { checkout: r, session: s, webhook: await webhook(completed(s)) }; }
async function topUp(c, cents) { c.amount_cents += cents; const r = await checkout(c); if (r.status !== 200) return { checkout: r }; const s = pay(c.stripe_checkout_id); return { checkout: r, session: s, webhook: await webhook(completed(s)) }; }
const ready = (yes) => { STRIPE.accounts.acct_1EditorAAAAAAAA.payouts_enabled = yes; DB.payout_details.find(p => p.id === users.ed.id).stripe_payouts_enabled = yes; };
const dbError = () => new Response(JSON.stringify({ message: "canceling statement due to statement timeout" }), { status: 500, headers: { "content-type": "application/json" } });
const disputed = (c) => { const x = row(c); x.status = "disputed"; x.dispute_by = users.cl.id; x.disputed_at = new Date().toISOString(); };
const PLANS = [["plan 2", mk2, 2], ["plan 1", mk1, 1]];
const root = process.env.TARGET ? "file://" + process.env.TARGET + "/" : new URL("../", import.meta.url).href;
const page = fs.readFileSync(new URL("index.html", root), "utf8");
const CB_MARK = /^chargeback(:| won)/, OTHER_CB = /^chargeback (\S+) also (?:open )?on payment /;
const notes = (c) => String(row(c).money_error || "").split(" · Also: ").filter(Boolean);


const nz0 = (x) => Number(x) || 0;
const ban = (u, yes = true) => { DB.profiles.find(p => p.id === u.id).banned = yes; u.banned = yes; };
const show = (c) => { const x = row(c); return `${x.status}, paid in ${x.funded_cents}, paid out ${x.released_cents}, back ${x.refunded_cents}, held ${held(c)}; at the freelancer ${sent(c)}, back to the client ${back(c)}`; };
const ledgerP = (c, plan) => plan === 2 ? ledger(c).filter(x => !x.startsWith("to_decide:")) : (linesOk(c) ? [] : [`the paid-out total ${row(c).released_cents} is not what its lines say`]);
const linesOk = (c) => { const x = row(c), ls = lines(c); const sum = (k) => ls.filter(l => l.kind === k).reduce((a, l) => a + l.amount_cents, 0);
  return x.released_cents === sum("release") - sum("reversal"); };

const dashRefund = (pi, amount) => { const ch = chargeOf(pi); ch.amount_refunded += amount; STRIPE.balance -= amount;
  const r = { id: "re_dash" + Math.random().toString(36).slice(2, 10), created: Date.now() / 1000, amount, contract: null, metadata: {}, payment_intent: pi, charge: ch.id, status: "succeeded" }; STRIPE.refunds.push(r); return r; };
const refundedEvent = (pi) => { const ch = chargeOf(pi); return signed({ type: "charge.refunded", data: { object: { id: ch.id, object: "charge", payment_intent: pi, amount: ch.amount, amount_refunded: ch.amount_refunded, refunded: ch.amount_refunded >= ch.amount, currency: "eur" } } }); };
const failedEvent = (r) => signed({ type: "charge.refund.updated", data: { object: { ...r, object: "refund", status: "failed", currency: "eur", failure_reason: "expired_or_canceled_card" } } });
const refundFails = (r) => { r.status = "failed"; const ch = STRIPE.charges[r.charge]; ch.amount_refunded -= r.amount; STRIPE.balance += r.amount; return failedEvent(r); };
const okBack = (pi) => STRIPE.refunds.filter(r => r.payment_intent === pi && r.status === "succeeded" && !(r.metadata && ["fee_surplus", "late_payment"].includes(r.metadata.kind))).reduce((a, r) => a + r.amount, 0);
const okLate = () => 0;
// schema v55's rule: order_payments.kind in ('fund','release','refund','reversal','chargeback') (no "refund_failed" yet)
const v55 = async (method, table, search, body) => (method === "POST" && table === "order_payments" && /"kind":"refund_failed"/.test(String(body))
  ? new Response(JSON.stringify({ code: "23514", message: 'new row for relation "order_payments" violates check constraint "order_payments_kind_check"' }), { status: 400, headers: { "content-type": "application/json" } }) : null);
const freelancerGets = (plan, cents) => plan === 2 ? Math.round(cents * 0.95) : cents;
const mstat = (m) => DB.order_milestones.find(x => x.id === m.id).status;
const lostTransfer = () => arm("lost", (u, init) => u.includes("api.stripe.com/v1/transfers") && init.method === "POST" && !u.includes("reversals"));
// a database without v56: PostgREST refuses a select naming a column that is not there, and the kind "refund_failed"
const V56COLS = /(payout_purpose|commission_cents|payout_cents|entry_key|pricing_version)/;
const v55full = async (method, table, search, body) => {
  if (method === "GET" && table === "order_payments") { const sel = new URLSearchParams(String(search || "").replace(/^\?/, "")).get("select") || ""; if (V56COLS.test(sel)) return new Response(JSON.stringify({ code: "42703", message: `column order_payments.${(sel.match(V56COLS) || [])[1]} does not exist` }), { status: 400, headers: { "content-type": "application/json" } }); }
  return v55(method, table, search, body);
};


const noFunds = async (path, method) => (method === "POST" && /\/reversals$/.test(path)) ? [400, { error: { type: "invalid_request_error", code: "insufficient_funds", message: "Insufficient funds in the connected account to reverse this transfer." } }] : null;
// Stripe: a notice not answered 200 is sent again (here up to 3 more times)
const stripeSends = async (c, ch, status, amount) => { const got = []; for (let i = 0; i < 4; i++) { const r = await dispute(c, ch, status, { amount }); got.push(r.status); if (r.status === 200) break; later(60); } return got; };
const repays = (c) => tsOf(c).filter(t => /^retransfer_/.test(t.metadata.purpose || ""));
const noteOf = (c, re) => notes(c).filter(n => re.test(n));

// ---------- W1 the pull-back refused ----------
for (const [name, mkX, plan] of PLANS) for (const outcome of ["won", "lost"]) {
  await guard(`W1 [${name}] ${outcome}`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent, ch = chargeOf(pi);
    row(c).status = "funded"; const [m1] = ms(c, [6000, 4000]);
    lostTransfer(); await approve(c, m1.id); FAULT.pred = null; later(5);
    dashRefund(pi, 5000); const w = await webhook(refundedEvent(pi));
    hooks.stripe = noFunds;
    const w1 = await stripeSends(c, ch, "needs_response", 5000);
    later(60); await hourly();
    const w2 = await stripeSends(c, ch, outcome, 5000);
    for (let i = 0; i < 3; i++) { later(60); await hourly(); }
    hooks.stripe = null;
    const pending = noteOf(c, /^chargeback won; re-payment/), told = noteOf(c, /not in the books/);
    vuln(w1.join() !== "200" || w2.join() !== "200" || row(c).chargeback_status !== outcome || pending.length || !told.length || repays(c).length || sent(c) !== freelancerGets(plan, 6000),
      `W1 [${name}] part 1 (60.00) paid out, its answer lost; 50.00 refunded in the dashboard (${w.status}); the other 50.00 charged back, the pull-back refused; decided ${outcome}: notices ${w1.join("/")}, ${w2.join("/")}; ${show(c)}; chargeback ${row(c).chargeback_status}; paid again ${repays(c).length}; notes: ${JSON.stringify(notes(c).map(n => n.slice(0, 45)))} (must be: every notice 200 at once, ${outcome}, nothing paid again, no re-payment waiting, the Order says what can't be counted)`);
  });
}

// ---------- W2 the pull-back went through for one payout only ----------
for (const [name, mkX, plan] of PLANS) for (const outcome of ["won", "lost"]) {
  await guard(`W2 [${name}] ${outcome}`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent, ch = chargeOf(pi);
    row(c).status = "funded"; const [m1, m2] = ms(c, [5000, 1000, 4000]);
    lostTransfer(); await approve(c, m1.id); FAULT.pred = null; later(2);
    lostTransfer(); await approve(c, m2.id); FAULT.pred = null; later(2);
    const t1 = STRIPE.transfers.find(t => t.metadata.milestone_id === m1.id);
    dashRefund(pi, 6000); await webhook(refundedEvent(pi));
    hooks.stripe = async (path, method) => (method === "POST" && path === `/transfers/${t1.id}/reversals`) ? [400, { error: { type: "invalid_request_error", code: "insufficient_funds", message: "Insufficient funds in the connected account to reverse this transfer." } }] : null;
    const w1 = await stripeSends(c, ch, "needs_response", 4000);
    for (let i = 0; i < 2; i++) { later(60); await hourly(); }
    const w2 = await stripeSends(c, ch, outcome, 4000);
    for (let i = 0; i < 3; i++) { later(60); await hourly(); }
    hooks.stripe = null;
    // (check of 13 November: a refund made in the dashboard that leaves the Order holding nothing counts its payouts first, so
    // the Order says right then what of it went out twice; Cuvori's part of a re-payment is then already in that)
    const twiceSaid = noteOf(c, /had already been paid/);
    const pending = noteOf(c, /^chargeback won; re-payment/), told = [...noteOf(c, /not in the books/), ...twiceSaid], covered = [...noteOf(c, /^re-payment covered by Cuvori/), ...twiceSaid];
    const madeOut = freelancerGets(plan, 5000) + freelancerGets(plan, 1000);
    const d = "dp_" + ch.id, pulled = STRIPE.reversals.filter(r => r.metadata && r.metadata.reason === d).reduce((a, r) => a + r.amount, 0);
    const paidBack = repays(c).reduce((a, t) => a + t.amount, 0);
    const okBack = outcome === "won" ? pulled > 0 && paidBack === pulled && repays(c).length === 1 && covered.length === 1 : !repays(c).length && !noteOf(c, /^re-payment covered by Cuvori/).length;
    vuln(w1[w1.length - 1] !== 200 || w2[w2.length - 1] !== 200 || row(c).chargeback_status !== outcome || pending.length || !told.length || !okBack || sent(c) > madeOut,
      `W2 [${name}] parts 50.00 + 10.00 paid out (answers lost), 60.00 refunded in the dashboard; 40.00 charged back, only part 2's payout can be pulled back; decided ${outcome}: notices ${w1.join("/")}, ${w2.join("/")}; ${show(c)}; chargeback ${row(c).chargeback_status}; pulled back ${pulled}, paid back ${paidBack} in ${repays(c).length} payout(s); notes: ${JSON.stringify(notes(c).map(n => n.slice(0, 45)))} (must be: every notice answered 200 in the end, ${outcome}, ${outcome === "won" ? "what was pulled back paid back once, Cuvori's part said" : "nothing paid again"}, no re-payment waiting, the Order says what can't be counted)`);
  });
}

// ---------- W3 the hourly run's re-payment, its count refused for good (or failing for a moment) ----------
// (the whole Order paid out and counted; the bank charges it back, all of it pulled back; decided won while the freelancer's
// Stripe account can't take money: the re-payment waits for the hourly run. The hourly run pays it again, its answer lost.
// Then either 50.00 is refunded in the Stripe dashboard, so the books can never take that re-payment, or the count's write
// fails once with a database timeout.)
let failsLeft = 0;
const countFails = async (method, table, search, body) => {
  if (failsLeft > 0 && method === "PATCH" && table === "contracts" && /"released_cents"/.test(String(body))) { failsLeft--; return dbError(); }
  return null;
};
for (const [name, mkX, plan] of PLANS) for (const how of ["refused for good", "a passing error"]) {
  await guard(`W3 [${name}] ${how}`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent, ch = chargeOf(pi);
    row(c).status = "delivered"; const a = await approve(c); later(5);
    const w1 = await stripeSends(c, ch, "needs_response", 10000);
    ready(false); const w2 = await stripeSends(c, ch, "won", 10000);
    const waiting = noteOf(c, /^chargeback won/).length;
    ready(true); lostTransfer(); later(60); await hourly(); FAULT.pred = null;
    const made = repays(c).length;
    let wd = "-";
    if (how === "refused for good") { dashRefund(pi, 5000); wd = (await webhook(refundedEvent(pi))).status; }
    else { failsLeft = 1; hooks.db = countFails; }
    later(60); await hourly(); hooks.db = null; failsLeft = 0;
    const falseNote = how === "a passing error" ? noteOf(c, /not in the books/).length : 0;
    for (let i = 0; i < 2; i++) { later(60); await hourly(); }
    const pending = noteOf(c, /^chargeback won/), told = noteOf(c, /not in the books/);
    const okBooks = how === "a passing error" ? row(c).released_cents === 10000 && !told.length : told.length > 0;
    vuln(a.status !== 200 || w1.join() !== "200" || w2.join() !== "200" || !waiting || made !== 1 || repays(c).length !== 1 || pending.length || falseNote || !okBooks || sent(c) !== freelancerGets(plan, 10000),
      `W3 [${name}] the whole Order paid out (${a.status}), charged back and pulled back (${w1.join("/")}); won while the freelancer's account can't take money (${w2.join("/")}, waiting ${waiting}); the hourly run pays it again, its answer lost (made ${made}); ${how === "refused for good" ? "50.00 refunded in the dashboard (" + wd + ")" : "the count's write fails once"}; hourly runs: ${show(c)}; paid again ${repays(c).length}; notes: ${JSON.stringify(notes(c).map(n => n.slice(0, 45)))} (must be: paid again once, no re-payment waiting, ${how === "refused for good" ? "the Order says what can't be counted" : "counted on the next run, with no note saying the books can't take it"})`);
  });
}

console.error = realError;
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
