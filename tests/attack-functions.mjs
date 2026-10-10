// Attack harness for the Cuvori payment functions. Copy of fntest.mjs fakes, extended with:
//  - Stripe idempotency semantics (same key+params -> cached result incl. errors; different params -> 400; in-flight -> 409)
//  - failure / race hooks on Stripe and Supabase calls
//  - a URL log
process.env.STRIPE_SECRET_KEY = "sk_test_fake"; process.env.SUPABASE_SERVICE_ROLE_KEY = "service_fake"; process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake"; process.env.SITE_URL = "https://cuvori.test";
process.env.STRIPE_CONNECT_WEBHOOK_SECRET = " whsec_connect_fake \n";   // pasted with a space and a line break, as can happen in Netlify
import crypto from "node:crypto";
import fs from "node:fs";
const F = (process.env.TARGET || new URL("..", import.meta.url).pathname.replace(/\/$/, "")) + "/netlify/functions/";
console.log("TARGET", F);
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const info = (m) => out.push("info       " + m);
const uuid = () => crypto.randomUUID();
const U = (role, extra = {}) => ({ id: uuid(), email: role + "@t.com", first_name: role, role: role.startsWith("ed") ? "editor" : "client", is_admin: false, banned: false, ...extra });
const users = { ed: U("ed"), cl: U("cl"), adm: U("adm", { is_admin: true }), ed2: U("ed2"), ed3: U("ed3") };
const tokens = { tok_ed: users.ed, tok_cl: users.cl, tok_adm: users.adm, tok_ed2: users.ed2, tok_ed3: users.ed3 };
const conv = uuid();
const DB = { rpc_calls: [], profiles: Object.values(users), user_flags: [], messages: [], contracts: [], order_events: [], order_payments: [], order_milestones: [], money_keys: [], site_settings: [],
  payout_details: [{ id: users.ed.id, methods: [], note: "", stripe_account_id: "acct_1EditorAAAAAAAA", stripe_payouts_enabled: true },
                   { id: users.ed2.id, methods: [], note: "", stripe_account_id: "acct_1VictimBBBBBBBB", stripe_payouts_enabled: true }] };
const STRIPE = { sessions: {}, transfers: [], refunds: [], idem: new Map(), accounts: { acct_1EditorAAAAAAAA: { id: "acct_1EditorAAAAAAAA", payouts_enabled: true, charges_enabled: true, capabilities: { transfers: "active" }, requirements: { currently_due: [] }, metadata: { cuvori_user: users.ed.id } },
                                                                                acct_1VictimBBBBBBBB: { id: "acct_1VictimBBBBBBBB", payouts_enabled: true, charges_enabled: true, capabilities: { transfers: "active" }, requirements: { currently_due: [] }, metadata: { cuvori_user: users.ed2.id } } } };
const hooks = { stripe: null, db: null };
const urls = [];
const tick = () => new Promise(r => setImmediate(r));

function parseFilter(q) { const p = new URLSearchParams(q); const f = []; for (const [k, v] of p) { if (["select", "limit", "order"].includes(k)) continue; const m = v.match(/^(eq|neq|lte|gte|lt|gt|in|is|like)\.(.*)$/); if (m) f.push({ k, op: m[1], v: m[1] === "in" ? m[2].replace(/^\(|\)$/g, "").split(",").map(decodeURIComponent) : m[2] }); } return f; }
const match = (row, f) => f.every(x => x.op === "eq" ? String(row[x.k]) === x.v : x.op === "neq" ? String(row[x.k]) !== x.v : x.op === "in" ? x.v.includes(String(row[x.k])) : x.op === "lte" ? (row[x.k] != null && row[x.k] <= x.v) : x.op === "lt" ? (row[x.k] != null && row[x.k] < x.v) : x.op === "gt" ? (row[x.k] != null && row[x.k] > x.v) : x.op === "like" ? new RegExp("^" + decodeURIComponent(x.v).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(String(row[x.k] ?? "")) : true);
const res = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function stripeHandle(path, method, p) {
  if (path === "/account" && method === "GET") return [200, { id: "acct_1CuvoriPlatformAA", object: "account" }];
  if (path === "/account_links") return [200, { url: "https://connect.stripe.com/setup/" + p.get("account") }];
  if (path.startsWith("/accounts/") && method === "GET") return STRIPE.accounts[path.split("/")[2]] ? [200, STRIPE.accounts[path.split("/")[2]]] : [404, { error: { message: "No such account", code: "resource_missing", type: "invalid_request_error" } }];
  if (path === "/transfers" && method === "GET") return [200, { data: STRIPE.transfers.filter(t => t.transfer_group === p.get("transfer_group")) }];
  if (path === "/refunds" && method === "GET") return [200, { data: STRIPE.refunds.filter(r => r.payment_intent === p.get("payment_intent")) }];
  if (/^\/checkout\/sessions\/[^/]+\/expire$/.test(path)) return [200, {}];
  if (path === "/checkout/sessions") { const id = "cs_" + Math.random().toString(36).slice(2, 8); STRIPE.sessions[id] = { id, url: "https://checkout.stripe.com/" + id, client_reference_id: p.get("client_reference_id"), amounts: [p.get("line_items[0][price_data][unit_amount]"), p.get("line_items[1][price_data][unit_amount]")], params: Object.fromEntries(p) }; return [200, STRIPE.sessions[id]]; }
  if (path.startsWith("/payment_intents/")) return [200, { id: path.split("/")[2], latest_charge: { id: "ch_" + path.split("/")[2] } }];
  if (path === "/transfers") { const t = { id: "tr_" + Math.random().toString(36).slice(2, 8), amount: +p.get("amount"), destination: p.get("destination"), contract: p.get("metadata[contract_id]"), metadata: { contract_id: p.get("metadata[contract_id]") }, transfer_group: p.get("transfer_group"), source_transaction: p.get("source_transaction") }; STRIPE.transfers.push(t); return [200, t]; }
  if (path === "/refunds") { const r = { id: "re_" + Math.random().toString(36).slice(2, 8), amount: +p.get("amount"), contract: p.get("metadata[contract_id]"), metadata: { contract_id: p.get("metadata[contract_id]") }, payment_intent: p.get("payment_intent"), status: "succeeded" }; STRIPE.refunds.push(r); return [200, r]; }
  return [404, { error: { message: "unknown " + path } }];
}

globalThis.fetch = async (url, init = {}) => {
  urls.push((init.method || "GET") + " " + url);
  await tick();
  const u = new URL(url); const method = init.method || "GET"; const body = init.body;
  if (u.hostname === "api.stripe.com") {
    const p = new URLSearchParams(method === "GET" ? u.search : (body || "")); const path = u.pathname.replace("/v1", "");
    const key = init.headers["Idempotency-Key"];
    if (key && method === "POST") {
      const prev = STRIPE.idem.get(key);
      if (prev && prev.inflight) return res(409, { error: { type: "idempotency_error", message: "There is currently another in-progress request using this Stripe-Idempotency-Key" } });
      if (prev && prev.body !== body) return res(400, { error: { type: "idempotency_error", message: "Keys for idempotent requests can only be used with the same parameters they were first used with." } });
      if (prev) return res(prev.status, prev.data);
      STRIPE.idem.set(key, { inflight: true, body });
    }
    let status, data;
    try {
      const h = hooks.stripe && await hooks.stripe(path, method, p);
      [status, data] = h || stripeHandle(path, method, p);
    } finally { await tick(); }
    if (key && method === "POST") STRIPE.idem.set(key, { body, status, data });
    return res(status, data);
  }
  if (u.pathname === "/auth/v1/user") { const t = (init.headers.Authorization || "").replace("Bearer ", ""); return tokens[t] ? res(200, tokens[t]) : res(403, { code: 403, error_code: "bad_jwt", msg: "invalid JWT" }); }
  if (u.pathname.startsWith("/rest/v1/rpc/")) { const fn = u.pathname.split("/")[4], args = JSON.parse(body); DB.rpc_calls.push({ fn, args });
    if (fn === "rate_limit_tries") return res(200, "ok");     // the limit on tries (schema v31) is tested in attack-rate.mjs; here every try is let through
    if (fn === "order_quote") { const p = args.p_price_cents; if (!Number.isInteger(p) || p < 0) return res(400, { message: "bad_price" }); const pct = args.p_country === "US" ? 3.25 : 1.5; const total = Math.ceil((p + 25) / (1 - pct / 100)); return res(200, { price_cents: p, processing_cents: total - p, cuvori_cents: 0, total_cents: total, currency: "EUR", payer: "client", percent: pct, fixed_cents: 25 }); }
    return res(200, null); }
  if (u.pathname.startsWith("/rest/v1/")) {
    const table = u.pathname.split("/")[3]; const f = parseFilter(u.search.slice(1)); const rows = DB[table];
    if (hooks.db) { const h = await hooks.db(method, table, u.search, body); if (h) return h; }
    if (method === "GET") return res(200, rows.filter(r => match(r, f)));
    if (method === "PATCH") { const patch = JSON.parse(body); const o = rows.filter(r => match(r, f)); o.forEach(r => Object.assign(r, patch)); return res(200, o); }
    if (method === "POST") { const row = { id: uuid(), created_at: new Date().toISOString(), ...JSON.parse(body) }; if (table === "money_keys" && rows.some(r => r.scope === row.scope)) return res(409, { code: "23505", message: "duplicate key value violates unique constraint \"money_keys_pkey\"" }); rows.push(row); return res(201, [row]); }
    if (method === "DELETE") { const keep = rows.filter(r => !match(r, f)); rows.length = 0; rows.push(...keep); return res(200, []); }
  }
  throw new Error("unexpected fetch " + url);
};
const req = (method, path, { token, body, raw, headers } = {}) => new Request("https://cuvori.test/.netlify/functions/" + path, { method, headers: { ...(token ? { authorization: "Bearer " + token } : {}), ...(headers || {}) }, body: raw != null ? raw : body !== undefined ? JSON.stringify(body) : undefined });
const sigFor = (payload, t = Math.floor(Date.now() / 1000)) => ({ t, v1: crypto.createHmac("sha256", "whsec_fake").update(`${t}.${payload}`).digest("hex") });
const signed = (obj) => { const raw = JSON.stringify(obj); const s = sigFor(raw); return { raw, headers: { "stripe-signature": `t=${s.t},v1=${s.v1}` } }; };
// Netlify turns an uncaught throw into a 500; emulate that
const call = async (fn, r) => { try { const x = await fn(r); let j = null; try { j = await x.clone().json(); } catch {} return { status: x.status, json: j }; } catch (e) { return { status: 500, thrown: e.constructor.name + ": " + e.message }; } };

const connect = (await import(F + "stripe-connect.mjs")).default;
const checkout = (await import(F + "stripe-checkout.mjs")).default;
const webhook = (await import(F + "stripe-webhook.mjs")).default;
const release = (await import(F + "stripe-release.mjs")).default;
const resolve = (await import(F + "stripe-resolve.mjs")).default;
const autoRelease = (await import(F + "stripe-auto-release.mjs")).default;

const mk = (o = {}) => { const c = { id: uuid(), conversation_id: conv, editor: users.ed.id, client: users.cl.id, proposed_by: users.ed.id, title: "Job", price: 100, currency: "EUR", pricing: "project", status: "delivered", payment_mode: "escrow", amount_cents: 10000, fee_cents: 325, stripe_payment_intent: "pi_" + Math.random().toString(36).slice(2, 8), ...o }; DB.contracts.push(c); return c; };
const past = () => new Date(Date.now() - 3600e3).toISOString();
const moneyOut = (c) => ({ transferred: STRIPE.transfers.filter(t => t.contract === c.id).reduce((a, t) => a + t.amount, 0), refunded: STRIPE.refunds.filter(r => r.contract === c.id).reduce((a, r) => a + r.amount, 0) });
const reset = () => { hooks.stripe = null; hooks.db = null; };
// the 'hourly' batch must only see the contract under test
const onlyDue = (c) => { for (const x of DB.contracts) if (x !== c && x.status === "delivered") x.status = "completed"; };

// ---------- A1: split with editor_percent missing -> NaN -> "refunded" with no money moved
{
  const c = mk({ status: "disputed" });
  const r = await call(resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "split" } }));
  const m = moneyOut(c);
  vuln(r.status === 200 && c.status === "refunded" && m.transferred === 0 && m.refunded === 0,
    `A1 resolve split w/o editor_percent -> HTTP ${r.status}, status=${c.status}, split_editor_cents=${JSON.stringify(c.split_editor_cents)}, transferred=${m.transferred}, refunded=${m.refunded}`);
  reset();
}
// ---------- A2: resolve partial failure (transfer ok, refund fails) then admin retries with another decision
{
  const c = mk({ status: "disputed" });
  let failed = false;
  hooks.stripe = async (path) => { if (path === "/refunds" && !failed) { failed = true; return [400, { error: { message: "Charge ch_x has been charged back; cannot issue a refund." } }]; } };
  const r1 = await call(resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "split", editor_percent: 60 } }));
  const mid = { status: c.status, transfer: c.stripe_transfer_id ?? null, ...moneyOut(c) };
  const r2 = await call(resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "refund" } }));
  const r3 = await call(resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "split", editor_percent: 60 } }));
  info(`A2b admin retries the same split 60% -> HTTP ${r3.status}, status=${c.status}, transferred=${moneyOut(c).transferred}, refunded=${moneyOut(c).refunded}`);
  const m = moneyOut(c);
  vuln(m.transferred + m.refunded > 10000,
    `A2 split 60% -> refund fails (HTTP ${r1.status}: ${r1.thrown || JSON.stringify(r1.json)}); DB after: status=${mid.status}, stripe_transfer_id=${mid.transfer}, already transferred=${mid.transferred}; admin retries 'refund' (HTTP ${r2.status} ${JSON.stringify(r2.json)}) -> transferred ${m.transferred} + refunded ${m.refunded} = ${m.transferred + m.refunded} on a 10000 contract`);
  reset();
}
// ---------- A3: auto-release vs dispute (TOCTOU): client disputes while the batch is running
{
  const c = mk({ status: "delivered", auto_release_at: past() }); onlyDue(c);
  let fired = false;
  hooks.stripe = async () => { if (fired) return; fired = true; /* contract_action('dispute') commits here; it only accepts funded/delivered */ if (["funded", "delivered"].includes(c.status)) { c.status = "disputed"; c.dispute_by = users.cl.id; c.disputed_at = new Date().toISOString(); c.auto_release_at = null; } };
  const r = await call(autoRelease);
  const m = moneyOut(c);
  vuln(c.status === "completed" && c.disputed_at && m.transferred === 10000,
    `A3 dispute lands between auto-release SELECT and PATCH -> status overwritten to '${c.status}' (disputed_at=${!!c.disputed_at}), transferred=${m.transferred}; released=${JSON.stringify(r.json && r.json.released.length)}`);
  reset();
}
// ---------- A4: client approve + admin refund at the same time on a delivered contract
{
  const c = mk({ status: "delivered" });
  const [r1, r2] = await Promise.all([
    call(release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } })),
    call(resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "refund" } })),
  ]);
  const m = moneyOut(c);
  vuln(m.transferred + m.refunded > 10000, `A4 concurrent stripe-release (HTTP ${r1.status}) + stripe-resolve refund (HTTP ${r2.status}) -> transferred ${m.transferred} + refunded ${m.refunded}; final status=${c.status}, resolution=${c.resolution}`);
  reset();
}
// ---------- A5: double-click approve (same idempotency key)
{
  const c = mk({ status: "delivered" });
  const rs = await Promise.all([1, 2, 3].map(() => call(release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }))));
  const m = moneyOut(c);
  const evs = DB.messages.filter(x => x.payload && x.payload.contract_id === c.id && x.payload.event === "approve").length;
  vuln(m.transferred > 10000, `A5 3 concurrent approves -> HTTP ${rs.map(r => r.status).join("/")}, transferred=${m.transferred}, 'approve' events posted=${evs}${rs.find(r => r.thrown) ? ", error: " + rs.find(r => r.thrown).thrown : ""}`);
  reset();
}
// ---------- A6: transfer ok, DB PATCH fails, idempotency key pruned after 24h -> auto-release pays again
{
  const c = mk({ status: "delivered", auto_release_at: past() }); onlyDue(c);
  let n = 0;
  hooks.db = async (method, table) => { if (method === "PATCH" && table === "contracts" && STRIPE.transfers.some(t => t.contract === c.id) && n++ === 0) return res(503, { message: "upstream timeout" }); };
  const r1 = await call(release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const st = c.status;
  const r2 = await call(release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } })); // retry within 24h -> cached
  const within = moneyOut(c).transferred;
  // simulate: a 2nd failure then >24h pass (Stripe prunes keys) before the next successful attempt
  c.status = "delivered"; c.stripe_transfer_id = null; c.auto_release_at = past(); STRIPE.idem.clear();
  const r3 = await call(autoRelease);
  const m = moneyOut(c);
  vuln(m.transferred > 10000, `A6 release: transfer ok then PATCH 503 (HTTP ${r1.status}, status still '${st}'); retry <24h HTTP ${r2.status} total=${within} (dedup ok); after key pruning auto-release -> transferred total=${m.transferred}`);
  reset();
}
// ---------- A7: contract cancelled while the client is in Checkout; payment is silently ignored
{
  const c = mk({ status: "accepted", stripe_payment_intent: null });
  const r0 = await call(checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  c.status = "cancelled"; // editor (or client) runs contract_action('cancel') - allowed for 'accepted'
  const s = { id: c.stripe_checkout_id, client_reference_id: c.id, payment_status: "paid", payment_intent: "pi_paid_cancelled", amount_total: 10325, currency: "eur" };
  const w = signed({ type: "checkout.session.completed", data: { object: s } });
  const r = await call(webhook, req("POST", "x", w));
  vuln(r.status === 200 && c.status === "cancelled" && moneyOut(c).refunded === 0,
    `A7 checkout (HTTP ${r0.status}) -> contract cancelled -> client pays -> webhook HTTP ${r.status} ${JSON.stringify(r.json)}; contract status=${c.status}, payment_intent stored=${c.stripe_payment_intent}, refund issued=${moneyOut(c).refunded}`);
  reset();
}
// ---------- A8: async payment methods (SEPA etc.)
{
  const c = mk({ status: "accepted", stripe_payment_intent: null, stripe_checkout_id: "cs_async" });
  const s = { id: "cs_async", client_reference_id: c.id, payment_status: "unpaid", payment_intent: "pi_async", amount_total: 10325, currency: "eur" };
  await call(webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: s } })));
  const r = await call(webhook, req("POST", "x", signed({ type: "checkout.session.async_payment_succeeded", data: { object: { ...s, payment_status: "paid" } } })));
  c.status === "funded" && (c.status = "delivered");
  const r8 = await call(release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const t8 = STRIPE.transfers.find(t => t.contract === c.id);
  info(`A8b releasing a webhook-funded contract -> HTTP ${r8.status}, transfer source_transaction=${t8 && t8.source_transaction}`);
  vuln(c.status === "accepted", `A8 async_payment_succeeded (HTTP ${r.status}) -> contract status '${c.status}'`);
  reset();
}
// ---------- A9: webhook does not compare amount / currency / session id / livemode
{
  const c = mk({ status: "accepted", stripe_payment_intent: null, stripe_checkout_id: "cs_expected" });
  const s = { id: "cs_other", client_reference_id: c.id, payment_status: "paid", payment_intent: "pi_cheap", amount_total: 50, currency: "usd", livemode: false };
  const r = await call(webhook, req("POST", "x", signed({ type: "checkout.session.completed", livemode: false, data: { object: s } })));
  vuln(c.status === "funded", `A9 session cs_other, amount_total=50 usd for a 10325 EUR contract -> HTTP ${r.status}, status=${c.status}, stripe_checkout_id overwritten=${c.stripe_checkout_id}`);
  reset();
}
// ---------- A10: chargeback ignored, auto-release still pays the editor
{
  const c = mk({ status: "delivered", auto_release_at: past() }); onlyDue(c);
  const r = await call(webhook, req("POST", "x", signed({ type: "charge.dispute.created", data: { object: { id: "dp_1", charge: "ch_1", payment_intent: c.stripe_payment_intent, amount: 10325, metadata: { contract_id: c.id } } } })));
  await call(autoRelease);
  vuln(moneyOut(c).transferred === 10000, `A10 charge.dispute.created (HTTP ${r.status}) -> status '${c.status}', auto-release transferred ${moneyOut(c).transferred}`);
  reset();
}
// ---------- A11: partial refund from dashboard is ignored, then full release
{
  const c = mk({ status: "delivered" });
  const r = await call(webhook, req("POST", "x", signed({ type: "charge.refunded", data: { object: { id: "ch_2", payment_intent: c.stripe_payment_intent, amount: 10325, amount_refunded: 5000, refunded: false, metadata: { contract_id: c.id } } } })));
  const st = c.status;
  await call(release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  vuln(moneyOut(c).transferred === 10000, `A11 charge.refunded partial 5000 (HTTP ${r.status}) -> status '${st}'; client approves -> transferred ${moneyOut(c).transferred}`);
  reset();
}
// ---------- A12: banned users
{
  users.cl.banned = true;
  const c = mk({ status: "funded" });
  const r = await call(release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  vuln(r.status === 200, `A12a banned client calls stripe-release -> HTTP ${r.status}, status=${c.status}`);
  users.cl.banned = false;
  users.ed.banned = true;
  const c2 = mk({ status: "delivered", auto_release_at: past() }); onlyDue(c2);
  await call(autoRelease);
  vuln(moneyOut(c2).transferred === 10000, `A12b banned editor still paid by auto-release: transferred ${moneyOut(c2).transferred}`);
  const c3 = mk({ status: "delivered" });
  const r3 = await call(release, req("POST", "x", { token: "tok_cl", body: { contract_id: c3.id } }));
  vuln(r3.status === 200, `A12c client approve pays banned editor -> HTTP ${r3.status}, transferred ${moneyOut(c3).transferred}`);
  users.ed.banned = false;
  reset();
}
// ---------- A13: JSON body "null"
for (const [name, fn] of [["checkout", checkout], ["release", release], ["resolve", resolve]]) {
  const r = await call(fn, req("POST", "x", { token: name === "resolve" ? "tok_adm" : "tok_cl", raw: "null" }));
  vuln(r.status === 500 && r.thrown, `A13 ${name} body 'null' -> ${r.status} ${r.thrown || JSON.stringify(r.json)}`);
}
// ---------- A14: id validation / filter injection
{
  urls.length = 0;
  const r1 = await call(release, req("POST", "x", { token: "tok_cl", body: { contract_id: "------------------------------------" } }));
  const hit = urls.find(u => u.includes("/rest/v1/contracts"));
  info(`A14 36 hyphens pass /^[0-9a-f-]{36}$/ -> HTTP ${r1.status}, Supabase URL: ${hit}`);
  const inj = ["00000000-0000-0000-0000-000000000000&client=eq.x", "00000000-0000-0000-0000-00000000000,", { a: 1 }, ["x"]];
  const rs = [];
  for (const id of inj) rs.push((await call(release, req("POST", "x", { token: "tok_cl", body: { contract_id: id } }))).status);
  vuln(rs.some(s => s !== 400), `A14 injection-shaped ids (& , object, array) -> HTTP ${rs.join("/")}`);
}
// ---------- A15: stripe-connect trusts a stripe_account_id the editor can write through RLS
{
  // payout_details RLS "owner manages payout details" FOR ALL -> editor PATCHes own row (proved in rls.sql)
  DB.payout_details.push({ id: users.ed3.id, methods: [], note: "", stripe_account_id: "acct_1VictimBBBBBBBB", stripe_payouts_enabled: false });
  const r = await call(connect, req("POST", "x", { token: "tok_ed3" }));
  vuln(/acct_1VictimBBBBBBBB/.test(r.json && r.json.url), `A15a editor3 sets own stripe_account_id=<victim acct> -> POST stripe-connect url: ${r.json && r.json.url}`);
  DB.payout_details.at(-1).stripe_account_id = "acct_x/../../balance";
  urls.length = 0;
  const r2 = await call(connect, req("GET", "x", { token: "tok_ed3" }));
  const hit = urls.find(u => u.includes("api.stripe.com"));
  const hp = hit ? new URL(hit.split(" ")[1]).pathname : "(no Stripe call)";
  vuln(hp === "/v1/balance", `A15b stripe_account_id='acct_x/../../balance' -> GET stripe-connect fetches ${hp} with the platform secret key (HTTP ${r2.status}, body ${JSON.stringify(r2.json)})`);
  // A16: payouts_enabled self-set, no account
  DB.payout_details.at(-1).stripe_account_id = null; DB.payout_details.at(-1).stripe_payouts_enabled = true;
  const c = mk({ editor: users.ed3.id, status: "accepted", stripe_payment_intent: null });
  const r3 = await call(checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  c.status = "delivered"; c.stripe_payment_intent = "pi_ed3";
  const r4 = await call(release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  vuln(r3.status === 200 && r4.status === 500, `A16 editor self-sets stripe_payouts_enabled=true with no account -> checkout HTTP ${r3.status}; later release HTTP ${r4.status} (${r4.thrown || JSON.stringify(r4.json)})`);
}
// ---------- A17: signature header parsing / replay
{
  const raw = JSON.stringify({ type: "account.updated", data: { object: { id: "acct_1EditorAAAAAAAA", payouts_enabled: true, charges_enabled: true } } });
  const s = sigFor(raw);
  const a = await call(webhook, req("POST", "x", { raw, headers: { "stripe-signature": `t=${s.t},v1=${s.v1},v1=${"0".repeat(64)}` } }));
  const b = await call(webhook, req("POST", "x", { raw, headers: { "stripe-signature": `t=${s.t},v1=${"0".repeat(64)},v1=${s.v1}` } }));
  vuln(a.status === 400, `A17a valid v1 followed by a 2nd v1 (secret rotation) -> HTTP ${a.status} ${a.json && a.json.error}; reversed order -> HTTP ${b.status}`);
  const c = await call(webhook, req("POST", "x", { raw, headers: { "stripe-signature": `t=abc,v1=${s.v1}` } }));
  const d = await call(webhook, req("POST", "x", { raw, headers: { "stripe-signature": `v1=${s.v1}` } }));
  const e = await call(webhook, req("POST", "x", { raw, headers: { "stripe-signature": `t=${s.t},v1=${s.v1.slice(0, 63)}` } }));
  info(`A17b t=abc -> ${c.status}; missing t -> ${d.status}; short v1 -> ${e.status} (no bypass: HMAC covers t)`);
  const old = sigFor(raw, Math.floor(Date.now() / 1000) - 3600);
  const f = await call(webhook, req("POST", "x", { raw, headers: { "stripe-signature": `t=${old.t},v1=${old.v1}` } }));
  info(`A17c 1h-old signed event -> ${f.status} ${f.json && f.json.error}`);
  // replay: acct disabled (fresh), then a captured older 'enabled' event re-sent inside the 10 min window
  const off = signed({ type: "account.updated", data: { object: { id: "acct_1EditorAAAAAAAA", payouts_enabled: false, charges_enabled: true } } });
  const onOld = { raw, headers: { "stripe-signature": `t=${s.t},v1=${s.v1}` } };
  STRIPE.accounts.acct_1EditorAAAAAAAA.payouts_enabled = false;
  await call(webhook, req("POST", "x", off));
  const g = await call(webhook, req("POST", "x", onOld));
  vuln(g.status === 200 && DB.payout_details[0].stripe_payouts_enabled === true, `A17d replayed/out-of-order account.updated re-enables payouts (HTTP ${g.status}, enabled=${DB.payout_details[0].stripe_payouts_enabled})`);
  STRIPE.accounts.acct_1EditorAAAAAAAA.payouts_enabled = true; DB.payout_details[0].stripe_payouts_enabled = true;
}
// ---------- A18: duplicate delivery of checkout.session.completed
{
  const c = mk({ status: "accepted", stripe_payment_intent: null, stripe_checkout_id: "cs_dup" });
  const w = signed({ type: "checkout.session.completed", data: { object: { id: "cs_dup", client_reference_id: c.id, payment_status: "paid", payment_intent: "pi_dup", amount_total: 10325, currency: "eur" } } });
  await Promise.all([call(webhook, req("POST", "x", w)), call(webhook, req("POST", "x", w))]);
  const n = DB.messages.filter(x => x.payload && x.payload.contract_id === c.id && x.payload.event === "funded").length;
  vuln(n > 1, `A18 same event delivered twice concurrently -> ${n} 'funded' chat events, status=${c.status}, refunds=${moneyOut(c).refunded}`);
}
// ---------- A19: one bad contract does not abort the batch; missing account retried silently forever
{
  for (const x of DB.contracts) if (x.status === "delivered") x.status = "completed";
  const bad = mk({ editor: users.cl.id, auto_release_at: past() }); // no payout_details row
  const good = mk({ auto_release_at: past() });
  const r1 = await call(autoRelease); const r2 = await call(autoRelease);
  info(`A19 batch with a payee lacking a Stripe account: run1 released=${r1.json.released.length}, run2 released=${r2.json.released.length}, failed=${JSON.stringify(r2.json.failed)}; bad contract status=${bad.status}; good=${good.status}`);
}
// ---------- A20: hourly pricing charged as a single unit
{
  const c = mk({ status: "accepted", pricing: "hour", price: 50, amount_cents: 5000, stripe_payment_intent: null });
  const r = await call(checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  info(`A20 pricing='hour' price 50 -> checkout HTTP ${r.status} ${JSON.stringify(r.json)}`);
}
// ---------- A21: split math conservation (brute force)
{
  let badCnt = 0, sample = null;
  const pct = [0, 0.1, 1, 12.5, 33.333, 49.995, 50, 66.6667, 99.99, 100, -5, 150, Infinity, "abc", null, undefined, "", "50"];
  for (let total = 1; total <= 20000; total += 7) for (const p0 of pct) {
    const p = Math.max(0, Math.min(100, Number(p0)));
    const e = Math.round(total * p / 100), r = total - e;
    if (!(Number.isInteger(e) && Number.isInteger(r) && e >= 0 && r >= 0 && e + r === total)) { badCnt++; sample = sample || { total, p0, e, r }; }
  }
  info(`A21 split math over ${Math.ceil(20000 / 7)} totals x ${pct.length} percents: ${badCnt} bad cases; first=${JSON.stringify(sample)} (only non-numeric percents break it; null/''/undefined -> Number()=0 or NaN)`);
}
// ---------- A22: transfers are not tied to the charge (no source_transaction)
info(`A22 source_transaction on transfers: ${[...new Set(STRIPE.transfers.map(t => t.source_transaction ? "set" : "missing"))].join(",")} (missing = release draws on whatever *available* balance exists)`);
// ---------- A23: stored XSS in the contract chat card (index.html) -> session theft -> stripe-release as the client
{
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const pick = (re) => { const m = html.match(re); if (!m) throw new Error("not found: " + re); return m[0]; };
  const src = [pick(/function escapeHtml\(s\)\{.*\}/), pick(/const O_CARD_EVENTS=\{[\s\S]*?\};/), pick(/function money\(n,cur\)\{.*\}/), pick(/const oMoney=\(cents,cur\)=>.*;/), pick(/function fill\(str, vars\)\{.*\}/), pick(/function contractCardHtml\(m\)\{[\s\S]*?\n  \}/)].join("\n");
  const t = (k) => escapeHtmlLocal(String(k));   // unknown keys come back escaped, like the page's t()
  function escapeHtmlLocal(x) { return x.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[c])); }
  const myId = () => "me";
  const contractCardHtml = new Function("t", "myId", src + "; return contractCardHtml;")(t, myId);
  const outHtml = contractCardHtml({ sender: "x", payload: { contract_id: '1" autofocus onfocus="alert(1)" tabindex="0', title: "ok", price: 1, currency: "<img src=x onerror=alert(2)>", event: "<svg onload=alert(3)>" } });
  vuln(/onfocus="alert\(1\)"/.test(outHtml) || /<img src=x/.test(outHtml) || /<svg onload/.test(outHtml), `A23 contractCardHtml output: ${outHtml.slice(0, 260)}...`);
}
// ---------- A24: which database key the functions use when Netlify has both the old and the new one ----------
{
  const { execFileSync } = await import("node:child_process");
  const lib = new URL("../netlify/lib/cuvori.mjs", import.meta.url).href;
  const keyWith = (extra) => {
    const env = { ...process.env, SITE_URL: "https://cuvori.io", SUPABASE_SERVICE_ROLE_KEY: "", SUPABASE_SECRET_KEY: "", ...extra };
    return execFileSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(lib)}); process.stdout.write(String(m.SERVICE_KEY))`], { env, encoding: "utf8" });
  };
  const both = keyWith({ SUPABASE_SERVICE_ROLE_KEY: "old_jwt_key", SUPABASE_SECRET_KEY: "sb_secret_new" });
  const onlyOld = keyWith({ SUPABASE_SERVICE_ROLE_KEY: "old_jwt_key" });
  const onlyNew = keyWith({ SUPABASE_SECRET_KEY: " sb_secret_new \n" });
  vuln(both !== "sb_secret_new" || onlyOld !== "old_jwt_key" || onlyNew !== "sb_secret_new",
    `A24 the database key used -> both set: ${both}, only the old: ${onlyOld}, only the new (pasted with spaces): ${JSON.stringify(onlyNew)} (the new key must win when both are set; either alone must work)`);
}
// ---------- A25: the second webhook secret (freelancers' own Stripe accounts) works even when pasted with a space or line break ----------
{
  const raw = JSON.stringify({ type: "account.updated", data: { object: { id: "acct_1EditorAAAAAAAA" } } });
  const t = Math.floor(Date.now() / 1000), v1 = crypto.createHmac("sha256", "whsec_connect_fake").update(`${t}.${raw}`).digest("hex");
  const r = await call(webhook, req("POST", "x", { raw, headers: { "stripe-signature": `t=${t},v1=${v1}` } }));
  const forged = await call(webhook, req("POST", "x", { raw, headers: { "stripe-signature": `t=${t},v1=${"0".repeat(64)}` } }));
  vuln(r.status !== 200 || forged.status !== 400,
    `A25 an event signed with the freelancer-account webhook secret (saved with a space and a line break) -> HTTP ${r.status} ${JSON.stringify(r.json)}; a forged one -> HTTP ${forged.status} (the real one must be accepted, the forged one refused)`);
}
// ---------- A26: a Stripe key that is not a secret key: payments pause, and the log, the admin and the status say why ----------
{
  const { execFileSync } = await import("node:child_process");
  const base = new URL("../netlify/", import.meta.url).href;
  const probe = (key) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    const logs = []; console.error = (...a) => logs.push(a.map(String).join(" "));
    globalThis.fetch = async () => { throw new Error("no network in this test"); };   // nothing ever reaches the real database or Stripe
    const lib = await import(${JSON.stringify(base + "lib/cuvori.mjs")});
    const status = await (await (await import(${JSON.stringify(base + "functions/stripe-status.mjs")})).default(new Request("https://x/", { method: "GET" }))).json();
    let err = null; try { await lib.stripe("GET", "/account"); } catch (e) { err = { code: e.code || null, status: e.status || null, message: e.message }; }
    let cols = null; try { lib.acctCols(); } catch (e) { cols = e.code || null; }
    process.stdout.write(JSON.stringify({ status, err, cols, logs }));`], {
    env: { ...process.env, SITE_URL: "https://cuvori.io", STRIPE_SECRET_KEY: key, SUPABASE_SERVICE_ROLE_KEY: "service_fake", STRIPE_WEBHOOK_SECRET: "whsec_fake" }, encoding: "utf8" }));
  const bad = probe("pk_live_PUBLICPARTabc123");
  const logLine = bad.logs.find(l => l.includes("not a Stripe secret key")) || "";
  vuln(bad.status.escrow !== true || bad.status.stripeKeyOk !== false || !bad.err || bad.err.code !== "payments_paused" || !/not a secret key/.test(bad.err.message) || bad.cols !== "payments_paused"
       || !logLine.includes('"pk_"') || logLine.includes("PUBLICPART") || JSON.stringify(bad).includes("PUBLICPART"),
    `A26 Stripe's public key saved as the secret key -> status ${JSON.stringify(bad.status)}, payment ${JSON.stringify(bad.err)}, Payout details ${bad.cols}, log ${JSON.stringify(logLine)} (must pause with the reason, show the key's first 3 characters only)`);
  const good = probe("sk_test_fake");
  vuln(good.status.stripeKeyOk !== true || good.logs.some(l => l.includes("not a Stripe secret key")), `A26 a real secret key -> status ${JSON.stringify(good.status)}, log lines ${good.logs.length} (must say the key is fine and log nothing about it)`);
}
// ---------- A27: extra headers can add something, but never change what every answer is (JSON, never cached, allowed websites only) ----------
{
  const L = await import(new URL("../netlify/lib/cuvori.mjs", import.meta.url).href);
  const sneaky = { "Content-Type": "text/html", "Cache-Control": "max-age=999", "access-control-allow-origin": "*", "Access-Control-Allow-Headers": "*", "VARY": "*", "retry-after": "30" };
  const lone = L.json(200, { ok: 1 }, sneaky);
  const fromEvil = await L.safe(async () => L.json(200, { ok: 1 }, sneaky))(new Request("https://x/", { method: "POST", headers: { origin: "https://evil.example" } }));
  const fromCuvori = await L.safe(async () => L.json(200, { ok: 1 }, sneaky))(new Request("https://x/", { method: "POST", headers: { origin: "https://cuvori.io" } }));
  const h = (r) => ({ type: r.headers.get("content-type"), cache: r.headers.get("cache-control"), origin: r.headers.get("access-control-allow-origin"), allow: r.headers.get("access-control-allow-headers"), vary: r.headers.get("vary"), retry: r.headers.get("retry-after") });
  const a = h(lone), e = h(fromEvil), g = h(fromCuvori);
  const fixedOk = (x) => x.type === "application/json" && x.cache === "no-store" && x.vary === "origin" && x.retry === "30";
  vuln(!fixedOk(a) || a.origin || !fixedOk(e) || e.origin || e.allow || !fixedOk(g) || g.origin !== "https://cuvori.io" || g.allow !== "authorization, content-type",
    `A27 extra headers that try to change the fixed ones -> on their own ${JSON.stringify(a)}; another website ${JSON.stringify(e)}; cuvori.io ${JSON.stringify(g)} (JSON, never cached and the allowed list must win; a harmless extra must stay)`);
}
// ---------- A28: shortening text looks only at its start: exactly what splitting the whole text gives, and a text of several megabytes takes no time ----------
{
  const L = await import(new URL("../netlify/lib/cuvori.mjs", import.meta.url).href);
  // the way it is meant to work: half an emoji already in the text becomes "�" (the database refuses half an emoji),
  // then the whole text is split into what people see as characters, and they are kept while they fit
  const SEG = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const whole = (s, n, maxUnits = Infinity) => {
    s = s.toWellFormed(); let out = "", used = 0;
    for (const g of Array.from(SEG.segment(s), x => x.segment)) { const size = Array.from(g).length; if (used + size > n || out.length + g.length > maxUnits) break; out += g; used += size; }
    return out;
  };
  // the pieces that are hard to cut: accents (also many on one letter), emoji with a skin tone, a family, flags (also
  // half a flag), England's flag, a keycap, Korean letters built from parts, Hindi and Thai, line breaks, half emoji
  const pieces = ["a", "Ž", "ė", "e\u0301", "\u0301", "\u0301\u0301\u0301", "😀", "👍🏽", "\u{1F3FD}", "👨‍👩‍👧", "\u200D", "\uFE0F", "🇱🇹", "🇱",
    "🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}", "1️⃣", "ᄀ", "ᅡ", "ᆨ", "क्ष", "्", "ำ", "\r\n", "\n", " ", "\uD83D", "\uDE00", "\u{1D165}"];
  let seed = 28; const rnd = (k) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
  const wrong = []; let tried = 0;
  for (let i = 0; i < 400; i++) {
    let s = ""; for (let j = 0, len = 1 + rnd(40); j < len; j++) s += pieces[rnd(pieces.length)];
    for (let n = 0; n <= 30; n++) for (const u of [Infinity, 1, 3, 7, 12, 20]) {
      tried++; const a = L.cut(s, n, u), b = whole(s, n, u);
      if ((a !== b || !a.isWellFormed()) && wrong.length < 3) wrong.push(`${JSON.stringify(s)} to ${n} characters / ${u} units gave ${JSON.stringify(a)} instead of ${JSON.stringify(b)}`);
    }
    for (const u of [2, 5, 9, 15, 33]) {
      tried++; const a = L.cut(s, Infinity, u), b = whole(s, Infinity, u);
      if ((a !== b || !a.isWellFormed()) && wrong.length < 3) wrong.push(`${JSON.stringify(s)} to ${u} units gave ${JSON.stringify(a)} instead of ${JSON.stringify(b)}`);
    }
  }
  const slow = [];
  for (const [what, s, n, u, want] of [["6 MB of letters", "a".repeat(6e6), 500, Infinity, "a".repeat(500)],
                                       ["6 MB of emoji", "😀".repeat(1.5e6), 500, Infinity, "😀".repeat(500)],
                                       ["one letter with 6 million accents", "a" + "\u0301".repeat(6e6 - 1), 500, Infinity, ""],
                                       ["6 MB of emoji cut to fit Stripe", "😀".repeat(1.5e6), Infinity, 249, "😀".repeat(124)]]) {
    const t = performance.now(); const got = L.cut(s, n, u); const ms = Math.round(performance.now() - t);
    if (got !== want || ms > 200) slow.push(`${what}: ${ms} ms, kept ${got.length} units${got !== want ? " (WRONG)" : ""}`);
  }
  vuln(wrong.length || slow.length, `A28 shortening text: ${tried} cuts of hard text, ${wrong.length ? "different from splitting the whole text, or half an emoji kept: " + wrong.join("; ") : "all the same as splitting the whole text, never half an emoji"}; ${slow.length ? "too slow or wrong: " + slow.join("; ") : "6 MB texts done at once"}`);
}
console.log(out.join("\n"));
console.log(`\n${out.filter(l => l.startsWith("VULNERABLE")).length} vulnerable / ${out.filter(l => l.startsWith("safe")).length} safe / ${out.filter(l => l.startsWith("info")).length} info`);
