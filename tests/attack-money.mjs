// Money attack suite: every way a payment can go wrong — bank delays, failed transfers and refunds,
// chargebacks before and after release, top-ups, milestones under contention, missed webhooks,
// tampering, stuck states. Each check names the scenario in plain words.
import { createHash } from "node:crypto";
import { DB, STRIPE, users, hooks, urls, req, signed, sigFor, call, mk, past, moneyOut, reset, onlyDue, fns, fund, pay, uuid } from "./fn-harness.mjs";
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const info = (m) => out.push("info       " + m);
const fx = await fns();
const ledger = (c, kind) => DB.order_payments.filter(p => p.order_id === c.id && (!kind || p.kind === kind));
const events = (c) => DB.order_events.filter(e => e.order_id === c.id).map(e => e.event);
const cards = (c, ev) => DB.messages.filter(m => m.payload && m.payload.contract_id === c.id && (!ev || m.payload.event === ev));
const hook = (fn) => { hooks.stripe = fn; };
const cbEvent = (type, ch, extra = {}) => signed({ type, data: { object: { id: extra.id || "dp_" + ch.id, object: "dispute", charge: ch.id, payment_intent: ch.payment_intent, amount: extra.amount || ch.amount, status: extra.status || "needs_response", ...extra } } });
const chargeOf = (pi) => STRIPE.charges[STRIPE.intents[pi].latest_charge];

// ---------- B1: the plain path, checked at every step
{
  const c = mk(); const f = await fund(fx, c);
  vuln(f.webhook.status !== 200 || c.status !== "funded" || c.funded_cents !== 10000 || !c.stripe_charge_id || ledger(c, "fund").length !== 1 || !cards(c, "funded").length,
    `B1a fund: checkout ${f.checkout.status}, webhook ${f.webhook.status}, status=${c.status}, funded=${c.funded_cents}, charge=${!!c.stripe_charge_id}, ledger=${ledger(c, "fund").length}, card=${cards(c, "funded").length}`);
  const fee = ledger(c, "fund")[0]; info(`B1b ledger records the provider's real fee: fee_cents=${fee.fee_cents} provider_fee_cents=${fee.provider_fee_cents} charge_ref=${fee.charge_ref}`);
  c.status = "delivered";
  const r = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const t = STRIPE.transfers.find(x => x.contract === c.id);
  vuln(r.status !== 200 || c.status !== "completed" || c.released_cents !== 10000 || !t || t.amount !== 10000 || t.source_transaction !== c.stripe_charge_id,
    `B1c release: HTTP ${r.status}, status=${c.status}, released=${c.released_cents}, transfer=${t && t.amount} sourced to the charge=${!!(t && t.source_transaction)}`);
  reset();
}
// ---------- B2: top-up after an accepted amendment, then a whole release (two charges, one transfer would exceed the first)
{
  const c = mk(); await fund(fx, c);
  c.amount_cents = 12000; c.price = 120;                              // amendment accepted (+€20)
  const f2 = await fund(fx, c);
  vuln(f2.webhook.status !== 200 || c.funded_cents !== 12000 || ledger(c, "fund").length !== 2, `B2a top-up: checkout ${f2.checkout.status}, webhook ${f2.webhook.status}, funded=${c.funded_cents}, fund rows=${ledger(c, "fund").length}`);
  c.status = "delivered";
  const r = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const m = moneyOut(c);
  vuln(r.status !== 200 || c.status !== "completed" || m.transferred !== 12000, `B2b release €120 funded by two charges -> HTTP ${r.status} ${r.json && r.json.error || ""}, status=${c.status}, transferred=${m.transferred}, money_error=${c.money_error}`);
  reset();
}
// ---------- B3: top-up, then the freelancer cancels: the refund must go back to both payments
{
  const c = mk(); await fund(fx, c); c.amount_cents = 12000; await fund(fx, c);
  const r = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id } }));
  const m = moneyOut(c);
  vuln(r.status !== 200 || c.status !== "refunded" || m.refunded !== 12000, `B3 cancel after top-up -> HTTP ${r.status} ${r.json && r.json.error || ""}, status=${c.status}, refunded=${m.refunded} (needs 12000 across 2 payments), refunds=${STRIPE.refunds.filter(x => x.contract === c.id).length}`);
  reset();
}
// ---------- B4: a chargeback on the top-up payment (not the first one) must still be seen
{
  const c = mk(); await fund(fx, c); c.amount_cents = 12000; const f2 = await fund(fx, c); c.status = "delivered";
  const ch = chargeOf(f2.session.payment_intent); STRIPE.disputes[ch.id] = { status: "needs_response" };
  const r = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.created", ch, { amount: 2055 })));
  vuln(c.status !== "disputed", `B4 chargeback on the top-up charge -> webhook ${r.status}, status=${c.status} (must be disputed), chargeback=${c.chargeback_status}`);
  const r2 = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  vuln(r2.status === 200 || moneyOut(c).transferred > 0, `B4b client approve while a chargeback is open -> HTTP ${r2.status}, transferred=${moneyOut(c).transferred}`);
  reset();
}
// ---------- B5: two milestones released at the same moment: counters must not lose one
{
  const c = mk({ amount_cents: 30000, has_milestones: true }); await fund(fx, c); c.status = "funded";
  const ms = [1, 2, 3].map(i => ({ id: uuid(), order_id: c.id, title: "m" + i, amount_cents: 10000, status: "submitted", position: i })); DB.order_milestones.push(...ms);
  const rs = await Promise.all(ms.slice(0, 2).map(m => call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, milestone_id: m.id } }))));
  vuln(rs.some(r => r.status !== 200) || c.released_cents !== 20000 || moneyOut(c).transferred !== 20000, `B5a two milestones released concurrently -> HTTP ${rs.map(r => r.status).join("/")}, released_cents=${c.released_cents} (must be 20000), transferred=${moneyOut(c).transferred}`);
  // now the third: with a lost counter the code would think 20000 is still held and could over-release later
  const r3 = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, milestone_id: ms[2].id } }));
  const r4 = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, milestone_id: ms[2].id } }));
  vuln(moneyOut(c).transferred !== 30000 || c.status !== "completed" || c.released_cents !== 30000, `B5b third milestone (${r3.status}, retry ${r4.status}) -> transferred=${moneyOut(c).transferred}, status=${c.status}, released_cents=${c.released_cents}`);
  reset();
}
// ---------- B6: chargeback AFTER the money was released: recover it from the freelancer's account, then follow the outcome
{
  const c = mk(); const f = await fund(fx, c); c.status = "delivered";
  await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const ch = chargeOf(f.session.payment_intent); STRIPE.disputes[ch.id] = { status: "needs_response" };
  const r = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.created", ch)));
  const rev = STRIPE.reversals.length;
  vuln(r.status !== 200 || c.chargeback_status !== "open" || rev !== 1 || moneyOut(c).transferred !== 0, `B6a chargeback after release -> webhook ${r.status}, chargeback_status=${c.chargeback_status}, transfer reversed=${rev === 1}, freelancer keeps=${moneyOut(c).transferred}, released_cents=${c.released_cents}, client flagged=${DB.user_flags.some(f => f.user_id === c.client && f.contract_id === c.id)}`);
  const rr = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.created", ch)));
  vuln(STRIPE.reversals.length !== 1, `B6b the same chargeback event delivered again -> reversals=${STRIPE.reversals.length}`);
  // Cuvori wins the dispute (the client approved the work in the app): the freelancer is paid again
  STRIPE.disputes[ch.id].status = "won";
  const w = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.closed", ch, { status: "won" })));
  vuln(w.status !== 200 || c.chargeback_status !== "won" || moneyOut(c).transferred !== 10000 || c.status !== "completed" || c.released_cents !== 10000, `B6c dispute won -> ${w.status}, chargeback_status=${c.chargeback_status}, freelancer paid again=${moneyOut(c).transferred}, status=${c.status}, released_cents=${c.released_cents}`);
  const w2 = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.closed", ch, { status: "won" })));
  vuln(moneyOut(c).transferred !== 10000, `B6d 'won' delivered twice -> transferred=${moneyOut(c).transferred}`);
  reset();
}
// ---------- B6e: chargeback after release, LOST: the order ends refunded (by the bank), nothing else moves
{
  const c = mk(); const f = await fund(fx, c); c.status = "delivered";
  await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const ch = chargeOf(f.session.payment_intent); STRIPE.disputes[ch.id] = { status: "needs_response" };
  await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.created", ch)));
  STRIPE.disputes[ch.id].status = "lost";
  const w = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.closed", ch, { status: "lost" })));
  vuln(w.status !== 200 || c.status !== "refunded" || c.chargeback_status !== "lost" || moneyOut(c).transferred !== 0 || moneyOut(c).refunded !== 0 || c.refunded_cents !== 10000,
    `B6e dispute lost -> ${w.status}, status=${c.status}, chargeback=${c.chargeback_status}, transferred=${moneyOut(c).transferred}, our refunds=${moneyOut(c).refunded}, refunded_cents=${c.refunded_cents}, ledger=${ledger(c).map(p => p.kind).join(",")}`);
  reset();
}
// ---------- B7: chargeback while the money is still held: nobody can move it until the bank decides
{
  const c = mk(); const f = await fund(fx, c); c.status = "delivered";
  const ch = chargeOf(f.session.payment_intent); STRIPE.disputes[ch.id] = { status: "needs_response" };
  await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.created", ch)));
  const a = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "release" } }));
  const b = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "refund" } }));
  const d = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id } }));
  vuln([a, b, d].some(r => r.status === 200) || moneyOut(c).transferred || moneyOut(c).refunded, `B7a admin release ${a.status} / admin refund ${b.status} / freelancer cancel ${d.status} while a chargeback is open -> transferred=${moneyOut(c).transferred}, refunded=${moneyOut(c).refunded}, status=${c.status}`);
  onlyDue(c); c.auto_release_at = past(); await call(fx.autoRelease);
  vuln(moneyOut(c).transferred > 0, `B7b the hourly job while a chargeback is open -> transferred=${moneyOut(c).transferred}`);
  STRIPE.disputes[ch.id].status = "won";
  await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.closed", ch, { status: "won" })));
  const a2 = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "release" } }));
  vuln(a2.status !== 200 || moneyOut(c).transferred !== 10000 || c.status !== "completed", `B7c bank sided with Cuvori -> admin releases: ${a2.status}, transferred=${moneyOut(c).transferred}, status=${c.status}`);
  reset();
}
{
  const c = mk(); const f = await fund(fx, c); c.status = "delivered";
  const ch = chargeOf(f.session.payment_intent); STRIPE.disputes[ch.id] = { status: "needs_response" };
  await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.created", ch)));
  STRIPE.disputes[ch.id].status = "lost";
  const w = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.closed", ch, { status: "lost" })));
  vuln(c.status !== "refunded" || c.refunded_cents !== 10000 || moneyOut(c).refunded !== 0, `B7d chargeback lost while holding -> ${w.status}, status=${c.status}, refunded_cents=${c.refunded_cents}, extra refunds by us=${moneyOut(c).refunded}`);
  reset();
}
// ---------- B8: a second checkout session must retire the first, so the client can never pay twice
{
  const c = mk();
  const r1 = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } })); const s1 = c.stripe_checkout_id;
  STRIPE.idem.clear();                                                   // 30 minutes later: a new key, a new session
  const r2 = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } })); const s2 = c.stripe_checkout_id;
  vuln(s1 === s2 || STRIPE.sessions[s1].status !== "expired", `B8a second checkout (${r1.status}/${r2.status}) -> first session ${s1} is ${STRIPE.sessions[s1].status} (must be expired), second=${s2}`);
  // even if both were somehow paid, the second payment is never charged: its hold is released (hold first, charge after)
  const p2 = pay(s2); await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: p2 } })));
  STRIPE.sessions[s1].status = "open"; const before = STRIPE.balance; const p1 = pay(s1); const w = await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: p1 } })));
  const pi1 = STRIPE.intents[p1.payment_intent], ch1 = STRIPE.charges[pi1.latest_charge];
  vuln(c.funded_cents !== 10000 || pi1.status !== "canceled" || ch1.captured || moneyOut(c).refunded || STRIPE.balance !== before, `B8b both paid anyway -> webhook ${w.status}, funded=${c.funded_cents}, second payment ${pi1.status} (must be canceled: never charged), captured=${ch1.captured}, refunds=${moneyOut(c).refunded}, Cuvori's balance ${STRIPE.balance - before}`);
  reset();
}
// ---------- B9: the price grows again while a top-up checkout is open: keep the money, ask for the rest
{
  const c = mk(); await fund(fx, c); c.amount_cents = 12000;
  const r = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));   // top-up €20
  c.amount_cents = 13000;                                                                                    // another amendment accepted meanwhile
  const s = pay(c.stripe_checkout_id); const w = await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: s } })));
  vuln(w.status !== 200 || c.funded_cents !== 12000 || moneyOut(c).refunded !== 0, `B9 €20 top-up paid after the price grew to €130 -> webhook ${w.status}, funded=${c.funded_cents} (keep 12000, ask for 1000 more), refunded=${moneyOut(c).refunded}`);
  reset();
}
// ---------- B10: the webhook never arrives (misconfigured, or Stripe gave up): the client's return must still confirm the payment
{
  const c = mk();
  const r0 = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  pay(c.stripe_checkout_id);                                             // paid at Stripe, nothing told Cuvori
  if (!fx.confirm) vuln(true, "B10 there is no stripe-confirm function: a paid order stays 'accepted' when the webhook is lost");
  else {
    const x = await call(fx.confirm, req("POST", "x", { token: "tok_cl2", body: { contract_id: c.id } }));
    vuln(x.status === 200 && c.status === "funded", `B10a a stranger confirms -> ${x.status}`);
    const y = await call(fx.confirm, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
    vuln(y.status !== 200 || c.status !== "funded" || c.funded_cents !== 10000 || ledger(c, "fund").length !== 1, `B10b owner confirms -> ${y.status} ${JSON.stringify(y.json)}, status=${c.status}, ledger=${ledger(c, "fund").length}`);
    const z = await call(fx.confirm, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
    const late = await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: STRIPE.sessions[c.stripe_checkout_id] } })));
    vuln(ledger(c, "fund").length !== 1 || cards(c, "funded").length !== 1, `B10c confirm again (${z.status}) then the late webhook (${late.status}) -> fund rows=${ledger(c, "fund").length}, chat cards=${cards(c, "funded").length}`);
    const c2 = mk(); await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c2.id } }));
    const u = await call(fx.confirm, req("POST", "x", { token: "tok_cl", body: { contract_id: c2.id } }));
    vuln(c2.status !== "accepted" || u.status !== 200, `B10d confirm on an unpaid session -> ${u.status} ${JSON.stringify(u.json)}, status=${c2.status}`);
  }
  reset();
}
// ---------- B11: the freelancer's account gets restricted between the check and the transfer: money must not be stuck for ever
{
  const c = mk(); await fund(fx, c); c.status = "delivered";
  hook(async (path, method) => { if (path === "/transfers" && method === "POST") { STRIPE.accounts.acct_1EditorAAAAAAAA.payouts_enabled = false; } });
  const r = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  reset();
  info(`B11a release when the account gets restricted -> HTTP ${r.status} ${r.json && r.json.error || r.thrown || ""}; status=${c.status}, money_error=${c.money_error}`);
  const a = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "refund", note: "freelancer account closed" } }));
  vuln(a.status !== 200 || c.status !== "refunded" || moneyOut(c).refunded !== 10000, `B11b admin refunds a release that is stuck (no transfer was made) -> ${a.status} ${a.json && a.json.error || ""}, status=${c.status}, refunded=${moneyOut(c).refunded}`);
  STRIPE.accounts.acct_1EditorAAAAAAAA.payouts_enabled = true;
  // the other way round: the account comes back, the hourly job finishes the stuck release
  const c2 = mk(); await fund(fx, c2); c2.status = "delivered";
  hook(async (path, method) => { if (path === "/transfers" && method === "POST") { STRIPE.accounts.acct_1EditorAAAAAAAA.payouts_enabled = false; } });
  await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c2.id } }));
  reset(); STRIPE.accounts.acct_1EditorAAAAAAAA.payouts_enabled = true; onlyDue(c2); c2.resolved_at = past();
  const h = await call(fx.autoRelease);
  vuln(c2.status !== "completed" || moneyOut(c2).transferred !== 10000, `B11c account fixed, hourly job -> status=${c2.status}, transferred=${moneyOut(c2).transferred}, released=${JSON.stringify(h.json && h.json.released)}`);
  reset();
}
// ---------- B12: the bank is slow: the card money has not settled yet when the client approves
{
  STRIPE.settleDelay = true;
  const c = mk(); await fund(fx, c); c.status = "delivered";
  const r = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  vuln(r.status !== 200 || c.status !== "completed", `B12a release before the card money settled (tied to the charge, so allowed) -> ${r.status}, status=${c.status}`);
  // a top-up order can only be released from the balance: refuse politely, retry later
  const c2 = mk(); await fund(fx, c2); c2.amount_cents = 12000; await fund(fx, c2); c2.status = "delivered";
  const r2 = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c2.id } }));
  info(`B12b release of a two-charge order while nothing has settled -> ${r2.status} ${r2.json && r2.json.error || r2.thrown || ""}; status=${c2.status}, transferred=${moneyOut(c2).transferred}`);
  vuln(r2.status === 500 || (r2.status === 200 && moneyOut(c2).transferred !== 12000), `B12c ...it must be either a plain message or a full release, never a crash: HTTP ${r2.status}`);
  STRIPE.settleDelay = false; STRIPE.balance += 100000;                 // the money arrives
  onlyDue(c2); const h = await call(fx.autoRelease);
  const r3 = c2.status === "completed" ? { status: 200 } : await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c2.id } }));
  vuln(c2.status !== "completed" || moneyOut(c2).transferred !== 12000, `B12d after settlement: hourly job (${h.status}) / client retry (${r3.status}) -> status=${c2.status}, transferred=${moneyOut(c2).transferred}`);
  reset();
}
// ---------- B13: signatures and event routing
{
  const c = mk(); await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } })); const s = pay(c.stripe_checkout_id);
  const evt = { type: "checkout.session.completed", data: { object: s } };
  const a = await call(fx.webhook, req("POST", "x", signed(evt, "whsec_wrong")));
  const raw = JSON.stringify(evt); const old = sigFor(raw, Math.floor(Date.now() / 1000) - 600);
  const b = await call(fx.webhook, req("POST", "x", { raw, headers: { "stripe-signature": `t=${old.t},v1=${old.v1}` } }));
  const good = signed(evt); const tampered = { raw: good.raw.replace('"amount_total":', '"amount_total_x":'), headers: good.headers };
  const d = await call(fx.webhook, req("POST", "x", tampered));
  const e = await call(fx.webhook, req("POST", "x", { raw: good.raw, headers: {} }));
  vuln([a, b, d, e].some(r => r.status !== 400) || c.status !== "accepted", `B13a wrong secret ${a.status}, 10-min-old ${b.status}, tampered body ${d.status}, no header ${e.status} -> status=${c.status}`);
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect";
  const f = await call(fx.webhook, req("POST", "x", signed(evt, "whsec_connect")));
  info(`B13b a checkout event signed with the Connect secret -> ${f.status}, status=${c.status} (must stay accepted: ${c.status === "accepted"})`);
  vuln(c.status !== "accepted", `B13c ...connect-signed checkout event funded the order`);
  const g = await call(fx.webhook, req("POST", "x", signed({ type: "payment_intent.created", data: { object: { id: "pi_x" } } })));
  vuln(g.status !== 200, `B13d an event type we do not use -> ${g.status} (must be 200 so Stripe stops retrying)`);
  const h = await call(fx.webhook, req("GET", "x", {}));
  vuln(h.status !== 405, `B13e GET on the webhook -> ${h.status}`);
  reset();
}
// ---------- B14: tampered session amounts (a stolen signing secret is the only way to send these; the handler must still refuse)
{
  const c = mk(); await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } })); const s = pay(c.stripe_checkout_id);
  const lies = [{ ...s, amount_total: 50 }, { ...s, currency: "usd" }, { ...s, metadata: { ...s.metadata, amount_cents: "50", fee_cents: "0" }, amount_total: 50 }, { ...s, client_reference_id: uuid() }, { ...s, payment_status: "unpaid" }];
  const rs = []; for (const l of lies) rs.push((await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: l } })))).status);
  vuln(c.status !== "accepted" || c.funded_cents !== 0, `B14 five lying sessions -> ${rs.join("/")}, status=${c.status}, funded=${c.funded_cents}, refunds issued=${STRIPE.refunds.filter(r => r.payment_intent === s.payment_intent).length}`);
  reset();
}
// ---------- B15: CORS and methods
{
  const pre = await call(fx.checkout, req("OPTIONS", "x", { headers: { origin: "https://cuvori.io" } }));
  const evil = await call(fx.checkout, req("OPTIONS", "x", { headers: { origin: "https://evil.example" } }));
  const get = await call(fx.checkout, req("GET", "x", { token: "tok_cl" }));
  const anon = await call(fx.release, req("POST", "x", { body: { contract_id: uuid() } }));
  const badTok = await call(fx.release, req("POST", "x", { token: "tok_nope", body: { contract_id: uuid() } }));
  vuln(pre.status !== 204 || pre.headers.get("access-control-allow-origin") !== "https://cuvori.io" || evil.headers.get("access-control-allow-origin") || get.status !== 405 || anon.status !== 401 || badTok.status !== 401,
    `B15 preflight from cuvori.io ${pre.status} (${pre.headers.get("access-control-allow-origin")}), from evil ${evil.status} (${evil.headers.get("access-control-allow-origin")}), GET ${get.status}, no token ${anon.status}, bad token ${badTok.status}`);
}
// ---------- B16: wrong person, wrong thing
{
  const c = mk(); await fund(fx, c); c.status = "delivered";
  const other = mk({ client: users.cl2.id, has_milestones: true, status: "funded", funded_cents: 5000, amount_cents: 5000 }); const om = { id: uuid(), order_id: other.id, title: "x", amount_cents: 5000, status: "submitted" }; DB.order_milestones.push(om);
  const a = await call(fx.release, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id } }));
  const b = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, milestone_id: om.id } }));
  const d = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: other.id, milestone_id: om.id } }));
  const direct = mk({ payment_mode: "direct", status: "paid" });
  const e = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: direct.id } }));
  const f = await call(fx.resolve, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, decision: "release" } }));
  const g = await call(fx.cancel, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const h = await call(fx.cancel, req("POST", "x", { token: "tok_ed2", body: { contract_id: c.id } }));
  vuln([a, b, d, e, f, g, h].some(r => r.status === 200) || moneyOut(c).transferred || moneyOut(c).refunded || moneyOut(other).transferred,
    `B16 freelancer approves ${a.status}, client releases another order's milestone ${b.status}, a stranger's milestone ${d.status}, direct order ${e.status}, client plays admin ${f.status}, client cancels ${g.status}, other freelancer cancels ${h.status}`);
  reset();
}
// ---------- B17: split arithmetic on awkward totals
{
  let bad = 0, sample = "";
  for (const [total, pct] of [[10001, 33.333], [1, 50], [3, 66.6], [99999, 0.01], [12345, 99.99], [7, 12.5]]) {
    const c = mk({ status: "disputed", amount_cents: total, funded_cents: total, stripe_payment_intent: "pi_split" + total, stripe_charge_id: "ch_split" + total });
    STRIPE.intents["pi_split" + total] = { id: "pi_split" + total, amount: total + 100, latest_charge: "ch_split" + total }; STRIPE.charges["ch_split" + total] = { id: "ch_split" + total, amount: total + 100, amount_refunded: 0, sourced: 0, payment_intent: "pi_split" + total, balance_transaction: { fee: 100, net: total } }; STRIPE.balance += total;
    const r = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "split", editor_percent: pct } }));
    const m = moneyOut(c);
    if (r.status !== 200 || m.transferred + m.refunded !== total || c.released_cents + c.refunded_cents !== total || m.transferred < 0 || m.refunded < 0) { bad++; sample += ` [${total}@${pct}% -> ${r.status} t=${m.transferred} r=${m.refunded}]`; }
  }
  vuln(bad > 0, `B17 six awkward splits: ${bad} lost or invented cents${sample}`);
  reset();
}
// ---------- B18/B19: Stripe fails or times out in the middle; a retry moves the money exactly once
{
  const c = mk(); await fund(fx, c); c.status = "delivered";
  let n = 0; hook(async (path, method) => { if (path === "/transfers" && method === "POST" && n++ === 0) return [500, { error: { message: "An error occurred with our connection to Stripe.", type: "api_error" } }]; });
  const r1 = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const r2 = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  vuln(r2.status !== 200 || moneyOut(c).transferred !== 10000 || c.status !== "completed", `B18 Stripe 500 on the transfer (${r1.status}) then retry (${r2.status}) -> transferred=${moneyOut(c).transferred}, status=${c.status}`);
  reset();
  const c2 = mk(); await fund(fx, c2); c2.status = "delivered";
  let k = 0; hook(async (path, method) => { if (path === "/transfers" && method === "POST" && k++ === 0) { const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; throw e; } });
  const t1 = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c2.id } }));
  reset();
  const t2 = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c2.id } }));
  vuln(t2.status !== 200 || moneyOut(c2).transferred !== 10000 || c2.status !== "completed" || (t1.json && /ref/.test(t1.json.error) === false && t1.status === 500), `B19 network timeout on the transfer (${t1.status} ${t1.json && t1.json.error || ""}) then retry (${t2.status}) -> transferred=${moneyOut(c2).transferred}, status=${c2.status}`);
  const c3 = mk(); await fund(fx, c3); c3.status = "delivered";
  let j = 0; hook(async (path, method) => { if (path === "/transfers" && method === "POST" && j++ === 0) { const e = new Error("fetch failed"); e.name = "TypeError"; throw e; } });
  const u1 = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c3.id } }));
  reset();
  vuln(u1.status !== 500 && u1.status !== 409 && u1.status !== 503, `B19b a dropped connection is reported as an error (${u1.status}) not a success`);
  vuln(u1.json && /stack|at\s|node:|Error:/i.test(JSON.stringify(u1.json)), `B19c ...and the message carries no internals: ${JSON.stringify(u1.json)}`);
  c3.resolved_at = past(); onlyDue(c3); const u2 = await call(fx.autoRelease);
  vuln(c3.status !== "completed" || moneyOut(c3).transferred !== 10000, `B19d the hourly job finishes it -> status=${c3.status}, transferred=${moneyOut(c3).transferred}`);
  reset();
}
// ---------- B20: the hourly job — the review window, milestones, stuck states, what it must not touch
{
  const c = mk(); await fund(fx, c); c.status = "delivered"; c.auto_release_at = past(); onlyDue(c);
  const silent = mk(); await fund(fx, silent); silent.status = "delivered"; silent.auto_release_at = new Date(Date.now() + 3600e3).toISOString();
  const disputed = mk(); await fund(fx, disputed); disputed.status = "disputed"; disputed.auto_release_at = past();
  const r = await call(fx.autoRelease);
  vuln(c.status !== "completed" || silent.status !== "delivered" || disputed.status !== "disputed" || moneyOut(disputed).transferred, `B20a due order released (${c.status}), not-yet-due untouched (${silent.status}), disputed untouched (${disputed.status})`);
  const m = mk({ amount_cents: 20000, has_milestones: true }); await fund(fx, m); m.status = "funded";
  const ms = [{ id: uuid(), order_id: m.id, title: "a", amount_cents: 8000, status: "submitted", auto_release_at: past() }, { id: uuid(), order_id: m.id, title: "b", amount_cents: 12000, status: "pending" }]; DB.order_milestones.push(...ms);
  onlyDue(m); const r2 = await call(fx.autoRelease);
  vuln(ms[0].status !== "released" || ms[1].status !== "pending" || m.released_cents !== 8000 || m.status !== "funded", `B20b milestone review window passed -> a=${ms[0].status}, b=${ms[1].status}, released_cents=${m.released_cents}, order=${m.status}`);
  // a milestone whose transfer failed once (approved, no transfer) is picked up by the job
  hook(async (path, method) => { if (path === "/transfers" && method === "POST") return [500, { error: { message: "down" } }]; });
  ms[1].status = "submitted"; const r3 = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: m.id, milestone_id: ms[1].id } }));
  reset();
  const st = ms[1].status; const r4 = await call(fx.autoRelease);
  vuln(ms[1].status !== "released" || m.status !== "completed" || moneyOut(m).transferred !== 20000, `B20c milestone approve failed at Stripe (${r3.status}, milestone ${st}) -> hourly job: ${ms[1].status}, order=${m.status}, transferred=${moneyOut(m).transferred}`);
  reset();
}
// ---------- B21: cancellations, refunds and their limits
{
  const a = mk(); const r1 = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: a.id } }));
  vuln(r1.status === 200, `B21a freelancer cancels an unfunded order through the money function -> ${r1.status}`);
  const b = mk({ amount_cents: 20000, has_milestones: true }); await fund(fx, b); b.status = "funded";
  const bm = { id: uuid(), order_id: b.id, title: "a", amount_cents: 8000, status: "submitted" }; DB.order_milestones.push(bm, { id: uuid(), order_id: b.id, title: "b", amount_cents: 12000, status: "pending" });
  await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: b.id, milestone_id: bm.id } }));
  const r2 = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: b.id } }));
  vuln(r2.status !== 200 || moneyOut(b).refunded !== 12000 || moneyOut(b).transferred !== 8000 || b.status !== "refunded", `B21b cancel after one milestone was paid -> ${r2.status}, refunded=${moneyOut(b).refunded} (rest only), transferred stays=${moneyOut(b).transferred}, status=${b.status}`);
  const r3 = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: b.id } }));
  vuln(moneyOut(b).refunded !== 12000, `B21c cancel again (${r3.status}) -> refunded=${moneyOut(b).refunded}`);
  // refund fails at Stripe (e.g. balance), then works
  const d = mk(); await fund(fx, d);
  let n = 0; hook(async (path, method) => { if (path === "/refunds" && method === "POST" && n++ === 0) return [400, { error: { message: "You have insufficient funds in your Stripe account", code: "balance_insufficient" } }]; });
  const r4 = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: d.id } }));
  reset();
  const r5 = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: d.id } }));
  vuln(r4.status === 200 || r5.status !== 200 || moneyOut(d).refunded !== 10000 || d.status !== "refunded", `B21d refund refused once (${r4.status} ${r4.json && r4.json.error || ""}) then retried (${r5.status}) -> refunded=${moneyOut(d).refunded}, status=${d.status}`);
  reset();
}
// ---------- B22: outside refunds and disputes through the dashboard
{
  const c = mk(); const f = await fund(fx, c); c.status = "delivered"; const ch = chargeOf(f.session.payment_intent);
  STRIPE.refunds.push({ id: "re_dash22", amount: ch.amount - ch.amount_refunded, metadata: {}, payment_intent: ch.payment_intent, charge: ch.id, status: "succeeded" });   // the dashboard refund of everything still on the charge
  ch.amount_refunded = ch.amount; const w = await call(fx.webhook, req("POST", "x", signed({ type: "charge.refunded", data: { object: { id: ch.id, payment_intent: ch.payment_intent, amount: ch.amount, amount_refunded: ch.amount, refunded: true } } })));
  vuln(c.status !== "refunded" || c.refunded_cents !== 10000, `B22a full refund from the Stripe dashboard -> ${w.status}, status=${c.status}, refunded_cents=${c.refunded_cents}`);
  const r = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  vuln(r.status === 200 || moneyOut(c).transferred, `B22b ...and a release afterwards -> ${r.status}, transferred=${moneyOut(c).transferred}`);
  reset();
}
// ---------- B23: money conservation over everything above
{
  let broken = 0, sample = "";
  for (const c of DB.contracts) {
    if (c.payment_mode !== "escrow") continue;
    const m = moneyOut(c); const fundedAtStripe = ledger(c, "fund").reduce((a, p) => a + p.amount_cents, 0);
    const okStripe = m.transferred + m.refunded - m.orphans <= Math.max(fundedAtStripe, c.funded_cents || 0);
    const okCounters = (c.released_cents || 0) + (c.refunded_cents || 0) <= (c.funded_cents || 0);
    if (!okStripe || !okCounters) { broken++; sample += ` [${c.title}/${c.status}: funded=${c.funded_cents} stripe(t=${m.transferred},r=${m.refunded}) counters(rel=${c.released_cents},ref=${c.refunded_cents})]`; }
  }
  vuln(broken > 0, `B23 conservation over ${DB.contracts.length} orders: ${broken} broken${sample}`);
}
// ---------- B24: the freelancer connects Stripe: account creation is idempotent, links only for own account
{
  DB.payout_details.push({ id: users.cl2.id, methods: [], note: "", stripe_account_id: null, stripe_payouts_enabled: false }); users.cl2.role = "editor";
  const a = await call(fx.connect, req("POST", "x", { token: "tok_cl2" })); const acct1 = DB.payout_details.at(-1).stripe_account_id;
  const b = await call(fx.connect, req("POST", "x", { token: "tok_cl2" })); const acct2 = DB.payout_details.at(-1).stripe_account_id;
  const g = await call(fx.connect, req("GET", "x", { token: "tok_cl2" }));
  vuln(a.status !== 200 || acct1 !== acct2 || Object.keys(STRIPE.accounts).length !== 3 || g.json.connected !== true || g.json.payouts_enabled !== false, `B24 connect twice -> ${a.status}/${b.status}, same account=${acct1 === acct2}, accounts at Stripe=${Object.keys(STRIPE.accounts).length}, status: ${JSON.stringify(g.json)}`);
  users.cl2.role = "client";
}
// ---------- B25: a funded order whose freelancer account was closed at Stripe (account gone)
{
  DB.payout_details.push({ id: users.ed2.id + "x", methods: [] });
  const c = mk({ editor: users.ed2.id }); await fund(fx, c); c.status = "delivered";
  delete STRIPE.accounts.acct_1SecondBBBBBBBB;
  const r = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const a = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "refund", note: "account closed" } }));
  vuln(r.status === 200 || a.status !== 200 || c.status !== "refunded" || moneyOut(c).refunded !== 10000, `B25 account gone: client approve ${r.status} (${r.json && r.json.error || ""}), admin refund ${a.status} -> status=${c.status}, refunded=${moneyOut(c).refunded}`);
  STRIPE.accounts.acct_1SecondBBBBBBBB = { id: "acct_1SecondBBBBBBBB", payouts_enabled: true, charges_enabled: true, requirements: { currently_due: [] }, metadata: { cuvori_user: users.ed2.id } };
  reset();
}

// ---------- B25b: do not take a client's money while Stripe says the freelancer's charge path is restricted
{
  const acct = STRIPE.accounts.acct_1EditorAAAAAAAA;
  acct.charges_enabled = false;
  const c = mk();
  const r = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  vuln(r.status === 200 || c.stripe_checkout_id, `B25b freelancer payouts enabled but charge path restricted -> checkout ${r.status}, session created=${!!c.stripe_checkout_id}`);
  acct.charges_enabled = true;
  reset();
}

// ---------- B26: the freelancer's account cannot give the money back (reversal refused): the facts are still recorded
{
  const c = mk(); const f = await fund(fx, c); c.status = "delivered";
  await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const ch = chargeOf(f.session.payment_intent); STRIPE.disputes[ch.id] = { status: "needs_response" };
  hook(async (path, method) => { if (/\/reversals$/.test(path) && method === "POST") return [400, { error: { message: "Insufficient funds in the connected account", code: "balance_insufficient" } }]; });
  const r = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.created", ch)));
  reset();
  vuln(r.status !== 200 || c.chargeback_status !== "open" || !c.money_error || c.released_cents !== 10000, `B26a reversal refused -> webhook ${r.status}, chargeback=${c.chargeback_status}, money_error=${!!c.money_error}, released_cents stays ${c.released_cents}`);
  STRIPE.disputes[ch.id].status = "lost";
  const w = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.closed", ch, { status: "lost" })));
  // either the pull-back went through in the meantime (the account had money again) and the books say so, or a person is told
  const recovered = c.released_cents === 0 && moneyOut(c).transferred === 0 && c.refunded_cents === 10000;
  vuln(w.status !== 200 || c.chargeback_status !== "lost" || !(recovered || /by hand/.test(c.money_error || "")), `B26b then lost -> ${w.status}, chargeback=${c.chargeback_status}, status=${c.status}, pulled back after all=${recovered}, admin note=${c.money_error}`);
  reset();
}
// ---------- B27: the client's return and the webhook land at the same moment
{
  if (fx.confirm) {
    const c = mk(); await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } })); const s = pay(c.stripe_checkout_id);
    const [a, b] = await Promise.all([call(fx.confirm, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } })), call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: s } })))]);
    vuln(a.status !== 200 || b.status !== 200 || c.status !== "funded" || c.funded_cents !== 10000 || ledger(c, "fund").length !== 1 || cards(c, "funded").length !== 1 || moneyOut(c).refunded, `B27 confirm ${a.status} + webhook ${b.status} together -> status=${c.status}, fund rows=${ledger(c, "fund").length}, cards=${cards(c, "funded").length}, refunds=${moneyOut(c).refunded}`);
  }
  reset();
}
// ---------- B28: idempotency keys — a definite failure gets a fresh key, an unknown outcome keeps it
{
  const c = mk(); await fund(fx, c); c.status = "delivered";
  let n = 0; hook(async (path, method) => { if (path === "/transfers" && method === "POST" && n++ === 0) return [400, { error: { message: "You have insufficient funds in your Stripe account", code: "balance_insufficient" } }]; });
  const r1 = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const keysAfterFail = DB.money_keys.filter(k => k.scope.startsWith("transfer:" + c.id)).length;
  reset();
  const r2 = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  vuln(r1.status !== 409 || keysAfterFail !== 0 || r2.status !== 200 || moneyOut(c).transferred !== 10000, `B28a balance refused (${r1.status}: ${r1.json && r1.json.error}), key dropped=${keysAfterFail === 0}, retry ${r2.status} -> transferred=${moneyOut(c).transferred}`);
  const c2 = mk(); await fund(fx, c2); c2.status = "delivered";
  let k = 0; hook(async (path, method) => { if (path === "/transfers" && method === "POST" && k++ === 0) { const e = new Error("socket hang up"); throw e; } });
  const t1 = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c2.id } }));
  const keysAfterNet = DB.money_keys.filter(x => x.scope.startsWith("transfer:" + c2.id)).length;
  reset();
  const t2 = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c2.id } }));
  vuln(t1.status !== 503 || keysAfterNet !== 1 || t2.status !== 200 || moneyOut(c2).transferred !== 10000, `B28b connection dropped (${t1.status}), key kept=${keysAfterNet === 1}, retry ${t2.status} -> transferred=${moneyOut(c2).transferred}`);
  reset();
}

// ---------- B29: a payment for an Order that is not a protected one, and a double click on one milestone
{
  const d = mk({ payment_mode: "direct" }); d.stripe_checkout_id = "cs_direct1234";
  STRIPE.sessions.cs_direct1234 = { id: "cs_direct1234", object: "checkout.session", mode: "payment", status: "open", payment_status: "unpaid", client_reference_id: d.id, amount_total: 10178, currency: "eur", metadata: { contract_id: d.id, amount_cents: "10000", fee_cents: "178", kind: "fund" } };
  const s = pay("cs_direct1234"); const w = await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: s } })));
  const keptD = STRIPE.charges[STRIPE.intents[s.payment_intent].latest_charge].balance_transaction.fee;   // Stripe's card fee stays with Stripe: Cuvori pays no fees
  vuln(w.status !== 200 || d.status !== "accepted" || moneyOut(d).orphans !== 10178 - keptD, `B29a a card payment arrives for a direct-payment Order -> ${w.status}, status=${d.status}, sent back=${moneyOut(d).orphans} (all but Stripe's fee ${keptD})`);
  const c = mk({ amount_cents: 20000, has_milestones: true }); await fund(fx, c); c.status = "funded";
  const ms = [{ id: uuid(), order_id: c.id, title: "a", amount_cents: 8000, status: "submitted" }, { id: uuid(), order_id: c.id, title: "b", amount_cents: 12000, status: "pending" }]; DB.order_milestones.push(...ms);
  const rs = await Promise.all([1, 2, 3].map(() => call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, milestone_id: ms[0].id } }))));
  vuln(moneyOut(c).transferred !== 8000 || ms[0].status !== "released" || c.released_cents !== 8000 || c.status !== "funded", `B29b the same milestone approved three times at once -> ${rs.map(r => r.status).join("/")}, transferred=${moneyOut(c).transferred}, milestone=${ms[0].status}, released_cents=${c.released_cents}, order=${c.status}`);
  reset();
}
// ---------- B30: two Fund requests at the same moment, and two paid pages at the same moment ----------
// Two tabs (here: two page languages, so Stripe makes two different pages) click Fund together. One Order must never end
// up with two pages that could both be paid: the second request finds the first one's page on the Order and hands that
// page back. And if two paid pages for one Order ever arrive together, only one may be charged: the other hold is
// released, nothing refunded minus a card fee.
{
  const c = mk({ amount_cents: 10000 });
  const [a, b] = await Promise.all([
    call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, lang: "en" } })),
    call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, lang: "lt" } })),
  ]);
  const pages = Object.values(STRIPE.sessions).filter(s => s.client_reference_id === c.id), open = pages.filter(s => s.status === "open");
  vuln(a.status !== 200 || b.status !== 200 || open.length !== 1 || !a.json || !b.json || a.json.url !== b.json.url || open[0].id !== c.stripe_checkout_id,
    `B30a two Fund clicks at the same moment -> ${a.status}/${b.status}; pages made ${pages.length}, still open ${open.length}, both tabs got the same page: ${!!(a.json && b.json && a.json.url === b.json.url)} (must be one live page, handed to both)`);
  // two tabs in the same language: Stripe hands both the same page (the same request twice). The second tab read the Order
  // before the first one saved the page; its save then fails, and it must hand the same page back, never close it.
  const e = mk({ amount_cents: 10000 }); const before = { ...e };
  const t1 = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: e.id, lang: "en" } }));
  let first = true;
  hooks.db = async (method, table, search) => { if (method === "GET" && table === "contracts" && search.includes(`id=eq.${e.id}`) && first) { first = false; return new Response(JSON.stringify([before]), { status: 200 }); } return null; };   // tab 2 read the Order a moment earlier
  const t2 = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: e.id, lang: "en" } }));
  reset();
  const shared = STRIPE.sessions[e.stripe_checkout_id];
  vuln(t1.status !== 200 || t2.status !== 200 || !t1.json || !t2.json || t1.json.url !== t2.json.url || !shared || shared.status !== "open" || Object.values(STRIPE.sessions).filter(x => x.client_reference_id === e.id).length !== 1,
    `B30c two tabs in the same language a moment apart -> ${t1.status}/${t2.status}; same page for both: ${!!(t1.json && t2.json && t1.json.url === t2.json.url)}; the page is ${shared && shared.status} (must be one page, still open, handed to both)`);
  // two holds for one Order (only possible before this check existed, or by hand): confirmed together, charged once
  const d = mk({ amount_cents: 10000 });
  await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: d.id } }));
  const A = STRIPE.sessions[d.stripe_checkout_id], B = { ...A, id: "cs_second" + Math.random().toString(36).slice(2, 8), status: "open", payment_status: "unpaid", payment_intent: null };
  STRIPE.sessions[B.id] = B;
  const sA = pay(A.id), sB = pay(B.id);
  const [wa, wb] = await Promise.all([
    call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: sA } }))),
    call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: sB } }))),
  ]);
  const charged = [sA, sB].filter(s => STRIPE.intents[s.payment_intent].status === "succeeded").length, released = [sA, sB].filter(s => STRIPE.intents[s.payment_intent].status === "canceled").length;
  const back = moneyOut(d).refunded + moneyOut(d).orphans;                                   // Order money or a late payment sent back (the card-fee surplus going back is normal)
  vuln(charged !== 1 || released !== 1 || d.status !== "funded" || d.funded_cents !== 10000 || back !== 0 || ledger(d, "fund").length !== 1,
    `B30b two paid pages for one Order confirmed together -> webhooks ${wa.status}/${wb.status}; charged ${charged}, holds released ${released}, Order ${d.status} with ${d.funded_cents}, money sent back ${back}, ledger lines ${ledger(d, "fund").length} (must be charged once, the other released, nothing sent back)`);
  reset();
}
// ---------- B31: the payment page a click gets, and the page the return checks ----------
// Every Fund click must end on a page that can be paid and is the Order's page: after switching language and back, after
// the request changed in some detail (a new version, a changed title), after Stripe failed once. And when the client comes
// back from the page they paid, that very page is confirmed, even if another tab has made a newer one meanwhile.
{
  const click = (c, lang) => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, lang } }));
  const confirm = (c, session_id) => call(fx.confirm, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, session_id } }));
  const pagesOf = (c) => Object.values(STRIPE.sessions).filter(s => s.client_reference_id === c.id);
  const urlOk = (r, c) => !!(r.json && STRIPE.sessions[c.stripe_checkout_id] && r.json.url === STRIPE.sessions[c.stripe_checkout_id].url && STRIPE.sessions[c.stripe_checkout_id].status === "open");
  // a) English, Lithuanian, English again within the half hour: the third click must get a page that can be paid
  const a = mk({ amount_cents: 10000 });
  const a1 = await click(a, "en"), a2 = await click(a, "lt"), a3 = await click(a, "en");
  const aOpen = pagesOf(a).filter(s => s.status === "open");
  vuln(a1.status !== 200 || a2.status !== 200 || a3.status !== 200 || !urlOk(a3, a) || aOpen.length !== 1,
    `B31a English, Lithuanian, then English again -> ${a1.status}/${a2.status}/${a3.status}; the client is sent to a page that is ${a3.json && Object.values(STRIPE.sessions).find(s => s.url === a3.json.url)?.status}, the Order's page is ${STRIPE.sessions[a.stripe_checkout_id]?.status}, open pages ${aOpen.length} (must be one open page: the Order's, and the one the client gets)`);
  const back = (STRIPE.sessions[a.stripe_checkout_id]?.params || {}).success_url || "";
  vuln(!back.endsWith(`/?cs={CHECKOUT_SESSION_ID}#orders?paid=${a.id}`),
    `B31a1 the return link carries the paid page's id where Stripe fills it in -> ${back} (must end in /?cs={CHECKOUT_SESSION_ID}#orders?paid=<the Order>)`);
  // ...and the same click once more (Back, then Fund again): the same page again, still open, no new one
  const before = pagesOf(a).length, a4 = await click(a, "en");
  vuln(a4.status !== 200 || !a3.json || !a4.json || a4.json.url !== a3.json.url || !urlOk(a4, a) || pagesOf(a).length !== before,
    `B31a2 the same click again -> ${a4.status}; same page ${!!(a3.json && a4.json && a4.json.url === a3.json.url)}, pages made ${pagesOf(a).length - before} (must be the same open page, none made)`);
  // b) the request changed in a detail that is not the amount (here the Order's title; a new version changing a page text
  // is the same thing) between two clicks in the same half hour
  const b = mk({ amount_cents: 10000, title: "First title" });
  const b1 = await click(b, "en"); b.title = "Second title"; const b2 = await click(b, "en");
  vuln(b1.status !== 200 || b2.status !== 200 || !urlOk(b2, b) || pagesOf(b).filter(s => s.status === "open").length !== 1,
    `B31b the request changed between two clicks -> ${b1.status}/${b2.status} ${b2.status !== 200 ? JSON.stringify(b2.json) : ""} (must be a new open page, the old one closed)`);
  // c) Stripe fails once while making the page (an error it saves for its key), then works again
  const c = mk({ amount_cents: 10000 });
  let fails = 1;
  hooks.stripe = async (path, method) => (path === "/checkout/sessions" && method === "POST" && fails-- > 0 ? [500, { error: { type: "api_error", message: "An unknown error occurred" } }] : null);
  const c1 = await click(c, "en"), c2 = await click(c, "en");
  reset();
  vuln(c1.status < 500 || c2.status !== 200 || !urlOk(c2, c),
    `B31c Stripe failed once, then works -> first ${c1.status}, second ${c2.status} ${c2.status !== 200 ? JSON.stringify(c2.json) : ""} (the second click must get a page)`);
  // d) Fund clicked again after paying, before the payment was confirmed: never the paid page's link again (Stripe gives a
  // page's link only while it is open); the payment is confirmed right there and the client is told the Order isn't
  // waiting for a payment, so the page reloads it and shows it paid. No new page.
  const d = mk({ amount_cents: 10000 });
  const d1 = await click(d, "en"); pay(d.stripe_checkout_id); const dn = pagesOf(d).length; const d2 = await click(d, "en");
  const dIntent = STRIPE.intents[STRIPE.sessions[d.stripe_checkout_id].payment_intent];
  vuln(d2.status !== 409 || !d2.json || d2.json.code !== "not_payable" || d.status !== "funded" || d.funded_cents !== 10000 || ledger(d, "fund").length !== 1 || dIntent.status !== "succeeded" || pagesOf(d).length !== dn,
    `B31d Fund again after paying, before the confirmation -> ${d2.status} ${JSON.stringify(d2.json)}; Order ${d.status} with ${d.funded_cents}, the card hold ${dIntent.status}, new pages ${pagesOf(d).length - dn} (must be "not waiting for a payment", the payment confirmed, no new page)`);
  // e) paid in one tab, a newer page made in another tab before the confirmation; back from the paid page
  const e = mk({ amount_cents: 10000 });
  await click(e, "en"); const paidId = e.stripe_checkout_id; pay(paidId);
  await click(e, "lt"); const replaced = e.stripe_checkout_id !== paidId;  // the other tab: a new page now on the Order
  const e1 = await confirm(e, paidId);
  const eIntent = STRIPE.intents[STRIPE.sessions[paidId].payment_intent];
  vuln(!replaced || e1.status !== 200 || e.status !== "funded" || e.funded_cents !== 10000 || ledger(e, "fund").length !== 1 || eIntent.status !== "succeeded",
    `B31e back from the paid page while another tab made a newer one -> ${e1.status} ${JSON.stringify(e1.json)}; Order ${e.status} with ${e.funded_cents}, the card hold is ${eIntent.status} (must be funded, the payment taken)`);
  // f) the return names a page of another Order (paid): never applied through this Order; this Order's own page is checked
  const f = mk({ amount_cents: 10000 }), g = mk({ amount_cents: 10000 });
  await click(f, "en"); await click(g, "en"); pay(g.stripe_checkout_id);
  const f1 = await confirm(f, g.stripe_checkout_id);
  vuln(f1.status !== 200 || f.status !== "accepted" || g.status !== "accepted" || ledger(g, "fund").length !== 0 || STRIPE.intents[STRIPE.sessions[g.stripe_checkout_id].payment_intent].status !== "requires_capture",
    `B31f the return names another Order's paid page -> ${f1.status} ${JSON.stringify(f1.json)}; this Order ${f.status}, the other Order ${g.status} (must change neither)`);
  // g) a made-up page id, a page that does not exist, a page id Stripe did not fill in: the Order's own page is checked as before
  const h = mk({ amount_cents: 10000 }); await click(h, "en"); pay(h.stripe_checkout_id);
  const h1 = await confirm(h, "{CHECKOUT_SESSION_ID}"), h1s = h.status;
  const k = mk({ amount_cents: 10000 }); await click(k, "en"); pay(k.stripe_checkout_id);
  const k1 = await confirm(k, "cs_does_not_exist_123");
  vuln(h1.status !== 200 || h1s !== "funded" || k1.status !== 200 || k.status !== "funded",
    `B31g the return has no usable page id -> ${h1.status} (${h1s}), ${k1.status} (${k.status}) (the Order's own page must be confirmed)`);
  // h) the return names a page of this Order that was not paid (an old, closed one): the Order's own page is checked
  const m = mk({ amount_cents: 10000 }); await click(m, "en"); const oldId = m.stripe_checkout_id; await click(m, "lt"); pay(m.stripe_checkout_id);
  const m1 = await confirm(m, oldId);
  vuln(m1.status !== 200 || m.status !== "funded" || ledger(m, "fund").length !== 1,
    `B31h the return names an unpaid page of this Order while its current page is paid -> ${m1.status} ${JSON.stringify(m1.json)}; Order ${m.status} (must be funded from the paid page)`);
  reset();
}
// ---------- B32: the stored key of a payment page meets Stripe's own answers about keys ----------
{
  const click = (c, lang) => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, lang } }));
  const pagesOf = (c) => Object.values(STRIPE.sessions).filter(s => s.client_reference_id === c.id);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const keyOf = (c) => DB.money_keys.find(k => k.scope.startsWith(`checkout:${c.id}:`));
  // a) two tabs in one language click at the same moment, while Stripe is still making the first tab's page
  const a = mk({ amount_cents: 10000 });
  hooks.stripe = async (path, method) => { if (path === "/checkout/sessions" && method === "POST") await sleep(300); return null; };
  const [a1, a2] = await Promise.all([click(a, "en"), (async () => { await sleep(100); return click(a, "en"); })()]);
  reset();
  vuln(a1.status !== 200 || a2.status !== 200 || !a1.json || !a2.json || a1.json.url !== a2.json.url || pagesOf(a).length !== 1 || pagesOf(a)[0].status !== "open",
    `B32a two tabs in one language click while Stripe is still making the page -> ${a1.status}/${a2.status} ${a2.status !== 200 ? JSON.stringify(a2.json) : ""}; same page ${!!(a1.json && a2.json && a1.json.url === a2.json.url)}, pages ${pagesOf(a).length} (both tabs must get the one page)`);
  // b) the key is named after the exact text Stripe receives, with the API version it is read under
  const b = mk({ amount_cents: 10000 }); const f0 = globalThis.fetch; let sent = null;
  globalThis.fetch = async (u, i = {}) => { if (String(u).endsWith("/v1/checkout/sessions") && i.method === "POST") sent = `${i.headers["Stripe-Version"]} POST /checkout/sessions\n${i.body}`; return f0(u, i); };
  await click(b, "en"); globalThis.fetch = f0;
  const want = sent && createHash("sha256").update(sent).digest("hex").slice(0, 16), got = (keyOf(b) || {}).scope || "";
  vuln(!want || !got.endsWith(`:${want}`), `B32b the key is named after the exact request text -> key ${got.replace(b.id, "<order>")}, text's fingerprint ${want} (must match)`);
  // ...and if Stripe ever says the key belongs to a different request, the client still gets a page
  const saved = STRIPE.idem.get(keyOf(b).key); STRIPE.idem.set(keyOf(b).key, { ...saved, body: saved.body + "&changed=1" });
  const b2 = await click(b, "en");
  vuln(b2.status !== 200 || STRIPE.sessions[b.stripe_checkout_id]?.status !== "open" || pagesOf(b).filter(s => s.status === "open").length !== 1,
    `B32b2 Stripe says the key belongs to a different request -> ${b2.status} ${b2.status !== 200 ? JSON.stringify(b2.json) : ""} (must be a new page, one open page)`);
  // c) Stripe fails once, and at that moment the database cannot forget the key: the next click must not get the old failure
  const c = mk({ amount_cents: 10000 }); let s500 = 1, delFail = 1;
  hooks.stripe = async (path, method) => (path === "/checkout/sessions" && method === "POST" && s500-- > 0 ? [500, { error: { type: "api_error", message: "An unknown error occurred" } }] : null);
  hooks.db = async (method, table) => (method === "DELETE" && table === "money_keys" && delFail-- > 0 ? new Response(JSON.stringify({ message: "timeout" }), { status: 503 }) : null);
  const c1 = await click(c, "en"), c2 = await click(c, "en");
  reset();
  vuln(c1.status < 500 || c2.status !== 200 || STRIPE.sessions[c.stripe_checkout_id]?.status !== "open",
    `B32c Stripe failed while the database could not forget the key -> first ${c1.status}, next ${c2.status} (the next click must get a page)`);
  // d) a closed page comes back for its key, and the database cannot forget the key: the closed page is never handed out
  const d = mk({ amount_cents: 10000 });
  await click(d, "en"); await click(d, "lt");                                   // the English page is now closed
  hooks.db = async (method, table) => (method === "DELETE" && table === "money_keys" ? new Response(JSON.stringify({ message: "timeout" }), { status: 503 }) : null);
  const d3 = await click(d, "en");
  reset();
  const handed = d3.status === 200 && d3.json && Object.values(STRIPE.sessions).find(s => s.url === d3.json.url);
  vuln(d3.status === 200 && (!handed || handed.status !== "open"), `B32d a closed page comes back while the database cannot forget its key -> ${d3.status}, page handed out: ${handed ? handed.status : "none"} (a closed page must never be handed out)`);
  reset();
}
// ---------- B33: looking a page up at Stripe only when Stripe hands it back from memory ----------
{
  const click = (c, lang) => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, lang } }));
  const pagesOf = (c) => Object.values(STRIPE.sessions).filter(s => s.client_reference_id === c.id);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // a) a first click never depends on a second call to Stripe: even when looking a page up would fail, the page is handed out
  const a = mk({ amount_cents: 10000 }); let lookups = 0;
  hooks.stripe = async (path, method) => (method === "GET" && /^\/checkout\/sessions\/cs_/.test(path) ? (lookups++, [500, { error: { type: "api_error", message: "An unknown error occurred" } }]) : null);
  const a1 = await click(a, "en"); reset();
  vuln(a1.status !== 200 || lookups !== 0 || STRIPE.sessions[a.stripe_checkout_id]?.status !== "open",
    `B33a a first click while looking pages up at Stripe fails -> ${a1.status}, look-ups ${lookups} (must be the new page, without a look-up)`);
  // b) a page Stripe hands back from memory is still looked up (Back, Fund again): one look-up, the same open page
  lookups = 0; hooks.stripe = async (path, method) => { if (method === "GET" && /^\/checkout\/sessions\/cs_/.test(path)) lookups++; return null; };
  const a2 = await click(a, "en"); reset();
  vuln(a2.status !== 200 || lookups !== 1 || !a1.json || !a2.json || a2.json.url !== a1.json.url,
    `B33b the same click again -> ${a2.status}, look-ups ${lookups}, same page ${!!(a1.json && a2.json && a2.json.url === a1.json.url)} (must be looked up once and handed back)`);
  // c) two tabs in one language click at the same moment right after a language switch and back (both get the closed
  // English page back from Stripe's memory), then the client clicks once more: the page both tabs got must stay
  const c = mk({ amount_cents: 10000 }); await click(c, "en"); await click(c, "lt");      // the English page is now closed
  let gets = 0;
  hooks.stripe = async (path, method) => { if (path === "/checkout/sessions" && method === "POST") await sleep(150); if (method === "GET" && /^\/checkout\/sessions\/cs_/.test(path) && ++gets === 2) await sleep(60); return null; };
  const [c1, c2] = await Promise.all([click(c, "en"), click(c, "en")]); reset();
  const shared = c.stripe_checkout_id; const c3 = await click(c, "en");
  vuln(c1.status !== 200 || c2.status !== 200 || !c1.json || !c2.json || c1.json.url !== c2.json.url || c3.status !== 200 || c.stripe_checkout_id !== shared || STRIPE.sessions[shared].status !== "open" || !c3.json || c3.json.url !== c1.json.url,
    `B33c two tabs at once on a closed page, then one more click -> ${c1.status}/${c2.status}/${c3.status}; the page both tabs got is ${STRIPE.sessions[shared]?.status}, the next click got ${c3.json && c3.json.url === (c1.json && c1.json.url) ? "the same page" : "another page"} (must stay open and be handed back)`);
  // d) Stripe's "from memory" mark missing (never expected): a closed page made more than a minute ago is still caught
  const d = mk({ amount_cents: 10000 }); await click(d, "en"); const old = d.stripe_checkout_id; await click(d, "lt");
  STRIPE.sessions[old].created -= 3600;
  const f0 = globalThis.fetch;
  globalThis.fetch = async (u, i) => { const r = await f0(u, i); if (!r.headers.get("Idempotent-Replayed")) return r; const h = new Headers(r.headers); h.delete("Idempotent-Replayed"); return new Response(await r.text(), { status: r.status, headers: h }); };
  const d3 = await click(d, "en"); globalThis.fetch = f0;
  const handed = d3.json && Object.values(STRIPE.sessions).find(s => s.url === d3.json.url);
  vuln(d3.status !== 200 || !handed || handed.status !== "open" || handed.id === old,
    `B33d a closed page from an hour ago comes back without Stripe's mark -> ${d3.status}, the page handed out is ${handed ? handed.status : "none"} (must be a new open page)`);
  reset();
}
// ---------- B34: every refusal at Fund carries a code the page can say in the client's language; a payment record that
// looks wrong is noted for the owner, and the note goes once the record checks out ----------
{
  const click = (c, token = "tok_cl") => call(fx.checkout, req("POST", "x", { token, body: { contract_id: c.id, lang: "lt" } }));
  const pagesOf = (c) => Object.values(STRIPE.sessions).filter(s => s.client_reference_id === c.id);
  // a) the codes
  const plain = mk();
  const rOut = await call(fx.checkout, req("POST", "x", { body: { contract_id: plain.id } }));
  users.cl.banned = true; const rBan = await click(plain); users.cl.banned = false;
  const rOther = await click(plain, "tok_cl2");
  const rDirect = await click(mk({ payment_mode: "direct" }));
  const rSmall = await click(mk({ amount_cents: 50, price: 0.5 }));
  const rCb = await click(mk({ status: "funded", funded_cents: 10000, amount_cents: 13000, price: 130, chargeback_status: "open", chargeback_id: "dp_x" }));
  for (const [what, r, status, code] of [["signed out", rOut, 401, "signed_out"], ["a suspended account", rBan, 403, "account_suspended"], ["someone else's Order", rOther, 403, "not_your_order"],
    ["an Order paid directly", rDirect, 409, "paid_directly"], ["an amount under €1", rSmall, 409, "amount_out_of_range"], ["a top-up while a card chargeback is open", rCb, 409, "chargeback_open"]])
    vuln(r.status !== status || !r.json || r.json.code !== code, `B34a Fund refused for ${what} -> ${r.status} ${JSON.stringify(r.json)} (must be ${status} with code ${code})`);
  // b) each mark that only money moving leaves, alone on an Order waiting for its first payment: refused, noted for the owner
  for (const [what, extra, words] of [
    ["a payment time", { funded_at: new Date().toISOString() }, "a payment time"], ["a card payment", { stripe_payment_intent: "pi_x" }, "a card payment"],
    ["money paid in", { funded_cents: 100 }, "money paid in"], ["money paid out", { released_cents: 100 }, "money paid out"], ["money refunded", { refunded_cents: 100 }, "money refunded"],
    ["a payout to the freelancer", { stripe_transfer_id: "tr_1" }, "a payout to the freelancer"], ["a refund at Stripe", { stripe_refund_id: "re_1" }, "a refund"],
    ["a reversal", { stripe_reversal_id: "trr_1" }, "a reversal"], ["the mode it was paid in", { paid_mode: "test" }, "the mode it was paid in"],
    ["a refund decided on its money", { refund_cents: 5000 }, "a decision on its money"], ["a split decided on its money", { split_editor_cents: 5000 }, "a decision on its money"],
  ]) {
    const c = mk(extra); const r = await click(c);
    vuln(r.status !== 409 || !r.json || r.json.code !== "needs_check" || pagesOf(c).length !== 0 || !String(c.money_error || "").startsWith("Payment record needs checking: ") || !String(c.money_error).includes(words),
      `B34b an Order waiting for its first payment that shows ${what} -> ${r.status} ${r.json && r.json.code}, pages made ${pagesOf(c).length}, note ${JSON.stringify(c.money_error || null)} (must be refused with needs_check and a note naming it)`);
  }
  const led = mk(); DB.order_payments.push({ id: uuid(), order_id: led.id, kind: "fund", status: "succeeded", amount_cents: 10000, provider: "stripe", provider_ref: "pi_led" });
  const rLed = await click(led);
  vuln(rLed.status !== 409 || rLed.json?.code !== "needs_check" || !String(led.money_error || "").includes("a payment in its ledger"), `B34b an Order waiting for its first payment with a payment in its ledger -> ${rLed.status} ${rLed.json?.code}, note ${JSON.stringify(led.money_error || null)}`);
  // c) a paid Order whose amount paid in is missing, and one with more paid in than its price: refused and noted
  const f0 = mk({ status: "funded", funded_cents: 0, amount_cents: 13000, price: 130 }); const r0 = await click(f0);
  const fx2 = mk({ status: "funded", funded_cents: 15000, amount_cents: 13000, price: 130 }); const r2 = await click(fx2);
  vuln(r0.status !== 409 || r0.json?.code !== "needs_check" || !String(f0.money_error || "").includes("amount paid in is missing"), `B34c a paid Order without the amount paid in -> ${r0.status} ${r0.json?.code}, note ${JSON.stringify(f0.money_error || null)}`);
  vuln(r2.status !== 409 || r2.json?.code !== "needs_check" || !String(fx2.money_error || "").includes("more was paid in (€150.00) than the Order's price (€130.00)"), `B34c more paid in than the price -> ${r2.status} ${r2.json?.code}, note ${JSON.stringify(fx2.money_error || null)}`);
  // d) another note already on the Order is never written over; once the record checks out, this check's own note goes
  const other = mk({ funded_at: new Date().toISOString(), money_error: "Stripe account check: something else" }); await click(other);
  vuln(other.money_error !== "Stripe account check: something else", `B34d another note on the Order -> ${JSON.stringify(other.money_error)} (must stay as it was)`);
  const fixed = mk({ funded_at: new Date().toISOString() }); await click(fixed); const noted = fixed.money_error;
  fixed.funded_at = null; const rFixed = await click(fixed);                       // corrected by hand
  vuln(!noted || rFixed.status !== 200 || fixed.money_error != null || pagesOf(fixed).length !== 1, `B34d the record corrected by hand -> ${rFixed.status}, note before ${JSON.stringify(noted)}, after ${JSON.stringify(fixed.money_error ?? null)} (must be paid normally, the note gone)`);
  // e) a decided card chargeback alone (one can come for a late payment that was sent back) does not block the first payment
  const cbd = mk({ chargeback_id: "dp_old", chargeback_status: "won", chargeback_cents: 10178 }); const rCbd = await click(cbd);
  vuln(rCbd.status !== 200 || pagesOf(cbd).length !== 1 || cbd.money_error, `B34e an Order waiting for its first payment with only a decided chargeback on a sent-back payment -> ${rCbd.status} ${JSON.stringify(rCbd.json)} (must get its payment page)`);
  reset();
}
// ---------- B35: the total with the card fee above Stripe's per-payment limit is refused with a code the page can translate ----------
{
  const c = mk({ amount_cents: 95000000, price: 950000 });
  hooks.rpc = async (fn, args) => (fn === "order_quote" ? [200, { price_cents: args.p_price_cents, processing_cents: 9000000, cuvori_cents: 0, total_cents: args.p_price_cents + 9000000, currency: "EUR", payer: "client", percent: 9.47, fixed_cents: 0, schedule_id: 3, region: "ANY" }] : null);
  const r = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, lang: "lt" } }));
  reset();
  vuln(r.status !== 400 || !r.json || r.json.code !== "amount_out_of_range" || Object.values(STRIPE.sessions).some(s => s.client_reference_id === c.id),
    `B35 a €950,000 Order whose total with the card fee passes Stripe's limit -> ${r.status} ${JSON.stringify(r.json)} (must be refused with code amount_out_of_range, no page made)`);
}
// ---------- B36: right after its own "needs checking" note goes, a failing check of the freelancer's account is still noted ----------
{
  const click = (c) => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, lang: "en" } }));
  const c = mk({ funded_at: new Date().toISOString() }); await click(c); const before = c.money_error;
  c.funded_at = null;                                                            // the record corrected by hand
  hooks.stripe = async (path, method) => (method === "GET" && path.startsWith("/accounts/") ? [500, { error: { type: "api_error", message: "An unknown error occurred" } }] : null);
  const r = await click(c); reset();
  vuln(!String(before || "").startsWith("Payment record needs checking: ") || r.status !== 500 || !String(c.money_error || "").startsWith("Stripe check failed: ") || !String(c.money_error).includes(r.json && r.json.ref),
    `B36 the record corrected, then Stripe can't be reached on the same click -> ${r.status} ref ${r.json && r.json.ref}; note before ${JSON.stringify(before)}, after ${JSON.stringify(c.money_error ?? null)} (must be the Stripe check note, with the same ref)`);
}
// ---------- B37: the ledger of an Order waiting for its first payment: which lines stop the payment ----------
{
  const click = (c) => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, lang: "en" } }));
  for (const [kind, blocks, words] of [["fund", true, "a payment in its ledger"], ["release", true, "a payout in its ledger"], ["reversal", true, "a reversal in its ledger"],
    ["refund", false, ""], ["chargeback", false, ""]]) {
    const c = mk(); DB.order_payments.push({ id: uuid(), order_id: c.id, kind, status: "succeeded", amount_cents: 100, provider: "stripe", provider_ref: "x_" + kind });
    const r = await click(c);
    const made = Object.values(STRIPE.sessions).some(s => s.client_reference_id === c.id);
    vuln(blocks ? (r.status !== 409 || r.json?.code !== "needs_check" || made || !String(c.money_error || "").includes(words)) : (r.status !== 200 || !made || c.money_error),
      `B37 an Order waiting for its first payment with only a ${kind} line in its ledger -> ${r.status} ${r.json?.code || "page made"}, note ${JSON.stringify(c.money_error ?? null)} (must ${blocks ? "be stopped and noted" : "be paid normally: such a line can belong to a late payment that was sent back"})`);
  }
}
// ---------- B38: when the sign-in check itself can't be done, the answer carries a code the page can translate ----------
{
  const c = mk(); const f0 = globalThis.fetch;
  for (const [what, resp, status, code] of [
    ["Supabase's sign-in service down", () => new Response("{}", { status: 503 }), 503, "signin_unavailable"],
    ["Supabase's sign-in service not reachable", () => { throw new TypeError("fetch failed"); }, 503, "signin_unavailable"],
    ["an unreadable answer from the sign-in service", () => new Response("not json", { status: 200 }), 503, "signin_unavailable"],
    ["the sign-in service too busy", () => new Response("{}", { status: 429 }), 429, "too_many_tries"],
    ["the account banned at the sign-in level", () => new Response(JSON.stringify({ error_code: "user_banned", msg: "User is banned" }), { status: 403 }), 403, "account_suspended"],
    ["Cuvori's own key refused by the sign-in service", () => new Response(JSON.stringify({ message: "Invalid API key" }), { status: 401 }), 503, "signin_unavailable"],
  ]) {
    globalThis.fetch = async (u, i) => (String(u).includes("/auth/v1/user") ? resp() : f0(u, i));
    const r = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, lang: "lt" } }));
    globalThis.fetch = f0;
    vuln(r.status !== status || !r.json || r.json.code !== code || Object.values(STRIPE.sessions).some(s => s.client_reference_id === c.id),
      `B38 ${what} -> ${r.status} ${JSON.stringify(r.json)} (must be ${status} with code ${code}, no page made)`);
  }
  // an expired or fake sign-in still just asks the person to sign in again
  const r = await call(fx.checkout, req("POST", "x", { token: "tok_nobody", body: { contract_id: c.id } }));
  vuln(r.status !== 401 || r.json?.code !== "signed_out", `B38 an expired sign-in -> ${r.status} ${JSON.stringify(r.json)} (must be 401 signed_out)`);
}
// ---------- B39: a payment record that needs checking is always on record for the owner, even when no note can be written ----------
{
  const click = (c) => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, lang: "en" } }));
  const logged = []; const e0 = console.error; console.error = (...a) => { logged.push(a.map(String).join(" ")); };
  const a = mk({ funded_at: new Date().toISOString() }); await click(a);                                              // an empty note: written
  const b = mk({ funded_at: new Date().toISOString(), money_error: "Stripe account check: something else" }); await click(b);   // another note: kept
  const d = mk({ funded_at: new Date().toISOString() });
  hooks.db = async (method, table, search) => (method === "PATCH" && table === "contracts" && search.includes(`id=eq.${d.id}`) ? new Response(JSON.stringify({ message: "timeout" }), { status: 503 }) : null);
  const rd = await click(d); reset();                                                                                    // the note can't be saved
  console.error = e0;
  const line = (c) => logged.find(l => l.startsWith("Payment record needs checking") && l.includes(c.id) && l.includes("a payment time"));
  vuln(!line(a) || !line(a).includes("(noted on the Order)") || !String(a.money_error || "").startsWith("Payment record needs checking: "),
    `B39 an empty note -> note ${JSON.stringify(a.money_error ?? null)}, log ${JSON.stringify(line(a) || null)} (must be noted and logged)`);
  vuln(!line(b) || !line(b).includes("not noted: the Order already has another note") || b.money_error !== "Stripe account check: something else",
    `B39 another note on the Order -> note ${JSON.stringify(b.money_error)}, log ${JSON.stringify(line(b) || null)} (the other note must stay, the problem must be logged)`);
  vuln(rd.status !== 409 || rd.json?.code !== "needs_check" || !line(d) || !line(d).includes("the note could not be saved"),
    `B39 the note can't be saved -> ${rd.status} ${rd.json?.code}, log ${JSON.stringify(line(d) || null)} (must still refuse, and be logged)`);
}
// ---------- B40: an empty note never stops the real one, and the log says truly why a note was not saved ----------
{
  const click = (c) => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, lang: "en" } }));
  const logged = []; const e0 = console.error; console.error = (...a) => { logged.push(a.map(String).join(" ")); };
  const line = (c) => logged.find(l => l.startsWith("Payment record needs checking") && l.includes(c.id)) || null;
  const own = (c) => String(c.money_error || "").startsWith("Payment record needs checking: this Order is waiting for its first payment");
  for (const [what, blank] of [["an empty note", ""], ["a note of only spaces", "   "]]) {
    const c = mk({ funded_at: new Date().toISOString(), money_error: blank });
    const r = await click(c);
    vuln(r.status !== 409 || r.json?.code !== "needs_check" || !own(c) || !String(line(c)).includes("(noted on the Order)"),
      `B40 ${what} on the Order -> ${r.status} ${r.json?.code}, note ${JSON.stringify(c.money_error)}, log ${JSON.stringify(line(c))} (the real note must be written)`);
  }
  // the note changed between reading the Order and saving (another click wrote it at the same moment): nothing saved, said truly
  const d = mk({ funded_at: new Date().toISOString() });
  hooks.db = async (method, table, search) => (method === "PATCH" && table === "contracts" && search.includes(`id=eq.${d.id}`) ? new Response("[]", { status: 200, headers: { "content-type": "application/json" } }) : null);
  const rd = await click(d); reset();
  vuln(rd.status !== 409 || !String(line(d)).includes("this click did not save the note: it changed at the same moment") || String(line(d)).includes("could not be saved"),
    `B40 the note changed at the same moment -> ${rd.status} ${rd.json?.code}, log ${JSON.stringify(line(d))} (must say this click did not save it, not that saving failed)`);
  console.error = e0;
}
// ---------- B41: a failure Stripe replays from its memory of the key never blocks Fund, even when Stripe also says "retry" ----------
{
  const c = mk({});
  const f0 = globalThis.fetch; let stuckKey = null; const keys = [];
  globalThis.fetch = async (u, i = {}) => {
    if (String(u) === "https://api.stripe.com/v1/checkout/sessions" && (i.method || "GET") === "POST" && String(i.body || "").includes(c.id)) {
      const k = i.headers["Idempotency-Key"]; keys.push(k); if (!stuckKey) stuckKey = k;
      if (k === stuckKey) return new Response(JSON.stringify({ error: { type: "api_error", message: "An unknown error occurred" } }), { status: 500, headers: { "content-type": "application/json", "Idempotent-Replayed": "true", "Stripe-Should-Retry": "true" } });
    }
    return f0(u, i);
  };
  const quiet = console.error; console.error = () => {};
  const r = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, lang: "en" } }));
  console.error = quiet; globalThis.fetch = f0;
  vuln(r.status !== 200 || !r.json?.url || new Set(keys).size !== 2 || keys.length !== 2,
    `B41 Stripe replays a saved 500 that also says "retry" -> ${r.status} ${r.json?.code || (r.json?.url ? "page made" : "")}, tries ${keys.length}, keys ${new Set(keys).size} (must make one fresh try with a new key and give the page)`);
  // a definite failure that is not a replay still gets no second try in the same click
  const d = mk({}); const k2 = [];
  globalThis.fetch = async (u, i = {}) => {
    if (String(u) === "https://api.stripe.com/v1/checkout/sessions" && (i.method || "GET") === "POST" && String(i.body || "").includes(d.id)) {
      k2.push(i.headers["Idempotency-Key"]);
      return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "bad" } }), { status: 400, headers: { "content-type": "application/json" } });
    }
    return f0(u, i);
  };
  console.error = () => {};
  const rd = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: d.id, lang: "en" } }));
  console.error = quiet; globalThis.fetch = f0;
  vuln(k2.length !== 1 || rd.status === 200, `B41 a new (not replayed) refusal from Stripe -> ${rd.status}, tries ${k2.length} (must not be tried again in the same click)`);
}
// ---------- B42: the browser may remember the answer to its "may I?" check for 10 minutes, and only on Cuvori's own site ----------
{
  const pre = await call(fx.checkout, req("OPTIONS", "x", { headers: { origin: "https://cuvori.io", "access-control-request-method": "POST" } }));
  const evil = await call(fx.checkout, req("OPTIONS", "x", { headers: { origin: "https://evil.example", "access-control-request-method": "POST" } }));
  vuln(pre.status !== 204 || pre.headers.get("access-control-max-age") !== "600" || pre.headers.get("access-control-allow-origin") !== "https://cuvori.io"
       || evil.headers.get("access-control-allow-origin") || evil.headers.get("access-control-max-age"),
    `B42 the "may I?" check from cuvori.io -> ${pre.status}, remembered for ${pre.headers.get("access-control-max-age")} s; from another site -> allowed ${evil.headers.get("access-control-allow-origin")}, remembered ${evil.headers.get("access-control-max-age")} (must be 600 s for Cuvori, nothing for others)`);
}
// ---------- B43: a cancel note of several megabytes (sent by hand: the page sends none) is shortened at once, so it never holds up the cancel ----------
{
  const c = mk(); await fund(fx, c);
  const huge = "Sorry, I cannot finish this. " + "a".repeat(6e6);
  const t = performance.now();
  const r = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id, note: huge } }));
  const ms = Math.round(performance.now() - t);
  const ev = DB.order_events.find(e => e.order_id === c.id && e.event === "cancelled");
  const note = (ev && ev.data && ev.data.note) || "";
  vuln(r.status !== 200 || c.status !== "refunded" || note !== huge.slice(0, 500) || ms > 1500,
    `B43 a freelancer cancels with a 6 MB note -> HTTP ${r.status} ${r.json && r.json.error || ""}, status=${c.status}, the history keeps ${note.length} characters (must be the first 500), took ${ms} ms (must not be held up: it took over 4 s before)`);
  reset();
}
console.log(out.join("\n"));
console.log(`\n${out.filter(l => l.startsWith("VULNERABLE")).length} vulnerable / ${out.filter(l => l.startsWith("safe")).length} safe / ${out.filter(l => l.startsWith("info")).length} info`);
