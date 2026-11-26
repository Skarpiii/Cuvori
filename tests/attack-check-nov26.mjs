// Check of 26 November 2026 (the calendar date: the labels of some earlier checks ran ahead of it). Lines 91–182 of
// netlify/lib/cuvori.mjs: the settings in Netlify (the database key, the Stripe key, the webhook secrets, the addresses).
// D  Supabase's PUBLIC key (the publishable sb_publishable_… key, or the older anon key, a JWT whose role is "anon") pasted
//    in place of the secret one. It sits next to the secret key in Supabase. It was taken for a working key: the admin page
//    said "ON", every button answered "Something went wrong", Stripe's notices were refused and the hourly job found no
//    Order at all, so it paid out and refunded nothing and said nothing. Now it is refused like Stripe's public key: never
//    sent, the buttons say "payments paused", the admin page says ON, but paused and why, and the log names the setting.
// W  STRIPE_WEBHOOK_SECRET set, but not a secret that can check anything (quotes around it, a space inside): the admin page
//    said so and payments stayed on, but every Stripe notice was refused, a chargeback's too, and the hourly job still paid
//    out on the date alone: an Order whose client's bank had opened a chargeback was paid to the freelancer. Now nothing is
//    paid out on a date alone while the secret can't be one; the client's own approval and what a person decided go on.
// G  breaks of these lines that no test noticed (check of 26 November 2026): a Stripe key with spaces around it, Stripe's
//    public key, the second webhook secret, SITE_URL set to Netlify's address, the payment cap, the payout-fee ceiling, a
//    disputed Order refunded in full from the Stripe dashboard, an old Order without counters being paid out or decided,
//    payments without a database key, and a website whose name only starts like Cuvori's.
// Run: node tests/attack-check-nov26.mjs   (TARGET=<folder> checks another copy)
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = process.env.TARGET ? path.resolve(process.env.TARGET) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");   // the copy under test (TARGET), else this one
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (role) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "supabase", ref: "tnxujwlfatcvxzevllfr", role, iat: 1700000000, exp: 2000000000 })}.c2lnbmF0dXJlc2lnbmF0dXJlc2lnbmF0dXJl`;
const UUID = "22222222-2222-4222-8222-222222222222";

// ---------- one fresh process per setting: what the payment code makes of it ----------
// A small stand-in for Supabase (an admin's sign-in, the try counter, no Orders) and for Stripe; every call to either is
// written down, so a key that must never be sent can be seen not to be.
const CHILD = `
  const root = process.env.T_ROOT, out = { calls: [] };
  const logs = []; console.error = (...a) => logs.push(a.map(String).join(" "));
  try {
    globalThis.fetch = async (u, init = {}) => { const url = new URL(String(u)), h = new Headers(init.headers || {});
      out.calls.push({ host: url.hostname, path: url.pathname, apikey: h.get("apikey"), auth: h.get("authorization") });
      const ok = (d) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (url.hostname === "api.stripe.com") return ok({});
      if (url.pathname === "/auth/v1/user") return ok({ id: "00000000-0000-4000-8000-0000000000ad" });
      if (url.pathname === "/rest/v1/profiles") return ok([{ id: "00000000-0000-4000-8000-0000000000ad", email: "a@t.com", first_name: "a", role: "client", is_admin: true, banned: false }]);
      if (url.pathname === "/rest/v1/rpc/rate_limit_tries") return ok("ok");
      return ok([]); };
    const lib = await import(root + "/netlify/lib/cuvori.mjs");
    Object.assign(out, { site: lib.SITE_URL, mode: lib.STRIPE_MODE ?? null, dbKeyOk: lib.SERVICE_KEY_OK ?? null, connect: lib.CONNECT_WEBHOOK_SECRET, escrow: lib.escrowEnabled(), notes: lib.SETTINGS_NOTES || [] });
    const st = (await import(root + "/netlify/functions/stripe-status.mjs")).default;
    const ask = (o, auth) => new Request("https://main--cuvori.netlify.app/.netlify/functions/x", { method: "POST", headers: { origin: o || "https://cuvori.io", "content-type": "application/json", ...(auth ? { authorization: "Bearer admin_token" } : {}) }, body: JSON.stringify({ contract_id: "${UUID}" }) });
    const s = await st(new Request("https://main--cuvori.netlify.app/.netlify/functions/stripe-status", { headers: { origin: "https://cuvori.io" } }));
    out.status = JSON.parse(await s.text());
    const before = out.calls.length;
    const rel = (await import(root + "/netlify/functions/stripe-release.mjs")).default;
    const r = await rel(ask(null, true)); out.release = { status: r.status, ...JSON.parse(await r.text()) };
    out.releaseCalls = out.calls.slice(before);
    const co = (await import(root + "/netlify/functions/stripe-checkout.mjs")).default;
    const c = await co(ask(null, true)); out.checkout = { status: c.status, ...JSON.parse(await c.text()) };
  } catch (e) { out.error = String(e && e.stack || e); }
  out.log = logs.join("\\n");
  console.log("RESULT " + JSON.stringify(out));`;
const load = (settings) => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, T_ROOT: root, URL: "https://cuvori.netlify.app", SITE_URL: "https://cuvori.io", STRIPE_SECRET_KEY: "sk_test_51AbCdEf", SUPABASE_SECRET_KEY: "sb_secret_AbCdEf123456", STRIPE_WEBHOOK_SECRET: "whsec_AbCdEf123456", ...settings };
  for (const k of Object.keys(env)) if (env[k] === null) delete env[k];
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", CHILD], { env, encoding: "utf8", timeout: 60000 });
  const line = (r.stdout || "").split("\n").find(l => l.startsWith("RESULT ")) || 'RESULT {"error":"no answer"}';
  return JSON.parse(line.slice(7));
};
const dbCalls = (r) => (r.calls || []).filter(c => c.host.endsWith("supabase.co")).length;
const leaks = (r, key) => [key.slice(0, 14), key.slice(-14), key.slice(10, 24)].some(p => p.length >= 8 && JSON.stringify([r.log, r.notes, r.status, r.release, r.checkout]).includes(p));

// ---------- D: Supabase's public key in place of the secret one ----------
for (const [name, settings, setting] of [
  ["D1 the older anon key (a JWT whose role is anon) in SUPABASE_SERVICE_ROLE_KEY", { SUPABASE_SECRET_KEY: null, SUPABASE_SERVICE_ROLE_KEY: jwt("anon") }, "SUPABASE_SERVICE_ROLE_KEY"],
  ["D2 the publishable key (sb_publishable_…) in SUPABASE_SECRET_KEY", { SUPABASE_SECRET_KEY: "sb_publishable_AbCdEf1234567890xyz" }, "SUPABASE_SECRET_KEY"],
  ["D3 a JWT for a signed-in person (role authenticated) in SUPABASE_SERVICE_ROLE_KEY", { SUPABASE_SECRET_KEY: null, SUPABASE_SERVICE_ROLE_KEY: jwt("authenticated") }, "SUPABASE_SERVICE_ROLE_KEY"],
  ["D4 the publishable key in SUPABASE_SECRET_KEY while the older setting holds the service_role key (the newer setting is the one used)", { SUPABASE_SECRET_KEY: "sb_publishable_AbCdEf1234567890xyz", SUPABASE_SERVICE_ROLE_KEY: jwt("service_role") }, "SUPABASE_SECRET_KEY"],
]) {
  const key = settings.SUPABASE_SECRET_KEY || settings.SUPABASE_SERVICE_ROLE_KEY;
  const r = load(settings);
  const paused = (x) => x && x.status === 503 && x.code === "payments_paused" && x.error.includes(setting) && /public/i.test(x.error);
  vuln(!!r.error || r.dbKeyOk !== false || r.status.databaseKeyOk !== false || r.status.escrow !== true || !paused(r.release) || !paused(r.checkout) || dbCalls(r) !== 0
       || !r.log.includes(setting) || !/public/i.test(r.log) || leaks(r, key),
    `${name} -> database key usable ${r.dbKeyOk}; the admin page is told databaseKeyOk ${r.status && r.status.databaseKeyOk}, escrow ${r.status && r.status.escrow}; a button: ${r.release && r.release.status} ${r.release && r.release.code} "${r.release && r.release.error}"; Pay: ${r.checkout && r.checkout.status} ${r.checkout && r.checkout.code}; requests sent to the database ${dbCalls(r)}; the log names the setting ${r.log.includes(setting)}; the key in the log or an answer: ${leaks(r, key)}${r.error ? "; STOPPED " + r.error.slice(0, 200) : ""} (must be refused as Supabase's public key: never sent, "payments paused" naming ${setting})`);
}
for (const [name, settings, key] of [
  ["D5 the older service_role key (a JWT whose role is service_role)", { SUPABASE_SECRET_KEY: null, SUPABASE_SERVICE_ROLE_KEY: jwt("service_role") }, jwt("service_role")],
  ["D6 the newer secret key (sb_secret_…)", {}, "sb_secret_AbCdEf123456"],
  ["D7 a key that is no JWT Cuvori can read (eyJ.a.b): Supabase decides", { SUPABASE_SECRET_KEY: null, SUPABASE_SERVICE_ROLE_KEY: "eyJ.a.b" }, "eyJ.a.b"],
]) {
  const r = load(settings);
  const sent = (r.releaseCalls || []).filter(c => c.host.endsWith("supabase.co"));
  vuln(!!r.error || r.dbKeyOk !== true || r.status.databaseKeyOk !== true || !sent.length || !sent.every(c => c.apikey === key) || r.release.code === "payments_paused",
    `${name} -> database key usable ${r.dbKeyOk}; databaseKeyOk ${r.status && r.status.databaseKeyOk}; a button reached the database ${sent.length} times with this key, answered ${r.release && r.release.status} ${r.release && r.release.code}${r.error ? "; STOPPED " + r.error.slice(0, 200) : ""} (must work as before)`);
}
{ // D8 the admin page's words for a database key that can't be used name the public key too
  const html = fs.readFileSync(root + "/index.html", "utf8");
  const i = html.indexOf("ESCROW.dbKeyOk===false?"), line = i < 0 ? "" : html.slice(i, html.indexOf("`:", i + 30));
  vuln(!/not the public one/.test(line) || !/publishable/.test(line) || !/anon/.test(line) || !/SUPABASE_SECRET_KEY/.test(line),
    `D8 Admin panel → Payment costs, "ON, but paused" for the database key, says it must be the secret key, not the public one (publishable or anon) -> ${JSON.stringify(line.slice(0, 400))}`);
}
{ // D9 SETUP.md says so where the database key is set
  const setup = fs.readFileSync(root + "/SETUP.md", "utf8"), p = setup.split("\n").find(l => /^\s*- `SUPABASE_SERVICE_ROLE_KEY` = /.test(l)) || "";
  vuln(!/publishable/.test(p) || !/anon/.test(p) || !/refused/.test(p), `D9 SETUP.md, where the database key goes into Netlify, warns about Supabase's public key -> ${JSON.stringify(p.slice(0, 160))}…`);
}

// ---------- W: a webhook secret that can't be one holds the automatic payouts ----------
const WCHILD = `
  const H = await import(process.env.T_ROOT + "/tests/fn-harness.mjs");
  process.env.STRIPE_WEBHOOK_SECRET = process.env.T_SECRET;          // read when the functions load (below); Stripe signs with whsec_fake
  const logs = []; console.error = (...a) => logs.push(a.map(String).join(" "));
  const { DB, STRIPE, users, req, call, mk, past, pay, signed, uuid } = H;
  const fx = await H.fns();
  const lib = await import(H.F + "../lib/cuvori.mjs");
  const paid = (c) => STRIPE.transfers.filter(t => t.contract === c.id).reduce((a, t) => a + t.amount - (t.amount_reversed || 0), 0);
  // paid the way a client pays when Stripe's notice may not get through: Pay, Stripe's page, Stripe's notice, back on the page
  const payIn = async (c) => { const co = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } })); if (co.status !== 200) return "Pay " + co.status;
    const s = pay(c.stripe_checkout_id); await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: s } })));
    const cf = await call(fx.confirm, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, session_id: s.id } })); return cf.status === 200 && c.funded_cents === c.amount_cents ? "paid" : "confirm " + cf.status; };
  const o = { A: mk(), B: mk({ has_milestones: true }), C: mk(), D: mk(), E: mk() }, how = {};
  for (const k of Object.keys(o)) how[k] = await payIn(o[k]);
  // A handed in, its review period over; B one part handed in, its review period over; C an automatic payout started an hour
  // ago whose transfer failed (the hourly job finishes it); D the client approves now; E the client approved an hour ago,
  // its transfer failed (finished by the hourly job)
  Object.assign(o.A, { status: "delivered", delivered_at: past(400), auto_release_at: past(1) });
  const m = { id: uuid(), order_id: o.B.id, title: "Part 1", amount_cents: o.B.amount_cents, status: "submitted", position: 1, submitted_at: past(400), auto_release_at: past(1) }; DB.order_milestones.push(m);
  o.B.status = "funded";
  Object.assign(o.C, { status: "releasing", resolution: "release", split_editor_cents: o.C.amount_cents, refund_cents: 0, resolved_by: null, resolved_at: past(1) });
  Object.assign(o.D, { status: "delivered", delivered_at: past(2), auto_release_at: past(-100) });
  Object.assign(o.E, { status: "releasing", resolution: "release", split_editor_cents: o.E.amount_cents, refund_cents: 0, resolved_by: users.cl.id, resolved_at: past(1) });
  const d = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: o.D.id } }));
  const l0 = logs.length;
  const run = await call(fx.autoRelease, req("GET", "x"));
  const res = { how, approve: d.status, run: run.json, runLog: logs.slice(l0).join("\\n"), notes: lib.SETTINGS_NOTES || [], milestone: DB.order_milestones.find(x => x.id === m.id).status };
  for (const k of Object.keys(o)) res[k] = { paid: paid(o[k]), status: o[k].status };
  console.log("RESULT " + JSON.stringify(res));`;
const wload = (secret) => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", WCHILD], { env: { PATH: process.env.PATH, HOME: process.env.HOME, T_ROOT: root, T_SECRET: secret }, encoding: "utf8", timeout: 120000 });
  const line = (r.stdout || "").split("\n").find(l => l.startsWith("RESULT ")) || null;
  return line ? JSON.parse(line.slice(7)) : { error: ((r.stdout || "") + (r.stderr || "")).slice(-400) };
};
const said = (w) => w.error ? "STOPPED " + w.error : `paid in: ${JSON.stringify(w.how)}; paid out A ${w.A.paid} (${w.A.status}), part of B ${w.B.paid} (part ${w.milestone}), C ${w.C.paid} (${w.C.status}), D ${w.D.paid} (${w.D.status}), E ${w.E.paid} (${w.E.status})`;
{
  const good = wload("whsec_fake");
  vuln(!!good.error || Object.values(good.how).some(x => x !== "paid") || ["A", "B", "C", "D", "E"].some(k => good[k].paid !== 10000),
    `W1 the secret Stripe signs with: every payout goes as before -> ${said(good)} (each must be 10000)`);
  for (const [name, secret] of [["with quotes around it", '"whsec_fake"'], ["with a space inside", "whsec_fa ke"], ["the Stripe key pasted in its place", "sk_live_51AbCdEf"]]) {
    const w = wload(secret);
    const why = w.run && JSON.stringify(w.run) || "";
    vuln(!!w.error || Object.values(w.how).some(x => x !== "paid") || w.A.paid !== 0 || w.A.status !== "delivered" || w.B.paid !== 0 || w.milestone !== "submitted" || w.C.paid !== 0 || w.C.status !== "releasing",
      `W2 STRIPE_WEBHOOK_SECRET ${name}: nothing is paid out on the date alone -> ${said(w)} (A, B and C must wait: a chargeback could not reach them)`);
    vuln(!!w.error || w.D.paid !== 10000 || w.D.status !== "completed" || w.E.paid !== 10000 || w.E.status !== "completed" || w.approve !== 200,
      `W3 STRIPE_WEBHOOK_SECRET ${name}: the client's own approval goes on, now (D) and one started earlier (E) -> approve ${w.approve}; D ${w.D && w.D.paid} ${w.D && w.D.status}, E ${w.E && w.E.paid} ${w.E && w.E.status}`);
    const note = (w.notes || []).find(n => n.startsWith("STRIPE_WEBHOOK_SECRET")) || "";
    vuln(!!w.error || !/STRIPE_WEBHOOK_SECRET/.test(w.run && w.run.held || "") || !/STRIPE_WEBHOOK_SECRET/.test(w.runLog) || !/automatic/i.test(w.runLog) || w.runLog.includes(secret) || why.includes(secret)
         || !/nothing is paid out automatically/.test(note) || note.length > 400 || note.includes(secret),
      `W4 STRIPE_WEBHOOK_SECRET ${name}: the hourly job's answer (held) and the log say why, the admin note says payouts wait, the secret is never repeated -> answer ${why.slice(0, 260)}; log: ${JSON.stringify((w.runLog || "").split("\n").filter(l => /STRIPE_WEBHOOK_SECRET/.test(l)).slice(0, 2))}; note (${note.length} characters): ${JSON.stringify(note)}`);
  }
}

// ---------- G: breaks of lines 91–182 no test noticed ----------
{ // G1 (line 102) a Stripe key copied with spaces or a line break around it is used as it is meant
  const r = load({ STRIPE_SECRET_KEY: "  sk_live_51AbCdEf \n" });
  const sent = (r.calls || []).filter(c => c.host === "api.stripe.com");
  vuln(!!r.error || r.mode !== "live" || r.status.stripeKeyOk !== true || sent.some(c => c.auth !== "Bearer sk_live_51AbCdEf"),
    `G1 STRIPE_SECRET_KEY with spaces and a line break around it -> mode ${r.mode}, stripeKeyOk ${r.status && r.status.stripeKeyOk}; sent as ${JSON.stringify([...new Set(sent.map(c => c.auth))])}${r.error ? "; STOPPED " + r.error.slice(0, 200) : ""} (must be read without them)`);
}
{ // G2 (lines 107, 108) Stripe's public key (pk_live_…) pasted in place of the secret one: never sent, paused, and said as that.
  // A client presses Pay on their own Order (the shared stand-ins, in a process of its own: the key is read as the code loads).
  const PK = `
    const H = await import(process.env.T_ROOT + "/tests/fn-harness.mjs");
    const logs = []; console.error = (...a) => logs.push(a.map(String).join(" "));
    let asked = 0; H.hooks.stripe = async () => { asked++; return null; };
    const fx = await H.fns(); const c = H.mk(); const before = Object.keys(H.STRIPE.sessions).length;
    const r = await H.call(fx.checkout, H.req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
    const st = await H.call(fx.status, H.req("GET", "x"));
    console.log("RESULT " + JSON.stringify({ status: r.status, code: r.json && r.json.code, error: r.json && r.json.error, keyOk: st.json && st.json.stripeKeyOk, asked, pages: Object.keys(H.STRIPE.sessions).length - before, log: logs.join("\\n") }));`;
  const p = spawnSync(process.execPath, ["--input-type=module", "-e", PK], { env: { PATH: process.env.PATH, HOME: process.env.HOME, T_ROOT: root, HARNESS_STRIPE_KEY: "pk_live_51AbCdEf1234567890" }, encoding: "utf8", timeout: 60000 });
  const line = (p.stdout || "").split("\n").find(l => l.startsWith("RESULT ")), r = line ? JSON.parse(line.slice(7)) : { error: (p.stderr || "").slice(-300), log: "" };
  vuln(!!r.error && !r.status || r.keyOk !== false || r.status !== 503 || r.code !== "payments_paused" || !/is not a secret key/.test(r.error || "") || r.asked !== 0 || r.pages !== 0
       || !/starts with "pk_"/.test(r.log) || r.log.includes("51AbCdEf"),
    `G2 STRIPE_SECRET_KEY the public pk_live_ key -> stripeKeyOk ${r.keyOk}; Pay ${r.status} ${r.code} "${r.error}"; requests to Stripe ${r.asked}, payment pages ${r.pages}; log ${JSON.stringify((r.log || "").split("\n").filter(l => /STRIPE_SECRET_KEY/.test(l)).slice(0, 1))} (must pause as "not a secret key", never asking Stripe, naming only "pk_")`);
}
{ // G3 (line 114) the second webhook secret is only ever its own setting
  const r = load({ STRIPE_WEBHOOK_SECRET: '"whsec_x"', STRIPE_CONNECT_WEBHOOK_SECRET: null });
  const named = (r.notes || []).filter(n => n.startsWith("STRIPE_CONNECT_WEBHOOK_SECRET")).length, first = (r.notes || []).filter(n => n.startsWith("STRIPE_WEBHOOK_SECRET")).length;
  vuln(!!r.error || r.connect !== "" || named !== 0 || first !== 1,
    `G3 STRIPE_CONNECT_WEBHOOK_SECRET not set, STRIPE_WEBHOOK_SECRET with quotes -> the second secret is ${JSON.stringify(r.connect)}; notes about the first ${first}, about the second ${named} (must be "", 1 and 0)`);
}
for (const site of ["https://cuvori.netlify.app", "https://main--cuvori.netlify.app"]) { // G4 (line 134) Netlify's addresses are not Cuvori's own
  const r = load({ SITE_URL: site });
  vuln(!!r.error || r.site !== "https://cuvori.io" || !(r.notes || []).some(n => n.startsWith("SITE_URL is not Cuvori's own address")),
    `G4 SITE_URL ${site} (Netlify's address: an older copy of the page) -> Stripe sends people back to ${r.site}; a note: ${(r.notes || []).some(n => n.startsWith("SITE_URL is not Cuvori's own address"))} (must be https://cuvori.io, with a note)`);
}
{ // G5 (line 177) no database key: protected payments are off, as with no Stripe key
  const r = load({ SUPABASE_SECRET_KEY: null, SUPABASE_SERVICE_ROLE_KEY: null });
  vuln(!!r.error || r.escrow !== false || r.status.escrow !== false || !r.checkout || r.checkout.status !== 503 || r.checkout.code !== "payments_paused",
    `G5 no database key at all -> switched on ${r.escrow}; the page is told escrow ${r.status && r.status.escrow}; Pay ${r.checkout && r.checkout.status} ${r.checkout && r.checkout.code} (must be off)`);
}

// the rest with the shared stand-ins, in this process (what the functions write to the log is kept out of this report)
const H = await import("./fn-harness.mjs");
console.error = () => {};
const { DB, STRIPE, CONNECT, hooks, req, call, mk, fund, pay, signed, reset } = H;
const fx = await H.fns();
const lib = await import(H.F + "../lib/cuvori.mjs");
const quoteAt = (pct, fixed) => (p) => { const total = Math.ceil((p + fixed) / (1 - pct / 100)); return { price_cents: p, processing_cents: total - p, connect_cents: 0, cuvori_cents: 0, total_cents: total, currency: "EUR", payer: "client", percent: pct, fixed_cents: fixed, schedule_id: 3, region: "ANY" }; };
{ // G6 (line 170) a payment above what one card payment can carry (€999,999.99 with the fee) is never put on Stripe's page
  for (const [name, pct, want] of [["4.9% on a €950,000 Order (€998,948.74 in all)", 4.9, 200], ["6% on a €950,000 Order (€1,010,638.57 in all)", 6, 400]]) {
    hooks.rpc = async (fn, args) => fn === "order_quote" ? [200, quoteAt(pct, 25)(args.p_price_cents)] : null;
    const c = mk({ amount_cents: 95000000, price: 950000 }); const before = Object.keys(STRIPE.sessions).length;
    const r = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
    vuln(r.status !== want || (want === 400 && ((r.json && r.json.code) !== "amount_out_of_range" || Object.keys(STRIPE.sessions).length !== before)),
      `G6 the fee table at ${name} -> HTTP ${r.status} ${r.json && r.json.code || ""} (must be ${want}${want === 400 ? ", amount_out_of_range, no Stripe page" : ""})`);
    reset();
  }
}
{ // G7 (line 173) a slip in the fee table's payout-fee row never reaches a card; Stripe's real rates (and the ceiling itself) do
  const was = { ...CONNECT };
  for (const [name, percent, fixed, want] of [["2% + €5, the ceiling itself", 2, 500, 200], ["25% instead of 0.25%", 25, 210, 503], ["€21 fixed instead of €2.10", 0.25, 2100, 503], ["Stripe's 0.25% + €2.10", 0.25, 210, 200]]) {
    Object.assign(CONNECT, { percent, fixed_cents: fixed });
    const c = mk({ amount_cents: 10000 }); const before = Object.keys(STRIPE.sessions).length;
    const r = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
    vuln(r.status !== want || (want === 503 && ((r.json && r.json.code) !== "payments_paused" || !/far above Stripe's Connect rates/.test(r.json && r.json.error || "") || Object.keys(STRIPE.sessions).length !== before)),
      `G7 the payout-fee row at ${name} on a €100 Order -> HTTP ${r.status} ${r.json && r.json.code || ""} ${want === 503 ? JSON.stringify(r.json && r.json.error || "") : ""} (must be ${want})`);
    reset();
  }
  Object.assign(CONNECT, was);
}
{ // G8 (line 174) a disputed Order whose payment went back in full from the Stripe dashboard is refunded, not left in a dispute over nothing
  const c = mk(); const f = await fund(fx, c);
  Object.assign(c, { status: "disputed", dispute_by: c.client, dispute: "not what we agreed" });
  const ch = STRIPE.charges[STRIPE.intents[f.session.payment_intent].latest_charge];
  STRIPE.refunds.push({ id: "re_dashG8", amount: ch.amount - ch.amount_refunded, metadata: {}, payment_intent: ch.payment_intent, charge: ch.id, status: "succeeded" });
  ch.amount_refunded = ch.amount;
  const w = await call(fx.webhook, req("POST", "x", signed({ type: "charge.refunded", data: { object: { id: ch.id, object: "charge", payment_intent: ch.payment_intent, amount: ch.amount, amount_refunded: ch.amount, refunded: true, currency: "eur" } } })));
  vuln(w.status !== 200 || c.status !== "refunded" || c.refunded_cents !== 10000, `G8 a disputed Order refunded in full from the Stripe dashboard -> ${w.status}, Order ${c.status}, refunded ${c.refunded_cents} (must be refunded, 10000)`);
  reset();
}
{ // G9 (line 175) an Order from before the money counters (v18) that is being paid out or decided still holds its price
  const got = ["releasing", "resolving", "funded", "completed"].map(s => [s, lib.heldCents({ status: s, amount_cents: 10000 }), lib.owedCents({ status: s, amount_cents: 10000 })]);
  vuln(JSON.stringify(got) !== JSON.stringify([["releasing", 10000, 0], ["resolving", 10000, 0], ["funded", 10000, 0], ["completed", 0, 10000]]),
    `G9 held / still owed on an Order of €100 with no counters, by its status -> ${JSON.stringify(got)} (being paid out or decided: 10000 held, nothing owed)`);
}
{ // G10 (line 182) only the exact website is allowed to read an answer, never one whose name only starts like it
  const asks = { "https://cuvori.io": "https://cuvori.io", "https://www.cuvori.io": "https://www.cuvori.io", "https://cuvori.io.evil.example": null, "https://www.cuvori.io.evil.example": null, "https://cuvori.iox": null, "https://cuvori.io:8443": null, "http://cuvori.io": null };
  const got = {};
  for (const o of Object.keys(asks)) { const r = await call(fx.status, req("GET", "x", { headers: { origin: o } })); got[o] = r.headers.get("access-control-allow-origin"); }
  vuln(Object.keys(asks).some(o => got[o] !== asks[o]), `G10 which website may read the answer -> ${JSON.stringify(got)} (only cuvori.io and www.cuvori.io, exactly)`);
}

console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
