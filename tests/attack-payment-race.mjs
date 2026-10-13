// Fund and the first payment, when something happens at the same moment (the payment functions' side; the database's
// side is tests/attack-payment-lock.mjs):
//  - the price changes right before the payment is recorded: the payment is never recorded as paying a different price
//    (with schema v34 the change has to wait for the payment step, so this is the second line of defence);
//  - the client's card hold was released because the Order could not take the payment at that moment (the freelancer
//    was suspended), and the Order still waits for it: the next Fund click makes a new page at once, instead of saying
//    for up to half an hour that the Order is not waiting for a payment;
//  - closing an old payment page fails: the Netlify log says so.
// P1–P2 the record, P3–P5 Fund after a released hold, P6 a failed close.
// Run: node tests/attack-payment-race.mjs
const H = await import("./fn-harness.mjs");
const { DB, STRIPE, users, hooks, req, call, mk, pay, signed, reset } = H;
const logs = []; console.error = (...a) => logs.push(a.map(x => (x && x.stack) || String(x)).join(" "));
const fx = await H.fns();
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const euro = (c) => `€${((c || 0) / 100).toFixed(2)}`;
const click = (c, lang = "en") => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, lang } }));
const notice = (s) => call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: s } })));

// ---------- P1–P2: the price changes right before the payment is recorded ----------
for (const [what, delta] of [["a price decrease", -1000], ["a price increase", 1000]]) {
  const c = mk(); await click(c); const s = pay(c.stripe_checkout_id);
  let done = false;
  hooks.db = async (method, table, search) => { if (!done && method === "PATCH" && table === "contracts" && /status=(eq\.accepted|in\.\(accepted\))/.test(decodeURIComponent(search))) { done = true; c.amount_cents += delta; c.price = c.amount_cents / 100; } return null; };
  await notice(s); reset();
  const wrong = c.status === "funded" && c.funded_cents !== c.amount_cents;
  vuln(wrong, `P${delta < 0 ? 1 : 2} ${what} saved right before the first payment is recorded -> Order ${c.status}, price ${euro(c.amount_cents)}, paid in ${euro(c.funded_cents)} (a payment must never be recorded as paying a different price)`);
}

// ---------- P3–P5: Fund again after the card hold was released ----------
const ed = DB.profiles.find(p => p.id === users.ed.id);
{
  const c = mk(); await click(c); const page1 = c.stripe_checkout_id;
  ed.banned = true; const s = pay(page1); await notice(s); ed.banned = false;      // suspended while the client was on Stripe's page, then reinstated
  const released = STRIPE.intents[s.payment_intent].status === "canceled" && c.status === "accepted";
  const l0 = logs.length;
  const r = await click(c);
  const page2 = c.stripe_checkout_id;
  vuln(!released || r.status !== 200 || !r.json || !r.json.url || page2 === page1 || STRIPE.sessions[page2].status !== "open",
    `P3 the hold was released (the freelancer was suspended), the freelancer is reinstated, the client clicks Fund in the same half hour -> ${r.status} ${r.json && (r.json.code || (r.json.url ? "a new payment page" : ""))} (must be a new, open payment page at once)`);
  const s2 = pay(page2); const w = await notice(s2);
  vuln(w.status !== 200 || c.status !== "funded" || c.funded_cents !== 10000 || STRIPE.intents[s2.payment_intent].status !== "succeeded",
    `P4 the client pays the new page -> Order ${c.status}, paid in ${euro(c.funded_cents)} (must be paid once)`);
  vuln(logs.slice(l0).some(l => /could not close a payment page/.test(l) && l.includes(page1)), `P4 the page whose hold was released is not "closed" again (it is complete at Stripe) -> no failed close logged for it`);
}
{
  const c = mk(); await click(c); const page1 = c.stripe_checkout_id;
  ed.banned = true; const s = pay(page1); await notice(s); ed.banned = false;
  // the freelancer cancels the Order while the client clicks Fund
  hooks.stripe = async (path, method) => { if (method === "GET" && path === `/checkout/sessions/${page1}`) c.status = "cancelled"; return null; };
  const r = await click(c); reset();
  const pages = Object.values(STRIPE.sessions).filter(x => x.client_reference_id === c.id && x.status === "open");
  vuln(r.status !== 409 || (r.json && r.json.code) !== "order_changed" || pages.length !== 0, `P5 the same, but the Order is cancelled in that very moment -> ${r.status} ${r.json && r.json.code}; open pages ${pages.length} (must say the Order changed and make no page)`);
}

// ---------- P6: closing an old page fails ----------
{
  const c = mk(); await click(c, "en"); const old = c.stripe_checkout_id;
  hooks.stripe = async (path, method) => (method === "POST" && /\/expire$/.test(path) ? [500, { error: { type: "api_error", message: "An unknown error occurred" } }] : null);
  const l0 = logs.length;
  await click(c, "de"); reset();
  const line = logs.slice(l0).find(l => /could not close a payment page/.test(l) && l.includes(old));
  vuln(!line, `P6 the client switches language and closing the old page fails -> Netlify log: ${line ? JSON.stringify(line.slice(0, 110)) : "nothing"} (must say which page stayed open)`);
}

console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
