// Protected payments: release, refunds and disputes, against the owner's policy (1 November). Every check runs at the new
// prices (plan 2: 14 days, 5% on payouts) and, where it differs, at today's prices (plan 1: 7 days, no commission), on the
// fake Stripe and the fake database of tests/fn-harness.mjs with schema v56's rules on. The database's own buttons
// (deliver, ask for changes, hand in a part, open a dispute: public.order_action) are copied here as they work in v56.
//   R1  the client's approval: two clicks / two tabs at once give one payout (95.00 sent, 5.00 kept; plan 1: 100.00); a
//       later click moves nothing; a part approved twice at once is paid once
//   R2  the automatic release: a delivery starts 14 days (plan 1: 7); a minute before nothing moves; after it, two hourly
//       runs at the same moment pay exactly once; a third moves nothing
//   R3  a dispute just before the hourly run claims the Order wins (nothing paid, nothing later either); one after the
//       claim is refused and the payout goes once; a dispute and the client's approval at the same moment: one wins
//   R4  the hourly run's list goes out of date: the client sends the work back and the freelancer delivers again (a new
//       period) while the run works through its list: nothing is paid before the new period is over (a whole Order, a
//       part, both prices)
//   R5  several Orders of one freelancer due at once, one failing at Stripe: the others are paid, each from its own
//       payment to the right account; the failed one is paid once on the next run
//   R6  parts and top-ups: parts approved and released on day 14, a top-up paid later, a dispute in the middle (nothing
//       released during it), Cuvori's decision on what is held; 5% only on what is paid out
//   R7  refunds: the freelancer gives the Order back (everything back to the client, nothing kept: no commission on refunded
//       money), Cuvori's refund after a part was paid out (only what is held), a 60/40 decision (57 sent, 3 kept, 40 back), a
//       partial refund over two payments; races: approval against the freelancer's cancel, Cuvori's decision against the
//       hourly run and against the approval: one wins, every cent accounted for
//   R8  failed payouts: the freelancer's Stripe account not ready, Stripe's answer lost, Stripe down: each paid exactly once
//       later; a pull-back after a chargeback lost after the payout
//   R9  a bank chargeback is kept apart from the Order's own dispute: the client's dispute keeps its reason; on an Order
//       nobody disputed the status stays; nothing moves while it is open; once the bank decides for Cuvori the review clock
//       goes on with the time it had left (and pays automatically then), the client can approve, the freelancer can deliver,
//       and nobody is marked as having lost a dispute; a partial chargeback lost while money is held leaves the rest in the
//       Order's own flow
//   R10 a chargeback during a decision or an approval under way: once the bank decides for Cuvori the decision is finished
//       as decided (the client gets exactly the 40.00 of a 60/40), the approval is carried out, and what the chargeback
//       pulled back is paid again once
//   R11 a chargeback lost after a payout whose Stripe answer was lost: the 5% is counted first, so the admin's note is right
//       and the Order ends refunded
//   R12 Cuvori's decisions: only an admin who is not on the Order decides; the decision is on record before money moves
//       (who, what, the amounts, the written reason) also when the hourly run finishes it, both sides read it, the side that
//       lost a dispute it opened is marked; a decision that replaces a stuck one names the one it replaced
//   R13 provider outages: Stripe down, not answering, or acting with its answer lost at each Stripe call of an approval, an
//       automatic release, a cancel, a 60/40 decision and a part's approval; then the retry and the hourly run: every case
//       ends with the right money, nothing held, the ledger reconciled
//   R14 an Order agreed at today's prices keeps them after the switch: 7 days, no commission
//   R15 the hourly run stays inside Netlify's 30 seconds for a scheduled function: with a slow Stripe it stops starting new
//       payouts in time, leaves no Order half-way, and the next runs pay the rest, each once
// Run: node tests/attack-release-policy.mjs   (TARGET=<another copy of the repo> runs it against that copy's functions; V56=off
// runs it on today's database rules, without v56: then only the plan 1 lines apply)
import { DB, STRIPE, V56, users, hooks, req, call, mk, reset, fns, pay, signed, stripeHandle, onlyDue, uuid } from "./fn-harness.mjs";
import { checkLines, reconcile, listed } from "./plan2-ledger.mjs";
const out = [];
const vuln = (cond, m) => { const line = (cond ? "VULNERABLE " : "safe       ") + m; out.push(line); process.stdout.write(line + "\n"); };
const realError = console.error; console.error = process.env.DEBUG ? realError : () => {};
const fx = await fns();
V56.on = process.env.V56 !== "off";                                         // V56=off: today's database rules (v55)
STRIPE.balance = 50_000_000_000;
// a clock the checks move on (days pass between steps); waits inside the payment code take no real time
const RealDate = Date; let skew = 0;
globalThis.Date = class extends RealDate { constructor(...a) { if (a.length === 0) super(RealDate.now() + skew); else super(...a); } static now() { return RealDate.now() + skew; } };
const later = (min) => { skew += min * 60e3; };
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(() => { if (Number(ms) > 0) skew += Number(ms); fn(...args); }, 0);
const DAY = 1440;

// ---------- the steps ----------
const chargeOf = (pi) => STRIPE.charges[STRIPE.intents[pi].latest_charge];
const webhook = (ev) => call(fx.webhook, req("POST", "x", ev));
const hourly = () => call(fx.autoRelease, req("POST", "x", {}));
const NOTE = "Cuvori looked at the chat and the files.";
const checkout = (c) => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
const approve = (c, milestone_id) => call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, ...(milestone_id ? { milestone_id } : {}) } }));
const cancel = (c) => call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id } }));
const resolve = (c, decision, extra = {}, token = "tok_adm") => call(fx.resolve, req("POST", "x", { token, body: { contract_id: c.id, decision, note: NOTE, ...extra } }));
const completed = (s) => signed({ type: "checkout.session.completed", data: { object: s } });
// (as Stripe sends it: every notice of a chargeback carries the time it was opened)
const cbEvent = (type, ch, extra = {}) => signed({ type, data: { object: { id: extra.id || "dp_" + ch.id, object: "dispute", charge: ch.id, payment_intent: ch.payment_intent, amount: extra.amount || ch.amount, currency: "eur", status: extra.status || "needs_response", reason: "fraudulent",
  created: (STRIPE.disputes[ch.id] && STRIPE.disputes[ch.id].created) || Math.floor(Date.now() / 1000) } } });
const mk2 = (o = {}) => mk({ pricing_version: 2, commission_bps: 500, commission_cents: 0, auto_days: 14, ...o });
const mk1 = (o = {}) => mk({ pricing_version: 1, commission_bps: 0, commission_cents: 0, auto_days: 7, ...o });
const PLANS = [["plan 2", mk2, 14, 9500], ["plan 1", mk1, 7, 10000]];
const cof = (c) => DB.contracts.find(x => x.id === c.id) || c;
const lines = (c, kind) => DB.order_payments.filter(p => p.order_id === c.id && (!kind || p.kind === kind));
const tsOf = (c) => STRIPE.transfers.filter(t => t.metadata.contract_id === c.id);
const sent = (c) => tsOf(c).reduce((a, t) => a + t.amount - t.amount_reversed, 0);
const back = (c) => STRIPE.refunds.filter(r => r.contract === c.id && !(r.metadata && ["fee_surplus", "late_payment"].includes(r.metadata.kind))).reduce((a, r) => a + r.amount, 0);
const held = (c) => { const x = cof(c); return (x.funded_cents || 0) - (x.released_cents || 0) - (x.refunded_cents || 0); };
const events = (c) => DB.order_events.filter(e => e.order_id === c.id);
async function fund(c) {
  const r = await checkout(c); if (r.status !== 200) throw new Error("no payment page: " + JSON.stringify(r.json));
  const s = pay(c.stripe_checkout_id);
  await webhook(completed(s));
  return s;
}
async function topUp(c, cents) { c.amount_cents += cents; return fund(c); }
// the database's buttons (order_action / order_milestone_action in v56)
function deliver(c, link = "https://x.test/work") {
  if (!["funded", "paid"].includes(c.status) || c.has_milestones) return "not_allowed";
  Object.assign(c, { status: "delivered", delivered_at: new Date().toISOString(), delivery_url: link, changes_open: false, auto_release_at: new Date(Date.now() + (c.auto_days ?? 7) * 864e5).toISOString() });
  DB.order_events.push({ id: uuid(), order_id: c.id, event: "delivered", actor: c.editor, data: { link }, created_at: new Date().toISOString() });
  return "ok";
}
function openDispute(c, by, note = "the work is not what we agreed") {
  if (c.payment_mode !== "escrow" || !["funded", "delivered"].includes(c.status)) return "not_allowed";
  Object.assign(c, { status: "disputed", dispute_by: by, dispute_reason: note, disputed_at: new Date().toISOString(), auto_release_at: null });
  for (const m of DB.order_milestones) if (m.order_id === c.id) m.auto_release_at = null;
  DB.order_events.push({ id: uuid(), order_id: c.id, event: "disputed", actor: by, data: { note }, created_at: new Date().toISOString() });
  return "ok";
}
function requestChanges(c) {                       // within the paid rounds: the clock stops, back to being worked on
  if (c.status !== "delivered" || !(c.changes_used < (c.revisions || 0))) return "not_allowed";
  Object.assign(c, { status: "funded", changes_used: c.changes_used + 1, changes_open: true, auto_release_at: null }); return "ok";
}
function parts(c, amounts) { c.has_milestones = true; return amounts.map((a, i) => { const m = { id: uuid(), order_id: c.id, title: "part " + (i + 1), amount_cents: a, status: "pending", position: i + 1 }; DB.order_milestones.push(m); return m; }); }
function submit(c, m, link = "https://x.test/part") {
  if (!["funded", "paid"].includes(c.status) || m.status !== "pending") return "not_allowed";
  Object.assign(m, { status: "submitted", submitted_at: new Date().toISOString(), delivery_url: link, auto_release_at: new Date(Date.now() + (c.auto_days ?? 7) * 864e5).toISOString() }); return "ok";
}
function sendPartBack(c, m) { if (m.status !== "submitted" || !(c.changes_used < (c.revisions || 0))) return "not_allowed"; Object.assign(m, { status: "pending", auto_release_at: null }); c.changes_used++; return "ok"; }
const dispute = (c, ch, status, extra = {}) => {
  STRIPE.disputes[ch.id] = { created: Math.floor(Date.now() / 1000), ...(STRIPE.disputes[ch.id] || {}), id: extra.id || "dp_" + ch.id, status, ...(extra.amount ? { amount: extra.amount } : {}) };
  const type = ["won", "lost", "warning_closed"].includes(status) ? "charge.dispute.closed" : "charge.dispute.created";
  return webhook(cbEvent(type, ch, { status, ...extra }));
};
// only the given Orders are due (the others of earlier checks are closed)
const only = (...keep) => { for (const x of DB.contracts) if (!keep.includes(x) && ["delivered", "releasing", "resolving"].includes(x.status)) x.status = "completed"; for (const m of DB.order_milestones) if (!keep.some(k => k.id === m.order_id) && m.status !== "released") m.status = "released"; };
// after a plan 2 check: every line against v56's rules, the Order against Stripe, and what the ledger check lists
function ledgerProblems(c, expect = []) {
  if (!(Number(cof(c).pricing_version) >= 2)) return [];
  const p = [...checkLines(DB, [c.id]), ...reconcile(DB, STRIPE, cof(c))];
  const got = listed(DB, cof(c)), want = [...expect].sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) p.push(`the ledger check lists [${got.join(", ")}], expected [${want.join(", ")}]`);
  return p;
}
const report = (p) => (p.length ? " PROBLEMS: " + p.slice(0, 4).join("; ") : "");
async function guard(name, fn) {
  try { await fn(); }
  catch (e) { vuln(true, `${name} stopped half-way: ${e && e.message} (at ${String(e && e.stack || "").split("\n").find(x => x.includes("attack-release-policy")) || "?"})`); }
  finally { reset(); }
}

// ---------- R1 approval ----------
for (const [plan, make, , paid] of PLANS) await guard(`R1 ${plan}`, async () => {
  const c = make(); await fund(c); deliver(c);
  const [a, b] = await Promise.all([approve(c), approve(c)]);
  const later1 = await approve(c);
  const d = make(); await fund(d); d.status = "funded"; const [m1] = parts(d, [4000, 6000]); submit(d, m1);
  const [x, y] = await Promise.all([approve(d, m1.id), approve(d, m1.id)]);
  const p = [...ledgerProblems(c), ...ledgerProblems(d)];
  vuln(tsOf(c).length !== 1 || sent(c) !== paid || cof(c).status !== "completed" || later1.status !== 409 || tsOf(d).length !== 1 || sent(d) !== paid * 0.4 || p.length,
    `R1 ${plan}: two approvals at once (${a.status}, ${b.status}) -> ${tsOf(c).length} payout, ${sent(c)} sent, ${cof(c).status}; a later click ${later1.status}; a part approved twice at once (${x.status}, ${y.status}) -> ${tsOf(d).length} payout, ${sent(d)} (must be 1, ${paid}, completed; 409; 1, ${paid * 0.4})${report(p)}`);
});

// ---------- R2 the automatic release at its boundary ----------
for (const [plan, make, days, paid] of PLANS) await guard(`R2 ${plan}`, async () => {
  const c = make(); await fund(c); deliver(c); only(c);
  const length = (Date.parse(c.auto_release_at) - Date.now()) / 864e5;
  later(days * DAY - 1); await hourly();
  const before = { status: cof(c).status, n: tsOf(c).length };
  later(2); await Promise.all([hourly(), hourly()]); await hourly();
  const ev = events(c).filter(e => e.event === "auto_released").length;
  const p = ledgerProblems(c);
  vuln(Math.abs(length - days) > 0.001 || before.status !== "delivered" || before.n !== 0 || cof(c).status !== "completed" || tsOf(c).length !== 1 || sent(c) !== paid || ev !== 1 || p.length,
    `R2 ${plan}: a delivery starts ${length.toFixed(3)} days; a minute before -> ${before.status}, ${before.n} payouts; after it, two runs at once and a third -> ${cof(c).status}, ${tsOf(c).length} payout of ${sent(c)}, ${ev} history line (must be ${days}; delivered, 0; completed, 1 of ${paid}, 1)${report(p)}`);
});

// ---------- R3 a dispute at the deadline ----------
for (const [plan, make, days, paid] of PLANS) await guard(`R3 ${plan}`, async () => {
  // just before the claim (while the run checks the Order's payment page at Stripe)
  const c = make(); await fund(c); deliver(c); only(c); later(days * DAY + 1);
  let d1 = null;
  hooks.stripe = async (path) => { if (!d1 && /checkout\/sessions/.test(path)) d1 = openDispute(c, users.cl.id, "the video is too short"); return null; };
  await hourly(); reset(); later(DAY); await hourly();
  // just after the claim (the payout is on its way)
  const e = make(); await fund(e); deliver(e); only(e); later(days * DAY + 1);
  let d2 = null;
  hooks.stripe = async (path, method) => { if (d2 == null && method === "POST" && path === "/transfers") d2 = openDispute(e, users.cl.id); return null; };
  await hourly(); reset();
  // the client's approval and the freelancer's dispute at the same moment
  const f = make(); await fund(f); deliver(f); let d3 = null;
  hooks.stripe = async (path, method) => { if (!d3 && method === "GET" && path.startsWith("/checkout/sessions/")) d3 = openDispute(f, users.ed.id, "the client added work"); return null; };
  const a = await approve(f); reset();
  vuln(d1 !== "ok" || cof(c).status !== "disputed" || tsOf(c).length !== 0 || d2 !== "not_allowed" || cof(e).status !== "completed" || sent(e) !== paid || d3 !== "ok" || a.status !== 409 || sent(f) !== 0,
    `R3 ${plan}: a dispute just before the hourly claim (${d1}) -> ${cof(c).status}, ${tsOf(c).length} payouts a day later; one after the claim -> ${d2}, ${cof(e).status}, ${sent(e)} sent; a dispute just before the approval's claim (${d3}) -> approval ${a.status}, ${sent(f)} sent (must be ok, disputed, 0; not_allowed, completed, ${paid}; ok, 409, 0)`);
});

// ---------- R4 the hourly run's list goes out of date ----------
for (const [plan, make, days] of PLANS) await guard(`R4 ${plan}`, async () => {
  const c = make({ revisions: 2, changes_used: 0 }); await fund(c); deliver(c); only(c); later(days * DAY + 5);
  let did = null;
  hooks.stripe = async (path, method) => { if (!did && method === "GET" && path.startsWith("/checkout/sessions/")) did = [requestChanges(c), deliver(c, "https://x.test/v2")]; return null; };
  await hourly(); reset();
  const left = (Date.parse(cof(c).auto_release_at || 0) - Date.now()) / 864e5, cs = cof(c).status, cp = sent(c);
  const d = make({ revisions: 2, changes_used: 0 }); await fund(d); d.status = "funded"; const [m] = parts(d, [10000]); submit(d, m); only(d); later(days * DAY + 5);
  let did2 = null;
  hooks.stripe = async (path, method) => { if (!did2 && method === "GET" && path.startsWith("/accounts/")) did2 = [sendPartBack(d, m), submit(d, m, "https://x.test/part-v2")]; return null; };
  await hourly(); reset();
  later(days * DAY + 5); await hourly();
  vuln(String(did) !== "ok,ok" || cp !== 0 || cs !== "delivered" || String(did2) !== "ok,ok" || m.status !== "released" || tsOf(d).length !== 1,
    `R4 ${plan}: sent back and delivered again while the run worked through its list (${did}) -> ${cp} paid, ${cs}, ${left.toFixed(1)} days left; a part sent back and handed in again (${did2}) -> not paid then; once its own period is over -> ${m.status}, ${tsOf(d).length} payout (must be 0, delivered; released, 1)`);
});

// ---------- R5 several Orders of one freelancer ----------
await guard("R5", async () => {
  const A = mk2(), B = mk2(), C = mk1(), O = mk2({ editor: users.ed2.id });
  for (const x of [A, B, C, O]) { await fund(x); deliver(x); }
  only(A, B, C, O); later(14 * DAY + 1);
  hooks.stripe = async (path, method, p) => (method === "POST" && path === "/transfers" && p.get("metadata[contract_id]") === B.id ? [500, { error: { type: "api_error", message: "boom" } }] : null);
  await hourly(); reset();
  const dest = (x) => tsOf(x).map(t => [t.destination, t.source_transaction === STRIPE.intents[x.stripe_payment_intent].latest_charge]);
  const first = { A: sent(A), B: sent(B), C: sent(C), O: sent(O) };
  later(11); await hourly();
  const p = [A, B, O].flatMap(x => ledgerProblems(x));
  vuln(first.A !== 9500 || first.B !== 0 || first.C !== 10000 || first.O !== 9500 || dest(A)[0][0] !== "acct_1EditorAAAAAAAA" || dest(O)[0][0] !== "acct_1SecondBBBBBBBB" || !dest(A)[0][1] || !dest(C)[0][1] || !dest(O)[0][1]
       || sent(B) !== 9500 || tsOf(B).length !== 1 || p.length,
    `R5 four Orders due (three of one freelancer), one failing at Stripe -> paid ${JSON.stringify(first)}, each to ${[dest(A), dest(O)].map(d => d[0] && d[0][0]).join(" / ")} from its own payment; the next run -> B ${sent(B)} in ${tsOf(B).length} payout (must be A 9500, B 0, C 10000, O 9500, the right accounts; then 9500 once)${report(p)}`);
});

// ---------- R6 parts and top-ups ----------
await guard("R6", async () => {
  const c = mk2(); await fund(c); c.status = "funded";
  const [m1, m2] = parts(c, [3000, 5000, 2000]);
  submit(c, m1); submit(c, m2);
  await Promise.all([approve(c, m1.id), approve(c, m1.id)]);
  only(c); later(14 * DAY - 1); await hourly();
  const early = m2.status;
  later(2); await Promise.all([hourly(), hourly()]);
  const m4 = { id: uuid(), order_id: c.id, title: "part 4", amount_cents: 4000, status: "pending", position: 4 }; DB.order_milestones.push(m4);
  await topUp(c, 4000); submit(c, m4);
  openDispute(c, users.cl.id, "part 4 is missing the subtitles");
  later(15 * DAY); await hourly();
  const during = { m4: m4.status, n: tsOf(c).length };
  const r = await resolve(c, "split", { editor_percent: 50 });
  const p = ledgerProblems(c);
  // held 60 (part 3: 20, part 4: 40): 30 to the freelancer (28.50 sent), 30 back; 5% of 30 + 50 + 30 = 5.50 kept in all
  vuln(early !== "submitted" || m2.status !== "released" || during.m4 !== "submitted" || during.n !== 2 || r.status !== 200 || back(c) !== 3000 || sent(c) !== 2850 + 4750 + 2850 || cof(c).commission_cents !== 550 || held(c) !== 0 || p.length,
    `R6 parts 30/50/20 and a 40 top-up: part 1 approved twice -> once; part 2 a minute before day 14 -> ${early}, after -> ${m2.status}; a dispute: 15 days later part 4 ${during.m4}, ${during.n} payouts; Cuvori divides what is held 50/50 (${r.status}) -> ${back(c)} back, ${sent(c)} sent, ${cof(c).commission_cents} kept, ${held(c)} held (must be submitted, released; submitted, 2; 3000, 10450, 550, 0)${report(p)}`);
});

// ---------- R7 refunds and races ----------
for (const [plan, make, , paid] of PLANS) await guard(`R7 ${plan}`, async () => {
  const k = make(); await fund(k); k.status = "funded"; const kr = await cancel(k);
  const c = make(); await fund(c); c.status = "funded"; const [m1] = parts(c, [4000, 6000]); submit(c, m1); await approve(c, m1.id); openDispute(c, users.cl.id);
  const r1 = await resolve(c, "refund");
  const s = make(); await fund(s); deliver(s); openDispute(s, users.cl.id); const r2 = await resolve(s, "split", { editor_percent: 60 });
  const t = make(); await fund(t); t.status = "funded"; await topUp(t, 3000); deliver(t); openDispute(t, users.ed.id); const r3 = await resolve(t, "split", { editor_percent: 25 });
  const two = STRIPE.refunds.filter(x => x.contract === t.id && !(x.metadata && x.metadata.kind)).length;
  const p = [...ledgerProblems(k), ...ledgerProblems(c), ...ledgerProblems(s), ...ledgerProblems(t)];
  const p2 = plan === "plan 2";
  vuln(kr.status !== 200 || back(k) !== 10000 || (cof(k).commission_cents || 0) !== 0 || r1.status !== 200 || back(c) !== 6000 || held(c) !== 0 || r2.status !== 200 || sent(s) !== (p2 ? 5700 : 6000) || back(s) !== 4000
       || (cof(s).commission_cents || 0) !== (p2 ? 300 : 0) || r3.status !== 200 || back(t) !== 9750 || two !== 2 || p.length,
    `R7 ${plan}: the freelancer gives it back -> ${back(k)} back, ${cof(k).commission_cents || 0} kept; Cuvori's refund after a 40 part -> ${back(c)} back, ${held(c)} held; 60/40 -> ${sent(s)} sent, ${cof(s).commission_cents || 0} kept, ${back(s)} back; 25/75 over two payments -> ${back(t)} back in ${two} refunds (must be 10000, 0; 6000, 0; ${p2 ? "5700, 300" : "6000, 0"}, 4000; 9750 in 2)${report(p)}`);
  // races: exactly one wins, every cent accounted for
  const acc = (x, total = 10000) => held(x) === 0 && sent(x) + (cof(x).commission_cents || 0) + back(x) === total;
  const a = make(); await fund(a); deliver(a); only(a); const [ra, rk] = await Promise.all([approve(a), cancel(a)]);
  const b = make(); await fund(b); deliver(b); only(b); later(15 * DAY); const [rr] = await Promise.all([resolve(b, "refund"), hourly()]);
  const d = make(); await fund(d); deliver(d); only(d); const [rs, rp] = await Promise.all([resolve(d, "split", { editor_percent: 30 }), approve(d)]);
  vuln(!acc(a) || (sent(a) === 0) === (back(a) === 0) || !acc(b) || (sent(b) === 0) === (back(b) === 0) || !acc(d),
    `R7 ${plan} races: approval | cancel (${ra.status}, ${rk.status}) -> sent ${sent(a)}, back ${back(a)}; Cuvori's refund | the hourly run (${rr.status}) -> sent ${sent(b)}, back ${back(b)}; Cuvori's 30/70 | the approval (${rs.status}, ${rp.status}) -> sent ${sent(d)}, back ${back(d)}, held ${held(d)} (must be one winner each, every cent accounted for)`);
});

// ---------- R8 failed payouts ----------
await guard("R8", async () => {
  const a = mk2(); await fund(a); deliver(a); only(a); later(14 * DAY + 1);
  STRIPE.accounts.acct_1EditorAAAAAAAA.payouts_enabled = false; await hourly(); const notReady = sent(a);
  STRIPE.accounts.acct_1EditorAAAAAAAA.payouts_enabled = true; later(61); await hourly();
  const b = mk2(); await fund(b); deliver(b); only(b); let once = true;
  hooks.stripe = async (path, method, p) => { if (once && method === "POST" && path === "/transfers") { once = false; stripeHandle(path, method, p); throw new TypeError("fetch failed"); } return null; };
  const ra = await approve(b); reset(); const rb = await approve(b); later(11); await hourly();
  const c = mk1(); await fund(c); deliver(c); only(c);
  hooks.stripe = async (path, method) => (method === "POST" && path === "/transfers" ? [500, { error: { type: "api_error", message: "down" } }] : null);
  const rc = await approve(c); reset(); later(11); await hourly();
  const locks = DB.money_keys.filter(k => [a, b, c].some(x => k.scope === `lock:${x.id}`)).length;
  const p = [...ledgerProblems(a), ...ledgerProblems(b)];
  vuln(notReady !== 0 || sent(a) !== 9500 || tsOf(a).length !== 1 || tsOf(b).length !== 1 || sent(b) !== 9500 || cof(b).status !== "completed" || rc.status === 200 || tsOf(c).length !== 1 || sent(c) !== 10000 || locks || p.length,
    `R8 account not ready -> ${notReady} paid, then ${sent(a)} in ${tsOf(a).length}; Stripe's answer lost (${ra.status}, again ${rb.status}) -> ${tsOf(b).length} payout of ${sent(b)}, ${cof(b).status}; Stripe down (${rc.status}) -> ${tsOf(c).length} payout of ${sent(c)}; locks left ${locks} (must be 0, 9500 in 1; 1 of 9500, completed; 1 of 10000; 0)${report(p)}`);
});

// ---------- R9 a bank chargeback is not the Order's own dispute ----------
for (const [plan, make, days, paid] of PLANS) await guard(`R9 ${plan}`, async () => {
  // the client's own dispute, then a chargeback on the same payment: the dispute keeps its reason and who opened it
  const c = make(); const fc = await fund(c); deliver(c); openDispute(c, users.cl.id, "Client: the video is 2 minutes, we agreed on 5");
  await dispute(c, chargeOf(fc.payment_intent), "needs_response");
  const kept = cof(c).dispute_reason === "Client: the video is 2 minutes, we agreed on 5" && cof(c).dispute_by === users.cl.id && cof(c).status === "disputed";
  // delivered, nobody disputes; a chargeback 4 days before the end of the review period; nothing moves while it is open
  const d = make(); const fd = await fund(d); deliver(d); only(d); const ch = chargeOf(fd.payment_intent);
  later((days - 4) * DAY); await dispute(d, ch, "needs_response");
  const open = { status: cof(d).status, reason: cof(d).dispute_reason || "", by: cof(d).dispute_by || null };
  later(30 * DAY); await hourly();
  const during = { sent: sent(d), approve: (await approve(d)).status, cancel: (await cancel(d)).status, decide: (await resolve(d, "release")).status };
  await dispute(d, ch, "won");
  const left = (Date.parse(cof(d).auto_release_at || 0) - Date.now()) / 864e5;
  later(4 * DAY - 10); await hourly(); const tooSoon = sent(d);
  later(20); await hourly();
  const flags = DB.user_flags.filter(x => x.contract_id === d.id && x.kind === "dispute_lost").length;
  // funded, a chargeback the bank decides for Cuvori: the freelancer can still deliver, the client can approve
  const e = make(); const fe = await fund(e); e.status = "funded"; await dispute(e, chargeOf(fe.payment_intent), "needs_response"); await dispute(e, chargeOf(fe.payment_intent), "won");
  const dl = deliver(e), ap = await approve(e);
  // a partial chargeback lost while everything is held, on a delivered Order: the rest stays in the Order's own flow
  const g = make(); const fg = await fund(g); deliver(g); only(g);
  await dispute(g, chargeOf(fg.payment_intent), "needs_response", { amount: 3000 }); await dispute(g, chargeOf(fg.payment_intent), "lost", { amount: 3000 });
  const gs = cof(g).status; later(days * DAY + 1); await hourly();
  const p = [...ledgerProblems(d), ...ledgerProblems(e), ...ledgerProblems(g)];
  vuln(!kept || open.status !== "delivered" || /chargeback/i.test(open.reason) || open.by || during.sent !== 0 || during.approve !== 409 || during.cancel !== 409 || during.decide !== 409
       || Math.abs(left - 4) > 0.01 || tooSoon !== 0 || sent(d) !== paid || flags || dl !== "ok" || ap.status !== 200 || sent(e) !== paid || gs !== "delivered" || sent(g) !== Math.round(paid * 0.7) || p.length,
    `R9 ${plan}: the client's dispute after a chargeback keeps its reason and who opened it: ${kept}; a chargeback on a delivered Order -> ${open.status}${open.reason ? ", reason \"" + open.reason.slice(0, 30) + "\"" : ""}${open.by ? ", opened by someone" : ""}; while open: ${during.sent} paid, approve ${during.approve}, cancel ${during.cancel}, decide ${during.decide}; won -> ${left.toFixed(2)} days of review left, ${tooSoon} paid just before them, then ${sent(d)}; ${flags} marked as having lost a dispute; funded and won: deliver ${dl}, approve ${ap.status} -> ${sent(e)}; 30 of 100 lost while held -> ${gs}, then ${sent(g)} paid automatically (must be true; delivered; 0, 409, 409, 409; 4.00, 0, ${paid}; 0; ok, 200, ${paid}; delivered, ${Math.round(paid * 0.7)})${report(p)}`);
});

// ---------- R10 a chargeback during a decision or an approval under way ----------
for (const [plan, make, , paid] of PLANS) await guard(`R10 ${plan}`, async () => {
  const p2 = plan === "plan 2";
  // Cuvori decided 60/40: the freelancer's part went out, the client's refund stopped at Stripe; then a chargeback, won
  const c = make(); const fc = await fund(c); deliver(c); openDispute(c, users.cl.id); only(c); const ch = chargeOf(fc.payment_intent);
  hooks.stripe = async (path, method) => (method === "POST" && path === "/refunds" ? [500, { error: { type: "api_error", message: "down" } }] : null);
  await resolve(c, "split", { editor_percent: 60 }); reset();
  await dispute(c, ch, "needs_response"); await dispute(c, ch, "won");
  const again = await resolve(c, "release");
  later(11); await hourly(); later(61); await hourly();
  // the client approved, the transfer was refused (the account was not ready at Stripe); then a chargeback, won
  const d = make(); const fd = await fund(d); deliver(d); only(d); const chd = chargeOf(fd.payment_intent);
  hooks.stripe = async (path, method) => (method === "POST" && path === "/transfers" ? [400, { error: { type: "invalid_request_error", code: "insufficient_capabilities_for_transfer", message: "Your destination account needs to have at least one of the following capabilities enabled: transfers" } }] : null);
  await approve(d); reset();
  await dispute(d, chd, "needs_response"); await dispute(d, chd, "won");
  later(11); await hourly(); later(61); await hourly();
  const p = [...ledgerProblems(c), ...ledgerProblems(d)];
  vuln(again.status !== 409 || back(c) !== 4000 || sent(c) !== (p2 ? 5700 : 6000) || held(c) !== 0 || !["completed", "refunded"].includes(cof(c).status) || sent(d) !== paid || cof(d).status !== "completed" || p.length,
    `R10 ${plan}: a 60/40 decision half done, a chargeback won -> a new decision ${again.status}; the hourly run -> client ${back(c)}, freelancer ${sent(c)}, held ${held(c)}, ${cof(c).status}; an approval whose payout was refused, a chargeback won -> ${sent(d)}, ${cof(d).status} (must be 409; 4000, ${p2 ? 5700 : 6000}, 0, closed; ${paid}, completed)${report(p)}`);
});

// ---------- R11 a chargeback lost after a payout whose answer was lost ----------
await guard("R11", async () => {
  const c = mk2(); const f = await fund(c); deliver(c); const ch = chargeOf(f.payment_intent); only(c);
  let once = true;
  hooks.stripe = async (path, method, p) => { if (once && method === "POST" && path === "/transfers") { once = false; stripeHandle(path, method, p); throw new TypeError("fetch failed"); } return null; };
  await approve(c); reset();
  await dispute(c, ch, "needs_response"); await dispute(c, ch, "lost");
  later(11); await hourly(); later(60); await hourly();
  const p = ledgerProblems(c, ["to_decide:commission_on_lost_chargeback"]);
  vuln(sent(c) !== 0 || /could not be pulled back/.test(cof(c).money_error || "") || cof(c).status !== "refunded" || p.length,
    `R11 a payout made with its answer lost, then a chargeback lost -> the freelancer has ${sent(c)}, the note "${(cof(c).money_error || "").slice(0, 80)}", ${cof(c).status} (must be 0, no "could not be pulled back", refunded)${report(p)}`);
});

// ---------- R12 Cuvori's decisions ----------
await guard("R12", async () => {
  const c = mk2(); await fund(c); deliver(c); openDispute(c, users.cl.id); only(c);
  const r1 = await resolve(c, "refund", {}, "tok_cl2"), r2 = await resolve(c, "release", {}, "tok_ed");
  users.adm.banned = true; const r3 = await resolve(c, "refund"); users.adm.banned = false;
  const own = mk2({ client: users.adm.id }); own.status = "disputed"; own.funded_cents = 10000; const r4 = await resolve(own, "refund");
  const refused = [r1, r2, r3, r4].every(r => r.status === 403) && sent(c) === 0 && back(c) === 0;
  // a decision whose refund stops at Stripe: on record before any money moved, and finished by the hourly run
  hooks.stripe = async (path, method) => (method === "POST" && path === "/refunds" ? [500, { error: { type: "api_error", message: "down" } }] : null);
  const r = await resolve(c, "refund"); reset();
  const rec = events(c).find(e => e.event === "decision") || {};
  const atOnce = rec.actor === users.adm.id && rec.data && rec.data.decision === "refund" && rec.data.note === NOTE && rec.data.refund_cents === 10000 && back(c) === 0;
  const told = DB.messages.some(m => m.body === `Cuvori decision: ${NOTE}` && m.conversation_id === c.conversation_id);
  const flagged = DB.user_flags.some(x => x.contract_id === c.id && x.kind === "dispute_lost" && x.user_id === users.ed.id);
  later(11); await hourly();
  const once = events(c).filter(e => e.event === "decision").length;
  // a stuck 'release' (the freelancer's Stripe account closed) replaced by a 'refund'
  const d = mk2(); await fund(d); deliver(d); openDispute(d, users.cl.id); only(d);
  STRIPE.accounts.acct_1EditorAAAAAAAA.payouts_enabled = false;
  await resolve(d, "release"); later(1); const rd = await resolve(d, "refund");
  STRIPE.accounts.acct_1EditorAAAAAAAA.payouts_enabled = true;
  const recs = events(d).filter(e => e.event === "decision").map(e => [e.data.decision, e.data.replaced && e.data.replaced.decision].join(":"));
  vuln(!refused || r.status === 200 || !atOnce || !told || !flagged || back(c) !== 10000 || once !== 1 || rd.status !== 200 || back(d) !== 10000 || String(recs) !== "release:,refund:release",
    `R12 a non-admin / the freelancer / a banned admin / an admin who is the client -> ${[r1, r2, r3, r4].map(x => x.status).join("/")}; a refund decision stopped at Stripe (${r.status}): on record at once ${atOnce}, told to both sides ${told}, the freelancer marked ${flagged}; the hourly run -> ${back(c)} back, ${once} record; a stuck 'release' replaced by a 'refund' (${rd.status}) -> records ${JSON.stringify(recs)} (must be 403 x4; true, true, true; 10000, 1; 200, ["release:","refund:release"])`);
});

// ---------- R13 provider outages ----------
await guard("R13", async () => {
  const STEPS = {
    approve: { setup: (c) => { deliver(c); }, act: (c) => approve(c), want: [9500, 0] },
    auto: { setup: (c) => { deliver(c); later(14 * DAY + 1); }, act: () => hourly(), want: [9500, 0] },
    cancel: { setup: (c) => { c.status = "funded"; }, act: (c) => cancel(c), want: [0, 10000] },
    split: { setup: (c) => { deliver(c); openDispute(c, users.cl.id); }, act: (c) => resolve(c, "split", { editor_percent: 60 }), want: [5700, 4000] },
    part: { setup: (c) => { c.status = "funded"; const [m] = parts(c, [10000]); submit(c, m); c._m = m; }, act: (c) => approve(c, c._m.id), want: [9500, 0] },
  };
  let cases = 0; const bad = [];
  for (const [name, s] of Object.entries(STEPS)) for (const mode of ["500", "network", "lost"]) for (let k = 1; k <= 14; k++) {
    const c = mk2(); await fund(c); s.setup(c); only(c);
    let n = 0, hit = false;
    hooks.stripe = async (path, method, p) => {
      if (hit || ++n !== k) return null;
      hit = true;
      if (mode === "500") return [500, { error: { type: "api_error", message: "Stripe down" } }];
      if (mode === "network") throw new TypeError("fetch failed");
      const r = stripeHandle(path, method, p); if (r[0] >= 400) return r; throw new TypeError("fetch failed");
    };
    await s.act(c); reset();
    if (!hit) continue;
    cases++;
    for (let i = 0; i < 3; i++) { await s.act(c).catch(() => null); later(11); await hourly(); later(60); }
    const p = ledgerProblems(c);
    if (sent(c) !== s.want[0] || back(c) !== s.want[1] || held(c) !== 0 || p.length) bad.push(`${name}/${mode}/${k}: sent ${sent(c)}, back ${back(c)}, held ${held(c)}${p.length ? ", " + p[0] : ""}`);
  }
  vuln(bad.length > 0 || cases < 80, `R13 ${cases} outages (Stripe down, no answer, answer lost, at each Stripe call of five money steps), then the retry and the hourly run -> ${bad.length ? bad.length + " END WRONG: " + bad.slice(0, 3).join("; ") : "every one ends right, nothing held, the ledger reconciled"} (must be every one, at least 80)`);
});

// ---------- R14 an Order agreed at today's prices, after the switch ----------
await guard("R14", async () => {
  const c = mk1(); await fund(c); deliver(c);
  const d = (Date.parse(c.auto_release_at) - Date.now()) / 864e5;
  const a = await approve(c);
  vuln(Math.round(d) !== 7 || a.status !== 200 || sent(c) !== 10000 || cof(c).commission_cents, `R14 a plan 1 Order on a database with the new prices -> ${Math.round(d)} days, approval ${a.status}, ${sent(c)} sent, ${cof(c).commission_cents || 0} kept (must be 7, 200, 10000, 0)`);
});

// ---------- R15 the hourly run inside Netlify's 30 seconds ----------
await guard("R15", async () => {
  const orders = [];
  for (let i = 0; i < 45; i++) { const c = mk2(); await fund(c); deliver(c); orders.push(c); }
  only(...orders); later(14 * DAY + 1);
  // a slow Stripe: every payout takes 0.6 s, on the clock the hourly run measures itself by (performance.now)
  let slow = 0, lastStart = 0;
  const realNow = performance.now.bind(performance);
  Object.defineProperty(performance, "now", { value: () => realNow() + slow, configurable: true, writable: true });
  let t0 = performance.now(), first = true;
  hooks.stripe = async (path, method) => { if (method === "POST" && path === "/transfers") { if (first) lastStart = performance.now() - t0; slow += 600; } return null; };
  const h1 = await hourly();
  const spent = performance.now() - t0; first = false;
  const half = orders.filter(c => cof(c).status === "releasing").length, paid1 = orders.filter(c => cof(c).status === "completed").length;
  for (let i = 0; i < 4; i++) { later(61); await hourly(); }
  reset(); Object.defineProperty(performance, "now", { value: realNow, configurable: true, writable: true });
  const twice = orders.filter(c => tsOf(c).length !== 1).length, all = orders.filter(c => cof(c).status === "completed").length;
  vuln(h1.status !== 200 || spent > 30000 || lastStart > 25000 || half || paid1 === 0 || paid1 === 45 || !(h1.json.waiting > 0) || all !== 45 || twice,
    `R15 45 Orders due, each payout 0.6 s at Stripe -> the first run took ${(spent / 1000).toFixed(1)} s (last payout started at ${(lastStart / 1000).toFixed(1)} s), paid ${paid1}, left ${h1.json.waiting} waiting, ${half} half-way; four more runs -> ${all} paid, ${twice} not exactly once (must stay under 30 s, start nothing after 25 s; some paid, the rest waiting, none half-way; then 45, 0)`);
});

console.error = realError; globalThis.Date = RealDate; globalThis.setTimeout = realSetTimeout;
const bad = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${bad} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(bad ? 1 : 0);
