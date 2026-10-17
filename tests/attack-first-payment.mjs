// The ledger line of an Order's first payment. The refunds, the card-fee surplus and a later chargeback all go by the
// Order's ledger (order_payments). When saving the first payment's line failed (the database did not answer for a
// moment), the payment was counted on the Order but the failure was only logged:
//  * the card-fee surplus never went back to the client (it stayed with Cuvori, and nothing told anyone);
//  * after a top-up, a refund (a cancel, a dispute decided for the client) failed with "refund exceeds what was paid";
//  * after a top-up, a chargeback on the first payment could not be answered ("principal not recorded"): nothing was
//    pulled back from the freelancer, so Cuvori paid it.
// A top-up's line was already checked. Now the first payment's line is too: a failed save is tried again (and looked up
// first, so a save whose answer was lost is never written twice); if it still cannot be saved, the Order says so, and
// the line is added from Stripe's own record of the payment: by the hourly job, or by the next money step that needs
// it. Never while the payment's own save may still be on its way (2 minutes), and never twice.
// P1 control, P2 a save that fails once, P3 a save that keeps failing, P4 a save whose answer was lost, P5 a top-up and a
// cancel, P6 a top-up, a release and a chargeback, P7 two hourly runs at the same moment, P8 a record that does not match.
// Run: node tests/attack-first-payment.mjs
import { DB, STRIPE, hooks, req, signed, call, mk, fund, moneyOut, reset, fns } from "./fn-harness.mjs";
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const logs = []; const realError = console.error; console.error = (...a) => logs.push(a.map(String).join(" "));
const fx = await fns();
const euro = (c) => `€${((c || 0) / 100).toFixed(2)}`;
const lines = (c) => DB.order_payments.filter(p => p.order_id === c.id && p.kind === "fund");
const firstLines = (c) => lines(c).filter(p => p.provider_ref === c.stripe_payment_intent);
const chargeOf = (pi) => STRIPE.charges[STRIPE.intents[pi].latest_charge];
const surplus = (c) => { const real = chargeOf(c.stripe_payment_intent)._bt.fee; return c.fee_cents - real; };     // what must go back to the card
const res = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const isFundSave = (method, table, body) => method === "POST" && table === "order_payments" && /"kind":"fund"/.test(String(body || ""));
const hourly = () => call(fx.autoRelease, req("POST", "x", {}));
const later = (c, min = 3) => { c.funded_at = new Date(Date.now() - min * 60e3).toISOString(); };     // the payment was a few minutes ago
const pulledBack = (c) => STRIPE.transfers.filter(t => t.contract === c.id).reduce((a, t) => a + (t.amount_reversed || 0), 0);

// the first payment's save fails: once (n = 1), or every time during the payment (n = Infinity)
async function fundFailing(c, n) {
  let failed = 0;
  hooks.db = async (method, table, search, body) => { if (isFundSave(method, table, body) && failed < n) { failed++; return res(503, { message: "connection reset" }); } return null; };
  const f = await fund(fx, c);
  hooks.db = null;
  return f;
}

{ // P1 control
  const c = mk(); await fund(fx, c);
  vuln(firstLines(c).length !== 1 || moneyOut(c).feeBack !== surplus(c) || c.money_error,
    `P1 control: a €100 first payment -> ledger lines ${firstLines(c).length}; card-fee surplus back ${euro(moneyOut(c).feeBack)} of ${euro(surplus(c))}; note ${JSON.stringify(c.money_error || null)}`);
  reset();
}
{ // P2 the save fails once
  const c = mk(); await fundFailing(c, 1);
  vuln(c.status !== "funded" || firstLines(c).length !== 1 || moneyOut(c).feeBack !== surplus(c) || c.money_error,
    `P2 the save of the first payment's line fails once -> Order ${c.status}; ledger lines ${firstLines(c).length}; surplus back ${euro(moneyOut(c).feeBack)} of ${euro(surplus(c))}; note ${JSON.stringify(c.money_error || null)} (must be tried again: 1 line, surplus back at once)`);
  reset();
}
{ // P3 the save keeps failing: the Order says so; the hourly job adds the line from Stripe's record, once the payment is a few minutes old
  const c = mk(); await fundFailing(c, Infinity);
  const noted = String(c.money_error || ""), linesThen = firstLines(c).length;
  vuln(c.status !== "funded" || linesThen !== 0 || !noted.includes(c.stripe_payment_intent),
    `P3a the save keeps failing during the payment -> Order ${c.status}; ledger lines ${linesThen}; note ${JSON.stringify(noted || null)} (must not be silent: the Order says the line is missing)`);
  await hourly();
  const early = firstLines(c).length;
  later(c); await hourly();
  const l = firstLines(c)[0] || {};
  const real = chargeOf(c.stripe_payment_intent)._bt.fee;
  vuln(early !== 0 || firstLines(c).length !== 1 || l.amount_cents !== 10000 || l.fee_cents !== c.fee_cents || l.provider_fee_cents !== real || moneyOut(c).feeBack !== surplus(c) || c.money_error,
    `P3b the hourly job -> right after the payment: ${early} line(s) (its own save may still be on its way); 3 minutes later: ${firstLines(c).length} line(s) of ${euro(l.amount_cents)}, fee ${euro(l.fee_cents)}, Stripe's fee ${euro(l.provider_fee_cents)}; surplus back ${euro(moneyOut(c).feeBack)} of ${euro(surplus(c))}; note ${JSON.stringify(c.money_error || null)}`);
  reset();
}
{ // P4 the save went through, but its answer was lost: never two lines, never two surplus refunds
  const c = mk(); let once = 0;
  hooks.db = async (method, table, search, body) => {
    if (isFundSave(method, table, body) && !once++) { DB.order_payments.push({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...JSON.parse(body) }); return res(504, { message: "timeout" }); }
    return null;
  };
  await fund(fx, c); hooks.db = null;
  later(c); await hourly(); await hourly();
  vuln(firstLines(c).length !== 1 || moneyOut(c).feeBack !== surplus(c) || c.money_error,
    `P4 the save went through but its answer was lost -> ledger lines ${firstLines(c).length}; surplus back ${euro(moneyOut(c).feeBack)} of ${euro(surplus(c))}; note ${JSON.stringify(c.money_error || null)} (must be 1 line and 1 refund of the surplus)`);
  reset();
}
{ // P5 the line is missing, then a €20 top-up, then the freelancer gives the Order back
  const c = mk(); await fundFailing(c, Infinity); later(c);
  c.amount_cents = 12000; c.price = 120; await fund(fx, c);
  const r = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id } }));
  vuln(r.status !== 200 || moneyOut(c).refunded !== 12000,
    `P5 a €20 top-up, then the freelancer cancels -> HTTP ${r.status}${r.status !== 200 ? " " + JSON.stringify(r.json).slice(0, 100) : ""}; refunded ${euro(moneyOut(c).refunded)} of ${euro(12000)}; Order ${c.status} (must refund all of it)`);
  reset();
}
{ // P6 the line is missing, then a €20 top-up, the client approves, and the bank charges back the first payment
  const c = mk(); await fundFailing(c, Infinity); later(c);
  c.amount_cents = 12000; c.price = 120; await fund(fx, c);
  c.status = "delivered";
  const r = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const ch = chargeOf(c.stripe_payment_intent);
  const w = await call(fx.webhook, req("POST", "x", signed({ type: "charge.dispute.created", data: { object: { id: "dp_" + ch.id, object: "dispute", charge: ch.id, payment_intent: ch.payment_intent, amount: ch.amount, status: "needs_response", reason: "fraudulent" } } })));
  vuln(r.status !== 200 || pulledBack(c) !== 10000,
    `P6 a €20 top-up, the client releases €120, then the bank charges back the first payment (€${(ch.amount / 100).toFixed(2)}) -> release HTTP ${r.status}; webhook ${w.status}; pulled back from the freelancer ${euro(pulledBack(c))} (must be the first payment's €100.00, or Cuvori pays it)`);
  reset();
}
{ // P7 two hourly runs at the same moment add the missing line once
  const c = mk(); await fundFailing(c, Infinity); later(c);
  await Promise.all([hourly(), hourly()]);
  vuln(firstLines(c).length !== 1 || moneyOut(c).feeBack !== surplus(c),
    `P7 two hourly runs at the same moment -> ledger lines ${firstLines(c).length}; surplus back ${euro(moneyOut(c).feeBack)} of ${euro(surplus(c))} (must be 1 line, 1 refund)`);
  reset();
}
{ // P8 Stripe's record does not match what the Order counted: nothing is guessed
  const c = mk(); await fundFailing(c, Infinity); later(c);
  c.funded_cents = 5000;                      // the Order says €50 came in; Stripe's payment was €100 + fee
  await hourly();
  vuln(firstLines(c).length !== 0 || !String(c.money_error || "").includes(c.stripe_payment_intent),
    `P8 the Order's record (€50 paid in) does not match Stripe's payment (€100) -> ledger lines ${firstLines(c).length}; note ${JSON.stringify(c.money_error || null)} (must add nothing and keep the note for a person to check)`);
  reset();
}
console.error = realError;
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
