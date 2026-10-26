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
// A refund Stripe refuses for good (the client charged the payment back and the bank gave the money back to them) was tried
// every hour forever, and its note came back after "Mark as handled". Now the tries have a clear end:
// L9 a chargeback on the late payment: while the bank decides, Cuvori waits (no error every hour); decided for the client,
// the reminder goes and the note says so; decided for Cuvori, the refund is made. L10 "Mark as handled" also stops the tries.
// L11 the note never shows Cuvori's own "payments are paused: the Stripe key in Netlify…" sentence to the people on the
// Order. L12 an Order busy at that minute is left for the next hourly run at once, without waiting.
// And three more ends, from Stripe's guide to disputes: an inquiry (the bank only asks about the payment, before or instead
// of a chargeback) is answered by refunding right away — Cuvori used to wait, so the inquiry could turn into a chargeback
// and its fee; a chargeback for only part of the payment, decided for the client, still sends the rest back; and a lost
// chargeback that the bank later turns into a win for Cuvori ("late win") brings the money back to the card.
// L13 an inquiry, L14 a part chargeback decided for the client, L15 a late win, L16 the watch for a late win is quiet
// (once a day) and ends after 180 days.
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

// ---------- the tries have an end ----------
const disputed = (s, status) => { const ch = chargeOf(s.payment_intent); ch.disputed = true; STRIPE.disputes[ch.id] = { id: "dp_" + ch.id, status }; };
const refusedWhileDisputed = () => null;                                   // the test Stripe itself refuses a refund on a charge with a dispute not won
const reminded = (s) => DB.money_keys.some(k => k.scope === "late_refund:" + s.payment_intent);
const triedIn = (h, s) => JSON.stringify(h.json || {}).includes(s.payment_intent);
{ // L9 a chargeback on the late payment
  const res = {};
  for (const outcome of ["lost", "won"]) {
    const { c, s } = await late(() => REFUSED); reset();
    disputed(s, "needs_response");                                            // the client has charged it back; the bank is deciding
    const w = await webhook(s); const h1 = await hourly(); const waiting = c.money_error;
    STRIPE.disputes[chargeOf(s.payment_intent).id].status = outcome;         // the bank decides
    const h2 = await hourly(); const h3 = await hourly();
    res[outcome] = { w: w.status, waitingNote: waiting, h1Fails: triedIn(h1, s), h3Fails: triedIn(h3, s), note: c.money_error, reminded: reminded(s), back: backOf(s.payment_intent), refunds: refundsOf(s.payment_intent).length, total: s.amount_total, fee: chargeOf(s.payment_intent).balance_transaction.fee };
  }
  const L = res.lost, W = res.won;
  vuln(L.w !== 200 || !/chargeback/.test(L.waitingNote || "") || !/waits for the bank/.test(L.waitingNote || "") || L.h1Fails
       || !/went back to the client through their bank/.test(L.note || "") || L.refunds !== 0 || L.h3Fails
       || W.reminded || W.refunds !== 1 || W.back !== W.total - W.fee || W.note != null,
    `L9 a chargeback on the late payment -> while the bank decides: webhook ${L.w}, note ${shown(L.waitingNote)}, the hourly run reports it as failed: ${L.h1Fails}; decided for the client -> note ${shown(L.note)}, reminder kept: ${L.reminded}, refunds ${L.refunds}, still tried: ${L.h3Fails}; decided for Cuvori -> refunds ${W.refunds} of ${W.back} (paid ${W.total}, fee ${W.fee}), note ${shown(W.note)}, reminder kept: ${W.reminded}`);
}
{ // L10 you press "Mark as handled" on the note: the hourly run stops trying, and the note does not come back
  const { c, s } = await late(() => REFUSED);
  const noted = c.money_error; c.money_error = null;                         // Mark as handled (schema v55 empties the note)
  let asked = 0; hooks.stripe = async (p, m) => { if (m === "POST" && p === "/refunds") { asked++; return REFUSED; } return null; };
  const h = await hourly(); await hourly(); reset();
  vuln(!String(noted || "").startsWith(`late payment ${s.payment_intent} `) || asked !== 0 || c.money_error != null || reminded(s) || triedIn(h, s),
    `L10 "Mark as handled" on a late payment's note -> the hourly run tried the refund ${asked} times (must be 0), note ${shown(c.money_error)}, reminder kept: ${reminded(s)}`);
}
{ // L11 payments are paused by a key problem while the refund is tried: the note says it in plain words, not Cuvori's setting sentence
  const { c, s } = await late(() => REFUSED); reset();
  DB.site_settings.push({ key: "stripe_mode", value: "live" });             // keys and database in different modes: payments paused
  await webhook(s); await hourly(); const noted = c.money_error;
  DB.site_settings.splice(DB.site_settings.findIndex(r => r.key === "stripe_mode" && r.value === "live"), 1);
  await webhook(s).catch(() => {});                                          // the mode is read again
  vuln(/Netlify \(|STRIPE_SECRET_KEY|database is set to/.test(noted || "") || !/payments are paused/.test(noted || ""),
    `L11 payments paused by a key problem during the retry -> note ${shown(noted)} (must say "payments are paused" in plain words, without Cuvori's setting sentence)`);
}
{ // L12 the Order is busy when the hourly run comes: left for the next run at once, then refunded once
  const { c, s } = await late(() => REFUSED); reset();
  DB.money_keys.push({ scope: `lock:${c.id}`, key: "claim:busy", created_at: new Date().toISOString() });
  const t0 = Date.now(); await hourly(); const took = Date.now() - t0; const first = refundsOf(s.payment_intent).length;
  DB.money_keys.splice(DB.money_keys.findIndex(k => k.scope === `lock:${c.id}`), 1);
  await hourly();
  vuln(took > 2500 || first !== 0 || refundsOf(s.payment_intent).length !== 1, `L12 the Order busy during the hourly run -> the run took ${(took / 1000).toFixed(1)} s (must not wait), refunds ${first}; next run -> refunds ${refundsOf(s.payment_intent).length} (must be 1)`);
}

// ---------- an inquiry, a part chargeback, a late win ----------
const reminder = (s) => { const r = DB.money_keys.find(k => k.scope === "late_refund:" + s.payment_intent); return r ? { row: r, key: JSON.parse(r.key) } : null; };
const dayLater = (s, days = 1) => { const r = reminder(s); if (!r) return; for (const f of ["checked_at", "watch_until"]) if (r.key[f]) r.key[f] = new Date(Date.parse(r.key[f]) - days * 86400e3).toISOString(); r.row.key = JSON.stringify(r.key); };
{ // L13 the bank only asks about the payment (an inquiry): refunded right away, once, all but the card fee
  const res = [];
  for (const status of ["warning_needs_response", "warning_under_review"]) {
    const { c, s } = await late(() => REFUSED); reset();
    disputed(s, status);
    const h = await hourly(); await hourly();
    const fee = chargeOf(s.payment_intent).balance_transaction.fee;
    res.push({ status, refunds: refundsOf(s.payment_intent).length, back: backOf(s.payment_intent), want: s.amount_total - fee, note: c.money_error, reminded: !!reminder(s) });
  }
  vuln(res.some(r => r.refunds !== 1 || r.back !== r.want || r.note != null || r.reminded),
    `L13 an inquiry on the late payment -> ${res.map(r => `${r.status}: refunds ${r.refunds}, back ${r.back} (must be ${r.want}), note ${shown(r.note)}`).join("; ")} (must be refunded right away, once)`);
}
{ // L14 a chargeback for part of the payment (€30 of it), decided for the client: the rest goes back to the card
  const { c, s } = await late(() => REFUSED); reset();
  disputed(s, "lost"); STRIPE.disputes[chargeOf(s.payment_intent).id].amount = 3000;
  const h = await hourly(); await hourly();
  const fee = chargeOf(s.payment_intent).balance_transaction.fee, rest = s.amount_total - fee - 3000;
  vuln(refundsOf(s.payment_intent).length !== 1 || backOf(s.payment_intent) !== rest || !/30\.00 .*through their bank/.test(c.money_error || "") || !/(\d+\.\d\d) .*back to the card/.test(c.money_error || ""),
    `L14 a part chargeback (€30) decided for the client -> refunds ${refundsOf(s.payment_intent).length} of ${backOf(s.payment_intent)} (must be one of ${rest}: the rest, all but the card fee), note ${shown(c.money_error)}`);
}
{ // L15 a lost chargeback that the bank turns into a win for Cuvori later: the money goes back to the card, once
  const { c, s } = await late(() => REFUSED); reset();
  disputed(s, "lost");
  await hourly(); const watching = reminder(s);
  STRIPE.disputes[chargeOf(s.payment_intent).id].status = "won";            // the late win
  await hourly(); const sameDay = refundsOf(s.payment_intent).length;     // checked once a day
  dayLater(s); await hourly(); await hourly(); dayLater(s); await hourly();
  const fee = chargeOf(s.payment_intent).balance_transaction.fee;
  vuln(!watching || watching.key.state !== "watch" || sameDay !== 0 || refundsOf(s.payment_intent).length !== 1 || backOf(s.payment_intent) !== s.amount_total - fee || reminder(s) || String(c.money_error || "").includes(`late payment ${s.payment_intent} `),
    `L15 a late win -> watched: ${watching && watching.key.state}; refunds the same day ${sameDay}, after the next daily look ${refundsOf(s.payment_intent).length} of ${backOf(s.payment_intent)} (must be one of ${s.amount_total - fee}); reminder left: ${!!reminder(s)}, note ${shown(c.money_error)}`);
}
{ // L16 the watch for a late win is quiet: Stripe is asked once a day, nothing fails, and it ends after 180 days
  const { c, s } = await late(() => REFUSED); reset();
  disputed(s, "lost"); await hourly();
  let asked = 0; hooks.stripe = async (p, m, q) => { if (p.includes(s.payment_intent) || (p === "/disputes" && q && q.get("payment_intent") === s.payment_intent)) asked++; return null; };
  const runs = []; for (let i = 0; i < 3; i++) runs.push(await hourly());
  const askedSameDay = asked; dayLater(s); await hourly(); const askedNextDay = asked - askedSameDay;
  dayLater(s, 181); await hourly(); reset();
  vuln(askedSameDay !== 0 || askedNextDay < 1 || runs.some(h => JSON.stringify(h.json || {}).includes(s.payment_intent)) || reminder(s) || refundsOf(s.payment_intent).length !== 0,
    `L16 watching a lost chargeback -> Stripe asked ${askedSameDay} times in three runs the same day, ${askedNextDay} the next day; failures in the runs: ${runs.some(h => JSON.stringify(h.json || {}).includes(s.payment_intent))}; after 180 days the watch is ${reminder(s) ? "still on" : "over"}; refunds ${refundsOf(s.payment_intent).length}`);
}

console.error = realError;
console.log(out.join("\n"));
const bad = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${bad} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(bad ? 1 : 0);
