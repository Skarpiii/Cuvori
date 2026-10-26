// The bank's inquiry on an Order's own payment.
// Some card networks (mostly American Express and Discover) first only ask about a payment: an inquiry. Stripe takes no
// money from Cuvori then; it is answered with the facts in Stripe's dashboard, and it ends without a chargeback (closed
// after 120 days) or becomes one. Cuvori treated it as a chargeback: the Order was frozen ("disputed": no release, no
// decision), money already paid out was pulled back from the freelancer and the client was flagged — and when the inquiry
// closed without a chargeback, nothing undid it: the Order stayed frozen and the freelancer was never paid back.
// Now an inquiry only writes a note for you (answer the bank in Stripe), and the Order goes on as normal. When the bank
// turns it into a chargeback, the chargeback steps run as before: when Stripe takes the money (charge.dispute.funds_withdrawn,
// the same dispute) or, if that notice never came, when the bank's decision for the client arrives.
// I1 an Order still holding the money, I2 an Order already paid out, I3 the inquiry becomes a chargeback (Stripe takes the
// money), I4 it became one and Cuvori only hears of the bank's decision for the client, I5 an inquiry the old code froze
// the Order for, when it closes, I6 a chargeback as before (and Stripe's "money taken" notice for it changes nothing more),
// I7 the setup guide and the webhook know the new notice.
// Run: node tests/attack-inquiries.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DB, STRIPE, req, call, mk, fund, signed, reset, fns } from "./fn-harness.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const logs = []; const realError = console.error; console.error = (...a) => logs.push(a.map(String).join(" "));
const fx = await fns();
const eur = (c) => (c / 100).toFixed(2);
const chargeOf = (pi) => STRIPE.charges[STRIPE.intents[pi].latest_charge];
const dispute = (type, c, status, id) => { const ch = chargeOf(c.stripe_payment_intent);
  return call(fx.webhook, req("POST", "x", signed({ type, data: { object: { id: id || "du_inq" + ch.id, object: "dispute", charge: ch.id, payment_intent: ch.payment_intent, amount: ch.amount, currency: "eur", status, reason: "general" } } }))); };
const hourly = () => call(fx.autoRelease, req("POST", "x", {}));
const release = (c) => call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
const pulled = (c) => STRIPE.reversals.filter(r => STRIPE.transfers.find(t => t.id === r.transfer && t.contract === c.id)).reduce((a, r) => a + r.amount, 0);
const paidOut = (c) => STRIPE.transfers.filter(t => t.contract === c.id).reduce((a, t) => a + t.amount - t.amount_reversed, 0);
const flagged = (c) => DB.user_flags.some(f => f.contract_id === c.id && f.kind === "chargeback");
const asks = (c) => /bank asked about payment .*Stripe's dashboard/.test(c.money_error || "");
const view = (c) => `${c.status}, chargeback ${c.chargeback_status || "none"}, client flagged: ${flagged(c)}, note ${JSON.stringify((c.money_error || "none").slice(0, 80))}`;
const paidOutOrder = async () => { const c = mk({ amount_cents: 10000 }); await fund(fx, c); c.status = "delivered"; await release(c); return c; };

{ // I1 an Order still holding the money: the bank asks, the Order goes on; the inquiry closes and its note goes
  const c = mk({ amount_cents: 10000 }); await fund(fx, c);
  const w = await dispute("charge.dispute.created", c, "warning_needs_response"); const during = view(c), noted = asks(c), wasFunded = c.status === "funded" && !c.chargeback_status && !flagged(c);
  c.status = "delivered"; const r = await release(c);
  const w2 = await dispute("charge.dispute.closed", c, "warning_closed");
  vuln(w.status !== 200 || !wasFunded || !noted || r.status !== 200 || c.status !== "completed" || paidOut(c) !== 10000 || w2.status !== 200 || asks(c),
    `I1 the bank asks about a held Order's payment -> webhook ${w.status}; meanwhile ${during}; the client's release ${r.status}, paid out ${eur(paidOut(c))}; the inquiry closes -> ${w2.status}, now ${view(c)} (must go on as normal, with a note to answer the bank, gone when it closes)`);
}
{ // I2 an Order already paid out: nothing is pulled back from the freelancer
  const c = await paidOutOrder();
  const w = await dispute("charge.dispute.created", c, "warning_needs_response"); await hourly(); const during = view(c), back = pulled(c), noted = asks(c);
  const w2 = await dispute("charge.dispute.closed", c, "warning_closed");
  vuln(w.status !== 200 || back !== 0 || !noted || c.chargeback_status || c.status !== "completed" || flagged(c) || w2.status !== 200 || asks(c),
    `I2 the bank asks about a paid-out Order's payment -> webhook ${w.status}; pulled back from the freelancer ${eur(back)} (must be 0.00); meanwhile ${during}; the inquiry closes -> now ${view(c)}`);
}
{ // I3 the inquiry becomes a chargeback (the same dispute): when Stripe takes the money, the chargeback steps run as before
  const c = await paidOutOrder();
  await dispute("charge.dispute.created", c, "warning_needs_response");
  const w = await dispute("charge.dispute.funds_withdrawn", c, "needs_response"); const during = view(c), back = pulled(c), noteGone = !asks(c);
  const w2 = await dispute("charge.dispute.closed", c, "lost");
  vuln(w.status !== 200 || c.chargeback_status !== "lost" || back !== 10000 || !flagged(c) || !noteGone || w2.status !== 200,
    `I3 the inquiry becomes a chargeback (Stripe takes the money) -> webhook ${w.status}; ${during}; pulled back ${eur(back)} (must be 100.00, as for a chargeback); the bank decides for the client -> chargeback ${c.chargeback_status}`);
}
{ // I4 it became a chargeback and Cuvori hears only of the bank's decision for the client: recorded then, closed as lost
  const c = await paidOutOrder();
  await dispute("charge.dispute.created", c, "warning_needs_response");
  const w = await dispute("charge.dispute.closed", c, "lost");
  vuln(w.status !== 200 || c.chargeback_status !== "lost" || pulled(c) !== 10000 || !flagged(c) || asks(c),
    `I4 a chargeback Cuvori only hears of when the bank decides for the client -> webhook ${w.status}; ${view(c)}; pulled back from the freelancer ${eur(pulled(c))} (must be recorded and closed as lost, the money pulled back)`);
}
{ // I5 an Order the old code froze for an inquiry (recorded as a chargeback, money pulled back): when the inquiry closes,
  // the Order is unfrozen and the freelancer is paid back (Stripe took nothing)
  const c = await paidOutOrder(); const id = "du_old" + c.id.slice(0, 8);
  await dispute("charge.dispute.created", c, "needs_response", id); const frozen = view(c), back = pulled(c);   // what the old code did for an inquiry
  const w = await dispute("charge.dispute.closed", c, "warning_closed", id);
  vuln(back !== 10000 || w.status !== 200 || c.chargeback_status !== "won" || paidOut(c) !== 10000,
    `I5 an inquiry the old code froze the Order for (${frozen}, ${eur(back)} pulled back), then it closes -> webhook ${w.status}; chargeback ${c.chargeback_status}; the freelancer has ${eur(paidOut(c))} (must be paid back: 100.00)`);
}
{ // I6 a chargeback as before; Stripe's "money taken" notice for it afterwards changes nothing more
  const c = await paidOutOrder();
  const w = await dispute("charge.dispute.created", c, "needs_response"); const once = pulled(c);
  const w2 = await dispute("charge.dispute.funds_withdrawn", c, "needs_response"); await hourly();
  vuln(w.status !== 200 || w2.status !== 200 || c.chargeback_status !== "open" || once !== 10000 || pulled(c) !== 10000 || asks(c) || !flagged(c),
    `I6 a chargeback -> webhook ${w.status}, chargeback ${c.chargeback_status}, pulled back ${eur(once)}; then Stripe's "money taken" notice -> ${w2.status}, pulled back in all ${eur(pulled(c))} (must stay 100.00)`);
}
{ // I7 the setup guide asks Stripe for the "money taken" notice, and the webhook takes it
  const setup = fs.readFileSync(path.join(root, "SETUP.md"), "utf8"), hook = fs.readFileSync(path.join(root, "netlify/functions/stripe-webhook.mjs"), "utf8");
  const lists = (setup.match(/charge\.dispute\.funds_withdrawn/g) || []).length, handled = /HANDLED = \[[^\]]*"charge\.dispute\.funds_withdrawn"/.test(hook);
  vuln(lists < 2 || !handled, `I7 the "money taken" notice -> named in the setup guide ${lists} times (must be both webhook steps), in the webhook's list: ${handled}`);
}
reset();
console.error = realError;
console.log(out.join("\n"));
const bad = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${bad} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(bad ? 1 : 0);
