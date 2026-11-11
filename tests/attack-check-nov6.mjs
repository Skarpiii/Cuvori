// Check of 6 November (the third check of the payment code): regression checks for what it proved. Both price plans where
// both are affected.
// L1 today's prices: a won chargeback's re-payment to the freelancer was made at Stripe, but its answer was lost (or the
//    count right after it was refused). Before Stripe sent the notice again or the hourly run counted it, the freelancer
//    gave the Order back, or Cuvori decided 'refund' or 'release': the settlement did not count the re-payment, so the
//    client got back 100.00 instead of 40.00 (or the freelancer was paid 100.00 more): 160.00 out of 100.00 paid in.
// L2 a second chargeback noted while the first was open and decided for the client; the first won. Taking the second over
//    broke off after it was recorded (one database answer that did not come): nothing ever finished it, the Order stayed
//    frozen for good (no payout, decision or cancel), neither Stripe's notice sent again nor the hourly run touched it.
// L3 a chargeback the bank decided for Cuvori whose "decided" notice came before its "opened" notice (Stripe does not
//    always send them in order, and sends a failed one again): the late "opened" notice recorded it as open, pulled the
//    freelancer's pay back, and the Order froze for good.
// L4 Cuvori's 'split' at 60% whose history line could not be saved; the admin decides 'split' again at 30%: the 60%
//    amounts were carried out, the history said 30%, and the admin's answer said only "Done" (L4c).
// L5 the freelancer gave the Order back and its refund failed at Stripe; the admin pressed 'refund' to finish it: the
//    history recorded it as a decision of Cuvori's made by the freelancer.
// L6 the "decision not on record" note: it stayed on an Order a chargeback had closed (asking the admin to decide an Order
//    that holds nothing); the admin page offered "Mark as handled" for it and then said the hourly run removes it (it never
//    does); and a note written at the very moment the decision was saved stayed for good.
// L7 the freelancer's cancel with preview sent as text ("true") or a number gave the whole Order back instead of only
//    showing the amount.
// L8 the smaller points: a top-up whose ledger line was saved but whose answer was lost got a false "check by hand" note
//    (L8a); a payment sent again after its history line was refused got a second chat card (L8b); a late payment's history
//    line refused once was never written (L8c); a lost chargeback the bank later turned into a win for Cuvori said nothing
//    (L8d); a chargeback lost on a payment already refunded in full said nothing either (L8e); a part worth more than the
//    Order still holds waited without a word to anyone, and the client's Approve button only gave an error (L8f); the
//    payment history lines and chat cards carried Stripe's payment id, which both people can read (L8g).
// The second round (the re-check of these fixes, 6 November):
// L9 the first chargeback's "won" notice failed, and the hourly run took the second chargeback over before Stripe sent the
//    notice again: the first one's "chargeback won" history line was never written (the database's ledger check then
//    showed its re-payment as one "for a chargeback not won", at the new prices).
// L10 two saves failed at once (a part's payout line, and the count of the re-payment after a won chargeback); the
//    freelancer then gave the Order back: the money ended right, but the cancel worked out and answered 70.00 where 40.00
//    went back (and an admin's decision showed its amounts the same way); with a part larger than the re-payment (L10b) the
//    money itself went wrong: the client got back 20.00 of 30.00, or 11.50 stayed at Cuvori on a closed Order.
// L11 a 1.00 Order: a 'split' at 60% not on record, decided again at 61%: the 60% amounts were carried out under a 61%
//    history line (a one-cent difference was taken as the same percentage).
// L12 a decision not on record, then a chargeback took part of the payment and sent the Order back to a dispute: the note
//    still said the old decision "is then carried out" when decided again, though it no longer existed.
// Run: node tests/attack-check-nov6.mjs  (TARGET=<folder> runs it against another copy of the payment code)
import { DB, DBQ, STRIPE, V56, users, hooks, req, call, mk, reset, fns, pay, signed, uuid } from "./fn-harness.mjs";
import { checkLines, reconcile, listed } from "./plan2-ledger.mjs";
import fs from "node:fs";
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const realError = console.error; console.error = () => {};
const guard = async (name, fn) => { try { await fn(); } catch (e) { out.push(`VULNERABLE ${name} threw: ${e && e.stack ? e.stack.split("\n").slice(0, 2).join(" ") : e}`); } finally { reset(); FAULT.pred = null; } };
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

// ---------- L1 a re-payment made at Stripe but not counted yet, then a cancel or a decision ----------
for (const [name, mkX, plan] of PLANS) {
  for (const fault of ["lost", "refused"]) {
    for (const how of ["cancel", "refund", "release"]) {
      await guard(`L1 [${name}] ${how} ${fault}`, async () => {
        ready(true);
        const c = mkX(); const f = await fund2(c); c.status = "funded";
        const ch = chargeOf(f.session.payment_intent);
        const [m1] = ms(c, [6000, 4000]);
        await approve(c, m1.id);
        await dispute(c, ch, "needs_response");
        if (fault === "lost") arm("lost", (u, init) => u.includes("api.stripe.com/v1/transfers") && init.method === "POST" && bodyOf(init).includes("retransfer_"));
        else arm("refused", (u, init) => u.includes("/rest/v1/contracts") && init.method === "PATCH" && /"released_cents"/.test(bodyOf(init)));
        const w = await dispute(c, ch, "won");                                   // the webhook fails: Stripe sends the notice again later
        const hit = FAULT.hit; FAULT.pred = null; FAULT.hit = 0;
        const r = how === "cancel" ? await cancel(c) : await resolve(c, how);
        const rec = how === "cancel" ? (events(c, "cancelled")[0] || {}).data || {} : (events(c, "decision").slice(-1)[0] || {}).data || {};
        for (let i = 0; i < 3; i++) { await webhook(cbEvent("charge.dispute.closed", ch, { status: "won" })); later(DAY); await hourly(); }
        const part1 = plan === 2 ? 5700 : 6000;
        const freelancer = how === "release" ? (plan === 2 ? 9500 : 10000) : part1, client = how === "release" ? 0 : 4000;
        // what the history says moved: the cancel's refund, or the decision's two amounts (before the 5%)
        const said = how === "cancel" ? [rec.refund_cents, r.json && r.json.refunded] : [rec.editor_cents, rec.refund_cents, r.json && r.json.editorCents, r.json && r.json.refundCents];
        const must = how === "cancel" ? [4000, 4000] : how === "refund" ? [0, 4000, 0, 4000] : [4000, 0, 4000, 0];
        const x = row(c), p = plan === 2 ? ledger(c) : [];
        vuln(!hit || w.status !== 500 || r.status !== 200 || sent(c) !== freelancer || back(c) !== client || held(c) !== 0 || notes(c).some(n => CB_MARK.test(n)) || JSON.stringify(said) !== JSON.stringify(must) || p.length,
          `L1 [${name}] part 1 paid, pulled back by a chargeback, won; the re-payment's ${fault === "lost" ? "answer lost" : "count refused"} (${w.status}); then ${how} -> ${r.status}: the freelancer has ${sent(c)}, the client got back ${back(c)} (out ${sent(c) + back(c)} of 10000), held ${held(c)}, ${x.status}; the history says ${JSON.stringify(said)}; note ${JSON.stringify(x.money_error)} (must be ${freelancer}, ${client}, 0, ${JSON.stringify(must)}, no chargeback note)${report(p)}`);
      });
    }
  }
}

// ---------- L2 a second chargeback's takeover broken off after it was recorded ----------
for (const [name, mkX, plan] of PLANS) {
  for (const variant of ["webhook", "hourly"]) {
    await guard(`L2 [${name}] ${variant}`, async () => {
      ready(true);
      const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); c.status = "funded"; const ch = chargeOf(f.session.payment_intent);
      const u = await topUp(c, 5000); const ch2 = chargeOf(u.session.payment_intent);
      const [m1] = ms(c, [10000, 5000]); await approve(c, m1.id);
      await dispute(c, ch, "needs_response"); await dispute(c, ch2, "needs_response"); await dispute(c, ch2, "lost");
      // the database does not answer the second chargeback's closing plan (the first write after it is recorded)
      let fired = false;
      hooks.db = async (method, table, search, body) => { if (!fired && method === "POST" && table === "money_keys" && String(body || "").includes(`chargeback_result:${c.id}:dp_${ch2.id}`)) { fired = true; return dbError(); } return null; };
      let w1, w2 = { status: "-" };
      if (variant === "webhook") {
        w1 = await dispute(c, ch, "won"); hooks.db = null;
        w2 = await webhook(cbEvent("charge.dispute.closed", ch, { status: "won" }));       // Stripe sends the first one's notice again
      } else {
        ready(false); w1 = await dispute(c, ch, "won"); ready(true);                     // the re-payment can't be made at once
        later(60); await hourly(); hooks.db = null;                                     // the re-payment, then the takeover breaks off
      }
      for (let i = 0; i < 3; i++) { later(DAY); await hourly(); }
      const x = row(c), must = plan === 2 ? 9500 : 10000, p = plan === 2 ? ledger(c) : [];
      vuln(!fired || x.chargeback_id !== "dp_" + ch2.id || x.chargeback_status !== "lost" || notes(c).some(n => OTHER_CB.test(n)) || x.status !== "completed" || held(c) !== 0 || sent(c) !== must || p.length,
        `L2 [${name}] ${variant}: the second chargeback's takeover broke off (${fired}); first won ${w1.status}, its notice again ${w2.status}; three days later: chargeback ${x.chargeback_id === "dp_" + ch2.id ? "the second" : "the first"} ${x.chargeback_status}, Order ${x.status}, held ${held(c)}, the freelancer has ${sent(c)}, note ${JSON.stringify(x.money_error)} (must be the second, lost, completed, 0, ${must}, no note)${report(p)}`);
    });
  }
}

// ---------- L3 the "decided for Cuvori" notice before the "opened" notice ----------
for (const [name, mkX, plan] of PLANS) {
  for (const ev of ["charge.dispute.created", "charge.dispute.funds_withdrawn"]) {
    await guard(`L3 [${name}] ${ev}`, async () => {
      ready(true);
      const c = mkX(); const f = await fund2(c); c.status = "funded"; const ch = chargeOf(f.session.payment_intent);
      const [m1, m2] = ms(c, [6000, 4000]);
      await approve(c, m1.id);
      const paid1 = sent(c), id = "dp_" + ch.id;
      STRIPE.disputes[ch.id] = { id, status: "won" };
      const w1 = await webhook(cbEvent("charge.dispute.closed", ch, { status: "won" }));
      const late = cbEvent(ev, ch, { status: "needs_response" });                         // the notice as it was when it was first sent
      STRIPE.disputeObjs[id].status = "won";                                                // Stripe's record of it now
      const w2 = await webhook(late);
      later(2 * 60); await hourly(); later(DAY); await hourly();
      const mid = { ...row(c) }, sentMid = sent(c);
      const a2 = await approve(c, m2.id);
      const x = row(c), must = plan === 2 ? 9500 : 10000, p = plan === 2 ? ledger(c) : [];
      vuln(w1.status !== 200 || w2.status !== 200 || sentMid !== paid1 || mid.chargeback_status === "open" || a2.status !== 200 || x.status !== "completed" || sent(c) !== must || x.money_error != null || p.length,
        `L3 [${name}] decided for Cuvori (${w1.status}), then ${ev} sent late (${w2.status}): the freelancer had ${paid1}, then ${sentMid}; chargeback ${mid.chargeback_status}; approve part 2 -> ${a2.status} ${JSON.stringify(a2.json && a2.json.error || "")}; Order ${x.status}, the freelancer has ${sent(c)}, note ${JSON.stringify(x.money_error)} (must keep ${paid1}, not open, 200, completed, ${must}, no note)${report(p)}`);
    });
  }
}

// ---------- L4 a stuck 'split' decided again at another percentage ----------
for (const [name, mkX, plan] of PLANS) {
  for (const [k, pct2] of [["L4", 30], ["L4b", 60]]) {
    await guard(`${k} [${name}]`, async () => {
      ready(true);
      const c = mkX(); await fund2(c); disputed(c);
      let fired = false;
      hooks.db = async (method, table, search, body) => { if (!fired && method === "POST" && table === "order_events" && /"event":"decision"/.test(body || "")) { fired = true; return dbError(); } return null; };
      const r1 = await resolve(c, "split", { editor_percent: 60 });
      hooks.db = null;
      later(15); await hourly();
      const r2 = await resolve(c, "split", { editor_percent: pct2 });
      later(60); await hourly();
      const x = row(c);
      // (the decision that moved the money is the last one recorded; the settlement's own time replaces its claim time)
      const rec = events(c, "decision").slice(-1);
      const share = pct2 * 100, gets = plan === 2 ? share - Math.round(share * 0.05) : share;
      const d = (rec[0] || {}).data || {};
      vuln(!fired || r1.status !== 503 || r2.status !== 200 || !r2.json || r2.json.editorCents !== share || r2.json.refundCents !== 10000 - share || sent(c) !== gets || back(c) !== 10000 - share || rec.length !== 1 || (k === "L4") !== !!d.replaced || d.editor_percent !== pct2 || d.editor_cents !== share || d.refund_cents !== 10000 - share,
        `${k} [${name}] 'split' 60% not on record (${r1.status}); decided again at ${pct2}% -> ${r2.status} ${JSON.stringify(r2.json)}: the freelancer got ${sent(c)}, the client ${back(c)}; the history of the decision carried out: ${JSON.stringify(rec.map(e => ({ pct: e.data.editor_percent, editor: e.data.editor_cents, refund: e.data.refund_cents, replaced: e.data.replaced ? e.data.replaced.decision : undefined })))} (must be 200, ${gets}, ${10000 - share}, ${pct2}% ${share}/${10000 - share}${k === "L4" ? ", in place of the stuck one" : ""})`);
    });
  }
}

{
  // the admin's answer after deciding says the amounts the decision divided, every time (it said only "Done" unless a
  // re-payment was owed, so a stuck decision carried out with other amounts went unseen)
  const go = page.split("\n").find(l => l.includes('fnCall("stripe-resolve"')) || "";
  vuln(!/toast\(res&&Number\.isInteger\(res\.editorCents\)&&Number\.isInteger\(res\.refundCents\)\?`Done: /.test(go),
    `L4c the admin's answer after a decision shows what it divided every time (${/toast\(res&&Number\.isInteger\(res\.editorCents\)/.test(go)})`);
}

// ---------- L5 the freelancer's own cancel, finished by the admin ----------
for (const [name, mkX] of PLANS) {
  await guard(`L5 [${name}]`, async () => {
    ready(true);
    const c = mkX(); await fund2(c); c.status = "delivered";
    let down = true;
    hooks.stripe = async (path, method) => (down && method === "POST" && path === "/refunds" ? [500, { error: { type: "api_error", message: "An unknown error occurred" } }] : null);
    const k = await cancel(c);
    down = false; hooks.stripe = null;
    const mid = row(c).status;
    const r = await resolve(c, "refund", { note: "" });
    const rec = events(c, "decision");
    vuln(k.status === 200 || mid !== "resolving" || r.status !== 200 || row(c).status !== "refunded" || back(c) !== 10000 || rec.length !== 0,
      `L5 [${name}] the freelancer's cancel stopped at Stripe (${k.status}, ${mid}); the admin's 'refund' -> ${r.status}: ${row(c).status}, the client got back ${back(c)}; "decision" lines ${JSON.stringify(rec.map(e => ({ by: e.actor === users.ed.id ? "the freelancer" : e.actor === users.adm.id ? "the admin" : e.actor, decision: e.data.decision })))} (must be refunded, 10000, none: it is the freelancer's cancel)`);
  });
}

// ---------- L6 the "decision not on record" note ----------
for (const [name, mkX] of PLANS) {
  for (const outc of ["lost", "won"]) {
    await guard(`L6a [${name}] ${outc}`, async () => {
      ready(true);
      const c = mkX(); const f = await fund2(c); const ch = chargeOf(f.session.payment_intent); disputed(c);
      let fired = false;
      hooks.db = async (method, table, search, body) => { if (!fired && method === "POST" && table === "order_events" && /"event":"decision"/.test(body || "")) { fired = true; return dbError(); } return null; };
      await resolve(c, "refund"); hooks.db = null;
      later(15); await hourly();
      const noted = notes(c).some(n => n.startsWith("decision not on record: "));
      await dispute(c, ch, "needs_response"); const w = await dispute(c, ch, outc);
      later(60); await hourly();
      const x = row(c);
      const left = notes(c).some(n => n.startsWith("decision not on record: "));
      // decided for the client: the Order is closed and the note goes; decided for Cuvori: the Order still holds the money,
      // the note stays and the admin's decision goes through
      const again = outc === "won" ? await resolve(c, "refund") : null;
      vuln(!noted || w.status !== 200 || (outc === "lost" ? (x.status !== "refunded" || left) : (!left || again.status !== 200 || row(c).status !== "refunded" || notes(c).some(n => n.startsWith("decision not on record: ")))),
        `L6a [${name}] a decision not on record (noted ${noted}), then a chargeback ${outc} (${w.status}): Order ${x.status}, the note ${left ? "stays" : "gone"}${again ? `; deciding again -> ${again.status}, ${row(c).status}, note ${JSON.stringify(row(c).money_error)}` : ""} (must be ${outc === "lost" ? "refunded, gone" : "kept, then 200, refunded, gone"})`);
    });
  }
}
for (const [name, mkX] of PLANS) {
  await guard(`L6b [${name}]`, async () => {
    ready(true);
    const c = mkX(); await fund2(c); disputed(c);
    let fired = false;
    hooks.db = async (method, table, search, body) => { if (!fired && method === "POST" && table === "order_events" && /"event":"decision"/.test(body || "")) { fired = true; return dbError(); } return null; };
    await resolve(c, "refund");
    // the hourly run writes its note in the very moment the admin's try again saves the decision
    let raced = false;
    hooks.db = async (method, table, search, body) => {
      if (!raced && method === "PATCH" && table === "contracts" && String(body || "").includes("decision not on record")) {
        raced = true; const x = row(c);
        DB.order_events.push({ id: DB.order_events.length + 1e6, order_id: c.id, actor: users.adm.id, event: "decision", data: { attempt: String(x.resolved_at || ""), decision: "refund", editor_cents: 0, refund_cents: 10000, note: NOTE }, created_at: new Date().toISOString() });
      }
      return null;
    };
    later(15); await hourly(); hooks.db = null;
    later(60); await hourly();
    const x = row(c);
    vuln(!fired || !raced || x.status !== "refunded" || back(c) !== 10000 || notes(c).some(n => n.startsWith("decision not on record: ")),
      `L6b [${name}] the note written as the decision was saved (${raced}): Order ${x.status}, the client got back ${back(c)}, note ${JSON.stringify(x.money_error)} (must be refunded, 10000, no decision note)`);
  });
}
{
  // the admin page: a note that is only "decision not on record" offers no "Mark as handled" (the database keeps it) and
  // says to decide again; marking a note that has one says the same, never that the hourly run removes it
  const rowLine = page.split("\n").find(l => l.includes("data-clearnote>Mark as handled")) || "";
  const toast = page.split("\n").find(l => l.includes("said={ ok:")) || "";
  const fnLine = page.split("\n").find(l => /const decisionNote=/.test(l)) || "";
  let decisionNote = null; try { decisionNote = new Function(fnLine.trim() + "\nreturn decisionNote;")(); } catch {}
  const t1 = "decision not on record: Cuvori's 'refund' decision could not be saved", t2 = "top-up pi_1 may not be recorded — check by hand · Also: " + t1;
  vuln(!decisionNote || decisionNote(t1) !== "only" || decisionNote(t2) !== "part" || decisionNote("chargeback won; re-payment pending") !== null || !/decisionNote\(r\.money_error\)==="only"/.test(rowLine) || !/Decide this Order again/.test(rowLine) || !/decisionNote\(r\.money_error\)/.test(toast) || !/Decide this Order again/.test(toast),
    `L6c the admin page and the "decision not on record" note: the note read (${decisionNote ? "found" : "not found"}), no "Mark as handled" for it alone and words to decide again (${/Decide this Order again/.test(rowLine)}), the answer after marking (${/Decide this Order again/.test(toast)}) (must be all true)`);
}

// ---------- L7 the cancel's preview sent as anything but true or false ----------
for (const [name, mkX] of PLANS) {
  await guard(`L7 [${name}]`, async () => {
    ready(true);
    const c = mkX(); await fund2(c); c.status = "funded";
    const r = [];
    for (const preview of ["true", 1, "yes", {}]) r.push([JSON.stringify(preview), (await cancel(c, { preview })).status]);
    const x = { ...row(c) }, back0 = back(c);
    const real = await cancel(c, { preview: false });
    vuln(r.some(([, s]) => s !== 400) || x.status !== "funded" || back0 !== 0 || back(c) !== 10000 || real.status !== 200,
      `L7 [${name}] preview sent as ${r.map(([p, s]) => `${p} -> ${s}`).join(", ")}: Order ${x.status}, the client got back ${back0}; then preview false (a real cancel) -> ${real.status}, the client got back ${back(c)} (must be 400 each, still funded, 0, then 200 and 10000)`);
  });
}

// ---------- L8 the smaller points ----------
for (const [name, mkX] of PLANS) {
  await guard(`L8a [${name}]`, async () => {
    const c = mkX(); await fund2(c); c.status = "funded";
    arm("lost", (u, init) => u.includes("/rest/v1/order_payments") && init.method === "POST" && /"note":"topup"/.test(bodyOf(init)));
    const t = await topUp(c, 5000);
    const hit = FAULT.hit; FAULT.hit = 0;
    const tl = lines(c, "fund").filter(l => l.provider_ref === t.session.payment_intent);
    vuln(!hit || t.webhook.status !== 200 || tl.length !== 1 || /ledger line failed/.test(row(c).money_error || ""),
      `L8a [${name}] a top-up's ledger line saved, its answer lost (${t.webhook.status}): lines ${tl.length}, note ${JSON.stringify(row(c).money_error)} (must be 1 line, no note)`);
  });
  await guard(`L8b [${name}]`, async () => {
    const c = mkX(); await fund2(c); c.status = "funded";
    let fired = false;
    hooks.db = async (method, table, search, body) => { if (!fired && method === "POST" && table === "order_events" && /"event":"topped_up"/.test(body || "")) { fired = true; return dbError(); } return null; };
    const t = await topUp(c, 5000); hooks.db = null;
    const w2 = await webhook(completed(t.session));                                         // the same payment sent again
    vuln(!fired || w2.status !== 200 || events(c, "topped_up").length !== 1 || cards(c, "funded").length !== 2,
      `L8b [${name}] a top-up's history line refused (${fired}), the payment sent again (${w2.status}): history "topped_up" ${events(c, "topped_up").length}, chat cards ${cards(c, "funded").length} (must be 1, and 2 with the first payment's)`);
  });
}
await guard("L8c", async () => {
  const c = mk1({ amount_cents: 10000 });
  await checkout(c); const s1 = pay(c.stripe_checkout_id, { fee: 184 });
  // the price changes in the very instant the card is charged: a late payment, sent back less the card fee; its history line is refused once
  hooks.stripe = async (path, method) => { if (method === "POST" && path === `/payment_intents/${s1.payment_intent}/capture`) Object.assign(c, { amount_cents: 12000, price: 120 }); return null; };
  let fired = false;
  hooks.db = async (method, table, search, body) => { if (!fired && method === "POST" && table === "order_events" && /"event":"late_payment_refunded"/.test(body || "")) { fired = true; return dbError(); } return null; };
  const w1 = await webhook(completed(s1)); hooks.stripe = null; hooks.db = null;
  const w2 = await webhook(completed(s1));
  vuln(!fired || w2.status !== 200 || events(c, "late_payment_refunded").length !== 1,
    `L8c a late payment's history line refused (${w1.status}), the payment sent again (${w2.status}): history "late_payment_refunded" ${events(c, "late_payment_refunded").length} (must be 1)`);
});
for (const [name, mkX] of PLANS) {
  await guard(`L8d [${name}]`, async () => {
    ready(true);
    const c = mkX(); const f = await fund2(c); c.status = "delivered"; const ch = chargeOf(f.session.payment_intent);
    await approve(c);
    await dispute(c, ch, "needs_response"); await dispute(c, ch, "lost");
    const s1 = { ...row(c) };
    const w = await dispute(c, ch, "won"); await webhook(cbEvent("charge.dispute.closed", ch, { status: "won" }));   // the bank turns it around; the notice twice
    later(DAY); await hourly();
    const ns = notes(c).filter(n => n.includes("dp_" + ch.id) && /late win/i.test(n));
    vuln(s1.chargeback_status !== "lost" || w.status !== 200 || ns.length !== 1 || ns.some(n => CB_MARK.test(n) || OTHER_CB.test(n)) || events(c, "chargeback_won").length !== 0,
      `L8d [${name}] a lost chargeback (${s1.status}) the bank later decided for Cuvori (${w.status}): notes about it ${JSON.stringify(ns)}, "chargeback won" history lines ${events(c, "chargeback_won").length} (must be one note, not one the hourly run works from, no "won" line: nothing is owed to anyone by itself)`);
  });
  await guard(`L8e [${name}]`, async () => {
    ready(true);
    const c = mkX(); const f = await fund2(c); c.status = "funded"; const ch = chargeOf(f.session.payment_intent);
    const k = await cancel(c);
    await dispute(c, ch, "needs_response"); const w = await dispute(c, ch, "lost");
    later(60); await hourly();
    const ns = notes(c).filter(n => n.includes("dp_" + ch.id));
    vuln(k.status !== 200 || w.status !== 200 || ns.length !== 1 || !/refunded|gone back/i.test(ns[0] || "") || ns.some(n => CB_MARK.test(n) || OTHER_CB.test(n)),
      `L8e [${name}] the Order given back in full (${k.status}), then the client's chargeback on it lost (${w.status}): notes about it ${JSON.stringify(ns)} (must be one, saying the payment had already gone back)`);
  });
  await guard(`L8f [${name}]`, async () => {
    ready(true);
    const c = mkX(); const f = await fund2(c); c.status = "funded"; const ch = chargeOf(f.session.payment_intent);
    const [m1, m2] = ms(c, [6000, 4000]);
    await dispute(c, ch, "needs_response", { amount: 5000 }); await dispute(c, ch, "lost", { amount: 5000 });   // the bank takes 50.00: 50.00 left for 60.00 + 40.00
    const a = await approve(c, m1.id);
    m1.auto_release_at = new Date(Date.now() - 60e3).toISOString();
    later(60); await hourly(); later(60); await hourly();
    const ns = notes(c).filter(n => n.includes(m1.id) || n.includes('"part 1"'));
    vuln(a.status !== 409 || ns.length !== 1 || ns.some(n => CB_MARK.test(n) || OTHER_CB.test(n)) || m1.status === "released",
      `L8f [${name}] a part of 60.00 with 50.00 held: approve -> ${a.status} ${JSON.stringify(a.json && a.json.code)}; after two hourly runs the Order's notes about it ${JSON.stringify(ns)} (must be 409 and one note)`);
  });
}
{
  // the client's page: a part worth more than the Order holds (and no price increase unpaid) shows why instead of Approve
  const btn = page.split("\n").find(l => l.includes('data-msact="release"')) || "";
  vuln(!/m\.amount_cents>oHeld\(o\)/.test(btn) || !/fn_notEnoughHeld/.test(btn),
    `L8f the client's page shows "not enough money is held" in place of Approve for such a part (${/m\.amount_cents>oHeld\(o\)/.test(btn) && /fn_notEnoughHeld/.test(btn)})`);
}
for (const [name, mkX] of PLANS) {
  await guard(`L8g [${name}]`, async () => {
    const c = mkX(); const f = await fund2(c); c.status = "funded";
    const t = await topUp(c, 5000);
    const pis = [f.session.payment_intent, t.session.payment_intent];
    const seen = [...events(c, "funded"), ...events(c, "topped_up")].map(e => JSON.stringify(e.data)).concat(cards(c, "funded").map(m => JSON.stringify(m.payload)));
    vuln(seen.length !== 4 || seen.some(s => pis.some(pi => s.includes(pi)) || /"pi_/.test(s)),
      `L8g [${name}] the payment history lines and chat cards both people read: ${seen.length}, with a Stripe payment id ${seen.filter(s => /pi_/.test(s)).length} (must be 4, none)`);
  });
}

// ---------- L9 the first chargeback's "won" history line, when the hourly run takes the second over first ----------
for (const [name, mkX, plan] of PLANS) {
  for (const fault of ["refused", "lost"]) {
    await guard(`L9 [${name}] ${fault}`, async () => {
      ready(true);
      const c = mkX({ amount_cents: 10000, price: 100 }); const f = await fund2(c); c.status = "funded"; const ch = chargeOf(f.session.payment_intent);
      const u = await topUp(c, 5000); const ch2 = chargeOf(u.session.payment_intent);
      const [m1] = ms(c, [10000, 5000]); await approve(c, m1.id);
      await dispute(c, ch, "needs_response"); await dispute(c, ch2, "needs_response"); await dispute(c, ch2, "lost");
      // the first one won while the freelancer's account can't take the re-payment; the notice's handling breaks off
      ready(false);
      if (fault === "refused") arm("refused", (u, init) => u.includes("/rest/v1/order_events") && init.method === "POST" && /"event":"chargeback_won"/.test(bodyOf(init)));
      else arm("lost", (u, init) => u.includes("/rest/v1/contracts") && init.method === "PATCH" && /"chargeback_status":"won"/.test(bodyOf(init)));
      const w = await dispute(c, ch, "won");
      const hit = FAULT.hit; FAULT.pred = null; FAULT.hit = 0;
      ready(true); later(60); await hourly();                                   // the re-payment, then the second one taken over
      later(60); const w2 = await webhook(cbEvent("charge.dispute.closed", ch, { status: "won" }));   // Stripe sends the notice again
      for (let i = 0; i < 2; i++) { later(DAY); await hourly(); }
      const x = row(c), must = plan === 2 ? 9500 : 10000, p = plan === 2 ? ledger(c) : [];
      const wonLine = events(c, "chargeback_won").filter(e => e.data && e.data.chargeback === "dp_" + ch.id).length;
      vuln(!hit || w.status !== 500 || w2.status !== 200 || wonLine !== 1 || x.chargeback_id !== "dp_" + ch2.id || x.chargeback_status !== "lost" || x.status !== "completed" || sent(c) !== must || p.length,
        `L9 [${name}] the first chargeback's "won" notice broke off (${fault}, ${w.status}); the hourly run took the second over; the notice again (${w2.status}): the first one's "chargeback won" history lines ${wonLine}; the second ${x.chargeback_status}, ${x.status}, the freelancer has ${sent(c)} (must be 1, lost, completed, ${must})${report(p)}`);
    });
  }
}

// ---------- L10 two saves failed at once, then the freelancer gives the Order back ----------
for (const [name, mkX, plan] of PLANS) {
  for (const how of ["cancel", "refund"]) {
    await guard(`L10 [${name}] ${how}`, async () => {
      ready(true);
      const c = mkX(); const f = await fund2(c); c.status = "funded"; const ch = chargeOf(f.session.payment_intent);
      const [m1, m2] = ms(c, [3000, 3000, 4000]);
      await approve(c, m1.id);
      await dispute(c, ch, "needs_response");
      arm("refused", (u, init) => u.includes("/rest/v1/contracts") && init.method === "PATCH" && /"released_cents"/.test(bodyOf(init)));
      const w = await dispute(c, ch, "won");                                    // the re-payment is made; its count is refused
      const hit = FAULT.hit; FAULT.pred = null; FAULT.hit = 0;
      let n = 0;
      hooks.db = async (method, table, search, body) => (method === "POST" && table === "order_payments" && String(body || "").includes(m2.id) && n++ < 3 ? dbError() : null);
      const a = await approve(c, m2.id); hooks.db = null;                         // part 2 paid and counted; its line not saved
      const r = how === "cancel" ? await cancel(c) : await resolve(c, "refund");
      const rec = how === "cancel" ? (events(c, "cancelled")[0] || {}).data || {} : (events(c, "decision").slice(-1)[0] || {}).data || {};
      const said = [rec.refund_cents, r.json && (how === "cancel" ? r.json.refunded : r.json.refundCents)];
      for (let i = 0; i < 2; i++) { await webhook(cbEvent("charge.dispute.closed", ch, { status: "won" })); later(DAY); await hourly(); }
      const fl = plan === 2 ? 5700 : 6000, p = plan === 2 ? ledger(c) : [];
      vuln(!hit || w.status !== 500 || a.status !== 200 || r.status !== 200 || sent(c) !== fl || back(c) !== 4000 || held(c) !== 0 || said.some(x => x !== 4000) || p.length,
        `L10 [${name}] part 2's line not saved and the re-payment's count refused; then ${how} -> ${r.status}: the freelancer has ${sent(c)}, the client got back ${back(c)}, held ${held(c)}; the ${how === "cancel" ? "cancel" : "decision"} worked out and answered ${JSON.stringify(said)} (must be ${fl}, 4000, 0, [4000,4000])${report(p)}`);
    });
  }
}

// L10b the same with a part larger than the re-payment (parts 30.00, 40.00, 30.00), at once and after an hourly run: the
// money itself went wrong (the client got back 20.00 of 30.00, or 11.50 stayed at Cuvori on a closed Order)
for (const [name, mkX, plan] of PLANS) {
  for (const how of ["cancel at once", "refund after an hourly run"]) {
    await guard(`L10b [${name}] ${how}`, async () => {
      ready(true);
      const c = mkX(); const f = await fund2(c); c.status = "funded"; const ch = chargeOf(f.session.payment_intent);
      const [m1, m2] = ms(c, [3000, 4000, 3000]);
      await approve(c, m1.id);
      await dispute(c, ch, "needs_response");
      arm("refused", (u, init) => u.includes("/rest/v1/contracts") && init.method === "PATCH" && /"released_cents"/.test(bodyOf(init)));
      await dispute(c, ch, "won"); const hit = FAULT.hit; FAULT.pred = null; FAULT.hit = 0;
      let n = 0;
      hooks.db = async (method, table, search, body) => (method === "POST" && table === "order_payments" && String(body || "").includes(m2.id) && n++ < 3 ? dbError() : null);
      const a = await approve(c, m2.id); hooks.db = null;
      if (how !== "cancel at once") { later(60); await hourly(); }
      const r = how === "cancel at once" ? await cancel(c) : await resolve(c, "refund");
      for (let i = 0; i < 2; i++) { await webhook(cbEvent("charge.dispute.closed", ch, { status: "won" })); later(DAY); await hourly(); }
      const fl = plan === 2 ? 2850 + 3800 : 7000, p = plan === 2 ? ledger(c) : [];
      vuln(!hit || a.status !== 200 || r.status !== 200 || sent(c) !== fl || back(c) !== 3000 || held(c) !== 0 || p.length,
        `L10b [${name}] parts 30.00/40.00/30.00, part 2's line not saved and the re-payment's count refused; ${how} -> ${r.status}: the freelancer has ${sent(c)}, the client got back ${back(c)}, held ${held(c)}, ${row(c).status} (must be ${fl}, 3000, 0)${report(p)}`);
    });
  }
}

// ---------- L11 a split decided again at another percentage on a 1.00 Order ----------
for (const [name, mkX, plan] of PLANS) {
  for (const [k, pct2] of [["L11", 61], ["L11b", 60]]) {
    await guard(`${k} [${name}]`, async () => {
      ready(true);
      const c = mkX({ amount_cents: 100, price: 1 }); await fund2(c); disputed(c);
      let fired = false;
      hooks.db = async (method, table, search, body) => { if (!fired && method === "POST" && table === "order_events" && /"event":"decision"/.test(body || "")) { fired = true; return dbError(); } return null; };
      const r1 = await resolve(c, "split", { editor_percent: 60 }); hooks.db = null;
      later(15); await hourly();
      const r2 = await resolve(c, "split", { editor_percent: pct2 }); later(60); await hourly();
      const d = (events(c, "decision").slice(-1)[0] || {}).data || {};
      const share = pct2, gets = plan === 2 ? share - Math.round(share * 0.05) : share;
      vuln(!fired || r1.status !== 503 || r2.status !== 200 || !r2.json || r2.json.editorCents !== share || sent(c) !== gets || back(c) !== 100 - share || d.editor_percent !== pct2 || d.editor_cents !== share || d.refund_cents !== 100 - share || (k === "L11") !== !!d.replaced,
        `${k} [${name}] 1.00 held: 'split' 60% not on record (${r1.status}); decided again at ${pct2}% -> ${r2.status} ${JSON.stringify(r2.json)}: the freelancer got ${sent(c)}, the client ${back(c)}; history ${d.editor_percent}% ${d.editor_cents}/${d.refund_cents}${d.replaced ? ", in place of the stuck one" : ""} (must be ${gets}, ${100 - share}, ${pct2}% ${share}/${100 - share}${k === "L11" ? ", in place of the stuck one" : ""})`);
    });
  }
}

// ---------- L12 the decision note when a chargeback sends the Order back to a dispute ----------
for (const [name, mkX, plan] of PLANS) {
  await guard(`L12 [${name}]`, async () => {
    ready(true);
    const c = mkX(); const f = await fund2(c); const ch = chargeOf(f.session.payment_intent); disputed(c);
    let fired = false;
    hooks.db = async (method, table, search, body) => { if (!fired && method === "POST" && table === "order_events" && /"event":"decision"/.test(body || "")) { fired = true; return dbError(); } return null; };
    await resolve(c, "refund"); hooks.db = null;
    later(15); await hourly();
    const noted = notes(c).some(n => n.startsWith("decision not on record: "));
    await dispute(c, ch, "needs_response", { amount: 4000 }); const w = await dispute(c, ch, "lost", { amount: 4000 });
    later(60); await hourly();
    const mid = { ...row(c) };
    const left = notes(c).filter(n => n.startsWith("decision not on record: "));
    const r = await resolve(c, "release"); later(60); await hourly();
    vuln(!fired || !noted || w.status !== 200 || mid.status !== "disputed" || mid.resolution != null || left.length || !/need Cuvori's new decision/.test(mid.dispute_reason || "") || r.status !== 200 || row(c).status !== "completed" || sent(c) !== (plan === 2 ? 5700 : 6000),
      `L12 [${name}] a decision not on record (${noted}), then 40.00 charged back and lost (${w.status}): Order ${mid.status}, the stuck decision ${mid.resolution || "gone"}, the note ${left.length ? "still says it " + JSON.stringify(left[0].slice(0, 80)) : "gone"}; the admin's 'release' -> ${r.status}: ${row(c).status}, the freelancer has ${sent(c)} (must be disputed, gone, gone, 200, completed, ${plan === 2 ? 5700 : 6000})`);
  });
}

console.error = realError;
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
