// Check of 13 November (both price plans): a refund made by hand in the Stripe dashboard, found by random sequences of
// payment steps.
// S1 money went out twice (the freelancer paid, then the client's payment refunded in the dashboard): when Cuvori's first try
//    at Stripe's notice broke off at the Order's write (the database not answering for a moment, or its answer lost), Stripe
//    sends it again, and then the Order never said money went out twice (nothing at all when nothing was held any more).
//    Now it says it then too, once (also when the note was saved but not the key that says so); a note marked as handled
//    does not come back when the notice comes yet again.
// S2 a part's payout made with its answer lost, then the whole payment refunded in the dashboard: the Order closed as
//    refunded with no note at all (the freelancer had the part's money, the client all of it back). Now the payout is
//    counted first, and the Order says what went out twice.
// S3 a whole Order's payout or Cuvori's decision made with its answer lost, then a refund in the dashboard: the Order stayed
//    "releasing" or "resolving" for good, the hourly run failing on it, its note saying "Nothing was lost — please try again"
//    (or "Cuvori's database had a problem"). Now the payout is counted first, the Order is finished, and it says what went
//    out twice (also when only part of the payment was refunded). When the books can't take the payout at all, the step's
//    note says so, never "try again".
// S4 a cancel's refund made with its answer lost fails at Stripe before the cancel is finished: the Order then counted it as
//    given back; following its note (refund it again in the dashboard), the Order said money went out twice. Now the failed
//    refund stays counted as come back, and the refund made again is counted as usual.
// S5 what is unchanged: such refunds without a broken-off notice say what they said before (the full refund's note now
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
const MISLEADING = /Nothing was lost|please try again|database had a problem/;

// ---------- S1 a broken-off notice sent again still says money went out twice ----------
for (const [name, mkX, plan] of PLANS) for (const how of ["refused", "lost"]) for (const kind of ["paid out in full", "partly paid out"]) {
  await guard(`S1 [${name}] ${how}, ${kind}`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent;
    let a;
    if (kind === "paid out in full") { row(c).status = "delivered"; a = await approve(c); }
    else { row(c).status = "funded"; const [m1] = ms(c, [6000, 4000]); a = await approve(c, m1.id); }
    later(5);
    const amount = kind === "paid out in full" ? 10000 : 5000, want = kind === "paid out in full" ? 10000 : 1000;
    dashRefund(pi, amount);
    orderWrite(how); const w1 = await webhook(refundedEvent(pi)); const hit = FAULT.hit; FAULT.pred = null; later(60);
    const w2 = await sends(() => refundedEvent(pi)); await hours(1);
    const said = twiceSaid(c), back0 = row(c).refunded_cents;
    vuln(a.status !== 200 || !hit || last(w2) !== 200 || said.length !== 1 || said[0] !== eur(want) || back0 !== (kind === "paid out in full" ? 0 : 4000),
      `S1 [${name}] ${kind} (${a.status}), then ${eur(amount)} refunded in the Stripe dashboard; the first notice broke off at the Order's write (${how}: ${w1.status}), sent again (${w2.join("/")}): money went out twice said ${said.length ? said.join(", ") : "nowhere"}; ${show(c)} (must be: ${eur(want)} said once, the books as without the break)`);
  });
}
// (S1b: said once, marked as handled, the notice comes yet again: it does not come back)
for (const [name, mkX, plan] of PLANS) {
  await guard(`S1b [${name}]`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent;
    row(c).status = "delivered"; await approve(c); later(5);
    dashRefund(pi, 10000); orderWrite("refused"); await webhook(refundedEvent(pi)); FAULT.pred = null; later(60);
    const w2 = await sends(() => refundedEvent(pi)); const said1 = twiceSaid(c).length;
    row(c).money_error = null;                                                          // "Mark as handled"
    later(60); const w3 = await webhook(refundedEvent(pi)); const w4 = await webhook(refundedEvent(pi));
    vuln(last(w2) !== 200 || said1 !== 1 || w3.status !== 200 || w4.status !== 200 || twiceSaid(c).length !== 0,
      `S1b [${name}] money went out twice, said after the notice was sent again (${said1}); marked as handled, the notice twice more (${w3.status}/${w4.status}): said again ${twiceSaid(c).length} (must be: once, then not again)`);
  });
}

// (S1c: the Order's note saved, but the key that says so not: the notice fails, Stripe sends it again, and it is said once)
for (const [name, mkX, plan] of PLANS) {
  await guard(`S1c [${name}]`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent;
    row(c).status = "delivered"; await approve(c); later(5);
    dashRefund(pi, 4000);
    let hit = 0;
    hooks.db = async (m, t, s2, b) => (!hit && m === "POST" && t === "money_keys" && /outside_twice/.test(String(b))) ? (hit++, new Response(JSON.stringify({ message: "canceling statement due to statement timeout" }), { status: 500, headers: { "content-type": "application/json" } })) : null;
    const w1 = await webhook(refundedEvent(pi)); hooks.db = null; later(60);
    const w2 = await sends(() => refundedEvent(pi)); const w3 = await webhook(refundedEvent(pi));
    const said = twiceSaid(c);
    vuln(!hit || w1.status === 200 || last(w2) !== 200 || w3.status !== 200 || said.length !== 1 || said[0] !== "40.00",
      `S1c [${name}] paid out in full, 40.00 refunded in the dashboard; the Order's note saved, the key saying so refused (${hit}): the notice -> ${w1.status}, sent again ${w2.join("/")}, again ${w3.status}: said ${said.join(", ") || "nowhere"} (must be: the notice fails, then 40.00 said once)`);
  });
}

// ---------- S2 a part's payout with its answer lost, then the whole payment refunded in the dashboard ----------
for (const [name, mkX, plan] of PLANS) for (const when of ["at once", "after half an hour"]) {
  await guard(`S2 [${name}] ${when}`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent;
    row(c).status = "funded"; const [m1, m2] = ms(c, [6000, 4000]);
    lostTransfer(); const a = await approve(c, m1.id); FAULT.pred = null;
    if (when !== "at once") later(30);
    dashRefund(pi, chargeOf(pi).amount); const w = await sends(() => refundedEvent(pi)); await hours(3);
    const said = twiceSaid(c);
    // (its note names the payment: a notice sent again knows it was said, twiceOnNote)
    vuln(a.status === 200 || last(w) !== 200 || said.length !== 1 || said[0] !== "60.00" || !notes(c).some(n => TWICE.test(n) && n.includes(pi)) || row(c).released_cents !== 6000 || mstat(m1) !== "released" || row(c).status !== "refunded",
      `S2 [${name}] part 1's 60.00 paid out with its answer lost (${a.status}); the whole payment refunded in the dashboard ${when} (${w.join("/")}): money went out twice said ${said.length ? said.join(", ") : "nowhere"}; ${show(c)}; part 1 ${mstat(m1)}, part 2 ${mstat(m2)}; notes ${JSON.stringify(notes(c).map(n => n.slice(0, 70)))} (must be: the payout counted, part 1 paid out, 60.00 said, the Order refunded)`);
  });
}

// ---------- S3 a whole Order's payout or a decision with its answer lost, then a refund in the dashboard ----------
for (const [name, mkX, plan] of PLANS) for (const kind of ["the client approves", "decided: release", "decided: split 50%"]) {
  await guard(`S3 [${name}] ${kind}`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent;
    let a;
    if (kind === "the client approves") { row(c).status = "delivered"; lostTransfer(); a = await approve(c); }
    else { row(c).status = "funded"; disputed(c); lostTransfer(); a = await resolve(c, kind.includes("split") ? "split" : "release", kind.includes("split") ? { editor_percent: 50 } : {}); }
    FAULT.pred = null; later(15);
    const ch = chargeOf(pi); dashRefund(pi, ch.amount - ch.amount_refunded); const w = await sends(() => refundedEvent(pi)); await hours(4);
    const said = twiceSaid(c), want = kind.includes("split") ? "50.00" : "100.00", gross = kind.includes("split") ? 5000 : 10000;
    vuln(a.status === 200 || last(w) !== 200 || ["releasing", "resolving"].includes(row(c).status) || said.length !== 1 || said[0] !== want || row(c).released_cents !== gross || notes(c).some(n => MISLEADING.test(n)),
      `S3 [${name}] ${kind}, the payout made with its answer lost (${a.status}); the rest of the payment refunded in the dashboard (${w.join("/")}), hourly runs: ${show(c)}; money went out twice said ${said.length ? said.join(", ") : "nowhere"}; notes ${JSON.stringify(notes(c).map(n => n.slice(0, 80)))} (must be: finished, ${want} said, no "try again")`);
  });
}
// (S3c: only part of the payment refunded in the dashboard during the decision under way: the same)
for (const [name, mkX, plan] of PLANS) {
  await guard(`S3c [${name}]`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent;
    row(c).status = "funded"; disputed(c); lostTransfer(); const a = await resolve(c, "release"); FAULT.pred = null; later(15);
    dashRefund(pi, 5000); const w = await sends(() => refundedEvent(pi)); await hours(4);
    const said = twiceSaid(c);
    vuln(a.status === 200 || last(w) !== 200 || row(c).status !== "completed" || said.length !== 1 || said[0] !== "50.00" || row(c).released_cents !== 10000 || notes(c).some(n => MISLEADING.test(n)),
      `S3c [${name}] decided: release, its payout made with its answer lost (${a.status}); 50.00 refunded in the dashboard (${w.join("/")}), hourly runs: ${show(c)}; money went out twice said ${said.join(", ") || "nowhere"}; notes ${JSON.stringify(notes(c).map(n => n.slice(0, 80)))} (must be: completed, 50.00 said)`);
  });
}
// (S3b: the books can't take the payout at all: the database refuses its count at the refund's notice too. The Order's note
// says what to check, and the stopped step's note never says "try again")
for (const [name, mkX, plan] of PLANS) {
  await guard(`S3b [${name}]`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent;
    row(c).status = "delivered"; lostTransfer(); const a = await approve(c); FAULT.pred = null; later(15);
    const sane = () => new Response(JSON.stringify({ code: "23514", message: 'new row for relation "contracts" violates check constraint "contracts_money_sane"' }), { status: 400, headers: { "content-type": "application/json" } });
    let block = true;
    hooks.db = async (m, t, s, b) => (block && m === "PATCH" && t === "contracts" && /"released_cents"/.test(String(b))) ? sane() : null;
    const ch = chargeOf(pi); dashRefund(pi, ch.amount); const w = await sends(() => refundedEvent(pi)); block = false; hooks.db = null;
    await hours(3);
    const step = notes(c).filter(n => n.startsWith("Money step stopped (settlement)")), un = notes(c).filter(n => n.startsWith("payouts not in the books"));
    vuln(a.status === 200 || last(w) !== 200 || un.length !== 1 || step.some(n => MISLEADING.test(n)),
      `S3b [${name}] the whole Order's payout made with its answer lost (${a.status}); the payment refunded in the dashboard while the books can't take the payout (${w.join("/")}); hourly runs: ${show(c)}; notes ${JSON.stringify(notes(c).map(n => n.slice(0, 90)))} (must be: "payouts not in the books" said, the stopped step's note never "try again")`);
  });
}

// ---------- S4 a cancel's refund fails at Stripe before the cancel is finished ----------
for (const [name, mkX, plan] of PLANS) for (const finish of ["the freelancer again", "the hourly run"]) {
  await guard(`S4 [${name}] ${finish}`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 1100, price: 11 }); const f = await fund2(c); const pi = f.session.payment_intent; row(c).status = "funded";
    arm("lost", (u, init) => u.includes("api.stripe.com/v1/refunds") && init.method === "POST" && !/fee_surplus/.test(String(init.body)));
    const a = await cancel(c); FAULT.pred = null;
    const rf = STRIPE.refunds.find(r => r.payment_intent === pi && r.metadata && r.metadata.contract_id && !r.metadata.kind);
    const wf = await webhook(refundFails(rf));
    let b = "";
    if (finish === "the freelancer again") b = String((await cancel(c)).status); else { later(15); await hourly(); }
    await hours(2);
    const s1 = show(c), held1 = held(c), status1 = row(c).status, told = notes(c).some(n => n.startsWith(`refund ${rf.id} `));
    // the admin does what the note says: refunds the 11.00 again in the Stripe dashboard
    dashRefund(pi, 1100); const w2 = await sends(() => refundedEvent(pi)); await hours(1);
    const p = plan === 2 ? ledger(c) : [];
    vuln(a.status === 200 || wf.status !== 200 || !rf || held1 !== 1100 || !told || ["releasing", "resolving"].includes(status1) || last(w2) !== 200 || twiceSaid(c).length || held(c) !== 0 || p.length,
      `S4 [${name}] the freelancer cancels, the refund made with its answer lost (${a.status}); it fails at Stripe (${wf.status}); the cancel finished by ${finish} ${b}: ${s1}, said ${told}; the admin refunds 11.00 again in the dashboard (${w2.join("/")}): ${show(c)}; went out twice said ${twiceSaid(c).join(", ") || "nowhere"}${p.length ? "; ledger " + p.slice(0, 2).join(" | ") : ""} (must be: 11.00 held again until refunded again, nothing said twice)`);
  });
}

// ---------- S5 unchanged: without a broken-off notice ----------
for (const [name, mkX, plan] of PLANS) for (const kind of ["paid out in full", "partly paid out"]) {
  await guard(`S5 [${name}] ${kind}`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); const pi = f.session.payment_intent;
    if (kind === "paid out in full") { row(c).status = "delivered"; await approve(c); } else { row(c).status = "funded"; const [m1] = ms(c, [6000, 4000]); await approve(c, m1.id); }
    later(5);
    dashRefund(pi, kind === "paid out in full" ? chargeOf(pi).amount : 5000); const w = await sends(() => refundedEvent(pi)); const w2 = await webhook(refundedEvent(pi)); await hours(1);
    const said = twiceSaid(c), want = kind === "paid out in full" ? "100.00" : "10.00";
    const named = notes(c).some(n => TWICE.test(n) && n.includes(pi));
    vuln(last(w) !== 200 || w2.status !== 200 || said.length !== 1 || said[0] !== want || !named || row(c).status !== (kind === "paid out in full" ? "completed" : "refunded"),
      `S5 [${name}] ${kind}, then refunded in the dashboard (${w.join("/")}, again ${w2.status}): ${show(c)}; went out twice said ${said.join(", ") || "nowhere"}${named ? ", naming the payment" : ""} (must be: ${want}, once, naming the payment)`);
  });
}

console.error = realError;
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
