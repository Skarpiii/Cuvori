// Fixes of 2 November, funds segregation (Stripe's "allocated funds", behind STRIPE_FUNDS_SEGREGATION): regression checks
// for the defects the review of 2 November proved in money held apart at Stripe, and in the hourly run's work on Stripe's
// fees that funds segregation makes heavy. Every check runs against the fake Stripe of tests/fn-harness.mjs (fsReset: what
// Stripe's guide does not say is a setting of the fake), and the Orders against the ledger check (tests/plan2-ledger.mjs).
//   S1  a payout's answer lost after Stripe made it, and Stripe's list of transfers not showing it yet: the next try planned
//       the payout again from what the payment holds now (nothing: the payout took it) under a new key, and paid the
//       freelancer twice (19000 for a 10000 Order). S1b the same for a payout's second part. Switch off for comparison (one
//       transfer, its key named after the payout): unchanged.
//   S2  a won chargeback's re-payment made inside the settlement, then the decision's own payout stopping once: the next try
//       read the re-payment as the decision's share paid (the freelancer 9400 instead of 11400, the Order completed). S2b the
//       same at the new prices with the switch off (5700 instead of 9500). S2c the case of the review itself (a payout in
//       parts stopped, the chargeback on the first payment won before it went on): right since a2a30d9, kept as a guard.
//   S3  the hourly run's sweep and a closed Order that still owes the freelancer a won chargeback's re-payment: the money
//       was moved to Cuvori's balance (Stripe allowing it) or the note said "nobody is owed … ask Stripe support" (Stripe
//       not allowing it). S3c a closed Order whose refund failed at Stripe (it holds the client's money again): swept.
//   S4  the note "money held apart … ask Stripe support" never went once Stripe support had released the money.
//   S5  the sweep read only the 200 oldest marks: with 200 open Orders marked before it, a closed Order's money stayed held
//       apart for good.
//   S6  a payout in parts stopped part-way, then a refund in the Stripe dashboard on the second payment: "exists with a
//       different amount" every hour, the client's approval answered 500, the admin's decision "order changed". S6b a
//       milestone's payout is never paid with a smaller amount (a milestone counts as paid out only when whole).
//   S7  a payout from money held apart refused by Stripe for another reason than "not enough there yet" (the account lost
//       the preview): read as "still settling, nothing needs to be done", retried every hour for ever with no cause named.
//       S7b Stripe's answer that the payment does not hold enough yet is still "settling".
//   S8  standalone fees (what funds segregation switches the whole account to): 80 payments waiting for Stripe's fee took
//       the hourly run past Netlify's 30 seconds (3 Stripe requests each, no time check inside). S8b 60 payments whose fee
//       never comes kept a newer payment's fee from ever being recorded.
// Run: node tests/attack-fixes-nov2-fs.mjs  (TARGET=<folder> runs it against another copy of the payment code)
import { DB, DBQ, STRIPE, V56, users, hooks, req, call, mk, reset, fns, pay, signed, uuid, F, fsReset, fsDispute, fsDisputeClose } from "./fn-harness.mjs";
import { checkLines, reconcile, listed } from "./plan2-ledger.mjs";
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const logs = []; const realError = console.error; console.error = process.env.DEBUG ? realError : (...a) => logs.push(a.map(x => (x && x.stack) || String(x)).join(" "));
const fx = await fns();
const lib = await import(new URL("../lib/cuvori.mjs", "file://" + F).href);
V56.on = true;
STRIPE.balance = 50_000_000;                                           // Cuvori's own balance (other payments, its 5%)
const RealDate = Date; let skew = 0;
globalThis.Date = class extends RealDate { constructor(...a) { if (a.length === 0) super(RealDate.now() + skew); else super(...a); } static now() { return RealDate.now() + skew; } };
const later = (min) => { skew += min * 60e3; };
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(() => { if (Number(ms) > 0) skew += Number(ms); fn(...args); }, 0);
const DAY = 1440;
const ON = () => { process.env.STRIPE_FUNDS_SEGREGATION = "on"; }, OFF = () => { delete process.env.STRIPE_FUNDS_SEGREGATION; };
const chargeOf = (pi) => STRIPE.charges[STRIPE.intents[pi].latest_charge];
const heldOf = (ch) => (ch && ch.allocated_funds && ch.allocated_funds.enabled ? ch.allocated_funds.balance.available + ch.allocated_funds.balance.pending : 0);
const webhook = (ev) => call(fx.webhook, req("POST", "x", ev));
const hourly = () => call(fx.autoRelease, req("POST", "x", {}));
const checkout = (c) => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
const approve = (c, milestone_id) => call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, ...(milestone_id ? { milestone_id } : {}) } }));
const cancel = (c) => call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id } }));
const resolve = (c, decision, extra = {}) => call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision, note: "Cuvori looked at the chat and the files.", ...extra } }));
const completed = (s) => signed({ type: "checkout.session.completed", data: { object: s } });
const cbEvent = (type, ch, extra = {}) => signed({ type, data: { object: { id: "dp_" + ch.id, object: "dispute", charge: ch.id, payment_intent: ch.payment_intent, amount: extra.amount || ch.amount, currency: "eur", status: extra.status || "needs_response", reason: "fraudulent", created: Math.floor(ch.created || Date.now() / 1000) } } });
const dispute = async (ch, status, extra = {}) => {
  STRIPE.disputes[ch.id] = { ...(STRIPE.disputes[ch.id] || {}), id: "dp_" + ch.id, status, ...(extra.amount ? { amount: extra.amount } : {}) };
  return webhook(cbEvent(["won", "lost", "warning_closed"].includes(status) ? "charge.dispute.closed" : "charge.dispute.created", ch, { status, ...extra }));
};
const mk2 = (o = {}) => mk({ pricing_version: 2, commission_bps: 500, commission_cents: 0, auto_days: 14, ...o });
const row = (c) => DB.contracts.find(x => x.id === c.id) || c;
const lines = (c, kind) => DB.order_payments.filter(p => p.order_id === c.id && (!kind || p.kind === kind));
const tsOf = (c) => STRIPE.transfers.filter(t => t.metadata.contract_id === c.id);
const sent = (c) => tsOf(c).reduce((a, t) => a + (t._received ?? t.amount) - (t.amount_reversed || 0), 0);
const marked = (c) => DB.money_keys.some(k => k.scope === `fs:${c.id}`);
const evs = (c, e) => DB.order_events.filter(x => x.order_id === c.id && x.event === e);
const ms = (c, amounts) => { c.has_milestones = true; return amounts.map((a, i) => { const m = { id: uuid(), order_id: c.id, title: "part " + (i + 1), amount_cents: a, status: "submitted", position: i + 1 }; DB.order_milestones.push(m); return m; }); };
const shape = (c) => tsOf(c).map(t => `${String(t.metadata.purpose).replace(/^retransfer_.*/, "repay")}${t.metadata.part != null ? "#" + t.metadata.part : ""}:${t.amount}${t.amount_reversed ? "-" + t.amount_reversed : ""}${t.source_transaction ? "" : "(balance)"}`).join(" ");
const heldNote = (c) => String(row(c).money_error || "").includes("money held apart at Stripe");
async function fund2(c, opts = {}) {
  const r = await checkout(c);
  if (r.status !== 200) return { checkout: r };
  const s = pay(c.stripe_checkout_id, opts);
  return { checkout: r, session: s, webhook: await webhook(completed(s)) };
}
async function topUp(c, cents, opts = {}) { c.amount_cents += cents; return fund2(c, opts); }
const ready = (yes) => { STRIPE.accounts.acct_1EditorAAAAAAAA.payouts_enabled = yes; DB.payout_details.find(p => p.id === users.ed.id).stripe_payouts_enabled = yes; };
function verify(c, allow = () => false) {
  const x = row(c);
  return [...checkLines(DB, [c.id]), ...reconcile(DB, STRIPE, x), ...listed(DB, x).map(l => "the ledger check lists " + l)].filter(p => !allow(p));
}
const report = (p) => (p.length ? " PROBLEMS: " + p.slice(0, 4).join("; ") : "");
async function guard(name, fn) {
  try { await fn(); }
  catch (e) { vuln(true, `${name}: a check stopped half-way: ${e && e.message} (at ${String(e && e.stack || "").split("\n").find(x => x.includes("attack-fixes-nov2-fs")) || "?"})`); }
  finally { reset(); OFF(); STRIPE.fs = null; STRIPE.settleDelay = false; ready(true); DBQ.paging = false; }
}
// Stripe makes the transfer and keeps its key, but the answer never arrives; then Stripe's list of transfers does not show
// it for the next `reads` reads (Stripe's lists can lag behind a request that has just gone through)
function loseAnswer(which, reads = 3) {
  const fake = globalThis.fetch; let hidden = null, lag = 0, armed = true;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url), method = init.method || "GET";
    if (armed && u.hostname === "api.stripe.com" && method === "POST" && u.pathname === "/v1/transfers" && which(new URLSearchParams(init.body || ""))) {
      armed = false;
      const r = await fake(url, init), t = await r.clone().json();
      if (r.status === 200) { hidden = t.id; lag = reads; }
      throw new TypeError("fetch failed");
    }
    const r = await fake(url, init);
    if (hidden && lag > 0 && u.hostname === "api.stripe.com" && method === "GET" && u.pathname === "/v1/transfers") {
      lag--; const j = await r.json(); j.data = j.data.filter(t => t.id !== hidden);
      return new Response(JSON.stringify(j), { status: r.status, headers: { "content-type": "application/json" } });
    }
    return r;
  };
  return () => { globalThis.fetch = fake; };
}
const nowS = () => Math.floor(Date.now() / 1000);

// ---------- S8 standalone fees and the hourly run's 30 seconds (first: the time is measured on a database of its own) ----------
await guard("S8", async () => {
  ON(); fsReset();
  for (let i = 0; i < 80; i++) { const c = mk2(); await fund2(c, { standalone: true }); c.status = "funded"; }
  later(2 * DAY);                                                       // old enough for Stripe's Fees report to be asked about
  STRIPE.reports = { end: nowS(), runs: [], instant: false };           // its data reaches the payments; a run asked for stays pending
  const waitingRows = DB.order_payments.filter(p => p.kind === "fund" && p.provider_fee_cents == null).length;
  // Stripe answering in 0.3 s and the database in 0.04 s, on the clock the hourly run measures itself by
  let slow = 0; const realNow = performance.now.bind(performance), inner = globalThis.fetch, asked = {};
  Object.defineProperty(performance, "now", { value: () => realNow() + slow, configurable: true, writable: true });
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.hostname === "api.stripe.com") { slow += 300; const k = (init.method || "GET") + " " + u.pathname; asked[k] = (asked[k] || 0) + 1; } else if (u.pathname.startsWith("/rest/v1/")) slow += 40;
    return inner(url, init);
  };
  let h, spent;
  try { const t0 = performance.now(); h = await hourly(); spent = (performance.now() - t0) / 1000; }
  finally { globalThis.fetch = inner; Object.defineProperty(performance, "now", { value: realNow, configurable: true, writable: true }); }
  const types = asked["GET /v1/reporting/report_types"] || 0, runs = asked["GET /v1/reporting/report_runs"] || 0;
  vuln(h.status !== 200 || spent >= 30 || types > 1 || runs > 1,
    `S8 80 payments waiting for Stripe's fee (standalone fees, ${waitingRows} lines), Stripe answering in 0.3 s -> the hourly run ${h.status} took ${spent.toFixed(1)} s (must be under Netlify's 30), Stripe's report list asked ${types} time(s) and its runs ${runs} (must be once each), ${Object.values(asked).reduce((a, n) => a + n, 0)} Stripe requests, waiting for the next run ${h.json && h.json.waiting}`);
  for (const p of DB.order_payments) if (p.kind === "fund" && p.provider_fee_cents == null) p.provider_fee_cents = 1;   // out of the way of the checks below
});
await guard("S8b", async () => {
  OFF(); DBQ.paging = true;                                             // like the real database: a list read keeps its order and limit
  STRIPE.reports = { end: 0, runs: [], instant: true };
  const stuck = [];
  for (let i = 0; i < 60; i++) { const c = mk2(); const f = await fund2(c, { standalone: true }); c.status = "funded"; stuck.push(chargeOf(f.session.payment_intent)); }
  later(DAY / 2);
  const n = mk2(); const fn = await fund2(n, { standalone: true, fee: 187 }); n.status = "funded"; const chn = chargeOf(fn.session.payment_intent);
  later(2 * DAY);
  // the 60 older payments: 5 days old, and Stripe's Fees report never lists their fee
  for (const ch of stuck) { ch.created -= 3 * 86400; const l = DB.order_payments.find(p => p.provider_ref === ch.payment_intent); l.created_at = new Date(Date.now() - 5 * 86400e3).toISOString(); }
  STRIPE.feeRows = STRIPE.feeRows.filter(r => !stuck.some(ch => ch.id === r.incurred_by));
  STRIPE.reports.end = nowS() - 3600;
  const line = () => DB.order_payments.find(p => p.provider_ref === fn.session.payment_intent);
  let runs = 0;
  for (; runs < 3 && line().provider_fee_cents == null; runs++) { later(60); await hourly(); }
  vuln(line().provider_fee_cents !== 187,
    `S8b 60 older payments whose fee Stripe's report never lists, then a newer one (switch off, standalone fees) -> the newer one's fee ${line().provider_fee_cents} after ${runs} hourly run(s) (must be 187 within 3)`);
  for (const p of DB.order_payments) if (p.kind === "fund" && p.provider_fee_cents == null) p.provider_fee_cents = 1;
});

// ---------- S1 a payout's answer lost, Stripe's list lagging ----------
for (const on of [true, false]) await guard("S1", async () => {
  on ? ON() : OFF(); fsReset();
  const c = mk2({ amount_cents: 10000 }); const f = await fund2(c); c.status = "delivered"; const ch = chargeOf(f.session.payment_intent);
  const restore = loseAnswer(() => true);
  let a1, a2, mid;
  try {
    a1 = await approve(c); a2 = await approve(c); mid = tsOf(c).length;          // the client clicks again
    for (let i = 0; i < 3 && row(c).status !== "completed"; i++) { later(61); await hourly(); }
  } finally { restore(); }
  const p = verify(c);
  vuln(tsOf(c).length !== 1 || sent(c) !== 9500 || row(c).status !== "completed" || row(c).commission_cents !== 500 || (on && heldOf(ch) !== 0) || p.length,
    `S1 switch ${on ? "on " : "off"}: Stripe made the payout, its answer lost (${a1.status}), Stripe's list not showing it yet; the client approves again (${a2.status}: ${mid} transfer(s) then); the hourly run -> ${shape(c)}, the freelancer has ${sent(c)} (must be one payout, 9500), 5% ${row(c).commission_cents}, ${row(c).status}${report(p)}`);
});
await guard("S1b", async () => {
  ON(); fsReset();
  const c = mk2({ amount_cents: 10000 }); await fund2(c); c.status = "funded"; await topUp(c, 2000); c.status = "delivered";
  const restore = loseAnswer(b => b.get("metadata[part]") === "1");
  let a1, a2, mid;
  try {
    a1 = await approve(c); a2 = await approve(c); mid = tsOf(c).length;
    for (let i = 0; i < 3 && row(c).status !== "completed"; i++) { later(61); await hourly(); }
  } finally { restore(); }
  const p = verify(c);
  vuln(tsOf(c).length !== 2 || sent(c) !== 11400 || row(c).status !== "completed" || row(c).commission_cents !== 600 || p.length,
    `S1b a payout over two payments, Stripe made its second part but the answer was lost (${a1.status}) and the list lags; approved again (${a2.status}: ${mid} transfers then); the hourly run -> ${shape(c)}, the freelancer has ${sent(c)} (must be 2 parts, 11400), 5% ${row(c).commission_cents}, ${row(c).status}${report(p)}`);
});

// ---------- S2 a re-payment made inside the settlement is not the decision's share ----------
await guard("S2", async () => {
  ON(); fsReset();
  const c = mk2({ amount_cents: 10000 }); const f1 = await fund2(c); c.status = "funded"; const f2 = await topUp(c, 2000);
  const chA = chargeOf(f1.session.payment_intent), chB = chargeOf(f2.session.payment_intent);
  c.status = "delivered";
  const short = [400, { error: { type: "invalid_request_error", message: "The amount of this transfer exceeds the allocated funds available on the source charge" } }];
  let cutPart = 0, cutRepay = 0, cutAgain = 0, again = false;
  hooks.stripe = (path, method, p) => {
    if (method !== "POST" || path !== "/transfers") return null;
    const purpose = p.get("metadata[purpose]") || "";
    if (purpose === "release" && p.get("metadata[part]") === "1" && cutPart++ === 0) return short;                     // the second payment's money not there yet
    if (/^retransfer_/.test(purpose) && cutRepay++ === 0) return [400, { error: { type: "invalid_request_error", code: "insufficient_capabilities_for_transfer", message: "Your destination account needs to have at least one of the following capabilities enabled: transfers" } }];
    if (again && purpose === "release" && cutAgain++ === 0) return short;                                               // once more, after the re-payment went through
    return null;
  };
  const a = await approve(c);
  fsDispute(chA.id, 10000); await dispute(chA, "needs_response");
  fsDisputeClose(chA.id, true); const w = await dispute(chA, "won");
  again = true;
  later(61); const h1 = await hourly(); const mid = shape(c);
  hooks.stripe = null;
  for (let i = 0; i < 3 && row(c).status !== "completed"; i++) { later(61); await hourly(); }
  later(61); await hourly();
  const p = verify(c);
  vuln(sent(c) !== 11400 || row(c).status !== "completed" || row(c).released_cents !== 12000 || row(c).commission_cents !== 600 || evs(c, "held_apart_released").length || heldOf(chB) !== 0 || p.length,
    `S2 a payout in parts stopped (${a.status}), the chargeback on the first payment won (${w.status}) with the re-payment failing; the hourly run made the re-payment and its own payout stopped once more (${h1.status}: ${mid}) -> ${shape(c)}; the freelancer has ${sent(c)} (must be 11400), paid out ${row(c).released_cents}, 5% ${row(c).commission_cents}, moved to Cuvori's balance ${JSON.stringify(evs(c, "held_apart_released").map(e => e.data.amount_cents))} (must be none), ${row(c).status}${report(p)}`);
});
await guard("S2b", async () => {
  OFF();
  const c = mk2({ amount_cents: 10000 }); const f = await fund2(c); c.status = "funded"; const ch = chargeOf(f.session.payment_intent);
  const [m1] = ms(c, [6000, 4000]);
  const a = await approve(c, m1.id);
  c.status = "disputed"; c.disputed_at = new Date().toISOString();
  ready(false);
  const d = await resolve(c, "release");                                // the freelancer's Stripe account not ready: waits
  await dispute(ch, "needs_response"); const w = await dispute(ch, "won");
  ready(true);
  let cut = 0;
  hooks.stripe = (path, method, p) => (method === "POST" && path === "/transfers" && (p.get("metadata[purpose]") || "") === "release" && cut++ === 0 ? [400, { error: { type: "invalid_request_error", code: "balance_insufficient", message: "You have insufficient funds in your Stripe account." } }] : null);
  later(61); await hourly(); const mid = shape(c); hooks.stripe = null;
  for (let i = 0; i < 3 && row(c).status !== "completed"; i++) { later(61); await hourly(); }
  const p = verify(c);
  vuln(sent(c) !== 9500 || row(c).status !== "completed" || row(c).released_cents !== 10000 || row(c).commission_cents !== 500 || p.length,
    `S2b switch off: part 1 paid (${a.status}), Cuvori's 'release' waiting (${d.status}), the chargeback won (${w.status}); the hourly run made the re-payment, the decision's payout stopped once (${mid}) -> ${shape(c)}; the freelancer has ${sent(c)} (must be 9500), paid out ${row(c).released_cents}, 5% ${row(c).commission_cents}, ${row(c).status}${report(p)}`);
});
await guard("S2c", async () => {
  ON(); fsReset();
  const c = mk2({ amount_cents: 10000 }); const f1 = await fund2(c); c.status = "funded"; const f2 = await topUp(c, 2000);
  const chA = chargeOf(f1.session.payment_intent);
  c.status = "delivered";
  let cut = 0;
  hooks.stripe = (path, method, p) => (method === "POST" && path === "/transfers" && p.get("metadata[part]") === "1" && cut++ === 0
    ? [400, { error: { type: "invalid_request_error", message: "The amount of this transfer exceeds the allocated funds available on the source charge" } }] : null);
  const a = await approve(c); hooks.stripe = null;
  fsDispute(chA.id, 10000); await dispute(chA, "needs_response");
  fsDisputeClose(chA.id, true); const w = await dispute(chA, "won");
  for (let i = 0; i < 3; i++) { later(61); await hourly(); }
  const p = verify(c);
  vuln(sent(c) !== 11400 || row(c).status !== "completed" || row(c).commission_cents !== 600 || evs(c, "held_apart_released").length || p.length,
    `S2c (the review's case, right since a2a30d9) a payout in parts stopped (${a.status}), the chargeback on the first payment won (${w.status}) before it went on -> ${shape(c)}; the freelancer has ${sent(c)} (must be 11400), 5% ${row(c).commission_cents}, nothing moved to Cuvori's balance, ${row(c).status}${report(p)}`);
});

// ---------- S3 the sweep and an Order that still owes the freelancer ----------
for (const sweepLocked of [false, true]) await guard("S3", async () => {
  ON(); fsReset({ sweepLocked });
  const c = mk2({ amount_cents: 10000 }); const f = await fund2(c); const ch = chargeOf(f.session.payment_intent);
  c.status = "delivered"; const a = await approve(c);
  fsDispute(ch.id, 10000); await dispute(ch, "needs_response");
  let refuse = true;                                                    // the freelancer's account cannot take money right now
  hooks.stripe = (path, method, p) => (refuse && method === "POST" && path === "/transfers" && /^retransfer_/.test(p.get("metadata[purpose]") || "")
    ? [400, { error: { type: "invalid_request_error", code: "insufficient_capabilities_for_transfer", message: "Your destination account needs to have at least one of the following capabilities enabled: transfers" } }] : null);
  fsDisputeClose(ch.id, true); const w = await dispute(ch, "won");
  const bal0 = STRIPE.balance;
  later(61); await hourly();
  const s1 = { held: heldOf(ch), moved: evs(c, "held_apart_released").map(e => e.data.amount_cents), note: heldNote(c), marked: marked(c), balance: STRIPE.balance - bal0 };
  refuse = false;                                                       // the freelancer finishes their Stripe setup
  later(61); await hourly(); later(61); await hourly();
  const rp = tsOf(c).filter(t => /^retransfer_/.test(t.metadata.purpose)), p = verify(c);
  vuln(a.status !== 200 || w.status !== 200 || s1.held !== 9500 || s1.moved.length || s1.note || !s1.marked || s1.balance !== 0
    || rp.length !== 1 || rp[0].source_transaction !== ch.id || sent(c) !== 9500 || heldOf(ch) !== 0 || row(c).money_error || marked(c) || p.length,
    `S3 Stripe ${sweepLocked ? "letting" : "not letting"} money pulled back during a chargeback move: the chargeback won after the payout, the re-payment failing (account not ready); the hourly run -> still held apart ${s1.held} (must be 9500), moved to Cuvori's balance ${JSON.stringify(s1.moved)} (must be none), a "nobody is owed" note ${s1.note} (must be false), mark kept ${s1.marked}; once ready -> re-payment ${rp.map(t => t.amount + (t.source_transaction === ch.id ? " linked to the payment" : " FROM CUVORI'S BALANCE"))}, the freelancer has ${sent(c)}, note ${JSON.stringify(row(c).money_error)}, mark gone ${!marked(c)}${report(p)}`);
});
await guard("S3c", async () => {
  ON(); fsReset();
  const c = mk2({ amount_cents: 10000 }); const f = await fund2(c); c.status = "funded"; const ch = chargeOf(f.session.payment_intent);
  const x = await cancel(c);                                            // the freelancer gives it all back
  const re = STRIPE.refunds.find(r => r.payment_intent === ch.payment_intent && r.contract === c.id && !(r.metadata && r.metadata.kind));
  // the refund fails at Stripe afterwards (the client's card account closed); its money comes back to the payment
  re.status = "failed"; ch.allocated_funds.balance.available += re.amount;
  const w = await webhook(signed({ type: "charge.refund.updated", data: { object: { ...re, object: "refund", status: "failed", currency: "eur", failure_reason: "expired_or_canceled_card" } } }));
  const owed = lib.heldCents(row(c));
  later(61); await hourly(); later(61); await hourly();
  vuln(x.status !== 200 || w.status !== 200 || owed !== 10000 || evs(c, "held_apart_released").length || heldOf(ch) !== 10000 || heldNote(c) || !marked(c),
    `S3c a refund that failed at Stripe after the Order closed (${x.status}/${w.status}): the Order holds the client's ${owed} again; the hourly run twice -> moved to Cuvori's balance ${JSON.stringify(evs(c, "held_apart_released").map(e => e.data.amount_cents))} (must be none), still held apart ${heldOf(ch)} (must be 10000, for the refund made again), a "nobody is owed" note ${heldNote(c)}, mark kept ${marked(c)}`);
});

// ---------- S4 the "ask Stripe support" note once Stripe has released the money ----------
await guard("S4", async () => {
  ON(); fsReset({ sweepLocked: false });
  const c = mk2({ amount_cents: 10000 }); const f = await fund2(c); const ch = chargeOf(f.session.payment_intent);
  c.status = "delivered"; await approve(c);
  fsDispute(ch.id, 10000); await dispute(ch, "needs_response");
  fsDisputeClose(ch.id, false); await dispute(ch, "lost");
  later(61); await hourly(); const n1 = heldNote(c), h1 = heldOf(ch);
  // the owner asks Stripe support, as the note says; Stripe moves it to Cuvori's balance itself
  const b = ch.allocated_funds.balance; STRIPE.balance += b.available; b.available = 0; ch._locked = 0;
  later(61); await hourly(); later(61); await hourly();
  vuln(!n1 || h1 !== 9500 || heldNote(c) || marked(c),
    `S4 a chargeback lost after the payout -> the note asks the owner to write to Stripe ${n1} (held apart ${h1}); Stripe support released it -> the hourly run: note gone ${!heldNote(c)} (must be), mark gone ${!marked(c)}; note now ${JSON.stringify(row(c).money_error)}`);
});

// ---------- S6 a payout in parts stopped part-way, then a dashboard refund on its second payment ----------
await guard("S6", async () => {
  ON(); fsReset();
  const c = mk2({ amount_cents: 10000 }); const f1 = await fund2(c); c.status = "funded"; const f2 = await topUp(c, 2000);
  const chB = chargeOf(f2.session.payment_intent);
  c.status = "delivered";
  let cut = 0;
  hooks.stripe = (path, method, p) => (method === "POST" && path === "/transfers" && p.get("metadata[part]") === "1" && cut++ === 0
    ? [400, { error: { type: "invalid_request_error", message: "The amount of this transfer exceeds the allocated funds available on the source charge" } }] : null);
  const a1 = await approve(c); hooks.stripe = null;
  // a refund of 10.00 made in the Stripe dashboard on the top-up
  const r = { id: "re_dash" + Math.random().toString(36).slice(2, 10), object: "refund", created: Date.now() / 1000, amount: 1000, metadata: {}, payment_intent: chB.payment_intent, charge: chB.id, status: "succeeded" };
  STRIPE.refunds.push(r); chB.amount_refunded += 1000; chB.allocated_funds.balance.available -= 1000;
  const w = await webhook(signed({ type: "charge.refunded", data: { object: { id: chB.id, object: "charge", amount: chB.amount, amount_refunded: chB.amount_refunded, refunded: false, currency: "eur", payment_intent: chB.payment_intent } } }));
  const why = [];
  for (let i = 0; i < 3; i++) { later(61); const h = await hourly(); why.push(...((h.json && h.json.failures) || []).filter(x => x.id === c.id).map(x => x.why)); }
  const a2 = await approve(c), d = await resolve(c, "release");
  // what is left of the ledger check: the 5% of the first part was worked out on the whole payout (12000) before the
  // dashboard refund made it smaller (11000): 0.50 kept too much, which the ledger check lists for the owner (see the report)
  const commissionOnly = (p) => /commission/.test(p);
  const p = verify(c, commissionOnly), left = verify(c).filter(commissionOnly);
  vuln(a1.status !== 409 || w.status !== 200 || why.some(x => /different amount/.test(x)) || row(c).status !== "completed" || sent(c) !== 10400 || heldOf(chB) !== 0 || a2.status === 500 || d.status === 500 || /different amount/.test(String(row(c).money_error)) || p.length,
    `S6 a payout over two payments stopped after its first part (${a1.status}), then a 10.00 refund in the Stripe dashboard on the second payment (${w.status}) -> the hourly run's failures ${JSON.stringify(why.slice(0, 2))} (must be none), ${shape(c)}, the freelancer has ${sent(c)} (must be 10400: the 1000 left paid), the Order ${row(c).status}; the client's approval then ${a2.status}, the admin's decision ${d.status} (never 500)${report(p)}; left for the owner: ${left.join("; ") || "nothing"}`);
});
await guard("S6b", async () => {
  ON(); fsReset();
  const c = mk2({ amount_cents: 10000 }); await fund2(c); c.status = "funded"; await topUp(c, 2000);
  const [m1, m2] = ms(c, [6000, 6000]); await approve(c, m1.id);
  let cut = 0;
  hooks.stripe = (path, method, p) => (method === "POST" && path === "/transfers" && p.get("metadata[milestone_id]") === m2.id && p.get("metadata[part]") === "1" && cut++ === 0
    ? [400, { error: { type: "invalid_request_error", message: "The amount of this transfer exceeds the allocated funds available on the source charge" } }] : null);
  const r = await approve(c, m2.id); hooks.stripe = null;
  const parts = tsOf(c).filter(t => t.metadata.milestone_id === m2.id);
  // asked for less than what is left of the part's payout: refused, never paid as if it were the whole part
  let e2 = null; try { await lib.releaseToEditor(row(c), 1000, m2.id, "release"); } catch (e) { e2 = e.message; }
  const after = tsOf(c).filter(t => t.metadata.milestone_id === m2.id);
  vuln(r.status === 200 || parts.length !== 1 || !/different amount/.test(String(e2)) || after.length !== 1 || DB.order_milestones.find(m => m.id === m2.id).status === "released",
    `S6b a part's payout stopped after its first part (${r.status}, ${parts.length} transfer), then asked for 1000 (less than the 2000 left) -> ${e2 || "PAID"} (must be refused), its transfers ${after.length}, the part ${DB.order_milestones.find(m => m.id === m2.id).status} (never released until whole)`);
});

// ---------- S7 Stripe refusing a payout from money held apart for another reason ----------
await guard("S7", async () => {
  ON(); fsReset();
  const c = mk2({ amount_cents: 10000 }); await fund2(c); c.status = "delivered";
  const said = "Transfers from allocated funds are not enabled for account acct_1CuvoriPlatformAA: the allocated_funds_preview has ended for it.";
  hooks.stripe = (path, method, p) => (method === "POST" && path === "/transfers" && p.get("source_transaction") ? [400, { error: { type: "invalid_request_error", code: "transfers_not_allowed", message: said } }] : null);
  const n0 = logs.length;
  const a = await approve(c);
  later(61); await hourly();
  hooks.stripe = null;
  const note = String(row(c).money_error || ""), ref = (/Netlify log ref ([0-9a-f]{8})/.exec(note) || [])[1];
  const logged = !!ref && logs.slice(n0).some(l => l.includes(ref) && l.includes(said));
  vuln(a.json && a.json.code === "settling" || /still settling|nothing needs to be done/.test(note) || !/Stripe refused a payout from the money it holds apart, Stripe's code transfers_not_allowed/.test(note) || /acct_|allocated_funds_preview|not enabled for account/.test(note) || !logged || tsOf(c).length,
    `S7 Stripe refusing a payout from money held apart ("${said.slice(0, 50)}…") -> approve ${a.status} ${a.json && a.json.code}; the Order's note "${note.slice(0, 220)}" (must name the refusal and Stripe's code, never say "still settling" or carry Stripe's text); Stripe's own text in the log under the note's ref ${logged}`);
});
await guard("S7b", async () => {
  ON(); fsReset();
  const c = mk2({ amount_cents: 10000 }); await fund2(c); c.status = "delivered";
  let cut = 0;
  hooks.stripe = (path, method, p) => (method === "POST" && path === "/transfers" && cut++ === 0 ? [400, { error: { type: "invalid_request_error", message: "The amount of this transfer exceeds the allocated funds available on the source charge" } }] : null);
  const a = await approve(c); const note = String(row(c).money_error || ""); hooks.stripe = null;
  later(61); await hourly();
  vuln(a.status !== 409 || a.json.code !== "settling" || !/still settling/.test(note) || sent(c) !== 9500 || row(c).status !== "completed",
    `S7b Stripe saying the payment does not hold enough yet -> approve ${a.status} ${a.json && a.json.code} (must be 409 settling), note "${note.slice(0, 120)}"; the hourly run pays it: the freelancer has ${sent(c)}, ${row(c).status}`);
});

// ---------- S5 every closed Order's mark is reached (last: it leaves 200 open Orders behind) ----------
await guard("S5", async () => {
  ON(); fsReset(); DBQ.paging = true;                                  // like the real database: a list read keeps its order and limit
  const t0 = new Date(Date.now() - 10 * 86400e3).toISOString();
  for (let i = 0; i < 200; i++) { const o = mk2({ amount_cents: 10000, status: "funded", funded_cents: 10000 }); DB.money_keys.push({ id: uuid(), scope: `fs:${o.id}`, key: "fs:old" + i, created_at: t0 }); }
  const c = mk2({ amount_cents: 10000 }); const f = await fund2(c); const ch = chargeOf(f.session.payment_intent); c.status = "delivered"; await approve(c);
  ch.allocated_funds.balance.available += 300;                          // Stripe gave something back into it after the payout
  later(61); await hourly();
  const moved = evs(c, "held_apart_released").map(e => e.data.amount_cents);
  vuln(heldOf(ch) !== 0 || moved.length !== 1 || moved[0] !== 300 || marked(c),
    `S5 200 open Orders marked before it, a closed Order with 3.00 still held apart -> one hourly run: moved ${JSON.stringify(moved)} (must be [300]), still held apart ${heldOf(ch)}, mark gone ${!marked(c)}`);
});

console.error = realError;
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
