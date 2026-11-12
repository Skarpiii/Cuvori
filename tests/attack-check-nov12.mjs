// Check of 12 November (the owner's decision of 12 November, both price plans): on an Order where money went out twice (a
// payout whose answer was lost, then a refund in the Stripe dashboard), the freelancer paid for Cuvori's mistake.
// R1 a chargeback the bank decided for Cuvori: what was pulled back from the freelancer for it was paid back only up to what
//    the Order still had, the rest only if money ever came back to that Order, and the note said not to pay it by hand: the
//    freelancer was never paid back (10.00, 9.50 after 30 days). Now all of it is paid back right away; what the Order no
//    longer has comes from Cuvori's own money, and the Order's note says how much.
// R2 a later chargeback, on a top-up for a part never paid out: what the Order held came out below nothing, and the
//    freelancer's earlier pay was pulled back for it (28.50 lost when the bank decided for the client). Now a pull-back takes
//    at most what the freelancer was paid out of that payment (the payouts made after it came in).
// R3 the first chargeback's rest was never paid once a second one was recorded, its note stuck; now nothing is left over.
// R4 what is unchanged: an Order that holds money (paid back in full, no note); a top-up's chargeback whose part was paid
//    out after it (pulled back as before); a pull-back made by hand in the Stripe dashboard is never paid back by Cuvori; the
//    freelancer's Stripe account not ready (paid by the hourly run once it is); a note that can't be saved fails the step
//    before anything is paid; a re-payment the database refuses to count is said, gets no line without its total, and is
//    counted once by the next step that counts first.
// R5 (second part) the bank decides for the client and the pull-back from the freelancer was refused every time (their Stripe
//    balance empty), on such an Order: nothing said what Cuvori lost (the books, missing the payout, showed the Order holding
//    the money), and the note saying a pull-back was still owed went. Now the Order says how much could not be pulled back,
//    from what the pull-back still owed (only what it still owed, when part of it went through). Orders whose books know
//    the payout say the same as before.
// R6 (third part) the freelancer gave back all of it, but the Order no longer had the money (it went out twice): the note said
//    "could not be pulled back from the freelancer", which sends a person to pull back money they don't owe. Now it says
//    Cuvori covered it because the Order no longer had it, and that the freelancer gave back all they had to.
// (fifth part) R3 had no check of its own until now: the second chargeback waits until the first one's re-payment is made.
// R7 a chargeback on a top-up for a part never paid out, decided for the client, on such an Order: nothing is pulled back
//    from the freelancer (R2), and nothing said what Cuvori lost (the books, missing the payout, showed the Order holding
//    40.00 it no longer had). Now the Order says Cuvori covered the 30.00. On an ordinary Order nothing is said, as before.
// R8 the note "re-payment covered by Cuvori" said the money was "paid back" while the re-payment still waited (the freelancer
//    banned, or their Stripe account not ready). Now it says what Cuvori pays, true before and after the payment.
// R9 at the new prices the first "chargeback opened" notice on such an Order failed once (the database refused the paid-out
//    total after the pull-back; Stripe's next send went through). Now it goes through the first time, as at today's prices.
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
const unNote = (c) => notes(c).filter(n => n.startsWith("payouts not in the books")).length;
const eur = (cents) => (cents / 100).toFixed(2) + " EUR";
const notDisputed = (c) => { const x = row(c); if (x.status === "disputed") { x.status = "funded"; x.disputed_at = null; x.dispute_by = null; } };
// the Order's money at Stripe: what went out (payouts net of pull-backs, refunds, a lost chargeback) against what came in
const outAtStripe = (c, pi) => { const ch = chargeOf(pi); const bank = STRIPE.disputes[ch.id] && STRIPE.disputes[ch.id].status === "lost" ? (STRIPE.disputes[ch.id].amount || 0) : 0;
  return tsOf(c).reduce((a, t) => a + t.amount - t.amount_reversed, 0) + okBack(pi) + bank; };


const pulledAt = (c, d) => STRIPE.reversals.filter(r => r.metadata && r.metadata.contract_id === c.id && r.metadata.reason === d).reduce((a, r) => a + r.amount, 0);
const revLines = (c, d) => lines(c, "reversal").filter(l => l.note === `chargeback ${d}`);
const revSum = (c, d) => revLines(c, d).reduce((a, l) => a + l.amount_cents, 0);
const cbNote = (c) => notes(c).filter(n => /^chargeback:/.test(n)).length;
const last = (a) => a[a.length - 1];
const repaidOf = (c, d) => tsOf(c).filter(t => t.metadata.purpose === `retransfer_${d}`).reduce((a, t) => a + t.amount, 0);
const resend = async (c, ch, amount, n = 3) => { const got = []; for (let i = 0; i < n; i++) { later(30); got.push((await dispute(c, ch, "needs_response", { amount })).status); } return got; };
const hours = async (n) => { for (let i = 0; i < n; i++) { later(60); await hourly(); } };

const COVER_HEAD = "re-payment covered by Cuvori after chargeback ";
const covers = (c) => notes(c).filter(n => n.startsWith(COVER_HEAD));
const pending = (c) => notes(c).filter(n => /^chargeback won/.test(n)).length;
const repays = (c, d) => tsOf(c).filter(t => t.metadata.purpose === `retransfer_${d}`);
const grossT = (t) => t.metadata && t.metadata.gross_cents ? Number(t.metadata.gross_cents) : t.amount;
// the books follow Stripe: today's prices, the paid-out total is what the freelancer has (and its lines say the same); the new
// prices, every payout's full amount less what the chargebacks pulled back
const booksFollow = (c, plan) => plan === 1 ? row(c).released_cents === sent(c) && linesOk(c)
  : row(c).released_cents === tsOf(c).reduce((a, t) => a + grossT(t), 0) - STRIPE.reversals.filter(r => r.metadata && r.metadata.contract_id === c.id && /^dp_/.test(r.metadata.reason || "")).reduce((a, r) => a + r.amount, 0);
// money went out twice: 100.00 paid in, part 1's 90.00 paid out with its answer lost, then 50.00 refunded in the dashboard
async function twiceP(mkX) {
  ready(true);
  const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent, ch = chargeOf(pi);
  row(c).status = "funded"; const [m1] = ms(c, [9000, 1000]); lostTransfer(); await approve(c, m1.id); FAULT.pred = null; later(5);
  const r1 = dashRefund(pi, 5000); await webhook(refundedEvent(pi));
  return { c, pi, ch, r1, d: "dp_" + ch.id };
}

// ---------- R1 decided for Cuvori: paid back in full right away, Cuvori's own money said ----------
for (const [name, mkX, plan] of PLANS) for (const size of ["10.00", "the rest"]) {
  await guard(`R1 [${name}] ${size}`, async () => {
    const { c, ch, d, r1 } = await twiceP(mkX);
    const amt = size === "10.00" ? 1000 : ch.amount - ch.amount_refunded;
    const w1 = await stripeSends(c, ch, "needs_response", amt); await hours(1);
    const w2 = await stripeSends(c, ch, "won", amt);
    const pulled = pulledAt(c, d), rp0 = repaidOf(c, d), said = covers(c);
    // what Cuvori covers: what the Order no longer had of it (paid in, less given back, less what the freelancer had then)
    const cover = size === "10.00" ? pulled : 4000;
    const saidOk = said.length === 1 && said[0].includes(d) && said[0].includes(eur(cover)) && said[0].includes(eur(pulled));
    // the bank's notice again, a month of hourly runs: nothing paid twice
    const w3 = []; for (let i = 0; i < 2; i++) { later(30); w3.push((await dispute(c, ch, "won", { amount: amt })).status); }
    await hours(3); later(30 * DAY); STRIPE.idem.clear(); await hours(3);
    const rp1 = repaidOf(c, d), n1 = repays(c, d).length;
    // the money comes back to the Order (the dashboard refund fails): nothing more is paid; then the freelancer cancels the
    // rest of the Order: the payout is counted first, the client gets back what is really left (part 2's 10.00), and the
    // books follow Stripe
    const wf = await webhook(refundFails(r1)); await hours(3);
    const rp2 = repaidOf(c, d);
    notDisputed(c); const back0 = back(c); const k = await cancel(c); await hours(1);
    const gave = back(c) - back0, books = booksFollow(c, plan);
    vuln(last(w1) !== 200 || last(w2) !== 200 || w3.some(s => s !== 200) || row(c).chargeback_status !== "won" || !(pulled > 0) || rp0 !== pulled || !saidOk || pending(c) || rp1 !== pulled || n1 !== 1 || rp2 !== pulled || k.status !== 200 || gave !== 1000 || !books || repaidOf(c, d) !== pulled || /not paid back/.test(String(row(c).money_error)),
      `R1 [${name}] money went out twice (part 1's 90.00 paid out, the answer lost; 50.00 refunded in the dashboard); the bank charges back ${size} (${w1.join("/")}), won (${w2.join("/")}): pulled back ${pulled}, paid back right away ${rp0}; said ${said.length ? '"' + said[0].slice(0, 200) + '"' : "nothing"}; notices again (${w3.join("/")}) and a month of hourly runs: paid back ${rp1} in ${n1} payout(s); the dashboard refund fails (${wf.status}): paid back ${rp2}; the freelancer cancels -> ${k.status}${k.status === 200 ? "" : ` "${String((k.json && k.json.error) || "").slice(0, 120)}"`}, the client gets back ${gave}, the books ${books ? "follow Stripe" : "DON'T follow Stripe"}; ${show(c)} (must be: all of it paid back at once and once, Cuvori's ${eur(cover)} said, nothing waiting; the cancel gives back 1000)`);
  });
}

// ---------- R2 a later chargeback on a top-up for a part never paid out: nothing pulled back from the freelancer ----------
for (const [name, mkX, plan] of PLANS) for (const outcome of ["won", "lost"]) {
  await guard(`R2 [${name}] ${outcome}`, async () => {
    const { c, ch, d } = await twiceP(mkX);
    const a1 = await stripeSends(c, ch, "needs_response", 1000); await hours(1); const a2 = await stripeSends(c, ch, "won", 1000); await hours(1);
    const repaidA = repaidOf(c, d), pulledA = pulledAt(c, d);
    // a top-up for a new part 3 (not handed in yet), then the client's bank charges the top-up back too
    notDisputed(c); const [m3] = ms(c, [3000]); m3.position = 3; m3.status = "pending";
    const t = await topUp(c, 3000); const pi2 = t.session.payment_intent, ch2 = chargeOf(pi2), B = "dp_" + ch2.id;
    const has0 = sent(c);
    const b1 = await stripeSends(c, ch2, "needs_response", 3000); await hours(2);
    const pulledB1 = pulledAt(c, B);
    const b2 = await stripeSends(c, ch2, outcome, 3000); await hours(3);
    vuln(last(a1) !== 200 || last(a2) !== 200 || repaidA !== pulledA || last(b1) !== 200 || last(b2) !== 200 || pulledB1 !== 0 || pulledAt(c, B) !== 0 || sent(c) !== has0 || /not paid back/.test(String(row(c).money_error)) || pending(c),
      `R2 [${name}] ${outcome}: money went out twice; the first chargeback (10.00) won (${a1.join("/")}, ${a2.join("/")}): pulled back ${pulledA}, paid back ${repaidA}; a top-up of 30.00 for part 3 (never paid out), charged back too (${b1.join("/")}): pulled back from the freelancer ${pulledB1}; ${outcome} (${b2.join("/")}): pulled back ${pulledAt(c, B)}; the freelancer has ${has0} -> ${sent(c)}; ${show(c)} (must be: the first paid back in full, nothing pulled back for the second, the freelancer keeps what they had)`);
  });
}

// (R2b: the top-up came in before the first chargeback, whose re-payment was made after it: a re-payment is no pay for the
// work, so the top-up's chargeback still takes nothing from the freelancer)
for (const [name, mkX, plan] of PLANS) {
  await guard(`R2b [${name}]`, async () => {
    const { c, ch, d } = await twiceP(mkX);
    notDisputed(c); const [m3] = ms(c, [3000]); m3.position = 3; m3.status = "pending";
    const t = await topUp(c, 3000); const pi2 = t.session.payment_intent, ch2 = chargeOf(pi2), B = "dp_" + ch2.id; later(5);
    const a1 = await stripeSends(c, ch, "needs_response", 1000); await hours(1); const a2 = await stripeSends(c, ch, "won", 1000); await hours(1);
    const repaidA = repaidOf(c, d), has0 = sent(c);
    const b1 = await stripeSends(c, ch2, "needs_response", 3000); await hours(1); const b2 = await stripeSends(c, ch2, "lost", 3000); await hours(1);
    vuln(t.webhook.status !== 200 || last(a1) !== 200 || last(a2) !== 200 || !(repaidA > 0) || repaidA !== pulledAt(c, d) || last(b1) !== 200 || last(b2) !== 200 || pulledAt(c, B) !== 0 || sent(c) !== has0,
      `R2b [${name}] money went out twice; a top-up of 30.00 for part 3 (never paid out, ${t.webhook.status}); the first payment's 10.00 charged back, won (${a1.join("/")}, ${a2.join("/")}): paid back ${repaidA} after the top-up; the top-up charged back, lost (${b1.join("/")}, ${b2.join("/")}): pulled back ${pulledAt(c, B)}; the freelancer has ${has0} -> ${sent(c)} (must be: nothing pulled back for the top-up)`);
  });
}

// ---------- R4 unchanged ----------
// an Order that holds money: the chargeback pulls back what the payment paid out, decided for Cuvori, paid back in full, no note
for (const [name, mkX, plan] of PLANS) {
  await guard(`R4a [${name}]`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent, ch = chargeOf(pi);
    row(c).status = "funded"; const [m1] = ms(c, [9000, 1000]); await approve(c, m1.id); later(5);
    const d = "dp_" + ch.id, amt = ch.amount;
    const w1 = await stripeSends(c, ch, "needs_response", amt); const p1 = pulledAt(c, d);
    const w2 = await stripeSends(c, ch, "won", amt); await hours(2);
    const want = plan === 1 ? 9000 : 8550;
    vuln(last(w1) !== 200 || last(w2) !== 200 || p1 !== want || repaidOf(c, d) !== want || covers(c).length || pending(c) || !booksFollow(c, plan),
      `R4a [${name}] part 1's 90.00 paid out; the whole payment charged back (${w1.join("/")}): pulled back ${p1}; won (${w2.join("/")}): paid back ${repaidOf(c, d)}; notes ${JSON.stringify(notes(c).map(n => n.slice(0, 60)))}; ${show(c)} (must be: ${want} pulled back and paid back, no note, the books following Stripe)`);
  });
}
// a top-up whose part was paid out after it came in: its chargeback pulls back as before
for (const [name, mkX, plan] of PLANS) {
  await guard(`R4b [${name}]`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c);
    row(c).status = "funded"; const [m1, m2] = ms(c, [9000, 1000]); await approve(c, m1.id); later(5);
    const [m3] = ms(c, [3000]); m3.position = 3;
    const t = await topUp(c, 3000); const pi2 = t.session.payment_intent, ch2 = chargeOf(pi2), B = "dp_" + ch2.id; later(5);
    const a3 = await approve(c, m3.id); later(5);
    const w1 = await stripeSends(c, ch2, "needs_response", ch2.amount);
    // (the Order held 10.00 for part 2: of the top-up, 20.00 was paid out to the freelancer; the new prices less the 5%)
    const want = plan === 1 ? 2000 : 1900;
    vuln(t.webhook.status !== 200 || a3.status !== 200 || last(w1) !== 200 || pulledAt(c, B) !== want,
      `R4b [${name}] part 1's 90.00 paid out; a top-up of 30.00 (${t.webhook.status}) and part 3's 30.00 paid out after it (${a3.status}); the top-up charged back (${w1.join("/")}): pulled back ${pulledAt(c, B)} (must be: ${want}, as before)`);
  });
}
// a pull-back made by hand in the Stripe dashboard is never paid back by Cuvori
for (const [name, mkX, plan] of PLANS) {
  await guard(`R4c [${name}]`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent, ch = chargeOf(pi);
    row(c).status = "funded"; const [m1] = ms(c, [6000, 4000]);
    lostTransfer(); await approve(c, m1.id); FAULT.pred = null; later(5);
    const tr = tsOf(c).find(x => (x.metadata.purpose || "release") === "release");
    const pb = await fetch(`https://api.stripe.com/v1/transfers/${tr.id}/reversals`, { method: "POST", headers: { Authorization: "Bearer " + process.env.STRIPE_SECRET_KEY, "content-type": "application/x-www-form-urlencoded" }, body: "amount=2000" });
    dashRefund(pi, 5000); await webhook(refundedEvent(pi));
    const amt = ch.amount - ch.amount_refunded, d = "dp_" + ch.id;
    const w1 = await stripeSends(c, ch, "needs_response", amt); await hours(1);
    const w2 = await stripeSends(c, ch, "won", amt); await hours(3);
    const rp = repaidOf(c, d);
    // then (today's prices) the freelancer cancels the rest: nothing is kept back for the 20.00 taken by hand, nothing stays
    // held. (The new prices leave a pull-back made by hand out of the books, Part 20: such an Order waits for a person.)
    notDisputed(c); const k = plan === 1 ? await cancel(c) : { status: 200 }; await hours(2);
    vuln(pb.status !== 200 || last(w1) !== 200 || last(w2) !== 200 || rp !== pulledAt(c, d) || k.status !== 200 || (plan === 1 && held(c) !== 0) || repaidOf(c, d) !== rp,
      `R4c [${name}] part 1 paid out (the answer lost); 20.00 pulled back by hand in the Stripe dashboard (${pb.status}); 50.00 refunded in the dashboard; the rest charged back, won (${w1.join("/")}, ${w2.join("/")}): the chargeback pulled back ${pulledAt(c, d)}, paid back ${rp}; the freelancer cancels -> ${k.status}${k.status === 200 ? "" : ` "${String((k.json && k.json.error) || "").slice(0, 120)}"`}: ${show(c)} (must be: exactly what the chargeback pulled back, never the 20.00 taken by hand; nothing kept back for it)`);
  });
}
// the freelancer's Stripe account not ready when the bank decides: the hourly run pays it all once it is
for (const [name, mkX, plan] of PLANS) {
  await guard(`R4d [${name}]`, async () => {
    const { c, ch, d } = await twiceP(mkX);
    const w1 = await stripeSends(c, ch, "needs_response", 1000); await hours(1);
    ready(false); const w2 = await stripeSends(c, ch, "won", 1000); await hours(1);
    const rp0 = repaidOf(c, d), wait0 = pending(c), said = covers(c).length;
    ready(true); await hours(3);
    vuln(last(w1) !== 200 || last(w2) !== 200 || rp0 !== 0 || !wait0 || said !== 1 || repaidOf(c, d) !== pulledAt(c, d) || repays(c, d).length !== 1 || pending(c),
      `R4d [${name}] money went out twice; 10.00 charged back (${w1.join("/")}), won while the freelancer's account can't take money (${w2.join("/")}): paid back ${rp0}, waiting ${wait0}, Cuvori's note ${said}; the account ready, hourly runs: paid back ${repaidOf(c, d)} of ${pulledAt(c, d)} in ${repays(c, d).length} payout(s), waiting ${pending(c)} (must be: nothing paid while it can't be, then all of it once)`);
  });
}
// the note saying what Cuvori pays can't be saved: nothing is paid, Stripe sends the notice again, then it is paid once
for (const [name, mkX, plan] of PLANS) {
  await guard(`R4e [${name}]`, async () => {
    const { c, ch, d } = await twiceP(mkX);
    const w1 = await stripeSends(c, ch, "needs_response", 1000); await hours(1);
    let block = true, hit = 0;
    hooks.db = async (method, table, search, body) => (block && method === "PATCH" && table === "contracts" && String(body).includes(COVER_HEAD)) ? (hit++, dbError()) : null;
    const first = await dispute(c, ch, "won", { amount: 1000 }); const rp0 = repaidOf(c, d);
    block = false; hooks.db = null; later(60);
    const w2 = await stripeSends(c, ch, "won", 1000); await hours(1);
    vuln(!hit || first.status === 200 || rp0 !== 0 || last(w2) !== 200 || repaidOf(c, d) !== pulledAt(c, d) || repays(c, d).length !== 1 || covers(c).length !== 1,
      `R4e [${name}] money went out twice; 10.00 charged back (${w1.join("/")}); won while the note can't be saved (${hit ? "hit" : "NOT HIT"}): the notice -> ${first.status}, paid back ${rp0}; sent again -> ${w2.join("/")}: paid back ${repaidOf(c, d)} of ${pulledAt(c, d)} in ${repays(c, d).length} payout(s), the note ${covers(c).length} (must be: nothing paid while the note can't be saved, then paid once with its note)`);
  });
}

// the database refuses the re-payment's count for good (imitated: the books can't take it), after Stripe made it: the notice
// is answered, the Order says what can't be counted, the re-payment gets no line without its total; once the books can take
// it, the freelancer's cancel counts it first, once, and the books follow Stripe
for (const [name, mkX, plan] of PLANS) {
  await guard(`R4f [${name}]`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent, ch = chargeOf(pi);
    row(c).status = "funded"; const [m1] = ms(c, [9000, 1000]); await approve(c, m1.id); later(5);
    const d = "dp_" + ch.id, amt = ch.amount;
    const w1 = await stripeSends(c, ch, "needs_response", amt);
    let hit = 0;
    hooks.db = async (method, table, search, body) => (method === "PATCH" && table === "contracts" && /"released_cents"/.test(String(body)) && !/chargeback_status/.test(String(body)))
      ? (hit++, new Response(JSON.stringify({ code: "23514", message: 'new row for relation "contracts" violates check constraint "contracts_money_sane"' }), { status: 400, headers: { "content-type": "application/json" } })) : null;
    const w2 = await stripeSends(c, ch, "won", amt); hooks.db = null;
    const rp = repaidOf(c, d), told = unNote(c), lined = lines(c, "release").filter(l => repays(c, d).some(t => t.id === l.provider_ref)).length;
    later(60); notDisputed(c); const k = await cancel(c); await hours(1);
    const lined2 = lines(c, "release").filter(l => repays(c, d).some(t => t.id === l.provider_ref)).length, books = booksFollow(c, plan);
    vuln(!hit || last(w1) !== 200 || last(w2) !== 200 || rp !== pulledAt(c, d) || !(rp > 0) || told !== 1 || lined || pending(c) || k.status !== 200 || lined2 !== 1 || !books || repays(c, d).length !== 1,
      `R4f [${name}] part 1's 90.00 paid out; the whole payment charged back (${w1.join("/")}); won while the database refuses the re-payment's count (${hit ? "hit" : "NOT HIT"}; ${w2.join("/")}): paid back ${rp} of ${pulledAt(c, d)}, "payouts not in the books" ${told}, its line ${lined}, waiting ${pending(c)}; then the freelancer's cancel -> ${k.status}: its line ${lined2}, the books ${books ? "follow Stripe" : "DON'T follow Stripe"}; ${show(c)} (must be: answered, paid back once, said, no line without its total; counted once by the cancel)`);
  });
}

// ---------- R5 decided for the client, the pull-back refused every time: what Cuvori lost is said ----------
const COULD_NOT = /^chargeback lost; ([0-9]+\.[0-9]{2}) could not be pulled back from the freelancer/;
const couldNot = (c) => notes(c).map(n => (COULD_NOT.exec(n) || [])[1]).filter(Boolean);
for (const [name, mkX, plan] of PLANS) for (const size of ["10.00", "the rest"]) {
  await guard(`R5a [${name}] ${size}`, async () => {
    const { c, ch, d } = await twiceP(mkX);
    const amt = size === "10.00" ? 1000 : ch.amount - ch.amount_refunded, principal = size === "10.00" ? 1000 : 5000;
    const has0 = sent(c);
    hooks.stripe = noFunds;
    const w1 = await stripeSends(c, ch, "needs_response", amt); await hours(2);
    const w2 = await stripeSends(c, ch, "lost", amt); await hours(1);
    hooks.stripe = null;
    // what the pull-back should have taken: the part of the payment paid out to the freelancer (the new prices: less the 5%)
    const want = eur(plan === 1 ? principal : principal - Math.round(principal * 0.05)).replace(" EUR", "");
    const said = couldNot(c);
    vuln(last(w1) !== 200 || last(w2) !== 200 || row(c).chargeback_status !== "lost" || pulledAt(c, d) !== 0 || sent(c) !== has0 || said.length !== 1 || said[0] !== want || unNote(c) !== 1 || cbNote(c),
      `R5a [${name}] money went out twice (part 1's 90.00 paid out, the answer lost; 50.00 refunded in the dashboard); the bank charges back ${size}, the pull-back refused every time (${w1.join("/")}); lost (${w2.join("/")}): pulled back ${pulledAt(c, d)}, the freelancer has ${has0} -> ${sent(c)}; said ${said.length ? said.join(", ") + " could not be pulled back" : "NOTHING"}; notes ${JSON.stringify(notes(c).map(n => n.slice(0, 70)))} (must be: ${want} could not be pulled back, said; the books' note stays)`);
  });
}
// the same where the books know the payout (its answer kept; the refund made in the dashboard counted only as far as the
// Order held it), and on an Order that held money: said as before
for (const [name, mkX, plan] of PLANS) for (const kind of ["dashboard refund", "whole payment"]) {
  await guard(`R5b [${name}] ${kind}`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent, ch = chargeOf(pi);
    row(c).status = "funded"; const [m1] = ms(c, [9000, 1000]); await approve(c, m1.id); later(5);
    if (kind === "dashboard refund") { dashRefund(pi, 5000); await webhook(refundedEvent(pi)); }
    const amt = kind === "dashboard refund" ? 1000 : ch.amount, principal = kind === "dashboard refund" ? 1000 : 9000;
    hooks.stripe = noFunds;
    const w1 = await stripeSends(c, ch, "needs_response", amt); await hours(1);
    const w2 = await stripeSends(c, ch, "lost", amt); await hours(1);
    hooks.stripe = null;
    const want = eur(plan === 1 ? principal : principal - Math.round(principal * 0.05)).replace(" EUR", "");
    const said = couldNot(c);
    vuln(last(w1) !== 200 || last(w2) !== 200 || row(c).chargeback_status !== "lost" || said.length !== 1 || said[0] !== want || cbNote(c),
      `R5b [${name}] part 1's 90.00 paid out (counted)${kind === "dashboard refund" ? "; 50.00 refunded in the dashboard" : ""}; the bank charges back ${amt / 100}, the pull-back refused (${w1.join("/")}); lost (${w2.join("/")}): said ${said.length ? said.join(", ") : "NOTHING"} (must be: ${want} could not be pulled back, as before)`);
  });
}

// only part of the pull-back went through (part 2's payout; part 1's refused): what was not pulled back is said, not all of it
for (const [name, mkX, plan] of PLANS) for (const when of ["at once", "at the decision"]) {
  await guard(`R5c [${name}] ${when}`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent, ch = chargeOf(pi);
    row(c).status = "funded"; const [m1, m2] = ms(c, [5000, 1000, 4000]);
    lostTransfer(); await approve(c, m1.id); FAULT.pred = null; later(2);
    lostTransfer(); await approve(c, m2.id); FAULT.pred = null; later(2);
    const t1 = STRIPE.transfers.find(t => t.metadata.milestone_id === m1.id), d = "dp_" + ch.id;
    dashRefund(pi, 6000); await webhook(refundedEvent(pi));
    // (each variant: part 2's pull-back goes through when the chargeback opens, or only at the bank's decision, everything
    // having been refused until then)
    const refuse = (all) => async (path, method) => (method === "POST" && (all ? /\/reversals$/.test(path) : path === `/transfers/${t1.id}/reversals`)) ? [400, { error: { type: "invalid_request_error", code: "insufficient_funds", message: "Insufficient funds in the connected account to reverse this transfer." } }] : null;
    hooks.stripe = refuse(when === "at the decision");
    const w1 = await stripeSends(c, ch, "needs_response", 4000); await hours(1);
    hooks.stripe = refuse(false);
    const w2 = await stripeSends(c, ch, "lost", 4000); await hours(1);
    hooks.stripe = null;
    // 40.00 of the payment paid out to the freelancer (the new prices: 38.00, less the 5%); part 2's payout gave back what it had
    const pulled = pulledAt(c, d), want = eur((plan === 1 ? 4000 : 3800) - pulled).replace(" EUR", ""), said = couldNot(c);
    vuln(last(w1) !== 200 || last(w2) !== 200 || row(c).chargeback_status !== "lost" || !(pulled > 0) || said.length !== 1 || said[0] !== want,
      `R5c [${name}] parts 50.00 + 10.00 paid out (answers lost), 60.00 refunded in the dashboard; 40.00 charged back, only part 2's payout can be pulled back, ${when} (${w1.join("/")}); lost (${w2.join("/")}): pulled back ${pulled}; said ${said.length ? said.join(", ") : "NOTHING"} (must be: ${want} could not be pulled back)`);
  });
}

// ---------- R6 the freelancer gave back all of it, the Order no longer had the money: never "could not be pulled back" ----------
const COVERED = /^chargeback lost; Cuvori covered ([0-9]+\.[0-9]{2}) of what the bank took: the Order no longer had it \(money went out twice\?\), and the freelancer gave back all they had to/;
for (const [name, mkX, plan] of PLANS) {
  await guard(`R6 [${name}]`, async () => {
    const { c, ch, d, pi } = await twiceP(mkX);
    const amt = ch.amount - ch.amount_refunded;
    const w1 = await stripeSends(c, ch, "needs_response", amt); await hours(1);
    const w2 = await stripeSends(c, ch, "lost", amt); await hours(1);
    // what Cuvori is short: 100.00 paid in; out to the freelancer what they still have, 50.00 to the client in the dashboard,
    // and the 50.00 the bank took
    const short = sent(c) + 5000 + 5000 - 10000, want = eur(short).replace(" EUR", "");
    const covered = notes(c).map(n => (COVERED.exec(n) || [])[1]).filter(Boolean), not = couldNot(c);
    vuln(last(w1) !== 200 || last(w2) !== 200 || row(c).chargeback_status !== "lost" || pulledAt(c, d) !== (plan === 1 ? 5000 : 4750) || covered.length !== 1 || covered[0] !== want || not.length,
      `R6 [${name}] money went out twice; the other 50.00 charged back, pulled back from the freelancer (${w1.join("/")}): ${pulledAt(c, d)}; lost (${w2.join("/")}): said ${covered.length ? "Cuvori covered " + covered.join(", ") : "nothing of that"}${not.length ? `, and "${not.join(", ")} could not be pulled back"` : ""}; ${show(c)} (must be: Cuvori covered ${want}, the Order no longer having it; never "could not be pulled back")`);
  });
}

// ---------- fifth part ----------
// R3 a second chargeback (on a top-up) comes while the first one's re-payment waits (the freelancer's account not ready)
for (const [name, mkX, plan] of PLANS) {
  await guard(`R3 [${name}]`, async () => {
    const { c, ch, d } = await twiceP(mkX);
    notDisputed(c); const [m3] = ms(c, [3000]); m3.position = 3; m3.status = "pending";
    const t = await topUp(c, 3000); const ch2 = chargeOf(t.session.payment_intent), B = "dp_" + ch2.id; later(5);
    const a1 = await stripeSends(c, ch, "needs_response", 1000); await hours(1);
    ready(false); const a2 = await stripeSends(c, ch, "won", 1000); later(30);
    const waiting = pending(c), rp0 = repaidOf(c, d);
    const b1 = await stripeSends(c, ch2, "needs_response", 3000);
    const second0 = row(c).chargeback_id === B ? "recorded" : notes(c).some(n => OTHER_CB.test(n) && n.includes(B)) ? "noted" : "nothing";
    ready(true); await hours(3);
    const rp1 = repaidOf(c, d), sec1 = row(c).chargeback_id === B ? row(c).chargeback_status : "not taken over";
    const b2 = await stripeSends(c, ch2, "lost", 3000); await hours(2);
    const covered = notes(c).map(n => (COVERED.exec(n) || [])[1]).filter(Boolean);
    vuln(t.webhook.status !== 200 || last(a1) !== 200 || last(a2) !== 200 || !waiting || rp0 !== 0 || last(b1) !== 200 || second0 !== "noted" || !(rp1 > 0) || rp1 !== pulledAt(c, d) || repays(c, d).length !== 1
      || sec1 !== "open" || last(b2) !== 200 || row(c).chargeback_status !== "lost" || pulledAt(c, B) !== 0 || pending(c) || notes(c).some(n => OTHER_CB.test(n)) || covered.length !== 1 || covered[0] !== "30.00",
      `R3 [${name}] money went out twice; a top-up of 30.00 for part 3 (never paid out); the first payment's 10.00 charged back (${a1.join("/")}), pulled back ${pulledAt(c, d)}, won while the freelancer's account can't take money (${a2.join("/")}): waiting ${waiting}, paid back ${rp0}; the top-up charged back (${b1.join("/")}): ${second0}; the account ready, hourly runs: paid back ${rp1} in ${repays(c, d).length} payout(s), the second chargeback ${sec1}; lost (${b2.join("/")}): pulled back for it ${pulledAt(c, B)}, said ${covered.length ? "Cuvori covered " + covered.join(", ") : "nothing of it"}; notes ${JSON.stringify(notes(c).map(n => n.slice(0, 50)))} (must be: noted while it waits, then paid back in full, the second taken over, nothing pulled back for it, Cuvori covered 30.00 said, nothing left waiting)`);
  });
}
// R7 a chargeback on a top-up for a part never paid out, decided for the client, on an Order where money went out twice
for (const [name, mkX, plan] of PLANS) for (const first of [true, false]) {
  await guard(`R7 [${name}]${first ? " after a won chargeback" : ""}`, async () => {
    const { c, ch, d } = await twiceP(mkX);
    let a = [];
    if (first) { a = await stripeSends(c, ch, "needs_response", 1000); await hours(1); a = [...a, ...await stripeSends(c, ch, "won", 1000)]; await hours(1); }
    notDisputed(c); const [m3] = ms(c, [3000]); m3.position = 3; m3.status = "pending";
    const t = await topUp(c, 3000); const ch2 = chargeOf(t.session.payment_intent), B = "dp_" + ch2.id;
    const has0 = sent(c);
    const b1 = await stripeSends(c, ch2, "needs_response", 3000); await hours(2);
    const b2 = await stripeSends(c, ch2, "lost", 3000); await hours(2);
    const covered = notes(c).map(n => (COVERED.exec(n) || [])[1]).filter(Boolean);
    vuln(t.webhook.status !== 200 || (first && last(a) !== 200) || last(b1) !== 200 || last(b2) !== 200 || row(c).chargeback_status !== "lost" || pulledAt(c, B) !== 0 || sent(c) !== has0 || covered.length !== 1 || covered[0] !== "30.00" || couldNot(c).length,
      `R7 [${name}] money went out twice${first ? `; a 10.00 chargeback won before (${a.join("/")})` : ""}; a top-up of 30.00 for part 3 (never paid out), charged back (${b1.join("/")}), lost (${b2.join("/")}): pulled back ${pulledAt(c, B)}; said ${covered.length ? "Cuvori covered " + covered.join(", ") : "nothing of what Cuvori lost"}; ${show(c)} (must be: nothing pulled back, "Cuvori covered 30.00 of what the bank took" said once)`);
  });
}
// (unchanged: an ordinary Order: the top-up's money is still held for its part, the bank takes it from there, nothing said;
// an Order paid out in full whose whole payment is charged back and pulled back in full: nothing said, the 5% Cuvori kept at
// the new prices is Cuvori's own loss, the owner's decision)
for (const [name, mkX, plan] of PLANS) {
  await guard(`R7u [${name}] top-up`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); await fund2(c);
    row(c).status = "funded"; const [m1, m2] = ms(c, [6000, 4000]);
    const a1 = await approve(c, m1.id); later(5);
    const [m3] = ms(c, [3000]); m3.position = 3; m3.status = "pending";
    const t = await topUp(c, 3000); const ch2 = chargeOf(t.session.payment_intent);
    const b1 = await stripeSends(c, ch2, "needs_response", 3000); await hours(1);
    const b2 = await stripeSends(c, ch2, "lost", 3000); await hours(1);
    const lostNotes = notes(c).filter(n => n.startsWith("chargeback lost;"));
    vuln(a1.status !== 200 || t.webhook.status !== 200 || last(b1) !== 200 || last(b2) !== 200 || row(c).chargeback_status !== "lost" || held(c) !== 4000 || row(c).refunded_cents !== 3000 || sent(c) !== freelancerGets(plan, 6000) || lostNotes.length,
      `R7u [${name}] an ordinary Order: part 1's 60.00 paid out (${a1.status}); a top-up of 30.00 for part 3, charged back (${b1.join("/")}), lost (${b2.join("/")}): ${show(c)}; notes ${JSON.stringify(lostNotes.map(n => n.slice(0, 60)))} (must be: held 40.00, nothing said)`);
  });
  await guard(`R7u [${name}] paid out in full`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const ch = chargeOf(f.session.payment_intent), d = "dp_" + ch.id;
    row(c).status = "delivered"; const a1 = await approve(c); later(5);
    const b1 = await stripeSends(c, ch, "needs_response", 10000); await hours(1);
    const b2 = await stripeSends(c, ch, "lost", 10000); await hours(1);
    const lostNotes = notes(c).filter(n => n.startsWith("chargeback lost;"));
    vuln(a1.status !== 200 || last(b1) !== 200 || last(b2) !== 200 || row(c).chargeback_status !== "lost" || pulledAt(c, d) !== freelancerGets(plan, 10000) || lostNotes.length,
      `R7u [${name}] an ordinary Order paid out in full (${a1.status}); the whole payment charged back (${b1.join("/")}), pulled back ${pulledAt(c, d)}; lost (${b2.join("/")}): notes ${JSON.stringify(lostNotes.map(n => n.slice(0, 60)))} (must be: all the freelancer received pulled back, nothing said)`);
  });
}
// R8 the note "re-payment covered by Cuvori" while the re-payment waits (the freelancer banned), and once it is made
for (const [name, mkX, plan] of PLANS) {
  await guard(`R8 [${name}]`, async () => {
    const { c, ch, d } = await twiceP(mkX);
    const w1 = await stripeSends(c, ch, "needs_response", 1000); await hours(1);
    ban(users.ed, true);
    const w2 = await stripeSends(c, ch, "won", 1000); await hours(1);
    const pulled = pulledAt(c, d), rp0 = repaidOf(c, d), said0 = covers(c), want = `Cuvori pays ${eur(pulled)} of the ${eur(pulled)} owed back to the freelancer from its own money`;
    ban(users.ed, false); await hours(2);
    const said1 = covers(c);
    vuln(last(w1) !== 200 || last(w2) !== 200 || !(pulled > 0) || rp0 !== 0 || said0.length !== 1 || / paid back to the freelancer/.test(said0[0]) || !said0[0].includes(want) || repaidOf(c, d) !== pulled || said1.join() !== said0.join(),
      `R8 [${name}] money went out twice; 10.00 charged back (${w1.join("/")}), pulled back ${pulled}; won while the freelancer is banned (${w2.join("/")}): paid back ${rp0}, the note says "${(said0[0] || "").slice(46, 140)}"; the ban lifted, hourly runs: paid back ${repaidOf(c, d)}, the note ${said1.join() === said0.join() ? "the same" : "changed"} (must be: never "paid back" before it is, the amounts said, then paid in full)`);
    ban(users.ed, false);
  });
}
// R9 the first "chargeback opened" notice on such an Order: answered at once, the pull-back made once, the books' total as it is
for (const [name, mkX, plan] of PLANS) {
  await guard(`R9 [${name}]`, async () => {
    const { c, ch, d } = await twiceP(mkX);
    const paidOut0 = row(c).released_cents, parts = () => DB.order_milestones.filter(m => m.order_id === c.id).map(m => m.status).join(","), parts0 = parts();
    const w1 = await dispute(c, ch, "needs_response", { amount: 1000 });
    const p1 = pulledAt(c, d), u1 = unNote(c);
    const again = await resend(c, ch, 1000); await hours(2);
    vuln(w1.status !== 200 || p1 !== freelancerGets(plan, 1000) || u1 !== 1 || again.some(x => x !== 200) || pulledAt(c, d) !== p1 || row(c).released_cents !== paidOut0 || parts() !== parts0 || row(c).chargeback_status !== "open",
      `R9 [${name}] money went out twice; 10.00 charged back: the first notice -> ${w1.status}, pulled back ${p1}, the note "payouts not in the books" ${u1}; sent again (${again.join("/")}), hourly runs: pulled back ${pulledAt(c, d)}, the paid-out total ${row(c).released_cents} (was ${paidOut0}), the parts ${parts()} (were ${parts0}) (must be: 200 the first time, pulled back once, the note there, the total and the parts as they were: the payout the books can't take stays out of them)`);
  });
}

console.error = realError;
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
