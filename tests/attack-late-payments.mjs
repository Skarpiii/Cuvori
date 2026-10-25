// Late payments: a payment that comes in after its Order can no longer take it.
// Cuvori charges a card only when the Order can still take the payment; otherwise the hold is released and nothing is
// charged. Only when the Order changes in the instant between that check and the charge is the payment charged and then
// sent back (all but the card fee Stripe kept). If Stripe refused that refund (the client had opened a chargeback on the
// card payment, or the balance was too low for a refund), Cuvori answered Stripe with an error and Stripe sent the payment
// again for about 3 days, then stopped: the client's money stayed with Cuvori, with no note on the Order, no history line,
// and nothing in the hourly run. Now the Order's note says so (the admin panel's "Needs a hand"), and the hourly run tries
// the refund again until the money is back on the card; then the note goes. A payment that was recorded on its Order
// after all is never refunded by it.
// And Cuvori's webhook released card holds on Stripe pages that are not Cuvori's (something else sold through the same
// Stripe account, "authorize now, charge later"), and could refund a payment on such a page. Now a page that carries no
// Cuvori Order is left alone.
// L1 a hold on a page that is not Cuvori's, L2 a paid page that is not Cuvori's, L3 a late payment's refund refused and
// then taken by the hourly run, L4 the payment refunded by hand in Stripe meanwhile, L5 the payment recorded on its Order
// after all, L6 a Cuvori page whose Order is gone (as before), L7 Stripe's card fee not known yet at first (as before),
// L8 a late payment from the other Stripe mode (test money after launch day) is left for keys that can refund it.
// Run: node tests/attack-late-payments.mjs
import { DB, STRIPE, hooks, req, call, mk, fund, pay, signed, reset, fns, uuid } from "./fn-harness.mjs";
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const logs = []; const realError = console.error; console.error = (...a) => logs.push(a.map(String).join(" "));
const fx = await fns();
const shown = (s) => JSON.stringify(s ?? null).slice(0, 170);
const checkout = (c) => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
const webhook = (s) => call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: s } })));
const hourly = () => call(fx.autoRelease, req("POST", "x", {}));
const refundsOf = (pi) => STRIPE.refunds.filter(r => r.payment_intent === pi);
const backOf = (pi) => refundsOf(pi).reduce((a, r) => a + r.amount, 0);
const chargeOf = (pi) => STRIPE.charges[STRIPE.intents[pi].latest_charge];
const lines = (c, ev) => DB.order_events.filter(e => e.order_id === c.id && e.event === ev).length;
const REFUSED = [400, { error: { type: "invalid_request_error", code: "charge_disputed", message: "Charge ch_x has been charged back; cannot issue a refund." } }];
const foreign = (id, paid, ref) => {
  const pi = "pi_Other" + id, ch = "ch_Other" + id;
  STRIPE.intents[pi] = { id: pi, amount: 5000, status: paid ? "succeeded" : "requires_capture", capture_method: paid ? "automatic" : "manual", latest_charge: ch };
  STRIPE.charges[ch] = { id: ch, currency: "eur", amount: 5000, amount_refunded: 0, captured: !!paid, payment_intent: pi, balance_transaction: paid ? { id: "txn_" + id, fee: 100, net: 4900, status: "available" } : null };
  return { id: "cs_Other" + id, object: "checkout.session", mode: "payment", status: "complete", payment_status: paid ? "paid" : "unpaid", payment_intent: pi, client_reference_id: ref, amount_total: 5000, currency: "eur", metadata: {} };
};
// a late payment: the Order is cancelled in the instant between the check and the charge
const late = async (refund) => {
  const c = mk({ amount_cents: 10000 }); await checkout(c); const s = pay(c.stripe_checkout_id);
  hooks.stripe = async (p, m) => { if (m === "POST" && /\/capture$/.test(p)) { c.status = "cancelled"; return null; } if (m === "POST" && p === "/refunds") return refund ? refund() : null; return null; };
  const w = await webhook(s);
  return { c, s, w };
};

{ // L1 a hold on a Stripe page that is not Cuvori's (no Order on it): left alone
  const s = foreign("Hold1", false, null), s2 = foreign("Hold2", false, uuid());
  const w = await webhook(s), w2 = await webhook(s2);
  vuln(w.status !== 200 || STRIPE.intents[s.payment_intent].status !== "requires_capture" || w2.status !== 200 || STRIPE.intents[s2.payment_intent].status !== "requires_capture",
    `L1 a hold on a page that is not Cuvori's -> webhook ${w.status}, the hold ${STRIPE.intents[s.payment_intent].status}; with an id that is no Cuvori Order -> ${w2.status}, ${STRIPE.intents[s2.payment_intent].status} (must stay a hold: never charged, never released by Cuvori)`);
}
{ // L2 a paid Stripe page that is not Cuvori's, with an id that is no Cuvori Order: never refunded by Cuvori
  const s = foreign("Paid1", true, uuid());
  const w = await webhook(s);
  vuln(w.status !== 200 || refundsOf(s.payment_intent).length !== 0, `L2 a paid page that is not Cuvori's -> webhook ${w.status}, refunds ${refundsOf(s.payment_intent).length} (must be none)`);
}
{ // L3 the late payment's refund is refused: the Order says so, the hourly run tries again until it is back on the card
  let refuse = true;
  const { c, s, w } = await late(() => refuse ? REFUSED : null);
  const w2 = await webhook(s);
  const noted = c.money_error;
  const h1 = await hourly(); const stillNoted = c.money_error, after1 = backOf(s.payment_intent);
  refuse = false;
  const h2 = await hourly(); reset();
  const kept = chargeOf(s.payment_intent).balance_transaction.fee;
  const h3 = await hourly();
  vuln(w.status !== 500 || w2.status !== 500 || !String(noted || "").startsWith(`late payment ${s.payment_intent} `) || !/check by hand/.test(noted) || stillNoted !== noted && !String(stillNoted || "").startsWith(`late payment ${s.payment_intent} `)
       || after1 !== 0 || h2.status !== 200 || backOf(s.payment_intent) !== s.amount_total - kept || refundsOf(s.payment_intent).length !== 1 || c.money_error != null || lines(c, "late_payment_refunded") !== 1 || h3.status !== 200 || refundsOf(s.payment_intent).length !== 1,
    `L3 the late payment's refund is refused -> webhook ${w.status}, ${w2.status}; the Order's note ${shown(noted)}; hourly run while still refused: back ${after1}; then the refund goes through -> back ${backOf(s.payment_intent)} of ${s.amount_total} (card fee ${kept} kept), refunds ${refundsOf(s.payment_intent).length}, note ${shown(c.money_error)}, history lines ${lines(c, "late_payment_refunded")}; the next hourly run refunds nothing more (${refundsOf(s.payment_intent).length})`);
}
{ // L4 meanwhile you refunded it by hand in Stripe: the hourly run refunds nothing more, and the note goes
  const { c, s } = await late(() => REFUSED); reset();
  const ch = chargeOf(s.payment_intent); STRIPE.refunds.push({ id: "re_byhand1", amount: ch.amount, metadata: {}, payment_intent: s.payment_intent, charge: ch.id, status: "succeeded" }); ch.amount_refunded = ch.amount;
  const noted = c.money_error;
  await hourly();
  vuln(!String(noted || "").startsWith(`late payment ${s.payment_intent} `) || backOf(s.payment_intent) !== ch.amount || c.money_error != null,
    `L4 refunded by hand in Stripe meanwhile -> refunded ${backOf(s.payment_intent)} of ${ch.amount} (only your refund), note before ${shown(noted)}, after ${shown(c.money_error)} (must go)`);
}
{ // L5 the payment was recorded on its Order after all: the hourly run never refunds it
  const { c, s } = await late(() => REFUSED); reset();
  const noted = c.money_error;
  Object.assign(c, { status: "funded", stripe_payment_intent: s.payment_intent, funded_cents: 10000 });   // recorded on the Order meanwhile
  await hourly();
  vuln(!String(noted || "").startsWith(`late payment ${s.payment_intent} `) || refundsOf(s.payment_intent).length !== 0 || String(c.money_error || "").includes(`late payment ${s.payment_intent} `),
    `L5 the payment was recorded on its Order after all -> refunds ${refundsOf(s.payment_intent).length} (must be none), note ${shown(c.money_error)} (the late payment's note must go)`);
}
{ // L6 as before: a Cuvori page whose Order is gone — its hold is released (nothing charged)
  const c = mk({ amount_cents: 10000 }); await checkout(c); const s = pay(c.stripe_checkout_id); DB.contracts.splice(DB.contracts.indexOf(c), 1);
  const w = await webhook(s);
  vuln(w.status !== 200 || STRIPE.intents[s.payment_intent].status !== "canceled", `L6 a Cuvori page whose Order is gone -> webhook ${w.status}, the hold ${STRIPE.intents[s.payment_intent].status} (must be released, as before)`);
}
{ // L7 as before: Stripe's card fee is not known yet at first — nothing goes back for now, then all but the fee; the note goes again
  const c = mk({ amount_cents: 10000 }); await checkout(c); const s = pay(c.stripe_checkout_id, { feeLater: true }); const ch = chargeOf(s.payment_intent);
  hooks.stripe = async (p, m) => { if (m === "POST" && /\/capture$/.test(p)) { hooks.stripe = null; c.status = "cancelled"; } return null; };
  const w1 = await webhook(s); hooks.stripe = null; const early = backOf(s.payment_intent);
  ch.balance_transaction = ch._bt; const w2 = await webhook(s);
  vuln(w1.status === 200 || early || w2.status !== 200 || backOf(s.payment_intent) !== s.amount_total - ch._bt.fee || c.money_error != null,
    `L7 Stripe's fee not known yet -> first ${w1.status} with ${early} back; then ${w2.status}: ${backOf(s.payment_intent)} back (must be ${s.amount_total - ch._bt.fee}); note ${shown(c.money_error)} (none left)`);
  reset();
}

{ // L8 a late payment waiting from the other Stripe mode: these keys cannot refund it, so the hourly run leaves it (no error every hour)
  const { c, s } = await late(() => REFUSED); reset();
  const row = DB.money_keys.find(k => k.scope === `late_refund:${s.payment_intent}`);
  const k = row ? JSON.parse(row.key) : null; if (row) row.key = JSON.stringify({ ...k, mode: "live" });
  let asked = 0; hooks.stripe = async (p) => { if (p.includes(s.payment_intent)) asked++; return null; };
  const h = await hourly(); reset();
  vuln(!row || k.mode !== "test" || asked !== 0 || refundsOf(s.payment_intent).length !== 0 || JSON.stringify(h.json).includes(s.payment_intent),
    `L8 a late payment waiting from live mode while the keys are test keys -> remembered with its mode: ${k && k.mode}; Stripe asked about it ${asked} times, refunds ${refundsOf(s.payment_intent).length}, in the hourly run's failures: ${JSON.stringify(h.json).includes(s.payment_intent)} (must be left alone)`);
}

console.error = realError;
console.log(out.join("\n"));
const bad = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${bad} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(bad ? 1 : 0);
