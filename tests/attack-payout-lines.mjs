// The ledger lines of payouts to the freelancer: a milestone's payout, and the re-payment after a chargeback Cuvori won.
// Both are written after the money moved and after the Order's counters followed. When saving the line failed (the
// database did not answer for a moment) the failure was only logged: the Order's payment history (both people see it)
// was missing a payout that was made, and the books no longer added up. For a re-payment the line is also what says
// it was made: what is still owed to the freelancer is worked out from it.
// Now both are saved like the first payment's line: a failed save is looked up and tried again; if it still cannot be
// saved, the Order says so, and the hourly run adds it from Stripe's own record of the transfer — never twice, and
// without paying or counting anything again.
// M1 control, M2 a milestone line that fails once, M3 one that keeps failing, M4 a save whose answer was lost, M5 two
// hourly runs at once, R1 control, R2 a re-payment line that fails once, R3 one that keeps failing.
// Run: node tests/attack-payout-lines.mjs
import { DB, STRIPE, hooks, req, signed, call, mk, fund, moneyOut, reset, fns, uuid } from "./fn-harness.mjs";
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const realError = console.error; console.error = () => {};
const fx = await fns();
const euro = (c) => `€${((c || 0) / 100).toFixed(2)}`;
const res = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const releaseSave = (method, table, body) => method === "POST" && table === "order_payments" && /"kind":"release"/.test(String(body || ""));
const hourly = () => call(fx.autoRelease, req("POST", "x", {}));
const chargeOf = (pi) => STRIPE.charges[STRIPE.intents[pi].latest_charge];
const transfersTo = (c) => STRIPE.transfers.filter(t => t.contract === c.id);
// a save of a payout line fails n times (only the saves `also` picks)
function failSaves(n, also = () => true) { let failed = 0; hooks.db = async (method, table, search, body) => (releaseSave(method, table, body) && also(body) && failed < n ? (failed++, res(503, { message: "connection reset" })) : null); }

// a €100 Order in two €50 milestones, paid, the first one submitted
async function milestoneOrder() {
  const c = mk({ has_milestones: true });
  await fund(fx, c);
  const ms = [1, 2].map(i => ({ id: uuid(), order_id: c.id, title: "Part " + i, amount_cents: 5000, status: i === 1 ? "submitted" : "pending", position: i }));
  DB.order_milestones.push(...ms);
  return { c, m: ms[0] };
}
const approve = (c, m) => call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, milestone_id: m.id } }));
const msLines = (m) => DB.order_payments.filter(p => p.kind === "release" && p.milestone_id === m.id);
const earlier = (m, min = 3) => { m.released_at = new Date(Date.now() - min * 60e3).toISOString(); };

{ // M1 control
  const { c, m } = await milestoneOrder(); const r = await approve(c, m);
  vuln(r.status !== 200 || msLines(m).length !== 1 || c.money_error,
    `M1 control: the client approves a €50 milestone -> HTTP ${r.status}; payout lines ${msLines(m).length}; note ${JSON.stringify(c.money_error || null)}`);
  reset();
}
{ // M2 the save fails once
  const { c, m } = await milestoneOrder(); failSaves(1); const r = await approve(c, m); hooks.db = null;
  vuln(r.status !== 200 || msLines(m).length !== 1 || c.money_error,
    `M2 the payout line's save fails once -> HTTP ${r.status}; payout lines ${msLines(m).length}; note ${JSON.stringify(c.money_error || null)} (must be tried again: 1 line)`);
  reset();
}
{ // M3 the save keeps failing: the Order says so; the hourly run adds the line from Stripe's record
  const { c, m } = await milestoneOrder(); failSaves(Infinity); const r = await approve(c, m); hooks.db = null;
  const noted = String(c.money_error || ""), then = msLines(m).length, paid = transfersTo(c).length;
  vuln(r.status !== 200 || m.status !== "released" || then !== 0 || !noted.includes(m.id),
    `M3a the payout line's save keeps failing -> HTTP ${r.status}; milestone ${m.status}; payout lines ${then}; note ${JSON.stringify(noted || null)} (must not be silent: the Order says the line is missing)`);
  await hourly(); const early = msLines(m).length;
  earlier(m); await hourly();
  const l = msLines(m)[0] || {};
  vuln(early !== 0 || msLines(m).length !== 1 || l.amount_cents !== 5000 || l.provider_ref !== m.transfer_ref || transfersTo(c).length !== paid || c.released_cents !== 5000 || c.money_error,
    `M3b the hourly run -> right after the payout: ${early} line(s); 3 minutes later: ${msLines(m).length} line(s) of ${euro(l.amount_cents)} for transfer ${l.provider_ref === m.transfer_ref ? "the milestone's" : JSON.stringify(l.provider_ref || null)}; transfers ${transfersTo(c).length} (was ${paid}); counted as paid out ${euro(c.released_cents)}; note ${JSON.stringify(c.money_error || null)}`);
  reset();
}
{ // M4 the save went through but its answer was lost
  const { c, m } = await milestoneOrder(); let once = 0;
  hooks.db = async (method, table, search, body) => { if (releaseSave(method, table, body) && !once++) { DB.order_payments.push({ id: uuid(), created_at: new Date().toISOString(), ...JSON.parse(body) }); return res(504, { message: "timeout" }); } return null; };
  await approve(c, m); hooks.db = null; earlier(m); await hourly();
  vuln(msLines(m).length !== 1 || c.money_error, `M4 the save went through but its answer was lost -> payout lines ${msLines(m).length}; note ${JSON.stringify(c.money_error || null)} (must be 1 line)`);
  reset();
}
{ // M5 two hourly runs at the same moment
  const { c, m } = await milestoneOrder(); failSaves(Infinity); await approve(c, m); hooks.db = null; earlier(m);
  await Promise.all([hourly(), hourly()]);
  vuln(msLines(m).length !== 1, `M5 two hourly runs at the same moment -> payout lines ${msLines(m).length} (must be 1)`);
  reset();
}

// a €100 Order paid out to the freelancer, charged back by the client's bank, and the bank sides with Cuvori
const dispute = (type, ch, extra = {}) => signed({ type, data: { object: { id: "dp_" + ch.id, object: "dispute", charge: ch.id, payment_intent: ch.payment_intent, amount: ch.amount, status: "needs_response", reason: "fraudulent", ...extra } } });
async function wonChargeback(during) {
  const c = mk(); await fund(fx, c); c.status = "delivered";
  await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const ch = chargeOf(c.stripe_payment_intent); STRIPE.disputes[ch.id] = { status: "needs_response" };
  await call(fx.webhook, req("POST", "x", dispute("charge.dispute.created", ch)));
  STRIPE.disputes[ch.id] = { status: "won" };
  if (during) during();
  const w = await call(fx.webhook, req("POST", "x", dispute("charge.dispute.closed", ch, { status: "won" })));
  hooks.db = null;
  return { c, w };
}
const repayLines = (c) => DB.order_payments.filter(p => p.order_id === c.id && p.kind === "release" && p.note === "chargeback_won");
const net = (c) => moneyOut(c).transferred;
const isRepay = (body) => /chargeback_won/.test(String(body || ""));

{ // R1 control
  const { c, w } = await wonChargeback();
  vuln(w.status !== 200 || net(c) !== 10000 || repayLines(c).length !== 1 || c.released_cents !== 10000 || c.money_error,
    `R1 control: chargeback won after a €100 payout -> webhook ${w.status}; the freelancer has ${euro(net(c))}; re-payment lines ${repayLines(c).length}; counted as paid out ${euro(c.released_cents)}; note ${JSON.stringify(c.money_error || null)}`);
  reset();
}
{ // R2 the re-payment line fails once
  const { c, w } = await wonChargeback(() => failSaves(1, isRepay));
  vuln(w.status !== 200 || net(c) !== 10000 || repayLines(c).length !== 1 || c.money_error,
    `R2 the re-payment line's save fails once -> webhook ${w.status}; the freelancer has ${euro(net(c))}; re-payment lines ${repayLines(c).length}; note ${JSON.stringify(c.money_error || null)} (must be tried again: 1 line)`);
  reset();
}
{ // R3 the re-payment line keeps failing: the Order says so; the hourly run adds it, paying and counting nothing again
  const { c } = await wonChargeback(() => failSaves(Infinity, isRepay));
  const noted = String(c.money_error || ""), paidThen = net(c), linesThen = repayLines(c).length, transfersThen = transfersTo(c).length;
  vuln(paidThen !== 10000 || linesThen !== 0 || !/re-payment/.test(noted),
    `R3a the re-payment line's save keeps failing -> the freelancer has ${euro(paidThen)}; re-payment lines ${linesThen}; note ${JSON.stringify(noted || null)} (must not be silent: the Order says the line is missing)`);
  await hourly(); await hourly();
  const l = repayLines(c)[0] || {};
  vuln(repayLines(c).length !== 1 || l.amount_cents !== 10000 || net(c) !== 10000 || transfersTo(c).length !== transfersThen || c.released_cents !== 10000 || c.money_error,
    `R3b two hourly runs -> re-payment lines ${repayLines(c).length} of ${euro(l.amount_cents)}; the freelancer has ${euro(net(c))}; transfers ${transfersTo(c).length} (was ${transfersThen}); counted as paid out ${euro(c.released_cents)}; note ${JSON.stringify(c.money_error || null)} (must be 1 line, nothing paid or counted twice)`);
  reset();
}
console.error = realError;
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
