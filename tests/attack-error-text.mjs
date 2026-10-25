// What a failed Stripe or database call leaves behind. The client and the freelancer on an Order can read its note (the
// database lets them read every column of their Order, and the page loads them all), and the Netlify log keeps whatever
// is written into it. So:
//  - a key in Netlify that holds a space, a line break or another character that is not part of a key is never sent.
//    Node refuses to send such a header and puts the whole header, the key with it, into its error text. Payments (or the
//    database) pause instead, the log says why with the key's first 3 characters only, and the admin panel says so;
//  - an Order's note never carries Stripe's own text, which can show the end of Cuvori's key and name Cuvori's Stripe
//    account: it says in plain words what went wrong, with the ref under which the Netlify log has Stripe's full text.
//    Cuvori's own sentences (the money is still settling, the account is not ready, Stripe did not answer) stay as they are;
//  - when Stripe can't be reached, the log says why (no answer in time, or the connection's error code), never Node's text.
// K1–K4 the Stripe key, S1–S2 the Supabase key, N1–N6 the notes on Orders, R1–R3 the reason in the log, P1 the admin panel.
// S3–S4, P2: a database key that can't be used answered every button with an English sentence and no code ("Database access
// is not configured"), and the admin panel still said "ON". Now every answer says "payments paused" with the code the page
// translates (the admin reads which setting to correct), stripe-status says the key can't be used (never the key), and the
// admin panel says "ON, but paused" and names the setting, as it does for the Stripe key.
// Run: node tests/attack-error-text.mjs
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const PERMISSION = "The provided key 'rk_test_********************fake' does not have the required permissions for this endpoint on account 'acct_1CuvoriPlatformAA'. Having the 'rak_transfer_write' permission would allow this request to continue.";
const STRIPE_WORDS = /rk_test_|sk_test_|acct_1CuvoriPlatformAA|required permissions|rak_transfer_write|Bearer/;

// ---------- the child: one key set in Netlify, read once when the functions start (as on Netlify) ----------
if (process.env.ERRTEXT_CHILD) {
  const logs = [];
  for (const k of ["error", "warn", "log", "info"]) console[k] = (...a) => logs.push(a.map(x => (x && x.stack) || String(x)).join(" "));
  const H = await import("./fn-harness.mjs");
  // an older service key with something wrong in it (the shared fakes always set a working one)
  if (process.env.SUPABASE_SERVICE_ROLE_KEY_OVERRIDE) process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY_OVERRIDE;
  const { DB, req, call, signed, mk, past, users } = H;
  // what real fetch does before anything leaves: a header value it can't send is refused, with the header in the error
  const sent = { stripe: 0, supabase: 0 };
  const f0 = globalThis.fetch;
  globalThis.fetch = async (u, init = {}) => {
    new Headers(init.headers || {});
    if (new URL(String(u)).hostname === "api.stripe.com") sent.stripe++; else sent.supabase++;
    return f0(u, init);
  };
  const lib = await import(H.F + "../lib/cuvori.mjs"); const fx = await H.fns();
  const out = { answers: {}, sent, logs };
  const status = await call(fx.status, req("GET", "x"));
  out.keyOk = status.json && status.json.stripeKeyOk;
  out.dbKeyOk = status.json && status.json.databaseKeyOk;
  try { out.mode = lib.acctCols().mode; } catch (e) { out.mode = e.code || e.message; }
  if (process.env.ERRTEXT_GOOD) {
    try { await lib.stripe("GET", "/accounts/acct_1EditorAAAAAAAA"); out.call = "answered"; } catch (e) { out.call = e.message; }
    try { await lib.db.one("site_settings", "key=eq.stripe_mode&select=value"); out.db = "answered"; } catch (e) { out.db = e.message; }
  } else {
    const paid = { funded_cents: 10000, funded_at: past(48), stripe_payment_intent: "pi_ErrTextPaid1", stripe_charge_id: "ch_ErrTextPaid1", paid_mode: "test" };
    const fresh = mk(), done = mk({ status: "delivered", ...paid }), funded = mk({ status: "funded", ...paid }), disputed = mk({ status: "disputed", ...paid });
    mk({ status: "delivered", ...paid, auto_release_at: past(2) });
    const steps = {
      fund: () => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: fresh.id } })),
      release: () => call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: done.id } })),
      cancel: () => call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: funded.id } })),
      decision: () => call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: disputed.id, decision: "refund" } })),
      payoutDetails: () => call(fx.connect, req("GET", "x", { token: "tok_ed" })),
      hourly: () => call(fx.autoRelease, req("POST", "x", {})),
      webhookPayment: () => call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: { id: "cs_ErrTextPage1", object: "checkout.session", client_reference_id: fresh.id, mode: "payment", status: "complete", payment_status: "paid", payment_intent: "pi_ErrTextLate1", amount_total: 10000, currency: "eur", metadata: { contract_id: fresh.id, amount_cents: "10000", fee_cents: "0", kind: "fund" } } } }))),
      webhookAccount: () => call(fx.webhook, req("POST", "x", signed({ type: "account.updated", data: { object: { id: "acct_1EditorAAAAAAAA", object: "account" } } }))),
    };
    for (const [name, run] of Object.entries(steps)) out.answers[name] = await run();
    out.notes = DB.contracts.map(c => c.money_error).filter(Boolean);
    out.users = Object.keys(users).length;
  }
  process.stdout.write("@@RESULT@@" + JSON.stringify(out));
  process.exit(0);
}

const child = (env) => {
  const text = execFileSync(process.execPath, [SELF], { env: { ...process.env, ERRTEXT_CHILD: "1", ...env }, encoding: "utf8", maxBuffer: 64 << 20 });
  return JSON.parse(text.slice(text.indexOf("@@RESULT@@") + 10));
};
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const shown = (s, n = 140) => JSON.stringify(s).slice(0, n);

// ---------- K1–K4: a Stripe key with something in it that is not part of a key ----------
for (const [what, key] of [
  ["a line break inside it", "sk_test_FRONTPART\nSECRETPART"],
  ["a Windows line break inside it (live key)", "sk_live_FRONTPART\r\nSECRETPART"],
  ["a space inside it", "sk_test_FRONTPART SECRETPART"],
  ["a tab inside it (restricted key)", "rk_test_FRONTPART\tSECRETPART"],
  ["an invisible zero-width space inside it", "sk_test_FRONTPART​SECRETPART"],
  ["a Cyrillic letter that looks like a Latin one", "sk_test_FRONTPARTаSECRETPART"],
]) {
  const r = child({ HARNESS_STRIPE_KEY: key });
  const all = JSON.stringify(r);
  const keyLine = r.logs.find(l => /STRIPE_SECRET_KEY/.test(l) && /not part of a Stripe key/.test(l)) || "";
  const a = r.answers;
  vuln(r.sent.stripe !== 0, `K1 key with ${what}: requests sent to Stripe -> ${r.sent.stripe} (must be 0: such a key is never sent)`);
  vuln(/FRONTPART|SECRETPART/.test(all), `K2 key with ${what}: the key anywhere in the answers, the notes, the hourly job's answer or the Netlify log -> ${/FRONTPART|SECRETPART/.test(all) ? shown(all.match(/.{0,60}(FRONTPART|SECRETPART).{0,30}/)[0]) : "nowhere"} (must be nowhere)`);
  vuln(r.keyOk !== false || r.mode !== "payments_paused", `K3 key with ${what}: the admin panel's key check -> stripeKeyOk ${r.keyOk}, Payout details ${r.mode} (must say the key can't be used, payments paused)`);
  vuln(!keyLine || !keyLine.includes(`"${key.slice(0, 3)}"`), `K4 key with ${what}: the Netlify log says why -> ${shown(keyLine || "(nothing)")} (must name the problem and the key's first 3 characters only)`);
  vuln(a.fund.status !== 503 || (a.fund.json && a.fund.json.code) !== "payments_paused" || !/not part of a Stripe key/.test(a.fund.json && a.fund.json.error || "")
       || ["release", "cancel", "decision", "payoutDetails", "webhookPayment", "webhookAccount"].some(s => a[s].status < 500),
    `K4 key with ${what}: the answers -> Fund ${a.fund.status} ${a.fund.json && a.fund.json.code}, release ${a.release.status}, cancel ${a.cancel.status}, decision ${a.decision.status}, Payout details ${a.payoutDetails.status}, payment notice ${a.webhookPayment.status}, account notice ${a.webhookAccount.status} (Fund must say payments are paused and why; nothing may go through; a notice must fail so Stripe sends it again)`);
}
for (const [what, key, mode] of [["a test secret key", "sk_test_fake", "test"], ["a test restricted key", "rk_test_fake", "test"], ["a live secret key", "sk_live_fake", "live"], ["a live restricted key", "rk_live_fake", "live"]]) {
  const r = child({ HARNESS_STRIPE_KEY: key, ERRTEXT_GOOD: "1" });
  const noisy = r.logs.find(l => /not part of a|not a Stripe secret key/.test(l));
  vuln(r.keyOk !== true || r.mode !== mode || (mode === "test" && (r.call !== "answered" || r.sent.stripe === 0)) || noisy,
    `K5 ${what} still works -> key check ${r.keyOk}, mode ${r.mode}${mode === "test" ? `, a Stripe call ${r.call} (${r.sent.stripe} sent)` : ""}, log about the key: ${noisy ? shown(noisy) : "none"}`);
}

// ---------- S1–S2: the Supabase key ----------
{
  const r = child({ SUPABASE_SECRET_KEY: "sb_secret_FRONTPART\nSECRETPART" });
  const all = JSON.stringify(r);
  const keyLine = r.logs.find(l => /SUPABASE_SECRET_KEY/.test(l) && /not part of a Supabase key/.test(l)) || "";
  vuln(r.sent.supabase !== 0 || /FRONTPART|SECRETPART/.test(all) || !keyLine.includes('"sb_"') || Object.values(r.answers).some(x => x.status < 500),
    `S1 Supabase key with a line break inside it -> requests sent to Supabase ${r.sent.supabase} (must be 0), the key anywhere: ${/FRONTPART|SECRETPART/.test(all) ? shown(all.match(/.{0,60}(FRONTPART|SECRETPART).{0,30}/)[0]) : "nowhere"}, log: ${shown(keyLine || "(nothing)")}, answers ${Object.values(r.answers).map(x => x.status).join(" ")}`);
  for (const [what, key] of [["a new secret key", "sb_secret_Ab12Cd34Ef56_gh-78"], ["an older service key (a JWT)", "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.Abc-_dEf09"]]) {
    const g = child({ SUPABASE_SECRET_KEY: key, ERRTEXT_GOOD: "1" });
    vuln(g.db !== "answered" || g.sent.supabase === 0 || g.logs.some(l => /not part of a Supabase key/.test(l)) || g.dbKeyOk !== true, `S2 ${what} still works -> database ${g.db} (${g.sent.supabase} sent), the admin panel's key check ${g.dbKeyOk}`);
  }
}
// ---------- S3–S4: what a database key that can't be used tells the person, and the admin ----------
for (const [what, key] of [["a line break inside it", "sb_secret_FRONTPART\nSECRETPART"], ["an invisible zero-width space inside it", "sb_secret_FRONTPART\u200bSECRETPART"], ["a space inside it (an older service key)", "eyJhbGciOiJIUzI1NiJ9.FRONTPART SECRETPART"]]) {
  const r = child(key.startsWith("eyJ") ? { SUPABASE_SECRET_KEY: "", SUPABASE_SERVICE_ROLE_KEY_OVERRIDE: key } : { SUPABASE_SECRET_KEY: key });
  const people = ["fund", "release", "cancel", "decision", "payoutDetails"].map(n => [n, r.answers[n]]);
  const wrong = people.filter(([, a]) => !a || a.status !== 503 || !a.json || a.json.code !== "payments_paused" || !/SUPABASE_(SECRET|SERVICE_ROLE)_KEY/.test(a.json.error || "") || /FRONTPART|SECRETPART/.test(JSON.stringify(a.json)));
  vuln(wrong.length > 0, `S3 database key with ${what}: every button's answer -> ${wrong.length ? wrong.map(([n, a]) => `${n} ${a && a.status} ${shown(a && a.json, 120)}`).join("; ") : "503, payments_paused, the setting named"} (each must be 503 with the code payments_paused, naming the setting, never the key)`);
  vuln(r.dbKeyOk !== false || /FRONTPART|SECRETPART/.test(JSON.stringify(r.dbKeyOk)), `S4 database key with ${what}: stripe-status tells the admin panel -> databaseKeyOk ${r.dbKeyOk} (must be false, never the key)`);
}

// ---------- N1–N6: notes on Orders (one process, a normal key) ----------
const logged = [];
console.error = (...a) => logged.push(a.map(x => (x && x.stack) || String(x)).join(" "));
const H = await import("./fn-harness.mjs");
const { DB, STRIPE, hooks, req, call, signed, mk, moneyOut, reset, onlyDue, fund, uuid } = H;
const lib = await import(H.F + "../lib/cuvori.mjs");
const fx = await H.fns();
const refOf = (note) => (String(note || "").match(/\(Netlify log ref ([0-9a-f]{8})\)$/) || [])[1];
const inLog = (note, text) => { const ref = refOf(note); return !!ref && logged.some(l => l.includes(ref) && l.includes(text)); };
const refuseAt = (re) => { hooks.stripe = async (path, method) => (method === "POST" && re.test(path) ? [403, { error: { message: PERMISSION, type: "invalid_request_error" } }] : null); };
const chargeOf = (pi) => STRIPE.charges[STRIPE.intents[pi].latest_charge];
const cbEvent = (type, ch, status) => signed({ type, data: { object: { id: "dp_" + ch.id, object: "dispute", charge: ch.id, payment_intent: ch.payment_intent, amount: ch.amount, status } } });
const MISSING = "Cuvori's Stripe key is missing a permission";
const plain = (note, start) => String(note || "") === `${start}${MISSING} (Netlify log ref ${refOf(note)})` && !STRIPE_WORDS.test(note) && inLog(note, "required permissions");

{ // N1 the client's release (settlement): Stripe refuses the payout
  const c = mk(); await fund(fx, c); c.status = "delivered";
  refuseAt(/^\/transfers$/);
  const r = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  vuln(!plain(c.money_error, "Money step stopped (settlement): ") || (r.json && r.json.ref) !== refOf(c.money_error),
    `N1 the client's release, Stripe refuses the payout -> ${r.status} ${shown(r.json, 80)}; note the client and freelancer can read: ${shown(c.money_error)} (must be plain words with a log ref, the same ref as the answer; Stripe's text only in the log)`);
  reset(); onlyDue(c);
  c.resolved_at = new Date(Date.parse(c.resolved_at) - 11 * 60e3).toISOString();         // the hourly job takes up releases stuck for over 10 minutes
  await call(fx.autoRelease, req("POST", "x", {}));
  vuln(c.status !== "completed" || c.money_error || moneyOut(c).transferred !== 10000, `N1 once the key may pay out, the hourly job finishes it -> Order ${c.status}, paid out ${moneyOut(c).transferred}, note gone: ${!c.money_error}`);
}
{ // N2 a milestone payout
  const c = mk({ amount_cents: 20000, has_milestones: true }); await fund(fx, c); c.status = "funded";
  const m = { id: uuid(), order_id: c.id, title: "Part 1", amount_cents: 10000, status: "submitted", position: 1 };
  DB.order_milestones.push(m, { id: uuid(), order_id: c.id, title: "Part 2", amount_cents: 10000, status: "pending", position: 2 });
  refuseAt(/^\/transfers$/);
  const r = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, milestone_id: m.id } }));
  vuln(!plain(c.money_error, `Money step stopped (milestone ${m.id}): `), `N2 a milestone payout, Stripe refuses it -> ${r.status}; note: ${shown(c.money_error)} (must be plain words with a log ref)`);
  reset();
  const again = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, milestone_id: m.id } }));
  vuln(again.status !== 200 || c.released_cents !== 10000 || c.money_error, `N2 once fixed, the milestone is paid out -> ${again.status}, released ${c.released_cents}, note gone: ${!c.money_error}`);
}
{ // N3 a chargeback after the payout: pulling the money back is refused; N4 the bank sides with Cuvori: paying again is refused
  const c = mk(); const f = await fund(fx, c); c.status = "delivered";
  await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const ch = chargeOf(f.session.payment_intent); STRIPE.disputes[ch.id] = { status: "needs_response" };
  refuseAt(/\/reversals$/);
  const w = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.created", ch, "needs_response")));
  vuln(!plain(c.money_error, "chargeback: "), `N3 a chargeback after the payout, pulling it back is refused -> notice ${w.status}; note: ${shown(c.money_error)} (must be "chargeback: " + plain words with a log ref)`);
  reset(); onlyDue(c); await call(fx.autoRelease, req("POST", "x", {}));
  vuln(moneyOut(c).transferred !== 0 || c.money_error, `N3 once fixed, the hourly job pulls it back -> the freelancer keeps ${moneyOut(c).transferred} (must be 0), note gone: ${!c.money_error}`);
  STRIPE.disputes[ch.id].status = "won";
  refuseAt(/^\/transfers$/);
  const won = await call(fx.webhook, req("POST", "x", cbEvent("charge.dispute.closed", ch, "won")));
  vuln(!plain(c.money_error, "chargeback won, re-payment failed: "), `N4 the bank sides with Cuvori, paying the freelancer again is refused -> notice ${won.status}; note: ${shown(c.money_error)} (must be "chargeback won, re-payment failed: " + plain words with a log ref)`);
  reset(); onlyDue(c); await call(fx.autoRelease, req("POST", "x", {}));
  vuln(moneyOut(c).transferred !== 10000 || c.money_error, `N4 once fixed, the hourly job pays the freelancer again -> paid ${moneyOut(c).transferred} (must be 10000), note gone: ${!c.money_error}`);
}
{ // N5 Cuvori's own sentences stay as they are
  for (const [what, answer, want] of [
    ["the money is still settling", [400, { error: { code: "balance_insufficient", message: "You have insufficient available funds in your Stripe account.", type: "invalid_request_error" } }], "The card payment is still settling at the payment provider. Cuvori retries this every hour; nothing needs to be done."],
    ["the freelancer's account can't take payouts", [400, { error: { message: "No such destination: 'acct_1EditorAAAAAAAA'", type: "invalid_request_error" } }], "The freelancer's Stripe account is not ready to receive money. Once they finish their Stripe setup, Cuvori retries this every hour."],
  ]) {
    const c = mk(); await fund(fx, c); c.status = "delivered";
    hooks.stripe = async (path, method) => (method === "POST" && path === "/transfers" ? answer : null);
    await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
    vuln(c.money_error !== `Money step stopped (settlement): ${want}`, `N5 ${what} -> note: ${shown(c.money_error)} (Cuvori's own sentence, as before, under the step's heading)`);
    reset();
  }
  const c = mk(); await fund(fx, c); c.status = "delivered";
  hooks.stripe = async (path, method) => { if (method === "POST" && path === "/transfers") throw new TypeError("fetch failed"); return null; };
  await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  vuln(c.money_error !== "Money step stopped (settlement): The payment provider did not answer. Nothing was lost — please try again in a minute.", `N6 Stripe does not answer a payout -> note: ${shown(c.money_error)} (Cuvori's own sentence, as before, under the step's heading)`);
  reset();
}

// ---------- R1–R3: why Stripe could not be reached, in the log, never Node's own text ----------
for (const [what, thrown, want, never] of [
  ["the connection is refused", () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 10.0.3.7:443"), { code: "ECONNREFUSED" }) }), /ECONNREFUSED/, /fetch failed/],
  ["no answer within 8 seconds", () => new DOMException("The operation was aborted due to timeout", "TimeoutError"), /8 seconds/, /aborted/],
  ["Node refuses to send a header", () => new TypeError('Headers.append: "Bearer sk_test_fake" is an invalid header value.'), /could not be sent/, /Bearer|sk_test_fake|Headers/],
]) {
  hooks.stripe = async () => { throw thrown(); };
  let e = null; try { await lib.stripe("GET", "/accounts/acct_1EditorAAAAAAAA"); } catch (x) { e = x; }
  vuln(!e || !e.network || !want.test(e.message) || never.test(e.message), `R ${what} -> ${e ? shown(e.message) : "no error"}, marked as no answer: ${!!(e && e.network)} (must say why, in Cuvori's words only)`);
  reset();
}

// ---------- P1: the admin panel's sentence when the key can't be used ----------
{
  const html = fs.readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
  const m = html.match(/ESCROW\.keyOk===false\?`([^`]*)`/);
  const t = m ? m[1] : "";
  vuln(!/sk_live_/.test(t) || !/space or line break/.test(t) || /is not a secret key:/.test(t), `P1 the admin panel when the key can't be used -> ${shown(t.replace(/<[^>]+>/g, ""), 260)} (must name both reasons: not a secret key, or a space or line break inside it)`);
}

// ---------- P2: the admin panel's sentence when the database key can't be used ----------
{
  const html = fs.readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
  const m = html.match(/ESCROW\.dbKeyOk===false\?`([^`]*)`/);
  const t = m ? m[1] : "";
  vuln(!/ON, but paused/.test(t) || !/SUPABASE_SECRET_KEY/.test(t) || !/SUPABASE_SERVICE_ROLE_KEY/.test(t) || !/space or line break/.test(t),
    `P2 the admin panel when the database key can't be used -> ${shown(t.replace(/<[^>]+>/g, "") || "(no such sentence)", 260)} (must say "ON, but paused" and name the setting)`);
}

console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
