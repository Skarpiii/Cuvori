// Check of 11 November: a chargeback at today's prices on an Order whose books can't take a payout Stripe made (a part's
// payout whose answer was lost, then a refund in the Stripe dashboard: paid out and given back would be more than was paid
// in), when the pull-back from the freelancer still leaves the books unable to take it.
// K1 every notice of the chargeback failed (the books' paid-out total could not follow Stripe after the pull-back, and that
//    refusal failed the step every time): the chargeback stayed open for good, Stripe stopped after 3 days. Now the pull-back
//    is written down (its line, naming the chargeback), the total stays as it is, and the Order's note says what to check.
// K2 the pull-back is made once, however often the notice comes and whatever the bank decides: what the Order "held" came
//    out below nothing there, and every notice and hourly run worked out more to pull back (with a larger chargeback on such
//    an Order, already before: Stripe's 24-hour key held it back for a day, then 90.00 was taken for a 50.00 chargeback).
// K3 decided for Cuvori: the freelancer is paid back in full right away, Cuvori's own money said (the owner's decision of 12
//    November; tests/attack-check-nov12.mjs); decided for the client: it closes.
// K4 only a refusal for good goes on that way: a passing error still fails the notice (Stripe sends it again).
// K5 the payout stays out of the books with the total (never its line alone): a cancel or Cuvori's decision afterwards is
//    refused with the books to check by hand, and nothing moves.
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
const COVER_HEAD = "re-payment covered by Cuvori after chargeback ";
const covers = (c) => notes(c).filter(n => n.startsWith(COVER_HEAD));
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

// The Order of the problem, at today's prices: 100.00 paid in; a payout made at Stripe whose answer was lost (part 1's 90.00,
// or Cuvori's decision 'release' of the whole 100.00); then 50.00 refunded in the Stripe dashboard (money went out twice)
async function twice(kind) {
  ready(true);
  const c = mk1({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent, ch = chargeOf(pi);
  row(c).status = "funded";
  if (kind === "part") { const [m1] = ms(c, [9000, 1000]); lostTransfer(); await approve(c, m1.id); }
  else { disputed(c); lostTransfer(); await resolve(c, "release"); }
  FAULT.pred = null; later(5);
  const r1 = dashRefund(pi, 5000); await webhook(refundedEvent(pi));
  return { c, pi, ch, r1, d: "dp_" + ch.id };
}

// ---------- K1 every notice answered, the pull-back written down, made once ----------
for (const kind of ["part", "whole"]) {
  await guard(`K1 [${kind}]`, async () => {
    const { c, ch, d } = await twice(kind);
    const w1 = await stripeSends(c, ch, "needs_response", 1000);
    const p1 = pulledAt(c, d), l1 = revSum(c, d), n1 = unNote(c), m1 = cbNote(c), s1 = row(c).chargeback_status;
    // Stripe may send the same notice again; the hourly runs meanwhile
    const w2 = await resend(c, ch, 1000); await hours(2);
    const p2 = pulledAt(c, d), l2 = revSum(c, d), lc = revLines(c, d).length;
    vuln(last(w1) !== 200 || s1 !== "open" || p1 !== 1000 || l1 !== 1000 || n1 !== 1 || m1 || w2.some(s => s !== 200) || p2 !== 1000 || l2 !== 1000 || lc !== 1 || unNote(c) !== 1,
      `K1 [${kind}] ${kind === "part" ? "part 1's 90.00" : "the decision's 100.00"} paid out, the answer lost; 50.00 refunded in the dashboard; the bank charges back 10.00: Stripe's notices answered ${w1.join("/")} (chargeback ${s1}); pulled back ${p1}, its line ${l1}, the note "payouts not in the books" ${n1}, a pull-back still owed ${m1}; the same notice again ${w2.join("/")} and 2 hourly runs: pulled back ${p2} in all, ${lc} line(s) of ${l2}; ${show(c)} (must be: answered 200, the 10.00 pulled back once and written down once, the note there, nothing owed)`);
  });
}

// ---------- K2 the larger chargeback on such an Order: never pulled back twice ----------
// (the bank decides weeks later; Stripe keeps a request's key for 24 hours only, so a pull-back worked out again then is made)
const COULD_NOT = /could not be pulled back/, COVERED = /^chargeback lost; Cuvori covered ([0-9]+\.[0-9]{2}) of what the bank took: the Order no longer had it/;
for (const outcome of ["lost", "won"]) {
  await guard(`K2 [${outcome}]`, async () => {
    const { c, ch, d } = await twice("part");
    const amt = ch.amount - ch.amount_refunded, principal = 5000;          // (the charge's card fee is not the Order's money)
    const w1 = await stripeSends(c, ch, "needs_response", amt);
    const p1 = pulledAt(c, d);
    const w2 = await resend(c, ch, amt, 2); await hours(1);
    later(2 * DAY); STRIPE.idem.clear(); await hours(2); w2.push(...await resend(c, ch, amt, 1));
    const p2 = pulledAt(c, d);
    later(30 * DAY); STRIPE.idem.clear();
    const w3 = await stripeSends(c, ch, outcome, amt); await hours(2);
    // (lost: what Cuvori is really short is said, 40.00: 90.00 + 50.00 went out of 100.00 before the chargeback, and what the
    // bank took the freelancer gave back whole, so never "could not be pulled back" (check of 12 November, third part);
    // won: nothing is missing)
    const p3 = pulledAt(c, d), said = notes(c).filter(n => COULD_NOT.test(n) || COVERED.test(n));
    const saidOk = outcome === "lost" ? said.length === 1 && (COVERED.exec(said[0]) || [])[1] === "40.00" : said.length === 0;
    vuln(last(w1) !== 200 || w2.some(s => s !== 200) || last(w3) !== 200 || row(c).chargeback_status !== outcome || p1 !== principal || p2 !== principal || p3 !== principal || !saidOk || cbNote(c),
      `K2 [${outcome}] part 1's 90.00 paid out, the answer lost; 50.00 refunded in the dashboard; the bank charges back the other 50.00 (${w1.join("/")}): pulled back ${p1}; the same notice again and two days of hourly runs ${w2.join("/")}: ${p2}; ${outcome} a month later (${w3.join("/")}): pulled back ${p3} in all${said.length ? `; the Order says "${said[0].slice(0, 90)}"` : ""}; ${show(c)} (must be: every notice 200, pulled back ${principal} once, chargeback ${outcome}${outcome === "lost" ? ", Cuvori's 40.00 said as the Order no longer having it, never as not pulled back" : ", nothing said to be missing"})`);
  });
}

// ---------- K3 decided by the bank: closed, and the freelancer paid back in full right away ----------
await guard(`K3 [won]`, async () => {
  const { c, ch, d, r1 } = await twice("part");
  const w1 = await stripeSends(c, ch, "needs_response", 1000); await hours(1);
  const w2 = await stripeSends(c, ch, "won", 1000); await hours(2);
  const st = row(c).chargeback_status, pend = notes(c).filter(n => /^chargeback won/.test(n)).length, said = covers(c), rp1 = repaidOf(c, d);
  // the money comes back to the Order: the refund made in the Stripe dashboard fails; nothing more is paid. Then the
  // freelancer cancels the rest: the payout is counted first (the books can take it now), the client gets back what is left
  const wf = await webhook(refundFails(r1)); await hours(3);
  const rp2 = repaidOf(c, d);
  notDisputed(c); const k = await cancel(c); await hours(1);
  const books = row(c).released_cents === sent(c) && linesOk(c);
  vuln(last(w1) !== 200 || last(w2) !== 200 || st !== "won" || pend || rp1 !== 1000 || said.length !== 1 || !said[0].includes(eur(1000)) || pulledAt(c, d) !== 1000 || rp2 !== 1000 || k.status !== 200 || unNote(c) !== 1 || !books,
    `K3 [won] the bank charges back 10.00 (${w1.join("/")}), won (${w2.join("/")}): chargeback ${st}, re-payment waiting ${pend}, paid back ${rp1}, said ${said.length ? '"' + said[0].slice(0, 120) + '"' : "nothing"}; the dashboard refund fails (${wf.status}) and the hourly runs: paid back ${rp2} of ${pulledAt(c, d)}; the freelancer cancels -> ${k.status}, the books ${books ? "follow Stripe" : "DON'T follow Stripe"}; ${show(c)} (must be: won, all 10.00 paid back at once with Cuvori's part said, nothing more later, the payout counted once the books can take it)`);
});
await guard(`K3 [lost]`, async () => {
  const { c, ch, d } = await twice("part");
  const w1 = await stripeSends(c, ch, "needs_response", 1000); await hours(1);
  const w2 = await stripeSends(c, ch, "lost", 1000); await hours(2);
  vuln(last(w1) !== 200 || last(w2) !== 200 || row(c).chargeback_status !== "lost" || pulledAt(c, d) !== 1000 || revSum(c, d) !== 1000 || unNote(c) !== 1 || cbNote(c),
    `K3 [lost] the bank charges back 10.00 (${w1.join("/")}), lost (${w2.join("/")}): chargeback ${row(c).chargeback_status}, pulled back ${pulledAt(c, d)}, its line ${revSum(c, d)}, the note ${unNote(c)}; ${show(c)} (must be: lost, 10.00 pulled back once, the note there)`);
});

// ---------- K5 after it: a cancel or Cuvori's decision waits for a person, nothing moves ----------
// (the books still can't take the payout: the payout is left out of the books with the total, so the step counts it first,
// is refused, and says why; check of 11 November: with the payout's line written while the total could not be, the count
// found nothing to count, the step failed with "Something went wrong" and left the Order "resolving")
for (const step of ["cancel", "refund", "split"]) {
  await guard(`K5 [${step}]`, async () => {
    const { c, ch, pi } = await twice("part");
    const w1 = await stripeSends(c, ch, "needs_response", 1000); const w2 = await stripeSends(c, ch, "won", 1000); await hours(2);
    const out0 = outAtStripe(c, pi), status0 = step === "cancel" ? "funded" : "disputed";
    if (step === "cancel") notDisputed(c); else disputed(c);
    const r = step === "cancel" ? await cancel(c) : await resolve(c, step, step === "split" ? { editor_percent: 50 } : {});
    await hours(2);
    const said = String((r.json && r.json.error) || "");
    vuln(last(w1) !== 200 || last(w2) !== 200 || r.status !== 409 || !/check by hand/.test(said) || outAtStripe(c, pi) !== out0 || row(c).status !== status0 || unNote(c) !== 1,
      `K5 [${step}] the chargeback of 10.00 won (${w1.join("/")}, ${w2.join("/")}); then ${step === "cancel" ? "a cancel" : `Cuvori's decision '${step}'`} -> ${r.status} "${said.slice(0, 90)}"; out at Stripe ${out0} -> ${outAtStripe(c, pi)}; the Order ${row(c).status} (must be: refused with the books to check by hand, nothing moved, the Order as it was)`);
  });
}

// ---------- K1b the pull-back's line: its answer lost, or the database not answering for a moment ----------
for (const how of ["lost", "refused"]) {
  await guard(`K1b [${how}]`, async () => {
    const { c, ch, d } = await twice("part");
    arm(how, (u, init) => u.includes("/order_payments") && init.method === "POST" && /"kind":"reversal"/.test(bodyOf(init)));
    const w1 = await stripeSends(c, ch, "needs_response", 1000); const hit = FAULT.hit; FAULT.pred = null;
    await resend(c, ch, 1000, 1); await hours(1);
    vuln(!hit || last(w1) !== 200 || pulledAt(c, d) !== 1000 || revSum(c, d) !== 1000 || revLines(c, d).length !== 1 || unNote(c) !== 1,
      `K1b [${how}] the pull-back's line ${how === "lost" ? "saved with its answer lost" : "not saved (no answer from the database)"} (${hit ? "hit" : "NOT HIT"}); notices ${w1.join("/")}: pulled back ${pulledAt(c, d)}, ${revLines(c, d).length} line(s) of ${revSum(c, d)}, the note ${unNote(c)} (must be: the notice sent again goes through, pulled back once, one line)`);
  });
}

// ---------- K4 a passing error is never taken for a refusal ----------
await guard(`K4`, async () => {
  ready(true);
  const c = mk1({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent, ch = chargeOf(pi);
  row(c).status = "funded"; const [m1] = ms(c, [9000, 1000]); await approve(c, m1.id); later(5);
  const d = "dp_" + ch.id;
  // the paid-out total after the pull-back: no answer from the database (it did not land)
  arm("refused", (u, init) => u.includes("/contracts") && init.method === "PATCH" && /"stripe_reversal_id"/.test(bodyOf(init)));
  const first = await dispute(c, ch, "needs_response", { amount: 5000 }); const hit = FAULT.hit; FAULT.pred = null;
  const n1 = unNote(c);
  later(60); const w = await stripeSends(c, ch, "needs_response", 5000);
  const lineOk = linesOk(c);
  vuln(!hit || first.status === 200 || n1 || last(w) !== 200 || pulledAt(c, d) !== 4000 || revSum(c, d) !== 4000 || row(c).released_cents !== 5000 || !lineOk || unNote(c),
    `K4 part 1's 90.00 paid out (counted); the bank charges back 50.00, the paid-out total after the pull-back not saved (no answer, ${hit ? "hit" : "NOT HIT"}): the notice -> ${first.status}, the note "payouts not in the books" ${n1}; sent again -> ${w.join("/")}: pulled back ${pulledAt(c, d)}, its line ${revSum(c, d)}, paid out ${row(c).released_cents}, the books ${lineOk ? "match their lines" : "DON'T match their lines"}, the note ${unNote(c)} (must be: the first notice fails, Stripe sends it again, 40.00 pulled back once, paid out 50.00, no note)`);
});

console.error = realError;
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
