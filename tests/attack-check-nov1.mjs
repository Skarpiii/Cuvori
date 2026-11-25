// Check of 1 November: regression checks for the money problems three independent reviewers proved in the payment code.
// K1a a milestone payout Stripe made whose counter update failed, the hourly run in between, then the admin's 'release':
//     the hourly run added the payout's ledger line but not its amount to the Order's counter, so settlement no longer saw
//     the payout and paid the milestone a second time (16000 out of 10000 paid in). K1b the same with a 'split'.
//     K1c control: with no hourly run in between, the decision pays out the rest only (as before).
// K2a a refund made in Stripe's dashboard, its first webhook's counter update saved but the answer lost, Stripe sends it
//     again: the refund was counted twice, and the client's later refund came up 30.00 short. K2b the ledger line not
//     saved, then a second dashboard refund. K2c (standalone fees) the line not saved, then Cuvori's own card-fee refund
//     a day later.
// K3a a release whose transfer Stripe made with the answer lost, then a chargeback on the price increase decided for
//     Cuvori: settlement counted the transfer a second time, nothing moved, and the chargeback's 20.00 stayed with
//     Cuvori. Since the chargeback is kept apart from the Order (1 November, later), the client's approval stays under way
//     and an admin's 'release' can't replace it; the hourly run finishes it. K3b the same with an admin's 'refund'. K3c control: a stuck release with no
//     chargeback is counted once and finished.
// K4  20 late payments whose chargebacks the banks are deciding, and one late payment whose refund failed once: the
//     hourly run only ever looked at the first 20 reminders, so that client's refund was never tried.
// K5a the bank's inquiry ended but its notice was lost: its note held back the automatic release for ever (and since
//     v56 the admin can't mark it as handled). Now the hourly run asks Stripe and goes on. K5b control: while the
//     inquiry is still open at Stripe the release waits. K5c control: Stripe not answering, it waits too.
// Run: node tests/attack-check-nov1.mjs
import { DB, STRIPE, DBQ, users, hooks, req, call, mk, past, moneyOut, reset, fns, fund, pay, signed, stripeHandle, onlyDue, uuid } from "./fn-harness.mjs";
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const realError = console.error; console.error = () => {};
const fx = await fns();
STRIPE.balance = 1_000_000;                                           // other clients' money in the platform balance
const chargeOf = (pi) => STRIPE.charges[STRIPE.intents[pi].latest_charge];
const webhook = (ev) => call(fx.webhook, req("POST", "x", ev));
const hourly = () => call(fx.autoRelease, req("POST", "x", {}));
const NOTE = "Cuvori looked at the chat and the files.";
const resolve = (c, decision, extra = {}) => call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision, note: NOTE, ...extra } }));
const cbEvent = (type, ch, extra = {}) => signed({ type, data: { object: { id: "dp_" + ch.id, object: "dispute", charge: ch.id, payment_intent: ch.payment_intent, amount: extra.amount || ch.amount, currency: "eur", status: extra.status || "needs_response", reason: "fraudulent", created: Math.floor(Date.now() / 1000) } } });
const topUp = async (c, cents) => { c.amount_cents = cents; await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } })); const s = pay(c.stripe_checkout_id); await webhook(signed({ type: "checkout.session.completed", data: { object: s } })); return s; };
const backAtStripe = (pi) => STRIPE.refunds.filter(r => r.payment_intent === pi && !(r.metadata && r.metadata.kind === "fee_surplus")).reduce((a, r) => a + r.amount, 0);
// the database (or the network) failing once: "refused" answers 500 and does nothing; "lost" does it and the answer never arrives
const orig = globalThis.fetch;
let fault = null;
globalThis.fetch = async (url, init = {}) => {
  const how = fault && fault(init.method || "GET", String(url), String(init.body || ""));
  if (how) {
    fault = null;
    if (how === "refused") return new Response(JSON.stringify({ message: "canceling statement due to statement timeout" }), { status: 500, headers: { "content-type": "application/json" } });
    await orig(url, init);
    const e = new TypeError("fetch failed"); e.cause = { code: "UND_ERR_SOCKET" }; throw e;
  }
  return orig(url, init);
};

// ---------- K1 a milestone payout counted by the hourly repair ----------
const milestoneCase = async (decision, withHourly) => {
  const c = mk({ amount_cents: 10000, has_milestones: true }); await fund(fx, c); c.status = "funded";
  const m1 = { id: uuid(), order_id: c.id, title: "m1", amount_cents: 6000, status: "submitted", position: 1 };
  DB.order_milestones.push(m1, { id: uuid(), order_id: c.id, title: "m2", amount_cents: 4000, status: "pending", position: 2 });
  // the database times out once, on the milestone's counter update, right after Stripe paid it
  let failOnce = true;
  hooks.db = async (method, table, search, body) => {
    if (failOnce && method === "PATCH" && table === "contracts" && body && body.includes("released_cents") && body.includes("changes_open")) {
      failOnce = false; return new Response(JSON.stringify({ message: "canceling statement due to statement timeout" }), { status: 500, headers: { "content-type": "application/json" } });
    }
    return null;
  };
  const a = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, milestone_id: m1.id } }));
  hooks.db = null;
  let h = null;
  if (withHourly) { m1.released_at = past(1); h = await hourly(); }
  const before = { released: c.released_cents || 0, lines: DB.order_payments.filter(p => p.order_id === c.id && p.kind === "release" && p.milestone_id === m1.id).length };
  c.status = "disputed"; c.disputed_at = past(); c.dispute_by = users.cl.id;   // the client disputes the rest
  const d = await resolve(c, decision, decision === "split" ? { editor_percent: 50 } : {});
  const m = moneyOut(c);
  const r = { approve: a.status, hourly: h && h.status, before, decision: d.status, freelancer: m.transferred, client: m.refunded, status: c.status };
  reset();
  return r;
};
{ // K1a / K1b the hourly run comes between the failed counter and the decision
  const rel = await milestoneCase("release", true), spl = await milestoneCase("split", true);
  vuln(rel.decision !== 200 || rel.freelancer !== 10000 || rel.client !== 0 || rel.before.released !== 6000 || rel.before.lines !== 1,
    `K1a milestone €60 paid at Stripe, its counter failed (${rel.approve}), the hourly run (${rel.hourly}) -> counter ${rel.before.released}, lines ${rel.before.lines}; then 'release' ${rel.decision} -> freelancer ${rel.freelancer}, client back ${rel.client} of 10000 paid in (must be 6000, 1; 10000, 0)`);
  vuln(spl.decision !== 200 || spl.freelancer !== 8000 || spl.client !== 2000,
    `K1b the same, then a 50/50 'split' ${spl.decision} -> freelancer ${spl.freelancer}, client back ${spl.client} (must be 8000, 2000: the €40 still held is divided)`);
}
{ // K1c control: no hourly run in between, the decision counts the payout itself
  const r = await milestoneCase("release", false);
  vuln(r.decision !== 200 || r.freelancer !== 10000 || r.client !== 0,
    `K1c control: no hourly run in between, then 'release' ${r.decision} -> freelancer ${r.freelancer}, client back ${r.client} (normal: 10000, 0)`);
}

// ---------- K2 a refund made in Stripe's dashboard ----------
const dashboardRefund = (ch, cents) => { const r = { id: "re_dash" + Math.random().toString(36).slice(2, 10), object: "refund", amount: cents, metadata: {}, payment_intent: ch.payment_intent, charge: ch.id, status: "succeeded" }; STRIPE.refunds.push(r); ch.amount_refunded += cents; return r; };
const refundedEvent = (ch, id) => signed({ id, type: "charge.refunded", data: { object: { id: ch.id, object: "charge", amount: ch.amount, amount_refunded: ch.amount_refunded, refunded: ch.amount_refunded >= ch.amount, currency: "eur", payment_intent: ch.payment_intent } } });
{ // K2a the counter update saved, its answer lost: Stripe sends the event again
  const c = mk(); const f = await fund(fx, c); const pi = f.session.payment_intent, ch = chargeOf(pi);
  dashboardRefund(ch, 3000);
  fault = (m, u) => (m === "PATCH" && u.includes("/rest/v1/contracts?") ? "lost" : null);
  const w1 = await webhook(refundedEvent(ch, "evt_k2a")); fault = null;
  const w2 = await webhook(refundedEvent(ch, "evt_k2a"));
  const counted = c.refunded_cents, lines = DB.order_payments.filter(p => p.order_id === c.id && p.kind === "refund").length;
  const d = await resolve(c, "refund");
  vuln(counted !== 3000 || lines !== 1 || d.status !== 200 || backAtStripe(pi) !== 10000,
    `K2a €30 refunded in Stripe's dashboard, the first webhook's answer lost (${w1.status}), sent again (${w2.status}) -> counted ${counted}, ${lines} line; then 'refund' ${d.status} -> the client got back ${backAtStripe(pi)} of 10000 (must be 3000, 1; 10000)`);
}
{ // K2b the ledger line not saved, then a second dashboard refund
  const c = mk(); const f = await fund(fx, c); const pi = f.session.payment_intent, ch = chargeOf(pi);
  dashboardRefund(ch, 3000);
  fault = (m, u) => (m === "POST" && u.includes("/rest/v1/order_payments") ? "refused" : null);
  const w1 = await webhook(refundedEvent(ch, "evt_k2b1")); fault = null;
  const w1b = await webhook(refundedEvent(ch, "evt_k2b1"));
  dashboardRefund(ch, 1000);
  const w2 = await webhook(refundedEvent(ch, "evt_k2b2"));
  const counted = c.refunded_cents;
  const d = await resolve(c, "refund");
  vuln(counted !== 4000 || d.status !== 200 || backAtStripe(pi) !== 10000,
    `K2b the line not saved (${w1.status}, sent again ${w1b.status}), then €10 more refunded in the dashboard (${w2.status}) -> counted ${counted}; then 'refund' ${d.status} -> the client got back ${backAtStripe(pi)} of 10000 (must be 4000; 10000)`);
}
{ // K2c standalone fees: the line not saved, a day later Cuvori's own card-fee refund sends the next charge.refunded
  const RealDate = Date; let skew = 0;
  globalThis.Date = class extends RealDate { constructor(...a) { if (a.length === 0) super(RealDate.now() + skew); else super(...a); } static now() { return RealDate.now() + skew; } };
  STRIPE.reports.instant = true;
  const c = mk(); const f = await fund(fx, c, { standalone: true, fee: 175 }); const pi = f.session.payment_intent, ch = chargeOf(pi);
  dashboardRefund(ch, 3000);
  fault = (m, u) => (m === "POST" && u.includes("/rest/v1/order_payments") ? "refused" : null);
  const w1 = await webhook(refundedEvent(ch, "evt_k2c1")); fault = null;
  skew += 26 * 3600e3; STRIPE.reports.end = Math.floor(Date.now() / 1000) - 60;
  await hourly(); skew += 3600e3; await hourly();
  const w2 = await webhook(refundedEvent(ch, "evt_k2c2"));
  const counted = c.refunded_cents;
  const d = await resolve(c, "refund");
  globalThis.Date = RealDate; STRIPE.reports.instant = false;
  vuln(counted !== 3000 || d.status !== 200 || backAtStripe(pi) !== 10000,
    `K2c standalone fees: the line not saved (${w1.status}), a day later the card-fee refund's notice (${w2.status}) -> counted ${counted}; then 'refund' ${d.status} -> the client got back ${backAtStripe(pi)} of 10000 (must be 3000; 10000)`);
}

// ---------- K3 a transfer the books don't show, counted by a chargeback's pull-back ----------
const transferCase = async (decision, withChargeback) => {
  const c = mk(); await fund(fx, c); const s = await topUp(c, 12000); c.status = "delivered";
  // the client approves; Stripe makes the transfer but its answer never arrives
  hooks.stripe = async (path, method, p) => { if (method === "POST" && path === "/transfers") { stripeHandle(path, method, p); const e = new TypeError("fetch failed"); e.cause = { code: "UND_ERR_SOCKET" }; throw e; } return null; };
  const a = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  hooks.stripe = null;
  let cbClosed = null;
  if (withChargeback) {
    const ch2 = chargeOf(s.payment_intent);
    STRIPE.disputes[ch2.id] = { status: "needs_response" }; await webhook(cbEvent("charge.dispute.created", ch2));
    STRIPE.disputes[ch2.id].status = "won"; cbClosed = (await webhook(cbEvent("charge.dispute.closed", ch2, { status: "won" }))).status;
    // the bank's chargeback is kept apart from the Order: the client's approval stays under way (its transfer is made), so
    // an admin decision can't replace it; the hourly run finishes it, and pays back what the chargeback pulled back
    const d = await resolve(c, decision);
    for (const x of DB.contracts) if (x !== c && ["delivered", "releasing", "resolving"].includes(x.status)) x.status = "completed";
    c.resolved_at = past(1); await hourly(); await hourly();
    const m = moneyOut(c);
    const r = { approve: a.status, cbClosed, decision: d.status, freelancer: m.transferred, client: m.refunded, keeps: 12000 - m.transferred - m.refunded, status: c.status, released: c.released_cents };
    reset(); return r;
  }
  c.resolved_at = past(1);                                              // an hour later: the hourly run finishes the stuck release
  const h = await hourly();
  const m = moneyOut(c);
  const r = { approve: a.status, hourly: h.status, freelancer: m.transferred, status: c.status, released: c.released_cents, lines: DB.order_payments.filter(p => p.order_id === c.id && p.kind === "release").length };
  reset(); return r;
};
{ // K3a / K3b
  const rel = await transferCase("release", true), ref = await transferCase("refund", true);
  vuln(rel.decision !== 409 || rel.keeps !== 0 || rel.freelancer !== 12000 || rel.released !== 12000 || rel.status !== "completed",
    `K3a release whose transfer's answer was lost (${rel.approve}), then the €20 increase charged back and won (${rel.cbClosed}), an admin's 'release' ${rel.decision}, then the hourly run -> freelancer ${rel.freelancer}, client back ${rel.client}, Cuvori keeps ${rel.keeps}; counter ${rel.released}, ${rel.status} (must be 409 (the approval is under way); 12000, 0, 0; 12000, completed)`);
  vuln(ref.decision !== 409 || ref.keeps !== 0 || ref.freelancer !== 12000 || ref.client !== 0 || ref.status !== "completed",
    `K3b the same, an admin's 'refund' ${ref.decision} -> freelancer ${ref.freelancer}, client back ${ref.client}, Cuvori keeps ${ref.keeps}, ${ref.status} (must be 409; the client's approval stands: 12000, 0, 0, completed)`);
}
{ // K3c control: a stuck release with no chargeback, finished by the hourly run
  const r = await transferCase("release", false);
  vuln(r.freelancer !== 12000 || r.released !== 12000 || r.status !== "completed" || r.lines !== 1,
    `K3c control: the stuck release finished by the hourly run (${r.hourly}) -> freelancer ${r.freelancer}, counter ${r.released}, ${r.status}, ${r.lines} line (normal: 12000, 12000, completed, 1)`);
}

// ---------- K4 the late-refund reminders ----------
{ // K4 20 late payments with a chargeback open, then one whose refund Stripe refused once
  DBQ.paging = true;                                                    // like the real database: limit and order apply
  const RealDate = Date; let skew = 0;
  globalThis.Date = class extends RealDate { constructor(...a) { if (a.length === 0) super(RealDate.now() + skew); else super(...a); } static now() { return RealDate.now() + skew; } };
  const late = async (refuse) => {
    const c = mk({ amount_cents: 10000 }); await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } })); const s = pay(c.stripe_checkout_id);
    // the Order is cancelled while the card is being charged: the payment can't go in, so it is a late payment
    hooks.stripe = async (path, method) => { if (method === "POST" && /\/capture$/.test(path)) { c.status = "cancelled"; return null; } if (method === "POST" && path === "/refunds" && refuse) return refuse(s); return null; };
    await webhook(signed({ type: "checkout.session.completed", data: { object: s } })); reset();
    return s;
  };
  const waiting = [];
  for (let i = 0; i < 20; i++) waiting.push(await late((s) => { const ch = chargeOf(s.payment_intent); ch.disputed = true; STRIPE.disputes[ch.id] = { id: "dp_" + ch.id, status: "needs_response" }; return null; }));
  skew += 3600e3; await hourly();
  const last = await late(() => [400, { error: { type: "invalid_request_error", code: "balance_insufficient", message: "You have insufficient funds in your Stripe account." } }]);
  const reminders = DB.money_keys.filter(k => k.scope.startsWith("late_refund:")).length, before = backAtStripe(last.payment_intent);
  skew += 3600e3; const h = await hourly();
  const refunded = backAtStripe(last.payment_intent), waitingRefunded = waiting.filter(s => backAtStripe(s.payment_intent) > 0).length;
  globalThis.Date = RealDate; DBQ.paging = false;
  vuln(reminders < 21 || before !== 0 || refunded <= 0 || waitingRefunded !== 0,
    `K4 ${reminders} reminders (20 waiting for the banks, the 21st refused once, back ${before}); the next hourly run (${h.status}) -> the 21st client got back ${refunded}; refunds made while a chargeback is open: ${waitingRefunded} (must be 21; more than 0; 0)`);
  reset();
}

// ---------- K5 the bank's inquiry ----------
const inquiryCase = async (stripeSays) => {
  const c = mk(); const f = await fund(fx, c); c.status = "delivered"; c.auto_release_at = past(2); onlyDue(c);
  const ch = chargeOf(f.session.payment_intent);
  STRIPE.disputes[ch.id] = { status: "warning_needs_response" };
  const w = (await webhook(cbEvent("charge.dispute.created", ch, { status: "warning_needs_response" }))).status;
  const noted = /bank asked about payment/.test(c.money_error || "");
  if (stripeSays === "ended") STRIPE.disputes[ch.id].status = "warning_closed";         // ended at Stripe; its notice never came
  if (stripeSays === "down") hooks.stripe = async (path, method) => (method === "GET" && path === "/disputes" ? [500, { error: { message: "Stripe is down", type: "api_error" } }] : null);
  const h = await hourly();
  hooks.stripe = null;
  const r = { w, noted, hourly: h.status, status: c.status, paid: moneyOut(c).transferred, note: /bank asked about payment/.test(c.money_error || "") };
  reset(); return r;
};
{ // K5a the inquiry ended without a notice
  const r = await inquiryCase("ended");
  vuln(!r.noted || r.status !== "completed" || r.paid !== 10000 || r.note,
    `K5a an inquiry (${r.w}, noted: ${r.noted}) that ended at Stripe without its notice, the review window over -> the hourly run (${r.hourly}): ${r.status}, paid ${r.paid}, note still there: ${r.note} (must be completed, 10000, false)`);
}
{ // K5b / K5c controls
  const open = await inquiryCase("open"), down = await inquiryCase("down");
  vuln(open.status !== "delivered" || open.paid !== 0 || !open.note || down.status !== "delivered" || down.paid !== 0 || !down.note,
    `K5b/K5c controls: the inquiry still open at Stripe -> ${open.status}, paid ${open.paid}, note kept: ${open.note}; Stripe not answering -> ${down.status}, paid ${down.paid}, note kept: ${down.note} (normal: delivered, 0, true twice)`);
}

console.error = realError;
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
