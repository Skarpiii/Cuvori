// Fixes of 2 November (payments coming in): regression checks for the problems the review of 2 November proved about money
// coming into an Order. Both price plans where both are affected.
// I1 two payment pages open for one unpaid Order (closing the first failed). The client pays page 1: its card is charged,
//    and the database's answer to recording it is lost. The client pays page 2 too: it was charged and recorded, and page 1
//    then went back as a late payment less Stripe's card fee (the client lost it at today's prices, Cuvori at the new ones).
//    Now page 2's hold is released (nothing charged) and page 1 is recorded when Stripe sends it again.
//    I1b, I1c (guards of the fix): a first payment charged and sent back as a late payment earlier (I1b), or still waiting to
//    go back (I1c), never stops the Order's real first payment.
// I2 today's prices: a top-up counted on the Order whose ledger line could not be saved. I2a a chargeback on it was taken
//    for a payment with no Order (nothing frozen, the payout went on); I2b no hourly run ever added the line (its card-fee
//    surplus never went back, the note stayed). I2c (guard): a late top-up Cuvori sent back is never taken for the Order's,
//    even when its claim was left behind and the Order counts that much more than its lines show.
// I3 a top-up whose first write got no answer (not applied) was recorded on the next delivery, but its note "may not be
//    recorded — check by hand" stayed.
// I4 the write that records a payment landed but its answer was lost: the next delivery found it recorded and wrote no
//    history line and no chat card (I4a the first payment, I4b a top-up); never written twice either.
// I5 a second price increase of the same size within the half hour: Stripe handed back the first increase's page, paid and
//    recorded, and the client was told the Order is not waiting for a payment.
// I6 today's prices: Stripe's fee on a payment still not known after its 96 hours (no row in the Fees report, I6a; another
//    currency, I6b): nothing on the Order said the card-fee surplus had not gone back. Now one note, once.
// Run: node tests/attack-fixes-nov2-in.mjs  (TARGET=<folder> runs it against another copy of the payment code)
import { DB, STRIPE, V56, hooks, req, call, mk, reset, fns, pay, signed } from "./fn-harness.mjs";
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const logs = []; const realError = console.error; console.error = (...a) => logs.push(a.map(String).join(" "));
const guard = async (name, fn) => { try { await fn(); } catch (e) { out.push(`VULNERABLE ${name} threw: ${e && e.stack ? e.stack.split("\n").slice(0, 2).join(" ") : e}`); } finally { reset(); } };
const fx = await fns();
V56.on = true;                                                        // the fake database keeps v56's rules
STRIPE.balance = 50_000_000_000;                                      // other clients' money in the platform balance
// time moves on when the test says so, and a wait inside the code passes at once
const RealDate = Date; let skew = 0;
globalThis.Date = class extends RealDate { constructor(...a) { if (a.length === 0) super(RealDate.now() + skew); else super(...a); } static now() { return RealDate.now() + skew; } };
const later = (min) => { skew += min * 60e3; };
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(() => { if (Number(ms) > 0) skew += Number(ms); fn(...args); }, 0);
const DAY = 1440;
const nowS = () => Math.floor(Date.now() / 1000);
const res = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const lost = () => res(503, { message: "upstream connect error" });
const webhook = (ev) => call(fx.webhook, req("POST", "x", ev));
const completed = (s) => signed({ type: "checkout.session.completed", data: { object: s } });
const hourly = () => call(fx.autoRelease, req("POST", "x", {}));
const checkout = (c, lang) => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, ...(lang ? { lang } : {}) } }));
const approve = (c) => call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
const cbEvent = (ch, status = "needs_response") => signed({ type: "charge.dispute.created", data: { object: { id: "dp_" + ch.id, object: "dispute", charge: ch.id, payment_intent: ch.payment_intent, amount: ch.amount, currency: "eur", status, reason: "fraudulent", created: nowS() } } });
const dispute = (ch) => { STRIPE.disputes[ch.id] = { id: "dp_" + ch.id, status: "needs_response" }; return webhook(cbEvent(ch)); };
const mk2 = (o = {}) => mk({ pricing_version: 2, commission_bps: 500, commission_cents: 0, auto_days: 14, ...o });
const mk1 = (o = {}) => mk({ pricing_version: 1, commission_bps: 0, commission_cents: 0, auto_days: 7, ...o });
const PLANS = [["plan 1", mk1, 1], ["plan 2", mk2, 2]];
const row = (c) => DB.contracts.find(x => x.id === c.id) || c;
const chargeOf = (pi) => STRIPE.charges[STRIPE.intents[pi].latest_charge];
const fundLine = (c, pi) => DB.order_payments.filter(p => p.order_id === c.id && p.kind === "fund" && p.provider_ref === pi);
const history = (c, ev) => DB.order_events.filter(e => e.order_id === c.id && e.event === ev).length;
const cards = (c, ev) => DB.messages.filter(m => m.payload && m.payload.contract_id === c.id && m.payload.event === ev).length;
const refundsOf = (pi, kind) => STRIPE.refunds.filter(r => r.payment_intent === pi && (!kind || r.metadata.kind === kind));
const note = (c) => JSON.stringify(row(c).money_error ?? null);
async function fund(c) { const r = await checkout(c); if (r.status !== 200) return { checkout: r }; const s = pay(c.stripe_checkout_id); return { checkout: r, session: s, webhook: await webhook(completed(s)) }; }
// a price increase both sides accepted, and the page for it (paid by the caller)
async function increase(c, cents) { Object.assign(c, { amount_cents: c.amount_cents + cents, price: (c.amount_cents + cents) / 100 }); const r = await checkout(c); return { r, sid: c.stripe_checkout_id }; }
// the next write that records this payment on the Order gets no answer: applied or not
const loseFundWrite = (applied) => { let once = false; hooks.db = async (method, table, search, body) => {
  if (!once && method === "PATCH" && table === "contracts" && /"status":"funded"|"funded_cents"/.test(String(body || ""))) { once = true; if (applied) { const c = DB.contracts.find(x => search.includes(x.id)); if (c) Object.assign(c, JSON.parse(body)); } return lost(); }
  return null; }; };

// ---------- I1 two pages for one unpaid Order: the first charged and its recording lost, then the second paid ----------
for (const [name, mkX] of PLANS) {
  await guard(`I1a [${name}]`, async () => {
    const c = mkX({ amount_cents: 10000 });
    const a = await checkout(c, "en"); const s1id = c.stripe_checkout_id;
    hooks.stripe = async (path, method) => (method === "POST" && path === `/checkout/sessions/${s1id}/expire`) ? [500, { error: { type: "api_error", message: "An unknown error occurred" } }] : null;
    const b = await checkout(c, "de"); const s2id = c.stripe_checkout_id; hooks.stripe = null;   // closing page 1 failed: two pages open
    const s1 = pay(s1id, { fee: 184 });
    loseFundWrite(false);
    const w1 = await webhook(completed(s1)); hooks.db = null;          // page 1 charged, its recording got no answer
    const s2 = pay(s2id, { fee: 184 });
    const w2 = await webhook(completed(s2));
    const w1b = await webhook(completed(s1));                          // Stripe sends page 1 again
    const st = [s1, s2].map(s => STRIPE.intents[s.payment_intent].status);
    const charged = st.filter(x => x === "succeeded").length, x = row(c);
    const late = [s1, s2].reduce((n, s) => n + refundsOf(s.payment_intent, "late_payment").length, 0);
    vuln(a.status !== 200 || b.status !== 200 || s1id === s2id || w2.status !== 200 || charged !== 1 || st[1] !== "canceled" || late || x.status !== "funded" || x.funded_cents !== 10000 || x.stripe_payment_intent !== s1.payment_intent,
      `I1a [${name}] two pages open, page 1 charged and its recording lost (${w1.status}), page 2 paid (${w2.status}), page 1 sent again (${w1b.status}): pages ${st.join("/")}, ${charged} charged, late-payment refunds ${late}; Order ${x.status} with ${x.funded_cents} by ${x.stripe_payment_intent === s1.payment_intent ? "page 1" : x.stripe_payment_intent === s2.payment_intent ? "page 2" : x.stripe_payment_intent} (must be: page 2's hold released, one charge, no late payment, funded 10000 by page 1)`);
  });
}
// a first payment charged and found not to fit the Order (the price changed at that very moment): a late payment
async function lateFirst(c, opts) {
  await checkout(c); const s = pay(c.stripe_checkout_id, opts);
  hooks.stripe = async (path, method) => { if (method === "POST" && /\/capture$/.test(path)) Object.assign(c, { amount_cents: 12000, price: 120 }); return null; };
  const w = await webhook(completed(s)); hooks.stripe = null;
  return { s, w };
}
await guard("I1b", async () => {
  const c = mk1({ amount_cents: 10000 });
  const L = await lateFirst(c, { fee: 184 });
  const backL = refundsOf(L.s.payment_intent, "late_payment").reduce((a, r) => a + r.amount, 0);
  const f = await fund(c);
  const x = row(c);
  vuln(backL !== L.s.amount_total - 184 || !f.session || f.webhook.status !== 200 || STRIPE.intents[f.session.payment_intent].status !== "succeeded" || x.status !== "funded" || x.funded_cents !== 12000,
    `I1b a first payment charged and sent back as a late payment (${backL} back), then the Order's real first payment: ${f.webhook && f.webhook.status}, ${f.session ? STRIPE.intents[f.session.payment_intent].status : "no page"}; Order ${x.status} with ${x.funded_cents} (must be charged and recorded: funded 12000)`);
});
await guard("I1c", async () => {
  // page 1 at 100.00; the price is changed to 120.00 and a second tab makes page 2 (closing page 1 fails); the price goes back
  // to 100.00 and page 1 is paid, but at the very moment its card is charged the price is 120.00 again: page 1 is a late
  // payment, and Stripe's fee on it is not known yet (standalone fees), so its refund waits. Then page 2 is paid.
  const c = mk1({ amount_cents: 10000 });
  await checkout(c, "en"); const s1id = c.stripe_checkout_id;
  Object.assign(c, { amount_cents: 12000, price: 120 });
  hooks.stripe = async (path, method) => (method === "POST" && path === `/checkout/sessions/${s1id}/expire`) ? [500, { error: { type: "api_error", message: "An unknown error occurred" } }] : null;
  await checkout(c, "de"); const s2id = c.stripe_checkout_id; hooks.stripe = null;
  Object.assign(c, { amount_cents: 10000, price: 100 });
  const s1 = pay(s1id, { standalone: true, fee: 175 });
  hooks.stripe = async (path, method) => { if (method === "POST" && path === `/payment_intents/${s1.payment_intent}/capture`) Object.assign(c, { amount_cents: 12000, price: 120 }); return null; };
  const w1 = await webhook(completed(s1)); hooks.stripe = null;
  const waiting = !!DB.money_keys.find(k => k.scope === "late_refund:" + s1.payment_intent) && STRIPE.intents[s1.payment_intent].status === "succeeded";
  const s2 = pay(s2id, { standalone: true, fee: 175 });
  const w2 = await webhook(completed(s2));
  const x = row(c);
  vuln(s1id === s2id || !waiting || w2.status !== 200 || STRIPE.intents[s2.payment_intent].status !== "succeeded" || x.status !== "funded" || x.funded_cents !== 12000 || x.stripe_payment_intent !== s2.payment_intent,
    `I1c a first payment charged as a late payment (${w1.status}) and still waiting to go back (${waiting ? "waiting" : "NOT waiting"}), then the Order's real first payment on another page: ${w2.status}, ${STRIPE.intents[s2.payment_intent].status}; Order ${x.status} with ${x.funded_cents} (must be charged and recorded: funded 12000)`);
});

// ---------- I2 today's prices: a counted top-up whose ledger line could not be saved ----------
async function topupLineFails(c, cents = 5000, fee = 120) {
  const { r, sid } = await increase(c, cents);
  const s = pay(sid, { fee });
  let once = false;
  hooks.db = async (method, table, search, body) => (!once && method === "POST" && table === "order_payments" && String(body).includes(s.payment_intent) && (once = true)) ? lost() : null;
  const w = await webhook(completed(s)); hooks.db = null;
  return { r, s, w };
}
await guard("I2a", async () => {
  const c = mk1({ amount_cents: 10000 }); await fund(c);
  const T = await topupLineFails(c);
  const before = fundLine(c, T.s.payment_intent).length, noted = note(c);
  const ch = chargeOf(T.s.payment_intent);
  const d = await dispute(ch);                                          // the bank pulls the top-up back
  const x = row(c), rel = await approve(c);
  const noOrder = logs.some(l => /no Order on record/.test(l) && l.includes(T.s.payment_intent));
  vuln(T.w.status !== 200 || before !== 0 || d.status !== 200 || x.chargeback_status !== "open" || x.chargeback_id !== "dp_" + ch.id || noOrder || rel.status !== 409 || STRIPE.transfers.some(t => t.metadata.contract_id === c.id) || fundLine(c, T.s.payment_intent).length !== 1,
    `I2a a top-up counted (${T.w.status}) whose line failed (lines ${before}, note ${noted}); a chargeback on it -> ${d.status}: Order chargeback ${x.chargeback_status || "none"}${noOrder ? " (taken for a payment with no Order)" : ""}; the client's release -> ${rel.status}, payouts ${STRIPE.transfers.filter(t => t.metadata.contract_id === c.id).length}, top-up line ${fundLine(c, T.s.payment_intent).length} (must be: chargeback open on the Order, release refused, no payout, the line added)`);
});
await guard("I2b", async () => {
  const c = mk1({ amount_cents: 10000 }); await fund(c);
  const T = await topupLineFails(c);
  const noted = note(c);
  later(3 * 60); const h1 = await hourly(); later(60); await hourly();
  const lines = fundLine(c, T.s.payment_intent), feeBack = refundsOf(T.s.payment_intent, "fee_surplus").reduce((a, r) => a + r.amount, 0);
  const owed = Number(T.s.metadata.fee_cents) - 120;
  vuln(!/counted but its ledger line failed/.test(noted) || h1.status !== 200 || lines.length !== 1 || lines[0].amount_cents !== 5000 || lines[0].fee_cents !== Number(T.s.metadata.fee_cents) || lines[0].connect_cents !== Number(T.s.metadata.connect_cents || 0) || row(c).money_error != null || feeBack !== owed || row(c).funded_cents !== 15000,
    `I2b the same, then two hourly runs: top-up lines ${lines.length}${lines[0] ? ` (${lines[0].amount_cents}, card fee ${lines[0].fee_cents}, payout fee ${lines[0].connect_cents})` : ""}, card-fee surplus back ${feeBack} of ${owed}, note before ${noted}, now ${note(c)}, funded ${row(c).funded_cents} (must be: one line of 5000 with the page's fees, the surplus back, the note gone, 15000)`);
});
await guard("I2c", async () => {
  const c = mk1({ amount_cents: 10000 }); await fund(c);
  const a = await increase(c, 5000); const s1 = pay(a.sid, { fee: 120 }); await webhook(completed(s1));   // the first increase, counted
  const { sid } = await increase(c, 5000);
  const s2 = pay(sid, { fee: 120 });
  hooks.stripe = async (path, method) => { if (method === "POST" && path === `/payment_intents/${s2.payment_intent}/capture`) c.status = "cancelled"; return null; };
  const w2 = await webhook(completed(s2)); hooks.stripe = null;          // cancelled at that very moment: a late payment, sent back
  const back2 = refundsOf(s2.payment_intent, "late_payment").reduce((a, r) => a + r.amount, 0);
  // its claim was left behind (the removal got no answer), and the first increase's line is missing (its save failed):
  // the Order counts 5000 more than its lines show, the very amount of the late one
  if (!DB.money_keys.some(k => k.scope === "apply:" + s2.payment_intent)) DB.money_keys.push({ id: "k", scope: "apply:" + s2.payment_intent, key: "claim:left", created_at: new Date(Date.now() - 3 * 3600e3).toISOString() });
  DB.order_payments = DB.order_payments.filter(p => !(p.kind === "fund" && p.provider_ref === s1.payment_intent));
  const T1 = { s: s1 };
  const d = await dispute(chargeOf(s2.payment_intent));
  const x = row(c);
  later(3 * 60); await hourly();
  const l1 = fundLine(c, T1.s.payment_intent).length, l2 = fundLine(c, s2.payment_intent).length;
  vuln(w2.status !== 200 || back2 !== s2.amount_total - 120 || d.status !== 200 || x.chargeback_status === "open" || l2 !== 0 || l1 !== 1 || row(c).funded_cents !== 15000,
    `I2c a late top-up sent back (${back2}), its claim left behind, the Order 5000 ahead of its lines (another top-up's line missing); a chargeback on the late one -> ${d.status}: Order chargeback ${x.chargeback_status || "none"}; after the hourly run: line of the late one ${l2}, of the counted one ${l1}, funded ${row(c).funded_cents} (must be: no chargeback on the Order, no line for the late one, the counted one's line added, 15000)`);
});

// ---------- I3 a top-up's write got no answer (not applied); the next delivery records it ----------
await guard("I3", async () => {
  const c = mk1({ amount_cents: 10000 }); await fund(c);
  const { sid } = await increase(c, 5000);
  const s = pay(sid);
  loseFundWrite(false);
  const w1 = await webhook(completed(s)); hooks.db = null;
  const noted = note(c);
  later(2);                                                            // Stripe sends it again after the 90 s stale limit
  const w2 = await webhook(completed(s));
  const x = row(c);
  vuln(w1.status !== 500 || !/may not be recorded/.test(noted) || w2.status !== 200 || x.funded_cents !== 15000 || fundLine(c, s.payment_intent).length !== 1 || history(c, "topped_up") !== 1 || x.money_error != null,
    `I3 a top-up's write got no answer (${w1.status}, note ${noted}); sent again (${w2.status}): funded ${x.funded_cents}, lines ${fundLine(c, s.payment_intent).length}, history ${history(c, "topped_up")}, note now ${note(c)} (must be 15000, 1, 1, no note)`);
});

// ---------- I4 the write recording a payment landed, its answer lost ----------
for (const [name, mkX] of PLANS) {
  await guard(`I4a [${name}]`, async () => {
    const c = mkX({ amount_cents: 10000 });
    await checkout(c); const s = pay(c.stripe_checkout_id);
    loseFundWrite(true);
    const w1 = await webhook(completed(s)); hooks.db = null;
    const w2 = await webhook(completed(s)); const w3 = await webhook(completed(s));   // sent again, and once more
    const x = row(c);
    vuln(w1.status !== 500 || w2.status !== 200 || w3.status !== 200 || x.status !== "funded" || history(c, "funded") !== 1 || cards(c, "funded") !== 1,
      `I4a [${name}] the first payment's write landed, its answer lost (${w1.status}); sent again twice (${w2.status}, ${w3.status}): ${x.status}; history "funded" ${history(c, "funded")}, chat card ${cards(c, "funded")} (must be 1 and 1)`);
  });
  await guard(`I4b [${name}]`, async () => {
    const c = mkX({ amount_cents: 10000 }); await fund(c);
    const { sid } = await increase(c, 5000);
    const s = pay(sid);
    loseFundWrite(true);
    const w1 = await webhook(completed(s)); hooks.db = null;
    later(2);
    const w2 = await webhook(completed(s)); const w3 = await webhook(completed(s));
    const x = row(c);
    vuln(w1.status !== 500 || w2.status !== 200 || w3.status !== 200 || x.funded_cents !== 15000 || history(c, "topped_up") !== 1 || cards(c, "funded") !== 2 || x.money_error != null,
      `I4b [${name}] a top-up's write landed, its answer lost (${w1.status}); sent again twice (${w2.status}, ${w3.status}): funded ${x.funded_cents}; history "topped_up" ${history(c, "topped_up")}, chat cards ${cards(c, "funded")} (must be 1, and 2 with the first payment's), note ${note(c)}`);
  });
}

// ---------- I5 two price increases of the same size within one half hour ----------
for (const [name, mkX] of PLANS) {
  await guard(`I5 [${name}]`, async () => {
    skew += 1800e3 - (Date.now() % 1800e3) + 1000;                       // the start of a half hour: both clicks fall in it
    const c = mkX({ amount_cents: 10000 }); await fund(c);
    const a = await increase(c, 5000); const s1 = pay(a.sid); const w1 = await webhook(completed(s1));
    const b = await increase(c, 5000);
    const again = await checkout(c);
    let w2 = null, s2 = null;
    if (b.r.status === 200 && b.sid !== a.sid) { s2 = pay(b.sid); w2 = await webhook(completed(s2)); }
    const x = row(c);
    vuln(a.r.status !== 200 || w1.status !== 200 || b.r.status !== 200 || b.sid === a.sid || b.r.json.amount !== 5000 || again.status !== 200 || again.json.url !== b.r.json.url || !w2 || w2.status !== 200 || x.funded_cents !== 20000,
      `I5 [${name}] first increase paid (${w1.status}); the second of the same size -> ${b.r.status} ${b.r.status === 200 ? (b.sid === a.sid ? "the first page again" : "a new page") : JSON.stringify(b.r.json && b.r.json.code)}, clicked again -> ${again.status} ${again.json && again.json.url === b.r.json?.url ? "the same page" : "another page"}; paid: ${w2 ? w2.status : "-"}, funded ${x.funded_cents} (must be a new page, the same one again, 20000)`);
  });
}

// ---------- I6 today's prices: Stripe's fee on a payment never known ----------
await guard("I6a", async () => {
  const c = mk1({ amount_cents: 10000 }); const f = await fund2Standalone(c);
  const pi = f.session.payment_intent, ch = chargeOf(pi);
  STRIPE.feeRows = STRIPE.feeRows.filter(r => r.incurred_by !== ch.id);  // Stripe's Fees report never lists its fee
  later(5 * DAY); STRIPE.reports.end = nowS() - 3600; STRIPE.reports.instant = true;
  for (let i = 0; i < 3; i++) { later(60); await hourly(); }
  const count = () => String(row(c).money_error || "").split(" · Also: ").filter(n => n.startsWith(`card fee of payment ${pi} `)).length;
  const n1 = count();
  row(c).money_error = null;                                            // the admin marks it as handled
  for (let i = 0; i < 3; i++) { later(60); await hourly(); }
  const n2 = count();
  vuln(n1 !== 1 || n2 !== 0 || refundsOf(pi, "fee_surplus").length !== 0,
    `I6a a payment whose fee Stripe's Fees report never lists, 5 days on: notes about it after 3 hourly runs ${n1}, after it was marked as handled and 3 more runs ${n2}, card-fee refunds ${refundsOf(pi, "fee_surplus").length} (must be 1, 0, 0)`);
});
await guard("I6b", async () => {
  const c = mk1({ amount_cents: 10000 }); await checkout(c); const s = pay(c.stripe_checkout_id, { fee: 184, feeLater: true });
  const ch = chargeOf(s.payment_intent);
  const w = await webhook(completed(s));                                // Stripe's balance entry not there yet when it is recorded
  ch.balance_transaction = { ...ch._bt, currency: "usd" };              // then: Stripe settled it in another currency
  later(5 * DAY);
  for (let i = 0; i < 2; i++) { later(60); await hourly(); }
  const n1 = note(c);
  ch.balance_transaction.currency = "eur";                              // now it can be read
  later(60); await hourly();
  const owed = Number(s.metadata.fee_cents) - 184, back = refundsOf(s.payment_intent, "fee_surplus").reduce((a, r) => a + r.amount, 0);
  vuln(w.status !== 200 || !/^"card fee of payment /.test(n1) || back !== owed || row(c).money_error != null,
    `I6b a payment Stripe settled in another currency, 5 days on: note ${n1}; once the fee can be read: surplus back ${back} of ${owed}, note ${note(c)} (must be a note, then the surplus back and the note gone)`);
});
async function fund2Standalone(c) { await checkout(c); const s = pay(c.stripe_checkout_id, { standalone: true, fee: 175 }); return { session: s, webhook: await webhook(completed(s)) }; }

console.error = realError;
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
