// Shared fakes for the payment-function attack suites: a small Stripe (with the rules that bite in
// production — idempotency, transfer caps per source charge, refund caps per payment, disputes,
// balance), a small Supabase REST, and helpers to sign webhooks.
process.env.STRIPE_SECRET_KEY = "sk_test_fake"; process.env.SUPABASE_SERVICE_ROLE_KEY = "service_fake"; process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake"; process.env.SITE_URL = "https://cuvori.test";
import crypto from "node:crypto";
export const F = (process.env.TARGET || new URL("..", import.meta.url).pathname.replace(/\/$/, "")) + "/netlify/functions/";
export const uuid = () => crypto.randomUUID();
const U = (role, extra = {}) => ({ id: uuid(), email: role + "@t.com", first_name: role, role: role.startsWith("ed") ? "editor" : "client", is_admin: false, banned: false, ...extra });
export const users = { ed: U("ed"), cl: U("cl"), adm: U("adm", { is_admin: true }), ed2: U("ed2"), cl2: U("cl2") };
export const tokens = { tok_ed: users.ed, tok_cl: users.cl, tok_adm: users.adm, tok_ed2: users.ed2, tok_cl2: users.cl2 };
export const conv = uuid();
export const DB = { rpc_calls: [], profiles: Object.values(users), user_flags: [], messages: [], contracts: [], order_events: [], order_payments: [], order_milestones: [], money_keys: [],
  payout_details: [{ id: users.ed.id, methods: [], note: "", stripe_account_id: "acct_1EditorAAAAAAAA", stripe_payouts_enabled: true },
                   { id: users.ed2.id, methods: [], note: "", stripe_account_id: "acct_1SecondBBBBBBBB", stripe_payouts_enabled: true }] };
export const STRIPE = { sessions: {}, charges: {}, intents: {}, transfers: [], refunds: [], reversals: [], disputes: {}, idem: new Map(), balance: 0, settleDelay: false,
  accounts: { acct_1EditorAAAAAAAA: { id: "acct_1EditorAAAAAAAA", payouts_enabled: true, charges_enabled: true, requirements: { currently_due: [] }, metadata: { cuvori_user: users.ed.id } },
              acct_1SecondBBBBBBBB: { id: "acct_1SecondBBBBBBBB", payouts_enabled: true, charges_enabled: true, requirements: { currently_due: [] }, metadata: { cuvori_user: users.ed2.id } } } };
export const hooks = { stripe: null, db: null };
export const urls = [];
const tick = () => new Promise(r => setImmediate(r));
const rid = (p) => p + "_" + Math.random().toString(36).slice(2, 10);

function parseFilter(q) { const p = new URLSearchParams(q); const f = []; for (const [k, v] of p) { if (["select", "limit", "order"].includes(k)) continue; const m = v.match(/^(eq|neq|lte|gte|in|is)\.(.*)$/); if (m) f.push({ k, op: m[1], v: m[1] === "in" ? m[2].replace(/^\(|\)$/g, "").split(",").map(decodeURIComponent) : m[2] }); } return f; }
const match = (row, f) => f.every(x => x.op === "eq" ? String(row[x.k]) === x.v : x.op === "neq" ? String(row[x.k]) !== x.v : x.op === "in" ? x.v.includes(String(row[x.k])) : x.op === "lte" ? (row[x.k] != null && row[x.k] <= x.v) : x.op === "gte" ? (row[x.k] != null && row[x.k] >= x.v) : x.op === "is" ? (x.v === "null" ? row[x.k] == null : row[x.k] != null) : true);
const res = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const err = (status, message, code) => [status, { error: { message, code, type: "invalid_request_error" } }];

// a client "pays" a checkout session: creates the payment intent + charge and returns the session object Stripe would send
export function pay(sessionId, opts = {}) {
  const s = STRIPE.sessions[sessionId]; if (!s) throw new Error("no session " + sessionId);
  const pi = rid("pi"), ch = rid("ch"); const total = s.amount_total;
  const fee = opts.fee != null ? opts.fee : Math.round(total * 0.015 + 25);
  STRIPE.intents[pi] = { id: pi, amount: total, latest_charge: ch };
  STRIPE.charges[ch] = { id: ch, amount: total, amount_refunded: 0, sourced: 0, payment_intent: pi, balance_transaction: { id: rid("txn"), fee, net: total - fee, status: STRIPE.settleDelay ? "pending" : "available" }, payment_method_details: { card: { fingerprint: "fp_" + (opts.card || "one"), brand: "visa", last4: "4242" } } };
  if (!STRIPE.settleDelay) STRIPE.balance += total - fee;
  s.payment_status = "paid"; s.payment_intent = pi;
  return { ...s };
}

export function stripeHandle(path, method, p) {
  const seg = path.split("/");
  if (path === "/account_links") return [200, { url: "https://connect.stripe.com/setup/" + p.get("account") }];
  if (path === "/accounts" && method === "POST") { const id = rid("acct"); STRIPE.accounts[id] = { id, payouts_enabled: false, charges_enabled: false, requirements: { currently_due: ["external_account"] }, metadata: { cuvori_user: p.get("metadata[cuvori_user]") } }; return [200, STRIPE.accounts[id]]; }
  if (seg[1] === "accounts" && method === "GET") return STRIPE.accounts[seg[2]] ? [200, STRIPE.accounts[seg[2]]] : err(404, "No such account: " + seg[2], "resource_missing");
  if (path === "/transfers" && method === "GET") return [200, { data: STRIPE.transfers.filter(t => t.transfer_group === p.get("transfer_group")) }];
  if (path === "/refunds" && method === "GET") return [200, { data: STRIPE.refunds.filter(r => r.payment_intent === p.get("payment_intent")) }];
  if (seg[1] === "checkout" && seg[2] === "sessions" && seg[4] === "expire") { const s = STRIPE.sessions[seg[3]]; if (s) s.status = "expired"; return [200, s || {}]; }
  if (seg[1] === "checkout" && seg[2] === "sessions" && seg[3] && method === "GET") return STRIPE.sessions[seg[3]] ? [200, STRIPE.sessions[seg[3]]] : err(404, "No such checkout.session", "resource_missing");
  if (path === "/checkout/sessions") {
    const id = rid("cs"); const a0 = +p.get("line_items[0][price_data][unit_amount]"), a1 = +(p.get("line_items[1][price_data][unit_amount]") || 0);
    STRIPE.sessions[id] = { id, object: "checkout.session", mode: "payment", status: "open", payment_status: "unpaid", payment_intent: null, url: "https://checkout.stripe.com/" + id, client_reference_id: p.get("client_reference_id"), amount_total: a0 + a1, currency: p.get("line_items[0][price_data][currency]"), amounts: [a0, a1],
      metadata: { contract_id: p.get("metadata[contract_id]"), amount_cents: p.get("metadata[amount_cents]"), fee_cents: p.get("metadata[fee_cents]"), kind: p.get("metadata[kind]") }, params: Object.fromEntries(p) };
    return [200, STRIPE.sessions[id]];
  }
  if (seg[1] === "payment_intents" && method === "GET") { const pi = STRIPE.intents[seg[2]]; if (!pi) return err(404, "No such payment_intent", "resource_missing"); return [200, { ...pi, latest_charge: STRIPE.charges[pi.latest_charge] }]; }
  if (path === "/transfers" && method === "POST") {
    const amount = +p.get("amount"), src = p.get("source_transaction"), dest = p.get("destination");
    if (!STRIPE.accounts[dest]) return err(400, "No such destination: " + dest, "resource_missing");
    if (!STRIPE.accounts[dest].payouts_enabled) return err(400, "Your destination account needs to have at least one of the following capabilities enabled: transfers", "insufficient_capabilities_for_transfer");
    if (src) { const c = STRIPE.charges[src]; if (!c) return err(400, "No such charge: " + src, "resource_missing"); if (c.sourced + amount > c.amount - c.amount_refunded) return err(400, "The amount of this transfer exceeds the amount available on the source charge", "invalid_request_error"); c.sourced += amount; }
    else { if (STRIPE.balance < amount) return err(400, "You have insufficient funds in your Stripe account. One likely reason is that your balance is pending settlement.", "balance_insufficient"); STRIPE.balance -= amount; }
    const t = { id: rid("tr"), object: "transfer", created: Date.now() + STRIPE.transfers.length, amount, currency: p.get("currency"), destination: dest, reversed: false, amount_reversed: 0, contract: p.get("metadata[contract_id]"), metadata: { contract_id: p.get("metadata[contract_id]"), milestone_id: p.get("metadata[milestone_id]") || "", purpose: p.get("metadata[purpose]") || "release" }, transfer_group: p.get("transfer_group"), source_transaction: src || null };
    STRIPE.transfers.push(t); return [200, t];
  }
  if (seg[1] === "transfers" && seg[3] === "reversals" && method === "POST") { const t = STRIPE.transfers.find(x => x.id === seg[2]); if (!t) return err(404, "No such transfer", "resource_missing"); const amount = +(p.get("amount") || (t.amount - t.amount_reversed)); if (amount + t.amount_reversed > t.amount) return err(400, "Reversal amount exceeds the transfer amount"); t.amount_reversed += amount; t.reversed = t.amount_reversed === t.amount; const r = { id: rid("trr"), amount, transfer: t.id }; STRIPE.reversals.push(r); STRIPE.balance += amount; return [200, r]; }
  if (path === "/refunds" && method === "POST") {
    const pi = p.get("payment_intent"), amount = +p.get("amount"); const intent = STRIPE.intents[pi]; if (!intent) return err(404, "No such payment_intent: " + pi, "resource_missing");
    const ch = STRIPE.charges[intent.latest_charge]; if (STRIPE.disputes[ch.id] && STRIPE.disputes[ch.id].status !== "won") return err(400, "Charge " + ch.id + " has been charged back; cannot issue a refund.", "charge_disputed");
    if (amount > ch.amount - ch.amount_refunded) return err(400, "Refund amount (€" + (amount / 100).toFixed(2) + ") is greater than unrefunded amount on charge (€" + ((ch.amount - ch.amount_refunded) / 100).toFixed(2) + ")", "amount_too_large");
    if (ch.sourced > ch.amount - ch.amount_refunded - amount) return err(400, "Cannot refund more than the amount not yet transferred from this charge");
    ch.amount_refunded += amount; STRIPE.balance -= amount;
    const r = { id: rid("re"), amount, contract: p.get("metadata[contract_id]"), metadata: { contract_id: p.get("metadata[contract_id]"), reason: p.get("metadata[reason]") || "" }, payment_intent: pi, charge: ch.id, status: "succeeded" }; STRIPE.refunds.push(r); return [200, r];
  }
  return err(404, "unknown " + path);
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
    try { const h = hooks.stripe && await hooks.stripe(path, method, p); [status, data] = h || stripeHandle(path, method, p); }
    catch (e) { if (key && method === "POST") STRIPE.idem.delete(key); throw e; }
    finally { await tick(); }
    if (key && method === "POST") STRIPE.idem.set(key, { body, status, data });
    return res(status, data);
  }
  if (u.pathname === "/auth/v1/user") { const t = (init.headers.Authorization || "").replace("Bearer ", ""); return tokens[t] ? res(200, tokens[t]) : res(401, {}); }
  if (u.pathname.startsWith("/rest/v1/rpc/")) { const fn = u.pathname.split("/")[4], args = JSON.parse(body); DB.rpc_calls.push({ fn, args });
    if (fn === "order_quote") { const p = args.p_price_cents; if (!Number.isInteger(p) || p < 0) return res(400, { message: "bad_price" }); const pct = args.p_country === "US" ? 3.25 : 1.5; const total = Math.ceil((p + 25) / (1 - pct / 100)); return res(200, { price_cents: p, processing_cents: total - p, cuvori_cents: 0, total_cents: total, currency: "EUR", payer: "client", percent: pct, fixed_cents: 25 }); }
    if (fn === "expire_jobs") return res(200, 0);
    return res(200, null); }
  if (u.pathname.startsWith("/rest/v1/")) {
    const table = u.pathname.split("/")[3]; const f = parseFilter(u.search.slice(1)); const rows = DB[table]; if (!rows) return res(404, { message: `relation "${table}" does not exist` });
    if (hooks.db) { const h = await hooks.db(method, table, u.search, body); if (h) return h; }
    if (method === "GET") return res(200, rows.filter(r => match(r, f)));
    if (method === "PATCH") { const patch = JSON.parse(body); const o = rows.filter(r => match(r, f)); o.forEach(r => Object.assign(r, patch)); return res(200, o); }
    if (method === "POST") { const row = { id: uuid(), created_at: new Date().toISOString(), ...JSON.parse(body) }; if (table === "money_keys" && rows.some(r => r.scope === row.scope)) return res(409, { code: "23505", message: "duplicate key value violates unique constraint \"money_keys_pkey\"" }); rows.push(row); return res(201, [row]); }
    if (method === "DELETE") { const keep = rows.filter(r => !match(r, f)); const gone = rows.length - keep.length; rows.length = 0; rows.push(...keep); return res(200, []); }
  }
  throw new Error("unexpected fetch " + url);
};
export const req = (method, path, { token, body, raw, headers } = {}) => new Request("https://cuvori.test/.netlify/functions/" + path, { method, headers: { ...(token ? { authorization: "Bearer " + token } : {}), ...(headers || {}) }, body: raw != null ? raw : body !== undefined ? JSON.stringify(body) : undefined });
export const sigFor = (payload, t = Math.floor(Date.now() / 1000), secret = "whsec_fake") => ({ t, v1: crypto.createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex") });
export const signed = (obj, secret) => { const raw = JSON.stringify({ id: rid("evt"), ...obj }); const s = sigFor(raw, undefined, secret); return { raw, headers: { "stripe-signature": `t=${s.t},v1=${s.v1}` } }; };
export const call = async (fn, r) => { try { const x = await fn(r); let j = null; try { j = await x.clone().json(); } catch {} return { status: x.status, json: j, headers: x.headers }; } catch (e) { return { status: 500, thrown: e.constructor.name + ": " + e.message }; } };
export const mk = (o = {}) => { const c = { id: uuid(), conversation_id: conv, editor: users.ed.id, client: users.cl.id, proposed_by: users.ed.id, title: "Job", price: 100, currency: "EUR", pricing: "project", status: "accepted", payment_mode: "escrow", amount_cents: 10000, fee_cents: 0, funded_cents: 0, released_cents: 0, refunded_cents: 0, has_milestones: false, stripe_payment_intent: null, ...o }; DB.contracts.push(c); return c; };
export const past = (h = 1) => new Date(Date.now() - h * 3600e3).toISOString();
export const moneyOut = (c) => ({ transferred: STRIPE.transfers.filter(t => t.contract === c.id).reduce((a, t) => a + t.amount - t.amount_reversed, 0), refunded: STRIPE.refunds.filter(r => r.contract === c.id).reduce((a, r) => a + r.amount, 0), orphans: STRIPE.refunds.filter(r => r.contract === c.id && r.metadata.reason).reduce((a, r) => a + r.amount, 0) });
export const reset = () => { hooks.stripe = null; hooks.db = null; STRIPE.settleDelay = false; };
export const onlyDue = (c) => { for (const x of DB.contracts) if (x !== c && ["delivered", "releasing", "resolving"].includes(x.status)) x.status = "completed"; for (const m of DB.order_milestones) if (m.order_id !== c.id && m.status !== "released") m.status = "released"; };
export const fns = async () => ({
  connect: (await import(F + "stripe-connect.mjs")).default, checkout: (await import(F + "stripe-checkout.mjs")).default, webhook: (await import(F + "stripe-webhook.mjs")).default,
  release: (await import(F + "stripe-release.mjs")).default, resolve: (await import(F + "stripe-resolve.mjs")).default, cancel: (await import(F + "stripe-cancel.mjs")).default,
  autoRelease: (await import(F + "stripe-auto-release.mjs")).default, status: (await import(F + "stripe-status.mjs")).default,
  confirm: await import(F + "stripe-confirm.mjs").then(m => m.default).catch(() => null) });
// fund an order the way a real client does: checkout -> pay -> webhook
export async function fund(fx, c, opts = {}) {
  const r0 = await call(fx.checkout, req("POST", "x", { token: opts.token || "tok_cl", body: { contract_id: c.id, ...(opts.body || {}) } }));
  if (r0.status !== 200) return { checkout: r0 };
  const s = pay(c.stripe_checkout_id, opts);
  const w = await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: s } })));
  return { checkout: r0, session: s, webhook: w };
}
