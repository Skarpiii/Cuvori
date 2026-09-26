// Role & tampering attack suite: call every payment function as the WRONG person, and with tampered
// inputs, and prove nothing moves. Roles: anonymous (no token), the order's client (tok_cl), the order's
// professional/editor (tok_ed), an admin (tok_adm), a stranger client (tok_cl2), a second professional not
// on the order (tok_ed2). "safe" = the attempt was refused and no money moved; "VULNERABLE" = it got through.
import { DB, STRIPE, users, req, call, mk, moneyOut, reset, fns, fund, pay, uuid } from "./fn-harness.mjs";
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

console.log(out.join("\n"));
const bad = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${bad} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(bad ? 1 : 0);
