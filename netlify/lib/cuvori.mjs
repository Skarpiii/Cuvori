import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

const env = (name) => String(process.env[name] || "").trim();
// The web addresses in the settings (SUPABASE_URL, SITE_URL, ALLOWED_ORIGINS) are read the way people write them:
// "cuvori.io", "www.cuvori.io/", "https//cuvori.io", "http://cuvori.io" and "https://cuvori.io/anything" all mean
// https://cuvori.io (http stays only for local testing). One that is not a web address at all never stops the payment
// functions — before, it made this file throw as it loaded, so every function, the webhook and the hourly job stopped at
// once: it is left out (ALLOWED_ORIGINS) or replaced by Cuvori's own address, and the admin page says which setting to
// correct (SETTINGS_NOTES, sent by stripe-status, which anyone can read). What was typed, and the address read from it, is
// never written to the log or shown anywhere: a key or password pasted into the wrong field must not travel further. Only
// the setting's name is, and Cuvori's own address when that is used instead.
export const SETTINGS_NOTES = [];
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
// a real host name: letters, digits and hyphens, at most 63 to a part and 253 in all, ending in a name (com, io, xn--…).
// Cuvori's own keys (Stripe's, Supabase's) never pass: they hold underscores, or parts far longer than 63, or end in digits.
const HOST_OK = (h) => h.length <= 253 && h.split(".").length >= 2 && h.split(".").every(l => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))
  && /^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(h.split(".").pop());
function originOf(value) {
  const typed = String(value || "").trim();
  // a line break, tab or other space inside (a paste that wrapped, two lines in one field): not one address. The address
  // reader would quietly drop line breaks and tabs and glue the rest into a made-up address Stripe would send clients to.
  // The same for any character that is not a plain letter, digit or sign: the reader drops invisible ones (cuvori.io, an
  // invisible space, evil.com becomes cuvori.ioevil.com), turns a full-width dot into a dot, and turns a look-alike letter
  // from another alphabet (a Cyrillic "о" in cuvori.io) into a different domain that anyone can register.
  if (/[^\x21-\x7e]/.test(typed)) return null;
  // an "@": what comes before it is a user name, so "cuvori.io@evil.com" is the website evil.com. Never an address here.
  if (typed.includes("@")) return null;
  let rest = typed.replace(/^\/+/, ""), scheme = null;
  const m = /^(https?)(?::\/*|\/+)(.*)$/i.exec(rest);
  if (m) { scheme = m[1].toLowerCase(); rest = m[2]; }
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rest)) return null;                 // another kind of address (ftp://, file://)
  if (!rest) return null;
  let url; try { url = new URL("https://" + rest); } catch { return null; }
  const local = LOCAL_HOSTS.includes(url.hostname);
  if (!local && !HOST_OK(url.hostname)) return null;
  const host = scheme === "http" && url.port === "80" ? url.hostname : url.host;   // http's own port, written out: not a port of its own
  const origin = `${local ? scheme || "http" : "https"}://${host}`;
  return { origin, corrected: origin !== typed.replace(/\/+$/, "").toLowerCase() };
}
const note = (text) => { SETTINGS_NOTES.push(text); console.error("Netlify setting:", text); };
const WHERE = "Correct it in Netlify under Project configuration → Environment variables.";
function addressSetting(name, value, fallback, kind = null) {
  if (!value) return fallback;
  const o = originOf(value);
  if (!o) { note(`${name} is not a web address, so Cuvori uses ${fallback} instead. ${WHERE}`); return fallback; }
  if (kind && !kind.ok(o.origin)) { note(`${name} is not ${kind.what}, so Cuvori uses ${fallback} instead. ${WHERE}`); return fallback; }
  if (o.corrected) note(`${name} is not written as a full web address; Cuvori corrected it. Check it in Netlify under Project configuration → Environment variables.`);
  return o.origin;
}
const CUVORI_SITE = "https://cuvori.io";
// The project address is public (it is in the page too); a missing or broken setting must not take every payment function
// down. Only a Supabase project address (….supabase.co, or a local one for testing) is used: every call to it carries the
// secret database key, so the Supabase dashboard's own address pasted in by mistake, or any other website, never gets it.
const SUPABASE_PROJECT = { what: "a Supabase project address (….supabase.co)", ok: (o) => { const h = new URL(o).hostname; return h.endsWith(".supabase.co") || LOCAL_HOSTS.includes(h); } };
export const SUPABASE_URL = addressSetting("SUPABASE_URL", env("SUPABASE_URL"), "https://tnxujwlfatcvxzevllfr.supabase.co", SUPABASE_PROJECT);
// Legacy service-role keys are JWTs; new secret keys use only the apikey header. When both are set, the new secret key
// is used: Supabase is phasing the old keys out, and an old key switched off in Supabase must never shadow a working new one.
export const SERVICE_KEY = env("SUPABASE_SECRET_KEY") || env("SUPABASE_SERVICE_ROLE_KEY");
export const STRIPE_KEY = env("STRIPE_SECRET_KEY");
// A Stripe secret key is one word: sk_live_, sk_test_ (rk_ for a restricted key) and then only letters and digits. A key
// with anything else in it (a space or a line break in the middle, from a copy that wrapped; an invisible character; a
// letter from another alphabet that looks the same) is never sent: Node refuses to send such a header and puts the whole
// header, the key with it, into its error text, and that text would end up in the Netlify log.
const KEY_PREFIX = /^(sk|rk)_(live|test)_/;
const STRIPE_KEY_WHOLE = /^(sk|rk)_(live|test)_[A-Za-z0-9_]+$/.test(STRIPE_KEY);
// Test and live are two separate worlds at Stripe: an account, payment or payout made with test keys does not exist for
// live keys, and the other way round. The key says which one these functions work in (none when the key can't be used).
export const STRIPE_MODE = !STRIPE_KEY_WHOLE ? null : /^(sk|rk)_live_/.test(STRIPE_KEY) ? "live" : "test";
export const WEBHOOK_SECRET = env("STRIPE_WEBHOOK_SECRET");
// the optional second endpoint, for events about the freelancers' own Stripe accounts: read like every other setting
export const CONNECT_WEBHOOK_SECRET = env("STRIPE_CONNECT_WEBHOOK_SECRET");
// Where Stripe sends people back (after paying, after setting up payouts). Not set: Netlify's own address (URL), and the
// admin page says so, since that address may serve an older copy of the page. Set but not a web address: Cuvori's own
// address, never Netlify's.
export const SITE_URL = env("SITE_URL") ? addressSetting("SITE_URL", env("SITE_URL"), CUVORI_SITE) : addressSetting("URL", env("URL"), CUVORI_SITE);
// SITE_URL set to a website other than cuvori.io (a typo such as cuvori.co, a password pasted into the wrong field, an
// address with a folder, whose folder is dropped): used as it is, since that may be on purpose, but the admin page says so.
// Which website it is stays unsaid, like everything read from a setting.
const CUVORI_HOSTS = ["cuvori.io", "www.cuvori.io"];
if (env("SITE_URL") && ![...CUVORI_HOSTS, ...LOCAL_HOSTS].includes(new URL(SITE_URL).hostname))
  note(`SITE_URL leads to a website other than cuvori.io, so Stripe sends clients there after paying, and freelancers after setting up payouts. If that is not on purpose, correct it in Netlify under Project configuration → Environment variables.`);
if (!env("SITE_URL")) note(SITE_URL === CUVORI_SITE ? `SITE_URL is not set; Cuvori uses ${CUVORI_SITE}. Add SITE_URL = ${CUVORI_SITE} in Netlify under Project configuration → Environment variables.`
  : `SITE_URL is not set, so Stripe sends clients back to ${SITE_URL} after paying, which may show an older copy of the page. Add SITE_URL = ${CUVORI_SITE} in Netlify under Project configuration → Environment variables.`);
// the page may live on another host (GitHub Pages) and call these functions across origins. The page's own addresses
// (SITE_URL, cuvori.io, www.cuvori.io) are always allowed, so no setting can lock the page out of its payment functions;
// ALLOWED_ORIGINS adds more, separated by commas or semicolons. An entry that is not one web address — "*" for every
// website, or one with a space or line break inside it from a paste that wrapped — is left out, never split into pieces.
const DEFAULT_ORIGINS = [...new Set([SITE_URL, "https://cuvori.io", "https://www.cuvori.io"])];
function originsSetting(value) {
  if (!value) return DEFAULT_ORIGINS;
  const list = [];
  let left = 0, fixed = 0;
  for (const entry of value.split(/[,;]+/).map(e => e.trim()).filter(Boolean)) {
    const o = originOf(entry);
    if (!o) { left++; continue; }
    if (o.corrected) fixed++;
    list.push(o.origin);
  }
  if (left) note(`ALLOWED_ORIGINS has ${left} ${left === 1 ? "entry" : "entries"} that ${left === 1 ? "is" : "are"} not one web address ("*" for every website is never allowed); ${left === 1 ? "it is" : "they are"} left out. Cuvori's own addresses stay allowed. ${WHERE}`);
  if (fixed) note(`ALLOWED_ORIGINS has ${fixed} ${fixed === 1 ? "entry" : "entries"} not written as a full web address; Cuvori corrected ${fixed === 1 ? "it" : "them"}. Check it in Netlify under Project configuration → Environment variables.`);
  return [...new Set([...DEFAULT_ORIGINS, ...list])];
}
export const ALLOWED_ORIGINS = originsSetting(env("ALLOWED_ORIGINS"));
export const AUTO_RELEASE_DAYS = 7; // hard-coded in order_action() too
// Cuvori's conservative per-payment total cap, including the quoted fee.
// Provider limits also depend on currency/payment method and must be checked at Checkout.
export const MAX_PAYMENT_CENTS = 99999999;
export const MIN_CENTS = 100, MAX_CENTS = 95000000, MIN_TOPUP_CENTS = 50;
export const FEE_SANITY_PERCENT = 10, FEE_SANITY_FIXED_CENTS = 100;   // a quoted fee above 10% + €1 can only be a slip in the fee table (quoteFor)
export const CONNECT_SANITY_PERCENT = 2, CONNECT_SANITY_FIXED_CENTS = 500;   // a payout fee above 2% + €5 can only be a slip in the fee table's "connect" row (quoteFor, v50)
export const HOLDING = ["funded", "delivered", "disputed"];
const holdsFunds = (c) => !!c && [...HOLDING, "releasing", "resolving"].includes(c.status);

export function escrowEnabled() { return !!(STRIPE_KEY && SERVICE_KEY && WEBHOOK_SECRET); }

const corsContext = new AsyncLocalStorage();
export function setCors(req) {
  const o = req && req.headers.get("origin") || "";
  corsContext.enterWith({ origin: ALLOWED_ORIGINS.includes(o) ? o : null });
}
// max-age: the browser may remember the answer to its "may I?" check for 10 minutes, so a click within that time is one
// call instead of two (without it the browser forgets after about 5 seconds)
const corsHeaders = () => {
  const origin = corsContext.getStore()?.origin;
  return origin ? { "access-control-allow-origin": origin, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-max-age": "600", "vary": "origin" } : { "vary": "origin" };
};
// Extra headers can add something (a "retry after" time, say) but never change what every answer is: JSON, never cached,
// and readable only by the websites on the allowed list. Headers are the same whatever their capital letters, so an extra
// "Content-Type" or "Access-Control-Allow-Origin" is dropped, not merged in next to the fixed one.
const FIXED_HEADER = /^(content-type|cache-control|vary|access-control-.*)$/i;
const extrasOnly = (h) => Object.fromEntries(Object.entries(h || {}).filter(([k]) => !FIXED_HEADER.test(String(k).trim())));
export const json = (status, body, extraHeaders = {}) => new Response(JSON.stringify(body), { status, headers: { ...extrasOnly(extraHeaders), "content-type": "application/json", "cache-control": "no-store", ...corsHeaders() } });
export const bad = (msg, status = 400, extraHeaders = {}) => json(status, { error: msg }, extraHeaders);
// a refusal with a code: the page says it in the person's language (fnPlain in index.html); the message stays for the log
export const refuse = (status, error, code) => json(status, { error, code });
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
// maxUnits (optional): also short enough for a limit counted the way JavaScript counts, where an emoji outside the basic
// range counts as two — so the text fits a limit however the other side counts it
// Only the start of the text is looked at: what is kept is never longer than 2 units per character (or maxUnits), so
// a note of several megabytes is shortened at once instead of being split up whole first. The piece where that start
// ends may be cut short there, so it is never kept (it could not have fitted anyway), and the start never ends between
// the two halves of an emoji, so every piece before it is exactly the piece the whole text has there.
const LONE_HALF = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const wellFormed = (t) => (typeof t.toWellFormed === "function" ? t.toWellFormed() : t.replace(LONE_HALF, "\uFFFD"));
export const cut = (text, n, maxUnits = Infinity) => {
  const s = String(text ?? "");
  let end = Math.min(2 * n, maxUnits) + 1;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xD800 && last <= 0xDBFF) end++;                     // never between the two halves of an emoji
  const short = end < s.length;
  // half an emoji that is already in the text (only a hand-made request can hold one) becomes "�" (U+FFFD), which counts the same:
  // the database refuses half an emoji, so a note holding one would be lost, or fail a step after the money has moved
  const head = wellFormed(short ? s.slice(0, end) : s);
  let out = "", used = 0;
  for (const segment of GRAPHEMES ? Array.from(GRAPHEMES.segment(head), x => x.segment) : Array.from(head)) {
    const size = Array.from(segment).length;
    if (used + size > n || out.length + segment.length > maxUnits) break;
    if (short && out.length + segment.length >= head.length) break;  // the piece at the end of the start may be cut short
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
const REFUND_SETTLING = "The payment provider cannot pay this refund yet (balance still settling). Cuvori retries every hour.";
const PROVIDER_DOWN = "The payment provider did not answer. Nothing was lost — please try again in a minute.";
const BANNED = "This freelancer cannot receive payments";
// Each of these is sent with a code (settling, freelancer_not_ready, chargeback_open, provider_down, under_review), so the
// page says it in the person's language; the English sentence is for the Order's note and the admin. Every other refusal
// a person can get carries a code too.

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
// A Stripe key that is not a secret key (Stripe's public "pk_…" key pasted by mistake, or another secret in its place)
// never moves money: payments pause, and both the Netlify log and the admin say exactly why. The log names only the key's
// first three characters, which are never secret.
function requireStripeMode() {
  if (STRIPE_MODE) return;
  if (KEY_PREFIX.test(STRIPE_KEY)) {
    console.error(`Payments paused: STRIPE_SECRET_KEY in Netlify has a space, a line break or another character that is not part of a Stripe key (it starts with "${STRIPE_KEY.slice(0, 3)}"); copy the key again from Stripe, in one piece`);
    throw fail("Payments are paused: the Stripe key in Netlify (STRIPE_SECRET_KEY) has a space, a line break or another character that is not part of a Stripe key. It must be copied again from Stripe, in one piece.", 503, PAUSED);
  }
  if (STRIPE_KEY) console.error(`Payments paused: STRIPE_SECRET_KEY in Netlify is not a Stripe secret key (it starts with "${STRIPE_KEY.slice(0, 3)}"; a secret key starts with sk_live_ or sk_test_, a restricted key with rk_live_ or rk_test_)`);
  throw fail(STRIPE_KEY ? "Payments are paused: the Stripe key in Netlify (STRIPE_SECRET_KEY) is not a secret key. It must start with sk_live_ or sk_test_ (rk_ for a restricted key)."
                        : "Payments are not configured. Please contact support.", 503, PAUSED);
}
async function checkStripeMode(fresh = false) {
  requireStripeMode();
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
export const STRIPE_VERSION = "2024-06-20";
// Marks on what a Stripe call returns (symbols: never sent anywhere, never saved): REPLAYED when Stripe handed back its
// saved answer to an earlier request with the same key (its Idempotent-Replayed header), IDEM_KEY the key moneyPost used
export const REPLAYED = Symbol("stripe replayed"), IDEM_KEY = Symbol("idempotency key");
// the call itself, without the checks: only for the checks and through stripe()
async function stripeCall(method, path, body, opts = {}) {
  if (!/^\/[a-z_]+(\/[A-Za-z0-9_]+)*$/.test(path)) throw new Error("bad Stripe path");
  const headers = { Authorization: `Bearer ${STRIPE_KEY}`, "Stripe-Version": STRIPE_VERSION };
  if (opts.idempotency) headers["Idempotency-Key"] = opts.idempotency;
  let url = `https://api.stripe.com/v1${path}`;
  const init = { method, headers, signal: AbortSignal.timeout(8000) };
  if (method === "GET") { if (body) url += "?" + encode(body); }
  else { headers["content-type"] = "application/x-www-form-urlencoded"; init.body = encode(body || {}); }
  let r;
  try { r = await fetch(url, init); }
  catch (e) {
    // Node's own text is never copied: for a request it refuses to send, it holds the request's headers, the key among
    // them. Only the kind of failure is kept, so the Netlify log still says what went wrong.
    const code = e && e.cause && typeof e.cause.code === "string" && /^[A-Z0-9_]{2,40}$/.test(e.cause.code) ? e.cause.code : null;
    const why = e && e.name === "TimeoutError" ? "no answer within 8 seconds" : code || (e && e.message === "fetch failed" ? "no connection" : "the request could not be sent");
    const x = new Error(`Could not reach the payment provider (${why})`); x.network = true; throw x;
  }
  let data;
  try { data = await r.json(); }
  catch { const e = new Error("Unreadable payment provider response"); e.outcomeUnknown = true; e.status = r.status; throw e; }
  if (!data || typeof data !== "object" || Array.isArray(data)) { const e = new Error("Invalid payment provider response"); e.outcomeUnknown = true; throw e; }
  if (!r.ok) { const e = new Error((data.error && data.error.message) || "Stripe error"); e.stripe = data.error || {}; e.status = r.status; e.shouldRetry = r.headers.get("Stripe-Should-Retry") === "true"; e.replayed = r.headers.get("Idempotent-Replayed") === "true"; throw e; }
  if (r.headers.get("Idempotent-Replayed") === "true") data[REPLAYED] = true;
  return data;
}
const stripeCode = (e) => (e && e.stripe && (e.stripe.code || e.stripe.decline_code)) || "";
// Stripe's two answers about a key itself rather than about the request:
// - "another request with this key is still running": a 409. Stripe's docs give it its own code, idempotency_key_in_use,
//   and don't say which type comes with it (the type idempotency_error is the other answer, below). Stripe's own library
//   sends every 409 again with the same key, and Stripe's docs say to wait and retry with that key: a new key could start
//   a second payout or refund. So every 409, or that code, counts: the key is kept and the same request asks again later.
// - "this key was used for a different request": the type idempotency_error, a 400.
export const idemBusy = (e) => !!(e && e.stripe && (e.status === 409 || e.stripe.code === "idempotency_key_in_use"));
export const idemMismatch = (e) => !!(e && e.stripe && e.stripe.type === "idempotency_error" && e.status === 400);
// either answer is about the key: what the first request with it did is not known from here, so the key is never dropped
const aboutTheKey = (e) => idemBusy(e) || !!(e && e.stripe && e.stripe.type === "idempotency_error");
// What Stripe recognises a repeated request by: the exact text it receives, read under the API version sent with it. A
// key named after this can never meet a request Stripe calls "different", whatever a later version changes in how
// requests are written.
export const stripeFingerprint = (path, body) => crypto.createHash("sha256").update(`${STRIPE_VERSION} POST ${path}\n${encode(body)}`).digest("hex").slice(0, 16);

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
// The Supabase key is one word too (sb_secret_… or, for the older service key, a JWT: letters, digits, "_", "-" and
// dots). One with anything else in it is never sent, for the same reason as the Stripe key: Node's error text for it holds
// the whole key. The Netlify log says why once per start, with the key's first 3 characters only.
const SERVICE_KEY_NAME = env("SUPABASE_SECRET_KEY") ? "SUPABASE_SECRET_KEY" : "SUPABASE_SERVICE_ROLE_KEY";
const SERVICE_KEY_WHOLE = /^[A-Za-z0-9._-]+$/.test(SERVICE_KEY);
// for stripe-status: whether the database key can be used at all (never the key), so the admin panel can say "ON, but
// paused" and name the setting, as it does for the Stripe key
export const SERVICE_KEY_OK = !!SERVICE_KEY && SERVICE_KEY_WHOLE;
let serviceKeyLogged = false;
// Every button then answers "payments paused" with the code the page says in the person's language (fnPlain in
// index.html); the admin also reads this sentence, which names the setting to correct.
function requireServiceKey() {
  if (!SERVICE_KEY) throw fail("Payments are paused: there is no database key in Netlify (SUPABASE_SECRET_KEY, or the older SUPABASE_SERVICE_ROLE_KEY).", 503, PAUSED);
  if (!SERVICE_KEY_WHOLE) {
    if (!serviceKeyLogged) { serviceKeyLogged = true; console.error(`Database paused: ${SERVICE_KEY_NAME} in Netlify has a space, a line break or another character that is not part of a Supabase key (it starts with "${SERVICE_KEY.slice(0, 3)}"); copy the key again from Supabase, in one piece`); }
    throw fail(`Payments are paused: the database key in Netlify (${SERVICE_KEY_NAME}) has a space, a line break or another character that is not part of a Supabase key. It must be copied again from Supabase, in one piece.`, 503, PAUSED);
  }
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
  contract: (id) => { if (!isUuid(id)) throw fail("Bad order id", 400, "not_your_order"); return db.one("contracts", `id=eq.${id}&select=*`); },
  milestone: (id) => { if (!isUuid(id)) throw fail("Bad milestone id", 400, "milestone_changed"); return db.one("order_milestones", `id=eq.${id}&select=*`); },
  // compare-and-set: only moves the row if it is still in one of `from`; returns the new row or null
  claim: async (id, from, patch) => { if (!isUuid(id)) throw fail("Bad order id", 400, "not_your_order"); const rows = await db.update("contracts", `id=eq.${id}&status=in.(${from.map(q).join(",")})`, patch); return rows && rows[0] || null; },
  claimMilestone: async (id, from, patch) => { if (!isUuid(id)) throw fail("Bad milestone id", 400, "milestone_changed"); const rows = await db.update("order_milestones", `id=eq.${id}&status=in.(${from.map(q).join(",")})`, patch); return rows && rows[0] || null; },
};
// the Order behind a Stripe payment: the first payment is on the row, top-ups are in the ledger
export async function contractByPi(pi) {
  if (!isPi(pi)) return null;
  const c = await db.one("contracts", `stripe_payment_intent=eq.${q(pi)}&select=*`);
  if (c) return c;
  const row = await db.one("order_payments", `provider_ref=eq.${q(pi)}&kind=eq.fund&select=order_id`);
  return row ? db.contract(row.order_id) : null;
}

// Every answer of the sign-in check carries a code, so the page says it in the person's language (fnPlain in index.html),
// never this English sentence, which stays for the owner. Every Cuvori button that needs a sign-in uses this check.
const SIGNIN_DOWN = "signin_unavailable";
export async function userFromRequest(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") || "");
  if (!m) return null;
  requireServiceKey();
  let r;
  try { r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${m[1]}` }, signal: AbortSignal.timeout(8000) }); }
  catch { throw fail("Sign-in verification is temporarily unavailable. Please try again shortly.", 503, SIGNIN_DOWN); }
  if (r.status === 429) throw fail("Too many sign-in checks. Please try again shortly.", 429, "too_many_tries");
  if (r.status >= 500) throw fail("Sign-in verification is temporarily unavailable. Please try again shortly.", 503, SIGNIN_DOWN);
  let u;
  try { u = await r.json(); }
  catch { throw fail("Sign-in verification is temporarily unavailable. Please try again shortly.", 503, SIGNIN_DOWN); }
  if (!r.ok) {
    // Supabase Auth: `error_code` is the name ("bad_jwt"); `code` is often just the HTTP status number
    const code = u && (u.error_code || (typeof u.code === "string" ? u.code : null));
    if (code === "user_banned") throw fail("Account suspended", 403, "account_suspended");
    if (["bad_jwt", "session_not_found", "session_expired", "user_not_found", "no_authorization", "invalid_credentials"].includes(code)) return null;
    // Older Auth responses may have no code. An API-key failure concerns the backend,
    // so signing in again would not help. Never send the provider's raw message back.
    const message = String(u && (u.message || u.msg || u.error_description || u.error) || "");
    if (!code && (r.status === 401 || r.status === 403) && /jwt|token|session|expired/i.test(message) && !/api.?key/i.test(message)) return null;
    throw fail("Sign-in verification is unavailable. Please contact support if this continues.", 503, SIGNIN_DOWN);
  }
  if (!u || !isUuid(u.id)) throw fail("Sign-in verification is temporarily unavailable. Please try again shortly.", 503, SIGNIN_DOWN);
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
export async function quoteFor(priceCents, currency = "EUR", country = null, customer = "any", method = "any", topup = false) {
  // a whole Order starts at €1 (MIN_CENTS, checked by the caller); a top-up for an agreed amendment may be smaller.
  // €0.50 is the smallest card payment Stripe takes in euros, so nothing below it can ever be paid.
  if (!Number.isSafeInteger(priceCents) || priceCents < MIN_TOPUP_CENTS || priceCents > MAX_CENTS) throw fail("Order amount is outside the allowed range.", 400, "amount_out_of_range");
  const qte = await db.rpc("order_quote", { p_price_cents: priceCents, p_currency: currency, p_country: country, p_customer: customer, p_method: method, p_topup: !!topup });
  if (!qte || !Number.isSafeInteger(qte.total_cents) || qte.total_cents < priceCents) throw new Error("bad quote");
  // Stripe's payout fees (schema v50): their own line, never part of the card fee. A database from before v50 has no such
  // line (0). The three lines must add up to the total the client is shown; nothing else is ever charged.
  const connect = qte.connect_cents == null ? 0 : qte.connect_cents;
  if (!Number.isSafeInteger(connect) || connect < 0 || !Number.isSafeInteger(qte.processing_cents) || qte.total_cents !== priceCents + qte.processing_cents + connect) throw new Error("bad quote");
  qte.connect_cents = connect;
  // A slip in the payout-fee row (25 instead of 0.25, €21 instead of €2.10) must never reach a card either: far above
  // Stripe's Connect rates, with room for the fixed part on the smallest payments.
  if (connect > Math.ceil(priceCents * CONNECT_SANITY_PERCENT / 100) + CONNECT_SANITY_FIXED_CENTS) {
    console.error("fee table: the payout fee is far above Stripe's Connect rates — payments paused", JSON.stringify({ connect_schedule_id: qte.connect_schedule_id, connect_percent: qte.connect_percent, connect_fixed_cents: qte.connect_fixed_cents, price_cents: priceCents, connect_cents: connect }));
    throw fail(`Payments through Cuvori are paused: the fee table's payout-fee row charges ${qte.connect_percent}% + ${qte.connect_fixed_cents} cents, which is far above Stripe's Connect rates. Correct it under Payment costs in the admin panel.`, 503, PAUSED);
  }
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
  if (qte.total_cents > MAX_PAYMENT_CENTS) throw fail("The order total including fees exceeds the payment limit.", 400, "amount_out_of_range");   // code: the page says it in the client's language
  return qte;
}

// ---- history, ledger, chat card ----
export async function orderEvent(c, ev, data, actor) {
  if (!c) return;
  await db.insert("order_events", { order_id: c.id, actor: actor || null, event: ev, data: data || {} }).catch(e => console.error("event", ev, e.message));
}
// A ledger line. A failed save is looked up first (a save whose answer was lost is never written twice) and tried again,
// three tries in all; without a way to look it up, or with no answer to the look-up, it is never saved again blind.
// `same` finds this very line. True once the line is there; false when it could not be saved: the caller then says so
// on the Order, and the hourly run adds it from Stripe's record (repairFirstLines, repairPayoutLines).
export async function ledger(c, row, same) {
  const line = { order_id: c.id, provider: "stripe", status: "succeeded", ...row };
  for (let i = 0; i < 3; i++) {
    try { await db.insert("order_payments", line); return true; }
    catch (e) {
      console.error("ledger", line.kind, e.message);
      if (!same) return false;
      let found;
      try { found = await db.one("order_payments", `order_id=eq.${c.id}&${same}&select=id`); } catch (e2) { console.error("ledger lookup", e2.message); return false; }
      if (found) return true;                                                          // it was saved, only the answer was lost
      if (i < 2) await sleep(250 * (i + 1));
    }
  }
  return false;
}
// The chat card ("Order funded", "Payment released", …). Written after the money has moved, so, like the history line above,
// a card that cannot be saved (the database did not answer for a moment) is written to the log and never fails the step:
// the person is told what really happened, and Stripe is never asked to send a payment again that is already recorded.
export async function contractEvent(c, ev, sender, extra) {
  if (!c) return;
  await db.insert("messages", { conversation_id: c.conversation_id, sender: sender || c.editor, kind: "contract", body: c.title,
    payload: { contract_id: c.id, event: ev, title: c.title, price: c.price, currency: c.currency, pricing: c.pricing, status: c.status, amount_cents: c.amount_cents, ...(extra || {}) } })
    .catch(e => console.error("chat card not saved", ev, c.id, e.message));
}
// The ledger lines money came into an Order by. Refunds, a chargeback and the card-fee surplus all go by them, so a first
// payment counted on the Order without its line (its save failed, see saveFirstLine) gets its line from Stripe's record
// first (repairFirstLine). It is placed first: it was the first payment.
const savedFundRows = async (c) => (await db.select("order_payments", `order_id=eq.${c.id}&kind=eq.fund&status=eq.succeeded&select=*&order=created_at.asc`)) || [];
const fundRows = async (c) => {
  const rows = await savedFundRows(c);
  if (!isPi(c.stripe_payment_intent) || !nz(c.funded_cents) || rows.some(r => r.provider_ref === c.stripe_payment_intent)) return rows;
  const added = await repairFirstLine(c, rows).catch(e => { console.error("first payment line not added", c.id, e.message); return null; });
  return added && added.status === "succeeded" ? [added, ...rows] : rows;
};

// ---- the first payment's ledger line ----
// Saved right after the payment is counted on the Order. A failed save is looked up and tried again, so a save whose answer
// was lost is never written twice; one that still cannot be saved is said on the Order (the admin panel shows it under
// "Needs a hand"), and the line is added later from Stripe's own record of the payment.
export const FIRST_LINE_NOTE = "ledger line of the first payment not saved: ";
const FIRST_LINE_WAIT_MS = 2 * 60e3;     // the payment's own save is long over by then (a function runs for seconds)
async function saveFirstLine(u, line) {
  if (await ledger(u, line, `kind=eq.fund&provider_ref=eq.${q(line.provider_ref)}`)) return true;
  await putNote(u.id, n => addNote(n, `${FIRST_LINE_NOTE}${line.provider_ref} (the hourly run adds it from Stripe's record; if this note stays, check by hand)`));
  return false;
}
// One writer at a time for a missing line: a claim per payment, which a writer that died leaves for at most 90 s.
async function claimLine(scope) {
  const key = `claim:${crypto.randomUUID().slice(0, 12)}`;
  const take = async () => { try { await db.insert("money_keys", { scope, key }); return key; } catch (e) { if (e.status === 409) return null; throw e; } };
  const k = await take(); if (k) return k;
  const row = await db.one("money_keys", `scope=eq.${q(scope)}&select=created_at`);
  if (!row || !row.created_at || Date.now() - Date.parse(row.created_at) <= LOCK_STALE_MS) return null;
  await db.remove("money_keys", `scope=eq.${q(scope)}&created_at=lt.${q(new Date(Date.now() - LOCK_STALE_MS).toISOString())}`).catch(() => {});
  return take();
}
// A first payment counted on its Order without its ledger line: the line is added from Stripe's record of that payment.
// Only once the payment is 2 minutes old (its own save can no longer be on its way), one writer at a time, and only when
// Stripe's record matches the Order: the payment succeeded, it belongs to this Order and is in its currency, and without
// the card fee it is exactly what the Order counts as paid in beyond its other lines. Anything else is left as it is: the
// Order's note stays for a person to check. Returns the line, or null.
export async function repairFirstLine(c, rows) {
  const pi = c && c.stripe_payment_intent;
  if (!isPi(pi) || !nz(c.funded_cents)) return null;
  if (c.paid_mode && c.paid_mode !== STRIPE_MODE) return null;                       // paid in the other mode: these keys cannot see it
  const have = await fundRowOf(c, pi); if (have) return have;
  const at = Date.parse(c.funded_at || "");
  if (!Number.isFinite(at) || Date.now() - at < FIRST_LINE_WAIT_MS) return null;
  const scope = `ledger:${pi}`, key = await claimLine(scope);
  if (!key) return null;                                                                // another writer is on it
  let keep = false;
  try {
    const again = await fundRowOf(c, pi); if (again) return again;
    const p = await stripe("GET", `/payment_intents/${pi}`, { "expand[]": "latest_charge.balance_transaction" });
    const ch = p && p.latest_charge && typeof p.latest_charge === "object" ? p.latest_charge : null;
    const bt = ch && ch.balance_transaction && typeof ch.balance_transaction === "object" ? ch.balance_transaction : null;
    const md = (p && p.metadata) || {};
    const total = p && Number.isInteger(p.amount_received) && p.amount_received > 0 ? p.amount_received : p && p.amount;
    const fee = Number.isInteger(c.fee_cents) && c.fee_cents >= 0 ? c.fee_cents : null;
    const connect = Number.isInteger(c.connect_cents) && c.connect_cents >= 0 ? c.connect_cents : 0;   // Stripe's payout fees (v50); none before it
    const amount = Number.isInteger(total) && fee != null ? total - fee - connect : null;
    const others = (rows || await savedFundRows(c)).filter(r => r.provider_ref !== pi).reduce((a, r) => a + r.amount_cents, 0);
    const why = !p || p.status !== "succeeded" ? "the payment is not marked succeeded at Stripe"
      : (md.contract_id && md.contract_id !== c.id) || (md.kind && md.kind !== "fund") ? "the payment belongs to something else"
      : !ch || String(ch.currency || "").toLowerCase() !== String(c.currency || "EUR").toLowerCase() ? "the currency does not match"
      : !(amount > 0) || amount !== nz(c.funded_cents) - others ? `Stripe's payment (${total} with a ${fee} card fee and a ${connect} payout fee) does not match what the Order counts as paid in` : null;
    if (why) { console.error("first payment line not added", c.id, pi, why); return null; }
    keep = true;      // a lost answer may still mean the line was saved: the claim then stays (90 s), so nobody writes it twice
    await db.insert("order_payments", { order_id: c.id, provider: "stripe", status: "succeeded", kind: "fund", amount_cents: amount, fee_cents: fee, connect_cents: connect, provider_ref: pi,
      charge_ref: ch.id || null, provider_fee_cents: bt && Number.isInteger(bt.fee) ? bt.fee : null, note: "fund (line added from Stripe's record)" });
    keep = false;
    console.error("first payment line added from Stripe's record", c.id, pi, amount);
    const mine = (n) => n.startsWith(FIRST_LINE_NOTE) && n.includes(pi);
    if (hasNote(c.money_error, mine)) await putNote(c.id, n => dropNote(n, mine));
    return await fundRowOf(c, pi);
  } finally { if (!keep) await dropKeyIf(scope, key); }
}
// The hourly run: Orders paid in the last 30 days, and any older one whose note says its line is missing. The card-fee
// surplus of a line added here goes back to the card right away.
export async function repairFirstLines() {
  const since = q(new Date(Date.now() - 30 * 86400e3).toISOString());          // the 2 minutes are checked by repairFirstLine
  const recent = (await db.select("contracts", `payment_mode=eq.escrow&funded_at=gt.${since}&select=*&order=funded_at.desc&limit=100`)) || [];
  const noted = (await db.select("contracts", `money_error=like.${q(FIRST_LINE_NOTE)}*&select=*&limit=20`)) || [];
  const todo = [...new Map([...recent, ...noted].filter(c => isPi(c.stripe_payment_intent) && nz(c.funded_cents)).map(c => [c.id, c])).values()];
  if (!todo.length) return { added: 0, failed: [] };
  const have = new Set(((await db.select("order_payments", `kind=eq.fund&provider_ref=in.(${todo.map(c => q(c.stripe_payment_intent)).join(",")})&select=provider_ref`)) || []).map(r => r.provider_ref));
  let added = 0; const failed = [];
  for (const c of todo.filter(c => !have.has(c.stripe_payment_intent))) {
    try {
      const row = await repairFirstLine(c);
      if (!row) { if (hasNote(c.money_error, n => n.startsWith(FIRST_LINE_NOTE))) failed.push({ id: c.id, why: "first payment line still missing" }); continue; }
      added++;
      await settleFee(c, row).catch(e => console.error("fee settle", c.id, e.message));
    } catch (e) { failed.push({ id: c.id, why: "first payment line: " + e.message }); console.error("first payment line failed for", c.id, e.message); }
  }
  return { added, failed };
}

// ---- the payout lines: a milestone's payout, and the re-payment after a chargeback Cuvori won ----
// Written after the money moved and the counters followed. One that could not be saved is said on the Order and added by
// the hourly run from Stripe's record of the transfer: under the Order's lock, never twice, and nothing is paid or counted
// again (the counters already include it). A note that starts like this is not a retry marker: no money is on its way.
export const MS_LINE_NOTE = "ledger line of a milestone payout not saved: ";
export const REPAY_LINE_NOTE = "ledger line of the re-payment not saved: ";
export async function repairPayoutLines() {
  let added = 0; const failed = [];
  // milestones paid out in the last 30 days, and every paid-out milestone of an Order whose note says a line is missing
  const since = q(new Date(Date.now() - 30 * 86400e3).toISOString());
  const recent = (await db.select("order_milestones", `status=eq.released&released_at=gt.${since}&select=*&order=released_at.desc&limit=200`)) || [];
  const noted = (await db.select("contracts", `money_error=like.${q(MS_LINE_NOTE)}*&select=id&limit=20`)) || [];
  const ofNoted = noted.length ? ((await db.select("order_milestones", `status=eq.released&order_id=in.(${noted.map(c => c.id).join(",")})&select=*`)) || []) : [];
  const ms = [...new Map([...recent, ...ofNoted].filter(m => isStripeId(m.transfer_ref)).map(m => [m.id, m])).values()];
  const have = new Set(ms.length ? ((await db.select("order_payments", `kind=eq.release&milestone_id=in.(${ms.map(m => m.id).join(",")})&select=milestone_id`)) || []).map(r => r.milestone_id) : []);
  const byOrder = new Map();
  for (const m of ms.filter(m => !have.has(m.id))) byOrder.set(m.order_id, [...(byOrder.get(m.order_id) || []), m]);
  for (const id of new Set([...byOrder.keys(), ...noted.map(c => c.id)])) {
    try { added += await repairMilestoneLines(id, byOrder.get(id) || []); }
    catch (e) { failed.push({ id, why: "milestone payout line: " + e.message }); console.error("milestone payout line failed for", id, e.message); }
  }
  // re-payments after a won chargeback
  for (const { id } of ((await db.select("contracts", `money_error=like.${q(REPAY_LINE_NOTE)}*&select=id&limit=20`)) || [])) {
    try { added += await repairRepayLine(id); }
    catch (e) { failed.push({ id, why: "re-payment line: " + e.message }); console.error("re-payment line failed for", id, e.message); }
  }
  return { added, failed };
}
async function repairMilestoneLines(id, missing) {
  const unlock = await lockOrder(id);
  try {
    const c = await db.contract(id);
    if (!c || (c.paid_mode && c.paid_mode !== STRIPE_MODE)) return 0;                // paid in the other mode: these keys cannot see it
    const lines = () => db.select("order_payments", `order_id=eq.${id}&kind=eq.release&select=milestone_id`).then(r => r || []);
    const had = await lines();
    // only once the payout is 2 minutes old: its own save is long over by then
    const todo = missing.filter(m => !had.some(l => l.milestone_id === m.id) && Date.now() - Date.parse(m.released_at || "") >= FIRST_LINE_WAIT_MS);
    let added = 0;
    if (todo.length) {
      const ts = await transfersOf(c);
      for (const m of todo) {
        const t = ts.find(x => x.id === m.transfer_ref);
        if (!t || t.amount !== m.amount_cents || (t.metadata.milestone_id || "") !== m.id) { console.error("milestone payout line not added", id, m.id, "the transfer at Stripe does not match the milestone"); continue; }
        if (await ledger(c, { kind: "release", milestone_id: m.id, amount_cents: m.amount_cents, provider_ref: t.id, note: "milestone payout (line added from Stripe's record)" }, `kind=eq.release&milestone_id=eq.${m.id}`)) added++;
      }
    }
    // the note goes once every paid-out milestone of the Order has its line
    const msLine = (n) => n.startsWith(MS_LINE_NOTE);
    if (hasNote(c.money_error, msLine)) {
      const out = (await db.select("order_milestones", `order_id=eq.${id}&status=eq.released&select=id`)) || [], now = await lines();
      if (out.every(m => now.some(l => l.milestone_id === m.id))) await putNote(id, n => dropNote(n, msLine));
    }
    return added;
  } finally { await unlock(); }
}
async function repairRepayLine(id) {
  const unlock = await lockOrder(id);
  try {
    const c = await db.contract(id);
    const repayLine = (n) => n.startsWith(REPAY_LINE_NOTE);
    if (!c || !hasNote(c.money_error, repayLine) || !c.chargeback_id) return 0;
    if (c.paid_mode && c.paid_mode !== STRIPE_MODE) return 0;
    const t = (await transfersOf(c)).find(x => !x.reversed && x.metadata.purpose === `retransfer_${c.chargeback_id}`);
    if (!t) { console.error("re-payment line not added", id, "no re-payment at Stripe"); return 0; }
    const same = `kind=eq.release&note=eq.chargeback_won&provider_ref=eq.${q(t.id)}`;
    const there = await db.one("order_payments", `order_id=eq.${id}&${same}&select=id`);
    const ok = there || await ledger(c, { kind: "release", amount_cents: t.amount, provider_ref: t.id, note: "chargeback_won" }, same);
    if (ok) await putNote(id, n => dropNote(n, repayLine));
    return ok && !there ? 1 : 0;
  } finally { await unlock(); }
}

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
// forgets the key only if it is still the given one: a newer key another request has just stored is never removed
export const dropKeyIf = (scope, key) => (key ? db.remove("money_keys", `scope=eq.${q(scope)}&key=eq.${q(key)}`).catch(() => {}) : Promise.resolve());
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
export async function lockOrder(id, waitMs = LOCK_WAIT_MS) {
  const scope = `lock:${id}`;
  const until = Date.now() + waitMs;
  do {
    if (await claimScope(scope)) return () => dropKey(scope);
    const row = await db.one("money_keys", `scope=eq.${q(scope)}&select=created_at`);
    if (row && row.created_at && Date.now() - Date.parse(row.created_at) > LOCK_STALE_MS) {          // only that stale row, never a fresh one taken meanwhile
      await db.remove("money_keys", `scope=eq.${q(scope)}&created_at=lt.${q(new Date(Date.now() - LOCK_STALE_MS).toISOString())}`).catch(() => {}); continue;
    }
    await sleep(LOCK_POLL_MS);
  } while (Date.now() < until);
  throw fail("Another payment step on this order is still running. Please try again in a moment.", 409, "busy");
}
// Also used to make payment pages (stripe-checkout): one key per exact request, renewed after a definite Stripe failure.
export async function moneyPost(scope, path, body) {
  const key = await moneyKey(scope);
  try { const out = await stripe("POST", path, body, { idempotency: key }); out[IDEM_KEY] = key; return out; }
  catch (e) {
    if (e && typeof e === "object") e.idemKey = key;
    // Keep the key only when the outcome is unknown (no answer, unreadable answer, Stripe says "retry with the
    // same key", another request with this key is still running, or the key belongs to a different request). Any
    // other answer is final for this key — including a 500, which Stripe saves and would replay for 24 h. The next
    // attempt gets a fresh key; the Stripe-side lookups before every transfer, refund and reversal are what keep a
    // fresh attempt from paying twice.
    const unknown = e.network || e.outcomeUnknown || e.shouldRetry || aboutTheKey(e) || !e.status;
    if (!unknown) await db.remove("money_keys", `scope=eq.${q(scope)}&key=eq.${q(key)}`).catch(() => {});
    throw e;
  }
}

// Each freelancer has one saved Stripe account per mode: the test pair is the original stripe_account_id /
// stripe_payouts_enabled, the live pair stripe_live_account_id / stripe_live_payouts_enabled (schema v28). Only the
// pair of the current mode is ever read or written; the other one stays exactly as it is.
export const acctCols = () => {
  requireStripeMode();
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
// hand", and the note goes once the check works again. Cuvori's own clear refusals
// (payments paused, not configured) are not written: everyone is shown those already.
// The note says in plain words what went wrong, never Stripe's own text: both people on the Order can read its notes,
// and Stripe's text can name Cuvori's Stripe account or show the end of its key. The full error goes to the Netlify
// function log under the ref the note gives, and only the owner sees that log.
const CHECK_FAILED = "Stripe check failed: ", CHECK_NEEDED = "Stripe account check: ";
// Written only while the note still reads exactly what this request read: two checks of the same Order can overlap, and
// the one that finishes last must not wipe out or replace what the other just found.
const noteStill = (c) => (c.money_error == null ? "money_error=is.null" : `money_error=eq.${q(c.money_error)}`);
const isCheckNote = (n) => n.startsWith(CHECK_FAILED) || n.startsWith(CHECK_NEEDED);
// "Stripe check failed" is never added to another note: it says nothing a person must do, and the check writes it again
// each time it fails. "Needs a check by hand" goes after the notes already there (it takes the place of this check's own
// older note, so its ref and time stay current).
async function writeCheckNote(c, text) {
  if (text.startsWith(CHECK_FAILED) && notesOf(c.money_error).some(n => !isCheckNote(n))) return;
  await db.update("contracts", `id=eq.${c.id}&${noteStill(c)}`, { money_error: addNote(c.money_error, text, isCheckNote) }).catch(() => {});
}
// ---- an Order's note: several at once ----
// The admin panel shows an Order's note under "Needs a hand". More than one thing can need a look on the same Order, so a
// new note never wipes out the ones already there: they stay after it, separated by " · Also: ", the newest first. A note
// goes only when what it says is done (each step removes only its own) or when the admin marks it as handled (schema v55).
// The notes the hourly run works from always come first, because it looks at the start of the note: a chargeback's
// pull-back or re-payment still owed, then a payment line still to add. A stopped step's note comes last (the hourly run
// retries the step), and a "Stripe check failed" note is dropped when another note is written (the check writes it again
// if it still fails).
export const ALSO = " · Also: ";
// an empty note, or one of only spaces, says nothing (the admin panel shows no text for it): it counts as no note at all
const notesOf = (note) => (note == null || String(note).trim() === "" ? [] : String(note).split(ALSO));
const noteOf = (parts) => (parts.length ? parts.join(ALSO) : null);
const isCbMark = (n) => /^chargeback(:| won)/.test(n);
// (the account check's note comes after the other notes that need a person: the database empties a note that starts with it
// when an unpaid Order is cancelled, schema v31, and that must never take another note with it)
const rankOf = (n) => isCbMark(n) ? 0 : [FIRST_LINE_NOTE, MS_LINE_NOTE, REPAY_LINE_NOTE].some(p => n.startsWith(p)) ? 1 : isStepNote(n) ? 3 : n.startsWith(CHECK_NEEDED) ? 2.5 : 2;
// the note with `text` added; replaces(part) says which notes the new one takes the place of (the next stage of the same
// chargeback, an older stop of the same step)
export function addNote(note, text, replaces = () => false) {
  const parts = notesOf(note).filter(n => n.trim() !== "" && !n.startsWith(CHECK_FAILED) && !replaces(n) && n !== text);
  const at = parts.findIndex(n => rankOf(n) >= rankOf(text));
  parts.splice(at < 0 ? parts.length : at, 0, text);
  return noteOf(parts);
}
// the note without the parts done(part) says are done: the rest comes back (null when nothing is left)
export const dropNote = (note, done) => noteOf(notesOf(note).filter(n => !done(n)));
export const hasNote = (note, which) => notesOf(note).some(which);
// the Order's money steps are over (paid out or given back): a stopped step's note and a Stripe check's note say nothing any more
export const stepsOver = (note) => dropNote(note, n => isStepNote(n) || isCheckNote(n));
// Changes the note from what it is now, never from an older copy, so a note written meanwhile is never lost.
async function putNote(id, change) {
  for (let i = 0; i < 5; i++) {
    const c = await db.contract(id).catch(() => null);
    if (!c) return null;
    const after = change(c.money_error ?? null);
    if ((after ?? null) === (c.money_error ?? null)) return c;
    const rows = await db.update("contracts", `id=eq.${id}&${noteStill(c)}`, { money_error: after }).catch(() => null);
    if (rows && rows[0]) return rows[0];
  }
  return null;
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
// The note on an Order when a money step fails (a payout, a refund, pulling money back after a chargeback, paying again
// after a won one). The same rule as the Stripe check's note above: both people on the Order can read it, so it is
// Cuvori's own sentence. Cuvori's own messages (the money is still settling, the account is not ready, Stripe did not
// answer, …) are written as they are; an answer from Stripe or the database, or any other error, is said in plain words,
// and its full text goes to the Netlify log under the ref the note gives — the ref the person is shown too.
function failNote(e, step) {
  const own = e && (e.expose || (e.constructor === Error && !e.stripe && !e.network && !e.outcomeUnknown && !e.db));
  if (own) return String(e.message);
  const ref = e && typeof e.ref === "string" && /^[0-9a-f]{8}$/.test(e.ref) ? e.ref : crypto.randomUUID().slice(0, 8);
  try { e.ref = ref; } catch {}
  console.error("money step failed", ref, step, e && e.stack || e);
  return `${checkNote(e)} (Netlify log ref ${ref})`;
}
// A money step that stops (the whole Order's settlement, or one milestone's payout) writes why under its own heading —
// "Money step stopped (settlement): …", "Money step stopped (milestone <id>): …" — so the admin sees which step it was.
// It goes after the notes already on the Order (it never replaces one, except an older stop of the same step), and when
// the step goes through it removes only its own note (and a Stripe check's note: the money moved).
const STEP_NOTE = "Money step stopped";
const stepHead = (what) => `${STEP_NOTE} (${what}): `;
// what a stopped step wrote before it had a heading (until October 2026): Cuvori's own sentence, or "<what went wrong> (Netlify log ref …)"
const OLD_STEP = new Set([SETTLING, NOT_READY, CHARGEBACK, REFUND_SETTLING, PROVIDER_DOWN, BANNED]);
const oldStepNote = (n) => OLD_STEP.has(n) || /^[^:]+ \(Netlify log ref [0-9a-f]{8}\)$/.test(n);
const isStepNote = (n) => n.startsWith(STEP_NOTE + " (") || oldStepNote(n);
async function stepStopped(c, what, e) {
  const text = (stepHead(what) + failNote(e, `${what} of order ${c.id}`)).slice(0, 300);   // the ref is logged in any case
  await putNote(c.id, n => addNote(n, text, p => p.startsWith(stepHead(what)) || oldStepNote(p)));   // replaces an older stop of this step
}
// head: this step's own heading, or STEP_NOTE + " (" for every stopped step's note. Only while the note still reads
// what this step read: a note written since stays.
async function stepDone(c, head) {
  const after = dropNote(c.money_error, n => isCheckNote(n) || n.startsWith(head) || oldStepNote(n));
  if ((after ?? null) === (c.money_error ?? null)) return c;
  const rows = await db.update("contracts", `id=eq.${c.id}&${noteStill(c)}`, { money_error: after }).catch(() => null);
  return rows && rows[0] || c;
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
  if (hasNote(c.money_error, isCheckNote)) await db.update("contracts", `id=eq.${c.id}&${noteStill(c)}`, { money_error: dropNote(c.money_error, isCheckNote) }).catch(() => {});
  return acct;
}

// ---- money movements ----
export async function transfersOf(c) { const r = await stripe("GET", "/transfers", { transfer_group: `contract_${c.id}`, limit: 100 }); return (r.data || []).filter(t => t.metadata && t.metadata.contract_id === c.id); }

// Pay the freelancer. `purpose` separates a normal release from paying again after a chargeback was won.
export async function releaseToEditor(c, editorCents, milestoneId = null, purpose = "release") {
  if (!Number.isInteger(editorCents) || editorCents <= 0) throw new Error("bad release amount");
  if (purpose === "release" && editorCents > heldCents(c)) throw new Error("bad release amount");
  sameMode(c);
  if (chargebackOpen(c)) throw fail(CHARGEBACK, 409, "chargeback_open");
  // a transfer for the same milestone / the same settlement attempt is never made twice. Whole-order releases carry
  // the attempt (the decision's timestamp): a later, different decision on the same Order may transfer again.
  const attemptTag = milestoneId || purpose !== "release" ? "" : String(c.resolved_at || "");
  const existing = await transfersOf(c);
  const prior = existing.find(t => !t.reversed && (t.metadata.milestone_id || "") === (milestoneId || "") && (t.metadata.purpose || "release") === purpose && (!t.metadata.attempt || t.metadata.attempt === attemptTag));
  if (prior) { if (prior.amount !== editorCents) throw new Error(`transfer ${prior.id} exists with a different amount`); return prior.id; }
  // Existing transfers above still need reconciliation; a ban blocks new transfers.
  if (await isBanned(c.editor)) throw fail(BANNED, 409, "under_review");
  const acct = await payoutAccount(c.editor);
  if (!accountReady(acct)) throw fail(NOT_READY, 409, "freelancer_not_ready");
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
    if (stripeCode(e) === "balance_insufficient" || /insufficient funds/i.test(e.message)) throw fail(SETTLING, 409, "settling");
    if (/capabilit|destination|No such account|payouts/i.test(e.message) && e.status === 400) throw fail(NOT_READY, 409, "freelancer_not_ready");
    if (e.network) throw fail(PROVIDER_DOWN, 503, "provider_down");
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
  if (chargebackOpen(c)) throw fail(CHARGEBACK, 409, "chargeback_open");
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
    if (stripeCode(e) === "balance_insufficient" || /insufficient funds/i.test(e.message)) throw fail(REFUND_SETTLING, 409, "settling");
    // Stripe has two codes for "this payment was charged back, it can't be refunded"
    if (["charge_disputed", "refund_disputed_payment"].includes(stripeCode(e)) || /charged back/i.test(e.message)) throw fail(CHARGEBACK, 409, "chargeback_open");
    if (e.network) throw fail(PROVIDER_DOWN, 503, "provider_down");
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
  if (chargebackOpen(c)) throw fail(CHARGEBACK, 409, "chargeback_open");
  if (c.status !== c0.status) throw fail("The order changed a moment ago — reload the page.", 409, "order_changed");
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
    await stepStopped(c, "settlement", e);
    throw e;
  }
  const movedE = (doneT ? editorCents : 0) + pendE, movedR = (doneR ? refundCents : 0) + pendR;
  // the decision names the outcome; when nothing was left to move (milestones took it all), whoever has the money does
  const paid = movedE + movedR > 0 ? movedE > 0 : nz(c.released_cents) > 0;
  let u = (await db.update("contracts", `id=eq.${c.id}&status=eq.${c.status}`, { status: paid ? "completed" : "refunded",
    completed_at: paid ? now : null, closed_at: now, resolved_at: now, auto_release_at: null,
    funded_cents: nz(c.funded_cents) || centsOf(c) || 0 }))[0];
  if (!u) { await putNote(c.id, n => addNote(n, `settled at the provider (${transferId || ""} ${refundId || ""}) but the order changed meanwhile — check by hand`)); throw new Error("order changed during settlement"); }
  // every money step on the Order is over now (a milestone that stopped can no longer be paid out), so the notes of
  // stopped steps go; any other note stays until it is dealt with
  u = await stepDone(u, STEP_NOTE + " (");
  await orderEvent(u, ev === "approve" ? "released" : ev === "auto_release" ? "auto_released" : ev.startsWith("resolved") ? "resolved" : ev, { editor_cents: movedE, refund_cents: movedR, decision: u.resolution }, actor);
  await contractEvent(u, ev, actor, { amount_cents: movedE || movedR });
  return u;
}

// Release one milestone: transfer its amount, mark it released, add it to the Order's counters.
// When it was the last one the Order is complete.
export async function releaseMilestone(c0, m, actor, ev) {
  if (!m || m.order_id !== c0.id) throw fail("Milestone does not belong to this order", 409, "milestone_changed");
  if (!["submitted", "approved"].includes(m.status)) throw fail("This milestone is not waiting for approval", 409, "milestone_changed");
  const unlock = await lockOrder(c0.id);
  try { return await releaseMilestoneLocked(c0, m, actor, ev); } finally { await unlock(); }
}
async function releaseMilestoneLocked(c0, m, actor, ev) {
  // fresh row under the lock: another milestone, a refund or a chargeback may have moved money since the caller looked
  const c = await db.contract(c0.id);
  if (!c) throw fail("Order not found", 404, "order_changed");
  if (!["funded", "delivered"].includes(c.status)) throw fail("Nothing to release right now", 409, "nothing_to_release");
  if (chargebackOpen(c)) throw fail(CHARGEBACK, 409, "chargeback_open");
  if (m.amount_cents > heldCents(c)) throw fail("Not enough money is held for this milestone", 409, "not_enough_held");
  const claimed = await db.claimMilestone(m.id, ["submitted", "approved"], { status: "approved", approved_at: m.approved_at || new Date().toISOString(), auto_release_at: null });
  if (!claimed) throw fail("This milestone was just changed, reload", 409, "milestone_changed");
  let transferId;
  try { transferId = await releaseToEditor(c, m.amount_cents, m.id); }
  catch (e) { await stepStopped(c, `milestone ${m.id}`, e); throw e; }
  const now = new Date().toISOString();
  const marked = await db.claimMilestone(m.id, ["approved"], { status: "released", released_at: now, transfer_ref: transferId });
  if (!marked) return transferId;                                                      // another request marked it first: it also moved the counters
  // the counters move exactly once per milestone, even when two milestones are released at the same moment
  let u = null;
  for (let i = 0; i < 8 && !u; i++) {
    const cur = i === 0 ? c : await db.contract(c.id);
    const rows = await db.update("contracts", `id=eq.${c.id}&released_cents=eq.${nz(cur.released_cents)}`, { released_cents: nz(cur.released_cents) + m.amount_cents, changes_open: false });
    u = rows && rows[0] || null;
  }
  if (!u) { await putNote(c.id, n => addNote(n, `counter update failed for milestone ${m.id}`)); throw new Error("could not record the release"); }
  u = await stepDone(u, stepHead(`milestone ${m.id}`));                               // this milestone's own note, if an earlier try stopped
  // the payout's line: checked like the payments' lines, never left out in silence
  if (!(await ledger(u, { kind: "release", milestone_id: m.id, amount_cents: m.amount_cents, provider_ref: transferId, note: ev }, `kind=eq.release&milestone_id=eq.${m.id}`)))
    await putNote(c.id, n => addNote(n, `${MS_LINE_NOTE}${m.id} (transfer ${transferId}; the hourly run adds it from Stripe's record; if this note stays, check by hand)`));
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
// When the refund does not go through (Stripe refuses it, its fee is not known yet, Stripe does not answer), the Order's
// note says so ("Needs a hand") and the hourly run tries again (retryLateRefunds) until the money is back on the card —
// Stripe itself stops sending the payment again after about 3 days. Once it is back, the note goes.
// The tries have an end. While the client's chargeback on the payment is open, Cuvori waits for the bank (Stripe refuses a
// refund then); when the bank gives the money back to the client, only what it did not give back (and was not refunded
// already) goes to the card, and the note says so. When Stripe allows no refund on the payment any more, the note says what
// the client is still owed, and nobody asks Stripe again every hour. And when you mark a refused refund's note as handled
// (schema v55), the tries stop. Marking the note as handled while Cuvori waits for the bank does not end the wait: what the
// client is owed once the bank has decided still goes back.
const LATE_DUE = "late_refund:";
const lateNote = (pi) => (n) => n.startsWith(`late payment ${pi} `);
const lateHead = (s) => `late payment ${s.payment_intent} (${(nz(s.amount_total) / 100).toFixed(2)} ${String(s.currency || "").toUpperCase()})`;
async function refundOrphan(s, why) {
  let out;
  try { out = await refundOrphanNow(s, why); }
  catch (e) {
    await lateRefundDue(s, why, e).catch(x => console.error("late payment not noted", s && s.payment_intent, x && x.message));
    throw e;
  }
  const quiet = (p) => p.catch(x => console.error("late payment note not saved", s && s.payment_intent, x && x.message));
  if (out.r === "chargeback_open") await quiet(lateWaiting(s, why, out.inquiry));
  else if (out.r === "charged_back") await quiet(lateChargedBack(s, why, out));
  else await lateRefundDone(s);
  return out.r;
}
async function lateRefundDue(s, why, e) {
  const pi = s.payment_intent;
  const reason = /card fee Stripe kept on it is not known/.test(String(e && e.message)) ? "Stripe's card fee on it is not known yet"
    : e && e.code === PAUSED ? (failNote(e, `refund of late payment ${pi}`), "payments are paused at the moment")       // the reason is in the log and the admin panel
    : failNote(e, `refund of late payment ${pi}`);
  await lateNoteAndRemind(s, why, `${lateHead(s)} was charged but has not gone back to the card yet: ${reason}. The hourly run tries again; if this note stays, check by hand`);
}
// The note on the Order (in the place of this payment's older one) and what the hourly run needs to try again (the payment,
// its page and its Order), kept until it is done. `noted`: the note is on the Order, so the note gone means you marked it
// as handled.
async function lateNoteAndRemind(s, why, text) {
  const pi = s.payment_intent;
  let noted = false;
  if (isUuid(s.client_reference_id) && (await db.contract(s.client_reference_id).catch(() => null))) {
    const row = await putNote(s.client_reference_id, n => addNote(n, text, lateNote(pi)));
    noted = !!row && hasNote(row.money_error, lateNote(pi));
  }
  await remindLate(s, why, { noted }, noted);
}
// While the bank decides (or, after an inquiry, while Stripe allows no refund), Cuvori waits and the hourly run looks again,
// also once you have marked the note as handled: the note is not what the hourly run goes by here. The note is written when
// the wait starts, not again every hour, so "Mark as handled" removes it for good.
async function lateWaiting(s, why, inquiry) {
  if (s.waiting) return;                                                          // the hourly run's own reminder: waiting already
  const text = inquiry ? `${lateHead(s)} was charged, and the client's bank has asked about it; Stripe allows no refund on it at the moment: Cuvori waits (the hourly run looks again)`
    : `${lateHead(s)} was charged, and the client has opened a chargeback on it: Cuvori waits for the bank's decision (the hourly run looks again)`;
  if (isUuid(s.client_reference_id) && (await db.contract(s.client_reference_id).catch(() => null))) await putNote(s.client_reference_id, n => addNote(n, text, lateNote(s.payment_intent)));
  await remindLate(s, why, { noted: false, waiting: true });
}
// The hourly run's reminder for a late payment. state "refund" (default): try the refund again; "watch": the bank decided
// for the client, and Cuvori looks once a day for 180 days whether the bank turns it into a win for Cuvori after all.
async function remindLate(s, why, extra, replace = true) {
  const pi = s.payment_intent;
  const key = JSON.stringify({ id: s.id, payment_intent: pi, client_reference_id: s.client_reference_id || null, amount_total: nz(s.amount_total), currency: s.currency || null, mode: STRIPE_MODE || null, why: String(why).slice(0, 200), state: "refund", ...extra });
  await db.insert("money_keys", { scope: LATE_DUE + pi, key }).catch(async (x) => {
    if (x.status !== 409) throw x;
    if (replace) await db.update("money_keys", `scope=eq.${q(LATE_DUE + pi)}`, { key });            // waiting already: kept, now with what changed
  });
}
async function lateRefundDone(s) {
  const pi = s.payment_intent;
  await db.remove("money_keys", `scope=eq.${q(LATE_DUE + pi)}`).catch(() => {});
  if (isUuid(s.client_reference_id)) { const c = await db.contract(s.client_reference_id).catch(() => null); if (c && hasNote(c.money_error, lateNote(pi))) await putNote(c.id, n => dropNote(n, lateNote(pi))); }
}
// The bank gave the money back to the client: what it did not give back has gone to the card, and there is nothing left to
// refund; the note says what happened, once. When Stripe allows no refund on the payment any more, the rest could not go to
// the card: the note says what the client is still owed, for you to sort out ("Mark as handled" then ends it).
// Cuvori keeps a quiet watch: banks sometimes turn a decision into a win for the business later (Stripe calls it a late
// win), and then the money goes back to the card too.
async function lateChargedBack(s, why, { bankTook, rest, stuck }) {
  const pi = s.payment_intent;
  const eur = (cents) => `${(nz(cents) / 100).toFixed(2)} ${String(s.currency || "").toUpperCase()}`;
  const c = isUuid(s.client_reference_id) ? await db.contract(s.client_reference_id).catch(() => null) : null;
  let first = false, noted = false;
  if (c) {
    first = await claimScope(`late_cb:${pi}`).catch(() => false);
    if (first) {
      const row = await putNote(c.id, n => addNote(n, `${lateHead(s)}: ${eur(bankTook)} went back to the client through their bank (they charged it back and the bank decided for them)${stuck > 0 ? `; the other ${eur(stuck)} could not go back to the card, because Stripe allows no refund on this payment any more, so the client is still owed ${eur(stuck)}: check by hand` : rest > 0 ? `; the other ${eur(rest)} went back to the card` : "; nothing is left to refund"}. Stripe's chargeback fee, if any, is in the Stripe dashboard`, lateNote(pi)));
      noted = !!row && hasNote(row.money_error, lateNote(pi));
    } else noted = hasNote(c.money_error, lateNote(pi));
  }
  if (stuck > 0 && c && !first && !noted) { await db.remove("money_keys", `scope=eq.${q(LATE_DUE + pi)}`).catch(() => {}); return; }   // marked as handled: yours from here
  const now = Date.now();
  await remindLate(s, why, { state: "watch", watch_until: new Date(now + 180 * 86400e3).toISOString(), checked_at: new Date(now).toISOString(), ...(stuck > 0 ? { stuck, noted } : {}) });
}
// The hourly run: late payments charged but not back on the card yet. A payment that has been recorded on an Order since
// is never refunded here (its note and its reminder just go), and nor is one whose note you marked as handled (a refused
// refund, or a rest Stripe allows no refund for; never a wait for the bank). An Order busy at that very minute (another
// payment step on it) is left for the next run, without waiting.
export async function retryLateRefunds() {
  const due = (await db.select("money_keys", `scope=like.${q(LATE_DUE)}*&select=scope,key&limit=20`)) || [];
  let done = 0; const failed = [];
  for (const row of due) {
    let s; try { s = JSON.parse(row.key); } catch { s = null; }
    if (!s || !isPi(s.payment_intent)) { failed.push({ id: row.scope, why: "late payment: unreadable reminder" }); continue; }
    if (s.mode && STRIPE_MODE && s.mode !== STRIPE_MODE) continue;                   // paid in the other mode: these keys cannot refund it (kept for when they can)
    const watch = s.state === "watch";
    if (watch && !(Date.parse(s.watch_until) > Date.now())) { await db.remove("money_keys", `scope=eq.${q(row.scope)}`).catch(() => {}); continue; }   // 180 days: the watch ends
    if (watch && Date.now() - Date.parse(s.checked_at) < 86400e3) continue;          // once a day
    const unlock = isUuid(s.client_reference_id) ? await lockOrder(s.client_reference_id, 0).catch(() => null) : () => {};
    if (!unlock) continue;                                                           // busy right now: the next run
    try {
      const c = isUuid(s.client_reference_id) ? await db.contract(s.client_reference_id) : null;
      if ((!watch || s.stuck > 0) && c && s.noted && !hasNote(c.money_error, lateNote(s.payment_intent))) { await db.remove("money_keys", `scope=eq.${q(row.scope)}`); continue; }   // marked as handled
      if (watch) {
        const cb = await chargebackOn(s.payment_intent);
        if (cb.state === "lost") { await db.update("money_keys", `scope=eq.${q(row.scope)}`, { key: JSON.stringify({ ...s, checked_at: new Date().toISOString() }) }); continue; }
        // the bank changed its decision: the refund goes ahead as usual (it is a reminder to refund again)
        await db.update("money_keys", `scope=eq.${q(row.scope)}`, { key: JSON.stringify({ ...s, state: "refund", noted: false, stuck: undefined }) });
      }
      if (await contractByPi(s.payment_intent)) { await lateRefundDone(s); continue; }          // on an Order after all: not a late payment
      const r = await refundOrphan(s, s.why || "late payment");
      if (r !== "chargeback_open") done++;
    } catch (e) { failed.push({ id: s.client_reference_id, why: `late payment ${s.payment_intent}: ${e && e.message}` }); console.error("late payment refund retry failed", s.payment_intent, e && e.message); }
    finally { await unlock(); }
  }
  return { done, failed };
}
// The newest chargeback on a payment: state "open" (the bank is deciding), "lost" (decided for the client; amount: what the
// bank took back), "inquiry" (the bank only asks about the payment), or null (none, or decided for Cuvori). refundable:
// Stripe's own yes/no on the chargeback (is_charge_refundable), whether the payment can still be refunded; null when Stripe
// does not say.
async function chargebackOn(pi) {
  const d = (((await stripe("GET", "/disputes", { payment_intent: pi, limit: 10 })).data) || [])[0];
  if (!d || !d.status) return { state: null, refundable: null };
  const refundable = typeof d.is_charge_refundable === "boolean" ? d.is_charge_refundable : null;
  if (d.status === "lost") return { state: "lost", amount: d.amount, refundable };
  if (d.status === "warning_needs_response" || d.status === "warning_under_review") return { state: "inquiry", refundable };
  return ["won", "warning_closed", "prevented"].includes(d.status) ? { state: null, refundable } : { state: "open", refundable };
}
// The bank asks about a late payment Cuvori already sent back except the card fee (the client may not recognise the smaller
// refund). Your decision: during an inquiry Cuvori refunds in full, so the card fee goes back too — Stripe says only a full
// refund ends an inquiry without a chargeback and its fee. Only for a payment Cuvori itself refunded as a late payment (its
// refund says so), never for another one; never twice (the refund's key is the amount refunded so far), and not when
// Stripe says the payment cannot be refunded. A payment whose refund has not gone through yet is the hourly run's: it
// refunds in full too (refundOrphanNow).
async function lateInquiry(o) {
  const pi = o.payment_intent;
  if (!isPi(pi)) return "ignored";
  const ours = (((await stripe("GET", "/refunds", { payment_intent: pi, limit: 100 })).data) || [])
    .find(r => r && r.metadata && r.metadata.kind === "late_payment" && r.status !== "failed" && r.status !== "canceled");
  if (!ours) return "ignored";
  if (o.is_charge_refundable === false) { console.error("inquiry on a late payment: Stripe allows no refund on it, so its card fee could not go back", pi, o.id); return "not_refundable"; }
  const p = await stripe("GET", `/payment_intents/${pi}`, { "expand[]": "latest_charge" });
  const ch = p && p.latest_charge && typeof p.latest_charge === "object" ? p.latest_charge : null;
  if (!ch || !Number.isInteger(ch.amount)) { const e = new Error(`inquiry on late payment ${pi}: its charge could not be read`); e.outcomeUnknown = true; throw e; }   // the webhook fails, Stripe sends it again
  const rest = ch.amount - nz(ch.amount_refunded);
  if (rest <= 0) return "already";
  const id = ours.metadata.contract_id;
  await moneyPost(`orphan:${pi}:${nz(ch.amount_refunded)}`, "/refunds", { payment_intent: pi, amount: rest, metadata: { contract_id: id || "", reason: "the client's bank asked about the late payment", kind: "late_payment" } });
  console.error("inquiry on a late payment: its card fee went back too, so the refund is full", pi, { refunded: rest });
  const c = isUuid(id) ? await db.contract(id).catch(() => null) : null;
  if (c && (await claimScope(`late_full:${pi}`).catch(() => false))) await orderEvent(c, "late_payment_refunded", { amount_cents: rest, card_fee_cents: 0, total_cents: ch.amount, full: true }, null);
  return "refunded";
}
async function refundOrphanNow(s, why) {
  const p = await stripe("GET", `/payment_intents/${s.payment_intent}`, { "expand[]": "latest_charge.balance_transaction" });
  const ch = p && p.latest_charge && typeof p.latest_charge === "object" ? p.latest_charge : null;
  const bt = ch && ch.balance_transaction && typeof ch.balance_transaction === "object" ? ch.balance_transaction : null;
  if (!ch || !Number.isInteger(ch.amount) || !bt || !Number.isInteger(bt.fee) || bt.fee < 0 || (bt.currency && String(bt.currency).toLowerCase() !== String(s.currency || ch.currency || "").toLowerCase())) {
    const e = new Error(`late payment ${s.payment_intent} not refunded yet: the card fee Stripe kept on it is not known (${why})`); e.outcomeUnknown = true; throw e;
  }
  const back = Math.max(ch.amount - bt.fee, 0), left = Math.max(back - nz(ch.amount_refunded), 0);   // what an earlier attempt refunded is not refunded twice
  console.error("refunding payment that cannot fund an order", s.id, why, { paid: ch.amount, card_fee: bt.fee, back });
  let give = 0, bankTook = 0, lost = false, stuck = 0;
  if (left > 0) {
    // A chargeback on the payment (Stripe's guide to disputes): while the bank decides, Stripe refuses a refund, so Cuvori
    // waits; once the bank gave the money back to the client, only what it did not give back, and what did not go back to
    // the card already, still goes to the card. An inquiry (the bank only asks about the payment) is answered by refunding
    // right away and in full, the card fee too: Stripe says only a full refund ends an inquiry without a chargeback and its
    // fee (your decision: Cuvori pays the card fee then, rather than risk the chargeback fee). Stripe's own yes/no on the
    // chargeback is asked too: when it says the payment cannot be refunded, Cuvori does not ask for a refund.
    for (let pass = 0; pass < 2; pass++) {
      const cb = ch.disputed === true || pass > 0 ? await chargebackOn(s.payment_intent) : { state: null };
      if (cb.state === "open") return { r: "chargeback_open" };
      if (cb.state === "inquiry" && cb.refundable === false) return { r: "chargeback_open", inquiry: true };
      lost = cb.state === "lost";
      bankTook = lost ? (Number.isInteger(cb.amount) && cb.amount > 0 ? Math.min(cb.amount, ch.amount) : ch.amount) : 0;
      // what is still owed: all but the card fee, less what already went back to the card (`left`) and the bank's part
      give = lost ? Math.max(left - bankTook, 0) : cb.state === "inquiry" ? Math.max(ch.amount - nz(ch.amount_refunded), 0) : left;   // an inquiry: all of it
      if (give <= 0) break;
      if (lost && cb.refundable === false) { stuck = give; give = 0; break; }      // Stripe allows no refund on it any more
      try {
        await moneyPost(`orphan:${s.payment_intent}:${nz(ch.amount_refunded)}`, "/refunds", { payment_intent: s.payment_intent, amount: give, metadata: { contract_id: s.client_reference_id || "", reason: why.slice(0, 200), kind: "late_payment" } });
        break;
      } catch (e) {
        const charged = ["charge_disputed", "refund_disputed_payment"].includes(stripeCode(e)) || /charged back|disputed/i.test(String(e && e.message));
        if (charged && pass === 0) { give = 0; continue; }                         // charged back a moment ago: what the bank decided, asked again
        if (charged && lost) { stuck = give; give = 0; break; }                    // Stripe refuses the rest after the bank's decision: not asked again every hour
        throw e;
      }
    }
  }
  if (stuck > 0) console.error("late payment: Stripe allows no refund of the rest after the chargeback; the client is still owed it", s.payment_intent, { still_owed: stuck });
  const c = isUuid(s.client_reference_id) ? await db.contract(s.client_reference_id).catch(() => null) : null;
  if (c && (give > 0 || (!lost && nz(ch.amount_refunded) === back)) && (await claimScope(`late:${s.payment_intent}`).catch(() => false)))
    await orderEvent(c, "late_payment_refunded", { amount_cents: give > 0 ? give : back, card_fee_cents: bt.fee, total_cents: ch.amount, ...(give > 0 && nz(ch.amount_refunded) + give >= ch.amount ? { full: true } : {}) }, null);   // full: all of it went back, the card fee too
  return lost ? { r: "charged_back", bankTook, rest: give, stuck } : { r: "refunded" };
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
  const amount = Number(md.amount_cents), fee = Number(md.fee_cents), connect = md.connect_cents != null ? Number(md.connect_cents) : 0;   // connect: Stripe's payout fees (v50)
  if (!Number.isInteger(amount) || amount <= 0 || !Number.isInteger(fee) || fee < 0 || !Number.isInteger(connect) || connect < 0 || s.amount_total !== amount + fee + connect) return "amounts do not match";
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
// A Stripe page Cuvori made carries its Order's id (and the same id in its metadata). Any other page — something else sold
// through the same Stripe account — is left alone: never charged, released or refunded here. A database that does not
// answer is an error (the webhook then fails and Stripe sends it again), never "not Cuvori's".
async function cuvoriPage(s) {
  const id = s && s.client_reference_id;
  if (!isUuid(id)) return false;
  if (s.metadata && s.metadata.contract_id === id) return true;
  return !!(await db.contract(id));
}
async function applyPaidSessionNow(s) {
  if (!s || (s.mode !== undefined && s.mode !== "payment")) return "ignored";
  if (!(await cuvoriPage(s))) return "ignored";
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
  // Stripe's payout fees (v50): their own line on the page, kept in their own field, never part of the card fee (so the
  // card-fee settlement never touches them). A page from before v50 has none (0).
  const connect = md.connect_cents != null ? Number(md.connect_cents) : 0;
  if (!Number.isInteger(connect) || connect < 0) return refundOrphan(s, `payout fee on the page is not a number: ${md.connect_cents}`);
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
  if (!amountOk || s.amount_total !== amount + fee + connect || String(s.currency).toLowerCase() !== String(c.currency || "EUR").toLowerCase() || c.payment_mode !== "escrow")
    return refundOrphan(s, `amount/currency mismatch ${s.amount_total} ${s.currency} vs ${expected}+${fee}+${connect}`);
  let charge = null;
  try { const pi = await stripe("GET", `/payment_intents/${s.payment_intent}`, { "expand[]": "latest_charge.balance_transaction" }); charge = pi.latest_charge; } catch (e) { console.error("pi fetch", e.message); }
  const bt = charge && charge.balance_transaction && typeof charge.balance_transaction === "object" ? charge.balance_transaction : null;
  let u;
  if (kind === "fund") {
    // the breakdown the client saw on this very page (its metadata, since v34 of the functions): saved only when it describes
    // this payment's amounts; a page from before, or a damaged value, leaves the Order's record as it is
    let quote;
    try { const qd = md.quote ? JSON.parse(md.quote) : null; if (qd && typeof qd === "object" && !Array.isArray(qd) && qd.price_cents === amount && qd.processing_cents === fee && (qd.connect_cents == null ? 0 : qd.connect_cents) === connect) quote = qd; } catch {}
    // recorded only while the Order still waits for it at this very price: the price can no longer change while this step
    // runs (schema v34 makes a change wait for it), and if it ever did, the payment is never recorded as paying a
    // different price (it would leave more paid in than the price, or less)
    try { u = ((await db.update("contracts", `id=eq.${id}&status=eq.accepted&amount_cents=eq.${amount}`, { status: "funded", funded_at: new Date().toISOString(), funded_cents: amount, stripe_payment_intent: s.payment_intent, stripe_checkout_id: s.id, stripe_charge_id: charge && charge.id || null, fee_cents: fee, connect_cents: connect, paid_mode: STRIPE_MODE, ...(quote ? { quote } : {}) })) || [])[0] || null; }
    catch (e) { if (MODE_REFUSED.test(String(e && e.message))) return refundOrphan(s, "test and live were switched while this payment came in"); throw e; }
    if (!u) {
      const now = await db.contract(id);
      if (now && now.stripe_payment_intent === s.payment_intent) return "already";   // concurrent duplicate delivery won the claim
      if (now && now.status === "accepted" && now.amount_cents !== amount) return refundOrphan(s, "the price changed while this payment came in");
      return refundOrphan(s, `order is ${now && now.status}`);                        // cancelled / already funded by another session
    }
  } else {
    // A top-up counts once. The same paid session is delivered twice at the same moment as a rule (Stripe's
    // webhook and the page's own check): the first to claim the payment records it, the other waits for that
    // record. Nothing here treats a payment as unwanted while the other delivery may be recording it.
    const ledgerRow = { order_id: id, provider: "stripe", status: "succeeded", kind: "fund", amount_cents: amount, fee_cents: fee, connect_cents: connect, provider_ref: s.payment_intent, charge_ref: charge && charge.id || null, provider_fee_cents: bt && Number.isInteger(bt.fee) ? bt.fee : null, note: kind };
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
        const mine = (n) => n.startsWith(`top-up ${s.payment_intent} `);           // this top-up's own note, never another one naming the payment
        if (hasNote(fresh.money_error, mine)) await putNote(id, n => dropNote(n, mine));
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
            e.outcomeUnknown = true; await putNote(id, n => addNote(n, `top-up ${s.payment_intent} may not be recorded — check by hand`)); throw e; });
        u = rows && rows[0] || null;
      }
    } catch (e) {
      if (e.modeRefused) { await dropKey(scope); return refundOrphan(s, "test and live were switched while this payment came in"); }
      if (!e.outcomeUnknown) await dropKey(scope); throw e;                              // nothing was changed: the next delivery starts over
    }
    if (!u) { await dropKey(scope); return refundOrphan(s, `top-up no longer applies (order is ${cur && cur.status})`); }   // the refund has its own key
    // the ledger line is the record other deliveries wait for: written right away, and a failure is not silent
    try { await db.insert("order_payments", ledgerRow); }
    catch (e) { console.error("ledger", e.message); await putNote(id, n => addNote(n, `top-up ${s.payment_intent} counted but its ledger line failed — check by hand`)); }
  }
  // the first payment's line: checked like a top-up's, never left out in silence (saveFirstLine)
  if (kind === "fund") await saveFirstLine(u, { order_id: id, provider: "stripe", status: "succeeded", kind: "fund", amount_cents: amount, fee_cents: fee, connect_cents: connect, provider_ref: s.payment_intent, charge_ref: charge && charge.id || null, provider_fee_cents: bt && Number.isInteger(bt.fee) ? bt.fee : null, note: kind });
  await orderEvent(u, kind === "fund" ? "funded" : "topped_up", { amount_cents: amount, fee_cents: fee, connect_cents: connect, total_cents: amount + fee + connect }, c.client);
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
  if (!initial) {
    // the bank only asks about a late payment Cuvori sent back except the card fee: the card fee goes back too (lateInquiry)
    if (o && (o.status === "warning_needs_response" || o.status === "warning_under_review")) { const r = await lateInquiry(o); if (r !== "ignored") return r; }
    // a chargeback on a payment with no Order on record (an Order removed with an account before schema v35 kept them, or
    // a payment made outside Cuvori): nothing here can answer it or pull money back, so the log says where to do it
    console.error("chargeback on a payment with no Order on record: answer it in Stripe's dashboard, under Disputes", "dispute", o && o.id, "payment", o && o.payment_intent, "amount", o && o.amount);
    return "ignored";
  }
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
      const text = ("chargeback: " + failNote(err, `pulling money back after chargeback ${disputeId}`)).slice(0, 300);
      await putNote(c.id, n => addNote(n, text, isCbMark));
      if (retryable(err)) throw err;
    } else if (pendingReversal(c)) await putNote(c.id, n => dropNote(n, p => p.startsWith("chargeback:")));
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
    const u = (await db.update("contracts", `id=eq.${c.id}&chargeback_id=eq.${q(o.id)}&chargeback_status=eq.open`, { chargeback_status: "won", money_error: addNote(c.money_error, "chargeback won; re-payment pending", isCbMark) }))[0];
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
    auto_release_at: null, refunded_cents: plan.after,
    // the pull-back's note goes; what Cuvori covered is said for the admin; any other note stays
    money_error: unrecovered > 0 ? addNote(keepOpen ? c.money_error : stepsOver(c.money_error), `chargeback lost; ${(unrecovered / 100).toFixed(2)} could not be pulled back from the freelancer — Cuvori covered it, check by hand`, isCbMark)
      : dropNote(keepOpen ? c.money_error : stepsOver(c.money_error), isCbMark),
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
  const repayMark = (n) => n.startsWith("chargeback won");
  if (back <= 0 || holdsFunds(c)) { if (pendingRepay(c)) await putNote(c.id, n => dropNote(n, repayMark)); return 0; }
  try {
    const t = await releaseToEditor(c, back, null, `retransfer_${c.chargeback_id}`);
    const v0 = (await db.update("contracts", `id=eq.${c.id}`, { released_cents: nz(c.released_cents) + back }))[0];
    const v = (await putNote(c.id, n => dropNote(n, repayMark))) || v0;                  // paid again: the re-payment's note goes, any other stays
    // the line is what says the re-payment was made (what is still owed is worked out from it): checked, never left out in silence
    if (!(await ledger(v || c, { kind: "release", amount_cents: back, provider_ref: t, note: "chargeback_won" }, `kind=eq.release&note=eq.chargeback_won&provider_ref=eq.${q(t)}`)))
      await putNote(c.id, n => addNote(n, `${REPAY_LINE_NOTE}${t} (${back} paid again after chargeback ${c.chargeback_id}; the hourly run adds it from Stripe's record; if this note stays, check by hand)`));
    return back;
  } catch (e) {
    console.error("re-pay after won chargeback", c.id, e.message);
    const text = ("chargeback won, re-payment failed: " + failNote(e, `paying again after chargeback ${c.chargeback_id}`)).slice(0, 300);
    await putNote(c.id, n => addNote(n, text, isCbMark));
    if (retryable(e)) throw e;                                             // no answer: the webhook fails and Stripe sends the event again
    return 0;                                                              // a plain no (account not ready, money settling): the hourly job tries again
  }
}
