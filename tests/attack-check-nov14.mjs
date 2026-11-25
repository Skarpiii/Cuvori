// Check of 14 November (both price plans): two rare cases left over from the check of 13 November.
// T1 two refunds made in the Stripe dashboard on the same payment, each with 10.00 that had already been paid out to the
//    freelancer (money that went out twice). When Cuvori's first try at the second one's notice broke off at the Order's
//    write and Stripe sent it again, the second 10.00 was never said: the Order's note of the first refund names the same
//    payment and the same 10.00, and was taken for it. Now the note of a later one also says the total that went out twice
//    on the payment, so each is told apart; one that landed with its answer lost is still said only once.
// T2 a cancel's refund counted on the Order (its total raised) with its line not saved, then the refund fails at Stripe:
//    the Order kept counting the 11.00 as given back, though the client never got it (the books against Stripe off by
//    11.00; under the new prices the ledger check found only a "refund failed" line). Now the failed refund is counted back
//    and the missing line written, as for any refund that fails; and when the admin refunds it again in the dashboard, as
//    the note says, it is counted as usual, nothing said to have gone out twice.
//    names the payment).
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
// what a line put on the Order's refund total: a refund made in the dashboard after the freelancer was paid counts only what
// was still held ("dashboard_refund counted <cents>" at the new prices, a "dashboard_refund_paid_out" line of its own today)
const countedOf = (l) => l.note === "dashboard_refund_paid_out" ? 0 : (/^dashboard_refund counted (\d+)$/.exec(String(l.note || "")) || [])[1] !== undefined ? Number(/(\d+)$/.exec(l.note)[1]) : l.amount_cents;
const sum = (c, kind) => lines(c, kind).reduce((a, l) => a + countedOf(l), 0);
// the Order's refund total against its lines: refunds less the ones that failed (the database's ledger check counts them so)
const linesAgree = (c) => sum(c, "refund") - sum(c, "refund_failed") === (row(c).refunded_cents || 0);

// the Order's write that says money went out twice (never the try limited to an Order still funded or delivered: that one
// changes nothing on an Order already closed)
const noteWrite = (u, init) => /\/rest\/v1\/contracts/.test(u) && init.method === "PATCH" && /went out twice/.test(String(init.body)) && !/status=in\.\(funded/.test(decodeURIComponent(u));

// ---------- T1 a second refund in the dashboard with money that went out twice, its notice broken off ----------
// (how it broke off: the Order's write refused; the write that says it landed with its answer lost; or the note saved and the
// key that says so refused)
for (const [name, mkX, plan] of PLANS) for (const how of ["refused", "lost", "key refused"]) {
  await guard(`T1 [${name}] ${how}`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent;
    row(c).status = "funded"; const [m1] = ms(c, [9000, 1000]); const a = await approve(c, m1.id); later(5);
    dashRefund(pi, 2000); const w1 = await sends(() => refundedEvent(pi)); const said1 = twiceSaid(c); later(5);
    dashRefund(pi, 1000);
    let keyHit = 0;
    if (how === "refused") orderWrite(how);
    else if (how === "lost") arm("lost", noteWrite);
    else hooks.db = async (m, t, s2, b) => (!keyHit && ["POST", "PATCH"].includes(m) && t === "money_keys" && /outside_twice/.test(String(s2) + String(b)) && /2000/.test(String(b)))
      ? (keyHit++, new Response(JSON.stringify({ message: "canceling statement due to statement timeout" }), { status: 500, headers: { "content-type": "application/json" } })) : null;
    const w2 = await webhook(refundedEvent(pi)); const hit = FAULT.hit + keyHit; FAULT.pred = null; hooks.db = null; later(60);
    const w3 = await sends(() => refundedEvent(pi)); const w4 = await webhook(refundedEvent(pi)); await hours(1);
    const said = twiceSaid(c), total = said.reduce((x, s) => x + Math.round(Number(s) * 100), 0);
    vuln(a.status !== 200 || last(w1) !== 200 || said1.join() !== "10.00" || !hit || last(w3) !== 200 || w4.status !== 200 || said.length !== 2 || total !== 2000 || row(c).refunded_cents !== 1000 || !linesAgree(c),
      `T1 [${name}] part 1's 90.00 paid out (${a.status}); 20.00 refunded in the dashboard (${w1.join("/")}): said ${said1.join(", ") || "nowhere"}; 10.00 more, its first notice broken off at the Order's write (${how}: ${w2.status}), sent again (${w3.join("/")}, again ${w4.status}): money went out twice said ${said.join(", ") || "nowhere"}; ${show(c)}; lines agree ${linesAgree(c)} (must be: 10.00 and 10.00, each once; the Order counts the 10.00 it held)`);
  });
}

// (T1c: a later refund that the Order still held part of, as well as money that went out twice (the Order holds money
// again: Cuvori's own refund failed). Its note landed with its answer lost: the notice sent again finds it, though the Order
// now holds nothing less, and says nothing again)
for (const [name, mkX, plan] of PLANS) {
  await guard(`T1c [${name}]`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent;
    row(c).status = "funded"; const [m1] = ms(c, [9000, 1000]); const a = await approve(c, m1.id); later(5);
    const k = await cancel(c); later(5);
    const own = STRIPE.refunds.find(r => r.payment_intent === pi && r.metadata && r.metadata.contract_id && !r.metadata.kind);
    dashRefund(pi, 2000); const w1 = await sends(() => refundedEvent(pi)); const said1 = twiceSaid(c); later(5);
    const wf = own ? await webhook(refundFails(own)) : { status: "no refund" }; const held1 = held(c); later(5);
    dashRefund(pi, 1500);
    arm("lost", noteWrite); const w2 = await webhook(refundedEvent(pi)); const hit = FAULT.hit; FAULT.pred = null; later(60);
    const w3 = await sends(() => refundedEvent(pi)); await hours(1);
    const said = twiceSaid(c);
    vuln(a.status !== 200 || k.status !== 200 || !own || last(w1) !== 200 || said1.join() !== "20.00" || wf.status !== 200 || held1 !== 1000 || !hit || last(w3) !== 200 || [...said].sort().join() !== "20.00,5.00" || held(c) !== 0 || !linesAgree(c),
      `T1c [${name}] part 1's 90.00 paid out (${a.status}), the rest cancelled (${k.status}); 20.00 refunded in the dashboard (${w1.join("/")}): said ${said1.join(", ") || "nowhere"}; Cuvori's refund of 10.00 fails (${wf.status}): held ${held1}; 15.00 refunded in the dashboard, its note's write landed with its answer lost (${w2.status}), sent again (${w3.join("/")}): money went out twice said ${said.join(", ") || "nowhere"}; ${show(c)}; lines agree ${linesAgree(c)} (must be: 20.00, then 5.00 once; the 10.00 held counted)`);
  });
}

// ---------- T2 a cancel's refund counted with its line lost, then it fails at Stripe ----------
for (const [name, mkX, plan] of PLANS) for (const when of ["before the cancel is finished", "after the cancel is finished"]) {
  await guard(`T2 [${name}] ${when}`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 1100, price: 11 }); const f = await fund2(c); const pi = f.session.payment_intent; row(c).status = "funded";
    let block = true, hit = 0;
    hooks.db = async (m, t, s, b) => (block && m === "POST" && t === "order_payments" && /"kind":"refund"/.test(String(b)) && !/dashboard/.test(String(b)))
      ? (hit++, new Response(JSON.stringify({ message: "canceling statement due to statement timeout" }), { status: 500, headers: { "content-type": "application/json" } })) : null;
    const a = await cancel(c); block = false; hooks.db = null;
    const counted0 = row(c).refunded_cents;
    const rf = STRIPE.refunds.find(r => r.payment_intent === pi && r.metadata && r.metadata.contract_id && !r.metadata.kind);
    if (when.startsWith("after")) await hours(2);
    const wf = rf ? await webhook(refundFails(rf)) : { status: "no refund" };
    await hours(2);
    const s1 = show(c), held1 = held(c), agree1 = linesAgree(c), status1 = row(c).status, told = !!rf && notes(c).some(n => n.startsWith(`refund ${rf.id} `));
    // the admin does what the note says: refunds the 11.00 again in the Stripe dashboard
    dashRefund(pi, 1100); const w2 = await sends(() => refundedEvent(pi)); await hours(1);
    const p = plan === 2 ? ledger(c) : [];
    vuln(a.status === 200 || !hit || counted0 !== 1100 || wf.status !== 200 || held1 !== 1100 || !agree1 || !told || ["releasing", "resolving", "cancelling"].includes(status1)
      || last(w2) !== 200 || held(c) !== 0 || !linesAgree(c) || twiceSaid(c).length || p.length,
      `T2 [${name}] the freelancer cancels; the refund counted (${counted0}), its line refused (${a.status}); it fails at Stripe ${when} (${wf.status}): ${s1}, lines agree ${agree1}, said ${told}; the admin refunds 11.00 again in the dashboard (${w2.join("/")}): ${show(c)}; lines agree ${linesAgree(c)}; went out twice said ${twiceSaid(c).join(", ") || "nowhere"}${p.length ? "; ledger " + p.slice(0, 2).join(" | ") : ""} (must be: 11.00 held again until refunded again, the books agreeing, nothing said twice)`);
  });
}

// (T2c: the same with a top-up: the cancel's refund is made from both payments, two refunds at Stripe (today's prices write
// them on one line, the new prices one line each); the line of both lost, then the first payment's refund fails)
async function topUp(c, cents) { c.amount_cents += cents; row(c).amount_cents = c.amount_cents; const r = await checkout(c); if (r.status !== 200) return { checkout: r }; const s = pay(c.stripe_checkout_id); return { checkout: r, session: s, webhook: await webhook(completed(s)) }; }
for (const [name, mkX, plan] of PLANS) {
  await guard(`T2c [${name}]`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 1100, price: 11 }); const f = await fund2(c); const pi = f.session.payment_intent; row(c).status = "funded";
    const t = await topUp(c, 500); const pi2 = t.session && t.session.payment_intent; row(c).status = "funded";
    let block = true, hit = 0;
    hooks.db = async (m, tb, s2, b) => (block && m === "POST" && tb === "order_payments" && /"kind":"refund"/.test(String(b)) && !/dashboard/.test(String(b)))
      ? (hit++, new Response(JSON.stringify({ message: "canceling statement due to statement timeout" }), { status: 500, headers: { "content-type": "application/json" } })) : null;
    const a = await cancel(c); block = false; hooks.db = null;
    const counted0 = row(c).refunded_cents, ours = STRIPE.refunds.filter(r => r.metadata && r.metadata.contract_id === c.id && !r.metadata.kind);
    const rf = ours.find(r => r.payment_intent === pi);
    const wf = rf ? await webhook(refundFails(rf)) : { status: "no refund" };
    await hours(2);
    const s1 = show(c), held1 = held(c), agree1 = linesAgree(c), told = !!rf && notes(c).some(n => n.startsWith(`refund ${rf.id} `));
    dashRefund(pi, 1100); const w2 = await sends(() => refundedEvent(pi)); await hours(1);
    const p = plan === 2 ? ledger(c) : [];
    vuln(!pi2 || a.status === 200 || !hit || counted0 !== 1600 || ours.length !== 2 || wf.status !== 200 || held1 !== 1100 || !agree1 || !told || last(w2) !== 200 || held(c) !== 0 || !linesAgree(c) || twiceSaid(c).length || p.length,
      `T2c [${name}] a top-up of 5.00 (${t.webhook && t.webhook.status}); the freelancer cancels; ${ours.length} refunds counted (${counted0}), their line refused (${a.status}); the first payment's 11.00 fails at Stripe (${wf.status}): ${s1}, lines agree ${agree1}, said ${told}; the admin refunds 11.00 again in the dashboard (${w2.join("/")}): ${show(c)}; lines agree ${linesAgree(c)}; went out twice said ${twiceSaid(c).join(", ") || "nowhere"}${p.length ? "; ledger " + p.slice(0, 2).join(" | ") : ""} (must be: 11.00 held again until refunded again, the books agreeing, nothing said twice)`);
  });
}

// (T2b: a refund never counted, its answer lost, that fails before the cancel is finished (the check of 13 November): the
// failed notice writes no line for it, and the cancel counts it once; then the books agree with the lines)
for (const [name, mkX, plan] of PLANS) {
  await guard(`T2b [${name}]`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 1100, price: 11 }); const f = await fund2(c); const pi = f.session.payment_intent; row(c).status = "funded";
    arm("lost", (u, init) => u.includes("api.stripe.com/v1/refunds") && init.method === "POST" && !/fee_surplus/.test(String(init.body)));
    const a = await cancel(c); FAULT.pred = null;
    const rf = STRIPE.refunds.find(r => r.payment_intent === pi && r.metadata && r.metadata.contract_id && !r.metadata.kind);
    const wf = rf ? await webhook(refundFails(rf)) : { status: "no refund" }; const n0 = lines(c, "refund").length;
    later(15); await hours(2);
    const s1 = show(c), held1 = held(c), agree1 = linesAgree(c), n1 = lines(c, "refund").length;
    vuln(a.status === 200 || !rf || wf.status !== 200 || n0 !== 0 || held1 !== 1100 || !agree1 || n1 !== 1,
      `T2b [${name}] the freelancer cancels, the refund made with its answer lost (${a.status}); it fails at Stripe (${wf.status}): refund lines ${n0}; the hourly run finishes the cancel: ${s1}; refund lines ${n1}, lines agree ${agree1} (must be: no line until the cancel counts it, then one; 11.00 held again; the books agreeing)`);
  });
}

console.error = realError;
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
