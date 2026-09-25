// Money attack suite, round two: the races and retries found in the second review.
// Two deliveries of the same payment at the same moment, a client who clicks Fund twice, refunds made
// in the Stripe dashboard, chargebacks on part-released milestone orders, and Stripe not answering in
// the middle of a reversal or a re-payment. Each check names the scenario in plain words.
import { DB, STRIPE, users, hooks, urls, req, signed, call, mk, past, moneyOut, reset, onlyDue, fns, fund, pay, uuid } from "./fn-harness.mjs";
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const info = (m) => out.push("info       " + m);
const fx = await fns();
const ledger = (c, kind) => DB.order_payments.filter(p => p.order_id === c.id && (!kind || p.kind === kind));
const events = (c) => DB.order_events.filter(e => e.order_id === c.id).map(e => e.event);
const cbEvent = (type, ch, extra = {}) => signed({ type, data: { object: { id: extra.id || "dp_" + ch.id, object: "dispute", charge: ch.id, payment_intent: ch.payment_intent, amount: extra.amount || ch.amount, status: extra.status || "needs_response", ...extra } } });
const chargeOf = (pi) => STRIPE.charges[STRIPE.intents[pi].latest_charge];
const chargeEvent = (ch) => signed({ type: "charge.refunded", data: { object: { id: ch.id, object: "charge", payment_intent: ch.payment_intent, amount: ch.amount, amount_refunded: ch.amount_refunded, refunded: ch.amount_refunded >= ch.amount } } });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const hook = (fn) => { hooks.stripe = fn; };
const reversalsOf = (c) => { const ids = new Set(STRIPE.transfers.filter(t => t.contract === c.id).map(t => t.id)); return STRIPE.reversals.filter(r => ids.has(r.transfer)).length; };

// ---------- C1: the client clicks "Fund" twice a few seconds apart (same half hour): both must open a Checkout page
{
  const c = mk();
  const realNow = Date.now; const t0 = realNow();
  const bucket = Math.floor(t0 / 1800e3); const base = bucket * 1800e3 + 60e3;                 // one minute into a half-hour, so both clicks share it
  Date.now = () => base;
  const r1 = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  Date.now = () => base + 5000;                                                                  // five seconds later
  const r2 = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  Date.now = realNow;
  vuln(r1.status !== 200 || r2.status !== 200, `C1a Fund clicked twice 5 s apart -> HTTP ${r1.status} then ${r2.status} ${r2.json && r2.json.error || ""} (both must open the payment page)`);
  info(`C1b same Checkout page both times: ${!!(r1.json && r2.json && r1.json.url === r2.json.url)}`);
  const s = STRIPE.sessions[c.stripe_checkout_id] || {};
  const exp = Number(s.params && s.params.expires_at) || 0; const mins = Math.round((exp - base / 1000) / 60);
  vuln(exp && (mins < 30 || mins > 24 * 60), `C1c the page expires ${mins} min after the click (Stripe allows 30 min to 24 h)`);
  reset();
}
// ---------- C2: a top-up is paid; Stripe's webhook and the page's own check arrive at the same moment
{
  const c = mk(); await fund(fx, c); c.amount_cents = 12000;                                   // amendment accepted (+€20)
  const r0 = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const s = pay(c.stripe_checkout_id);
  // the ledger line is written a moment after the counter moves: make that moment visible
  hooks.db = async (method, table) => { if (method === "POST" && table === "order_payments") await sleep(30); return null; };
  const [w, k] = await Promise.all([
    call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: s } }))),
    call(fx.confirm, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } })),
  ]);
  hooks.db = null;
  const m = moneyOut(c);
  vuln(w.status !== 200 || k.status !== 200 || c.funded_cents !== 12000 || m.refunded !== 0 || ledger(c, "fund").length !== 2 || c.status !== "funded",
    `C2a top-up: webhook ${w.status} + page check ${k.status} at once -> funded=${c.funded_cents} (must be 12000), refunded back=${m.refunded} (must be 0), fund rows=${ledger(c, "fund").length}, status=${c.status}`);
  // whatever happened above, the refund webhook for our own refund (if one was made) must not close the order
  const ch = chargeOf(s.payment_intent);
  if (ch.amount_refunded > 0) { const rw = await call(fx.webhook, req("POST", "x", chargeEvent(ch))); vuln(c.status !== "funded", `C2b the refund's own webhook -> ${rw.status}, status=${c.status} (must stay funded), refunded_cents=${c.refunded_cents}`); }
  else info("C2b no refund was made, nothing to mirror");
  const w2 = await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: s } })));
  vuln(c.funded_cents !== 12000 || ledger(c, "fund").length !== 2, `C2c the same top-up webhook again -> ${w2.status}, funded=${c.funded_cents}, fund rows=${ledger(c, "fund").length}`);
  reset();
}
// ---------- C3: refunds that Cuvori did not make (Stripe dashboard) — and refunds Cuvori did make
{
  // C3a: Cuvori refunds an unwanted payment (orphan). Its charge.refunded webhook must leave the order alone.
  const c = mk(); const f = await fund(fx, c); c.amount_cents = 12000;
  await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const sA = c.stripe_checkout_id; STRIPE.idem.clear();
  await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const sB = c.stripe_checkout_id;
  const pB = pay(sB); await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: pB } })));
  STRIPE.sessions[sA].status = "open"; const pA = pay(sA); await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: pA } })));
  const chA = chargeOf(pA.payment_intent);
  vuln(c.funded_cents !== 12000 || chA.amount_refunded !== pA.amount_total, `C3a a second top-up paid by mistake -> funded=${c.funded_cents}, the extra payment went back=${chA.amount_refunded === pA.amount_total}`);
  const rw = await call(fx.webhook, req("POST", "x", chargeEvent(chA)));
  vuln(c.status !== "funded" || (c.refunded_cents || 0) !== 0 || ledger(c, "refund").length !== 0, `C3b the refund's webhook (Cuvori's own refund) -> ${rw.status}, status=${c.status} (must stay funded), refunded_cents=${c.refunded_cents || 0}, refund rows=${ledger(c, "refund").length}`);
  // C3c: someone refunds the TOP-UP charge in the Stripe dashboard: the order is short of money — flag it, do not call the whole order refunded
  const chB = chargeOf(pB.payment_intent);
  STRIPE.refunds.push({ id: "re_dash1", amount: chB.amount, metadata: {}, payment_intent: pB.payment_intent, charge: chB.id, status: "succeeded" }); chB.amount_refunded = chB.amount;
  const rw2 = await call(fx.webhook, req("POST", "x", chargeEvent(chB)));
  vuln(c.status === "refunded" || c.status === "completed", `C3c dashboard refund of the top-up charge -> ${rw2.status}, status=${c.status} (must not be 'refunded': the first €100 is still held), refunded_cents=${c.refunded_cents || 0}`);
  info(`C3d ...it is ${c.status}${c.dispute_reason ? " — " + c.dispute_reason : ""}${c.money_error ? " — " + c.money_error : ""}`);
  reset();
  // C3e: the main charge refunded in full in the dashboard (the old behaviour, still right)
  const c2 = mk(); const f2 = await fund(fx, c2); const ch2 = chargeOf(f2.session.payment_intent);
  STRIPE.refunds.push({ id: "re_dash2", amount: ch2.amount, metadata: {}, payment_intent: f2.session.payment_intent, charge: ch2.id, status: "succeeded" }); ch2.amount_refunded = ch2.amount;
  const rw3 = await call(fx.webhook, req("POST", "x", chargeEvent(ch2)));
  vuln(c2.status !== "refunded" || c2.refunded_cents !== 10000, `C3e dashboard refund of the whole payment -> ${rw3.status}, status=${c2.status}, refunded_cents=${c2.refunded_cents}`);
  const rw4 = await call(fx.webhook, req("POST", "x", chargeEvent(ch2)));
  vuln(ledger(c2, "refund").length !== 1, `C3f the same refund webhook again -> ${rw4.status}, refund rows=${ledger(c2, "refund").length}`);
  reset();
}
// ---------- C4: two milestones approved at the same moment on an order that is only partly funded
{
  const c = mk({ amount_cents: 30000, has_milestones: true }); await fund(fx, c); c.status = "funded";
  c.funded_cents = 15000; STRIPE.charges[c.stripe_charge_id].amount = 15000;                   // only half arrived so far (a top-up is still open)
  const ms = [1, 2, 3].map(i => ({ id: uuid(), order_id: c.id, title: "m" + i, amount_cents: 10000, status: "submitted", position: i })); DB.order_milestones.push(...ms);
  const rs = await Promise.all(ms.slice(0, 2).map(m => call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, milestone_id: m.id } }))));
  const m = moneyOut(c);
  vuln(m.transferred > 15000 || c.released_cents > 15000, `C4a two €100 milestones approved at once with €150 held -> HTTP ${rs.map(r => r.status).join("/")}, transferred=${m.transferred} (must be ≤ 15000), released_cents=${c.released_cents}`);
  vuln(rs.every(r => r.status !== 200) || m.transferred !== 10000, `C4b ...and one of them must go through: transferred=${m.transferred}`);
  const again = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, milestone_id: ms[1].id } }));
  info(`C4c the second one tried again later -> ${again.status} ${again.json && again.json.error || ""}`);
  reset();
}
// ---------- C5: chargeback on a milestone order where one milestone was already paid out
{
  const c = mk({ amount_cents: 30000, has_milestones: true }); const f = await fund(fx, c); c.status = "funded";
  const ms = [1, 2, 3].map(i => ({ id: uuid(), order_id: c.id, title: "m" + i, amount_cents: 10000, status: i === 1 ? "submitted" : "pending", position: i })); DB.order_milestones.push(...ms);
  const r = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, milestone_id: ms[0].id } }));
  const ch = chargeOf(f.session.payment_intent); STRIPE.disputes[ch.id] = { status: "needs_response" };
  const w = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.created", ch)));           // the bank pulls the whole payment
  const m = moneyOut(c);
  vuln(r.status !== 200 || w.status !== 200 || c.status !== "disputed" || m.transferred !== 0,
    `C5a chargeback for the whole €300 after €100 was paid out -> release ${r.status}, webhook ${w.status}, status=${c.status}, freelancer keeps=${m.transferred} (must be 0: pulled back until the bank decides), released_cents=${c.released_cents}`);
  STRIPE.disputes[ch.id].status = "lost";
  const l = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.closed", ch, { status: "lost" })));
  vuln(l.status !== 200 || c.status !== "refunded" || c.refunded_cents !== 30000 || moneyOut(c).transferred !== 0, `C5b ...lost -> ${l.status}, status=${c.status}, refunded_cents=${c.refunded_cents} (must be 30000), freelancer keeps=${moneyOut(c).transferred}`);
  reset();
}
// ---------- C6: Stripe does not answer while Cuvori pulls a transfer back after a chargeback — the retry must finish it, once
{
  const c = mk(); const f = await fund(fx, c); c.status = "delivered";
  await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const ch = chargeOf(f.session.payment_intent); STRIPE.disputes[ch.id] = { status: "needs_response" };
  let cut = 1;
  hook(async (path, method) => { if (method === "POST" && /\/reversals$/.test(path) && cut-- > 0) throw new TypeError("fetch failed"); });
  const w1 = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.created", ch)));
  info(`C6a reversal cut off by the network -> webhook answered ${w1.status} (500 makes Stripe retry), money_error=${c.money_error || ""}`);
  const w2 = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.created", ch)));           // Stripe's retry
  const w3 = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.created", ch)));           // and once more
  vuln(reversalsOf(c) !== 1 || moneyOut(c).transferred !== 0 || c.released_cents !== 0, `C6b after the retries (${w2.status}/${w3.status}) -> reversals=${reversalsOf(c)} (must be exactly 1), freelancer keeps=${moneyOut(c).transferred}, released_cents=${c.released_cents}, money_error=${c.money_error || ""}`);
  reset();
}
// ---------- C7: the bank sides with Cuvori, but Stripe does not answer when the freelancer is paid again
{
  const c = mk(); const f = await fund(fx, c); c.status = "delivered";
  await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const ch = chargeOf(f.session.payment_intent); STRIPE.disputes[ch.id] = { status: "needs_response" };
  await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.created", ch)));
  STRIPE.disputes[ch.id].status = "won";
  let cut = 1;
  hook(async (path, method) => { if (method === "POST" && path === "/transfers" && cut-- > 0) throw new TypeError("fetch failed"); });
  const w1 = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.closed", ch, { status: "won" })));
  info(`C7a re-payment cut off by the network -> webhook answered ${w1.status}, money_error=${c.money_error || ""}`);
  const w2 = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.closed", ch, { status: "won" })));
  const w3 = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.closed", ch, { status: "won" })));
  vuln(moneyOut(c).transferred !== 10000 || c.released_cents !== 10000, `C7b after the retries (${w2.status}/${w3.status}) -> freelancer paid again=${moneyOut(c).transferred} (must be 10000, once), released_cents=${c.released_cents}, money_error=${c.money_error || ""}`);
  vuln(STRIPE.transfers.filter(t => t.contract === c.id).length !== 2, `C7c transfers on this order=${STRIPE.transfers.filter(t => t.contract === c.id).length} (the release and one re-payment)`);
  reset();
}
// ---------- C8: a milestone approved while the admin is settling the whole order (dispute decided) — never more than what is held
{
  const c = mk({ amount_cents: 30000, has_milestones: true }); await fund(fx, c); c.status = "disputed"; c.dispute_by = users.cl.id; c.disputed_at = past();
  const ms = [1, 2, 3].map(i => ({ id: uuid(), order_id: c.id, title: "m" + i, amount_cents: 10000, status: "submitted", position: i })); DB.order_milestones.push(...ms);
  c.status = "funded";
  hook(async (path, method) => { if (method === "POST" && path === "/transfers") await sleep(20); });
  const [a, b] = await Promise.all([
    call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, milestone_id: ms[0].id } })),
    call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id } })),                 // the freelancer gives everything back at the same moment
  ]);
  const m = moneyOut(c);
  vuln(m.transferred + m.refunded > 30000, `C8 milestone approve (${a.status}) and freelancer cancel (${b.status}) at once -> transferred=${m.transferred} + refunded=${m.refunded} must not exceed the €300 held; status=${c.status}, money_error=${c.money_error || ""}`);
  reset();
}

console.log(out.join("\n"));
const bad = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${bad} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(bad ? 1 : 0);
