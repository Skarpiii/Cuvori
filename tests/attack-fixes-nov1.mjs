// Fixes of 1 November: regression checks for the medium and low findings of the payment audit, and its high one on two
// chargebacks at once.
// F4a two chargebacks open at once (the first payment and the price increase): the second was refused (the webhook failed
//     until Stripe stopped sending it) and, once the first was decided, the admin could pay out the increase the bank had
//     taken back. Now the second is noted on the Order, nothing is paid out while it is open, and it becomes the Order's
//     chargeback when the first is decided. F4b the same with the second decided for the client while the first was
//     still open: it is counted once the first is decided. F4c an Order already paid out: both chargebacks are covered.
//     F4d Stripe can't be asked when the first is decided: nothing is paid out until the second is taken over. F4e the
//     first is won but its re-payment to the freelancer can't be made yet: it is made first, then the second is taken
//     over (by the hourly run) and covered.
// F7a a refund decision after the bank took back the price increase (lost chargeback): Stripe refused a refund of that
//     payment every hour; now only payments that can still be refunded are used. F7b a 'release' decision whose
//     freelancer was banned afterwards can be replaced by a refund. F7c it can't be replaced once part of it moved at
//     Stripe, also when Cuvori's records don't show it yet.
// F8  the bank's inquiry on an Order's payment pauses automatic release (whole Order and milestones); the client can
//     still approve.
// F9a 55 due Orders whose freelancer is banned no longer hold back another Order's automatic release.
// F9b 55 approved milestones of Orders paid directly no longer hold back a protected Order's milestone payout.
// F6  an accepted price increase that was never paid: the hourly run does not release what is held and close the Order.
// F12a a payment that went back to the card (a late payment) is never recorded as the Order's payment when the Order
//     later waits for the same amount. F12b the same through the client's return from Stripe with the old page. F12c a
//     payment Stripe received less of than the page's total is not recorded either.
// L1a an admin can't decide an Order on which they are the client or the freelancer. L1b a decision on an Order that is
//     neither in dispute nor stuck needs a written note of at least 10 characters. L1c a stuck release is still turned
//     into a refund without a note.
// L3  pressing Fund again while the earlier page was paid but not recorded yet records that payment instead of making
//     a second page (the client was charged twice).
// L5  Stripe's fee on a payment charged days after its hold: a finished Fees report that ends before the charge no longer
//     stops Cuvori from asking for a newer one.
// L11 stripe-status gives the settings notes only to an admin; Fund no longer tells the client that the freelancer is
//     banned.
// Run: node tests/attack-fixes-nov1.mjs
import { DB, STRIPE, DBQ, F, users, hooks, req, signed, call, mk, past, moneyOut, reset, fns, fund, pay, uuid, stripeHandle, finishReport, onlyDue } from "./fn-harness.mjs";
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const realError = console.error; console.error = () => {};
const fx = await fns();
const lib = await import(F + "../lib/cuvori.mjs");
const chargeOf = (pi) => STRIPE.charges[STRIPE.intents[pi].latest_charge];
const cbEvent = (type, ch, extra = {}) => signed({ type, data: { object: { id: "dp_" + ch.id, object: "dispute", charge: ch.id, payment_intent: ch.payment_intent, amount: extra.amount || ch.amount, currency: "eur", status: extra.status || "needs_response", reason: "fraudulent", created: Math.floor(Date.now() / 1000) } } });
const webhook = (ev) => call(fx.webhook, req("POST", "x", ev));
const openCb = async (ch) => { STRIPE.disputes[ch.id] = { status: "needs_response" }; return (await webhook(cbEvent("charge.dispute.created", ch))).status; };
const closeCb = async (ch, outcome) => { STRIPE.disputes[ch.id].status = outcome; return (await webhook(cbEvent("charge.dispute.closed", ch, { status: outcome }))).status; };
const checkout = (c, body = {}, token = "tok_cl") => call(fx.checkout, req("POST", "x", { token, body: { contract_id: c.id, ...body } }));
const paidPage = (s) => webhook(signed({ type: "checkout.session.completed", data: { object: s } }));
const topUp = async (c, cents) => { c.amount_cents = cents; await checkout(c); const s = pay(c.stripe_checkout_id); await paidPage(s); return s; };
const NOTE = "Cuvori looked at the chat and the delivery.";
const resolve = (c, decision, extra = {}, token = "tok_adm") => call(fx.resolve, req("POST", "x", { token, body: { contract_id: c.id, decision, ...extra } }));
const release = (c, body = {}) => call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, ...body } }));
const hourly = () => call(fx.autoRelease, req("POST", "x", {}));
const refundedOn = (pi) => STRIPE.refunds.filter(r => r.payment_intent === pi && r.metadata.kind !== "fee_surplus").reduce((a, r) => a + r.amount, 0);
const said = (c) => JSON.stringify((c.money_error || "none").slice(0, 120));
STRIPE.balance = 1_000_000;                                           // other clients' money in the platform balance

{ // F4a the first payment and the price increase charged back at once; the first is won, the second lost
  const c = mk(); const f = await fund(fx, c); const s = await topUp(c, 12000); c.status = "delivered";
  const ch1 = chargeOf(f.session.payment_intent), ch2 = chargeOf(s.payment_intent);
  const a1 = await openCb(ch1), a2 = await openCb(ch2);
  const noted = (c.money_error || "").includes("dp_" + ch2.id), whileBoth = said(c);
  const b1 = await closeCb(ch1, "won");
  const early = await resolve(c, "release", { note: NOTE }); const paidEarly = moneyOut(c).transferred, recorded = c.chargeback_id === "dp_" + ch2.id && c.chargeback_status === "open";
  const b2 = await closeCb(ch2, "lost");
  const late = await resolve(c, "release", { note: NOTE });
  vuln([a1, a2, b1, b2].some(x => x !== 200) || !noted || early.status === 200 || paidEarly !== 0 || !recorded || late.status !== 200 || moneyOut(c).transferred !== 10000 || c.status !== "completed",
    `F4a €100 + €20 charged back at once -> webhooks ${[a1, a2, b1, b2]} (must all be 200); note while both open ${whileBoth} (must name the second); the first won, the admin's 'release' ${early.status} paid ${paidEarly} (must be refused, 0: the second is still open); the second recorded as the Order's chargeback: ${recorded}; the second lost, 'release' ${late.status} -> the freelancer got ${moneyOut(c).transferred} (must be 10000: the bank took the €20 back), Order ${c.status}`);
  reset();
}
{ // F4b the second chargeback is decided for the client while the first is still open
  const c = mk(); const f = await fund(fx, c); const s = await topUp(c, 12000); c.status = "delivered";
  const ch1 = chargeOf(f.session.payment_intent), ch2 = chargeOf(s.payment_intent);
  const a1 = await openCb(ch1), a2 = await openCb(ch2), b2 = await closeCb(ch2, "lost");
  const noted = (c.money_error || "").includes("dp_" + ch2.id);
  const b1 = await closeCb(ch1, "won");
  const r = await resolve(c, "release", { note: NOTE });
  vuln([a1, a2, b2, b1].some(x => x !== 200) || !noted || r.status !== 200 || moneyOut(c).transferred !== 10000 || c.refunded_cents !== 2000 || (c.money_error || "").includes("dp_" + ch2.id),
    `F4b the second lost while the first is open -> webhooks ${[a1, a2, b2, b1]} (must all be 200), noted: ${noted}; the first won, then 'release' ${r.status} -> the freelancer got ${moneyOut(c).transferred}, counted back to the client ${c.refunded_cents} (must be 10000, 2000); note now ${said(c)} (the second's note gone)`);
  reset();
}
{ // F4c an Order already paid out: both payments charged back, the first lost, the second won
  const c = mk(); const f = await fund(fx, c); const s = await topUp(c, 12000); c.status = "delivered"; await release(c);
  const ch1 = chargeOf(f.session.payment_intent), ch2 = chargeOf(s.payment_intent);
  const a1 = await openCb(ch1), a2 = await openCb(ch2), b1 = await closeCb(ch1, "lost"), b2 = await closeCb(ch2, "won");
  vuln([a1, a2, b1, b2].some(x => x !== 200) || moneyOut(c).transferred !== 2000 || c.chargeback_id !== "dp_" + ch2.id || c.chargeback_status !== "won",
    `F4c €120 paid out, then €100 and €20 charged back at once (the €100 lost, the €20 won) -> webhooks ${[a1, a2, b1, b2]} (must all be 200); the freelancer keeps ${moneyOut(c).transferred} (must be 2000); the Order's chargeback ${c.chargeback_id === "dp_" + ch2.id ? "the second" : c.chargeback_id} ${c.chargeback_status}`);
  reset();
}
{ // F4d when the first is decided Stripe can't be asked about the other chargebacks: nothing is paid out until it can
  const c = mk(); const f = await fund(fx, c); const s = await topUp(c, 12000); c.status = "delivered";
  const ch1 = chargeOf(f.session.payment_intent), ch2 = chargeOf(s.payment_intent);
  await openCb(ch1); await openCb(ch2);
  hooks.stripe = async (path, method) => (path === "/disputes" && method === "GET" ? [500, { error: { message: "Stripe is having a problem", type: "api_error" } }] : null);
  STRIPE.disputes[ch1.id].status = "won"; const b1 = (await webhook(cbEvent("charge.dispute.closed", ch1, { status: "won" }))).status;
  hooks.stripe = null;
  const mid = await resolve(c, "release", { note: NOTE }); const paidMid = moneyOut(c).transferred;
  const again = (await webhook(cbEvent("charge.dispute.closed", ch1, { status: "won" }))).status;     // Stripe sends it again
  vuln(b1 === 200 || mid.status === 200 || paidMid !== 0 || again !== 200 || c.chargeback_id !== "dp_" + ch2.id || c.chargeback_status !== "open",
    `F4d the first won while Stripe can't list the Order's chargebacks -> webhook ${b1} (must fail, so Stripe sends it again); 'release' meanwhile ${mid.status}, paid ${paidMid} (must be refused, 0); sent again -> ${again}, the Order's chargeback ${c.chargeback_id === "dp_" + ch2.id ? "the second" : c.chargeback_id} ${c.chargeback_status} (must be the second, open)`);
  STRIPE.disputes[ch2.id].status = "won"; await webhook(cbEvent("charge.dispute.closed", ch2, { status: "won" }));
  reset();
}
{ // F4e paid out; both charged back; the first won while the freelancer's Stripe account can't take its re-payment; the
  // hourly run pays them again first, then takes the second over; the second is lost
  const c = mk(); const f = await fund(fx, c); const s = await topUp(c, 12000); c.status = "delivered"; await release(c); onlyDue(c);
  const ch1 = chargeOf(f.session.payment_intent), ch2 = chargeOf(s.payment_intent);
  await openCb(ch1); await openCb(ch2);
  const acct = STRIPE.accounts.acct_1EditorAAAAAAAA; acct.payouts_enabled = false;
  const b1 = await closeCb(ch1, "won"); const mid = { has: moneyOut(c).transferred, cb: c.chargeback_id === "dp_" + ch1.id ? "the first" : c.chargeback_id, blocked: lib.chargebackOpen(c) };
  acct.payouts_enabled = true; const pd = DB.payout_details.find(p => p.id === users.ed.id); pd.stripe_payouts_enabled = true;
  await hourly(); const after = { has: moneyOut(c).transferred, taken: c.chargeback_id === "dp_" + ch2.id && c.chargeback_status === "open" };
  const b2 = await closeCb(ch2, "lost");
  vuln(b1 !== 200 || b2 !== 200 || mid.has !== 2000 || !mid.blocked || after.has !== 10000 || !after.taken || moneyOut(c).transferred !== 10000 || c.refunded_cents !== 2000,
    `F4e €120 paid out, both charged back, the first won with the re-payment refused -> ${b1}; meanwhile the freelancer has ${mid.has}, the Order's chargeback ${mid.cb}, payouts stopped: ${mid.blocked} (must be 2000, stopped); after the hourly run ${after.has}, the second taken over: ${after.taken} (must be 10000, yes); the second lost (${b2}) -> the freelancer keeps ${moneyOut(c).transferred}, back to the client ${c.refunded_cents} (must be 10000, 2000)`);
  reset();
}
{ // F7a the bank took the price increase back (lost chargeback); the admin refunds the rest to the client
  const c = mk(); await fund(fx, c); const s = await topUp(c, 12000); c.status = "delivered";
  const ch2 = chargeOf(s.payment_intent); const a = await openCb(ch2), b = await closeCb(ch2, "lost");
  const r = await resolve(c, "refund", { note: NOTE }); const h = await hourly();
  vuln(a !== 200 || b !== 200 || r.status !== 200 || c.status !== "refunded" || refundedOn(c.stripe_payment_intent) !== 10000 || refundedOn(s.payment_intent) !== 0,
    `F7a the €20 increase charged back and lost, then the admin's 'refund' -> ${r.status} ${JSON.stringify(r.json && r.json.error || "")}, Order ${c.status}; back to the card from the first payment ${refundedOn(c.stripe_payment_intent)}, from the increase ${refundedOn(s.payment_intent)} (must be 200, refunded, 10000, 0)`);
  reset();
}
{ // F7b a 'release' decision, the freelancer banned after it: the admin turns it into a refund
  const c = mk(); await fund(fx, c); c.status = "disputed"; c.disputed_at = past(); c.dispute_by = users.cl.id;
  users.ed.banned = true;
  const r1 = await resolve(c, "release"); const stuck = c.status;
  const r2 = await resolve(c, "refund");
  users.ed.banned = false;
  vuln(r1.status === 200 || stuck !== "resolving" || r2.status !== 200 || c.status !== "refunded" || moneyOut(c).refunded !== 10000 || moneyOut(c).transferred !== 0,
    `F7b 'release' to a banned freelancer (${r1.status}, Order ${stuck}), then the admin's 'refund' -> ${r2.status} ${JSON.stringify(r2.json && r2.json.error || "")}; Order ${c.status}, back to the client ${moneyOut(c).refunded}, paid out ${moneyOut(c).transferred} (must be 200, refunded, 10000, 0)`);
  reset();
}
{ // F7c a 'split' whose transfer Stripe made but whose answer was lost: it can't be replaced, it is finished
  const c = mk(); await fund(fx, c); c.status = "disputed"; c.disputed_at = past(); c.dispute_by = users.cl.id;
  hooks.stripe = async (path, method, p) => { if (method === "POST" && path === "/transfers") { hooks.stripe = null; stripeHandle(path, method, p); const e = new TypeError("fetch failed"); e.cause = { code: "UND_ERR_SOCKET" }; throw e; } return null; };
  const r1 = await resolve(c, "split", { editor_percent: 50 }); hooks.stripe = null;
  const recordsShow = !!c.stripe_transfer_id || (c.released_cents || 0) > 0;
  const r2 = await resolve(c, "refund");
  const r3 = await resolve(c, "split", { editor_percent: 50 });
  vuln(r1.status === 200 || recordsShow || r2.status === 200 || r3.status !== 200 || moneyOut(c).transferred !== 5000 || moneyOut(c).refunded !== 5000,
    `F7c a split whose transfer Stripe made with the answer lost (${r1.status}; the records show it: ${recordsShow}), then 'refund' -> ${r2.status} (must be refused), then the split again -> ${r3.status}; paid out ${moneyOut(c).transferred}, back to the client ${moneyOut(c).refunded} (must be 5000, 5000)`);
  reset();
}
{ // F8 the bank's inquiry on the Order's payment: no automatic release (whole Order, milestone); the client can still approve
  const c = mk(); const f = await fund(fx, c); c.status = "delivered"; c.auto_release_at = past(2); onlyDue(c);
  const ch = chargeOf(f.session.payment_intent);
  STRIPE.disputes[ch.id] = { status: "warning_needs_response" };          // the inquiry as Stripe lists it (the hourly run asks)
  const w = (await webhook(cbEvent("charge.dispute.created", ch, { status: "warning_needs_response" }))).status;
  await hourly(); const auto = c.status, autoPaid = moneyOut(c).transferred;
  const m = mk({ amount_cents: 10000, has_milestones: true }); const fm = await fund(fx, m); m.status = "funded";
  const ms = { id: uuid(), order_id: m.id, title: "m1", amount_cents: 6000, status: "submitted", auto_release_at: past(2), position: 1 };
  DB.order_milestones.push(ms, { id: uuid(), order_id: m.id, title: "m2", amount_cents: 4000, status: "pending", position: 2 });
  STRIPE.disputes[chargeOf(fm.session.payment_intent).id] = { status: "warning_under_review" };
  await webhook(cbEvent("charge.dispute.created", chargeOf(fm.session.payment_intent), { status: "warning_under_review" }));
  await hourly(); const msAuto = ms.status;
  const r = await release(c);
  vuln(w !== 200 || auto !== "delivered" || autoPaid !== 0 || msAuto !== "submitted" || r.status !== 200 || c.status !== "completed",
    `F8 an inquiry on a delivered Order's payment (${w}) -> the hourly run left it ${auto}, paid ${autoPaid} (must be delivered, 0); a milestone due during an inquiry -> ${msAuto} (must stay submitted); the client's own approval -> ${r.status}, ${c.status} (must go through)`);
  ms.status = "released"; m.status = "completed";
  reset();
}
{ // F9a 55 Orders of a banned freelancer, due for days, and one Order of another freelancer due now
  DBQ.paging = true;
  const c = mk(); await fund(fx, c); c.status = "delivered"; c.auto_release_at = past(1); onlyDue(c);
  users.ed2.banned = true;
  const pile = []; for (let i = 0; i < 55; i++) pile.push(mk({ editor: users.ed2.id, status: "delivered", funded_cents: 10000, auto_release_at: past(48 + i) }));
  const h = await hourly();
  vuln(h.status !== 200 || c.status !== "completed" || moneyOut(c).transferred !== 10000,
    `F9a 55 due Orders of a banned freelancer ahead of one due Order -> hourly ${h.status}; that Order ${c.status}, paid ${moneyOut(c).transferred} (must be completed, 10000)`);
  for (const x of pile) x.status = "completed";
  users.ed2.banned = false; DBQ.paging = false;
  reset();
}
{ // F9b 55 approved milestones of Orders paid directly (never a transfer) and one approved milestone never paid out
  DBQ.paging = true;
  const c = mk({ amount_cents: 10000, has_milestones: true }); await fund(fx, c); c.status = "funded"; onlyDue(c);
  const d = mk({ payment_mode: "direct", status: "paid", has_milestones: true });
  for (let i = 0; i < 55; i++) DB.order_milestones.push({ id: uuid(), order_id: d.id, title: "d" + i, amount_cents: 100, status: "approved", approved_at: past(200 + i), transfer_ref: null, position: i + 1 });
  const m = { id: uuid(), order_id: c.id, title: "m1", amount_cents: 6000, status: "approved", approved_at: past(2), transfer_ref: null, position: 1 };
  DB.order_milestones.push(m, { id: uuid(), order_id: c.id, title: "m2", amount_cents: 4000, status: "pending", position: 2 });
  const h = await hourly();
  vuln(h.status !== 200 || m.status !== "released" || moneyOut(c).transferred !== 6000,
    `F9b 55 approved milestones of direct-payment Orders ahead of one approved milestone never paid out -> hourly ${h.status}; that milestone ${m.status}, paid ${moneyOut(c).transferred} (must be released, 6000)`);
  for (const x of DB.order_milestones) if (x.status !== "released") x.status = "released";
  c.status = "completed"; DBQ.paging = false;
  reset();
}
{ // F6 an accepted price increase never paid in: the hourly run does not release what is held and close the Order
  const c = mk(); await fund(fx, c); c.amount_cents = 12000; c.status = "delivered"; c.auto_release_at = past(2); onlyDue(c);
  const h = await hourly();
  vuln(h.status !== 200 || c.status !== "delivered" || moneyOut(c).transferred !== 0,
    `F6 €100 held, a €20 increase accepted but never paid, the review window over -> hourly ${h.status}; Order ${c.status}, paid out ${moneyOut(c).transferred} (must stay delivered, 0)`);
  c.status = "completed";
  reset();
}
{ // F12a a late payment that went back to the card is never recorded when the Order later waits for the same amount
  const c = mk(); await checkout(c); const s = pay(c.stripe_checkout_id);
  hooks.stripe = async (p, m) => { if (m === "POST" && /\/capture$/.test(p)) { hooks.stripe = null; c.status = "cancelled"; } return null; };
  await paidPage(s); hooks.stripe = null;
  const back = refundedOn(s.payment_intent);
  c.status = "accepted";                                                  // the Order waits for €100 again
  const w = await paidPage(s);                                            // Stripe sends the old page's notice again
  vuln(back <= 0 || w.status !== 200 || c.status !== "accepted" || c.funded_cents || c.stripe_payment_intent === s.payment_intent || refundedOn(s.payment_intent) !== back,
    `F12a a payment sent back to the card (${back} of ${s.amount_total}), the Order waiting for the same amount again, the old page delivered again -> ${w.status}; Order ${c.status}, paid in ${c.funded_cents} (must stay accepted, nothing paid in); refunded ${refundedOn(s.payment_intent)} (must stay ${back})`);
  c.status = "cancelled";
  reset();
}
{ // F12b the same through the client's return from Stripe, naming the old page
  const c = mk(); await checkout(c); const s = pay(c.stripe_checkout_id);
  hooks.stripe = async (p, m) => { if (m === "POST" && /\/capture$/.test(p)) { hooks.stripe = null; c.status = "cancelled"; } return null; };
  await paidPage(s); hooks.stripe = null;
  const back = refundedOn(s.payment_intent);
  c.status = "accepted";
  const k = await checkout(c, { lang: "de" });                            // a new page for the Order
  const r = await call(fx.confirm, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, session_id: s.id } }));
  vuln(back <= 0 || r.status !== 200 || r.json.result !== "unpaid" || c.status !== "accepted" || c.funded_cents || refundedOn(s.payment_intent) !== back,
    `F12b the old page (sent back to the card) named on return -> ${r.status} ${JSON.stringify(r.json)} (must check the Order's new page: unpaid); new page ${k.status}; Order ${c.status}, paid in ${c.funded_cents} (must stay accepted, nothing paid in)`);
  c.status = "cancelled";
  reset();
}
{ // F12c Stripe says it received less than the page's total (the hold charged only in part): not recorded as the payment
  const c = mk(); await checkout(c); const s = pay(c.stripe_checkout_id);
  hooks.stripe = async (p, m) => { if (m === "POST" && /\/capture$/.test(p)) { hooks.stripe = null; const out = stripeHandle(p, m, new URLSearchParams()); STRIPE.intents[s.payment_intent].amount_received = s.amount_total - 5000; return out; } return null; };
  const w = await paidPage(s); hooks.stripe = null;
  vuln(c.status !== "accepted" || c.funded_cents || c.stripe_payment_intent === s.payment_intent,
    `F12c the card charged ${s.amount_total - 5000} of a ${s.amount_total} page -> ${w.status}; Order ${c.status}, paid in ${c.funded_cents} (must not be recorded as the Order's payment)`);
  c.status = "cancelled";
  reset();
}
{ // L1a an admin who is the client, or the freelancer, on the Order can't decide it
  const c = mk({ client: users.adm.id }); await fund(fx, c, { token: "tok_adm" }); c.status = "disputed"; c.disputed_at = past(); c.dispute_by = users.ed.id;
  const r = await resolve(c, "refund");
  const d = mk({ editor: users.adm.id, status: "disputed", funded_cents: 10000, stripe_payment_intent: "pi_madeUpAdminOrder", disputed_at: past(), dispute_by: users.cl.id });
  const r2 = await resolve(d, "release");
  vuln(r.status !== 403 || c.status !== "disputed" || moneyOut(c).refunded !== 0 || r2.status !== 403 || d.status !== "disputed",
    `L1a an admin decides an Order they are the client of -> ${r.status}, Order ${c.status}, refunded ${moneyOut(c).refunded}; one they are the freelancer of -> ${r2.status}, ${d.status} (must be 403, nothing moved)`);
  c.status = "completed"; d.status = "completed";
  reset();
}
{ // L1b a decision on an Order that is neither in dispute nor stuck needs a written note
  const c = mk(); await fund(fx, c);
  const r1 = await resolve(c, "refund"), r2 = await resolve(c, "refund", { note: "  too short " });
  const before = moneyOut(c).refunded;
  const r3 = await resolve(c, "refund", { note: "The client and the freelancer both asked to stop the Order." });
  vuln(r1.status === 200 || r2.status === 200 || before !== 0 || r3.status !== 200 || c.status !== "refunded",
    `L1b an admin's 'refund' on a funded Order with no dispute -> without a note ${r1.status}, with a short one ${r2.status} (must be refused, nothing moved: ${before}); with a real note ${r3.status}, Order ${c.status} (must be 200, refunded)`);
  reset();
}
{ // L1c control: a release stuck before its transfer is still turned into a refund, no note needed
  const c = mk(); await fund(fx, c);
  Object.assign(c, { status: "releasing", resolution: "release", split_editor_cents: 10000, refund_cents: 0, resolved_by: users.cl.id, resolved_at: past(1) });
  const r = await resolve(c, "refund");
  vuln(r.status !== 200 || c.status !== "refunded" || moneyOut(c).refunded !== 10000,
    `L1c control: a release stuck before its transfer, the admin's 'refund' with no note -> ${r.status}, Order ${c.status}, back ${moneyOut(c).refunded} (normal: 200, refunded, 10000)`);
  reset();
}
{ // L3 the first page was paid (charged) but the payment not recorded yet; the client presses Fund again
  const c = mk(); await checkout(c); const s = pay(c.stripe_checkout_id);
  let failOnce = true;
  hooks.db = async (method, table, search, body) => {
    if (failOnce && method === "PATCH" && table === "contracts" && String(body || "").includes('"funded_at"')) { failOnce = false; return new Response(JSON.stringify({ message: "canceling statement due to statement timeout" }), { status: 500, headers: { "content-type": "application/json" } }); }
    return null;
  };
  const w = await paidPage(s); hooks.db = null;
  const chargedFirst = STRIPE.intents[s.payment_intent].status === "succeeded";
  const again = await checkout(c, { lang: "de" });
  if (again.status === 200) { const s2 = pay(c.stripe_checkout_id); await paidPage(s2); await paidPage(s); }      // the client pays the second page; Stripe sends the first again
  const pages = Object.values(STRIPE.sessions).filter(x => x.client_reference_id === c.id);
  const charged = pages.filter(x => x.payment_intent && STRIPE.intents[x.payment_intent].status === "succeeded").length;
  const lost = pages.reduce((a, x) => a + (x.payment_intent ? refundedOn(x.payment_intent) : 0), 0);
  vuln(w.status === 200 || !chargedFirst || again.status === 200 || charged !== 1 || c.status !== "funded" || c.stripe_payment_intent !== s.payment_intent || lost !== 0,
    `L3 the first page charged but not recorded (${w.status}), Fund pressed again -> ${again.status} ${JSON.stringify(again.json && again.json.code || "")} (must not make a new page); payments charged ${charged} (must be 1), sent back ${lost}; Order ${c.status} by the first page: ${c.stripe_payment_intent === s.payment_intent}`);
  reset();
}
{ // L5 Stripe's fee on a payment charged two days after its hold was placed (standalone fees)
  STRIPE.reports = { end: 0, runs: [], instant: true }; for (const k of [...STRIPE.idem.keys()]) if (k.startsWith("feereport:")) STRIPE.idem.delete(k);
  const now = Math.floor(Date.now() / 1000), DAY = 86400;
  const c = mk(); const f = await fund(fx, c, { standalone: true, fee: 175 }); c.status = "completed";
  const pi = f.session.payment_intent, ch = chargeOf(pi), row = DB.order_payments.find(p => p.order_id === c.id && p.kind === "fund");
  ch.created = now - 5 * DAY; ch.balance_transaction.created = now - 2 * DAY;                          // the hold 5 days ago, charged 2 days ago
  for (const r of STRIPE.feeRows) if (r.incurred_by === ch.id) r.created = now - 2 * DAY;            // the fee is incurred when the card is charged
  row.created_at = new Date((now - 5 * DAY) * 1000).toISOString();
  const old = { id: "frr_oldFeeReport", object: "reporting.report_run", report_type: "all_fees.incurred_at.itemized.2", status: "pending", result: null, created: now - 3 * DAY, parameters: { interval_start: now - 35 * DAY, interval_end: now - 3 * DAY } };
  STRIPE.reports.runs.push(old); finishReport(old);                       // a finished report that ends a day before the charge
  STRIPE.reports.end = now - 3600;
  await hourly(); await hourly();
  const back = STRIPE.refunds.filter(r => r.payment_intent === pi && r.metadata.kind === "fee_surplus");
  const asked = STRIPE.reports.runs.filter(r => r !== old).length;
  vuln(row.provider_fee_cents !== 175 || back.length !== 1 || asked !== 1,
    `L5 a hold charged 2 days later, a finished Fees report ending before the charge -> Stripe's fee ${row.provider_fee_cents} (must be 175), card-fee refunds ${back.length} (must be 1), newer reports asked for ${asked} (must be 1)`);
  STRIPE.reports = { end: 0, runs: [], instant: false };
  reset();
}
{ // L11 stripe-status: the settings notes only for an admin; Fund doesn't say the freelancer is banned
  lib.SETTINGS_NOTES.push("SITE_URL is not written as a full web address; Cuvori corrected it.");
  const anon = await call(fx.status, req("GET", "x"));
  const someone = await call(fx.status, req("GET", "x", { token: "tok_cl" }));
  const admin = await call(fx.status, req("GET", "x", { token: "tok_adm" }));
  lib.SETTINGS_NOTES.pop();
  const shows = (r) => JSON.stringify(r.json || {}).includes("SITE_URL");
  const c = mk(); users.ed.banned = true; const r = await checkout(c); users.ed.banned = false;
  vuln(anon.status !== 200 || shows(anon) || shows(someone) || !shows(admin) || anon.json.escrow !== true || anon.json.autoReleaseDays !== 7 || anon.json.stripeKeyOk !== true || anon.json.databaseKeyOk !== true,
    `L11a stripe-status -> to anyone ${JSON.stringify(anon.json)}, to a client: notes shown ${shows(someone)}, to an admin: notes shown ${shows(admin)} (must be only for the admin; what the page needs stays)`);
  vuln(r.status !== 409 || r.json.code !== "freelancer_unavailable" || /cannot receive|banned|suspend/i.test(r.json.error || ""),
    `L11b Fund for a banned freelancer -> ${r.status} ${JSON.stringify(r.json)} (must be 409 freelancer_unavailable, saying only that this freelancer can't take payments right now)`);
  c.status = "cancelled";
  reset();
}

console.error = realError;
console.log(out.join("\n"));
const bad = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${bad} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(bad ? 1 : 0);
