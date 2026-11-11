// Check of 7 November (the full payment review after the fixes of 6 November): regression checks for what it proved. Both
// price plans where both are affected.
// M1 a whole Order's payout made at Stripe whose answer was lost; the client's bank opened a chargeback before the hourly
//    run counted it (the payout was pulled back), and decided weeks later for Cuvori (re-paid). The hourly run then paid the
//    freelancer a second time (today's prices: 400.00 for a 200.00 Order) -- the fix of 6 November set the paid-out total
//    to Stripe's record less a pull-back that belonged to the payout it left out. The same with the chargeback lost.
// M2 the same with a part of an Order: the part was paid again (or, while Stripe still knew the payout's key, counted
//    twice: the Order then held 60.00 less than it did).
import { DB, DBQ, STRIPE, V56, users, hooks, req, call, mk, reset, fns, pay, signed, uuid, fsReset } from "./fn-harness.mjs";
import { checkLines, reconcile, listed } from "./plan2-ledger.mjs";
import fs from "node:fs";
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
const DAY = 1440;
// one write that lands at Stripe or in the database while its answer is lost (the connection drops), or that is refused
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
const bodyOf = (init) => String(init && init.body || "");
const chargeOf = (pi) => STRIPE.charges[STRIPE.intents[pi].latest_charge];
const webhook = (ev) => call(fx.webhook, req("POST", "x", ev));
const hourly = () => call(fx.autoRelease, req("POST", "x", {}));
const NOTE = "Cuvori looked at the chat and the files.";
const checkout = (c) => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
const approve = (c, milestone_id) => call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, ...(milestone_id ? { milestone_id } : {}) } }));
const cancel = (c, extra = {}) => call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id, ...extra } }));
const resolve = (c, decision, extra = {}) => call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision, note: NOTE, ...extra } }));
const completed = (s) => signed({ type: "checkout.session.completed", data: { object: s } });
const cbEvent = (type, ch, extra = {}) => signed({ type, data: { object: { id: extra.id || "dp_" + ch.id, object: "dispute", charge: ch.id, payment_intent: ch.payment_intent, amount: extra.amount || ch.amount, currency: "eur", status: extra.status || "needs_response", reason: "fraudulent",
  created: (STRIPE.disputes[ch.id] && STRIPE.disputes[ch.id].created) || Math.floor(Date.now() / 1000) } } });
const dispute = async (c, ch, status, extra = {}) => {
  STRIPE.disputes[ch.id] = { ...(STRIPE.disputes[ch.id] || {}), id: extra.id || "dp_" + ch.id, status, ...(extra.amount ? { amount: extra.amount } : {}) };
  const type = ["won", "lost", "warning_closed"].includes(status) ? "charge.dispute.closed" : "charge.dispute.created";
  return webhook(cbEvent(type, ch, { status, ...extra }));
};
const mk2 = (o = {}) => mk({ pricing_version: 2, commission_bps: 500, commission_cents: 0, auto_days: 14, ...o });
const mk1 = (o = {}) => mk({ pricing_version: 1, commission_bps: 0, commission_cents: 0, auto_days: 7, ...o });
const row = (c) => DB.contracts.find(x => x.id === c.id) || c;
const lines = (c, kind) => DB.order_payments.filter(p => p.order_id === c.id && (!kind || p.kind === kind));
const tsOf = (c) => STRIPE.transfers.filter(t => t.metadata.contract_id === c.id);
const sent = (c) => tsOf(c).reduce((a, t) => a + t.amount - t.amount_reversed, 0);
const back = (c) => STRIPE.refunds.filter(r => r.contract === c.id && !(r.metadata && ["fee_surplus", "late_payment"].includes(r.metadata.kind))).reduce((a, r) => a + r.amount, 0);
const held = (c) => { const x = row(c); return x.funded_cents - x.released_cents - x.refunded_cents; };
const events = (c, ev) => DB.order_events.filter(e => e.order_id === c.id && (!ev || e.event === ev));
const cards = (c, ev) => DB.messages.filter(m => m.kind === "contract" && m.payload && m.payload.contract_id === c.id && m.payload.event === ev);
const ms = (c, amounts, status = "submitted") => { c.has_milestones = true; return amounts.map((a, i) => { const m = { id: uuid(), order_id: c.id, title: "part " + (i + 1), amount_cents: a, status, position: i + 1 }; DB.order_milestones.push(m); return m; }); };
const ledger = (c) => { const x = row(c); return [...checkLines(DB, [c.id]), ...reconcile(DB, STRIPE, x), ...listed(DB, x)]; };
const report = (p) => p.length ? " — " + p.slice(0, 3).join(" | ") : "";
async function fund2(c) { const r = await checkout(c); if (r.status !== 200) return { checkout: r }; const s = pay(c.stripe_checkout_id); return { checkout: r, session: s, webhook: await webhook(completed(s)) }; }
async function topUp(c, cents) { c.amount_cents += cents; const r = await checkout(c); if (r.status !== 200) return { checkout: r }; const s = pay(c.stripe_checkout_id); return { checkout: r, session: s, webhook: await webhook(completed(s)) }; }
const ready = (yes) => { STRIPE.accounts.acct_1EditorAAAAAAAA.payouts_enabled = yes; DB.payout_details.find(p => p.id === users.ed.id).stripe_payouts_enabled = yes; };
const dbError = () => new Response(JSON.stringify({ message: "canceling statement due to statement timeout" }), { status: 500, headers: { "content-type": "application/json" } });
const disputed = (c) => { const x = row(c); x.status = "disputed"; x.dispute_by = users.cl.id; x.disputed_at = new Date().toISOString(); };
const PLANS = [["plan 2", mk2, 2], ["plan 1", mk1, 1]];
const root = process.env.TARGET ? "file://" + process.env.TARGET + "/" : new URL("../", import.meta.url).href;
const page = fs.readFileSync(new URL("index.html", root), "utf8");
const CB_MARK = /^chargeback(:| won)/, OTHER_CB = /^chargeback (\S+) also (?:open )?on payment /;
const notes = (c) => String(row(c).money_error || "").split(" · Also: ").filter(Boolean);


const nz0 = (x) => Number(x) || 0;
const ban = (u, yes = true) => { DB.profiles.find(p => p.id === u.id).banned = yes; u.banned = yes; };
const show = (c) => { const x = row(c); return `${x.status}, paid in ${x.funded_cents}, paid out ${x.released_cents}, back ${x.refunded_cents}, held ${held(c)}; at the freelancer ${sent(c)}, back to the client ${back(c)}`; };
const ledgerP = (c, plan) => plan === 2 ? ledger(c).filter(x => !x.startsWith("to_decide:")) : (linesOk(c) ? [] : [`the paid-out total ${row(c).released_cents} is not what its lines say`]);
const linesOk = (c) => { const x = row(c), ls = lines(c); const sum = (k) => ls.filter(l => l.kind === k).reduce((a, l) => a + l.amount_cents, 0);
  return x.released_cents === sum("release") - sum("reversal"); };

// ---------- M1 a whole Order's payout answer lost, a chargeback before the hourly run, decided weeks later ----------
for (const [name, mkX, plan] of PLANS) {
  for (const [how, part] of [["won", 0], ["lost", 0], ["lost", 5000], ["won", 5000]]) {
    await guard(`M1 [${name}] ${how} ${part}`, async () => {
      ready(true);
      const c = mkX({ amount_cents: 20000, price: 200 }); const f = await fund2(c); const ch = chargeOf(f.session.payment_intent);
      arm("lost", (u, init) => u.includes("api.stripe.com/v1/transfers") && init.method === "POST" && !u.includes("reversals"));
      const a = await approve(c);
      later(15);
      await dispute(c, ch, "needs_response", part ? { amount: part } : {});
      later(30 * DAY); STRIPE.idem.clear();                        // Stripe keeps a request's key 24 hours
      const w = await dispute(c, ch, how, part ? { amount: part } : {});
      for (let i = 0; i < 3; i++) { later(60); await hourly(); }
      const pay = plan === 2 ? 19000 : 20000, pulled = how === "lost" ? (part ? (plan === 2 ? Math.round(pay * part / 20000) : part) : pay) : 0;
      const must = pay - pulled, ts = tsOf(c).filter(t => (t.metadata.purpose || "release") === "release");
      const p = ledgerP(c, plan);
      vuln(FAULT.hit !== 1 || a.status !== 503 || w.status !== 200 || sent(c) !== must || ts.length !== 1 || !["completed", "refunded"].includes(row(c).status) || held(c) !== 0 || p.length,
        `M1 [${name}] (fault ${FAULT.hit}, approve ${a.status}, decided ${w.status}) 200.00 approved, the payout's answer lost; a chargeback${part ? " of " + part / 100 + ".00" : ""} before the hourly run, decided ${how} 30 days later: ${show(c)}; payouts made ${ts.length}${report(p)} (must be: at the freelancer ${must}, 1 payout, nothing held, closed)`);
    });
  }
}

// ---------- M2 the same with a part of an Order ----------
for (const [name, mkX, plan] of PLANS) {
  for (const [how, expire] of [["won", true], ["won", false], ["lost", true], ["lost", false]]) {
    await guard(`M2 [${name}] ${how} ${expire}`, async () => {
      ready(true);
      const c = mkX({ amount_cents: 20000, price: 200 }); const f = await fund2(c); const ch = chargeOf(f.session.payment_intent);
      c.status = "funded";
      const [m1] = ms(c, [6000, 14000]);
      arm("lost", (u, init) => u.includes("api.stripe.com/v1/transfers") && init.method === "POST" && !u.includes("reversals"));
      const a = await approve(c, m1.id);
      later(15);
      await dispute(c, ch, "needs_response");
      if (expire) { later(30 * DAY); STRIPE.idem.clear(); }
      const w = await dispute(c, ch, how);
      for (let i = 0; i < 3; i++) { later(60); await hourly(); }
      const pay = plan === 2 ? 5700 : 6000, must = how === "won" ? pay : 0;
      const ts = tsOf(c).filter(t => t.metadata.milestone_id === m1.id);
      const p = ledgerP(c, plan);
      const m1now = DB.order_milestones.find(m => m.id === m1.id).status, heldMust = how === "won" ? 14000 : 0;
      const stuck = notes(c).filter(n => n.includes(m1.id));
      vuln(FAULT.hit !== 1 || a.status !== 503 || w.status !== 200 || sent(c) !== must || ts.length !== 1 || m1now !== "released" || held(c) !== heldMust || (how === "lost" && row(c).status !== "refunded") || stuck.length || p.length,
        `M2 [${name}] (fault ${FAULT.hit}, approve ${a.status}, decided ${w.status}) part 1 (60.00 of 200.00) approved, its payout's answer lost; a chargeback on the payment before the hourly run, decided ${how}${expire ? " 30 days later" : " at once"}: ${show(c)}; part 1 ${m1now}, its payouts ${ts.length}${stuck.length ? "; its note stays: " + stuck[0].slice(0, 60) : ""}${report(p)} (must be: at the freelancer ${must}, held ${heldMust}, part 1 released, 1 payout${how === "lost" ? ", Order refunded" : ""}, no note)`);
    });
  }
}

// helpers for refunds made in the Stripe dashboard and their notices
const dashRefund = (pi, amount) => { const ch = chargeOf(pi); ch.amount_refunded += amount; STRIPE.balance -= amount;
  const r = { id: "re_dash" + Math.random().toString(36).slice(2, 10), created: Date.now() / 1000, amount, contract: null, metadata: {}, payment_intent: pi, charge: ch.id, status: "succeeded" }; STRIPE.refunds.push(r); return r; };
const refundedEvent = (pi) => { const ch = chargeOf(pi); return signed({ type: "charge.refunded", data: { object: { id: ch.id, object: "charge", payment_intent: pi, amount: ch.amount, amount_refunded: ch.amount_refunded, refunded: ch.amount_refunded >= ch.amount, currency: "eur" } } }); };
const failedEvent = (r) => signed({ type: "charge.refund.updated", data: { object: { ...r, object: "refund", status: "failed", currency: "eur", failure_reason: "expired_or_canceled_card" } } });
const refundFails = (r) => { r.status = "failed"; const ch = STRIPE.charges[r.charge]; ch.amount_refunded -= r.amount; STRIPE.balance += r.amount; return failedEvent(r); };
const okBack = (pi) => STRIPE.refunds.filter(r => r.payment_intent === pi && r.status === "succeeded" && !(r.metadata && ["fee_surplus", "late_payment"].includes(r.metadata.kind))).reduce((a, r) => a + r.amount, 0);

// ---------- M3 a dashboard refund failed, made again in the dashboard as the note says ----------
for (const [name, mkX, plan] of PLANS) {
  await guard(`M3 [${name}]`, async () => {
    ready(true);
    const c = mkX(); const f = await fund2(c); const pi = f.session.payment_intent;
    const r1 = dashRefund(pi, 4000); const w1 = await webhook(refundedEvent(pi));
    const w2 = await webhook(refundFails(r1));
    const said = notes(c).find(n => n.startsWith("refund " + r1.id)) || "";
    dashRefund(pi, 4000); const w3 = await webhook(refundedEvent(pi));
    const mid = { ...row(c) };
    const d = await resolve(c, "release"); later(60); await hourly();
    const fl = plan === 2 ? 5700 : 6000;
    vuln(w1.status !== 200 || w2.status !== 200 || w3.status !== 200 || !/refund it again in the Stripe dashboard/.test(said) || mid.refunded_cents !== 4000 || d.status !== 200 || sent(c) !== fl || okBack(pi) !== 4000 || held(c) !== 0,
      `M3 [${name}] 40.00 refunded in the dashboard, the refund failed, made again in the dashboard as the note says: the Order counts ${mid.refunded_cents} given back; 'release' -> ${d.status}: ${show(c)}; the client has ${okBack(pi)} back (must be 4000 counted, the freelancer ${fl}, the client 4000)`);
  });
}

// ---------- M4 a failed refund's notice sent again after its note was marked as handled ----------
for (const [name, mkX, plan] of PLANS) {
  await guard(`M4 [${name}]`, async () => {
    ready(true);
    const c = mkX(); const f = await fund2(c); const pi = f.session.payment_intent;
    const k = await cancel(c);
    const ours = STRIPE.refunds.find(x => x.payment_intent === pi && x.metadata.contract_id === c.id && !x.metadata.kind);
    const ev = refundFails(ours); const w1 = await webhook(ev);
    const mid = { ...row(c) };
    dashRefund(pi, ours.amount); const w2 = await webhook(refundedEvent(pi));
    row(c).money_error = null;                                        // "Mark as handled"
    const w3 = await webhook(failedEvent(ours));
    const x = row(c);
    vuln(k.status !== 200 || w1.status !== 200 || mid.refunded_cents !== 0 || w2.status !== 200 || w3.status !== 200 || x.refunded_cents !== 10000 || held(c) !== 0 || x.status !== "refunded",
      `M4 [${name}] the cancel's refund failed (counted back: ${mid.refunded_cents} given back), made again in the dashboard, note marked as handled; the "failed" notice once more -> ${w3.status}: ${show(c)} (must be 10000 given back, nothing held, refunded)`);
  });
}

// ---------- M5 Cuvori's card-fee refund failed ----------
await guard("M5a [plan 1]", async () => {
  const c = mk1(); const f = await fund2(c); const pi = f.session.payment_intent;
  later(10); await hourly();
  const fr = STRIPE.refunds.find(r => r.payment_intent === pi && r.metadata.kind === "fee_surplus");
  const w = await webhook(refundFails(fr));
  const n = notes(c).find(x => x.includes(fr.id)) || "";
  vuln(!fr || w.status !== 200 || !n || !/another way/.test(n) || /send it to them by hand$/.test(n),
    `M5a [plan 1] the card-fee refund of ${fr && fr.amount} failed -> ${w.status}; the note says: "${n.slice(n.indexOf("—"))}" (must say to pay it another way, never a refund in the Stripe dashboard, which counts as Order money)`);
});
await guard("M5b [plan 1]", async () => {
  const c = mk1(); const f = await fund2(c); const pi = f.session.payment_intent, ch = chargeOf(pi);
  later(10); await hourly();
  const fee = STRIPE.refunds.find(r => r.payment_intent === pi && r.metadata.kind === "fee_surplus");
  const snapshot = { ...ch, object: "charge", refunded: false, amount_refunded: fee.amount };
  refundFails(fee);
  const w = await webhook(signed({ type: "charge.refunded", data: { object: snapshot } }));
  const x = row(c);
  vuln(w.status !== 200 || x.status !== "funded" || nz0(x.refunded_cents) !== 0 || lines(c, "refund").length,
    `M5b [plan 1] the card-fee refund failed, then its "refunded" notice came -> ${w.status}: ${x.status}, counted back ${x.refunded_cents}, refund lines ${lines(c, "refund").length} (must be funded, 0, 0)`);
});
await guard("M5c [plan 2]", async () => {
  const c = mk2(); const f = await fund2(c); const pi = f.session.payment_intent;
  const r = dashRefund(pi, 3000); const ev = refundedEvent(pi);
  refundFails(r); const w1 = await webhook(failedEvent(r));
  const w = await webhook(ev);                                         // the "refunded" notice, delivered after the refund failed
  const x = row(c);
  vuln(w1.status !== 200 || w.status !== 200 || nz0(x.refunded_cents) !== 0 || x.status !== "funded",
    `M5c [plan 2] a dashboard refund that failed; its "refunded" notice delivered after -> ${w.status}: ${x.status}, given back ${x.refunded_cents} (must be 200, funded, 0)`);
});

// ---------- M6 a price increase paid on two pages ----------
for (const [name, mkX, plan] of PLANS) {
  await guard(`M6 [${name}]`, async () => {
    const c = mkX(); await fund2(c);
    c.amount_cents += 5000;
    await checkout(c); const pageA = row(c).stripe_checkout_id;
    let failExpire = true;
    hooks.stripe = async (path) => { if (failExpire && path.endsWith("/expire")) { failExpire = false; return [500, { error: { type: "api_error", message: "An unknown error occurred" } }]; } return null; };
    await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, lang: "de" } })); hooks.stripe = null;
    const pageB = row(c).stripe_checkout_id;
    const sA = pay(pageA), sB = pay(pageB);
    let refused = false;
    hooks.db = async (method, table, search, body) => { if (!refused && method === "PATCH" && table === "contracts" && /"funded_cents"/.test(String(body))) { refused = true; return dbError(); } return null; };
    const wA = await webhook(completed(sA)); hooks.db = null;
    const wB = await webhook(completed(sB));
    later(10); const wA2 = await webhook(completed(sA));
    later(180); await hourly();
    const a = STRIPE.intents[sA.payment_intent], b = STRIPE.intents[sB.payment_intent];
    const lost = [sA, sB].reduce((s0, x) => { const p = STRIPE.intents[x.payment_intent]; return s0 + (p.status === "succeeded" ? p.amount - STRIPE.refunds.filter(r => r.payment_intent === x.payment_intent).reduce((t, r) => t + r.amount, 0) : 0); }, 0) - (plan === 2 ? 5000 : a.amount - 92 - 0);
    vuln(pageA === pageB || wA.status === 200 || [a.status, b.status].filter(x => x === "succeeded").length !== 1 || row(c).funded_cents !== 15000 || row(c).money_error,
      `M6 [${name}] a 50.00 price increase paid on two pages, the first one's count refused once: first page ${a.status}, second ${b.status}; the Order counts ${row(c).funded_cents} paid in; note ${JSON.stringify(row(c).money_error)} (must be one charged, 15000, no note)`);
  });
}

// ---------- M7 the new prices: a top-up sent back as a late payment never takes another top-up's line ----------
await guard("M7 [plan 2]", async () => {
  const c = mk2(); await fund2(c);
  c.amount_cents += 5000; await checkout(c); const sA = pay(row(c).stripe_checkout_id);
  let refused = false;
  hooks.db = async (method, table, search, body) => { if (!refused && method === "PATCH" && table === "contracts" && /"funded_cents"/.test(String(body))) { refused = true; return dbError(); } return null; };
  await webhook(completed(sA)); hooks.db = null;                   // A charged, its count refused: its claim stays
  c.amount_cents -= 5000; row(c).amount_cents = c.amount_cents;     // the increase is withdrawn before Stripe sends A again
  later(10); const wA = await webhook(completed(sA));             // A goes back as a late payment
  later(60);
  c.amount_cents += 5000; row(c).amount_cents = c.amount_cents;     // a new increase C of the same size, paid; its line can't be saved
  await checkout(c); const sC = pay(row(c).stripe_checkout_id);
  hooks.db = async (method, table, search, body) => {
    if (method === "POST" && table === "order_payments" && String(body).includes(sC.payment_intent)) return dbError();
    if (method === "PATCH" && table === "contracts" && String(body).includes("ledger line failed")) return dbError();
    return null;
  };
  await webhook(completed(sC)); hooks.db = null;
  later(5); await hourly(); later(60); await hourly();
  const lineOf = (pi) => lines(c, "fund").filter(l => l.provider_ref === pi).length;
  const backA = okBack(sA.payment_intent) + STRIPE.refunds.filter(r => r.payment_intent === sA.payment_intent && r.metadata.kind === "late_payment").reduce((a, r) => a + r.amount, 0);
  const k = await cancel(c);
  const all = [row(c).stripe_payment_intent, sC.payment_intent].reduce((a, pi) => a + okBack(pi), 0);
  vuln(backA !== 5000 || lineOf(sA.payment_intent) !== 0 || lineOf(sC.payment_intent) !== 1 || k.status !== 200 || all !== 15000 || row(c).status !== "refunded",
    `M7 [plan 2] top-up A sent back as a late payment (${backA} back, its claim kept), top-up C counted with its line not saved; after the hourly run: lines A ${lineOf(sA.payment_intent)}, C ${lineOf(sC.payment_intent)}; the freelancer gives the Order back -> ${k.status}: the client got back ${all} of the 150.00 in the Order (must be lines A 0, C 1; 15000)`);
});

// ---------- M8 a stuck decision whose re-payment went through; a refund Stripe refuses for good ----------
for (const what of ["banned", "account closed"]) {
  await guard(`M8 [plan 2] ${what}`, async () => {
    ready(true); const c = mk2(); const f = await fund2(c); row(c).status = "funded"; const ch = chargeOf(f.session.payment_intent);
    const [m1] = ms(c, [6000, 4000]);
    await approve(c, m1.id);
    await dispute(c, ch, "needs_response");
    ready(false); await dispute(c, ch, "won");
    disputed(c);
    const r1 = await resolve(c, "release");
    ready(true);
    let short = true;
    hooks.stripe = async (path, method, q) => (short && method === "POST" && path === "/transfers" && !String(q.get("metadata[purpose]") || "").startsWith("retransfer_") ? [400, { error: { type: "invalid_request_error", code: "balance_insufficient", message: "You have insufficient funds in your Stripe account." } }] : null);
    later(15); await hourly(); short = false; hooks.stripe = null;
    const repaid = tsOf(c).filter(t => String(t.metadata.purpose).startsWith("retransfer_")).length;
    if (what === "banned") ban(users.ed); else ready(false);
    const r2 = await resolve(c, "refund");
    later(60); await hourly();
    if (what === "banned") ban(users.ed, false);
    vuln(r1.status !== 409 || repaid !== 1 || r2.status !== 200 || row(c).status !== "refunded" || back(c) !== 4000 || sent(c) !== 5700 || held(c) !== 0,
      `M8 [plan 2] ${what}: 'release' made the re-payment (${repaid}) and its payout stopped; the admin replaces it with 'refund' -> ${r2.status} ${JSON.stringify(r2.json && r2.json.error || "")}: ${show(c)} (must be 200, refunded, the client 4000 back, the freelancer 5700)`);
  });
}
for (const [name, mkX, plan] of PLANS) {
  await guard(`M8b [${name}]`, async () => {
    ready(true); const c = mkX(); await fund2(c); disputed(c);
    hooks.stripe = async (path, method) => (method === "POST" && path === "/refunds" ? [400, { error: { type: "invalid_request_error", code: "charge_expired_for_refund", message: "This charge is too old to be refunded." } }] : null);
    const r = await resolve(c, "split", { editor_percent: 50 });
    later(60); await hourly(); hooks.stripe = null;
    const n = notes(c).find(x => x.startsWith("Money step stopped (settlement)")) || "";
    vuln(r.status !== 409 || (r.json && r.json.code) !== "refund_impossible" || !/50\.00 EUR is owed to the client/.test(n) || !/another way/.test(n),
      `M8b [${name}] 'split' 50%, the client's refund refused for good by Stripe (too old) -> ${r.status} ${JSON.stringify(r.json && r.json.code)}; the note: "${n.slice(0, 160)}" (must be 409 refund_impossible; the note says what the client is owed and to pay it another way)`);
  });
}

// ---------- M9 the bank's decision whose plan no longer fits once the pull-back went through ----------
for (const [name, mkX, plan] of PLANS) {
  await guard(`M9 [${name}]`, async () => {
    const c = mkX(); const f = await fund2(c); const ch = chargeOf(f.session.payment_intent);
    await approve(c);
    let refuse = true;
    hooks.stripe = async (path, method) => (refuse && method === "POST" && /\/reversals$/.test(path)) ? [400, { error: { type: "invalid_request_error", code: "insufficient_funds", message: "Insufficient funds in the connected account to reverse this transfer." } }] : null;
    await dispute(c, ch, "needs_response");
    arm("refused", (u, init) => u.includes("/rest/v1/contracts") && init.method === "PATCH" && bodyOf(init).includes('"chargeback_status":"lost"'));
    const w1 = await dispute(c, ch, "lost");
    refuse = false; hooks.stripe = null;
    const ws = []; for (let i = 0; i < 3; i++) { later(60); ws.push((await dispute(c, ch, "lost")).status); }
    later(60); await hourly();
    vuln(w1.status === 200 || !ws.includes(200) || row(c).chargeback_status !== "lost" || sent(c) !== 0 || row(c).status !== "refunded",
      `M9 [${name}] the decided notice's first try broke off (${w1.status}) with the pull-back still refused; it went through by the next tries -> ${ws.join(",")}: chargeback ${row(c).chargeback_status}, ${show(c)} (must reach 200, lost, refunded, the freelancer 0)`);
  });
}

// ---------- M10 a part's payout not counted yet, then a cancel or a decision; and while the freelancer is banned ----------
for (const [name, mkX, plan] of PLANS) {
  for (const how of ["cancel", "preview", "split", "refund"]) {
    await guard(`M10 [${name}] ${how}`, async () => {
      ready(true); const c = mkX(); await fund2(c); row(c).status = "funded";
      const [m1] = ms(c, [6000, 4000]);
      arm("lost", (u, init) => u.includes("api.stripe.com/v1/transfers") && init.method === "POST");
      const a = await approve(c, m1.id);
      if (how === "split" || how === "refund") disputed(c);
      const r = how === "cancel" ? await cancel(c) : how === "preview" ? await cancel(c, { preview: true }) : how === "refund" ? await resolve(c, "refund") : await resolve(c, "split", { editor_percent: 50 });
      const rec = how === "cancel" ? (events(c, "cancelled")[0] || {}).data || {} : (events(c, "decision").slice(-1)[0] || {}).data || {};
      const j = r.json || {};
      const answered = how === "cancel" ? [j.refunded] : how === "preview" ? [j.refund_cents] : [j.editorCents, j.refundCents];
      const recorded = how === "cancel" ? [rec.refund_cents] : how === "preview" ? [4000] : [rec.editor_cents, rec.refund_cents];
      const must = how === "split" ? [2000, 2000] : how === "refund" ? [0, 4000] : [4000];
      vuln(a.status !== 503 || r.status !== 200 || answered.join() !== must.join() || recorded.join() !== must.join(),
        `M10 [${name}] part 1 (60.00) paid at Stripe, its answer lost; then ${how} -> ${r.status}: answered ${answered.join("/")}, recorded ${recorded.join("/")}; ${show(c)} (must be ${must.join("/")} both)`);
    });
  }
  await guard(`M10b [${name}]`, async () => {
    ready(true); const c = mkX(); await fund2(c); row(c).status = "funded";
    const [m1] = ms(c, [6000, 4000]);
    arm("lost", (u, init) => u.includes("api.stripe.com/v1/transfers") && init.method === "POST");
    await approve(c, m1.id);
    ban(users.ed);
    for (let i = 0; i < 3; i++) { later(DAY); await hourly(); }
    const mid = { ...row(c) }, ts = tsOf(c).length;
    ban(users.ed, false);
    vuln(mid.released_cents !== 6000 || held({ id: c.id }) !== 4000 || ts !== 1 || DB.order_milestones.find(m => m.id === m1.id).status !== "released",
      `M10b [${name}] part 1 paid at Stripe (answer lost), the freelancer banned: after three days of hourly runs the Order counts ${mid.released_cents} paid out, payouts ${ts}, part 1 ${DB.order_milestones.find(m => m.id === m1.id).status} (must be 6000, 1, released)`);
  });
}

// ---------- M11 a decision whose history line's answer was lost: both sides still told ----------
for (const [name, mkX] of PLANS) {
  for (const then of ["admin retries", "hourly run first, then admin retries", "hourly run only"]) {
    await guard(`M11 [${name}] ${then}`, async () => {
      DB.messages.length = 0;
      ready(true); const c = mkX(); await fund2(c); disputed(c);
      DB.order_events.push({ id: uuid(), order_id: c.id, actor: users.cl.id, event: "disputed", data: {} });
      arm("lost", (u, init) => u.includes("/rest/v1/order_events") && init.method === "POST" && /"event":"decision"/.test(bodyOf(init)));
      const r1 = await resolve(c, "refund");
      if (then !== "admin retries") { later(15); await hourly(); }
      if (then !== "hourly run only") await resolve(c, "refund");
      const flags = DB.user_flags.filter(f => f.contract_id === c.id && f.kind === "dispute_lost").length;
      const msgs = DB.messages.filter(m => m.kind === "text" && m.conversation_id === c.conversation_id && String(m.body || "") === "Cuvori decision: " + NOTE).length;
      vuln(r1.status !== 503 || row(c).status !== "refunded" || flags !== 1 || msgs !== 1,
        `M11 [${name}] the decision's history line saved with its answer lost (${r1.status}); ${then}: ${row(c).status}; "lost a dispute" marks on the freelancer ${flags}, "Cuvori decision:" chat messages ${msgs} (must be refunded, 1, 1)`);
      DB.messages.length = 0;
    });
  }
}

// ---------- M12 inquiry notices out of order ----------
const inq = (n) => n.startsWith("the client's bank asked about payment");
for (const [name, mkX] of PLANS) {
  await guard(`M12a [${name}]`, async () => {
    const c = mkX(); const f = await fund2(c); const ch = chargeOf(f.session.payment_intent);
    await approve(c);
    STRIPE.disputes[ch.id] = { id: "du_" + ch.id, status: "warning_closed" };
    await dispute(c, ch, "warning_closed", { id: "du_" + ch.id });
    const late = cbEvent("charge.dispute.created", ch, { id: "du_" + ch.id, status: "warning_needs_response" });
    STRIPE.disputeObjs["du_" + ch.id].status = "warning_closed";                // what Stripe says now
    const w = await webhook(late);
    for (let i = 0; i < 2; i++) { later(DAY); await hourly(); }
    vuln(w.status !== 200 || notes(c).some(inq),
      `M12a [${name}] the inquiry's "ended" notice came before its "opened" one -> ${w.status}; after the hourly runs its note ${notes(c).some(inq) ? "STILL THERE" : "gone"} (must be gone)`);
  });
  await guard(`M12b [${name}]`, async () => {
    const c = mkX(); const f = await fund2(c); const ch = chargeOf(f.session.payment_intent);
    await approve(c);
    await dispute(c, ch, "warning_needs_response", { id: "du_" + ch.id });
    await dispute(c, ch, "needs_response", { id: "du_" + ch.id, type: "charge.dispute.funds_withdrawn" });
    const again = cbEvent("charge.dispute.created", ch, { id: "du_" + ch.id, status: "warning_needs_response" });
    STRIPE.disputes[ch.id].status = "needs_response"; STRIPE.disputeObjs["du_" + ch.id].status = "needs_response";
    const w = await webhook(again);
    const mid = notes(c).some(inq);
    await dispute(c, ch, "lost", { id: "du_" + ch.id });
    for (let i = 0; i < 2; i++) { later(DAY); await hourly(); }
    vuln(w.status !== 200 || mid || notes(c).some(inq) || row(c).chargeback_status !== "lost",
      `M12b [${name}] the inquiry became a chargeback; its first notice sent again -> ${w.status}, noted again: ${mid}; the chargeback lost: note ${notes(c).some(inq) ? "STILL THERE" : "gone"} (must be not noted, gone)`);
  });
}

// ---------- M13 a payment partly given back, then charged back in full ----------
for (const [name, mkX, plan] of PLANS) {
  await guard(`M13 [${name}]`, async () => {
    const c = mkX(); const f = await fund2(c); const pi = f.session.payment_intent, ch = chargeOf(pi);
    disputed(c); const r = await resolve(c, "split", { editor_percent: 70 });
    await dispute(c, ch, "needs_response"); const w = await dispute(c, ch, "lost");
    const n = notes(c).find(x => x.startsWith("refunded payment charged back")) || "";
    vuln(r.status !== 200 || w.status !== 200 || !/30\.00 EUR of this payment back/.test(n),
      `M13 [${name}] 'split' 70/30 (30.00 back to the client), then the whole payment charged back and lost (${w.status}): the note "${n.slice(0, 150)}" (must say 30.00 had already gone back and may have been taken twice)`);
  });
}
await guard("M13b [plan 1]", async () => {
  const c = mk1(); const f = await fund2(c); const ch = chargeOf(f.session.payment_intent);
  later(10); await hourly(); await approve(c);
  await dispute(c, ch, "needs_response"); await dispute(c, ch, "lost");
  vuln(notes(c).some(x => x.startsWith("refunded payment charged back")),
    `M13b [plan 1] a payment whose only refund was the card-fee surplus, charged back in full: a note about money taken twice ${notes(c).some(x => x.startsWith("refunded payment charged back")) ? "WRITTEN" : "none"} (must be none: the card fee is not the Order's money)`);
});

// ---------- M14 a part's payout not counted, a chargeback the held money covered, lost; then the next part approved ----------
for (const [name, mkX, plan] of PLANS) {
  await guard(`M14 [${name}]`, async () => {
    ready(true); const c = mkX({ amount_cents: 20000, price: 200 }); const f = await fund2(c); const ch = chargeOf(f.session.payment_intent);
    row(c).status = "funded";
    const [m1, m2] = ms(c, [6000, 14000]);
    arm("lost", (u, init) => u.includes("api.stripe.com/v1/transfers") && init.method === "POST" && !u.includes("reversals"));
    await approve(c, m1.id);
    later(15);
    await dispute(c, ch, "needs_response", { amount: 6000 }); const w = await dispute(c, ch, "lost", { amount: 6000 });
    const a = await approve(c, m2.id);
    later(60); await hourly();
    const pay = plan === 2 ? 5700 : 6000;
    vuln(w.status !== 200 || a.status !== 409 || sent(c) !== pay || held(c) !== 8000 || DB.order_milestones.find(m => m.id === m2.id).status === "released",
      `M14 [${name}] part 1 paid at Stripe (answer lost), 60.00 charged back and lost, then part 2 (140.00) approved -> ${a.status} ${JSON.stringify(a.json && a.json.code)}: ${show(c)} (must be refused: 80.00 left for 140.00; the freelancer ${pay})`);
  });
}

// ---------- M15 a part counted by another step while its own mark was refused ----------
for (const [name, mkX, plan] of PLANS) {
  await guard(`M15 [${name}]`, async () => {
    ready(true); const c = mkX(); await fund2(c); row(c).status = "funded";
    const [m1] = ms(c, [3000, 7000]);
    arm("lost", (u, init) => u.includes("api.stripe.com/v1/transfers") && init.method === "POST");
    await approve(c, m1.id);
    later(15);
    arm("refused", (u, init) => u.includes("/rest/v1/order_milestones") && init.method === "PATCH" && bodyOf(init).includes('"status":"released"'));
    const b = await approve(c, m1.id); FAULT.pred = null;
    const mid = { ...row(c) };
    const k = await cancel(c); later(60); await hourly();
    const hist = events(c, "milestone_released").filter(e => e.data && e.data.milestone === m1.id).length, card = cards(c, "milestone_approved").length;
    vuln(mid.released_cents !== 3000 || row(c).status !== "refunded" || back(c) !== 7000 || held(c) !== 0 || DB.order_milestones.find(m => m.id === m1.id).status !== "released" || hist !== 1 || card !== 1,
      `M15 [${name}] part 1 (30.00) paid at Stripe (answer lost); approved again with its "paid out" mark refused once -> ${b.status}: paid out ${mid.released_cents}; the freelancer cancels -> ${k.status}: ${show(c)}; part 1's history lines ${hist}, chat cards ${card} (must be 3000; refunded, the client 7000 back, nothing held; 1, 1)`);
  });
}

// ---------- M16 money held apart: a part paid in pieces whose payout stopped between two pieces ----------
for (const [label, parts] of [["60+60", [6000, 6000]], ["90+20+10", [9000, 2000, 1000]]]) {
  await guard(`M16 ${label}`, async () => {
    process.env.STRIPE_FUNDS_SEGREGATION = "on"; fsReset(); ready(true);
    try {
      const c = mk2({ amount_cents: 10000 }); await fund2(c); row(c).status = "funded"; await topUp(c, 2000);
      const m = ms(c, parts); await approve(c, m[0].id);
      let cut = 0;
      hooks.stripe = (path, method, q) => (method === "POST" && path === "/transfers" && q.get("metadata[milestone_id]") === m[1].id && q.get("metadata[part]") === "1" && cut++ === 0
        ? [400, { error: { type: "invalid_request_error", message: "The amount of this transfer exceeds the allocated funds available on the source charge" } }] : null);
      await approve(c, m[1].id); hooks.stripe = null;
      later(60); await approve(c, m[1].id);
      if (m[2]) await approve(c, m[2].id);
      for (let i = 0; i < 3; i++) { later(60); await hourly(); }
      const st = m.map(x => DB.order_milestones.find(y => y.id === x.id).status);
      vuln(st.some(x => x !== "released") || row(c).status !== "completed" || held(c) !== 0 || sent(c) !== 11400 || row(c).released_cents !== 12000,
        `M16 [plan 2, held apart] parts ${label} on 100.00 + 20.00; part 2's payout stopped after its first piece, then approved again: parts ${st.join("/")}; ${show(c)} (must be all released, completed, the freelancer 11400, paid out 12000)`);
    } finally { delete process.env.STRIPE_FUNDS_SEGREGATION; STRIPE.fs = null; }
  });
}

// ---------- M17 a decision told after a lost answer or a refused write ----------
for (const [name, mkX] of PLANS) {
  for (const how of ["the key's answer lost", "the mark refused"]) {
    await guard(`M17 [${name}] ${how}`, async () => {
      DB.messages.length = 0;
      ready(true); const c = mkX(); await fund2(c); disputed(c);
      DB.order_events.push({ id: uuid(), order_id: c.id, actor: users.cl.id, event: "disputed", data: {} });
      let outage = how === "the mark refused";
      if (how === "the key's answer lost") arm("lost", (u, init) => u.includes("/rest/v1/money_keys") && init.method === "POST" && bodyOf(init).includes('"scope":"decision_told:'));
      hooks.db = async (method, table) => (outage && method === "POST" && table === "user_flags" ? dbError() : null);
      const r = await resolve(c, "refund"); outage = false; hooks.db = null;
      for (let i = 0; i < 2; i++) { later(60); await hourly(); }
      const flags = DB.user_flags.filter(f => f.contract_id === c.id && f.kind === "dispute_lost").length;
      const msgs = DB.messages.filter(m => m.kind === "text" && m.conversation_id === c.conversation_id && String(m.body || "") === "Cuvori decision: " + NOTE).length;
      vuln(r.status !== 200 || flags !== 1 || msgs !== 1,
        `M17 [${name}] Cuvori's 'refund', ${how} -> ${r.status}; after the hourly runs: "lost a dispute" marks ${flags}, "Cuvori decision:" messages ${msgs} (must be 200, 1, 1)`);
      DB.messages.length = 0;
    });
  }
}

// ---------- M18 a refund Stripe can no longer make, across a top-up and an old first payment ----------
for (const [name, mkX] of PLANS) {
  await guard(`M18 [${name}]`, async () => {
    const c = mkX(); const f = await fund2(c); const pi1 = f.session.payment_intent;
    const t = await topUp(c, 5000);
    later(10); await hourly(); disputed(c);
    hooks.stripe = async (path, method, q) => (method === "POST" && path === "/refunds" && q.get("payment_intent") === pi1 && !q.get("metadata[kind]")
      ? [400, { error: { type: "invalid_request_error", code: "charge_expired_for_refund", message: "This charge is too old to be refunded." } }] : null);
    const r = await resolve(c, "refund"); hooks.stripe = null;
    const n = notes(c).find(x => x.startsWith("Money step stopped (settlement)")) || "";
    const topBack = okBack(t.session.payment_intent);
    vuln(r.status !== 409 || topBack !== 5000 || !/: 100\.00 EUR is owed to the client \(50\.00 EUR of this refund went back to the card\)/.test(n) || !/100\.00 EUR is owed/.test(JSON.stringify(r.json || {})),
      `M18 [${name}] a 'refund' of 150.00: the 50.00 top-up went back, the old 100.00 first payment can't -> ${r.status}; the note says "${(n.match(/: [^:]*owed to the client[^.]*/) || [""])[0]}"; the admin's answer ${JSON.stringify(r.json && r.json.error || "").slice(0, 90)} (must say 100.00 is owed, 50.00 went back)`);
  });
}
{
  const fnSrc = (page.match(/function fnPlain\(e,pay\)\{[\s\S]*?\n  \}/) || [""])[0];
  let said = "";
  try { said = new Function("t", "fill", "isAdmin", fnSrc + "\nreturn fnPlain;")((k) => "KEY:" + k, (x) => x, () => true)({ code: "refund_impossible", reason: "100.00 EUR is owed to the client" }, false) || ""; } catch {}
  vuln(!said.includes("KEY:fn_refundGone") || !said.includes("100.00 EUR is owed"),
    `M18b the admin's answer on the page for a refund Stripe can no longer make: "${said}" (must give the person's words and, for the admin, how much is owed)`);
}

// ---------- M19 a second, different price increase while the first one's line is missing ----------
for (const [name, mkX] of PLANS) {
  await guard(`M19 [${name}]`, async () => {
    const c = mkX(); await fund2(c);
    c.amount_cents += 5000; row(c).amount_cents = c.amount_cents;
    await checkout(c); const sA = pay(row(c).stripe_checkout_id);
    hooks.db = async (method, table, search, body) => (method === "POST" && table === "order_payments" && String(body).includes(sA.payment_intent) ? dbError() : null);
    await webhook(completed(sA));
    later(10);
    c.amount_cents += 3000; row(c).amount_cents = c.amount_cents;
    await checkout(c); const sB = pay(row(c).stripe_checkout_id);
    const wB = await webhook(completed(sB)); hooks.db = null;
    const b = STRIPE.intents[sB.payment_intent].status;
    vuln(wB.status !== 200 || b !== "succeeded" || row(c).funded_cents !== 18000,
      `M19 [${name}] increase A (50.00) counted with its line missing; a second increase B (30.00) paid -> ${wB.status}: B ${b}, the Order counts ${row(c).funded_cents} paid in (must be succeeded, 18000)`);
  });
}

// ---------- M21 failed refunds: the count back's answer lost; made again before the "failed" notice; money paid out twice ----------
for (const [name, mkX, plan] of PLANS) {
  await guard(`M21a [${name}]`, async () => {
    const c = mkX(); const f = await fund2(c); const pi = f.session.payment_intent;
    await cancel(c);
    const ours = STRIPE.refunds.find(x => x.payment_intent === pi && x.metadata.contract_id === c.id && !x.metadata.kind);
    const ev = refundFails(ours);
    arm("lost", (u, init) => u.includes("/rest/v1/contracts") && init.method === "PATCH" && bodyOf(init).includes(`refund ${ours.id} `));
    const w1 = await webhook(ev);
    dashRefund(pi, ours.amount); await webhook(refundedEvent(pi));
    row(c).money_error = null;
    const w3 = await webhook(failedEvent(ours));
    vuln(FAULT.hit !== 1 || w3.status !== 200 || row(c).refunded_cents !== 10000 || held(c) !== 0,
      `M21a [${name}] a failed refund's count back landed with its answer lost (${w1.status}); made again in the dashboard, note marked as handled, the "failed" notice again -> ${w3.status}: ${show(c)} (must be 10000 given back, nothing held)`);
  });
  await guard(`M21b [${name}]`, async () => {
    const c = mkX(); const f = await fund2(c); const pi = f.session.payment_intent;
    const r1 = dashRefund(pi, 4000); await webhook(refundedEvent(pi));
    const failed = refundFails(r1);
    dashRefund(pi, 4000); const w2 = await webhook(refundedEvent(pi));
    const w3 = await webhook(failed);
    later(60); await hourly();
    const mid = row(c).refunded_cents;
    const d = await resolve(c, "release"); later(60); await hourly();
    const fl = plan === 2 ? 5700 : 6000;
    vuln(w2.status !== 200 || w3.status !== 200 || mid !== 4000 || d.status !== 200 || sent(c) !== fl || okBack(pi) !== 4000,
      `M21b [${name}] a dashboard refund failed and was made again before Cuvori handled the "failed" notice (${w2.status}, ${w3.status}): the Order counts ${mid} given back; 'release' -> ${d.status}: the freelancer ${sent(c)}, the client ${okBack(pi)} (must be 4000; ${fl}, 4000)`);
  });
  await guard(`M21c [${name}]`, async () => {
    const c = mkX(); const f = await fund2(c); const pi = f.session.payment_intent;
    later(10); await hourly();
    disputed(c); await resolve(c, "split", { editor_percent: 60 });
    const r1 = dashRefund(pi, 3000); await webhook(refundedEvent(pi));
    const w = await webhook(refundFails(r1));
    const x = row(c);
    vuln(w.status !== 200 || x.refunded_cents !== 4000 || held(c) !== 0,
      `M21c [${name}] a completed 60/40 split; a 30.00 dashboard refund (money out twice) that then failed -> ${w.status}: given back ${x.refunded_cents}, held ${held(c)} (must be 4000, 0)`);
  });
}

// ---------- the second re-check ----------
for (const [name, mkX, plan] of PLANS) {
  await guard(`M12c [${name}]`, async () => {
    ready(true);
    const c = mkX(); const f = await fund2(c); const ch = chargeOf(f.session.payment_intent);
    const x = row(c); x.status = "delivered"; x.delivered_at = new Date(Date.now() - 20 * 86400e3).toISOString(); x.auto_release_at = new Date(Date.now() - 3600e3).toISOString();
    const id = "du_" + ch.id;
    STRIPE.disputes[ch.id] = { id, status: "needs_response" };
    const ev = cbEvent("charge.dispute.created", ch, { id, status: "warning_needs_response" });
    STRIPE.disputeObjs[id].status = "needs_response";                                // what Stripe says now: a chargeback
    const w = await webhook(ev);
    later(10); await hourly();
    vuln(w.status !== 200 || sent(c) !== 0 || row(c).chargeback_status !== "open",
      `M12c [${name}] the inquiry's first notice came after the bank made it a chargeback -> ${w.status}; the Order's chargeback ${row(c).chargeback_status || "none"}; after the hourly run the freelancer has ${sent(c)} (must be open, 0)`);
  });
  await guard(`M17b [${name}]`, async () => {
    DB.messages.length = 0;
    ready(true); const c = mkX(); await fund2(c); disputed(c);
    DB.order_events.push({ id: uuid(), order_id: c.id, actor: users.cl.id, event: "disputed", data: {} });
    arm("lost", (u, init) => u.includes("/rest/v1/order_events") && init.method === "POST" && /"event":"decision"/.test(bodyOf(init)));
    const r1 = await resolve(c, "release", { note: "Release: the work was delivered as agreed." });
    const r2 = await resolve(c, "refund", { note: "Refund: the files were never delivered." });
    for (let i = 0; i < 2; i++) { later(60); await hourly(); }
    const flags = DB.user_flags.filter(f => f.contract_id === c.id && f.kind === "dispute_lost").map(f => f.user_id === users.cl.id ? "client" : "freelancer");
    const chat = DB.messages.filter(m => m.kind === "text" && String(m.body).startsWith("Cuvori decision:")).map(m => m.body.slice(17, 24));
    vuln(r1.status !== 503 || r2.status !== 200 || flags.join() !== "freelancer" || chat.join() !== "Refund:",
      `M17b [${name}] 'release' saved with its answer lost (${r1.status}), replaced by 'refund' (${r2.status}); after the hourly runs: "lost a dispute" marks [${flags}], decision messages [${chat.join(" | ")}] (must be: the freelancer only; the 'refund' only)`);
    DB.messages.length = 0;
  });
  await guard(`M17c [${name}]`, async () => {
    DB.messages.length = 0;
    const a = mkX(), b = mkX(); await fund2(a); await fund2(b); disputed(a); disputed(b);
    for (const c of [a, b]) DB.order_events.push({ id: uuid(), order_id: c.id, actor: users.cl.id, event: "disputed", data: {} });
    let outage = true;
    hooks.db = async (method, table, search, body) => (outage && method === "POST" && table === "messages" && String(body).includes("Cuvori decision:") ? dbError() : null);
    await resolve(b, "refund"); outage = false; hooks.db = null;
    later(5); await resolve(a, "refund");
    for (let i = 0; i < 2; i++) { later(60); await hourly(); }
    const msgs = DB.messages.filter(m => m.kind === "text" && m.body === "Cuvori decision: " + NOTE).length;
    vuln(msgs !== 2, `M17c [${name}] Order B's decision message refused, then Order A of the same two people decided with the same words; after the hourly runs: decision messages ${msgs} (must be 2, one per decision)`);
    DB.messages.length = 0;
  });
  await guard(`M21d [${name}]`, async () => {
    const c = mkX(); const f = await fund2(c); const pi = f.session.payment_intent;
    await cancel(c);
    const ours = STRIPE.refunds.find(x => x.payment_intent === pi && x.metadata.contract_id === c.id && !x.metadata.kind);
    const ev = refundFails(ours);
    arm("lost", (u, init) => u.includes("/rest/v1/money_keys") && init.method === "POST" && bodyOf(init).includes(`"scope":"refund_back:${ours.id}"`));
    const w1 = await webhook(ev);
    const w2 = await webhook(failedEvent(ours));
    vuln(row(c).refunded_cents !== 0 || held(c) !== 10000 || !notes(c).some(n => n.startsWith(`refund ${ours.id} `)),
      `M21d [${name}] a failed refund's "counted back" key saved with its answer lost (${w1.status}); the notice again (${w2.status}): ${show(c)}; its note ${notes(c).some(n => n.startsWith(`refund ${ours.id} `)) ? "there" : "MISSING"} (must be 0 given back, 10000 held, the note there)`);
  });
  await guard(`M21e [${name}]`, async () => {
    ready(true); const c = mkX(); const f = await fund2(c); const pi = f.session.payment_intent; row(c).status = "funded";
    const [m1] = ms(c, [7000, 3000]); await approve(c, m1.id);
    const r1 = dashRefund(pi, 5000); await webhook(refundedEvent(pi));
    await webhook(refundFails(r1));
    dashRefund(pi, 5000); const w3 = await webhook(refundedEvent(pi));
    vuln(w3.status !== 200 || row(c).refunded_cents !== 3000 || held(c) !== 0,
      `M21e [${name}] part 1 (70.00) paid out; a 50.00 dashboard refund (20.00 of it already paid out), failed, made again -> ${w3.status}: ${show(c)} (must be 3000 given back, nothing held)`);
  });
}

// ---------- M20 the Order screen's amounts ----------
{
  const lineOf = (re) => page.split("\n").find(l => re.test(l)) || "";
  let oMoney = null;
  try { oMoney = new Function("escapeHtml", [lineOf(/^\s*function money\(n,cur\)/), lineOf(/^\s*const oMoney=/), lineOf(/^\s*const oMoney2=/)].join("\n") + "\nreturn oMoney;")(x => x); } catch {}
  const got = oMoney ? [oMoney(9990), oMoney(10000), oMoney(5), oMoney(123456, "EUR")] : [];
  vuln(!oMoney || got.join("|") !== "€99.90|€100|€0.05|€1,234.56",
    `M20 the Order screen's amounts: 99.90, 100, 0.05, 1234.56 -> ${got.join(", ") || "not found"} (must be €99.90, €100, €0.05, €1,234.56)`);
}

console.error = realError;
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
