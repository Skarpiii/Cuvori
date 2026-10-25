// The chat card ("Order funded", "Payment released", …) is written after the money has moved. Saving it had no safety net,
// unlike the Order's history line: when the database did not answer for a moment just then, the whole step answered
// "Something went wrong (ref …)" although the freelancer had been paid, so the client was told the opposite of what
// happened (and pressing again said "Nothing to release right now"); a payment coming in was answered "error, send again"
// to Stripe although it was recorded. Now a card that cannot be saved is written to the log and the step answers what
// really happened, like the history line. Money is never moved twice either way.
// C1 a release, C2 a milestone release, C3 a payment coming in, C4 what stays as it was (the card is saved normally).
// Run: node tests/attack-chat-card.mjs
import { DB, STRIPE, hooks, req, signed, call, mk, fund, pay, reset, fns, uuid } from "./fn-harness.mjs";
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const logs = []; const realError = console.error; console.error = (...a) => logs.push(a.map(String).join(" "));
const fx = await fns();
const res = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const noCards = () => { hooks.db = async (method, table) => (method === "POST" && table === "messages") ? res(503, { message: "database busy" }) : null; };
const paidOut = (c) => STRIPE.transfers.filter(t => t.contract === c.id).reduce((a, t) => a + t.amount, 0);
const cards = (c, ev) => DB.messages.filter(m => m.kind === "contract" && m.payload && m.payload.contract_id === c.id && (!ev || m.payload.event === ev)).length;
const history = (c, ev) => DB.order_events.filter(e => e.order_id === c.id && e.event === ev).length;
const said = (r) => `${r.status} ${JSON.stringify(r.json)}`;

{ // C1 the client releases the payment; the chat card can't be saved at that moment
  const c = mk({ amount_cents: 10000 }); await fund(fx, c); c.status = "delivered"; noCards(); logs.length = 0;
  const r = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } })); reset();
  vuln(r.status !== 200 || !(r.json && r.json.ok) || c.status !== "completed" || paidOut(c) !== 10000 || history(c, "released") !== 1 || !logs.some(l => /chat card/.test(l)),
    `C1 Release while the chat card can't be saved -> ${said(r)}; Order ${c.status}, paid to the freelancer ${paidOut(c)}, history line ${history(c, "released")}, logged: ${logs.some(l => /chat card/.test(l))} (must answer OK: the money moved, once; the card's failure is in the log)`);
  const again = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  vuln(paidOut(c) !== 10000, `C1b pressing Release again pays nothing more -> ${again.status}, paid ${paidOut(c)}`);
}
{ // C2 a milestone release
  const c = mk({ amount_cents: 10000, has_milestones: true }); await fund(fx, c);
  const m = { id: uuid(), order_id: c.id, title: "Part 1", amount_cents: 10000, status: "submitted", position: 1 }; DB.order_milestones.push(m); noCards();
  const r = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, milestone_id: m.id } })); reset();
  vuln(r.status !== 200 || m.status !== "released" || paidOut(c) !== 10000, `C2 milestone Release while the chat card can't be saved -> ${said(r)}; milestone ${m.status}, paid ${paidOut(c)} (must answer OK)`);
}
{ // C3 the payment comes in from Stripe
  const c = mk({ amount_cents: 10000 }); await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const s = pay(c.stripe_checkout_id); noCards();
  const w = await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: s } }))); reset();
  const lines = DB.order_payments.filter(p => p.order_id === c.id && p.kind === "fund").length;
  vuln(w.status !== 200 || c.status !== "funded" || c.funded_cents !== 10000 || lines !== 1 || history(c, "funded") !== 1,
    `C3 a payment while the chat card can't be saved -> webhook ${w.status}; Order ${c.status} with ${c.funded_cents}, payment lines ${lines}, history line ${history(c, "funded")} (must answer 200: the payment is recorded once)`);
}
{ // C4 normal: the chat card is saved
  const c = mk({ amount_cents: 10000 }); await fund(fx, c); c.status = "delivered";
  const r = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  vuln(r.status !== 200 || cards(c, "funded") !== 1 || cards(c) < 2, `C4 normal: a payment and a release -> ${r.status}; chat cards: funded ${cards(c, "funded")}, all ${cards(c)} (must be saved as before)`);
  reset();
}

console.error = realError;
console.log(out.join("\n"));
const bad = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${bad} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(bad ? 1 : 0);
