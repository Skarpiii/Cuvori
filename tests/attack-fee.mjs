// The processing fee: the highest card rate is charged up front and the surplus over the provider's real fee is
// refunded to the card automatically. These checks prove Cuvori nets exactly zero on every payment, that the fee
// refund is never mistaken for Order money (price refunds, dashboard refunds, chargebacks), and that it happens
// exactly once even when things are delivered twice, fail half-way, or the provider's fee is not known yet.
import { DB, STRIPE, hooks, req, signed, call, mk, moneyOut, reset, fns, fund, pay, past } from "./fn-harness.mjs";
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const info = (m) => out.push("info       " + m);
const fx = await fns();
const hook = (fn) => { hooks.stripe = fn; };
const fundRow = (c) => DB.order_payments.find(p => p.order_id === c.id && p.kind === "fund");
const feeRefunds = (pi) => STRIPE.refunds.filter(r => r.payment_intent === pi && r.metadata.kind === "fee_surplus");
const chargeOf = (pi) => STRIPE.charges[STRIPE.intents[pi].latest_charge];
const events = (c, ev) => DB.order_events.filter(e => e.order_id === c.id && e.event === ev);

// ---------- F1: a European card — the fee line is the ceiling, the real fee is lower, the difference goes back ----------
{
  const c = mk({ amount_cents: 10000 }); const before = STRIPE.balance; const f = await fund(fx, c);
  const s = f.session, pi = s.payment_intent, row = fundRow(c), actual = chargeOf(pi).balance_transaction.fee, collected = s.amount_total - 10000;
  info(`F1 price 10000, fee line ${collected} (ceiling), provider took ${actual}`);
  vuln(!row || row.fee_refund_cents !== collected - actual, `F1a the ledger records the fee refund -> fee_refund_cents=${row && row.fee_refund_cents} (expected ${collected - actual}), ref=${row && row.fee_refund_ref}`);
  vuln(feeRefunds(pi).length !== 1 || feeRefunds(pi)[0].amount !== collected - actual, `F1b exactly one fee refund at Stripe for ${collected - actual} -> ${JSON.stringify(feeRefunds(pi).map(r => r.amount))}`);
  vuln(c.funded_cents !== 10000 || c.status !== "funded" || moneyOut(c).refunded !== 0, `F1c the Order still holds the full price -> funded=${c.funded_cents}, status=${c.status}, Order money refunded=${moneyOut(c).refunded}`);
  vuln(STRIPE.balance - before !== 10000, `F1d Cuvori's balance holds exactly the price after the fee refund -> ${STRIPE.balance - before} (must be 10000: what came in, minus the provider's fee, minus the surplus refund)`);
  vuln(events(c, "fee_refunded").length !== 1, `F1e one 'fee_refunded' event for the Order screen -> ${events(c, "fee_refunded").length}`);
  reset();
}
// ---------- F2: a non-European card — the provider's fee equals the ceiling: nothing to refund, nothing stranded ----------
{
  const c = mk({ amount_cents: 10000 }); const before = STRIPE.balance;
  const r0 = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const s = STRIPE.sessions[c.stripe_checkout_id]; const collected = s.amount_total - 10000;
  const paid = pay(c.stripe_checkout_id, { fee: collected });
  await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: paid } })));
  const row = fundRow(c);
  vuln(r0.status !== 200 || !row || row.fee_refund_cents !== 0 || feeRefunds(paid.payment_intent).length, `F2a fee equal to the ceiling -> fee_refund_cents=${row && row.fee_refund_cents}, refunds=${feeRefunds(paid.payment_intent).length} (must be 0 and none)`);
  vuln(STRIPE.balance - before !== 10000 || events(c, "fee_exact").length !== 1, `F2b balance holds the price (${STRIPE.balance - before}) and one 'fee_exact' event (${events(c, "fee_exact").length})`);
  reset();
}
// ---------- F3: the provider's fee is ABOVE the ceiling (rare) — nothing can be taken from the card; recorded, not hidden ----------
{
  const c = mk({ amount_cents: 10000 });
  const r0 = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const s = STRIPE.sessions[c.stripe_checkout_id]; const collected = s.amount_total - 10000;
  const paid = pay(c.stripe_checkout_id, { fee: collected + 40 });
  await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: paid } })));
  const row = fundRow(c); const ev = events(c, "fee_exact")[0];
  vuln(r0.status !== 200 || !row || row.fee_refund_cents !== 0 || feeRefunds(paid.payment_intent).length || c.funded_cents !== 10000, `F3a fee above the ceiling -> fee_refund_cents=${row && row.fee_refund_cents}, refunds=${feeRefunds(paid.payment_intent).length}, funded=${c.funded_cents}`);
  vuln(!ev || ev.data.shortfall_cents !== 40, `F3b the shortfall is recorded on the event -> ${ev && JSON.stringify(ev.data)}`);
  reset();
}
// ---------- F4: the same paid session delivered twice (webhook + the page) — one fee refund, not two ----------
{
  const c = mk({ amount_cents: 10000 }); const f = await fund(fx, c); const pi = f.session.payment_intent;
  const again = await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: f.session } })));
  const viaPage = await call(fx.confirm, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, session_id: f.session.id } }));
  vuln(feeRefunds(pi).length !== 1, `F4 delivered three times (${f.webhook.status}, ${again.status}, ${viaPage.status}) -> fee refunds=${feeRefunds(pi).length} (must be 1)`);
  reset();
}
// ---------- F5: the fee is not known at payment time (balance transaction pending) — the hourly job settles it later ----------
{
  const c = mk({ amount_cents: 10000 }); await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const session = pay(c.stripe_checkout_id); const pi = session.payment_intent; const ch = chargeOf(pi);
  const saved = ch.balance_transaction; ch.balance_transaction = null;          // what Stripe answers while the fee is not there yet
  const f = { session, webhook: await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: session } }))) };
  const row = fundRow(c);
  info(`F5a right after payment (fee unknown): webhook ${f.webhook.status}, funded=${c.funded_cents}, fee_refund_cents=${row && row.fee_refund_cents}, provider_fee_cents=${row && row.provider_fee_cents}`);
  const r1 = await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: f.session } })));   // a re-delivery meanwhile changes nothing
  vuln(feeRefunds(pi).length || c.funded_cents !== 10000 || (row && Number.isInteger(row.fee_refund_cents)), `F5b no fee refund while the provider's fee is unknown, the payment itself is recorded -> refunds=${feeRefunds(pi).length}, funded=${c.funded_cents}, fee_refund_cents=${row && row.fee_refund_cents}`);
  const collected = f.session.amount_total - 10000, actual = saved.fee;
  ch.balance_transaction = { ...saved, status: "available", currency: "eur" };
  row.created_at = past(1);                                                    // old enough for the job to look at it
  const job = await call(fx.autoRelease, req("POST", "x", {}));
  vuln(job.status !== 200 || (row.fee_refund_cents !== collected - actual) || feeRefunds(pi).length !== 1, `F5c the hourly job settles it -> HTTP ${job.status} feesSettled=${job.json && job.json.feesSettled}, fee_refund_cents=${row.fee_refund_cents} (expected ${collected - actual}), refunds=${feeRefunds(pi).length}`);
  const job2 = await call(fx.autoRelease, req("POST", "x", {}));
  vuln(feeRefunds(pi).length !== 1 || (job2.json && job2.json.feesSettled), `F5d running the job again changes nothing -> refunds=${feeRefunds(pi).length}, feesSettled=${job2.json && job2.json.feesSettled}`);
  reset();
}
// ---------- F6: the refund request fails or the record fails half-way — a retry makes exactly one refund ----------
{
  let n = 0; hook(async (path, method) => { if (path === "/refunds" && method === "POST" && n++ === 0) { const e = new Error("socket hang up"); e.network = true; e.outcomeUnknown = true; throw e; } });
  const c = mk({ amount_cents: 10000 }); const f = await fund(fx, c); const pi = f.session.payment_intent; const row = fundRow(c);
  info(`F6a first refund attempt failed on the network -> fee_refund_cents=${row.fee_refund_cents}, refunds at Stripe=${feeRefunds(pi).length}, webhook ${f.webhook.status}`);
  reset(); row.created_at = past(1);
  await call(fx.autoRelease, req("POST", "x", {}));
  vuln(feeRefunds(pi).length !== 1 || !Number.isInteger(row.fee_refund_cents) || row.fee_refund_cents <= 0, `F6b after the retry: refunds=${feeRefunds(pi).length}, fee_refund_cents=${row.fee_refund_cents} (exactly one refund)`);
  // a refund that was made but not recorded (killed between the two): the retry finds it at Stripe and records it, no second refund
  const d = mk({ amount_cents: 10000 });
  hook(async (path, method) => { if (path === "/refunds" && method === "POST") { return { after: () => { const e = new Error("db down"); throw e; } }; } });
  reset();
  const g = await fund(fx, d); const pi2 = g.session.payment_intent; const row2 = fundRow(d);
  row2.fee_refund_cents = null; row2.fee_refund_ref = null;                     // as if the record had failed after the refund was made
  row2.created_at = past(1);
  await call(fx.autoRelease, req("POST", "x", {}));
  vuln(feeRefunds(pi2).length !== 1 || row2.fee_refund_cents !== feeRefunds(pi2)[0].amount, `F6c refund made but unrecorded, then retried -> refunds=${feeRefunds(pi2).length}, recorded=${row2.fee_refund_cents}`);
  reset();
}
// ---------- F7: a later price refund is the full price — the fee refund is not counted against it ----------
{
  const c = mk({ amount_cents: 10000 }); const f = await fund(fx, c); const pi = f.session.payment_intent;
  const r = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id } }));
  vuln(r.status !== 200 || moneyOut(c).refunded !== 10000 || c.status !== "refunded", `F7a freelancer cancels after the fee refund -> HTTP ${r.status}, Order money refunded=${moneyOut(c).refunded} (must be 10000), status=${c.status}`);
  vuln(feeRefunds(pi).length !== 1, `F7b the fee refund is still exactly one -> ${feeRefunds(pi).length}`);
  const ch = chargeOf(pi);
  vuln(ch.amount_refunded !== 10000 + feeRefunds(pi)[0].amount, `F7c at Stripe the charge shows price + fee surplus refunded -> ${ch.amount_refunded}`);
  reset();
}
// ---------- F8: a dashboard refund is mirrored from the dashboard refund only, never from the fee refund ----------
{
  const c = mk({ amount_cents: 10000 }); const f = await fund(fx, c); const pi = f.session.payment_intent; const ch = chargeOf(pi);
  // the fee refund's own charge.refunded event: nothing to mirror
  const w0 = await call(fx.webhook, req("POST", "x", signed({ type: "charge.refunded", data: { object: { id: ch.id, object: "charge", payment_intent: pi, amount: ch.amount, amount_refunded: ch.amount_refunded, refunded: false } } })));
  vuln(w0.status !== 200 || c.status !== "funded" || (c.refunded_cents || 0) !== 0 || DB.order_payments.some(p => p.order_id === c.id && p.kind === "refund"), `F8a the fee refund's own event mirrors nothing -> ${w0.status}, status=${c.status}, refunded_cents=${c.refunded_cents || 0}`);
  // then a real dashboard refund of 3000
  STRIPE.refunds.push({ id: "re_dashF8", amount: 3000, metadata: {}, payment_intent: pi, charge: ch.id, status: "succeeded" }); ch.amount_refunded += 3000;
  const w1 = await call(fx.webhook, req("POST", "x", signed({ type: "charge.refunded", data: { object: { id: ch.id, object: "charge", payment_intent: pi, amount: ch.amount, amount_refunded: ch.amount_refunded, refunded: false } } })));
  const mirrored = DB.order_payments.filter(p => p.order_id === c.id && p.kind === "refund").reduce((a, p) => a + p.amount_cents, 0);
  vuln(w1.status !== 200 || mirrored !== 3000, `F8b a 3000 dashboard refund is mirrored as 3000, not 3000 + the fee refund -> ${w1.status}, mirrored=${mirrored}`);
  reset();
}
// ---------- F9: a chargeback after the fee refund — the disputed Order money is the full price ----------
{
  const c = mk({ amount_cents: 10000 }); const f = await fund(fx, c); const pi = f.session.payment_intent; const ch = chargeOf(pi);
  const w = await call(fx.webhook, req("POST", "x", signed({ type: "charge.dispute.created", data: { object: { id: "dp_F9", charge: ch.id, payment_intent: pi, amount: ch.amount - ch.amount_refunded, currency: "eur", status: "needs_response" } } })));
  vuln(w.status !== 200 || c.status !== "disputed" || c.chargeback_status !== "open", `F9a dispute opens -> ${w.status}, status=${c.status}, chargeback=${c.chargeback_status}`);
  const lost = await call(fx.webhook, req("POST", "x", signed({ type: "charge.dispute.closed", data: { object: { id: "dp_F9", charge: ch.id, payment_intent: pi, amount: ch.amount - ch.amount_refunded, currency: "eur", status: "lost" } } })));
  vuln(lost.status !== 200 || c.refunded_cents !== 10000 || c.status !== "refunded", `F9b lost -> ${lost.status}, refunded_cents=${c.refunded_cents} (the full price, not price minus the fee refund), status=${c.status}`);
  reset();
}
// ---------- F10: a top-up has its own fee settlement; a page-declared country changes nothing ----------
{
  const c = mk({ amount_cents: 10000 }); const f = await fund(fx, c); c.amount_cents = 13000; c.price = 130;
  const r0 = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, country: "LT", customer: "consumer" } }));
  const s = STRIPE.sessions[c.stripe_checkout_id]; const q = r0.json || {};
  vuln(r0.status !== 200 || s.amount_total - 3000 !== Math.ceil((3000 + 25) / (1 - 0.0325)) - 3000, `F10a a top-up with a declared EEA country is still quoted at the ceiling -> fee ${s.amount_total - 3000} (ceiling ${Math.ceil((3000 + 25) / (1 - 0.0325)) - 3000}), HTTP ${r0.status} ${JSON.stringify(q).slice(0, 80)}`);
  const paid = pay(c.stripe_checkout_id);
  await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: paid } })));
  const rows = DB.order_payments.filter(p => p.order_id === c.id && p.kind === "fund");
  vuln(rows.length !== 2 || rows.some(p => !Number.isInteger(p.fee_refund_cents)) || feeRefunds(paid.payment_intent).length !== 1 || c.funded_cents !== 13000, `F10b both payments have their fee settled -> ${JSON.stringify(rows.map(p => [p.amount_cents, p.fee_cents, p.fee_refund_cents]))}, top-up refunds=${feeRefunds(paid.payment_intent).length}, funded=${c.funded_cents}`);
  reset();
}
// ---------- F11: a stray payment (orphan) is refunded in full; no fee settlement is attempted on it ----------
{
  const c = mk({ amount_cents: 10000 }); await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const s = pay(c.stripe_checkout_id); c.status = "cancelled";
  const w = await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: s } })));
  vuln(w.status !== 200 || moneyOut(c).orphans !== s.amount_total || feeRefunds(s.payment_intent).length, `F11 orphan -> ${w.status}, refunded in full=${moneyOut(c).orphans} of ${s.amount_total}, fee refunds=${feeRefunds(s.payment_intent).length}`);
  reset();
}

console.log(out.join("\n"));
const bad = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${bad} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(bad ? 1 : 0);
