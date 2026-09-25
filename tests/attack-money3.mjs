// Money attack suite, round three: the cases an independent review raised against the round-two fixes —
// a settlement that finds nothing left to move, dashboard refunds mirrored twice, pull-backs that failed
// half-way and are retried, stale claim and lock rows left by a function that died, a chargeback landing
// while a milestone release is in flight, refunds on orders that no longer hold money.
import { DB, STRIPE, users, hooks, urls, req, signed, call, mk, past, moneyOut, reset, onlyDue, fns, fund, pay, uuid, stripeHandle } from "./fn-harness.mjs";
const out = []; const vuln = (c, m) => out.push((c ? "VULNERABLE " : "safe       ") + m); const info = (m) => out.push("info       " + m);
const fx = await fns();
const ledger = (c, kind) => DB.order_payments.filter(p => p.order_id === c.id && (!kind || p.kind === kind));
const chargeOf = (pi) => STRIPE.charges[STRIPE.intents[pi].latest_charge];
const chargeEvent = (ch) => signed({ type: "charge.refunded", data: { object: { id: ch.id, object: "charge", payment_intent: ch.payment_intent, amount: ch.amount, amount_refunded: ch.amount_refunded, refunded: ch.amount_refunded >= ch.amount } } });
const cbEvent = (type, ch, extra = {}) => signed({ type, data: { object: { id: extra.id || "dp_" + ch.id, object: "dispute", charge: ch.id, payment_intent: ch.payment_intent, amount: extra.amount || ch.amount, status: extra.status || "needs_response", ...extra } } });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const refundsOn = (pi) => STRIPE.refunds.filter(r => r.payment_intent === pi).reduce((a, r) => a + r.amount, 0);
const sum = (rows) => rows.reduce((a, r) => a + r.amount_cents, 0);
const reversalsOf = (c) => { const ids = new Set(STRIPE.transfers.filter(t => t.contract === c.id).map(t => t.id)); return STRIPE.reversals.filter(r => ids.has(r.transfer)); };
const books = (c) => { const m = moneyOut(c); return `status=${c.status} transferred=${m.transferred} refunded=${m.refunded} | released_cents=${c.released_cents} refunded_cents=${c.refunded_cents} | ledger release=${sum(ledger(c, "release"))} refund=${sum(ledger(c, "refund"))} | money_error=${c.money_error || "-"}`; };
// the hourly job an hour later, with the row untouched (resolved_at stays the decision's timestamp)
const hourlyLater = async (c) => { onlyDue(c); const real = Date.now; Date.now = () => real() + 3600e3; try { return await call(fx.autoRelease, req("POST", "x")); } finally { Date.now = real; } };
const split = (c) => call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "split", editor_percent: 50 } }));
const disputed = async () => { const c = mk(); await fund(fx, c); c.status = "disputed"; c.dispute_by = users.cl.id; c.disputed_at = past(); return c; };
const res = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
// ---- P1: the last milestone is approved while the freelancer cancels; the release wins the lock ----
{
  const c = mk({ amount_cents: 10000, has_milestones: true }); await fund(fx, c); c.status = "funded";
  const m = { id: uuid(), order_id: c.id, title: "m1", amount_cents: 10000, status: "submitted", position: 1 }; DB.order_milestones.push(m);
  hooks.stripe = async (path, method) => { if (method === "POST" && path === "/transfers") await sleep(150); };
  const pA = call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, milestone_id: m.id } }));
  await sleep(40);                                                       // the release holds the lock and is at Stripe
  const pB = call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id } }));
  const [a, b] = await Promise.all([pA, pB]);
  const mo = moneyOut(c);
  info(`P1a release ${a.status} ${a.json && a.json.error || ""} / cancel ${b.status} ${b.json && b.json.error || ""} -> status=${c.status}, held=${c.funded_cents - c.released_cents - c.refunded_cents}, transferred=${mo.transferred}, refunded=${mo.refunded}, split=${c.split_editor_cents}/${c.refund_cents}, money_error=${c.money_error || ""}`);
  vuln(c.status === "resolving", `P1b the order is left in '${c.status}' although everything went to the freelancer (should be completed)`);
  // the hourly job: does it ever get this order out of 'resolving'?
  c.resolved_at = past(1);
  for (const x of DB.contracts) if (x !== c && ["delivered", "releasing", "resolving"].includes(x.status)) x.status = "completed";
  const j1 = await call(fx.autoRelease, req("POST", "x"));
  const j2 = await call(fx.autoRelease, req("POST", "x"));
  vuln(c.status === "resolving", `P1c after two hourly runs -> status=${c.status}, failures=${JSON.stringify((j2.json || {}).failures)}`);
  reset();
}
// ---- P2: a dashboard partial refund is mirrored into refunded_cents (fix 6), then the admin refunds what is held (fix 7) ----
{
  const c = mk({ amount_cents: 10000 }); const f = await fund(fx, c); const pi = f.session.payment_intent; const ch = chargeOf(pi);
  STRIPE.refunds.push({ id: "re_dashA", amount: 3000, metadata: {}, payment_intent: pi, charge: ch.id, status: "succeeded" }); ch.amount_refunded += 3000;
  const w = await call(fx.webhook, req("POST", "x", chargeEvent(ch)));
  info(`P2a dashboard refund 3000 -> webhook ${w.status}, status=${c.status}, refunded_cents=${c.refunded_cents}, held=${c.funded_cents - c.released_cents - c.refunded_cents}`);
  const r = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "refund" } }));
  const total = refundsOn(pi);
  vuln(total !== 10000, `P2b admin decides 'refund' (${r.status} ${r.json && r.json.error || ""}) -> client got back ${total} in total at Stripe (must be 10000: 3000 dashboard + 7000 held); status=${c.status}, refunded_cents=${c.refunded_cents}`);
  info(`P2c money left in the platform balance for this order: ${10000 - total - moneyOut(c).transferred}`);
  reset();
}
// ---- P2s: same with a split decision ----
{
  const c = mk({ amount_cents: 10000 }); const f = await fund(fx, c); const pi = f.session.payment_intent; const ch = chargeOf(pi);
  STRIPE.refunds.push({ id: "re_dashB", amount: 3000, metadata: {}, payment_intent: pi, charge: ch.id, status: "succeeded" }); ch.amount_refunded += 3000;
  await call(fx.webhook, req("POST", "x", chargeEvent(ch)));
  const r = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "split", editor_percent: 50 } }));
  const total = refundsOn(pi), mo = moneyOut(c);
  vuln(total + mo.transferred !== 10000, `P2d admin splits 50/50 of the 7000 held (${r.status}) -> freelancer ${mo.transferred}, client back ${total} (3000 + 3500 = 6500 expected) => ${10000 - total - mo.transferred} stranded in the platform balance`);
  reset();
}

// ---- P3: two partial refunds in the dashboard on the same charge (charge.refunded fires for each) ----
{
  const c = mk({ amount_cents: 10000 }); const f = await fund(fx, c); const pi = f.session.payment_intent; const ch = chargeOf(pi);
  STRIPE.refunds.push({ id: "re_d1", amount: 3000, metadata: {}, payment_intent: pi, charge: ch.id, status: "succeeded" }); ch.amount_refunded += 3000;
  const w1 = await call(fx.webhook, req("POST", "x", chargeEvent(ch)));
  STRIPE.refunds.push({ id: "re_d2", amount: 3000, metadata: {}, payment_intent: pi, charge: ch.id, status: "succeeded" }); ch.amount_refunded += 3000;
  const w2 = await call(fx.webhook, req("POST", "x", chargeEvent(ch)));
  vuln(c.refunded_cents !== 6000, `P3a two dashboard refunds of 3000 (${w1.status}/${w2.status}) -> refunded_cents=${c.refunded_cents} (must be 6000), refund rows=${ledger(c, "refund").length}, held=${c.funded_cents - c.released_cents - c.refunded_cents} (really ${10000 - 6000})`);
  // the admin, believing 7000 is held, releases it to the freelancer
  const r = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "release" } }));
  const mo = moneyOut(c); const refunded = STRIPE.refunds.filter(x => x.payment_intent === pi).reduce((a, x) => a + x.amount, 0);
  vuln(mo.transferred + refunded > 10000, `P3b admin 'release' (${r.status}) -> freelancer ${mo.transferred} + client ${refunded} = ${mo.transferred + refunded} out of a 10000 order (platform pays ${mo.transferred + refunded - 10000})`);
  reset();
}
// ---- P3c: partial then the remainder (full) in the dashboard ----
{
  const c = mk({ amount_cents: 10000 }); const f = await fund(fx, c); const pi = f.session.payment_intent; const ch = chargeOf(pi);
  STRIPE.refunds.push({ id: "re_e1", amount: 3000, metadata: {}, payment_intent: pi, charge: ch.id, status: "succeeded" }); ch.amount_refunded += 3000;
  await call(fx.webhook, req("POST", "x", chargeEvent(ch)));
  STRIPE.refunds.push({ id: "re_e2", amount: ch.amount - 3000, metadata: {}, payment_intent: pi, charge: ch.id, status: "succeeded" }); ch.amount_refunded = ch.amount;
  const w2 = await call(fx.webhook, req("POST", "x", chargeEvent(ch)));
  vuln(c.status !== "refunded", `P3c rest refunded in the dashboard too (${w2.status}) -> status=${c.status}, refunded_cents=${c.refunded_cents} (the whole payment is back with the client; order should be refunded)`);
  reset();
}
// ---- P4: chargeback on a completed 3-milestone order; the network drops on the 3rd reversal; Stripe retries ----
{
  const c = mk({ amount_cents: 30000, has_milestones: true }); const f = await fund(fx, c); c.status = "funded";
  const ms = [1, 2, 3].map(i => ({ id: uuid(), order_id: c.id, title: "m" + i, amount_cents: 10000, status: "submitted", position: i })); DB.order_milestones.push(...ms);
  for (const m of ms) await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, milestone_id: m.id } }));
  info(`P4a three milestones paid out -> status=${c.status}, released_cents=${c.released_cents}, transferred=${moneyOut(c).transferred}`);
  const ch = chargeOf(f.session.payment_intent); STRIPE.disputes[ch.id] = { status: "needs_response" };
  let n = 0;
  hooks.stripe = async (path, method) => { if (method === "POST" && /\/reversals$/.test(path) && ++n === 3) throw new TypeError("fetch failed"); };
  const w1 = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.created", ch)));
  info(`P4b first delivery -> ${w1.status}, released_cents=${c.released_cents}, freelancer keeps=${moneyOut(c).transferred}, money_error=${c.money_error || ""}`);
  const w2 = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.created", ch)));
  const w3 = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.created", ch)));
  const rev = sum(ledger(c, "reversal"));
  vuln(c.released_cents !== 0 || rev !== 30000, `P4c after the retries (${w2.status}/${w3.status}) -> released_cents=${c.released_cents} (must be 0), reversal ledger=${rev} (must be 30000), freelancer keeps=${moneyOut(c).transferred}, money_error=${c.money_error || ""}`);
  STRIPE.disputes[ch.id].status = "won";
  const ww = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.closed", ch, { status: "won" })));
  const j = await call(fx.autoRelease, req("POST", "x"));
  vuln(moneyOut(c).transferred !== 30000, `P4d bank sides with Cuvori (${ww.status}) + hourly job -> freelancer has ${moneyOut(c).transferred} (must be 30000), released_cents=${c.released_cents}, money_error=${c.money_error || ""}`);
  reset();
}
// ---- P5: a claim row left behind by a function that died between claiming and recording a top-up ----
{
  const c = mk(); await fund(fx, c); c.amount_cents = 12000;
  await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const s = pay(c.stripe_checkout_id);
  DB.money_keys.push({ scope: `apply:${s.payment_intent}`, key: "claim:dead", created_at: past(2) });   // the dead function's claim, 2 h old
  const w = await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: s } })));
  const k = await call(fx.confirm, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const w2 = await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: s } })));
  const j = await call(fx.autoRelease, req("POST", "x"));
  vuln(c.funded_cents !== 12000, `P5 top-up paid, stale claim row present -> webhook ${w.status} (Stripe stops retrying), page check ${k.status} result=${k.json && k.json.result}, again ${w2.status}; funded_cents=${c.funded_cents} (client paid for 12000), money_error=${c.money_error || "(none: nobody is told)"}, ledger fund rows=${ledger(c, "fund").length}`);
  reset();
}

// ---- P6: a lock left by a dead function (100 s old); two milestone approvals arrive; one waiter's DELETE is slow ----
{
  const c = mk({ amount_cents: 30000, has_milestones: true }); await fund(fx, c); c.status = "funded";
  c.funded_cents = 15000; STRIPE.charges[c.stripe_charge_id].amount = 15000;                   // only half arrived so far
  const ms = [1, 2].map(i => ({ id: uuid(), order_id: c.id, title: "m" + i, amount_cents: 10000, status: "submitted", position: i })); DB.order_milestones.push(...ms);
  DB.money_keys.push({ scope: `lock:${c.id}`, key: "claim:dead", created_at: new Date(Date.now() - 100e3).toISOString() });
  let slow = 1;
  hooks.db = async (method, table, search) => { if (method === "DELETE" && table === "money_keys" && /lock%3A/.test(search) && slow-- > 0) await sleep(60); return null; };
  const rs = await Promise.all(ms.map(m => call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, milestone_id: m.id } }))));
  const mo = moneyOut(c);
  vuln(mo.transferred > 15000, `P6 stale lock + two approvals (${rs.map(r => r.status).join("/")}) -> transferred=${mo.transferred} with only 15000 held; released_cents=${c.released_cents}`);
  reset();
}
// ---- P7: a chargeback arrives while a milestone release is at Stripe (the reversal is slower than the transfer) ----
{
  const c = mk({ amount_cents: 30000, has_milestones: true }); const f = await fund(fx, c); c.status = "funded";
  const ms = [1, 2, 3].map(i => ({ id: uuid(), order_id: c.id, title: "m" + i, amount_cents: 10000, status: "submitted", position: i })); DB.order_milestones.push(...ms);
  await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, milestone_id: ms[0].id } }));   // m1 paid: released 10000, held 20000
  const ch = chargeOf(f.session.payment_intent); STRIPE.disputes[ch.id] = { status: "needs_response" };
  hooks.stripe = async (path, method) => { if (method === "POST" && path === "/transfers") await sleep(30); if (method === "POST" && /\/reversals$/.test(path)) await sleep(120); };
  const pA = call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, milestone_id: ms[1].id } }));   // m2 being released
  await sleep(25);
  const pB = call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.created", ch)));                                    // bank pulls the whole charge
  const [a, b] = await Promise.all([pA, pB]);
  const mo = moneyOut(c);
  info(`P7a release m2 ${a.status} / chargeback webhook ${b.status} -> status=${c.status}, released_cents=${c.released_cents}, freelancer really keeps=${mo.transferred}, reversal ledger=${sum(ledger(c, "reversal"))}`);
  vuln(c.released_cents !== mo.transferred, `P7b the books say released_cents=${c.released_cents} but the freelancer holds ${mo.transferred}`);
  STRIPE.disputes[ch.id].status = "lost";
  const l = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.closed", ch, { status: "lost" })));
  vuln(c.refunded_cents + moneyOut(c).transferred > 30000, `P7c ...lost (${l.status}) -> refunded_cents=${c.refunded_cents} + freelancer keeps ${moneyOut(c).transferred} = ${c.refunded_cents + moneyOut(c).transferred} on a 30000 order (bank took ${ch.amount}); money_error=${c.money_error || "(none)"}`);
  reset();
}
// ---- P8: a full dashboard refund on an order that is completed / releasing ----
{
  const c = mk(); const f = await fund(fx, c); c.status = "delivered";
  await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));                            // completed, freelancer paid 10000
  const ch = chargeOf(f.session.payment_intent);
  STRIPE.refunds.push({ id: "re_full1", amount: ch.amount, metadata: {}, payment_intent: f.session.payment_intent, charge: ch.id, status: "succeeded" }); ch.amount_refunded = ch.amount;
  const w = await call(fx.webhook, req("POST", "x", chargeEvent(ch)));
  vuln(!c.money_error && !ledger(c, "refund").length, `P8a completed order, whole payment refunded in the dashboard (${w.status}) -> status=${c.status}, money_error=${c.money_error || "(none)"}, refund rows=${ledger(c, "refund").length}: the platform is out 10000 with no trace in Cuvori`);
  reset();
  // releasing: the transfer is in flight when the whole payment goes back from the dashboard
  const c2 = mk(); const f2 = await fund(fx, c2); c2.status = "delivered"; const ch2 = chargeOf(f2.session.payment_intent);
  hooks.stripe = async (path, method) => { if (method === "POST" && path === "/transfers") await sleep(80); };
  const pA = call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c2.id } }));
  await sleep(20);
  STRIPE.refunds.push({ id: "re_full2", amount: ch2.amount, metadata: {}, payment_intent: f2.session.payment_intent, charge: ch2.id, status: "succeeded" }); ch2.amount_refunded = ch2.amount;
  const pB = call(fx.webhook, req("POST", "x", chargeEvent(ch2)));
  const [a, b] = await Promise.all([pA, pB]);
  vuln(!c2.money_error && !ledger(c2, "refund").length, `P8b release ${a.status} / full dashboard refund during it ${b.status} -> status=${c2.status}, freelancer got ${moneyOut(c2).transferred}, client got ${ch2.amount_refunded}, money_error=${c2.money_error || "(none)"}, refund rows=${ledger(c2, "refund").length}`);
  reset();
}
// ---- P9: the reversal succeeds at Stripe, the database write after it fails; the webhook retries ----
{
  const c = mk(); const f = await fund(fx, c); c.status = "delivered";
  await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const ch = chargeOf(f.session.payment_intent); STRIPE.disputes[ch.id] = { status: "needs_response" };
  let cut = 1;
  hooks.db = async (method, table, search, body) => { if (method === "PATCH" && table === "contracts" && /stripe_reversal_id/.test(body || "") && cut-- > 0) return res(503, { message: "service unavailable" }); return null; };
  const w1 = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.created", ch)));
  info(`P9a reversal done at Stripe, DB write failed -> ${w1.status}, released_cents=${c.released_cents}, freelancer keeps=${moneyOut(c).transferred}, money_error=${c.money_error || ""}`);
  const w2 = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.created", ch)));
  vuln(c.released_cents !== 0 || sum(ledger(c, "reversal")) !== 10000, `P9b after the retry (${w2.status}) -> released_cents=${c.released_cents} (must be 0), reversal ledger=${sum(ledger(c, "reversal"))} (must be 10000), money_error=${c.money_error || "(none)"}`);
  STRIPE.disputes[ch.id].status = "won";
  await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.closed", ch, { status: "won" })));
  await call(fx.autoRelease, req("POST", "x"));
  vuln(moneyOut(c).transferred !== 10000, `P9c ...won -> freelancer has ${moneyOut(c).transferred} (must be 10000), money_error=${c.money_error || "(none)"}`);
  reset();
}

{
  const c = mk({ amount_cents: 30000, has_milestones: true }); await fund(fx, c); c.status = "funded";
  c.funded_cents = 15000; STRIPE.charges[c.stripe_charge_id].amount = 15000;                   // only half arrived so far
  const ms = [1, 2].map(i => ({ id: uuid(), order_id: c.id, title: "m" + i, amount_cents: 10000, status: "submitted", position: i })); DB.order_milestones.push(...ms);
  DB.money_keys.push({ scope: `lock:${c.id}`, key: "claim:dead", created_at: new Date(Date.now() - 100e3).toISOString() });
  let slow = 1; const holders = [];
  hooks.db = async (method, table, search, body) => {
    if (method === "DELETE" && table === "money_keys" && /lock%3A/.test(search) && slow-- > 0) await sleep(60);      // one waiter's DELETE of the stale row is slow
    if (method === "POST" && table === "money_keys" && /"scope":"lock:/.test(body || "")) holders.push(Date.now());
    return null;
  };
  hooks.stripe = async (path, method) => { if (method === "POST" && path === "/transfers") await sleep(150); };      // Stripe takes a moment for the transfer
  const t0 = Date.now();
  const rs = await Promise.all(ms.map(m => call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, milestone_id: m.id } }))));
  const mo = moneyOut(c);
  const lockRows = DB.money_keys.filter(k => k.scope === `lock:${c.id}`).length;
  info(`P6 lock claim attempts at +${holders.map(t => t - t0).join(", +")} ms; lock rows left=${lockRows}`);
  vuln(mo.transferred > 15000, `P6 stale lock + two approvals (${rs.map(r => r.status).join("/")}) -> transferred=${mo.transferred} with only 15000 held; released_cents=${c.released_cents}, transfers=${STRIPE.transfers.filter(t => t.contract === c.id).map(t => t.amount + (t.source_transaction ? "(src)" : "(bal)")).join(",")}`);
  reset();
}

{
  const c = mk(); const f = await fund(fx, c); c.status = "delivered";
  await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const ch = chargeOf(f.session.payment_intent); STRIPE.disputes[ch.id] = { status: "needs_response" };
  let cut = 1;
  hooks.stripe = async (path, method) => { if (method === "POST" && /\/reversals$/.test(path) && cut-- > 0) throw new TypeError("fetch failed"); };
  const w1 = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.created", ch)));
  const w2 = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.created", ch)));
  const evs = DB.order_events.filter(e => e.order_id === c.id).map(e => e.event);
  const flag = DB.user_flags.find(f => f.contract_id === c.id && f.kind === "chargeback");
  const card = DB.messages.find(m => m.conversation_id === c.conversation_id && m.payload && m.payload.event === "dispute" && m.payload.contract_id === c.id);
  vuln(!evs.includes("chargeback") || !flag || !card, `P10 reversal failed once (${w1.status}) then retried (${w2.status}) -> order events=${JSON.stringify(evs)}, chargeback user flag=${!!flag}, chat card=${!!card}, released_cents=${c.released_cents}`);
  reset();
}

// ---- Q1: PARTIAL chargeback (6000 of a 10178 charge) on a completed order; created, then lost weeks later ----
{
  const c = mk(); const f = await fund(fx, c); c.status = "delivered";
  await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));                       // freelancer paid 10000
  const ch = chargeOf(f.session.payment_intent); STRIPE.disputes[ch.id] = { status: "needs_response" };
  const w1 = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.created", ch, { amount: 6000 })));
  info(`Q1a partial chargeback 6000 -> ${w1.status}, pulled back=${sum(reversalsOf(c).map(r => ({ amount_cents: r.amount })))}, freelancer keeps=${moneyOut(c).transferred}, released_cents=${c.released_cents}`);
  const w2 = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.created", ch, { amount: 6000 })));   // Stripe delivers the event again
  info(`Q1b duplicate delivery -> ${w2.status}, reversals=${reversalsOf(c).length}, freelancer keeps=${moneyOut(c).transferred}, money_error=${c.money_error || "(none)"}`);
  vuln(!!c.money_error, `Q1c after a duplicate delivery the order carries money_error="${c.money_error || ""}" (hourly job retries it every hour)`);
  STRIPE.idem.clear();                                                                                              // 24 h later: Stripe forgot the idempotency keys
  STRIPE.disputes[ch.id].status = "lost";
  const l = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.closed", ch, { status: "lost", amount: 6000 })));
  vuln(moneyOut(c).transferred !== 4000, `Q1d ...lost (${l.status}) -> freelancer keeps ${moneyOut(c).transferred} (must be 4000: the bank only took 6000), reversals=${reversalsOf(c).length}, refunded_cents=${c.refunded_cents}, released_cents=${c.released_cents}`);
  reset();
}
// ---- Q2: two deliveries take over the same stale top-up claim at once (counter already bumped by the dead function) ----
{
  const c = mk(); await fund(fx, c); c.amount_cents = 12000;
  await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const s = pay(c.stripe_checkout_id);
  c.funded_cents = 12000;                                                                                          // the dead function moved the counter...
  DB.money_keys.push({ scope: `apply:${s.payment_intent}`, key: "claim:dead", created_at: past(2) });               // ...and left its claim
  const [w, k] = await Promise.all([
    call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: s } }))),
    call(fx.confirm, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } })),
  ]);
  const rows = ledger(c, "fund").filter(r => r.provider_ref === s.payment_intent);
  vuln(rows.length !== 1, `Q2a webhook retry ${w.status} + page check ${k.status} (${k.json && k.json.result}) take over together -> fund rows for the top-up=${rows.length} (must be 1), funded_cents=${c.funded_cents}`);
  const r = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id } }));            // freelancer gives everything back
  const back = STRIPE.refunds.filter(x => x.contract === c.id).reduce((a, x) => a + x.amount, 0);
  vuln(back !== 12000, `Q2b freelancer cancels (${r.status} ${r.json && r.json.error || ""}) -> client got back ${back} of 12000; status=${c.status}, money_error=${c.money_error || ""}`);
  reset();
}
// ---- Q3: an order funded twice (fund + top-up), both charges refunded in full from the dashboard ----
{
  const c = mk(); const f = await fund(fx, c); c.amount_cents = 12000;
  await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const s = pay(c.stripe_checkout_id); await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: s } })));
  for (const pi of [s.payment_intent, f.session.payment_intent]) {
    const ch = chargeOf(pi); STRIPE.refunds.push({ id: "re_" + ch.id, amount: ch.amount, metadata: {}, payment_intent: pi, charge: ch.id, status: "succeeded" }); ch.amount_refunded = ch.amount;
    await call(fx.webhook, req("POST", "x", chargeEvent(ch)));
  }
  info(`Q3a both charges refunded outside -> status=${c.status}, refunded_cents=${c.refunded_cents}, held=${c.funded_cents - c.released_cents - c.refunded_cents}`);
  const r = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "refund" } }));
  vuln(c.status === "disputed", `Q3b admin tries to close it (${r.status} ${r.json && r.json.error || ""}) -> status=${c.status} (nothing held, but the order can never be closed)`);
  reset();
}
// ---- Q4: dedupe against rows written by the currently deployed version (provider_ref = charge id, no charge_ref) ----
{
  const c = mk(); const f = await fund(fx, c); const pi = f.session.payment_intent; const ch = chargeOf(pi);
  // the deployed code mirrored a 3000 dashboard refund like this:
  STRIPE.refunds.push({ id: "re_old", amount: 3000, metadata: {}, payment_intent: pi, charge: ch.id, status: "succeeded" }); ch.amount_refunded += 3000;
  c.status = "disputed"; c.refunded_cents = 3000; DB.order_payments.push({ id: uuid(), order_id: c.id, kind: "refund", amount_cents: 3000, provider: "stripe", provider_ref: ch.id, status: "succeeded", note: "dashboard_refund", created_at: past(24) });
  // after the deploy, a second dashboard refund of 1000 on the same charge
  STRIPE.refunds.push({ id: "re_new", amount: 1000, metadata: {}, payment_intent: pi, charge: ch.id, status: "succeeded" }); ch.amount_refunded += 1000;
  const w = await call(fx.webhook, req("POST", "x", chargeEvent(ch)));
  vuln(c.refunded_cents !== 4000, `Q4 legacy mirrored row + new refund of 1000 (${w.status}) -> refunded_cents=${c.refunded_cents} (must be 4000), held=${c.funded_cents - c.released_cents - c.refunded_cents} (really 6000)`);
  reset();
}
// ---- Q5: a split whose transfer went through but whose refund keeps failing; a chargeback lands meanwhile ----
{
  const c = mk(); const f = await fund(fx, c); c.status = "disputed"; c.dispute_by = users.cl.id; c.disputed_at = past();
  hooks.stripe = async (path, method) => { if (method === "POST" && path === "/refunds") return [400, { error: { message: "You have insufficient funds in your Stripe account", code: "balance_insufficient" } }]; };
  const r = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "split", editor_percent: 50 } }));
  reset();
  info(`Q5a split 50/50, refund half refused -> ${r.status} ${r.json && r.json.error || ""}; status=${c.status}, transfer=${!!c.stripe_transfer_id}, freelancer has=${moneyOut(c).transferred}, released_cents=${c.released_cents}`);
  const ch = chargeOf(f.session.payment_intent); STRIPE.disputes[ch.id] = { status: "needs_response" };
  const w = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.created", ch)));
  info(`Q5b chargeback for the whole charge -> ${w.status}, status=${c.status}, pulled back=${reversalsOf(c).length}, freelancer keeps=${moneyOut(c).transferred}`);
  STRIPE.disputes[ch.id].status = "lost";
  const l = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.closed", ch, { status: "lost" })));
  vuln(moneyOut(c).transferred > 0 && !c.money_error, `Q5c ...lost (${l.status}) -> bank took ${ch.amount}, freelancer keeps ${moneyOut(c).transferred}, refunded_cents=${c.refunded_cents}, released_cents=${c.released_cents}, money_error=${c.money_error || "(none: platform loss unflagged)"}`);
  reset();
}

// ---- Q6: completed order funded by two payments; the bank disputes the first one in full; lost weeks later ----
{
  const c = mk(); const f = await fund(fx, c); c.amount_cents = 12000;
  await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const s = pay(c.stripe_checkout_id); await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: s } })));
  c.status = "delivered";
  await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));                       // freelancer paid 12000
  const ch = chargeOf(f.session.payment_intent); STRIPE.disputes[ch.id] = { status: "needs_response" };
  const w1 = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.created", ch)));
  info(`Q6a chargeback on the first payment (${ch.amount}) -> ${w1.status}, pulled back=${reversalsOf(c).reduce((a, r) => a + r.amount, 0)}, freelancer keeps=${moneyOut(c).transferred}, released_cents=${c.released_cents}`);
  STRIPE.idem.clear(); STRIPE.disputes[ch.id].status = "lost";
  const l = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.closed", ch, { status: "lost" })));
  vuln(moneyOut(c).transferred !== 12000 - ch.amount, `Q6b ...lost (${l.status}) -> freelancer keeps ${moneyOut(c).transferred} (must be ${12000 - ch.amount}), reversals=${reversalsOf(c).length}, refunded_cents=${c.refunded_cents}`);
  reset();
}
// ---- Q2 mechanism: where does the stale-claim delivery go? ----
{
  const c = mk(); await fund(fx, c); c.amount_cents = 12000;
  await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const s = pay(c.stripe_checkout_id);
  c.funded_cents = 12000; DB.money_keys.push({ scope: `apply:${s.payment_intent}`, key: "claim:dead", created_at: past(2) });
  const n0 = urls.length;
  const w = await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: s } })));
  const calls = urls.slice(n0).filter(u => /refunds|money_keys/.test(u)).map(u => u.replace(/https:\/\/[^/]+\/(rest\/v1|v1)/, "").slice(0, 60));
  const ch = chargeOf(s.payment_intent);
  vuln(ch.amount_refunded > 0, `Q2c stale claim + counter already bumped -> webhook ${w.status}; the top-up charge was refunded=${ch.amount_refunded} (as an orphan), funded_cents still ${c.funded_cents}; calls: ${JSON.stringify(calls)}`);
  reset();
}

// ---- D1: a split whose transfer went through but whose refund was refused, retried later by the hourly job: the books stay right
{
  const c = mk(); await fund(fx, c); c.status = "disputed"; c.dispute_by = users.cl.id; c.disputed_at = past();
  hooks.stripe = async (path, method) => { if (method === "POST" && path === "/refunds") return [400, { error: { message: "You have insufficient funds in your Stripe account", code: "balance_insufficient" } }]; };
  const r = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "split", editor_percent: 50 } }));
  reset();
  vuln(c.released_cents !== 5000 || ledger(c, "release").length !== 1 || c.status !== "resolving", `D1a split, refund refused (${r.status}) -> status=${c.status}, released_cents=${c.released_cents} (must already be 5000: the transfer was made), release rows=${ledger(c, "release").length}`);
  for (const x of DB.contracts) if (x !== c && ["delivered", "releasing", "resolving"].includes(x.status)) x.status = "completed";
  c.resolved_at = past(1);
  const j = await call(fx.autoRelease, req("POST", "x"));
  const mo = moneyOut(c);
  vuln(c.status !== "completed" || mo.transferred !== 5000 || mo.refunded !== 5000 || c.released_cents !== 5000 || c.refunded_cents !== 5000 || ledger(c, "release").length !== 1 || ledger(c, "refund").length !== 1,
    `D1b hourly retry -> status=${c.status}, freelancer ${mo.transferred}, client ${mo.refunded}, counters ${c.released_cents}/${c.refunded_cents}, ledger release×${ledger(c, "release").length} refund×${ledger(c, "refund").length} (each exactly once)`);
  reset();
}
// ---- D2: the same, but a chargeback lands while the refund is stuck; Cuvori wins; the admin decides again — the freelancer gets the whole amount once
{
  const c = mk(); const f = await fund(fx, c); c.status = "disputed"; c.dispute_by = users.cl.id; c.disputed_at = past();
  hooks.stripe = async (path, method) => { if (method === "POST" && path === "/refunds") return [400, { error: { message: "You have insufficient funds in your Stripe account", code: "balance_insufficient" } }]; };
  await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "split", editor_percent: 50 } }));
  reset();
  const ch = chargeOf(f.session.payment_intent); STRIPE.disputes[ch.id] = { status: "needs_response" };
  const w = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.created", ch)));
  info(`D2a chargeback during the stuck split -> ${w.status}, status=${c.status}, freelancer keeps=${moneyOut(c).transferred}, released_cents=${c.released_cents}`);
  STRIPE.disputes[ch.id].status = "won";
  const ww = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.closed", ch, { status: "won" })));
  const r2 = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "release" } }));
  const mo = moneyOut(c);
  vuln(r2.status !== 200 || mo.transferred !== 10000 || c.status !== "completed" || c.released_cents !== 10000 || mo.refunded !== 0,
    `D2b won (${ww.status}), admin releases everything (${r2.status} ${r2.json && r2.json.error || ""}) -> freelancer has ${mo.transferred} (must be 10000), refunded ${mo.refunded}, status=${c.status}, released_cents=${c.released_cents}, money_error=${c.money_error || ""}`);
  reset();
}

// ---- R1: split; transfer made and counted, but the ledger line fails (DB 503); hourly resume ----
{
  const c = await disputed(); let cut = 1;
  hooks.db = async (method, table, search, body) => (method === "POST" && table === "order_payments" && /"kind":"release"/.test(body || "") && cut-- > 0) ? res(503, { message: "unavailable" }) : null;
  const r = await split(c); reset();
  info(`R1a split 50/50, ledger line failed -> ${r.status}; ${books(c)}`);
  const j = await hourlyLater(c);
  const m = moneyOut(c);
  vuln(m.transferred !== 5000 || m.refunded !== 5000 || c.released_cents !== 5000 || c.refunded_cents !== 5000, `R1b hourly resume -> ${books(c)} (must be 5000/5000 both at Stripe and in the books)`);
  reset();
}
// ---- R2: a stuck client release is resumed by the hourly job while the admin takes it over ----
{
  const c = mk(); await fund(fx, c); c.status = "delivered"; let cut = 1;
  hooks.stripe = async (path, method) => { if (method === "POST" && path === "/transfers" && cut-- > 0) throw new TypeError("fetch failed"); };
  const r0 = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } })); reset();
  info(`R2a client release, provider unreachable -> ${r0.status}; status=${c.status}, transfer id=${c.stripe_transfer_id || "-"}`);
  c.resolved_at = past(1); onlyDue(c);
  hooks.stripe = async (path, method) => { if (method === "POST" && path === "/transfers") await sleep(150); };
  const pA = call(fx.autoRelease, req("POST", "x"));
  await sleep(60);                                                          // the resume is at Stripe with the transfer
  const pB = call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "release" } }));
  const [a, b] = await Promise.all([pA, pB]);
  const m = moneyOut(c);
  vuln(m.transferred > 10000, `R2b hourly resume ${a.status} + admin takeover ${b.status} ${b.json && b.json.error || ""} -> freelancer got ${m.transferred} of a 10000 order; transfers=${STRIPE.transfers.filter(t => t.contract === c.id).map(t => t.amount + "@" + (t.metadata.attempt || "-").slice(11, 23)).join(", ")}; ${books(c)}`);
  reset();
}
// ---- R3: the other interruption points, each followed by the hourly resume ----
{
  // A: transfer made, count()'s PATCH fails
  const c = await disputed(); let cut = 1;
  hooks.db = async (method, table, search, body) => (method === "PATCH" && table === "contracts" && /stripe_transfer_id/.test(body || "") && /released_cents/.test(body || "") && cut-- > 0) ? res(503, { message: "unavailable" }) : null;
  const r = await split(c); reset(); await hourlyLater(c);
  const m = moneyOut(c);
  vuln(m.transferred !== 5000 || m.refunded !== 5000 || c.released_cents !== 5000 || c.refunded_cents !== 5000 || c.status !== "completed", `R3a count() PATCH failed once (${r.status}) -> ${books(c)}`);
  reset();
  // C: everything moved and counted, the final status update fails
  const c2 = await disputed(); cut = 1;
  hooks.db = async (method, table, search, body) => (method === "PATCH" && table === "contracts" && /"status":"completed"/.test(body || "") && cut-- > 0) ? res(503, { message: "unavailable" }) : null;
  const r2 = await split(c2); reset(); await hourlyLater(c2);
  const m2 = moneyOut(c2);
  vuln(m2.transferred !== 5000 || m2.refunded !== 5000 || c2.released_cents !== 5000 || c2.refunded_cents !== 5000 || c2.status !== "completed", `R3c final update failed once (${r2.status}) -> ${books(c2)}`);
  reset();
  // D: refund refused (balance), hourly retry
  const c3 = await disputed(); cut = 1;
  hooks.stripe = async (path, method) => (method === "POST" && path === "/refunds" && cut-- > 0) ? [400, { error: { message: "You have insufficient funds in your Stripe account", code: "balance_insufficient" } }] : undefined;
  const r3 = await split(c3); reset(); await hourlyLater(c3);
  const m3 = moneyOut(c3);
  vuln(m3.transferred !== 5000 || m3.refunded !== 5000 || c3.released_cents !== 5000 || c3.refunded_cents !== 5000 || c3.status !== "completed", `R3d refund refused once (${r3.status}) -> ${books(c3)}`);
  reset();
  // R4: the transfer is made at Stripe but the answer is lost (network); the resume must reuse it (attempt tag)
  const c4 = mk(); await fund(fx, c4); c4.status = "delivered"; cut = 1;
  hooks.stripe = async (path, method, p) => { if (method === "POST" && path === "/transfers" && cut-- > 0) { stripeHandle(path, method, p); throw new TypeError("fetch failed"); } };
  const r4 = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c4.id } })); reset();
  const r5 = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c4.id } }));   // the client clicks again
  const m4 = moneyOut(c4);
  vuln(m4.transferred !== 10000 || c4.released_cents !== 10000 || c4.status !== "completed", `R4 transfer made, answer lost (${r4.status}); client retries (${r5.status}) -> ${books(c4)}; transfers=${STRIPE.transfers.filter(t => t.contract === c4.id).length}`);
  reset();
}

{
  // A: transfer made, count()'s PATCH fails; the hourly job resumes an hour later
  const c = await disputed(); let cut = 1;
  hooks.db = async (method, table, search, body) => (method === "PATCH" && table === "contracts" && /stripe_transfer_id/.test(body || "") && /released_cents/.test(body || "") && cut-- > 0) ? res(503, { message: "unavailable" }) : null;
  const r = await split(c); reset(); const j = await hourlyLater(c);
  const m = moneyOut(c);
  vuln(m.transferred !== 5000 || m.refunded !== 5000 || c.released_cents !== 5000 || c.refunded_cents !== 5000 || c.status !== "completed", `R3a' count() PATCH failed once (${r.status}), hourly an hour later (${j.status}) -> ${books(c)}; transfers=${STRIPE.transfers.filter(t => t.contract === c.id).length}`);
  reset();
  // B again, with the clock instead of the row: transfer counted, ledger line failed
  const c2 = await disputed(); cut = 1;
  hooks.db = async (method, table, search, body) => (method === "POST" && table === "order_payments" && /"kind":"release"/.test(body || "") && cut-- > 0) ? res(503, { message: "unavailable" }) : null;
  const r2 = await split(c2); reset(); await hourlyLater(c2);
  const m2 = moneyOut(c2);
  vuln(m2.transferred !== 5000 || m2.refunded !== 5000 || c2.released_cents !== 5000 || c2.refunded_cents !== 5000, `R1b' ledger line failed once (${r2.status}), hourly an hour later -> ${books(c2)}`);
  reset();
}

console.log(out.join("\n"));
const bad = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${bad} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(bad ? 1 : 0);
