// A freelancer's Stripe account is kept separately for test and live (schema v28, stripe-connect.mjs), and the
// safeguards around setting one aside: only when Stripe confirms it is gone, only in test mode, only while it is still
// the saved one, kept in the history, with a fresh retry key for a genuinely new account. Live mode is never replaced
// automatically, and keys of the other mode never move money (the database says which mode it belongs to).
// M1–M5: keys and database in different modes say "paused" even with nothing saved; a saved account that belongs to someone
// else (or a live account Stripe says is gone) is noted for the admin; a payment is never taken in the wrong mode, also
// when the database was switched a moment ago; old "Stripe check failed" notes on unpaid Orders leave after a day.
// N1–N5: every Order remembers the mode its money was paid in; a payment recorded while test/live is being switched goes
// back to the card; an Order's money never moves with the other mode's keys; the newest note replaces the check's own.
// K1–K4: only Stripe's precise "account gone" answers mean "the freelancer is not ready"; a problem on Cuvori's side says
// "something went wrong", is noted on the Order for the admin in plain words (never Stripe's own text, which can name
// Cuvori's Stripe account or end with part of its key) and cleared once it works again; and Cuvori remembers which
// Stripe account its keys belong to, pausing every payment for keys of another Stripe account.
// K5–K6: the database's "ready" mark (the page's Fund button) follows every check, under the one rule all four places use;
// two overlapping checks of the same Order never wipe out or replace what the other just found.
// K7: a broken answer from the database (not JSON, cut off, a row without its yes/no) stops a payment, never passes for "not banned".
// The test-mode part runs here; the file then runs itself again with live keys for the live-mode part.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const LIVE = process.env.HARNESS_STRIPE_KEY === "sk_live_fake";
const H = await import("./fn-harness.mjs");
const { DB, STRIPE, users, hooks, urls, req, call, mk, reset, fns, signed, F, fund, past, onlyDue, pay } = H;
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
    vuln(r.status !== 503 || !/Payments are paused/.test(r.json && r.json.error || "") || (r.json && r.json.code) !== "payments_paused" || (g.json && g.json.code) !== "payments_paused" || g.status !== 503 || Object.keys(STRIPE.sessions).length !== pages || stripeCalls,
      `C9 test keys, database in live mode -> Fund ${r.status} ${r.json && r.json.error}; Payout details ${g.status}; Stripe calls made: ${stripeCalls} (must be paused, none)`);
    setMode("test");
    const ok = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: mk().id } }));
    vuln(ok.status !== 200, `C9 back to test mode, Fund works again -> ${ok.status} ${ok.json && ok.json.error || ""}`);
  }

  // ---------- K1: Fund: the right reason for the right person ----------
  // Stripe's own texts as Stripe writes them: they name Cuvori's Stripe account and end with part of the key. Both people
  // on an Order can read its notes, so a note says in plain words what went wrong; Stripe's text goes to the log only.
  const keyProblem = (path, method) => path === `/accounts/${ORIGINAL}` && method === "GET"
    ? [403, { error: { type: "invalid_request_error", message: `The provided key 'rk_test_*********************wXyZ' does not have the required permissions for this endpoint on account '${STRIPE.platform}'. Having the 'rak_accounts_kyc_basic_read' permission would allow this request to continue.` } }] : null;
  const keyRefused = (path, method) => path === `/accounts/${ORIGINAL}` && method === "GET"
    ? [401, { error: { type: "invalid_request_error", message: "Invalid API Key provided: sk_test_*********************wXyZ" } }] : null;
  const leaks = (note) => /acct_|sk_|rk_|wXyZ|required permissions|Invalid API Key|10\.0\.3\.7|connection reset/.test(String(note || ""));
  const refOf = (note) => (String(note || "").match(/ \(Netlify log ref ([0-9a-f]{8})\)$/) || [])[1];
  const logged = [], realError = console.error;
  console.error = (...a) => { logged.push(a.map(x => String(x && x.stack || x)).join(" ")); };
  const inLog = (note, text) => { const ref = refOf(note); return !!ref && logged.some(l => l.includes(ref) && l.includes(text)); };
  const fundIt = (c) => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  {
    const c = mk(); const pages = Object.keys(STRIPE.sessions).length;
    hooks.stripe = keyProblem; const r = await fundIt(c); reset();
    vuln(r.status !== 500 || (r.json && r.json.code) === "freelancer_not_ready" || c.money_error !== `Stripe check failed: Cuvori's Stripe key is missing a permission (Netlify log ref ${refOf(c.money_error)})`
      || leaks(c.money_error) || !inLog(c.money_error, "required permissions") || Object.keys(STRIPE.sessions).length !== pages
      || (r.json && r.json.error) !== `Something went wrong (ref ${refOf(c.money_error)})` || (r.json && r.json.code) !== "server_error" || (r.json && r.json.ref) !== refOf(c.money_error),
      `K1 Cuvori's own key can't read Stripe accounts, the client clicks Fund -> ${r.status} ${r.json && r.json.error}; note for the admin: ${c.money_error}; Stripe's full text in the log under that ref: ${inLog(c.money_error, "required permissions")} (must be "Something went wrong" with the note's ref, never "ask the freelancer", no Stripe page, a plain note without Stripe's text)`);
    const again = await fundIt(c);
    vuln(again.status !== 200 || c.money_error, `K1 once Cuvori's key works again -> Fund ${again.status}; the note is gone: ${!c.money_error}`);
    const c2 = mk({ money_error: "top-up pi_x may not be recorded — check by hand" });
    hooks.stripe = keyProblem; await fundIt(c2); reset();
    vuln(c2.money_error !== "top-up pi_x may not be recorded — check by hand", `K1 an Order that already has a note for the admin keeps it -> ${c2.money_error}`);
    const c3 = mk();
    hooks.stripe = gone403(ORIGINAL); const g = await fundIt(c3); reset();
    vuln(g.status !== 409 || (g.json && g.json.code) !== "freelancer_not_ready" || !/Payout details under Settings/.test(g.json && g.json.error || "") || c3.money_error, `K1 Stripe confirms the freelancer's account is gone -> ${g.status} ${g.json && g.json.error} (${g.json && g.json.code}); no note: ${!c3.money_error}`);
    for (const [name, hook, says] of [
      ["Stripe not answering", (path) => { if (path === `/accounts/${ORIGINAL}`) throw new Error("network down"); return null; }, "Stripe did not answer"],
      ["a Stripe outage (500)", (path) => path === `/accounts/${ORIGINAL}` ? [500, { error: { type: "api_error", message: "Something went wrong on Stripe's end" } }] : null, "Stripe had a problem on its side"],
      ["Stripe refusing Cuvori's secret key (401)", keyRefused, "Stripe refused Cuvori's secret key"],
      ["too many requests (429)", (path) => path === `/accounts/${ORIGINAL}` ? [429, { error: { type: "invalid_request_error", code: "rate_limit", message: "Too many requests" } }] : null, "Stripe was busy (too many requests)"],
    ]) {
      const c4 = mk(); hooks.stripe = hook; const x = await fundIt(c4); reset();
      vuln(x.status !== 500 || (x.json && x.json.error) !== `Something went wrong (ref ${refOf(c4.money_error)})` || c4.money_error !== `Stripe check failed: ${says} (Netlify log ref ${refOf(c4.money_error)})` || leaks(c4.money_error),
        `K1 ${name}, the client clicks Fund -> ${x.status} ${x.json && x.json.error}; note: ${c4.money_error}`);
    }
    // Cuvori's database failing while the freelancer's account is read: said plainly, the database's own text is not copied
    const c5 = mk();
    hooks.db = async (method, table) => method === "GET" && table === "payout_details" ? new Response(JSON.stringify({ message: "connection reset by peer at 10.0.3.7" }), { status: 503 }) : null;
    const d5 = await fundIt(c5); reset();
    vuln(d5.status !== 500 || c5.money_error !== `Stripe check failed: Cuvori's database had a problem (Netlify log ref ${refOf(c5.money_error)})` || leaks(c5.money_error) || !inLog(c5.money_error, "connection reset"),
      `K1 Cuvori's database failing during the check -> ${d5.status} ${d5.json && d5.json.error}; note: ${c5.money_error}`);
  }
  console.error = realError;
  // ---------- K2: releases: the real reason on the Order, gone once it is paid out ----------
  {
    const c = mk(); await fund(fx, c); c.status = "delivered";
    hooks.stripe = keyProblem;
    const r = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
    reset();
    vuln(r.status !== 500 || !String(c.money_error || "").startsWith("Stripe check failed: Cuvori's Stripe key is missing a permission (Netlify log ref ") || leaks(c.money_error) || c.status !== "delivered",
      `K2 Cuvori's key problem, the client clicks Approve & release -> ${r.status} ${r.json && r.json.error}; Order ${c.status}, note: ${c.money_error}`);
    const ok = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
    vuln(ok.status !== 200 || c.status !== "completed" || c.money_error, `K2 once fixed -> release ${ok.status}, Order ${c.status}, note gone: ${!c.money_error}`);
    const d = mk(); await fund(fx, d); d.status = "delivered"; d.auto_release_at = past(1); onlyDue(d);
    hooks.stripe = keyProblem;
    const a = await call(fx.autoRelease, req("POST", "x", {}));
    reset();
    const why = ((a.json && a.json.failures) || []).find(f => f.id === d.id);
    vuln(!why || !/required permissions/.test(why.why) || !String(d.money_error || "").startsWith("Stripe check failed: Cuvori's Stripe key is missing a permission (Netlify log ref ") || leaks(d.money_error) || d.status !== "delivered",
      `K2 the hourly automatic release with Cuvori's key problem -> reason in the log: ${why && why.why}; note on the Order: ${d.money_error}`);
    await call(fx.autoRelease, req("POST", "x", {}));
    vuln(d.status !== "completed" || d.money_error, `K2 once fixed, the next hourly run pays out -> Order ${d.status}, note gone: ${!d.money_error}`);
  }
  const NEEDED = /^Stripe account check: the freelancer's Stripe account needs a check by hand \(Netlify log ref [0-9a-f]{8}\)$/;
  // ---------- K5: the page's "ready" mark follows what Stripe says, so the Fund button and the refusal agree ----------
  // The page shows the Fund button by the database's mark (editor_can_receive). Stripe normally keeps it current through the
  // account webhook; when that update never arrived, the check at Fund puts it right, in the mode's own column only.
  {
    const c = mk(); const pages = Object.keys(STRIPE.sessions).length;
    STRIPE.accounts[ORIGINAL].payouts_enabled = false; row().stripe_payouts_enabled = true; row().stripe_live_payouts_enabled = true;
    const r = await fundIt(c);
    vuln(r.status !== 409 || (r.json && r.json.code) !== "freelancer_not_ready" || row().stripe_payouts_enabled !== false || row().stripe_live_payouts_enabled !== true || Object.keys(STRIPE.sessions).length !== pages || c.money_error,
      `K5 Stripe stopped the freelancer's payouts, the webhook never came, the client clicks Fund -> ${r.status} ${r.json && r.json.code}; test mark now ${row().stripe_payouts_enabled}, live mark untouched: ${row().stripe_live_payouts_enabled === true}; no Stripe page: ${Object.keys(STRIPE.sessions).length === pages}; no note: ${!c.money_error}`);
    STRIPE.accounts[ORIGINAL].payouts_enabled = true;                 // Stripe is happy again, the mark still says no
    const ok = await fundIt(c);
    vuln(ok.status !== 200 || row().stripe_payouts_enabled !== true, `K5 once Stripe allows payouts again -> Fund ${ok.status}; the mark follows: ${row().stripe_payouts_enabled}`);
    // the write names the freelancer and the very account the check looked at, so an account saved a moment later keeps its own mark
    const other = newAccount({ payouts_enabled: false }); const saved = row().stripe_account_id; row().stripe_account_id = other;
    const n0 = urls.length; await fundIt(mk());
    const writes = urls.slice(n0).filter(u => u.startsWith("PATCH ") && u.includes("/payout_details?")).map(u => decodeURIComponent(u));
    row().stripe_account_id = saved; row().stripe_payouts_enabled = true; delete row().stripe_live_payouts_enabled;
    vuln(writes.length !== 1 || !writes[0].includes(`id=eq.${users.ed.id}`) || !writes[0].includes(`stripe_account_id=eq.${other}`), `K5 the mark is written for the freelancer and the account the check looked at only -> ${writes.length ? writes.join(" | ") : "no write"}`);
    // Stripe confirms the saved account is gone: the mark says no, but the account stays saved (only Payout details sets one aside, and only in test mode)
    const hist = JSON.stringify(row().stripe_account_history || []);
    hooks.stripe = gone403(ORIGINAL); const g = await fundIt(mk()); reset();
    vuln(g.status !== 409 || row().stripe_payouts_enabled !== false || row().stripe_account_id !== ORIGINAL || JSON.stringify(row().stripe_account_history || []) !== hist,
      `K5 Stripe says the saved account is gone -> Fund ${g.status}; mark now ${row().stripe_payouts_enabled}; account still saved: ${row().stripe_account_id === ORIGINAL}; history untouched: ${JSON.stringify(row().stripe_account_history || []) === hist}`);
    row().stripe_payouts_enabled = true;
    // the saved account belongs to someone else: the same
    STRIPE.accounts[ORIGINAL].metadata.cuvori_user = users.ed2.id; const o = await fundIt(mk()); STRIPE.accounts[ORIGINAL].metadata.cuvori_user = users.ed.id;
    vuln(o.status !== 409 || row().stripe_payouts_enabled !== false || row().stripe_account_id !== ORIGINAL, `K5 the saved account belongs to someone else -> Fund ${o.status}; mark now ${row().stripe_payouts_enabled}; account still saved: ${row().stripe_account_id === ORIGINAL}`);
    row().stripe_payouts_enabled = true;
    // a mark that says yes with nothing saved (only possible by hand): put right too
    row().stripe_account_id = null; const n = await fundIt(mk()); row().stripe_account_id = ORIGINAL;
    vuln(n.status !== 409 || row().stripe_payouts_enabled !== false, `K5 a "ready" mark with no account saved -> Fund ${n.status}; mark now ${row().stripe_payouts_enabled}`);
    row().stripe_payouts_enabled = true;
    // one rule everywhere: the transfers capability not active while Stripe's two flags say yes -> Fund, Payout details,
    // the account webhook and the mark all say "not ready", none of them "ready"
    STRIPE.accounts[ORIGINAL].capabilities.transfers = "pending";
    const f1 = await fundIt(mk()); const m1 = row().stripe_payouts_enabled;
    row().stripe_payouts_enabled = true; const g1 = await connect("GET"); const m2 = row().stripe_payouts_enabled;
    row().stripe_payouts_enabled = true;
    const w1 = await call(fx.webhook, req("POST", "x", signed({ type: "account.updated", data: { object: { id: ORIGINAL } } }))); const m3 = row().stripe_payouts_enabled;
    STRIPE.accounts[ORIGINAL].capabilities.transfers = "active"; row().stripe_payouts_enabled = true;
    vuln(f1.status !== 409 || (f1.json && f1.json.code) !== "freelancer_not_ready" || m1 !== false || g1.status !== 200 || g1.json.payouts_enabled !== false || m2 !== false || w1.status !== 200 || m3 !== false,
      `K5 the transfers capability not active, Stripe's two flags yes -> Fund ${f1.status} ${f1.json && f1.json.code}, mark ${m1}; Payout details says ready: ${g1.json && g1.json.payouts_enabled}, mark ${m2}; after the webhook mark ${m3} (all must say not ready)`);
  }
  // ---------- K6: two checks of the same Order overlapping: the one that finishes last never wipes out or replaces what the other just found ----------
  {
    const quiet = console.error; console.error = () => {};
    const OLD_FAILED = "Stripe check failed: Stripe did not answer (Netlify log ref 00000000)";
    const OLD_NEEDED = "Stripe account check: the freelancer's Stripe account needs a check by hand (Netlify log ref 00000000)";
    const during = (inner) => { let once = false; return async (path, method) => {   // while request A waits for Stripe, request B runs on the same Order
      if (path === `/accounts/${ORIGINAL}` && method === "GET" && !once) { once = true; const outer = hooks.stripe; const r = await inner(); hooks.stripe = outer; return r; }
      return null; }; };
    // A reads an old failure note, Stripe is slow for A; meanwhile B fails and writes a newer note; A then succeeds and must not clear B's note
    const c = mk({ money_error: OLD_FAILED }); let b = null;
    hooks.stripe = during(async () => { hooks.stripe = (p2, m2) => p2 === `/accounts/${ORIGINAL}` && m2 === "GET" ? [500, { error: { type: "api_error", message: "Something went wrong on Stripe's end" } }] : null; b = await fundIt(c); return null; });
    const a = await fundIt(c); reset();
    vuln(a.status !== 200 || !b || b.status !== 500 || !/^Stripe check failed: Stripe had a problem on its side \(Netlify log ref [0-9a-f]{8}\)$/.test(c.money_error || ""),
      `K6 an older check succeeds after a newer one failed -> A ${a.status}, B ${b && b.status}; the Order's note: ${c.money_error || "none"} (must still be B's "Stripe had a problem")`);
    // A reads an old "needs a check" note; meanwhile B finds the account belongs to someone else and writes a newer one; A then fails and must not replace it
    const d = mk({ money_error: OLD_NEEDED }); let b2 = null;
    hooks.stripe = during(async () => { STRIPE.accounts[ORIGINAL].metadata.cuvori_user = users.ed2.id; b2 = await fundIt(d); STRIPE.accounts[ORIGINAL].metadata.cuvori_user = users.ed.id;
      return [500, { error: { type: "api_error", message: "Something went wrong on Stripe's end" } }]; });
    const a2 = await fundIt(d); reset(); row().stripe_payouts_enabled = true;
    vuln(a2.status !== 500 || !b2 || b2.status !== 409 || !NEEDED.test(d.money_error || "") || d.money_error === OLD_NEEDED,
      `K6 an older check fails after a newer one found the account belongs to someone else -> A ${a2.status}, B ${b2 && b2.status}; the Order's note: ${d.money_error || "none"} (must still be B's "needs a check by hand")`);
    console.error = quiet;
  }
  // ---------- K7: a broken answer from the database never passes for a real one ----------
  // "Is this freelancer banned?" reads one row. The database always answers in JSON; an answer that isn't (something in
  // between replaced it, or it was cut off), a row without the yes/no, or a yes/no that isn't one must stop the payment —
  // never count as "not banned". The real answers keep working exactly as before.
  {
    const quiet = console.error; console.error = () => {};
    const dbSays = (body, status = 200) => async (method, table, search) => method === "GET" && table === "profiles" && String(search).includes(users.ed.id)   // the freelancer's row only
      ? new Response(body, { status, headers: { "content-type": "application/json" } }) : null;
    for (const [name, body, want, code] of [
      ["a success answer that isn't JSON (a proxy's HTML page)", "<html><body>Bad gateway</body></html>", 500, "server_error"],
      ["a cut-off answer", '[{"banned":fa', 500, "server_error"],
      ["a row without the banned mark", "[{}]", 500, "server_error"],
      ["a banned mark that isn't yes or no", '[{"banned":"false"}]', 500, "server_error"],
      ["one object instead of a list", '{"banned":false}', 500, "server_error"],
      ["banned: true", '[{"banned":true}]', 409, "freelancer_unavailable"],
      ["banned: false", '[{"banned":false}]', 200, undefined],
      ["no profile at all", "[]", 409, "freelancer_unavailable"],
    ]) {
      const c = mk(); const pages = Object.keys(STRIPE.sessions).length;
      hooks.db = dbSays(body); const r = await fundIt(c); reset();
      vuln(r.status !== want || (r.json && r.json.code) !== code || (want !== 200 && Object.keys(STRIPE.sessions).length !== pages),
        `K7 the database answers ${name} -> Fund ${r.status} ${r.json && r.json.code || ""} (must be ${want}${code ? " " + code : ""})`);
    }
    // the same broken answer while the Order itself is read: "something went wrong", not a made-up "not your order"
    const c2 = mk(); hooks.db = async (method, table) => method === "GET" && table === "contracts" ? new Response("<html>oops</html>", { status: 200 }) : null;
    const r2 = await fundIt(c2); reset();
    vuln(r2.status !== 500 || (r2.json && r2.json.code) !== "server_error", `K7 the database answers with a non-JSON page while the Order is read -> Fund ${r2.status} ${r2.json && r2.json.error}`);
    // a real database error (status 503) still stops the payment as before, and a check that fails this way is noted on the Order
    const c3 = mk(); hooks.db = async (method, table) => method === "GET" && table === "payout_details" ? new Response("<html>oops</html>", { status: 200 }) : null;
    const r3 = await fundIt(c3); reset();
    vuln(r3.status !== 500 || !/^Stripe check failed: Cuvori's database had a problem \(Netlify log ref [0-9a-f]{8}\)$/.test(c3.money_error || ""),
      `K7 a non-JSON page while the freelancer's saved account is read -> Fund ${r3.status}; note: ${c3.money_error || "none"}`);
    console.error = quiet;
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
    vuln(f.status !== 503 || !/belong to a different Stripe account/.test(f.json && f.json.error || "") || (f.json && f.json.code) !== "payments_paused" || g.status !== 503 || p.status !== 503
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
  // ---------- M1: keys and database in different modes say "paused", even when the freelancer has nothing saved yet ----------
  {
    const keep = row().stripe_account_id; row().stripe_account_id = null;
    setMode("live");
    const n0 = urls.length;
    const f = await fundIt(mk());
    const calls = urls.slice(n0).filter(u => u.includes("api.stripe.com")).length;
    row().stripe_account_id = keep; setMode("test");
    vuln(f.status !== 503 || (f.json && f.json.code) !== "payments_paused" || calls,
      `M1 test keys, database in live mode, the freelancer has nothing saved -> Fund ${f.status} ${f.json && f.json.error}; Stripe calls: ${calls} (must say payments are paused, not "ask the freelancer")`);
  }
  // ---------- M2: a saved account that belongs to someone else: the client is told "not ready", the admin gets a note ----------
  {
    const c = mk();
    STRIPE.accounts[ORIGINAL].metadata.cuvori_user = users.ed2.id;
    const r = await fundIt(c);
    STRIPE.accounts[ORIGINAL].metadata.cuvori_user = users.ed.id;
    vuln(r.status !== 409 || !NEEDED.test(c.money_error || "") || leaks(c.money_error), `M2 the saved Stripe account belongs to someone else, the client clicks Fund -> ${r.status}; note for the admin: ${c.money_error}`);
    const ok = await fundIt(c);
    vuln(ok.status !== 200 || c.money_error, `M2 once it is sorted out -> Fund ${ok.status}; the note is gone: ${!c.money_error}`);
  }
  // ---------- M3: a test account Stripe says is gone is the normal "set up again" case: no note ----------
  {
    const c = mk(); hooks.stripe = gone403(ORIGINAL); const r = await fundIt(c); reset();
    vuln(r.status !== 409 || c.money_error, `M3 a test-mode account Stripe says is gone -> Fund ${r.status}; note: ${c.money_error || "none"} (none: the freelancer just sets up again)`);
  }
  // ---------- M4: the database is switched to live a moment before a test payment: the payment is not taken or counted ----------
  {
    const c = mk();
    const f = await fundIt(c);                                         // a payment page made in test mode
    DB.site_settings.find(x => x.key === "stripe_mode").value = "live";  // the database switched; this copy still remembers "test" (under a minute ago)
    const s = pay(c.stripe_checkout_id);                               // the client pays with a test card
    const w = await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: s } })));
    const hold = STRIPE.intents[s.payment_intent].status;
    setMode("test");
    vuln(f.status !== 200 || w.status === 200 || c.status !== "accepted" || c.funded_cents || hold !== "requires_capture",
      `M4 the database switched to live just before a test payment -> webhook ${w.status}; Order ${c.status}, paid in ${c.funded_cents || 0}; card hold ${hold} (must be neither taken nor counted)`);
  }
  // ---------- M5: the hourly run: "Stripe check" notes on unpaid Orders leave after a day, nothing else is touched ----------
  {
    const old = new Date(Date.now() - 25 * 3600e3).toISOString(), recent = new Date(Date.now() - 3600e3).toISOString();
    const a = mk({ money_error: "Stripe check failed: Stripe did not answer (Netlify log ref 1a2b3c4d)", money_error_at: old });
    const b = mk({ money_error: "Stripe account check: the freelancer's Stripe account needs a check by hand (Netlify log ref 2b3c4d5e)", money_error_at: null });
    const k = mk({ money_error: "Stripe check failed: Stripe did not answer (Netlify log ref 5e6f7a8b)", money_error_at: recent });
    const other = mk({ money_error: "top-up pi_x may not be recorded — check by hand", money_error_at: old });
    const paidIn = mk({ status: "funded", funded_cents: 10000, money_error: "Stripe check failed: Stripe did not answer (Netlify log ref 9c9c9c9c)", money_error_at: old });
    await call(fx.autoRelease, req("POST", "x", {}));
    const st = (o) => o.money_error ? "kept" : "gone";
    const legacy = mk({ money_error: "Stripe check failed: Stripe did not answer (Netlify log ref 3c4d5e6f)", money_error_at: null });
    await call(fx.autoRelease, req("POST", "x", {}));
    vuln(a.money_error || legacy.money_error || !b.money_error || !k.money_error || !other.money_error || !paidIn.money_error,
      `M5 the hourly run -> unpaid Order, "check failed" over a day old: ${st(a)}; from before notes had a time: ${st(legacy)}; "account needs a check" (needs a person): ${st(b)}; an hour old: ${st(k)}; another kind of note: ${st(other)}; a paid Order: ${st(paidIn)} (only the first two may go)`);
  }

  // ---------- N1: a funded Order remembers the mode its money was paid in ----------
  {
    const c = mk(); await fund(fx, c);
    vuln(c.status !== "funded" || c.paid_mode !== "test", `N1 a client pays an Order in test mode -> Order ${c.status}, paid in ${c.paid_mode} mode (must say test)`);
  }
  // ---------- N2: test and live switched while a payment is being recorded: it goes back to the card, the Order stays unpaid ----------
  {
    const c = mk(); await fundIt(c);
    const s = pay(c.stripe_checkout_id);
    hooks.db = async (method, table, search, body) => { if (method === "PATCH" && table === "contracts" && String(body || "").includes('"status":"funded"') && hooks.db) { DB.site_settings.find(x => x.key === "stripe_mode").value = "live"; hooks.db = null; } return null; };
    const w = await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: s } })));
    reset(); setMode("test");
    const back = STRIPE.refunds.filter(r => r.payment_intent === s.payment_intent).reduce((a, r) => a + r.amount, 0);
    vuln(c.status !== "accepted" || c.funded_cents || back <= 0, `N2 the owner switches to live while a test payment is being recorded -> webhook ${w.status}; Order ${c.status}, paid in ${c.funded_cents || 0}; given back to the card: ${back} (must be unpaid, the money back)`);
  }
  // ---------- N5: the newest note replaces the check's own older one (current reason and time), never another note ----------
  {
    const c = mk({ money_error: "Stripe check failed: Stripe did not answer (Netlify log ref 1a2b3c4d)" });
    const notMine = () => { STRIPE.accounts[ORIGINAL].metadata.cuvori_user = users.ed2.id; }, mine = () => { STRIPE.accounts[ORIGINAL].metadata.cuvori_user = users.ed.id; };
    notMine(); const r = await fundIt(c); mine();
    vuln(r.status !== 409 || !NEEDED.test(c.money_error || ""), `N5 an older "Stripe did not answer" note, and now the saved account isn't the freelancer's -> Fund ${r.status}; the note: ${c.money_error} (must give the newer reason)`);
    const before = c.money_error;
    notMine(); await fundIt(c); mine();
    vuln(!NEEDED.test(c.money_error || "") || c.money_error === before, `N5 the same problem again -> the note is renewed (new ref, so its time is current): ${c.money_error !== before}`);
    const d = mk({ money_error: "top-up pi_x may not be recorded — check by hand" });
    notMine(); await fundIt(d); mine();
    vuln(d.money_error !== "top-up pi_x may not be recorded — check by hand", `N5 an Order with another kind of note keeps it -> ${d.money_error}`);
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
    vuln(f.status !== 503 || !/Payments are paused: the Stripe keys are for live mode, but the database is set to test mode/.test(f.json && f.json.error || "") || (f.json && f.json.code) !== "payments_paused" || stripeCalls,
      `L4 live keys, database still in test mode (launch-day step not done) -> Fund ${f.status} ${f.json && f.json.error}; Stripe calls: ${stripeCalls}`);
  }
  // ---------- L5: the same with a freelancer who has no live account yet: still "paused", never "ask the freelancer" ----------
  {
    const keep = row().stripe_live_account_id; row().stripe_live_account_id = null;
    const n0 = urls.length;
    const f = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: mk().id } }));
    const calls = urls.slice(n0).filter(u => u.includes("api.stripe.com")).length;
    row().stripe_live_account_id = keep;
    vuln(f.status !== 503 || (f.json && f.json.code) !== "payments_paused" || calls, `L5 live keys, database in test mode, freelancer without a live account -> Fund ${f.status} ${f.json && f.json.error}; Stripe calls: ${calls}`);
  }
  // ---------- L6: a live account Stripe says is gone: the client is told "not ready", the admin gets a note ----------
  {
    setMode("live");
    const live = row().stripe_live_account_id, c = mk();
    hooks.stripe = gone403(live);
    const r = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
    reset();
    const NEEDED = /^Stripe account check: the freelancer's Stripe account needs a check by hand \(Netlify log ref [0-9a-f]{8}\)$/;
    vuln(r.status !== 409 || !NEEDED.test(c.money_error || ""), `L6 Stripe can't find the freelancer's live account, the client clicks Fund -> ${r.status}; note for the admin: ${c.money_error}`);
    const ok = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
    vuln(ok.status !== 200 || c.money_error, `L6 once the live account is found again -> Fund ${ok.status}; the note is gone: ${!c.money_error}`);
  }
  // ---------- N3: live keys never pay out an Order whose money was paid in test mode ----------
  {
    const c = mk({ status: "delivered", funded_cents: 10000, stripe_payment_intent: "pi_testmodeAAAAAAAA", paid_mode: "test" });
    const n0 = STRIPE.transfers.length;
    const r = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
    vuln(r.status !== 409 || (r.json && r.json.code) !== "other_mode" || STRIPE.transfers.length !== n0, `N3 live keys, an Order paid in test mode, the client clicks Approve & release -> ${r.status} ${r.json && r.json.code}; transfers made: ${STRIPE.transfers.length - n0} (must be none)`);
  }
  // ---------- N4: and take no real top-up into it ----------
  {
    const c = mk({ status: "funded", funded_cents: 5000, amount_cents: 10000, stripe_payment_intent: "pi_testmodeBBBBBBBB", paid_mode: "test" });
    const pages = Object.keys(STRIPE.sessions).length;
    const r = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
    vuln(r.status !== 409 || (r.json && r.json.code) !== "other_mode" || Object.keys(STRIPE.sessions).length !== pages, `N4 live keys, the client pays the agreed increase on an Order paid in test mode -> ${r.status} ${r.json && r.json.code}; payment page made: ${Object.keys(STRIPE.sessions).length !== pages}`);
  }
}

console.log(out.join("\n"));
if (!LIVE) {
  const bad = out.filter(l => l.startsWith("VULNERABLE")).length;
  console.log(`\n${bad} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
  process.exit(bad ? 1 : 0);
}
