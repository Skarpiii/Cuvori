// An Order's note for the admin ("Needs a hand" in the admin panel) stays until it is dealt with.
// A payout or refund that stops writes why on the Order, so the admin sees it. When that step later went through, the
// whole-Order release (settle) and a milestone's payout cleared the note — any note, not only their own: a "check by hand"
// note (a top-up that may not be recorded, a counter that could not be updated, a refund made in the Stripe dashboard) or a
// note the hourly run works from (a payout's ledger line still to add) was wiped by the next payout and never seen. A full
// refund made in the Stripe dashboard, a chargeback that was lost and one that was won did the same, and any new note
// replaced the one before it. Now an Order's note can hold several, newest first ("… · Also: …"): a new note never wipes
// out the one that was there, and each step removes only its own note, so the rest comes back. The notes the hourly run
// works from always come first (a chargeback's pull-back or re-payment, then a payment line still to add), so it still
// finds them. A stopped step writes its note under its own heading ("Money step stopped (settlement): …", "… (milestone
// <id>): …"); it replaces only an empty note, a "Stripe check failed" note or an older stop. Notes that need a person stay
// until the admin marks them as handled (schema v55, tested in attack-note-handled.mjs).
// O1 a "check by hand" note and a milestone payout, O2 the same with a whole-Order release, O3 the hourly run's ledger
// note, O4 a step's own note goes once it goes through (whole Order and milestone), O5 a step that stops while there is a
// "check by hand" note, O6 one milestone's note is not removed by another milestone, O7 notes from before this change,
// O8 the admin's decision on a dispute keeps the dispute's note, O9 a newer stop replaces an older stop's note, O10 an
// empty note counts as none, O11 a full refund made in the Stripe dashboard, O12 a chargeback lost, O13 a chargeback won,
// O14 a pull-back that failed and is made later, O15 two notes that need a person, O16 the hourly run's note stays first,
// O17 a top-up's repair removes only that top-up's note, O18 the same note delivered twice is there once.
// Run: node tests/attack-order-notes.mjs
import { DB, STRIPE, hooks, req, call, mk, fund, reset, fns, uuid, onlyDue, moneyOut, signed, pay, F } from "./fn-harness.mjs";
const lib = await import(F + "../lib/cuvori.mjs");
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const logs = []; const realError = console.error; console.error = (...a) => logs.push(a.map(String).join(" "));
const fx = await fns();
const said = (r) => `${r.status} ${JSON.stringify(r.json).slice(0, 120)}`;
const shown = (s) => JSON.stringify(s ?? null).slice(0, 150);
const SETTLING = { type: "invalid_request_error", code: "balance_insufficient", message: "You have insufficient available funds in your Stripe account." };
const NOT_READY = { type: "invalid_request_error", code: "insufficient_capabilities_for_transfer", message: "Your destination account needs to have at least one of the following capabilities enabled: transfers" };
const stripeSays = (path, status, error) => { hooks.stripe = async (p, method) => (p === path && method === "POST") ? [status, { error }] : null; };
const TOPUP = "top-up pi_3NotesTopup1 may not be recorded — check by hand";
const SETTLE_HEAD = "Money step stopped (settlement): ";
const msHead = (m) => `Money step stopped (milestone ${m.id}): `;
const release = (c, m) => call(fx.release, req("POST", "x", { token: "tok_cl", body: m ? { contract_id: c.id, milestone_id: m.id } : { contract_id: c.id } }));
const msOrder = async (n = 2) => {
  const c = mk({ amount_cents: 10000 * n, has_milestones: true }); await fund(fx, c); c.status = "funded";
  const ms = Array.from({ length: n }, (_, i) => ({ id: uuid(), order_id: c.id, title: `Part ${i + 1}`, amount_cents: 10000, status: "submitted", position: i + 1 }));
  DB.order_milestones.push(...ms); return { c, ms };
};
const whole = async (extra) => { const c = mk({ amount_cents: 10000, ...(extra || {}) }); await fund(fx, c); c.status = "delivered"; return c; };
const hourly = async (c) => { onlyDue(c); c.resolved_at = new Date(Date.now() - 11 * 60e3).toISOString(); return call(fx.autoRelease, req("POST", "x", {})); };

{ // O1 a "check by hand" note on the Order, then the client approves a milestone
  const { c, ms } = await msOrder(); c.money_error = TOPUP;
  const r = await release(c, ms[0]);
  const first = c.money_error;
  const counter = `counter update failed for milestone ${uuid()}`; c.money_error = counter;
  const r2 = await release(c, ms[1]);
  vuln(r.status !== 200 || r2.status !== 200 || ms[1].status !== "released" || first !== TOPUP || c.money_error !== counter,
    `O1 a milestone is paid out while the Order has a "check by hand" note -> ${r.status}, note ${shown(first)}; another note ("counter update failed"), the next milestone -> ${r2.status}, note ${shown(c.money_error)} (each must stay as it was)`);
  reset();
}
{ // O2 the same with a whole-Order release
  const c = await whole(); c.money_error = TOPUP;
  const r = await release(c);
  vuln(r.status !== 200 || c.status !== "completed" || c.money_error !== TOPUP,
    `O2 the client releases an Order that has a "check by hand" note -> ${r.status}, Order ${c.status}; the note: ${shown(c.money_error)} (must stay until the admin deals with it)`);
  reset();
}
{ // O3 the hourly run's note: a payout's ledger line still to add. The next milestone must not wipe it, or the line is never added.
  const { c, ms } = await msOrder();
  const note = `ledger line of a milestone payout not saved: ${uuid()} (transfer tr_NotesLine1; the hourly run adds it from Stripe's record; if this note stays, check by hand)`;
  c.money_error = note;
  const r = await release(c, ms[0]);
  vuln(r.status !== 200 || c.money_error !== note, `O3 a milestone is paid out while the hourly run still has a ledger line to add -> ${r.status}; the note: ${shown(c.money_error)} (must stay: the hourly run finds the line by it)`);
  reset();
}
{ // O4 a step's own note: written under its heading when it stops, removed once it goes through
  const c = await whole(); stripeSays("/transfers", 400, SETTLING);
  const r = await release(c); reset();
  const noted = c.money_error;
  const h = await hourly(c);
  const { c: d, ms } = await msOrder(1); stripeSays("/transfers", 400, SETTLING);
  const rm = await release(d, ms[0]); reset();
  const notedM = d.money_error;
  const again = await release(d, ms[0]);
  vuln(r.status !== 409 || !String(noted || "").startsWith(SETTLE_HEAD) || !/still settling/.test(noted) || h.status !== 200 || c.status !== "completed" || c.money_error != null
       || rm.status !== 409 || !String(notedM || "").startsWith(msHead(ms[0])) || !/still settling/.test(notedM) || again.status !== 200 || d.money_error != null,
    `O4 a release stops (the money is still settling), the hourly run then pays it -> ${r.status}; note ${shown(noted)}; then Order ${c.status}, note ${shown(c.money_error)}; a milestone the same -> ${rm.status}; note ${shown(notedM)}; then ${again.status}, note ${shown(d.money_error)} (the note must name the step, and go once the step went through)`);
}
{ // O5 a step that stops while the Order has a "check by hand" note: that note stays first, the stop is added after it, and
  // goes again once the step went through; the person's answer and the log are as before
  const c = await whole(); c.money_error = TOPUP; stripeSays("/transfers", 400, SETTLING);
  const r = await release(c); reset();
  const both = c.money_error;
  const h = await hourly(c);
  const d = await whole(); d.money_error = TOPUP; logs.length = 0;
  hooks.stripe = async (p, method) => (p === "/transfers" && method === "POST") ? [500, { error: { type: "api_error", message: "Stripe broke" } }] : null;
  const r2 = await release(d); reset();
  const ref = r2.json && r2.json.ref;
  vuln(r.status !== 409 || (r.json && r.json.code) !== "settling" || !String(both || "").startsWith(TOPUP + " · Also: " + SETTLE_HEAD) || !/still settling/.test(both)
       || h.status !== 200 || c.status !== "completed" || c.money_error !== TOPUP
       || r2.status !== 500 || !ref || !String(d.money_error || "").startsWith(TOPUP + " · Also: " + SETTLE_HEAD) || !String(d.money_error).includes(ref) || !logs.some(l => l.includes("money step failed") && l.includes(ref)),
    `O5 a release stops while the Order has a "check by hand" note -> ${said(r)}; note ${shown(both)}; once paid out -> Order ${c.status}, note ${shown(c.money_error)}; Stripe fails -> ${said(r2)}, note ${shown(d.money_error)}, the ref in the log: ${logs.some(l => l.includes("money step failed") && l.includes(ref))} (the "check by hand" note must stay first, the stop after it, and only the stop goes)`);
}
{ // O6 milestone A stops, milestone B is paid out: A's note stays until A is paid out
  const { c, ms } = await msOrder(); stripeSays("/transfers", 400, SETTLING);
  await release(c, ms[0]); reset();
  const noteA = c.money_error;
  const rb = await release(c, ms[1]);
  const afterB = c.money_error;
  const ra = await release(c, ms[0]);
  vuln(!String(noteA || "").startsWith(msHead(ms[0])) || rb.status !== 200 || afterB !== noteA || ra.status !== 200 || c.money_error != null || c.status !== "completed",
    `O6 milestone A stops, then B is paid out -> ${rb.status}; A's note after B: ${shown(afterB)}; then A is paid out -> ${ra.status}, note ${shown(c.money_error)}, Order ${c.status} (A's note must stay until A went through)`);
}
{ // O7 notes a stopped step wrote before this change (no heading): removed when the step goes through, as before
  const old = ["The card payment is still settling at the payment provider. Cuvori retries this every hour; nothing needs to be done.",
               "Stripe had a problem on its side (Netlify log ref 1a2b3c4d)"];
  const res = [];
  for (const note of old) {
    const c = await whole(); Object.assign(c, { status: "releasing", resolution: "release", split_editor_cents: 10000, refund_cents: 0, resolved_by: c.client, money_error: note });
    await hourly(c); res.push(`${c.status}/${shown(c.money_error)}`);
  }
  const { c: d, ms } = await msOrder(1); d.money_error = old[1];
  const r = await release(d, ms[0]);
  vuln(res.some(x => x !== "completed/null") || r.status !== 200 || d.money_error != null,
    `O7 a stopped step's note from before this change, the step then goes through -> whole Order: ${res.join(", ")}; milestone: ${r.status}, note ${shown(d.money_error)} (must go, as before)`);
}
{ // O8 the admin decides a dispute that has the dispute's own note (a refund made in the Stripe dashboard): the note stays
  const c = await whole();
  const note = "Refund of 20.00 EUR made outside Cuvori on payment pi_3NotesDash1; the order holds 20.00 less than before";
  Object.assign(c, { status: "disputed", money_error: note, refunded_cents: 2000 });
  const r = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "release" } }));
  vuln(r.status !== 200 || c.status !== "completed" || c.money_error !== note,
    `O8 the admin releases a dispute that came from a refund made in the Stripe dashboard -> ${r.status}, Order ${c.status}; the note: ${shown(c.money_error)} (must stay until the admin marks it as handled)`);
}
{ // O9 a newer stop replaces an older stop's note (its reason is the current one)
  const c = await whole(); stripeSays("/transfers", 400, SETTLING);
  await release(c); reset();
  const first = c.money_error;
  stripeSays("/transfers", 400, NOT_READY);
  const r = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } })); reset();
  vuln(!String(first || "").startsWith(SETTLE_HEAD) || r.status !== 409 || !String(c.money_error || "").startsWith(SETTLE_HEAD) || !/not ready/.test(c.money_error || ""),
    `O9 a release stops twice for different reasons -> first note ${shown(first)}; then ${said(r)}, note ${shown(c.money_error)} (must be the newest reason)`);
}
{ // O10 an empty note (only spaces) counts as no note
  const c = await whole(); c.money_error = "   "; stripeSays("/transfers", 400, SETTLING);
  await release(c); reset();
  vuln(!String(c.money_error || "").startsWith(SETTLE_HEAD), `O10 a release stops on an Order whose note is only spaces -> note ${shown(c.money_error)} (must be the step's note)`);
}

// ---------- the other places that write an Order's note: a refund made in the Stripe dashboard, chargebacks, top-ups ----------
const chargeOf = (pi) => STRIPE.charges[STRIPE.intents[pi].latest_charge];
const chargeEvent = (ch) => signed({ type: "charge.refunded", data: { object: { id: ch.id, object: "charge", payment_intent: ch.payment_intent, amount: ch.amount, amount_refunded: ch.amount_refunded, refunded: ch.amount_refunded >= ch.amount } } });
const cbEvent = (type, ch, extra = {}) => signed({ type, data: { object: { id: extra.id || "dp_" + ch.id, object: "dispute", charge: ch.id, payment_intent: ch.payment_intent, amount: extra.amount || ch.amount, status: extra.status || "needs_response", ...extra } } });
const dashboardRefund = (ch, amount) => { STRIPE.refunds.push({ id: "re_" + uuid().slice(0, 8), amount, metadata: {}, payment_intent: ch.payment_intent, charge: ch.id, status: "succeeded" }); ch.amount_refunded += amount; };
const paidOut = async () => { const c = mk(); const f = await fund(fx, c); c.status = "delivered"; await release(c); return { c, ch: chargeOf(f.session.payment_intent) }; };
{ // O11 the whole payment refunded in the Stripe dashboard while the Order holds it
  const c = mk(); const f = await fund(fx, c); c.status = "delivered"; c.money_error = TOPUP;
  const ch = chargeOf(f.session.payment_intent); dashboardRefund(ch, ch.amount);
  const w = await call(fx.webhook, req("POST", "x", chargeEvent(ch)));
  vuln(w.status !== 200 || c.status !== "refunded" || c.money_error !== TOPUP,
    `O11 the whole payment refunded in the Stripe dashboard -> webhook ${w.status}, Order ${c.status}; the note: ${shown(c.money_error)} (must stay)`);
  reset();
}
{ // O12 a chargeback after the payout, pulled back in full, then lost
  const { c, ch } = await paidOut(); c.money_error = TOPUP; STRIPE.disputes[ch.id] = { status: "needs_response" };
  await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.created", ch)));
  STRIPE.disputes[ch.id].status = "lost";
  const w = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.closed", ch, { status: "lost" })));
  vuln(w.status !== 200 || c.chargeback_status !== "lost" || c.money_error !== TOPUP,
    `O12 a chargeback after the payout, lost -> webhook ${w.status}, chargeback ${c.chargeback_status}; the note: ${shown(c.money_error)} (must stay)`);
  reset();
}
{ // O13 a chargeback after the payout, then won: "re-payment pending" comes first while the freelancer is paid again, the note after it
  const { c, ch } = await paidOut(); c.money_error = TOPUP; STRIPE.disputes[ch.id] = { status: "needs_response" };
  await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.created", ch)));
  STRIPE.disputes[ch.id].status = "won";
  stripeSays("/transfers", 400, SETTLING);                                  // the re-payment has to wait for the hourly run
  const w = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.closed", ch, { status: "won" }))); reset();
  const waiting = c.money_error;
  onlyDue(c); const h = await call(fx.autoRelease, req("POST", "x", {}));
  vuln(w.status !== 200 || c.chargeback_status !== "won" || !String(waiting || "").startsWith("chargeback won, re-payment failed: ") || !String(waiting).endsWith(" · Also: " + TOPUP)
       || h.status !== 200 || moneyOut(c).transferred !== 10000 || c.money_error !== TOPUP,
    `O13 a chargeback won, the re-payment waits -> note ${shown(waiting)}; the hourly run pays the freelancer again (${moneyOut(c).transferred}) -> note ${shown(c.money_error)} (the re-payment's note first while it waits, then the "check by hand" note alone)`);
  reset();
}
{ // O14 the pull-back from the freelancer fails at first: its note comes first, and once the hourly run made it, the earlier note is back
  const { c, ch } = await paidOut(); c.money_error = TOPUP; STRIPE.disputes[ch.id] = { status: "needs_response" };
  hooks.stripe = async (p, method) => (/\/reversals$/.test(p) && method === "POST") ? [400, { error: { type: "invalid_request_error", message: "Insufficient funds in the connected account." } }] : null;
  const w = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.created", ch))); reset();
  const waiting = c.money_error;
  onlyDue(c); await call(fx.autoRelease, req("POST", "x", {}));
  vuln(w.status !== 200 || !String(waiting || "").startsWith("chargeback: ") || !String(waiting).endsWith(" · Also: " + TOPUP) || moneyOut(c).transferred !== 0 || c.money_error !== TOPUP,
    `O14 the pull-back after a chargeback is refused at first -> note ${shown(waiting)}; the hourly run pulls it back (the freelancer keeps ${moneyOut(c).transferred}) -> note ${shown(c.money_error)} (the pull-back's note first while it waits, then the "check by hand" note alone)`);
  reset();
}
{ // O15 two notes that need a person: both stay, the newest first
  const { c, ch } = await paidOut(); c.money_error = TOPUP;
  dashboardRefund(ch, ch.amount);                                          // paid out already, and now the whole payment went back as well
  const w = await call(fx.webhook, req("POST", "x", chargeEvent(ch)));
  vuln(w.status !== 200 || !/^Refund of \d+\.\d\d EUR made outside Cuvori .* had already been paid out .* · Also: /.test(c.money_error || "") || !String(c.money_error).endsWith(" · Also: " + TOPUP),
    `O15 a payout went out twice (a dashboard refund after it) on an Order that already had a "check by hand" note -> ${w.status}; the note: ${shown(c.money_error)} (both, the newest first)`);
  reset();
}
{ // O16 the hourly run's note stays first when a note that needs a person comes after it, so the hourly run still finds it
  const { c, ms } = await msOrder(2);
  await release(c, ms[0]);
  const line = `ledger line of a milestone payout not saved: ${ms[0].id} (transfer ${ms[0].transfer_ref}; the hourly run adds it from Stripe's record; if this note stays, check by hand)`;
  DB.order_payments.splice(DB.order_payments.findIndex(p => p.order_id === c.id && p.milestone_id === ms[0].id), 1);
  c.money_error = line;
  const ch = chargeOf(c.stripe_payment_intent); dashboardRefund(ch, 2000);  // part of the payment back from the dashboard: a dispute with its note
  const w = await call(fx.webhook, req("POST", "x", chargeEvent(ch)));
  const both = c.money_error;
  ms[0].released_at = new Date(Date.now() - 5 * 60e3).toISOString();
  onlyDue(c); await call(fx.autoRelease, req("POST", "x", {}));
  const lines = DB.order_payments.filter(p => p.order_id === c.id && p.milestone_id === ms[0].id).length;
  vuln(w.status !== 200 || !String(both || "").startsWith(line + " · Also: Refund of ") || lines !== 1 || !String(c.money_error || "").startsWith("Refund of "),
    `O16 a dispute note arrives while a payout line is still to add -> note ${shown(both)}; the hourly run adds the line (${lines}) -> note ${shown(c.money_error)} (the line's note must stay first, then go, leaving the dispute's note)`);
  reset();
}
{ // O17 the repair of a top-up whose record broke off removes only that top-up's own note, not another note naming the same payment
  const res = [];
  for (const note of [(pi) => `top-up ${pi} counted but its ledger line failed — check by hand`, (pi) => `Refund of 5.00 EUR made outside Cuvori on payment ${pi}; the order holds 5.00 less than before`]) {
    const c = await whole(); c.amount_cents = 15000;
    await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
    const s = pay(c.stripe_checkout_id);
    if (STRIPE.intents[s.payment_intent].status === "requires_capture") await lib.stripe("POST", `/payment_intents/${s.payment_intent}/capture`, {});
    // an earlier delivery counted the top-up and died before its ledger line: its claim is old, the counter includes it
    c.funded_cents = 15000; c.money_error = note(s.payment_intent);
    DB.money_keys.push({ scope: `apply:${s.payment_intent}`, key: "claim:died", created_at: new Date(Date.now() - 5 * 60e3).toISOString() });
    const done = { ...STRIPE.sessions[c.stripe_checkout_id], status: "complete", payment_status: "paid" };
    await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: done } })));
    res.push({ note: note(s.payment_intent), after: c.money_error, line: DB.order_payments.some(p => p.order_id === c.id && p.provider_ref === s.payment_intent) });
  }
  vuln(!res[0].line || res[0].after != null || !res[1].line || res[1].after !== res[1].note,
    `O17 a top-up's broken-off record repaired -> its own note: ${shown(res[0].after)} (line ${res[0].line}); another note naming the payment: ${shown(res[1].after)} (line ${res[1].line}) (the top-up's note goes, the other stays)`);
  reset();
}
{ // O18 a note never grows a copy of itself: the same note written again (a webhook sent twice) is there once
  const { c, ch } = await paidOut(); c.money_error = TOPUP;
  dashboardRefund(ch, ch.amount);
  await call(fx.webhook, req("POST", "x", chargeEvent(ch))); const once = c.money_error;
  await call(fx.webhook, req("POST", "x", chargeEvent(ch)));
  vuln(c.money_error !== once || (c.money_error || "").split(" · Also: ").length !== 2, `O18 the same refund event delivered twice -> note ${shown(c.money_error)} (must be the same as after the first: two notes, not three)`);
  reset();
}

console.error = realError;
console.log(out.join("\n"));
const bad = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${bad} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(bad ? 1 : 0);
