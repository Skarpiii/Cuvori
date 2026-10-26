// The webhook reads Stripe's classic "Snapshot" events, where the object the event is about travels inside the event
// (data.object). Since 30 September 2026 Stripe also offers "Thin" events, which carry only a reference, and offers them
// when an event destination is created. An event the webhook cannot read must never be answered "received": Stripe would
// count it as delivered and never send it again, so a payment, a dashboard refund or a chargeback would be lost without a
// trace. It is refused instead (Stripe shows it as failed and sends it again), and it is logged. Events Cuvori does not
// handle at all keep being answered "received", so an extra event never makes the endpoint fail.
// W1–W3 thin and non-v1 events (W3b: Stripe's test ping is answered); W4–W5 a handled event without its object; W6–W8 normal events unchanged; W9 SETUP.md.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const H = await import("./fn-harness.mjs");
const { DB, STRIPE, users, req, call, mk, signed, fund, pay } = H;
const logs = []; const ce = console.error; console.error = (...a) => logs.push(a.map(String).join(" "));
const fx = await H.fns();
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const ok2xx = (r) => r.status >= 200 && r.status < 300;
const snap = () => JSON.stringify([DB.contracts.map(c => [c.id, c.status, c.funded_cents, c.released_cents, c.refunded_cents, c.chargeback_status || null]), DB.order_payments.length, DB.payout_details, Object.values(STRIPE.intents).map(p => p.status), STRIPE.refunds.length, STRIPE.transfers.length]);
const send = (ev) => call(fx.webhook, req("POST", "x", signed(ev)));

// a client has paid a page (a hold on the card); the notice about it has not arrived yet
const c = mk(); await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
const s = pay(c.stripe_checkout_id), pi = s.payment_intent;
const hold = () => STRIPE.intents[pi].status;
const ref = { id: s.id, type: "checkout.session", url: `/v1/checkout/sessions/${s.id}` };

// ---------- W1–W3: thin events and events that are not v1 snapshot events ----------
for (const [name, ev] of [
  ["W1 a thin event for the paid page (v1.checkout.session.completed, only a reference)", { object: "v2.core.event", type: "v1.checkout.session.completed", related_object: ref, snapshot_event: "evt_1" }],
  ["W2 a thin event under the classic name (no data in it)", { type: "checkout.session.completed", related_object: ref }],
  ["W3 an event of Stripe's v2 API", { object: "v2.core.event", type: "v2.core.account.updated", related_object: { id: "acct_1EditorAAAAAAAA", type: "v2.core.account" } }],
]) {
  const before = snap(), l0 = logs.length;
  const r = await send(ev);
  const logged = logs.slice(l0).some(l => /Snapshot/.test(l));
  vuln(ok2xx(r) || snap() !== before || !logged || !/Snapshot/.test(JSON.stringify(r.json || {})),
    `${name} -> ${r.status} ${JSON.stringify(r.json)}; nothing changed: ${snap() === before}; card ${hold()}; logged: ${logged} (must be refused so Stripe sends it again, and say Snapshot)`);
}

{ // W3b Stripe's test of a destination (a ping) is answered, so the test in Workbench passes
  const before = snap();
  const r = await send({ object: "v2.core.event", type: "v2.core.event_destination.ping", related_object: { id: "ed_1", type: "v2.core.event_destination" } });
  vuln(r.status !== 200 || snap() !== before, `W3b Stripe's test ping of the destination -> ${r.status} ${JSON.stringify(r.json)} (must be answered, nothing changed)`);
}

// ---------- W4–W5: an event Cuvori handles, arriving without the object it is about ----------
const HANDLED = ["checkout.session.completed", "checkout.session.async_payment_succeeded", "account.updated", "charge.refunded", "charge.dispute.created", "charge.dispute.funds_withdrawn", "charge.dispute.closed"];
for (const type of HANDLED) {
  for (const [what, data] of [["no data", undefined], ["data without object", {}], ["object null", { object: null }], ["object a list", { object: [] }], ["object without id", { object: { object: "x" } }]]) {
    const before = snap();
    const r = await send({ type, ...(data === undefined ? {} : { data }) });
    vuln(ok2xx(r) || snap() !== before, `W4 ${type} with ${what} -> ${r.status} ${JSON.stringify(r.json)}; nothing changed: ${snap() === before} (must be refused)`);
  }
}
vuln(hold() !== "requires_capture" || c.status !== "accepted", `W5 after all that, the paid page is untouched -> card ${hold()}, Order ${c.status} (must be untouched)`);

// ---------- W6–W8: the normal events work as before ----------
{
  const r = await send({ type: "checkout.session.completed", data: { object: STRIPE.sessions[s.id] } });
  vuln(r.status !== 200 || c.status !== "funded" || hold() !== "succeeded", `W6 the classic snapshot event for the same payment, after the refused ones -> ${r.status}; Order ${c.status}, card ${hold()} (must be recorded once)`);
  const again = await send({ type: "checkout.session.completed", data: { object: STRIPE.sessions[s.id] } });
  vuln(again.status !== 200 || c.funded_cents !== c.amount_cents, `W6 the same event once more -> ${again.status}; paid in ${c.funded_cents} (must stay ${c.amount_cents})`);
}
{
  const a = await send({ type: "account.updated", data: { object: { id: "acct_1EditorAAAAAAAA", object: "account" } } });
  const d = mk(); const f = await fund(fx, d); const ch = STRIPE.charges[STRIPE.intents[d.stripe_payment_intent].latest_charge];
  const dc = await send({ type: "charge.dispute.created", data: { object: { id: "dp_" + ch.id, object: "dispute", charge: ch.id, payment_intent: ch.payment_intent, amount: ch.amount, status: "needs_response" } } });
  vuln(a.status !== 200 || f.webhook.status !== 200 || dc.status !== 200 || d.chargeback_status !== "open",
    `W7 the other events Cuvori handles (account update, payment, chargeback) -> ${a.status}/${f.webhook.status}/${dc.status}; chargeback ${d.chargeback_status} (must work as before)`);
}
for (const type of ["payment_intent.created", "customer.created", "invoice.paid"]) {
  const before = snap();
  const r = await send({ type, data: { object: { id: "x_1", object: type.split(".")[0] } } });
  vuln(r.status !== 200 || snap() !== before, `W8 an event Cuvori does not handle (${type}) -> ${r.status} (must stay "received", so an extra event never makes the endpoint fail)`);
}

// ---------- W9: SETUP.md creates the webhook with Snapshot, in Stripe's words of October 2026 ----------
{
  const text = fs.readFileSync(fileURLToPath(new URL("../SETUP.md", import.meta.url)), "utf8");
  const steps = text.split(/\n(?=\d+\.\s|#)/).filter(p => /stripe-webhook/.test(p) && /(Webhooks|destination)/.test(p));
  vuln(steps.length < 2, `W9 the SETUP.md steps that create the Stripe webhook were found (${steps.length}, must be 2: Part 5 step 4 and Part 15 item 3)`);
  for (const p of steps) {
    const name = p.replace(/\s+/g, " ").replace(/\*\*/g, "").slice(0, 60);
    const missing = ["**Developers**", "**Webhooks**", "**+ Add destination**", "**Your account**", "**Snapshot**", "**Webhook endpoint**", "**Endpoint URL**", "**Create destination**", "**Signing secret**", "**Connected accounts**", "STRIPE_CONNECT_WEBHOOK_SECRET", "main--cuvori.netlify.app/.netlify/functions/stripe-webhook",
      "`checkout.session.completed`", "`checkout.session.async_payment_succeeded`", "`charge.refunded`", "`charge.dispute.created`", "`charge.dispute.closed`", "`account.updated`"].filter(w => !p.includes(w));
    vuln(missing.length > 0 || !/not \*\*Thin\*\*/.test(p), `W9 "${name}…" names Stripe's buttons, Snapshot (not Thin), the address, the five events and the connected-accounts one -> missing: ${JSON.stringify(missing)}${/not \*\*Thin\*\*/.test(p) ? "" : ' and "not Thin"'}`);
  }
}

console.error = ce;
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
