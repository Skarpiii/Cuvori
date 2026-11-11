// Second re-check of 8 November (of add8ade, the re-check's fixes): regression checks for what three fresh reviewers proved.
// U1 a chargeback's first step (counting every payout at Stripe the books don't show) took every error for "the database
//    refuses this for good" and went on: when the database did not answer for a moment, the chargeback closed on books
//    without the payout (paid out 0.00 where the freelancer had 190.00), Stripe was told all was well and never sent the
//    notice again, and nothing on the Order said what Cuvori lost. Now only what is refused for good goes on; anything else
//    fails the notice, and Stripe sends it again.
// U2 the note "payouts not in the books": noted while the books can't take the payout; it stays for a person until marked
//    as handled, also once the books can take the payout after all (re-check of 9 November: dropped then by a cancel's or
//    a decision's count, it went where money had really gone out twice; tests/attack-recheck-nov9.mjs, Z1).
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


// ---------- U1 a passing error at a chargeback's first count fails the notice, and Stripe sends it again ----------
// (a payout whose answer was lost, then a chargeback of the whole payment the freelancer's balance can't cover, decided for
// the client; the count's write of the paid-out total fails once at the bank's notices with a database timeout)
const noFunds = async (path, method) => (method === "POST" && /\/reversals$/.test(path)) ? [400, { error: { type: "invalid_request_error", code: "insufficient_funds", message: "Insufficient funds in the connected account to reverse this transfer." } }] : null;
let failsLeft = 0, failed = 0;
const countFails = async (method, table, search, body) => {
  if (failsLeft > 0 && method === "PATCH" && table === "contracts" && /"released_cents"/.test(String(body)) && !/"chargeback_status"/.test(String(body))) { failsLeft--; failed++; return dbError(); }
  return null;
};
// Stripe: a notice not answered 200 is sent again (here at once, up to 3 tries)
const stripeSends = async (c, ch, status) => { const got = []; for (let i = 0; i < 3; i++) { const r = await dispute(c, ch, status); got.push(r.status); if (r.status === 200) break; later(30); } return got; };
for (const [name, mkX, plan] of PLANS) for (const what of ["whole", "part"]) for (const faults of [[1, 1], [0, 1], [1, 0], ["none", 2]]) {
  await guard(`U1 [${name}] ${what} ${faults}`, async () => {
    ready(true); failed = 0;
    const c = mkX({ amount_cents: 20000, price: 200 }); const f = await fund2(c); const ch = chargeOf(f.session.payment_intent);
    let m1 = null;
    if (what === "part") { row(c).status = "funded"; [m1] = ms(c, [6000, 14000]); }
    lostTransfer();
    const a = what === "part" ? await approve(c, m1.id) : await approve(c);
    FAULT.pred = null; later(15);
    STRIPE.disputes[ch.id] = { id: "dp_" + ch.id, status: "needs_response" };
    hooks.stripe = noFunds; hooks.db = countFails;
    failsLeft = faults[0] === "none" ? 0 : faults[0];
    const w1 = faults[0] === "none" ? ["none (the bank's 'lost' is the first notice Cuvori gets)"] : await stripeSends(c, ch, "needs_response");
    failsLeft = faults[1];
    const w2 = await stripeSends(c, ch, "lost");
    hooks.stripe = null; hooks.db = null; failsLeft = 0;
    for (let i = 0; i < 3; i++) { later(60); await hourly(); }
    const covered = notes(c).filter(n => /could not be pulled back/.test(n));
    const owes = what === "part" ? freelancerGets(plan, 6000) : freelancerGets(plan, 20000);
    const p = ledgerP(c, plan).filter(x => x !== "more_out_than_in");
    vuln(sent(c) !== owes || !covered.length || row(c).released_cents < (what === "part" ? 6000 : 20000) || lines(c, "release").length !== 1 || row(c).chargeback_status !== "lost" || p.length,
      `U1 [${name}] ${what === "part" ? "part 1 (60.00)" : "the whole Order (200.00)"} paid out, its answer lost (${a.status}); the whole payment charged back, the pull-back refused; the count's write fails ${faults[0] === "none" ? "-" : faults[0] + "x"} at "created", ${faults[1]}x at "lost" (failed ${failed}); notices: created ${w1.join("/")}, lost ${w2.join("/")}: ${show(c)}; payout lines ${lines(c, "release").length}${m1 ? ", part 1 " + mstat(m1) : ""}; chargeback ${row(c).chargeback_status}; note: ${covered.length ? '"' + covered[0].slice(0, 80) + '…"' : "NONE"}${report(p)} (must be: the payout counted, the chargeback lost, a note saying what Cuvori covered)`);
  });
}

// ---------- U2 the note "payouts not in the books" stays for a person ----------
// (part 1's payout made, its answer lost; 50.00 refunded in the Stripe dashboard: the books can't take the payout and the
// Order is noted. Then the dashboard refund fails, its money back at Cuvori: the books can take the payout, and a cancel or a
// decision counts it; or money is pulled back from the freelancer, or a chargeback is decided. The note stays until a person
// marks it as handled: only a person can tell whether money really went out twice.)
for (const [name, mkX, plan] of PLANS) for (const where of ["cancel", "decision", "chargeback", "cancel, pulled back by hand"]) {
  if (where.includes("pulled back") && plan === 2) continue;           // (at the new prices the books still can't take it then)
  await guard(`U2 [${name}] ${where}`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent, ch = chargeOf(pi);
    row(c).status = "funded"; const [m1] = ms(c, [6000, 4000]);
    lostTransfer(); await approve(c, m1.id); FAULT.pred = null; later(5);
    const r1 = dashRefund(pi, 5000); await webhook(refundedEvent(pi));
    const notDisputed = () => { const x = row(c); if (x.status === "disputed") { x.status = "funded"; x.disputed_at = null; x.dispute_by = null; } };
    const again = async () => { if (where === "decision") { if (row(c).status !== "disputed") disputed(c); return resolve(c, "refund"); } notDisputed(); return cancel(c); };
    const k1 = where === "chargeback" ? await dispute(c, ch, "needs_response", { amount: 5000 }) : await again();
    const n1 = notes(c).filter(n => /not in the books/.test(n)).length;
    let what;
    if (where === "cancel, pulled back by hand") {                          // a person pulls 20.00 back in the Stripe dashboard
      const t = tsOf(c).find(x => (x.metadata.purpose || "release") === "release");
      const pb = await fetch(`https://api.stripe.com/v1/transfers/${t.id}/reversals`, { method: "POST", headers: { Authorization: "Bearer " + process.env.STRIPE_SECRET_KEY, "content-type": "application/x-www-form-urlencoded" }, body: "amount=2000" });
      what = `20.00 pulled back from the freelancer in the Stripe dashboard (${pb.status})`;
    } else what = `the dashboard refund failed (${(await webhook(refundFails(r1))).status})`;
    later(5);
    const k2 = where === "chargeback" ? await dispute(c, ch, "won", { amount: 5000 }) : await again();
    for (let i = 0; i < 2; i++) { later(60); await hourly(); }
    const left = notes(c).filter(n => /not in the books/.test(n));
    const stays = true;
    const payoutLines = lines(c, "release").filter(l => !/^chargeback_won/.test(l.note || "")).length;   // (a won chargeback's re-payment has its own)
    const p = where === "chargeback" || where.includes("pulled back") ? [] : ledgerP(c, plan).filter(x => x !== "more_out_than_in");
    vuln(n1 !== 1 || (stays ? left.length !== 1 : left.length > 0) || k2.status !== 200 || payoutLines !== 1 || p.length,
      `U2 [${name}] part 1's payout made (answer lost), 50.00 refunded in the dashboard; ${where === "chargeback" ? "the bank charges back the other 50.00" : where.startsWith("cancel") ? "the freelancer's cancel" : "the decision 'refund'"} -> ${k1.status} ${(k1.json && k1.json.code) || ""} (note ${n1}); ${what}; ${where === "chargeback" ? "the chargeback won" : "again"} -> ${k2.status} ${(k2.json && k2.json.code) || ""}; ${show(c)}; payout lines ${payoutLines}; "payouts not in the books" on the Order: ${left.length ? '"' + left[0].slice(0, 70) + '…"' : "gone"}${report(p)} (must be: noted while the books can't take the payout; ${stays ? "kept for a person until marked as handled" : "gone once they can"})`);
  });
}

console.error = realError;
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
