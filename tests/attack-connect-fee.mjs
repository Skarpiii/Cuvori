// Stripe's payout fees on the client's bill (schema v50, netlify/lib/cuvori.mjs quoteFor, stripe-checkout).
// Freelancers are paid through Stripe Express accounts, so Stripe charges Cuvori for paying out: EUR 2 a month per
// freelancer account paid out, plus 0.25% + EUR 0.10 per payout. Nothing passed that on. Now the client pays it as a third
// line, "Payout fee (Stripe)", at cost; a top-up pays only the percentage. It is kept in its own field (connect_cents) on
// the Order and on the payment line, never mixed into the card fee, so the card-fee refund (the surplus over what the card
// really cost) is exactly what it was. It is not refunded afterwards, and like the card fee it is not given back on a
// cancel; the price is. A payment that arrives after its Order could no longer take it still goes back whole, this fee
// included (refundOrphan). These checks prove every one of those sentences against Stripe's test copy.
// N1 what the client pays, N2 what is recorded, N3 the card-fee refund is untouched, N4 a cancel, N5 a late payment,
// N6 a top-up, N7 the lost first line is rebuilt with the right amounts, N8 a slip in the fee row pauses payments,
// N9 a quote without the payout-fee line (the row switched off), N10 the amounts must add up.
import { DB, STRIPE, CONNECT, hooks, req, signed, call, mk, moneyOut, reset, fns, fund, pay, past } from "./fn-harness.mjs";
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const info = (m) => out.push("info       " + m);
const fx = await fns();
const fundRow = (c) => DB.order_payments.find(p => p.order_id === c.id && p.kind === "fund");
const refundsOf = (pi) => STRIPE.refunds.filter(r => r.payment_intent === pi);
const feeRefunds = (pi) => refundsOf(pi).filter(r => r.metadata.kind === "fee_surplus");
const chargeOf = (pi) => STRIPE.charges[STRIPE.intents[pi].latest_charge];
const events = (c, ev) => DB.order_events.filter(e => e.order_id === c.id && e.event === ev);
const expectConnect = (price, topup = false) => Math.ceil(price * CONNECT.percent / 100) + (topup ? 0 : CONNECT.fixed_cents);
const lines = (s) => { const P = s.params || {}; const l = []; for (let i = 0; P[`line_items[${i}][price_data][unit_amount]`] != null; i++) l.push({ name: P[`line_items[${i}][price_data][product_data][name]`], amount: +P[`line_items[${i}][price_data][unit_amount]`] }); return l; };

// ---------- N1: the EUR 100 Order — three lines on Stripe's page, and they add up ----------
{
  const c = mk({ amount_cents: 10000 });
  const r0 = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const s = STRIPE.sessions[c.stripe_checkout_id], L = lines(s), connect = expectConnect(10000);
  info(`N1 EUR 100 Order: lines ${JSON.stringify(L)}, total ${s.amount_total}`);
  vuln(r0.status !== 200 || L.length !== 3 || L[0].amount !== 10000 || L[2].name !== "Payout fee (Stripe)" || L[2].amount !== connect || L[1].name !== "Card fee",
    `N1a Stripe's page shows price, card fee and "Payout fee (Stripe)" ${connect} -> ${JSON.stringify(L)}`);
  vuln(s.amount_total !== 10000 + L[1].amount + connect || r0.json.total !== s.amount_total || r0.json.connect !== connect || r0.json.fee !== L[1].amount,
    `N1b the three lines add up to what is charged (${s.amount_total}) and to what the page is told (total ${r0.json.total}, fee ${r0.json.fee}, connect ${r0.json.connect})`);
  // the card fee is worked out on price + payout fee, so Stripe's percentage on the whole charge is covered
  const expectedCard = Math.ceil((10000 + connect + 25) / (1 - 3.25 / 100)) - (10000 + connect);
  vuln(L[1].amount !== expectedCard || L[1].amount < Math.ceil(s.amount_total * 3.25 / 100) + 25 - 1,
    `N1c the card fee ${L[1].amount} covers 3.25% + 25c of everything charged (${Math.ceil(s.amount_total * 3.25 / 100) + 25}): Cuvori is never short`);
  reset();
}
// ---------- N2: after payment — recorded in its own field, the Order holds the price, Cuvori keeps the payout fee ----------
{
  const c = mk({ amount_cents: 10000 }); const before = STRIPE.balance; const f = await fund(fx, c);
  const s = f.session, pi = s.payment_intent, row = fundRow(c), connect = expectConnect(10000), actual = chargeOf(pi).balance_transaction.fee;
  const cardFee = s.amount_total - 10000 - connect;
  vuln(f.webhook.status !== 200 || c.status !== "funded" || c.funded_cents !== 10000 || c.fee_cents !== cardFee || c.connect_cents !== connect,
    `N2a the Order: status ${c.status}, holds ${c.funded_cents} (the price), card fee ${c.fee_cents}, payout fee ${c.connect_cents} (must be ${cardFee} and ${connect}, in their own fields)`);
  vuln(!row || row.amount_cents !== 10000 || row.fee_cents !== cardFee || row.connect_cents !== connect,
    `N2b the payment line: amount ${row && row.amount_cents}, card fee ${row && row.fee_cents}, payout fee ${row && row.connect_cents} (must be ${10000}, ${cardFee}, ${connect})`);
  const ev = events(c, "funded")[0];
  vuln(!ev || ev.data.connect_cents !== connect || ev.data.total_cents !== s.amount_total || ev.data.fee_cents !== cardFee,
    `N2c the history line carries all three -> ${ev && JSON.stringify(ev.data)}`);
  // what Cuvori's balance holds: the price, plus the payout fee (kept, to pay Stripe's monthly Connect bill), nothing of the card fee
  vuln(STRIPE.balance - before !== 10000 + connect,
    `N2d Cuvori's balance after the card-fee refund: ${STRIPE.balance - before} (must be price ${10000} + payout fee ${connect} = ${10000 + connect}; the card fee ${cardFee} went to Stripe (${actual}) and back to the client (${cardFee - actual}))`);
  reset();
}
// ---------- N3: the card-fee refund is exactly what it was: the surplus of the card fee only, never a cent of the payout fee ----------
{
  const c = mk({ amount_cents: 10000 }); const f = await fund(fx, c);
  const s = f.session, pi = s.payment_intent, row = fundRow(c), connect = expectConnect(10000), actual = chargeOf(pi).balance_transaction.fee, cardFee = s.amount_total - 10000 - connect;
  vuln(!row || row.fee_refund_cents !== cardFee - actual || feeRefunds(pi).length !== 1 || feeRefunds(pi)[0].amount !== cardFee - actual,
    `N3a the card-fee refund is ${feeRefunds(pi).map(r => r.amount).join(",")} (must be card fee ${cardFee} - real card cost ${actual} = ${cardFee - actual}, not a cent more)`);
  vuln(refundsOf(pi).length !== 1 || events(c, "fee_refunded").length !== 1,
    `N3b exactly one refund at Stripe after payment (${refundsOf(pi).length}) and one 'fee_refunded' line (${events(c, "fee_refunded").length}): nothing else is refunded`);
  reset();
}
// ---------- N4: the Order is cancelled — the price goes back, the card fee and the payout fee do not ----------
{
  const c = mk({ amount_cents: 10000 }); const f = await fund(fx, c); const pi = f.session.payment_intent, connect = expectConnect(10000);
  const before = { balance: STRIPE.balance, refunds: refundsOf(pi).length };
  const r = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id } }));
  const back = refundsOf(pi).filter(x => x.metadata.kind !== "fee_surplus");
  vuln(r.status !== 200 || c.status !== "refunded" || back.length !== 1 || back[0].amount !== 10000 || moneyOut(c).refunded !== 10000,
    `N4a the freelancer gives the Order back -> ${r.status}, Order ${c.status}, refunded to the client ${moneyOut(c).refunded} (must be the price ${10000}, as before)`);
  vuln(STRIPE.balance !== before.balance - 10000 || refundsOf(pi).length !== before.refunds + 1,
    `N4b Cuvori's balance moved by ${STRIPE.balance - before.balance} (must be -${10000}: the payout fee ${connect} stays, as the Stripe page said), refunds made: ${refundsOf(pi).length - before.refunds} (must be 1)`);
  reset();
}
// ---------- N5: a payment that arrives after the Order could no longer take it goes back whole, payout fee included ----------
{
  const c = mk({ amount_cents: 10000 });
  const r0 = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  c.status = "cancelled";                                            // the Order is closed while the client is on Stripe's page
  const paid = pay(c.stripe_checkout_id, {}); const pi = paid.payment_intent;
  const w = await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: paid } })));
  const kept = chargeOf(pi).balance_transaction ? chargeOf(pi).balance_transaction.fee : null;
  const late = refundsOf(pi).filter(x => x.metadata.kind === "late_payment");
  info(`N5 paid ${paid.amount_total} into a closed Order: hold ${STRIPE.intents[pi].status}, late refunds ${JSON.stringify(late.map(x => x.amount))}, released events ${events(c, "late_payment_released").length}`);
  // hold first, charge after: a hold on a closed Order is released, nothing charged — or, if it was already charged, everything but Stripe's card cost comes back
  const releasedUncharged = STRIPE.intents[pi].status === "canceled" && refundsOf(pi).length === 0;
  const refundedWhole = late.length === 1 && late[0].amount === paid.amount_total - kept;
  vuln(r0.status !== 200 || w.status !== 200 || !(releasedUncharged || refundedWhole) || c.funded_cents,
    `N5 a payment for a closed Order -> ${releasedUncharged ? "the hold was released, nothing charged" : refundedWhole ? `refunded whole minus Stripe's card cost (${late[0].amount} of ${paid.amount_total}, payout fee included)` : `WRONG: hold ${STRIPE.intents[pi].status}, refunds ${JSON.stringify(refundsOf(pi).map(x => [x.metadata.kind, x.amount]))}`}; Order holds ${c.funded_cents || 0}`);
  reset();
}
// ---------- N6: a top-up pays the percentage only; the Order's own fields keep the first payment's fees ----------
{
  const c = mk({ amount_cents: 10000 }); const f = await fund(fx, c); const first = { fee: c.fee_cents, connect: c.connect_cents };
  c.amount_cents = 15000; c.price = 150;                               // a EUR 50 increase both sides agreed to
  const r0 = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const s = STRIPE.sessions[c.stripe_checkout_id], L = lines(s), connect = expectConnect(5000, true);
  vuln(r0.status !== 200 || r0.json.kind !== "topup" || L.length !== 3 || L[0].amount !== 5000 || L[2].amount !== connect || connect !== Math.ceil(5000 * CONNECT.percent / 100),
    `N6a the top-up page: ${JSON.stringify(L)} (the payout fee must be ${Math.ceil(5000 * CONNECT.percent / 100)}: 0.25% of the increase, no fixed part)`);
  const paid = pay(c.stripe_checkout_id, {}); const w = await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: paid } })));
  const top = DB.order_payments.find(p => p.order_id === c.id && p.kind === "fund" && p.provider_ref === paid.payment_intent);
  vuln(w.status !== 200 || c.funded_cents !== 15000 || !top || top.amount_cents !== 5000 || top.connect_cents !== connect || c.fee_cents !== first.fee || c.connect_cents !== first.connect,
    `N6b after the top-up: Order holds ${c.funded_cents} (must be 15000); its line: amount ${top && top.amount_cents}, payout fee ${top && top.connect_cents}; the Order's own fields still describe the first payment (card fee ${c.fee_cents}, payout fee ${c.connect_cents})`);
  const ev = events(c, "topped_up")[0];
  vuln(!ev || ev.data.connect_cents !== connect || ev.data.total_cents !== paid.amount_total, `N6c the top-up history line -> ${ev && JSON.stringify(ev.data)}`);
  reset();
}
// ---------- N7: the first payment's line was lost; the hourly run rebuilds it from Stripe's record, with the right split ----------
{
  const c = mk({ amount_cents: 10000 }); const f = await fund(fx, c); const row = fundRow(c), connect = expectConnect(10000), cardFee = c.fee_cents;
  DB.order_payments.splice(DB.order_payments.indexOf(row), 1);        // the line is gone
  c.funded_at = past(1);                                               // old enough for the repair (2 minutes)
  const r = await call(fx.autoRelease, req("POST", "x", {}));
  const again = fundRow(c);
  vuln(!again || again.amount_cents !== 10000 || again.fee_cents !== cardFee || again.connect_cents !== connect || !/added from Stripe/.test(again.note || ""),
    `N7 the lost first line rebuilt from Stripe's payment of ${f.session.amount_total} -> amount ${again && again.amount_cents}, card fee ${again && again.fee_cents}, payout fee ${again && again.connect_cents} (must be 10000, ${cardFee}, ${connect}) [hourly run ${r.status}]`);
  reset();
}
// ---------- N8: a slip in the fee table's payout-fee row pauses payments instead of reaching a card ----------
{
  const c = mk({ amount_cents: 10000 }); const was = { ...CONNECT };
  CONNECT.percent = 25;                                                // 25 instead of 0.25
  const r1 = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  CONNECT.percent = was.percent; CONNECT.fixed_cents = 2100;           // EUR 21 instead of EUR 2.10
  const r2 = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  Object.assign(CONNECT, was);
  const r3 = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  vuln(r1.status !== 503 || r1.json.code !== "payments_paused" || r2.status !== 503 || r2.json.code !== "payments_paused" || !/payout-fee row/.test(r1.json.error || "") || r3.status !== 200,
    `N8 the payout-fee row at 25% -> ${r1.status} ${r1.json.code}; at EUR 21 fixed -> ${r2.status} ${r2.json.code}; corrected -> ${r3.status} (must be paused, paused, 200)`);
  reset();
}
// ---------- N9: a quote without the payout-fee line (the connect row switched off in the fee table, or a page made before
// v50 whose metadata has no connect_cents) is still confirmed and recorded, with 0. Note: the database must have v50 before
// these functions run (order_quote's p_topup argument), so v50 is run first, then the files are uploaded. ----------
{
  const c = mk({ amount_cents: 10000 });
  hooks.rpc = async (fn, args) => fn === "order_quote" ? [200, (() => { const t = Math.ceil((args.p_price_cents + 25) / (1 - 3.25 / 100)); return { price_cents: args.p_price_cents, processing_cents: t - args.p_price_cents, cuvori_cents: 0, total_cents: t, currency: "EUR", payer: "client", percent: 3.25, fixed_cents: 25 }; })()] : null;
  const f = await fund(fx, c); const row = fundRow(c), s = f.session;
  vuln(f.webhook.status !== 200 || c.status !== "funded" || c.funded_cents !== 10000 || c.connect_cents !== 0 || !row || row.connect_cents !== 0 || lines(s).length !== 2 || s.amount_total !== 10000 + c.fee_cents,
    `N9 a quote without the payout-fee line: two lines, total ${s.amount_total}, Order ${c.status} holds ${c.funded_cents}, payout fee recorded as ${c.connect_cents} / ${row && row.connect_cents} (must be 0 and 0)`);
  reset();
}
// ---------- N10: the quote's lines must add up, or nothing is charged ----------
{
  const c = mk({ amount_cents: 10000 });
  hooks.rpc = async (fn) => fn === "order_quote" ? [200, { price_cents: 10000, processing_cents: 370, connect_cents: 235, cuvori_cents: 0, total_cents: 10700, currency: "EUR", payer: "client", percent: 3.25, fixed_cents: 25 }] : null;
  const r = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  vuln(r.status === 200 || c.stripe_checkout_id, `N10 a quote whose three lines (10000 + 370 + 235) do not add up to its total (10700) -> ${r.status} (must be refused; no page made: ${c.stripe_checkout_id || "none"})`);
  reset();
}
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
