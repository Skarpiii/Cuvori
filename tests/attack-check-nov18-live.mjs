// Check of 18 November, the live site's code (main) and the update waiting on pricing-v2: the two webhook secrets.
// Stripe signs the notices about Cuvori's own account (payments, chargebacks, refunds) with the secret of the "Your
// account" destination, and the notices about the freelancers' own Stripe accounts with the secret of the "Connected
// accounts" destination. With the two swapped in Netlify (STRIPE_WEBHOOK_SECRET holding the second one,
// STRIPE_CONNECT_WEBHOOK_SECRET the first), every notice about Cuvori's own account was answered "received" and dropped:
// Stripe showed it as delivered and never sent it again, so a chargeback or a refund made in the Stripe dashboard never
// reached its Order, and the hourly run paid the freelancer money the bank or the client had already taken back. Now such a
// notice is refused, naming the two settings, and recorded when Stripe sends it again once they are put right; it is never
// acted on while only the second secret fits it. (pricing-v2 has had this since the check of 17 November, which also covers
// the new prices and refunds that fail at Stripe: tests/attack-check-nov17.mjs. This one uses only what main has too.)
// L1 a payment, L2 a chargeback, L3 a refund made in the Stripe dashboard: refused while swapped, recorded when sent again,
// and the hourly run never pays the freelancer money already taken back. L4-L9: what already worked keeps working.
// The functions read the two webhook secrets once, as they start: the second one is set before they are loaded.
process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect";
const H = await import("./fn-harness.mjs");
const { DB, STRIPE, users, req, call, mk, reset, fns, pay, signed, past } = H;
const OWN = "whsec_fake", SECOND = "whsec_connect";      // Netlify's STRIPE_WEBHOOK_SECRET and STRIPE_CONNECT_WEBHOOK_SECRET
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const logs = []; const realError = console.error; console.error = (...a) => logs.push(a.map(String).join(" "));
const ready = () => { STRIPE.accounts.acct_1EditorAAAAAAAA.payouts_enabled = true; DB.payout_details.find(p => p.id === users.ed.id).stripe_payouts_enabled = true; };
const guard = async (name, fn) => { try { await fn(); } catch (e) { out.push(`VULNERABLE ${name} threw: ${e && e.stack ? e.stack.split("\n").slice(0, 2).join(" ") : e}`); } finally { reset(); ready(); } };
const fx = await fns();
STRIPE.balance = 50_000_000;
const webhook = (ev) => call(fx.webhook, req("POST", "x", ev));
const hourly = () => call(fx.autoRelease, req("POST", "x", {}));
const checkout = (c) => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
async function fund(c) { const r = await checkout(c); if (r.status !== 200) return { checkout: r }; const s = pay(c.stripe_checkout_id); return { checkout: r, session: s, webhook: await webhook(signed({ type: "checkout.session.completed", data: { object: s } }, OWN)) }; }
const row = (c) => DB.contracts.find(x => x.id === c.id) || c;
const chargeOf = (pi) => STRIPE.charges[STRIPE.intents[pi].latest_charge];
const sent = (c) => STRIPE.transfers.filter(t => t.metadata && t.metadata.contract_id === c.id).reduce((a, t) => a + t.amount - (t.amount_reversed || 0), 0);
const backAt = (pi) => STRIPE.refunds.filter(r => r.payment_intent === pi && r.status !== "failed" && r.status !== "canceled").reduce((a, r) => a + r.amount, 0);
const show = (c) => { const x = row(c); return `${x.status}, paid in ${x.funded_cents}, paid out ${x.released_cents}, back ${x.refunded_cents}, chargeback ${x.chargeback_status || "none"}; at the freelancer ${sent(c)}`; };
const due = (c) => { const x = row(c); x.status = "delivered"; x.delivered_at = past(24 * 20); x.auto_release_at = past(1); };
// Stripe's deliveries of one notice about Cuvori's own account while the two secrets are swapped in Netlify: the first is
// signed with the secret the second field holds. Stripe sends a notice again only when it was not answered with success;
// by then the owner has put the two right, so it fits the first field.
async function swappedThenRight(build) {
  const got = [];
  for (let i = 0; i < 3; i++) { const r = await webhook(signed(build(), i === 0 ? SECOND : OWN)); got.push(r); if (r.status >= 200 && r.status < 300) break; }
  return got;
}
const codes = (got) => got.map(r => r.status).join("/");
const refusedFirst = (got) => got.length > 1 && !(got[0].status >= 200 && got[0].status < 300) && got[got.length - 1].status === 200;
const names = (r) => { const t = JSON.stringify(r.json || ""); return t.includes("STRIPE_WEBHOOK_SECRET") && t.includes("STRIPE_CONNECT_WEBHOOK_SECRET"); };
const marked = (type, object) => ({ type, account: "acct_1EditorAAAAAAAA", data: { object } });

// ---------- L1 a payment notice, the two secrets swapped ----------
await guard("L1", async () => {
  const c = mk({ amount_cents: 10000 }); const r = await checkout(c); const s = pay(c.stripe_checkout_id);
  const n = logs.length;
  const got = await swappedThenRight(() => ({ type: "checkout.session.completed", data: { object: s } }));
  const logged = logs.slice(n).some(l => l.includes("STRIPE_WEBHOOK_SECRET") && l.includes("STRIPE_CONNECT_WEBHOOK_SECRET"));
  vuln(r.status !== 200 || !refusedFirst(got) || !names(got[0]) || !logged || row(c).status !== "funded" || row(c).funded_cents !== 10000,
    `L1 a client pays; the two webhook secrets are swapped in Netlify: Stripe's notice answered ${got[0].status} ${JSON.stringify(got[0].json).slice(0, 140)}; the log names the two settings: ${logged}; Stripe sends it again once they are put right (${codes(got)}): ${show(c)} (must be: refused, naming both settings; recorded when sent again)`);
});
// ---------- L2 a chargeback notice, swapped, on an Order the hourly run would pay out ----------
await guard("L2", async () => {
  const c = mk({ amount_cents: 10000 }); const f = await fund(c); const pi = f.session.payment_intent, ch = chargeOf(pi);
  due(c);
  STRIPE.disputes[ch.id] = { id: "dp_" + ch.id, status: "needs_response" }; STRIPE.balance -= ch.amount;      // the bank takes the money back
  const got = await swappedThenRight(() => ({ type: "charge.dispute.created", data: { object: { id: "dp_" + ch.id, object: "dispute", charge: ch.id, payment_intent: pi, amount: ch.amount, currency: "eur", status: "needs_response", reason: "fraudulent", created: Math.floor(Date.now() / 1000) } } }));
  await hourly();
  vuln(f.webhook.status !== 200 || !refusedFirst(got) || !names(got[0]) || row(c).chargeback_status !== "open" || sent(c) !== 0,
    `L2 the client's bank charges back an Order due to be paid out; the secrets swapped: Stripe's notice ${codes(got)}; then the hourly run: ${show(c)} (must be: refused until put right, then the chargeback recorded and nothing paid to the freelancer)`);
});
// ---------- L3 a refund made in the Stripe dashboard, swapped, on an Order the hourly run would pay out ----------
await guard("L3", async () => {
  const c = mk({ amount_cents: 10000 }); const f = await fund(c); const pi = f.session.payment_intent, ch = chargeOf(pi);
  due(c);
  ch.amount_refunded += 3000; STRIPE.balance -= 3000;
  STRIPE.refunds.push({ id: "re_dash" + Math.random().toString(36).slice(2, 10), created: Date.now() / 1000, amount: 3000, contract: null, metadata: {}, payment_intent: pi, charge: ch.id, status: "succeeded" });
  const got = await swappedThenRight(() => ({ type: "charge.refunded", data: { object: { id: ch.id, object: "charge", payment_intent: pi, amount: ch.amount, amount_refunded: ch.amount_refunded, refunded: ch.amount_refunded >= ch.amount, currency: "eur" } } }));
  await hourly();
  const cash = ch.amount - backAt(pi) - sent(c);
  vuln(f.webhook.status !== 200 || !refusedFirst(got) || !names(got[0]) || row(c).refunded_cents !== 3000 || cash < 0,
    `L3 30.00 refunded in the Stripe dashboard on an Order due to be paid out; the secrets swapped: Stripe's notice ${codes(got)}; then the hourly run: ${show(c)}; Cuvori's cash from the Order ${cash} (must be: refused until put right, then the refund recorded, and never more paid out than Cuvori holds)`);
});
// ---------- L4 a freelancer's account notice, swapped: it still works ----------
await guard("L4", async () => {
  STRIPE.accounts.acct_1EditorAAAAAAAA.payouts_enabled = false;              // Stripe paused the freelancer's payouts
  const w = await webhook(signed(marked("account.updated", { id: "acct_1EditorAAAAAAAA", object: "account" }), OWN));
  const flag = DB.payout_details.find(p => p.id === users.ed.id).stripe_payouts_enabled;
  vuln(w.status !== 200 || flag !== false, `L4 Stripe pauses a freelancer's payouts; the secrets swapped: its notice ${w.status}; the freelancer's payout details say ready: ${flag} (must be: received, and no longer ready)`);
});
// ---------- L5 the right way round: a payment is recorded ----------
await guard("L5", async () => {
  const c = mk({ amount_cents: 10000 }); const f = await fund(c);
  vuln(f.webhook.status !== 200 || row(c).status !== "funded", `L5 a client pays, the secrets the right way round: Stripe's notice ${f.webhook.status}: ${show(c)} (must be: received and funded)`);
});
// ---------- L6/L7 a payment notice from a freelancer's own Stripe account is never taken for Cuvori's own ----------
for (const [label, secret] of [["L6 the right way round", SECOND], ["L7 the secrets swapped", OWN]]) await guard(label, async () => {
  const c = mk({ amount_cents: 10000 }); await checkout(c); const s = pay(c.stripe_checkout_id);
  const w = await webhook(signed(marked("checkout.session.completed", s), secret));
  vuln(w.status !== 200 || row(c).status !== "accepted" || row(c).funded_cents !== 0,
    `${label}: a payment notice marked as a freelancer's own Stripe account's (Stripe's "account" on the notice) -> ${w.status}: ${show(c)} (must be: received, and never recorded as a payment of a Cuvori Order)`);
});
// ---------- L8 a notice neither secret fits ----------
await guard("L8", async () => {
  const c = mk({ amount_cents: 10000 }); await checkout(c); const s = pay(c.stripe_checkout_id);
  const w = await webhook(signed({ type: "checkout.session.completed", data: { object: s } }, "whsec_someone_else"));
  vuln(w.status !== 400 || row(c).status !== "accepted", `L8 a payment notice signed with neither secret -> ${w.status}: ${show(c)} (must be: refused, nothing recorded)`);
});
// ---------- L9 with the second secret: a notice Cuvori does not act on, Stripe's test, an unmarked account notice ----------
await guard("L9", async () => {
  const a = await webhook(signed({ type: "payment_intent.created", data: { object: { id: "pi_x1234", object: "payment_intent" } } }, SECOND));
  const b = await webhook(signed({ type: "v2.core.event_destination.ping", data: { object: { id: "ed_x1234" } } }, SECOND));
  STRIPE.accounts.acct_1EditorAAAAAAAA.payouts_enabled = false;
  const d = await webhook(signed({ type: "account.updated", data: { object: { id: "acct_1EditorAAAAAAAA", object: "account" } } }, SECOND));
  const flag = DB.payout_details.find(p => p.id === users.ed.id).stripe_payouts_enabled;
  vuln(a.status !== 200 || b.status !== 200 || d.status !== 200 || flag !== false,
    `L9 with the second secret: a notice Cuvori does not act on (${a.status}), Stripe's "is this destination ready?" test (${b.status}), a freelancer's account notice without the account mark (${d.status}, ready: ${flag}) (must all be received: Stripe would otherwise keep sending them)`);
});

console.error = realError;
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
