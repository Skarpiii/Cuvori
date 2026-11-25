// Check of 17 November: the settings read at the top of netlify/lib/cuvori.mjs.
// W  the two webhook secrets. Stripe signs the notices about Cuvori's own account (payments, chargebacks, refunds) with the
//    secret of the "Your account" destination, and the notices about the freelancers' own Stripe accounts with the secret of
//    the "Connected accounts" destination. With the two swapped in Netlify (STRIPE_WEBHOOK_SECRET holding the second one,
//    STRIPE_CONNECT_WEBHOOK_SECRET the first), every notice about Cuvori's own account was answered "received" and dropped:
//    Stripe showed it as delivered and never sent it again, so a chargeback or a refund made in the Stripe dashboard never
//    reached the Order, and the hourly run paid the freelancer money the bank or the client had already taken back. Now such a
//    notice is refused, naming the two settings: Stripe shows it as failed, emails the owner and sends it again, and it is
//    recorded once the two are put right. It is never acted on while only the second secret fits it.
//    W1 a payment, W2 a chargeback, W3 a refund made in the Stripe dashboard, W4 a refund that failed at Stripe (both price
//    plans): refused while swapped, recorded when Stripe sends it again. W5-W11: what already worked keeps working (a
//    freelancer's account notice, the right way round, a notice from a freelancer's own account never taken for Cuvori's
//    own (W8: whichever secret fits it), a forged one refused, a notice Cuvori does not act on and Stripe's test stay
//    "received").
// S  the three settings of money held apart at Stripe (STRIPE_FUNDS_SEGREGATION, STRIPE_FS_WHERE, STRIPE_PREVIEW_VERSION)
//    were the only ones not read like the others: "on " (a space after it), "on" with a line break or "ON" left money held
//    apart off without a word. Now a space or line break around them, and capital letters, make no difference; anything
//    else still means off.
// The functions read the two webhook secrets once, as they start: the second one is set before they are loaded.
process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect";
const H = await import("./fn-harness.mjs");
const { DB, STRIPE, V56, users, req, call, mk, reset, fns, pay, signed, past, fsReset, F } = H;
const lib = await import(F + "../lib/cuvori.mjs");
const OWN = "whsec_fake", SECOND = "whsec_connect";      // Netlify's STRIPE_WEBHOOK_SECRET and STRIPE_CONNECT_WEBHOOK_SECRET
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const logs = []; const realError = console.error; console.error = (...a) => logs.push(a.map(String).join(" "));
const guard = async (name, fn) => { try { await fn(); } catch (e) { out.push(`VULNERABLE ${name} threw: ${e && e.stack ? e.stack.split("\n").slice(0, 2).join(" ") : e}`); } finally { reset(); ready(true); delete process.env.STRIPE_FUNDS_SEGREGATION; delete process.env.STRIPE_FS_WHERE; delete process.env.STRIPE_PREVIEW_VERSION; STRIPE.fs = null; } };
const fx = await fns();
V56.on = true;
STRIPE.balance = 50_000_000;
const webhook = (ev) => call(fx.webhook, req("POST", "x", ev));
const hourly = () => call(fx.autoRelease, req("POST", "x", {}));
const checkout = (c) => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
async function fund2(c) { const r = await checkout(c); if (r.status !== 200) return { checkout: r }; const s = pay(c.stripe_checkout_id); return { checkout: r, session: s, webhook: await webhook(signed({ type: "checkout.session.completed", data: { object: s } }, OWN)) }; }
const ready = (yes) => { STRIPE.accounts.acct_1EditorAAAAAAAA.payouts_enabled = yes; DB.payout_details.find(p => p.id === users.ed.id).stripe_payouts_enabled = yes; };
const mk2 = (o = {}) => mk({ pricing_version: 2, commission_bps: 500, commission_cents: 0, auto_days: 14, ...o });
const mk1 = (o = {}) => mk({ pricing_version: 1, commission_bps: 0, commission_cents: 0, auto_days: 7, ...o });
const PLANS = [["plan 2", mk2], ["plan 1", mk1]];
const row = (c) => DB.contracts.find(x => x.id === c.id) || c;
const chargeOf = (pi) => STRIPE.charges[STRIPE.intents[pi].latest_charge];
const sent = (c) => STRIPE.transfers.filter(t => t.metadata.contract_id === c.id).reduce((a, t) => a + t.amount - t.amount_reversed, 0);
const backAt = (pi) => STRIPE.refunds.filter(r => r.payment_intent === pi && r.status !== "failed" && r.status !== "canceled").reduce((a, r) => a + r.amount, 0);
const show = (c) => { const x = row(c); return `${x.status}, paid in ${x.funded_cents}, paid out ${x.released_cents}, back ${x.refunded_cents}, chargeback ${x.chargeback_status || "none"}; at the freelancer ${sent(c)}`; };
const due = (c) => { const x = row(c); x.status = "delivered"; x.delivered_at = past(24 * 20); x.auto_release_at = past(1); };
// Stripe's deliveries of one notice about Cuvori's own account while the two secrets are swapped in Netlify: the first is
// signed with the secret the second field holds. Stripe sends a notice again only when it was not answered with success;
// by then the owner has put the two right (Stripe's email, or the delivery's answer in Workbench, says which), so it fits
// the first field. Returns each delivery's answer.
async function swappedThenRight(build) {
  const got = [];
  for (let i = 0; i < 3; i++) { const r = await webhook(signed(build(), i === 0 ? SECOND : OWN)); got.push(r); if (r.status >= 200 && r.status < 300) break; }
  return got;
}
const codes = (got) => got.map(r => r.status).join("/");
const refusedFirst = (got) => got.length > 1 && !(got[0].status >= 200 && got[0].status < 300) && got[got.length - 1].status === 200;
const names = (r) => { const t = JSON.stringify(r.json || ""); return t.includes("STRIPE_WEBHOOK_SECRET") && t.includes("STRIPE_CONNECT_WEBHOOK_SECRET"); };
const cbEvent = (ch) => ({ type: "charge.dispute.created", data: { object: { id: "dp_" + ch.id, object: "dispute", charge: ch.id, payment_intent: ch.payment_intent, amount: ch.amount, currency: "eur", status: "needs_response", reason: "fraudulent", created: Math.floor(Date.now() / 1000) } } });
const refundedEvent = (pi) => () => { const ch = chargeOf(pi); return { type: "charge.refunded", data: { object: { id: ch.id, object: "charge", payment_intent: pi, amount: ch.amount, amount_refunded: ch.amount_refunded, refunded: ch.amount_refunded >= ch.amount, currency: "eur" } } }; };
const dashRefund = (pi, amount) => { const ch = chargeOf(pi); ch.amount_refunded += amount; STRIPE.balance -= amount;
  const r = { id: "re_dash" + Math.random().toString(36).slice(2, 10), created: Date.now() / 1000, amount, contract: null, metadata: {}, payment_intent: pi, charge: ch.id, status: "succeeded" }; STRIPE.refunds.push(r); return r; };

// ---------- W1 a payment notice, the two secrets swapped ----------
await guard("W1", async () => {
  const c = mk2({ amount_cents: 10000 }); const r = await checkout(c); const s = pay(c.stripe_checkout_id);
  const n = logs.length;
  const got = await swappedThenRight(() => ({ type: "checkout.session.completed", data: { object: s } }));
  const logged = logs.slice(n).some(l => l.includes("STRIPE_WEBHOOK_SECRET") && l.includes("STRIPE_CONNECT_WEBHOOK_SECRET"));
  vuln(r.status !== 200 || !refusedFirst(got) || !names(got[0]) || !logged || row(c).status !== "funded" || row(c).funded_cents !== 10000,
    `W1 a client pays; the two webhook secrets are swapped in Netlify: Stripe's notice answered ${got[0].status} ${JSON.stringify(got[0].json).slice(0, 150)}; the log names the two settings: ${logged}; Stripe sends it again once they are put right (${codes(got)}): ${show(c)} (must be: refused, naming both settings, never "received"; recorded when sent again)`);
});
// ---------- W2 a chargeback notice, swapped, on an Order the hourly run would pay out ----------
for (const [name, mkX] of PLANS) await guard(`W2 [${name}]`, async () => {
  const c = mkX({ amount_cents: 10000 }); const f = await fund2(c); const pi = f.session.payment_intent, ch = chargeOf(pi);
  due(c);
  STRIPE.disputes[ch.id] = { id: "dp_" + ch.id, status: "needs_response" }; STRIPE.balance -= ch.amount;      // the bank takes the money back
  const got = await swappedThenRight(() => cbEvent(ch));
  await hourly();
  vuln(f.webhook.status !== 200 || !refusedFirst(got) || !names(got[0]) || row(c).chargeback_status !== "open" || sent(c) !== 0,
    `W2 [${name}] the client's bank charges back an Order due to be paid out; the secrets swapped: Stripe's notice ${codes(got)}; then the hourly run: ${show(c)} (must be: refused until put right, then the chargeback recorded and nothing paid to the freelancer)`);
});
// ---------- W3 a refund made in the Stripe dashboard, swapped, on an Order the hourly run would pay out ----------
for (const [name, mkX] of PLANS) await guard(`W3 [${name}]`, async () => {
  const c = mkX({ amount_cents: 10000 }); const f = await fund2(c); const pi = f.session.payment_intent;
  due(c);
  dashRefund(pi, 3000);
  const got = await swappedThenRight(refundedEvent(pi));
  await hourly();
  const cash = chargeOf(pi).amount - backAt(pi) - sent(c);
  vuln(f.webhook.status !== 200 || !refusedFirst(got) || !names(got[0]) || row(c).refunded_cents !== 3000 || cash < 0,
    `W3 [${name}] 30.00 refunded in the Stripe dashboard on an Order due to be paid out; the secrets swapped: Stripe's notice ${codes(got)}; then the hourly run: ${show(c)}; Cuvori's cash from the Order ${cash} (must be: refused until put right, then the refund recorded, and never more paid out than Cuvori holds)`);
});
// ---------- W4 a refund that fails at Stripe after it was recorded, swapped ----------
for (const [name, mkX] of PLANS) await guard(`W4 [${name}]`, async () => {
  const c = mkX({ amount_cents: 10000 }); const f = await fund2(c); const pi = f.session.payment_intent;
  const r = dashRefund(pi, 3000); const w0 = await webhook(signed(refundedEvent(pi)(), OWN)); const before = row(c).refunded_cents;
  r.status = "failed"; const ch = STRIPE.charges[r.charge]; ch.amount_refunded -= r.amount; STRIPE.balance += r.amount;   // the card refused it: the money is back at Cuvori
  const got = await swappedThenRight(() => ({ type: "charge.refund.updated", data: { object: { ...r, object: "refund", status: "failed", currency: "eur", failure_reason: "expired_or_canceled_card" } } }));
  vuln(f.webhook.status !== 200 || w0.status !== 200 || before !== 3000 || !refusedFirst(got) || !names(got[0]) || row(c).refunded_cents !== 0,
    `W4 [${name}] 30.00 refunded in the Stripe dashboard (recorded: ${before}), then the client's card refuses it; the secrets swapped: Stripe's notice ${codes(got)}: ${show(c)} (must be: refused until put right, then the Order counts the 30.00 as not given back)`);
});
// ---------- W5 a freelancer's account notice, swapped: it still works ----------
await guard("W5", async () => {
  STRIPE.accounts.acct_1EditorAAAAAAAA.payouts_enabled = false;              // Stripe paused the freelancer's payouts
  const ev = { type: "account.updated", account: "acct_1EditorAAAAAAAA", data: { object: { id: "acct_1EditorAAAAAAAA", object: "account" } } };
  const w = await webhook(signed(ev, OWN));                                  // swapped: the Connected accounts destination's secret is in the first field
  const flag = DB.payout_details.find(p => p.id === users.ed.id).stripe_payouts_enabled;
  vuln(w.status !== 200 || flag !== false, `W5 Stripe pauses a freelancer's payouts; the secrets swapped: its notice ${w.status}; the freelancer's payout details say ready: ${flag} (must be: received, and no longer ready)`);
});
// ---------- W6 the right way round: a payment is recorded ----------
await guard("W6", async () => {
  const c = mk2({ amount_cents: 10000 }); const f = await fund2(c);
  vuln(f.webhook.status !== 200 || row(c).status !== "funded", `W6 a client pays, the secrets the right way round: Stripe's notice ${f.webhook.status}: ${show(c)} (must be: received and funded)`);
});
// ---------- W7/W8 a payment notice from a freelancer's own Stripe account is never taken for Cuvori's own ----------
for (const [label, secret] of [["W7 the right way round", SECOND], ["W8 the secrets swapped", OWN]]) await guard(label, async () => {
  const c = mk2({ amount_cents: 10000 }); await checkout(c); const s = pay(c.stripe_checkout_id);
  const w = await webhook(signed({ type: "checkout.session.completed", account: "acct_1EditorAAAAAAAA", data: { object: s } }, secret));
  vuln(w.status !== 200 || row(c).status !== "accepted" || row(c).funded_cents !== 0,
    `${label}: a payment notice marked as a freelancer's own Stripe account's (Stripe's "account" on the notice) -> ${w.status}: ${show(c)} (must be: received, and never recorded as a payment of a Cuvori Order)`);
});
// ---------- W9 a notice neither secret fits ----------
await guard("W9", async () => {
  const c = mk2({ amount_cents: 10000 }); await checkout(c); const s = pay(c.stripe_checkout_id);
  const w = await webhook(signed({ type: "checkout.session.completed", data: { object: s } }, "whsec_someone_else"));
  vuln(w.status !== 400 || row(c).status !== "accepted", `W9 a payment notice signed with neither secret -> ${w.status}: ${show(c)} (must be: refused, nothing recorded)`);
});
// ---------- W10 a notice Cuvori does not act on, and Stripe's own test, with the second secret: still "received" ----------
await guard("W10", async () => {
  const a = await webhook(signed({ type: "payment_intent.created", data: { object: { id: "pi_x1234", object: "payment_intent" } } }, SECOND));
  const b = await webhook(signed({ type: "v2.core.event_destination.ping", data: { object: { id: "ed_x1234" } } }, SECOND));
  vuln(a.status !== 200 || b.status !== 200, `W10 a notice Cuvori does not act on (${a.status}) and Stripe's "is this destination ready?" test (${b.status}), with the second secret (must both be received: Stripe would otherwise keep sending them)`);
});
// ---------- W11 a freelancer's account notice without Stripe's account mark, with the second secret: still works ----------
await guard("W11", async () => {
  STRIPE.accounts.acct_1EditorAAAAAAAA.payouts_enabled = false;
  const w = await webhook(signed({ type: "account.updated", data: { object: { id: "acct_1EditorAAAAAAAA", object: "account" } } }, SECOND));
  const flag = DB.payout_details.find(p => p.id === users.ed.id).stripe_payouts_enabled;
  vuln(w.status !== 200 || flag !== false, `W11 a freelancer's account notice with the second secret, without the account mark -> ${w.status}; ready: ${flag} (must be: received, and no longer ready: the account is read from Stripe either way)`);
});

// ---------- S1/S2 STRIPE_FUNDS_SEGREGATION ----------
await guard("S1", async () => {
  const on = ["on", "on ", " on", "on\n", "\ton\r\n", "ON", "On"], off = ["off", "true", "1", "yes", "o n", "onn", "on;", "", "  "];
  const read = (v) => { process.env.STRIPE_FUNDS_SEGREGATION = v; return lib.segregationOn(); };
  const wrongOn = on.filter(v => !read(v)), wrongOff = off.filter(v => read(v));
  delete process.env.STRIPE_FUNDS_SEGREGATION; const unset = lib.segregationOn();
  vuln(wrongOn.length || wrongOff.length || unset, `S1 STRIPE_FUNDS_SEGREGATION: read as off although written as on: ${JSON.stringify(wrongOn)}; read as on although not on: ${JSON.stringify(wrongOff)}; not set: ${unset ? "on" : "off"} (must be: on for "on" with spaces, line breaks or capitals around it; off for everything else)`);
});
await guard("S2", async () => {
  fsReset(); process.env.STRIPE_FUNDS_SEGREGATION = "on ";                   // pasted with a space after it
  const c = mk2({ amount_cents: 10000 }); const r = await checkout(c);
  const asked = ((STRIPE.sessions[c.stripe_checkout_id] || {}).params || {})["payment_intent_data[allocated_funds][enabled]"];
  vuln(r.status !== 200 || asked !== "true", `S2 STRIPE_FUNDS_SEGREGATION = "on " (a space after it), an Order at the new prices: the payment page ${r.status}, asks Stripe to hold the payment apart: ${asked === "true"} (must be: yes)`);
});
// ---------- S3 STRIPE_FS_WHERE ----------
await guard("S3", async () => {
  const cap = ["capture", "capture ", "Capture", " CAPTURE\n"], chk = ["checkout", "", "captured", "cap ture", "capture;"];
  const read = (v) => { process.env.STRIPE_FS_WHERE = v; return lib.fsWhere(); };
  const a = cap.filter(v => read(v) !== "capture"), b = chk.filter(v => read(v) !== "checkout");
  vuln(a.length || b.length, `S3 STRIPE_FS_WHERE: not read as capture: ${JSON.stringify(a)}; read as capture although not: ${JSON.stringify(b)} (must be: none)`);
});
// ---------- S4 STRIPE_PREVIEW_VERSION ----------
await guard("S4", async () => {
  const read = (v) => { process.env.STRIPE_PREVIEW_VERSION = v; return lib.fsVersion(); };
  const want = "2026-12-01.preview; allocated_funds_preview=v1", dflt = `${lib.FS_PREVIEW_VERSION}; allocated_funds_preview=v1`;
  const got = { plain: read("2026-12-01.preview"), spaced: read(" 2026-12-01.preview \n"), bad: read("2026-12-01"), extra: read("2026-12-01.preview; x=1") };
  vuln(got.plain !== want || got.spaced !== want || got.bad !== dflt || got.extra !== dflt,
    `S4 STRIPE_PREVIEW_VERSION: "2026-12-01.preview" -> ${got.plain}; with spaces and a line break -> ${got.spaced}; not a preview version -> ${got.bad}; with more after it -> ${got.extra} (must be: the version written, spaces or not; Cuvori's own one otherwise)`);
});

console.error = realError;
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
