// A freelancer's Stripe account is kept separately for test and live (schema v28, stripe-connect.mjs), and the
// safeguards around setting one aside: only when Stripe confirms it is gone, only in test mode, only while it is still
// the saved one, kept in the history, with a fresh retry key for a genuinely new account. Live mode is never replaced
// automatically, and keys of the other mode never move money (the database says which mode it belongs to).
// K1–K4: only Stripe's precise "account gone" answers mean "the freelancer is not ready"; a problem on Cuvori's side says
// "something went wrong", is noted on the Order for the admin and cleared once it works again; and Cuvori remembers which
// Stripe account its keys belong to, pausing every payment for keys of another Stripe account.
// The test-mode part runs here; the file then runs itself again with live keys for the live-mode part.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const LIVE = process.env.HARNESS_STRIPE_KEY === "sk_live_fake";
const H = await import("./fn-harness.mjs");
const { DB, STRIPE, users, hooks, urls, req, call, mk, reset, fns, signed, F, fund, past, onlyDue } = H;
const lib = await import(F + "../lib/cuvori.mjs");
const fx = await fns();
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const row = () => DB.payout_details.find(p => p.id === users.ed.id);
const snap = () => JSON.stringify((({ stripe_account_id, stripe_payouts_enabled, stripe_live_account_id, stripe_live_payouts_enabled, stripe_account_history }) => ({ stripe_account_id, stripe_payouts_enabled, stripe_live_account_id, stripe_live_payouts_enabled, stripe_account_history }))(row()));
const setMode = (mode) => { DB.site_settings.length = 0; if (mode) DB.site_settings.push({ key: "stripe_mode", value: mode }); if (lib.forgetStripeMode) lib.forgetStripeMode(); };
const connect = (method) => call(fx.connect, req(method, "x", method === "POST" ? { token: "tok_ed", body: {} } : { token: "tok_ed" }));
const gone403 = (id) => (path, method) => path === `/accounts/${id}` && method === "GET"
  ? [403, { error: { type: "invalid_request_error", code: "account_invalid", message: `The provided key 'sk_test_***' does not have access to account '${id}' (or that account does not exist). Application access may have been revoked.` } }] : null;
const newAccount = (extra = {}) => { const id = "acct_1New" + Math.random().toString(36).slice(2, 12).padEnd(10, "x"); STRIPE.accounts[id] = { id, payouts_enabled: true, charges_enabled: true, capabilities: { transfers: "active" }, requirements: { currently_due: [] }, metadata: { cuvori_user: users.ed.id }, ...extra }; return id; };
const ORIGINAL = "acct_1EditorAAAAAAAA";

if (!LIVE) {
  setMode(null);                                                   // no setting row yet: the database counts as test mode
  // ---------- C1: the saved test account is used as before ----------
  {
    const r = await connect("GET");
    vuln(r.status !== 200 || !r.json.connected || !r.json.payouts_enabled, `C1 a ready test account -> ${r.status} ${JSON.stringify(r.json)} (must be connected and ready)`);
  }
  // ---------- C2: things that do not prove the account is gone change nothing ----------
  for (const [name, hook] of [
    ["a timeout / no answer", (path) => { if (path === `/accounts/${ORIGINAL}`) throw new Error("network down"); return null; }],
    ["too many requests (429)", (path) => path === `/accounts/${ORIGINAL}` ? [429, { error: { type: "invalid_request_error", code: "rate_limit", message: "Too many requests" } }] : null],
    ["a bad key (401)", (path) => path === `/accounts/${ORIGINAL}` ? [401, { error: { type: "invalid_request_error", message: "Invalid API Key provided" } }] : null],
    ["a key without permission (403, no account_invalid)", (path) => path === `/accounts/${ORIGINAL}` ? [403, { error: { type: "invalid_request_error", message: "The provided key 'rk_test_***' does not have the required permissions for this endpoint" } }] : null],
    ["a Stripe outage (500)", (path) => path === `/accounts/${ORIGINAL}` ? [500, { error: { type: "api_error", message: "Something went wrong on Stripe's end" } }] : null],
    ["the other mode's account (livemode_mismatch)", (path) => path === `/accounts/${ORIGINAL}` ? [400, { error: { type: "invalid_request_error", code: "livemode_mismatch", message: "Test and live mode API keys, requests, and objects are only available within the corresponding mode." } }] : null],
  ]) {
    for (const method of ["GET", "POST"]) {
      const before = snap(), accounts = Object.keys(STRIPE.accounts).length;
      hooks.stripe = hook;
      const r = await connect(method);
      reset();
      vuln(r.status === 200 || snap() !== before || Object.keys(STRIPE.accounts).length !== accounts,
        `C2 ${name}, ${method} Payout details -> ${r.status} ${r.json && r.json.error}; saved account unchanged: ${snap() === before}, no new account: ${Object.keys(STRIPE.accounts).length === accounts}`);
    }
  }
  // ---------- C3: someone else's account stops, it is never treated as unfinished setup ----------
  {
    const before = snap(), accounts = Object.keys(STRIPE.accounts).length;
    STRIPE.accounts[ORIGINAL].metadata.cuvori_user = users.ed2.id;
    for (const method of ["GET", "POST"]) {
      const r = await connect(method);
      vuln(r.status !== 409 || r.json.error !== "Stripe connection is broken, contact support" || snap() !== before || Object.keys(STRIPE.accounts).length !== accounts,
        `C3 the saved account belongs to someone else, ${method} -> ${r.status} ${r.json && r.json.error} (must stop with "contact support", nothing changed)`);
    }
    STRIPE.accounts[ORIGINAL].metadata.cuvori_user = users.ed.id;
  }
  // ---------- C4: overlapping requests: the account is set aside only while it is still the one saved ----------
  {
    const other = newAccount();
    hooks.stripe = gone403(ORIGINAL);
    hooks.db = async (method, table) => { if (method === "PATCH" && table === "payout_details" && hooks.db) { row().stripe_account_id = other; hooks.db = null; } return null; };   // another request saves a new account just before
    const r = await connect("GET");
    reset();
    vuln(r.status !== 409 || row().stripe_account_id !== other || (row().stripe_account_history || []).length,
      `C4 another request saved a new account meanwhile -> ${r.status} ${r.json && r.json.error}; the new account kept: ${row().stripe_account_id === other}, history ${JSON.stringify(row().stripe_account_history || [])} (must keep it and change nothing)`);
    row().stripe_account_id = ORIGINAL;
  }
  // ---------- C5: Stripe confirms the test account is gone: set aside in the history, then a new one ----------
  {
    hooks.stripe = gone403(ORIGINAL);
    const g = await connect("GET");
    const h = row().stripe_account_history || [];
    vuln(g.status !== 200 || g.json.connected || row().stripe_account_id != null || row().stripe_payouts_enabled !== false || h.length !== 1 || h[0].id !== ORIGINAL || h[0].mode !== "test",
      `C5 Stripe says the test account is gone -> ${g.status} ${JSON.stringify(g.json)}; saved now ${row().stripe_account_id}, ready flag ${row().stripe_payouts_enabled}, history ${JSON.stringify(h.map(x => [x.id, x.mode]))} (must show "not set up", keep the old account in the history)`);
    const p = await connect("POST");
    reset();
    const made = row().stripe_account_id, keys = [...STRIPE.idem.keys()].filter(k => k.startsWith("acct3_"));
    vuln(p.status !== 200 || !made || made === ORIGINAL || !keys.includes(`acct3_test_${users.ed.id}_${ORIGINAL}`),
      `C5 then "Set up payouts with Stripe" -> ${p.status}; new account ${made} (not the old one), retry key names the replaced account: ${keys.includes(`acct3_test_${users.ed.id}_${ORIGINAL}`)}`);
    // a 404 "no such account" is the other answer that proves it: the new account disappears too, and gets replaced again with a new key
    delete STRIPE.accounts[made];
    await connect("GET"); const p2 = await connect("POST");
    const h2 = row().stripe_account_history || [];
    vuln(p2.status !== 200 || h2.length !== 2 || h2[1].id !== made || row().stripe_account_id === made || ![...STRIPE.idem.keys()].includes(`acct3_test_${users.ed.id}_${made}`),
      `C5 a second account confirmed gone (404) -> ${p2.status}; history ${JSON.stringify(h2.map(x => x.id))}, a third account with its own retry key: ${[...STRIPE.idem.keys()].includes(`acct3_test_${users.ed.id}_${made}`)}`);
  }
  // ---------- C6: retry keys: a retry gets the same account back, never a second one ----------
  {
    const p = row(); const keep = p.stripe_account_id; p.stripe_account_id = null; p.stripe_account_history = []; delete STRIPE.accounts[keep];
    const accounts = Object.keys(STRIPE.accounts).length;
    let failOnce = true;
    hooks.db = async (method, table, search) => { if (failOnce && method === "PATCH" && table === "payout_details" && String(search).includes("is.null")) { failOnce = false; return new Response(JSON.stringify({ message: "connection reset" }), { status: 503 }); } return null; };
    const first = await connect("POST");                          // Stripe made the account, saving it failed: the outcome is unknown to the freelancer
    reset();
    const again = await connect("POST");                          // the freelancer clicks again
    vuln(first.status === 200 || again.status !== 200 || Object.keys(STRIPE.accounts).length !== accounts + 1,
      `C6 the save failed after Stripe made the account, then a retry -> first ${first.status}, retry ${again.status}; accounts made: ${Object.keys(STRIPE.accounts).length - accounts} (must be exactly 1, the same one)`);
    const twice = await connect("POST");
    vuln(twice.status !== 200 || Object.keys(STRIPE.accounts).length !== accounts + 1, `C6 clicking "Set up payouts" again uses the saved account -> ${twice.status}; accounts made: ${Object.keys(STRIPE.accounts).length - accounts}`);
  }
  // ---------- C7: a save never overwrites an account another request saved at the same time ----------
  {
    const p = row(); p.stripe_account_id = null; p.stripe_account_history = [{ id: "acct_1OldOneEEEEEEEE", mode: "test", why: "not found at Stripe", at: "2026-01-01T00:00:00Z" }];
    const theirs = newAccount();
    hooks.db = async (method, table, search) => { if (method === "PATCH" && table === "payout_details" && String(search).includes("is.null") && hooks.db) { row().stripe_account_id = theirs; hooks.db = null; } return null; };
    const r = await connect("POST");
    reset();
    vuln(r.status !== 409 || row().stripe_account_id !== theirs, `C7 another request saved an account first -> ${r.status} ${r.json && r.json.error}; theirs kept: ${row().stripe_account_id === theirs}`);
    row().stripe_account_id = ORIGINAL; row().stripe_account_history = []; STRIPE.accounts[ORIGINAL] = STRIPE.accounts[ORIGINAL] || { id: ORIGINAL, payouts_enabled: true, charges_enabled: true, capabilities: { transfers: "active" }, requirements: { currently_due: [] }, metadata: { cuvori_user: users.ed.id } };
    row().stripe_payouts_enabled = true;
  }
  // ---------- C8: the account-updated webhook only touches this mode's flag ----------
  {
    row().stripe_live_account_id = "acct_1LiveFFFFFFFFFF"; row().stripe_live_payouts_enabled = true;
    STRIPE.accounts[ORIGINAL].payouts_enabled = false;
    const w = await call(fx.webhook, req("POST", "x", signed({ type: "account.updated", data: { object: { id: ORIGINAL } } })));
    vuln(w.status !== 200 || row().stripe_payouts_enabled !== false || row().stripe_live_payouts_enabled !== true || row().stripe_live_account_id !== "acct_1LiveFFFFFFFFFF",
      `C8 Stripe says the test account can't be paid out -> webhook ${w.status}; test flag ${row().stripe_payouts_enabled}, live account and flag untouched: ${row().stripe_live_account_id === "acct_1LiveFFFFFFFFFF" && row().stripe_live_payouts_enabled === true}`);
    STRIPE.accounts[ORIGINAL].payouts_enabled = true; row().stripe_payouts_enabled = true; delete row().stripe_live_account_id; delete row().stripe_live_payouts_enabled;
  }
  // ---------- C9: test keys against a database switched to live: nothing moves ----------
  {
    setMode("live");
    const c = mk(); const pages = Object.keys(STRIPE.sessions).length, n0 = urls.length;
    const r = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
    const g = await connect("GET");
    const stripeCalls = urls.slice(n0).filter(u => u.includes("api.stripe.com")).length;
    vuln(r.status !== 503 || !/Payments are paused/.test(r.json && r.json.error || "") || g.status !== 503 || Object.keys(STRIPE.sessions).length !== pages || stripeCalls,
      `C9 test keys, database in live mode -> Fund ${r.status} ${r.json && r.json.error}; Payout details ${g.status}; Stripe calls made: ${stripeCalls} (must be paused, none)`);
    setMode("test");
    const ok = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: mk().id } }));
    vuln(ok.status !== 200, `C9 back to test mode, Fund works again -> ${ok.status} ${ok.json && ok.json.error || ""}`);
  }

  // ---------- K1: Fund: the right reason for the right person ----------
  const keyProblem = (path, method) => path === `/accounts/${ORIGINAL}` && method === "GET"
    ? [403, { error: { type: "invalid_request_error", message: "The provided key 'rk_test_***' does not have the required permissions for this endpoint" } }] : null;
  const fundIt = (c) => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  {
    const c = mk(); const pages = Object.keys(STRIPE.sessions).length;
    hooks.stripe = keyProblem; const r = await fundIt(c); reset();
    vuln(r.status !== 500 || /Stripe setup/.test(r.json && r.json.error || "") || !String(c.money_error || "").startsWith("Stripe check failed: ") || !/required permissions/.test(c.money_error) || Object.keys(STRIPE.sessions).length !== pages,
      `K1 Cuvori's own key can't read Stripe accounts, the client clicks Fund -> ${r.status} ${r.json && r.json.error}; note for the admin: ${c.money_error} (must be "Something went wrong", never "ask the freelancer", no Stripe page)`);
    const again = await fundIt(c);
    vuln(again.status !== 200 || c.money_error, `K1 once Cuvori's key works again -> Fund ${again.status}; the note is gone: ${!c.money_error}`);
    const c2 = mk({ money_error: "top-up pi_x may not be recorded — check by hand" });
    hooks.stripe = keyProblem; await fundIt(c2); reset();
    vuln(c2.money_error !== "top-up pi_x may not be recorded — check by hand", `K1 an Order that already has a note for the admin keeps it -> ${c2.money_error}`);
    const c3 = mk();
    hooks.stripe = gone403(ORIGINAL); const g = await fundIt(c3); reset();
    vuln(g.status !== 409 || !/Stripe setup under Account/.test(g.json && g.json.error || "") || c3.money_error, `K1 Stripe confirms the freelancer's account is gone -> ${g.status} ${g.json && g.json.error}; no note: ${!c3.money_error}`);
    for (const [name, hook] of [["Stripe not answering", (path) => { if (path === `/accounts/${ORIGINAL}`) throw new Error("network down"); return null; }],
                                ["a Stripe outage (500)", (path) => path === `/accounts/${ORIGINAL}` ? [500, { error: { type: "api_error", message: "Something went wrong on Stripe's end" } }] : null]]) {
      const c4 = mk(); hooks.stripe = hook; const x = await fundIt(c4); reset();
      vuln(x.status !== 500 || /Stripe setup/.test(x.json && x.json.error || "") || !String(c4.money_error || "").startsWith("Stripe check failed: "), `K1 ${name}, the client clicks Fund -> ${x.status} ${x.json && x.json.error}; note: ${c4.money_error}`);
    }
  }
  // ---------- K2: releases: the real reason on the Order, gone once it is paid out ----------
  {
    const c = mk(); await fund(fx, c); c.status = "delivered";
    hooks.stripe = keyProblem;
    const r = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
    reset();
    vuln(r.status !== 500 || !String(c.money_error || "").startsWith("Stripe check failed: ") || c.status !== "delivered",
      `K2 Cuvori's key problem, the client clicks Approve & release -> ${r.status} ${r.json && r.json.error}; Order ${c.status}, note: ${c.money_error}`);
    const ok = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
    vuln(ok.status !== 200 || c.status !== "completed" || c.money_error, `K2 once fixed -> release ${ok.status}, Order ${c.status}, note gone: ${!c.money_error}`);
    const d = mk(); await fund(fx, d); d.status = "delivered"; d.auto_release_at = past(1); onlyDue(d);
    hooks.stripe = keyProblem;
    const a = await call(fx.autoRelease, req("POST", "x", {}));
    reset();
    const why = ((a.json && a.json.failures) || []).find(f => f.id === d.id);
    vuln(!why || !/required permissions/.test(why.why) || !String(d.money_error || "").startsWith("Stripe check failed: ") || d.status !== "delivered",
      `K2 the hourly automatic release with Cuvori's key problem -> reason in the log: ${why && why.why}; note on the Order: ${d.money_error}`);
    await call(fx.autoRelease, req("POST", "x", {}));
    vuln(d.status !== "completed" || d.money_error, `K2 once fixed, the next hourly run pays out -> Order ${d.status}, note gone: ${!d.money_error}`);
  }
  // ---------- K3: Cuvori remembers which Stripe account its keys belong to ----------
  {
    const rec = () => (DB.site_settings.find(r => r.key === "stripe_platform_test") || {}).value;
    vuln(rec() !== STRIPE.platform, `K3 the first time, Cuvori remembers the Stripe account of its keys -> ${rec()}`);
    const was = STRIPE.platform;
    STRIPE.platform = "acct_1OtherCompanyBB"; lib.forgetStripeMode();          // keys of a different Stripe account (a new deploy)
    const pages = Object.keys(STRIPE.sessions).length, accounts = Object.keys(STRIPE.accounts).length, before = snap();
    const f = await fundIt(mk());
    const g = await connect("GET"), p = await connect("POST");
    vuln(f.status !== 503 || !/belong to a different Stripe account/.test(f.json && f.json.error || "") || g.status !== 503 || p.status !== 503
      || Object.keys(STRIPE.sessions).length !== pages || Object.keys(STRIPE.accounts).length !== accounts || snap() !== before || rec() !== was,
      `K3 keys of a different Stripe account -> Fund ${f.status} ${f.json && f.json.error}; Payout details ${g.status}/${p.status}; nothing changed: ${snap() === before && Object.keys(STRIPE.accounts).length === accounts}; still remembers ${rec()}`);
    // the owner confirms the move in Supabase (stripe_platform_switch): the new account is remembered, payments work again
    DB.site_settings.splice(DB.site_settings.findIndex(r => r.key === "stripe_platform_test"), 1); lib.forgetStripeMode();
    const ok = await fundIt(mk());
    vuln(ok.status !== 200 || rec() !== "acct_1OtherCompanyBB", `K3 after the owner confirms the move -> Fund ${ok.status}; remembers now ${rec()}`);
    STRIPE.platform = was; DB.site_settings.splice(DB.site_settings.findIndex(r => r.key === "stripe_platform_test"), 1); lib.forgetStripeMode();
  }
  // ---------- K4: if Stripe can't say which account the keys belong to, nothing is paid ----------
  {
    lib.forgetStripeMode();
    const pages = Object.keys(STRIPE.sessions).length;
    hooks.stripe = (path) => path === "/account" ? [500, { error: { type: "api_error", message: "Something went wrong on Stripe's end" } }] : null;
    const f = await fundIt(mk()); reset();
    vuln(f.status !== 500 || Object.keys(STRIPE.sessions).length !== pages, `K4 Stripe doesn't answer which account the keys belong to -> Fund ${f.status} ${f.json && f.json.error}; no Stripe page: ${Object.keys(STRIPE.sessions).length === pages}`);
    const ok = await fundIt(mk());
    vuln(ok.status !== 200, `K4 once Stripe answers again -> Fund ${ok.status}`);
  }

  // ---------- the live-mode part: the same file with live keys ----------
  let liveOut = "";
  try { liveOut = execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, HARNESS_STRIPE_KEY: "sk_live_fake" }, encoding: "utf8" }); }
  catch (e) { liveOut = String(e.stdout || "") + "\nVULNERABLE the live-mode part did not finish: " + String(e.stderr || e.message).split("\n").slice(0, 3).join(" "); }
  for (const l of liveOut.split("\n")) if (/^(safe|VULNERABLE) /.test(l)) out.push(l);
} else {
  setMode("live");
  const testBefore = () => JSON.stringify([row().stripe_account_id, row().stripe_payouts_enabled]);
  const tb = testBefore();
  // ---------- L1: with live keys, the test account is never looked at or changed ----------
  {
    const n0 = urls.length;
    const g = await connect("GET");
    const asked = urls.slice(n0).some(u => u.includes(`/accounts/${ORIGINAL}`));
    vuln(g.status !== 200 || g.json.connected || asked || testBefore() !== tb, `L1 live keys, only a test account saved -> ${g.status} ${JSON.stringify(g.json)}; Stripe asked about the test account: ${asked}; test account untouched: ${testBefore() === tb}`);
    const c = mk(); const f = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
    vuln(f.status !== 409 || !/Stripe account can't receive payments/.test(f.json && f.json.error || ""), `L1 Fund before the freelancer set up live payouts -> ${f.status} ${f.json && f.json.error} (must be refused as not ready)`);
  }
  // ---------- L2: setting up live payouts makes a live account next to the test one ----------
  {
    const p = await connect("POST");
    const live = row().stripe_live_account_id;
    vuln(p.status !== 200 || !live || live === ORIGINAL || testBefore() !== tb || ![...STRIPE.idem.keys()].includes(`acct3_live_${users.ed.id}_first`),
      `L2 "Set up payouts with Stripe" with live keys -> ${p.status}; live account ${live}; test account untouched: ${testBefore() === tb}`);
    Object.assign(STRIPE.accounts[live], { payouts_enabled: true, charges_enabled: true, capabilities: { transfers: "active" }, requirements: { currently_due: [] } });
    const g = await connect("GET");
    const f = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: mk().id } }));
    vuln(g.status !== 200 || !g.json.payouts_enabled || row().stripe_live_payouts_enabled !== true || row().stripe_payouts_enabled !== JSON.parse(tb)[1] || f.status !== 200,
      `L2 once Stripe has checked the freelancer -> Payout details ${JSON.stringify(g.json)}; live flag ${row().stripe_live_payouts_enabled}; Fund ${f.status} ${f.json && f.json.error || ""}`);
  }
  // ---------- L3: a live account Stripe can't find is never replaced automatically ----------
  {
    const live = row().stripe_live_account_id, before = snap(), accounts = Object.keys(STRIPE.accounts).length;
    hooks.stripe = gone403(live);
    const g = await connect("GET"), p = await connect("POST");
    reset();
    vuln(g.status !== 409 || p.status !== 409 || !/needs a check by Cuvori support/.test(g.json && g.json.error || "") || snap() !== before || Object.keys(STRIPE.accounts).length !== accounts,
      `L3 Stripe can't find the live account -> GET ${g.status}, POST ${p.status} ${p.json && p.json.error}; nothing changed: ${snap() === before}, no new account: ${Object.keys(STRIPE.accounts).length === accounts}`);
  }
  // ---------- L4: live keys against a database still in test mode: nothing moves ----------
  {
    setMode("test");
    const n0 = urls.length;
    const f = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: mk().id } }));
    const stripeCalls = urls.slice(n0).filter(u => u.includes("api.stripe.com")).length;
    vuln(f.status !== 503 || !/Payments are paused: the Stripe keys are for live mode, but the database is set to test mode/.test(f.json && f.json.error || "") || stripeCalls,
      `L4 live keys, database still in test mode (launch-day step not done) -> Fund ${f.status} ${f.json && f.json.error}; Stripe calls: ${stripeCalls}`);
  }
}

console.log(out.join("\n"));
if (!LIVE) {
  const bad = out.filter(l => l.startsWith("VULNERABLE")).length;
  console.log(`\n${bad} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
  process.exit(bad ? 1 : 0);
}
