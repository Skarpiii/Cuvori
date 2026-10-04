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
// Test and live are two separate worlds at Stripe: an account, payment or payout made with test keys does not exist for
// live keys, and the other way round. The key says which one these functions work in.
export const STRIPE_MODE = /^(sk|rk)_live_/.test(STRIPE_KEY) ? "live" : /^(sk|rk)_test_/.test(STRIPE_KEY) ? "test" : null;
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
export const MIN_CENTS = 100, MAX_CENTS = 95000000, MIN_TOPUP_CENTS = 50;
export const FEE_SANITY_PERCENT = 10, FEE_SANITY_FIXED_CENTS = 100;   // a quoted fee above 10% + €1 can only be a slip in the fee table (quoteFor)
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
// Shortens text to at most n characters without breaking anything a person sees as one character: never half an emoji
// (the database refuses it and Stripe cannot be sent it), and never part of an emoji built from several pieces (a flag, a
// skin tone, a family), which would show as a stray symbol. Still never more than n characters as the database counts them.
const GRAPHEMES = typeof Intl === "object" && typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
export const cut = (text, n) => {
  const s = String(text ?? "");
  if (!GRAPHEMES) return Array.from(s).slice(0, n).join("");
  let out = "", used = 0;
  for (const { segment } of GRAPHEMES.segment(s)) {
    const size = Array.from(segment).length;
    if (used + size > n) break;
    out += segment; used += size;
  }
  return out;
};
// what the provider is holding for this Order right now (Orders from before v18 carry no counters)
export const heldCents = (c) => { const f = nz(c.funded_cents) || (holdsFunds(c) ? centsOf(c) || 0 : 0); return Math.max(f - nz(c.released_cents) - nz(c.refunded_cents), 0); };
// the part of the price both sides agreed to that the client has not paid in yet (an accepted price increase not funded yet)
export const owedCents = (c) => { const f = nz(c.funded_cents) || (holdsFunds(c) ? centsOf(c) || 0 : 0); return Math.max((centsOf(c) || 0) - f, 0); };
// a database filter that matches the Order only while its price and what was paid in are what `c` says
const eqOrNull = (col, v) => (v == null ? `${col}=is.null` : `${col}=eq.${Number(v)}`);
export const moneyUnchanged = (c) => `${eqOrNull("funded_cents", c.funded_cents)}&${eqOrNull("amount_cents", c.amount_cents)}`;
export const chargebackOpen = (c) => !!c && c.chargeback_status === "open";
export async function readJson(req) { try { const b = await req.json(); return b && typeof b === "object" && !Array.isArray(b) ? b : {}; } catch { return {}; } }
// Never let an exception (Stripe/Supabase message, stack) reach the browser
export const safe = (fn) => async (req, ctx) => corsContext.run({ origin: null }, async () => {
  setCors(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  try { return await fn(req, ctx); }
  catch (e) {
    if (e && e.expose) return json(e.status || 409, e.code ? { error: e.message, code: e.code } : { error: e.message });
    // the same ref as a note written on the Order for this error (orderPayoutAccount), so the person's message and the note match
    const ref = e && typeof e.ref === "string" && /^[0-9a-f]{8}$/.test(e.ref) ? e.ref : crypto.randomUUID().slice(0, 8);
    console.error("fn error", ref, e && e.stack || e);
    return json(500, { error: `Something went wrong (ref ${ref})`, code: "server_error", ref });
  }
});
// code: a short name the page shows in the person's language (fnPlain in index.html); the message stays for the owner
export const fail = (msg, status = 409, code) => { const e = new Error(msg); e.expose = true; e.status = status; if (code) e.code = code; return e; };
const PAUSED = "payments_paused";
// An Order's money only moves in the mode it was paid in (schema v32 records it): money paid with test cards is never
// paid out, refunded or pulled back with live keys, and the other way round. The database refuses to record a payment
// in the other mode too (MODE_REFUSED: then the payment goes back to the card).
const MODE_REFUSED = /stripe_mode_(changed|mixed)/;
export function sameMode(c) {
  if (c && c.paid_mode && STRIPE_MODE && c.paid_mode !== STRIPE_MODE)
    throw fail(`This Order was paid in ${c.paid_mode} mode, so its money cannot move with the ${STRIPE_MODE} keys. Cuvori support needs to look at it.`, 409, "other_mode");
}
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
// The database says which Stripe mode it belongs to (site_settings.stripe_mode: "test" until the owner switches it on
// launch day, see SETUP.md). Keys of the other mode never move money in it, so test and live accounts, payments and
// payouts never mix — also when a deploy is left with the old keys. Read at most once a minute.
let modeSeen = { mode: null, at: 0 };
let keyPlatform = null;                         // the Stripe account these keys belong to: asked once, it never changes for a key
let platformSeen = { id: null, at: 0 };
export const forgetStripeMode = () => { modeSeen = { mode: null, at: 0 }; keyPlatform = null; platformSeen = { id: null, at: 0 }; };
async function checkStripeMode(fresh = false) {
  if (!STRIPE_MODE) throw fail("Payments are not configured. Please contact support.", 503, PAUSED);
  if (fresh || !modeSeen.mode || Date.now() - modeSeen.at > 60e3) {
    const row = await db.one("site_settings", "key=eq.stripe_mode&select=value");
    modeSeen = { mode: row ? String(row.value) : "test", at: Date.now() };
  }
  if (modeSeen.mode !== STRIPE_MODE) {
    console.error("Stripe mode mismatch: keys are", STRIPE_MODE, "but the database is set to", modeSeen.mode);
    throw fail(`Payments are paused: the Stripe keys are for ${STRIPE_MODE} mode, but the database is set to ${modeSeen.mode} mode.`, 503, PAUSED);
  }
}
// The Stripe account Cuvori's keys belong to is remembered the first time, once per mode (site_settings
// stripe_platform_test / stripe_platform_live). Keys of a different Stripe account pause every payment: money paid in
// through one Stripe account can only be paid out from it, and every freelancer's saved account would look gone. A
// deliberate move to another Stripe account is confirmed in Supabase (SETUP.md, "Moving to another Stripe account").
async function checkStripePlatform() {
  if (!keyPlatform) { const me = await stripeCall("GET", "/account"); keyPlatform = me && isAcct(me.id) ? me.id : null; }
  if (!keyPlatform) throw new Error("Stripe did not say which Stripe account these keys belong to");
  if (!platformSeen.id || Date.now() - platformSeen.at > 60e3) {
    const key = `stripe_platform_${STRIPE_MODE}`;
    let row = await db.one("site_settings", `key=eq.${key}&select=value`);
    if (!row) {                                 // the first time in this mode: remember it, never over one already remembered
      await sbFetch("/site_settings?on_conflict=key", { method: "POST", prefer: "resolution=ignore-duplicates,return=minimal", body: JSON.stringify({ key, value: keyPlatform }) });
      row = await db.one("site_settings", `key=eq.${key}&select=value`);
    }
    platformSeen = { id: row ? String(row.value) : null, at: Date.now() };
  }
  if (platformSeen.id !== keyPlatform) {
    console.error("Stripe account mismatch: the keys belong to", keyPlatform, "but Cuvori was set up with", platformSeen.id);
    throw fail("Payments are paused: the Stripe keys belong to a different Stripe account than the one Cuvori was set up with.", 503, PAUSED);
  }
}
export async function stripe(method, path, body, opts = {}) {
  if (!STRIPE_KEY) throw fail("Payments are not configured. Please contact support.", 503, PAUSED);
  await checkStripeMode();
  await checkStripePlatform();
  return stripeCall(method, path, body, opts);
}
// the call itself, without the checks: only for the checks and through stripe()
async function stripeCall(method, path, body, opts = {}) {
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
  let r, text;
  try {
    r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, { ...init, signal: AbortSignal.timeout(8000), headers: { apikey: SERVICE_KEY, ...auth, "content-type": "application/json", Prefer: init.prefer || "return=representation", ...(init.headers || {}) } });
    text = await r.text();
  } catch (e) { try { e.db = true; } catch {} throw e; }       // marked as the database's, so a note can say so (checkNote)
  let data = null, unreadable = false; try { data = text ? JSON.parse(text) : null; } catch { data = text; unreadable = true; }
  if (!r.ok) { const e = new Error((!unreadable && data && data.message) || `Supabase ${r.status}`); e.status = r.status; e.db = true; throw e; }
  // The database always answers in JSON (or with nothing). A "success" that cannot be read is a broken answer — something
  // in between replaced it, or it was cut off — and it must never pass for a real one: a check could take it for "no, not banned".
  if (unreadable) throw dbError("Unreadable database response", r.status);
  return data;
}
const dbError = (msg, status) => { const e = new Error(msg); e.db = true; if (status) e.status = status; return e; };
// a table answer is a list of rows (or nothing, with return=minimal): anything else is a broken answer, never a row
const rowsOf = async (p) => { const d = await p; if (d != null && !Array.isArray(d)) throw dbError("Unexpected database response"); return d; };
const q = encodeURIComponent;
export const db = {
  select: (table, query) => rowsOf(sbFetch(`/${table}?${query}`)),
  one: async (table, query) => { const rows = await rowsOf(sbFetch(`/${table}?${query}&limit=1`)); return rows && rows[0] || null; },
  update: (table, query, patch) => rowsOf(sbFetch(`/${table}?${query}`, { method: "PATCH", body: JSON.stringify(patch) })),
  insert: (table, row) => rowsOf(sbFetch(`/${table}`, { method: "POST", body: JSON.stringify(row) })),
  remove: (table, query) => rowsOf(sbFetch(`/${table}?${query}`, { method: "DELETE" })),
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
// No profile counts as banned. The mark must be a real yes or no (the column is boolean not null): a row without one is a
// broken answer and stops the request, never "not banned".
export const isBanned = async (uid) => {
  const p = await db.one("profiles", `id=eq.${uid}&select=banned`);
  if (!p) return true;
  if (typeof p.banned !== "boolean") throw dbError("profile answer without a banned mark");
  return p.banned;
};

// How often one person may make a payment function ask Stripe. Stripe takes only so many requests a second from Cuvori
// as a whole (25 a second for one kind, such as checking a freelancer's account), and only so many checks a month
// (at least 10,000; more as payments grow). Without a limit, one person or a small script pressing a button over and over
// could use it all, and Stripe would then refuse Cuvori for everyone — nobody could pay, and payouts would wait. Past the
// limit the person is asked to wait (a minute, or until tomorrow) and Stripe is not asked at all. Normal use never comes
// close. Counted in the database (schema v31), so every running copy of a function shares one count.
export async function limitTries(me, kind, perMinute = 10, perDay = 50) {
  let r;
  try { r = await db.rpc("rate_limit_tries", { p_user: me.id, p_kind: kind, p_per_minute: perMinute, p_per_day: perDay }); }
  catch (e) {
    // schema v31 not run yet: payments keep working without the limit, and the log says what is missing
    if (e && e.status === 404) { console.error("the limit on tries is not set up yet: run supabase/schema_v31.sql", e.message); return; }
    throw e;
  }
  if (r === "ok") return;
  if (r === "day") throw fail("Too many tries today. Please try again tomorrow.", 429, "too_many_today");
  throw fail("Too many tries in a short time. Please wait a minute and try again.", 429, "too_many_tries");
}

// ---- the price the client pays: from the fee table in the database, never a number in code ----
export async function quoteFor(priceCents, currency = "EUR", country = null, customer = "any", method = "any") {
  // a whole Order starts at €1 (MIN_CENTS, checked by the caller); a top-up for an agreed amendment may be smaller.
  // €0.50 is the smallest card payment Stripe takes in euros, so nothing below it can ever be paid.
  if (!Number.isSafeInteger(priceCents) || priceCents < MIN_TOPUP_CENTS || priceCents > MAX_CENTS) throw fail("Order amount is outside the allowed range.", 400);
  const qte = await db.rpc("order_quote", { p_price_cents: priceCents, p_currency: currency, p_country: country, p_customer: customer, p_method: method });
  if (!qte || !Number.isSafeInteger(qte.total_cents) || qte.total_cents < priceCents) throw new Error("bad quote");
  // Cuvori never pays the card cost: the client pays it on top of the price. A quote in which the client pays no fee
  // (no active fee row matched, the row is set to "payer = platform", or its rate is zero) would leave the provider's
  // whole fee to Cuvori, so no payment is taken until the fee table is fixed.
  if (qte.payer !== "client" || !Number.isSafeInteger(qte.processing_cents) || qte.processing_cents <= 0) {
    console.error("fee table: no client-paid processing fee for this payment — payments paused", JSON.stringify({ payer: qte.payer, schedule_id: qte.schedule_id, processing_cents: qte.processing_cents, region: qte.region }));
    throw fail("Payments through Cuvori are paused: the processing fee is not set up. Please contact Cuvori support.", 503, PAUSED);   // code: the page says "payments are paused" in the client's language; the admin also sees this sentence
  }
  // A slip in the fee table (32.5 instead of 3.25, €25 instead of €0.25) must never reach a card: the database allows any
  // rate under 50%, so this is the ceiling — far above any real card rate, with room for the fixed part on the smallest
  // payments. Above it no payment is taken until the table is corrected; the surplus would come back after payment, but
  // nobody should see a fee like that on Stripe's page in the first place.
  if (qte.processing_cents > Math.ceil(priceCents * FEE_SANITY_PERCENT / 100) + FEE_SANITY_FIXED_CENTS) {
    console.error("fee table: the processing fee is far above any card rate — payments paused", JSON.stringify({ schedule_id: qte.schedule_id, percent: qte.percent, fixed_cents: qte.fixed_cents, price_cents: priceCents, processing_cents: qte.processing_cents, region: qte.region }));
    throw fail(`Payments through Cuvori are paused: the fee table charges ${qte.percent}% + ${qte.fixed_cents} cents, which is far above any card rate. Correct it under Payment costs in the admin panel.`, 503, PAUSED);
  }
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
// Also used to make payment pages (stripe-checkout): one key per exact request, renewed after a definite Stripe failure.
export async function moneyPost(scope, path, body) {
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

// Each freelancer has one saved Stripe account per mode: the test pair is the original stripe_account_id /
// stripe_payouts_enabled, the live pair stripe_live_account_id / stripe_live_payouts_enabled (schema v28). Only the
// pair of the current mode is ever read or written; the other one stays exactly as it is.
export const acctCols = () => {
  if (!STRIPE_MODE) throw fail("Payments are not configured. Please contact support.", 503, PAUSED);
  return STRIPE_MODE === "live" ? { mode: "live", id: "stripe_live_account_id", ready: "stripe_live_payouts_enabled" }
                                : { mode: "test", id: "stripe_account_id", ready: "stripe_payouts_enabled" };
};
// The saved account as Stripe sees it now, or null only when Stripe confirms it is gone for these keys (it does not
// exist, or these keys have no access to it). A timeout, too many requests, a key problem or a Stripe outage throws:
// nothing is ever decided on a guess.
export async function lookupAccount(id) {
  try { return await stripe("GET", `/accounts/${id}`); }
  catch (e) {
    const code = e && e.stripe && e.stripe.code;
    if ((e.status === 404 && code === "resource_missing") || (e.status === 403 && code === "account_invalid")) return null;
    throw e;
  }
}
// Editor's connected account of the current mode, verified against Stripe (not just the DB row). null = not ready:
// none saved, Stripe confirms it is gone, or it is not this freelancer's. Anything else (Cuvori's key not allowed to
// read accounts, Stripe not answering) throws, so nobody is told to fix a setup that is fine.
// The mode and Stripe-account checks come first, so keys and database in different modes (or keys of another Stripe
// account) always say "payments are paused" — also for a freelancer with nothing saved yet in the keys' mode.
// why.reason says when a person has to look: a live account Stripe says is gone (only Cuvori can sort that out), or a
// saved account that belongs to someone else.
// The one rule for "this account can be paid": Stripe lets it take charges and payouts, and the transfers capability
// Cuvori's payouts use is active (a capability must be active for the account to do what it covers). Every place that
// looks at a freelancer's account uses it: this check, Payout details, the account webhook and the database's "ready" mark.
export const accountReady = (a) => !!(a && a.charges_enabled === true && a.payouts_enabled === true && a.capabilities?.transfers === "active");
export async function payoutAccount(editorId, why = {}) {
  await checkStripeMode();
  await checkStripePlatform();
  const col = acctCols();
  const p = await db.one("payout_details", `id=eq.${editorId}&select=${col.id},${col.ready}`);
  if (!p) return null;
  // The "ready" mark the page shows the Fund button by follows what this check just found (the same rule as Payout details
  // and the account webhook use), so a Stripe update that never arrived, an account Stripe says is gone or one that belongs
  // to someone else cannot leave a Fund button that always ends in "can't receive payments". Only the mark of the saved
  // account this check looked at, only when it differs; the account itself and its history are never touched here, and a
  // failure to write it changes nothing else.
  const saved = p[col.id];
  const mark = async (ready) => { if (ready !== !!p[col.ready]) await db.update("payout_details", `id=eq.${editorId}&${saved == null ? `${col.id}=is.null` : `${col.id}=eq.${q(saved)}`}`, { [col.ready]: ready }).catch(() => {}); };
  if (!isAcct(saved)) { await mark(false); return null; }
  const acct = await lookupAccount(saved);
  if (!acct) { await mark(false); if (col.mode === "live") why.reason = "Stripe says the saved live account is gone"; return null; }
  if (!acct.metadata || acct.metadata.cuvori_user !== editorId) { await mark(false); why.reason = "the saved Stripe account belongs to someone else"; return null; }
  await mark(accountReady(acct));
  return acct;
}
// The same for an Order. A problem on Cuvori's side is written on the Order, so the admin panel shows it under "Needs a
// hand" — never over another note — and the note goes once the check works again. Cuvori's own clear refusals
// (payments paused, not configured) are not written: everyone is shown those already.
// The note says in plain words what went wrong, never Stripe's own text: both people on the Order can read its notes,
// and Stripe's text can name Cuvori's Stripe account or show the end of its key. The full error goes to the Netlify
// function log under the ref the note gives, and only the owner sees that log.
const CHECK_FAILED = "Stripe check failed: ", CHECK_NEEDED = "Stripe account check: ";
const ownNote = (c) => [CHECK_FAILED, CHECK_NEEDED].find(p => String(c.money_error || "").startsWith(p));
// Written over an empty note or over this check's own older note (its time and reason then stay current), never over
// another — and only while the note still reads exactly what this request read: two checks of the same Order can overlap,
// and the one that finishes last must not wipe out or replace what the other just found.
const noteStill = (c) => (c.money_error == null ? "money_error=is.null" : `money_error=eq.${q(c.money_error)}`);
async function writeCheckNote(c, text) {
  const mine = ownNote(c);
  if (c.money_error && !mine) return;
  await db.update("contracts", `id=eq.${c.id}&${noteStill(c)}`, { money_error: text }).catch(() => {});
}
function checkNote(e) {
  const s = e && e.status;
  if (e && e.network) return "Stripe did not answer";
  if (e && e.stripe) {
    if (s === 401) return "Stripe refused Cuvori's secret key";
    if (s === 403) return "Cuvori's Stripe key is missing a permission";
    if (s === 429) return "Stripe was busy (too many requests)";
    if (s >= 500) return "Stripe had a problem on its side";
    return "Stripe refused the request";
  }
  if (e && e.outcomeUnknown) return "Stripe's answer could not be read";
  if (e && e.db) return "Cuvori's database had a problem";
  return "something unexpected went wrong";
}
export async function orderPayoutAccount(c) {
  let acct; const why = {};
  try { acct = await payoutAccount(c.editor, why); }
  catch (e) {
    if (!(e && e.expose)) {
      const ref = crypto.randomUUID().slice(0, 8);
      try { e.ref = ref; } catch {}                // "Something went wrong (ref …)" then shows the same ref as the note
      console.error("Stripe check failed", ref, "order", c.id, e && e.stack || e);
      await writeCheckNote(c, `${CHECK_FAILED}${checkNote(e)} (Netlify log ref ${ref})`);
    }
    throw e;
  }
  if (why.reason) {
    // the client is told the freelancer isn't ready; this tells you, because only you can sort it out
    const ref = crypto.randomUUID().slice(0, 8);
    console.error("Stripe account needs a check", ref, "order", c.id, "freelancer", c.editor, why.reason);
    await writeCheckNote(c, `${CHECK_NEEDED}the freelancer's Stripe account needs a check by hand (Netlify log ref ${ref})`);
    return acct;
  }
  // the check works again: its own note goes (only that one, never another note, and not one written since this request read)
  if (ownNote(c)) await db.update("contracts", `id=eq.${c.id}&${noteStill(c)}`, { money_error: null }).catch(() => {});
  return acct;
}

// ---- money movements ----
export async function transfersOf(c) { const r = await stripe("GET", "/transfers", { transfer_group: `contract_${c.id}`, limit: 100 }); return (r.data || []).filter(t => t.metadata && t.metadata.contract_id === c.id); }

// Pay the freelancer. `purpose` separates a normal release from paying again after a chargeback was won.
export async function releaseToEditor(c, editorCents, milestoneId = null, purpose = "release") {
  if (!Number.isInteger(editorCents) || editorCents <= 0) throw new Error("bad release amount");
  if (purpose === "release" && editorCents > heldCents(c)) throw new Error("bad release amount");
  sameMode(c);
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
// the automatic refund of the processing-fee surplus (see settleFee): Cuvori's own, but never Order money
export const FEE_REFUND = (r) => !!(r && r.metadata && r.metadata.kind === "fee_surplus");
export async function refundToClient(c, cents) {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error("bad refund amount");
  sameMode(c);
  if (chargebackOpen(c)) throw fail(CHARGEBACK);
  const funds = await fundRows(c);
  const sources = funds.length ? funds.map(f => ({ pi: f.provider_ref, amount: f.amount_cents })).reverse() : (c.stripe_payment_intent ? [{ pi: c.stripe_payment_intent, amount: nz(c.funded_cents) || centsOf(c) || 0 }] : []);
  if (!sources.length) throw new Error("no payment to refund");
  try {
    for (const s of sources) {
      if (!isPi(s.pi)) continue;
      const existing = ((await stripe("GET", "/refunds", { payment_intent: s.pi, limit: 50 })).data || []).filter(r => r.status !== "failed" && r.status !== "canceled" && !FEE_REFUND(r));
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
  sameMode(c);
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
// A payment that can no longer go into its Order (cancelled, changed, disputed or closed while the client was on the
// payment page) goes back to the card — all of it except the card fee Stripe kept on it. Stripe does not return its fee on
// a refund, and Cuvori pays no fees. When Stripe's fee is not known yet (or is in another currency) nothing is refunded
// now: the error makes Stripe send the payment again later. The Order's history says what happened, once.
async function refundOrphan(s, why) {
  const p = await stripe("GET", `/payment_intents/${s.payment_intent}`, { "expand[]": "latest_charge.balance_transaction" });
  const ch = p && p.latest_charge && typeof p.latest_charge === "object" ? p.latest_charge : null;
  const bt = ch && ch.balance_transaction && typeof ch.balance_transaction === "object" ? ch.balance_transaction : null;
  if (!ch || !Number.isInteger(ch.amount) || !bt || !Number.isInteger(bt.fee) || bt.fee < 0 || (bt.currency && String(bt.currency).toLowerCase() !== String(s.currency || ch.currency || "").toLowerCase())) {
    const e = new Error(`late payment ${s.payment_intent} not refunded yet: the card fee Stripe kept on it is not known (${why})`); e.outcomeUnknown = true; throw e;
  }
  const back = Math.max(ch.amount - bt.fee, 0), left = Math.max(back - nz(ch.amount_refunded), 0);   // what an earlier attempt refunded is not refunded twice
  console.error("refunding payment that cannot fund an order", s.id, why, { paid: ch.amount, card_fee: bt.fee, back });
  if (left > 0) await moneyPost(`orphan:${s.payment_intent}`, "/refunds", { payment_intent: s.payment_intent, amount: left, metadata: { contract_id: s.client_reference_id || "", reason: why.slice(0, 200), kind: "late_payment" } });
  const c = isUuid(s.client_reference_id) ? await db.contract(s.client_reference_id).catch(() => null) : null;
  if (c && (left > 0 || nz(ch.amount_refunded) === back) && (await claimScope(`late:${s.payment_intent}`).catch(() => false)))
    await orderEvent(c, "late_payment_refunded", { amount_cents: back, card_fee_cents: bt.fee, total_cents: ch.amount }, null);
  return "refunded";
}
// ---- hold first, charge after ----
// On Stripe's page the card is only authorized (a hold, capture_method manual). The money is charged here, and only when the
// Order can still take it. When it cannot — cancelled, changed, disputed or closed while the client was on the page — the
// hold is released instead: nothing is charged, the client keeps every cent, and nobody pays a card fee.
// Why a payment cannot go into its Order (null = it can). The same rules as the checkout and applyPaidSession.
async function holdRefusal(s) {
  const c = isUuid(s.client_reference_id) ? await db.contract(s.client_reference_id) : null;
  if (!c) return "unknown order";
  if (c.payment_mode !== "escrow") return "not a protected-payment order";
  if (String(s.currency || "").toLowerCase() !== String(c.currency || "EUR").toLowerCase()) return "currency changed";
  const md = s.metadata || {}, kind = md.kind === "topup" ? "topup" : "fund";
  const amount = Number(md.amount_cents), fee = Number(md.fee_cents);
  if (!Number.isInteger(amount) || amount <= 0 || !Number.isInteger(fee) || fee < 0 || s.amount_total !== amount + fee) return "amounts do not match";
  if (chargebackOpen(c)) return "a chargeback is open";
  if (c.paid_mode && c.paid_mode !== STRIPE_MODE) return `the order was paid in ${c.paid_mode} mode`;
  if (await isBanned(c.editor)) return "the freelancer cannot receive payments";
  if (kind === "fund") {
    if (c.status !== "accepted" || c.stripe_payment_intent) return `order is ${c.status}`;
    if (amount !== centsOf(c)) return "the price changed";
  } else {
    if (!["funded", "delivered"].includes(c.status)) return `order is ${c.status}`;
    if (amount > owedCents(c)) return "no longer owed";
  }
  return null;
}
// what Stripe says the hold is now: "charged", "released", or null (still a hold / something else)
const holdState = async (pi) => { const p = await stripe("GET", `/payment_intents/${pi}`); return p.status === "succeeded" ? "charged" : p.status === "canceled" ? "released" : null; };
// The history says once that a payment could not go in and was not charged.
async function holdReleasedEvent(s) {
  const c = isUuid(s.client_reference_id) ? await db.contract(s.client_reference_id).catch(() => null) : null;
  if (c && (await claimScope(`late:${s.payment_intent}`).catch(() => false))) await orderEvent(c, "late_payment_released", { total_cents: s.amount_total }, null);
}
async function releaseHold(s, why) {
  console.error("releasing a hold that cannot fund an order", s.id, why);
  try { await moneyPost(`release:${s.payment_intent}`, `/payment_intents/${s.payment_intent}/cancel`, { cancellation_reason: "abandoned" }); }
  catch (e) { const now = await holdState(s.payment_intent); if (now === "charged") return "charged"; if (now !== "released") throw e; }
  await holdReleasedEvent(s);
  return "released";
}
// "charged": the money is taken (now, or earlier); "released": the hold is gone and nothing was charged;
// "unpaid": nothing to do (not a hold); "pending": the card payment is still being processed — ask again later.
async function chargeHold(s) {
  const p = await stripe("GET", `/payment_intents/${s.payment_intent}`);
  if (p.status === "succeeded") return "charged";
  if (p.status === "canceled") return "released";
  if (p.status === "processing") return "pending";
  if (p.status !== "requires_capture") return "unpaid";
  const why = await holdRefusal(s);
  if (why) return releaseHold(s, why);
  await checkStripeMode(true);                          // right before the card is charged: test or live asked once more
  try { await moneyPost(`capture:${s.payment_intent}`, `/payment_intents/${s.payment_intent}/capture`, {}); }
  catch (e) { const now = await holdState(s.payment_intent); if (now) return now; throw e; }
  return "charged";
}
// Cancel, refund and decisions close the Order: a hold still waiting on its page is released, never charged.
export async function dropHold(s) {
  if (!s || !isPi(s.payment_intent)) return "none";
  const p = await stripe("GET", `/payment_intents/${s.payment_intent}`);
  if (p.status !== "requires_capture") return p.status === "succeeded" ? "charged" : "none";
  const r = await releaseHold(s, "the order is being closed");
  return r === "charged" ? "charged" : "none";
}

// One payment step per Order at a time, from the moment a hold is checked until the payment is recorded: the webhook and
// the page's own check deliver the same payment at the same moment, and two paid pages for one Order (two tabs) can both
// arrive — serialized, the second one finds the Order paid and releases its hold instead of charging the card twice.
export async function applyPaidSession(s) {
  const id = s && s.client_reference_id;
  if (!isUuid(id)) return applyPaidSessionNow(s);
  const unlock = await lockOrder(id);
  try { return await applyPaidSessionNow(s); } finally { await unlock(); }
}
async function applyPaidSessionNow(s) {
  if (!s || (s.mode !== undefined && s.mode !== "payment")) return "ignored";
  // test and live never mix: right before a payment is taken or counted, the database's mode is asked again, not the
  // answer from up to a minute ago (on launch day the database may have just been switched)
  await checkStripeMode(true);
  if (s.payment_status !== "paid") {
    // a hold (or a page not paid yet): charged only if the Order can still take it, otherwise released
    if (s.status !== "complete" || !isPi(s.payment_intent)) return "unpaid";     // async methods: wait for async_payment_succeeded
    const h = await chargeHold(s);
    if (h !== "charged") return h;
  }
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
    // the breakdown the client saw on this very page (its metadata, since v34 of the functions): saved only when it describes
    // this payment's amounts; a page from before, or a damaged value, leaves the Order's record as it is
    let quote;
    try { const qd = md.quote ? JSON.parse(md.quote) : null; if (qd && typeof qd === "object" && !Array.isArray(qd) && qd.price_cents === amount && qd.processing_cents === fee) quote = qd; } catch {}
    try { u = await db.claim(id, ["accepted"], { status: "funded", funded_at: new Date().toISOString(), funded_cents: amount, stripe_payment_intent: s.payment_intent, stripe_checkout_id: s.id, stripe_charge_id: charge && charge.id || null, fee_cents: fee, paid_mode: STRIPE_MODE, ...(quote ? { quote } : {}) }); }
    catch (e) { if (MODE_REFUSED.test(String(e && e.message))) return refundOrphan(s, "test and live were switched while this payment came in"); throw e; }
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
        const rows = await db.update("contracts", `id=eq.${id}&status=in.(funded,delivered)&funded_cents=eq.${nz(cur.funded_cents)}`, { funded_cents: nz(cur.funded_cents) + amount, paid_mode: STRIPE_MODE })
          .catch(async (e) => {
            if (MODE_REFUSED.test(String(e && e.message))) { e.modeRefused = true; throw e; }      // nothing was recorded: the payment goes back
            e.outcomeUnknown = true; await db.update("contracts", `id=eq.${id}`, { money_error: `top-up ${s.payment_intent} may not be recorded — check by hand` }).catch(() => {}); throw e; });
        u = rows && rows[0] || null;
      }
    } catch (e) {
      if (e.modeRefused) { await dropKey(scope); return refundOrphan(s, "test and live were switched while this payment came in"); }
      if (!e.outcomeUnknown) await dropKey(scope); throw e;                              // nothing was changed: the next delivery starts over
    }
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
  // the fee surplus goes back to the card now; if this fails the hourly job settles it later
  try { const row = await fundRowOf(u, s.payment_intent); if (row) await settleFee(u, row); } catch (e) { console.error("fee settle", s.payment_intent, e.message); }
  return "funded";
}

// Before an Order is paid out or closed, its Stripe payment page is closed, so nothing can be paid into it afterwards.
// "closed": the page was open and can no longer be paid. "none": nothing can come in (no page, expired, its payment is on
// the Order already, released, or back on the card). "paid": it was paid a moment ago and has just been added to the Order
// (the same step as the webhook) — the payout must start again from the new amounts.
// keep: a release keeps a hold the Order can still take (it is charged and added); a cancel or a decision (keep = false)
// releases it instead — nothing is charged for an Order that is being closed.
export async function closeCheckout(c, keep = true) {
  const id = c && c.stripe_checkout_id;
  if (!isSession(id)) return "none";
  const look = async () => { try { return await stripe("GET", `/checkout/sessions/${id}`); } catch (e) { if (e.status === 404) return null; throw e; } };
  let s = await look();
  if (!s) return "none";
  if (s.status === "open") {
    try { await stripe("POST", `/checkout/sessions/${id}/expire`); return "closed"; }
    catch (e) { s = await look(); if (!s || s.status === "open") throw e; }            // paid or expired in between: go by what it is now
  }
  if (s.status !== "complete" || !isPi(s.payment_intent) || s.client_reference_id !== c.id) return "none";
  if (s.payment_intent === c.stripe_payment_intent) return "none";                                    // the first payment, on the Order already
  if (await db.one("order_payments", `order_id=eq.${c.id}&provider_ref=eq.${q(s.payment_intent)}&select=id`)) return "none";   // a top-up, on the Order already
  if (!keep && (await dropHold(s)) === "none") return "none";                                         // a hold on its way in: released, not charged
  const pi = await stripe("GET", `/payment_intents/${s.payment_intent}`, { "expand[]": "latest_charge" });
  const ch = pi && pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : null;
  if (ch && (ch.refunded === true || nz(ch.amount_refunded) > 0)) return "none";   // not on the Order and (partly) back on the card: it is not Order money
  const r = await applyPaidSession(s);
  return r === "funded" || r === "pending" ? "paid" : "none";
}

// ---- the processing fee: the highest card rate is charged up front, the surplus over the provider's real fee goes back ----
// Cuvori keeps none of the fee. Stripe reports the fee it actually took on the payment's balance transaction; the
// difference between what the client paid as "Payment processing" and that fee is refunded to the card automatically.
// Runs once per payment (the ledger row remembers the outcome), safe to repeat, and retried by the hourly job while
// the provider's fee is not yet known. A fee above what was collected (rare) is recorded and absorbed: nothing more
// can be taken from the card.
export async function settleFee(c, row) {
  if (!row || row.kind !== "fund" || row.status !== "succeeded" || !isPi(row.provider_ref)) return "ignored";
  if (Number.isInteger(row.fee_refund_cents)) return "already";
  const pi = row.provider_ref, collected = Number.isInteger(row.fee_cents) ? row.fee_cents : 0;
  let actual = Number.isInteger(row.provider_fee_cents) ? row.provider_fee_cents : null;
  if (actual == null) {
    const p = await stripe("GET", `/payment_intents/${pi}`, { "expand[]": "latest_charge.balance_transaction" });
    const bt = p && p.latest_charge && p.latest_charge.balance_transaction;
    if (!bt || typeof bt !== "object" || !Number.isInteger(bt.fee)) return "pending";
    if (bt.currency && String(bt.currency).toLowerCase() !== String(c.currency || "EUR").toLowerCase()) return "pending";   // settled in another currency: a person looks
    actual = bt.fee;
    await db.update("order_payments", `id=eq.${row.id}`, { provider_fee_cents: actual });
  }
  const surplus = collected - actual;
  const done = async (refunded, ref, extra) => {
    await db.update("order_payments", `id=eq.${row.id}`, { fee_refund_cents: refunded, fee_refund_ref: ref || null });
    await orderEvent(c, refunded > 0 ? "fee_refunded" : "fee_exact", { amount_cents: refunded, collected_cents: collected, provider_fee_cents: actual, ...(extra || {}) }, null);
  };
  if (surplus <= 0) { await done(0, null, surplus < 0 ? { shortfall_cents: -surplus } : {}); return surplus < 0 ? "shortfall" : "exact"; }
  // a refund made by an earlier, interrupted attempt is used, never made twice
  const prior = ((await stripe("GET", "/refunds", { payment_intent: pi, limit: 50 })).data || []).filter(r => FEE_REFUND(r) && r.status !== "failed" && r.status !== "canceled");
  let r = prior[0] || null;
  if (!r) r = await moneyPost(`feerefund:${pi}`, "/refunds", { payment_intent: pi, amount: surplus, metadata: { contract_id: c.id, kind: "fee_surplus" } });
  await done(prior.length ? prior.reduce((a, x) => a + x.amount, 0) : surplus, r.id);
  return "refunded";
}
// the ledger row of a payment, for settleFee
export const fundRowOf = (c, pi) => db.one("order_payments", `order_id=eq.${c.id}&kind=eq.fund&provider_ref=eq.${q(pi)}&select=*`);

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
    if (!flagged) await db.insert("user_flags", { user_id: c0.client, kind: "chargeback", reason: `Chargeback ${o.id} on "${cut(c0.title, 120)}" (order was ${c0.status})`, contract_id: c0.id }).catch(() => {});
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
  // what was refunded of the Order money: everything refunded on the charge except the processing-fee surplus
  const feeBack = ((await stripe("GET", "/refunds", { payment_intent: pi, limit: 50 })).data || []).filter(r => FEE_REFUND(r) && r.status !== "failed" && r.status !== "canceled").reduce((a, r) => a + r.amount, 0);
  const principalRefunded = Math.max(charge.amount_refunded - feeBack, 0);
  return Math.min(dispute.amount, Math.max(principal - principalRefunded, 0));
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
