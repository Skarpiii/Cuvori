// Local test of the Netlify functions with a fake Stripe + fake Supabase (in-memory).
process.env.STRIPE_SECRET_KEY = "sk_test_fake"; process.env.SUPABASE_SERVICE_ROLE_KEY = "service_fake"; process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake"; process.env.SITE_URL = "https://cuvori.test";
import crypto from "node:crypto";
const log = []; const ok = (c, m) => log.push((c ? "PASS " : "FAIL ") + m);
const uuid = () => crypto.randomUUID();
const users = { ed: { id: uuid(), email: "maya@test.com", first_name: "Maya", role: "editor", is_admin: false, banned: false }, cl: { id: uuid(), email: "jonas@test.com", first_name: "Jonas", role: "client", is_admin: false, banned: false }, adm: { id: uuid(), email: "egi@test.com", first_name: "Egi", role: "client", is_admin: true, banned: false } };
const conv = uuid();
const DB = { rpc_calls: [], profiles: Object.values(users), payout_details: [], user_flags: [], contracts: [{ id: uuid(), conversation_id: conv, editor: users.ed.id, client: users.cl.id, proposed_by: users.ed.id, title: "Brand film", price: 300, currency: "EUR", pricing: "project", status: "accepted", payment_mode: "escrow", amount_cents: 30000 }], messages: [] };
const STRIPE = { accounts: {}, sessions: {}, transfers: [], refunds: [] };
const tokens = { "tok_ed": users.ed, "tok_cl": users.cl, "tok_adm": users.adm };

function parseFilter(q) { const p = new URLSearchParams(q); const f = []; for (const [k, v] of p) { if (["select", "limit", "order"].includes(k)) continue; const m = v.match(/^(eq|lte|in)\.(.*)$/); if (m) f.push({ k, op: m[1], v: m[1] === 'in' ? m[2].slice(1, -1).split(',') : m[2] }); } return f; }
const match = (row, f) => f.every(x => x.op === "in" ? x.v.includes(String(row[x.k])) : x.op === "eq" ? String(row[x.k]) === x.v : x.op === "lte" ? (row[x.k] != null && row[x.k] <= x.v) : true);
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url); const method = init.method || "GET"; const body = init.body;
  const res = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (u.hostname === "api.stripe.com") {
    const p = new URLSearchParams(body || ""); const path = u.pathname.replace("/v1", "");
    if (path === "/accounts" && method === "POST") { const id = "acct_1" + crypto.randomBytes(8).toString("hex"); STRIPE.accounts[id] = { id, metadata: { cuvori_user: p.get("metadata[cuvori_user]") }, payouts_enabled: false, charges_enabled: false, requirements: { currently_due: ["external_account"] } }; return res(200, STRIPE.accounts[id]); }
    if (path.startsWith("/accounts/") && method === "GET") return res(200, STRIPE.accounts[path.split("/")[2]]);
    if (path === "/account_links") return res(200, { url: "https://connect.stripe.com/setup/" + p.get("account") });
    if (path === "/checkout/sessions") { const id = "cs_" + Math.random().toString(36).slice(2, 8); STRIPE.sessions[id] = { id, url: "https://checkout.stripe.com/" + id, client_reference_id: p.get("client_reference_id"), amounts: [p.get("line_items[0][price_data][unit_amount]"), p.get("line_items[1][price_data][unit_amount]")] }; return res(200, STRIPE.sessions[id]); }
    if (path.startsWith("/payment_intents/") && method === "GET") return res(200, { id: path.split("/")[2], latest_charge: { id: "ch_test", payment_method_details: { card: { fingerprint: "fp_visa_4242", brand: "visa", last4: "4242" } } } });
    if (method === "GET" && path === "/transfers") return res(200, { data: STRIPE.transfers.filter(t => t.transfer_group === u.searchParams.get("transfer_group")) });
    if (method === "GET" && path === "/refunds") return res(200, { data: STRIPE.refunds.filter(r => r.payment_intent === u.searchParams.get("payment_intent")) });
    if (path === "/transfers") { const t = { id: "tr_" + Math.random().toString(36).slice(2, 8), amount: +p.get("amount"), destination: p.get("destination"), transfer_group: p.get("transfer_group"), metadata: { contract_id: p.get("metadata[contract_id]") }, source_transaction: p.get("source_transaction") }; STRIPE.transfers.push(t); return res(200, t); }
    if (path === "/refunds") { const r = { id: "re_" + Math.random().toString(36).slice(2, 8), amount: +p.get("amount"), payment_intent: p.get("payment_intent"), metadata: { contract_id: p.get("metadata[contract_id]") }, status: "succeeded" }; STRIPE.refunds.push(r); return res(200, r); }
    return res(404, { error: { message: "unknown " + path } });
  }
  if (u.pathname === "/auth/v1/user") { const t = (init.headers.Authorization || "").replace("Bearer ", ""); return tokens[t] ? res(200, tokens[t]) : res(401, {}); }
  if (u.pathname.startsWith("/rest/v1/rpc/")) { const fn = u.pathname.split("/")[4]; const args = JSON.parse(body); DB.rpc_calls.push({ fn, args }); return res(200, null); }
  if (u.pathname.startsWith("/rest/v1/")) {
    const table = u.pathname.split("/")[3]; const f = parseFilter(u.search.slice(1)); const rows = DB[table];
    if (method === "GET") return res(200, rows.filter(r => match(r, f)));
    if (method === "PATCH") { const patch = JSON.parse(body); const out = rows.filter(r => match(r, f)); out.forEach(r => Object.assign(r, patch)); return res(200, out); }
    if (method === "POST") { const row = { id: uuid(), created_at: new Date().toISOString(), ...JSON.parse(body) }; rows.push(row); return res(201, [row]); }
  }
  return realFetch(url, init);
};
const req = (method, path, { token, body, raw, headers } = {}) => new Request("https://cuvori.test/.netlify/functions/" + path, { method, headers: { ...(token ? { authorization: "Bearer " + token } : {}), ...(headers || {}) }, body: raw != null ? raw : body ? JSON.stringify(body) : undefined });
const sig = (payload) => { const t = Math.floor(Date.now() / 1000); const v1 = crypto.createHmac("sha256", "whsec_fake").update(`${t}.${payload}`).digest("hex"); return `t=${t},v1=${v1}`; };

const status = (await import("./netlify/functions/stripe-status.mjs")).default;
const connect = (await import("./netlify/functions/stripe-connect.mjs")).default;
const checkout = (await import("./netlify/functions/stripe-checkout.mjs")).default;
const webhook = (await import("./netlify/functions/stripe-webhook.mjs")).default;
const release = (await import("./netlify/functions/stripe-release.mjs")).default;
const resolve = (await import("./netlify/functions/stripe-resolve.mjs")).default;
const autoRelease = (await import("./netlify/functions/stripe-auto-release.mjs")).default;
const c0 = DB.contracts[0];

let r = await (await status(req("GET", "stripe-status"))).json(); ok(r.escrow === true, "status reports escrow enabled");
r = await checkout(req("POST", "stripe-checkout", { token: "tok_cl", body: { contract_id: c0.id } })); ok(r.status === 409, "checkout refused while editor has no Stripe account (" + r.status + ")");
r = await connect(req("POST", "stripe-connect", { token: "tok_cl" })); ok(r.status === 403, "client cannot onboard as editor");
r = await (await connect(req("POST", "stripe-connect", { token: "tok_ed" }))).json(); ok(/connect\.stripe\.com/.test(r.url), "editor gets onboarding link");
const acctId = DB.payout_details[0].stripe_account_id; ok(!!acctId, "stripe account id stored");
r = await (await connect(req("GET", "stripe-connect", { token: "tok_ed" }))).json(); ok(r.connected && !r.payouts_enabled, "status: connected, payouts not yet enabled");
STRIPE.accounts[acctId].payouts_enabled = true; STRIPE.accounts[acctId].charges_enabled = true;
let payload = JSON.stringify({ type: "account.updated", data: { object: STRIPE.accounts[acctId] } });
r = await webhook(req("POST", "stripe-webhook", { raw: payload, headers: { "stripe-signature": sig(payload) } })); ok(r.status === 200 && DB.payout_details[0].stripe_payouts_enabled === true, "webhook account.updated enables payouts");
r = await webhook(req("POST", "stripe-webhook", { raw: payload, headers: { "stripe-signature": "t=1,v1=bad" } })); ok(r.status === 400, "webhook rejects bad signature");
r = await checkout(req("POST", "stripe-checkout", { token: "tok_ed", body: { contract_id: c0.id } })); ok(r.status === 403, "editor cannot pay own contract");
r = await (await checkout(req("POST", "stripe-checkout", { token: "tok_cl", body: { contract_id: c0.id } }))).json(); ok(/checkout\.stripe\.com/.test(r.url) && r.amount === 30000 && r.fee === 925, `checkout session: €300 + fee €${r.fee / 100}`);
const sess = Object.values(STRIPE.sessions)[0]; ok(sess.amounts[0] === "30000" && sess.amounts[1] === "925", "line items: price + processing fee");
r = await release(req("POST", "stripe-release", { token: "tok_cl", body: { contract_id: c0.id } })); ok(r.status === 409, "cannot release before funded");
payload = JSON.stringify({ type: "checkout.session.completed", data: { object: { id: sess.id, client_reference_id: c0.id, payment_status: "paid", payment_intent: "pi_123", amount_total: 30925, currency: "eur" } } });
r = await webhook(req("POST", "stripe-webhook", { raw: payload, headers: { "stripe-signature": sig(payload) } })); ok(r.status === 200 && c0.status === "funded" && c0.stripe_payment_intent === "pi_123", "webhook marks contract funded");
ok(DB.messages.some(m => m.kind === "contract" && m.payload.event === "funded"), "funded event posted to chat");
ok(DB.rpc_calls.some(r => r.fn === "record_card" && r.args.fingerprint === "fp_visa_4242" && r.args.uid === users.cl.id && r.args.label === "visa ••4242"), "card fingerprint recorded for the client");
r = await release(req("POST", "stripe-release", { token: "tok_ed", body: { contract_id: c0.id } })); ok(r.status === 403, "editor cannot release to themselves");
r = await (await release(req("POST", "stripe-release", { token: "tok_cl", body: { contract_id: c0.id } }))).json(); ok(r.ok && c0.status === "completed" && STRIPE.transfers[0].amount === 30000 && STRIPE.transfers[0].destination === acctId, "client approval transfers €300 to editor");
// second contract: dispute → admin split
const c1 = { id: uuid(), conversation_id: conv, editor: users.ed.id, client: users.cl.id, proposed_by: users.ed.id, title: "Reel", price: 100, currency: "EUR", pricing: "project", status: "disputed", payment_mode: "escrow", amount_cents: 10000, stripe_payment_intent: "pi_456" }; DB.contracts.push(c1);
r = await resolve(req("POST", "stripe-resolve", { token: "tok_cl", body: { contract_id: c1.id, decision: "split", editor_percent: 60 } })); ok(r.status === 403, "non-admin cannot resolve");
r = await (await resolve(req("POST", "stripe-resolve", { token: "tok_adm", body: { contract_id: c1.id, decision: "split", editor_percent: 60, note: "Both partly right" } }))).json();
ok(r.ok && r.editorCents === 6000 && r.refundCents === 4000 && c1.status === "completed" && STRIPE.refunds[0].amount === 4000, "admin split 60/40: transfer + refund");
ok(DB.messages.some(m => m.body && m.body.startsWith("Cuvori decision")), "admin note posted to chat");
ok(DB.user_flags.length === 0, "split decision flags nobody");
// third: delivered 8 days ago → auto-release
const c2 = { id: uuid(), conversation_id: conv, editor: users.ed.id, client: users.cl.id, proposed_by: users.ed.id, title: "Old", price: 50, currency: "EUR", pricing: "project", status: "delivered", payment_mode: "escrow", amount_cents: 5000, stripe_payment_intent: "pi_789", auto_release_at: new Date(Date.now() - 86400000).toISOString() }; DB.contracts.push(c2);
r = await (await autoRelease()).json(); ok(r.released.length === 1 && c2.status === "completed" && STRIPE.transfers.at(-1).amount === 5000, "auto-release pays out after 7 days");
// refund decision
const c3 = { id: uuid(), conversation_id: conv, editor: users.ed.id, client: users.cl.id, proposed_by: users.ed.id, title: "Bad", price: 80, currency: "EUR", pricing: "project", status: "disputed", payment_mode: "escrow", amount_cents: 8000, stripe_payment_intent: "pi_000" }; DB.contracts.push(c3);
r = await (await resolve(req("POST", "stripe-resolve", { token: "tok_adm", body: { contract_id: c3.id, decision: "refund" } }))).json(); ok(r.ok && c3.status === "refunded" && STRIPE.refunds.at(-1).amount === 8000, "admin full refund");
ok(DB.user_flags.length === 1 && DB.user_flags[0].user_id === users.ed.id && DB.user_flags[0].kind === "dispute_lost", "editor auto-flagged after losing the dispute");
console.log(log.join("\n")); console.log(log.filter(l => l.startsWith("FAIL")).length ? "SOME FAILED" : "all function tests passed");
