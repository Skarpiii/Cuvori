// The payment audit of 31 October: regression checks for its critical and high findings that are fixed in the payment code.
// R1 a won chargeback repaid every pull-back on the Order, also one made for a chargeback the bank decided for the client:
//    €100 + a €20 price increase released, the €100 charged back and lost, the €20 charged back and won -> the freelancer
//    was paid €120 again instead of €20. R2 the same with the pulled-back money released meanwhile by a decision.
//    R3 a single won chargeback still repays exactly what it pulled back.
// M1 a milestone payout Stripe made, whose counter update then failed, was paid a second time by the admin's 'release'
//    (€100 paid in, €160 paid out). M2 the same with Stripe's answer lost, then a 'release' or a 'split' decision.
// M3 a milestone whose counter moved but whose ledger line was lost is counted once, not twice.
// F1 Stripe's fee stored as 0 by older code (under standalone billing) is not believed: the card-fee refund waits for the
//    real fee from Stripe's Fees report instead of sending the whole card fee back.
// Run: node tests/attack-audit-oct31.mjs
import { DB, STRIPE, users, hooks, req, signed, call, mk, past, moneyOut, reset, fns, fund, pay, uuid, stripeHandle, finishReport } from "./fn-harness.mjs";
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const realError = console.error; console.error = () => {};
const fx = await fns();
const chargeOf = (pi) => STRIPE.charges[STRIPE.intents[pi].latest_charge];
const cbEvent = (type, ch, extra = {}) => signed({ type, data: { object: { id: "dp_" + ch.id, object: "dispute", charge: ch.id, payment_intent: ch.payment_intent, amount: extra.amount || ch.amount, status: extra.status || "needs_response", reason: "fraudulent", created: Math.floor(Date.now() / 1000) } } });
const webhook = (ev) => call(fx.webhook, req("POST", "x", ev));
const dispute = async (ch, outcome) => {
  STRIPE.disputes[ch.id] = { status: "needs_response" };
  const a = await webhook(cbEvent("charge.dispute.created", ch));
  STRIPE.disputes[ch.id].status = outcome;
  const b = await webhook(cbEvent("charge.dispute.closed", ch, { status: outcome }));
  return [a.status, b.status];
};
const topUp = async (c, cents) => {
  c.amount_cents = cents;
  await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const s = pay(c.stripe_checkout_id); await webhook(signed({ type: "checkout.session.completed", data: { object: s } }));
  return s;
};
STRIPE.balance = 1_000_000;                                           // other clients' money in the platform balance

{ // R1 a lost chargeback, then a won one on the price increase: only the increase's pull-back is repaid
  const c = mk(); const f = await fund(fx, c); const s = await topUp(c, 12000);
  c.status = "delivered"; await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const paidOut = moneyOut(c).transferred;
  const lost = await dispute(chargeOf(f.session.payment_intent), "lost");
  const won = await dispute(chargeOf(s.payment_intent), "won");
  vuln(paidOut !== 12000 || moneyOut(c).transferred !== 2000,
    `R1 €100 + €20 released; the €100 charged back and lost (${lost}), the €20 charged back and won (${won}) -> the freelancer keeps ${moneyOut(c).transferred} (must be 2000: the bank gave the €100 back to the client)`);
  reset();
}
{ // R2 a chargeback won while the money was held, the admin releases everything, then a chargeback on the increase is won
  const c = mk({ amount_cents: 10000, has_milestones: true }); const f = await fund(fx, c); c.status = "funded";
  const m1 = { id: uuid(), order_id: c.id, title: "m1", amount_cents: 6000, status: "submitted", position: 1 };
  DB.order_milestones.push(m1, { id: uuid(), order_id: c.id, title: "m2", amount_cents: 4000, status: "pending", position: 2 }, { id: uuid(), order_id: c.id, title: "m3", amount_cents: 2000, status: "pending", position: 3 });
  const s = await topUp(c, 12000); c.status = "funded";
  await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, milestone_id: m1.id } }));
  await dispute(chargeOf(f.session.payment_intent), "won");
  await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "release" } }));
  await dispute(chargeOf(s.payment_intent), "won");
  vuln(moneyOut(c).transferred > 12000,
    `R2 a won chargeback while held, everything released by the admin, a second chargeback won -> the freelancer has ${moneyOut(c).transferred} (must be at most the 12000 paid in)`);
  reset();
}
{ // R3 control: one chargeback after the payout, won -> exactly what it pulled back is paid again
  const c = mk(); const f = await fund(fx, c); c.status = "delivered";
  await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const ch = chargeOf(f.session.payment_intent);
  STRIPE.disputes[ch.id] = { status: "needs_response" }; await webhook(cbEvent("charge.dispute.created", ch));
  const pulled = STRIPE.transfers.filter(t => t.contract === c.id).reduce((a, t) => a + t.amount_reversed, 0);
  STRIPE.disputes[ch.id].status = "won"; await webhook(cbEvent("charge.dispute.closed", ch, { status: "won" }));
  vuln(pulled !== 10000 || moneyOut(c).transferred !== 10000,
    `R3 one chargeback after the payout, won -> pulled back ${pulled}, the freelancer has ${moneyOut(c).transferred} again (must be 10000, 10000)`);
  reset();
}
{ // M1 the milestone's counter update fails after Stripe paid it; the client disputes the rest; the admin releases
  const c = mk({ amount_cents: 10000, has_milestones: true }); await fund(fx, c); c.status = "funded";
  const m1 = { id: uuid(), order_id: c.id, title: "m1", amount_cents: 6000, status: "submitted", position: 1 };
  DB.order_milestones.push(m1, { id: uuid(), order_id: c.id, title: "m2", amount_cents: 4000, status: "pending", position: 2 });
  let failOnce = true;
  hooks.db = async (method, table, search, body) => {
    if (failOnce && method === "PATCH" && table === "contracts" && body && body.includes("released_cents") && body.includes("changes_open")) {
      failOnce = false; return new Response(JSON.stringify({ message: "canceling statement due to statement timeout" }), { status: 500, headers: { "content-type": "application/json" } });
    }
    return null;
  };
  await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, milestone_id: m1.id } }));
  hooks.db = null;
  c.status = "disputed"; c.disputed_at = past(); c.dispute_by = users.cl.id;
  const d = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "release" } }));
  vuln(moneyOut(c).transferred !== 10000 || c.released_cents !== 10000,
    `M1 a milestone paid at Stripe but not counted, then the admin's 'release' (${d.status}) -> the freelancer got ${moneyOut(c).transferred}, counted ${c.released_cents} (must be 10000, 10000: the €100 paid in, once)`);
  reset();
}
{ // M3 the milestone's counter moved but its ledger line failed: the settlement adds the line only, never the amount twice
  const c = mk({ amount_cents: 10000, has_milestones: true }); await fund(fx, c); c.status = "funded";
  const m1 = { id: uuid(), order_id: c.id, title: "m1", amount_cents: 6000, status: "submitted", position: 1 };
  DB.order_milestones.push(m1, { id: uuid(), order_id: c.id, title: "m2", amount_cents: 4000, status: "pending", position: 2 });
  hooks.db = async (method, table, search, body) => method === "POST" && table === "order_payments" && /"kind":"release"/.test(String(body || "")) && String(body).includes(m1.id)
    ? new Response(JSON.stringify({ message: "connection reset" }), { status: 503, headers: { "content-type": "application/json" } }) : null;
  await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, milestone_id: m1.id } }));
  hooks.db = null;
  const counted = c.released_cents;
  c.status = "disputed"; c.disputed_at = past(); c.dispute_by = users.cl.id;
  const d = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "release" } }));
  const lines = DB.order_payments.filter(p => p.order_id === c.id && p.kind === "release" && p.milestone_id === m1.id).length;
  vuln(counted !== 6000 || moneyOut(c).transferred !== 10000 || c.released_cents !== 10000 || lines !== 1,
    `M3 a milestone counted (${counted}) but its line lost, then the admin's 'release' (${d.status}) -> the freelancer got ${moneyOut(c).transferred}, counted ${c.released_cents}, milestone lines ${lines} (must be 10000, 10000, 1)`);
  reset();
}
for (const decision of ["release", "split"]) { // M2 Stripe paid the milestone but its answer was lost; the client disputes; the admin decides
  const c = mk({ amount_cents: 10000, has_milestones: true }); await fund(fx, c); c.status = "funded";
  const m1 = { id: uuid(), order_id: c.id, title: "m1", amount_cents: 6000, status: "submitted", position: 1 };
  DB.order_milestones.push(m1, { id: uuid(), order_id: c.id, title: "m2", amount_cents: 4000, status: "pending", position: 2 });
  hooks.stripe = async (path, method, p) => { if (method === "POST" && path === "/transfers") { stripeHandle(path, method, p); const e = new TypeError("fetch failed"); e.cause = { code: "UND_ERR_SOCKET" }; throw e; } return null; };
  await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, milestone_id: m1.id } }));
  hooks.stripe = null;
  c.status = "disputed"; c.disputed_at = past(); c.dispute_by = users.cl.id;
  const d = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision, editor_percent: 50 } }));
  const total = moneyOut(c).transferred + moneyOut(c).refunded;
  const want = decision === "release" ? 10000 : 6000 + 2000;              // a split of what is still held: €40, half each
  vuln(total !== 10000 || moneyOut(c).transferred !== want || !["completed", "refunded"].includes(c.status),
    `M2 a milestone paid at Stripe with its answer lost, then the admin's '${decision}' (${d.status}) -> freelancer ${moneyOut(c).transferred} + client back ${moneyOut(c).refunded} = ${total} (must be 10000; the freelancer ${want}); Order ${c.status}`);
  reset();
}
{ // F1 Stripe's fee stored as 0 by older code: the card-fee refund waits for the real fee instead of returning the whole card fee
  STRIPE.reports = { end: 0, runs: [], instant: true };
  const c = mk({ amount_cents: 10000 }); const f = await fund(fx, c, { standalone: true, fee: 175 });
  const pi = f.session.payment_intent, ch = chargeOf(pi), row = DB.order_payments.find(p => p.order_id === c.id && p.kind === "fund");
  row.provider_fee_cents = 0;                                              // what the code before update 37 stored
  ch.created = Math.floor(Date.now() / 1000) - 5 * 86400; for (const r of STRIPE.feeRows) if (r.incurred_by === ch.id) r.created = ch.created;
  row.created_at = new Date(Date.now() - 5 * 86400e3).toISOString();
  const collected = f.session.amount_total - 10000 - Number(f.session.metadata.connect_cents || 0);
  const before = STRIPE.refunds.filter(r => r.payment_intent === pi && r.metadata.kind === "fee_surplus").length;
  STRIPE.reports.end = Math.floor(Date.now() / 1000) - 3600;
  await call(fx.autoRelease, req("POST", "x", {})); await call(fx.autoRelease, req("POST", "x", {}));
  const back = STRIPE.refunds.filter(r => r.payment_intent === pi && r.metadata.kind === "fee_surplus").map(r => r.amount);
  vuln(before !== 0 || back.length !== 1 || back[0] !== collected - 175 || row.provider_fee_cents !== 175,
    `F1 Stripe's fee stored as 0 by older code -> card-fee refunds ${JSON.stringify(back)} (must be one of ${collected - 175}, not the whole ${collected}); Stripe's fee now ${row.provider_fee_cents} (must be 175)`);
  STRIPE.reports = { end: 0, runs: [], instant: false };
  reset();
}

console.error = realError;
console.log(out.join("\n"));
const bad = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${bad} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(bad ? 1 : 0);
