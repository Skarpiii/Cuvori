// Check of 15 November (both price plans): four problems found by random payment sequences with three new faults (a payment
// line refused, the Order's write refused, a key refused), report of 14 November.
// U1 (A) a refund made in the Stripe dashboard whose notice broke off at the Order's write (its line written, the Order's
//    total not): until Stripe sent the notice again the Order still counted that money as held, and a payout in between (the
//    client approving, the review period ending, Cuvori's decision, a part approved) paid the freelancer money the client
//    already had back; the notice sent again then said nothing. Now every payout first handles such a refund, as if its
//    notice had come: the Order goes to a dispute as usual (a decision under way pays only what is still held).
// U2 (B) a decision's refund made at Stripe with its answer lost, then a chargeback on the payment before the hourly run
//    finished the decision: when the bank decided for the client the Order went back to a dispute, the refund never counted
//    ("Nothing was lost — please try again"), and a new decision paid the freelancer money the client already had back. Now
//    Cuvori's own refunds Stripe made that the books don't show are counted first at a chargeback (as payouts are).
// U2c the same refund during a refund made in the Stripe dashboard: counted first, so what went out twice is said.
// U3 (C) a chargeback lost on a payment already refunded, then Cuvori's refund fails at Stripe: Stripe's "chargeback decided"
//    notice sent again was answered with an error every time ("chargeback counter is not recorded").
// U4 (D) a decision's refund made with its answer lost that then failed at Stripe, the amount changed meanwhile (a refund made
//    by hand in the dashboard): Stripe refused the decision's next try (the same key for another amount), and the Order stayed
//    "resolving" for good. Now the failed refund is taken as the decision's, given back and come back (as when it fails after
//    being counted): the Order is finished and holds the money again, its note saying to refund it again.
// U5 (found while fixing) a lost chargeback whose line was not saved yet, then a refund in the Stripe dashboard: part of the
//    refund was taken for the chargeback the Order already counted, and a decision paid it to the freelancer, nothing said.
// U6 (found while fixing) the decision's refund counted at a chargeback, its line refused, the notice sent again: a line of
//    0.00 and a note saying money went out twice at today's prices.
import { DB, STRIPE, V56, users, hooks, req, call, mk, reset, fns, pay, signed, uuid } from "./fn-harness.mjs";
import { checkLines, reconcile, listed } from "./plan2-ledger.mjs";
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const realError = console.error; console.error = () => {};
const guard = async (name, fn) => { try { await fn(); } catch (e) { out.push(`VULNERABLE ${name} threw: ${e && e.stack ? e.stack.split("\n").slice(0, 2).join(" ") : e}`); } finally { reset(); FAULT.pred = null; FAULT.hit = 0; } };
const fx = await fns();
V56.on = true;
STRIPE.balance = 50_000_000_000;
const RealDate = Date; let skew = 0;
globalThis.Date = class extends RealDate { constructor(...a) { if (a.length === 0) super(RealDate.now() + skew); else super(...a); } static now() { return RealDate.now() + skew; } };
const later = (min) => { skew += min * 60e3; };
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(() => { if (Number(ms) > 0) skew += Number(ms); fn(...args); }, 0);
// one request that lands while its answer is lost (the connection drops), or that is refused (500)
const FAULT = { pred: null, how: null, hit: 0 };
const innerFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (FAULT.pred && FAULT.pred(u, init)) {
    FAULT.pred = null; FAULT.hit++;
    if (FAULT.how === "refused") return u.includes("api.stripe.com")
      ? new Response(JSON.stringify({ error: { type: "api_error", message: "An unknown error occurred" } }), { status: 500, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ message: "canceling statement due to statement timeout" }), { status: 500, headers: { "content-type": "application/json" } });
    await innerFetch(url, init);
    const e = new TypeError("fetch failed"); e.cause = { code: "UND_ERR_SOCKET" }; throw e;
  }
  return innerFetch(url, init);
};
const arm = (how, pred) => { FAULT.how = how; FAULT.pred = pred; };
const lostTransfer = () => arm("lost", (u, init) => u.includes("api.stripe.com/v1/transfers") && init.method === "POST" && !u.includes("reversals"));
const orderWrite = (how) => arm(how, (u, init) => /\/rest\/v1\/contracts/.test(u) && init.method === "PATCH");
const chargeOf = (pi) => STRIPE.charges[STRIPE.intents[pi].latest_charge];
const webhook = (ev) => call(fx.webhook, req("POST", "x", ev));
const hourly = () => call(fx.autoRelease, req("POST", "x", {}));
const checkout = (c) => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
const approve = (c, milestone_id) => call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, ...(milestone_id ? { milestone_id } : {}) } }));
const cancel = (c) => call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id } }));
const resolve = (c, decision, extra = {}) => call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision, note: "Cuvori looked at the chat and the files.", ...extra } }));
const completed = (s) => signed({ type: "checkout.session.completed", data: { object: s } });
const mk2 = (o = {}) => mk({ pricing_version: 2, commission_bps: 500, commission_cents: 0, auto_days: 14, ...o });
const mk1 = (o = {}) => mk({ pricing_version: 1, commission_bps: 0, commission_cents: 0, auto_days: 7, ...o });
const PLANS = [["plan 2", mk2, 2], ["plan 1", mk1, 1]];
const row = (c) => DB.contracts.find(x => x.id === c.id) || c;
const lines = (c, kind) => DB.order_payments.filter(p => p.order_id === c.id && (!kind || p.kind === kind));
const tsOf = (c) => STRIPE.transfers.filter(t => t.metadata.contract_id === c.id);
const sent = (c) => tsOf(c).reduce((a, t) => a + t.amount - t.amount_reversed, 0);
const held = (c) => { const x = row(c); return x.funded_cents - x.released_cents - x.refunded_cents; };
const ms = (c, amounts, status = "submitted") => { c.has_milestones = true; return amounts.map((a, i) => { const m = { id: uuid(), order_id: c.id, title: "part " + (i + 1), amount_cents: a, status, position: i + 1 }; DB.order_milestones.push(m); return m; }); };
const mstat = (m) => DB.order_milestones.find(x => x.id === m.id).status;
async function fund2(c) { const r = await checkout(c); if (r.status !== 200) return { checkout: r }; const s = pay(c.stripe_checkout_id); return { checkout: r, session: s, webhook: await webhook(completed(s)) }; }
const ready = (yes) => { STRIPE.accounts.acct_1EditorAAAAAAAA.payouts_enabled = yes; DB.payout_details.find(p => p.id === users.ed.id).stripe_payouts_enabled = yes; };
const disputed = (c) => { const x = row(c); x.status = "disputed"; x.dispute_by = users.cl.id; x.disputed_at = new Date().toISOString(); };
const notes = (c) => String(row(c).money_error || "").split(" · Also: ").filter(Boolean);
const show = (c) => { const x = row(c); return `${x.status}, paid in ${x.funded_cents}, paid out ${x.released_cents}, back ${x.refunded_cents}, held ${held(c)}; at the freelancer ${sent(c)}`; };
const ledger = (c) => { const x = row(c); return [...checkLines(DB, [c.id]), ...reconcile(DB, STRIPE, x), ...listed(DB, x)].filter(p => !p.startsWith("to_decide:")); };
const dashRefund = (pi, amount) => { const ch = chargeOf(pi); ch.amount_refunded += amount; STRIPE.balance -= amount;
  const r = { id: "re_dash" + Math.random().toString(36).slice(2, 10), created: Date.now() / 1000, amount, contract: null, metadata: {}, payment_intent: pi, charge: ch.id, status: "succeeded" }; STRIPE.refunds.push(r); return r; };
const refundedEvent = (pi) => { const ch = chargeOf(pi); return signed({ type: "charge.refunded", data: { object: { id: ch.id, object: "charge", payment_intent: pi, amount: ch.amount, amount_refunded: ch.amount_refunded, refunded: ch.amount_refunded >= ch.amount, currency: "eur" } } }); };
const failedEvent = (r) => signed({ type: "charge.refund.updated", data: { object: { ...r, object: "refund", status: "failed", currency: "eur", failure_reason: "expired_or_canceled_card" } } });
const refundFails = (r) => { r.status = "failed"; const ch = STRIPE.charges[r.charge]; ch.amount_refunded -= r.amount; STRIPE.balance += r.amount; return failedEvent(r); };
const eur = (cents) => (cents / 100).toFixed(2);
// what the Order says went out twice: the amounts its notes name ("X of it had already been paid out", "X had already been paid")
const TWICE = /(\d+\.\d{2}) (?:EUR )?(?:of it )?had already been paid/;
const twiceSaid = (c) => notes(c).map(n => (TWICE.exec(n) || [])[1]).filter(Boolean);
const hours = async (n) => { for (let i = 0; i < n; i++) { later(60); await hourly(); } };
// a notice of Stripe's answered other than 200 is sent again (here up to 3 more times)
const sends = async (ev) => { const got = []; for (let i = 0; i < 4; i++) { const r = await webhook(ev()); got.push(r.status); if (r.status === 200) break; later(60); } return got; };
const last = (a) => a[a.length - 1];
const MISLEADING = /Nothing was lost|please try again|database had a problem/;
const countedOf = (l) => l.note === "dashboard_refund_paid_out" ? 0 : (/^(?:dashboard_refund|chargeback_lost) counted (\d+)$/.exec(String(l.note || "")) || [])[1] !== undefined ? Number(/(\d+)$/.exec(l.note)[1]) : l.amount_cents;
// the Order's refund total against its lines (refunds and chargebacks as the Order counts them, less the refunds that failed)
const linesAgree = (c) => { const ls = lines(c).filter(l => l.status === "succeeded" && ["refund", "chargeback", "refund_failed"].includes(l.kind));
  const failedBack = ls.filter(l => l.kind === "refund_failed").reduce((a, f) => a + Math.min(f.amount_cents, ls.filter(l => l.kind === "refund" && String(l.provider_ref || "").split(",").includes(f.provider_ref)).reduce((b, l) => b + countedOf(l), 0)), 0);
  return ls.filter(l => l.kind !== "refund_failed").reduce((a, l) => a + countedOf(l), 0) - failedBack === (row(c).refunded_cents || 0); };
const backAt = (pi) => STRIPE.refunds.filter(r => r.payment_intent === pi && r.status !== "failed" && r.status !== "canceled").reduce((a, r) => a + r.amount, 0);
const dispute = async (c, ch, status, extra = {}) => {
  STRIPE.disputes[ch.id] = { ...(STRIPE.disputes[ch.id] || {}), id: "dp_" + ch.id, status, ...(extra.amount ? { amount: extra.amount } : {}) };
  const type = ["won", "lost", "warning_closed"].includes(status) ? "charge.dispute.closed" : "charge.dispute.created";
  return webhook(signed({ type, data: { object: { id: "dp_" + ch.id, object: "dispute", charge: ch.id, payment_intent: ch.payment_intent, amount: extra.amount || ch.amount, currency: "eur", status, reason: "fraudulent", created: Math.floor(Date.now() / 1000) } } }));
};
const lostRefund = () => arm("lost", (u, init) => u.includes("api.stripe.com/v1/refunds") && init.method === "POST" && !/fee_surplus/.test(String(init.body)));
const ours = (c, pi) => STRIPE.refunds.filter(r => r.payment_intent === pi && r.metadata && r.metadata.contract_id === c.id && !r.metadata.kind);

// ---------- U1 (A) a dashboard refund not counted yet, then a payout ----------
for (const [name, mkX, plan] of PLANS) for (const how of ["the client approves", "the review period ends", "Cuvori decides: release", "a part approved"]) {
  await guard(`U1 [${name}] ${how}`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent;
    let m1 = null;
    if (how === "a part approved") { row(c).status = "funded"; [m1] = ms(c, [10000]); } else row(c).status = "delivered";
    if (how === "the review period ends") row(c).auto_release_at = new Date(Date.now() + 30 * 60e3).toISOString();
    dashRefund(pi, 4000); orderWrite("refused"); const w1 = await webhook(refundedEvent(pi)); const hit = FAULT.hit; FAULT.pred = null;
    let a;
    if (how === "the client approves") a = await approve(c);
    else if (how === "the review period ends") { later(45); a = await hourly(); }
    else if (how === "Cuvori decides: release") { disputed(c); a = await resolve(c, "release"); }
    else a = await approve(c, m1.id);
    later(10); const w2 = await sends(() => refundedEvent(pi)); later(60); await hourly();
    const x = row(c), cash = chargeOf(pi).amount - backAt(pi) - sent(c);
    const wantStatus = how === "Cuvori decides: release" ? "completed" : "disputed", wantSent = how === "Cuvori decides: release" ? (plan === 2 ? 5700 : 6000) : 0;
    vuln(!hit || w1.status === 200 || last(w2) !== 200 || x.refunded_cents !== 4000 || cash < 0 || sent(c) !== wantSent || x.status !== wantStatus || twiceSaid(c).length || !notes(c).some(n => n.startsWith("Refund of 40.00")) || !linesAgree(c),
      `U1 [${name}] 40.00 refunded in the Stripe dashboard, its notice broke off at the Order's write (${w1.status}); ${how} (${a.status}); Stripe sends the notice again (${w2.join("/")}): ${show(c)}; Cuvori's cash from the Order ${cash}; went out twice said ${twiceSaid(c).join(", ") || "nowhere"}; lines agree ${linesAgree(c)}; notes ${JSON.stringify(notes(c).map(n => n.slice(0, 60)))} (must be: the refund counted before any payout, the Order ${wantStatus}, the freelancer ${wantSent})`);
  });
}
// ---------- U2 (B) a decision's refund with its answer lost, then a chargeback ----------
for (const [name, mkX, plan] of PLANS) for (const decision of ["refund", "split 50%"]) for (const outcome of ["lost", "won"]) {
  await guard(`U2 [${name}] ${decision}, ${outcome}`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent; row(c).status = "funded"; disputed(c);
    lostRefund(); const a = await resolve(c, decision === "refund" ? "refund" : "split", decision === "refund" ? {} : { editor_percent: 50 }); FAULT.pred = null;
    const ch = chargeOf(pi); const d1 = await dispute(c, ch, "needs_response", { amount: 6000 }); later(60);
    const back1 = row(c).refunded_cents;
    const d2 = await dispute(c, ch, outcome, { amount: 6000 }); later(60); await hours(2);
    const again = await resolve(c, "release"); later(60); await hours(1);
    const x = row(c), wantBack = decision === "refund" ? 10000 : 5000;
    const madeAt = ours(c, pi).filter(r => r.status === "succeeded").reduce((s2, r) => s2 + r.amount, 0);
    // (the new prices' ledger check: the books complete; what the bank took of a payment already given back is listed, and the
    // Order's note says it)
    const p = plan === 2 ? ledger(c).filter(q => !/^more_out_than_in|^commission_without_money/.test(q) && !/Cuvori has -?\d+ of the Order at Stripe/.test(q)) : [];
    // (a split's payout stays with the freelancer when the bank decides for Cuvori; when it decides for the client, the
    // chargeback pulls it back as it does after a split finished normally)
    const wantSent = decision === "refund" || outcome === "lost" ? 0 : (plan === 2 ? 4750 : 5000);
    vuln(a.status === 200 || d1.status !== 200 || d2.status !== 200 || back1 < wantBack || ["disputed", "resolving"].includes(x.status) || again.status === 200 || sent(c) !== wantSent
      || madeAt !== wantBack || notes(c).some(n => MISLEADING.test(n)) || !linesAgree(c) || p.length,
      `U2 [${name}] decided "${decision}", its refund made with its answer lost (${a.status}); a 60.00 chargeback on the payment (${d1.status}): the Order counts back ${back1}; the bank decides ${outcome} (${d2.status}); hourly runs; Cuvori tries to decide "release" (${again.status}): ${show(c)}; Cuvori's refunds at Stripe ${madeAt}; lines agree ${linesAgree(c)}${p.length ? "; ledger " + p.slice(0, 2).join(" | ") : ""}; notes ${JSON.stringify(notes(c).map(n => n.slice(0, 70)))} (must be: the decision's refund counted at the chargeback, the Order finished, no new decision, nothing "try again")`);
  });
}
// (U2d: the decision's refund made from two payments (a top-up), the first refund made with its answer lost and the second
// never made; the bank decides a chargeback on the top-up for the client: the refund made is counted, the decision goes back to
// Cuvori for what is left, its note no longer says "try again", and a new decision pays the freelancer only what is left)
async function topUp(c, cents) { c.amount_cents += cents; row(c).amount_cents = c.amount_cents; const r = await checkout(c); if (r.status !== 200) return { checkout: r }; const s2 = pay(c.stripe_checkout_id); return { checkout: r, session: s2, webhook: await webhook(completed(s2)) }; }
for (const [name, mkX, plan] of PLANS) {
  await guard(`U2d [${name}]`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 3350, price: 33.5 }); const f = await fund2(c); const pi = f.session.payment_intent; row(c).status = "funded";
    const t = await topUp(c, 5000); const pi2 = t.session && t.session.payment_intent; row(c).status = "funded"; disputed(c);
    lostRefund(); const a = await resolve(c, "refund"); FAULT.pred = null;
    const made = ours(c, pi2).concat(ours(c, pi)).filter(r => r.status === "succeeded").reduce((s2, r) => s2 + r.amount, 0);
    const ch2 = chargeOf(pi2); const d1 = await dispute(c, ch2, "needs_response", { amount: 4250 }); later(60); const d2 = await dispute(c, ch2, "lost", { amount: 4250 }); later(60);
    const st1 = row(c).status, back1 = row(c).refunded_cents, full1 = notes(c), n1 = full1.map(n => n.slice(0, 70));
    const b = await resolve(c, "release"); later(60); await hours(1);
    vuln(!pi2 || a.status === 200 || made !== 5000 || d1.status !== 200 || d2.status !== 200 || st1 !== "disputed" || back1 < 5000 || full1.some(n => MISLEADING.test(n)) || b.status !== 200 || sent(c) > 3350 || row(c).released_cents > 3350,
      `U2d [${name}] a top-up of 50.00; decided "refund": the top-up's 50.00 refunded with its answer lost, the first payment's never (${a.status}, made ${made}); a 42.50 chargeback on the top-up (${d1.status}), lost (${d2.status}): ${st1}, the Order counts back ${back1}; notes ${JSON.stringify(n1)}; Cuvori decides "release" (${b.status}): ${show(c)} (must be: the 50.00 counted, the decision back with Cuvori, nothing "try again", the freelancer paid at most the 33.50 left)`);
  });
}
// (U2e: a cancel's refund made from two payments (the first payment and a top-up whose part was paid out), the top-up's made
// with its answer lost and the first payment's not yet; the admin refunds part of the first payment in the Stripe dashboard
// meanwhile, then the cancel is finished: the client gets exactly what is owed, the top-up's refund counted once; a refund in
// the dashboard bigger than what was still held says what went out twice)
const backOrder = (pi) => STRIPE.refunds.filter(r => r.payment_intent === pi && r.status !== "failed" && r.status !== "canceled" && !(r.metadata && r.metadata.kind)).reduce((a, r) => a + r.amount, 0);
for (const [name, mkX, plan] of PLANS) for (const dash of [1000, 7850]) {
  await guard(`U2e [${name}] ${eur(dash)}`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 9550, price: 95.5 }); const f = await fund2(c); const pi = f.session.payment_intent; row(c).status = "funded";
    ms(c, [9550], "pending");
    const t = await topUp(c, 3900); const pi2 = t.session && t.session.payment_intent; row(c).status = "funded";
    const [m2] = ms(c, [3900]); const ap = await approve(c, m2.id);
    lostRefund(); const k = await cancel(c); FAULT.pred = null;
    const made = ours(c, pi2).concat(ours(c, pi)).filter(r => r.status === "succeeded").reduce((s2, r) => s2 + r.amount, 0);
    dashRefund(pi, dash); const w = await sends(() => refundedEvent(pi)); later(15); await hours(2);
    const backAll = backOrder(pi) + backOrder(pi2), wantBack = Math.max(9550, 3900 + dash), wantTwice = 3900 + dash > 9550 ? eur(3900 + dash - 9550) : "";
    const p = plan === 2 ? ledger(c).filter(q => !/^more_out_than_in|^commission_without_money/.test(q) && !/Cuvori has -?\d+ of the Order at Stripe/.test(q)) : [];
    vuln(!pi2 || ap.status !== 200 || k.status === 200 || made !== 3900 || last(w) !== 200 || !["refunded", "completed"].includes(row(c).status) || row(c).refunded_cents !== 9550 || backAll !== wantBack || twiceSaid(c).join() !== wantTwice || !linesAgree(c) || p.length,
      `U2e [${name}] a top-up of 39.00 for a part paid out (${ap.status}); the freelancer cancels: the top-up's 39.00 refunded with its answer lost, the first payment's not yet (${k.status}, made ${made}); ${eur(dash)} of the first payment refunded in the dashboard (${w.join("/")}); hourly runs: ${show(c)}; given back at Stripe ${backAll}; went out twice said ${twiceSaid(c).join(", ") || "nowhere"}; lines agree ${linesAgree(c)}${p.length ? "; ledger " + p.slice(0, 2).join(" | ") : ""} (must be: the Order closed, the client gets ${eur(wantBack)} back in all, the Order counts 95.50${wantTwice ? ", " + wantTwice + " said" : ""})`);
  });
}
// (U2f: a cancel's refund made with its answer lost, counted at a small refund made in the dashboard meanwhile, then failed at
// Stripe; the hourly run finishes the cancel: the failed refund given back and come back once, its line written once)
for (const [name, mkX, plan] of PLANS) {
  await guard(`U2f [${name}]`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 4200, price: 42 }); const f = await fund2(c); const pi = f.session.payment_intent; row(c).status = "funded";
    const [m1] = ms(c, [1400, 1400, 1400]); const ap = await approve(c, m1.id);
    lostRefund(); const k = await cancel(c); FAULT.pred = null;
    dashRefund(pi, 300); const w = await sends(() => refundedEvent(pi));
    const rf = ours(c, pi)[0]; const wf = rf ? await webhook(refundFails(rf)) : { status: "no refund" };
    later(15); await hours(2);
    const n = lines(c, "refund").filter(l => rf && String(l.provider_ref || "").split(",").includes(rf.id)).length;
    vuln(ap.status !== 200 || k.status === 200 || last(w) !== 200 || wf.status !== 200 || !["refunded", "completed"].includes(row(c).status) || held(c) !== 2800 || n !== 1 || !linesAgree(c) || twiceSaid(c).join() !== "3.00",
      `U2f [${name}] part 1 paid out (${ap.status}); the freelancer cancels, the refund of 28.00 made with its answer lost (${k.status}); 3.00 refunded in the dashboard meanwhile (${w.join("/")}): the cancel's refund counted, 3.00 said to have gone out twice; the cancel's refund fails at Stripe (${wf.status}); hourly runs: ${show(c)}; lines naming the failed refund ${n}; lines agree ${linesAgree(c)}; went out twice said ${twiceSaid(c).join(", ") || "nowhere"} (must be: the Order closed holding 28.00 again, one line for the failed refund, the books agreeing)`);
  });
}
// (U2c: a refund made in the Stripe dashboard while such a decision is under way: the decision's refund is counted first, so
// what went out twice is said)
for (const [name, mkX, plan] of PLANS) {
  await guard(`U2c [${name}]`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent; row(c).status = "funded"; disputed(c);
    lostRefund(); const a = await resolve(c, "split", { editor_percent: 50 }); FAULT.pred = null; later(5);
    dashRefund(pi, 3000); const w = await sends(() => refundedEvent(pi)); later(15); await hours(2);
    const x = row(c);
    vuln(a.status === 200 || last(w) !== 200 || twiceSaid(c).join() !== "30.00" || x.status !== "completed" || x.refunded_cents !== 5000 || !linesAgree(c) || notes(c).some(n => MISLEADING.test(n)),
      `U2c [${name}] decided "split 50%": the payout made, the refund made with its answer lost (${a.status}); 30.00 refunded in the dashboard meanwhile (${w.join("/")}); hourly runs: ${show(c)}; went out twice said ${twiceSaid(c).join(", ") || "nowhere"}; lines agree ${linesAgree(c)}; notes ${JSON.stringify(notes(c).map(n => n.slice(0, 60)))} (must be: 30.00 said, the decision finished)`);
  });
}

// ---------- U3 (C) the "chargeback decided" notice again after Cuvori's refund failed ----------
for (const [name, mkX, plan] of PLANS) {
  await guard(`U3 [${name}]`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 14350, price: 143.5 }); const f = await fund2(c); const pi = f.session.payment_intent; row(c).status = "funded";
    const k = await cancel(c); const ch = chargeOf(pi);
    const d1 = await dispute(c, ch, "needs_response", { amount: 10900 }); const d2 = await dispute(c, ch, "lost", { amount: 10900 });
    const rf = ours(c, pi)[0]; const wf = rf ? await webhook(refundFails(rf)) : { status: "no refund" };
    const back1 = row(c).refunded_cents, n1 = lines(c, "chargeback").length;
    const d3 = await dispute(c, ch, "lost", { amount: 10900 }); const d4 = await dispute(c, ch, "lost", { amount: 10900 }); await hours(1);
    vuln(k.status !== 200 || d1.status !== 200 || d2.status !== 200 || wf.status !== 200 || d3.status !== 200 || d4.status !== 200 || row(c).refunded_cents !== back1 || lines(c, "chargeback").length !== n1,
      `U3 [${name}] cancelled and refunded (${k.status}); a chargeback on the refunded payment (${d1.status}), lost (${d2.status}); the cancel's refund fails at Stripe (${wf.status}); Stripe sends the "decided" notice twice more (${d3.status}/${d4.status}): ${show(c)}; chargeback lines ${lines(c, "chargeback").length} (must be: answered 200, nothing counted again)`);
  });
}

// ---------- U4 (D) a decision's refund failed, the amount changed meanwhile ----------
for (const [name, mkX, plan] of PLANS) {
  await guard(`U4 [${name}]`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent; row(c).status = "funded"; disputed(c);
    lostRefund(); const a = await resolve(c, "refund"); FAULT.pred = null;
    const rf = ours(c, pi)[0]; const wf = rf ? await webhook(refundFails(rf)) : { status: "no refund" }; later(5);
    dashRefund(pi, 3000); const w = await sends(() => refundedEvent(pi)); later(15);
    const h = await hourly(); await hours(2);
    const status1 = row(c).status, stopped = notes(c).some(n => n.startsWith("Money step stopped")), told = !!rf && notes(c).some(n => n.startsWith(`refund ${rf.id} `)), s1 = show(c), held1 = held(c);
    // the admin refunds the 70.00 still owed in the dashboard, as the note says
    dashRefund(pi, 7000); const w2 = await sends(() => refundedEvent(pi)); await hours(1);
    vuln(a.status === 200 || wf.status !== 200 || last(w) !== 200 || h.status !== 200 || ["resolving", "releasing"].includes(status1) || held1 !== 7000 || !told || stopped || last(w2) !== 200 || held(c) !== 0 || twiceSaid(c).length || !linesAgree(c),
      `U4 [${name}] decided "refund", its refund made with its answer lost (${a.status}), then failed at Stripe (${wf.status}); 30.00 refunded in the dashboard meanwhile (${w.join("/")}); the hourly run (${h.status}): ${s1}, said ${told}${stopped ? ", its step stopped" : ""}; the admin refunds the 70.00 again in the dashboard (${w2.join("/")}): ${show(c)}; went out twice said ${twiceSaid(c).join(", ") || "nowhere"}; lines agree ${linesAgree(c)}; notes ${JSON.stringify(notes(c).map(n => n.slice(0, 60)))} (must be: the decision finished, 70.00 held until refunded again, nothing said twice)`);
  });
}

// (U4b: Stripe's "refund failed" notice comes only after the hourly run tried the decision again: handled then, once)
for (const [name, mkX, plan] of PLANS) {
  await guard(`U4b [${name}]`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent; row(c).status = "funded"; disputed(c);
    lostRefund(); const a = await resolve(c, "refund"); FAULT.pred = null;
    const rf = ours(c, pi)[0]; const ev = rf ? refundFails(rf) : null; later(5);
    dashRefund(pi, 3000); const w = await sends(() => refundedEvent(pi)); later(15);
    await hours(2); const status1 = row(c).status, held1 = held(c), agree1 = linesAgree(c);
    const wf = ev ? await webhook(failedEvent(rf)) : { status: "no refund" }; await hours(1);
    const told = !!rf && notes(c).some(n => n.startsWith(`refund ${rf.id} `));
    vuln(a.status === 200 || last(w) !== 200 || ["resolving", "releasing"].includes(status1) || held1 !== 7000 || !agree1 || wf.status !== 200 || held(c) !== 7000 || !linesAgree(c) || !told || twiceSaid(c).length,
      `U4b [${name}] decided "refund", its refund made with its answer lost (${a.status}), then failed at Stripe, its notice not come yet; 30.00 refunded in the dashboard (${w.join("/")}); hourly runs: ${status1}, held ${held1}, lines agree ${agree1}; the "failed" notice comes now (${wf.status}): ${show(c)}; lines agree ${linesAgree(c)}; said ${told} (must be: the decision finished, 70.00 held, counted back once)`);
  });
}

// (U4c: the "refund failed" notice not come yet when Cuvori decides again, after a chargeback the bank decided for the client
// sent the decision back (Cuvori's refund had failed, so the Order still held the money): the new decision, for less, meets the
// key of the failed refund; that refund's failure is handled first, and the notice when it comes changes nothing)
for (const [name, mkX, plan] of PLANS) {
  await guard(`U4c [${name}]`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent; row(c).status = "funded"; disputed(c);
    lostRefund(); const a = await resolve(c, "refund"); FAULT.pred = null;
    const rf = ours(c, pi)[0]; if (rf) refundFails(rf); later(5);
    const ch = chargeOf(pi); const d1 = await dispute(c, ch, "needs_response", { amount: 3000 }); later(60); const d2 = await dispute(c, ch, "lost", { amount: 3000 }); later(60);
    const st1 = row(c).status;
    const b = await resolve(c, "refund"); later(60); await hours(1);
    const s1 = show(c), held1 = held(c), agree1 = linesAgree(c), status2 = row(c).status;
    const wf = rf ? await webhook(failedEvent(rf)) : { status: "no refund" }; await hours(1);
    const told = !!rf && notes(c).some(n => n.startsWith(`refund ${rf.id} `));
    vuln(a.status === 200 || d1.status !== 200 || d2.status !== 200 || st1 !== "disputed" || b.status !== 200 || status2 !== "refunded" || held1 !== 7000 || !agree1 || wf.status !== 200 || held(c) !== 7000 || !linesAgree(c) || !told,
      `U4c [${name}] decided "refund", its refund made with its answer lost (${a.status}), then failed at Stripe (its notice not come yet); a 30.00 chargeback (${d1.status}), lost (${d2.status}): ${st1}; Cuvori decides "refund" again (${b.status}): ${s1}, lines agree ${agree1}; the "failed" notice comes now (${wf.status}): ${show(c)}; lines agree ${linesAgree(c)}; said ${told} (must be: the new decision finished, 70.00 held until refunded again, counted back once)`);
  });
}

// ---------- U5 a lost chargeback whose line was not saved yet, then a refund in the Stripe dashboard (found while fixing) ----------
// (the chargeback on a top-up decided for the client, its line refused (three tries): the notice fails, and Stripe sends it again later.
// Meanwhile 133.50 of the first payment is refunded in the dashboard: the Order took 18.50 of it for the chargeback it already
// counted, held 18.50 it did not have, and Cuvori's decision paid it to the freelancer, nothing said. Now the chargeback's line
// is written first, the refund counted in full, and the decision pays only what is held)
const TIMEOUT = () => new Response(JSON.stringify({ message: "canceling statement due to statement timeout" }), { status: 500, headers: { "content-type": "application/json" } });
for (const [name, mkX, plan] of PLANS) {
  await guard(`U5 [${name}]`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 19650, price: 196.5 }); const f = await fund2(c); const pi = f.session.payment_intent; row(c).status = "delivered";
    const t = await topUp(c, 1850); const pi2 = t.session && t.session.payment_intent; row(c).status = "delivered";
    const ch2 = chargeOf(pi2); const d1 = await dispute(c, ch2, "needs_response", { amount: ch2.amount }); later(60);
    let n = 0; hooks.db = async (m, tb, s2, b) => (n < 3 && m === "POST" && tb === "order_payments" && /"kind":"chargeback"/.test(String(b))) ? (n++, TIMEOUT()) : null;
    const d2 = await dispute(c, ch2, "lost", { amount: ch2.amount }); hooks.db = null; later(60);
    dashRefund(pi, 13350); const w = await sends(() => refundedEvent(pi));
    const back1 = row(c).refunded_cents, held1 = held(c), st1 = row(c).status;
    later(5); const b = await resolve(c, "release"); later(60);
    const d3 = await dispute(c, ch2, "lost", { amount: ch2.amount }); await hours(1);
    const cash = chargeOf(pi).amount + ch2.amount - backAt(pi) - backAt(pi2) - sent(c) - ch2.amount;
    const p = plan === 2 ? ledger(c).filter(q => !/^more_out_than_in|^commission_without_money/.test(q) && !/Cuvori has -?\d+ of the Order at Stripe/.test(q)) : [];
    vuln(!pi2 || d1.status !== 200 || !n || d2.status === 200 || last(w) !== 200 || back1 !== 15200 || held1 !== 6300 || st1 !== "disputed" || b.status !== 200 || d3.status !== 200 || row(c).released_cents !== 6300 || cash < 0 || !linesAgree(c) || lines(c, "chargeback").length !== 1 || p.length,
      `U5 [${name}] a top-up of 18.50 charged back (${d1.status}), lost, its line refused (${d2.status}); 133.50 of the first payment refunded in the dashboard (${w.join("/")}): ${st1}, the Order counts back ${back1}, holds ${held1}; Cuvori decides "release" (${b.status}); the chargeback's notice again (${d3.status}): ${show(c)}; Cuvori's cash from the Order ${cash}; lines agree ${linesAgree(c)}${p.length ? "; ledger " + p.slice(0, 2).join(" | ") : ""} (must be: 152.00 counted back, 63.00 held and paid out, the books agreeing)`);
  });
}
// ---------- U6 the decision's refund counted at a chargeback, its line refused, the notice sent again ----------
// (the Order's total was raised and the line not saved: the notice sent again counted nothing twice, but at today's prices
// wrote a line of 0.00 and a note saying money went out twice. Now only the line is written, for what was counted)
// (refused once, the line is written on a second try at once, and the notice is answered 200; refused three times, the notice
// fails and its next delivery writes it)
for (const [name, mkX, plan] of PLANS) for (const decision of ["refund", "split 50%"]) for (const refusals of [1, 3]) {
  await guard(`U6 [${name}] ${decision}, refused ${refusals}x`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent; row(c).status = "funded"; disputed(c);
    lostRefund(); const a = await resolve(c, decision === "refund" ? "refund" : "split", decision === "refund" ? {} : { editor_percent: 50 }); FAULT.pred = null;
    let n = 0; hooks.db = async (m, tb, s2, b) => (n < refusals && m === "POST" && tb === "order_payments" && /"kind":"refund"/.test(String(b))) ? (n++, TIMEOUT()) : null;
    const ch = chargeOf(pi); const d1 = await dispute(c, ch, "needs_response", { amount: 6000 }); hooks.db = null; later(60);
    const d1b = await sends(() => { STRIPE.disputes[ch.id].status = "needs_response"; return signed({ type: "charge.dispute.created", data: { object: { id: "dp_" + ch.id, object: "dispute", charge: ch.id, payment_intent: pi, amount: 6000, currency: "eur", status: "needs_response", reason: "fraudulent", created: Math.floor(Date.now() / 1000) } } }); });
    const wantBack = decision === "refund" ? 10000 : 5000, rf = ours(c, pi)[0];
    const named = lines(c, "refund").filter(l => rf && String(l.provider_ref || "").split(",").includes(rf.id));
    const back1 = row(c).refunded_cents, twiceNote = notes(c).some(q => /went out twice/.test(q));
    const d2 = await dispute(c, ch, "lost", { amount: 6000 }); later(60); await hours(2);
    vuln(a.status === 200 || !rf || n < 1 || (refusals === 1) !== (d1.status === 200) || last(d1b) !== 200 || back1 !== wantBack || named.length !== 1 || named[0].amount_cents !== wantBack || twiceNote || d2.status !== 200 || !linesAgree(c) || ["disputed", "resolving"].includes(row(c).status),
      `U6 [${name}] decided "${decision}", its refund made with its answer lost (${a.status}); a chargeback, the refund's line refused at it (${d1.status}, ${n} refused), the notice sent again (${d1b.join("/")}): the Order counts back ${back1}; lines naming the refund ${JSON.stringify(named.map(l => l.amount_cents))}; "went out twice" said ${twiceNote}; lost (${d2.status}): ${show(c)}; lines agree ${linesAgree(c)} (must be: ${eur(wantBack)} counted once, one line of ${eur(wantBack)}, nothing said twice)`);
  });
}

console.error = realError;
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
