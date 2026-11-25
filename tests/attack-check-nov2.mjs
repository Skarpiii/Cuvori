// Check of 2 November: regression checks for the payment problems the review of 2 November proved (its group A, items 1
// to 3, and B9, which has the same cause as A1). Both price plans where both are affected.
// K1 a part of an Order paid out; the client's chargeback on the payment pulled it back from the freelancer; the bank
//    decided for Cuvori. Then the freelancer gives the rest back (K1a), or Cuvori decides 'refund' (K1b) or a 50/50
//    'split' (K1c): the client got back the freelancer's pulled-back money for the part they had approved (97.00 or 100.00
//    instead of 40.00), and the freelancer ended with nothing for it.
// K1d the same, but the freelancer's Stripe account was not ready when the bank decided, so the re-payment could not be
//    made then; they give the rest back: the client gets only the rest, and the freelancer is paid back once ready.
// K2 Cuvori's 'release' decided before the chargeback, its payout waiting for the freelancer's Stripe account; the
//    chargeback pulled part 1 back and was won; the hourly run finished the decision: the freelancer got only the decision's
//    amount (99.75 instead of 190.00 at the new prices), and 95.00 stayed with Cuvori on a completed Order.
// K3 a chargeback won while the Order still holds money, and a second chargeback (on the price increase) noted meanwhile
//    and decided for the client: the Order froze for good (no approval, decision or cancel, nothing the admin could clear,
//    the second chargeback never recorded).
// K4 50 old payments whose card-fee surplus can never go back (their chargebacks were lost, Stripe refuses every refund on
//    them): a newer client's surplus was never sent back (the hourly run only ever took the 50 oldest, and the time limit
//    fewer). K4b: the stuck ones are still tried again later, less often.
// K5 20 late payments whose refund can never go through (Stripe's fee on them is never known): a later client's late
//    payment, whose first refund attempt failed, was never refunded by the hourly run.
// The second round (the check of 2 November, evening, on the fixes above):
// K6 two chargebacks on two payments of one Order, both decided for Cuvori: the second one's pull-back took the first one's
//    re-payment (the newest transfer), and that re-payment then read as "still owed": a cancel or 'refund' gave the client
//    10.00 of the 15.00 held, 'release' paid the freelancer 5.00 too much, and (K6b) with 1.00 held the admin could decide
//    nothing ("not holding money"); (K6c) with funds segregation on, the money stayed held apart at Stripe for ever.
// K7 the "card fee not settled" note told the owner to refund by hand in the Stripe dashboard, which Cuvori then counted as
//    Order money (the Order went into dispute) and refunded a second time once Stripe's fee was known.
// K8 a late first payment refunded less the card fee whose refund then failed at Stripe (K8a), or whose note the admin
//    marked as handled (K8b): the check against charging twice took it for "a payment still being recorded" and released
//    every new card hold for 10 days, so the client could not pay the Order.
// K9 the hourly run's card-fee loop at today's prices asked Stripe for its Fees report list once per payment (the new
//    prices' loop asked once per run): 40 payments waiting took the run to its 25-second limit and the sweep never ran.
// K10 an Order in parts closed because a chargeback took the money for its parts left: no resolution was recorded, and a
//    part's "Money step stopped" note stayed on the closed Order.
// K11 the freelancer's cancel confirmation asked for its amount (preview) only for the Order's current chargeback, not
//    after an earlier won one; and each preview spent one of their 10 cancel tries a minute.
// K12 the top-up line repair read "any 20" noted Orders, like the lists fixed in the morning.
// Run: node tests/attack-check-nov2.mjs  (TARGET=<folder> runs it against another copy of the payment code)
import { DB, DBQ, STRIPE, V56, users, hooks, req, call, mk, reset, fns, pay, signed, uuid, fund } from "./fn-harness.mjs";
import { checkLines, reconcile, listed } from "./plan2-ledger.mjs";
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const realError = console.error; console.error = () => {};
const guard = async (name, fn) => { try { await fn(); } catch (e) { out.push(`VULNERABLE ${name} threw: ${e && e.stack ? e.stack.split("\n").slice(0, 2).join(" ") : e}`); } finally { reset(); } };
const fx = await fns();
V56.on = true;                                                        // the fake database keeps v56's rules
STRIPE.balance = 50_000_000_000;                                      // other clients' money in the platform balance
// time moves on when the test says so (hours between hourly runs), and a wait inside the code passes at once
const RealDate = Date; let skew = 0;
globalThis.Date = class extends RealDate { constructor(...a) { if (a.length === 0) super(RealDate.now() + skew); else super(...a); } static now() { return RealDate.now() + skew; } };
const later = (min) => { skew += min * 60e3; };
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(() => { if (Number(ms) > 0) skew += Number(ms); fn(...args); }, 0);
const DAY = 1440;
const chargeOf = (pi) => STRIPE.charges[STRIPE.intents[pi].latest_charge];
const webhook = (ev) => call(fx.webhook, req("POST", "x", ev));
const hourly = () => call(fx.autoRelease, req("POST", "x", {}));
const NOTE = "Cuvori looked at the chat and the files.";
const checkout = (c) => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
const approve = (c, milestone_id) => call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, ...(milestone_id ? { milestone_id } : {}) } }));
const cancel = (c) => call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id } }));
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
const ms = (c, amounts, status = "submitted") => { c.has_milestones = true; return amounts.map((a, i) => { const m = { id: uuid(), order_id: c.id, title: "part " + (i + 1), amount_cents: a, status, position: i + 1 }; DB.order_milestones.push(m); return m; }); };
const ledger = (c) => { const x = row(c); return [...checkLines(DB, [c.id]), ...reconcile(DB, STRIPE, x), ...listed(DB, x)]; };
const report = (p) => p.length ? " — " + p.slice(0, 3).join(" | ") : "";
async function fund2(c) { const r = await checkout(c); if (r.status !== 200) return { checkout: r }; const s = pay(c.stripe_checkout_id); return { checkout: r, session: s, webhook: await webhook(completed(s)) }; }
async function topUp(c, cents) { c.amount_cents += cents; const r = await checkout(c); if (r.status !== 200) return { checkout: r }; const s = pay(c.stripe_checkout_id); return { checkout: r, session: s, webhook: await webhook(completed(s)) }; }
// the freelancer's Stripe account ready to receive money, or not (yet)
const ready = (yes) => { STRIPE.accounts.acct_1EditorAAAAAAAA.payouts_enabled = yes; DB.payout_details.find(p => p.id === users.ed.id).stripe_payouts_enabled = yes; };
const PLANS = [["plan 2", mk2, 2], ["plan 1", mk1, 1]];

// ---------- K1 a chargeback won while the Order still holds money, then a cancel, a refund or a split ----------
async function wonThen(mkX, how, notReadyAtWin = false) {
  const c = mkX(); const f = await fund2(c); c.status = "funded";
  const ch = chargeOf(f.session.payment_intent);
  const [m1] = ms(c, [6000, 4000]);
  const a = await approve(c, m1.id);
  const paid1 = sent(c);
  await dispute(c, ch, "needs_response");
  const pulled = lines(c, "reversal").reduce((s, l) => s + l.amount_cents, 0);
  if (notReadyAtWin) ready(false);
  const w = await dispute(c, ch, "won");
  ch.sourced = 0;      // (the fake Stripe kept counting the pulled-back payout against its payment; real Stripe does not)
  const r = how === "cancel" ? await cancel(c) : how === "refund" ? await resolve(c, "refund") : await resolve(c, "split", { editor_percent: 50 });
  if (notReadyAtWin) ready(true);
  later(2 * 60); await hourly(); later(DAY); await hourly();
  return { c, a, w, r, paid1, pulled, freelancer: sent(c), client: back(c), held: held(c), x: row(c) };
}
for (const [name, mkX, plan] of PLANS) {
  // what each side must end with: the freelancer keeps part 1 (60.00, less the 5% at the new prices), the client gets the
  // rest back (40.00), or half of it in a 50/50 split (the freelancer's half less its 5%)
  const part1 = plan === 2 ? 5700 : 6000, half = plan === 2 ? 1900 : 2000;
  for (const [k, how, freelancer, client] of [["K1a", "cancel", part1, 4000], ["K1b", "refund", part1, 4000], ["K1c", "split", part1 + half, 2000]]) {
    await guard(`${k} [${name}]`, async () => {
      const t = await wonThen(mkX, how);
      const p = plan === 2 ? ledger(t.c) : [];
      vuln(t.a.status !== 200 || t.pulled !== part1 || t.w.status !== 200 || t.r.status !== 200 || t.freelancer !== freelancer || t.client !== client || t.held !== 0 || p.length,
        `${k} [${name}] part 1 paid (${t.paid1}), pulled back ${t.pulled} by the chargeback, won (${t.w.status}); then ${how} -> ${t.r.status}: the freelancer has ${t.freelancer}, the client got back ${t.client}, held ${t.held}, ${t.x.status} (must be ${freelancer}, ${client}, 0)${report(p)}`);
    });
  }
  await guard(`K1d [${name}]`, async () => {
    const t = await wonThen(mkX, "cancel", true);
    const p = plan === 2 ? ledger(t.c) : [];
    vuln(t.r.status !== 200 || t.freelancer !== part1 || t.client !== 4000 || t.held !== 0 || /^chargeback won/.test(t.x.money_error || "") || p.length,
      `K1d [${name}] the same, the freelancer's account not ready when the bank decided; they give the rest back (${t.r.status}), then their account is ready: the freelancer has ${t.freelancer}, the client got back ${t.client}, held ${t.held}, note ${JSON.stringify(t.x.money_error)} (must be ${part1}, 4000, 0, no re-payment note)${report(p)}`);
  });
}

// K1e the freelancer's confirmation shows what really goes back: while the re-payment is still owed (their Stripe account
// not ready), the page asks first (preview) and gets the rest only; asking changes nothing. The page asks it after a won
// chargeback, and only then.
for (const [name, mkX, plan] of PLANS) {
  await guard(`K1e [${name}]`, async () => {
    const c = mkX(); const f = await fund2(c); c.status = "funded";
    const ch = chargeOf(f.session.payment_intent);
    const [m1] = ms(c, [6000, 4000]);
    await approve(c, m1.id);
    await dispute(c, ch, "needs_response");
    ready(false);
    await dispute(c, ch, "won");
    const before = JSON.stringify(row(c)), refunds0 = back(c);
    const p = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id, preview: true } }));
    const after = JSON.stringify(row(c));
    ready(true);
    vuln(p.status !== 200 || !p.json || p.json.refund_cents !== 4000 || held(c) !== (plan === 2 ? 9700 : 10000) || before !== after || back(c) !== refunds0,
      `K1e [${name}] the re-payment still owed (account not ready), held ${held(c)}: the confirmation's question -> ${p.status} ${JSON.stringify(p.json)}; the Order unchanged ${before === after}, refunds ${back(c) - refunds0} (must be 200 with refund_cents 4000, unchanged, none)`);
  });
}
{
  const fs = await import("node:fs");
  const page = fs.readFileSync(new URL((process.env.TARGET ? "file://" + process.env.TARGET + "/" : "../") + "index.html", import.meta.url), "utf8");
  const btn = (page.split("\n").find(l => l.includes('act("cancelRefund"')) || "");
  vuln(!/o\.chargeback_id/.test(btn) || !/fnCall\("stripe-cancel",\{ contract_id:o\.id, preview:true \}\)/.test(btn) || !/amt:oMoney\(amt,cur\)/.test(btn),
    `K1e the page's "give the Order back" confirmation asks for the amount after a won chargeback and shows it (${btn.length ? "button found" : "button not found"})`);
}

// ---------- K2 Cuvori's decision made before the chargeback, finished after it was won ----------
for (const [name, mkX, plan] of PLANS) {
  await guard(`K2 [${name}]`, async () => {
    const c = mkX({ amount_cents: 20000, price: 200 }); const f = await fund2(c); c.status = "funded";
    const ch = chargeOf(f.session.payment_intent);
    const [m1] = ms(c, [10000, 10000]);
    await approve(c, m1.id);
    c.status = "disputed"; c.dispute_by = users.cl.id; c.disputed_at = new Date().toISOString();
    ready(false);
    const r = await resolve(c, "release");                              // waits: the freelancer's account is not ready
    await dispute(c, ch, "needs_response");
    const pulled = lines(c, "reversal").reduce((s, l) => s + l.amount_cents, 0);
    await dispute(c, ch, "won");
    ready(true);
    later(20); await hourly(); later(DAY); await hourly(); later(DAY); await hourly();
    const x = row(c), must = plan === 2 ? 19000 : 20000;
    const p = plan === 2 ? ledger(c) : [];
    vuln(r.status !== 409 || pulled !== must / 2 || sent(c) !== must || back(c) !== 0 || held(c) !== 0 || x.status !== "completed" || (plan === 2 && x.commission_cents !== 1000) || p.length,
      `K2 [${name}] part 1 paid, 'release' of the rest decided (${r.status}: the account not ready), the chargeback pulled back ${pulled} and was won; after the hourly runs the freelancer has ${sent(c)}, the client got back ${back(c)}, held ${held(c)}, ${x.status}, commission ${x.commission_cents} (must be ${must}, 0, 0, completed${plan === 2 ? ", 1000" : ""})${report(p)}`);
  });
}

// ---------- K3 a chargeback won while money is held, and a second one noted meanwhile and lost ----------
for (const [name, mkX, plan] of PLANS) {
  await guard(`K3 [${name}]`, async () => {
    const c = mkX(); const f = await fund2(c); c.status = "funded";
    const ch = chargeOf(f.session.payment_intent);
    const u = await topUp(c, 2000); const ch2 = chargeOf(u.session.payment_intent);
    const [m1] = ms(c, [6000, 6000]);
    await approve(c, m1.id);
    await dispute(c, ch, "needs_response");
    await dispute(c, ch2, "needs_response");                            // noted: the first is still open
    const w1 = await dispute(c, ch, "won");
    const w2 = await dispute(c, ch2, "lost");
    later(2 * 60); await hourly();
    const mid = row(c);
    const frozen = mid.chargeback_status === "open" || /also (open )?on payment/.test(mid.money_error || "");
    // what is left (the bank took the price increase back) is divided by Cuvori: the second part can't be paid in full
    const r = await resolve(c, "release");
    later(2 * 60); await hourly();
    const x = row(c), cbLines = lines(c, "chargeback").length;
    const must = plan === 2 ? 9500 : 10000;                           // part 1 (60.00) and what was left (40.00), less the 5%
    const p = plan === 2 ? ledger(c) : [];
    vuln(w1.status !== 200 || w2.status !== 200 || frozen || mid.chargeback_id !== "dp_" + ch2.id || mid.chargeback_status !== "lost" || r.status !== 200 || x.status !== "completed" || held(c) !== 0 || sent(c) !== must || (plan === 2 && cbLines !== 1) || p.length,
      `K3 [${name}] first chargeback won (${w1.status}), the second (noted meanwhile) lost (${w2.status}): the Order ${frozen ? "FROZEN" : "goes on"}, its chargeback ${mid.chargeback_id === "dp_" + ch2.id ? "the second" : mid.chargeback_id} ${mid.chargeback_status}, note ${JSON.stringify(mid.money_error)}; Cuvori's 'release' of the rest -> ${r.status}; ${x.status}, held ${held(c)}, the freelancer has ${sent(c)}, chargeback lines ${cbLines} (must be: goes on, the second lost, 200, completed, 0, ${must}${plan === 2 ? ", 1" : ""})${report(p)}`);
  });
}

// ---------- K4 the card-fee surplus of newer payments behind payments that can never settle ----------
// Stripe answering in 0.3 s and the database in 0.04 s, on the clock the hourly run keeps its 30-second limit by
let slow = 0;
const realNow = performance.now.bind(performance);
Object.defineProperty(performance, "now", { value: () => realNow() + slow, configurable: true, writable: true });
const innerFetch = globalThis.fetch;
let slowOn = true;                                                    // (off for checks that need a whole hourly run with many Orders in the fake database)
globalThis.fetch = async (url, init = {}) => { const s = String(url); if (slowOn) { if (s.includes("api.stripe.com")) slow += 300; else if (s.includes("/rest/v1/")) slow += 40; } return innerFetch(url, init); };
const nowS = () => Math.floor(Date.now() / 1000);
await guard("K4", async () => {
  DBQ.paging = true;                                                  // like the real database: order and limit apply
  const fundRow = (c, pi) => DB.order_payments.find(p => p.order_id === c.id && p.kind === "fund" && p.provider_ref === pi);
  const age = (pi, r, days) => { const ch = chargeOf(pi); ch.created = Math.round(nowS() - days * 86400); for (const x of STRIPE.feeRows) if (x.incurred_by === ch.id) x.created = ch.created; if (r) r.created_at = new Date(Date.now() - days * 86400e3).toISOString(); };
  const stuck = [];
  for (let i = 0; i < 50; i++) {
    const c = mk1({ amount_cents: 10000 }); const f = await fund(fx, c, { standalone: true, fee: 175 });
    const pi = f.session.payment_intent; age(pi, fundRow(c, pi), 10 + i / 1000);
    const ch = chargeOf(pi); STRIPE.disputes[ch.id] = { status: "lost", amount: ch.amount };     // charged back: no refund possible
    c.status = "refunded"; stuck.push(pi);
  }
  const c = mk1({ amount_cents: 10000 }); const f = await fund(fx, c, { standalone: true, fee: 175 });
  const pi = f.session.payment_intent, r = fundRow(c, pi); age(pi, r, 5);
  STRIPE.reports.end = nowS() - 3600; STRIPE.reports.instant = true;
  const feeBack = (x) => STRIPE.refunds.filter(y => y.payment_intent === x && y.metadata.kind === "fee_surplus").reduce((a, y) => a + y.amount, 0);
  let run = 0;
  for (; run < 6 && !feeBack(pi); run++) { later(60); await hourly(); }
  const owed = f.session.amount_total - 10000 - Number(f.session.metadata.connect_cents || 0) - 175;
  vuln(feeBack(pi) !== owed || r.fee_refund_cents !== owed,
    `K4 50 older payments whose surplus can never go back, then a newer client's payment: its surplus (${owed}) sent back ${feeBack(pi)} after ${run} hourly run(s), on its line ${r.fee_refund_cents} (must be ${owed} within 6 runs)`);
  // K4b the stuck ones are tried again later, not dropped (they wait longer each time)
  const triedAgain = new Set();
  hooks.stripe = async (p, m, body) => { if (m === "POST" && p === "/refunds") { const x = String(body && body.get ? body.get("payment_intent") : ""); if (stuck.includes(x)) triedAgain.add(x); } return null; };
  for (let i = 0; i < 4; i++) { later(DAY / 2); await hourly(); }
  hooks.stripe = null;
  vuln(triedAgain.size === 0,
    `K4b the stuck payments are tried again later (${triedAgain.size} of 50 tried in the next two days; must be more than 0)`);
  DBQ.paging = false;
});

// ---------- K5 a later client's late payment behind 20 late payments whose refund can never go through ----------
await guard("K5", async () => {
  DBQ.paging = true;
  async function late(opts, failRefundOnce = false) {
    const c = mk1({ amount_cents: 10000 }); await checkout(c); const s = pay(c.stripe_checkout_id, opts);
    let refundFailed = false;
    hooks.stripe = async (p, m) => {
      if (m === "POST" && /\/capture$/.test(p)) c.status = "cancelled";               // cancelled in the very instant: a late payment
      if (failRefundOnce && !refundFailed && m === "POST" && p === "/refunds") { refundFailed = true; return [500, { error: { type: "api_error", message: "An unknown error occurred" } }]; }
      return null;
    };
    const w = await webhook(completed(s)); hooks.stripe = null;
    return { c, s, w };
  }
  for (let i = 0; i < 20; i++) {
    const { s } = await late({ standalone: true, fee: 175 });
    const ch = chargeOf(s.payment_intent); ch.created = nowS() - 5 * 86400;
    STRIPE.feeRows = STRIPE.feeRows.filter(r => r.incurred_by !== ch.id);            // Stripe's Fees report never lists its fee
  }
  STRIPE.reports.end = nowS() - 3600; STRIPE.reports.instant = true;
  const L = await late({ standalone: false, fee: 184 }, true);
  const got = () => STRIPE.refunds.filter(r => r.payment_intent === L.s.payment_intent).reduce((a, r) => a + r.amount, 0);
  let run = 0;
  for (; run < 6 && !got(); run++) { later(60); await hourly(); }
  vuln(got() !== L.s.amount_total - 184,
    `K5 20 late payments whose refund can never go through, then a later client's late payment whose first refund failed (${L.w.status}): sent back ${got()} after ${run} hourly run(s) (must be ${L.s.amount_total - 184} within 6 runs)`);
  DBQ.paging = false;
});


// ---------- K6 two chargebacks on two payments, both won ----------
// Order 20.00 (P1) + 20.00 top-up (P2), parts 25.00 + 15.00; part 1 paid out. Chargeback A on P2 (20.00): the 15.00 held covers
// only part of it, 5.00 is pulled back from part 1; won → paid back. Chargeback B on P1 (20.00): 5.00 pulled back again, from
// the newest transfer, which is A's re-payment; won → paid back. Nobody is owed anything: the freelancer has part 1, the Order
// holds 15.00 for part 2.
async function twoWon(mkX, { parts = [2500, 1500], topups = [2000], price = 2000 } = {}) {
  const c = mkX({ amount_cents: price, price: price / 100 }); const f = await fund2(c); c.status = "funded";
  const ch1 = chargeOf(f.session.payment_intent);
  const u = await topUp(c, topups[0]); const ch2 = chargeOf(u.session.payment_intent);
  for (const t of topups.slice(1)) await topUp(c, t);
  const m = ms(c, parts);
  await approve(c, m[0].id);
  if (parts.length > 2) await approve(c, m[1].id);
  await dispute(c, ch2, "needs_response"); const wA = await dispute(c, ch2, "won");
  await dispute(c, ch1, "needs_response"); const wB = await dispute(c, ch1, "won");
  return { c, m, wA, wB, ch1, ch2 };
}
for (const [name, mkX, plan] of PLANS) {
  const part1 = plan === 2 ? 2375 : 2500;
  for (const how of ["cancel", "refund", "release", "split"]) {
    await guard(`K6 ${how} [${name}]`, async () => {
      const t = await twoWon(mkX);
      const before = { sent: sent(t.c), held: held(t.c), note: row(t.c).money_error };
      let r;
      if (how === "cancel") r = await cancel(t.c);
      else { t.c.status = "disputed"; t.c.dispute_by = users.cl.id; t.c.disputed_at = new Date().toISOString(); r = await resolve(t.c, how, how === "split" ? { editor_percent: 50 } : {}); }
      later(2 * 60); await hourly(); later(DAY); await hourly();
      const x = row(t.c), p = plan === 2 ? ledger(t.c) : [];
      // what each side must end with: the client the 15.00 for part 2 (or half, or none), the freelancer part 1 plus their share less 5%
      const share = how === "release" ? 1500 : how === "split" ? 750 : 0, client = 1500 - share;
      const freelancer = part1 + (plan === 2 ? share - Math.round(share * 0.05) : share);
      vuln(t.wA.status !== 200 || t.wB.status !== 200 || before.sent !== part1 || before.held !== 1500 || before.note !== null || r.status !== 200 || sent(t.c) !== freelancer || back(t.c) !== client || held(t.c) !== 0 || p.length,
        `K6 ${how} [${name}] both chargebacks won: freelancer ${before.sent}, held ${before.held}, note ${JSON.stringify(before.note)} (must be ${part1}, 1500, null); then ${how} -> ${r.status}: freelancer ${sent(t.c)}, client got back ${back(t.c)}, held ${held(t.c)}, ${x.status} (must be ${freelancer}, ${client}, 0)${report(p)}`);
    });
  }
  await guard(`K6b [${name}]`, async () => {
    // 100.00 + 50.00 + 10.00 paid in, parts 100/50/10, two paid out, 10.00 held for the third: the same two chargebacks (A on
    // the 50.00 top-up pulls more than is held, from part 2; B on the first payment pulls from A's re-payment); then the
    // admin must still be able to decide the 10.00
    const t = await twoWon(mkX, { parts: [10000, 5000, 1000], topups: [5000, 1000], price: 10000 });
    t.c.status = "disputed"; t.c.dispute_by = users.cl.id; t.c.disputed_at = new Date().toISOString();
    const r = await resolve(t.c, "refund");
    later(2 * 60); await hourly();
    vuln(r.status !== 200 || back(t.c) !== 1000 || held(t.c) !== 0,
      `K6b [${name}] three parts, 10.00 held for the third after both chargebacks were won: admin 'refund' -> ${r.status} ${JSON.stringify(r.json && r.json.error)}; client got back ${back(t.c)}, held ${held(t.c)} (must be 200, 1000, 0)`);
  });
}
await guard("K6c (funds segregation on)", async () => {
  const { fsReset } = await import("./fn-harness.mjs");
  process.env.STRIPE_FUNDS_SEGREGATION = "on"; fsReset(); slowOn = false;
  try {
    const t = await twoWon(mk2);
    const r = await cancel(t.c);
    later(2 * 60); await hourly(); later(DAY); await hourly(); later(DAY); await hourly();
    const heldApart = Object.values(STRIPE.charges).filter(ch => ch.payment_intent === t.ch1.payment_intent || ch.payment_intent === t.ch2.payment_intent).reduce((a, ch) => a + ((ch.allocated_funds && ch.allocated_funds.balance && (ch.allocated_funds.balance.available + ch.allocated_funds.balance.pending)) || 0), 0);
    const marked = DB.money_keys.some(k => k.scope === "fs:" + t.c.id);
    vuln(r.status !== 200 || back(t.c) !== 1500 || heldApart !== 0 || marked,
      `K6c funds segregation on, both chargebacks won, then cancel -> ${r.status}: client got back ${back(t.c)}, still held apart at Stripe ${heldApart}, Order still marked ${marked} (must be 200, 1500, 0, false)`);
  } finally { delete process.env.STRIPE_FUNDS_SEGREGATION; STRIPE.fs = null; slowOn = true; }
});

// ---------- K7 the "card fee not settled" note must not send the owner to the Stripe dashboard ----------
await guard("K7", async () => {
  DBQ.paging = true;
  const c = mk1({ amount_cents: 10000 }); const f = await fund(fx, c, { standalone: true, fee: 175 });
  const pi = f.session.payment_intent, ch = chargeOf(pi);
  STRIPE.feeRows = STRIPE.feeRows.filter(x => x.incurred_by !== ch.id);          // Stripe's report never lists its fee
  later(5 * DAY); STRIPE.reports.end = nowS() - 3600; STRIPE.reports.instant = true;
  for (let i = 0; i < 3; i++) { later(60); await hourly(); }
  const note = String(row(c).money_error || "");
  vuln(!/card fee of payment/.test(note) || /by hand|dashboard/i.test(note) || !/ask for help|help/i.test(note),
    `K7 the note after 4 days: ${JSON.stringify(note.slice(0, 220))} (must name the payment, never say "by hand" or "dashboard", and say to ask for help)`);
  DBQ.paging = false;
});

// ---------- K8 a late first payment never blocks the Order's real first payment ----------
for (const variant of ["refund failed at Stripe", "note marked as handled"]) {
  await guard(`K8 [${variant}]`, async () => {
    const c = mk1({ amount_cents: 10000 });
    await checkout(c); const s1 = pay(c.stripe_checkout_id, { fee: 184 });
    // the price changes in the very instant the card is charged: a late payment, sent back less the card fee
    hooks.stripe = async (path, method) => { if (method === "POST" && path === `/payment_intents/${s1.payment_intent}/capture`) Object.assign(c, { amount_cents: 12000, price: 120 }); return null; };
    const w1 = await webhook(completed(s1)); hooks.stripe = null;
    const ch1 = chargeOf(s1.payment_intent);
    const late = STRIPE.refunds.find(r => r.payment_intent === s1.payment_intent && r.metadata.kind === "late_payment");
    if (variant === "refund failed at Stripe") {
      late.status = "failed"; ch1.amount_refunded -= late.amount;                    // the card was closed: Stripe takes the refund off the charge
      await webhook(signed({ type: "charge.refund.updated", data: { object: { ...late, object: "refund", status: "failed", failure_reason: "expired_or_canceled_card", currency: "eur" } } }));
    } else {
      STRIPE.refunds.splice(STRIPE.refunds.indexOf(late), 1); ch1.amount_refunded = 0;   // Stripe refused the refund; the admin marked the note as handled
      DB.money_keys = DB.money_keys.filter(k => k.scope !== "late_refund:" + s1.payment_intent);
    }
    const a = await checkout(c); const s2 = pay(c.stripe_checkout_id, { fee: 200 });
    const w2 = await webhook(completed(s2));
    const x = row(c);
    vuln(w1.status !== 200 || !late || a.status !== 200 || w2.status !== 200 || STRIPE.intents[s2.payment_intent].status !== "succeeded" || x.status !== "funded" || x.funded_cents !== 12000,
      `K8 [${variant}] late first payment ${w1.status} (refund ${late ? late.amount : "none"}); the real first payment: page ${a.status}, webhook ${w2.status}, hold ${STRIPE.intents[s2.payment_intent].status}; Order ${x.status}, funded ${x.funded_cents} (must be charged and recorded: succeeded, funded, 12000)`);
  });
}

// ---------- K9 the card-fee loop at today's prices asks Stripe for its report list once per run ----------
await guard("K9", async () => {
  DBQ.paging = true;
  for (let i = 0; i < 40; i++) {
    const c = mk1({ amount_cents: 10000 }); const f = await fund(fx, c, { standalone: true, fee: 175 });
    const pi = f.session.payment_intent, r = DB.order_payments.find(p => p.order_id === c.id && p.kind === "fund" && p.provider_ref === pi);
    chargeOf(pi).created = nowS() - 2 * 86400; r.created_at = new Date(Date.now() - 2 * 86400e3).toISOString();
    for (const x of STRIPE.feeRows) if (x.incurred_by === chargeOf(pi).id) x.created = chargeOf(pi).created;
  }
  STRIPE.reports.end = nowS();                                                    // the report's data reaches them; the run asked for waits
  const inner = globalThis.fetch; let types = 0;
  // (only this loop's own calls are timed: the fake database holds every Order of the checks above, so a whole run's other
  // steps would swamp it; in a process of its own the run falls from 25.2 s to 15.5 s)
  let runs = 0;
  globalThis.fetch = async (url, init = {}) => { const s = String(url); if (s.includes("/reporting/report_types")) types++; if (s.includes("/reporting/report_runs") && (init.method || "GET") === "GET") runs++; return inner(url, init); };
  const h = await hourly();
  globalThis.fetch = inner;
  vuln(h.status !== 200 || types > 2 || runs > 2,
    `K9 40 payments at today's prices waiting for Stripe's fee: one hourly run asked for the report list ${types} time(s) and the report runs ${runs} time(s) (must be at most 2 each, once per fee loop)`);
  DBQ.paging = false;
});

// ---------- K10 an Order closed because a chargeback took its parts' money: a resolution, no stale step note ----------
for (const [name, mkX, plan] of PLANS) {
  await guard(`K10 [${name}]`, async () => {
    const c = mkX(); const f = await fund2(c); c.status = "funded";
    const ch = chargeOf(f.session.payment_intent);
    const [m1, m2] = ms(c, [6000, 4000]);
    // part 2's payout stops at Stripe (settling), so its step note is on the Order
    hooks.stripe = async (path, method) => method === "POST" && path === "/transfers" ? [400, { error: { type: "invalid_request_error", code: "balance_insufficient", message: "You have insufficient funds in your Stripe account" } }] : null;
    await approve(c, m2.id); hooks.stripe = null;
    const noted = /Money step stopped \(milestone/.test(row(c).money_error || "");
    // the bank takes 40.00 of the payment: the Order goes on with 60.00; part 1's payout then leaves nothing for part 2
    await dispute(c, ch, "needs_response", { amount: 4000 }); await dispute(c, ch, "lost", { amount: 4000 });
    const mid = row(c).status;
    const a1 = await approve(c, m1.id);
    later(2 * 60); await hourly(); later(60); await hourly();
    const x = row(c);
    vuln(!noted || mid !== "funded" || a1.status !== 200 || x.status !== "completed" || x.resolution !== "chargeback" || !x.resolved_at || /Money step stopped/.test(x.money_error || ""),
      `K10 [${name}] part 2's payout stopped (noted ${noted}), the bank took 40.00 (Order ${mid}), part 1 paid (${a1.status}) and nothing is left for part 2: the Order is ${x.status}, resolution ${x.resolution}, resolved_at ${!!x.resolved_at}, note ${JSON.stringify(x.money_error)} (must be completed, chargeback, true, no step note)`);
  });
}

// ---------- K11 the cancel confirmation after an earlier won chargeback, and the preview's rate limit ----------
await guard("K11", async () => {
  const fs = await import("node:fs");
  const page = fs.readFileSync(new URL((process.env.TARGET ? "file://" + process.env.TARGET + "/" : "../") + "index.html", import.meta.url), "utf8");
  const btn = (page.split("\n").find(l => l.includes('act("cancelRefund"')) || "");
  const { LIMITS } = await import("./fn-harness.mjs");
  const c = mk2(); await fund2(c); c.status = "funded";
  LIMITS.strict = true; LIMITS.events = [];
  let refused = 0;
  for (let i = 0; i < 12; i++) { const p = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id, preview: true } })); if (p.status === 429) refused++; }
  const real = await cancel(c);
  LIMITS.strict = false; LIMITS.events = [];
  vuln(!/o\.chargeback_id/.test(btn) || /chargeback_status==="won"/.test(btn) || real.status !== 200,
    `K11 the page asks the preview for any Order with a chargeback on record (${/o\.chargeback_id/.test(btn)}, not only the current won one: ${!/chargeback_status==="won"/.test(btn)}); 12 previews (${refused} refused) then the real cancel -> ${real.status} (must be true, true, 200)`);
});

// ---------- K12 the top-up line repair's noted list is worked least-failed first, not "any 20" ----------
await guard("K12", async () => {
  DBQ.paging = true;
  const fsLib = await import("node:fs");
  const src = fsLib.readFileSync(new URL((process.env.TARGET ? "file://" + process.env.TARGET + "/" : "../") + "netlify/lib/cuvori.mjs", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("export async function repairTopupLines"), src.indexOf("export async function repairTopupLines") + 1600);
  vuln(!/retryOrder\("topupline"/.test(fn) || /&limit=20`/.test(fn),
    `K12 repairTopupLines reads its noted Orders in a fixed order and works them least-failed first (retryOrder: ${/retryOrder\("topupline"/.test(fn)}, "limit=20" gone: ${!/&limit=20`/.test(fn)})`);
  DBQ.paging = false;
});

console.error = realError;
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
