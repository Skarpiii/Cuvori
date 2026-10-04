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
  const session = pay(c.stripe_checkout_id, { feeLater: true }); const pi = session.payment_intent; const ch = chargeOf(pi);   // Stripe's fee not there yet when the card is charged
  const saved = ch._bt;                                                        // what Stripe reports once it is
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
// ---------- F11: a stray payment (orphan) is never charged: its hold is released, so nobody pays a card fee; no fee settlement is attempted on it ----------
{
  const c = mk({ amount_cents: 10000 }); await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const before = STRIPE.balance; const s = pay(c.stripe_checkout_id); c.status = "cancelled";
  const w = await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: s } })));
  const p = STRIPE.intents[s.payment_intent], ch = chargeOf(s.payment_intent);
  vuln(w.status !== 200 || p.status !== "canceled" || ch.captured || moneyOut(c).orphans || feeRefunds(s.payment_intent).length || STRIPE.balance !== before,
    `F11 orphan -> ${w.status}, payment ${p.status} (must be canceled: the hold released), charged=${ch.captured}, refunds=${moneyOut(c).orphans}, fee refunds=${feeRefunds(s.payment_intent).length}, Cuvori's balance ${STRIPE.balance - before} (must be 0)`);
  reset();
}
// ---------- F12: the fee table can never make Cuvori pay the card cost — the checkout stops instead ----------
{
  const quoteOf = (p, extra) => ({ price_cents: p, processing_cents: 0, cuvori_cents: 0, total_cents: p, currency: "EUR", payer: "platform", percent: 0, fixed_cents: 0, schedule_id: null, region: "ANY", ...(extra || {}) });
  for (const [name, answer] of [
    ["no active fee row matches", (p) => quoteOf(p)],
    ["the row is set to payer = platform", (p) => quoteOf(p, { schedule_id: 3, percent: 3.25, fixed_cents: 25 })],
    ["the client row has a zero rate", (p) => quoteOf(p, { payer: "client", schedule_id: 3 })],
  ]) {
    hooks.rpc = async (fn, args) => fn === "order_quote" ? [200, answer(args.p_price_cents)] : null;
    const c = mk({ amount_cents: 10000 }); const sessionsBefore = Object.keys(STRIPE.sessions).length;
    const r = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
    vuln(r.status !== 503 || (r.json && r.json.code) !== "payments_paused" || Object.keys(STRIPE.sessions).length !== sessionsBefore || c.stripe_checkout_id,
      `F12 ${name} -> HTTP ${r.status} ${r.json && r.json.code || ""}: ${r.json && r.json.error || ""} (must refuse as "payments paused", with the code the page translates; no Stripe page made)`);
    reset();
  }
  const ok = mk({ amount_cents: 10000 }); const f = await fund(fx, ok);
  vuln(!f.checkout || f.checkout.status !== 200 || ok.status !== "funded", `F12 with a proper client-paid fee row, payment works as before -> HTTP ${f.checkout && f.checkout.status}, status=${ok.status}`);
  reset();
  // a slip while editing the fee table (the database allows any rate under 50%): no card is ever charged a fee like that
  const slip = (pct, fixed) => (p) => { const total = Math.ceil((p + fixed) / (1 - pct / 100)); return { price_cents: p, processing_cents: total - p, cuvori_cents: 0, total_cents: total, currency: "EUR", payer: "client", percent: pct, fixed_cents: fixed, schedule_id: 3, region: "ANY" }; };
  for (const [name, pct, fixed, price] of [["32.5% instead of 3.25%", 32.5, 25, 10000], ["€25 fixed instead of €0.25", 3.25, 2500, 10000], ["a €25 fixed part on a €10 Order", 3.25, 2500, 1000]]) {
    hooks.rpc = async (fn, args) => fn === "order_quote" ? [200, slip(pct, fixed)(args.p_price_cents)] : null;
    const c = mk({ amount_cents: price }); const sessionsBefore = Object.keys(STRIPE.sessions).length;
    const r = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
    vuln(r.status !== 503 || (r.json && r.json.code) !== "payments_paused" || !/far above any card rate/.test(r.json && r.json.error || "") || Object.keys(STRIPE.sessions).length !== sessionsBefore || c.stripe_checkout_id,
      `F12 the fee table slipped to ${name} -> HTTP ${r.status} ${r.json && r.json.code || ""}: ${r.json && r.json.error || ""} (must pause, no Stripe page made)`);
    reset();
  }
  // the real ceiling row (3.25% + €0.25) keeps working on every size of payment, the smallest included
  for (const [name, price] of [["a €1 Order", 100], ["a €0.50 price increase", 50], ["a €950,000 Order", 95000000]]) {
    hooks.rpc = async (fn, args) => fn === "order_quote" ? [200, slip(3.25, 25)(args.p_price_cents)] : null;
    const c = price === 50 ? mk({ amount_cents: 10050, status: "funded", funded_cents: 10000, stripe_payment_intent: "pi_fundedbefore" }) : mk({ amount_cents: price });
    const r = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
    vuln(r.status !== 200, `F12 the real ceiling row on ${name} -> HTTP ${r.status} ${r.json && r.json.error || ""} (must work)`);
    reset();
  }
}

// ---------- F12b: the breakdown saved on the Order is the one of the page that was paid ----------
// Page A is paid; before Cuvori confirms it, the fee table changes and the client makes page B (A cannot be closed: it is
// already complete). A's confirmation must keep A's amounts, A's fee and A's breakdown on the Order, not B's.
{
  const quoteAt = (pct, fixed) => (p) => { const total = Math.ceil((p + fixed) / (1 - pct / 100)); return { price_cents: p, processing_cents: total - p, cuvori_cents: 0, total_cents: total, currency: "EUR", payer: "client", percent: pct, fixed_cents: fixed, schedule_id: 3, region: "ANY" }; };
  const c = mk({ amount_cents: 10000 });
  hooks.rpc = async (fn, args) => fn === "order_quote" ? [200, quoteAt(3.25, 25)(args.p_price_cents)] : null;
  const rA = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const A = c.stripe_checkout_id, feeA = rA.json && rA.json.fee;
  const sA = pay(A);                                                   // the client pays on page A; Cuvori has not confirmed it yet
  hooks.rpc = async (fn, args) => fn === "order_quote" ? [200, quoteAt(3.5, 30)(args.p_price_cents)] : null;   // the fee table changes
  const rB = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const B = c.stripe_checkout_id, feeB = rB.json && rB.json.fee;
  const w = await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: sA } })));   // A's confirmation arrives
  const q = c.quote || {};
  vuln(rA.status !== 200 || rB.status !== 200 || B === A || feeB === feeA || w.status !== 200 || c.status !== "funded" || c.stripe_checkout_id !== A || c.fee_cents !== feeA || q.processing_cents !== feeA || q.price_cents !== 10000 || q.percent !== 3.25,
    `F12b page A paid, fee table changed, page B made, then A confirmed -> Order ${c.status}, page kept ${c.stripe_checkout_id === A ? "A" : c.stripe_checkout_id === B ? "B" : "?"}, fee ${c.fee_cents} (A: ${feeA}, B: ${feeB}), saved breakdown fee ${q.processing_cents} at ${q.percent}% (must all be A's)`);
  reset();
}

// ---------- F13: hold first, charge after — a payment that comes in after its Order changed is never charged ----------
// Its hold is released: the client keeps every cent, nobody pays a card fee, and the history says so once, however often
// Stripe sends it. Only if the Order changes in the moment between the check and the charge is it charged and then
// sent back, all but the card fee Stripe kept — Cuvori still pays nothing.
{
  const checkout = (c) => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const webhook = (s) => call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: s } })));
  const backOf = (s) => STRIPE.refunds.filter(r => r.payment_intent === s.payment_intent);
  const released = async (name, c) => {
    const before = STRIPE.balance; const s = pay(c.stripe_checkout_id); const w = await webhook(s); await webhook(s);   // Stripe sends it twice
    const p = STRIPE.intents[s.payment_intent], ev = events(c, "late_payment_released");
    vuln(w.status !== 200 || p.status !== "canceled" || chargeOf(s.payment_intent).captured || backOf(s).length || STRIPE.balance !== before || ev.length !== 1 || ev[0].data.total_cents !== s.amount_total,
      `F13 ${name} -> ${w.status}; payment ${p.status} (must be canceled: nothing charged), refunds ${backOf(s).length}, Cuvori's balance ${STRIPE.balance - before} (must be 0), history lines ${ev.length} (must be 1)`);
  };
  { const c = mk({ amount_cents: 100000, price: 1000 }); await checkout(c); c.status = "cancelled"; await released("the client cancels, then pays the open €1,000 page", c); }
  { const c = mk({ amount_cents: 100000, price: 1000 }); await checkout(c); c.amount_cents = 90000; c.price = 900; await released("the price is changed to €900, then the €1,000 page is paid", c); }
  { const c = mk({ amount_cents: 10000 }); await fund(fx, c); Object.assign(c, { amount_cents: 15000, price: 150, status: "delivered" }); await checkout(c); c.status = "disputed"; await released("a dispute starts, then the page for the agreed +€50 is paid", c); }
  // the page's own check (stripe-confirm) finds it first: same outcome, and the page is told nothing was charged
  { const c = mk({ amount_cents: 10000 }); await checkout(c); c.status = "cancelled"; const s = pay(c.stripe_checkout_id);
    const k = await call(fx.confirm, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
    vuln(k.status !== 200 || (k.json && k.json.result) !== "released" || STRIPE.intents[s.payment_intent].status !== "canceled", `F13 the page's check comes first -> ${k.status} result=${k.json && k.json.result} (must be released), payment ${STRIPE.intents[s.payment_intent].status}`); }
  // the Order is cancelled in the very moment between the check and the charge: charged, then all but Stripe's fee goes back
  { const c = mk({ amount_cents: 100000, price: 1000 }); await checkout(c); const before = STRIPE.balance; const s = pay(c.stripe_checkout_id);
    hooks.stripe = async (path, method) => { if (method === "POST" && /\/capture$/.test(path)) { hooks.stripe = null; c.status = "cancelled"; } return null; };
    const w = await webhook(s); await webhook(s); hooks.stripe = null;
    const kept = chargeOf(s.payment_intent).balance_transaction.fee, back = backOf(s), ev = events(c, "late_payment_refunded");
    vuln(w.status !== 200 || back.length !== 1 || back[0].amount !== s.amount_total - kept || STRIPE.balance !== before || ev.length !== 1 || ev[0].data.card_fee_cents !== kept,
      `F13 cancelled between the check and the charge -> ${w.status}; back to the card ${JSON.stringify(back.map(r => r.amount))} (must be one refund of ${s.amount_total - kept}), Cuvori's balance ${STRIPE.balance - before} (must be 0), history lines ${ev.length}`); }
  // ...and Stripe's fee is not known yet at that moment: nothing goes back for now, Stripe sends it again; then all but the fee
  { const c = mk({ amount_cents: 10000 }); await checkout(c); const s = pay(c.stripe_checkout_id, { feeLater: true }); const ch = chargeOf(s.payment_intent);
    hooks.stripe = async (path, method) => { if (method === "POST" && /\/capture$/.test(path)) { hooks.stripe = null; c.status = "cancelled"; } return null; };
    const w1 = await webhook(s); hooks.stripe = null; const early = backOf(s).length;
    ch.balance_transaction = ch._bt; const w2 = await webhook(s); const back = backOf(s);
    vuln(w1.status === 200 || early || w2.status !== 200 || back.length !== 1 || back[0].amount !== s.amount_total - ch._bt.fee,
      `F13 ...with Stripe's fee not known yet -> first ${w1.status} with ${early} refunds (must fail with none), then ${w2.status}: ${JSON.stringify(back.map(r => r.amount))} back (must be ${s.amount_total - ch._bt.fee})`); }
  reset();
}
// ---------- F14: the freelancer's Cancel & refund and the admin's decision close the Order's payment page first ----------
{
  const checkout = (c) => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const raised = async () => { const c = mk({ amount_cents: 10000 }); await fund(fx, c); Object.assign(c, { amount_cents: 15000, price: 150, status: "delivered" }); await checkout(c); return c; };   // €100 paid, +€50 agreed, its page open
  { const c = await raised(); const page = c.stripe_checkout_id;
    const r = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id } }));
    vuln(r.status !== 200 || c.status !== "refunded" || STRIPE.sessions[page].status !== "expired",
      `F14 the freelancer cancels while the €50 page is open -> ${r.status} ${r.json && r.json.error || ""}, status ${c.status}, page ${STRIPE.sessions[page].status} (must be expired)`); }
  { const c = await raised(); const before = STRIPE.balance; const s = pay(c.stripe_checkout_id);       // the €50 hold placed a moment before; Stripe's message not in yet
    const r = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id } }));
    await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: s } })));   // the late message changes nothing
    const p = STRIPE.intents[s.payment_intent];
    vuln(r.status !== 200 || c.status !== "refunded" || moneyOut(c).refunded !== 10000 || p.status !== "canceled" || chargeOf(s.payment_intent).captured || moneyOut(c).orphans,
      `F14 the €50 hold is placed just before the freelancer cancels -> ${r.status} ${r.json && r.json.error || ""}: status ${c.status}, refunded ${moneyOut(c).refunded} (the €100 held), the €50 ${p.status} (must be canceled: never charged), stray refunds ${moneyOut(c).orphans}`); }
  { const c = await raised(); const page = c.stripe_checkout_id; c.status = "disputed";
    const r = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "split", editor_percent: 50 } }));
    vuln(r.status !== 200 || c.status !== "completed" || STRIPE.sessions[page].status !== "expired",
      `F14 the admin decides a dispute while a €50 page is still open -> ${r.status} ${r.json && r.json.error || ""}, status ${c.status}, page ${STRIPE.sessions[page].status} (must be expired)`); }
  reset();
}

// ---------- F15: hold first, charge after — the normal way still works, exactly once ----------
{
  const checkout = (c) => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const webhook = (s) => call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: s } })));
  // the Stripe page only places a hold; the webhook charges it; the Order is funded; the card fee surplus goes back
  { const c = mk({ amount_cents: 10000 }); await checkout(c); const sess = STRIPE.sessions[c.stripe_checkout_id]; const before = STRIPE.balance; const s = pay(c.stripe_checkout_id);
    const held = { status: STRIPE.intents[s.payment_intent].status, captured: chargeOf(s.payment_intent).captured };
    const w = await webhook(s); const p = STRIPE.intents[s.payment_intent];
    vuln(sess.params["payment_intent_data[capture_method]"] !== "manual" || held.status !== "requires_capture" || held.captured || w.status !== 200 || p.status !== "succeeded" || c.status !== "funded" || c.funded_cents !== 10000 || STRIPE.balance - before !== 10000 || feeRefunds(s.payment_intent).length !== 1,
      `F15 a normal payment -> page capture_method=${sess.params["payment_intent_data[capture_method]"]}, after paying ${JSON.stringify(held)} (must be a hold), webhook ${w.status}: payment ${p.status}, Order ${c.status} with ${c.funded_cents}, Cuvori's balance +${STRIPE.balance - before} (must be exactly the price 10000), fee refunds ${feeRefunds(s.payment_intent).length}`); }
  // the webhook and the page's own check arrive together: charged once, recorded once
  { const c = mk({ amount_cents: 10000 }); await checkout(c); const s = pay(c.stripe_checkout_id);
    const [w, k] = await Promise.all([webhook(s), call(fx.confirm, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }))]);
    const rows = DB.order_payments.filter(r => r.order_id === c.id && r.kind === "fund");
    vuln(w.status !== 200 || k.status !== 200 || STRIPE.intents[s.payment_intent].status !== "succeeded" || rows.length !== 1 || c.funded_cents !== 10000,
      `F15 webhook and page check together -> ${w.status}/${k.status} (${k.json && k.json.result}), payment ${STRIPE.intents[s.payment_intent].status}, fund rows ${rows.length} (must be 1), funded ${c.funded_cents}`); }
  // the charge fails at Stripe for a moment: nothing is recorded, Stripe is asked to send it again, and the retry charges it
  { const c = mk({ amount_cents: 10000 }); await checkout(c); const s = pay(c.stripe_checkout_id);
    hooks.stripe = async (path, method) => (method === "POST" && /\/capture$/.test(path)) ? [500, { error: { message: "An error occurred with our connection to Stripe.", type: "api_error" } }] : null;
    const w1 = await webhook(s); hooks.stripe = null; const mid = { payment: STRIPE.intents[s.payment_intent].status, order: c.status };
    const w2 = await webhook(s);
    vuln(w1.status === 200 || mid.payment !== "requires_capture" || mid.order !== "accepted" || w2.status !== 200 || STRIPE.intents[s.payment_intent].status !== "succeeded" || c.status !== "funded",
      `F15 the charge fails once -> first ${w1.status} ${JSON.stringify(mid)} (must fail, still a hold, Order unpaid), retry ${w2.status}: payment ${STRIPE.intents[s.payment_intent].status}, Order ${c.status}`); }
  // the admin decides while a new €50 hold is waiting: the hold is released, the decision goes ahead on the €100 held
  { const c = mk({ amount_cents: 10000 }); await fund(fx, c); Object.assign(c, { amount_cents: 15000, price: 150, status: "delivered" }); await checkout(c); const s = pay(c.stripe_checkout_id); c.status = "disputed";
    const r = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "refund" } }));
    vuln(r.status !== 200 || c.status !== "refunded" || moneyOut(c).refunded !== 10000 || STRIPE.intents[s.payment_intent].status !== "canceled",
      `F15 a decision while a €50 hold waits -> ${r.status} ${r.json && r.json.error || ""}: Order ${c.status}, refunded ${moneyOut(c).refunded} (the €100 held), the €50 ${STRIPE.intents[s.payment_intent].status} (must be canceled: never charged)`); }
  reset();
}

console.log(out.join("\n"));
const bad = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${bad} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(bad ? 1 : 0);
