// Funds segregation, prepared and off (Stripe's private preview "allocated funds"): with STRIPE_FUNDS_SEGREGATION set to
// "on", a payment under the new prices is held at Stripe apart from Cuvori's own money, tied to its card payment; payouts
// are linked to the payment they come from (one part per payment), the 5% moves to Cuvori's balance with each payout, and
// the hourly run moves what a closed Order no longer owes anybody. Off, nothing changes. Every check runs against the fake
// Stripe of tests/fn-harness.mjs, which follows Stripe's funds segregation guide (docs.stripe.com/connect/funds-segregation):
// the preview's parameters are refused without the preview version or without access, money held apart is not in
// Cuvori's balance, refunds and chargebacks take from it first, a pull-back goes back into it (and stays there during a
// chargeback), and the whole account has standalone fees. What Stripe's guide does not say is a setting of the fake
// (fsReset), and each such check says which way it assumes. After every check the ledger lines are checked against v56's
// rules and the Order against Stripe (tests/plan2-ledger.mjs), as in attack-plan2.
//   F1  off (the account has the preview, the setting is off): no preview parameter, no preview version on any request,
//       payouts exactly as before
//   F2  on, one payment: the page asks for it (preview version, Discover Global Network blocked), the Order is marked
//       before the card is charged, the money is not in Cuvori's balance, the payout is linked to the payment and moves
//       the 5% with it (application_fee_amount); only the requests about money held apart carry the preview version;
//       F2b Stripe's page refusing the parameter: no page, and with STRIPE_FS_WHERE=capture the hold asks instead;
//       F2c a payout before the card payment settled (linked, as Stripe allows)
//   F3  today's prices with the setting on: nothing held apart, the card fee waits for Stripe's real fee (standalone fees)
//   F4  payments made the old way stay the old way (no mark), also after the setting is on; a payment held apart stays
//       held apart after the setting is turned off again
//   F5  several Orders of one freelancer at once: each payout and refund takes only from its own payment; a refund of an
//       Order not held apart never touches another Order's money held apart
//   F6  top-ups: a payout over two payments is two parts, each linked to its payment, the 5% once
//   F7  parts of an Order over a top-up: the second part's payout is split over both payments; the ledger check takes it
//   F8  refunds: a divided decision (60/40) and a cancel (all back) come out of the money held apart, never Cuvori's
//   F9  chargebacks: lost before the payout; lost after it (the pull-back stays held apart: Stripe will not move it, the
//       Order's note asks the owner to ask Stripe; once Stripe does, the hourly run moves it); won after the payout (the
//       re-payment linked to the payment; F9e its line not saved, added by the hourly run); won before the payout, with
//       either destination of the money Stripe gives back
//   F10 failed payments: a card the page blocks; a hold let go (nothing charged, no mark); a card network Stripe cannot
//       hold apart (charged the old way; or, if Stripe refuses, the hold let go); the account without access (no page)
//   F11 the same notices twice, a notice for another Order's payment, two approvals at once: one payout, one line each
//   F12 Stripe's answer lost between two parts: the next try pays only what is left, never a part twice (a whole Order,
//       F12b a part's payout); F12c a part's line not saved: the hourly run adds it, counting nothing twice
//   F13 the hourly run moves what a closed Order still holds apart, once; an open Order's money stays
//   F14 standalone fees for the whole account: Stripe's fee is never recorded as 0 and never sent back to the client as
//       if it were the surplus
//   F15 every history line the payment code writes has its text on the Order page, or is one the page leaves out
// Run: node tests/attack-funds-segregation.mjs
import fs from "node:fs";
import path from "node:path";
import { DB, STRIPE, V56, users, hooks, req, call, mk, past, reset, fns, pay, signed, uuid, fsReset, fsDispute, fsDisputeClose, FS_HEADER, finishReport, stripeHandle } from "./fn-harness.mjs";
import { checkLines, reconcile, listed } from "./plan2-ledger.mjs";
const root = process.env.TARGET ? path.resolve(process.env.TARGET) : path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");   // TARGET: another copy of the repo
const out = [];
const vuln = (cond, m) => { const line = (cond ? "VULNERABLE " : "safe       ") + m; out.push(line); process.stdout.write(line + "\n"); };
const logs = []; const realError = console.error; console.error = process.env.DEBUG ? realError : (...a) => logs.push(a.map(String).join(" "));
const fx = await fns();
V56.on = true;
STRIPE.balance = 50_000_000;                                            // Cuvori's own balance (other payments, its 5%)
const RealDate = Date; let skew = 0;
globalThis.Date = class extends RealDate { constructor(...a) { if (a.length === 0) super(RealDate.now() + skew); else super(...a); } static now() { return RealDate.now() + skew; } };
const later = (min) => { skew += min * 60e3; };
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(() => { if (Number(ms) > 0) skew += Number(ms); fn(...args); }, 0);
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
const mk2 = (o = {}) => mk({ pricing_version: 2, commission_bps: 500, commission_cents: 0, auto_days: 14, ...o });
const mk1 = (o = {}) => mk({ pricing_version: 1, commission_bps: 0, commission_cents: 0, ...o });
const lines = (c, kind) => DB.order_payments.filter(p => p.order_id === c.id && (!kind || p.kind === kind));
const tsOf = (c) => STRIPE.transfers.filter(t => t.metadata.contract_id === c.id);
const sent = (c) => tsOf(c).reduce((a, t) => a + t._received - (t.amount_reversed || 0), 0);
const refundsOf = (c) => STRIPE.refunds.filter(r => r.contract === c.id && !(r.metadata && ["fee_surplus", "late_payment"].includes(r.metadata.kind)));
const marked = (c) => DB.money_keys.some(k => k.scope === `fs:${c.id}`);
const evs = (c, e) => DB.order_events.filter(x => x.order_id === c.id && x.event === e);
const ms = (c, amounts) => { c.has_milestones = true; return amounts.map((a, i) => { const m = { id: uuid(), order_id: c.id, title: "part " + (i + 1), amount_cents: a, status: "submitted", position: i + 1 }; DB.order_milestones.push(m); return m; }); };
async function fund2(c, opts = {}) {
  const r = await checkout(c);
  if (r.status !== 200) return { checkout: r };
  let s; try { s = pay(c.stripe_checkout_id, opts); } catch (e) { return { checkout: r, refused: e.message }; }
  return { checkout: r, session: s, webhook: await webhook(completed(s)) };
}
async function topUp(c, cents, opts = {}) { c.amount_cents += cents; return fund2(c, opts); }
const pageOf = (c) => STRIPE.sessions[c.stripe_checkout_id] || {};
// the requests of a check, by the version they carried
const since = (n) => STRIPE.versions.slice(n);
const previewed = (list) => list.filter(v => v.version === FS_HEADER);
const oldVersion = (list) => list.every(v => v.version === "2024-06-20");
// the only requests that may carry the preview version: the page asking for it, reading what a payment holds apart, the
// hold before it is charged and its charge, a payout linked to a payment held apart, and moving money held apart
const PREVIEW_OK = [/^POST \/checkout\/sessions$/, /^GET \/payment_intents\/pi_[A-Za-z0-9]+$/, /^POST \/payment_intents\/pi_[A-Za-z0-9]+(\/capture)?$/, /^POST \/transfers$/, /^POST \/balance_transfers$/];
const strayPreview = (list) => previewed(list).filter(v => !PREVIEW_OK.some(re => re.test(`${v.method} ${v.path}`))).map(v => `${v.method} ${v.path}`);
function verify(c, expect = []) {
  const fresh = DB.contracts.find(x => x.id === c.id) || c;
  const p = [...checkLines(DB, [c.id]), ...reconcile(DB, STRIPE, fresh)];
  const got = listed(DB, fresh), want = [...expect].sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) p.push(`the ledger check lists [${got.join(", ")}], expected [${want.join(", ")}]`);
  return p;
}
const report = (p) => (p.length ? " PROBLEMS: " + p.slice(0, 5).join("; ") + (p.length > 5 ? ` (+${p.length - 5})` : "") : "");
async function guard(name, fn) {
  try { await fn(); }
  catch (e) { vuln(true, `${name}: a check stopped half-way: ${e && e.message} (at ${String(e && e.stack || "").split("\n").find(x => x.includes("attack-funds")) || "?"})`); }
  finally { reset(); OFF(); STRIPE.fs = null; STRIPE.settleDelay = false; }
}

// ---------- F1 off ----------
await guard("F1", async () => {
  OFF(); fsReset();                                                      // Stripe gave the preview; the owner has not turned it on
  const n = STRIPE.versions.length, c = mk2({ amount_cents: 10000 });
  const f = await fund2(c); c.status = "delivered"; const a = await approve(c);
  const prm = pageOf(c).params || {}, ch = chargeOf(f.session.payment_intent), t = tsOf(c)[0] || { metadata: {} };
  const asked = Object.keys(prm).some(k => /allocated_funds|restrictions/.test(k)) || Object.values(prm).includes("checkout");
  const p = verify(c);
  vuln(f.webhook.status !== 200 || a.status !== 200 || asked || !oldVersion(since(n)) || marked(c) || ch.allocated_funds || t.source_transaction !== ch.id || t.application_fee_amount || t.amount !== 9500 || evs(c, "held_apart").length || p.length,
    `F1 off -> paid ${f.webhook.status}, approved ${a.status}; the page asks to hold it apart: ${asked}; requests with the preview version: ${previewed(since(n)).length} (must be 0); marked ${marked(c)}; held apart ${!!ch.allocated_funds}; payout ${t.amount} linked to the payment ${t.source_transaction === ch.id}, 5% moved by Stripe ${t.application_fee_amount || 0} (must be 9500, true, 0)${report(p)}`);
});

// ---------- F2 on, one payment ----------
await guard("F2", async () => {
  ON(); fsReset();
  const n = STRIPE.versions.length, bal0 = STRIPE.balance, c = mk2({ amount_cents: 10000 });
  const f = await fund2(c);
  const s = pageOf(c), prm = s.params || {}, pi = f.session.payment_intent, ch = chargeOf(pi);
  const pageReq = since(n).find(v => v.method === "POST" && v.path === "/checkout/sessions"), capReq = since(n).find(v => v.path === `/payment_intents/${pi}/capture`);
  const ev = evs(c, "held_apart")[0] || { data: {} };
  const paid = { held: heldOf(ch), balance: STRIPE.balance - bal0, marked: marked(c) };
  c.status = "delivered"; const n2 = STRIPE.versions.length; const a = await approve(c);
  const t = tsOf(c)[0] || { metadata: {} }, trReq = since(n2).find(v => v.method === "POST" && v.path === "/transfers"), rl = lines(c, "release")[0] || {};
  const p = verify(c), stray = strayPreview(since(n)), oldOnes = since(n).filter(v => v.version !== FS_HEADER);
  vuln(prm["payment_intent_data[allocated_funds][enabled]"] !== "true" || prm["payment_method_options[card][restrictions][brands_blocked][0]"] !== "discover_global_network" || s.metadata.allocated_funds !== "checkout" || prm["payment_intent_data[metadata][allocated_funds]"] !== "checkout"
    || !pageReq || pageReq.version !== FS_HEADER || !capReq || capReq.version !== FS_HEADER || !paid.marked || paid.held !== 10000 || paid.balance !== 0 || ev.data.held !== true || ev.data.amount_cents !== 10000,
    `F2 a payment under the new prices, held apart -> the page asks for it ${prm["payment_intent_data[allocated_funds][enabled]"]}, blocks ${prm["payment_method_options[card][restrictions][brands_blocked][0]"]}, says how (${s.metadata.allocated_funds}); the page and the charge under ${pageReq && pageReq.version} / ${capReq && capReq.version}; marked before the charge ${paid.marked}; Stripe holds apart ${paid.held}, Cuvori's balance +${paid.balance} (must be 10000, +0); the history says held ${ev.data.held} (${ev.data.amount_cents})`);
  vuln(a.status !== 200 || c.status !== "completed" || t.source_transaction !== ch.id || t.amount !== 9500 || t.application_fee_amount !== 500 || t.metadata.part !== "0" || t.metadata.payout_total_cents !== "10000" || t.metadata.source_charge !== ch.id
    || !trReq || trReq.version !== FS_HEADER || heldOf(ch) !== 0 || STRIPE.balance - bal0 !== 500 || rl.charge_ref !== ch.id || rl.commission_cents !== 500 || rl.payout_cents !== 9500 || p.length,
    `F2 approved (${a.status}) -> payout ${t.amount} linked to its payment ${t.source_transaction === ch.id}, the 5% (${t.application_fee_amount}) moved with it, under ${trReq && trReq.version}; Stripe still holds apart ${heldOf(ch)}, Cuvori's balance +${STRIPE.balance - bal0} (must be 0, +500); the line names the payment ${rl.charge_ref === ch.id}, keeps ${rl.commission_cents}, sends ${rl.payout_cents}${report(p)}`);
  vuln(stray.length || !oldVersion(oldOnes) || oldOnes.length < 5,
    `F2 the preview version only where money held apart is concerned -> ${previewed(since(n)).length} requests with it${stray.length ? ", ALSO ON " + stray.join(", ") : ""}; the other ${oldOnes.length} under ${[...new Set(oldOnes.map(v => v.version))].join("/")} (must be 2024-06-20 only)`);
});

// ---------- F2b Stripe's page refusing the parameter: asked on the hold instead; F2c money not settled yet ----------
await guard("F2b", async () => {
  ON(); fsReset({ checkoutRefuses: true });
  const a = mk2({ amount_cents: 10000 }); const ra = await checkout(a);
  vuln(ra.status === 200 || a.stripe_checkout_id, `F2b Stripe's page refusing allocated_funds (STRIPE_FS_WHERE unset) -> the page ${ra.status} (must not be made: the owner switches to "capture", SETUP.md Part 22)`);
  process.env.STRIPE_FS_WHERE = "capture";
  try {
    const n = STRIPE.versions.length, c = mk2({ amount_cents: 10000 }); const f = await fund2(c);
    const prm = pageOf(c).params || {}, pi = f.session.payment_intent, ch = chargeOf(pi);
    const upd = since(n).find(v => v.method === "POST" && v.path === `/payment_intents/${pi}`);
    c.status = "delivered"; const ap = await approve(c); const t = tsOf(c)[0] || {}, p = verify(c);
    vuln(f.webhook.status !== 200 || prm["payment_intent_data[allocated_funds][enabled]"] !== undefined || prm["payment_method_options[card][restrictions][brands_blocked][0]"] !== "discover_global_network" || pageOf(c).metadata.allocated_funds !== "capture"
      || !upd || upd.version !== FS_HEADER || heldOf(ch) !== 0 || !ch.allocated_funds || ap.status !== 200 || t.source_transaction !== ch.id || t.application_fee_amount !== 500 || p.length,
      `F2b STRIPE_FS_WHERE=capture -> paid ${f.webhook.status}; the page asks nothing of it (${prm["payment_intent_data[allocated_funds][enabled]"] === undefined}) but blocks the network and says "${pageOf(c).metadata.allocated_funds}"; the hold asked before the charge ${!!upd} (${upd && upd.version}); held apart ${!!ch.allocated_funds}; approved ${ap.status}: linked ${t.source_transaction === ch.id}, 5% moved ${t.application_fee_amount}${report(p)}`);
  } finally { delete process.env.STRIPE_FS_WHERE; }
});
await guard("F2c", async () => {
  ON(); fsReset(); STRIPE.settleDelay = true;                            // the card payment is not settled yet
  const c = mk2({ amount_cents: 10000 }); const f = await fund2(c); const ch = chargeOf(f.session.payment_intent);
  const pending = ch.allocated_funds && ch.allocated_funds.balance.pending;
  c.status = "delivered"; const a = await approve(c); const t = tsOf(c)[0] || {}, p = verify(c);
  vuln(pending !== 10000 || a.status !== 200 || t.source_transaction !== ch.id || t.amount !== 9500 || heldOf(ch) !== 0 || p.length,
    `F2c approved before the card payment settled (Stripe holds apart ${pending} pending) -> ${a.status}; payout ${t.amount} linked to the payment (Stripe pays it out once the payment settles, as with any linked payout)${report(p)}`);
});

// ---------- F3 today's prices with the setting on ----------
await guard("F3", async () => {
  ON(); fsReset();
  const n = STRIPE.versions.length, c = mk1({ amount_cents: 10000 }), f = await fund2(c);
  const pi = f.session && f.session.payment_intent, ch = pi && chargeOf(pi), row = lines(c, "fund")[0] || {};
  const surplus = STRIPE.refunds.filter(r => r.payment_intent === pi && r.metadata.kind === "fee_surplus");
  c.status = "delivered"; const a = await approve(c); const t = tsOf(c)[0] || {};
  vuln(f.webhook.status !== 200 || !oldVersion(since(n)) || marked(c) || (ch && ch.allocated_funds) || surplus.length || row.provider_fee_cents != null || a.status !== 200 || t.amount !== 10000 || t.application_fee_amount,
    `F3 today's prices with the setting on -> paid ${f.webhook.status}, preview requests ${previewed(since(n)).length}, marked ${marked(c)}, held apart ${!!(ch && ch.allocated_funds)} (must be 0, false, false); the card fee sent back ${surplus.map(r => r.amount)} and Stripe's fee recorded ${row.provider_fee_cents} while only the 0 of standalone fees is known (must be none, null); payout ${t.amount} (must be the whole 10000)`);
});

// ---------- F4 payments made the old way, and the setting turned off again ----------
await guard("F4", async () => {
  OFF(); fsReset();
  const old = mk2({ amount_cents: 10000 }); const fo = await fund2(old);
  ON(); const n = STRIPE.versions.length; old.status = "delivered"; const ao = await approve(old);
  const to = tsOf(old)[0] || {}, cho = chargeOf(fo.session.payment_intent), po = verify(old);
  vuln(ao.status !== 200 || marked(old) || to.source_transaction !== cho.id || to.application_fee_amount || to.metadata.part !== undefined || !oldVersion(since(n)) || po.length,
    `F4 an Order paid before the setting was on, approved after -> ${ao.status}; marked ${marked(old)}, payout ${to.amount} the old way (linked ${to.source_transaction === cho.id}, no parts ${to.metadata && to.metadata.part === undefined}), preview requests ${previewed(since(n)).length} (must be 0)${report(po)}`);
  const c = mk2({ amount_cents: 10000 }); const f = await fund2(c); const ch = chargeOf(f.session.payment_intent);
  OFF(); c.status = "delivered"; const a = await approve(c); const t = tsOf(c)[0] || {}, p = verify(c);
  vuln(a.status !== 200 || t.source_transaction !== ch.id || t.application_fee_amount !== 500 || heldOf(ch) !== 0 || p.length,
    `F4 a payment held apart, the setting turned off before the payout -> ${a.status}; the payout still linked to it ${t.source_transaction === ch.id} with the 5% moved (${t.application_fee_amount}), nothing left held apart (${heldOf(ch)})${report(p)}`);
});

// ---------- F5 several Orders of one freelancer at once ----------
await guard("F5", async () => {
  ON(); fsReset();
  const A = mk2({ amount_cents: 10000 }), B = mk2({ amount_cents: 5000 }), D = mk2({ amount_cents: 7000 });
  const fa = await fund2(A), fb = await fund2(B), fd = await fund2(D);
  OFF(); const C = mk2({ amount_cents: 3000 }); await fund2(C); ON();          // paid the old way: in Cuvori's balance
  const chA = chargeOf(fa.session.payment_intent), chB = chargeOf(fb.session.payment_intent), chD = chargeOf(fd.session.payment_intent);
  const bal0 = STRIPE.balance;
  A.status = "delivered";
  const [ra, rb, rc] = await Promise.all([approve(A), cancel(B), cancel(C)]);
  const tA = tsOf(A), rB = refundsOf(B), pA = verify(A), pB = verify(B), pC = verify(C);
  vuln(ra.status !== 200 || rb.status !== 200 || rc.status !== 200 || tA.length !== 1 || tA[0].source_transaction !== chA.id || heldOf(chA) !== 0 || rB.length !== 1 || rB[0].charge !== chB.id || heldOf(chB) !== 0 || heldOf(chD) !== 7000
    || STRIPE.balance - bal0 !== 500 - 3000 || pA.length || pB.length || pC.length,
    `F5 three Orders of one freelancer at once (approve A, cancel B held apart, cancel C paid the old way) -> ${ra.status}/${rb.status}/${rc.status}; A paid from its own payment ${tA.length === 1 && tA[0].source_transaction === chA.id}, B refunded from its own (${rB.map(r => r.charge === chB.id)}), both now hold ${heldOf(chA)} / ${heldOf(chB)}; D untouched ${heldOf(chD)} (must be 7000); Cuvori's balance ${STRIPE.balance - bal0} (must be +500 - 3000: A's 5%, C's refund)${report([...pA, ...pB, ...pC])}`);
});

// ---------- F6 a top-up ----------
await guard("F6", async () => {
  ON(); fsReset();
  const c = mk2({ amount_cents: 10000 }); const f1 = await fund2(c); c.status = "funded"; const f2 = await topUp(c, 2000);
  const chA = chargeOf(f1.session.payment_intent), chB = chargeOf(f2.session.payment_intent);
  c.status = "delivered"; const a = await approve(c);
  const ts = tsOf(c).sort((x, y) => Number(x.metadata.part) - Number(y.metadata.part)), rl = lines(c, "release"), p = verify(c);
  const shape = ts.map(t => `${t.metadata.part}:${t.source_transaction === chA.id ? "A" : t.source_transaction === chB.id ? "B" : "?"}:${t.metadata.gross_cents}-${t.metadata.commission_cents}=${t.amount}(fee ${t.application_fee_amount || 0})`).join(" ");
  vuln(a.status !== 200 || shape !== "0:A:10000-600=9400(fee 600) 1:B:2000-0=2000(fee 0)" || heldOf(chA) + heldOf(chB) !== 0 || c.commission_cents !== 600 || sent(c) !== 11400 || rl.length !== 2 || new Set(rl.map(l => l.charge_ref)).size !== 2 || p.length,
    `F6 €100 + a €20 top-up, approved -> ${a.status}; parts ${shape} (must be 0:A:10000-600=9400(fee 600) 1:B:2000-0=2000(fee 0)); held apart left ${heldOf(chA) + heldOf(chB)}; 5% ${c.commission_cents} once; the freelancer has ${sent(c)}; ${rl.length} lines naming ${new Set(rl.map(l => l.charge_ref)).size} payments${report(p)}`);
});

// ---------- F7 parts of an Order over a top-up ----------
await guard("F7", async () => {
  ON(); fsReset();
  const c = mk2({ amount_cents: 10000 }); const f1 = await fund2(c); c.status = "funded"; const f2 = await topUp(c, 2000);
  const [m1, m2] = ms(c, [6000, 6000]); const chA = chargeOf(f1.session.payment_intent), chB = chargeOf(f2.session.payment_intent);
  const r1 = await approve(c, m1.id), r2 = await approve(c, m2.id);
  const l2 = lines(c, "release").filter(l => l.milestone_id === m2.id), p = verify(c);
  const shape = l2.map(l => `${l.charge_ref === chA.id ? "A" : l.charge_ref === chB.id ? "B" : "?"}:${l.amount_cents}-${l.commission_cents}`).sort().join(" ");
  vuln(r1.status !== 200 || r2.status !== 200 || shape !== "A:4000-300 B:2000-0" || c.commission_cents !== 600 || heldOf(chA) + heldOf(chB) !== 0 || c.status !== "completed" || p.length,
    `F7 €100 + €20, two parts of €60 -> ${r1.status}/${r2.status}; the second part's payout ${shape} (must be A:4000-300 B:2000-0: what the first payment still holds, the rest from the top-up); 5% ${c.commission_cents} (must be 600); held apart left ${heldOf(chA) + heldOf(chB)}; ${c.status}; the ledger check lists nothing${report(p)}`);
});

// ---------- F8 refunds ----------
await guard("F8", async () => {
  ON(); fsReset();
  const c = mk2({ amount_cents: 10000 }); const f = await fund2(c); const ch = chargeOf(f.session.payment_intent);
  c.status = "disputed"; c.disputed_at = past(); c.dispute_by = users.cl.id;
  const bal0 = STRIPE.balance; const r = await resolve(c, "split", { editor_percent: 60 });
  const t = tsOf(c)[0] || {}, back = refundsOf(c).reduce((a, x) => a + x.amount, 0), p = verify(c);
  vuln(r.status !== 200 || back !== 4000 || t.amount !== 5700 || t.application_fee_amount !== 300 || t.source_transaction !== ch.id || heldOf(ch) !== 0 || STRIPE.balance - bal0 !== 300 || p.length,
    `F8 a divided decision 60/40 -> ${r.status}; €${back / 100} back to the client, ${t.amount} to the freelancer linked to the payment, 5% ${t.application_fee_amount} (must be 4000, 5700, 300); held apart left ${heldOf(ch)}, Cuvori's balance +${STRIPE.balance - bal0} (must be +300: only its 5%)${report(p)}`);
  const d = mk2({ amount_cents: 10000 }); const fd = await fund2(d); const chd = chargeOf(fd.session.payment_intent);
  const bal1 = STRIPE.balance; const x = await cancel(d); const pd = verify(d);
  vuln(x.status !== 200 || refundsOf(d).reduce((a, y) => a + y.amount, 0) !== 10000 || heldOf(chd) !== 0 || STRIPE.balance !== bal1 || tsOf(d).length || pd.length,
    `F8 the freelancer cancels -> ${x.status}; all €100 back from the money held apart (${heldOf(chd)} left), Cuvori's balance ${STRIPE.balance - bal1} (must be 0: no 5% on money given back)${report(pd)}`);
  later(61); const h = await hourly();
  vuln(h.status !== 200 || marked(d) || marked(c), `F8 the hourly run once both are closed with nothing held apart -> ${h.status}; the marks go: ${!marked(d) && !marked(c)}`);
});

// ---------- F9 chargebacks ----------
const dispute = async (ch, status, extra = {}) => {
  STRIPE.disputes[ch.id] = { ...(STRIPE.disputes[ch.id] || {}), id: "dp_" + ch.id, status, ...(extra.amount ? { amount: extra.amount } : {}) };
  return webhook(cbEvent(["won", "lost", "warning_closed"].includes(status) ? "charge.dispute.closed" : "charge.dispute.created", ch, { status, ...extra }));
};
await guard("F9a", async () => { // lost before the payout
  ON(); fsReset();
  const c = mk2({ amount_cents: 10000 }); const f = await fund2(c); c.status = "funded"; const ch = chargeOf(f.session.payment_intent);
  const bal0 = STRIPE.balance; const took = fsDispute(ch.id, 10000);
  await dispute(ch, "needs_response"); fsDisputeClose(ch.id, false); await dispute(ch, "lost");
  const p = verify(c);
  vuln(took.fromHeld !== 10000 || c.status !== "refunded" || heldOf(ch) !== 0 || STRIPE.balance - bal0 !== -1500 || tsOf(c).length || p.length,
    `F9a a chargeback lost before the payout -> the bank took ${took.fromHeld} from the money held apart, ${took.fromBalance} from Cuvori's balance; the Order ${c.status}; Cuvori's balance ${STRIPE.balance - bal0} (must be -1500: the dispute fee only)${report(p)}`);
});
await guard("F9b", async () => { // lost after the payout
  ON(); fsReset({ sweepLocked: false });
  const c = mk2({ amount_cents: 10000 }); const f = await fund2(c); const ch = chargeOf(f.session.payment_intent); c.status = "delivered"; await approve(c);
  const bal0 = STRIPE.balance; const took = fsDispute(ch.id, 10000);
  await dispute(ch, "needs_response"); const pulled = heldOf(ch);
  fsDisputeClose(ch.id, false); await dispute(ch, "lost");
  later(61); const h1 = await hourly(); const note1 = String(c.money_error || "").includes(`money held apart at Stripe: ${ch.id}`), still = heldOf(ch);
  STRIPE.fs.sweepLocked = true;                                          // the owner asked Stripe, Stripe lets it move
  later(61); const h2 = await hourly(); const note2 = String(c.money_error || "").includes("money held apart at Stripe"), moved = evs(c, "held_apart_released");
  const p = verify(c, ["to_decide:commission_on_lost_chargeback"]);
  vuln(took.fromBalance !== 10000 || pulled !== 9500 || h1.status !== 200 || !note1 || still !== 9500 || h2.status !== 200 || note2 || heldOf(ch) !== 0 || moved.length !== 1 || moved[0].data.amount_cents !== 9500 || marked(c) || STRIPE.balance - bal0 !== -10000 - 1500 + 9500 || p.length,
    `F9b a chargeback lost after the payout -> the bank took ${took.fromBalance} from Cuvori's balance (nothing was held apart any more), the 95 pulled back went back into the money held apart (${pulled}); the hourly run: Stripe will not move it, the note asks the owner ${note1}, still held apart ${still}; once Stripe allows it: moved ${moved.map(e => e.data.amount_cents)}, note gone ${!note2}, mark gone ${!marked(c)}; Cuvori's balance ${STRIPE.balance - bal0} (must be -2000: the bank's 100 and its fee, less the 95 back)${report(p)}`);
});
await guard("F9c", async () => { // won after the payout
  ON(); fsReset();
  const c = mk2({ amount_cents: 10000 }); const f = await fund2(c); const ch = chargeOf(f.session.payment_intent); c.status = "delivered"; await approve(c);
  fsDispute(ch.id, 10000); await dispute(ch, "needs_response"); const pulled = heldOf(ch);
  fsDisputeClose(ch.id, true); const w = await dispute(ch, "won");
  const rp = tsOf(c).filter(t => /^retransfer_/.test(t.metadata.purpose)), p = verify(c);
  vuln(w.status !== 200 || pulled !== 9500 || rp.length !== 1 || rp[0].source_transaction !== ch.id || rp[0].amount !== 9500 || rp[0].application_fee_amount || heldOf(ch) !== 0 || sent(c) !== 9500 || p.length,
    `F9c a chargeback won after the payout -> ${w.status}; pulled back ${pulled} into the money held apart, paid back ${rp.map(t => t.amount)} linked to the payment ${rp.every(t => t.source_transaction === ch.id)}, nothing kept again; held apart left ${heldOf(ch)}; the freelancer has ${sent(c)}${report(p)}`);
});
await guard("F9e", async () => { // won after the payout, the re-payment's line not saved: the hourly run adds it
  ON(); fsReset();
  const c = mk2({ amount_cents: 10000 }); const f = await fund2(c); const ch = chargeOf(f.session.payment_intent); c.status = "delivered"; await approve(c);
  fsDispute(ch.id, 10000); await dispute(ch, "needs_response"); fsDisputeClose(ch.id, true);
  hooks.db = async (method, table, search, body) => { const b = JSON.parse(body || "{}"); return method === "POST" && table === "order_payments" && b.payout_purpose === "repay" ? new Response(JSON.stringify({ message: "canceling statement due to statement timeout" }), { status: 500, headers: { "content-type": "application/json" } }) : null; };
  const w = await dispute(ch, "won"); hooks.db = null;
  const noted = String(c.money_error || "").includes("ledger line of the re-payment not saved"), rp = tsOf(c).filter(t => /^retransfer_/.test(t.metadata.purpose));
  later(61); const h = await hourly();
  const lines2 = lines(c, "release").filter(l => l.payout_purpose === "repay"), p = verify(c);
  vuln(w.status !== 200 || rp.length !== 1 || rp[0].metadata.part !== "0" || !noted || h.status !== 200 || lines2.length !== 1 || lines2[0].provider_ref !== rp[0].id || lines2[0].charge_ref !== ch.id || String(c.money_error || "").includes("ledger line of the re-payment") || p.length,
    `F9e a re-payment from money held apart whose line was not saved (${w.status}) -> ${rp.length} re-payment (part ${rp[0] && rp[0].metadata.part}), the note says so ${noted}; the hourly run (${h.status}) -> ${lines2.length} line naming it and its payment ${!!lines2[0] && lines2[0].charge_ref === ch.id}, note gone ${!String(c.money_error || "").includes("ledger line of the re-payment")}${report(p)}`);
});
for (const wonTo of ["held", "payments"]) await guard("F9d", async () => { // won before the payout; where Stripe puts the money back is not in its docs
  ON(); fsReset({ wonTo });
  const c = mk2({ amount_cents: 10000 }); const f = await fund2(c); c.status = "funded"; const ch = chargeOf(f.session.payment_intent);
  fsDispute(ch.id, 10000); await dispute(ch, "needs_response"); fsDisputeClose(ch.id, true); await dispute(ch, "won");
  c.status = "delivered"; const a = await approve(c);
  const ts = tsOf(c), p = verify(c);
  const shape = ts.map(t => (t.source_transaction === ch.id ? "linked" : "balance") + ":" + t.amount).join(" ");
  vuln(a.status !== 200 || sent(c) !== 9500 || c.commission_cents !== 500 || heldOf(ch) !== 0 || shape !== (wonTo === "held" ? "linked:9500" : "balance:9500") || p.length,
    `F9d a chargeback won before the payout, Stripe giving the money back ${wonTo === "held" ? "into the money held apart" : "to Cuvori's balance"} -> approved ${a.status}; payout ${shape} (must be ${wonTo === "held" ? "linked:9500" : "balance:9500"}); the freelancer has ${sent(c)}, 5% ${c.commission_cents}${report(p)}`);
});

// ---------- F10 failed payments ----------
await guard("F10", async () => {
  ON(); fsReset();
  const a = mk2({ amount_cents: 10000 }); const fa = await fund2(a, { brand: "jcb" });
  vuln(!fa.refused || a.funded_cents || marked(a), `F10 a JCB card on the page -> ${fa.refused || "TAKEN"}; paid in ${a.funded_cents}, marked ${marked(a)} (must be refused, 0, false)`);
  const b = mk2({ amount_cents: 10000 }); await checkout(b); const sb = pay(b.stripe_checkout_id); b.status = "cancelled";
  const wb = await webhook(completed(sb)); const pib = STRIPE.intents[sb.payment_intent];
  vuln(wb.status !== 200 || pib.status !== "canceled" || marked(b) || b.funded_cents, `F10 a hold for an Order cancelled meanwhile -> ${wb.status}; the hold ${pib.status}, marked ${marked(b)}, paid in ${b.funded_cents} (must be canceled, false, 0)`);
  const c = mk2({ amount_cents: 10000 }); const fc = await fund2(c, { brand: "cartes_bancaires" }); const chc = chargeOf(fc.session.payment_intent);
  const ev = evs(c, "held_apart")[0] || { data: {} }; c.status = "delivered"; const ac = await approve(c); const tc = tsOf(c)[0] || {}, pc = verify(c);
  vuln(fc.webhook.status !== 200 || c.funded_cents !== 10000 || chc.allocated_funds || ev.data.held !== false || ac.status !== 200 || tc.amount !== 9500 || tc.application_fee_amount || pc.length,
    `F10 a card network Stripe cannot hold apart (Cartes Bancaires), Stripe charging it the old way -> paid ${fc.webhook.status} (${c.funded_cents}); held apart ${!!chc.allocated_funds}, the history says held ${ev.data.held}; approved ${ac.status}: ${tc.amount} the old way${report(pc)}`);
  fsReset({ unsupported: "refuse" });
  const hooksBefore = hooks.stripe;
  hooks.stripe = (path, method, p) => (method === "POST" && /^\/payment_intents\/pi_[A-Za-z0-9]+$/.test(path) && p.get("allocated_funds[enabled]") === "false" ? [400, { error: { type: "invalid_request_error", message: "allocated_funds cannot be changed for this PaymentIntent" } }] : null);
  const d = mk2({ amount_cents: 10000 }); const fd = await fund2(d, { brand: "cartes_bancaires" }); hooks.stripe = hooksBefore;
  const pid = STRIPE.intents[fd.session.payment_intent];
  vuln(pid.status !== "canceled" || d.funded_cents || d.status !== "accepted" || evs(d, "late_payment_released").length !== 1,
    `F10 the same card, Stripe refusing to charge it held apart -> the hold ${pid.status}, paid in ${d.funded_cents}, the Order ${d.status}, the history says nothing was charged ${evs(d, "late_payment_released").length} (must be canceled, 0, accepted, 1)`);
  STRIPE.fs = null;                                                      // no access: Stripe refuses the preview's parameters
  const e = mk2({ amount_cents: 10000 }); const r = await checkout(e);
  vuln(r.status === 200 || e.stripe_checkout_id || Object.values(STRIPE.intents).some(x => x.metadata.contract_id === e.id),
    `F10 the setting on without Stripe's preview on the account -> the page ${r.status} (must not be made: no payment can start), nothing at Stripe for the Order`);
});

// ---------- F11 notices twice, a hold that is not Cuvori's, a forged notice, two approvals at once ----------
await guard("F11", async () => {
  ON(); fsReset();
  const c = mk2({ amount_cents: 10000 }); await checkout(c); const s = pay(c.stripe_checkout_id);
  const [w1, w2] = await Promise.all([webhook(completed(s)), webhook(completed(s))]); const w3 = await webhook(completed(s));
  const caps = STRIPE.versions.filter(v => v.path === `/payment_intents/${s.payment_intent}/capture`).length;
  // a hold on Cuvori's Stripe account that is not a Cuvori Order's (something else sold through the account)
  const pi = "pi_notcuvori" + Math.random().toString(36).slice(2, 8), ch = "ch_notcuvori" + Math.random().toString(36).slice(2, 8);
  STRIPE.intents[pi] = { id: pi, amount: 5000, amount_received: 0, latest_charge: ch, status: "requires_capture", capture_method: "manual", metadata: {}, allocated_requested: true };
  STRIPE.charges[ch] = { id: ch, currency: "eur", amount: 5000, amount_refunded: 0, sourced: 0, payment_intent: pi, captured: false, payment_method_details: { card: { brand: "visa" } }, created: Math.floor(Date.now() / 1000) };
  const w4 = await webhook(completed({ id: "cs_notcuvori", object: "checkout.session", mode: "payment", status: "complete", payment_status: "unpaid", payment_intent: pi, client_reference_id: null, metadata: { allocated_funds: "checkout" }, amount_total: 5000, currency: "eur" }));
  // a notice with a wrong signature
  // (the first character changed for certain: set to "0", it was the real one 1 time in 16, and the check failed by chance)
  const bad = completed(s); bad.headers["stripe-signature"] = bad.headers["stripe-signature"].replace(/v1=(.)/, (m, ch) => "v1=" + (ch === "0" ? "1" : "0"));
  const w5 = await webhook(bad);
  c.status = "delivered"; const [a1, a2] = await Promise.all([approve(c), approve(c)]);
  const p = verify(c);
  vuln([w1, w2, w3].some(w => w.status !== 200) || caps !== 1 || lines(c, "fund").length !== 1 || evs(c, "held_apart").length !== 1 || c.funded_cents !== 10000
    || STRIPE.intents[pi].status !== "requires_capture" || w5.status === 200 || tsOf(c).length !== 1 || ![a1.status, a2.status].includes(200) || sent(c) !== 9500 || p.length,
    `F11 the payment's notice three times (two at once) -> charged ${caps} time(s), ${lines(c, "fund").length} payment line, ${evs(c, "held_apart").length} history line, paid in ${c.funded_cents}; a hold that is not Cuvori's (${w4.status}) -> left ${STRIPE.intents[pi].status} (must be untouched); a wrongly signed notice -> ${w5.status}; two approvals at once (${a1.status}/${a2.status}) -> ${tsOf(c).length} payout, the freelancer has ${sent(c)}${report(p)}`);
});

// ---------- F12 Stripe's answer lost between two parts ----------
await guard("F12", async () => {
  ON(); fsReset();
  const c = mk2({ amount_cents: 10000 }); await fund2(c); c.status = "funded"; await topUp(c, 2000); c.status = "delivered";
  let cut = 0;
  hooks.stripe = (path, method, p) => { if (method === "POST" && path === "/transfers" && p.get("metadata[part]") === "1" && cut++ === 0) { throw Object.assign(new Error("socket hang up"), { network: true }); } return null; };
  const a1 = await approve(c); hooks.stripe = null;
  const mid = tsOf(c).length;
  later(61); const h = await hourly(); const a2 = c.status === "completed" ? { status: 200 } : await approve(c);
  const ts = tsOf(c), parts = ts.map(t => t.metadata.part).sort().join(","), p = verify(c);
  vuln(a1.status === 200 || mid !== 1 || ts.length !== 2 || parts !== "0,1" || sent(c) !== 11400 || c.commission_cents !== 600 || c.status !== "completed" || p.length,
    `F12 the second part's request lost (${a1.status}) -> ${mid} part at Stripe; then the hourly run (${h.status}) / the next approval (${a2.status}) -> parts ${parts} (must be 0,1: the first never again), the freelancer has ${sent(c)} (must be 11400), 5% ${c.commission_cents}, ${c.status}${report(p)}`);
});

await guard("F12d", async () => { // Stripe made the first part, its answer was lost
  ON(); fsReset();
  const c = mk2({ amount_cents: 10000 }); await fund2(c); c.status = "funded"; await topUp(c, 2000); c.status = "delivered";
  let cut = 0;
  hooks.stripe = (path, method, p, h) => { if (method === "POST" && path === "/transfers" && p.get("metadata[part]") === "0" && cut++ === 0) { stripeHandle(path, method, p, h); throw Object.assign(new Error("socket hang up"), { network: true }); } return null; };
  const a1 = await approve(c); hooks.stripe = null;
  const mid = tsOf(c).length;
  later(61); const h = await hourly();
  const ts = tsOf(c), parts = ts.map(t => t.metadata.part).sort().join(","), p = verify(c);
  vuln(a1.status === 200 || mid !== 1 || ts.length !== 2 || parts !== "0,1" || sent(c) !== 11400 || c.commission_cents !== 600 || c.status !== "completed" || p.length,
    `F12d Stripe made the first part but its answer was lost (${a1.status}) -> ${mid} part at Stripe; the hourly run (${h.status}) -> parts ${parts} (must be 0,1: the first found at Stripe, never made again), the freelancer has ${sent(c)}, 5% ${c.commission_cents}, ${c.status}${report(p)}`);
});
// ---------- F12b a part's payout over two payments, its second transfer lost; F12c a part line not saved ----------
await guard("F12b", async () => {
  ON(); fsReset();
  const c = mk2({ amount_cents: 10000 }); const f1 = await fund2(c); c.status = "funded"; const f2 = await topUp(c, 2000);
  const [m1, m2] = ms(c, [6000, 6000]); await approve(c, m1.id);
  let cut = 0;
  hooks.stripe = (path, method, p) => { if (method === "POST" && path === "/transfers" && p.get("metadata[milestone_id]") === m2.id && p.get("metadata[part]") === "1" && cut++ === 0) throw Object.assign(new Error("socket hang up"), { network: true }); return null; };
  const r1 = await approve(c, m2.id); hooks.stripe = null;
  const mid = tsOf(c).filter(t => t.metadata.milestone_id === m2.id).length, st = DB.order_milestones.find(m => m.id === m2.id).status;
  later(61); const h = await hourly();
  const parts = tsOf(c).filter(t => t.metadata.milestone_id === m2.id), l2 = lines(c, "release").filter(l => l.milestone_id === m2.id), p = verify(c);
  vuln(r1.status === 200 || mid !== 1 || st === "released" || h.status !== 200 || parts.length !== 2 || l2.length !== 2 || l2.reduce((a, l) => a + l.amount_cents, 0) !== 6000 || DB.order_milestones.find(m => m.id === m2.id).status !== "released" || c.commission_cents !== 600 || c.status !== "completed" || p.length,
    `F12b a part's payout over two payments, the second transfer's answer lost (${r1.status}) -> ${mid} transfer at Stripe, the part ${st}; the hourly run (${h.status}) -> ${parts.length} transfers, ${l2.length} lines for ${l2.reduce((a, l) => a + l.amount_cents, 0)} (must be 2, 2, 6000), the part ${DB.order_milestones.find(m => m.id === m2.id).status}, 5% ${c.commission_cents}, ${c.status}${report(p)}`);
});
await guard("F12c", async () => {
  ON(); fsReset();
  const c = mk2({ amount_cents: 10000 }); await fund2(c); c.status = "funded"; await topUp(c, 2000);
  const [m1, m2] = ms(c, [6000, 6000]); await approve(c, m1.id);
  hooks.db = async (method, table, search, body) => { const b = JSON.parse(body || "{}"); return method === "POST" && table === "order_payments" && b.kind === "release" && b.milestone_id === m2.id && b.charge_ref && b.amount_cents === 2000 ? new Response(JSON.stringify({ message: "canceling statement due to statement timeout" }), { status: 500, headers: { "content-type": "application/json" } }) : null; };
  const r = await approve(c, m2.id); hooks.db = null;
  const noted = String(c.money_error || "").includes("ledger line of a milestone payout not saved"), before = lines(c, "release").filter(l => l.milestone_id === m2.id).length;
  later(61); const h = await hourly();
  const l2 = lines(c, "release").filter(l => l.milestone_id === m2.id), p = verify(c);
  vuln(r.status !== 200 || !noted || before !== 1 || h.status !== 200 || l2.length !== 2 || String(c.money_error || "").includes("ledger line of a milestone payout") || c.released_cents !== 12000 || p.length,
    `F12c a part's payout over two payments, the second line not saved (${r.status}) -> the note says so ${noted}, ${before} line; the hourly run (${h.status}) -> ${l2.length} lines (must be 2), note gone ${!String(c.money_error || "").includes("ledger line of a milestone payout")}, paid out ${c.released_cents} (must be 12000: counted once)${report(p)}`);
});

// ---------- F13 the hourly run and money a closed Order still holds apart ----------
await guard("F13", async () => {
  ON(); fsReset();
  const c = mk2({ amount_cents: 10000 }); const f = await fund2(c); const ch = chargeOf(f.session.payment_intent); c.status = "delivered"; await approve(c);
  const open = mk2({ amount_cents: 8000 }); const fo = await fund2(open); const cho = chargeOf(fo.session.payment_intent);
  ch.allocated_funds.balance.available += 300;                            // Stripe gave something back into it after the payout
  const bal0 = STRIPE.balance, before = (STRIPE.balanceTransfers || []).length;
  later(61); const h1 = await hourly(); const h2 = await hourly();
  const moved = (STRIPE.balanceTransfers || []).slice(before), ev = evs(c, "held_apart_released");
  vuln(h1.status !== 200 || h2.status !== 200 || moved.length !== 1 || moved[0].amount !== 300 || heldOf(ch) !== 0 || STRIPE.balance - bal0 !== 300 || ev.length !== 1 || marked(c) || heldOf(cho) !== 8000 || !marked(open),
    `F13 a closed Order with 3.00 still held apart, the hourly run twice -> moved ${moved.map(b => b.amount)} once, to Cuvori's balance (+${STRIPE.balance - bal0}), history ${ev.length}, mark gone ${!marked(c)}; an open Order's money stays held apart (${heldOf(cho)}) and marked ${marked(open)}`);
});

// ---------- F14 standalone fees for the whole account ----------
await guard("F14", async () => {
  ON(); fsReset(); STRIPE.reports = { end: 0, runs: [], instant: true };
  const c2 = mk2({ amount_cents: 10000 }), c1 = mk1({ amount_cents: 10000 });
  const f2 = await fund2(c2, { fee: 175 }), f1 = await fund2(c1, { fee: 175 });
  const row2 = lines(c2, "fund")[0] || {}, row1 = lines(c1, "fund")[0] || {}, pi1 = f1.session.payment_intent;
  const zero = [row2.provider_fee_cents, row1.provider_fee_cents], earlyBack = STRIPE.refunds.filter(r => r.payment_intent === pi1 && r.metadata.kind === "fee_surplus").length;
  for (const f of [f2, f1]) { const ch = chargeOf(f.session.payment_intent); ch.created -= 2 * 86400; for (const r of STRIPE.feeRows) if (r.incurred_by === ch.id) r.created = ch.created; }
  for (const r of [row1, row2]) r.created_at = new Date(Date.now() - 2 * 86400e3).toISOString();
  STRIPE.reports.end = Math.floor(Date.now() / 1000) - 3600;
  later(61); await hourly(); for (const r of STRIPE.reports.runs) if (r.status !== "succeeded") finishReport(r); later(61); await hourly();
  const surplus = STRIPE.refunds.filter(r => r.payment_intent === pi1 && r.metadata.kind === "fee_surplus").reduce((a, r) => a + r.amount, 0);
  const collected = f1.session.amount_total - 10000 - Number(f1.session.metadata.connect_cents || 0);
  vuln(zero.some(z => z != null) || earlyBack || row2.provider_fee_cents !== 175 || row1.provider_fee_cents !== 175 || surplus !== collected - 175 || STRIPE.refunds.some(r => r.payment_intent === f2.session.payment_intent),
    `F14 standalone fees for the whole account (Stripe's fee 1.75, known only from the Fees report) -> at payment Stripe's fee recorded ${zero.join("/")} and the card fee sent back ${earlyBack} time(s) (must be null/null, 0); after the report: new prices ${row2.provider_fee_cents}, today's prices ${row1.provider_fee_cents} (must be 175 both), the card fee's surplus back ${surplus} of ${collected} (must be ${collected - 175}), nothing back on the new prices' payment`);
});

// ---------- F15 every history line has its text ----------
{
  const code = ["netlify/lib/cuvori.mjs", ...fs.readdirSync(path.join(root, "netlify/functions")).filter(f => f.endsWith(".mjs")).map(f => "netlify/functions/" + f)].map(f => fs.readFileSync(path.join(root, f), "utf8")).join("\n");
  const page = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const written = new Set([...code.matchAll(/orderEvent\([A-Za-z0-9_.]+, "([a-z_]+)"/g), ...code.matchAll(/event: "([a-z_]+)"/g)].map(m => m[1]));
  const quiet = (page.match(/const QUIET_EV=new Set\(\[([^\]]*)\]\)/) || [, ""])[1].split(",").map(x => x.trim().replace(/"/g, "")).filter(Boolean);
  const langs = ["en", "de", "ru", "lt", "es", "pl", "uk"];
  const missing = [...written].filter(e => !quiet.includes(e) && !new RegExp(`\\bo_ev_${e}:"`).test(page));
  const perLang = [...written].filter(e => !quiet.includes(e)).map(e => [e, (page.match(new RegExp(`\\bo_ev_${e}:"`, "g")) || []).length]).filter(([, n]) => n > 0 && n < langs.length);
  vuln(missing.length || perLang.length || !quiet.includes("held_apart") || !quiet.includes("held_apart_released"),
    `F15 every history line the payment code writes has its text on the Order page (${written.size} kinds) -> ${missing.length ? "MISSING: " + missing.join(", ") : "all have it"}${perLang.length ? "; NOT IN ALL 7 LANGUAGES: " + perLang.map(([e, n]) => `${e} (${n})`).join(", ") : ""}; left out on the page: ${quiet.join(", ") || "none"} (must include held_apart, held_apart_released)`);
}

console.error = realError;
const bad = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`${bad} vulnerable, ${out.length - bad} safe`);
process.exit(bad ? 1 : 0);
