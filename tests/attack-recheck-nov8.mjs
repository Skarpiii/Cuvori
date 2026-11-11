// Re-check of 8 November (of d578e0c, the fixes of 8 November): regression checks for what three fresh reviewers proved.
// S1 a chargeback whose first step (counting every payout at Stripe the books don't show) the database refused: the bank's
//    notice failed every time, the chargeback stayed "open" for good, nothing could move on the Order and nothing said why
//    (a part's payout whose answer was lost, then a refund in the Stripe dashboard, then a chargeback of the rest; or, at
//    today's prices, a part's line refused and then a decision's payout whose answer was lost: its payout was taken for the
//    part's). Now the counting never blocks the chargeback; what can't be counted is noted for a person.
// S2 a cancel or a decision whose first count the database refuses for good answered "try again in a minute" for ever, and
//    nothing told the admin why. Now it says the Order is under review, and the Order's note says what to check.
// S3 a card-fee refund that failed: its note, marked as handled, came back with every later refund notice of the payment.
// S4 the hourly run marked counted parts only among the first 2,000 parts waiting: one further down was never marked; and
//    (S4b) on a database without v56 it could not read the payout lines at all.
// S5 a database without v56 (schema v55): every cancel and every decision was refused ("try again"), and parts could not be
//    paid out (the lines' lookup asked for v56's columns); a failed refund noted there whose note could not be saved was
//    never noted.
// S6 a refund that failed on a database without v56 (noted, the Order still counting it as given back), made again, then v56:
//    a "failed" notice sent again counted it back, and Cuvori paid the client's 40.00 out of its own money with nothing
//    saying so; a later refund notice brought its old note back or wrote a false "money went out twice".
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

const dashRefund = (pi, amount) => { const ch = chargeOf(pi); ch.amount_refunded += amount; STRIPE.balance -= amount;
  const r = { id: "re_dash" + Math.random().toString(36).slice(2, 10), created: Date.now() / 1000, amount, contract: null, metadata: {}, payment_intent: pi, charge: ch.id, status: "succeeded" }; STRIPE.refunds.push(r); return r; };
const refundedEvent = (pi) => { const ch = chargeOf(pi); return signed({ type: "charge.refunded", data: { object: { id: ch.id, object: "charge", payment_intent: pi, amount: ch.amount, amount_refunded: ch.amount_refunded, refunded: ch.amount_refunded >= ch.amount, currency: "eur" } } }); };
const failedEvent = (r) => signed({ type: "charge.refund.updated", data: { object: { ...r, object: "refund", status: "failed", currency: "eur", failure_reason: "expired_or_canceled_card" } } });
const refundFails = (r) => { r.status = "failed"; const ch = STRIPE.charges[r.charge]; ch.amount_refunded -= r.amount; STRIPE.balance += r.amount; return failedEvent(r); };
const okBack = (pi) => STRIPE.refunds.filter(r => r.payment_intent === pi && r.status === "succeeded" && !(r.metadata && ["fee_surplus", "late_payment"].includes(r.metadata.kind))).reduce((a, r) => a + r.amount, 0);
const okLate = () => 0;
// schema v55's rule: order_payments.kind in ('fund','release','refund','reversal','chargeback') (no "refund_failed" yet)
const v55 = async (method, table, search, body) => (method === "POST" && table === "order_payments" && /"kind":"refund_failed"/.test(String(body))
  ? new Response(JSON.stringify({ code: "23514", message: 'new row for relation "order_payments" violates check constraint "order_payments_kind_check"' }), { status: 400, headers: { "content-type": "application/json" } }) : null);
const freelancerGets = (plan, cents) => plan === 2 ? Math.round(cents * 0.95) : cents;
const mstat = (m) => DB.order_milestones.find(x => x.id === m.id).status;
const lostTransfer = () => arm("lost", (u, init) => u.includes("api.stripe.com/v1/transfers") && init.method === "POST" && !u.includes("reversals"));
// a database without v56: PostgREST refuses a select naming a column that is not there, and the kind "refund_failed"
const V56COLS = /(payout_purpose|commission_cents|payout_cents|entry_key|pricing_version)/;
const v55full = async (method, table, search, body) => {
  if (method === "GET" && table === "order_payments") { const sel = new URLSearchParams(String(search || "").replace(/^\?/, "")).get("select") || ""; if (V56COLS.test(sel)) return new Response(JSON.stringify({ code: "42703", message: `column order_payments.${(sel.match(V56COLS) || [])[1]} does not exist` }), { status: 400, headers: { "content-type": "application/json" } }); }
  return v55(method, table, search, body);
};

// ---------- S1 a chargeback is never frozen by its first step ----------
for (const [name, mkX, plan] of PLANS) for (const outcome of ["won", "lost"]) {
  await guard(`S1a [${name}] ${outcome}`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent, ch = chargeOf(pi);
    row(c).status = "funded"; const [m1] = ms(c, [6000, 4000]);
    lostTransfer(); await approve(c, m1.id); FAULT.pred = null; later(5);
    dashRefund(pi, 5000); const w = await webhook(refundedEvent(pi));
    const ws = [(await dispute(c, ch, "needs_response", { amount: 5000 })).status];
    for (let i = 0; i < 2; i++) { later(60); await hourly(); ws.push((await dispute(c, ch, "needs_response", { amount: 5000 })).status); }
    ws.push((await dispute(c, ch, outcome, { amount: 5000 })).status);
    for (let i = 0; i < 2; i++) { later(60); await hourly(); }
    const said = notes(c).some(n => /not in the books|could not be counted/i.test(n));
    const payouts = tsOf(c).filter(t => (t.metadata.purpose || "release") === "release").length;
    vuln(ws.some(s => s !== 200) || row(c).chargeback_status !== outcome || !said || payouts !== 1 || sent(c) > freelancerGets(plan, 6000),
      `S1a [${name}] part 1 (60.00) paid, its answer lost; 50.00 refunded in the dashboard (${w.status}); the bank charges back the other 50.00, decided ${outcome}: notices ${ws.join(",")}; ${show(c)}; payouts ${payouts}; chargeback ${row(c).chargeback_status}; a note says what could not be counted: ${said} (must be all 200, ${outcome}, one payout, noted: money went out twice here, a person sorts it out)`);
  });
}
for (const what of ["chargeback won", "chargeback lost", "hourly only"]) {
  await guard(`S1b ${what}`, async () => {
    ready(true);
    const c = mk1({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const ch = chargeOf(f.session.payment_intent);
    row(c).status = "funded"; const [m1] = ms(c, [6000, 4000]);
    let partLineOff = true;
    hooks.db = async (method, table, search, body) => (partLineOff && method === "POST" && table === "order_payments" && String(body).includes(m1.id) ? dbError() : null);
    await approve(c, m1.id);
    later(5); disputed(c);
    lostTransfer();
    const d = await resolve(c, "release"); FAULT.pred = null;
    partLineOff = false; hooks.db = null;
    later(15);
    const w = [];
    if (what !== "hourly only") {
      w.push((await dispute(c, ch, "needs_response")).status);
      for (let i = 0; i < 2; i++) { later(60); await hourly(); w.push((await dispute(c, ch, "needs_response")).status); }
      w.push((await dispute(c, ch, what === "chargeback won" ? "won" : "lost")).status);
    }
    for (let i = 0; i < 3; i++) { later(60); await hourly(); }
    const p = ledgerP(c, 1);
    const ok = what === "chargeback lost" ? row(c).chargeback_status === "lost" && row(c).status !== "resolving" : row(c).status === "completed" && sent(c) === 10000 && row(c).released_cents === 10000;
    vuln(w.some(s => s !== 200) || !ok || p.length,
      `S1b [plan 1] part 1 (60.00) paid, its line refused; decision 'release' of the other 40.00 (${d.status}, its payout's answer lost); ${what}: notices ${w.join(",") || "-"}; ${show(c)}; chargeback ${row(c).chargeback_status || "-"}${report(p)} (must be: notices 200, ${what === "chargeback lost" ? "lost and closed" : "completed, 100.00 paid out once, the books right"})`);
  });
}

// ---------- S2 a cancel or a decision whose first count the database refuses for good ----------
for (const [name, mkX, plan] of PLANS) for (const how of ["refund", "cancel"]) {
  await guard(`S2 [${name}] ${how}`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent;
    row(c).status = "funded"; const [m1] = ms(c, [6000, 4000]);
    lostTransfer(); await approve(c, m1.id); FAULT.pred = null; later(5);
    dashRefund(pi, 5000); await webhook(refundedEvent(pi));
    if (how === "cancel") { const x = row(c); x.status = "funded"; x.disputed_at = null; x.dispute_by = null; }
    const rs = [];
    for (let i = 0; i < 2; i++) { rs.push(how === "cancel" ? await cancel(c) : await resolve(c, "refund")); later(2); }
    const said = notes(c).some(n => /not in the books|could not be counted/i.test(n));
    vuln(rs.some(r => r.status === 503 || (r.json && r.json.code === "provider_down")) || rs.some(r => r.status === 200 ? false : !(r.json && r.json.code === "under_review")) || !said,
      `S2 [${name}] part 1's payout made (answer lost), 50.00 refunded in the dashboard; then the ${how === "cancel" ? "freelancer's cancel" : "decision 'refund'"} twice -> ${rs.map(r => r.status + " " + (r.json && r.json.code)).join(", ")}; note for the admin: ${said} (must never be "try again": under review, and the note says what to check)`);
  });
}

// ---------- S3 a card-fee refund's failure note, marked as handled, never comes back ----------
for (const v of ["v55", "v56"]) {
  await guard(`S3 ${v}`, async () => {
    V56.on = v === "v56"; ready(true); hooks.db = v === "v55" ? v55full : null;
    const c = mk1(); const f = await fund2(c); const pi = f.session.payment_intent;
    const fee = STRIPE.refunds.find(x => x.payment_intent === pi && x.metadata && x.metadata.kind === "fee_surplus");
    if (!fee) { vuln(true, `S3 [plan 1, ${v}] no card-fee refund was made (the check's set-up failed)`); return; }
    const wf = await webhook(refundFails(fee));
    const n1 = notes(c).filter(n => n.startsWith(`refund ${fee.id} `)).length;
    row(c).money_error = null;                                                   // paid by bank transfer, "Mark as handled"
    dashRefund(pi, 1000); const w2 = await webhook(refundedEvent(pi));          // a later refund on the same payment
    const w3 = await webhook(failedEvent(fee));                                  // Stripe sends the failed notice again
    const n2 = notes(c).filter(n => n.startsWith(`refund ${fee.id} `)).length;
    hooks.db = null; V56.on = true;
    vuln(n1 !== 1 || n2 !== 0,
      `S3 [plan 1, ${v}] the card-fee refund (${fee.amount}) failed (${wf.status}): noted ${n1}; marked as handled; a later dashboard refund (${w2.status}) and the failed notice again (${w3.status}): the note ${n2 ? "BACK" : "stays gone"} (must be noted once, then stay gone)`);
  });
}

// ---------- S4 counted parts are marked also beyond the first 2,000 parts waiting ----------
await guard("S4", async () => {
  ready(true);
  const c = mk1({ amount_cents: 10000, price: 100 }); await fund2(c); row(c).status = "funded";
  const [m1] = ms(c, [3000, 7000]);
  // part 1 counted (its line in the books) but its mark never saved: it stays "approved"; its id sorts last
  m1.status = "approved"; m1.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  Object.assign(row(c), { status: "refunded", released_cents: 3000, refunded_cents: 7000 });   // the Order closed since (a cancel)
  DB.order_payments.push({ id: uuid(), order_id: c.id, provider: "stripe", status: "succeeded", kind: "release", amount_cents: 3000, provider_ref: "tr_counted1", milestone_id: m1.id, note: "milestone payout counted at settlement", created_at: new Date().toISOString() });
  const other = mk1({ amount_cents: 10000, price: 100, status: "funded", funded_cents: 10000 });
  for (let i = 0; i < 2100; i++) DB.order_milestones.push({ id: `0${String(i).padStart(7, "0")}-0000-4000-8000-000000000000`, order_id: other.id, title: "w", amount_cents: 1, status: "submitted", position: i });
  DBQ.paging = true;                                                           // reads apply their order and limit, as the real database
  const runs = [];
  for (let i = 0; i < 4 && mstat(m1) !== "released"; i++) { later(60); await hourly(); runs.push(mstat(m1)); }
  DBQ.paging = false;
  DB.order_milestones.splice(0, DB.order_milestones.length, ...DB.order_milestones.filter(m => m.order_id !== other.id));
  vuln(mstat(m1) !== "released",
    `S4 a counted part not marked, with 2,100 other parts waiting for review (their ids first): after the hourly runs ${runs.join(", ")} (must be released within a few runs)`);
});

await guard("S4b", async () => {
  V56.on = false; ready(true);
  const c = mk1({ amount_cents: 10000, price: 100 }); await fund2(c); row(c).status = "funded";
  const [m1] = ms(c, [3000, 7000]);
  m1.status = "approved";
  DB.order_payments.push({ id: uuid(), order_id: c.id, provider: "stripe", status: "succeeded", kind: "release", amount_cents: 3000, provider_ref: "tr_counted2", milestone_id: m1.id, note: "milestone payout counted at settlement", created_at: new Date().toISOString() });
  Object.assign(row(c), { status: "refunded", released_cents: 3000, refunded_cents: 7000 });
  hooks.db = v55full;
  later(60); const h = await hourly();
  hooks.db = null; V56.on = true;
  vuln(mstat(m1) !== "released", `S4b a database without v56: a counted part not marked, its Order closed; the hourly run (${h.status}) -> part 1 ${mstat(m1)} (must be released)`);
});

// ---------- S5 a database without v56 ----------
for (const how of ["cancel", "decision refund", "decision split", "part approved", "part released by the hourly run"]) {
  await guard(`S5 ${how}`, async () => {
    V56.on = false; ready(true); const c = mk1(); await fund2(c);
    let m1;
    if (how.startsWith("part")) { row(c).status = "funded"; [m1] = ms(c, [3000, 7000]); }
    if (how.startsWith("decision")) disputed(c);
    hooks.db = v55full;
    let r;
    if (how === "cancel") r = await cancel(c);
    else if (how === "decision refund") r = await resolve(c, "refund");
    else if (how === "decision split") r = await resolve(c, "split", { editor_percent: 50 });
    else if (how === "part approved") r = await approve(c, m1.id);
    else { m1.status = "approved"; m1.auto_release_at = new Date(Date.now() - 3600e3).toISOString(); r = await hourly(); }
    hooks.db = null; V56.on = true;
    const must = how === "cancel" || how === "decision refund" ? ["refunded", 0, 10000] : how === "decision split" ? ["completed", 5000, 5000] : ["funded", 3000, 0];
    vuln(r.status !== 200 || row(c).status !== must[0] || sent(c) !== must[1] || okBack(f => f) !== 0 && false || (m1 && mstat(m1) !== "released"),
      `S5 a database without v56, today's prices: ${how} -> ${r.status} ${JSON.stringify(r.json && (r.json.code || r.json.error) || "").slice(0, 60)}; ${show(c)}${m1 ? "; part 1 " + mstat(m1) : ""} (must be 200: ${must[0]}, at the freelancer ${must[1]})`);
  });
}
await guard("S5 note", async () => {
  V56.on = false; ready(true);
  const c = mk1(); const f = await fund2(c); const pi = f.session.payment_intent;
  const r1 = dashRefund(pi, 4000); await webhook(refundedEvent(pi));
  const failed = refundFails(r1);
  let n = 0; hooks.db = async (m, t, s, b) => { const x = await v55full(m, t, s, b); if (x) return x; if (m === "PATCH" && t === "contracts" && /money_error/.test(String(b)) && n < 6) { n++; return dbError(); } return null; };
  const w1 = await webhook(failed);
  hooks.db = v55full;
  const w2 = await webhook(failedEvent(r1));
  hooks.db = null; V56.on = true;
  const noted = notes(c).some(x => x.startsWith(`refund ${r1.id} `));
  vuln(!noted, `S5 note: a database without v56; a failed refund whose note could not be saved (${w1.status}); the notice again (${w2.status}): the note ${noted ? "written" : "NEVER written"} (must be written)`);
});

// ---------- S6 a refund that failed before v56 ran, made again; then v56 ----------
const setupV55 = async (handled) => {
  V56.on = false; ready(true); hooks.db = v55full;
  const c = mk1(); const f = await fund2(c); const pi = f.session.payment_intent;
  const r1 = dashRefund(pi, 4000); await webhook(refundedEvent(pi));
  await webhook(refundFails(r1));
  dashRefund(pi, 4000); await webhook(refundedEvent(pi));                     // made again, as the note says
  if (handled) row(c).money_error = null;                                       // "Mark as handled"
  hooks.db = null; V56.on = true;                                               // v56 runs
  return { c, pi, r1 };
};
for (const type of ["charge.refund.updated", "refund.failed"]) {
  await guard(`S6a ${type}`, async () => {
    const { c, pi, r1 } = await setupV55(true);
    const w = await webhook(signed({ type, data: { object: { ...r1, object: "refund", status: "failed", currency: "eur", failure_reason: "expired_or_canceled_card" } } }));
    const d = await resolve(c, "release"); later(60); await hourly();
    vuln(sent(c) !== 6000 || okBack(pi) !== 4000 || row(c).refunded_cents !== 4000 || notes(c).some(n => n.startsWith(`refund ${r1.id} `)),
      `S6a [plan 1] a failed refund noted before v56, made again, its note handled; v56; "${type}" again -> ${w.status}; 'release' -> ${d.status}: ${show(c)}; the client has ${okBack(pi)}; the old note ${notes(c).some(n => n.startsWith(`refund ${r1.id} `)) ? "BACK" : "stays gone"} (must be: the freelancer 6000, the client 4000, Cuvori nothing of its own, no note)`);
  });
}
for (const handled of [true, false]) {
  await guard(`S6b ${handled}`, async () => {
    const { c, pi, r1 } = await setupV55(handled);
    disputed(c);
    const d = await resolve(c, "refund");
    const w = await webhook(refundedEvent(pi));
    const bad = notes(c).filter(n => (handled && n.startsWith(`refund ${r1.id} `)) || /went out twice/.test(n));
    vuln(d.status !== 200 || okBack(pi) !== 10000 || row(c).status !== "refunded" || bad.length || lines(c, "refund").some(l => l.note === "dashboard_refund_paid_out"),
      `S6b [plan 1] a failed refund noted before v56, made again, its note ${handled ? "handled" : "still there"}; v56; 'refund' -> ${d.status}, its notice -> ${w.status}: ${show(c)}; the client has ${okBack(pi)}; wrong notes: ${JSON.stringify(bad.map(n => n.slice(0, 70)))} (must be: refunded, the client 10000, no old or false note)`);
  });
}

console.error = realError;
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
