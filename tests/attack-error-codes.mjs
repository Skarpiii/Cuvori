// Three refusals the person reads in their own language. "The card payment is still settling", "the freelancer's Stripe
// account is not ready" and "a card chargeback is open" were sent to the page as an English sentence with no code, so the
// page showed that sentence as it was: a client using Cuvori in Lithuanian or German who pressed Release, a freelancer who
// pressed Cancel & refund, or the admin deciding a dispute read English. Now every copy of these three refusals carries a
// code the page translates ("settling", "freelancer_not_ready", "chargeback_open"); the English sentence stays for the
// Order's note and the admin. The page has the words in all 7 languages.
// E1 release while the money is still settling, E2 a refund while it is still settling, E3 the freelancer's account
// can't take the payout, E4 the account check before a release (whole Order and milestone), E5 a chargeback open (release,
// cancel, decision), E6 a refund Stripe refuses because the payment was charged back, E7 the page's words in 7 languages,
// E8 what stays as it was.
// Every other refusal a person can get from Release, Cancel & refund, the return from the payment page and Payout details
// was sent the same way, as an English sentence with no code ("The order changed a moment ago", "Not enough money is held
// for this milestone", "This milestone was just changed", "Another payment step on this order is still running", …). Now
// each one carries a code too, and the page has its words in all 7 languages:
// E9 signed out, E10 a suspended account, E11 someone else's Order, E12 nothing to release, E13 the Order under review
// (the freelancer was banned), E14 an Order paid out milestone by milestone, E15 an agreed price increase not paid yet,
// E16 a payment that has just come in, E17 the Order changed a moment ago, E18 an Order that can't be cancelled,
// E19 another payment step still running, E20 not enough money held for a milestone, E21 a milestone that changed,
// E22 Stripe not answering, E23 Payout details for someone who is not a professional, E24 a Stripe connection that needs a
// check, E25 a Stripe setup that changed a moment ago, E26 payments not set up, E27 the page's words for every code,
// E28 no refusal left without a code.
// Run: node tests/attack-error-codes.mjs
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ---------- the child for E26: the functions started with no webhook secret set in Netlify (payments not set up) ----------
if (process.env.CODES_CHILD) {
  const H = await import("./fn-harness.mjs");
  delete process.env.STRIPE_WEBHOOK_SECRET;                                // read once, when the functions start
  for (const k of ["error", "warn", "log", "info"]) console[k] = () => {};
  const fx = await H.fns(); const c = H.mk({ status: "delivered", funded_cents: 10000 });
  const body = { contract_id: c.id };
  const answers = {
    release: await H.call(fx.release, H.req("POST", "x", { token: "tok_cl", body })), cancel: await H.call(fx.cancel, H.req("POST", "x", { token: "tok_ed", body })),
    confirm: await H.call(fx.confirm, H.req("POST", "x", { token: "tok_cl", body })), payoutDetails: await H.call(fx.connect, H.req("GET", "x", { token: "tok_ed" })),
    connect: await H.call(fx.connect, H.req("POST", "x", { token: "tok_ed", body: {} })) };
  process.stdout.write("@@RESULT@@" + JSON.stringify(Object.fromEntries(Object.entries(answers).map(([k, r]) => [k, { status: r.status, json: r.json }]))));
  process.exit(0);
}

import { DB, STRIPE, hooks, req, call, mk, reset, fns, fund, uuid, users, pay, F } from "./fn-harness.mjs";
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const fx = await fns();
const said = (r) => `${r.status} ${JSON.stringify(r.json)}`;
const coded = (r, code) => r.status === 409 && r.json && r.json.code === code && typeof r.json.error === "string" && r.json.error.length > 0;
const stripeSays = (path, status, error) => { hooks.stripe = async (p, method) => (p === path && method === "POST") ? [status, { error }] : null; };
const funded = async (extra) => { const c = mk({ amount_cents: 10000, ...(extra || {}) }); await fund(fx, c); c.status = "delivered"; return c; };
const SETTLING = { type: "invalid_request_error", code: "balance_insufficient", message: "You have insufficient available funds in your Stripe account." };

{ // E1 the client presses Release while the card payment is still settling at Stripe
  const c = await funded(); stripeSays("/transfers", 400, SETTLING);
  const r = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  vuln(!coded(r, "settling") || c.status !== "releasing", `E1 Release while the money is still settling -> ${said(r)}; Order ${c.status} (must carry the code "settling"; the Order waits in "releasing" for the hourly run)`);
  reset();
}
{ // E2 the freelancer gives the money back while the payment is still settling
  const c = await funded(); stripeSays("/refunds", 400, SETTLING);
  const r = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id } }));
  vuln(!coded(r, "settling"), `E2 Cancel & refund while the money is still settling -> ${said(r)} (must carry the code "settling")`);
  reset();
}
{ // E3 Stripe refuses the payout: the freelancer's account can't take transfers
  const c = await funded(); stripeSays("/transfers", 400, { type: "invalid_request_error", code: "insufficient_capabilities_for_transfer", message: "Your destination account needs to have at least one of the following capabilities enabled: transfers" });
  const r = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  vuln(!coded(r, "freelancer_not_ready"), `E3 Release when Stripe says the freelancer's account can't take it -> ${said(r)} (must carry the code "freelancer_not_ready")`);
  reset();
}
{ // E4 the account check before a release: the freelancer's Stripe account can't receive payouts right now
  const acct = STRIPE.accounts.acct_1EditorAAAAAAAA, was = acct.payouts_enabled;
  const c = await funded(); acct.payouts_enabled = false;
  const r = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  acct.payouts_enabled = was; reset();
  const d = await funded({ has_milestones: true }); const m = { id: uuid(), order_id: d.id, title: "Part 1", amount_cents: 10000, status: "submitted", position: 1 }; DB.order_milestones.push(m);
  acct.payouts_enabled = false;
  const rm = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: d.id, milestone_id: m.id } }));
  acct.payouts_enabled = was;
  vuln(!coded(r, "freelancer_not_ready") || !coded(rm, "freelancer_not_ready"), `E4 Release when the freelancer's account isn't ready -> whole Order ${said(r)}; one milestone ${said(rm)} (both must carry the code "freelancer_not_ready")`);
  reset();
}
{ // E5 a card chargeback is open on the Order: Release, Cancel & refund and the admin's decision all wait for the bank
  const c = await funded(); Object.assign(c, { chargeback_status: "open", chargeback_id: "dp_E5" });
  const rel = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const can = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id } }));
  c.status = "disputed";
  const dec = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "refund" } }));
  vuln(!coded(rel, "chargeback_open") || !coded(can, "chargeback_open") || !coded(dec, "chargeback_open"),
    `E5 a chargeback is open -> Release ${said(rel)}; Cancel & refund ${said(can)}; the admin's decision ${said(dec)} (each must carry the code "chargeback_open")`);
  reset();
}
{ // E6 the refund is refused by Stripe because the payment was charged back meanwhile
  const c = await funded(); stripeSays("/refunds", 400, { type: "invalid_request_error", code: "charge_disputed", message: "Charge ch_x has been charged back; cannot issue a refund." });
  const r = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id } }));
  vuln(!coded(r, "chargeback_open"), `E6 Cancel & refund when Stripe says the payment was charged back -> ${said(r)} (must carry the code "chargeback_open")`);
  reset();
}
{ // E7 the page has the words for the three codes, in all 7 languages, and uses them on every button (not only Fund)
  const root = process.env.TARGET || new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const page = fs.readFileSync(root + "/index.html", "utf8");
  const count = (key) => (page.match(new RegExp(`\\b${key}:"[^"]+"`, "g")) || []).length;
  const plain = (page.match(/function fnPlain\(e,pay\)\{[\s\S]*?\n  \}/) || [""])[0];
  const maps = { settling: /e\.code==="settling"\)\s*return t\("es_settling"\)/.test(plain), chargeback: /e\.code==="chargeback_open"&&!pay\)\s*return t\("fn_chargebackOpen"\)/.test(plain), notReady: /e\.code==="freelancer_not_ready"\)\s*return t\(pay\?"o_flNotReady":"fn_flNotReady"\)/.test(plain) };
  vuln(count("es_settling") !== 7 || count("fn_chargebackOpen") !== 7 || count("fn_flNotReady") !== 7 || !maps.settling || !maps.chargeback || !maps.notReady,
    `E7 the page's words: es_settling ${count("es_settling")}, fn_chargebackOpen ${count("fn_chargebackOpen")}, fn_flNotReady ${count("fn_flNotReady")} languages (each must be 7); used for the codes: ${JSON.stringify(maps)}`);
}
{ // E8 what stays as it was: a normal release and a normal cancel; the Order's note keeps Cuvori's English sentence for the admin
  const c = await funded();
  const r = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const d = await funded();
  const k = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: d.id } }));
  const e = await funded(); stripeSays("/transfers", 400, SETTLING);
  await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: e.id } })); reset();
  vuln(r.status !== 200 || c.status !== "completed" || k.status !== 200 || d.status !== "refunded" || !/still settling/.test(String(e.money_error)),
    `E8 normal: Release -> ${r.status}, Order ${c.status}; Cancel & refund -> ${k.status}, Order ${d.status}; the settling Order's note: ${JSON.stringify(e.money_error)} (must be 200 completed, 200 refunded, and the note in Cuvori's words)`);
  reset();
}

// ---------- E9–E28: every other refusal a person can get ----------
const lib = await import(F + "../lib/cuvori.mjs");
const has = (r, status, code) => r.status === status && r.json && r.json.code === code && typeof r.json.error === "string" && r.json.error.length > 0;
const rel = (token, body) => call(fx.release, req("POST", "x", { token, body }));
const can = (token, body) => call(fx.cancel, req("POST", "x", { token, body }));
const msOrder = async (n = 1) => {
  const c = mk({ amount_cents: 10000 * n, has_milestones: true }); await fund(fx, c); c.status = "funded";
  const ms = Array.from({ length: n }, (_, i) => ({ id: uuid(), order_id: c.id, title: `Part ${i + 1}`, amount_cents: 10000, status: "submitted", position: i + 1 }));
  DB.order_milestones.push(...ms); return { c, ms };
};
{ // E9 signed out (or signed in on another account that has gone): every button
  const c = await funded();
  const r = { release: await rel(null, { contract_id: c.id }), cancel: await can(null, { contract_id: c.id }), confirm: await call(fx.confirm, req("POST", "x", { body: { contract_id: c.id } })),
    payoutDetails: await call(fx.connect, req("GET", "x", {})), connect: await call(fx.connect, req("POST", "x", { body: {} })), madeUp: await rel("tok_madeup", { contract_id: c.id }) };
  const wrong = Object.entries(r).filter(([, x]) => !has(x, 401, "signed_out") || x.json.error !== "Sign in first");
  vuln(wrong.length > 0, `E9 signed out -> ${Object.entries(r).map(([k, x]) => `${k} ${x.status} ${x.json && x.json.code}`).join(", ")} (each must be 401 "Sign in first" with the code "signed_out")`);
  reset();
}
{ // E10 a suspended account
  const c = await funded();
  users.cl.banned = true; const r1 = await rel("tok_cl", { contract_id: c.id }); users.cl.banned = false;
  users.ed.banned = true; const r2 = await can("tok_ed", { contract_id: c.id }); const r3 = await call(fx.connect, req("POST", "x", { token: "tok_ed", body: {} })); users.ed.banned = false;
  vuln(!has(r1, 403, "account_suspended") || !has(r2, 403, "account_suspended") || !has(r3, 403, "account_suspended"),
    `E10 a suspended account -> Release ${said(r1)}; Cancel & refund ${said(r2)}; Payout details ${said(r3)} (each must carry the code "account_suspended")`);
  reset();
}
{ // E11 someone else's Order (another account signed in in this browser), or an Order id that is not one
  const c = await funded();
  const r = { release: await rel("tok_cl2", { contract_id: c.id }), cancel: await can("tok_ed2", { contract_id: c.id }),
    confirm: await call(fx.confirm, req("POST", "x", { token: "tok_cl2", body: { contract_id: c.id } })), badId: await rel("tok_cl", { contract_id: "not-an-order" }) };
  vuln(Object.values(r).some(x => x.json?.code !== "not_your_order" || ![400, 403].includes(x.status)),
    `E11 someone else's Order -> ${Object.entries(r).map(([k, x]) => `${k} ${said(x)}`).join("; ")} (each must carry the code "not_your_order")`);
  reset();
}
{ // E12 nothing to release: an Order paid directly, one already completed (a second tab), a milestone of a completed Order, nothing held
  const direct = mk({ payment_mode: "direct", status: "delivered" });
  const done = await funded(); await rel("tok_cl", { contract_id: done.id });
  const { c: msDone, ms } = await msOrder(); msDone.status = "completed";
  const empty = await funded(); empty.released_cents = empty.funded_cents;
  const r = { direct: await rel("tok_cl", { contract_id: direct.id }), again: await rel("tok_cl", { contract_id: done.id }),
    milestone: await rel("tok_cl", { contract_id: msDone.id, milestone_id: ms[0].id }), nothingHeld: await rel("tok_cl", { contract_id: empty.id }) };
  vuln(Object.values(r).some(x => !has(x, 409, "nothing_to_release")), `E12 nothing to release -> ${Object.entries(r).map(([k, x]) => `${k} ${said(x)}`).join("; ")} (each must carry the code "nothing_to_release")`);
  reset();
}
{ // E13 the Order is under review (the freelancer was banned): the client's Release, and the admin's decision that pays out
  const c = await funded(); const d = await funded(); d.status = "disputed";
  users.ed.banned = true;
  const r = await rel("tok_cl", { contract_id: c.id });
  const dec = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: d.id, decision: "release" } }));
  users.ed.banned = false;
  vuln(!has(r, 409, "under_review") || !has(dec, 409, "under_review"), `E13 the freelancer was banned -> Release ${said(r)}; the admin's release decision ${said(dec)} (each must carry the code "under_review")`);
  reset();
}
{ // E14 a whole-Order Release on an Order paid out milestone by milestone
  const { c } = await msOrder();
  const r = await rel("tok_cl", { contract_id: c.id });
  vuln(!has(r, 409, "by_milestone"), `E14 a whole-Order Release on a milestone Order -> ${said(r)} (must carry the code "by_milestone")`);
  reset();
}
{ // E15 an agreed price increase not paid in yet
  const c = await funded(); c.amount_cents = 15000;
  const r = await rel("tok_cl", { contract_id: c.id });
  vuln(!has(r, 409, "topup_unpaid") || c.status !== "delivered", `E15 Release with an agreed price increase not paid yet -> ${said(r)}; Order ${c.status} (must carry the code "topup_unpaid")`);
  reset();
}
{ // E16 a payment for the Order has just come in: the freelancer's Cancel & refund finds a top-up paid on the payment page that
  // the webhook has not recorded yet (Release meets the unpaid increase first; its copy of this refusal is in E28)
  const d = await funded(); d.amount_cents = 15000;
  const page = await call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: d.id } }));
  const paid = pay(d.stripe_checkout_id);
  await lib.stripe("POST", `/payment_intents/${paid.payment_intent}/capture`, {});   // charged; the webhook has not arrived yet
  const k = await can("tok_ed", { contract_id: d.id });
  vuln(page.status !== 200 || !has(k, 409, "payment_came_in") || d.status !== "delivered" || d.funded_cents !== 15000,
    `E16 a payment has just come in -> Cancel & refund ${said(k)}; Order ${d.status} with ${d.funded_cents} paid in (must carry the code "payment_came_in"; the payment is recorded and nothing refunded)`);
  reset();
}
{ // E17 the Order changed a moment ago: Release and Cancel & refund (between reading and claiming it), a settlement that finds it changed
  const changedNow = () => { hooks.db = async (method, table, search) => (method === "PATCH" && table === "contracts" && /status=in\.\(funded,delivered\)/.test(decodeURIComponent(search))) ? new Response("[]", { status: 200, headers: { "content-type": "application/json" } }) : null; };
  const c = await funded(); changedNow(); const r = await rel("tok_cl", { contract_id: c.id }); reset();
  const d = await funded(); changedNow(); const k = await can("tok_ed", { contract_id: d.id }); reset();
  const e = await funded(); e.status = "resolving"; let s;
  try { await lib.settle({ ...e, status: "releasing" }, null, "approve"); s = "went through"; } catch (x) { s = { status: x.status, code: x.code, msg: x.message }; }
  vuln(!has(r, 409, "order_changed") || !has(k, 409, "order_changed") || !s || s.code !== "order_changed" || s.status !== 409,
    `E17 the Order changed a moment ago -> Release ${said(r)}; Cancel & refund ${said(k)}; a settlement ${JSON.stringify(s)} (each must carry the code "order_changed")`);
  reset();
}
{ // E18 an Order that can't be cancelled and refunded: paid directly, nothing held any more, or in a dispute
  const direct = mk({ payment_mode: "direct", status: "delivered" });
  const empty = await funded(); empty.refunded_cents = empty.funded_cents;
  const disputed = await funded(); disputed.status = "disputed";
  const r = { direct: await can("tok_ed", { contract_id: direct.id }), nothingHeld: await can("tok_ed", { contract_id: empty.id }), disputed: await can("tok_ed", { contract_id: disputed.id }) };
  vuln(Object.values(r).some(x => !has(x, 409, "cannot_cancel")), `E18 an Order that can't be cancelled -> ${Object.entries(r).map(([k, x]) => `${k} ${said(x)}`).join("; ")} (each must carry the code "cannot_cancel")`);
  reset();
}
{ // E19 another payment step on the Order is still running (it holds the Order's lock for longer than the wait)
  const c = await funded();
  DB.money_keys.push({ scope: `lock:${c.id}`, key: "claim:held-by-test", created_at: new Date().toISOString() });
  const r = await rel("tok_cl", { contract_id: c.id });
  DB.money_keys.splice(DB.money_keys.findIndex(k => k.scope === `lock:${c.id}`), 1);
  vuln(!has(r, 409, "busy") || c.status !== "releasing", `E19 another payment step is still running -> ${said(r)}; Order ${c.status} (must carry the code "busy"; the hourly run finishes it)`);
  reset();
}
{ // E20 not enough money held for the milestone (part of it went back meanwhile)
  const { c, ms } = await msOrder(); c.refunded_cents = 5000;
  const r = await rel("tok_cl", { contract_id: c.id, milestone_id: ms[0].id });
  vuln(!has(r, 409, "not_enough_held") || ms[0].status !== "submitted", `E20 a milestone when not enough is held -> ${said(r)}; milestone ${ms[0].status} (must carry the code "not_enough_held")`);
  reset();
}
{ // E21 a milestone that changed: removed by an accepted change, already paid out (a second tab), changed between reading and claiming it, of another Order, a made-up id
  const { c, ms } = await msOrder(2); const { c: other, ms: oms } = await msOrder();
  const gone = await rel("tok_cl", { contract_id: c.id, milestone_id: uuid() });
  await rel("tok_cl", { contract_id: c.id, milestone_id: ms[0].id }); const twice = await rel("tok_cl", { contract_id: c.id, milestone_id: ms[0].id });
  hooks.db = async (method, table) => (method === "PATCH" && table === "order_milestones") ? new Response("[]", { status: 200, headers: { "content-type": "application/json" } }) : null;
  const raced = await rel("tok_cl", { contract_id: c.id, milestone_id: ms[1].id }); reset();
  const foreign = await rel("tok_cl", { contract_id: c.id, milestone_id: oms[0].id });
  const badId = await rel("tok_cl", { contract_id: c.id, milestone_id: "nope" });
  const r = { gone, twice, raced, foreign, badId };
  vuln(Object.values(r).some(x => x.json?.code !== "milestone_changed" || ![400, 403, 409].includes(x.status)) || other.released_cents !== 0,
    `E21 a milestone that changed -> ${Object.entries(r).map(([k, x]) => `${k} ${said(x)}`).join("; ")} (each must carry the code "milestone_changed")`);
  reset();
}
{ // E22 Stripe does not answer the payout or the refund
  const down = (path) => { hooks.stripe = async (p, method) => { if (p === path && method === "POST") throw new TypeError("fetch failed"); return null; }; };
  const c = await funded(); down("/transfers"); const r = await rel("tok_cl", { contract_id: c.id }); reset();
  const d = await funded(); down("/refunds"); const k = await can("tok_ed", { contract_id: d.id }); reset();
  vuln(!has(r, 503, "provider_down") || !has(k, 503, "provider_down"), `E22 Stripe does not answer -> Release ${said(r)}; Cancel & refund ${said(k)} (each must carry the code "provider_down")`);
}
{ // E23 Payout details for an account that is not a professional's
  const r = await call(fx.connect, req("POST", "x", { token: "tok_cl", body: {} }));
  vuln(!has(r, 403, "not_professional"), `E23 Payout details for a client account -> ${said(r)} (must carry the code "not_professional")`);
}
{ // E24 a Stripe connection that needs a check by Cuvori support: a saved id that is not an account id, or someone else's account
  const row = DB.payout_details.find(p => p.id === users.ed.id), was = { ...row };
  row.stripe_account_id = "not_an_account"; const r1 = await call(fx.connect, req("POST", "x", { token: "tok_ed", body: {} }));
  Object.assign(row, was);
  const acct = STRIPE.accounts.acct_1EditorAAAAAAAA, meta = acct.metadata; acct.metadata = { cuvori_user: users.ed2.id };
  const r2 = await call(fx.connect, req("GET", "x", { token: "tok_ed" })); acct.metadata = meta;
  vuln(!has(r1, 409, "connect_check") || !has(r2, 409, "connect_check"), `E24 a Stripe connection that needs a check -> a broken saved id ${said(r1)}; someone else's account ${said(r2)} (each must carry the code "connect_check")`);
  reset();
}
{ // E25 the Stripe setup changed a moment ago (a test account Stripe says is gone, and the row changed before it could be set aside)
  const row = DB.payout_details.find(p => p.id === users.ed.id), was = { ...row };
  row.stripe_account_id = "acct_1GoneAtStripeAAA";
  hooks.db = async (method, table) => (method === "PATCH" && table === "payout_details") ? new Response("[]", { status: 200, headers: { "content-type": "application/json" } }) : null;
  const r = await call(fx.connect, req("POST", "x", { token: "tok_ed", body: {} })); reset();
  Object.assign(row, was);
  vuln(!has(r, 409, "setup_changed"), `E25 the Stripe setup changed a moment ago -> ${said(r)} (must carry the code "setup_changed")`);
}
{ // E26 payments not set up (no webhook secret in Netlify): every button says "payments are paused" in the person's language
  const kid = JSON.parse((t => t.slice(t.indexOf("@@RESULT@@") + 10))(execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, CODES_CHILD: "1" }, encoding: "utf8", maxBuffer: 16 << 20 })));
  vuln(Object.values(kid).some(x => !has(x, 503, "payments_paused")), `E26 payments not set up -> ${Object.entries(kid).map(([k, x]) => `${k} ${x.status} ${x.json && x.json.code}`).join(", ")} (each must carry the code "payments_paused")`);
}

// ---------- the codes the functions send, read from the code itself ----------
const root = process.env.TARGET || new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const src = (f) => fs.readFileSync(`${root}/netlify/${f}`, "utf8");
// the calls of a function name in a file, each with its arguments (strings and template literals are skipped over)
function callsOf(text, name) {
  const found = []; const re = new RegExp(`(?<![\\w.])${name}\\(`, "g"); let m;
  while ((m = re.exec(text))) {
    if (/(const|function)\s+$/.test(text.slice(Math.max(0, m.index - 16), m.index))) continue;    // its definition
    let i = m.index + m[0].length, depth = 0, cur = "", args = [], q = null;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (q) { cur += ch; if (ch === "\\") { cur += text[++i]; continue; } if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { q = ch; cur += ch; continue; }
      if ("([{".includes(ch)) depth++;
      if (")]}".includes(ch)) { if (depth === 0) break; depth--; }
      if (ch === "," && depth === 0) { args.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    if (cur.trim()) args.push(cur.trim());
    found.push({ args, line: text.slice(0, m.index).split("\n").length });
  }
  return found;
}
const PEOPLE = ["functions/stripe-release.mjs", "functions/stripe-cancel.mjs", "functions/stripe-confirm.mjs", "functions/stripe-connect.mjs", "functions/stripe-checkout.mjs"];
const LIB = "lib/cuvori.mjs";
const libText = src(LIB);
const consts = Object.fromEntries([...libText.matchAll(/const (PAUSED|SIGNIN_DOWN) = "([a-z_]+)"/g)].map(m => [m[1], m[2]]));
const codeOf = (a) => (/^"([a-z_]+)"$/.exec(a || "") || [])[1] || consts[a] || null;
// the refusals made only for the two dispute notices from Stripe (the webhook and the hourly run), never for a person
const STRIPE_ONLY = [/needs reconciliation/];
const uncoded = [], codes = new Set();
for (const f of PEOPLE) {
  const t = src(f);
  for (const c of callsOf(t, "bad")) if (!(c.args[0] === '"Method not allowed"' && c.args[1] === "405")) uncoded.push(`${f}:${c.line} bad(${c.args.join(", ").slice(0, 70)})`);
  for (const c of callsOf(t, "json")) if (/^[45]\d\d$/.test(c.args[0])) { const m = /code:\s*("[a-z_]+"|[A-Z_]+)/.exec(c.args[1] || ""); if (!m) uncoded.push(`${f}:${c.line} json(${c.args[0]}, …) without a code`); else if (!f.includes("checkout")) codes.add(codeOf(m[1])); }
  for (const c of callsOf(t, "refuse")) { const k = codeOf(c.args[2]); if (!k) uncoded.push(`${f}:${c.line} refuse(…) without a code`); }
  for (const c of callsOf(t, "fail")) { const k = codeOf(c.args[2]); if (!k) uncoded.push(`${f}:${c.line} fail(${(c.args[0] || "").slice(0, 60)})`); else if (!f.includes("checkout")) codes.add(k); }
}
for (const c of callsOf(libText, "fail")) {
  const k = codeOf(c.args[2]);
  if (!k) { if (!STRIPE_ONLY.some(re => re.test(c.args[0]))) uncoded.push(`${LIB}:${c.line} fail(${(c.args[0] || "").slice(0, 70)})`); }
  else if (k !== "amount_out_of_range") codes.add(k);     // the price limits: only the Fund buttons ask for a price, and their own words say it
}
for (const m of libText.matchAll(/code:\s*"([a-z_]+)"/g)) codes.add(m[1]);
{ // E28 no refusal left without a code
  vuln(uncoded.length > 0, `E28 refusals a person can get without a code: ${uncoded.length}${uncoded.length ? " — " + uncoded.slice(0, 40).join("; ") : ""} (must be none)`);
}
{ // E27 the page has words for every code, in all 7 languages, on every button
  const page = fs.readFileSync(root + "/index.html", "utf8");
  const fnSrc = (page.match(/function fnPlain\(e,pay\)\{[\s\S]*?\n  \}/) || [""])[0];
  let plain = null; try { plain = new Function("t", "fill", "isAdmin", fnSrc + "\nreturn fnPlain;")((k) => "KEY:" + k, (s) => s, () => false); } catch {}
  const values = (key) => [...page.matchAll(new RegExp(`\\b${key}:"((?:[^"\\\\]|\\\\.)*)"`, "g"))].map(m => m[1]);
  const missing = [];
  for (const code of [...codes].sort()) {
    const words = plain ? plain({ code, ref: "1a2b3c4d" }, false) : null;
    const key = words && words.startsWith("KEY:") ? words.slice(4) : null;
    const v = key ? values(key) : [];
    if (!key) missing.push(`${code}: no words`);
    else if (v.length !== 7) missing.push(`${code}: ${key} in ${v.length} languages`);
    else if (v.slice(1).some(x => x === v[0])) missing.push(`${code}: ${key} not translated`);
    else if (v.some(x => /montuotoj/i.test(x))) missing.push(`${code}: ${key} uses "montuotojas"`);
    else if (/\b(zalogowany|zalogowana)\b/.test(v[3])) missing.push(`${code}: ${key} speaks to a man or a woman only in Polish`);
  }
  vuln(!plain || missing.length > 0, `E27 the page's words for the ${codes.size} codes the payment buttons can get: ${plain ? (missing.length ? missing.join("; ") : "all there") : "fnPlain not found"} (each must have words in all 7 languages)`);
}

console.log(out.join("\n"));
const bad = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${bad} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(bad ? 1 : 0);
