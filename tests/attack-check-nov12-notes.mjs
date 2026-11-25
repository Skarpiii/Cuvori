// Check of 12 November, fourth part (both price plans): a note written onto an Order while another step is working on it was
// wiped out. Some steps write the Order's note together with other things (a refund made in the Stripe dashboard counted, a
// refund that failed at Stripe counted back, a chargeback decided), from the copy of the Order they read at the start. A note
// another step saved in between (the cancel's or a decision's "payouts not in the books", which is written after the Order's
// lock is let go) was then written over: the warning that money may have gone out twice was gone, and nobody saw it.
// N1 a refund made in the Stripe dashboard, part of the payment (the Order goes to a dispute)
// N1b a second such refund while the Order is in the dispute the first one opened (written the other way: only the money)
// N2 the same, on an Order where money went out twice (the E3 probe of the review: a payout whose answer was lost, a first
//    refund in the dashboard, then a second one)
// N3 a refund made in the Stripe dashboard of the whole payment (the Order is refunded)
// N4 a refund made in the dashboard that failed at Stripe afterwards (counted back)
// N5 a chargeback the bank decided for Cuvori
// N6 a chargeback the bank decided for the client
// Each is done twice: once as it is, once with the note saved at the moment the step writes the Order. With the note saved
// in between, everything must come out the same (Stripe's notices all answered, the Order's status and money), and the note
// must still be there, with the notes the step writes itself.
// N7 the other way round: the admin marks the Order's notes as handled at the moment a step writes it: they must not come back
// N8 a note that changes at every write: the step fails (Stripe sends its notice again), nothing is written over, and the
//    notice sent again goes through
import { DB, STRIPE, V56, users, hooks, req, call, mk, reset, fns, pay, signed, uuid } from "./fn-harness.mjs";
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
// one write that lands at Stripe while its answer is lost (the connection drops)
const FAULT = { pred: null, hit: 0 };
const innerFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (FAULT.pred && FAULT.pred(u, init)) {
    FAULT.pred = null; FAULT.hit++;
    await innerFetch(url, init);
    const e = new TypeError("fetch failed"); e.cause = { code: "UND_ERR_SOCKET" }; throw e;
  }
  return innerFetch(url, init);
};
const lostTransfer = () => { FAULT.pred = (u, init) => u.includes("api.stripe.com/v1/transfers") && init.method === "POST" && !u.includes("reversals"); };
const chargeOf = (pi) => STRIPE.charges[STRIPE.intents[pi].latest_charge];
const webhook = (ev) => call(fx.webhook, req("POST", "x", ev));
const checkout = (c) => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
const approve = (c, milestone_id) => call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, ...(milestone_id ? { milestone_id } : {}) } }));
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
const PLANS = [["plan 2", mk2], ["plan 1", mk1]];
const row = (c) => DB.contracts.find(x => x.id === c.id) || c;
const ms = (c, amounts, status = "submitted") => { c.has_milestones = true; return amounts.map((a, i) => { const m = { id: uuid(), order_id: c.id, title: "part " + (i + 1), amount_cents: a, status, position: i + 1 }; DB.order_milestones.push(m); return m; }); };
async function fund(c) { const r = await checkout(c); if (r.status !== 200) throw new Error("checkout " + r.status); const s = pay(c.stripe_checkout_id); await webhook(completed(s)); return s.payment_intent; }
const ready = (yes) => { STRIPE.accounts.acct_1EditorAAAAAAAA.payouts_enabled = yes; DB.payout_details.find(p => p.id === users.ed.id).stripe_payouts_enabled = yes; };
const dashRefund = (pi, amount) => { const ch = chargeOf(pi); ch.amount_refunded += amount; STRIPE.balance -= amount;
  const r = { id: "re_dash" + Math.random().toString(36).slice(2, 10), created: Date.now() / 1000, amount, contract: null, metadata: {}, payment_intent: pi, charge: ch.id, status: "succeeded" }; STRIPE.refunds.push(r); return r; };
const refundedEvent = (pi) => { const ch = chargeOf(pi); return signed({ type: "charge.refunded", data: { object: { id: ch.id, object: "charge", payment_intent: pi, amount: ch.amount, amount_refunded: ch.amount_refunded, refunded: ch.amount_refunded >= ch.amount, currency: "eur" } } }); };
const failedEvent = (r) => signed({ type: "charge.refund.updated", data: { object: { ...r, object: "refund", status: "failed", currency: "eur", failure_reason: "expired_or_canceled_card" } } });
const refundFails = (r) => { r.status = "failed"; const ch = STRIPE.charges[r.charge]; ch.amount_refunded -= r.amount; STRIPE.balance += r.amount; return failedEvent(r); };
const notDisputed = (c) => { const x = row(c); if (x.status === "disputed") { x.status = "funded"; x.disputed_at = null; x.dispute_by = null; } };
const notes = (c) => String(row(c).money_error || "").split(" · Also: ").filter(Boolean);
// the note another step saves meanwhile, as noteUncounted saves it (putNote: a fresh read, written only while the note is
// still what it read, the new note before the others of its rank)
const BOOKS = "payouts not in the books: Stripe made payouts for this Order that its books don't show and can't take (refused before a cancel or a decision). Money may have gone out twice";
const booksNote = (c) => notes(c).filter(n => n.startsWith("payouts not in the books")).length;
// the Order's own ids, times and refs differ from one run to the next: left out when two runs are compared
const plain = (s) => String(s).replace(/\b(pi|ch|dp|du|re|tr|cs|py|trr|txn|acct)_[A-Za-z0-9]+/g, "$1_x").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "id")
  .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "time").replace(/ref [0-9a-f]{8}/g, "ref x");
const state = (c) => { const x = row(c); return { status: x.status, funded: x.funded_cents, paidOut: x.released_cents, back: x.refunded_cents, chargeback: x.chargeback_status || null, resolution: x.resolution || null }; };

// The step's write of the Order (a PATCH of contracts whose body `re` matches): the note is saved just before it lands
// (times: at that many of its writes, each time a newer such note in the place of the one before, as noteUncounted does)
function noteAt(c, re, times = 1) {
  const seen = { at: 0 };
  hooks.db = async (m, t, s, b) => {
    if (seen.at < times && m === "PATCH" && t === "contracts" && String(s).includes(c.id) && re.test(String(b))) {
      seen.at++;
      const x = row(c);
      const parts = notes(c).filter(n => !n.startsWith("payouts not in the books"));
      const at = parts.findIndex(n => !/^chargeback(:| won)/.test(n));
      parts.splice(at < 0 ? parts.length : at, 0, times > 1 ? `${BOOKS} (${seen.at})` : BOOKS);
      x.money_error = parts.join(" · Also: ");
    }
    return null;
  };
  return seen;
}

// each scenario returns the answers Stripe got for the step's notice; `inject` saves the note at the step's write
const SCENARIOS = [
  ["N1", "a refund of 10.00 of the 100.00 payment made in the Stripe dashboard", /made outside Cuvori/, async (mkX, inject) => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const pi = await fund(c);
    dashRefund(pi, 1000);
    const seen = inject ? noteAt(c, inject) : null;
    const w = await webhook(refundedEvent(pi)); hooks.db = null;
    return { c, answers: [w.status], seen };
  }],
  ["N1b", "10.00 refunded in the Stripe dashboard, then 20.00 more while the Order is in the dispute the first one opened", /made outside Cuvori/, async (mkX, inject) => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const pi = await fund(c);
    dashRefund(pi, 1000); const w1 = await webhook(refundedEvent(pi));
    dashRefund(pi, 2000);
    const seen = inject ? noteAt(c, inject) : null;
    const w = await webhook(refundedEvent(pi)); hooks.db = null;
    return { c, answers: [w1.status, w.status], seen };
  }],
  ["N2", "money went out twice (a payout whose answer was lost, 50.00 refunded in the dashboard), then 10.00 more refunded there", /made outside Cuvori/, async (mkX, inject) => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const pi = await fund(c);
    row(c).status = "funded"; const [m1] = ms(c, [6000, 4000]);
    lostTransfer(); await approve(c, m1.id); FAULT.pred = null; later(5);
    dashRefund(pi, 5000); const w1 = await webhook(refundedEvent(pi)); notDisputed(c);
    dashRefund(pi, 1000);
    const seen = inject ? noteAt(c, inject) : null;
    const w = await webhook(refundedEvent(pi)); hooks.db = null;
    return { c, answers: [w1.status, w.status], seen };
  }],
  ["N3", "the whole payment refunded in the Stripe dashboard", /"resolution":"refund"[^}]*"refunded_cents"/, async (mkX, inject) => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const pi = await fund(c);
    dashRefund(pi, chargeOf(pi).amount);                                       // (today's prices: the card fee with it)
    const seen = inject ? noteAt(c, inject) : null;
    const w = await webhook(refundedEvent(pi)); hooks.db = null;
    return { c, answers: [w.status], seen };
  }],
  ["N4", "30.00 refunded in the Stripe dashboard, and that refund failed at Stripe afterwards", /"money_error":"[^"]*refund re_dash/, async (mkX, inject) => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const pi = await fund(c);
    const r = dashRefund(pi, 3000); const w1 = await webhook(refundedEvent(pi)); notDisputed(c);
    const ev = refundFails(r);
    const seen = inject ? noteAt(c, inject) : null;
    const w = await webhook(ev); hooks.db = null;
    return { c, answers: [w1.status, w.status], seen };
  }],
  ["N5", "a chargeback of the 100.00 payment the bank decided for Cuvori", /"chargeback_status":"won"/, async (mkX, inject) => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const pi = await fund(c); const ch = chargeOf(pi);
    const w1 = await dispute(c, ch, "needs_response");
    const seen = inject ? noteAt(c, inject) : null;
    const w = await dispute(c, ch, "won"); hooks.db = null;
    return { c, answers: [w1.status, w.status], seen };
  }],
  ["N6", "a chargeback of the 100.00 payment the bank decided for the client", /"chargeback_status":"lost"/, async (mkX, inject) => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const pi = await fund(c); const ch = chargeOf(pi);
    const w1 = await dispute(c, ch, "needs_response");
    const seen = inject ? noteAt(c, inject) : null;
    const w = await dispute(c, ch, "lost"); hooks.db = null;
    return { c, answers: [w1.status, w.status], seen };
  }],
];

for (const [key, what, re, run] of SCENARIOS) {
  for (const [name, mkX] of PLANS) {
    await guard(`${key} [${name}]`, async () => {
      const a = await run(mkX, null); const A = { answers: a.answers, ...state(a.c) }, An = notes(a.c).map(plain);
      reset();
      const b = await run(mkX, re); const B = { answers: b.answers, ...state(b.c) }, Bn = notes(b.c).map(plain);
      const same = JSON.stringify(A) === JSON.stringify(B), answered = A.answers.every(x => x === 200);
      // the notes the step writes itself are all there, and the note saved meanwhile too
      const kept = booksNote(b.c) === 1, own = An.every(n => Bn.includes(n)) && Bn.length === An.length + 1;
      vuln(!b.seen || !b.seen.at || !same || !answered || !kept || !own,
        `${key} [${name}] ${what}; the note "payouts not in the books" saved while the step writes the Order (${b.seen && b.seen.at ? "saved" : "never reached"}): after it the note is ${kept ? "there" : "gone"}; `
        + `notes ${JSON.stringify(Bn.map(n => n.slice(0, 50)))}, as it is without that note ${JSON.stringify(An.map(n => n.slice(0, 50)))}; `
        + `${same ? "the rest the same" : `the rest differs: ${JSON.stringify(B)} instead of ${JSON.stringify(A)}`}; Stripe's notices answered ${A.answers.join("/")} (must be: the note stays, everything else as without it, every notice answered 200)`);
    });
  }
}

// N7: the Order has a note (a refund of 10.00 made in the Stripe dashboard); a chargeback is opened, and the admin marks the
// notes as handled (schema v56's admin_clear_order_note) at the moment the bank's "won" decision is written
for (const [name, mkX] of PLANS) {
  await guard(`N7 [${name}]`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const pi = await fund(c); const ch = chargeOf(pi);
    dashRefund(pi, 1000); await webhook(refundedEvent(pi)); notDisputed(c);
    const before = notes(c).filter(n => n.startsWith("Refund of 10.00")).length;
    const w1 = await dispute(c, ch, "needs_response");
    let cleared = 0;
    hooks.db = async (m, t, s, b) => {
      if (!cleared && m === "PATCH" && t === "contracts" && String(s).includes(c.id) && /"chargeback_status":"won"/.test(String(b))) { cleared = 1; row(c).money_error = null; }
      return null;
    };
    const w = await dispute(c, ch, "won"); hooks.db = null;
    const back = notes(c).filter(n => n.startsWith("Refund of 10.00")).length;
    vuln(before !== 1 || !cleared || w1.status !== 200 || w.status !== 200 || row(c).chargeback_status !== "won" || back !== 0,
      `N7 [${name}] the note "Refund of 10.00 … made outside Cuvori" (${before}) marked as handled while the bank's "won" decision is written (${cleared ? "marked" : "never reached"}; notices ${w1.status}/${w.status}, chargeback ${row(c).chargeback_status}): after it the note is ${back ? "back" : "still gone"}; notes ${JSON.stringify(notes(c).map(n => n.slice(0, 50)))} (must be: still gone)`);
  });
}

// N8: a note that changes at each of the step's writes (five times running): the bank's "won" decision is not written over it
// and fails (Stripe sends it again); sent again, it goes through, and the newest note is still there
for (const [name, mkX] of PLANS) {
  await guard(`N8 [${name}]`, async () => {
    ready(true);
    const c = mkX({ amount_cents: 10000, price: 100 }); const pi = await fund(c); const ch = chargeOf(pi);
    const w1 = await dispute(c, ch, "needs_response");
    const seen = noteAt(c, /"chargeback_status":"won"/, 5);
    const w2 = await dispute(c, ch, "won"); hooks.db = null;
    const mid = { status: row(c).chargeback_status, books: notes(c).filter(n => n.startsWith(BOOKS + " (5)")).length };
    later(5); const w3 = await dispute(c, ch, "won");
    const books = notes(c).filter(n => n.startsWith("payouts not in the books"));
    vuln(w1.status !== 200 || seen.at !== 5 || w2.status === 200 || mid.status !== "open" || mid.books !== 1 || w3.status !== 200 || row(c).chargeback_status !== "won" || books.length !== 1 || books[0] !== BOOKS + " (5)",
      `N8 [${name}] the note changed at each of 5 writes (${seen.at}): the "won" notice answered ${w2.status}, chargeback then ${mid.status}, the newest note ${mid.books ? "there" : "gone"}; sent again: ${w3.status}, chargeback ${row(c).chargeback_status}, notes ${JSON.stringify(notes(c).map(n => n.slice(0, 60)))} (must be: not 200 and still open with the note there, then 200 and won with it still there)`);
  });
}

console.error = realError;
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
