// The payment code for the new prices (plan 2, schema v56): every check runs against the fake Stripe and the fake database
// of tests/fn-harness.mjs with schema v56's rules turned on (V56.on: a badly written ledger line, old payment code without
// the x-cuvori-pricing header, a commission total written by hand, a part paid out during a dispute and more paid out and
// given back than paid in are all refused, as the database refuses them). After EVERY plan 2 check every ledger line is
// checked against v56's rules and the Order is reconciled with Stripe (tests/plan2-ledger.mjs: checkLines, reconcile, and
// admin_pricing_check in JavaScript, which must list exactly what the check expects).
//   N1  every request to Supabase carries x-cuvori-pricing: 2 (checked at the end, over the whole suite)
//   N2  €100: the payment page charges exactly €100 (one line, fee 0, payout fee 0, the plan in its details), the answer
//       keeps its shape; approved: the freelancer gets €95, Cuvori keeps €5, the transfer says 10000 / 500 / 9500
//   N3  the €2 minimum: 2.00 in, 1.90 sent, 0.10 kept; N4 a €950,000 Order: 902,500.00 sent, 47,500.00 kept
//   N5  three parts €33.33 / €33.33 / €33.34: 1.67, 1.66, 1.67 kept (5.00 in all)
//   N6  1-cent parts: a payout where 5% would be its whole cent sends the cent (Stripe can't send €0) and the next payout
//       catches it up: 25 parts of a cent and one of €9.75 keep exactly 0.50; parts of 0.10, 0.19, 0.01: 5% on the total
//   N7  one top-up (€100 + €20 increase): €120 in, 6.00 kept on one payout; N8 several top-ups and several payouts
//       (parts paid out between the increases): 5% of everything paid out, to the cent, never twice
//   N9  the automatic release after 14 days (whole Order, and a part) keeps 5% too
//   N10 the freelancer gives the Order back (cancel): the client gets back every cent, one refund line per Stripe refund
//       (also over two payments)
//   N11 Cuvori's decisions: release (95/5), refund (all back), divided 60/40 (57 to the freelancer, 3 kept, 40 back), and
//       divided on an Order with a top-up (the refund over two payments: a line each)
//   N12 payment states: a hold charged when the Order takes it; a payment still processing (nothing recorded, then recorded
//       once it succeeds: the async notice); a hold let go (nothing charged, no line); the price changed while the client
//       was on Stripe's page (the hold let go, nothing charged)
//   N13 the same notice twice, the async notice before the first one, the return page and the webhook at the same moment,
//       two tabs (one page, one payment), two paid pages (the second hold let go)
//   N14 a page that charged a card fee anyway (made before the Order took the new prices, paid without a hold): the fee
//       goes back to the card and is written on the payment's own line
//   N15 standalone fees: the payment's balance entry shows 0; Stripe's fee comes from the Fees report a day later (once,
//       on the payment line); a cancel before that refunds everything at once, whatever the fee
//   N16 a late payment (the Order was cancelled while the card was charged) goes back in full, card fee included, also
//       with standalone fees (nothing waits for Stripe's fee); N16b also when it was charged back and the bank decided for
//       Cuvori, and the hourly run's first read of the Order fails (it waits a run, never guesses today's prices)
//   N17 chargebacks: lost before the payout (the bank takes it from what is held); lost after the payout (95 pulled back
//       on its own line naming its reversal, the bank's 100 written whole, the Order's refund total takes the 95 held, the
//       5% listed "to decide"); won after the payout (95 paid back as a re-payment, "chargeback_won <id>", nothing kept
//       again); a partial chargeback; a chargeback on the top-up after the payout (19 pulled back, never the whole 20); two
//       chargebacks at once (both lost; one won, one lost); won while the Order still holds money, then a decision: the
//       pulled-back part as a re-payment, only the rest with 5%; N17i the whole payment charged back after a decision gave
//       part of it back (the line says all the bank took; "partially won", Stripe giving the refunded part back: what it
//       kept); N17j the pull-back fails at Stripe (the admin's note says the freelancer's 95.00, not the 100.00)
//   N18 a refund made in the Stripe dashboard: while held (counted), after the payout (written whole, counted 0: money that
//       went out twice, listed), sent twice (counted once)
//   N19 failures: the database refusing, or its answer lost, at EVERY write of a payment, an approval, a part's payout, a
//       divided decision, a cancel, a lost chargeback after the payout, a won one and a dashboard refund; Stripe's answer
//       lost at every money step. Then Stripe sends its notices again, the person clicks again and the hourly run comes
//       (later): every case ends with the right money and the right lines
//   N20 the hourly run adds the lines a step could not save (the first payment, a top-up, a part's payout, a re-payment, a
//       lost chargeback's line), so the ledger check's line_missing clears itself; a payout line added afterwards is
//       release_late, keeps the 5% its transfer says and carries Stripe's time of it; and when the next part is approved
//       before the hourly run, the missing line is written first and the 5% comes out right (other kinds: N19's failures)
//   N21 payments paused on purpose (stripe_payments_paused): no page for an Order at either prices; on again, it works
//   N22 a part approved at the very moment a dispute is opened: "Nothing to release right now" (409), nothing paid out
//   N23 today's prices, unchanged: the client pays the fee on top, the freelancer gets the whole price, no entry keys and
//       none of the new fields, the card-fee surplus goes back; a part, a cancel, a lost chargeback after the payout
//   N24 a refund recorded, then failed at Stripe (charge.refund.updated, sent twice): one refund_failed line naming it, the
//       Order counts it back once and its note tells the admin; refunded again in the dashboard, it is counted once more;
//       today's prices on a database with v56 the same (a line without entry key), on today's database (v55) the note only
// Run: node tests/attack-plan2.mjs   (TARGET=<another copy of the repo> runs it against that copy's payment functions)
import { DB, STRIPE, HDR, V56, users, hooks, req, call, mk, past, reset, fns, pay, signed, stripeHandle, onlyDue, uuid } from "./fn-harness.mjs";
import { checkLines, reconcile, listed, commission, ledgerCheck } from "./plan2-ledger.mjs";
const out = [];
// each result is printed as soon as it is known (the fault runs take a while), and counted at the end
const vuln = (cond, m) => { const line = (cond ? "VULNERABLE " : "safe       ") + m; out.push(line); process.stdout.write(line + "\n"); };
const realError = console.error; console.error = process.env.DEBUG ? realError : () => {};
const fx = await fns();
V56.on = true;
STRIPE.balance = 50_000_000_000;                                       // other clients' money in the platform balance
// the clock: the hourly run's repairs wait for a step's own save to be long over
const RealDate = Date; let skew = 0;
globalThis.Date = class extends RealDate { constructor(...a) { if (a.length === 0) super(RealDate.now() + skew); else super(...a); } static now() { return RealDate.now() + skew; } };
const later = (min) => { skew += min * 60e3; };
// a pause in the payment code (waiting for a lock, a moment before a retry) takes no real time: the clock moves on by it
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(() => { if (Number(ms) > 0) skew += Number(ms); fn(...args); }, 0);
const eur = (c) => (c / 100).toFixed(2);
const chargeOf = (pi) => STRIPE.charges[STRIPE.intents[pi].latest_charge];
const webhook = (ev) => call(fx.webhook, req("POST", "x", ev));
const hourly = () => call(fx.autoRelease, req("POST", "x", {}));
const NOTE = "Cuvori looked at the chat and the files.";
const checkout = (c, token = "tok_cl", body = {}) => call(fx.checkout, req("POST", "x", { token, body: { contract_id: c.id, ...body } }));
const approve = (c, milestone_id) => call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, ...(milestone_id ? { milestone_id } : {}) } }));
const cancel = (c) => call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id } }));
const resolve = (c, decision, extra = {}) => call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision, note: NOTE, ...extra } }));
const confirm = (c, sid) => call(fx.confirm, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, session_id: sid } }));
const completed = (s) => signed({ type: "checkout.session.completed", data: { object: s } });
const cbEvent = (type, ch, extra = {}) => signed({ type, data: { object: { id: extra.id || "dp_" + ch.id, object: "dispute", charge: ch.id, payment_intent: ch.payment_intent, amount: extra.amount || ch.amount, currency: "eur", status: extra.status || "needs_response", reason: "fraudulent", created: Math.floor(Date.now() / 1000), ...(extra.balance_transactions ? { balance_transactions: extra.balance_transactions } : {}) } } });
const mk2 = (o = {}) => mk({ pricing_version: 2, commission_bps: 500, commission_cents: 0, auto_days: 14, ...o });
const mk1 = (o = {}) => mk({ pricing_version: 1, commission_bps: 0, commission_cents: 0, ...o });
const lines = (c, kind) => DB.order_payments.filter(p => p.order_id === c.id && (!kind || p.kind === kind));
const tsOf = (c) => STRIPE.transfers.filter(t => t.metadata.contract_id === c.id);
const sent = (c) => tsOf(c).reduce((a, t) => a + t.amount - t.amount_reversed, 0);
const back = (c) => STRIPE.refunds.filter(r => r.contract === c.id && !(r.metadata && ["fee_surplus", "late_payment"].includes(r.metadata.kind))).reduce((a, r) => a + r.amount, 0);
const ms = (c, amounts, status = "submitted") => { c.has_milestones = true; return amounts.map((a, i) => { const m = { id: uuid(), order_id: c.id, title: "part " + (i + 1), amount_cents: a, status, position: i + 1 }; DB.order_milestones.push(m); return m; }); };
async function fund2(c, opts = {}) {
  const r = await checkout(c);
  if (r.status !== 200) return { checkout: r };
  const s = pay(c.stripe_checkout_id, opts);
  const w = await webhook(completed(s));
  return { checkout: r, session: s, webhook: w };
}
async function topUp(c, cents, opts = {}) {
  c.amount_cents += cents;
  const r = await checkout(c); if (r.status !== 200) return { checkout: r };
  const s = pay(c.stripe_checkout_id, opts);
  return { checkout: r, session: s, webhook: await webhook(completed(s)) };
}
// after every plan 2 check: the lines against v56's rules, the Order against Stripe, and what the ledger check lists
function verify(c, expect = [], opts = {}) {
  const fresh = DB.contracts.find(x => x.id === c.id) || c;
  const p = [...checkLines(DB, [c.id]), ...reconcile(DB, STRIPE, fresh, opts)];
  const got = listed(DB, fresh), want = [...expect].sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) p.push(`the ledger check lists [${got.join(", ")}], expected [${want.join(", ")}]`);
  return p;
}
const report = (p) => (p.length ? " PROBLEMS: " + p.slice(0, 6).join("; ") + (p.length > 6 ? ` (+${p.length - 6})` : "") : "");
let FAULT = null;                                                              // the one failure of a run (N19)
const fresh = () => { reset(); };
// a check block that throws (the payment code crashed, or refused a step the check needs) counts as failing, and the suite
// goes on with the next block
async function guard(fn) {
  const before = out.length;
  try { await fn(); }
  catch (e) { vuln(true, `a check stopped half-way: ${e && e.message} (at ${String(e && e.stack || "").split("\n").find(x => x.includes("attack-plan2")) || "?"})`); }
  finally { reset(); FAULT = null; }
  return out.length - before;
}

// ---------- N2 - N4: one payment, one payout ----------
async function onePayout(price) {
  const c = mk2({ amount_cents: price });
  const f = await fund2(c);
  const s = f.session && STRIPE.sessions[s0(c)];
  c.status = "delivered";
  const a = await approve(c);
  const t = tsOf(c)[0] || { metadata: {} };
  return { c, f, a, t, s };
}
function s0(c) { return Object.values(STRIPE.sessions).filter(s => s.client_reference_id === c.id).map(s => s.id)[0]; }
await guard(async () => { // N2 €100
  const { c, f, a, t, s } = await onePayout(10000);
  const page = f.checkout.json || {}, prm = (s && s.params) || {};
  const items = Object.keys(prm).filter(k => /^line_items\[\d+\]\[price_data\]\[unit_amount\]$/.test(k));
  const md = (s && s.metadata) || {};
  const fl = lines(c, "fund")[0] || {}, rl = lines(c, "release")[0] || {};
  const p = verify(c);
  vuln(page.amount !== 10000 || page.fee !== 0 || page.connect !== 0 || page.total !== 10000 || !page.url || items.length !== 1 || s.amount_total !== 10000
    || md.fee_cents !== "0" || md.connect_cents !== "0" || md.pricing_version !== "2" || prm["payment_intent_data[metadata][pricing_version]"] !== "2"
    || fl.fee_cents !== 0 || fl.connect_cents !== 0 || a.status !== 200 || c.status !== "completed" || t.amount !== 9500 || t.metadata.gross_cents !== "10000" || t.metadata.commission_cents !== "500" || t.metadata.payout_cents !== "9500" || t.metadata.pricing_version !== "2"
    || c.released_cents !== 10000 || c.commission_cents !== 500 || rl.commission_cents !== 500 || rl.payout_cents !== 9500 || rl.payout_purpose !== "release" || p.length,
    `N2 €100: the page -> ${JSON.stringify({ amount: page.amount, fee: page.fee, connect: page.connect, total: page.total })}, ${items.length} line(s), Stripe total ${s && s.amount_total}, details fee ${md.fee_cents} / payout fee ${md.connect_cents} / plan ${md.pricing_version}; approved ${a.status} -> ${c.status}, sent ${t.amount} (gross ${t.metadata.gross_cents}, kept ${t.metadata.commission_cents}), paid out ${c.released_cents}, commission ${c.commission_cents} (must be 10000/0/0/10000, 1 line, 10000, 0/0/2; completed, 9500 of 10000, 500)${report(p)}`);
  fresh();
});
await guard(async () => { // N3 the €2 minimum, N4 €950,000
  const a = await onePayout(200), b = await onePayout(95_000_000);
  const pa = verify(a.c), pb = verify(b.c);
  vuln(a.a.status !== 200 || a.t.amount !== 190 || a.c.commission_cents !== 10 || pa.length,
    `N3 the €2 minimum -> approved ${a.a.status}, sent ${eur(a.t.amount)}, kept ${eur(a.c.commission_cents)} (must be 1.90, 0.10)${report(pa)}`);
  vuln(b.f.checkout.status !== 200 || b.f.checkout.json.total !== 95_000_000 || b.a.status !== 200 || b.t.amount !== 90_250_000 || b.c.commission_cents !== 4_750_000 || pb.length,
    `N4 €950,000 -> page total ${b.f.checkout.json && eur(b.f.checkout.json.total)}, approved ${b.a.status}, sent ${eur(b.t.amount)}, kept ${eur(b.c.commission_cents)} (must be 950000.00; 902500.00, 47500.00)${report(pb)}`);
  fresh();
});

// ---------- N5 / N6 rounding ----------
async function parts(amounts, opts = {}) {
  const c = mk2({ amount_cents: amounts.reduce((a, b) => a + b, 0) });
  await fund2(c); const m = ms(c, amounts);
  const res = [];
  for (const x of m) { const r = await approve(c, x.id); res.push(r.status); }
  const kept = lines(c, "release").sort((a, b) => a.created_at < b.created_at ? -1 : 1).map(l => l.commission_cents);
  return { c, res, kept };
}
await guard(async () => { // N5 three parts
  const { c, res, kept } = await parts([3333, 3333, 3334]);
  const p = verify(c);
  vuln(res.some(s => s !== 200) || JSON.stringify(kept) !== "[167,166,167]" || c.commission_cents !== 500 || sent(c) !== 9500 || c.status !== "completed" || p.length,
    `N5 parts €33.33/€33.33/€33.34 -> ${res.join("/")}, kept ${kept.map(eur).join(", ")} (${eur(c.commission_cents)} in all), sent ${eur(sent(c))}, ${c.status} (must be 1.67, 1.66, 1.67; 5.00; 95.00; completed)${report(p)}`);
  fresh();
});
await guard(async () => { // N6 1-cent parts
  const a = await parts([...Array(25).fill(1), 975]);
  const pa = verify(a.c);
  const b = await parts([10, 19, 1, 1, 30, 9, 130]);
  const pb = verify(b.c);
  vuln(a.res.some(s => s !== 200) || a.c.commission_cents !== 50 || sent(a.c) !== 950 || tsOf(a.c).some(t => t.amount < 1) || pa.length,
    `N6a 25 parts of a cent and one of €9.75 -> ${a.res.filter(s => s === 200).length}/26 paid out, kept ${eur(a.c.commission_cents)}, sent ${eur(sent(a.c))}, smallest transfer ${Math.min(...tsOf(a.c).map(t => t.amount))} (must be 26, 0.50, 9.50, at least 1)${report(pa)}`);
  vuln(b.res.some(s => s !== 200) || b.c.commission_cents !== commission(200, 500) || sent(b.c) !== 200 - commission(200, 500) || pb.length,
    `N6b parts of 0.10, 0.19, 0.01, 0.01, 0.30, 0.09, 1.30 -> kept ${b.kept.join("/")} = ${b.c.commission_cents} (must be 5% of 2.00 = ${commission(200, 500)})${report(pb)}`);
  fresh();
});

// ---------- N7 / N8 top-ups ----------
await guard(async () => { // N7 one top-up
  const c = mk2({ amount_cents: 10000 }); await fund2(c); c.status = "funded";
  const u = await topUp(c, 2000);
  c.status = "delivered"; const a = await approve(c);
  const p = verify(c);
  vuln(u.checkout.status !== 200 || u.checkout.json.amount !== 2000 || u.checkout.json.fee !== 0 || u.checkout.json.total !== 2000 || u.checkout.json.kind !== "topup" || a.status !== 200 || c.funded_cents !== 12000 || sent(c) !== 11400 || c.commission_cents !== 600 || p.length,
    `N7 €100 + a €20 increase -> top-up page ${JSON.stringify(u.checkout.json && { amount: u.checkout.json.amount, fee: u.checkout.json.fee, total: u.checkout.json.total, kind: u.checkout.json.kind })}; approved ${a.status}: paid in ${c.funded_cents}, sent ${sent(c)}, kept ${c.commission_cents} (must be 2000/0/2000 topup; 12000, 11400, 600)${report(p)}`);
  fresh();
});
await guard(async () => { // N8 several top-ups, several payouts
  const c = mk2({ amount_cents: 10000 }); await fund2(c); c.status = "funded";
  const [m1, m2] = ms(c, [3333, 6667]);
  const r1 = await approve(c, m1.id);
  const m3 = ms(c, [3001])[0]; const u1 = await topUp(c, 3001);
  const r2 = await approve(c, m2.id);
  const m4 = ms(c, [1777])[0]; const u2 = await topUp(c, 1777);
  const r3 = await approve(c, m3.id), r4 = await approve(c, m4.id);
  const total = 10000 + 3001 + 1777;
  const p = verify(c);
  vuln([r1, r2, r3, r4, u1.webhook, u2.webhook].some(r => !r || r.status !== 200) || c.funded_cents !== total || c.commission_cents !== commission(total, 500) || sent(c) !== total - commission(total, 500) || c.status !== "completed" || p.length,
    `N8 €100, a part, a €30.01 increase, a part, a €17.77 increase, two parts -> paid in ${c.funded_cents}, kept ${c.commission_cents}, sent ${sent(c)}, ${c.status} (must be ${total}, ${commission(total, 500)} = 5% of all of it, ${total - commission(total, 500)}, completed)${report(p)}`);
  fresh();
});

// ---------- N9 automatic release ----------
await guard(async () => {
  const c = mk2(); await fund2(c); c.status = "delivered"; c.auto_release_at = past(1); onlyDue(c);
  const h = await hourly();
  const pa = verify(c);
  const d = mk2(); await fund2(d); d.status = "funded"; const [m] = ms(d, [10000]); m.auto_release_at = past(1); onlyDue(d);
  const h2 = await hourly();
  const pb = verify(d);
  vuln(h.status !== 200 || c.status !== "completed" || sent(c) !== 9500 || c.commission_cents !== 500 || pa.length || h2.status !== 200 || d.status !== "completed" || sent(d) !== 9500 || d.commission_cents !== 500 || pb.length,
    `N9 the automatic release -> whole Order ${c.status}, sent ${sent(c)}, kept ${c.commission_cents}; a part ${d.status}, sent ${sent(d)}, kept ${d.commission_cents} (must be completed, 9500, 500 twice)${report([...pa, ...pb])}`);
  fresh();
});

// ---------- N10 cancel ----------
await guard(async () => {
  const c = mk2(); await fund2(c); c.status = "funded";
  const r = await cancel(c);
  const pa = verify(c);
  const d = mk2(); await fund2(d); d.status = "funded"; await topUp(d, 2500);
  const r2 = await cancel(d);
  const pb = verify(d);
  vuln(r.status !== 200 || c.status !== "refunded" || back(c) !== 10000 || lines(c, "refund").length !== 1 || pa.length || r2.status !== 200 || back(d) !== 12500 || lines(d, "refund").length !== 2 || pb.length,
    `N10 cancel -> ${r.status}, ${c.status}, back ${back(c)} in ${lines(c, "refund").length} line(s); with a top-up -> ${r2.status}, back ${back(d)} in ${lines(d, "refund").length} lines (must be 10000 in 1; 12500 in 2: one per Stripe refund)${report([...pa, ...pb])}`);
  fresh();
});

// ---------- N11 decisions ----------
async function decided(decision, extra = {}, topup = 0) {
  const c = mk2(); await fund2(c); c.status = "funded";
  if (topup) await topUp(c, topup);
  c.status = "disputed"; c.disputed_at = past(); c.dispute_by = users.cl.id;
  const r = await resolve(c, decision, extra);
  return { c, r };
}
await guard(async () => {
  const rel = await decided("release"), ref = await decided("refund"), spl = await decided("split", { editor_percent: 60 }), splT = await decided("split", { editor_percent: 60 }, 5000);
  const p = [rel, ref, spl, splT].map(x => verify(x.c));
  vuln(rel.r.status !== 200 || sent(rel.c) !== 9500 || rel.c.commission_cents !== 500 || p[0].length,
    `N11a decision 'release' -> ${rel.r.status}, sent ${sent(rel.c)}, kept ${rel.c.commission_cents} (must be 9500, 500)${report(p[0])}`);
  vuln(ref.r.status !== 200 || back(ref.c) !== 10000 || sent(ref.c) !== 0 || ref.c.commission_cents !== 0 || p[1].length,
    `N11b decision 'refund' -> ${ref.r.status}, back ${back(ref.c)}, sent ${sent(ref.c)}, kept ${ref.c.commission_cents} (must be 10000, 0, 0)${report(p[1])}`);
  vuln(spl.r.status !== 200 || sent(spl.c) !== 5700 || spl.c.commission_cents !== 300 || back(spl.c) !== 4000 || spl.r.json.editorCents !== 6000 || p[2].length,
    `N11c €100 divided 60/40 -> ${spl.r.status}: the freelancer receives ${eur(sent(spl.c))}, Cuvori keeps ${eur(spl.c.commission_cents)}, the client gets ${eur(back(spl.c))} back (must be 57.00, 3.00, 40.00)${report(p[2])}`);
  vuln(splT.r.status !== 200 || sent(splT.c) !== 8550 || splT.c.commission_cents !== 450 || back(splT.c) !== 6000 || lines(splT.c, "refund").length !== 2 || p[3].length,
    `N11d €100 + €50 divided 60/40 -> sent ${sent(splT.c)}, kept ${splT.c.commission_cents}, back ${back(splT.c)} in ${lines(splT.c, "refund").length} lines (must be 8550, 450, 6000 over both payments: 2 lines)${report(p[3])}`);
  fresh();
});

// ---------- N12 payment states ----------
await guard(async () => { // a hold, charged when the Order takes it
  const c = mk2(); const r = await checkout(c); const s = pay(c.stripe_checkout_id);
  const holdBefore = STRIPE.intents[s.payment_intent].status;
  const w = await webhook(completed(s));
  const p = verify(c);
  vuln(holdBefore !== "requires_capture" || w.status !== 200 || STRIPE.intents[s.payment_intent].status !== "succeeded" || c.status !== "funded" || c.funded_cents !== 10000 || lines(c, "fund").length !== 1 || p.length,
    `N12a a hold (${holdBefore}) -> webhook ${w.status}: ${STRIPE.intents[s.payment_intent].status}, ${c.status}, paid in ${c.funded_cents} (must be charged, funded, 10000)${report(p)}`);
  fresh();
});
await guard(async () => { // still processing (an async payment method), then succeeded: the async notice
  const c = mk2(); await checkout(c); const s = pay(c.stripe_checkout_id);
  const pi = STRIPE.intents[s.payment_intent], ch = chargeOf(s.payment_intent);
  pi.status = "processing";
  const w1 = await webhook(completed(s));
  const during = { status: c.status, lines: lines(c, "fund").length };
  pi.status = "succeeded"; pi.amount_received = pi.amount; ch.captured = true; ch.balance_transaction = ch._bt; STRIPE.balance += ch.amount;
  const paid = { ...STRIPE.sessions[s.id], payment_status: "paid" };
  const w2 = await webhook(signed({ type: "checkout.session.async_payment_succeeded", data: { object: paid } }));
  const p = verify(c);
  vuln(during.status !== "accepted" || during.lines !== 0 || w2.status !== 200 || c.status !== "funded" || c.funded_cents !== 10000 || p.length,
    `N12b a payment still processing -> notice ${w1.status}: ${during.status}, ${during.lines} line(s); then succeeded (${w2.status}) -> ${c.status}, ${c.funded_cents} (must be accepted, 0; funded, 10000)${report(p)}`);
  fresh();
});
await guard(async () => { // a hold let go (the card was never charged); the price changed while the client was on Stripe's page
  const c = mk2(); await checkout(c); const s = pay(c.stripe_checkout_id);
  STRIPE.intents[s.payment_intent].status = "canceled";
  const w = await webhook(completed(s));
  const d = mk2(); await checkout(d); const s2 = pay(d.stripe_checkout_id);
  d.amount_cents = 12000;                                                          // a change both sides accepted, a moment before the webhook
  const w2 = await webhook(completed(s2));
  const r2 = await checkout(d);
  const p = [...verify(c), ...verify(d)];
  vuln(c.status !== "accepted" || lines(c).length !== 0 || STRIPE.intents[s2.payment_intent].status !== "canceled" || d.status !== "accepted" || lines(d).length !== 0 || r2.status !== 200 || r2.json.amount !== 12000 || r2.json.fee !== 0 || p.length,
    `N12c a hold let go (${w.status}) -> ${c.status}, ${lines(c).length} lines; the price changed while on Stripe's page (${w2.status}) -> its hold ${STRIPE.intents[s2.payment_intent].status}, ${d.status}; the new page ${r2.status} for ${r2.json && r2.json.amount} (must be accepted, 0; canceled, accepted; 12000 with fee 0)${report(p)}`);
  fresh();
});

// ---------- N13 duplicates and races ----------
await guard(async () => {
  const c = mk2(); await checkout(c); const s = pay(c.stripe_checkout_id);
  const [a, b] = await Promise.all([webhook(completed(s)), webhook(completed(s))]);
  const again = await webhook(completed(s));
  const pa = verify(c);
  // the async notice before the first one
  const d = mk2(); await checkout(d); const s2 = pay(d.stripe_checkout_id);
  const x = await webhook(signed({ type: "checkout.session.async_payment_succeeded", data: { object: s2 } })), y = await webhook(completed(s2));
  const pb = verify(d);
  // the return page and the webhook at the same moment
  const e = mk2(); await checkout(e); const s3 = pay(e.stripe_checkout_id);
  const [rp, wh] = await Promise.all([confirm(e, s3.id), webhook(completed(s3))]);
  const pc = verify(e);
  vuln([a, b, again, x, y, wh].some(r => r.status !== 200) || rp.status !== 200 || lines(c, "fund").length !== 1 || c.funded_cents !== 10000 || lines(d, "fund").length !== 1 || d.funded_cents !== 10000 || lines(e, "fund").length !== 1 || e.funded_cents !== 10000 || [...pa, ...pb, ...pc].length,
    `N13a the same notice three times (two at once) -> ${lines(c, "fund").length} line, ${c.funded_cents}; the async notice first -> ${lines(d, "fund").length}, ${d.funded_cents}; the return page and the webhook at once (${rp.status}/${wh.status}) -> ${lines(e, "fund").length}, ${e.funded_cents} (must be 1 line and 10000 each time)${report([...pa, ...pb, ...pc])}`);
  fresh();
});
await guard(async () => { // two tabs: one page; two paid pages: the second hold let go
  const c = mk2();
  const [t1, t2] = await Promise.all([checkout(c), checkout(c)]);
  const s = pay(c.stripe_checkout_id); await webhook(completed(s));
  const pa = verify(c);
  const d = mk2();
  const A = await checkout(d, "tok_cl", { lang: "en" }); const idA = d.stripe_checkout_id;
  const B = await checkout(d, "tok_cl", { lang: "de" }); const idB = d.stripe_checkout_id;
  const sB = pay(idB); STRIPE.sessions[idA].status = "open"; const sA = pay(idA);    // the old page paid anyway (an old tab)
  const wB = await webhook(completed(sB)), wA = await webhook(completed(sA));
  const pb = verify(d);
  vuln(t1.status !== 200 || t2.status !== 200 || t1.json.url !== t2.json.url || c.funded_cents !== 10000 || pa.length || A.status !== 200 || B.status !== 200 || idA === idB || wA.status !== 200 || wB.status !== 200
    || STRIPE.intents[sA.payment_intent].status !== "canceled" || d.funded_cents !== 10000 || lines(d, "fund").length !== 1 || pb.length,
    `N13b two tabs at once -> ${t1.status}/${t2.status}, the same page: ${t1.json && t2.json && t1.json.url === t2.json.url}, paid in ${c.funded_cents}; two pages both paid -> the old one's hold ${STRIPE.intents[sA.payment_intent].status}, paid in ${d.funded_cents}, ${lines(d, "fund").length} line (must be the same page, 10000; canceled, 10000, 1)${report([...pa, ...pb])}`);
  fresh();
});

// ---------- N14 a page that charged a card fee anyway ----------
await guard(async () => {
  const c = mk2();
  const prm = new URLSearchParams({ mode: "payment", client_reference_id: c.id, "line_items[0][price_data][unit_amount]": "10000", "line_items[0][price_data][currency]": "eur", "line_items[1][price_data][unit_amount]": "350",
    "metadata[contract_id]": c.id, "metadata[amount_cents]": "10000", "metadata[fee_cents]": "350", "metadata[connect_cents]": "0", "metadata[kind]": "fund", "payment_intent_data[transfer_group]": `contract_${c.id}` });
  const [, sess] = stripeHandle("/checkout/sessions", "POST", prm); c.stripe_checkout_id = sess.id;
  const s = pay(sess.id);                                                          // no hold: charged at once
  const w = await webhook(completed(s));
  const l = lines(c, "fund")[0] || {};
  const feeBack = STRIPE.refunds.filter(r => r.payment_intent === s.payment_intent && r.metadata.kind === "fee_surplus").reduce((a, r) => a + r.amount, 0);
  const p = verify(c);
  vuln(w.status !== 200 || c.funded_cents !== 10000 || l.fee_cents !== 350 || l.fee_refund_cents !== 350 || !/^re_/.test(l.fee_refund_ref || "") || feeBack !== 350 || p.length,
    `N14 a page with a €3.50 card fee paid without a hold (${w.status}) -> paid in ${c.funded_cents}, the line's fee ${l.fee_cents}, refunded on it ${l.fee_refund_cents} (${l.fee_refund_ref}), back at Stripe ${feeBack} (must be 10000, 350, 350 with its refund id, 350)${report(p)}`);
  fresh();
});

// ---------- N15 standalone fees ----------
await guard(async () => {
  const c = mk2(); await fund2(c, { standalone: true, fee: 175 }); c.status = "funded";
  const before = lines(c, "fund")[0].provider_fee_cents;
  const r = await cancel(c);                                                       // right away: the fee is not known yet
  const pa = verify(c);
  const d = mk2(); await fund2(d, { standalone: true, fee: 175, feeTax: 20 }); d.status = "funded";
  STRIPE.reports.instant = true; later(26 * 60); STRIPE.reports.end = Math.floor(Date.now() / 1000) - 60;
  await hourly(); later(60); await hourly();
  STRIPE.reports.instant = false;
  const l = lines(d, "fund")[0];
  const anyRefund = STRIPE.refunds.filter(x => x.payment_intent === l.provider_ref).length;
  const pb = verify(d);
  vuln(before !== null && before !== undefined || r.status !== 200 || back(c) !== 10000 || pa.length || l.provider_fee_cents !== 195 || anyRefund !== 0 || pb.length,
    `N15 standalone fees: the balance entry shows 0 -> Stripe's fee on the line ${before}; a cancel right away (${r.status}) -> back ${back(c)}; a day later the Fees report -> fee ${l.provider_fee_cents} on the line, refunds ${anyRefund} (must be empty, 10000; 195 = 175 + tax 20, none)${report([...pa, ...pb])}`);
  fresh();
});

// ---------- N16 late payments ----------
async function latePayment(opts = {}) {
  const c = mk2(); await checkout(c); const s = pay(c.stripe_checkout_id, opts);
  hooks.stripe = async (path, method) => { if (method === "POST" && /\/capture$/.test(path)) c.status = "cancelled"; return null; };   // cancelled while the card is charged
  const w = await webhook(completed(s)); hooks.stripe = null;
  const ch = chargeOf(s.payment_intent);
  return { c, w, ch, refunded: STRIPE.refunds.filter(r => r.payment_intent === s.payment_intent && r.metadata.kind === "late_payment").reduce((a, r) => a + r.amount, 0) };
}
await guard(async () => {
  const a = await latePayment(), b = await latePayment({ standalone: true, fee: 175 });
  const ev = DB.order_events.find(e => e.order_id === a.c.id && e.event === "late_payment_refunded") || { data: {} };
  const p = [...verify(a.c), ...verify(b.c)];
  vuln(a.w.status !== 200 || a.refunded !== a.ch.amount || ev.data.card_fee_cents !== 0 || !ev.data.full || lines(a.c).length || b.w.status !== 200 || b.refunded !== b.ch.amount || p.length,
    `N16 a late payment of ${a.ch.amount} -> back ${a.refunded} (history: card fee ${ev.data.card_fee_cents}, full ${ev.data.full}); with standalone fees -> back ${b.refunded} at once (must be all of it, card fee 0, full; all of it)${report(p)}`);
  fresh();
});

await guard(async () => {
  // N16b the late payment's client also charged it back: Cuvori waits for the bank; the bank decides for Cuvori, and the
  // hourly run sends the payment back, in full, also when its first read of the Order fails (it waits for the next run
  // instead of guessing today's prices and keeping the card fee)
  const c = mk2(); await checkout(c); const s = pay(c.stripe_checkout_id);
  const ch = chargeOf(s.payment_intent);
  hooks.stripe = async (path, method) => { if (method === "POST" && /\/capture$/.test(path)) { c.status = "cancelled"; STRIPE.disputes[ch.id] = { id: "dp_" + ch.id, status: "needs_response" }; } return null; };
  const w = await webhook(completed(s)); hooks.stripe = null;
  const waited = ch.amount_refunded;
  STRIPE.disputes[ch.id].status = "won";
  await webhook(cbEvent("charge.dispute.closed", ch, { status: "won" }));
  later(60);
  let failed = 0;
  hooks.db = async (method, table, search) => (method === "GET" && table === "contracts" && search.includes(`id=eq.${c.id}`) && /refundOrphanNow/.test(new Error().stack) && !failed++
    ? new Response(JSON.stringify({ message: "canceling statement due to statement timeout" }), { status: 500, headers: { "content-type": "application/json" } }) : null);
  await hourly(); hooks.db = null;
  for (let i = 0; i < 3; i++) { later(60); await hourly(); }
  const ev = DB.order_events.find(e => e.order_id === c.id && e.event === "late_payment_refunded") || { data: {} };
  vuln(w.status !== 200 || waited !== 0 || failed !== 1 || ch.amount_refunded !== ch.amount || ev.data.card_fee_cents !== 0 || !ev.data.full,
    `N16b a late payment also charged back -> waits (${w.status}, back ${waited}); the bank decides for Cuvori, the hourly run's first read of the Order fails (${failed}) -> back ${ch.amount_refunded} of ${ch.amount} (history: card fee ${ev.data.card_fee_cents}, full ${ev.data.full}) (must be 0; then all of it, card fee 0, full)`);
  fresh();
});

// ---------- N17 chargebacks ----------
const dispute = async (c, ch, status, extra = {}) => {
  STRIPE.disputes[ch.id] = { ...(STRIPE.disputes[ch.id] || {}), id: extra.id || "dp_" + ch.id, status, ...(extra.amount ? { amount: extra.amount } : {}) };
  const type = ["won", "lost", "warning_closed"].includes(status) ? "charge.dispute.closed" : "charge.dispute.created";
  return webhook(cbEvent(type, ch, { status, ...extra }));
};
const paidOut = async (topup = 0) => { const c = mk2(); const f = await fund2(c); c.status = "funded"; const u = topup ? await topUp(c, topup) : null; c.status = "delivered"; await approve(c); return { c, ch: chargeOf(f.session.payment_intent), ch2: u && chargeOf(u.session.payment_intent) }; };
await guard(async () => { // lost before the payout
  const c = mk2(); const f = await fund2(c); c.status = "funded"; const ch = chargeOf(f.session.payment_intent);
  const w1 = await dispute(c, ch, "needs_response"), w2 = await dispute(c, ch, "lost");
  const p = verify(c);
  const cb = lines(c, "chargeback")[0] || {};
  vuln(w1.status !== 200 || w2.status !== 200 || c.status !== "refunded" || sent(c) !== 0 || cb.amount_cents !== 10000 || c.refunded_cents !== 10000 || p.length,
    `N17a a chargeback lost before the payout -> ${c.status}, sent ${sent(c)}, the bank's line ${cb.amount_cents} (${cb.note}), refunded ${c.refunded_cents} (must be refunded, 0, 10000, 10000)${report(p)}`);
  fresh();
});
await guard(async () => { // lost after the payout
  const { c, ch } = await paidOut();
  const w1 = await dispute(c, ch, "needs_response");
  const rv = lines(c, "reversal")[0] || {};
  const w2 = await dispute(c, ch, "lost");
  const cb = lines(c, "chargeback")[0] || {};
  const p = verify(c, ["to_decide:commission_on_lost_chargeback"]);
  vuln(w1.status !== 200 || w2.status !== 200 || rv.amount_cents !== 9500 || !/^trr_/.test(rv.provider_ref || "") || rv.note !== `chargeback dp_${ch.id}` || sent(c) !== 0 || cb.amount_cents !== 10000 || c.refunded_cents !== 9500 || c.commission_cents !== 500 || /could not be pulled back/.test(c.money_error || "") || p.length,
    `N17b a chargeback lost after the payout -> pulled back ${rv.amount_cents} on its own line (${rv.provider_ref}, "${rv.note}"), the freelancer has ${sent(c)}, the bank's line ${cb.amount_cents} ("${cb.note}"), refunded ${c.refunded_cents}, the 5% ${c.commission_cents} still booked, ${c.status} (must be 9500 on a trr_ line naming the chargeback, 0, 10000, 9500, 500)${report(p)}`);
  fresh();
});
await guard(async () => { // won after the payout
  const { c, ch } = await paidOut();
  const asked = () => DB.rpc_calls.filter(x => x.fn === "pricing_next_commission" && x.args.p_order === c.id).length, before = asked();
  await dispute(c, ch, "needs_response"); const w = await dispute(c, ch, "won");
  const rp = lines(c, "release").find(l => l.payout_purpose === "repay") || {};
  const evs = DB.order_events.filter(e => e.order_id === c.id && e.event === "chargeback_won").length;
  const p = verify(c);
  vuln(w.status !== 200 || sent(c) !== 9500 || rp.amount_cents !== 9500 || rp.commission_cents !== 0 || rp.note !== `chargeback_won dp_${ch.id}` || c.commission_cents !== 500 || evs !== 1 || before !== 1 || asked() !== before || p.length,
    `N17c a chargeback won after the payout (${w.status}) -> the freelancer has ${sent(c)}, re-payment ${rp.amount_cents} keeping ${rp.commission_cents} ("${rp.note}"), commission ${c.commission_cents}, history lines ${evs}, the 5% asked ${before} time(s) for the payout and ${asked() - before} for the re-payment (must be 9500, 9500 keeping 0, chargeback_won <id>, 500, 1, once and never)${report(p)}`);
  fresh();
});
await guard(async () => { // partial: before the payout (then decided), and after the payout
  const c = mk2(); const f = await fund2(c); c.status = "funded"; const ch = chargeOf(f.session.payment_intent);
  await dispute(c, ch, "needs_response", { amount: 4000 }); await dispute(c, ch, "lost", { amount: 4000 });
  const st = c.status, r = await resolve(c, "release");
  const pa = verify(c);
  const { c: d, ch: dch } = await paidOut();
  await dispute(d, dch, "needs_response", { amount: 4000 }); await dispute(d, dch, "lost", { amount: 4000 });
  const pb = verify(d, ["to_decide:commission_on_lost_chargeback"]);
  vuln(st !== "funded" || r.status !== 200 || sent(c) !== 5700 || c.commission_cents !== 300 || pa.length || sent(d) !== 5700 || d.refunded_cents !== 3800 || pb.length,
    `N17d a €40 chargeback lost while held -> ${st}, then 'release' ${r.status}: sent ${sent(c)}, kept ${c.commission_cents}; after the payout -> the freelancer keeps ${sent(d)}, refunded ${d.refunded_cents} (must be funded: the Order goes on with what is held, a bank chargeback is not the two sides' dispute; 5700, 300; 5700, 3800)${report([...pa, ...pb])}`);
  fresh();
});
await guard(async () => { // on the top-up after the payout: never more than the freelancer received from it
  const { c, ch2 } = await paidOut(2000);
  await dispute(c, ch2, "needs_response");
  const pulled = lines(c, "reversal").reduce((a, l) => a + l.amount_cents, 0);
  await dispute(c, ch2, "lost");
  const p = verify(c, ["to_decide:commission_on_lost_chargeback"]);
  vuln(pulled !== 1900 || sent(c) !== 9500 || c.commission_cents !== 600 || p.length,
    `N17e a chargeback on the €20 increase after the payout -> pulled back ${pulled}, the freelancer keeps ${sent(c)}, commission ${c.commission_cents} (must be 1900 = what they received from it, 9500, 600)${report(p)}`);
  fresh();
});
await guard(async () => { // two at once: both lost; one won and one lost
  const { c, ch, ch2 } = await paidOut(2000);
  await dispute(c, ch, "needs_response"); await dispute(c, ch2, "needs_response");
  const noted = /also open on payment/.test(c.money_error || "");
  await dispute(c, ch, "lost"); await dispute(c, ch2, "lost");
  const pa = verify(c, ["to_decide:commission_on_lost_chargeback"]);
  const { c: d, ch: dch, ch2: dch2 } = await paidOut(2000);
  await dispute(d, dch, "needs_response"); await dispute(d, dch2, "needs_response");
  await dispute(d, dch, "won"); await dispute(d, dch2, "lost");
  const pb = verify(d, ["to_decide:commission_on_lost_chargeback"]);
  const rp = lines(d, "release").filter(l => l.payout_purpose === "repay");
  vuln(!noted || sent(c) !== 0 || lines(c, "chargeback").length !== 2 || c.chargeback_status !== "lost" || pa.length || sent(d) !== 9500 || rp.length !== 1 || rp[0].note !== `chargeback_won dp_${dch.id}` || d.commission_cents !== 600 || pb.length,
    `N17f two chargebacks at once (noted: ${noted}), both lost -> the freelancer keeps ${sent(c)}, ${lines(c, "chargeback").length} chargeback lines; one won, one lost -> keeps ${sent(d)}, re-payments ${rp.map(l => l.amount_cents + " " + l.note).join("; ")}, commission ${d.commission_cents} (must be 0, 2; 9500, one naming the won one, 600)${report([...pa, ...pb])}`);
  fresh();
});
await guard(async () => { // won before the payout (nothing pulled back; then decided as usual); a lost one whose notices come in the wrong order
  const c = mk2(); const f = await fund2(c); c.status = "funded"; const ch = chargeOf(f.session.payment_intent);
  await dispute(c, ch, "needs_response"); await dispute(c, ch, "won");
  const st = c.status, pulled = lines(c, "reversal").length, r = await resolve(c, "release");
  const pa = verify(c);
  const { c: d, ch: dch } = await paidOut();
  STRIPE.disputes[dch.id] = { id: "dp_" + dch.id, status: "lost" };
  const w1 = await webhook(cbEvent("charge.dispute.closed", dch, { status: "lost" })), w2 = await webhook(cbEvent("charge.dispute.created", dch, { status: "needs_response" }));
  const pb = verify(d, ["to_decide:commission_on_lost_chargeback"]);
  vuln(st !== "funded" || pulled !== 0 || r.status !== 200 || sent(c) !== 9500 || pa.length || w1.status !== 200 || w2.status !== 200 || d.chargeback_status !== "lost" || sent(d) !== 0 || lines(d, "chargeback").length !== 1 || pb.length,
    `N17h won before the payout -> ${st}, ${pulled} pull-backs, then 'release' ${r.status}: sent ${sent(c)}; lost after the payout with the "closed" notice first (${w1.status}, then "created" ${w2.status}) -> ${d.chargeback_status}, the freelancer keeps ${sent(d)}, ${lines(d, "chargeback").length} chargeback line (must be funded (the Order goes on where it was), 0, 9500; lost, 0, 1)${report([...pa, ...pb])}`);
  fresh();
});
await guard(async () => { // won while the Order still holds money, then Cuvori's decision: the pulled-back part as a re-payment, only the rest with 5%
  const c = mk2(); const f = await fund2(c); c.status = "funded"; const ch = chargeOf(f.session.payment_intent);
  const [m1] = ms(c, [6000, 4000]); await approve(c, m1.id);
  await dispute(c, ch, "needs_response");
  const pulled = lines(c, "reversal").reduce((a, l) => a + l.amount_cents, 0);
  await dispute(c, ch, "won");
  const r = await resolve(c, "release");
  const rp = lines(c, "release").filter(l => l.payout_purpose === "repay"), last = lines(c, "release").filter(l => l.payout_purpose === "release");
  const p = verify(c);
  vuln(pulled !== 5700 || r.status !== 200 || sent(c) !== 9500 || rp.length !== 1 || rp[0].amount_cents !== 5700 || c.commission_cents !== 500 || last.length !== 2 || last[1].commission_cents !== 200 || p.length,
    `N17g a part paid out, a chargeback won while €40 is still held (pulled back ${pulled}), then 'release' ${r.status} -> the freelancer has ${sent(c)}, re-payment ${rp.map(l => l.amount_cents).join("/")}, the rest kept ${last[1] && last[1].commission_cents}, commission ${c.commission_cents} (must be 5700; 9500, 5700, 200, 500)${report(p)}`);
  fresh();
});

await guard(async () => {
  // N17i a decision gave €40 back and €57 to the freelancer (€3 kept); then the client's bank charges back the whole €100
  // (it can, after a partial refund) and decides for the client: the bank's line says all it took, 100, of which the Order
  // counts the 57 that came back from the freelancer, and the check lists the €40 that went out twice. When Stripe gives
  // the €40 back because the refund was proven ("partially won": the dispute's balance entries are -100 and +40) the line
  // and the Order's chargeback amount say 60, and nothing went out twice
  const run = async (bts) => {
    const c = mk2(); const f = await fund2(c); c.status = "disputed"; c.disputed_at = past(); c.dispute_by = users.cl.id;
    const ch = chargeOf(f.session.payment_intent);
    const r = await resolve(c, "split", { editor_percent: 60 });
    const w1 = await dispute(c, ch, "needs_response");
    if (bts) STRIPE.disputes[ch.id].balance_transactions = bts;                  // Stripe's own record says the same
    const w2 = await dispute(c, ch, "lost", bts ? { balance_transactions: bts } : {});
    const cb = lines(c, "chargeback")[0] || {};
    return { c, ok: r.status === 200 && w1.status === 200 && w2.status === 200, cb, got: listed(DB, c) };
  };
  const a = await run(null);
  const pa = verify(a.c, ["more_out_than_in", "to_decide:commission_on_lost_chargeback"]);
  const b = await run([{ id: "txn_cb1", object: "balance_transaction", amount: -10000, fee: 1500, currency: "eur" }, { id: "txn_cb2", object: "balance_transaction", amount: 4000, fee: 0, currency: "eur" }]);
  const pb = verify(b.c, ["to_decide:commission_on_lost_chargeback"]);
  vuln(!a.ok || a.cb.amount_cents !== 10000 || a.cb.note !== "chargeback_lost counted 5700" || a.c.refunded_cents !== 9700 || a.c.chargeback_cents !== 10000 || pa.length
    || !b.ok || b.cb.amount_cents !== 6000 || b.cb.note !== "chargeback_lost counted 5700" || b.c.refunded_cents !== 9700 || b.c.chargeback_cents !== 6000 || pb.length,
    `N17i €40 given back and €57 paid out, then the whole €100 charged back and lost -> the bank's line ${a.cb.amount_cents} ("${a.cb.note}"), refunded ${a.c.refunded_cents}, chargeback ${a.c.chargeback_cents}, listed [${a.got}]; "partially won" (Stripe gave the €40 back) -> line ${b.cb.amount_cents} ("${b.cb.note}"), chargeback ${b.c.chargeback_cents}, listed [${b.got}] (must be 10000 counted 5700, 9700, 10000, money out twice; 6000 counted 5700, 6000, nothing out twice)${report([...pa, ...pb])}`);
  fresh();
});
await guard(async () => {
  // N17j the pull-back fails at Stripe (the freelancer's account has no money), the chargeback is lost after the payout:
  // the admin's note says what the freelancer kept, 95.00 (the 5.00 was Cuvori's own commission, never with them)
  const { c, ch } = await paidOut();
  hooks.stripe = async (path, method) => (method === "POST" && /\/reversals$/.test(path) ? [400, { error: { type: "invalid_request_error", message: "Insufficient funds in the connected account" } }] : null);
  const w1 = await dispute(c, ch, "needs_response"), w2 = await dispute(c, ch, "lost"); hooks.stripe = null;
  const cb = lines(c, "chargeback")[0] || {};
  const p = verify(c, ["more_out_than_in"]);
  const said = ((c.money_error || "").match(/([0-9]+\.[0-9]{2}) could not be pulled back/) || [])[1];
  vuln(w1.status !== 200 || w2.status !== 200 || sent(c) !== 9500 || said !== "95.00" || cb.amount_cents !== 10000 || c.commission_cents !== 500 || p.length,
    `N17j the pull-back fails at Stripe, the chargeback is lost after the payout (${w1.status}, ${w2.status}) -> the freelancer keeps ${sent(c)}, the note says ${said} could not be pulled back, the bank's line ${cb.amount_cents} ("${cb.note}"), commission ${c.commission_cents} (must be 9500, 95.00, 10000, 500)${report(p)}`);
  fresh();
});

// ---------- N18 a refund made in the Stripe dashboard ----------
const dashRefund = (ch, cents) => { const r = { id: "re_dash" + Math.random().toString(36).slice(2, 10), object: "refund", created: Date.now() / 1000, amount: cents, metadata: {}, payment_intent: ch.payment_intent, charge: ch.id, status: "succeeded" }; STRIPE.refunds.push(r); ch.amount_refunded += cents; STRIPE.balance -= cents; return r; };
const refundedEvent = (ch) => signed({ type: "charge.refunded", data: { object: { id: ch.id, object: "charge", amount: ch.amount, amount_refunded: ch.amount_refunded, refunded: ch.amount_refunded >= ch.amount, currency: "eur", payment_intent: ch.payment_intent } } });
await guard(async () => {
  const c = mk2(); const f = await fund2(c); c.status = "funded"; const ch = chargeOf(f.session.payment_intent);
  dashRefund(ch, 3000); const w1 = await webhook(refundedEvent(ch)), w1b = await webhook(refundedEvent(ch));
  const counted = c.refunded_cents, st = c.status;
  const r = await resolve(c, "refund");
  const pa = verify(c);
  const { c: d, ch: dch } = await paidOut();
  dashRefund(dch, 3000); const w2 = await webhook(refundedEvent(dch));
  const l = lines(d, "refund")[0] || {};
  const pb = verify(d, ["more_out_than_in"]);
  vuln(w1.status !== 200 || w1b.status !== 200 || counted !== 3000 || st !== "disputed" || lines(c, "refund").length !== 2 || r.status !== 200 || back(c) !== 7000 || ch.amount_refunded !== 10000 || pa.length || w2.status !== 200 || l.amount_cents !== 3000 || l.note !== "dashboard_refund counted 0" || d.refunded_cents !== 0 || pb.length,
    `N18 €30 refunded in the dashboard while held (twice the notice) -> counted ${counted}, ${st}, then 'refund' -> Cuvori sends back ${back(c)}, the client has ${ch.amount_refunded} back in all, in ${lines(c, "refund").length} lines; after the payout -> a line of ${l.amount_cents} ("${l.note}"), refunded ${d.refunded_cents} (must be 3000, disputed, 7000, 10000 in 2; 3000 counted 0, 0: listed as money out twice)${report([...pa, ...pb])}`);
  fresh();
});

// ---------- N20 the hourly run adds every kind of line a step could not save ----------
const refuseLines = (pred) => { hooks.db = async (method, table, search, body) => (method === "POST" && table === "order_payments" && pred(JSON.parse(body || "{}")) ? new Response(JSON.stringify({ message: "canceling statement due to statement timeout" }), { status: 500, headers: { "content-type": "application/json" } }) : null); };
await guard(async () => {
  const res = [], bad0 = []; let late = null;
  // the first payment
  { const c = mk2(); refuseLines(l => l.kind === "fund"); await fund2(c); reset(); const miss = lines(c, "fund").length; later(5); await hourly(); res.push(["first payment", c, miss, lines(c, "fund").length]); }
  // a top-up
  { const c = mk2(); await fund2(c); c.status = "funded"; refuseLines(l => l.kind === "fund"); await topUp(c, 2000); reset(); const miss = lines(c, "fund").length; later(5); await hourly(); res.push(["top-up", c, miss, lines(c, "fund").length]); }
  // a part's payout
  { const c = mk2(); await fund2(c); c.status = "funded"; const [m1] = ms(c, [6000, 4000]); refuseLines(l => l.kind === "release"); await approve(c, m1.id); reset(); m1.released_at = past(1); const miss = lines(c, "release").length; later(5); await hourly();
    const l = lines(c, "release")[0] || {}, t = tsOf(c)[0] || {};
    late = { purpose: l.payout_purpose, kept: l.commission_cents, at: l.created_at, stripeAt: t.created && new Date(Math.round(t.created * 1000)).toISOString() };
    res.push(["part's payout", c, miss, lines(c, "release").length]); }
  // a part's payout line not saved, and the next part approved before the hourly run: the missing line first, then the 5%
  { const c = mk2(); await fund2(c); c.status = "funded"; const [m1, m2] = ms(c, [3333, 6667]); refuseLines(l => l.kind === "release"); await approve(c, m1.id); reset();
    const miss = lines(c, "release").length; const r = await approve(c, m2.id);
    const ls = lines(c, "release"), first = ls.find(l => l.milestone_id === m1.id) || {};
    if (r.status !== 200 || first.payout_purpose !== "release_late" || c.commission_cents !== 500 || sent(c) !== 9500) bad0.push(`next part before the hourly run: ${r.status}, the first part's line ${first.payout_purpose}, kept ${c.commission_cents}, sent ${sent(c)} (must be 200, release_late, 500, 9500)`);
    res.push(["next part first", c, miss, ls.length]); }
  // a re-payment
  { const { c, ch } = await paidOut(); await dispute(c, ch, "needs_response"); refuseLines(l => l.payout_purpose === "repay"); await dispute(c, ch, "won"); reset(); const miss = lines(c, "release").length; later(5); await hourly(); res.push(["re-payment", c, miss, lines(c, "release").length]); }
  // a lost chargeback's line (and nothing sends the notice again)
  { const { c, ch } = await paidOut(); await dispute(c, ch, "needs_response"); refuseLines(l => l.kind === "chargeback"); await dispute(c, ch, "lost"); reset(); const miss = lines(c, "chargeback").length; later(5); await hourly(); res.push(["lost chargeback", c, miss, lines(c, "chargeback").length]); }
  const bad = res.map(([what, c, miss, now]) => { const p = verify(c, listedFor(what)); return miss === now || p.length ? `${what}: ${miss} -> ${now} lines${report(p)}` : ""; }).filter(Boolean);
  bad.push(...bad0);
  // a payout line added afterwards: release_late, the 5% from its transfer, Stripe's time of the transfer
  if (!late || late.purpose !== "release_late" || late.kept !== 300 || late.at !== late.stripeAt) bad.push(`the part's payout line added afterwards reads ${JSON.stringify(late)} (must be release_late, 300, at Stripe's time)`);
  vuln(bad.length, `N20 a line the step could not save, added by the hourly run from Stripe's record (first payment, top-up, a part's payout, re-payment, lost chargeback), or by the next payout before it (a part's line) -> ${bad.length ? bad.join(" | ") : "all added, the ledger check clean"}`);
  fresh();
});
function listedFor(what) { return what === "lost chargeback" ? ["to_decide:commission_on_lost_chargeback"] : []; }

// ---------- N21 payments paused on purpose ----------
await guard(async () => {
  DB.site_settings.push({ key: "stripe_payments_paused", value: true });
  const c = mk2(), d = mk1();
  const r2 = await checkout(c), r1 = await checkout(d), noPage = !c.stripe_checkout_id && !d.stripe_checkout_id;
  DB.site_settings.find(r => r.key === "stripe_payments_paused").value = false;
  const again = await checkout(c);
  DB.site_settings.splice(DB.site_settings.findIndex(r => r.key === "stripe_payments_paused"), 1);
  vuln(r2.status !== 503 || r2.json.code !== "payments_paused" || r1.status !== 503 || r1.json.code !== "payments_paused" || !noPage || again.status !== 200,
    `N21 stripe_payments_paused on -> new prices ${r2.status} ${r2.json && r2.json.code}, today's prices ${r1.status} ${r1.json && r1.json.code}, no page made: ${noPage}; off again -> ${again.status} (must be 503 payments_paused twice; 200)`);
  fresh();
});

// ---------- N22 a part approved at the very moment a dispute is opened ----------
await guard(async () => {
  const c = mk2(); await fund2(c); c.status = "funded"; const [m1] = ms(c, [6000, 4000]);
  let once = true;
  hooks.db = async (method, table) => { if (once && method === "PATCH" && table === "order_milestones") { once = false; c.status = "disputed"; } return null; };
  const r = await approve(c, m1.id); reset();
  const p = verify(c);
  vuln(r.status !== 409 || r.json.code !== "nothing_to_release" || r.json.error !== "Nothing to release right now" || sent(c) !== 0 || m1.status !== "submitted" || p.length,
    `N22 a part approved as a dispute opens -> ${r.status} ${JSON.stringify(r.json)}, sent ${sent(c)}, the part ${m1.status} (must be 409 "Nothing to release right now", 0, submitted)${report(p)}`);
  fresh();
});

// ---------- N23 today's prices, unchanged ----------
await guard(async () => {
  const results = [];
  for (const make of [mk1, (o) => mk(o)]) {                                   // plan 1, and an Order from before v56 (no plan)
    const c = make(); const f = await fund2(c); const fee = f.checkout.json.fee, connect = f.checkout.json.connect;
    c.status = "delivered"; const a = await approve(c);
    const d = make(); await fund2(d); d.status = "funded"; const [m1, m2] = ms(d, [6000, 4000]); await approve(d, m1.id); await approve(d, m2.id);
    const e = make(); await fund2(e); e.status = "funded"; await cancel(e);
    const g = make(); const fg = await fund2(g); g.status = "delivered"; await approve(g); const chg = chargeOf(fg.session.payment_intent);
    await dispute(g, chg, "needs_response"); await dispute(g, chg, "lost");
    results.push({ fee, connect, a: a.status, sentC: sent(c), sentD: sent(d), backE: back(e), sentG: sent(g), feeBack: STRIPE.refunds.filter(r => r.contract === c.id && r.metadata.kind === "fee_surplus").length,
      lines: checkLines(DB).filter(x => /today's prices/.test(x)).length, rpc: DB.rpc_calls.filter(x => x.fn === "pricing_next_commission" && [c, d, e, g].some(o => o.id === x.args.p_order)).length,
      keys: [c, d, e, g].flatMap(o => lines(o)).filter(l => l.entry_key != null || l.commission_cents != null || l.payout_purpose != null).length });
  }
  vuln(results.some(r => !(r.fee > 0) || !(r.connect > 0) || r.a !== 200 || r.sentC !== 10000 || r.sentD !== 10000 || r.backE !== 10000 || r.sentG !== 0 || r.feeBack !== 1 || r.lines || r.rpc || r.keys),
    `N23 today's prices (plan 1, and an Order from before v56) -> ${results.map(r => `fee ${r.fee} + payout fee ${r.connect} on top, approved ${r.a}: sent ${r.sentC}, parts ${r.sentD}, cancel back ${r.backE}, after a lost chargeback ${r.sentG}, card-fee surplus back ${r.feeBack}, lines with the new fields ${r.keys}, commission asked ${r.rpc}`).join(" | ")} (must be a fee on top, 10000 whole, 10000, 10000, 0, 1, none, never)`);
  fresh();
});

// ---------- N19 failures at every write ----------
// The database refusing a write ("refused": it answers 500 and writes nothing), its answer lost ("lost": it writes, and the
// answer never arrives), or Stripe's answer lost at a money step (Stripe does it, the answer never arrives). One failure per
// run, at the n-th write of the step, for every n the step has; then what really happens next: Stripe sends its notice
// again, the person clicks again, and the hourly run comes (later, so a step's own lock and its 2 minutes are over).
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (FAULT && !FAULT.fired) {
    const m = init.method || "GET", u = String(url);
    const dbWrite = u.includes("/rest/v1/") && !u.includes("/rest/v1/rpc/") && m !== "GET", stripeMoney = u.includes("api.stripe.com") && m === "POST";
    if ((FAULT.kind === "stripe" ? stripeMoney : dbWrite) && ++FAULT.seen === FAULT.n) {
      FAULT.fired = true; FAULT.at = `${m} ${u.replace(/^https:\/\/[^/]+/, "").split("?")[0]}`;
      if (FAULT.how === "refused" && FAULT.kind === "stripe") return new Response(JSON.stringify({ error: { type: "api_error", message: "An unknown error occurred" } }), { status: 500, headers: { "content-type": "application/json" } });
      if (FAULT.how === "refused") return new Response(JSON.stringify({ message: "canceling statement due to statement timeout" }), { status: 500, headers: { "content-type": "application/json" } });
      await origFetch(url, init);
      const e = new TypeError("fetch failed"); e.cause = { code: "UND_ERR_SOCKET" }; throw e;
    }
  }
  return origFetch(url, init);
};
// an Order checked and done with leaves the tables, so the hourly runs of later runs don't see it
// (with PLAN2_SNAPSHOT set, its rows are kept aside, so tests/attack-plan2-db.mjs can check every Order in the real database)
const ARCH = { contracts: [], order_payments: [], order_milestones: [], order_events: [], money_keys: [] };
const archive = (c) => {
  const pis = new Set(lines(c, "fund").map(l => l.provider_ref).concat(Object.values(STRIPE.charges).filter(ch => ch.transfer_group === `contract_${c.id}`).map(ch => ch.payment_intent)));
  for (const t of ["contracts", "order_payments", "order_milestones", "order_events", "messages", "user_flags"]) { const mine = (r) => r.id === c.id || r.order_id === c.id || r.contract_id === c.id || !!(r.payload && r.payload.contract_id === c.id); if (process.env.PLAN2_SNAPSHOT && ARCH[t]) ARCH[t].push(...DB[t].filter(mine).map(r => ({ ...r }))); const keep = DB[t].filter(r => !mine(r)); DB[t].length = 0; DB[t].push(...keep); }
  if (process.env.PLAN2_SNAPSHOT) ARCH.money_keys.push(...DB.money_keys.filter(k => k.scope.includes(c.id)).map(k => ({ ...k })));
  const keep = DB.money_keys.filter(k => !k.scope.includes(c.id) && ![...pis].some(pi => k.scope.includes(pi))); DB.money_keys.length = 0; DB.money_keys.push(...keep);
};
const heal = async (again) => { for (let i = 0; i < 2; i++) { await again(); later(20); await hourly(); later(20); await hourly(); } };
const FLOWS = {
  "a payment": {
    setup: async () => mk2(),
    step: async (c) => { let r = await checkout(c); if (r.status !== 200) r = await checkout(c); if (r.status !== 200 || !c.stripe_checkout_id) return; const s = pay(c.stripe_checkout_id); c._s = s; await webhook(completed(s)); },
    again: async (c) => { if (c._s) { await webhook(completed(STRIPE.sessions[c._s.id])); await confirm(c, c._s.id); } },
    done: (c) => c.status === "funded" && c.funded_cents === 10000, expect: [],
  },
  "a top-up": {
    setup: async () => { const c = mk2(); await fund2(c); c.status = "funded"; return c; },
    step: async (c) => { c.amount_cents = 12000; let r = await checkout(c); if (r.status !== 200) r = await checkout(c); if (r.status !== 200) return; const s = pay(c.stripe_checkout_id); c._s = s; await webhook(completed(s)); },
    again: async (c) => { if (c._s) { await webhook(completed(STRIPE.sessions[c._s.id])); await confirm(c, c._s.id); } },
    done: (c) => c.funded_cents === 12000, expect: [],
  },
  "an approval": {
    setup: async () => { const c = mk2(); await fund2(c); c.status = "delivered"; return c; },
    step: async (c) => { await approve(c); }, again: async (c) => { if (c.status !== "completed") await approve(c); },
    done: (c) => c.status === "completed" && sent(c) === 9500, expect: [],
  },
  "a part's payout": {
    setup: async () => { const c = mk2(); await fund2(c); c.status = "funded"; c._m = ms(c, [3333, 6667]); return c; },
    step: async (c) => { await approve(c, c._m[0].id); }, again: async (c) => { if (c._m[0].status !== "released") await approve(c, c._m[0].id); c._m[0].released_at = c._m[0].released_at || past(1); },
    finish: async (c) => { await approve(c, c._m[1].id); },
    done: (c) => c.status === "completed" && sent(c) === 9500 && c.commission_cents === 500, expect: [],
  },
  "a divided decision": {
    setup: async () => { const c = mk2(); await fund2(c); c.status = "funded"; await topUp(c, 5000); c.status = "disputed"; c.disputed_at = past(); c.dispute_by = users.cl.id; return c; },
    step: async (c) => { await resolve(c, "split", { editor_percent: 60 }); }, again: async (c) => { if (!["completed", "refunded"].includes(c.status)) await resolve(c, "split", { editor_percent: 60 }); },
    done: (c) => c.status === "completed" && sent(c) === 8550 && back(c) === 6000, expect: [],
  },
  "a cancel": {
    setup: async () => { const c = mk2(); await fund2(c); c.status = "funded"; await topUp(c, 2500); return c; },
    step: async (c) => { await cancel(c); }, again: async (c) => { if (c.status !== "refunded") await cancel(c); },
    done: (c) => c.status === "refunded" && back(c) === 12500, expect: [],
  },
  "a lost chargeback after the payout": {
    setup: async () => { const { c, ch } = await paidOut(); c._ch = ch; return c; },
    step: async (c) => { await dispute(c, c._ch, "needs_response"); await dispute(c, c._ch, "lost"); },
    again: async (c) => { await webhook(cbEvent("charge.dispute.created", c._ch, { status: "needs_response" })); await webhook(cbEvent("charge.dispute.closed", c._ch, { status: "lost" })); },
    done: (c) => sent(c) === 0 && c.chargeback_status === "lost", expect: ["to_decide:commission_on_lost_chargeback"],
  },
  "a won chargeback after the payout": {
    setup: async () => { const { c, ch } = await paidOut(); c._ch = ch; return c; },
    step: async (c) => { await dispute(c, c._ch, "needs_response"); await dispute(c, c._ch, "won"); },
    again: async (c) => { await webhook(cbEvent("charge.dispute.created", c._ch, { status: "needs_response" })); await webhook(cbEvent("charge.dispute.closed", c._ch, { status: "won" })); },
    done: (c) => sent(c) === 9500 && c.chargeback_status === "won", expect: [],
  },
  "an automatic release": {
    setup: async () => { const c = mk2(); await fund2(c); c.status = "delivered"; c.auto_release_at = past(1); onlyDue(c); return c; },
    step: async () => { await hourly(); }, again: async () => {},
    done: (c) => c.status === "completed" && sent(c) === 9500, expect: [],
  },
  "a part's automatic release": {
    setup: async () => { const c = mk2(); await fund2(c); c.status = "funded"; c._m = ms(c, [10000]); c._m[0].auto_release_at = past(1); onlyDue(c); return c; },
    step: async () => { await hourly(); }, again: async (c) => { c._m[0].released_at = c._m[0].released_at || past(1); },
    done: (c) => c.status === "completed" && sent(c) === 9500, expect: [],
  },
  "a lost chargeback on the top-up after the payout": {
    setup: async () => { const { c, ch2 } = await paidOut(2000); c._ch = ch2; return c; },
    step: async (c) => { await dispute(c, c._ch, "needs_response"); await dispute(c, c._ch, "lost"); },
    again: async (c) => { await webhook(cbEvent("charge.dispute.created", c._ch, { status: "needs_response" })); await webhook(cbEvent("charge.dispute.closed", c._ch, { status: "lost" })); },
    done: (c) => sent(c) === 9500 && c.chargeback_status === "lost", expect: ["to_decide:commission_on_lost_chargeback"],
  },
  "two chargebacks at once, both lost": {
    setup: async () => { const { c, ch, ch2 } = await paidOut(2000); c._ch = ch; c._ch2 = ch2; return c; },
    step: async (c) => { await dispute(c, c._ch, "needs_response"); await dispute(c, c._ch2, "needs_response"); await dispute(c, c._ch, "lost"); await dispute(c, c._ch2, "lost"); },
    again: async (c) => { for (const ch of [c._ch, c._ch2]) await webhook(cbEvent("charge.dispute.created", ch, { status: "needs_response" })); for (const ch of [c._ch, c._ch2]) await webhook(cbEvent("charge.dispute.closed", ch, { status: "lost" })); },
    done: (c) => sent(c) === 0 && lines(c, "chargeback").length === 2, expect: ["to_decide:commission_on_lost_chargeback"],
  },
  "a chargeback won while held, then a decision": {
    setup: async () => { const c = mk2(); const f = await fund2(c); c.status = "funded"; c._ch = chargeOf(f.session.payment_intent); const [m1] = ms(c, [6000, 4000]); await approve(c, m1.id); await dispute(c, c._ch, "needs_response"); await dispute(c, c._ch, "won"); return c; },
    step: async (c) => { await resolve(c, "release"); }, again: async (c) => { if (c.status !== "completed") await resolve(c, "release"); },
    done: (c) => c.status === "completed" && sent(c) === 9500 && c.commission_cents === 500, expect: [],
  },
  "a late payment": {
    setup: async () => { const c = mk2(); await checkout(c); c._s = pay(c.stripe_checkout_id); return c; },
    step: async (c) => { hooks.stripe = async (path, method) => { if (method === "POST" && /\/capture$/.test(path)) c.status = "cancelled"; return null; }; await webhook(completed(c._s)); hooks.stripe = null; },
    again: async (c) => { await webhook(completed(STRIPE.sessions[c._s.id])); },
    // cancelled while the card was charged: back in full (or its hold let go); a try that never got as far as the charge
    // finds the Order still waiting, and the payment goes into it
    done: (c) => c.status === "cancelled" ? STRIPE.refunds.filter(r => r.payment_intent === c._s.payment_intent && r.metadata.kind === "late_payment").reduce((a, r) => a + r.amount, 0) === chargeOf(c._s.payment_intent).amount
      || STRIPE.intents[c._s.payment_intent].status === "canceled" : c.status === "funded" && c.funded_cents === 10000, expect: [],
  },
  "a dashboard refund": {
    setup: async () => { const c = mk2(); const f = await fund2(c); c.status = "funded"; c._ch = chargeOf(f.session.payment_intent); return c; },
    step: async (c) => { dashRefund(c._ch, 3000); await webhook(refundedEvent(c._ch)); }, again: async (c) => { await webhook(refundedEvent(c._ch)); },
    done: (c) => c.refunded_cents === 3000 && c.status === "disputed", expect: [],
  },
};
await guard(async () => {
  const tally = [];
  for (const [name, f] of Object.entries(FLOWS).filter(([name]) => !process.env.FLOW || name === process.env.FLOW)) await guard(async () => {
    // a clean run first: how many writes the step has
    const c0 = await f.setup(); FAULT = { kind: "db", n: Infinity, seen: 0 }; await f.step(c0); const writes = FAULT.seen;
    FAULT = { kind: "stripe", n: Infinity, seen: 0 }; FAULT = null; archive(c0);
    const c1 = await f.setup(); FAULT = { kind: "stripe", n: Infinity, seen: 0 }; await f.step(c1); const calls = FAULT.seen; FAULT = null; archive(c1);
    const bad = [];
    for (const [kind, how, n0] of [["db", "refused", writes], ["db", "lost", writes], ["stripe", "lost", calls], ["stripe", "refused", calls]]) {
      for (let n = 1; n <= n0; n++) {
        if (process.env.FAULT_N && (Number(process.env.FAULT_N) !== n || process.env.FAULT_KIND !== `${how} ${kind}`)) continue;
        let c = null, at = null;
        try {
          c = await f.setup();
          FAULT = { kind, how, n, seen: 0 };
          await f.step(c);
          at = FAULT.at; FAULT = null; reset();
          await heal(() => f.again(c));
          if (f.finish) { await f.finish(c); later(20); await hourly(); }
        } catch (e) { FAULT = null; reset(); bad.push(`${how} ${kind} write ${n}: the check stopped half-way: ${e && e.message}`); if (c) archive(c); continue; }
        const p = verify(c, f.expect, { open: c.chargeback_status === "open" });
        if (process.env.FAULT_N) realError("DEBUG", name, how, kind, n, at, JSON.stringify({ status: c.status, released: c.released_cents, refunded: c.refunded_cents, note: c.money_error, cb: c.chargeback_status, ms: DB.order_milestones.filter(m => m.order_id === c.id).map(m => m.status) }), p);
        if (!f.done(c) || p.length) bad.push(`${how} ${kind} write ${n} (${at}): ${c.status}, sent ${sent(c)}, back ${back(c)}, paid in ${c.funded_cents}${report(p)}`);
        archive(c);
      }
    }
    tally.push(`${name} ${writes}+${writes}+${calls}`);
    vuln(bad.length, `N19 ${name}: the database refusing or its answer lost at each of its ${writes} writes, Stripe refusing or its answer lost at each of its ${calls} money calls, then the notices again, a second click and the hourly run -> ${bad.length ? bad.length + " cases end wrong: " + bad.slice(0, 3).join(" | ") : "every case ends with the right money and lines"}`);
  });
});

// ---------- N24 a refund that fails at Stripe after it was recorded ----------
const failRefund = (r, reason = "expired_or_canceled_card") => {
  r.status = "failed"; const ch = STRIPE.charges[STRIPE.intents[r.payment_intent].latest_charge]; ch.amount_refunded -= r.amount;
  return signed({ type: "charge.refund.updated", data: { object: { id: r.id, object: "refund", amount: r.amount, currency: "eur", status: "failed", failure_reason: reason, payment_intent: r.payment_intent, charge: ch.id, metadata: r.metadata || {} } } });
};
const refundsOf = (c) => STRIPE.refunds.filter(r => r.contract === c.id);
await guard(async () => {
  // the new prices: the freelancer gives the Order back, the refund is recorded, then it fails at Stripe
  const c = mk2(); await fund2(c); c.status = "funded";
  await cancel(c);
  const r = refundsOf(c)[0], ev = failRefund(r);
  const w1 = await webhook(ev), w2 = await webhook(ev);                      // the same notice twice
  const failed = lines(c, "refund_failed"), counted = c.refunded_cents, noted = (c.money_error || "").includes(r.id);
  const pa = verify(c, ["money_left_at_cuvori"]);                            // the client's money is at Cuvori again
  // the admin refunds the client again in the Stripe dashboard: Cuvori records it as usual
  const ch = chargeOf(r.payment_intent), again = { id: "re_dashagain" + uuid().slice(0, 6), object: "refund", amount: 10000, contract: c.id, metadata: {}, payment_intent: r.payment_intent, charge: ch.id, status: "succeeded" };
  STRIPE.refunds.push(again); ch.amount_refunded += 10000;
  const w3 = await webhook(signed({ type: "charge.refunded", data: { object: { id: ch.id, object: "charge", amount: ch.amount, amount_refunded: ch.amount_refunded, refunded: ch.amount_refunded >= ch.amount, currency: "eur", payment_intent: ch.payment_intent } } }));
  const pb = verify(c);
  vuln(w1.status !== 200 || w2.status !== 200 || failed.length !== 1 || failed[0].entry_key !== `refund_failed:${r.id}` || failed[0].amount_cents !== 10000 || counted !== 0 || !noted || pa.length
       || w3.status !== 200 || c.refunded_cents !== 10000 || pb.length,
    `N24 a recorded refund of €100 fails at Stripe (notice twice: ${w1.status}, ${w2.status}) -> ${failed.length} refund_failed line (${failed[0] && failed[0].entry_key}, ${failed[0] && failed[0].amount_cents}), the Order counts ${counted} refunded, noted: ${noted}; refunded again in the dashboard (${w3.status}) -> counts ${c.refunded_cents} (must be 1 line refund_failed:<its id> of 10000, 0, noted, listed as money left at Cuvori; then 10000, nothing listed)${report([...pa, ...pb])}`);
  fresh();
});
await guard(async () => {
  // today's prices: the same, on a database that already has v56 (the line, with no entry key), and on today's live
  // database (v55: no such kind of line yet, so only the note, and the books stay as they were)
  const c = mk1(); await fund2(c); c.status = "funded"; await cancel(c);
  const beforeC = c.refunded_cents, r = refundsOf(c).find(x => x.amount >= 10000) || refundsOf(c)[0];
  await webhook(failRefund(r));
  const withV56 = { lines: lines(c, "refund_failed").length, key: (lines(c, "refund_failed")[0] || {}).entry_key, counted: c.refunded_cents, noted: (c.money_error || "").includes(r.id) };
  // refunded again in the Stripe dashboard: today's copy of a dashboard refund counts it again, once
  const chc = chargeOf(r.payment_intent), again = { id: "re_dashagain" + uuid().slice(0, 6), object: "refund", amount: r.amount, contract: c.id, metadata: {}, payment_intent: r.payment_intent, charge: chc.id, status: "succeeded" };
  STRIPE.refunds.push(again); chc.amount_refunded += r.amount;
  const chEv = () => signed({ type: "charge.refunded", data: { object: { id: chc.id, object: "charge", amount: chc.amount, amount_refunded: chc.amount_refunded, refunded: chc.amount_refunded >= chc.amount, currency: "eur", payment_intent: chc.payment_intent } } });
  await webhook(chEv()); await webhook(chEv());
  withV56.again = c.refunded_cents;
  const d = mk1(); await fund2(d); d.status = "funded"; await cancel(d);
  const before = d.refunded_cents, rd = refundsOf(d).find(x => x.amount >= 10000) || refundsOf(d)[0];
  hooks.db = async (method, table, search, body) => (method === "POST" && table === "order_payments" && /refund_failed/.test(body || "")
    ? new Response(JSON.stringify({ code: "23514", message: 'new row for relation "order_payments" violates check constraint "order_payments_kind_check"' }), { status: 400, headers: { "content-type": "application/json" } }) : null);
  const w = await webhook(failRefund(rd));
  hooks.db = null;
  const v55 = { status: w.status, lines: lines(d, "refund_failed").length, counted: d.refunded_cents, noted: (d.money_error || "").includes(rd.id) };
  vuln(withV56.lines !== 1 || withV56.key != null || withV56.counted !== beforeC - r.amount || !withV56.noted || withV56.again !== beforeC || v55.status !== 200 || v55.lines !== 0 || v55.counted !== before || !v55.noted,
    `N24b today's prices: a recorded refund fails at Stripe -> with v56: ${withV56.lines} line (entry key ${withV56.key}), counts ${withV56.counted} refunded, noted ${withV56.noted}, refunded again in the dashboard (notice twice) -> counts ${withV56.again}; on today's database (v55) -> ${v55.status}, ${v55.lines} lines, counts ${v55.counted} (unchanged from ${before}), noted ${v55.noted} (must be 1 line without a key, the refund counted back, noted, then counted once more; 200, 0 lines, unchanged, noted)`);
  fresh();
});

// ---------- N1 the header ----------
vuln(HDR.seen < 100 || HDR.missing.length, `N1 every request to Supabase in this suite carried x-cuvori-pricing: 2 -> ${HDR.seen} with it, ${HDR.missing.length} without${HDR.missing.length ? ": " + HDR.missing.slice(0, 3).join(", ") : ""} (must be none without)`);
// and every plan 2 line written in the whole suite (those still in the tables) against v56's rules
{ const p = checkLines(DB); vuln(p.length, `N1b every ledger line left in the tables against schema v56's rules -> ${p.length ? p.slice(0, 4).join("; ") : "all well written"}`); }

// every Order of the suite, for tests/attack-plan2-db.mjs: the tables, and what the JavaScript ledger check lists for each
if (process.env.PLAN2_SNAPSHOT) {
  const T = Object.fromEntries(Object.keys(ARCH).map(t => [t, [...ARCH[t], ...DB[t].map(r => ({ ...r }))]]));
  const r = ledgerCheck(T);
  const expected = {};
  for (const c of T.contracts) expected[c.id] = [...r.problems.filter(p => p.order === c.id).map(p => p.problem), ...r.to_decide.filter(d => d.order === c.id).map(d => "to_decide:" + d.item)].sort();
  (await import("node:fs")).writeFileSync(process.env.PLAN2_SNAPSHOT, JSON.stringify({ ...T, expected }));
}
console.error = realError;
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
globalThis.Date = RealDate; globalThis.setTimeout = realSetTimeout;
process.exit(badN ? 1 : 0);
