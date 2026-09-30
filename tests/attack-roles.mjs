// Role & tampering attack suite: call every payment function as the WRONG person, and with tampered
// inputs, and prove nothing moves. Roles: anonymous (no token), the order's client (tok_cl), the order's
// professional/editor (tok_ed), an admin (tok_adm), a stranger client (tok_cl2), a second professional not
// on the order (tok_ed2). "safe" = the attempt was refused and no money moved; "VULNERABLE" = it got through.
import { DB, STRIPE, users, hooks, req, call, mk, moneyOut, reset, fns, fund, pay, uuid, signed, onlyDue, past } from "./fn-harness.mjs";
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const info = (m) => out.push("info       " + m);
const fx = await fns();
const ledger = (c, kind) => DB.order_payments.filter(p => p.order_id === c.id && (!kind || p.kind === kind));
const STRANGERS = [["anon", undefined], ["stranger-client", "tok_cl2"], ["second-pro", "tok_ed2"]];

// ---------- R-A: checkout (fund) — only the order's own client may start a payment ----------
{
  const c = mk();
  for (const [name, tok] of [...STRANGERS, ["the-editor", "tok_ed"], ["admin", "tok_adm"]]) {
    const r = await call(fx.checkout, req("POST", "x", tok ? { token: tok, body: { contract_id: c.id } } : { body: { contract_id: c.id } }));
    vuln(r.status === 200, `R-A ${name} starts a checkout on someone else's order -> HTTP ${r.status} ${r.json && r.json.error || ""}`);
  }
  const ok = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  vuln(ok.status !== 200, `R-A the real client can still fund -> HTTP ${ok.status} ${ok.json && ok.json.error || ""}`);
  reset();
}
// ---------- R-B: release — only the client may release; the professional must NOT be able to pay himself ----------
{
  const c = mk(); await fund(fx, c); c.status = "delivered";
  for (const [name, tok] of [...STRANGERS, ["the-editor-pays-himself", "tok_ed"], ["admin-via-release", "tok_adm"]]) {
    const r = await call(fx.release, req("POST", "x", tok ? { token: tok, body: { contract_id: c.id } } : { body: { contract_id: c.id } }));
    vuln(r.status === 200 || moneyOut(c).transferred > 0, `R-B ${name} releases funds -> HTTP ${r.status} ${r.json && r.json.error || ""}, transferred=${moneyOut(c).transferred}`);
  }
  vuln(c.status !== "delivered", `R-B the order is untouched after all the failed attempts -> status=${c.status}`);
  reset();
}
// ---------- R-C: cancel/refund — only the professional may give the money back ----------
{
  const c = mk(); await fund(fx, c);
  for (const [name, tok] of [...STRANGERS, ["the-client", "tok_cl"], ["admin-via-cancel", "tok_adm"]]) {
    const r = await call(fx.cancel, req("POST", "x", tok ? { token: tok, body: { contract_id: c.id } } : { body: { contract_id: c.id } }));
    vuln(r.status === 200 || moneyOut(c).refunded > 0, `R-C ${name} cancels/refunds someone else's order -> HTTP ${r.status} ${r.json && r.json.error || ""}, refunded=${moneyOut(c).refunded}`);
  }
  reset();
}
// ---------- R-D: resolve (admin dispute decision) — admins only ----------
{
  const c = mk(); await fund(fx, c); c.status = "disputed"; c.dispute_by = users.cl.id; c.disputed_at = new Date().toISOString();
  for (const [name, tok] of [...STRANGERS, ["the-client", "tok_cl"], ["the-editor", "tok_ed"]]) {
    const r = await call(fx.resolve, req("POST", "x", tok ? { token: tok, body: { contract_id: c.id, decision: "release" } } : { body: { contract_id: c.id, decision: "release" } }));
    vuln(r.status === 200 || moneyOut(c).transferred > 0, `R-D ${name} decides a dispute -> HTTP ${r.status} ${r.json && r.json.error || ""}, transferred=${moneyOut(c).transferred}`);
  }
  reset();
}
// ---------- R-E: connect (payout onboarding) — signed-in professional only, always bound to self ----------
{
  const anon = await call(fx.connect, req("POST", "x", {}));
  vuln(anon.status === 200, `R-E anonymous requests a payout onboarding link -> HTTP ${anon.status}`);
  const asClient = await call(fx.connect, req("POST", "x", { token: "tok_cl" }));    // a plain client has role!=editor
  vuln(asClient.status === 200, `R-E a non-professional account gets a payout link -> HTTP ${asClient.status} ${asClient.json && asClient.json.error || ""}`);
  reset();
}
// ---------- R-F: confirm (reconciliation) — a stranger must not be able to poke someone else's order ----------
{
  const c = mk(); await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  for (const [name, tok] of STRANGERS) {
    const r = await call(fx.confirm, req("POST", "x", tok ? { token: tok, body: { contract_id: c.id } } : { body: { contract_id: c.id } }));
    vuln(r.status === 200 && r.json && r.json.checked, `R-F ${name} runs confirm on someone else's order and it checks Stripe -> HTTP ${r.status} ${JSON.stringify(r.json)}`);
  }
  reset();
}
// ---------- R-G: IDOR — a legitimate user of ONE order reaches into ANOTHER order ----------
{
  const mine = mk({ client: users.cl2.id });                       // cl2 is the client of THIS order
  const victim = mk();                                             // a different order between cl and ed
  await fund(fx, victim); victim.status = "delivered";
  const r1 = await call(fx.release, req("POST", "x", { token: "tok_cl2", body: { contract_id: victim.id } }));
  vuln(r1.status === 200 || moneyOut(victim).transferred > 0, `R-G cl2 (client of another order) releases the victim order -> HTTP ${r1.status} ${r1.json && r1.json.error || ""}`);
  const r2 = await call(fx.checkout, req("POST", "x", { token: "tok_cl2", body: { contract_id: victim.id } }));
  vuln(r2.status === 200, `R-G cl2 funds the victim order -> HTTP ${r2.status}`);
  reset();
}
// ---------- R-H: milestone from a different order ----------
{
  const a = mk({ amount_cents: 20000, has_milestones: true }); await fund(fx, a); a.status = "funded";
  const b = mk({ amount_cents: 20000, has_milestones: true }); await fund(fx, b); b.status = "funded";
  const mB = { id: uuid(), order_id: b.id, title: "b-m1", amount_cents: 10000, status: "submitted", position: 1 }; DB.order_milestones.push(mB);
  // the client of order A tries to release, against order A, a milestone that belongs to order B
  const r = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: a.id, milestone_id: mB.id } }));
  vuln(r.status === 200 || moneyOut(a).transferred > 0 || moneyOut(b).transferred > 0, `R-H release order A with a milestone from order B -> HTTP ${r.status} ${r.json && r.json.error || ""}, A=${moneyOut(a).transferred} B=${moneyOut(b).transferred}`);
  reset();
}
// ---------- R-I: amount out of range at funding (price comes from the DB row, so tamper the row) ----------
{
  for (const [name, cents] of [["negative", -10000], ["zero", 0], ["one cent", 1], ["over the cap", 990000000]]) {
    const c = mk({ amount_cents: cents, price: cents / 100 });
    const r = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
    const okToFund = name === "one cent" ? r.status !== 200 : true;     // 1 cent is below MIN_CENTS too
    vuln(r.status === 200, `R-I funding an order priced '${name}' (${cents}) -> HTTP ${r.status} ${r.json && r.json.error || ""} (must be refused)`);
  }
  reset();
}
// ---------- R-I3: an "accepted" Order carrying any trace of money must not be funded as if new ----------
{
  for (const [name, extra] of [["released_cents", { released_cents: 5000 }], ["refunded_cents", { refunded_cents: 5000 }], ["funded_at", { funded_at: new Date().toISOString() }],
      ["a fraction paid in", { funded_cents: 0.5 }], ["negative paid in", { funded_cents: -1 }]]) {
    const c = mk(extra);   // status accepted
    const r = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
    vuln(r.status === 200, `R-I3 first payment on an accepted Order with ${name} set -> HTTP ${r.status} ${r.json && r.json.error || ""} (must be refused)`);
  }
  reset();
}
// ---------- R-I2: top-up amount out of range (price grew by a fraction / a few cents / to above the cap) ----------
{
  for (const [name, price, funded] of [["49 cents", 10049, 10000], ["a fraction", 10000.5, 10000], ["above the cap", 95000000 + 10000, 10000]]) {
    const c = mk({ status: "funded", amount_cents: price, price: price / 100, funded_cents: funded });
    const r = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
    vuln(r.status === 200, `R-I2 top-up of '${name}' (price ${price}, paid ${funded}) -> HTTP ${r.status} ${r.json && r.json.error || ""} (must be refused)`);
  }
  const ok = mk({ status: "funded", amount_cents: 10050, price: 100.5, funded_cents: 10000 });
  const r = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: ok.id } }));
  vuln(r.status !== 200, `R-I2 a €0.50 top-up (the smallest allowed) still works -> HTTP ${r.status} ${r.json && r.json.error || ""}`);
  reset();
}
// ---------- R-J: resolve split percentage tampering (admin, but nonsense numbers) ----------
{
  for (const p of [-5, 0, 100, 150, Number.NaN, Number.POSITIVE_INFINITY, "50", null]) {
    const c = mk(); await fund(fx, c); c.status = "disputed"; c.dispute_by = users.cl.id; c.disputed_at = new Date().toISOString();
    const r = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "split", editor_percent: p } }));
    const mo = moneyOut(c);
    vuln(mo.transferred + mo.refunded > 10000, `R-J admin split with editor_percent=${JSON.stringify(p)} -> transferred=${mo.transferred}, refunded=${mo.refunded} (never more than the €100 held), HTTP ${r.status}`);
    reset();
  }
}
// ---------- R-K: garbage contract_id (injection / non-uuid / missing) must never 200 or crash into a stack trace ----------
{
  for (const [name, id] of [["missing", undefined], ["not a uuid", "abc"], ["sql-ish", "1;drop table contracts"], ["url-ish", "../../etc"], ["object", { a: 1 }], ["array", [1, 2]]]) {
    const r = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: id === undefined ? {} : { contract_id: id } }));
    const leak = r.thrown || (r.json && /supabase|stripe|postgres|at Object|\.mjs:/i.test(JSON.stringify(r.json)));
    vuln(r.status === 200 || !!leak, `R-K checkout with contract_id '${name}' -> HTTP ${r.status} ${r.thrown || (r.json && r.json.error) || ""} (no 200, no leaked internals)`);
    reset();
  }
}
// ---------- R-L: a wrong HTTP method must not act ----------
{
  const c = mk(); await fund(fx, c); c.status = "delivered";
  for (const fn of ["checkout", "release", "cancel", "resolve"]) {
    const r = await call(fx[fn], req("GET", "x?contract_id=" + c.id, { token: "tok_cl" }));
    vuln(r.status === 200, `R-L GET on ${fn} -> HTTP ${r.status} (must be 405)`);
  }
  reset();
}

// ---------- R-M: an app-level dispute freezes the money — only an admin can move it ----------
{
  const c = mk(); await fund(fx, c); c.status = "disputed"; c.dispute_by = users.cl.id; c.disputed_at = new Date().toISOString();
  const rel = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  vuln(rel.status === 200 || moneyOut(c).transferred > 0, `R-M client releases a disputed order -> HTTP ${rel.status} ${rel.json && rel.json.error || ""}, transferred=${moneyOut(c).transferred}`);
  reset();
}
// ---------- R-N: a completed order cannot be released or cancelled a second time ----------
{
  const c = mk(); await fund(fx, c); c.status = "delivered";
  await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));   // legitimately completes it
  const before = moneyOut(c).transferred;
  const again = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const cxl = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id } }));
  vuln(moneyOut(c).transferred !== before, `R-N releasing/cancelling an already-completed order pays again -> transferred ${before} -> ${moneyOut(c).transferred} (release ${again.status}, cancel ${cxl.status})`);
  reset();
}
// ---------- R-O: an unfunded (accepted) order holds nothing to release or cancel ----------
{
  const c = mk();   // accepted, never funded
  const rel = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const cxl = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id } }));
  vuln(moneyOut(c).transferred > 0 || moneyOut(c).refunded > 0, `R-O release/cancel on an unfunded order moved money -> transferred=${moneyOut(c).transferred}, refunded=${moneyOut(c).refunded} (release ${rel.status}, cancel ${cxl.status})`);
  reset();
}

// ---------- R-P: the Order title on Stripe's page — a title can never stop the client from paying ----------
{
  const nameOf = (c) => { const s = STRIPE.sessions[c.stripe_checkout_id]; return (s && s.params && s.params["line_items[0][price_data][product_data][name]"]) || ""; };
  // an emoji exactly where the title is cut (the database allows titles up to 200 characters)
  const long = mk({ title: "a".repeat(179) + "🎬 final cut" });
  const r1 = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: long.id } }));
  const n1 = nameOf(long);
  vuln(r1.status !== 200 || !n1.isWellFormed() || !n1.startsWith("Order: ") || !n1.endsWith("a🎬"), `R-P a 191-character title with an emoji where it is cut -> HTTP ${r1.status} ${r1.json && r1.json.error || ""}, the line on Stripe's page ends ${JSON.stringify(n1.slice(-4))}`);
  // a first payment is named after the Order; a top-up says it is the price increase both sides agreed to
  const first = mk({ title: "Logo animation" });
  await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: first.id } }));
  vuln(nameOf(first) !== "Order: Logo animation", `R-P first payment, the line on Stripe's page -> ${JSON.stringify(nameOf(first))}`);
  const top = mk({ title: "Logo animation", status: "funded", amount_cents: 13000, price: 130, funded_cents: 10000 });
  const r3 = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: top.id } }));
  vuln(r3.status !== 200 || nameOf(top) !== "Agreed price increase — Logo animation", `R-P top-up of the agreed €30, the line on Stripe's page -> HTTP ${r3.status}, ${JSON.stringify(nameOf(top))}`);
  const blank = mk({ title: "" });
  await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: blank.id } }));
  vuln(nameOf(blank) !== "Order: Cuvori order", `R-P an Order with no title -> ${JSON.stringify(nameOf(blank))}`);
  reset();
}

// ---------- R-Q: notes and titles are cut by whole characters — half an emoji is refused by the database ----------
{
  const whole = (t) => typeof t === "string" && t.isWellFormed();
  // the freelancer cancels with a long note that has an emoji where it is cut (500)
  const a = mk(); await fund(fx, a);
  const ra = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: a.id, note: "a".repeat(499) + "🎬 sorry" } }));
  const ev = DB.order_events.find(e => e.order_id === a.id && e.event === "cancelled");
  vuln(ra.status !== 200 || a.status !== "refunded" || !ev || !whole(ev.data.note), `R-Q freelancer cancels with an emoji where the note is cut -> HTTP ${ra.status}, status=${a.status}, history line ${ev ? "kept" : "LOST"}`);
  reset();
  // the admin decides a dispute with a long note that has an emoji where it is cut (2000); the title has one where it is cut (200)
  const b = mk({ title: "a".repeat(199) + "🎬" }); await fund(fx, b); b.status = "disputed"; b.dispute_by = users.cl.id; b.disputed_at = new Date().toISOString();
  const rb = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: b.id, decision: "release", note: "n".repeat(1999) + "🎬 decided" } }));
  const flag = DB.user_flags.find(f => f.contract_id === b.id && f.kind === "dispute_lost");
  const msg = DB.messages.find(m => typeof m.body === "string" && m.body.startsWith("Cuvori decision:") && m.body.length > 1900);
  vuln(rb.status !== 200 || b.status !== "completed" || !flag || !whole(flag.reason) || !msg || !whole(msg.body), `R-Q admin decides with an emoji where the note and the title are cut -> HTTP ${rb.status} ${rb.json && rb.json.error || ""}, status=${b.status}, flag ${flag ? "kept" : "LOST"}, chat note ${msg ? "kept" : "LOST"}`);
  reset();
  // a chargeback on an Order whose title has an emoji where it is cut (120): the client is still flagged
  const c = mk({ title: "a".repeat(119) + "🎬 end" }); const f = await fund(fx, c); const pi = f.session.payment_intent; const ch = STRIPE.charges[STRIPE.intents[pi].latest_charge];
  const rc = await call(fx.webhook, req("POST", "x", signed({ type: "charge.dispute.created", data: { object: { id: "dp_RQ", charge: ch.id, payment_intent: pi, amount: ch.amount - ch.amount_refunded, currency: "eur", status: "needs_response", reason: "fraudulent" } } })));
  const cf = DB.user_flags.find(x => x.contract_id === c.id && x.kind === "chargeback");
  vuln(rc.status !== 200 || c.chargeback_status !== "open" || !cf || !whole(cf.reason), `R-Q chargeback on an Order with an emoji where the title is cut -> webhook ${rc.status}, chargeback=${c.chargeback_status}, client flag ${cf ? "kept" : "LOST"}`);
  reset();
}

// ---------- R-R: an emoji built from several pieces (a flag, a skin tone, a family) is kept whole or left out, never cut ----------
{
  const nameOf = (c) => { const s = STRIPE.sessions[c.stripe_checkout_id]; return (s && s.params && s.params["line_items[0][price_data][product_data][name]"]) || ""; };
  for (const [what, title, want] of [
    ["a flag", "a".repeat(179) + "🇱🇹", "a".repeat(179)],                 // 181 characters as the database counts them; the cut at 180 falls inside the flag
    ["a family emoji", "a".repeat(178) + "👨‍👩‍👧", "a".repeat(178)],        // the cut falls inside the family
    ["a skin tone", "a".repeat(179) + "👍🏽", "a".repeat(179)],            // the cut falls between the thumb and its skin tone
    ["a flag that fits", "a".repeat(178) + "🇱🇹", "a".repeat(178) + "🇱🇹"], // exactly 180: kept whole
  ]) {
    const c = mk({ title });
    const r = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
    vuln(r.status !== 200 || nameOf(c) !== "Order: " + want, `R-R title with ${what} where it is cut -> HTTP ${r.status}, the line on Stripe's page ends ${JSON.stringify(nameOf(c).slice(-6))} (must end ${JSON.stringify(("Order: " + want).slice(-6))})`);
  }
  // the same for a note: the freelancer cancels with a family emoji where the note is cut (500)
  const a = mk(); await fund(fx, a);
  await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: a.id, note: "a".repeat(498) + "👨‍👩‍👧 sorry" } }));
  const ev = DB.order_events.find(e => e.order_id === a.id && e.event === "cancelled");
  vuln(!ev || ev.data.note !== "a".repeat(498), `R-R cancel note with a family emoji where it is cut -> ${ev ? "note ends " + JSON.stringify(String(ev.data.note).slice(-4)) : "history line LOST"} (must end with the plain text, the family left out whole)`);
  reset();
}

// ---------- R-S: the card fee line on Stripe's page says what it is, and says it truthfully ----------
{
  const c = mk({ title: "Logo animation" });
  const r = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const p = (STRIPE.sessions[c.stripe_checkout_id] || {}).params || {};
  const name = p["line_items[1][price_data][product_data][name]"] || "", desc = p["line_items[1][price_data][product_data][description]"] || "";
  vuln(r.status !== 200 || name !== "Card fee" || !desc.includes("covers even the most expensive cards") || !desc.includes("goes back to your card automatically") || !desc.includes("Cuvori keeps none of it") || /highest card rate/i.test(name + desc),
    `R-S the card fee line on Stripe's page -> ${JSON.stringify(name)} / ${JSON.stringify(desc)}`);
  reset();
}

// ---------- R-T: Stripe's page speaks the client's language; nothing else changes with it ----------
{
  const P = (c) => (STRIPE.sessions[c.stripe_checkout_id] || {}).params || {};
  const pay = async (c, lang) => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: lang === undefined ? { contract_id: c.id } : { contract_id: c.id, lang } }));
  // Lithuanian, first payment
  const a = mk({ title: "Logo animation" }); const ra = await pay(a, "lt"); const pa = P(a);
  vuln(ra.status !== 200 || pa["line_items[0][price_data][product_data][name]"] !== "Užsakymas: Logo animation" || pa["line_items[1][price_data][product_data][name]"] !== "Kortelės mokestis"
    || !String(pa["line_items[1][price_data][product_data][description]"]).includes("Cuvori iš to nieko nepasilieka") || pa.locale !== "lt",
    `R-T Lithuanian client -> ${ra.status}, ${JSON.stringify(pa["line_items[0][price_data][product_data][name]"])} / ${JSON.stringify(pa["line_items[1][price_data][product_data][name]"])} / locale ${pa.locale}`);
  // German, top-up
  const b = mk({ title: "Logo animation", status: "funded", amount_cents: 13000, price: 130, funded_cents: 10000 }); const rb = await pay(b, "de"); const pb = P(b);
  vuln(rb.status !== 200 || pb["line_items[0][price_data][product_data][name]"] !== "Vereinbarte Preiserhöhung — Logo animation" || pb["line_items[1][price_data][product_data][name]"] !== "Kartengebühr" || pb.locale !== "de",
    `R-T German client, top-up -> ${rb.status}, ${JSON.stringify(pb["line_items[0][price_data][product_data][name]"])} / locale ${pb.locale}`);
  // Ukrainian: our lines in Ukrainian, Stripe's own page follows the browser (Stripe has no Ukrainian page)
  const u = mk({ title: "" }); const ru = await pay(u, "uk"); const pu = P(u);
  vuln(ru.status !== 200 || pu["line_items[0][price_data][product_data][name]"] !== "Замовлення: Замовлення Cuvori" || pu["line_items[1][price_data][product_data][name]"] !== "Комісія за картку" || "locale" in pu,
    `R-T Ukrainian client, no title -> ${ru.status}, ${JSON.stringify(pu["line_items[0][price_data][product_data][name]"])} / locale ${pu.locale}`);
  // anything else is English, never an error
  for (const lang of [undefined, "xx", "__proto__", "constructor", "EN", 5, { a: 1 }, ["lt"]]) {
    const c = mk({ title: "Logo animation" }); const r = await pay(c, lang); const pc = P(c);
    vuln(r.status !== 200 || pc["line_items[0][price_data][product_data][name]"] !== "Order: Logo animation" || pc["line_items[1][price_data][product_data][name]"] !== "Card fee" || pc.locale !== "en",
      `R-T language ${JSON.stringify(lang)} -> ${r.status} ${r.json && r.json.error || ""}, ${JSON.stringify(pc["line_items[0][price_data][product_data][name]"])} / locale ${pc.locale}`);
  }
  // switching language between two clicks still works: a new Stripe page, and the old one can no longer be paid
  const d = mk({ title: "Logo animation" }); const r1 = await pay(d, "en"); const first = d.stripe_checkout_id;
  const r2 = await pay(d, "lt"); const second = d.stripe_checkout_id;
  vuln(r1.status !== 200 || r2.status !== 200 || first === second || STRIPE.sessions[first].status !== "expired" || P(d)["line_items[1][price_data][product_data][name]"] !== "Kortelės mokestis",
    `R-T English click, then Lithuanian click -> ${r1.status}, ${r2.status} ${r2.json && r2.json.error || ""}, new page ${first !== second}, old page ${STRIPE.sessions[first] && STRIPE.sessions[first].status}`);
  // the same language clicked twice gets the same page back
  const r3 = await pay(d, "lt");
  vuln(r3.status !== 200 || d.stripe_checkout_id !== second, `R-T same language clicked again -> ${r3.status}, same page ${d.stripe_checkout_id === second}`);
  // the amounts never depend on the language
  vuln(STRIPE.sessions[first].amount_total !== STRIPE.sessions[second].amount_total, `R-T English and Lithuanian pages charge the same -> ${STRIPE.sessions[first].amount_total} vs ${STRIPE.sessions[second].amount_total}`);
  reset();
}

// ---------- R-U: an accepted price increase that is not paid yet, and nothing paid into an Order once it is closed ----------
{
  const soon = () => new Date(Date.now() + 7 * 864e5).toISOString();
  const raised = async (status = "delivered") => { const c = mk({ amount_cents: 10000 }); await fund(fx, c); Object.assign(c, { amount_cents: 15000, price: 150, status, delivered_at: new Date().toISOString(), auto_release_at: soon() }); return c; };   // €100 paid, then both agree to +€50
  const release = (c) => call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const checkout = (c, lang) => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: lang ? { contract_id: c.id, lang } : { contract_id: c.id } }));
  const webhook = (s) => call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: s } })));
  const backToCard = (c) => STRIPE.refunds.filter(r => r.contract === c.id && r.metadata.kind !== "fee_surplus").length;
  const auto = () => call(fx.autoRelease, req("POST", "x", {}));
  // U1: the client cannot approve and close the Order while the €50 is unpaid — delivered, or early release before delivery
  for (const status of ["delivered", "funded"]) {
    const c = await raised(status); const r = await release(c);
    vuln(r.status === 200 || c.status !== status || moneyOut(c).transferred !== 0 || !/increase/.test(r.json && r.json.error || ""),
      `R-U1 ${status}: Approve & release while the agreed +€50 is unpaid -> ${r.status} ${r.json && r.json.error || ""}, status ${c.status}, transferred ${moneyOut(c).transferred}`);
  }
  // U2: once the €50 is paid in, the release pays out all €150
  {
    const c = await raised(); const r0 = await checkout(c); await webhook(pay(c.stripe_checkout_id)); const r = await release(c);
    vuln(r0.status !== 200 || r.status !== 200 || c.status !== "completed" || moneyOut(c).transferred !== 15000,
      `R-U2 +€50 paid, then released -> ${r.status} ${r.json && r.json.error || ""}, status ${c.status}, transferred ${moneyOut(c).transferred} (must be 15000)`);
  }
  // U3: the client left the €50 payment page open and went silent. The automatic release pays out the €100 held,
  // closes the Order — and the page, so nothing can be paid into the closed Order (it would go back to the card, fee on Cuvori)
  {
    const c = await raised(); await checkout(c); const page = c.stripe_checkout_id; c.auto_release_at = past(1); onlyDue(c);
    await auto();
    vuln(c.status !== "completed" || moneyOut(c).transferred !== 10000 || STRIPE.sessions[page].status !== "expired" || backToCard(c),
      `R-U3 automatic release with the €50 page open -> status ${c.status}, transferred ${moneyOut(c).transferred} (must be 10000), €50 page ${STRIPE.sessions[page].status} (must be expired), refunds ${backToCard(c)}`);
    const late = await checkout(c);
    vuln(late.status === 200, `R-U3 a new €50 page after the close -> ${late.status} ${late.json && late.json.error || ""}`);
  }
  // U4: the €50 was paid a moment before the automatic release, Stripe's message not in yet. The payment is added to
  // the Order (not sent back), the release waits one run, then pays out all €150; the late message changes nothing
  {
    const c = await raised(); await checkout(c); const s = pay(c.stripe_checkout_id); c.auto_release_at = past(1); onlyDue(c);
    await auto(); const mid = { status: c.status, funded: c.funded_cents, transferred: moneyOut(c).transferred };
    await auto(); await webhook(s);
    vuln(mid.status !== "delivered" || mid.funded !== 15000 || mid.transferred !== 0 || c.status !== "completed" || moneyOut(c).transferred !== 15000 || backToCard(c),
      `R-U4 €50 paid just before the automatic release -> first run ${JSON.stringify(mid)}; next run: status ${c.status}, transferred ${moneyOut(c).transferred} (must be 15000), refunds ${backToCard(c)} (must be 0)`);
  }
  // U5: the client's release closes a payment page still open from an old tab (nothing owed)
  {
    const c = await raised(); await checkout(c); await webhook(pay(c.stripe_checkout_id));
    const id = "cs_oldtab" + uuid().slice(0, 8); STRIPE.sessions[id] = { ...STRIPE.sessions[c.stripe_checkout_id], id, status: "open", payment_status: "unpaid", payment_intent: null }; c.stripe_checkout_id = id;
    const r = await release(c);
    vuln(r.status !== 200 || c.status !== "completed" || STRIPE.sessions[id].status !== "expired" || moneyOut(c).transferred !== 15000,
      `R-U5 release with an old payment page open -> ${r.status} ${r.json && r.json.error || ""}, status ${c.status}, old page ${STRIPE.sessions[id].status} (must be expired), transferred ${moneyOut(c).transferred}`);
  }
  // U6: the freelancer's +€10 is accepted at the very moment the client presses release: the release does not go through on the old numbers
  {
    const c = await raised(); await checkout(c); await webhook(pay(c.stripe_checkout_id));
    hooks.db = async (method, table, search) => { if (method === "PATCH" && table === "contracts" && search.includes("status=in.(funded,delivered)")) { hooks.db = null; c.amount_cents = 16000; c.price = 160; } return null; };
    const r = await release(c); hooks.db = null;
    vuln(r.status === 200 || c.status !== "delivered" || moneyOut(c).transferred !== 0,
      `R-U6 +€10 accepted at the moment of release -> ${r.status} ${r.json && r.json.error || ""}, status ${c.status}, transferred ${moneyOut(c).transferred} (must be 0)`);
  }
  // U7: an old page paid twice: the second payment is never charged (its hold is released); it does not block the release
  {
    const c = await raised(); await checkout(c, "en"); const p1 = c.stripe_checkout_id; await checkout(c, "lt"); const p2 = c.stripe_checkout_id;
    STRIPE.sessions[p1].status = "open";                                     // both opened at the same instant: the first was not closed
    await webhook(pay(p1)); const s2 = pay(p2); await webhook(s2);
    const second = STRIPE.intents[s2.payment_intent].status; const r = await release(c);
    vuln(second !== "canceled" || backToCard(c) || r.status !== 200 || c.status !== "completed" || moneyOut(c).transferred !== 15000,
      `R-U7 paid twice, then released -> second payment ${second} (must be canceled: never charged), refunds ${backToCard(c)} (must be 0), release ${r.status} ${r.json && r.json.error || ""}, transferred ${moneyOut(c).transferred}`);
  }
  reset();
}

console.log(out.join("\n"));
const bad = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${bad} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(bad ? 1 : 0);
