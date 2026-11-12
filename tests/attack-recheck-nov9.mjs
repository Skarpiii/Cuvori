// Re-check of 9 November (of 2d756c7 and e5566f4): regression checks for what three fresh reviewers proved.
// Z1 the note "payouts not in the books" went by itself once a cancel's or a decision's count went through, while money
//    had really gone out twice: the decision's own payout (never counted by that count), or a chargeback lost with the
//    pull-back refused (the bank's take is no pull-back). The note now stays until a person marks it as handled.
// Z2 a chargeback decided for Cuvori: what was pulled back from the freelancer is paid again only up to what the Order still
//    has, and when that is less, the "re-payment pending" note went with nothing saying the freelancer was not paid back.
//    The Order now says how much ("freelancer not paid back after chargeback …"), that Cuvori pays it itself once the Order
//    has the money (never by hand: check of 11 November, a person following the note and Cuvori both paid it), only for
//    the chargeback's own pull-backs, and the note goes once it is paid.
// Z3 the note "payouts not in the books" was best effort: when the database did not answer while it was written, there was
//    no note at all (the books showing paid out 0.00 where the freelancer had 100.00). Now a note that can't be saved fails
//    the step: Stripe sends its notice again, the hourly run tries again, a person is asked to try again in a minute.
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
const SHORT_HEAD = "freelancer not paid back after chargeback ";
const shortNotes = (c) => notes(c).filter(n => n.startsWith(SHORT_HEAD));
const eur = (cents) => (cents / 100).toFixed(2) + " EUR";
const notDisputed = (c) => { const x = row(c); if (x.status === "disputed") { x.status = "funded"; x.disputed_at = null; x.dispute_by = null; } };
// the Order's money at Stripe: what went out (payouts net of pull-backs, refunds, a lost chargeback) against what came in
const outAtStripe = (c, pi) => { const ch = chargeOf(pi); const bank = STRIPE.disputes[ch.id] && STRIPE.disputes[ch.id].status === "lost" ? (STRIPE.disputes[ch.id].amount || 0) : 0;
  return tsOf(c).reduce((a, t) => a + t.amount - t.amount_reversed, 0) + okBack(pi) + bank; };

// ---------- Z1 the note never goes by itself ----------
for (const [name, mkX, plan] of PLANS) {
  await guard(`Z1a [${name}]`, async () => {                                 // the decision's own payout
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent, ch = chargeOf(pi);
    row(c).status = "funded"; disputed(c);
    lostTransfer(); const d1 = await resolve(c, "release"); FAULT.pred = null; later(5);
    dashRefund(pi, 5000); await webhook(refundedEvent(pi));
    hooks.stripe = noFunds; const w1 = await stripeSends(c, ch, "needs_response", 5000); hooks.stripe = null; later(5);
    const w2 = await stripeSends(c, ch, "won", 5000); const n1 = unNote(c);
    later(5); const d2 = await resolve(c, "release"); const n2 = unNote(c);
    for (let i = 0; i < 2; i++) { later(60); await hourly(); }
    const n3 = unNote(c);
    vuln(n1 !== 1 || n2 !== 1 || n3 !== 1,
      `Z1a [${name}] decision 'release' (${d1.status}: its payout made, the answer lost); 50.00 refunded in the dashboard; the bank charges back the other 50.00, the pull-back refused (${w1.join("/")}), won (${w2.join("/")}); the note ${n1}; the admin's same decision again -> ${d2.status}: the note ${n2}, after 2 hourly runs ${n3}; ${show(c)}; at Stripe ${outAtStripe(c, pi)} went out of 10000 (must be: the note stays, money went out twice)`);
  });
  await guard(`Z1b [${name}]`, async () => {                                 // a chargeback lost with the pull-back refused
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent, ch = chargeOf(pi);
    row(c).status = "funded"; const [m1, m2] = ms(c, [3000, 3000, 4000]);
    await approve(c, m1.id); later(5);
    lostTransfer(); await approve(c, m2.id); FAULT.pred = null; later(5);
    const r1 = dashRefund(pi, 5000); await webhook(refundedEvent(pi)); notDisputed(c);
    const k1 = await cancel(c); const n1 = unNote(c);
    hooks.stripe = noFunds;
    const w1 = await stripeSends(c, ch, "needs_response", 5000); later(5);
    const w2 = await stripeSends(c, ch, "lost", 5000);
    hooks.stripe = null;
    const wf = await webhook(refundFails(r1)); later(5);
    const d = await resolve(c, "refund", { note: "Cuvori decides this Order after the bank's chargeback." }); const n2 = unNote(c);
    for (let i = 0; i < 2; i++) { later(60); await hourly(); }
    const n3 = unNote(c);
    vuln(n1 !== 1 || n2 !== 1 || n3 !== 1,
      `Z1b [${name}] part 1 paid; part 2's payout made, the answer lost; 50.00 refunded in the dashboard; cancel -> ${k1.status} (note ${n1}); the other 50.00 charged back, the pull-back refused, lost (${w1.join("/")}, ${w2.join("/")}); the dashboard refund then failed (${wf.status}); a decision -> ${d.status}: the note ${n2}, after 2 hourly runs ${n3}; ${show(c)}; at Stripe ${outAtStripe(c, pi)} went out of 10000 (must be: the note stays)`);
  });
}

// ---------- Z2 what the freelancer was not paid back after a won chargeback is said, and follows Stripe ----------
// (today's prices with the small chargeback, part 1's answer lost: its notices failed every time Stripe sent them until the
// check of 11 November, tests/attack-check-nov11.mjs.) The note says how much is not paid back yet and that Cuvori pays it itself
// once the Order has the money: never to pay it by hand (check of 11 November: a person following "decide whether to pay
// it to them by hand", then Cuvori paying it too once the money came back, paid the freelancer twice). Then the refund made
// in the Stripe dashboard fails, its money back at Cuvori: the hourly run pays the rest, once, and the note goes.
for (const [name, mkX, plan] of PLANS) for (const [split, cb] of [[[9000, 1000], 1000], [[6000, 4000], "rest"], [[9000, 1000], "rest"]]) for (const lost of [false, true]) {
  await guard(`Z2 [${name}] ${split} ${cb} ${lost}`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent, ch = chargeOf(pi);
    row(c).status = "funded"; const [m1] = ms(c, split);
    if (lost) lostTransfer(); await approve(c, m1.id); FAULT.pred = null; later(5);
    const r1 = dashRefund(pi, 5000); await webhook(refundedEvent(pi));
    const amt = cb === "rest" ? ch.amount - ch.amount_refunded : cb;
    const w1 = await stripeSends(c, ch, "needs_response", amt);
    later(60); await hourly();
    const w2 = await stripeSends(c, ch, "won", amt);
    for (let i = 0; i < 2; i++) { later(60); await hourly(); }
    const d = "dp_" + ch.id;
    const pulledOf = () => STRIPE.reversals.filter(r => r.metadata && r.metadata.reason === d).reduce((a, r) => a + r.amount, 0);
    const repaidOf = () => tsOf(c).filter(t => t.metadata.purpose === `retransfer_${d}`).reduce((a, t) => a + t.amount, 0);
    const pulled = pulledOf(), repaid1 = repaidOf(), short = Math.max(pulled - repaid1, 0), said = shortNotes(c);
    const pending = notes(c).filter(n => /^chargeback won/.test(n)).length;
    const okSaid = short > 0 ? said.length === 1 && said[0].includes(eur(short)) && said[0].includes(d) && !/pay it to them by hand/i.test(said[0]) : said.length === 0;
    // the money comes back to the Order: the refund made in the Stripe dashboard fails
    const wf = await webhook(refundFails(r1));
    for (let i = 0; i < 3; i++) { later(60); await hourly(); }
    const repaid2 = repaidOf(), left = shortNotes(c).length;
    vuln(w1[w1.length - 1] !== 200 || w2[w2.length - 1] !== 200 || !okSaid || pending || repaid2 !== pulled || left,
      `Z2 [${name}] parts ${split.join("+")}, part 1's answer ${lost ? "lost" : "kept"}; 50.00 refunded in the dashboard; the bank charges back ${amt / 100}, won (${w1.join("/")}, ${w2.join("/")}): pulled back ${pulled}, paid again ${repaid1}, not paid back ${short}; said ${said.length ? '"' + said[0].slice(0, 170) + '"' : "nothing"}; re-payment waiting ${pending}; then the dashboard refund fails (${wf.status}) and the hourly runs: paid again ${repaid2} of ${pulled}, the note ${left ? "STILL THERE" : "gone"}; ${show(c)} (must be: ${short > 0 ? "said with the amount, never to pay by hand" : "nothing said"}; once the money is back, paid again exactly what was pulled back, and the note gone)`);
  });
}

// (Z2b: the note marked as handled while nothing is waiting, the way the admin panel allows: it does not come back by
// itself; once the money is back, Cuvori pays the rest itself with the Order's next step, once, and says nothing more)
for (const [name, mkX, plan, split, cbAmt] of [["plan 2", mk2, 2, [9000, 1000], 1000], ["plan 1", mk1, 1, [6000, 4000], "rest"]]) {
  await guard(`Z2b [${name}]`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent, ch = chargeOf(pi);
    row(c).status = "funded"; const [m1] = ms(c, split);
    lostTransfer(); await approve(c, m1.id); FAULT.pred = null; later(5);
    const r1 = dashRefund(pi, 5000); await webhook(refundedEvent(pi));
    const amt = cbAmt === "rest" ? ch.amount - ch.amount_refunded : cbAmt;
    const w1 = await stripeSends(c, ch, "needs_response", amt);
    const w2 = await stripeSends(c, ch, "won", amt);
    const said1 = shortNotes(c).length, waiting = notes(c).filter(n => /^chargeback won/.test(n)).length;
    row(c).money_error = notes(c).filter(n => !n.startsWith(SHORT_HEAD)).join(" · Also: ") || null;     // "Mark as handled" (that note)
    for (let i = 0; i < 2; i++) { later(60); await hourly(); }
    const back1 = shortNotes(c).length;
    const wf = await webhook(refundFails(r1)); later(5);
    notDisputed(c); const k = await cancel(c);
    for (let i = 0; i < 2; i++) { later(60); await hourly(); }
    const d = "dp_" + ch.id;
    const pulled = STRIPE.reversals.filter(r => r.metadata && r.metadata.reason === d).reduce((a, r) => a + r.amount, 0);
    const repaid = tsOf(c).filter(t => t.metadata.purpose === `retransfer_${d}`).reduce((a, t) => a + t.amount, 0);
    vuln(w1[w1.length - 1] !== 200 || w2[w2.length - 1] !== 200 || said1 !== 1 || waiting || back1 || k.status !== 200 || repaid !== pulled || shortNotes(c).length,
      `Z2b [${name}] parts ${split.join("+")}, part 1's payout made (the answer lost); 50.00 refunded in the dashboard; the bank charges back ${amt / 100}, won (${w1.join("/")}, ${w2.join("/")}): said ${said1}, waiting ${waiting}; marked as handled, 2 hourly runs: back ${back1}; the dashboard refund fails (${wf.status}); the freelancer's cancel -> ${k.status}: paid again ${repaid} of ${pulled}; the note ${shortNotes(c).length ? "BACK" : "not back"}; ${show(c)} (must be: said once, not back after "Mark as handled", paid again once all that was pulled back)`);
  });
}

// (Z2d: the money comes back in two steps (two refunds made in the Stripe dashboard, 45.00 and 5.00, one failing at a time): after each, the
// note says what is still not paid back, or goes; the rest paid by the Order's next decision is a re-payment of its own,
// never taken for the earlier one)
for (const [name, mkX, plan] of PLANS) {
  await guard(`Z2d [${name}]`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent, ch = chargeOf(pi);
    row(c).status = "funded"; const [m1] = ms(c, [6000, 4000]);
    lostTransfer(); await approve(c, m1.id); FAULT.pred = null; later(5);
    const r1 = dashRefund(pi, 4500); await webhook(refundedEvent(pi)); later(1);
    const r2 = dashRefund(pi, 500); await webhook(refundedEvent(pi));
    const amt = ch.amount - ch.amount_refunded;
    const w1 = await stripeSends(c, ch, "needs_response", amt);
    const w2 = await stripeSends(c, ch, "won", amt);
    for (let i = 0; i < 2; i++) { later(60); await hourly(); }
    const d = "dp_" + ch.id;
    const pulledOf = () => STRIPE.reversals.filter(r => r.metadata && r.metadata.reason === d).reduce((a, r) => a + r.amount, 0);
    const repaidOf = () => tsOf(c).filter(t => t.metadata.purpose === `retransfer_${d}`).reduce((a, t) => a + t.amount, 0);
    const follows = () => { const owed = Math.max(pulledOf() - repaidOf(), 0), said = shortNotes(c); return owed > 0 ? said.length === 1 && said[0].includes(eur(owed)) : said.length === 0; };
    const s1 = [repaidOf(), shortNotes(c).map(n => n.slice(42, 80)).join()], ok1 = follows();
    await webhook(refundFails(r2)); for (let i = 0; i < 2; i++) { later(60); await hourly(); }
    const s2 = [repaidOf(), shortNotes(c).map(n => n.slice(42, 80)).join()], ok2 = follows();
    // the rest comes back; "Mark as handled" first, so the Order's next decision (not the hourly run) pays it
    await webhook(refundFails(r1)); row(c).money_error = notes(c).filter(n => !n.startsWith(SHORT_HEAD)).join(" · Also: ") || null;
    if (row(c).status !== "disputed") disputed(c);
    const dd = await resolve(c, "release"); for (let i = 0; i < 2; i++) { later(60); await hourly(); }
    const pays = tsOf(c).filter(t => t.metadata.purpose === `retransfer_${d}`).map(t => t.amount);
    vuln(w1[w1.length - 1] !== 200 || w2[w2.length - 1] !== 200 || !ok1 || !ok2 || dd.status !== 200 || repaidOf() !== pulledOf() || shortNotes(c).length,
      `Z2d [${name}] part 1 (60.00) paid out (the answer lost); 45.00 and 5.00 refunded in the dashboard; the rest charged back, won: pulled back ${pulledOf()}, paid again ${s1[0]}, note "${s1[1]}" (follows ${ok1}); the 5.00 refund fails: paid again ${s2[0]}, note "${s2[1]}" (follows ${ok2}); the 45.00 fails too, the note marked as handled, a decision 'release' -> ${dd.status}: re-payments ${JSON.stringify(pays)}, ${repaidOf()} of ${pulledOf()}; ${show(c)} (must be: the note always the amount still owed, or gone; all of it paid again in the end, each re-payment its own)`);
  });
}

// (Z2c: money pulled back from the freelancer by hand in the Stripe dashboard is no pull-back of the chargeback's: the note
// never counts it as owed (check of 11 November: at today's prices it said 10.00 was not paid back, where Cuvori had paid
// back more than the chargeback took))
for (const [name, mkX, plan] of PLANS) {
  await guard(`Z2c [${name}]`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent, ch = chargeOf(pi);
    row(c).status = "funded"; const [m1] = ms(c, [6000, 4000]);
    lostTransfer(); await approve(c, m1.id); FAULT.pred = null; later(5);                 // (its answer lost: the books don't show it)
    const t = tsOf(c).find(x => (x.metadata.purpose || "release") === "release");
    const pb = await fetch(`https://api.stripe.com/v1/transfers/${t.id}/reversals`, { method: "POST", headers: { Authorization: "Bearer " + process.env.STRIPE_SECRET_KEY, "content-type": "application/x-www-form-urlencoded" }, body: "amount=2000" });
    dashRefund(pi, 5000); await webhook(refundedEvent(pi));
    const amt = ch.amount - ch.amount_refunded;
    const w1 = await stripeSends(c, ch, "needs_response", amt); later(60); await hourly();
    const w2 = await stripeSends(c, ch, "won", amt);
    for (let i = 0; i < 2; i++) { later(60); await hourly(); }
    const d = "dp_" + ch.id;
    const pulled = STRIPE.reversals.filter(r => r.metadata && r.metadata.reason === d).reduce((a, r) => a + r.amount, 0);
    const repaid = tsOf(c).filter(x => x.metadata.purpose === `retransfer_${d}`).reduce((a, x) => a + x.amount, 0);
    const said = shortNotes(c);
    const owedNow = Math.max(pulled - repaid, 0);
    const ok = owedNow > 0 ? said.length === 1 && said[0].includes(eur(owedNow)) : said.length === 0;
    vuln(pb.status !== 200 || w1[w1.length - 1] !== 200 || w2[w2.length - 1] !== 200 || !ok,
      `Z2c [${name}] part 1 paid out (the answer lost); 20.00 pulled back from the freelancer by hand in the Stripe dashboard (${pb.status}); 50.00 refunded in the dashboard; the rest charged back, won (${w1.join("/")}, ${w2.join("/")}): the chargeback pulled back ${pulled}, paid again ${repaid}; said ${said.length ? '"' + said[0].slice(0, 110) + '"' : "nothing"} (must be: only what the chargeback itself pulled back and was not paid again)`);
  });
}

// ---------- Z3 a note that can't be saved fails the step ----------
const timeoutResp = () => new Response(JSON.stringify({ message: "canceling statement due to statement timeout" }), { status: 500, headers: { "content-type": "application/json" } });
// one read of the Order fails right after the database refuses a count of it (the read that writes the note)
const blipAfterRefusal = (c) => { let armed = false; const st = { hit: 0 };
  hooks.db = async (method, table, search, body) => {
    if (!st.hit && method === "PATCH" && table === "contracts" && String(search).includes(c.id) && /"released_cents"/.test(String(body))) {
      const x = row(c), b = JSON.parse(body); if (b.released_cents + x.refunded_cents > x.funded_cents) armed = true; return null;
    }
    if (armed && method === "GET" && table === "contracts" && String(search).includes(c.id)) { armed = false; st.hit++; return timeoutResp(); }
    return null;
  };
  return st; };
for (const [name, mkX, plan] of PLANS) {
  await guard(`Z3a [${name}]`, async () => {                                 // the hourly run's re-payment
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent, ch = chargeOf(pi);
    row(c).status = "delivered"; await approve(c); later(5);
    await stripeSends(c, ch, "needs_response", 10000);
    ready(false); await stripeSends(c, ch, "won", 10000);
    ready(true); lostTransfer(); later(60); await hourly(); FAULT.pred = null;
    dashRefund(pi, 5000); await webhook(refundedEvent(pi));
    const st = blipAfterRefusal(c);
    later(60); await hourly(); hooks.db = null;
    const n1 = unNote(c), waiting = notes(c).filter(n => /^chargeback won/.test(n)).length;
    for (let i = 0; i < 2; i++) { later(60); await hourly(); }
    vuln(st.hit !== 1 || (n1 === 0 && !waiting) || unNote(c) !== 1,
      `Z3a [${name}] the whole Order charged back, won while the freelancer's account couldn't take money; the hourly run pays it again (the answer lost); 50.00 refunded in the dashboard; the next hourly run's count refused and the note's read fails (${st.hit}): right after, the note ${n1}, re-payment still waiting ${waiting}; after 2 more runs the note ${unNote(c)}; ${show(c)} (must be: the run fails, the next one writes the note)`);
  });
  await guard(`Z3b [${name}]`, async () => {                                 // a chargeback's first count
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent, ch = chargeOf(pi);
    row(c).status = "funded"; const [m1] = ms(c, [6000, 4000]);
    lostTransfer(); await approve(c, m1.id); FAULT.pred = null; later(5);
    dashRefund(pi, 5000); await webhook(refundedEvent(pi));
    const st = blipAfterRefusal(c);
    const w = await stripeSends(c, ch, "needs_response", 5000); hooks.db = null;
    vuln(st.hit !== 1 || w.join("/") !== "500/200" || unNote(c) !== 1,
      `Z3b [${name}] part 1's payout made (the answer lost), 50.00 refunded in the dashboard; the bank charges back the other 50.00: the first count refused and the note's read fails (${st.hit}): notices ${w.join("/")}; the note ${unNote(c)}; ${show(c)} (must be: 500, then 200 with the note when Stripe sends it again)`);
  });
  await guard(`Z3c [${name}]`, async () => {                                 // a cancel's first count
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent;
    row(c).status = "funded"; const [m1] = ms(c, [6000, 4000]);
    lostTransfer(); await approve(c, m1.id); FAULT.pred = null; later(5);
    dashRefund(pi, 5000); await webhook(refundedEvent(pi)); notDisputed(c);
    const st = blipAfterRefusal(c);
    const k1 = await cancel(c); hooks.db = null; const n1 = unNote(c);
    later(2); notDisputed(c); const k2 = await cancel(c);
    vuln(st.hit !== 1 || k1.status !== 503 || (k1.json && k1.json.code) !== "provider_down" || n1 !== 0 || k2.status !== 409 || (k2.json && k2.json.code) !== "under_review" || unNote(c) !== 1,
      `Z3c [${name}] part 1's payout made (the answer lost), 50.00 refunded in the dashboard; the freelancer's cancel: the count refused and the note's read fails (${st.hit}) -> ${k1.status} ${(k1.json && k1.json.code) || ""} (note ${n1}); again -> ${k2.status} ${(k2.json && k2.json.code) || ""} (note ${unNote(c)}) (must be: "try again in a minute" while the note isn't there, then "under review" with it)`);
  });
}

// (Z3d: the note saying what the freelancer was not paid back, when the database does not answer while it is written: the
// bank's "won" notice fails and the re-payment stays waiting; Stripe sends it again and the note is written)
for (const [name, mkX, plan, split, cbAmt] of [["plan 2", mk2, 2, [9000, 1000], 1000], ["plan 1", mk1, 1, [6000, 4000], "rest"]]) {
  await guard(`Z3d [${name}]`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent, ch = chargeOf(pi);
    row(c).status = "funded"; const [m1] = ms(c, split);
    lostTransfer(); await approve(c, m1.id); FAULT.pred = null; later(5);
    dashRefund(pi, 5000); await webhook(refundedEvent(pi));
    const amt = cbAmt === "rest" ? ch.amount - ch.amount_refunded : cbAmt;
    const w1 = await stripeSends(c, ch, "needs_response", amt);
    // every write of that note fails while the first "won" notice is handled
    const st = { hit: 0 };
    hooks.db = async (method, table, search, body) => {
      if (method === "PATCH" && table === "contracts" && String(search).includes(c.id) && String(body).includes(SHORT_HEAD)) { st.hit++; return timeoutResp(); }
      return null;
    };
    const first = await dispute(c, ch, "won", { amount: amt }); hooks.db = null;
    const waiting = notes(c).filter(n => /^chargeback won/.test(n)).length, said1 = shortNotes(c).length;
    later(60); const w2 = await stripeSends(c, ch, "won", amt);
    vuln(!st.hit || first.status !== 500 || !waiting || said1 || w2[w2.length - 1] !== 200 || shortNotes(c).length !== 1 || notes(c).some(n => /^chargeback won/.test(n)),
      `Z3d [${name}] parts ${split.join("+")}, part 1's payout made (the answer lost); 50.00 refunded in the dashboard; the bank charges back ${amt / 100} (${w1.join("/")}), won: the note's writes fail (${st.hit}) -> ${first.status} (re-payment waiting ${waiting}, said ${said1}); Stripe sends it again -> ${w2.join("/")}: said ${shortNotes(c).length}, waiting ${notes(c).filter(n => /^chargeback won/.test(n)).length}; ${show(c)} (must be: 500 with the re-payment still waiting, then 200 with the note)`);
  });
}

console.error = realError;
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
