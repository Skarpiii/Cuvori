import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

const env = (name) => String(process.env[name] || "").trim();
function configuredOrigin(value, name) {
  if (!value) throw new Error(`Missing configuration: ${name}`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`Invalid configuration: ${name}`); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error(`Invalid origin configuration: ${name}`);
  return url.origin;
}
// The project address is public (it is in the page too); a missing variable must not take every payment function down.
export const SUPABASE_URL = configuredOrigin(env("SUPABASE_URL") || "https://tnxujwlfatcvxzevllfr.supabase.co", "SUPABASE_URL");
// Legacy service-role keys are JWTs; new secret keys use only the apikey header.
export const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SECRET_KEY");
export const STRIPE_KEY = env("STRIPE_SECRET_KEY");
export const WEBHOOK_SECRET = env("STRIPE_WEBHOOK_SECRET");
export const SITE_URL = configuredOrigin(env("SITE_URL") || env("URL"), "SITE_URL or URL");
// the page may live on another host (GitHub Pages) and call these functions across origins
// An explicit list replaces the defaults; wildcard origins are not accepted.
export const ALLOWED_ORIGINS = [...new Set((env("ALLOWED_ORIGINS") || `${SITE_URL},https://cuvori.io,https://www.cuvori.io`).split(",").map(s => s.trim()).filter(Boolean).map(s => configuredOrigin(s, "ALLOWED_ORIGINS")))];
if (!ALLOWED_ORIGINS.length) throw new Error("ALLOWED_ORIGINS must contain at least one origin");
export const AUTO_RELEASE_DAYS = 7; // hard-coded in order_action() too
// Cuvori's conservative per-payment total cap, including the quoted fee.
// Provider limits also depend on currency/payment method and must be checked at Checkout.
export const MAX_PAYMENT_CENTS = 99999999;
export const MIN_CENTS = 100, MAX_CENTS = 95000000;
export const HOLDING = ["funded", "delivered", "disputed"];
const holdsFunds = (c) => !!c && [...HOLDING, "releasing", "resolving"].includes(c.status);

export function escrowEnabled() { return !!(STRIPE_KEY && SERVICE_KEY && WEBHOOK_SECRET); }

const corsContext = new AsyncLocalStorage();
export function setCors(req) {
  const o = req && req.headers.get("origin") || "";
  corsContext.enterWith({ origin: ALLOWED_ORIGINS.includes(o) ? o : null });
}
const corsHeaders = () => {
  const origin = corsContext.getStore()?.origin;
  return origin ? { "access-control-allow-origin": origin, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS", "vary": "origin" } : { "vary": "origin" };
};
export const json = (status, body, extraHeaders = {}) => new Response(JSON.stringify(body), { status, headers: { ...extraHeaders, "content-type": "application/json", "cache-control": "no-store", ...corsHeaders() } });
export const bad = (msg, status = 400, extraHeaders = {}) => json(status, { error: msg }, extraHeaders);
export const isUuid = (s) => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
export const isAcct = (s) => typeof s === "string" && /^acct_[A-Za-z0-9]{8,64}$/.test(s);
export const isPi = (s) => typeof s === "string" && /^pi_[A-Za-z0-9_]{4,80}$/.test(s);
export const isStripeId = (s) => typeof s === "string" && /^[a-z]{2,4}_[A-Za-z0-9_]{4,80}$/.test(s);
export const isSession = (s) => typeof s === "string" && /^cs_[A-Za-z0-9_]{4,120}$/.test(s);
export const centsOf = (c) => (Number.isInteger(c.amount_cents) && c.amount_cents > 0 ? c.amount_cents : null);
const nz = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
// what the provider is holding for this Order right now (Orders from before v18 carry no counters)
export const heldCents = (c) => { const f = nz(c.funded_cents) || (holdsFunds(c) ? centsOf(c) || 0 : 0); return Math.max(f - nz(c.released_cents) - nz(c.refunded_cents), 0); };
export const chargebackOpen = (c) => !!c && c.chargeback_status === "open";
export async function readJson(req) { try { const b = await req.json(); return b && typeof b === "object" && !Array.isArray(b) ? b : {}; } catch { return {}; } }
// Never let an exception (Stripe/Supabase message, stack) reach the browser
export const safe = (fn) => async (req, ctx) => corsContext.run({ origin: null }, async () => {
  setCors(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  try { return await fn(req, ctx); }
  catch (e) {
    if (e && e.expose) return bad(e.message, e.status || 409);
    const ref = crypto.randomUUID().slice(0, 8); console.error("fn error", ref, e && e.stack || e);
    return bad(`Something went wrong (ref ${ref})`, 500);
  }
});
export const fail = (msg, status = 409) => { const e = new Error(msg); e.expose = true; e.status = status; return e; };
const SETTLING = "The card payment is still settling at the payment provider. Cuvori retries this every hour; nothing needs to be done.";
const NOT_READY = "The freelancer's Stripe account is not ready to receive money. Once they finish their Stripe setup, Cuvori retries this every hour.";
const CHARGEBACK = "A card chargeback is open on this payment. Nothing can move until the bank decides.";

// ---- Stripe (form-encoded REST) ----
function encode(obj, prefix) {
  const out = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    if (typeof v === "number" && !Number.isFinite(v)) throw new Error(`refusing to send non-finite ${k}`);
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => { if (item && typeof item === "object") out.push(encode(item, `${key}[${i}]`)); else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`); });
    else if (typeof v === "object") out.push(encode(v, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.filter(Boolean).join("&");
}
export async function stripe(method, path, body, opts = {}) {
  if (!STRIPE_KEY) throw fail("Payments are not configured. Please contact support.", 503);
  if (!/^\/[a-z_]+(\/[A-Za-z0-9_]+)*$/.test(path)) throw new Error("bad Stripe path");
  const headers = { Authorization: `Bearer ${STRIPE_KEY}`, "Stripe-Version": "2024-06-20" };
  if (opts.idempotency) headers["Idempotency-Key"] = opts.idempotency;
  let url = `https://api.stripe.com/v1${path}`;
  const init = { method, headers, signal: AbortSignal.timeout(8000) };
  if (method === "GET") { if (body) url += "?" + encode(body); }
  else { headers["content-type"] = "application/x-www-form-urlencoded"; init.body = encode(body || {}); }
  let r;
  try { r = await fetch(url, init); }
  catch (e) { const x = new Error("Could not reach the payment provider: " + (e && e.message || "network")); x.network = true; throw x; }
  let data;
  try { data = await r.json(); }
  catch { const e = new Error("Unreadable payment provider response"); e.outcomeUnknown = true; e.status = r.status; throw e; }
  if (!data || typeof data !== "object" || Array.isArray(data)) { const e = new Error("Invalid payment provider response"); e.outcomeUnknown = true; throw e; }
  if (!r.ok) { const e = new Error((data.error && data.error.message) || "Stripe error"); e.stripe = data.error || {}; e.status = r.status; e.shouldRetry = r.headers.get("Stripe-Should-Retry") === "true"; throw e; }
  return data;
}
const stripeCode = (e) => (e && e.stripe && (e.stripe.code || e.stripe.decline_code)) || "";
const isIdemInFlight = (e) => e && e.stripe && e.stripe.type === "idempotency_error";

// Stripe-Signature: t=...,v1=...[,v1=...]  (several v1 during secret rotation)
export function verifyWebhook(rawBody, sigHeader, secret = WEBHOOK_SECRET, toleranceSec = 300) {
  if (!secret) throw new Error("webhook not configured");
  let t = null; const v1s = [];
  for (const part of String(sigHeader || "").split(",")) {
    const i = part.indexOf("="); if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t") t = v; else if (k === "v1") v1s.push(v);
  }
  if (!t || !/^\d{1,12}$/.test(t) || !v1s.length) throw new Error("bad signature");
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) throw new Error("bad signature");
  const expected = Buffer.from(crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"));
  const okSig = v1s.some(v => { const b = Buffer.from(v); return b.length === expected.length && crypto.timingSafeEqual(expected, b); });
  if (!okSig) throw new Error("bad signature");
  return JSON.parse(rawBody);
}

// ---- Supabase REST with the service role ----
function requireServiceKey() {
  if (!SERVICE_KEY) throw fail("Database access is not configured. Please contact support.", 503);
}
async function sbFetch(path, init = {}) {
  requireServiceKey();
  const auth = SERVICE_KEY.startsWith("sb_secret_") ? {} : { Authorization: `Bearer ${SERVICE_KEY}` };
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, { ...init, signal: AbortSignal.timeout(8000), headers: { apikey: SERVICE_KEY, ...auth, "content-type": "application/json", Prefer: init.prefer || "return=representation", ...(init.headers || {}) } });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) { const e = new Error((data && data.message) || `Supabase ${r.status}`); e.status = r.status; throw e; }
  return data;
}
const q = encodeURIComponent;
export const db = {
  select: (table, query) => sbFetch(`/${table}?${query}`),
  one: async (table, query) => { const rows = await sbFetch(`/${table}?${query}&limit=1`); return rows && rows[0] || null; },
  update: (table, query, patch) => sbFetch(`/${table}?${query}`, { method: "PATCH", body: JSON.stringify(patch) }),
  insert: (table, row) => sbFetch(`/${table}`, { method: "POST", body: JSON.stringify(row) }),
  remove: (table, query) => sbFetch(`/${table}?${query}`, { method: "DELETE" }),
  rpc: (fn, args) => sbFetch(`/rpc/${fn}`, { method: "POST", body: JSON.stringify(args || {}) }),
  contract: (id) => { if (!isUuid(id)) throw fail("Bad order id", 400); return db.one("contracts", `id=eq.${id}&select=*`); },
  milestone: (id) => { if (!isUuid(id)) throw fail("Bad milestone id", 400); return db.one("order_milestones", `id=eq.${id}&select=*`); },
  // compare-and-set: only moves the row if it is still in one of `from`; returns the new row or null
  claim: async (id, from, patch) => { if (!isUuid(id)) throw fail("Bad order id", 400); const rows = await db.update("contracts", `id=eq.${id}&status=in.(${from.map(q).join(",")})`, patch); return rows && rows[0] || null; },
  claimMilestone: async (id, from, patch) => { if (!isUuid(id)) throw fail("Bad milestone id", 400); const rows = await db.update("order_milestones", `id=eq.${id}&status=in.(${from.map(q).join(",")})`, patch); return rows && rows[0] || null; },
};
// the Order behind a Stripe payment: the first payment is on the row, top-ups are in the ledger
export async function contractByPi(pi) {
  if (!isPi(pi)) return null;
  const c = await db.one("contracts", `stripe_payment_intent=eq.${q(pi)}&select=*`);
  if (c) return c;
  const row = await db.one("order_payments", `provider_ref=eq.${q(pi)}&kind=eq.fund&select=order_id`);
  return row ? db.contract(row.order_id) : null;
}

export async function userFromRequest(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") || "");
  if (!m) return null;
  requireServiceKey();
  let r;
  try { r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${m[1]}` }, signal: AbortSignal.timeout(8000) }); }
  catch { throw fail("Sign-in verification is temporarily unavailable. Please try again shortly.", 503); }
  if (r.status === 429) throw fail("Too many sign-in checks. Please try again shortly.", 429);
  if (r.status >= 500) throw fail("Sign-in verification is temporarily unavailable. Please try again shortly.", 503);
  let u;
  try { u = await r.json(); }
  catch { throw fail("Sign-in verification is temporarily unavailable. Please try again shortly.", 503); }
  if (!r.ok) {
    // Supabase Auth: `error_code` is the name ("bad_jwt"); `code` is often just the HTTP status number
    const code = u && (u.error_code || (typeof u.code === "string" ? u.code : null));
    if (code === "user_banned") throw fail("Account suspended", 403);
    if (["bad_jwt", "session_not_found", "session_expired", "user_not_found", "no_authorization", "invalid_credentials"].includes(code)) return null;
    // Older Auth responses may have no code. An API-key failure concerns the backend,
    // so signing in again would not help. Never send the provider's raw message back.
    const message = String(u && (u.message || u.msg || u.error_description || u.error) || "");
    if (!code && (r.status === 401 || r.status === 403) && /jwt|token|session|expired/i.test(message) && !/api.?key/i.test(message)) return null;
    throw fail("Sign-in verification is unavailable. Please contact support if this continues.", 503);
  }
  if (!u || !isUuid(u.id)) throw fail("Sign-in verification is temporarily unavailable. Please try again shortly.", 503);
  return db.one("profiles", `id=eq.${u.id}&select=id,email,first_name,role,is_admin,banned`);
}
export const isBanned = async (uid) => { const p = await db.one("profiles", `id=eq.${uid}&select=banned`); return !p || !!p.banned; };

// ---- the price the client pays: from the fee table in the database, never a number in code ----
export async function quoteFor(priceCents, currency = "EUR", country = null, customer = "any", method = "any") {
  if (!Number.isSafeInteger(priceCents) || priceCents < MIN_CENTS || priceCents > MAX_CENTS) throw fail("Order amount is outside the allowed range.", 400);
  const qte = await db.rpc("order_quote", { p_price_cents: priceCents, p_currency: currency, p_country: country, p_customer: customer, p_method: method });
  if (!qte || !Number.isSafeInteger(qte.total_cents) || qte.total_cents < priceCents) throw new Error("bad quote");
  if (qte.total_cents > MAX_PAYMENT_CENTS) throw fail("The order total including fees exceeds the payment limit.", 400);
  return qte;
}

// ---- history, ledger, chat card ----
export async function orderEvent(c, ev, data, actor) {
  if (!c) return;
  await db.insert("order_events", { order_id: c.id, actor: actor || null, event: ev, data: data || {} }).catch(e => console.error("event", ev, e.message));
}
export async function ledger(c, row) {
  await db.insert("order_payments", { order_id: c.id, provider: "stripe", status: "succeeded", ...row }).catch(e => console.error("ledger", e.message));
}
export async function contractEvent(c, ev, sender, extra) {
  if (!c) return;
  await db.insert("messages", { conversation_id: c.conversation_id, sender: sender || c.editor, kind: "contract", body: c.title,
    payload: { contract_id: c.id, event: ev, title: c.title, price: c.price, currency: c.currency, pricing: c.pricing, status: c.status, amount_cents: c.amount_cents, ...(extra || {}) } });
}
const fundRows = async (c) => { const rows = await db.select("order_payments", `order_id=eq.${c.id}&kind=eq.fund&status=eq.succeeded&select=*&order=created_at.asc`); return rows || []; };

// ---- idempotency keys that survive retries ----
// Keep the key after uncertain outcomes, including server errors. Only known rejections permit
// a new attempt. Provider lookups are additional safeguards, not a guarantee of exactly-once execution.
// Old unresolved attempts stop for reconciliation before Stripe can expire their keys.
export async function moneyKey(scope) {
  const row = await db.one("money_keys", `scope=eq.${q(scope)}&select=key`);
  if (row && row.key) return row.key;
  const key = `${scope}:${crypto.randomUUID().slice(0, 12)}`;
  try { await db.insert("money_keys", { scope, key }); return key; }
  catch (e) { const again = await db.one("money_keys", `scope=eq.${q(scope)}&select=key`); if (again && again.key) return again.key; throw e; }
}
export const dropKey = (scope) => db.remove("money_keys", `scope=eq.${q(scope)}`).catch(() => {});
// A one-time claim: the first caller gets it, every other caller is told no. Postgres decides (the scope is
// the table's primary key), so two functions running at the same moment cannot both win.
async function claimScope(scope) {
  try { await db.insert("money_keys", { scope, key: `claim:${crypto.randomUUID().slice(0, 12)}` }); return true; }
  catch (e) { if (e.status === 409) return false; throw e; }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// One money move per Order at a time. A milestone release and a whole-order settlement both read the held
// amount and then move money; two of them at once could each pass that check. The lock is a money_keys row
// that the holder removes when done. A second request waits for its turn (up to 5 s, then a plain message);
// a lock older than 90 s belongs to a function that died and is taken over.
const LOCK_STALE_MS = 90e3, LOCK_WAIT_MS = 5000, LOCK_POLL_MS = 200;
export async function lockOrder(id) {
  const scope = `lock:${id}`;
  const until = Date.now() + LOCK_WAIT_MS;
  do {
    if (await claimScope(scope)) return () => dropKey(scope);
    const row = await db.one("money_keys", `scope=eq.${q(scope)}&select=created_at`);
    if (row && row.created_at && Date.now() - Date.parse(row.created_at) > LOCK_STALE_MS) {          // only that stale row, never a fresh one taken meanwhile
      await db.remove("money_keys", `scope=eq.${q(scope)}&created_at=lt.${q(new Date(Date.now() - LOCK_STALE_MS).toISOString())}`).catch(() => {}); continue;
    }
    await sleep(LOCK_POLL_MS);
  } while (Date.now() < until);
  throw fail("Another payment step on this order is still running. Please try again in a moment.", 409);
}
async function moneyPost(scope, path, body) {
  const key = await moneyKey(scope);
  try { return await stripe("POST", path, body, { idempotency: key }); }
  catch (e) {
    // Keep the key only when the outcome is unknown (no answer, unreadable answer, Stripe says "retry with the
    // same key", or the same key is still in flight). Any other answer is final for this key — including a 500,
    // which Stripe saves and would replay for 24 h. The next attempt gets a fresh key; the Stripe-side lookups
    // before every transfer, refund and reversal are what keep a fresh attempt from paying twice.
    const unknown = e.network || e.outcomeUnknown || e.shouldRetry || isIdemInFlight(e) || !e.status;
    if (!unknown) await db.remove("money_keys", `scope=eq.${q(scope)}&key=eq.${q(key)}`).catch(() => {});
    throw e;
  }
}

// Editor's connected account, verified against Stripe (not just the DB row)
export async function payoutAccount(editorId) {
  const p = await db.one("payout_details", `id=eq.${editorId}&select=stripe_account_id`);
  if (!p || !isAcct(p.stripe_account_id)) return null;
  let acct;
  try { acct = await stripe("GET", `/accounts/${p.stripe_account_id}`); }
  catch (e) { if (e.status === 404 || e.status === 403) return null; throw e; }
  if (!acct || !acct.metadata || acct.metadata.cuvori_user !== editorId) return null;
  return acct;
}
// Keep the existing charge/payout restrictions and explicitly require the capability
// used by Cuvori's separate transfers. Review requested capabilities with stripe-connect.mjs.
export const accountReady = (a) => !!(a && a.charges_enabled === true && a.payouts_enabled === true && a.capabilities?.transfers === "active");

// ---- money movements ----
export async function transfersOf(c) { const r = await stripe("GET", "/transfers", { transfer_group: `contract_${c.id}`, limit: 100 }); return (r.data || []).filter(t => t.metadata && t.metadata.contract_id === c.id); }

// Pay the freelancer. `purpose` separates a normal release from paying again after a chargeback was won.
export async function releaseToEditor(c, editorCents, milestoneId = null, purpose = "release") {
  if (!Number.isInteger(editorCents) || editorCents <= 0) throw new Error("bad release amount");
  if (purpose === "release" && editorCents > heldCents(c)) throw new Error("bad release amount");
  if (chargebackOpen(c)) throw fail(CHARGEBACK);
  // a transfer for the same milestone / the same settlement attempt is never made twice. Whole-order releases carry
  // the attempt (the decision's timestamp): a later, different decision on the same Order may transfer again.
  const attemptTag = milestoneId || purpose !== "release" ? "" : String(c.resolved_at || "");
  const existing = await transfersOf(c);
  const prior = existing.find(t => !t.reversed && (t.metadata.milestone_id || "") === (milestoneId || "") && (t.metadata.purpose || "release") === purpose && (!t.metadata.attempt || t.metadata.attempt === attemptTag));
  if (prior) { if (prior.amount !== editorCents) throw new Error(`transfer ${prior.id} exists with a different amount`); return prior.id; }
  // Existing transfers above still need reconciliation; a ban blocks new transfers.
  if (await isBanned(c.editor)) throw fail("This freelancer cannot receive payments", 409);
  const acct = await payoutAccount(c.editor);
  if (!accountReady(acct)) throw fail(NOT_READY);
  // tie the transfer to the card charge when there is exactly one: Stripe then allows it before the money
  // has settled. Several charges (top-ups) or a re-payment draw on the balance instead.
  const funds = await fundRows(c);
  const charges = [...new Set(funds.map(f => f.charge_ref).filter(isStripeId))]; if (!charges.length && isStripeId(c.stripe_charge_id)) charges.push(c.stripe_charge_id);
  const fundedFrom = funds.length ? funds.length : (c.stripe_payment_intent ? 1 : 0);
  const source = purpose === "release" && charges.length === 1 && fundedFrom <= 1 ? charges[0] : undefined;
  const scope = `transfer:${c.id}:${milestoneId || ""}:${purpose}${attemptTag ? ":" + attemptTag : ""}`;
  const body = { amount: editorCents, currency: (c.currency || "EUR").toLowerCase(), destination: acct.id, transfer_group: `contract_${c.id}`,
    description: `Cuvori order ${c.id}${milestoneId ? " milestone " + milestoneId : ""}`, metadata: { contract_id: c.id, milestone_id: milestoneId || "", purpose, attempt: attemptTag } };
  const attempt = async (src, sc) => moneyPost(sc, "/transfers", src ? { ...body, source_transaction: src } : body);
  try {
    try { return (await attempt(source, scope)).id; }
    catch (e) {
      // the charge cannot cover it (fees higher than quoted, a refund on it): pay from the balance instead
      if (source && e.status === 400 && /source|exceed|available on the/i.test(e.message)) return (await attempt(undefined, scope + ":balance")).id;
      throw e;
    }
  } catch (e) {
    if (stripeCode(e) === "balance_insufficient" || /insufficient funds/i.test(e.message)) throw fail(SETTLING);
    if (/capabilit|destination|No such account|payouts/i.test(e.message) && e.status === 400) throw fail(NOT_READY);
    if (e.network) throw fail("The payment provider did not answer. Nothing was lost — please try again in a minute.", 503);
    throw e;
  }
}
// Give money back to the client: spread over the payments it came from (top-ups first), each one only
// as far as that payment still allows. Money already given back from the Stripe dashboard (not by Cuvori)
// is already out of the held amount, so it only shrinks what a payment can still return; Cuvori's own
// earlier refunds count towards the plan, so a retry never pays twice. Returns the refund ids.
const OURS = (r) => !!(r.metadata && (r.metadata.contract_id || r.metadata.reason));
export async function refundToClient(c, cents) {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error("bad refund amount");
  if (chargebackOpen(c)) throw fail(CHARGEBACK);
  const funds = await fundRows(c);
  const sources = funds.length ? funds.map(f => ({ pi: f.provider_ref, amount: f.amount_cents })).reverse() : (c.stripe_payment_intent ? [{ pi: c.stripe_payment_intent, amount: nz(c.funded_cents) || centsOf(c) || 0 }] : []);
  if (!sources.length) throw new Error("no payment to refund");
  try {
    for (const s of sources) {
      if (!isPi(s.pi)) continue;
      const existing = ((await stripe("GET", "/refunds", { payment_intent: s.pi, limit: 50 })).data || []).filter(r => r.status !== "failed" && r.status !== "canceled");
      s.outside = Math.min(existing.filter(r => !OURS(r)).reduce((a, r) => a + r.amount, 0), s.amount);
      s.done = existing.filter(OURS).reduce((a, r) => a + r.amount, 0);
      s.ids = existing.filter(OURS).map(r => r.id);
    }
    // what each payment should have given back once this refund is complete (deterministic, so a retry lands on the same plan)
    let left = cents; const plan = [];
    for (const s of sources) { if (left <= 0) break; if (!isPi(s.pi)) continue; const part = Math.min(left, s.amount - s.outside); if (part <= 0) continue; plan.push({ ...s, cents: part }); left -= part; }
    if (left > 0) throw new Error("refund exceeds what was paid");
    const ids = [];
    for (const p of plan) {
      if (p.done >= p.cents) { ids.push(...p.ids); continue; }
      const r = await moneyPost(`refund:${c.id}:${p.pi}:${p.done}`, "/refunds", { payment_intent: p.pi, amount: p.cents - p.done, metadata: { contract_id: c.id } });
      ids.push(...p.ids, r.id);
    }
    return ids.join(",");
  } catch (e) {
    if (stripeCode(e) === "balance_insufficient" || /insufficient funds/i.test(e.message)) throw fail("The payment provider cannot pay this refund yet (balance still settling). Cuvori retries every hour.");
    if (stripeCode(e) === "charge_disputed" || /charged back/i.test(e.message)) throw fail(CHARGEBACK);
    if (e.network) throw fail("The payment provider did not answer. Nothing was lost — please try again in a minute.", 503);
    throw e;
  }
}
// Take money back from the freelancer's account (a chargeback after a release). Newest transfers first.
export async function reverseTransfers(c, cents, why) {
  const ts = (await transfersOf(c)).filter(t => t.amount - nz(t.amount_reversed) > 0).sort((a, b) => (b.created || 0) - (a.created || 0));
  let left = cents; const ids = [];
  for (const t of ts) {
    if (left <= 0) break;
    const part = Math.min(left, t.amount - nz(t.amount_reversed));
    const r = await moneyPost(`reversal:${c.id}:${t.id}:${why}`, `/transfers/${t.id}/reversals`, { amount: part, metadata: { contract_id: c.id, reason: why } });
    ids.push(r.id); left -= part;
  }
  return { ids: ids.join(","), reversed: cents - left };
}

// Finish an Order that is in 'releasing' / 'resolving' using the amounts recorded when it was claimed.
// Whatever was already released for milestones stays where it is; this settles the remainder.
export async function settle(c0, actor, ev) {
  const unlock = await lockOrder(c0.id);
  try { return await settleLocked(c0, actor, ev); } finally { await unlock(); }
}
async function settleLocked(c0, actor, ev) {
  // fresh row: the amounts were decided when the Order was claimed, and a milestone release that was already
  // running at that moment may have moved money since. Whatever is settled here never exceeds what is held now.
  let c = (await db.contract(c0.id)) || c0;
  if (chargebackOpen(c)) throw fail(CHARGEBACK);
  if (c.status !== c0.status) throw fail("The order changed a moment ago — reload the page.", 409);
  const editorCents = nz(c.split_editor_cents), refundCents = nz(c.refund_cents);
  const now = new Date().toISOString();
  // Each money move is written into the counters and the ledger the moment it succeeds, so an interrupted
  // settlement (transfer made, refund refused) leaves books that are right, and a later decision or chargeback
  // works from them. A move whose id is on the row but not in the ledger (recorded by an older version) is counted now.
  let transferId = c.stripe_transfer_id, refundId = c.stripe_refund_id;
  const rows = (await db.select("order_payments", `order_id=eq.${c.id}&status=eq.succeeded&select=kind,provider_ref,amount_cents`)) || [];
  const sumOf = (kind) => rows.filter(r => r.kind === kind).reduce((a, r) => a + r.amount_cents, 0);
  const inLedger = (kind, ref) => !!ref && rows.some(r => r.kind === kind && r.provider_ref === String(ref).slice(0, 200));
  // a move is counted when its ledger line exists — or when the counter is already ahead of the ledger by at least
  // its amount (counter written, line lost): then only the line is missing. Anything else on the row is counted now.
  const line = async (kind, cents, ref) => db.insert("order_payments", { order_id: c.id, provider: "stripe", status: "succeeded", kind, amount_cents: cents, provider_ref: String(ref).slice(0, 200), note: ev }).catch(e => console.error("ledger", e.message));
  const gapE = nz(c.released_cents) - (sumOf("release") - sumOf("reversal")), gapR = nz(c.refunded_cents) - sumOf("refund") - sumOf("chargeback");
  let doneT = inLedger("release", transferId), doneR = inLedger("refund", refundId);
  if (!doneT && transferId && editorCents > 0 && gapE >= editorCents) { await line("release", editorCents, transferId); doneT = true; }
  if (!doneR && refundId && refundCents > 0 && gapR >= refundCents) { await line("refund", refundCents, refundId); doneR = true; }
  // a whole-order transfer at the provider that the books do not show (an earlier decision that broke off before it
  // could be written down) is the freelancer's money already: it is counted before anything else moves
  for (const t of (await transfersOf(c)).filter(t => !t.reversed && !(t.metadata.milestone_id || "") && (t.metadata.purpose || "release") === "release" && t.metadata.attempt && t.metadata.attempt !== String(c.resolved_at || "") && !rows.some(r => r.kind === "release" && r.provider_ref === t.id))) {
    const net = t.amount - nz(t.amount_reversed);
    if (net <= 0) continue;
    const upd = await db.update("contracts", `id=eq.${c.id}&status=eq.${c.status}`, { released_cents: nz(c.released_cents) + net });
    if (!upd || !upd[0]) throw new Error("order changed during settlement");
    c = upd[0]; await line("release", net, t.id); console.error("counted a transfer the books did not show", c.id, t.id, net);
  }
  let pendE = doneT ? 0 : editorCents, pendR = doneR ? 0 : refundCents;
  const held = heldCents(c);
  if (pendE + pendR > held) {
    // less is held than when the decision was made: what is still to move shrinks in the same proportion
    const e2 = pendE + pendR > 0 ? Math.min(Math.round(held * pendE / (pendE + pendR)), held) : 0, r2 = held - e2;
    console.error("settlement adjusted to what is held", c.id, { pendE, pendR, held, e2, r2 });
    pendE = e2; pendR = r2;
    await db.update("contracts", `id=eq.${c.id}&status=eq.${c.status}`, { split_editor_cents: (doneT ? editorCents : 0) + pendE, refund_cents: (doneR ? refundCents : 0) + pendR });
  }
  const count = async (kind, cents, ref) => {
    const field = kind === "release" ? "released_cents" : "refunded_cents";
    const rows = await db.update("contracts", `id=eq.${c.id}&status=eq.${c.status}`, { [kind === "release" ? "stripe_transfer_id" : "stripe_refund_id"]: String(ref).slice(0, 200), [field]: nz(c[field]) + cents, funded_cents: nz(c.funded_cents) || centsOf(c) || 0 });
    if (!rows || !rows[0]) throw new Error("order changed during settlement");
    c = rows[0];
    await db.insert("order_payments", { order_id: c.id, provider: "stripe", status: "succeeded", kind, amount_cents: cents, provider_ref: String(ref).slice(0, 200), note: ev });
  };
  try {
    if (pendE > 0) { if (!transferId) transferId = await releaseToEditor(c, pendE); await count("release", pendE, transferId); }
    if (pendR > 0) { if (!refundId) refundId = await refundToClient(c, pendR); await count("refund", pendR, refundId); }
  } catch (e) {
    await db.update("contracts", `id=eq.${c.id}`, { money_error: String(e.message).slice(0, 300) }).catch(() => {});
    throw e;
  }
  const movedE = (doneT ? editorCents : 0) + pendE, movedR = (doneR ? refundCents : 0) + pendR;
  // the decision names the outcome; when nothing was left to move (milestones took it all), whoever has the money does
  const paid = movedE + movedR > 0 ? movedE > 0 : nz(c.released_cents) > 0;
  const u = (await db.update("contracts", `id=eq.${c.id}&status=eq.${c.status}`, { status: paid ? "completed" : "refunded",
    completed_at: paid ? now : null, closed_at: now, resolved_at: now, money_error: null, auto_release_at: null,
    funded_cents: nz(c.funded_cents) || centsOf(c) || 0 }))[0];
  if (!u) { await db.update("contracts", `id=eq.${c.id}`, { money_error: `settled at the provider (${transferId || ""} ${refundId || ""}) but the order changed meanwhile — check by hand` }).catch(() => {}); throw new Error("order changed during settlement"); }
  await orderEvent(u, ev === "approve" ? "released" : ev === "auto_release" ? "auto_released" : ev.startsWith("resolved") ? "resolved" : ev, { editor_cents: movedE, refund_cents: movedR, decision: u.resolution }, actor);
  await contractEvent(u, ev, actor, { amount_cents: movedE || movedR });
  return u;
}

// Release one milestone: transfer its amount, mark it released, add it to the Order's counters.
// When it was the last one the Order is complete.
export async function releaseMilestone(c0, m, actor, ev) {
  if (!m || m.order_id !== c0.id) throw fail("Milestone does not belong to this order", 409);
  if (!["submitted", "approved"].includes(m.status)) throw fail("This milestone is not waiting for approval", 409);
  const unlock = await lockOrder(c0.id);
  try { return await releaseMilestoneLocked(c0, m, actor, ev); } finally { await unlock(); }
}
async function releaseMilestoneLocked(c0, m, actor, ev) {
  // fresh row under the lock: another milestone, a refund or a chargeback may have moved money since the caller looked
  const c = await db.contract(c0.id);
  if (!c) throw fail("Order not found", 404);
  if (!["funded", "delivered"].includes(c.status)) throw fail("Nothing to release right now", 409);
  if (chargebackOpen(c)) throw fail(CHARGEBACK);
  if (m.amount_cents > heldCents(c)) throw fail("Not enough money is held for this milestone", 409);
  const claimed = await db.claimMilestone(m.id, ["submitted", "approved"], { status: "approved", approved_at: m.approved_at || new Date().toISOString(), auto_release_at: null });
  if (!claimed) throw fail("This milestone was just changed, reload", 409);
  let transferId;
  try { transferId = await releaseToEditor(c, m.amount_cents, m.id); }
  catch (e) { await db.update("contracts", `id=eq.${c.id}`, { money_error: String(e.message).slice(0, 300) }).catch(() => {}); throw e; }
  const now = new Date().toISOString();
  const marked = await db.claimMilestone(m.id, ["approved"], { status: "released", released_at: now, transfer_ref: transferId });
  if (!marked) return transferId;                                                      // another request marked it first: it also moved the counters
  // the counters move exactly once per milestone, even when two milestones are released at the same moment
  let u = null;
  for (let i = 0; i < 8 && !u; i++) {
    const cur = i === 0 ? c : await db.contract(c.id);
    const rows = await db.update("contracts", `id=eq.${c.id}&released_cents=eq.${nz(cur.released_cents)}`, { released_cents: nz(cur.released_cents) + m.amount_cents, money_error: null, changes_open: false });
    u = rows && rows[0] || null;
  }
  if (!u) { await db.update("contracts", `id=eq.${c.id}`, { money_error: `counter update failed for milestone ${m.id}` }).catch(() => {}); throw new Error("could not record the release"); }
  await ledger(u, { kind: "release", milestone_id: m.id, amount_cents: m.amount_cents, provider_ref: transferId, note: ev });
  await orderEvent(u, ev === "auto_release" ? "milestone_auto_released" : "milestone_released", { milestone: m.id, title: m.title, amount_cents: m.amount_cents }, actor);
  await contractEvent(u, "milestone_approved", actor || c.client, { amount_cents: m.amount_cents, label: m.title });
  const open = await db.select("order_milestones", `order_id=eq.${c.id}&status=neq.released&select=id`);
  if (!open || !open.length) {
    const done = await db.claim(c.id, ["funded", "delivered"], { status: "completed", completed_at: now, closed_at: now, auto_release_at: null });
    if (done) { await orderEvent(done, "completed", {}, actor); await contractEvent(done, "complete", actor || c.client); }
  }
  return transferId;
}

// ---- a paid Checkout session becomes a funded Order (webhook and reconciliation share this) ----
async function refundOrphan(s, why) {
  console.error("refunding payment that cannot fund an order", s.id, why);
  await moneyPost(`orphan:${s.payment_intent}`, "/refunds", { payment_intent: s.payment_intent, amount: s.amount_total, metadata: { contract_id: s.client_reference_id || "", reason: why.slice(0, 200) } });
  return "refunded";
}
export async function applyPaidSession(s) {
  if (!s || (s.mode !== undefined && s.mode !== "payment")) return "ignored";
  if (s.payment_status !== "paid") return "unpaid";                              // async methods: wait for async_payment_succeeded
  const id = s.client_reference_id;
  if (!isUuid(id) || !isPi(s.payment_intent)) return "ignored";
  const c = await db.contract(id);
  if (!c) return refundOrphan(s, "unknown order");
  if (c.stripe_payment_intent === s.payment_intent) return "already";             // duplicate delivery of the first payment
  const dupTop = await db.one("order_payments", `order_id=eq.${id}&provider_ref=eq.${q(s.payment_intent)}&select=id`);
  if (dupTop) return "already";
  const md = s.metadata || {};
  const kind = md.kind === "topup" ? "topup" : "fund";
  // sessions made before v18 carry no amounts in their metadata: the Order row has them
  const amount = md.amount_cents != null ? Number(md.amount_cents) : centsOf(c), fee = md.fee_cents != null ? Number(md.fee_cents) : (Number.isInteger(c.fee_cents) ? c.fee_cents : 0);
  const expected = kind === "fund" ? centsOf(c) : Math.max((centsOf(c) || 0) - nz(c.funded_cents), 0);
  const scope = `apply:${s.payment_intent}`;
  let amountOk = Number.isInteger(amount) && amount > 0 && (kind === "fund" ? amount === expected : amount <= expected);   // a top-up may be part of what is owed
  if (!amountOk && kind === "topup" && Number.isInteger(amount) && amount > 0) {
    // "more than what is owed" is also what this very payment looks like right after another delivery counted it
    // but before its ledger line landed (or when that delivery died in between). A claim row for this payment
    // plus a counter that is ahead of the ledger by at least this amount says so: not a stray payment.
    const claim = await db.one("money_keys", `scope=eq.${q(scope)}&select=created_at`);
    const gap = nz(c.funded_cents) - (await fundRows(c)).reduce((a, f) => a + f.amount_cents, 0);
    if (claim && gap >= amount) amountOk = true;
  }
  if (!amountOk || s.amount_total !== amount + fee || String(s.currency).toLowerCase() !== String(c.currency || "EUR").toLowerCase() || c.payment_mode !== "escrow")
    return refundOrphan(s, `amount/currency mismatch ${s.amount_total} ${s.currency} vs ${expected}+${fee}`);
  let charge = null;
  try { const pi = await stripe("GET", `/payment_intents/${s.payment_intent}`, { "expand[]": "latest_charge.balance_transaction" }); charge = pi.latest_charge; } catch (e) { console.error("pi fetch", e.message); }
  const bt = charge && charge.balance_transaction && typeof charge.balance_transaction === "object" ? charge.balance_transaction : null;
  let u;
  if (kind === "fund") {
    u = await db.claim(id, ["accepted"], { status: "funded", funded_at: new Date().toISOString(), funded_cents: amount, stripe_payment_intent: s.payment_intent, stripe_checkout_id: s.id, stripe_charge_id: charge && charge.id || null, fee_cents: fee });
    if (!u) {
      const now = await db.contract(id);
      if (now && now.stripe_payment_intent === s.payment_intent) return "already";   // concurrent duplicate delivery won the claim
      return refundOrphan(s, `order is ${now && now.status}`);                        // cancelled / already funded by another session
    }
  } else {
    // A top-up counts once. The same paid session is delivered twice at the same moment as a rule (Stripe's
    // webhook and the page's own check): the first to claim the payment records it, the other waits for that
    // record. Nothing here treats a payment as unwanted while the other delivery may be recording it.
    const ledgerRow = { order_id: id, provider: "stripe", status: "succeeded", kind: "fund", amount_cents: amount, fee_cents: fee, provider_ref: s.payment_intent, charge_ref: charge && charge.id || null, provider_fee_cents: bt && Number.isInteger(bt.fee) ? bt.fee : null, note: kind };
    const topupRow = () => db.one("order_payments", `order_id=eq.${id}&provider_ref=eq.${q(s.payment_intent)}&select=id`);
    if (!(await claimScope(scope))) {
      for (let i = 0; i < 15; i++) { if (await topupRow()) return "already"; await sleep(400); }
      // Still no record. The holder of the claim is either slow or died. A claim older than the stale limit is taken
      // over, and the books decide what is left to do: a counter that already includes this amount without a ledger
      // line means it died between the two writes — only the line is missing. Otherwise nothing was recorded.
      const row = await db.one("money_keys", `scope=eq.${q(scope)}&select=created_at`);
      if (!row || !row.created_at || Date.now() - Date.parse(row.created_at) < LOCK_STALE_MS) return "pending";   // the webhook answers 500 → Stripe sends it again later
      const fresh = await db.contract(id);
      if (!fresh) return "pending";
      const counted = nz(fresh.funded_cents) - (await fundRows(fresh)).reduce((a, f) => a + f.amount_cents, 0);
      if (counted >= amount) {
        // only the ledger line is missing; one writer (a second claim decides), and never twice
        if (await claimScope(`ledger:${s.payment_intent}`)) { if (!(await topupRow())) await db.insert("order_payments", ledgerRow).catch(e => console.error("ledger", e.message)); }
        if (String(fresh.money_error || "").includes(s.payment_intent)) await db.update("contracts", `id=eq.${id}`, { money_error: null }).catch(() => {});
        return "already";
      }
      await db.remove("money_keys", `scope=eq.${q(scope)}&created_at=lt.${q(new Date(Date.now() - LOCK_STALE_MS).toISOString())}`).catch(() => {});
      if (!(await claimScope(scope))) return "pending";
    }
    let cur = c;
    try {
      for (let i = 0; i < 6 && !u; i++) {
        if (i) cur = await db.contract(id);
        if (!cur || !["funded", "delivered"].includes(cur.status)) break;
        if (amount > Math.max((centsOf(cur) || 0) - nz(cur.funded_cents), 0)) break;     // no longer owed (paid another way meanwhile)
        const rows = await db.update("contracts", `id=eq.${id}&status=in.(funded,delivered)&funded_cents=eq.${nz(cur.funded_cents)}`, { funded_cents: nz(cur.funded_cents) + amount })
          .catch(async (e) => { e.outcomeUnknown = true; await db.update("contracts", `id=eq.${id}`, { money_error: `top-up ${s.payment_intent} may not be recorded — check by hand` }).catch(() => {}); throw e; });
        u = rows && rows[0] || null;
      }
    } catch (e) { if (!e.outcomeUnknown) await dropKey(scope); throw e; }                // nothing was changed: the next delivery starts over
    if (!u) { await dropKey(scope); return refundOrphan(s, `top-up no longer applies (order is ${cur && cur.status})`); }   // the refund has its own key
    // the ledger line is the record other deliveries wait for: written right away, and a failure is not silent
    try { await db.insert("order_payments", ledgerRow); }
    catch (e) { console.error("ledger", e.message); await db.update("contracts", `id=eq.${id}`, { money_error: `top-up ${s.payment_intent} counted but its ledger line failed — check by hand` }).catch(() => {}); }
  }
  if (kind === "fund") await ledger(u, { kind: "fund", amount_cents: amount, fee_cents: fee, provider_ref: s.payment_intent, charge_ref: charge && charge.id || null, provider_fee_cents: bt && Number.isInteger(bt.fee) ? bt.fee : null, note: kind });
  await orderEvent(u, kind === "fund" ? "funded" : "topped_up", { amount_cents: amount, fee_cents: fee, total_cents: amount + fee }, c.client);
  await contractEvent(u, "funded", c.client, { amount_cents: amount });
  const card = charge && charge.payment_method_details && charge.payment_method_details.card;
  if (card && card.fingerprint) await db.rpc("record_card", { uid: c.client, fingerprint: card.fingerprint, label: `${card.brand || "card"} ••${card.last4 || "????"}` }).catch(e => console.error("card", e.message));
  return "funded";
}

// ---- chargebacks: the bank pulls the money back on the client's word; Cuvori answers with the facts ----
const pendingReversal = (c) => String(c.money_error || "").startsWith("chargeback:");
const pendingRepay = (c) => String(c.money_error || "").startsWith("chargeback won");
// an error with no answer from the provider or the database: fail the webhook so Stripe sends the event again
const retryable = (e) => !!(e && (e.network || e.outcomeUnknown || e.shouldRetry || !e.status || e.status >= 500));
export async function onDisputeCreated(o) {
  const initial = await contractByPi(o.payment_intent);
  if (!initial) return "ignored";
  const unlock = await lockOrder(initial.id);
  try { return await createDisputeLocked(initial.id, o); }
  finally { await unlock(); }
}
async function createDisputeLocked(id, o) {
  const c0 = await db.contract(id);
  if (!c0) return "ignored";
  if (c0.chargeback_status === "open" && c0.chargeback_id !== o.id)
    throw fail("Another chargeback on this order needs reconciliation first.", 503);
  const retry = c0.chargeback_id === o.id;                                // Stripe sends the event again when the first handling did not finish
  if (retry && c0.chargeback_status !== "open") return "already";        // decided meanwhile: nothing left to cover
  const cents = Number.isInteger(o.amount) ? o.amount : 0;
  if (!retry) {
    // the facts first, before any money moves: the Order is frozen, the history and the chat say why, the client is flagged
    const holding = holdsFunds(c0);
    const base = { chargeback_id: o.id, chargeback_status: "open", chargeback_cents: cents, auto_release_at: null };
    await db.update("order_milestones", `order_id=eq.${c0.id}`, { auto_release_at: null }).catch(() => {});
    const u = (await db.update("contracts", `id=eq.${c0.id}`, holding
      ? { ...base, status: "disputed", dispute_reason: `Card chargeback ${o.id} (${o.reason || "no reason given"})`, disputed_at: c0.disputed_at || new Date().toISOString(), dispute_by: c0.dispute_by || c0.client }
      : base))[0] || c0;
    await orderEvent(u, "chargeback", { chargeback: o.id, amount_cents: cents, reason: o.reason || "" }, null);
    await contractEvent(u, "dispute", c0.client, { amount_cents: cents, label: "chargeback" });
    const flagged = await db.one("user_flags", `user_id=eq.${c0.client}&contract_id=eq.${c0.id}&kind=eq.chargeback&select=id`);
    if (!flagged) await db.insert("user_flags", { user_id: c0.client, kind: "chargeback", reason: `Chargeback ${o.id} on "${String(c0.title).slice(0, 120)}" (order was ${c0.status})`, contract_id: c0.id }).catch(() => {});
  }
  await coverChargebackLocked(c0.id, o.id, cents);
  return "recorded";
}
// Money that already went to the freelancer and that the held amount cannot cover is pulled back, so the
// dispute is covered either way; the outcome decides where it ends up (won: paid again, lost: gone).
// Under the order lock, from a fresh row, and the books follow what Stripe says was reversed — so a retry
// after a half-finished attempt (network gone mid-way, a lost answer) records exactly what happened.
// Called by the webhook, its retries, and the hourly job while `money_error` says a pull-back is owed.
export async function coverChargeback(id, disputeId, centsHint, pullBack = true) {
  const unlock = await lockOrder(id);
  try { return await coverChargebackLocked(id, disputeId, centsHint, pullBack); }
  finally { await unlock(); }
}
// Refunds in this integration consume order principal first. Processing fees are not
// added to the order's funded counter and must not consume an unrelated top-up's principal.
async function disputePrincipal(c, dispute) {
  const pi = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;
  if (!isPi(pi) || !Number.isSafeInteger(dispute.amount) || dispute.amount <= 0) throw new Error("invalid dispute payment or amount");
  const funds = await fundRows(c);
  const payment = funds.find(f => f.provider_ref === pi);
  const principal = payment ? payment.amount_cents : (!funds.length && pi === c.stripe_payment_intent ? centsOf(c) : null);
  if (!Number.isSafeInteger(principal) || principal <= 0) throw new Error("disputed payment principal is not recorded");
  const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
  if (!isStripeId(chargeId) || !chargeId.startsWith("ch_")) throw new Error("disputed charge is not recorded");
  const charge = await stripe("GET", `/charges/${chargeId}`);
  const chargePi = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (chargePi !== pi || String(charge.currency).toLowerCase() !== String(c.currency || "EUR").toLowerCase()
    || !Number.isSafeInteger(charge.amount_refunded) || charge.amount_refunded < 0)
    throw new Error("disputed charge does not match the order payment");
  return Math.min(dispute.amount, Math.max(principal - charge.amount_refunded, 0));
}
async function coverChargebackLocked(id, disputeId, centsHint, pullBack = true) {
    let c = await db.contract(id);
    if (!c || c.chargeback_id !== disputeId) return null;
    // Resolve the payment at Stripe; a gross dispute amount alone is not enough for top-ups.
    const dispute = await stripe("GET", `/disputes/${disputeId}`);
    if (dispute.id !== disputeId) throw new Error("dispute mismatch");
    const cents = await disputePrincipal(c, dispute);
    // 1. the books follow Stripe first, so what follows is decided on the real state (a half-finished earlier attempt included)
    let st = await syncReversals(c, disputeId); c = st.row;
    // 2. what still has to come back: while holding, only the part the held amount cannot cover (the held amount is
    //    taken from Stripe's net transfers too, so a transfer the counters have not caught up with is seen); after a
    //    release, the disputed amount minus what this dispute already pulled back
    let need = 0;
    if (pullBack && c.chargeback_status === "open") {
      const holding = holdsFunds(c);
      const fundedNow = nz(c.funded_cents) || (holdsFunds(c) ? centsOf(c) || 0 : 0);
      const heldReal = Math.max(fundedNow - st.net - nz(c.refunded_cents), 0);
      const already = ((await db.select("order_payments", `order_id=eq.${c.id}&kind=eq.reversal&note=eq.${q("chargeback " + disputeId)}&select=amount_cents`)) || []).reduce((a, r) => a + r.amount_cents, 0);
      need = Math.min(st.net, holding ? Math.max(cents - heldReal, 0) : Math.max(cents - already, 0));
    }
    let err = null;
    if (need > 0) {
      try { await reverseTransfers(c, need, disputeId); } catch (e) { err = e; }
      st = await syncReversals(c, disputeId); c = st.row;                   // 3. record what happened, whatever the answer was
    }
    if (err) {
      console.error("reversal", c.id, err.message);
      await db.update("contracts", `id=eq.${c.id}`, { money_error: ("chargeback: " + err.message).slice(0, 300) }).catch(() => {});
      if (retryable(err)) throw err;
    } else if (pendingReversal(c)) await db.update("contracts", `id=eq.${c.id}`, { money_error: null }).catch(() => {});
    return c;
}
// The books follow Stripe: released_cents becomes what the freelancer has net of every reversal on this Order's
// transfers, and a ledger line records whatever was reversed since the last one. Both writes land on the same
// values however often this runs, so a failure here (thrown: the webhook fails, Stripe sends the event again)
// heals itself on the next run. Called under the order lock.
async function syncReversals(c, disputeId) {
  const ts = await transfersOf(c);
  const atStripe = ts.reduce((a, t) => a + nz(t.amount_reversed), 0);
  const net = ts.reduce((a, t) => a + t.amount - nz(t.amount_reversed), 0);
  const recorded = ((await db.select("order_payments", `order_id=eq.${c.id}&kind=eq.reversal&select=amount_cents`)) || []).reduce((a, r) => a + r.amount_cents, 0);
  const delta = atStripe - recorded;
  let row = c;
  if (delta > 0) {
    const ids = ts.filter(t => nz(t.amount_reversed) > 0).map(t => t.id).join(",").slice(0, 200);
    row = (await db.update("contracts", `id=eq.${c.id}`, { stripe_reversal_id: ids, released_cents: net }))[0] || c;
    await db.insert("order_payments", { order_id: c.id, provider: "stripe", status: "succeeded", kind: "reversal", amount_cents: delta, provider_ref: ids, note: `chargeback ${disputeId}` });
  }
  return { row, net, atStripe };
}
export async function onDisputeClosed(o) {
  const c0 = await contractByPi(o.payment_intent);
  if (!c0 || c0.chargeback_id !== o.id) return "ignored";
  const won = o.status === "won", lost = o.status === "lost";
  if (!won && !lost) return "ignored";
  const unlock = await lockOrder(c0.id);
  try { return await closeDisputeLocked(c0, o, won, lost); }
  finally { await unlock(); }
}
async function closeDisputeLocked(c0, o, won, lost) {
  // the books follow Stripe before the outcome is applied (a pull-back that was still owed is made now when the bank sided with the client)
  await coverChargebackLocked(c0.id, o.id, 0, lost);
  const c = (await db.contract(c0.id)) || c0;
  if (c.chargeback_id !== o.id) return "ignored";
  if (c.chargeback_status !== "open") {
    if (won && c.chargeback_status === "won" && pendingRepay(c)) { await repayWonLocked(c); return "won"; }   // the retry finishes the re-payment
    if (lost && c.chargeback_status === "lost") await recordClosedChargeback(c, o.id);
    return "already";
  }
  const now = new Date().toISOString();
  if (won) {
    const u = (await db.update("contracts", `id=eq.${c.id}&chargeback_id=eq.${q(o.id)}&chargeback_status=eq.open`, { chargeback_status: "won", money_error: "chargeback won; re-payment pending" }))[0];
    if (!u) return "already";
    if (u.status === "disputed") await db.update("contracts", `id=eq.${c.id}`, { dispute_reason: `${u.dispute_reason || ""}\nThe bank sided with Cuvori. Decide the dispute as usual${u.stripe_reversal_id ? "; the money pulled back from the freelancer is part of the held amount" : ""}.`.slice(0, 2000) });
    await orderEvent(u, "chargeback_won", { chargeback: o.id }, null);
    await contractEvent(u, "chargeback_won", c.client);
    await repayWonLocked(u);
    return "won";
  }
  // A partial chargeback consumes only that payment's disputed principal. Keep any
  // undisputed remainder frozen for an explicit decision, with automatic release disabled.
  let gone = await disputePrincipal(c, o);
  const held = heldCents(c);
  let unrecovered = 0;
  if (gone > held) {
    // the bank took more than Cuvori still holds (the pull-back from the freelancer did not go through): close the
    // chargeback with what was held, and tell a person exactly what Cuvori lost. Failing for ever would keep the
    // order frozen with no way for an admin to act.
    unrecovered = gone - held; gone = held;
  }
  // A durable plan bridges the non-transactional contract/ledger writes. If either
  // response is lost, the next webhook repairs the same ledger entry without recounting it.
  const scope = `chargeback_result:${c.id}:${o.id}`;
  const previous = await db.one("money_keys", `scope=eq.${q(scope)}&select=key`);
  let plan;
  if (previous) {
    plan = parseChargebackPlan(previous.key);
    if (plan.before !== nz(c.refunded_cents) || plan.remaining + plan.amount !== held || plan.amount !== gone)
      throw fail("The chargeback balance changed and needs reconciliation.", 503);
  } else {
    plan = { v: 1, amount: gone, before: nz(c.refunded_cents), after: nz(c.refunded_cents) + gone, remaining: held - gone };
    await db.insert("money_keys", { scope, key: JSON.stringify(plan) });
  }
  gone = plan.amount;
  const remaining = plan.remaining;
  const keepOpen = remaining > 0;
  const u = (await db.update("contracts", `id=eq.${c.id}&chargeback_id=eq.${q(o.id)}&chargeback_status=eq.open`, {
    chargeback_status: "lost", status: keepOpen ? "disputed" : nz(c.released_cents) > 0 ? "completed" : "refunded",
    resolution: keepOpen ? null : "chargeback", closed_at: keepOpen ? null : now, resolved_at: keepOpen ? null : now,
    completed_at: keepOpen ? null : nz(c.released_cents) > 0 ? c.completed_at || now : null,
    auto_release_at: null, refunded_cents: plan.after, money_error: unrecovered > 0 ? `chargeback lost; ${(unrecovered / 100).toFixed(2)} could not be pulled back from the freelancer — Cuvori covered it, check by hand` : null,
    ...(keepOpen ? { dispute_reason: `${c.dispute_reason || ""}\nPartial chargeback lost. The remaining ${remaining} minor units require an explicit settlement decision.`.slice(-2000) } : {})
  }))[0];
  if (!u) return "already";
  await recordClosedChargeback(u, o.id);
  await orderEvent(u, "chargeback_lost", { chargeback: o.id, amount_cents: gone }, null);
  await contractEvent(u, "chargeback_lost", c.client, { amount_cents: gone });
  return "lost";
}
function parseChargebackPlan(raw) {
  const p = JSON.parse(raw);
  if (p.v !== 1 || ![p.amount, p.before, p.after, p.remaining].every(n => Number.isSafeInteger(n) && n >= 0) || p.after !== p.before + p.amount)
    throw new Error("invalid chargeback accounting plan");
  return p;
}
async function recordClosedChargeback(c, disputeId) {
  const stored = await db.one("money_keys", `scope=eq.${q(`chargeback_result:${c.id}:${disputeId}`)}&select=key`);
  // Old closures have no plan. Their historical counters cannot be reconstructed here.
  if (!stored) return;
  const plan = parseChargebackPlan(stored.key);
  if (nz(c.refunded_cents) < plan.after) throw new Error("chargeback counter is not recorded");
  if (!plan.amount) return;
  const existing = await db.one("order_payments", `order_id=eq.${c.id}&kind=eq.chargeback&provider_ref=eq.${q(disputeId)}&select=amount_cents`);
  if (existing) {
    if (existing.amount_cents !== plan.amount) throw new Error("chargeback ledger amount mismatch");
    return;
  }
  await db.insert("order_payments", { order_id: c.id, provider: "stripe", status: "succeeded", kind: "chargeback", amount_cents: plan.amount, provider_ref: disputeId, note: "chargeback_lost" });
}
// The bank sided with Cuvori: money that was pulled back from the freelancer goes to them again — unless the
// Order is still holding, where it is part of the held amount and the dispute decision moves it. Safe to
// repeat: the transfer is looked up before it is made, and the ledger says what was already paid again.
// Called from the webhook, from its retries, and from the hourly job while `money_error` says it is owed.
export async function repayWon(c0) {
  const unlock = await lockOrder(c0.id);
  try { return await repayWonLocked(c0); } finally { await unlock(); }
}
async function repayWonLocked(c0) {
  const c = (await db.contract(c0.id)) || c0;
  if (c.chargeback_status !== "won") return 0;
  const rows = (await db.select("order_payments", `order_id=eq.${c.id}&kind=in.(reversal,release)&select=kind,note,amount_cents`)) || [];
  const back = rows.filter(r => r.kind === "reversal").reduce((a, r) => a + r.amount_cents, 0) - rows.filter(r => r.kind === "release" && r.note === "chargeback_won").reduce((a, r) => a + r.amount_cents, 0);
  if (back <= 0 || holdsFunds(c)) { if (pendingRepay(c)) await db.update("contracts", `id=eq.${c.id}`, { money_error: null }).catch(() => {}); return 0; }
  try {
    const t = await releaseToEditor(c, back, null, `retransfer_${c.chargeback_id}`);
    const v = (await db.update("contracts", `id=eq.${c.id}`, { released_cents: nz(c.released_cents) + back, money_error: null }))[0];
    await ledger(v || c, { kind: "release", amount_cents: back, provider_ref: t, note: "chargeback_won" });
    return back;
  } catch (e) {
    console.error("re-pay after won chargeback", c.id, e.message);
    await db.update("contracts", `id=eq.${c.id}`, { money_error: ("chargeback won, re-payment failed: " + e.message).slice(0, 300) }).catch(() => {});
    if (retryable(e)) throw e;                                             // no answer: the webhook fails and Stripe sends the event again
    return 0;                                                              // a plain no (account not ready, money settling): the hourly job tries again
  }
}
