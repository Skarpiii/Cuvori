// Check of 8 November (the re-check of the fixes of 7 November, commit 3dd7d46): regression checks for what it proved. Both
// price plans where both are affected.
// Q1 today's database (schema v55, no "refund_failed" kind of line yet): a refund made in the Stripe dashboard that failed,
//    made again as the note says, was counted twice (the Order counted 80.00 given back for 40.00; the freelancer was then
//    paid 20.00 instead of 60.00 and 40.00 stayed at Cuvori). The fix of 7 November did that; before it, it was right.
// Q2 the same refund made again before Cuvori handled Stripe's "failed" notice (its first delivery failed, or it came late):
//    in between, the Order counted 80.00 given back, and a decision in that time underpaid the freelancer.
// Q3 a decision whose answer was lost was told by the hourly run before it was carried out; the admin then replaced it, and
//    both sides got both decisions and both were marked as having lost the dispute. And (older) a decision told, then stuck
//    (the freelancer could not be paid) and replaced: the side the replaced decision marked kept the mark.
// Q4 the update day: decisions of the last 7 days that the old version made and told were told again (a "lost a dispute"
//    mark the admin had removed came back; with the database's clock a second behind, the message was sent twice).
// Q5 (older) a failed refund counted back, its "done" key not saved: the notice sent again after "Mark as handled" counted
//    it back a second time (the Order showed 100.00 held that it did not have).
//    Q1c: there, the failed refund's note marked as handled came back with every later notice of the payment.
// Q6 (older) a "failed" notice handled halfway (its line saved, the count back refused), the refund made again before Stripe
//    sent the notice again: the refund made again was never counted, and the freelancer was paid the client's 40.00 too.
// Q7 (older) a price increase whose count was refused once, while an earlier increase's line was missing: sent again, it was
//    taken for counted already (the Order counted 150.00 of 180.00 paid in); and a second page for an increase was charged.
// Q8 (older) a payout whose answer was lost, then a chargeback whose pull-back Stripe refused (the freelancer's balance was
//    empty), decided for the client: the books never showed the payout, and the Order said nothing of what Cuvori lost.
// Q9 (older) a part's payout counted while its "paid out" mark was refused: the part stayed "approved" for good, with no
//    history line and no chat card.
// Q10 (older) a cancel or a decision while its first count of the payouts could not be done (Stripe or the database not
//    answering): it went ahead with the books as they were, and its history said 100.00 went back where 40.00 did.
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

// ---------- Q1 today's database (v55): a failed dashboard refund made again ----------
for (const [how, early] of [["made again after its \"failed\" notice", false], ["made again before its \"failed\" notice", true]]) {
  await guard(`Q1 ${how}`, async () => {
    V56.on = false; ready(true); hooks.db = v55;
    const c = mk1(); const f = await fund2(c); const pi = f.session.payment_intent;
    const r1 = dashRefund(pi, 4000); const w1 = await webhook(refundedEvent(pi));
    const failed = refundFails(r1);
    const w2 = early ? { status: "-" } : await webhook(failed);
    dashRefund(pi, 4000); const w3 = await webhook(refundedEvent(pi));            // made again, as the note says
    const w4 = early ? await webhook(failedEvent(r1)) : { status: "-" };         // the late "failed" notice
    const mid = { ...row(c) };
    const d = await resolve(c, "release"); later(60); await hourly(); hooks.db = null;
    const said = notes(c).some(n => n.startsWith(`refund ${r1.id} `));
    vuln(mid.refunded_cents !== 4000 || d.status !== 200 || sent(c) !== 6000 || held(c) !== 0 || okBack(pi) !== 4000,
      `Q1 [plan 1, v55] 40.00 refunded in the dashboard (${w1.status}), it failed, ${how} (${w2.status}, ${w3.status}, ${w4.status}): the Order counts ${mid.refunded_cents} given back (the client has ${okBack(pi)}); 'release' -> ${d.status}: ${show(c)}; the failed refund's note ${said ? "there" : "MISSING"} (must be 4000 counted, the freelancer 6000, nothing held)`);
    V56.on = true;
  });
}

await guard("Q1c the note once", async () => {
  V56.on = false; ready(true); hooks.db = v55;
  const c = mk1(); const f = await fund2(c); const pi = f.session.payment_intent;
  const r1 = dashRefund(pi, 4000); await webhook(refundedEvent(pi));
  const w1 = await webhook(refundFails(r1));
  dashRefund(pi, 4000); const w2 = await webhook(refundedEvent(pi));             // made again, as the note says
  row(c).money_error = null;                                                     // "Mark as handled"
  const w3 = await webhook(refundedEvent(pi)), w4 = await webhook(failedEvent(r1));   // Stripe sends both notices again
  hooks.db = null;
  vuln(notes(c).some(n => n.startsWith(`refund ${r1.id} `)) || row(c).refunded_cents !== 4000,
    `Q1c [plan 1, v55] a failed dashboard refund noted (${w1.status}), made again (${w2.status}), the note marked as handled; both notices sent again (${w3.status}, ${w4.status}): the note ${notes(c).some(n => n.startsWith(`refund ${r1.id} `)) ? "BACK" : "stays gone"}; the Order counts ${row(c).refunded_cents} given back (must stay gone, 4000)`);
  V56.on = true;
});

// ---------- Q2 the new database (v56): made again before Cuvori handled the "failed" notice ----------
for (const [name, mkX, plan] of PLANS) {
  for (const decide of [false, true]) {
    await guard(`Q2 [${name}] ${decide}`, async () => {
      ready(true);
      const c = mkX(); const f = await fund2(c); const pi = f.session.payment_intent;
      const r1 = dashRefund(pi, 4000); await webhook(refundedEvent(pi));
      refundFails(r1);                                                            // Stripe: failed; its notice not handled yet
      dashRefund(pi, 4000); const w2 = await webhook(refundedEvent(pi));          // made again, seen failed in the dashboard
      const mid = { ...row(c) };
      const d = decide ? await resolve(c, "release") : { status: "-" };
      later(60); await hourly();
      const w3 = await webhook(failedEvent(r1));                                  // the late "failed" notice
      later(60); await hourly();
      const end = { ...row(c) };
      const fl = decide ? freelancerGets(plan, 6000) : 0;
      vuln(w2.status !== 200 || mid.refunded_cents !== 4000 || end.refunded_cents !== 4000 || (decide && (d.status !== 200 || sent(c) !== fl || held(c) !== 0)) || (!decide && held(c) !== 6000) || ledgerP(c, plan).length,
        `Q2 [${name}] 40.00 refunded in the dashboard, it failed, made again before Cuvori handled its "failed" notice (${w2.status}): in between the Order counts ${mid.refunded_cents} given back${decide ? `; 'release' then -> ${d.status}` : ""}; the late notice (${w3.status}): ${show(c)}${report(ledgerP(c, plan))} (must be 4000 given back throughout${decide ? `, the freelancer ${fl}, nothing held` : ", 6000 held"})`);
    });
  }
}

// ---------- Q3 a decision told only once it is carried out; a replaced one never; its mark taken back ----------
const flagsOf = (c) => DB.user_flags.filter(f => f.contract_id === c.id && f.kind === "dispute_lost").map(f => f.user_id === users.cl.id ? "client" : "freelancer").sort().join(",");
const chatOf = (c) => DB.messages.filter(m => m.kind === "text" && m.conversation_id === c.conversation_id && String(m.body).startsWith("Cuvori decision:")).map(m => m.body.slice(17, 25)).join(" | ");
const opened = (c) => DB.order_events.push({ id: uuid(), order_id: c.id, actor: users.cl.id, event: "disputed", data: {} });
for (const [name, mkX] of PLANS) {
  await guard(`Q3a [${name}]`, async () => {
    DB.messages.length = 0;
    ready(true); const c = mkX(); await fund2(c); disputed(c); opened(c);
    arm("lost", (u, init) => u.includes("/rest/v1/order_events") && init.method === "POST" && /"event":"decision"/.test(bodyOf(init)));
    const r1 = await resolve(c, "release", { note: "Release: the work was delivered as agreed." });
    later(5); await hourly();                                                     // before the stuck list takes it up
    const mid = { flags: flagsOf(c), chat: chatOf(c) };
    later(3); const r2 = await resolve(c, "refund", { note: "Refund: the files were never delivered." });
    for (let i = 0; i < 2; i++) { later(60); await hourly(); }
    vuln(r1.status !== 503 || r2.status !== 200 || mid.chat !== "" || flagsOf(c) !== "freelancer" || chatOf(c) !== "Refund: " || row(c).status !== "refunded",
      `Q3a [${name}] 'release' saved, its answer lost (${r1.status}); the hourly run 5 minutes later told: marks [${mid.flags}], messages [${mid.chat}]; replaced by 'refund' 3 minutes later (${r2.status}), ${row(c).status}: marks [${flagsOf(c)}], messages [${chatOf(c)}] (must be: nothing told before; then the freelancer marked, the 'refund' told)`);
    DB.messages.length = 0;
  });
  await guard(`Q3b [${name}]`, async () => {
    DB.messages.length = 0;
    ready(true); const c = mkX(); await fund2(c); disputed(c); opened(c);
    ban(users.ed);
    const r1 = await resolve(c, "release", { note: "Release: the work was delivered as agreed." });
    const r2 = await resolve(c, "refund", { note: "Refund: the files were never delivered." });
    ban(users.ed, false);
    for (let i = 0; i < 2; i++) { later(60); await hourly(); }
    vuln(r2.status !== 200 || flagsOf(c) !== "freelancer" || row(c).status !== "refunded",
      `Q3b [${name}] 'release' told, then stuck (the freelancer banned: ${r1.status}), replaced by 'refund' (${r2.status}), ${row(c).status}: marks [${flagsOf(c)}], messages [${chatOf(c)}] (must be: only the freelancer marked; the client's mark from the replaced 'release' taken back)`);
    DB.messages.length = 0;
  });
}

// ---------- Q4 the update day: decisions the old version made and told are never told again ----------
for (const [how, flagThere, msgDelayMs] of [["told by the old version", true, 400], ["told by the old version; the admin removed the mark since", false, 400],
                                            ["told by the old version; the database clock 1 s behind", true, -1000]]) {
  await guard(`Q4 ${how}`, async () => {
    DB.messages.length = 0;
    const c = mk1(); await fund2(c);
    const x = row(c), at = new Date(Date.now() - 2 * 86400e3).toISOString();
    Object.assign(x, { status: "refunded", resolution: "refund", resolved_by: users.adm.id, resolved_at: at, dispute_by: users.cl.id, disputed_at: at });
    DB.order_events.push({ id: uuid(), order_id: c.id, actor: users.cl.id, event: "disputed", data: {}, created_at: at });
    DB.order_events.push({ id: uuid(), order_id: c.id, actor: users.adm.id, event: "decision", data: { attempt: at, decision: "refund", editor_cents: 0, refund_cents: 10000, note: NOTE }, created_at: at });
    if (flagThere) DB.user_flags.push({ id: uuid(), user_id: users.ed.id, kind: "dispute_lost", contract_id: c.id, reason: "Lost dispute" });
    DB.messages.push({ id: uuid(), conversation_id: c.conversation_id, sender: users.adm.id, kind: "text", body: "Cuvori decision: " + NOTE, created_at: new Date(Date.parse(at) + msgDelayMs).toISOString() });
    later(10); await hourly(); later(60); await hourly();
    const marks = DB.user_flags.filter(f => f.contract_id === c.id && f.kind === "dispute_lost").length;
    const msgs = DB.messages.filter(m => m.conversation_id === c.conversation_id && m.body === "Cuvori decision: " + NOTE).length;
    vuln(marks !== (flagThere ? 1 : 0) || msgs !== 1,
      `Q4 a 'refund' decided 2 days ago, ${how}; after the new version's hourly runs: marks ${marks}, messages ${msgs} (must stay ${flagThere ? 1 : 0}, 1)`);
    DB.messages.length = 0;
  });
}

// ---------- Q5 a failed refund counted back whose "done" key was not saved; the notice sent again after "Mark as handled" ----------
const Q5_CASES = [
  ["the key refused", (id) => arm("refused", (u, init) => u.includes("/rest/v1/money_keys") && init.method === "POST" && bodyOf(init).includes(`"scope":"refund_back:${id}"`))],
  ["the key's answer lost", (id) => arm("lost", (u, init) => u.includes("/rest/v1/money_keys") && init.method === "POST" && bodyOf(init).includes(`"scope":"refund_back:${id}"`))],
  ["the count back's answer lost, the re-read refused", (id) => { let n = 0; hooks.db = async (m, t) => (m === "GET" && t === "contracts" && n === 1 ? (n++, dbError()) : null);
      arm("lost", (u, init) => { const hit = u.includes("/rest/v1/contracts") && init.method === "PATCH" && bodyOf(init).includes(`refund ${id} `); if (hit) n = 1; return hit; }); }],
  ["the count back landed, the key refused after it", (id) => { let n = 0; hooks.db = async (m, t, s, b) => (m === "POST" && t === "money_keys" && String(b).includes(`refund_back:${id}`) && n === 1 ? (n++, dbError()) : null);
      arm("lost", (u, init) => { const hit = u.includes("/rest/v1/contracts") && init.method === "PATCH" && bodyOf(init).includes(`refund ${id} `); if (hit) n = 1; return hit; }); }],
];
for (const [name, mkX, plan] of PLANS) {
  for (const [how, set] of Q5_CASES) {
    await guard(`Q5 [${name}] ${how}`, async () => {
      const c = mkX(); const f = await fund2(c); const pi = f.session.payment_intent;
      await cancel(c);
      const ours = STRIPE.refunds.find(x => x.payment_intent === pi && x.metadata.contract_id === c.id && !x.metadata.kind);
      refundFails(ours); set(ours.id);
      const w1 = await webhook(failedEvent(ours)); hooks.db = null; FAULT.pred = null;
      dashRefund(pi, ours.amount); const w2 = await webhook(refundedEvent(pi));   // the admin follows the note
      row(c).money_error = null;                                                    // "Mark as handled"
      const w3 = await webhook(failedEvent(ours));                                  // the same notice once more
      vuln(row(c).refunded_cents !== 10000 || held(c) !== 0 || notes(c).length || ledgerP(c, plan).length,
        `Q5 [${name}] the cancel's refund (100.00) failed, ${how} (notice -> ${w1.status}); made again in the dashboard (${w2.status}), the note marked as handled; the notice once more -> ${w3.status}: ${show(c)}; notes ${JSON.stringify(notes(c).map(n => n.slice(0, 60)))}${report(ledgerP(c, plan))} (must be 10000 given back, nothing held, no note)`);
    });
  }
}

// ---------- Q6 a "failed" notice handled halfway, the refund made again before Stripe sends it again ----------
for (const [name, mkX, plan] of PLANS) {
  await guard(`Q6 [${name}]`, async () => {
    ready(true);
    const c = mkX(); const f = await fund2(c); const pi = f.session.payment_intent;
    const r1 = dashRefund(pi, 4000); await webhook(refundedEvent(pi));
    refundFails(r1);
    arm("refused", (u, init) => u.includes("/rest/v1/contracts") && init.method === "PATCH" && bodyOf(init).includes(`refund ${r1.id} `));
    const w1 = await webhook(failedEvent(r1));
    dashRefund(pi, 4000); const w2 = await webhook(refundedEvent(pi));
    const b = { ...row(c) };
    later(60); const w3 = await webhook(failedEvent(r1));
    const mid = { ...row(c) };
    const d = await resolve(c, "release"); later(60); await hourly();
    const fl = freelancerGets(plan, 6000);
    vuln(w1.status !== 500 || b.refunded_cents !== 4000 || mid.refunded_cents !== 4000 || d.status !== 200 || sent(c) !== fl || held(c) !== 0 || ledgerP(c, plan).length,
      `Q6 [${name}] 40.00 refunded in the dashboard, it failed; its notice handled halfway (${w1.status}, fault ${FAULT.hit}); made again (${w2.status}): counts ${b.refunded_cents}; the notice again (${w3.status}): counts ${mid.refunded_cents}; 'release' -> ${d.status}: ${show(c)}${report(ledgerP(c, plan))} (must be 4000 given back throughout, the freelancer ${fl})`);
  });
}

// ---------- Q7 price increases while an earlier increase's line is missing ----------
// (Q7a: a second increase's count refused once and sent again: it took the first one's missing line and was never counted;
// Q7b: a second increase paid on two pages, the first one's count refused once: both pages were charged)
const xLineFails = (sX) => async (method, table, search, body) => (method === "POST" && table === "order_payments" && String(body).includes(sX.payment_intent) ? dbError() : null);
for (const [name, mkX, plan] of PLANS) {
  for (const keepXFailing of [true, false]) {
    await guard(`Q7a [${name}] ${keepXFailing}`, async () => {
      const c = mkX(); await fund2(c);
      c.amount_cents += 5000; row(c).amount_cents = c.amount_cents;
      await checkout(c); const sX = pay(row(c).stripe_checkout_id);
      const xHook = xLineFails(sX); hooks.db = xHook;
      const wX = await webhook(completed(sX));
      if (!keepXFailing) hooks.db = null;
      later(10);
      c.amount_cents += 3000; row(c).amount_cents = c.amount_cents;
      await checkout(c); const sA = pay(row(c).stripe_checkout_id);
      let refused = false;
      hooks.db = async (method, table, search, body) => { if (keepXFailing) { const x = await xHook(method, table, search, body); if (x) return x; } if (!refused && method === "PATCH" && table === "contracts" && /"funded_cents"/.test(String(body))) { refused = true; return dbError(); } return null; };
      const wA = await webhook(completed(sA)); hooks.db = keepXFailing ? xHook : null;
      later(10); const wA2 = await webhook(completed(sA)); hooks.db = null;
      const mid = row(c).funded_cents;
      for (let i = 0; i < 3; i++) { later(60); await hourly(); }
      const who = (pi) => pi === sX.payment_intent ? "X" : pi === sA.payment_intent ? "A" : "first";
      const backA = STRIPE.refunds.filter(r => r.payment_intent === sA.payment_intent && !(r.metadata && r.metadata.kind === "fee_surplus")).reduce((a, r) => a + r.amount, 0);   // (today's prices: the card-fee surplus goes back as always)
      vuln(mid !== 18000 || row(c).funded_cents !== 18000 || backA !== 0 || lines(c, "fund").length !== 3,
        `Q7a [${name}] increase X (50.00) counted, its line ${keepXFailing ? "still failing" : "failed once"} (${wX.status}); increase A (30.00) charged, its count refused (${wA.status}), sent again (${wA2.status}): the Order counts ${mid} paid in, after 3 hourly runs ${row(c).funded_cents}; fund lines [${lines(c, "fund").map(l => who(l.provider_ref) + ":" + l.amount_cents).join(", ")}]; A sent back ${backA} (must be 18000, three lines, nothing of A sent back)`);
    });
  }
  await guard(`Q7b [${name}]`, async () => {
    const c = mkX(); await fund2(c);
    c.amount_cents += 5000; row(c).amount_cents = c.amount_cents;
    await checkout(c); const sX = pay(row(c).stripe_checkout_id);
    const xHook = xLineFails(sX); hooks.db = xHook;
    const wX = await webhook(completed(sX));
    later(10);
    c.amount_cents += 5000; row(c).amount_cents = c.amount_cents;
    await checkout(c); const pageA = row(c).stripe_checkout_id;
    let failExpire = true;
    hooks.stripe = async (path) => { if (failExpire && path.endsWith("/expire")) { failExpire = false; return [500, { error: { type: "api_error", message: "An unknown error occurred" } }]; } return null; };
    await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, lang: "de" } })); hooks.stripe = null;
    const pageB = row(c).stripe_checkout_id;
    const sA = pay(pageA), sB = pay(pageB);
    let refused = false;
    hooks.db = async (method, table, search, body) => { const x = await xHook(method, table, search, body); if (x) return x; if (!refused && method === "PATCH" && table === "contracts" && /"funded_cents"/.test(String(body))) { refused = true; return dbError(); } return null; };
    const wA = await webhook(completed(sA)); hooks.db = xHook;
    const wB = await webhook(completed(sB)); hooks.db = null;
    later(10); const wA2 = await webhook(completed(sA));
    for (let i = 0; i < 3; i++) { later(60); await hourly(); }
    const a = STRIPE.intents[sA.payment_intent], b = STRIPE.intents[sB.payment_intent];
    vuln(pageA === pageB || [a.status, b.status].filter(x => x === "succeeded").length !== 1 || row(c).funded_cents !== 20000,
      `Q7b [${name}] increase X (50.00) counted, its line missing (${wX.status}); a second increase of 50.00 paid on two pages, the first one's count refused once (${wA.status}, then ${wB.status}, sent again ${wA2.status}): first page ${a.status}, second ${b.status}; the Order counts ${row(c).funded_cents} paid in (must be: one page charged, 20000)`);
  });
}

// ---------- Q8 a payout whose answer was lost, then a chargeback the freelancer's balance can't cover, lost ----------
const noFunds = async (path, method) => (method === "POST" && /\/reversals$/.test(path)) ? [400, { error: { type: "invalid_request_error", code: "insufficient_funds", message: "Insufficient funds in the connected account to reverse this transfer." } }] : null;
const mstat = (m) => DB.order_milestones.find(x => x.id === m.id).status;
for (const [name, mkX, plan] of PLANS) {
  for (const what of ["whole approve", "whole release", "part"]) {
    await guard(`Q8 [${name}] ${what}`, async () => {
      ready(true);
      const c = mkX({ amount_cents: 20000, price: 200 }); const f = await fund2(c); const ch = chargeOf(f.session.payment_intent);
      let m1 = null;
      if (what === "part") { row(c).status = "funded"; [m1] = ms(c, [6000, 14000]); }
      if (what === "whole release") disputed(c);
      arm("lost", (u, init) => u.includes("api.stripe.com/v1/transfers") && init.method === "POST" && !u.includes("reversals"));
      const a = what === "part" ? await approve(c, m1.id) : what === "whole release" ? await resolve(c, "release") : await approve(c);
      later(15);
      hooks.stripe = noFunds;
      await dispute(c, ch, "needs_response");
      const w = await dispute(c, ch, "lost");
      hooks.stripe = null;
      for (let i = 0; i < 3; i++) { later(60); await hourly(); }
      const p = ledgerP(c, plan).filter(x => x !== "more_out_than_in"), atF = sent(c);   // (a loss Cuvori covered is listed for the owner: more_out_than_in)
      const covered = notes(c).filter(n => /could not be pulled back/.test(n));
      const owes = what === "part" ? freelancerGets(plan, 6000) : freelancerGets(plan, 20000);
      vuln(atF !== owes || !covered.length || p.length || (m1 && mstat(m1) !== "released") || row(c).released_cents < (what === "part" ? 6000 : 20000),
        `Q8 [${name}] ${what}: payout made, its answer lost (${a.status}); the whole payment charged back, the pull-back refused (no money at the freelancer), lost (${w.status}): ${show(c)}${m1 ? ", part 1 " + mstat(m1) : ""}; "Cuvori covered" note: ${covered.length ? '"' + covered[0].slice(0, 70) + '"' : "NONE"}${report(p)} (must be: the payout counted, the note saying what Cuvori covered)`);
    });
  }
}

// ---------- Q9 (older) a part's payout counted while its "paid out" mark was refused: the part stays "approved" ----------
for (const [name, mkX, plan] of PLANS) {
  for (const closer of ["cancel", "refund"]) {
    await guard(`Q9 [${name}] ${closer}`, async () => {
      ready(true); const c = mkX(); await fund2(c); row(c).status = "funded";
      const [m1] = ms(c, [3000, 7000]);
      arm("lost", (u, init) => u.includes("api.stripe.com/v1/transfers") && init.method === "POST" && !u.includes("reversals"));
      await approve(c, m1.id);
      later(15); FAULT.hit = 0;
      arm("refused", (u, init) => u.includes("/rest/v1/order_milestones") && init.method === "PATCH" && bodyOf(init).includes('"status":"released"'));
      const k = closer === "cancel" ? await cancel(c) : (disputed(c), await resolve(c, "refund"));
      const fh = FAULT.hit; FAULT.pred = null;
      for (let i = 0; i < 3; i++) { later(60); await hourly(); }
      const hist = events(c, "milestone_released").filter(e => e.data && e.data.milestone === m1.id).length;
      const card = cards(c, "milestone_approved").filter(m => m.payload && m.payload.label === "part 1").length;
      vuln(fh !== 1 || mstat(m1) !== "released" || hist !== 1 || card !== 1 || held(c) !== 0 || ledgerP(c, plan).length,
        `Q9 [${name}] part 1's payout made (its answer lost); the ${closer === "cancel" ? "freelancer's cancel" : "decision 'refund'"} counted it while the part's "paid out" mark was refused (${fh}) -> ${k.status}; after the hourly runs: ${show(c)}; part 1 ${mstat(m1)}, history lines ${hist}, chat cards ${card} (must be released, 1, 1)`);
    });
  }
}

// ---------- Q10 (older) a cancel or a decision while its first count of the payouts can't be done ----------
// (Stripe's list of payouts refused, the count's write refused, or another step busy on the Order: what the cancel or the
// decision recorded was what had been worked out from the books, not what moved: "100.00 went back" where 40.00 did)
for (const [name, mkX, plan] of PLANS) {
  for (const how of ["cancel", "split"]) {
    for (const [fault, set] of [
      ["Stripe's list of payouts refused", () => { let n = 0; hooks.stripe = async (path, method) => (method === "GET" && /^\/transfers/.test(path) && n++ === 0 ? [500, { error: { type: "api_error", message: "An unknown error occurred" } }] : null); }],
      ["the count's write refused", () => arm("refused", (u, init) => u.includes("/rest/v1/contracts") && init.method === "PATCH" && /"released_cents"/.test(bodyOf(init)))],
    ]) {
      await guard(`Q10 [${name}] ${how} ${fault}`, async () => {
        ready(true); const c = mkX(); await fund2(c); row(c).status = "funded";
        const [m1] = ms(c, [6000, 4000]);
        arm("lost", (u, init) => u.includes("api.stripe.com/v1/transfers") && init.method === "POST" && !u.includes("reversals"));
        await approve(c, m1.id);
        later(15);
        if (how !== "cancel") disputed(c);
        set();
        const r = how === "cancel" ? await cancel(c) : await resolve(c, "split", { editor_percent: 50 });
        hooks.stripe = null; FAULT.pred = null;
        const r2 = r.status === 200 ? r : (later(2), how === "cancel" ? await cancel(c) : await resolve(c, "split", { editor_percent: 50 }));
        for (let i = 0; i < 2; i++) { later(60); await hourly(); }
        const rec = how === "cancel" ? [((events(c, "cancelled").slice(-1)[0] || {}).data || {}).refund_cents]
          : [((events(c, "decision").slice(-1)[0] || {}).data || {}).editor_cents, ((events(c, "decision").slice(-1)[0] || {}).data || {}).refund_cents];
        const must = how === "cancel" ? [4000] : [2000, 2000];
        const j = r2.json || {}, ans = how === "cancel" ? [j.refunded] : [j.editorCents, j.refundCents];
        vuln(r2.status !== 200 || rec.join() !== must.join() || ans.join() !== must.join() || events(c, how === "cancel" ? "cancelled" : "decision").length !== 1,
          `Q10 [${name}] part 1 (60.00) paid at Stripe, its answer lost; then ${how} while ${fault} -> ${r.status}${r === r2 ? "" : `, again -> ${r2.status}`}: answered ${ans.join("/")}, history says ${rec.join("/")} (${events(c, how === "cancel" ? "cancelled" : "decision").length} line(s)); ${show(c)} (must be ${must.join("/")} in both, one line)`);
      });
    }
  }
}

console.error = realError;
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
