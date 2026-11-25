// Check of 25 November 2026 (the calendar date: the labels of some earlier checks, "26 November" to "14 December", ran
// ahead of the calendar). The hourly job (netlify/functions/stripe-auto-release.mjs) and an Order handed in whose price
// increase both sides accepted is not paid in yet. Such an Order is not paid out automatically (closing it would drop the
// increase for good), but it waited in silence: no note for the admin, and the Order kept its payout date, gone by. Since
// v56 an Order handed in whose price goes up is back to being worked on, so this is an Order from before v56 (on the live
// database today a price increase can still be accepted after the work was handed in).
// I1 it says so: a note on the Order under "Needs a hand" ("Money step stopped (automatic payout): …"), and a log line;
//    for an Order from before v56, at today's prices (plan 1) and at the new prices (plan 2).
// I2 written once: the next hour costs no write to the database.
// I3 the client pays the increase: the next hour pays out all of it and the note goes.
// I4 Cuvori decides the Order, or the freelancer cancels it: the note goes with the settlement.
// I5 the increase's payment came in a moment ago (Stripe's notice not in yet): it is counted, no "waits" note is written,
//    and the next hour pays out all of it.
// I6 what stays: an Order whose review period is not over says nothing yet; one without an increase is paid out as before;
//    the admin marks the note as handled while the increase is still unpaid: it comes back the next hour.
// Run: node tests/attack-check-nov25.mjs   (TARGET=<folder> checks another copy)
const H = await import("./fn-harness.mjs");
const { DB, STRIPE, V56, users, hooks, mk, fns, fund, past, call, req, pay } = H;
V56.on = true;
const fx = await fns();
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const logs = []; const realError = console.error; console.error = (...a) => logs.push(a.map(String).join(" "));
const run = async () => (await fx.autoRelease()).json();
const paid = (c) => STRIPE.transfers.filter(t => t.contract === c.id).reduce((a, t) => a + t.amount, 0);
const ready = () => { STRIPE.accounts.acct_1EditorAAAAAAAA.payouts_enabled = true; DB.payout_details.find(p => p.id === users.ed.id).stripe_payouts_enabled = true; };
const isolate = () => { for (const c of DB.contracts) c.status = "completed"; for (const m of DB.order_milestones) m.status = "released"; hooks.db = null; hooks.stripe = null; ready(); };
const KINDS = [
  ["before v56", (o = {}) => mk({ ...o })],
  ["plan 1", (o = {}) => mk({ pricing_version: 1, commission_bps: 0, commission_cents: 0, auto_days: 7, ...o })],
  ["plan 2", (o = {}) => mk({ pricing_version: 2, commission_bps: 500, commission_cents: 0, auto_days: 14, ...o })]];
const WAITS = "Money step stopped (automatic payout): ";
const INCREASE = /price increase both sides accepted is not paid in yet/;
const waitsNote = (c) => String(c.money_error || "").split(" · Also: ").filter(n => n.startsWith(WAITS) && INCREASE.test(n));
const show = (c) => `Order ${c.status}, paid out ${paid(c)}, note ${c.money_error ? JSON.stringify(String(c.money_error).slice(0, 150)) : "NONE"}`;
// paid 100.00, then an increase of 20.00 both sides accepted, not paid in; handed in, the review period over h hours ago
async function owing(mkX, h = 2) {
  const c = mkX({ amount_cents: 10000 });
  const f = await fund(fx, c);
  if (c.status !== "funded") throw new Error("funding failed: " + JSON.stringify(f.checkout || f.webhook));
  c.amount_cents += 2000; c.price = c.amount_cents / 100;
  c.status = "delivered"; c.delivered_at = past(h + 24 * 14); c.auto_release_at = past(h);
  return c;
}
const guard = async (name, fn) => { try { await fn(); } catch (e) { out.push(`VULNERABLE ${name}: the check itself stopped: ${e.message}`); } };

for (const [kind, mkX] of KINDS) {
  // ===== I1–I3 =====
  await guard(`I1 [${kind}]`, async () => {
    isolate();
    const c = await owing(mkX);
    const due = c.auto_release_at;
    await run();
    const n1 = waitsNote(c), s1 = show(c), logged = logs.filter(l => l.includes(c.id) && /waits/.test(l)).length;
    vuln(!(c.status === "delivered" && paid(c) === 0 && n1.length === 1 && logged > 0),
      `I1 [${kind}] handed in, review period over, accepted increase of 20.00 not paid in -> ${s1}; log lines ${logged} (must: nothing paid out, the Order still handed in, one note saying the automatic payout waits for the price increase, a log line)`);
    // I2: written once
    let writes = 0;
    hooks.db = async (method, table, search) => { if (method === "PATCH" && table === "contracts" && String(search).includes(c.id)) writes++; return null; };
    await run(); hooks.db = null;
    vuln(!(waitsNote(c).length === 1 && writes === 0 && c.status === "delivered"),
      `I2 [${kind}] the next hour, still not paid -> notes ${waitsNote(c).length}, writes to the Order ${writes} (must: the same one note, no write)`);
    // I3: the client pays the increase
    const t = await fund(fx, c);
    const funded = c.funded_cents;
    await run();
    const whole = kind === "plan 2" ? 12000 - Math.floor((12000 * 500 + 5000) / 10000) : 12000;
    vuln(!(funded === 12000 && c.status === "completed" && paid(c) === whole && waitsNote(c).length === 0 && !c.money_error),
      `I3 [${kind}] the client pays the 20.00 (${t.webhook ? t.webhook.status : JSON.stringify(t.checkout)}), paid in ${funded}; the next hour -> ${show(c)} (must: completed, the freelancer gets ${whole}, the note gone)`);
    void due;
  });

  // ===== I4: a decision, or the freelancer's cancel, takes the note with it =====
  for (const how of ["Cuvori decides 'release'", "the freelancer cancels"]) {
    await guard(`I4 [${kind}] ${how}`, async () => {
      isolate();
      const c = await owing(mkX);
      await run();
      const before = waitsNote(c).length;
      let r;
      if (how.startsWith("Cuvori")) {
        c.status = "disputed"; c.disputed_at = past(1); c.dispute_by = users.ed.id; c.dispute_reason = "the client does not pay the increase";
        r = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "release", note: "released what is held; the increase was never paid" } }));
      } else r = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id } }));
      vuln(!(before === 1 && r.status === 200 && ["completed", "refunded"].includes(c.status) && waitsNote(c).length === 0),
        `I4 [${kind}] note written (${before}), then ${how} -> ${r.status}, ${show(c)} (must: settled, the note gone)`);
    });
  }

  // ===== I5: the increase was paid a moment ago, Stripe's notice not in yet =====
  await guard(`I5 [${kind}]`, async () => {
    isolate();
    const c = await owing(mkX);
    const r0 = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
    if (r0.status !== 200) throw new Error("the increase's payment page: " + r0.status + " " + JSON.stringify(r0.json));
    pay(c.stripe_checkout_id);                                   // paid at Stripe; the notice never comes
    await run();
    const n = waitsNote(c).length, f = c.funded_cents, st = c.status;
    await run();
    const whole = kind === "plan 2" ? 12000 - Math.floor((12000 * 500 + 5000) / 10000) : 12000;
    vuln(!(n === 0 && f === 12000 && st === "delivered" && c.status === "completed" && paid(c) === whole),
      `I5 [${kind}] the increase paid a moment ago, its notice not in -> first hour: paid in ${f}, Order ${st}, "waits" notes ${n}; next hour: ${show(c)} (must: counted, no note, then all of it paid out)`);
  });

  // ===== I6: what stays =====
  await guard(`I6 [${kind}]`, async () => {
    isolate();
    const notDue = await owing(mkX); notDue.auto_release_at = new Date(Date.now() + 86400e3).toISOString();
    const plain = mkX({ amount_cents: 10000 }); await fund(fx, plain); plain.status = "delivered"; plain.delivered_at = past(400); plain.auto_release_at = past(2);
    await run();
    const whole = kind === "plan 2" ? 10000 - 500 : 10000;
    vuln(!(notDue.status === "delivered" && !notDue.money_error && plain.status === "completed" && paid(plain) === whole && !plain.money_error),
      `I6 [${kind}] review period not over yet -> ${show(notDue)}; no increase -> ${show(plain)} (must: the first says nothing yet, the second is paid ${whole} as before)`);
    // marked as handled while still unpaid: back the next hour
    const c = await owing(mkX);
    await run();
    const had = waitsNote(c).length;
    c.money_error = null;                                          // the admin's "Mark as handled"
    await run();
    vuln(!(had === 1 && waitsNote(c).length === 1 && paid(c) === 0),
      `I6b [${kind}] the note marked as handled while the increase is still unpaid -> note before ${had}, the next hour ${waitsNote(c).length}, paid out ${paid(c)} (must: back, nothing paid)`);
  });
}

hooks.db = null; hooks.stripe = null; console.error = realError;
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
