// Money attack suite: every way a payment can go wrong — bank delays, failed transfers and refunds,
// chargebacks before and after release, top-ups, milestones under contention, missed webhooks,
// tampering, stuck states. Each check names the scenario in plain words.
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
  // even if both were somehow paid, the second payment goes straight back
  const p2 = pay(s2); await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: p2 } })));
  STRIPE.sessions[s1].status = "open"; const p1 = pay(s1); const w = await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: p1 } })));
  vuln(c.funded_cents !== 10000 || moneyOut(c).refunded !== p1.amount_total, `B8b both paid anyway -> webhook ${w.status}, funded=${c.funded_cents}, refunded back=${moneyOut(c).refunded} (the second payment incl. its fee, ${p1.amount_total})`);
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
  vuln(w.status !== 200 || d.status !== "accepted" || moneyOut(d).orphans !== 10178, `B29a a card payment arrives for a direct-payment Order -> ${w.status}, status=${d.status}, sent back=${moneyOut(d).orphans}`);
  const c = mk({ amount_cents: 20000, has_milestones: true }); await fund(fx, c); c.status = "funded";
  const ms = [{ id: uuid(), order_id: c.id, title: "a", amount_cents: 8000, status: "submitted" }, { id: uuid(), order_id: c.id, title: "b", amount_cents: 12000, status: "pending" }]; DB.order_milestones.push(...ms);
  const rs = await Promise.all([1, 2, 3].map(() => call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, milestone_id: ms[0].id } }))));
  vuln(moneyOut(c).transferred !== 8000 || ms[0].status !== "released" || c.released_cents !== 8000 || c.status !== "funded", `B29b the same milestone approved three times at once -> ${rs.map(r => r.status).join("/")}, transferred=${moneyOut(c).transferred}, milestone=${ms[0].status}, released_cents=${c.released_cents}, order=${c.status}`);
  reset();
}
console.log(out.join("\n"));
console.log(`\n${out.filter(l => l.startsWith("VULNERABLE")).length} vulnerable / ${out.filter(l => l.startsWith("safe")).length} safe / ${out.filter(l => l.startsWith("info")).length} info`);
