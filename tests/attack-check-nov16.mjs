// Check of 16 November (both price plans): what a cancel or a decision says it refunded.
// V1 a cancel's or a decision's refund made at Stripe with its answer lost, counted first at a chargeback the bank then decided
//    for Cuvori, or at a refund made in the Stripe dashboard meanwhile (the fix of 15 November): when the hourly run finished the
//    step, it said 0.00 refunded: the chat card both people see ("Cancelled — 0.00 EUR refunded"), the Order's refund amount
//    and its history. The money was right. Now the step counts what was refunded first as its own refund.
// V2 a decision's refund made from two payments, one made with its answer lost and counted at a chargeback, the other not
//    made yet: the step gives back only the rest, and says it refunded all of it.
// V2b/V2c the same with a refund made by hand in the dashboard meanwhile, or the line of the rest refused once.
// V3 a decision whose refund was counted at a chargeback the bank decided for the client, then a new decision to refund what
//    is left: the earlier decision's refund is never taken for the new one's (the client gets the rest).
// (The Order screen's history line for a cancel is checked in tests/plan2-page.js, check 18.)
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
async function topUp(c, cents) { c.amount_cents += cents; row(c).amount_cents = c.amount_cents; const r = await checkout(c); if (r.status !== 200) return { checkout: r }; const s2 = pay(c.stripe_checkout_id); return { checkout: r, session: s2, webhook: await webhook(completed(s2)) }; }
// (what went back of the Order's own money: never the card-fee refund at today's prices)
const backOrd = (pi) => STRIPE.refunds.filter(r => r.payment_intent === pi && r.status !== "failed" && r.status !== "canceled" && !(r.metadata && r.metadata.kind)).reduce((a, r) => a + r.amount, 0);
const cards = (c, ev) => DB.messages.filter(m => m.kind === "contract" && m.payload && m.payload.contract_id === c.id && m.payload.event === ev).map(m => m.payload.amount_cents);
const evData = (c, ev) => DB.order_events.filter(e => e.order_id === c.id && e.event === ev).map(e => e.data || {});

// ---------- V1 the step finished after its refund was counted first ----------
for (const [name, mkX, plan] of PLANS) for (const how of ["the freelancer cancels", "Cuvori decides: refund", "Cuvori decides: split 50%"]) for (const trigger of ["a chargeback decided for Cuvori", "a refund in the dashboard"]) {
  if (trigger === "a refund in the dashboard" && !how.includes("split")) continue;     // (all of the payment already refunded: Stripe refuses another refund)
  await guard(`V1 [${name}] ${how}, ${trigger}`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent; row(c).status = "funded";
    lostRefund(); let a;
    if (how === "the freelancer cancels") a = await cancel(c);
    else { disputed(c); a = await resolve(c, how.includes("split") ? "split" : "refund", how.includes("split") ? { editor_percent: 50 } : {}); }
    FAULT.pred = null; const ch = chargeOf(pi);
    let t1, t2 = { status: "-" };
    if (trigger.startsWith("a chargeback")) { t1 = await dispute(c, ch, "needs_response", { amount: 3000 }); later(60); t2 = await dispute(c, ch, "won", { amount: 3000 }); }
    else { dashRefund(pi, 1000); t1 = { status: last(await sends(() => refundedEvent(pi))) }; }
    later(15); await hours(3);
    const x = row(c), want = how.includes("split") ? 5000 : 10000, ev = how === "the freelancer cancels" ? "cancel_refund" : "resolved";
    const card = how === "the freelancer cancels" ? cards(c, "cancel_refund") : how.includes("split") ? cards(c, "resolved_split") : cards(c, "resolved_refund");
    const wantCard = how.includes("split") ? 5000 : 10000;   // (a divided decision's card names the freelancer's share)
    const said = evData(c, ev).map(d => d.refund_cents);
    vuln(a.status === 200 || t1.status !== 200 || (t2.status !== "-" && t2.status !== 200) || ["resolving", "releasing", "disputed"].includes(x.status) || backOrd(pi) < want
      || x.refund_cents !== want || said.join() !== String(want) || card.join() !== String(wantCard),
      `V1 [${name}] ${how}, the refund made with its answer lost (${a.status}); ${trigger} (${t1.status}${t2.status !== "-" ? "/" + t2.status : ""}); hourly runs: ${show(c)}; the Order's refund ${x.refund_cents}; its history says ${said.join(", ") || "nothing"}; the chat card ${card.join(", ") || "none"} (must be: ${eur(want)} refunded, said so everywhere)`);
  });
}
// ---------- V2 a decision's refund from two payments, the top-up's counted at a chargeback ----------
for (const [name, mkX, plan] of PLANS) {
  await guard(`V2 [${name}]`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 3350, price: 33.5 }); const f = await fund2(c); const pi = f.session.payment_intent; row(c).status = "funded";
    const t = await topUp(c, 5000); const pi2 = t.session && t.session.payment_intent; row(c).status = "funded"; disputed(c);
    lostRefund(); const a = await resolve(c, "refund"); FAULT.pred = null;
    const ch = chargeOf(pi); const d1 = await dispute(c, ch, "needs_response", { amount: 1000 }); later(60); const d2 = await dispute(c, ch, "won", { amount: 1000 });
    later(15); await hours(3);
    const x = row(c), said = evData(c, "resolved").map(d => d.refund_cents);
    vuln(!pi2 || a.status === 200 || d1.status !== 200 || d2.status !== 200 || x.status !== "refunded" || backOrd(pi) + backOrd(pi2) !== 8350 || x.refunded_cents !== 8350 || x.refund_cents !== 8350 || said.join() !== "8350" || cards(c, "resolved_refund").join() !== "8350",
      `V2 [${name}] a top-up of 50.00; decided "refund": the top-up's 50.00 refunded with its answer lost, the first payment's not yet (${a.status}); a chargeback on the first payment (${d1.status}), decided for Cuvori (${d2.status}); hourly runs: ${show(c)}; given back at Stripe ${backOrd(pi) + backOrd(pi2)}; the Order's refund ${x.refund_cents}; history ${said.join(", ")}; card ${cards(c, "resolved_refund").join(", ")} (must be: 83.50 given back, said so)`);
  });
}
// (V2b: a refund made by hand in the dashboard meanwhile leaves less held: the step gives back what is left, and says it refunded
// what it counted first and what it gave back now. V2c: the line of what it gives back now is refused once the Order counted it:
// the next try writes the line only, never counting it again)
const TIMEOUT = () => new Response(JSON.stringify({ message: "canceling statement due to statement timeout" }), { status: 500, headers: { "content-type": "application/json" } });
for (const [name, mkX, plan] of PLANS) for (const kind of ["V2b", "V2c"]) {
  await guard(`${kind} [${name}]`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 3350, price: 33.5 }); const f = await fund2(c); const pi = f.session.payment_intent; row(c).status = "funded";
    const t = await topUp(c, 5000); const pi2 = t.session && t.session.payment_intent; row(c).status = "funded"; disputed(c);
    lostRefund(); const a = await resolve(c, "refund"); FAULT.pred = null;
    const ch = chargeOf(pi); const d1 = await dispute(c, ch, "needs_response", { amount: 1000 }); later(60); const d2 = await dispute(c, ch, "won", { amount: 1000 });
    let w = ["-"], n = 0;
    if (kind === "V2b") { later(5); dashRefund(pi, 1000); w = await sends(() => refundedEvent(pi)); }
    else hooks.db = async (m, tb, s2, b) => (n < 3 && m === "POST" && tb === "order_payments" && /"kind":"refund"/.test(String(b)) && !/refund counted at/.test(String(b))) ? (n++, TIMEOUT()) : null;
    later(15); await hours(1); hooks.db = null; await hours(2);
    const x = row(c), said = evData(c, "resolved").map(d => d.refund_cents), want = kind === "V2b" ? 7350 : 8350;
    vuln(!pi2 || a.status === 200 || d1.status !== 200 || d2.status !== 200 || (kind === "V2b" && last(w) !== 200) || (kind === "V2c" && !n) || x.status !== "refunded" || held(c) !== 0
      || backOrd(pi) + backOrd(pi2) !== 8350 || x.refund_cents !== want || said.join() !== String(want) || !linesAgree(c),
      `${kind} [${name}] a top-up of 50.00; decided "refund": the top-up's 50.00 refunded with its answer lost (${a.status}); a chargeback decided for Cuvori (${d1.status}/${d2.status})${kind === "V2b" ? `; 10.00 of the first payment refunded in the dashboard (${w.join("/")})` : `; the line of the rest refused (${n}x)`}; hourly runs: ${show(c)}; given back at Stripe ${backOrd(pi) + backOrd(pi2)}; the Order's refund ${x.refund_cents}; history ${said.join(", ")}; lines agree ${linesAgree(c)} (must be: 83.50 back with the client in all, the decision saying ${eur(want)})`);
  });
}
// ---------- V3 a new decision after one whose refund was counted at a chargeback decided for the client ----------
for (const [name, mkX, plan] of PLANS) {
  await guard(`V3 [${name}]`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 3350, price: 33.5 }); const f = await fund2(c); const pi = f.session.payment_intent; row(c).status = "funded";
    const t = await topUp(c, 5000); const pi2 = t.session && t.session.payment_intent; row(c).status = "funded"; disputed(c);
    lostRefund(); const a = await resolve(c, "refund"); FAULT.pred = null;
    const ch2 = chargeOf(pi2); const d1 = await dispute(c, ch2, "needs_response", { amount: 4250 }); later(60); const d2 = await dispute(c, ch2, "lost", { amount: 4250 }); later(60);
    const st1 = row(c).status;
    const b = await resolve(c, "refund"); later(60); await hours(2);
    const x = row(c);
    vuln(!pi2 || a.status === 200 || d1.status !== 200 || d2.status !== 200 || st1 !== "disputed" || b.status !== 200 || x.status !== "refunded" || backOrd(pi) !== 3350 || x.refund_cents !== 3350 || held(c) !== 0,
      `V3 [${name}] a top-up of 50.00; decided "refund": the top-up's 50.00 refunded with its answer lost (${a.status}); a 42.50 chargeback on the top-up (${d1.status}), lost (${d2.status}): ${st1}; Cuvori decides "refund" again (${b.status}): ${show(c)}; the first payment's 33.50 given back ${backOrd(pi)}; the new decision's refund ${x.refund_cents} (must be: 33.50 given back, the Order refunded)`);
  });
}

console.error = realError;
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
