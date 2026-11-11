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
// A chargeback is open on the Order: the one it records, or another one on one of its payments that came while the recorded
// one was still open and is noted on the Order until it is taken over (nextChargebackLocked). Nothing is paid out or
// refunded meanwhile. The note is the "chargeback <id> also …" one: OTHER_CB.
export const OTHER_CB = /^chargeback (\S+) also (?:open )?on payment /;
export const chargebackOpen = (c) => !!c && (c.chargeback_status === "open" || hasNote(c.money_error, n => OTHER_CB.test(n)));
// the bank's inquiry on one of the Order's payments is open (its note is on the Order, noteInquiry): no automatic release
export const inquiryOpen = (c) => !!c && hasNote(c.money_error, n => n.startsWith(INQUIRY_HEAD));
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
// Stripe allows a refund to the card for a limited time after the payment (about 180 days); after that it refuses it for good
// (owed: what of this refund has not gone back to the card; back: what of it went back to the card from a newer payment)
const refundGone = (c, owed, back = 0) => { const eur = (x) => `${(nz(x) / 100).toFixed(2)} ${String(c.currency || "EUR").toUpperCase()}`;
  return `Stripe can no longer refund this payment to the client's card (it is too old for a card refund): ${eur(owed)} is owed to the client${back > 0 ? ` (${eur(back)} of this refund went back to the card)` : ""}. Pay it to them another way (a bank transfer); the Order stays open until a person closes it`; };
const BANNED = "This freelancer cannot receive payments";
// a payout from money held apart whose earlier try Stripe has not confirmed yet (its answer was lost): nothing is paid until
// Stripe shows what that try did
const UNCONFIRMED = "Stripe has not confirmed an earlier try of this payout yet. Cuvori checks again every hour before paying anything; nothing needs to be done.";
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
// ---- funds segregation (Stripe's private preview "allocated funds") ----
// Off unless the setting STRIPE_FUNDS_SEGREGATION is "on": Stripe must first have given Cuvori's account the preview, and
// the owner must have approved it (SETUP.md Part 22). When on, a payment under the new prices is held at Stripe apart from
// Cuvori's own money, tied to its card payment: only a payout to the freelancer linked to that very payment, or a refund
// or chargeback of it, can take from it. Payments made before, payments at today's prices and Orders paid directly work
// exactly as before, and every other request keeps STRIPE_VERSION: only the requests about money held apart carry the
// preview version (Stripe's docs: "include the preview header ... in any API request relevant to the allocated funds").
export const FS_PREVIEW_VERSION = "2026-10-28.preview";
const fsPreview = () => { const v = String(process.env.STRIPE_PREVIEW_VERSION || ""); return /^20[0-9]{2}-[01][0-9]-[0-3][0-9]\.preview$/.test(v) ? v : FS_PREVIEW_VERSION; };
export const fsVersion = () => `${fsPreview()}; allocated_funds_preview=v1`;
export const segregationOn = () => process.env.STRIPE_FUNDS_SEGREGATION === "on";
// Where a payment asks to be held apart: on Stripe's payment page ("checkout", the default), or, should Stripe's page turn
// the parameter down, on the card hold just before Cuvori charges it ("capture"). Stripe's docs show neither; a test
// payment in the sandbox decides (SETUP.md Part 22).
export const fsWhere = () => (process.env.STRIPE_FS_WHERE === "capture" ? "capture" : "checkout");
// Stripe holds apart only payments by Visa, Mastercard, American Express and Discover cards. The page blocks the one card
// network Stripe lets it block that has others (Discover Global Network: Diners, JCB, UnionPay, Elo — and Discover with
// them); a payment that is still not held apart (another network) is recorded as it is and paid out the old way.
export const FS_BLOCKED = ["discover_global_network"];
const FS_BRANDS = new Set(["visa", "mastercard", "amex", "american_express", "discover"]);
export const fsBrandOk = (brand) => FS_BRANDS.has(String(brand || "").toLowerCase());
// Marks on what a Stripe call returns (symbols: never sent anywhere, never saved): REPLAYED when Stripe handed back its
// saved answer to an earlier request with the same key (its Idempotent-Replayed header), IDEM_KEY the key moneyPost used
export const REPLAYED = Symbol("stripe replayed"), IDEM_KEY = Symbol("idempotency key");
// the call itself, without the checks: only for the checks and through stripe()
async function stripeCall(method, path, body, opts = {}) {
  if (!/^\/[a-z_]+(\/[A-Za-z0-9_]+)*$/.test(path)) throw new Error("bad Stripe path");
  const headers = { Authorization: `Bearer ${STRIPE_KEY}`, "Stripe-Version": opts.preview ? fsVersion() : STRIPE_VERSION };   // preview: money held apart
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
export const stripeFingerprint = (path, body, preview = false) => crypto.createHash("sha256").update(`${preview ? fsVersion() : STRIPE_VERSION} POST ${path}\n${encode(body)}`).digest("hex").slice(0, 16);

// ---- Stripe's fee on a payment ----
// A payment's balance entry carries Stripe's fee only while the account is billed "inline". With standalone fees (what
// funds segregation switches the whole account to, and what Stripe uses for some accounts anyway) the entry shows 0 and
// the whole amount; the real fee comes later in a daily total, and per payment only in Stripe's Fees report, within 96
// hours. A card payment is never free, so 0 means "not known yet", never "Stripe took nothing": read as 0, the whole card
// fee went back to the client, Stripe's fee was recorded as 0 for good, and a late payment went back in full.
export const entryFee = (bt) => bt && typeof bt === "object" && Number.isInteger(bt.fee) && bt.fee > 0 ? bt.fee : null;
export const FEE_REPORT = "all_fees.incurred_at.itemized.2";     // Stripe's itemized Fees report, by when the fee was incurred
const FEE_DAY = 86400;
// "12.34", as the report writes amounts (major units) -> 1234; anything else -> null
const reportCents = (v) => { const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(v == null ? "" : v).trim()); if (!m) return null; const x = Number(m[2]) * 100 + Number((m[3] || "0").padEnd(2, "0")); return m[1] ? -x : x; };
// a CSV reader for the report: quoted fields, doubled quotes, commas and line breaks inside quotes
function csvRows(text) {
  const rows = []; let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += ch; continue; }
    if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.length > 1 || r[0] !== "");
}
// A report's file, only from Stripe's file address (the secret key goes with the request)
async function stripeFileText(url) {
  let u; try { u = new URL(String(url)); } catch { throw new Error("Stripe's Fees report has no file address"); }
  if (u.protocol !== "https:" || u.hostname !== "files.stripe.com" || u.search || !/^\/v1\/files\/file_[A-Za-z0-9]+\/contents$/.test(u.pathname))
    throw new Error("Stripe's Fees report points to a file address that is not Stripe's: not fetched");
  if (!STRIPE_KEY) throw fail("Payments are not configured. Please contact support.", 503, PAUSED);
  await checkStripeMode(); await checkStripePlatform();
  let r;
  try { r = await fetch(u.toString(), { headers: { Authorization: `Bearer ${STRIPE_KEY}`, "Stripe-Version": STRIPE_VERSION }, signal: AbortSignal.timeout(8000) }); }
  catch { const x = new Error("Could not reach the payment provider (its Fees report)"); x.network = true; throw x; }
  if (!r.ok) { const e = new Error(`Stripe's Fees report could not be read (HTTP ${r.status})`); e.status = r.status; throw e; }
  return await r.text();
}
// a finished report never changes: read once per function run. Per charge: its fee in cents (amount + tax, Stripe's own
// rule for a transaction's total fee) and the currency; a row written oddly marks the charge as unreadable
const feeFiles = new Map();
async function reportFees(run) {
  if (feeFiles.has(run.id)) return feeFiles.get(run.id);
  const rows = csvRows(await stripeFileText(run.result && run.result.url));
  const head = rows.shift() || [], col = (n) => head.indexOf(n);
  const [by, type, amount, tax, cur] = ["incurred_by", "incurred_by_type", "amount", "tax", "currency"].map(col);
  if (by < 0 || amount < 0) throw new Error("Stripe's Fees report has no incurred_by or amount column");
  const fees = new Map();
  for (const r of rows) {
    const id = r[by]; if (!isStripeId(id) || !/^(ch|py)_/.test(id)) continue;          // payouts, monthly fees: not a payment's
    if (type >= 0 && r[type] && r[type] !== "charge") continue;
    const a = reportCents(r[amount]), t = tax >= 0 && r[tax] !== "" ? reportCents(r[tax]) : 0, c = cur >= 0 ? String(r[cur] || "").toLowerCase() : "";
    const was = fees.get(id) || { cents: 0, currency: c, bad: false };
    if (a == null || t == null || (was.currency && c && was.currency !== c)) was.bad = true; else was.cents += a + t;
    if (!was.currency) was.currency = c;
    fees.set(id, was);
  }
  feeFiles.set(run.id, fees);
  return fees;
}
// Stripe's real fee on one card payment from the Fees report, or null while the report doesn't have it. The report is asked
// for only when its data reaches the payment, one request waiting at Stripe at a time; a finished one is read. Never asked
// in a payment's first day (its data comes within 96 hours), so a client's payment never waits on it.
// `once`: see feeReportType.
export async function reportedFee(charge, currency, once = null) {
  const id = charge && charge.id, created = charge && charge.created;
  if (!isStripeId(id) || !Number.isInteger(created) || Date.now() / 1000 - created < FEE_DAY) return null;
  // The report lists a fee by when Stripe took it: when the card was charged. A hold charged later (hold first, charge
  // after) is charged after the payment was created, and its balance entry has that time. A finished report that covers
  // the payment's creation but ends before the charge has no row for it, and a newer one was never asked for: the fee was
  // never found and the card-fee surplus never went back.
  const bt = charge.balance_transaction && typeof charge.balance_transaction === "object" ? charge.balance_transaction : null;
  const incurred = bt && Number.isInteger(bt.created) && bt.created > created ? bt.created : created;
  const state = await feeReportType(once), type = state.type;
  if (!type || !Number.isInteger(type.data_available_end) || incurred >= type.data_available_end) return null;
  const runs = await feeReportRuns(state);
  const covers = (r, t) => r.parameters && r.parameters.interval_start <= t && r.parameters.interval_end > t;
  const finished = runs.filter(r => r.status === "succeeded" && r.result);
  const done = finished.find(r => covers(r, incurred)) || finished.find(r => covers(r, created));
  if (done) {
    const f = (await reportFees(done)).get(id);
    if (f) return !f.bad && f.cents > 0 && (!f.currency || f.currency === String(currency || "EUR").toLowerCase()) ? f.cents : null;
    // no row: a report that reaches the time of the charge has none to give, so nothing is asked again; one that ends
    // before it can't have it, and a newer one is asked for below (still one waiting at a time)
    if (covers(done, incurred)) return null;
  }
  if (runs.some(r => r.status === "pending")) return null;
  // a month back, so the other payments waiting are in the same report
  const start = Math.max(Math.floor(created / FEE_DAY) * FEE_DAY - 30 * FEE_DAY, Number.isInteger(type.data_available_start) ? type.data_available_start : 0);
  const run = await stripe("POST", "/reporting/report_runs", { report_type: FEE_REPORT, parameters: { interval_start: start, interval_end: type.data_available_end, columns: ["incurred_by", "incurred_by_type", "amount", "tax", "currency"] } },
    { idempotency: `feereport:${start}:${type.data_available_end}` });
  // the run asked for waits at Stripe: the other payments of this run see it, and none asks for another
  runs.unshift(run && typeof run === "object" && run.report_type === FEE_REPORT ? run : { report_type: FEE_REPORT, status: "pending" });
  return null;
}
// What Stripe says about its Fees report (how far its data reaches, the runs asked for). `once`: an object the caller keeps
// for one run of its own (the hourly run's fees), so Stripe is asked once per run, not 3 times per payment: up to 70
// payments asked about every hour took longer than Netlify's 30 seconds (check of 2 November). Without it, asked afresh.
async function feeReportType(once) {
  if (once && once.feeReport) return once.feeReport;
  const state = { type: ((await stripe("GET", "/reporting/report_types", {})).data || []).find(t => t && t.id === FEE_REPORT) || null, runs: null };
  if (once) once.feeReport = state;
  return state;
}
async function feeReportRuns(state) {
  if (!state.runs) state.runs = ((await stripe("GET", "/reporting/report_runs", { limit: 100 })).data || []).filter(r => r && r.report_type === FEE_REPORT);
  return state.runs;
}

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
// The highest price plan this payment code knows (schema v56, pricing_engine): sent with every database request, so the
// database lets it move money on Orders at the new prices (plan 2). Code that does not send it is refused every money step
// on them; Orders at today's prices (plan 1, or no plan: from before v56) don't look at it.
export const PRICING_ENGINE = 2;
const PRICING_HEADER = { "x-cuvori-pricing": String(PRICING_ENGINE) };
async function sbFetch(path, init = {}) {
  requireServiceKey();
  const auth = SERVICE_KEY.startsWith("sb_secret_") ? {} : { Authorization: `Bearer ${SERVICE_KEY}` };
  let r, text;
  try {
    r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, { ...init, signal: AbortSignal.timeout(8000), headers: { apikey: SERVICE_KEY, ...auth, "content-type": "application/json", Prefer: init.prefer || "return=representation", ...(init.headers || {}), ...PRICING_HEADER } });
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
  // `also`: more conditions the part must meet at that moment (an automatic payout: its review period is over)
  claimMilestone: async (id, from, patch, also = "") => { if (!isUuid(id)) throw fail("Bad milestone id", 400, "milestone_changed"); const rows = await db.update("order_milestones", `id=eq.${id}&status=in.(${from.map(q).join(",")})${also ? "&" + also : ""}`, patch); return rows && rows[0] || null; },
};
// the Order behind a Stripe payment: the first payment is on the row, top-ups are in the ledger. A top-up the Order counted
// whose ledger line could not be saved is found by Stripe's record of it (countedTopupLine): a chargeback on it was taken for
// a payment with no Order, so nothing was frozen (review of 2 November). A late payment is never counted, so never found.
export async function contractByPi(pi) {
  if (!isPi(pi)) return null;
  const c = await db.one("contracts", `stripe_payment_intent=eq.${q(pi)}&select=*`);
  if (c) return c;
  const row = await db.one("order_payments", `provider_ref=eq.${q(pi)}&kind=eq.fund&select=order_id`);
  if (row) return db.contract(row.order_id);
  const t = await countedTopupLine(pi);
  return t ? t.c : null;
}

// Every answer of the sign-in check carries a code, so the page says it in the person's language (fnPlain in index.html),
// never this English sentence, which stays for the owner. Every Cuvori button that needs a sign-in uses this check.
const SIGNIN_DOWN = "signin_unavailable";
export async function userFromRequest(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") || "");
  if (!m) return null;
  requireServiceKey();
  let r;
  try { r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${m[1]}`, ...PRICING_HEADER }, signal: AbortSignal.timeout(8000) }); }
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

// Payments paused on purpose by the owner (SETUP.md Part 5, item 10): the setting stripe_payments_paused is true. It pauses
// new payments at either prices (the fee row's payer = platform pauses only Orders at today's prices, which ask the fee
// table: Orders at the new prices charge no fee). Only the owner sets it, in Supabase (the admin panel can't set stripe_
// settings). Payouts, refunds and a payment page opened before still go through. Asked fresh each time.
export async function paymentsPaused() {
  const row = await db.one("site_settings", "key=eq.stripe_payments_paused&select=value");
  return !!row && (row.value === true || row.value === "true");
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
// (true once the line is saved: a caller that writes it only once, behind a claim, gives the claim back when it is not)
export async function orderEvent(c, ev, data, actor) {
  if (!c) return false;
  return db.insert("order_events", { order_id: c.id, actor: actor || null, event: ev, data: data || {} }).then(() => true, e => { console.error("event", ev, e.message); return false; });
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
      charge_ref: ch.id || null, provider_fee_cents: entryFee(bt), note: "fund (line added from Stripe's record)",
      // under the new prices: its entry key, and Stripe's time of the payment (the commission report goes by the month)
      ...(isPlan2(c) ? { entry_key: entryKey("fund", pi), ...(stripeTime(ch.created) ? { created_at: stripeTime(ch.created) } : {}) } : {}) });
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
  // (the noted ones read in a fixed order; those still without their line are tried the one that failed least first: retryOrder)
  const notedAll = (await db.select("contracts", `money_error=like.${q(FIRST_LINE_NOTE)}*&select=*&order=id.asc&limit=${RETRY_READ}`)) || [];
  const all = [...new Map([...recent, ...notedAll].filter(c => isPi(c.stripe_payment_intent) && nz(c.funded_cents)).map(c => [c.id, c])).values()];
  if (!all.length) return { added: 0, failed: [] };
  const have = new Set();
  for (let i = 0; i < all.length; i += 100)
    for (const r of ((await db.select("order_payments", `kind=eq.fund&provider_ref=in.(${all.slice(i, i + 100).map(c => q(c.stripe_payment_intent)).join(",")})&select=provider_ref`)) || [])) have.add(r.provider_ref);
  const notedIds = new Set(notedAll.map(c => c.id)), lacking = all.filter(c => !have.has(c.stripe_payment_intent));
  const tries = await retryOrder("firstline", lacking.filter(c => notedIds.has(c.id)), { whole: notedAll.length < RETRY_READ });
  const isNoted = new Set(tries.list.map(c => c.id));
  const todo = [...lacking.filter(c => !notedIds.has(c.id)), ...tries.list];
  let added = 0; const failed = [];
  for (const c of todo) {
    try {
      const row = await repairFirstLine(c);
      if (!row) { if (hasNote(c.money_error, n => n.startsWith(FIRST_LINE_NOTE))) { failed.push({ id: c.id, why: "first payment line still missing" }); if (isNoted.has(c.id)) await tries.failed(c.id); } continue; }
      added++;
      if (isNoted.has(c.id)) await tries.ok(c.id);
      await settleFee(c, row).catch(e => console.error("fee settle", c.id, e.message));
    } catch (e) { failed.push({ id: c.id, why: "first payment line: " + e.message }); console.error("first payment line failed for", c.id, e.message); if (isNoted.has(c.id)) await tries.failed(c.id); }
  }
  return { added, failed };
}

// ---- a top-up's ledger line ----
// A top-up is counted on its Order and its line is written right after. When that line could not be saved, the Order's note
// said so and nothing ever added it under today's prices: the top-up's card-fee surplus never went back, and a chargeback on
// it was not recognised as Cuvori's, so nothing was frozen and a payout could send out money the bank had taken (review of
// 2 November). The line is added from Stripe's record of the payment and of the page it was paid on, only when both match the
// Order and the Order counted the payment: the payment succeeded and was made on this Order's page as a top-up, in its
// currency; the Order took the payment's claim when it counted it (a late payment's claim is let go); nothing says it is a
// late payment (one waiting to go back, or one Cuvori sent back); and the Order counts at least this much more than its lines
// show (the first payment's line there, so the difference is the top-ups'). Anything else: no line, and the note stays.
export const TOPUP_LINE_FAILED = "counted but its ledger line failed";
const topupNote = (pi) => (n) => n.startsWith(`top-up ${pi} `);
// the page a payment was made on (Stripe lists a Checkout page by its payment): its amounts say what of the payment is the
// price and what the card fee and the payout fee
async function pageOfPayment(pi) {
  const r = await stripe("GET", "/checkout/sessions", { payment_intent: pi, limit: 1 });
  return ((r && r.data) || []).find(s => s && s.payment_intent === pi) || null;
}
// What of the Order's paid-in total beyond its lines belongs to OTHER top-ups the Order counted whose lines are missing: their
// history line ("topped_up", naming the payment) or their note ("counted but its ledger line failed") says they were
// counted. That much of the gap is theirs, never this payment's (check of 8 November: a price increase whose count was
// refused once was taken, when Stripe sent it again, for counted already, because an earlier increase's line was missing:
// the Order counted 150.00 of 180.00 paid in; and a second page for an increase was charged as well).
async function othersCountedUnlined(c, pi, rows) {
  const lined = new Set(rows.map(r => payTag(r.provider_ref)));
  const evs = (await db.select("order_events", `order_id=eq.${c.id}&event=eq.topped_up&select=data`)) || [];
  const me = payTag(pi), counted = new Map();
  for (const e of evs) {
    const d = (e && e.data) || {}, tag = typeof d.payment === "string" ? d.payment : isPi(d.payment_intent) ? payTag(d.payment_intent) : null;
    if (tag && tag !== me && !lined.has(tag) && Number.isSafeInteger(d.amount_cents) && d.amount_cents > 0) counted.set(tag, d.amount_cents);
  }
  for (const n of String(c.money_error || "").split(" · Also: ")) {
    const m = new RegExp(`^top-up (pi_[A-Za-z0-9]+) ${TOPUP_LINE_FAILED}`).exec(n);
    if (!m || m[1] === pi || lined.has(payTag(m[1])) || counted.has(payTag(m[1]))) continue;
    const page = await pageOfPayment(m[1]).catch(() => null), amount = Number(page && page.metadata && page.metadata.amount_cents);
    if (Number.isSafeInteger(amount) && amount > 0) counted.set(payTag(m[1]), amount);
  }
  return [...counted.values()].reduce((a, x) => a + x, 0);
}
// The missing line of a counted top-up, from Stripe's record: { c, line }, { c, existing } when the line is there already,
// or null. c: the Order when known (otherwise the one the payment's own record names). minAgeMs: how long ago the Order
// must have claimed the payment (the hourly run waits until its own save is long over).
async function countedTopupLine(pi, c = null, minAgeMs = 0) {
  if (!isPi(pi)) return null;
  // the database first: a payment never claimed for counting, or a late payment waiting to go back, is no Order's
  const claim = await db.one("money_keys", `scope=eq.${q("apply:" + pi)}&select=scope,created_at`);
  if (!claim || (minAgeMs && !(Date.now() - Date.parse(claim.created_at || "") >= minAgeMs))) return null;
  if (await db.one("money_keys", `scope=eq.${q(LATE_DUE + pi)}&select=scope`)) return null;
  const p = await stripe("GET", `/payment_intents/${pi}`, { "expand[]": "latest_charge.balance_transaction" }).catch(e => { if (e && e.status === 404) return null; throw e; });
  const md = (p && p.metadata) || {};
  if (!p || p.status !== "succeeded" || md.kind !== "topup" || !isUuid(md.contract_id) || (c && md.contract_id !== c.id)) return null;
  c = c || await db.contract(md.contract_id);
  if (!c || c.payment_mode !== "escrow" || c.stripe_payment_intent === pi || (c.paid_mode && c.paid_mode !== STRIPE_MODE)) return null;
  const rows = await savedFundRows(c);
  const existing = rows.find(r => r.provider_ref === pi);
  if (existing) return { c, existing };
  const ch = p.latest_charge && typeof p.latest_charge === "object" ? p.latest_charge : null;
  if (!ch || !isStripeId(ch.id) || String(ch.currency || "").toLowerCase() !== String(c.currency || "EUR").toLowerCase()) return null;
  // sent back by Cuvori as a late payment: never the Order's
  if ((((await stripe("GET", "/refunds", { payment_intent: pi, limit: 100 })).data) || []).some(r => r && r.metadata && r.metadata.kind === "late_payment")) return null;
  const s = await pageOfPayment(pi), sm = (s && s.metadata) || {};
  const amount = Number(sm.amount_cents), fee = Number(sm.fee_cents), connect = sm.connect_cents != null ? Number(sm.connect_cents) : 0;
  if (!s || s.client_reference_id !== c.id || (sm.contract_id && sm.contract_id !== c.id) || sm.kind !== "topup" || !Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(fee) || fee < 0
      || !Number.isSafeInteger(connect) || connect < 0 || s.amount_total !== amount + fee + connect || (Number.isInteger(p.amount_received) && p.amount_received !== s.amount_total)
      || (isPlan2(c) && fee + connect > 0)) return null;
  if (isPi(c.stripe_payment_intent) && !rows.some(r => r.provider_ref === c.stripe_payment_intent)) return null;   // the first payment's line first (repairFirstLines)
  if (nz(c.funded_cents) - rows.reduce((a, r) => a + r.amount_cents, 0) - await othersCountedUnlined(c, pi, rows) < amount) return null;   // not counted on the Order
  const bt = ch.balance_transaction && typeof ch.balance_transaction === "object" ? ch.balance_transaction : null;
  const line = { kind: "fund", amount_cents: amount, fee_cents: fee, connect_cents: connect, provider_ref: pi, charge_ref: ch.id, provider_fee_cents: entryFee(bt), note: "topup (line added from Stripe's record)",
    ...(isPlan2(c) ? { entry_key: entryKey("fund", pi), ...(stripeTime(ch.created) ? { created_at: stripeTime(ch.created) } : {}) } : {}) };
  return { c, line };
}
// Adds a counted top-up's missing line (under the Order's lock), and this top-up's own note goes. The line, or null.
async function addTopupLine(c, pi, minAgeMs = 0) {
  const t = await countedTopupLine(pi, c, minAgeMs);
  if (!t) return null;
  if (!t.existing && !(await ledger(c, t.line, `kind=eq.fund&provider_ref=eq.${q(pi)}`))) return null;
  if (!t.existing) console.error("top-up line added from Stripe's record", c.id, pi, t.line.amount_cents);
  const now = await db.contract(c.id).catch(() => null);
  if (now && hasNote(now.money_error, topupNote(pi))) await putNote(c.id, n => dropNote(n, topupNote(pi)));
  return t.existing || await fundRowOf(c, pi);
}
// The hourly run, today's prices (the new prices' lines are repairPlan2Lines'): Orders paid in the last 30 days whose total
// counts more than their lines show, and any Order whose note says a top-up's line failed. The card-fee surplus of a line
// added here goes back to the card right away.
export async function repairTopupLines() {
  const since = q(new Date(Date.now() - 30 * 86400e3).toISOString());
  const recent = (await db.select("contracts", `payment_mode=eq.escrow&funded_at=gt.${since}&select=*&order=funded_at.desc&limit=100`)) || [];
  // (the noted Orders read in a fixed order, the one that failed least first: retryOrder, like the other lists)
  const notedAll = ((await db.select("contracts", `payment_mode=eq.escrow&money_error=like.${q("*" + TOPUP_LINE_FAILED + "*")}&select=*&order=id.asc&limit=${RETRY_READ}`)) || []).filter(c => !isPlan2(c));
  const tries = await retryOrder("topupline", notedAll, { whole: notedAll.length < RETRY_READ });
  const notedIds = new Set(tries.list.map(c => c.id));
  const todo = [...new Map([...recent, ...tries.list].filter(c => !isPlan2(c) && nz(c.funded_cents)).map(c => [c.id, c])).values()];
  let added = 0; const failed = [];
  if (!todo.length) return { added, failed };
  const lines = [];
  for (let i = 0; i < todo.length; i += 100)
    lines.push(...((await db.select("order_payments", `order_id=in.(${todo.slice(i, i + 100).map(c => c.id).join(",")})&kind=eq.fund&status=eq.succeeded&select=order_id,amount_cents,provider_ref`)) || []));
  const NAMED = new RegExp(`^top-up (pi_[A-Za-z0-9_]+) ${TOPUP_LINE_FAILED}`);
  for (const c0 of todo) {
    const rows = lines.filter(l => l.order_id === c0.id);
    const named = notesOf(c0.money_error).map(n => (NAMED.exec(n) || [])[1]).filter(isPi);
    const behind = nz(c0.funded_cents) > rows.reduce((a, r) => a + r.amount_cents, 0);
    if (!behind && !named.length) continue;
    if (isPi(c0.stripe_payment_intent) && !rows.some(r => r.provider_ref === c0.stripe_payment_intent)) continue;   // the first payment's line first (repairFirstLines)
    if (c0.paid_mode && c0.paid_mode !== STRIPE_MODE) continue;                       // paid in the other mode: these keys cannot see it
    const unlock = await lockOrder(c0.id, 0).catch(() => null);
    if (!unlock) continue;                                                             // busy right now: the next run
    try {
      const c = (await db.contract(c0.id)) || c0;
      const charges = behind ? (((await stripe("GET", "/charges", { transfer_group: `contract_${c.id}`, limit: 100 })).data) || [])
        .filter(ch => ch && ch.captured !== false && isPi(ch.payment_intent) && ch.payment_intent !== c.stripe_payment_intent).sort(byCreated).map(ch => ch.payment_intent) : [];
      for (const pi of [...new Set([...named, ...charges])]) {
        const had = rows.some(r => r.provider_ref === pi);
        const row = await addTopupLine(c, pi, FIRST_LINE_WAIT_MS);
        if (!row || had) continue;
        added++; rows.push(row);
        await settleFee(c, row).catch(e => console.error("fee settle", c.id, e.message));
      }
      const now = await db.contract(c.id);
      const still = !!now && notesOf(now.money_error).some(n => NAMED.test(n));
      if (still) failed.push({ id: c.id, why: "top-up line still missing" });
      if (notedIds.has(c.id)) await (still ? tries.failed(c.id) : tries.ok(c.id));
    } catch (e) { failed.push({ id: c0.id, why: "top-up line: " + e.message }); console.error("top-up line failed for", c0.id, e.message); if (notedIds.has(c0.id)) await tries.failed(c0.id); }
    finally { await unlock(); }
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
  // (the noted Orders read in a fixed order, the one that failed least first: retryOrder)
  const notedAll = (await db.select("contracts", `money_error=like.${q(MS_LINE_NOTE)}*&select=id&order=id.asc&limit=${RETRY_READ}`)) || [];
  const msTries = await retryOrder("msline", notedAll, { whole: notedAll.length < RETRY_READ });
  const noted = msTries.list;
  const ofNoted = noted.length ? ((await db.select("order_milestones", `status=eq.released&order_id=in.(${noted.map(c => c.id).join(",")})&select=*`)) || []) : [];
  const ms = [...new Map([...recent, ...ofNoted].filter(m => isStripeId(m.transfer_ref)).map(m => [m.id, m])).values()];
  // (a milestone paid in parts, from money held apart, has one line per part: it has its lines once they add up to it)
  const msRows = ms.length ? ((await db.select("order_payments", `kind=eq.release&milestone_id=in.(${ms.map(m => m.id).join(",")})&select=milestone_id,amount_cents`)) || []) : [];
  const have = new Set(ms.filter(m => msRows.filter(r => r.milestone_id === m.id).reduce((a, r) => a + nz(r.amount_cents), 0) >= m.amount_cents).map(m => m.id));
  const byOrder = new Map();
  for (const m of ms.filter(m => !have.has(m.id))) byOrder.set(m.order_id, [...(byOrder.get(m.order_id) || []), m]);
  // (a noted Order whose note is still there after its try counts as failing)
  const stillNoted = async (id, which) => { const x = await db.contract(id).catch(() => null); return !!x && hasNote(x.money_error, n => n.startsWith(which)); };
  const notedIds = new Set(noted.map(c => c.id)), notedIn = new Set(notedAll.map(c => c.id));
  for (const id of new Set([...byOrder.keys(), ...noted.map(c => c.id)])) {
    if (notedIn.has(id) && !notedIds.has(id)) continue;                                // failed for a day already: its next try is later
    try { added += await repairMilestoneLines(id, byOrder.get(id) || []); if (notedIds.has(id)) await ((await stillNoted(id, MS_LINE_NOTE)) ? msTries.failed(id) : msTries.ok(id)); }
    catch (e) { failed.push({ id, why: "milestone payout line: " + e.message }); console.error("milestone payout line failed for", id, e.message); if (notedIds.has(id)) await msTries.failed(id); }
  }
  // re-payments after a won chargeback
  const repayAll = (await db.select("contracts", `money_error=like.${q(REPAY_LINE_NOTE)}*&select=id&order=id.asc&limit=${RETRY_READ}`)) || [];
  const repTries = await retryOrder("repayline", repayAll, { whole: repayAll.length < RETRY_READ });
  for (const { id } of repTries.list) {
    try { added += await repairRepayLine(id); await ((await stillNoted(id, REPAY_LINE_NOTE)) ? repTries.failed(id) : repTries.ok(id)); }
    catch (e) { failed.push({ id, why: "re-payment line: " + e.message }); console.error("re-payment line failed for", id, e.message); await repTries.failed(id); }
  }
  return { added, failed };
}
async function repairMilestoneLines(id, missing) {
  const unlock = await lockOrder(id);
  try {
    const c = await db.contract(id);
    if (!c || (c.paid_mode && c.paid_mode !== STRIPE_MODE)) return 0;                // paid in the other mode: these keys cannot see it
    const lines = () => db.select("order_payments", `order_id=eq.${id}&kind=eq.release&select=milestone_id,amount_cents,provider_ref`).then(r => r || []);
    const had = await lines();
    const linedFor = (rows, m) => rows.filter(l => l.milestone_id === m.id).reduce((a, l) => a + nz(l.amount_cents), 0) >= m.amount_cents;
    // only once the payout is 2 minutes old: its own save is long over by then
    const todo = missing.filter(m => !linedFor(had, m) && Date.now() - Date.parse(m.released_at || "") >= FIRST_LINE_WAIT_MS);
    let added = 0;
    if (todo.length) {
      const ts = await transfersOf(c);
      // what the ledger shows paid out (payouts less pull-backs), against the Order's counter
      const outInLines = async () => ((await db.select("order_payments", `order_id=eq.${id}&status=eq.succeeded&kind=in.(release,reversal)&select=kind,amount_cents`)) || [])
        .reduce((a, r) => a + (r.kind === "release" ? r.amount_cents : -r.amount_cents), 0);
      for (const m of todo) {
        // paid in parts (money held apart): every part of the milestone's payout at Stripe, together exactly the milestone,
        // gets its line; the counter is raised by the parts it does not include yet
        const parts = isPlan2(c) ? ts.filter(x => !x.reversed && isPart(x) && (x.metadata.milestone_id || "") === m.id && (x.metadata.purpose || "release") === "release") : [];
        if (parts.length) {
          if (partOf(parts[0]).total !== m.amount_cents || parts.reduce((a, x) => a + grossOf(x), 0) !== m.amount_cents) { console.error("milestone payout line not added", id, m.id, "the parts at Stripe do not add up to the milestone"); continue; }
          const lack = parts.filter(x => !had.some(l => l.provider_ref === x.id)), lackCents = lack.reduce((a, x) => a + grossOf(x), 0);
          const cur = await db.contract(id);
          if (!cur) break;
          if (nz(cur.released_cents) - (await outInLines()) < lackCents) {
            const sameCounter = cur.released_cents == null ? "released_cents=is.null" : `released_cents=eq.${cur.released_cents}`;
            const upd = await db.update("contracts", `id=eq.${id}&${sameCounter}`, { released_cents: nz(cur.released_cents) + lackCents });
            if (!upd || !upd[0]) throw new Error("the Order changed while a milestone payout was counted");
            console.error("milestone payout counted from Stripe's record", id, m.id, lackCents);
          }
          for (const x of lack) if (await ledger((await db.contract(id)) || c, { ...payoutLine(x, { late: true, note: "milestone payout (line added from Stripe's record)" }), milestone_id: m.id }, byKey("release", x.id))) added++;
          continue;
        }
        const t = ts.find(x => x.id === m.transfer_ref);
        // (under the new prices the transfer sends 95%: its full amount is the milestone's)
        if (!t || (isPlan2(c) ? grossOf(t) : t.amount) !== m.amount_cents || (t.metadata.milestone_id || "") !== m.id) { console.error("milestone payout line not added", id, m.id, "the transfer at Stripe does not match the milestone"); continue; }
        // The counter may not include the payout either (its update failed after Stripe paid it). It is raised first, so
        // the Order never holds more than it has: adding only the line hid the payout from settlement's own check, and a
        // later decision paid the milestone a second time (check of 1 November). It is raised only when the counter is not
        // already ahead of the ledger by this payout (the counter was saved, only the line was lost).
        const cur = await db.contract(id);
        if (!cur) break;
        if (nz(cur.released_cents) - (await outInLines()) < m.amount_cents) {
          const sameCounter = cur.released_cents == null ? "released_cents=is.null" : `released_cents=eq.${cur.released_cents}`;
          const upd = await db.update("contracts", `id=eq.${id}&${sameCounter}`, { released_cents: nz(cur.released_cents) + m.amount_cents });
          if (!upd || !upd[0]) throw new Error("the Order changed while a milestone payout was counted");
          console.error("milestone payout counted from Stripe's record", id, m.id, m.amount_cents);
        }
        const line = isPlan2(c) ? { ...payoutLine(t, { late: true, note: "milestone payout (line added from Stripe's record)" }), milestone_id: m.id }
          : { kind: "release", milestone_id: m.id, amount_cents: m.amount_cents, provider_ref: t.id, note: "milestone payout (line added from Stripe's record)" };
        if (await ledger((await db.contract(id)) || c, line, isPlan2(c) ? byKey("release", t.id) : `kind=eq.release&milestone_id=eq.${m.id}`)) added++;
      }
    }
    // the note goes once every paid-out milestone of the Order has its line
    const msLine = (n) => n.startsWith(MS_LINE_NOTE);
    if (hasNote(c.money_error, msLine)) {
      const out = (await db.select("order_milestones", `order_id=eq.${id}&status=eq.released&select=id,amount_cents`)) || [], now = await lines();
      if (out.every(m => linedFor(now, m))) await putNote(id, n => dropNote(n, msLine));
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
    const all = (await transfersOf(c)).filter(x => !x.reversed && x.metadata.purpose === `retransfer_${c.chargeback_id}`);
    // (a re-payment from money held apart is made of parts: each gets its line)
    const ts = all.some(isPart) ? all.filter(isPart) : all.slice(0, 1);
    if (!ts.length) { console.error("re-payment line not added", id, "no re-payment at Stripe"); return 0; }
    let ok = true, added = 0;
    for (const t of ts) {
      // earlier re-payments are found in either form: "chargeback_won" (today's prices) and "chargeback_won <dispute id>"
      // (the new prices, which name the chargeback)
      const same = isPlan2(c) ? byKey("release", t.id) : `kind=eq.release&note=like.chargeback_won*&provider_ref=eq.${q(t.id)}`;
      const there = await db.one("order_payments", `order_id=eq.${id}&${same}&select=id`);
      const one = there || await ledger(c, isPlan2(c) ? payoutLine(t, { late: true }) : { kind: "release", amount_cents: t.amount, provider_ref: t.id, note: "chargeback_won" }, same);
      if (one && !there) added++;
      ok = ok && !!one;
    }
    if (ok) await putNote(id, n => dropNote(n, repayLine));
    return added;
  } finally { await unlock(); }
}

// ---- the new prices: every ledger line from Stripe's record (the hourly run) ----
// A plan 2 Order whose totals count more money than its lines show had a line not written (its save failed after the money
// moved and the total was raised; or a pull-back's line was written and the total not lowered). The hourly run writes it from
// Stripe's record, so the ledger check's line_missing clears by itself: the first payment and top-ups, payouts and
// re-payments (release_late, with the 5% from the transfer and Stripe's time of it), pull-backs, refunds, and a lost
// chargeback's line. Only what the Order's totals already count is written: money a step moved but did not count yet is that
// step's to count when it is tried again (it finds its transfer or refund at Stripe and never moves it twice).
const RECENT_PLAN2_DAYS = 90;
export async function repairPlan2Lines() {
  const since = q(new Date(Date.now() - RECENT_PLAN2_DAYS * 86400e3).toISOString());
  const recent = (await db.select("contracts", `pricing_version=gte.2&payment_mode=eq.escrow&funded_at=gt.${since}&select=*&order=funded_at.desc&limit=300`)) || [];
  if (!recent.length) return { added: 0, failed: [] };
  const lines = [];
  for (let i = 0; i < recent.length; i += 100)
    lines.push(...((await db.select("order_payments", `order_id=in.(${recent.slice(i, i + 100).map(c => c.id).join(",")})&status=eq.succeeded&select=order_id,kind,amount_cents,note,provider_ref`)) || []));
  let added = 0; const failed = [];
  for (const c of recent) {
    if (!isPlan2(c)) continue;
    const rows = lines.filter(l => l.order_id === c.id);
    const behind = nz(c.funded_cents) > sumKind(rows, "fund") || nz(c.released_cents) > sumKind(rows, "release") - sumKind(rows, "reversal")
      || nz(c.refunded_cents) > rows.filter(r => r.kind === "refund" || r.kind === "chargeback").reduce((a, r) => a + countedOf(r), 0) - failedBackOf(rows)
      || (c.chargeback_status === "lost" && isStripeId(c.chargeback_id) && !hasLine(rows, "chargeback", c.chargeback_id));
    // an Order in parts whose last part was paid out, but whose closing write was lost, or that holds nothing for its other
    // parts any more: closed below once every payout is in the books
    const allOut = c.has_milestones && ["funded", "delivered"].includes(c.status) && heldCents(c) === 0;
    if (!behind && !allOut) continue;
    const unlock = await lockOrder(c.id, 0).catch(() => null);
    if (!unlock) continue;                                                             // busy right now: the next run
    try { if (behind) added += await repairPlan2Order(c.id); await closeIfNothingLeft(c.id, null, { books: true }); }
    catch (e) { failed.push({ id: c.id, why: "ledger lines: " + e.message }); console.error("ledger lines from Stripe's record failed for", c.id, e.message); }
    finally { await unlock(); }
  }
  return { added, failed };
}
// An Order in parts closes once nothing more can be paid out of it: every part is paid out, or it holds nothing any more for
// the parts left (a chargeback the bank decided for the client took that money back while the Order went on, so those parts
// can never be paid: check of 2 November), and nobody is owed anything on it (no price increase to pay in, no chargeback
// open, no re-payment owed to the freelancer). Closed as the last part's payout closes it: completed when anything was paid
// out, else refunded. The parts not paid out stay as they are, never paid (what they were for went back to the client's
// bank); their review clock goes, and the history line names them. Called under the Order's lock by the milestone payout
// itself and by the hourly run (books: only once every payout of the Order is in the books, and nothing is held or owed).
// A part whose payout is at Stripe but not counted on the Order yet keeps it open: its own payout counts it first.
async function closeIfNothingLeft(id, actor, { books = false } = {}) {
  const c = await db.contract(id);
  if (!c || c.payment_mode !== "escrow" || (books && !c.has_milestones) || !["funded", "delivered"].includes(c.status)) return null;
  const open = (await db.select("order_milestones", `order_id=eq.${id}&status=neq.released&select=id`)) || [];
  if ((open.length || books) && (heldCents(c) !== 0 || owedCents(c) >= MIN_TOPUP_CENTS || chargebackOpen(c) || pendingRepay(c))) return null;
  if (books) {
    const rows = await linesOf(c);
    if (nz(c.released_cents) !== sumKind(rows, "release") - sumKind(rows, "reversal")) return null;
  }
  if (open.length) {
    const ids = new Set(open.map(m => m.id));
    if ((await transfersOf(c)).some(t => !t.reversed && ids.has(t.metadata.milestone_id || ""))) { console.error("an Order holds nothing, but a part's payout at Stripe is not counted yet: left open", id); return null; }
  }
  const now = new Date().toISOString();
  // (every part paid out: as it always was; parts left: only while the money on the Order is what was just read. The parts'
  // money went to the client's bank, so the close names the chargeback as its resolution, like a lost one that takes all;
  // and the notes of money steps that stopped go, as at every other close: nothing on this Order can move any more)
  const paid = !open.length || nz(c.released_cents) > 0;
  const closing = open.length && c.chargeback_status === "lost" ? { resolution: "chargeback", resolved_at: now, money_error: closedNote(c.money_error) } : open.length ? { money_error: closedNote(c.money_error) } : {};
  const done = !open.length ? await db.claim(id, ["funded", "delivered"], { status: "completed", completed_at: now, closed_at: now, auto_release_at: null })
    : ((await db.update("contracts", `id=eq.${id}&status=in.(funded,delivered)&${moneyUnchanged(c)}&${eqOrNull("released_cents", c.released_cents)}&${eqOrNull("refunded_cents", c.refunded_cents)}&${noteStill(c)}`,
        { status: paid ? "completed" : "refunded", completed_at: paid ? now : null, closed_at: now, auto_release_at: null, ...closing })) || [])[0] || null;
  if (!done) return null;
  if (open.length) {
    await db.update("order_milestones", `order_id=eq.${id}&status=in.(pending,submitted)`, { auto_release_at: null }).catch(e => console.error("parts' review clocks", id, e.message));
    console.error("an Order in parts that holds nothing for its other parts any more is closed", id, done.status, open.map(m => m.id));
  } else if (books) console.error("an Order whose parts were all paid out is completed", id);
  await orderEvent(done, paid ? "completed" : "refunded", open.length ? { unpaid_parts: open.map(m => m.id), note: "nothing is held for these parts any more: the money for them went back to the client" } : {}, actor);
  if (paid) await contractEvent(done, "complete", actor || c.client);
  return done;
}
// The hourly run: every Order in parts still open that holds nothing (both price plans) is closed as above, under its lock
// (an Order busy at that moment waits for the next run). Before, only plan 2 Orders whose every part was paid out were.
export async function closeEmptyOrders() {
  const rows = (await db.select("contracts", `payment_mode=eq.escrow&has_milestones=eq.true&status=in.(funded,delivered)&select=id,status,payment_mode,has_milestones,amount_cents,funded_cents,released_cents,refunded_cents,chargeback_status,money_error,paid_mode&order=id.asc&limit=2000`)) || [];
  let closed = 0; const failed = [];
  for (const c of rows.filter(c => heldCents(c) === 0 && owedCents(c) < MIN_TOPUP_CENTS && !chargebackOpen(c) && !pendingRepay(c) && !(c.paid_mode && c.paid_mode !== STRIPE_MODE))) {
    const unlock = await lockOrder(c.id, 0).catch(() => null);
    if (!unlock) continue;
    try { if (await closeIfNothingLeft(c.id, null, { books: true })) closed++; }
    catch (e) { failed.push({ id: c.id, why: "closing an Order that holds nothing: " + e.message }); console.error("closing an Order that holds nothing failed for", c.id, e.message); }
    finally { await unlock(); }
  }
  return { closed, failed };
}
const oldEnough = (stripeSeconds) => Number.isFinite(stripeSeconds) && Date.now() - stripeSeconds * 1000 >= FIRST_LINE_WAIT_MS;   // its own step is long over
async function repairPlan2Order(id) {
  let c = await db.contract(id);
  if (!c || !isPlan2(c) || (c.paid_mode && c.paid_mode !== STRIPE_MODE)) return 0;      // paid in the other mode: these keys cannot see it
  let added = 0, rows = await linesOf(c);
  // payments: the first one (as for every Order), then top-ups, from Stripe's record of the Order's card payments
  if (nz(c.funded_cents) > sumKind(rows, "fund")) {
    if (isPi(c.stripe_payment_intent) && !hasLine(rows, "fund", c.stripe_payment_intent)) {
      const r = await repairFirstLine(c, rows.filter(x => x.kind === "fund"));
      if (r) { added++; await settleFee(c, r).catch(e => console.error("fee", c.id, e.message)); }
      rows = await linesOf(c);
    }
    let gap = nz(c.funded_cents) - sumKind(rows, "fund");
    if (gap > 0) {
      const charges = (((await stripe("GET", "/charges", { transfer_group: `contract_${c.id}`, limit: 100 })).data) || [])
        .filter(ch => ch && ch.captured !== false && isPi(ch.payment_intent) && ch.payment_intent !== c.stripe_payment_intent && !hasLine(rows, "fund", ch.payment_intent) && oldEnough(ch.created)).sort(byCreated);
      for (const ch of charges) {
        if (gap <= 0) break;
        const pi = ch.payment_intent;
        // only a top-up this Order recorded: its claim was taken when it was counted (a late payment's claim is let go, and a
        // late payment waiting for its refund has its reminder)
        if (!(await db.one("money_keys", `scope=eq.${q("apply:" + pi)}&select=scope`)) || (await db.one("money_keys", `scope=eq.${q(LATE_DUE + pi)}&select=scope`))) continue;
        // a late payment (marked for good when it was taken for one, whatever became of its refund since) or one Cuvori sent
        // back as late is never the Order's: its claim can stay behind (check of 7 November: such a payment was counted as a
        // top-up, and the Order's payout was then paid from Cuvori's own money)
        if (await db.one("money_keys", `scope=in.(${[LATE_SEEN + pi, "late:" + pi, "late_cb:" + pi, "late_full:" + pi].map(q).join(",")})&select=scope`)) continue;
        if ((((await stripe("GET", "/refunds", { payment_intent: pi, limit: 100 })).data) || []).some(r => r && r.metadata && r.metadata.kind === "late_payment")) continue;
        const p = await stripe("GET", `/payment_intents/${pi}`, { "expand[]": "latest_charge.balance_transaction" });
        const md = (p && p.metadata) || {}, lc = p && p.latest_charge && typeof p.latest_charge === "object" ? p.latest_charge : ch;
        if (!p || p.status !== "succeeded" || md.contract_id !== c.id || md.kind !== "topup" || String(ch.currency || "").toLowerCase() !== String(c.currency || "EUR").toLowerCase()) continue;
        const amount = ch.amount;                                                       // the new prices: nothing on top of the price
        if (!(amount > 0) || amount > gap) continue;
        const bt = lc.balance_transaction && typeof lc.balance_transaction === "object" ? lc.balance_transaction : null;
        const line = { kind: "fund", amount_cents: amount, fee_cents: 0, connect_cents: 0, provider_ref: pi, charge_ref: ch.id, provider_fee_cents: entryFee(bt), entry_key: entryKey("fund", pi),
          note: "topup (line added from Stripe's record)", ...(stripeTime(ch.created) ? { created_at: stripeTime(ch.created) } : {}) };
        if (await ledger(c, line, byKey("fund", pi))) {
          added++; gap -= amount; rows.push(line);
          const mine = (n) => n.startsWith(`top-up ${pi} `);
          if (hasNote(c.money_error, mine)) c = (await putNote(c.id, n => dropNote(n, mine))) || c;
        }
      }
    }
  }
  // payouts and re-payments: the pull-backs first (the paid-out total follows its lines), then every transfer the total
  // counts but the books don't show
  rows = await linesOf(c);
  if (nz(c.released_cents) > sumKind(rows, "release") - sumKind(rows, "reversal")) {
    const ts = await transfersOf(c);
    if (ts.some(t => nz(t.amount_reversed) > 0)) { c = (await syncReversals(c, c.chargeback_id)).row; rows = await linesOf(c); }
    let gap = nz(c.released_cents) - (sumKind(rows, "release") - sumKind(rows, "reversal"));
    for (const t of ts.sort(byCreated)) {
      if (gap <= 0) break;
      if (hasLine(rows, "release", t.id) || !oldEnough(t.created)) continue;
      const g = grossOf(t);
      if (g > gap) continue;
      const line = payoutLine(t, { late: true, note: "payout (line added from Stripe's record)" });
      if (await ledger(c, line, byKey("release", t.id))) { added++; gap -= g; rows.push(line); }
    }
  }
  // a lost chargeback's line (what the bank took), then Cuvori's refunds the refund total counts but the books don't show
  c = (await db.contract(id)) || c;
  if (c.chargeback_status === "lost" && isStripeId(c.chargeback_id) && !hasLine(rows, "chargeback", c.chargeback_id)) {
    await recordClosedChargeback(c, c.chargeback_id);
    if (hasLine(await linesOf(c), "chargeback", c.chargeback_id)) added++;
    rows = await linesOf(c);
  }
  let gapR = nz(c.refunded_cents) - rows.filter(r => r.kind === "refund" || r.kind === "chargeback").reduce((a, r) => a + countedOf(r), 0) + failedBackOf(rows);
  if (gapR > 0) {
    for (const r of await ourRefundsAtStripe(c)) {
      if (gapR <= 0) break;
      if (hasLine(rows, "refund", r.id) || r.amount > gapR || !oldEnough(r.created)) continue;
      await refundLines(c, [r], rows, "refund (line added from Stripe's record)");
      added++; gapR -= r.amount;
    }
  }
  if (added) console.error("ledger lines added from Stripe's record", c.id, added);
  return added;
}
// The hourly run: Stripe's real fee on the new prices' payments, once it is known (a fee billed separately, standalone fees,
// is in Stripe's Fees report within about 4 days: asked again each hour for two weeks), and a card fee charged by mistake sent back.
// Within the hourly run's time (over: true once its repairs must stop; what is left waits for the next run), with what Stripe
// says about its Fees report read once for the whole run, and the payments that keep failing, or still wait for Stripe's
// fee after 4 days, going after the others and tried less often (the hourly run's retry rule, retryStates): check of 2
// November, where 40 such payments took the hourly run past Netlify's 30 seconds.
export async function recordPlan2Fees(over = () => false, once = {}) {
  const from = q(new Date(Date.now() - 14 * 86400e3).toISOString()), to = q(new Date(Date.now() - 2 * 60e3).toISOString());
  // (the 200 oldest and the 50 newest still waiting: ones that keep waiting never keep a newer one from being looked at)
  const noFee = async (dir, n) => (await db.select("order_payments", `kind=eq.fund&status=eq.succeeded&provider=eq.stripe&pricing_version=gte.2&provider_fee_cents=is.null&created_at=gt.${from}&created_at=lt.${to}&select=*&order=created_at.${dir}&limit=${n}`)) || [];
  const rows = [...(await noFee("asc", 200)), ...(await noFee("desc", 50)).reverse(),
                // (and the card fees charged by mistake still to send back, read in a fixed order: up to RETRY_READ, the one that
                // failed least first like the rest, so 20 that fail for ever no longer hide the others; check of 2 November)
                ...((await db.select("order_payments", `kind=eq.fund&status=eq.succeeded&provider=eq.stripe&pricing_version=gte.2&fee_cents=gt.0&fee_refund_ref=is.null&created_at=lt.${to}&select=*&order=created_at.asc&limit=${RETRY_READ}`)) || [])];
  let done = 0, waiting = 0; const failed = [];
  const tries = await retryStates("fee2");
  const list = [...new Map(rows.map(r => [r.id, r])).values()].filter(r => retryDue(tries.get(r.id))).sort((a, b) => retryTries(tries.get(a.id)) - retryTries(tries.get(b.id)));
  for (const row of list) {
    if (over()) { waiting++; continue; }
    const st = tries.get(row.id);
    try {
      const c = await db.contract(row.order_id); if (!c || !isPlan2(c)) continue;
      if ((await recordFeeV2(c, row, once)) !== "pending") { done++; await retryDone("fee2", row.id, st); }
      else if (Date.now() - Date.parse(row.created_at) > FEE_WAIT_MS) await retryLater("fee2", row.id, st).catch(() => {});   // 4 days and Stripe's fee still not known: counts as failing
    }
    catch (e) { failed.push({ id: row.order_id, why: "fee: " + e.message }); console.error("Stripe's fee not recorded for", row.order_id, e.message); await retryLater("fee2", row.id, st).catch(() => {}); }
  }
  return { done, failed, waiting };
}

// A refund made in the Stripe dashboard on an Order at the new prices, mirrored into the books (called under the Order's
// lock, with a fresh row). One line per refund (its own Stripe id: the database takes each refund once), written first and
// whole; what of it the Order counts is what it still held, said on the line ("dashboard_refund counted <cents>" when that
// is less: the rest had already been paid out to the freelancer, so money went out twice). The Order's refund total then
// follows its lines. A refund mirrored before has its line, so a notice Stripe sends again counts nothing twice. Today's
// prices keep their own copy (stripe-webhook.mjs).
export async function mirrorOutsideRefundV2(c, o) {
  const all = (((await stripe("GET", "/refunds", { payment_intent: o.payment_intent, limit: 100 })).data) || []).filter(r => r && isStripeId(r.id));
  if (!all.length) { const e = new Error(`refund on ${o.payment_intent}: Stripe lists no refund yet`); e.outcomeUnknown = true; throw e; }   // the event fails: Stripe sends it again
  // a refund Stripe lists as failed whose "failed" notice Cuvori has not handled yet is handled first, so the refund made
  // again in its place is counted once (check of 8 November: in between, the Order counted both)
  c = await failedRefundsFirst(c, all, o.payment_intent);
  // (refunds Stripe lists as failed or cancelled are nothing to mirror: a notice delivered after its refund failed is done)
  const listed = all.filter(r => r.status !== "failed" && r.status !== "canceled");
  const outside = listed.filter(r => !OURS(r)).sort(byCreated);
  const now = new Date().toISOString();
  let rows = await linesOf(c);
  const funds = rows.filter(r => r.kind === "fund"), thisFund = funds.find(f => f.provider_ref === o.payment_intent);
  // the Order's money in this payment: what it paid in, less what went back of it before (Cuvori's refunds and these)
  let room = Math.max((thisFund ? thisFund.amount_cents : (nz(c.funded_cents) || centsOf(c) || 0))
    - rows.filter(r => r.kind === "refund" && listed.some(x => x.id === r.provider_ref)).reduce((a, r) => a + r.amount_cents, 0), 0);
  const countedAll = () => rows.filter(r => r.kind === "refund" || r.kind === "chargeback").reduce((a, r) => a + countedOf(r), 0) - failedBackOf(rows);
  let heldLeft = Math.max(heldCents(c) - Math.max(countedAll() - nz(c.refunded_cents), 0), 0);
  let part = 0, twice = 0;
  for (const r of outside) {
    if (hasLine(rows, "refund", r.id)) continue;
    const amount = Math.min(r.amount, room);
    if (amount <= 0) continue;
    const counted = Math.min(amount, heldLeft);
    const line = { kind: "refund", amount_cents: amount, provider_ref: r.id, charge_ref: o.id, entry_key: entryKey("refund", r.id), note: counted === amount ? "dashboard_refund" : `dashboard_refund counted ${counted}` };
    // a line that can't be saved fails this event, so Stripe sends it again and nothing is counted on a guess
    if (!(await ledger(c, line, byKey("refund", r.id)))) throw new Error(`refund made outside Cuvori on ${o.payment_intent}: its line ${r.id} could not be saved`);
    rows.push(line); room -= amount; heldLeft -= counted; part += amount; twice += amount - counted;
  }
  const held = heldCents(c);
  const behind = Math.min(Math.max(countedAll() - nz(c.refunded_cents), 0), held);
  if (part <= 0 && behind <= 0) return;
  const cents = outside.reduce((a, r) => a + r.amount, 0);
  const sameCounter = eqOrNull("refunded_cents", c.refunded_cents);
  const onlyPayment = funds.length <= 1 && (c.stripe_payment_intent === o.payment_intent || !!thisFund);
  if (onlyPayment && o.refunded) {
    // the one payment behind this order is back with the client in full: the order is refunded, whatever was still held is gone
    const rowsU = await db.update("contracts", `id=eq.${c.id}&status=in.(${HOLDING.join(",")})&${sameCounter}`, { status: "refunded", closed_at: now, resolution: "refund", auto_release_at: null, refunded_cents: nz(c.refunded_cents) + behind,
      money_error: twice > 0 ? addNote(stepsOver(c.money_error), `refund made outside Cuvori: ${(twice / 100).toFixed(2)} had already been paid to the freelancer — check by hand`) : stepsOver(c.money_error) });
    const u = rowsU && rowsU[0] || null;
    if (u) { await orderEvent(u, "refunded", { outside: true, amount_cents: o.amount_refunded }, null); return; }
  }
  const why = `Refund of ${(cents / 100).toFixed(2)} ${String(o.currency || c.currency || "").toUpperCase()} made outside Cuvori on payment ${o.payment_intent}; the order holds ${(behind / 100).toFixed(2)} less than before${twice > 0 ? `; ${(twice / 100).toFixed(2)} of it had already been paid out — money went out twice` : ""}`;
  const note = addNote(c.money_error, why.slice(0, 300));
  const u = ((await db.update("contracts", `id=eq.${c.id}&status=in.(funded,delivered)&${sameCounter}`, { status: "disputed", dispute_reason: why.slice(0, 2000), disputed_at: now, dispute_by: c.client, auto_release_at: null, money_error: note, refunded_cents: nz(c.refunded_cents) + behind })) || [])[0]
    || ((await db.update("contracts", `id=eq.${c.id}&${sameCounter}`, { money_error: note, refunded_cents: nz(c.refunded_cents) + behind })) || [])[0];
  if (!u) throw new Error(`refund made outside Cuvori on ${o.payment_intent}: the Order changed while it was counted`);
  await orderEvent(u, "disputed", { outside_refund: true, amount_cents: part || behind, note: "Refund made outside Cuvori — Cuvori checks this by hand" }, null);
  if (HOLDING.includes(u.status) && heldCents(u) === 0) {
    const v = await db.claim(c.id, HOLDING, { status: "refunded", closed_at: now, resolved_at: now, resolution: "refund", auto_release_at: null });
    if (v) await orderEvent(v, "refunded", { outside: true, amount_cents: nz(v.refunded_cents) }, null);
  }
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
// The hourly run's retries (a card-fee surplus, a late payment's refund) that keep failing, or keep waiting for Stripe, never
// hold up the others (check of 2 November: 50 payments whose surplus could never go back kept every newer client's surplus
// from going back, and 20 late payments whose refund could never go through kept a later client's): what has failed least
// goes first, and one that has failed for a day is tried less often: after 1, 2, 4, 8 and 16 hours, then once a day. A
// payment only waiting for Stripe's fee (billed separately: in Stripe's Fees report within 96 hours) does not count as
// failing until it is older than that. One money key per payment ("retry:<kind>:<id>": how often it failed, and when
// next), gone once it settles.
const RETRY = "retry:", RETRY_HOURLY = 24;
export const FEE_WAIT_MS = 4 * 86400e3;
export async function retryStates(kind) {
  const rows = (await db.select("money_keys", `scope=like.${q(RETRY + kind + ":")}*&select=scope,key&limit=5000`).catch(() => [])) || [];
  const m = new Map();
  for (const r of rows) { let s = null; try { s = JSON.parse(r.key); } catch { s = null; } if (s && Number.isInteger(s.tries)) m.set(r.scope.slice(RETRY.length + kind.length + 1), s); }
  return m;
}
export const retryDue = (st) => !st || !(Date.parse(st.next) > Date.now());
export const retryTries = (st) => (st && Number.isInteger(st.tries) ? st.tries : 0);
export async function retryLater(kind, id, st) {
  const tries = retryTries(st) + 1, scope = RETRY + kind + ":" + id;
  const wait = tries < RETRY_HOURLY ? 0 : Math.min(2 ** (tries - RETRY_HOURLY), 24) * 3600e3 - 5 * 60e3;   // (a few minutes early: the next run is due then)
  const key = JSON.stringify({ tries, next: new Date(Date.now() + Math.max(wait, 0)).toISOString() });
  if (st) { await db.update("money_keys", `scope=eq.${q(scope)}`, { key }); return; }
  await db.insert("money_keys", { scope, key }).catch(async (x) => { if (x.status !== 409) throw x; await db.update("money_keys", `scope=eq.${q(scope)}`, { key }); });
}
export const retryDone = (kind, id, st) => (st ? dropKey(RETRY + kind + ":" + id) : Promise.resolve());
// The same for the hourly run's lists of Orders to try again (a chargeback's pull-back, a re-payment after a won one, a
// second chargeback to take over, a payout line to add, a card fee charged by mistake to send back): each list is read in a
// fixed order (up to RETRY_READ rows), and the rows due are worked on, the one that failed least first, at most `max` a run.
// Before, each list took any 20 rows, so 20 that failed for ever (re-payments to banned freelancers, say) were the whole list
// every hour and hid every later one (check of 2 November). One key per row and list, as above; when the list was read
// whole, a row no longer on it is forgotten. ok(id) / failed(id): how its try went.
export const RETRY_READ = 500;
export async function retryOrder(kind, rows, { max = 20, whole = false } = {}) {
  const st = await retryStates(kind);
  if (whole) { const ids = new Set(rows.map(r => String(r.id))); for (const [id, s] of st) if (!ids.has(id)) await retryDone(kind, id, s); }
  const list = rows.filter(r => retryDue(st.get(String(r.id)))).sort((a, b) => retryTries(st.get(String(a.id))) - retryTries(st.get(String(b.id)))).slice(0, max);
  return { list, ok: (id) => retryDone(kind, id, st.get(String(id))), failed: (id) => retryLater(kind, id, st.get(String(id))).catch(() => {}) };
}
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
export async function moneyPost(scope, path, body, opts = {}) {
  const key = await moneyKey(scope);
  try { const out = await stripe("POST", path, body, { preview: !!opts.preview, idempotency: key }); out[IDEM_KEY] = key; return out; }
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
    // a payout from money held apart that Stripe refused for another reason than "not enough there yet" (payInParts): it
    // will not go through by waiting. Stripe's code (one of its fixed words) names the cause; its text is in the log only.
    if (e.heldApart && s >= 400 && s < 500 && s !== 429) {
      const code = typeof e.stripe.code === "string" && /^[a-z_]{2,60}$/.test(e.stripe.code) ? `, Stripe's code ${e.stripe.code}` : "";
      return `Stripe refused a payout from the money it holds apart${code}: not a settling delay, it goes through only once the cause is fixed (Stripe's answer is in the log)`;
    }
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
// A part whose payout another step counted (the settlement, the chargeback's sync, the part's own retry): it is paid out,
// and its stopped step's note goes with it (check of 7 November: "Money step stopped (milestone …)" stayed for good)
// The part's history line and its chat card are written then, as when the part's own step pays it (check of 7 November: a
// part counted this way had neither). True when it marked the part now.
async function partPaid(c, mid, tid, actor = null, ev = null) {
  if (!mid) return false;
  const m = await db.claimMilestone(mid, ["submitted", "approved"], { status: "released", released_at: new Date().toISOString(), transfer_ref: tid }).catch(e => { console.error("milestone mark", c.id, e.message); return null; });
  const head = stepHead(`milestone ${mid}`);
  await putNote(c.id, n => dropNote(n, x => x.startsWith(head))).catch(e => console.error("milestone note", c.id, e && e.message));
  if (!m) return false;
  await orderEvent(c, ev === "auto_release" ? "milestone_auto_released" : "milestone_released", { milestone: mid, title: m.title, amount_cents: m.amount_cents, counted: true }, actor).catch(e => console.error("milestone history", c.id, e && e.message));
  await contractEvent(c, "milestone_approved", actor || c.client, { amount_cents: m.amount_cents, label: m.title }).catch(e => console.error("milestone card", c.id, e && e.message));
  return true;
}
// The hourly run: a part whose payout is in the books (its line, or all its lines when it was paid in pieces) but which is not
// marked paid out (the mark could not be saved when another step counted it): marked now, with its history line and chat
// card (check of 8 November: such a part stayed "approved" for good, with neither). Looked up from the parts not marked yet
// (however long ago their payout was counted), 1,000 an hour in turn, so every one is looked at (check of 8 November,
// re-check: only the first 2,000 ever were); a payout line's re-payment after a won chargeback is no part's payout.
export async function markCountedParts() {
  const SWEEP = "sweep:counted_parts";
  const at = await db.one("money_keys", `scope=eq.${q(SWEEP)}&select=key`).catch(() => null);
  const after = at && isUuid(at.key) ? at.key : null;
  const open = (await db.select("order_milestones", `status=in.(submitted,approved)${after ? `&id=gt.${after}` : ""}&select=id,order_id,amount_cents&order=id.asc&limit=1000`)) || [];
  const next = open.length >= 1000 ? open[open.length - 1].id : null;           // the end of the list: from the start again
  if (next) await db.insert("money_keys", { scope: SWEEP, key: next }).catch(async (e) => { if (e.status === 409) await db.update("money_keys", `scope=eq.${q(SWEEP)}`, { key: next }).catch(() => {}); });
  else if (after) await db.remove("money_keys", `scope=eq.${q(SWEEP)}`).catch(() => {});
  let marked = 0;
  for (let i = 0; i < open.length; i += 100) {
    const some = open.slice(i, i + 100).filter(m => isUuid(m.id));
    if (!some.length) continue;
    const ls = ((await db.select("order_payments", `kind=eq.release&status=eq.succeeded&milestone_id=in.(${some.map(m => m.id).join(",")})&select=order_id,milestone_id,amount_cents,provider_ref,note`)) || [])
      .filter(l => !String(l.note || "").startsWith("chargeback_won"));
    for (const m of some) {
      const mine = ls.filter(l => l.milestone_id === m.id && l.order_id === m.order_id);
      if (!mine.length || mine.reduce((a, l) => a + nz(l.amount_cents), 0) < nz(m.amount_cents)) continue;   // (paid in pieces: once all of it is in)
      const c = await db.contract(m.order_id).catch(() => null);
      if (c && await partPaid(c, m.id, mine[0].provider_ref).catch(e => { console.error("marking a counted part", m.id, e && e.message); return false; })) marked++;
    }
  }
  return marked;
}
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

// ---- money held apart at Stripe (funds segregation, see FS_PREVIEW_VERSION) ----
// An Order has (or may have) a payment held apart once its mark is saved, which is before such a payment is charged
// (chargeHold): from then on its payouts are linked to the payments they come from, also after the setting is turned off
// again (Stripe only lets a payout linked to the payment take money held apart). An Order without the mark (every Order
// paid before, every Order at today's prices) is paid out exactly as before, and Stripe is never asked about it.
const fsScope = (id) => `fs:${id}`;
export const fsMarked = async (c) => !!c && isPlan2(c) && !!(await db.one("money_keys", `scope=eq.${q(fsScope(c.id))}&select=scope`));
async function markHeldApart(id) {
  try { await db.insert("money_keys", { scope: fsScope(id), key: `fs:${crypto.randomUUID().slice(0, 12)}` }); }
  catch (e) { if (!(await db.one("money_keys", `scope=eq.${q(fsScope(id))}&select=scope`))) throw e; }   // marked already: fine
}
// What Stripe still holds apart of one payment, in cents (pending: not settled yet, which a linked payout can still use, as
// with any payout linked to its payment). enabled false: the payment is not held apart (made before, another card network,
// or Stripe did not take the request) and is paid out the old way.
export async function heldApartOf(pi) {
  const p = await stripe("GET", `/payment_intents/${pi}`, { "expand[]": "latest_charge.allocated_funds.balance" }, { preview: true });
  const ch = p && p.latest_charge && typeof p.latest_charge === "object" ? p.latest_charge : null;
  const af = ch && ch.allocated_funds && typeof ch.allocated_funds === "object" ? ch.allocated_funds : null;
  const b = af && af.balance && typeof af.balance === "object" ? af.balance : {};
  const n = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);
  const card = ch && ch.payment_method_details && ch.payment_method_details.card;
  return { pi, charge: ch && isStripeId(ch.id) ? ch.id : null, enabled: !!af && af.enabled === true && !!ch && isStripeId(ch.id),
    available: n(b.available), pending: n(b.pending), currency: String(b.currency || (ch && ch.currency) || "").toLowerCase(), brand: (card && card.brand) || null };
}
// the Order's payments Stripe holds apart, oldest first, each with what it still holds (only those in the Order's currency)
async function heldApartPools(c) {
  const cur = String(c.currency || "EUR").toLowerCase(), out = [];
  for (const f of await fundRows(c)) {
    if (!isPi(f.provider_ref)) continue;
    const a = await heldApartOf(f.provider_ref);
    if (a.enabled && (!a.currency || a.currency === cur)) out.push(a);
  }
  return out;
}
// A payout from money held apart is made of parts, one per payment it is paid from (Stripe links each transfer to one
// payment). Each part says its number and the payout's full amount (payout_total_cents); the parts of one payout share its
// milestone, purpose and decision. Everything that reads payouts counts each part as a payout of its own amount.
const partOf = (t) => { const md = (t && t.metadata) || {}, i = metaInt(md.part), total = metaInt(md.payout_total_cents); return i != null && total != null && total > 0 ? { i, total } : null; };
export const isPart = (t) => !!partOf(t);
const samePayout = (a, b) => (a.metadata.milestone_id || "") === (b.metadata.milestone_id || "") && (a.metadata.purpose || "release") === (b.metadata.purpose || "release") && (a.metadata.attempt || "") === (b.metadata.attempt || "");
// a transfer that is a whole payout, or a part whose payout has all its parts at Stripe
const payoutWhole = (ts, t) => { const p = partOf(t); if (!p) return true; return ts.filter(x => !x.reversed && isPart(x) && samePayout(x, t)).reduce((a, x) => a + grossOf(x), 0) >= p.total; };

// ---- the new prices (plan 2, schema v56) ----
// An Order agreed under the new prices and paid through Cuvori: the client pays only the agreed price, every payout keeps
// 5% (the Order's commission_bps), Cuvori pays the card costs. Everything else (no plan: an Order from before v56; plan 1:
// today's prices) works exactly as before.
export const isPlan2 = (c) => !!c && Number(c.pricing_version) >= 2 && c.payment_mode === "escrow";
// the commission on an amount, rounded half up to the cent (the database's pricing_commission)
export const pricingCommission = (cents, bps) => Math.floor((nz(cents) * (Number.isInteger(bps) && bps > 0 ? bps : 0) + 5000) / 10000);
const metaInt = (v) => { if (v == null || v === "") return null; const n = Number(v); return Number.isSafeInteger(n) && n >= 0 ? n : null; };
// A payout under the new prices records its full amount (with the 5%) on the Order and its line, and sends the 95%: its
// transfer says both (gross_cents, commission_cents, payout_cents). Everywhere a transfer is read as "paid out", the full
// amount is what counts (grossOf): read as the transfer alone, the 5% would count as still held, and be paid out or refunded
// again. A transfer of today's prices (or one whose details don't add up) counts as itself.
export const payoutOf = (t) => {
  const md = (t && t.metadata) || {}, g = metaInt(md.gross_cents), k = metaInt(md.commission_cents);
  if (md.pricing_version && g != null && k != null && g - k === t.amount) return { gross: g, commission: k, sent: t.amount };
  return { gross: t.amount, commission: 0, sent: t.amount };
};
export const grossOf = (t) => payoutOf(t).gross;
// the re-payment after a won chargeback names its chargeback in its purpose ("retransfer_<dispute id>")
const repayOf = (t) => { const p = String((t && t.metadata && t.metadata.purpose) || ""); return /^retransfer_[A-Za-z0-9_]{1,200}$/.test(p) ? p.slice(11) : null; };
// Stripe's own time (seconds) of a payment, payout, refund or pull-back: a line added afterwards from Stripe's record carries
// it, so the commission report puts it in the month the money moved
const stripeTime = (s) => (Number.isFinite(s) && s > 0 ? new Date(Math.round(s * 1000)).toISOString() : undefined);
// Every plan 2 line has its own entry key, named after its one Stripe object: "fund:pi_…", "release:tr_…", "refund:re_…",
// "reversal:trr_…", "chargeback:dp_…". The database takes each key once, so a line saved twice (an answer lost) is found
// by it and never written twice.
export const entryKey = (kind, id) => `${kind}:${id}`;
const byKey = (kind, id) => `entry_key=eq.${q(entryKey(kind, id))}`;
// A payout's line, from its transfer: its full amount, the 5% kept and what was sent; a re-payment after a won chargeback
// keeps nothing and names its chargeback. late: written afterwards from Stripe's record (release_late, at Stripe's time).
function payoutLine(t, { late = false, note = null } = {}) {
  const { gross, commission, sent } = payoutOf(t), d = repayOf(t), ms = (t.metadata && t.metadata.milestone_id) || "";
  return { kind: "release", amount_cents: gross, commission_cents: d ? 0 : commission, payout_cents: d ? gross : sent, payout_purpose: d ? "repay" : late ? "release_late" : "release",
    provider_ref: t.id, entry_key: entryKey("release", t.id), note: d ? `chargeback_won ${d}` : (note || "payout"), ...(isUuid(ms) ? { milestone_id: ms } : {}),
    ...(late && stripeTime(t.created) ? { created_at: stripeTime(t.created) } : {}),
    // a part of a payout paid from a payment held apart names that payment (its card charge)
    ...(isPart(t) && isStripeId(t.metadata.source_charge) ? { charge_ref: t.metadata.source_charge } : {}) };
}
// What a refund or chargeback line put on the Order's refund total. Under the new prices a refund made in the Stripe
// dashboard after the freelancer was paid is written whole on its own line (one line per refund), but the Order counts
// only what it still held ("dashboard_refund counted <cents>"); a lost chargeback is written with what the bank took, and
// the Order counts what Cuvori still held ("chargeback_lost counted <cents>"). Every other line counts whole.
export const countedOf = (l) => {
  const m = /^(?:dashboard_refund|chargeback_lost) counted (\d{1,12})$/.exec(String(l.note || ""));
  return m ? Math.min(Number(m[1]), l.amount_cents) : l.amount_cents;
};
// What refunds that failed at Stripe afterwards took off the Order's refund total again (recordFailedRefund): for each
// "refund_failed" line, what the Order had counted of that refund. Every count of refund lines against the Order's refund
// total takes it off, or a refund made again after a failed one would be read as counted already.
export const failedBackOf = (rows) => rows.filter(r => r.kind === "refund_failed").reduce((a, f) => a + Math.min(f.amount_cents,
  rows.filter(r => r.kind === "refund" && String(r.provider_ref || "").split(",").includes(f.provider_ref)).reduce((b, r) => b + countedOf(r), 0)), 0);
// A refund that fails at Stripe after it was recorded (the client's card account closed, for example): the money comes back
// to Cuvori's balance, but the books said it went to the client. Stripe tells it with "charge.refund.updated" (and, for
// newer API versions, "refund.failed"), the refund's status "failed" or "canceled". The ledger gets a "refund_failed"
// line of its own (schema v56; the refund's line itself is never changed), written first, and the Order's refund total
// gives back what it had counted of that refund, so the money shows as held by Cuvori again (the ledger check then lists a
// finished Order as money left at Cuvori). The Order's note tells the admin to refund the client again in the Stripe
// dashboard, which Cuvori records as usual. A card-fee refund or a late payment's refund that fails was never part of the
// Order's money: only the note. On a database without v56 (no such kind of line yet) only the note is written too.
// Safe to receive more than once: the line names the refund, and each Stripe object is written once.
export async function recordFailedRefund(r) {
  if (!r || r.object !== "refund" || !isStripeId(r.id) || !["failed", "canceled"].includes(r.status)) return "ignored";
  const pi = typeof r.payment_intent === "string" ? r.payment_intent : r.payment_intent && r.payment_intent.id;
  const md = r.metadata || {};
  const c0 = (isPi(pi) ? await contractByPi(pi) : null) || (isUuid(md.contract_id) ? await db.contract(md.contract_id) : null);
  if (!c0) { console.error("a refund failed at Stripe, on no Order of Cuvori's", r.id, pi); return "ignored"; }
  if (md.kind === "fee_surplus" || md.kind === "late_payment") return failedRefundIn(c0, r);
  const unlock = await lockOrder(c0.id);
  try { return await failedRefundIn((await db.contract(c0.id)) || c0, r); } finally { await unlock(); }
}
// The same, for an Order whose lock the caller holds (with a fresh row): Stripe's "failed" notice, or a refund made in the
// Stripe dashboard while Stripe already lists an earlier refund of the payment as failed whose notice Cuvori has not
// handled yet (it comes late, or its first delivery failed). That one is handled first, so the refund made again in its
// place is counted once (check of 8 November: in between, the Order counted both, and a decision then underpaid the
// freelancer; on a database without v56 the refund made again was counted although the failed one never came off).
export async function failedRefundIn(c, r) {
  if (!c || !r || !isStripeId(r.id) || !["failed", "canceled"].includes(r.status)) return "ignored";
  const md = r.metadata || {};
  const eur = (cents) => `${(nz(cents) / 100).toFixed(2)} ${String(r.currency || c.currency || "EUR").toUpperCase()}`;
  const why = r.failure_reason ? ` (${String(r.failure_reason).slice(0, 60)})` : "";
  const noteOf = (id) => (n) => n.startsWith(`refund ${id} `);
  const say = (text) => putNote(c.id, n => addNote(n, text, noteOf(r.id)));
  // a refund only noted (never counted back: the card fee, a late payment, or any refund on a database without v56): noted
  // once, and a key says so once the note is on the Order, so a note marked as handled never comes back with a later notice
  // of the payment, and one that could not be saved is written by the next one (check of 8 November, re-check)
  const NOTED = `refund_noted:${r.id}`;
  const noteOnce = async (text) => {
    if (await db.one("money_keys", `scope=eq.${q(NOTED)}&select=scope`)) return "noted";
    const row = await say(text);
    if (row && hasNote(row.money_error, noteOf(r.id))) await db.insert("money_keys", { scope: NOTED, key: "noted" }).catch(() => {});
    return "noted";
  };
  if (md.kind === "fee_surplus" || md.kind === "late_payment") {
    // (a late payment is not the Order's money: a refund of it in the Stripe dashboard is not counted on the Order. The card
    // fee is paid with the Order's own payment: a refund of it in the dashboard would be counted as the Order's money)
    return noteOnce(md.kind === "late_payment"
      ? `refund ${r.id} of ${eur(r.amount)} (a late payment) failed at Stripe${why}: the money is back at Cuvori and the client hasn't got it — refund it again in the Stripe dashboard, or pay it to them another way (a bank transfer)`
      : `refund ${r.id} of ${eur(r.amount)} (card fee) failed at Stripe${why}: the money is back at Cuvori and the client hasn't got it — pay it to them another way (a bank transfer; not a refund in the Stripe dashboard: Cuvori would count that as a refund of the Order's money)`);
  }
  const text = `refund ${r.id} of ${eur(r.amount)} failed at Stripe${why}: the money is back at Cuvori and the client hasn't got it — refund it again in the Stripe dashboard (Cuvori records that refund as usual)`;
  const BACK = `refund_back:${r.id}`;
  if (await db.one("money_keys", `scope=eq.${q(BACK)}&select=scope`)) return "already";
  // noted on a database without v56 (no such kind of line then): the Order kept counting it as given back, and the refund
  // made again in its place is that same money. It stays that way once v56 has run: never counted back, never noted again
  // (check of 8 November, re-check: a "failed" notice sent again after v56 counted it back, and Cuvori paid the client's
  // 40.00 out of its own money with nothing saying so)
  if (await db.one("money_keys", `scope=eq.${q(NOTED)}&select=scope`)) return "noted";
  // 1. the line first: what says the refund came back. A second notice finds it and adds nothing.
  let wasLined = !!(await db.one("order_payments", `order_id=eq.${c.id}&kind=eq.refund_failed&provider_ref=eq.${q(r.id)}&select=id`));
  if (!wasLined) {
    try {
      // (an entry key under the new prices, as every line there; today's prices write none, as today's code)
      await db.insert("order_payments", { order_id: c.id, provider: "stripe", status: "succeeded", kind: "refund_failed", amount_cents: nz(r.amount), provider_ref: r.id,
        ...(isPlan2(c) ? { entry_key: entryKey("refund_failed", r.id) } : {}), note: "refund_failed" });
    } catch (e) {
      const m = String(e && e.message);
      // a database without v56 has no such kind of line (its kind rule refuses it): the note says it, once, and the books stay
      // as they were (the failed refund stays counted as given back, so the refund made again in its place is not counted a
      // second time)
      if (/order_payments_kind_check/i.test(m)) return noteOnce(text);
      if (!/duplicate key/i.test(m)) throw e;
      wasLined = true;                                                     // written a moment ago: as seen before
    }
  }
  // 2. the Order gives back what it had counted of that refund, together with its note (in one write: the note there means
  //    this was done, so a notice sent again never counts it back twice). The note can go ("Mark as handled"), so a key says
  //    it for good once it is done (check of 7 November). And when neither is there (the key could not be saved, the note was
  //    marked as handled since), the lines decide: the Order counts back only what its total still shows beyond what its
  //    lines say went back (this refund's refund_failed line among them), so a notice sent again after the refund was made
  //    again counts nothing back (check of 8 November: the key refused once, and the Order showed 100.00 held that it did not
  //    have). The key is written once the count back is done (under the Order's lock, so never two at once).
  const backDone = () => db.insert("money_keys", { scope: BACK, key: "counted back" }).catch(e => { if (e.status !== 409) console.error("refund counted back: key not saved (its note and the lines say it)", c.id, r.id, e && e.message); });
  if (hasNote(c.money_error, noteOf(r.id))) { await backDone(); return "already"; }
  let counted = 0;
  try {
    // what the Order had counted of this refund: its own line (today's prices may name several refunds on one line). A
    // refund made in the dashboard after the freelancer was paid has a line of its own that the Order never counted
    // ("dashboard_refund_paid_out"): nothing of it is counted back (check of 7 November, re-check)
    const all = (await db.select("order_payments", `order_id=eq.${c.id}&status=eq.succeeded&kind=in.(refund,chargeback,refund_failed)&select=kind,amount_cents,provider_ref,note`)) || [];
    const mine = all.filter(l => l.kind === "refund" && String(l.provider_ref || "").split(",").includes(r.id) && l.note !== "dashboard_refund_paid_out");
    counted = Math.min(nz(r.amount), mine.reduce((a, l) => a + countedOf(l), 0), nz(c.refunded_cents));
    if (wasLined) {
      // a notice seen before (its line was there): only what the total still shows beyond the lines comes off
      const counts = all.filter(l => l.note !== "dashboard_refund_paid_out");
      const byLines = Math.max(counts.filter(l => l.kind !== "refund_failed").reduce((a, l) => a + countedOf(l), 0) - failedBackOf(counts), 0);
      const beyond = Math.max(nz(c.refunded_cents) - byLines, 0);
      if (counted > 0 && beyond === 0) { await backDone(); console.error("a failed refund's notice again: counted back before", c.id, r.id); return "already"; }
      counted = Math.min(counted, beyond);
    }
    const same = c.refunded_cents == null ? "refunded_cents=is.null" : `refunded_cents=eq.${c.refunded_cents}`;
    const rows = await db.update("contracts", `id=eq.${c.id}&${same}`, { refunded_cents: nz(c.refunded_cents) - counted, money_error: addNote(c.money_error, text, noteOf(r.id)) });
    if (!rows || !rows[0]) throw new Error(`refund ${r.id} failed at Stripe: the Order changed while it was counted back`);
    c.refunded_cents = rows[0].refunded_cents; c.money_error = rows[0].money_error;
  } catch (e) {
    // landed after all (its note is on the Order): the key says so; otherwise Stripe's notice sent again counts it back
    const now = await db.contract(c.id).catch(() => null);
    if (now && hasNote(now.money_error, noteOf(r.id))) await backDone();
    throw e;
  }
  await backDone();
  console.error("a refund failed at Stripe: counted back on its Order", c.id, r.id, { amount: r.amount, counted });
  return "recorded";
}
// Every refund of the payment Stripe lists as failed, handled before a refund made in the dashboard is mirrored (under the
// Order's lock). The Order, as it is then.
export async function failedRefundsFirst(c, all, pi) {
  const failed = (all || []).filter(r => r && isStripeId(r.id) && (r.status === "failed" || r.status === "canceled"));
  if (!failed.length) return c;
  for (const r of failed) await failedRefundIn((await db.contract(c.id)) || c, { ...r, object: "refund", payment_intent: r.payment_intent || pi });
  return (await db.contract(c.id)) || c;
}
// (an Order at today's prices asks only for the columns a database without v56 has too: asked for v56's, it refused the read,
// and no part could be paid out, cancelled or decided there; check of 8 November, re-check)
const linesOf = async (c) => (await db.select("order_payments",`order_id=eq.${c.id}&status=eq.succeeded&select=id,kind,amount_cents,provider_ref,note,milestone_id${isPlan2(c) ? ",payout_purpose,commission_cents,entry_key" : ""}`)) || [];
const sumKind = (rows, kind) => rows.filter(r => r.kind === kind).reduce((a, r) => a + r.amount_cents, 0);
const hasLine = (rows, kind, id) => rows.some(r => r.kind === kind && r.provider_ref === id);
// The plan 2 payout lines the books don't show yet although the Order already counts their money (the line's save failed
// after the counter was raised): written now from Stripe's record, oldest first, so the next 5% is worked out on every payout
// made. A transfer the Order does not count yet is left to the step that made it (it counts it when it is tried again).
async function addCountedPayoutLines(c, transfers) {
  const rows = await linesOf(c);
  let gap = nz(c.released_cents) - (sumKind(rows, "release") - sumKind(rows, "reversal"));
  for (const t of [...transfers].sort((a, b) => (a.created || 0) - (b.created || 0))) {
    if (hasLine(rows, "release", t.id)) continue;
    const g = grossOf(t);
    if (gap < g) continue;
    const line = payoutLine(t, { late: true, note: "payout (line added from Stripe's record)" });
    if (await ledger(c, line, byKey("release", t.id))) { gap -= g; rows.push(line); }
  }
  return rows;
}
// The commission of the next payout of `gross` cents: from the database (pricing_next_commission, on the running total of
// the Order's payout lines), counting also the payouts at Stripe whose lines are not written yet, and catching up a cent
// an earlier payout could not keep (a payout always sends at least a cent: Stripe can't send nothing). So over the Order the
// commission is 5% of everything paid out, rounded half up on the total, and never taken twice.
async function nextCommission(c, gross, transfers, rows) {
  const ask = async (cents) => {
    const k = await db.rpc("pricing_next_commission", { p_order: c.id, p_gross: cents });
    if (!Number.isSafeInteger(k) || k < 0 || k > cents) throw new Error(`the database gave no commission for ${cents} cents on order ${c.id}`);
    return k;
  };
  const normal = rows.filter(r => r.kind === "release" && ["release", "release_late"].includes(r.payout_purpose));
  const unbooked = transfers.filter(t => !repayOf(t) && (t.metadata.purpose || "release") === "release" && !hasLine(rows, "release", t.id));
  const before = normal.reduce((a, r) => a + r.amount_cents, 0), kept = normal.reduce((a, r) => a + nz(r.commission_cents), 0);
  const u = unbooked.reduce((a, t) => a + grossOf(t), 0), uk = unbooked.reduce((a, t) => a + payoutOf(t).commission, 0);
  // commission(before + u + gross) - commission(before), from the database; less what the lines and the unbooked payouts kept
  // beyond commission(before)
  const upTo = (u + gross > 0 ? await ask(u + gross) : 0);
  const k = upTo + pricingCommission(before, c.commission_bps) - kept - uk;
  return Math.max(0, Math.min(k, gross - 1));
}

// Pay the freelancer. `purpose` separates a normal release from paying again after a chargeback was won.
// Under the new prices editorCents is the payout's full amount: the 5% is worked out first (pricing_next_commission, after
// any payout line the books still lack is written), and the freelancer is sent the rest; the transfer says all three.
// opts.out.transfer: the transfer (made now or found again); opts.attempt: the decision a re-payment belongs to (a decision
// that pays back what a won chargeback pulled back).
export async function releaseToEditor(c, editorCents, milestoneId = null, purpose = "release", opts = {}) {
  if (!Number.isInteger(editorCents) || editorCents <= 0) throw new Error("bad release amount");
  if (purpose === "release" && editorCents > heldCents(c)) throw new Error("bad release amount");
  sameMode(c);
  // the re-payment after a won chargeback waits only for a chargeback the Order records as open: another one only noted
  // is taken over once this re-payment is made (nextChargebackLocked), and covered then from what the freelancer has
  if (purpose.startsWith("retransfer_") ? c.chargeback_status === "open" : chargebackOpen(c)) throw fail(CHARGEBACK, 409, "chargeback_open");
  const p2 = isPlan2(c);
  // a transfer for the same milestone / the same settlement attempt is never made twice. Whole-order releases carry
  // the attempt (the decision's timestamp): a later, different decision on the same Order may transfer again.
  const attemptTag = p2 && typeof opts.attempt === "string" ? opts.attempt : milestoneId || purpose !== "release" ? "" : String(c.resolved_at || "");
  const existing = await transfersOf(c);
  const thisPayout = (t) => (t.metadata.milestone_id || "") === (milestoneId || "") && (t.metadata.purpose || "release") === purpose && (!t.metadata.attempt || t.metadata.attempt === attemptTag);
  const same = (t) => !t.reversed && thisPayout(t);
  // a payout of this that a chargeback pulled back (in part or in full) was made: it is counted by the step that asks for it
  // (the settlement, the part's own step), never made again (check of 7 November). Asked for all the same, nothing is paid.
  // (paid in parts, from money held apart: a part pulled back in part still counts as made below, as before; one pulled back
  // in full is never made again either)
  const pulledBack = existing.find(t => thisPayout(t) && (isPart(t) ? t.reversed : nz(t.amount_reversed) > 0));
  if (pulledBack) throw new Error(`payout ${pulledBack.id} was made and pulled back since: it is counted, never made again`);
  // money held apart: the parts of this very payout made already (an earlier try stopped between two parts), and what is
  // left of it. Asked again for the whole payout (a milestone) or for what is left (a decision works that out from
  // Stripe's record), only the rest is paid; any other amount is never guessed at. A whole Order's own payout asked for
  // less than what is left of it (the Order holds less since: a refund made in the Stripe dashboard on one of its payments)
  // pays just that; its parts keep the payout's total, and the settlement counts what it paid (a part of an Order, a
  // milestone, still counts as paid out only once all of it is at Stripe).
  const done = p2 ? existing.filter(t => same(t) && isPart(t)).sort((a, b) => partOf(a).i - partOf(b).i) : [];
  // the part numbers this payout used at Stripe already (a part pulled back since included): never planned again, so a
  // part's key only ever meets a retry of that same part
  const nextPart = p2 ? existing.filter(t => thisPayout(t) && isPart(t)).reduce((a, t) => Math.max(a, partOf(t).i + 1), 0) : 0;
  let total = editorCents, rest = editorCents;
  if (done.length) {
    const T = partOf(done[0]).total, d = done.reduce((a, t) => a + grossOf(t), 0);
    const less = !milestoneId && purpose === "release" && editorCents < T - d;
    if ((editorCents !== T && editorCents !== T - d && !less) || d > T) throw new Error(`payout ${done[0].id} (${T} in parts) exists with a different amount`);
    total = T; rest = less ? editorCents : T - d;
    if (rest === 0) { if (opts.out) { opts.out.transfer = done[0]; opts.out.transfers = done; } return done[0].id; }
  } else {
    const prior = existing.find(same);
    if (prior) {
      if ((p2 ? grossOf(prior) : prior.amount) !== editorCents) throw new Error(`transfer ${prior.id} exists with a different amount`);
      if (opts.out) opts.out.transfer = prior;
      return prior.id;
    }
  }
  // Existing transfers above still need reconciliation; a ban blocks new transfers.
  if (await isBanned(c.editor)) throw fail(BANNED, 409, "under_review");
  const acct = await payoutAccount(c.editor);
  if (!accountReady(acct)) throw fail(NOT_READY, 409, "freelancer_not_ready");
  // the new prices: the payout lines the books lack are written first, then the 5% of this payout (a re-payment after a won
  // chargeback keeps nothing again and does not ask)
  let commission = 0;
  if (p2) {
    const rows = await addCountedPayoutLines(c, existing);
    // an Order with money held apart at Stripe: paid in parts, each linked to the payment it comes from
    if (done.length || await fsMarked(c)) {
      const pools = await heldApartPools(c);
      if (done.length || pools.length) return payInParts(c, { total, rest, done, nextPart, pools, rows, existing, milestoneId, purpose, attemptTag, acct, opts });
    }
    if (purpose === "release") commission = await nextCommission(c, editorCents, existing, rows);
  }
  const sent = editorCents - commission;
  // tie the transfer to the card charge when there is exactly one: Stripe then allows it before the money
  // has settled. Several charges (top-ups) or a re-payment draw on the balance instead.
  const funds = await fundRows(c);
  const charges = [...new Set(funds.map(f => f.charge_ref).filter(isStripeId))]; if (!charges.length && isStripeId(c.stripe_charge_id)) charges.push(c.stripe_charge_id);
  const fundedFrom = funds.length ? funds.length : (c.stripe_payment_intent ? 1 : 0);
  const source = purpose === "release" && charges.length === 1 && fundedFrom <= 1 ? charges[0] : undefined;
  // (under the new prices the key also names the 5%: a retry after other payouts were made meanwhile works it out again, and
  // a request with other amounts under the same key would be refused by Stripe for good)
  const scope = `transfer:${c.id}:${milestoneId || ""}:${purpose}${attemptTag ? ":" + attemptTag : ""}${p2 ? `:${editorCents}-${commission}` : ""}`;
  const body = { amount: sent, currency: (c.currency || "EUR").toLowerCase(), destination: acct.id, transfer_group: `contract_${c.id}`,
    description: `Cuvori order ${c.id}${milestoneId ? " milestone " + milestoneId : ""}`, metadata: { contract_id: c.id, milestone_id: milestoneId || "", purpose, attempt: attemptTag,
      ...(p2 ? { pricing_version: String(c.pricing_version), gross_cents: String(editorCents), commission_cents: String(commission), payout_cents: String(sent) } : {}) } };
  const attempt = async (src, sc) => { const t = await moneyPost(sc, "/transfers", src ? { ...body, source_transaction: src } : body); if (opts.out) opts.out.transfer = t; return t; };
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
// The payout from money held apart (releaseToEditor): what is left of it is taken from the Order's payments held apart,
// oldest first, each as far as it still holds; what they no longer cover (a payment Stripe could not hold apart, money the
// bank took during a chargeback) comes from Cuvori's balance as before. Each part is linked to its payment
// (source_transaction) and sends its share of the 95%; its 5% Stripe moves from the money held apart to Cuvori's own
// balance with the payout (application_fee_amount), so Cuvori's 5% is never left held apart. The 5% goes with the largest
// parts, a part always sending at least a cent.
// Stripe's answers that a payment does not hold enough for a part (yet): an amount that exceeds, or funds insufficient or not
// enough, of what is allocated or available on the payment. Stripe's guide gives no wording for them: any other refusal is
// never read as "still settling" (an account that lost the preview was retried every hour with "nothing needs to be done").
const notEnoughYet = (m) => /exceed|insufficient|\benough\b/i.test(String(m || "")) && /allocat|available|source|balance/i.test(String(m || ""));
// Every part has its own key, named after its payout and its number only (never after what the plan reads from Stripe right
// now): a try whose answer was lost after Stripe made the part, while Stripe's list of transfers does not show it yet, plans
// that part again from what the payments hold now (less: the part took it), under the same key. Stripe then answers "this
// key was used with other amounts", and the payout waits for the next try, which reads Stripe again: it is never paid twice.
// A key goes only after a definite refusal (moneyPost), so a part Stripe refused is planned again with a fresh one.
async function payInParts(c, { total, rest, done, nextPart, pools, rows, existing, milestoneId, purpose, attemptTag, acct, opts }) {
  const k = purpose === "release" ? await nextCommission(c, rest, existing, rows) : 0;
  let left = rest; const plan = [];
  for (const p of pools) { if (left <= 0) break; const g = Math.min(left, p.available + p.pending); if (g > 0) { plan.push({ charge: p.charge, gross: g, commission: 0 }); left -= g; } }
  if (left > 0) plan.push({ charge: null, gross: left, commission: 0 });
  let kl = k;
  for (const p of [...plan].sort((a, b) => b.gross - a.gross)) { p.commission = Math.min(kl, p.gross - 1); kl -= p.commission; }
  if (kl > 0) throw new Error(`the 5% of a payout of ${rest} cents could not be split over its parts`);
  const made = [...done];
  let n = Math.max(nextPart || 0, done.length ? Math.max(...done.map(t => partOf(t).i)) + 1 : 0);
  for (const p of plan) {
    const sent = p.gross - p.commission;
    const scope = `transfer:${c.id}:${milestoneId || ""}:${purpose}${attemptTag ? ":" + attemptTag : ""}:p${n}`;
    const body = { amount: sent, currency: (c.currency || "EUR").toLowerCase(), destination: acct.id, transfer_group: `contract_${c.id}`,
      ...(p.charge ? { source_transaction: p.charge, ...(p.commission > 0 ? { application_fee_amount: p.commission } : {}) } : {}),
      description: `Cuvori order ${c.id}${milestoneId ? " milestone " + milestoneId : ""}`,
      metadata: { contract_id: c.id, milestone_id: milestoneId || "", purpose, attempt: attemptTag, pricing_version: String(c.pricing_version),
        gross_cents: String(p.gross), commission_cents: String(p.commission), payout_cents: String(sent), part: String(n), payout_total_cents: String(total), source_charge: p.charge || "" } };
    let t;
    try { t = await moneyPost(scope, "/transfers", body, { preview: !!p.charge }); }
    catch (e) {
      if (opts.out && made.length) { opts.out.transfer = made[0]; opts.out.transfers = made; }
      // Stripe has this part's key from an earlier try with other amounts (see above): wait, never pay on a guess
      if (idemMismatch(e)) throw fail(UNCONFIRMED, 409, "settling");
      // another request with this part's key is still running at Stripe (the client's click and the hourly run at once): a
      // wait, not a refusal from the money held apart; the key is kept and the next try reads Stripe again
      if (idemBusy(e)) throw fail(PROVIDER_DOWN, 503, "provider_down");
      // the payment does not hold enough for it yet (not settled, or a refund or chargeback on it meanwhile): the next try
      // reads it again. Only Stripe's answers that say so; any other refusal is not a delay (below)
      if (p.charge && e.status === 400 && notEnoughYet(e.message)) throw fail(SETTLING, 409, "settling");
      if (stripeCode(e) === "balance_insufficient" || /insufficient funds/i.test(e.message)) throw fail(SETTLING, 409, "settling");
      if (/capabilit|destination|No such account|payouts/i.test(e.message) && e.status === 400) throw fail(NOT_READY, 409, "freelancer_not_ready");
      if (e.network) throw fail(PROVIDER_DOWN, 503, "provider_down");
      // any other refusal of a part from money held apart (the account no longer has Stripe's preview, a parameter Stripe
      // no longer takes, …): the step's note says so with Stripe's code, and the log has Stripe's own text (failNote)
      if (p.charge && e && e.stripe) e.heldApart = true;
      throw e;
    }
    made.push(t); n++;
  }
  if (opts.out) { opts.out.transfer = made[0]; opts.out.transfers = made; }
  return made[0].id;
}
// Give money back to the client: spread over the payments it came from (top-ups first), each one only
// as far as that payment still allows. Money already given back from the Stripe dashboard (not by Cuvori)
// is already out of the held amount, so it only shrinks what a payment can still return; Cuvori's own
// earlier refunds count towards the plan, so a retry never pays twice. Returns the refund ids.
const OURS = (r) => !!(r.metadata && (r.metadata.contract_id || r.metadata.reason));
// the automatic refund of the processing-fee surplus (see settleFee): Cuvori's own, but never Order money
export const FEE_REFUND = (r) => !!(r && r.metadata && r.metadata.kind === "fee_surplus");
// opts.out.refunds: the refunds this one is made of, each with its amount (under the new prices each gets its own line)
export async function refundToClient(c, cents, opts = {}) {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error("bad refund amount");
  sameMode(c);
  if (chargebackOpen(c)) throw fail(CHARGEBACK, 409, "chargeback_open");
  const funds = await fundRows(c);
  const sources = funds.length ? funds.map(f => ({ pi: f.provider_ref, amount: f.amount_cents })).reverse() : (c.stripe_payment_intent ? [{ pi: c.stripe_payment_intent, amount: nz(c.funded_cents) || centsOf(c) || 0 }] : []);
  if (!sources.length) throw new Error("no payment to refund");
  let plan = [], at = 0;
  try {
    for (const s of sources) {
      if (!isPi(s.pi)) continue;
      const existing = ((await stripe("GET", "/refunds", { payment_intent: s.pi, limit: 50 })).data || []).filter(r => r.status !== "failed" && r.status !== "canceled" && !FEE_REFUND(r));
      s.outside = Math.min(existing.filter(r => !OURS(r)).reduce((a, r) => a + r.amount, 0), s.amount);
      s.done = existing.filter(OURS).reduce((a, r) => a + r.amount, 0);
      s.ids = existing.filter(OURS).map(r => r.id);
      s.ours = existing.filter(OURS).map(r => ({ id: r.id, amount: r.amount, created: r.created }));
      // A payment the bank took back (a lost chargeback) has that much less to give back: Stripe refuses a refund of what
      // it took, every hour again, and the client's money stayed held for ever (audit of 31 October). When Stripe allows no
      // refund on the payment at all any more, it gives back nothing new. What the bank took is already out of the held
      // amount (the chargeback counted it), so the rest comes from the other payments.
      const cb = await chargebackOn(s.pi);
      s.lost = cb.state === "lost" ? Math.min(Number.isInteger(cb.amount) && cb.amount > 0 ? cb.amount : s.amount, s.amount) : 0;
      if (cb.refundable === false) s.lost = Math.max(s.amount - s.outside - s.done, s.lost);
    }
    // what each payment should have given back once this refund is complete (deterministic, so a retry lands on the same plan)
    let left = cents; plan = [];
    for (const s of sources) { if (left <= 0) break; if (!isPi(s.pi)) continue; const part = Math.min(left, s.amount - s.outside - s.lost); if (part <= 0) continue; plan.push({ ...s, cents: part }); left -= part; }
    if (left > 0) throw new Error("refund exceeds what was paid");
    const ids = [], made = [];
    for (const [i, p] of plan.entries()) {
      at = i;
      if (p.done >= p.cents) { ids.push(...p.ids); made.push(...p.ours); continue; }
      const r = await moneyPost(`refund:${c.id}:${p.pi}:${p.done}`, "/refunds", { payment_intent: p.pi, amount: p.cents - p.done, metadata: { contract_id: c.id } });
      ids.push(...p.ids, r.id); made.push(...p.ours, { id: r.id, amount: r.amount, created: r.created });
    }
    if (opts.out) opts.out.refunds = made;
    return ids.join(",");
  } catch (e) {
    if (stripeCode(e) === "balance_insufficient" || /insufficient funds/i.test(e.message)) throw fail(REFUND_SETTLING, 409, "settling");
    // Stripe has two codes for "this payment was charged back, it can't be refunded"
    if (["charge_disputed", "refund_disputed_payment"].includes(stripeCode(e)) || /charged back/i.test(e.message)) throw fail(CHARGEBACK, 409, "chargeback_open");
    // a payment too old for a card refund: refused for good, said plainly with what the client is owed (check of 7 November:
    // "Something went wrong", and a note that only said Stripe refused the request)
    // (what is owed is what of this refund has not gone back yet: the payment Stripe refused and any older one after it;
    // a newer payment's part went back to the card already. Check of 7 November, re-check)
    if (e.status === 400 && (stripeCode(e) === "charge_expired_for_refund" || /too old to be refunded|expired for refund/i.test(e.message))) {
      const owed = plan.length ? plan.slice(at).reduce((a, p) => a + Math.max(p.cents - p.done, 0), 0) : cents;
      throw fail(refundGone(c, owed, Math.max(cents - owed, 0)), 409, "refund_impossible");
    }
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
    // a part paid from money held apart goes back into it (Stripe's docs): the Order is marked again, so the hourly run
    // looks at it once the Order is closed (sweepHeldApart)
    if (isPart(t) && isStripeId(t.metadata.source_charge)) await markHeldApart(c.id).catch(e => console.error("held apart mark", c.id, e.message));
  }
  return { ids: ids.join(","), reversed: cents - left };
}

// ---- the hourly run: money held apart that nobody is owed any more ----
// A closed Order (completed, refunded or cancelled; no chargeback or bank inquiry open) owes nobody anything more, so what
// Stripe still holds apart of its payments is Cuvori's: money pulled back from the freelancer after the client had been
// refunded, or after the bank decided a chargeback for the client. It goes to Cuvori's own balance (Stripe's Balance
// Transfers), and the history says so. Stripe's docs say money pulled back during a chargeback stays held apart whatever
// the bank decides and is moved only on request: when Stripe will not move it, the Order's note asks the owner to write to
// Stripe (and the next run tries again). Money not settled yet waits for the next run. An Order's mark goes once nothing
// of it is held apart any more (a later pull-back marks it again), and with it any note that said Stripe would not move it
// (Stripe support released it, or a re-payment used it). One key per payment and hour: a move whose answer was lost is
// never made twice, and the next hour reads what is left.
// An Order that still owes anybody anything is never swept, closed or not (check of 2 November): money a won chargeback
// pulled back from the freelancer and not paid back yet (its "chargeback won" note, or its pull-back lines not matched by
// re-payments), or money the Order still holds (a refund that failed at Stripe, …). Its mark stays, so it is looked at
// again once that is settled; a note saying nobody is owed goes.
// Every closed Order's mark is reached: the marks are read in pages, the Orders they name are read 100 at a time and only
// the closed ones are worked on (an Order still open keeps its mark for as long as it holds money: reading only the 200
// oldest marks never reached a newer closed Order); one whose money Stripe would not move before goes last.
export const HELD_APART_NOTE = "money held apart at Stripe: ";
const heldNoteOf = (charge) => (n) => n.startsWith(`${HELD_APART_NOTE}${charge} `);
const anyHeldNote = (n) => n.startsWith(HELD_APART_NOTE);
const CLOSED = ["completed", "refunded", "cancelled"];
const FS_PAGE = 1000, FS_PAGES = 20;
export async function sweepHeldApart(over = () => false) {
  let done = 0, waiting = 0; const failed = [];
  const ids = new Set();
  for (let p = 0; p < FS_PAGES; p++) {
    const marks = (await db.select("money_keys", `scope=like.${q("fs:")}*&select=scope&order=created_at.asc&limit=${FS_PAGE}&offset=${p * FS_PAGE}`)) || [];
    for (const { scope } of marks) { const id = String(scope).slice(3); if (isUuid(id)) ids.add(id); }
    if (marks.length < FS_PAGE) break;
  }
  const all = [...ids], closed = [];
  for (let i = 0; i < all.length; i += 100) {
    if (over()) { waiting += all.length - i; break; }
    closed.push(...((await db.select("contracts", `id=in.(${all.slice(i, i + 100).join(",")})&status=in.(${CLOSED.join(",")})&select=*`)) || []));
  }
  const refusedBefore = (c) => (hasNote(c.money_error, anyHeldNote) ? 1 : 0);
  closed.sort((a, b) => refusedBefore(a) - refusedBefore(b));
  for (const c of closed) {
    if (over()) { waiting++; continue; }
    const id = c.id, scope = fsScope(id);
    try {
      if (!CLOSED.includes(c.status) || (c.paid_mode && c.paid_mode !== STRIPE_MODE)) continue;
      if (chargebackOpen(c) || inquiryOpen(c)) continue;
      if (await stillOwes(c)) {
        if (hasNote(c.money_error, anyHeldNote)) await putNote(id, n => dropNote(n, anyHeldNote));
        continue;
      }
      const r = await sweepOrder(c);
      done += r.moved;
      if (!r.left) {
        await db.remove("money_keys", `scope=eq.${q(scope)}`);
        if (hasNote(c.money_error, anyHeldNote)) await putNote(id, n => dropNote(n, anyHeldNote));
      }
    } catch (e) { failed.push({ id, why: "money held apart: " + e.message }); console.error("money held apart", id, e.message); }
  }
  return { done, failed, waiting };
}
// a closed Order that still owes the freelancer (a won chargeback's re-payment not made yet) or still holds money
async function stillOwes(c) {
  if (heldCents(c) > 0 || hasNote(c.money_error, n => n.startsWith("chargeback won"))) return true;
  if (!(await wonDisputes(c)).length) return false;
  const rows = (await db.select("order_payments", `order_id=eq.${c.id}&kind=eq.reversal&select=kind,amount_cents,note`)) || [];
  return (await owedRepays(c, await transfersOf(c), rows)).length > 0;
}
async function sweepOrder(c) {
  let moved = 0, left = false;
  const cur = (c.currency || "EUR").toLowerCase(), hour = Math.floor(Date.now() / 3600e3);
  for (const a of await heldApartPools(c)) {
    if (a.pending > 0) left = true;
    if (a.available <= 0) {
      // nothing of this payment to move (any more): a note that said Stripe would not move it goes
      if (a.pending <= 0 && hasNote(c.money_error, heldNoteOf(a.charge))) await putNote(c.id, n => dropNote(n, heldNoteOf(a.charge)));
      continue;
    }
    try {
      const bt = await moneyPost(`fs_sweep:${c.id}:${a.charge}:${a.available}:${hour}`, "/balance_transfers", { amount: a.available, currency: a.currency || cur,
        source_balance: { type: "allocated_funds", allocated_funds: { type: "charge", charge: a.charge } }, destination_balance: { type: "payments" } }, { preview: true });
      moved++;
      await orderEvent(c, "held_apart_released", { payment: payTag(a.pi), amount_cents: a.available, ...(bt && typeof bt.id === "string" ? { balance_transfer: bt.id.slice(0, 80) } : {}) }, null);
      if (hasNote(c.money_error, heldNoteOf(a.charge))) await putNote(c.id, n => dropNote(n, heldNoteOf(a.charge)));
    } catch (e) {
      if (retryable(e)) throw e;
      left = true;
      const text = `${HELD_APART_NOTE}${a.charge} still holds ${(a.available / 100).toFixed(2)} ${cur.toUpperCase()} of this closed Order that nobody is owed, and Stripe did not move it to Cuvori's balance (money pulled back during a chargeback is moved only on request). Ask Stripe support to release it; the hourly run tries again.`;
      if (!hasNote(c.money_error, n => n === text)) await putNote(c.id, n => addNote(n, text, heldNoteOf(a.charge)));
    }
  }
  return { moved, left };
}

// ---- Cuvori's decision, on record before it is carried out ----
// An admin's decision is carried out only once it is on record: its "decision" history line, which names it by its claim
// time (resolved_at; stripe-resolve writes it). When that line could not be saved, the admin was told nothing had moved and
// to try again, yet ten minutes later the hourly run carried the decision out without it: no record, no admin log, no
// written decision to the two people, no "lost a dispute" mark (check of 2 November). The hourly run now leaves such a
// decision as it is and says so on the Order, once; the admin's next decision on the Order records it (the same decision is
// then carried out, a different one takes its place, as nothing of it has moved). The freelancer giving the Order back (a
// 'refund' they claimed themselves, its history line "cancelled") is not Cuvori's decision and is finished as before.
export const DECISION_NOTE = "decision not on record: ";
const isDecisionNote = (n) => n.startsWith(DECISION_NOTE);
export const freelancerCancel = (c) => c.resolution === "refund" && !!c.resolved_by && c.resolved_by === c.editor;
// An Order that closes: the notes of money steps that stopped go (nothing on it can move any more), and so does a "decision
// not on record" note: nothing is left to decide (check of 6 November: an Order a chargeback had closed kept asking the
// admin to decide it again, and deciding it was refused, "not holding money")
const closedNote = (note) => dropNote(stepsOver(note), n => isDecisionNote(n) || isShortNote(n));
// A part worth more than its Order still holds (money went back to the client: a refund or a chargeback; and no price
// increase is still to be paid in) can't be paid out as it is: it waits for Cuvori's decision. Said on the Order once per
// part, by the client's approval that is refused and by the hourly run that sets it aside (check of 6 November: it waited
// without a word to anyone). It goes once the Order is decided or closed; its words never start like the notes the hourly
// run works from.
const isShortNote = (n) => n.startsWith('part "') && n.includes(" is worth more than this Order still holds ");
export async function noteShortPart(c, m) {
  if (!c || !m || owedCents(c) >= MIN_TOPUP_CENTS || !(nz(m.amount_cents) > heldCents(c))) return;
  const scope = `short_part:${m.id}`;
  if (!(await claimScope(scope).catch(() => false))) return;
  const cur = String(c.currency || "").toUpperCase(), amt = (x) => `${(nz(x) / 100).toFixed(2)} ${cur}`;
  const text = `part "${cut(String(m.title || ""), 80)}" (${amt(m.amount_cents)}) is worth more than this Order still holds (${amt(heldCents(c))}): money went back to the client (a refund or a chargeback), so it can't be paid out as it is. Decide the Order in the admin panel (part ${m.id})`;
  const row = await putNote(c.id, n => addNote(n, text));
  if (!row || !hasNote(row.money_error, n => n === text)) await dropKey(scope);                      // not written: the next try writes it
}
export async function decisionOnRecord(c) {
  const attempt = String(c.resolved_at || "");
  return ((await db.select("order_events", `order_id=eq.${c.id}&event=eq.decision&select=data`)) || []).some(e => e && e.data && e.data.attempt === attempt);
}
// The hourly run, for an Order in 'resolving': true when it must wait for the admin (a decision of Cuvori's not on record)
export async function decisionMissing(c) {
  if (!c || c.status !== "resolving" || freelancerCancel(c) || await decisionOnRecord(c)) return false;
  const scope = `decision_note:${c.id}:${String(c.resolved_at || "")}`;
  if (await claimScope(scope)) {
    const text = `${DECISION_NOTE}Cuvori's '${c.resolution}' decision could not be saved in the Order's history, so nothing of it has moved and it is not carried out. Decide this Order again in the admin panel: the same decision is then carried out, a different one takes its place`;
    const row = await putNote(c.id, n => addNote(n, text, isDecisionNote));
    if (!row || !hasNote(row.money_error, isDecisionNote)) await dropKey(scope);                      // not written: the next run writes it
    // saved in the very moment the note was written (the admin's try again): the note is wrong, it goes (it stayed for
    // good, check of 6 November); the decision is carried out by that try, or by the next run
    else if (await decisionOnRecord(c)) await putNote(c.id, n => dropNote(n, isDecisionNote));
    else console.error("a decision not on record is not carried out: the admin decides again", c.id, c.resolution);
  }
  return true;
}
// Cuvori's decision told to both sides once: the written reason in their chat, and (when a side opened the dispute) the "lost
// a dispute" mark on the side that lost it. Once per decision (its claim time names it), by whichever step carries it out:
// the admin's first try, the admin's try again, or the hourly run. Only the first try did it before (check of 7 November: a
// decision whose saved history line got no answer was carried out by the retry or the hourly run, and neither side was told
// why). The history line (its actor, its decision, its note) says what to tell; one not on record tells nothing.
export async function announceDecision(c, at = null) {
  const attempt = String(at || (c && c.resolved_at) || "");
  if (!attempt || !c.conversation_id) return false;
  const scope = `decision_told:${c.id}:${attempt}`;
  try {
    if (await db.one("money_keys", `scope=eq.${q(scope)}&select=scope`)) return true;
    const all = (await db.select("order_events", `order_id=eq.${c.id}&event=eq.decision&select=actor,data`)) || [];
    const ev = all.find(e => e && e.data && e.data.attempt === attempt);
    if (!ev || !isUuid(ev.actor)) return false;
    // a decision an older version made: that version told it in its first try (and only there), so it is never told again
    // (check of 8 November: on the update day the hourly run told the last 7 days' decisions again: a "lost a dispute" mark
    // the admin had removed came back, and with the database's clock a second behind, the message was sent twice)
    if (ev.data.tell_once !== true) {
      await db.insert("money_keys", { scope, key: "told by an older version" }).catch(() => {});
      return true;
    }
    // a decision another one replaced before it was carried out is never told (check of 7 November, re-check: the hourly run
    // told a replaced 'release' after the 'refund' that replaced it, and marked the client as having lost)
    if (all.some(e => e && e.data && e.data.replaced && e.data.replaced.at === attempt)) {
      await db.insert("money_keys", { scope, key: "replaced" }).catch(() => {});
      return true;
    }
    // Under the Order's lock, so the admin's try again and the hourly run never tell it at the same moment. Each part is
    // looked up before it is written (never twice), and the key that says "told" is written last: an answer lost on the way
    // (or a moment the database refused) is told by the next try, never left untold (check of 7 November, re-check: a key
    // taken first whose answer was lost kept every later try from telling anyone)
    const unlock = await lockOrder(c.id);
    try {
      const decision = ev.data.decision, note = typeof ev.data.note === "string" ? ev.data.note : "";
      // the side that lost a dispute it opened or was in: only a dispute a side opened itself (its history line names them),
      // never one recorded for a refund made outside Cuvori or for a bank chargeback, which are not the two sides' dispute
      // (an Order with no such history line at all, from before the history was kept: who the Order says opened it)
      const lines = (await db.select("order_events", `order_id=eq.${c.id}&event=eq.disputed&select=actor,data`)) || [];
      const opened = lines.length ? lines.some(e => e && [c.client, c.editor].includes(e.actor) && !(e.data && e.data.outside_refund)) : [c.client, c.editor].includes(c.dispute_by) && !!c.disputed_at;
      const loser = !opened ? null : decision === "refund" ? c.editor : decision === "release" ? c.client : null;
      // (each of the two on its own: one the database refuses does not hold back the other)
      let ok = true;
      // never the same person twice for the same Order
      try {
        if (loser && !(await db.one("user_flags", `user_id=eq.${loser}&contract_id=eq.${c.id}&kind=eq.dispute_lost&select=id`)))
          await db.insert("user_flags", { user_id: loser, kind: "dispute_lost", reason: `Lost dispute on "${cut(c.title, 200)}"${note ? ": " + note : ""}`, contract_id: c.id, created_by: ev.actor });
      } catch (e) { ok = false; console.error("the decision's \"lost a dispute\" mark not saved yet", c.id, e && e.message); }
      // a decision that replaced one already told (it was told, then could not be carried out: the freelancer could not be
      // paid, for example): the side the replaced one marked as having lost, and who did not lose this one, has that mark
      // taken back (check of 8 November: the client whose 'release' was replaced by a 'refund' stayed marked as having lost)
      try {
        const was = ev.data.replaced && ev.data.replaced.decision;
        const wasLoser = !opened ? null : was === "refund" ? c.editor : was === "release" ? c.client : null;
        if (wasLoser && wasLoser !== loser) await db.remove("user_flags", `user_id=eq.${wasLoser}&contract_id=eq.${c.id}&kind=eq.dispute_lost`);
      } catch (e) { ok = false; console.error("the replaced decision's \"lost a dispute\" mark not taken back yet", c.id, e && e.message); }
      // both sides read the written decision before the money moves (a decision told by an older version is never told twice)
      try {
        // (the message names its Order and decision, so another Order of the same two people decided with the same words is
        // never taken for it; one an older version wrote, which names nothing, counts only when written right after the
        // decision was saved, as that version did. Check of 7 November, re-check)
        const body = `Cuvori decision: ${note}`;
        const same = note ? ((await db.select("messages", `conversation_id=eq.${c.conversation_id}&kind=eq.text&sender=eq.${ev.actor}&body=eq.${q(body)}&select=id,payload,created_at`)) || []) : [];
        const told = same.some(m => m.payload && m.payload.decision_of === c.id && m.payload.attempt === attempt);
        if (note && !told) await db.insert("messages", { conversation_id: c.conversation_id, sender: ev.actor, kind: "text", body, payload: { decision_of: c.id, attempt } });
      } catch (e) { ok = false; console.error("the decision's chat message not saved yet", c.id, e && e.message); }
      if (ok) await db.insert("money_keys", { scope, key: "told" }).catch(e => { if (e.status !== 409) console.error("decision told: key not saved (the next try looks again)", c.id, e.message); });
      return ok;
    } finally { await unlock(); }
  } catch (e) { console.error("the decision could not be told to both sides yet; the next try tells it", c.id, e && e.message); return false; }
}
// The hourly run: Cuvori's decisions of the last 7 days not told yet (the database refused it at the time, and the decision
// was carried out all the same) are told now, once.
export async function tellDecisions() {
  const since = q(new Date(Date.now() - 7 * 86400e3).toISOString());
  const evs = (await db.select("order_events", `event=eq.decision&created_at=gt.${since}&select=order_id,data&order=created_at.desc&limit=200`)) || [];
  let told = 0;
  for (const e of evs) {
    const attempt = e && e.data && typeof e.data.attempt === "string" ? e.data.attempt : "";
    if (!attempt || !isUuid(e.order_id)) continue;
    if (await db.one("money_keys", `scope=eq.${q(`decision_told:${e.order_id}:${attempt}`)}&select=scope`)) continue;
    const c = await db.contract(e.order_id).catch(() => null);
    // only a decision carried out (the Order closed by it): one still under way, or put back to the admin, is told by the
    // step that carries it out, and one replaced before that never (check of 8 November: the hourly run told a 'release'
    // whose answer was lost before it was carried out; the admin then replaced it, and both sides got both decisions)
    if (!c || !["completed", "refunded"].includes(c.status)) continue;
    if (await announceDecision(c, attempt)) told++;
  }
  return told;
}
// the decision is on record now: the note saying it was not goes
export async function decisionRecorded(c) {
  if (c && hasNote(c.money_error, isDecisionNote)) await putNote(c.id, n => dropNote(n, isDecisionNote));
}

// Finish an Order that is in 'releasing' / 'resolving' using the amounts recorded when it was claimed.
// Whatever was already released for milestones stays where it is; this settles the remainder.
export async function settle(c0, actor, ev) {
  const unlock = await lockOrder(c0.id);
  try { return await settleLocked(c0, actor, ev); } finally { await unlock(); }
}
// The Order's paid-out total follows Stripe's own record of its payouts, once every payout has been counted in this pass
// (check of 6 November, second round). Each payout the books didn't show is counted by the gap between that total and the
// lines ("already in the total, only its line was lost", or not). With two of them at once (a part's line lost, and the
// count of a re-payment refused) the gap can't tell which one the total already had: a payout was counted twice or left
// out, and a cancel or a decision then sent the client too much or kept part of their money at Cuvori. The total is then
// set to what Stripe's record says. Today's prices: every payout's amount less the pull-backs on record; the new prices:
// every payout's full amount (with the 5%) less the pull-backs on record (as syncReversalsV2). A payout of the decision being
// carried out that is not counted yet is left out: its own step counts it. Nothing is changed when the books name a payout
// Stripe does not list (an Order from before payouts carried their Order), when the list may be cut short, when a payout
// still has no line, or (today's prices) when a pull-back at Stripe is not on record.
async function paidOutFollowsStripe(c, ts, rows) {
  if (!c || ts.length >= 100) return c;
  const p2 = isPlan2(c), attempt = String(c.resolved_at || "");
  const ownUncounted = (t) => !!attempt && (t.metadata.attempt || "") === attempt && !(t.metadata.milestone_id || "") && !hasLine(rows, "release", t.id) && (p2 || c.stripe_transfer_id !== t.id);
  const mine = ts.filter(t => !ownUncounted(t));
  // a payout left out that a chargeback pulled back: its pull-back is on the lines, its payout is not, so the lines say less
  // than the freelancer has (check of 7 November: the total fell to Stripe's record less that pull-back, and the hourly run
  // then paid a whole Order of 200.00 a second time). Its own step counts it first (settleLocked).
  if (ts.some(t => ownUncounted(t) && nz(t.amount_reversed) > 0)) return c;
  if (mine.some(t => !hasLine(rows, "release", t.id) && !(p2 ? false : t.reversed || t.amount - nz(t.amount_reversed) <= 0))) return c;
  const ids = new Set(ts.map(t => t.id));
  if (rows.some(r => r.kind === "release" && !ids.has(r.provider_ref))) return c;
  const pulled = sumKind(rows, "reversal");
  if (!p2 && pulled !== ts.reduce((a, t) => a + nz(t.amount_reversed), 0)) return c;
  // (today's prices: what the freelancer has of each payout; the guard above makes the pull-backs on the lines exactly Stripe's)
  const truth = p2 ? mine.reduce((a, t) => a + grossOf(t), 0) - pulled : mine.reduce((a, t) => a + t.amount - nz(t.amount_reversed), 0);
  if (!Number.isSafeInteger(truth) || truth < 0 || truth === nz(c.released_cents)) return c;
  const upd = await db.update("contracts", `id=eq.${c.id}&${eqOrNull("released_cents", c.released_cents)}`, { released_cents: truth })
    .catch(e => { console.error("the paid-out total could not follow Stripe's record", c.id, e && e.message); return null; });
  if (!upd || !upd[0]) return c;
  console.error("the Order's paid-out total follows Stripe's record", c.id, nz(c.released_cents), "->", truth);
  return upd[0];
}
// Today's prices: a re-payment to the freelancer after a won chargeback that Stripe made but the Order does not count (its
// answer was lost, or the count right after it was refused) is the freelancer's money already. It is counted and written
// down before anything is worked out from what the Order holds: the paid-out total is raised by what the freelancer still
// has of it, unless the total is already ahead of the books by it (then only its line was lost). Under the Order's lock, by
// the re-payment's own step and by every settlement (check of 6 November: a cancel, a 'refund' or a 'release' made before
// Stripe sent the notice again, or before the hourly run, gave the client back the freelancer's re-paid money, or paid the
// freelancer again: 160.00 out of 100.00 paid in). rows: the Order's release and reversal lines (the ones written are added).
async function countRepaysP1(c, ts, rows) {
  const pulledBackBooked = sumKind(rows, "reversal") >= ts.reduce((a, t) => a + nz(t.amount_reversed), 0);
  let counted = 0;
  for (const t of ts.filter(t => repayOf(t) && !hasLine(rows, "release", t.id))) {
    const net = t.amount - nz(t.amount_reversed);
    if (net <= 0) continue;
    const lineCents = pulledBackBooked ? t.amount : net;
    if (nz(c.released_cents) - (sumKind(rows, "release") - sumKind(rows, "reversal")) < lineCents) {
      const upd = await db.update("contracts", `id=eq.${c.id}&${eqOrNull("released_cents", c.released_cents)}`, { released_cents: nz(c.released_cents) + net });
      if (!upd || !upd[0]) throw new Error("the Order changed while a re-payment was counted");
      c = upd[0]; counted += net;
      console.error("a re-payment at Stripe the Order did not count is counted", c.id, t.id, net);
    }
    if (!(await ledger(c, { kind: "release", amount_cents: lineCents, provider_ref: t.id, note: "chargeback_won" }, `kind=eq.release&note=like.chargeback_won*&provider_ref=eq.${q(t.id)}`)))
      await putNote(c.id, n => addNote(n, `${REPAY_LINE_NOTE}${t.id} (${lineCents} paid again after chargeback ${repayOf(t)}; the hourly run adds it from Stripe's record; if this note stays, check by hand)`));
    rows.push({ kind: "release", amount_cents: lineCents, provider_ref: t.id });
  }
  return { c, counted };
}
// Today's prices: every payout of the Order at Stripe that the books don't show is counted and written down before anything is
// worked out from what the Order holds: a whole-order payout of an earlier decision that broke off, a part's payout, a
// re-payment after a won chargeback. Used by every settlement and by the re-payment's own step, which a cancel or a decision
// runs first (repayFirst): both work out what the Order holds the same way (check of 6 November, second round: the cancel
// worked out 70.00 where the settlement then moved 40.00). rows: the Order's lines (kind, provider_ref, amount_cents; the
// ones written are added); ts0: its payouts at Stripe; ev: the note of a whole-order payout's line.
async function countUnbookedP1(c, rows, ts0, ev) {
  const sumOf = (kind) => sumKind(rows, kind);
  const line = async (kind, cents, ref) => db.insert("order_payments", { order_id: c.id, provider: "stripe", status: "succeeded", kind, amount_cents: cents, provider_ref: String(ref).slice(0, 200), note: ev }).catch(e => console.error("ledger", e.message));
  // a whole-order transfer at the provider that the books do not show (an earlier decision that broke off before it
  // could be written down) is the freelancer's money already: it is counted before anything else moves
  // A chargeback's pull-back may have brought such a transfer into the counter already (it sets the counter to Stripe's
  // net of all the Order's transfers, and books the pull-back): then only its line is written, for the whole transfer, and
  // nothing is counted twice (check of 1 November: counted twice, the decision moved nothing and the chargeback's amount
  // stayed with Cuvori). Otherwise the counter is raised by what the freelancer still has of it.
  const pulledBackBooked = sumOf("reversal") >= ts0.reduce((a, t) => a + nz(t.amount_reversed), 0);
  // (one a chargeback pulled back in full is counted too: its pull-back is on the lines, so its line is the whole transfer)
  for (const t of ts0.filter(t => !(t.metadata.milestone_id || "") && (t.metadata.purpose || "release") === "release" && t.metadata.attempt && t.metadata.attempt !== String(c.resolved_at || "") && !rows.some(r => r.kind === "release" && r.provider_ref === t.id))) {
    const net = t.amount - nz(t.amount_reversed);
    const lineCents = pulledBackBooked ? t.amount : net;                    // with its pull-back booked, the line is the whole transfer
    if (lineCents <= 0) continue;
    const inCounter = nz(c.released_cents) - (sumOf("release") - sumOf("reversal")) >= lineCents;   // the counter already shows it, line or not
    if (!inCounter && net > 0) {
      const upd = await db.update("contracts", `id=eq.${c.id}&status=eq.${c.status}`, { released_cents: nz(c.released_cents) + net });
      if (!upd || !upd[0]) throw new Error("order changed during settlement");
      c = upd[0];
    }
    await line("release", lineCents, t.id); rows.push({ kind: "release", provider_ref: t.id, amount_cents: lineCents });
    console.error("counted a transfer the books did not show", c.id, t.id, net, inCounter ? "(already in the counter)" : "");
  }
  // a milestone payout at the provider that the books don't show (its counter or its line failed after Stripe paid it, or
  // Stripe's answer was lost) is the freelancer's money already: counted before anything moves, so a decision never pays
  // it again or refunds it (audit of 31 October). The counter is raised only when it doesn't include the payout yet.
  // A chargeback may have pulled it back since, in part or in full (its answer was lost before the bank's chargeback came):
  // the part was paid out all the same, so it is counted the same way (its line is the whole payout once the pull-back is on
  // the lines) and never paid again (check of 7 November: the hourly run paid the part a second time, or counted it twice).
  for (const t of ts0.filter(t => (t.metadata.milestone_id || "") && (t.metadata.purpose || "release") === "release" && !rows.some(r => r.kind === "release" && r.provider_ref === t.id))) {
    const net = t.amount - nz(t.amount_reversed);
    const lineCents = pulledBackBooked ? t.amount : net;
    if (lineCents > 0) {
      const inCounter = nz(c.released_cents) - (sumOf("release") - sumOf("reversal")) >= lineCents;
      if (!inCounter && net > 0) {
        const upd = await db.update("contracts", `id=eq.${c.id}&status=eq.${c.status}`, { released_cents: nz(c.released_cents) + net });
        if (!upd || !upd[0]) throw new Error("order changed during settlement");
        c = upd[0];
      }
      await db.insert("order_payments", { order_id: c.id, provider: "stripe", status: "succeeded", kind: "release", milestone_id: t.metadata.milestone_id, amount_cents: lineCents, provider_ref: t.id, note: "milestone payout counted at settlement" })
        .catch(e => console.error("ledger", c.id, e.message));
      rows.push({ kind: "release", provider_ref: t.id, amount_cents: lineCents });
    }
    await partPaid(c, t.metadata.milestone_id, t.id);
    console.error("counted a milestone payout the books did not show", c.id, t.id, t.amount, nz(t.amount_reversed));
  }
  // and a re-payment after a won chargeback that Stripe made but the Order did not count yet (check of 6 November)
  ({ c } = await countRepaysP1(c, ts0, rows));
  // then the paid-out total follows Stripe's record, once every payout has its line (check of 6 November, second round)
  return paidOutFollowsStripe(c, ts0, rows);
}
// Today's prices: the payout of the release or decision under way (its claim time names it) that Stripe made and the books
// don't show (an earlier try made it, and its answer or its count was lost), counted and written down, and never made
// again. A chargeback may have pulled it back since, in part or in full: the payout was made all the same (check of 7
// November: pulled back in full, it was not found, the paid-out total fell by its pull-back, and the hourly run paid a whole
// Order of 200.00 a second time). rows: the Order's lines (this payout's is added). { c, own }: own is that payout, when
// there is one (counted now, or in the books already).
async function countOwnP1(c, ts0, rows, note) {
  const sumOf = (kind) => rows.filter(r => r.kind === kind).reduce((a, r) => a + r.amount_cents, 0);
  const attempt = String(c.resolved_at || "");
  const own = attempt ? ts0.find(t => (t.metadata.attempt || "") === attempt && !(t.metadata.milestone_id || "") && (t.metadata.purpose || "release") === "release") : null;
  if (!own || hasLine(rows, "release", own.id)) return { c, own };
  const net = own.amount - nz(own.amount_reversed);
  const lineCents = sumOf("reversal") >= ts0.reduce((a, t) => a + nz(t.amount_reversed), 0) ? own.amount : net;
  const inCounter = nz(c.released_cents) - (sumOf("release") - sumOf("reversal")) >= lineCents;
  const upd = await db.update("contracts", `id=eq.${c.id}&status=eq.${c.status}`, { stripe_transfer_id: own.id, ...(inCounter || net <= 0 ? {} : { released_cents: nz(c.released_cents) + net }) });
  if (!upd || !upd[0]) throw new Error("order changed during settlement");
  c = upd[0];
  if (lineCents > 0) {
    await db.insert("order_payments", { order_id: c.id, provider: "stripe", status: "succeeded", kind: "release", amount_cents: lineCents, provider_ref: own.id, note }).catch(e => console.error("ledger", e.message));
    rows.push({ kind: "release", provider_ref: own.id, amount_cents: lineCents });
  }
  console.error("the payout under way at Stripe is counted", c.id, own.id, own.amount, nz(own.amount_reversed), inCounter ? "(already in the counter)" : "");
  return { c, own };
}
// Every payout of the Order at Stripe the books don't show (its answer was lost), the payout of a release or decision under
// way included, counted and written down before a chargeback is worked out (under the Order's lock): what the bank takes
// that the freelancer's balance can't give back is then seen, and said (check of 8 November: a payout whose answer was lost,
// then a chargeback whose pull-back Stripe refused, decided for the client: the freelancer kept the money, the books never
// showed the payout, and the Order said nothing of what Cuvori lost). A payout paid in pieces that is not whole yet is left to
// its own step.
async function countAllAtChargeback(c, disputeId) {
  if (!c || c.payment_mode !== "escrow" || (c.paid_mode && c.paid_mode !== STRIPE_MODE)) return c;
  const ev = `payout counted at chargeback ${disputeId}`;
  const ts = await transfersOf(c);
  const todo = ts.filter(t => !isPart(t) || payoutWhole(ts, t));
  if (!todo.length) return c;
  if (isPlan2(c)) {
    const rows = await linesOf(c);
    if (!todo.some(t => !hasLine(rows, "release", t.id))) return c;
    return (await bookUnbookedV2(c, todo, ev, true)).c;
  }
  const rows = (await db.select("order_payments", `order_id=eq.${c.id}&status=eq.succeeded&select=kind,provider_ref,amount_cents`)) || [];
  if (!todo.some(t => !hasLine(rows, "release", t.id))) return c;
  // (the other payouts first, the one under way last: a total ahead of the lines is the older payouts' before it is the
  // newest one's; check of 8 November, re-check: a part's line was refused, and the decision's payout was taken for it)
  c = await countUnbookedP1(c, rows, todo, ev);
  return (await countOwnP1(c, todo, rows, ev)).c;
}
// Money the database refuses to take for good (the books would show more paid out and given back than was paid in, for
// example: a refund made in the Stripe dashboard after a payout the books did not show yet). Retrying never helps.
const refusedForGood = (e) => /violates (check|foreign key|not-null) constraint|contracts_money_sane/i.test(String(e && e.message || ""));
export const UNCOUNTED_HEAD = "payouts not in the books: ";
// Said on the Order for a person (never in the way of anything): Stripe made payouts for the Order that its books don't show,
// and they could not be counted. It stays until a person marks it as handled: the books taking those payouts later never
// shows that money did not go out twice (re-check of 9 November: dropped when a cancel's or a decision's count went
// through, it went while the decision's own payout, never counted there, or a chargeback lost with the pull-back refused
// had left Cuvori short). Saved or not: one that can't be saved fails the step that needs it (Stripe sends its notice
// again, the hourly run tries again, the person is asked to try again in a minute), never leaving the books without it
// (re-check of 9 November: with no answer from the database right then, there was no note at all).
async function noteUncounted(c, e, where) {
  // (the database's own words are in the log; the note stays short enough to be read whole)
  console.error("payouts at Stripe the books can't take", c.id, where, e && e.message);
  const text = `${UNCOUNTED_HEAD}Stripe made payouts for this Order that its books don't show and can't take (refused ${where}). Money may have gone out twice (a refund in the Stripe dashboard after a payout?): check its payouts and refunds in the Stripe dashboard`;
  const row = await putNote(c.id, n => addNote(n, text.slice(0, 300), x => x.startsWith(UNCOUNTED_HEAD))).catch(x => { console.error("note", c.id, x && x.message); return null; });
  return !!(row && hasNote(row.money_error, x => x.startsWith(UNCOUNTED_HEAD)));
}
// the note above, or the step fails (no answer: Stripe sends the notice again, the hourly run tries again)
async function mustNoteUncounted(c, e, where) {
  if (!(await noteUncounted(c, e, where))) { const x = new Error(`the note about payouts not in the books of order ${c.id} could not be saved`); x.outcomeUnknown = true; throw x; }
}
async function settleLocked(c0, actor, ev) {
  // fresh row: the amounts were decided when the Order was claimed, and a milestone release that was already
  // running at that moment may have moved money since. Whatever is settled here never exceeds what is held now.
  let c = (await db.contract(c0.id)) || c0;
  if (chargebackOpen(c)) throw fail(CHARGEBACK, 409, "chargeback_open");
  if (c.status !== c0.status) throw fail("The order changed a moment ago — reload the page.", 409, "order_changed");
  if (isPlan2(c)) return settleLockedV2(c, actor, ev);
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
  // every payout at Stripe the books don't show is counted and written down before anything moves (countUnbookedP1)
  const ts0 = await transfersOf(c);
  c = await countUnbookedP1(c, rows, ts0, ev);
  // This decision's own payout at Stripe (an earlier try made it, and its answer or its count was lost) is counted the same
  // way, after the others (a total ahead of the lines is theirs first: check of 8 November, re-check), and never made again
  if (!doneT) { const r = await countOwnP1(c, ts0, rows, ev); c = r.c; if (r.own) { transferId = r.own.id; doneT = true; } }
  let pendE = doneT ? 0 : editorCents, pendR = doneR ? 0 : refundCents;
  // what a won chargeback pulled back from the freelancer and is not paid back to them yet is theirs, never part of the
  // decision (paid to them once the Order is closed, below): the decision moves at most the rest (check of 2 November)
  const owed = await owedBack(c);
  const held = Math.max(heldCents(c) - owed, 0);
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
  u = await settledNotes(u);
  await orderEvent(u, ev === "approve" ? "released" : ev === "auto_release" ? "auto_released" : ev.startsWith("resolved") ? "resolved" : ev, { editor_cents: movedE, refund_cents: movedR, decision: u.resolution }, actor);
  await contractEvent(u, ev, actor, { amount_cents: movedE || movedR });
  return repayAfterSettle(u, owed);
}
// A settlement that went through: every stopped step's note goes, and so does a "decision not on record" note: the decision
// is carried out, nothing is left to decide
async function settledNotes(u) {
  u = await stepDone(u, STEP_NOTE + " (");
  const over = (n) => isDecisionNote(n) || isShortNote(n);
  return hasNote(u.money_error, over) ? (await putNote(u.id, n => dropNote(n, over))) || u : u;
}
// The Order is closed: what a won chargeback pulled back from the freelancer and was still owed to them is paid to them now
// (under the Order's lock, as the settlement). One that can't be made now (their Stripe account not ready) keeps its note
// and the hourly run tries again; the settlement itself is done either way.
async function repayAfterSettle(u, owed) {
  if (!(owed > 0) || u.chargeback_status !== "won") return u;
  try { await repayWonLocked(u); } catch (e) { console.error("re-payment after the settlement", u.id, e && e.message); }
  return (await db.contract(u.id).catch(() => null)) || u;
}

// ---- settling an Order at the new prices ----
// Counted and written down: a transfer of the Order at Stripe. The Order's paid-out total is raised by its full amount (with
// the 5%) unless the books already count it (its line was lost after the counter was raised: the counter is then ahead of
// the lines by at least that much), and its line is written. setId: the decision's own payout, named on the Order.
const byCreated = (a, b) => (a.created || 0) - (b.created || 0);
async function bookTransfer(c, t, rows, { late = false, note = null, setId = false } = {}) {
  if (hasLine(rows, "release", t.id)) return c;
  const g = grossOf(t);
  const gap = nz(c.released_cents) - (sumKind(rows, "release") - sumKind(rows, "reversal"));
  if (gap < g || (setId && c.stripe_transfer_id !== t.id)) {
    const patch = { ...(gap < g ? { released_cents: nz(c.released_cents) + g } : {}), ...(setId ? { stripe_transfer_id: t.id } : {}) };
    const upd = await db.update("contracts", `id=eq.${c.id}&status=eq.${q(c.status)}&${eqOrNull("released_cents", c.released_cents)}`, patch);
    if (!upd || !upd[0]) throw new Error("order changed during settlement");
    c = upd[0];
  }
  const line = payoutLine(t, { late, note });
  if (!(await ledger(c, line, byKey("release", t.id)))) throw new Error(`the payout line of transfer ${t.id} could not be saved`);
  rows.push(line);
  return c;
}
// Cuvori's refunds on the Order's payments at Stripe (never the card-fee refund or a late payment's), oldest first
async function ourRefundsAtStripe(c) {
  const pis = [...new Set([c.stripe_payment_intent, ...(await savedFundRows(c)).map(r => r.provider_ref)].filter(isPi))];
  const out = [];
  for (const pi of pis) out.push(...(((await stripe("GET", "/refunds", { payment_intent: pi, limit: 100 })).data) || [])
    .filter(r => r && isStripeId(r.id) && r.status !== "failed" && r.status !== "canceled" && OURS(r) && !FEE_REFUND(r) && r.metadata.kind !== "late_payment"));
  return out.sort(byCreated);
}
// one line per Stripe refund, each with its own amount
async function refundLines(c, refunds, rows, note) {
  for (const r of refunds) {
    if (hasLine(rows, "refund", r.id)) continue;
    const line = { kind: "refund", amount_cents: r.amount, provider_ref: r.id, entry_key: entryKey("refund", r.id), note };
    if (!(await ledger(c, line, byKey("refund", r.id)))) throw new Error(`the refund line of ${r.id} could not be saved`);
    rows.push(line);
  }
}
// The chargebacks the bank decided for Cuvori on this Order: the one it records, and earlier ones (their "chargeback won"
// history line, saved every time under the new prices)
async function wonDisputes(c) {
  const ev = (await db.select("order_events", `order_id=eq.${c.id}&event=eq.chargeback_won&select=data`)) || [];
  const ids = new Set(ev.map(e => e && e.data && e.data.chargeback).filter(x => typeof x === "string" && /^(dp|du)_[A-Za-z0-9_]{1,200}$/.test(x)));
  if (c.chargeback_status === "won" && isStripeId(c.chargeback_id)) ids.add(c.chargeback_id);
  return [...ids];
}
// what each won chargeback pulled back from the freelancer and has not paid back yet (its pull-back lines name it, its
// re-payments at Stripe name it in their purpose). A re-payment counts at its full amount: a pull-back takes from the newest
// transfer first, so a LATER chargeback's pull-back takes from this one's re-payment, and that is the later chargeback's own
// business (its own pull-back line, its own re-payment if won, the bank's if lost). Counted net of that pull-back, the
// re-payment read as "still owed" for ever, and a cancel or decision then kept 5.00 of the client's money at Cuvori, or paid
// the freelancer 5.00 twice (check of 2 November, second round).
async function owedRepays(c, ts, rows) {
  const out = [];
  for (const d of await wonDisputes(c)) {
    const pulled = rows.filter(r => r.kind === "reversal" && r.note === `chargeback ${d}`).reduce((a, r) => a + r.amount_cents, 0);
    const repaid = ts.filter(t => repayOf(t) === d).reduce((a, t) => a + t.amount, 0);
    if (pulled - repaid > 0) out.push({ id: d, owed: pulled - repaid });
  }
  return out;
}
// What won chargebacks pulled back from the freelancer and is not paid back to them yet (both price plans). It is the
// freelancer's money, for work already approved or paid out: never part of what a cancel or Cuvori's decision divides
// between the two sides (check of 2 November: after a won chargeback, the freelancer giving the rest back, or Cuvori's
// 'refund', sent the client the freelancer's pay for a part the client had approved). Never more than the Order holds.
export async function owedBack(c, ts) {
  const ds = await wonDisputes(c);
  if (!ds.length) return 0;
  const rows = (await db.select("order_payments", `order_id=eq.${c.id}&kind=eq.reversal&select=kind,amount_cents,note`)) || [];
  const owed = (await owedRepays(c, ts || await transfersOf(c), rows)).reduce((a, d) => a + d.owed, 0);
  return Math.min(owed, heldCents(c));
}
// settleLocked under the new prices: every transfer at Stripe is in the books at its full amount (with the 5%), one line
// per Stripe object (each payout, each refund), and money a won chargeback pulled back from the freelancer is paid back to
// them as its re-payment (no 5% again) before the rest of their share, which keeps its 5%. In a divided decision the
// freelancer's share is before the 5%: the client's refund never pays commission.
// The new prices: what was pulled back after a chargeback, then every transfer of the Order the books don't show (a payout
// whose answer was lost), in the order Stripe made them, counted at its full amount and written down; then the paid-out
// total follows Stripe's record (paidOutFollowsStripe). own: also the payouts of the decision being carried out (the
// settlement does; the re-payment's own step, which a cancel or a decision runs first, leaves them to it). Returns the
// Order and its lines.
async function bookUnbookedV2(c, ts, ev, own) {
  const attempt = String(c.resolved_at || "");
  const isOwn = (t) => !!attempt && (t.metadata.attempt || "") === attempt && !(t.metadata.milestone_id || "");
  if (ts.some(t => nz(t.amount_reversed) > 0)) c = (await syncReversals(c, c.chargeback_id)).row;
  const rows = await linesOf(c);
  for (const t of [...ts].sort(byCreated)) {
    if (hasLine(rows, "release", t.id) || (!own && isOwn(t))) continue;
    c = await bookTransfer(c, t, rows, { late: !isOwn(t), note: isOwn(t) ? ev : "payout counted at settlement", setId: isOwn(t) && !repayOf(t) });
    if (t.metadata.milestone_id && payoutWhole(ts, t)) await partPaid(c, t.metadata.milestone_id, t.id);
    console.error("counted a transfer the books did not show", c.id, t.id, grossOf(t));
  }
  c = await paidOutFollowsStripe(c, ts, rows);
  return { c, rows };
}
async function settleLockedV2(c, actor, ev) {
  const attempt = String(c.resolved_at || "");
  let editorCents = nz(c.split_editor_cents), refundCents = nz(c.refund_cents);
  const now = new Date().toISOString();
  const ownOf = (ts) => ts.filter(t => attempt && (t.metadata.attempt || "") === attempt && !(t.metadata.milestone_id || ""));
  let ts, rows, doneR = false, pendE = 0, pendR = 0, owed = 0;
  try {
    ts = await transfersOf(c);
    // 1. the books follow Stripe first: what was pulled back after a chargeback, then every transfer of the Order the
    //    books don't show (a payout whose answer was lost, this decision's own included), before anything else moves
    ({ c, rows } = await bookUnbookedV2(c, ts, ev, true));
    // 2. this decision's refund, counted already (its ids go on the Order with the count): any line of it still missing
    const rids = String(c.stripe_refund_id || "").split(",").filter(isStripeId);
    doneR = rids.length > 0 && refundCents > 0;
    if (doneR && rids.some(id => !hasLine(rows, "refund", id))) await refundLines(c, (await ourRefundsAtStripe(c)).filter(r => rids.includes(r.id)), rows, ev);
    // 3. what this decision has moved already, and what is left (never more than is held now, less what won chargebacks
    //    pulled back from the freelancer and is still owed to them: theirs, never part of the decision; check of 2 November)
    // (a payout from money held apart is done once all its parts are at Stripe: an earlier try may have stopped between two)
    // What it moved for the freelancer is its own payout only: a re-payment it made (step 4) is on top of the share and
    // never part of it (an earlier try that made the re-payment and then stopped before its own payout read the
    // re-payment as the share paid, and the share was never paid: the freelancer short, the Order completed)
    const own0 = ownOf(ts), normal0 = own0.filter(t => !repayOf(t)), normalDone = normal0.length > 0 && normal0.every(t => payoutWhole(normal0, t)), movedE0 = normal0.reduce((a, t) => a + grossOf(t), 0);
    pendE = normalDone ? 0 : Math.max(editorCents - movedE0, 0); pendR = doneR ? 0 : refundCents;
    owed = Math.min((await owedRepays(c, ts, rows)).reduce((a, d) => a + d.owed, 0), heldCents(c));
    const held = heldCents(c) - owed;
    if (pendE + pendR > held) {
      const e2 = pendE + pendR > 0 ? Math.min(Math.round(held * pendE / (pendE + pendR)), held) : 0, r2 = held - e2;
      console.error("settlement adjusted to what is held", c.id, { pendE, pendR, held, e2, r2 });
      pendE = e2; pendR = r2;
      await db.update("contracts", `id=eq.${c.id}&status=eq.${q(c.status)}`, { split_editor_cents: movedE0 + pendE, refund_cents: (doneR ? refundCents : 0) + pendR });
    }
    // 4. the freelancer's share: first what a won chargeback pulled back from them, paid back as its re-payment (no 5%, and
    //    on top of the decision's share, which never included it); then the share itself, a normal payout with its 5%. A
    //    decision that pays the freelancer nothing leaves the re-payment to the end, once the Order is closed.
    if (pendE > 0) {
      let left = owed;
      for (const d of await owedRepays(c, ts, rows)) {
        const x = Math.min(d.owed, left);
        if (x <= 0) break;
        const out = {};
        await releaseToEditor(c, x, null, `retransfer_${d.id}`, { attempt, out });
        rows = await linesOf(c);
        for (const t of out.transfers || [out.transfer]) { c = await bookTransfer(c, t, rows, { note: ev }); if (!ts.some(y => y.id === t.id)) ts.push(t); }
        left -= x;
      }
      if (pendE > 0) {
        const out = {};
        await releaseToEditor(c, pendE, null, "release", { out });
        rows = await linesOf(c);
        const made = out.transfers || [out.transfer];
        for (const t of made) { c = await bookTransfer(c, t, rows, { note: ev, setId: t === made[0] }); if (!ts.some(y => y.id === t.id)) ts.push(t); }
        pendE = 0;
      }
    }
    // 5. the client's part: one line per Stripe refund
    if (pendR > 0) {
      const out = {};
      const ids = await refundToClient(c, pendR, { out });
      const upd = await db.update("contracts", `id=eq.${c.id}&status=eq.${q(c.status)}`, { stripe_refund_id: String(ids).slice(0, 200), refunded_cents: nz(c.refunded_cents) + pendR });
      if (!upd || !upd[0]) throw new Error("order changed during settlement");
      c = upd[0];
      await refundLines(c, (out.refunds || []).filter(r => !hasLine(rows, "refund", r.id)), rows, ev);
    }
  } catch (e) {
    await stepStopped(c, "settlement", e);
    throw e;
  }
  const own = ownOf(ts.filter((t, i, a) => a.findIndex(x => x.id === t.id) === i));
  const movedE = own.reduce((a, t) => a + grossOf(t), 0), movedR = (doneR ? refundCents : 0) + pendR;
  const kept = own.filter(t => !repayOf(t)).reduce((a, t) => a + payoutOf(t).commission, 0), sent = own.reduce((a, t) => a + t.amount, 0);
  // the decision names the outcome; when nothing was left to move (milestones took it all), whoever has the money does
  const paid = movedE + movedR > 0 ? movedE > 0 : nz(c.released_cents) > 0;
  let u = (await db.update("contracts", `id=eq.${c.id}&status=eq.${q(c.status)}`, { status: paid ? "completed" : "refunded",
    completed_at: paid ? now : null, closed_at: now, resolved_at: now, auto_release_at: null }))[0];
  if (!u) { await putNote(c.id, n => addNote(n, `settled at the provider (${own.map(t => t.id).join(" ")} ${c.stripe_refund_id || ""}) but the order changed meanwhile — check by hand`)); throw new Error("order changed during settlement"); }
  u = await settledNotes(u);
  await orderEvent(u, ev === "approve" ? "released" : ev === "auto_release" ? "auto_released" : ev.startsWith("resolved") ? "resolved" : ev,
    { editor_cents: movedE, refund_cents: movedR, decision: u.resolution, commission_cents: kept, payout_cents: sent }, actor);
  await contractEvent(u, ev, actor, { amount_cents: movedE || movedR });
  return repayAfterSettle(u, owed);
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
  let c = await db.contract(c0.id);
  if (!c) throw fail("Order not found", 404, "order_changed");
  if (!["funded", "delivered"].includes(c.status)) throw fail("Nothing to release right now", 409, "nothing_to_release");
  if (chargebackOpen(c)) throw fail(CHARGEBACK, 409, "chargeback_open");
  // Every payout of the Order at Stripe that the books don't show yet (a part's payout whose answer was lost, also one a
  // chargeback pulled back since) is counted first, so what the Order holds is what it really holds: this part is paid only
  // from that (check of 7 November: part 1's payout not counted, the bank's chargeback of 60.00 lost, and part 2 was then
  // paid in full from money that had gone to the bank: 200.00 to the freelancer of 200.00 paid in). This part's own payout
  // found at Stripe is counted the same way, and that is all there is to do (a part pulled back before it was counted was
  // paid a second time, or counted twice; never made again now).
  if (!c.paid_mode || c.paid_mode === STRIPE_MODE) {
    const was = await db.milestone(m.id);
    if (!was || !["submitted", "approved"].includes(was.status)) throw fail("This milestone was just changed, reload", 409, "milestone_changed");
    const bk = await bookAllUnbooked(c, "payout counted before a part's payout");
    c = bk.c || c;
    // this part's payout in the books (counted now or earlier) is the part paid out: it is marked so, and nothing else is
    // done. Decided by the books, not by the mark, so a mark that could not be saved never lets the part be counted again
    // (check of 7 November, re-check: one refused write counted a part twice). A payout in pieces counts once all of it is in.
    const mine = bk.ts.filter(t => (t.metadata.milestone_id || "") === m.id && (t.metadata.purpose || "release") === "release" && hasLine(bk.rows, "release", t.id));
    const inBooks = mine.some(t => !isPart(t)) || (mine.length > 0 && mine.reduce((a, t) => a + grossOf(t), 0) >= m.amount_cents);
    if (inBooks) {
      const tid = (mine.find(t => !isPart(t)) || mine[0]).id;
      if (!(await partPaid(c, m.id, tid, actor, ev))) {
        const now = await db.milestone(m.id);
        if (!now || now.status !== "released") throw new Error(`milestone ${m.id}: its payout is in the books, but it could not be marked as paid out yet`);
      }
      try { await closeIfNothingLeft(c.id, actor); } catch (e) { console.error("the Order could not be closed after its part was counted; the hourly run closes it", c.id, e && e.message); }
      return tid;
    }
    if (!["funded", "delivered"].includes(c.status)) throw fail("Nothing to release right now", 409, "nothing_to_release");
  }
  if (m.amount_cents > heldCents(c)) { await noteShortPart(c, m); throw fail("Not enough money is held for this milestone", 409, "not_enough_held"); }
  // (since schema v56 the database refuses to pay out a part while the Order is in dispute or a chargeback is open, also
  // one opened at this very moment: nothing is paid out, and the person is told there is nothing to release)
  // an automatic payout (the hourly run, nobody approving) takes only a part that is still handed in with its review period
  // over at this very moment: the part may have been sent back and handed in again since the run read its list (a new
  // period then runs). A part the client approved, or one whose payout stopped earlier, is taken as it is.
  const auto = ev === "auto_release" && !actor;
  const claimed = await db.claimMilestone(m.id, auto ? ["submitted"] : ["submitted", "approved"], { status: "approved", approved_at: m.approved_at || new Date().toISOString(), auto_release_at: null },
    auto ? `auto_release_at=lte.${encodeURIComponent(new Date().toISOString())}` : "")
    .catch(e => { if (/release_paused/.test(String(e && e.message))) throw fail("Nothing to release right now", 409, "nothing_to_release"); throw e; });
  if (!claimed) throw fail("This milestone was just changed, reload", 409, "milestone_changed");
  let transferId; const out = {};
  try { transferId = await releaseToEditor(c, m.amount_cents, m.id, "release", { out }); }
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
  // the payout's line: checked like the payments' lines, never left out in silence (under the new prices: what was kept and
  // what was sent, from the transfer)
  // (a payout from money held apart: one line per part, each naming its own transfer and payment)
  const msParts = isPlan2(c) ? (out.transfers || (out.transfer ? [out.transfer] : [])) : [];
  if (msParts.length) {
    for (const t of msParts) if (!(await ledger(u, { ...payoutLine(t, { note: ev }), milestone_id: m.id }, byKey("release", t.id))))
      await putNote(c.id, n => addNote(n, `${MS_LINE_NOTE}${m.id} (transfer ${t.id}; the hourly run adds it from Stripe's record; if this note stays, check by hand)`));
  } else if (!(await ledger(u, { kind: "release", milestone_id: m.id, amount_cents: m.amount_cents, provider_ref: transferId, note: ev }, isPlan2(c) ? byKey("release", transferId) : `kind=eq.release&milestone_id=eq.${m.id}`)))
    await putNote(c.id, n => addNote(n, `${MS_LINE_NOTE}${m.id} (transfer ${transferId}; the hourly run adds it from Stripe's record; if this note stays, check by hand)`));
  await orderEvent(u, ev === "auto_release" ? "milestone_auto_released" : "milestone_released", { milestone: m.id, title: m.title, amount_cents: m.amount_cents }, actor);
  await contractEvent(u, "milestone_approved", actor || c.client, { amount_cents: m.amount_cents, label: m.title });
  // the last part paid out, or nothing held any more for the parts left: the Order closes. The payout has gone through and is
  // counted, so a close the database does not answer is not an error for the person: the hourly run closes it
  // (closeEmptyOrders; check of 2 November: the client was shown "something went wrong", and a plan 1 Order stayed open)
  try { await closeIfNothingLeft(c.id, actor); }
  catch (e) { console.error("the Order could not be closed after its part was paid out; the hourly run closes it", c.id, e && e.message); }
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
// a payment Cuvori treats as late is marked for good ("late_seen:<payment>"), whatever becomes of its refund: the check
// against charging the same Order twice (chargedNotRecorded) must never take it for a first payment still being recorded
const LATE_SEEN = "late_seen:";
async function refundOrphan(s, why) {
  let out;
  if (isPi(s.payment_intent)) await db.insert("money_keys", { scope: LATE_SEEN + s.payment_intent, key: String(why).slice(0, 200) }).catch(() => {});
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
  // (the page's plan goes with it: under the new prices the hourly run's refund is in full, whatever it can read then)
  const plan = Number((s.metadata || {}).pricing_version) || null;
  const key = JSON.stringify({ id: s.id, payment_intent: pi, client_reference_id: s.client_reference_id || null, amount_total: nz(s.amount_total), currency: s.currency || null, mode: STRIPE_MODE || null, why: String(why).slice(0, 200), state: "refund", ...(plan ? { metadata: { pricing_version: String(plan) } } : {}), ...extra });
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
  // Every reminder is looked at (oldest first, up to 500), and up to 20 that have something to do are worked on each run.
  // A refund still to be tried goes before a payment whose chargeback the bank is deciding, and those before the daily
  // watches; reminders with nothing to do this hour (the other mode's, a watch checked today) take no place. 20 reminders
  // waiting for banks kept a later client's refund from ever being tried (check of 1 November). Among refunds still to be
  // tried, the one tried least goes first, and one that has failed for a day is tried less often (retryLater): 20 refunds
  // that could never go through kept a later client's from ever being tried again (check of 2 November).
  const rows = (await db.select("money_keys", `scope=like.${q(LATE_DUE)}*&select=scope,key&order=created_at.asc&limit=500`)) || [];
  const parsed = rows.map(row => { let s; try { s = JSON.parse(row.key); } catch { s = null; } return { row, s }; });
  const tries = await retryStates("late");
  const stOf = ({ s }) => (s && isPi(s.payment_intent) ? tries.get(s.payment_intent) : undefined);
  const rank = ({ s }) => (!s ? 0 : s.state === "watch" ? 2 : s.waiting ? 1 : 0);
  const due = parsed.map((x, i) => ({ ...x, i })).sort((a, b) => rank(a) - rank(b) || retryTries(stOf(a)) - retryTries(stOf(b)) || a.i - b.i);
  let done = 0, worked = 0; const failed = [];
  for (const x of due) {
    const { row, s } = x, st = stOf(x);
    if (worked >= 20) break;
    if (!s || !isPi(s.payment_intent)) { failed.push({ id: row.scope, why: "late payment: unreadable reminder" }); continue; }
    if (s.mode && STRIPE_MODE && s.mode !== STRIPE_MODE) continue;                   // paid in the other mode: these keys cannot refund it (kept for when they can)
    const watch = s.state === "watch";
    if (watch && !(Date.parse(s.watch_until) > Date.now())) { await db.remove("money_keys", `scope=eq.${q(row.scope)}`).catch(() => {}); await retryDone("late", s.payment_intent, st); continue; }   // 180 days: the watch ends
    if (watch && Date.now() - Date.parse(s.checked_at) < 86400e3) continue;          // once a day
    if (!retryDue(st)) continue;                                                     // failed for a day already: its next try is later
    worked++;
    const unlock = isUuid(s.client_reference_id) ? await lockOrder(s.client_reference_id, 0).catch(() => null) : () => {};
    if (!unlock) continue;                                                           // busy right now: the next run
    try {
      const c = isUuid(s.client_reference_id) ? await db.contract(s.client_reference_id) : null;
      if ((!watch || s.stuck > 0) && c && s.noted && !hasNote(c.money_error, lateNote(s.payment_intent))) { await db.remove("money_keys", `scope=eq.${q(row.scope)}`); await retryDone("late", s.payment_intent, st); continue; }   // marked as handled
      if (watch) {
        const cb = await chargebackOn(s.payment_intent);
        if (cb.state === "lost") { await db.update("money_keys", `scope=eq.${q(row.scope)}`, { key: JSON.stringify({ ...s, checked_at: new Date().toISOString() }) }); continue; }
        // the bank changed its decision: the refund goes ahead as usual (it is a reminder to refund again)
        await db.update("money_keys", `scope=eq.${q(row.scope)}`, { key: JSON.stringify({ ...s, state: "refund", noted: false, stuck: undefined }) });
      }
      if (await contractByPi(s.payment_intent)) { await lateRefundDone(s); await retryDone("late", s.payment_intent, st); continue; }   // on an Order after all: not a late payment
      const r = await refundOrphan(s, s.why || "late payment");
      if (r !== "chargeback_open") done++;
      await retryDone("late", s.payment_intent, st);                                 // refunded, or waiting for the bank: no failed tries any more
    } catch (e) {
      failed.push({ id: s.client_reference_id, why: `late payment ${s.payment_intent}: ${e && e.message}` }); console.error("late payment refund retry failed", s.payment_intent, e && e.message);
      if (!e.waiting) await retryLater("late", s.payment_intent, st).catch(() => {});
    }
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
  if (c && (await claimScope(`late_full:${pi}`).catch(() => false)) && !(await orderEvent(c, "late_payment_refunded", { amount_cents: rest, card_fee_cents: 0, total_cents: ch.amount, full: true }, null))) await dropKey(`late_full:${pi}`);
  return "refunded";
}
async function refundOrphanNow(s, why) {
  const p = await stripe("GET", `/payment_intents/${s.payment_intent}`, { "expand[]": "latest_charge.balance_transaction" });
  const ch = p && p.latest_charge && typeof p.latest_charge === "object" ? p.latest_charge : null;
  const bt = ch && ch.balance_transaction && typeof ch.balance_transaction === "object" ? ch.balance_transaction : null;
  // Under the new prices (the page's own record of its plan, or its Order's) the payment goes back in full, Stripe's card fee
  // included: Cuvori carries it, so nothing here waits for Stripe's fee or depends on how Stripe bills it
  // (the Order is read for sure: a read that fails waits for the next try, never guesses today's prices and keeps the fee)
  let order = null;
  if (isUuid(s.client_reference_id)) {
    try { order = await db.contract(s.client_reference_id); }
    catch (e) { const x = new Error(`late payment ${s.payment_intent}: its Order could not be read (${e && e.message})`); x.outcomeUnknown = true; throw x; }
  }
  const full = Number((s.metadata || {}).pricing_version) >= 2 || Number((p && p.metadata || {}).pricing_version) >= 2 || isPlan2(order);
  const sameCurrency = full ? !!ch : !!bt && (!bt.currency || String(bt.currency).toLowerCase() === String(s.currency || ch && ch.currency || "").toLowerCase());
  // Stripe's fee: from the balance entry, or (standalone fees: the entry shows 0) from the Fees report, days later
  const cardFee = full ? 0 : ch && sameCurrency ? (entryFee(bt) ?? await reportedFee(ch, s.currency || ch.currency)) : null;
  if (!ch || !Number.isInteger(ch.amount) || (!full && !bt) || !sameCurrency || !Number.isInteger(cardFee)) {
    const e = new Error(`late payment ${s.payment_intent} not refunded yet: the card fee Stripe kept on it is not known (${why})`); e.outcomeUnknown = true;
    e.waiting = !!ch && Number.isInteger(ch.created) && Date.now() - ch.created * 1000 < FEE_WAIT_MS && sameCurrency;   // only waiting for Stripe's fee: not a failed try
    throw e;
  }
  const back = Math.max(ch.amount - cardFee, 0), left = Math.max(back - nz(ch.amount_refunded), 0);   // what an earlier attempt refunded is not refunded twice
  console.error("refunding payment that cannot fund an order", s.id, why, { paid: ch.amount, card_fee: cardFee, back });
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
  // (the history line once: its claim is given back when the line can't be saved, so a delivery sent again writes it;
  // check of 6 November: it was never written)
  if (c && (give > 0 || (!lost && nz(ch.amount_refunded) === back)) && (await claimScope(`late:${s.payment_intent}`).catch(() => false))
    && !(await orderEvent(c, "late_payment_refunded", { amount_cents: give > 0 ? give : back, card_fee_cents: cardFee, total_cents: ch.amount, ...(give > 0 && nz(ch.amount_refunded) + give >= ch.amount ? { full: true } : {}) }, null)))   // full: all of it went back, the card fee too
    await dropKey(`late:${s.payment_intent}`);
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
  // the new prices charge only the agreed price: a page with a card fee or a payout fee on it (made before the Order took
  // them) is never charged
  if (isPlan2(c) && fee + connect > 0) return "the page charges a fee the Order's prices don't";
  if (chargebackOpen(c)) return "a chargeback is open";
  if (c.paid_mode && c.paid_mode !== STRIPE_MODE) return `the order was paid in ${c.paid_mode} mode`;
  if (await isBanned(c.editor)) return "the freelancer cannot receive payments";
  if (kind === "fund") {
    if (c.status !== "accepted" || c.stripe_payment_intent) return `order is ${c.status}`;
    if (amount !== centsOf(c)) return "the price changed";
    if (await chargedNotRecorded(c, s.payment_intent)) return "another payment for this Order was charged and is still being recorded";
  } else {
    if (!["funded", "delivered"].includes(c.status)) return `order is ${c.status}`;
    if (amount > owedCents(c)) return "no longer owed";
    // the same for a price increase: two pages open for it, the first one charged and its count not saved yet (check of 7
    // November: the second page was charged as well, and the first one went back as a late payment less Stripe's card fee,
    // which the client lost)
    if (await chargedNotRecorded(c, s.payment_intent, "topup")) return "another payment for this Order was charged and is still being recorded";
  }
  return null;
}
// Two payment pages open for one unpaid Order (a second tab; closing the first page failed). The client paid the first, its
// card was charged, and the database's answer to recording it was lost: Stripe sends that payment again. The Order row still
// shows no payment, so the second page was charged too, and the first payment then went back as a late payment less Stripe's
// card fee, which the client lost (review of 2 November). So before a first payment is charged, Stripe is asked about the
// Order's other card payments (Cuvori's pages put them in the Order's transfer group): one that was charged, made for this
// Order as its first payment, and is not on the Order, not sent back (none of it), not charged back, and not a late payment
// waiting to go back, is on its way into the Order. This hold is then released, nothing is charged, and the first payment is
// recorded when Stripe sends it again. Only payments of the last 10 days count: a hold lasts at most 7, and Stripe sends a
// payment again for 3 days; anything older is one for a person to look at, never a reason to refuse a payment for ever.
// A top-up (kind "topup") is checked against the Order's other top-ups the same way: one charged and not on the Order yet is
// on its way into it, and the hold of a second page is released rather than charged.
async function chargedNotRecorded(c, pi, kind = "fund") {
  const since = Date.now() / 1000 - 10 * 86400;
  const recorded = new Set([c.stripe_payment_intent, ...(await savedFundRows(c)).map(r => r.provider_ref)].filter(Boolean));
  const others = ((((await stripe("GET", "/charges", { transfer_group: `contract_${c.id}`, limit: 100 })).data) || [])
    .filter(ch => ch && ch.captured === true && ch.refunded !== true && !nz(ch.amount_refunded) && ch.disputed !== true && isPi(ch.payment_intent) && ch.payment_intent !== pi
      && !recorded.has(ch.payment_intent) && Number(ch.created) >= since));
  for (const ch of others) {
    const pi = ch.payment_intent;
    // a late payment: on its way back, or one Cuvori sent back (also one whose refund failed since, or whose note the admin
    // marked as handled): never a first payment being recorded. Taken for one, it kept every new hold of the Order released
    // for 10 days, and the client could not pay (check of 2 November, second round)
    if (await db.one("money_keys", `scope=eq.${q(LATE_DUE + pi)}&select=scope`)) continue;
    if (await db.one("money_keys", `scope=in.(${[LATE_SEEN + pi, "late:" + pi, "late_cb:" + pi, "late_full:" + pi].map(q).join(",")})&select=scope`)) continue;
    if ((((await stripe("GET", "/refunds", { payment_intent: pi, limit: 100 })).data) || []).some(r => r && r.metadata && r.metadata.kind === "late_payment")) continue;
    // a top-up the Order already counts whose line is missing (its save failed): recorded, not on its way (check of 7
    // November, re-check: a second, different price increase was refused while the first one's line was missing)
    if (kind === "topup" && await countedTopupLine(pi, c).catch(() => null)) continue;
    const p = await stripe("GET", `/payment_intents/${pi}`);
    const md = (p && p.metadata) || {};
    if (p && p.status === "succeeded" && md.contract_id === c.id && (md.kind || "fund") === kind) {
      console.error("a first payment of this Order was charged and is not recorded yet: this hold is released", c.id, ch.payment_intent, "hold", pi);
      return ch.payment_intent;
    }
  }
  return null;
}
// what Stripe says the hold is now: "charged", "released", or null (still a hold / something else)
const holdState = async (pi) => { const p = await stripe("GET", `/payment_intents/${pi}`); return p.status === "succeeded" ? "charged" : p.status === "canceled" ? "released" : null; };
// The history says once that a payment could not go in and was not charged.
async function holdReleasedEvent(s) {
  const c = isUuid(s.client_reference_id) ? await db.contract(s.client_reference_id).catch(() => null) : null;
  if (c && (await claimScope(`late:${s.payment_intent}`).catch(() => false)) && !(await orderEvent(c, "late_payment_released", { total_cents: s.amount_total }, null))) await dropKey(`late:${s.payment_intent}`);
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
  // money held apart (funds segregation): the Order is marked before the card is charged, so its payouts are always linked
  // to this payment; a page made with STRIPE_FS_WHERE=capture asks for it on the hold right here. The page says which
  // (what its maker asked for), never today's setting.
  const fs = heldApartAsked(s);
  if (fs) {
    await markHeldApart(s.client_reference_id);
    // Stripe holds apart only Visa, Mastercard, American Express and Discover payments: a card of another network (one the
    // page could not block) is charged as before, not held apart. Should Stripe refuse to hold this payment apart at all,
    // the hold is let go (nothing is charged) rather than left waiting on a card that cannot be charged this way.
    const h = await stripe("GET", `/payment_intents/${s.payment_intent}`, { "expand[]": "latest_charge" }, { preview: true });
    const card = h && h.latest_charge && typeof h.latest_charge === "object" && h.latest_charge.payment_method_details && h.latest_charge.payment_method_details.card;
    const can = fsBrandOk(card && card.brand);
    try {
      if (fs === "capture" && can) await stripe("POST", `/payment_intents/${s.payment_intent}`, { allocated_funds: { enabled: true } }, { preview: true });
      if (fs === "checkout" && !can) await stripe("POST", `/payment_intents/${s.payment_intent}`, { allocated_funds: { enabled: false } }, { preview: true });
    } catch (e) {
      if (retryable(e)) throw e;
      if (fs === "capture") return releaseHold(s, "Stripe would not hold the payment apart");
      console.error("a card Stripe cannot hold apart: the hold still asks for it", s.payment_intent, card && card.brand, e.message);
    }
  }
  try { await moneyPost(`capture:${s.payment_intent}`, `/payment_intents/${s.payment_intent}/capture`, {}, { preview: !!fs }); }
  catch (e) {
    const now = await holdState(s.payment_intent); if (now) return now;
    if (fs && e.status === 400 && /alloc/i.test(String(e.message))) return releaseHold(s, "Stripe would not charge this card with the payment held apart");
    throw e;
  }
  return "charged";
}
// how a payment page asked Stripe to hold its payment apart: "checkout" (on the page), "capture" (on the hold), or null
export const heldApartAsked = (s) => { const v = s && s.metadata && s.metadata.allocated_funds; return v === "checkout" || v === "capture" ? v : null; };
// The history says once whether Stripe holds the payment apart as asked (for the owner: the Order's page leaves the line
// out). A payment Stripe did not hold apart (another card network) is paid out the old way; nothing else changes.
async function noteHeldApart(c, pi) {
  try {
    const a = await heldApartOf(pi);
    if (!a.enabled) console.error("a payment asked to be held apart is not held apart at Stripe", c.id, pi, a.brand);
    await orderEvent(c, "held_apart", { payment: payTag(pi), held: a.enabled, amount_cents: a.available + a.pending, ...(a.brand ? { brand: String(a.brand).slice(0, 30) } : {}) }, null);
  } catch (e) { console.error("held apart?", c.id, pi, e && e.message); }
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
// A payment that is on its Order already. The delivery that recorded it may have lost the database's answer (the write
// landed): it failed before the history line and the chat card, and every later delivery found the payment recorded and
// wrote neither, so neither side was ever told the Order was paid (review of 2 November). They are written here when this
// payment's history line is missing, and never twice: the history line names its payment (a line from before it did:
// a first payment's "funded", or a top-up's line of the same amount, counts as this payment's), and the chat card goes
// with a history line written here. A failure here is only logged: the payment is recorded either way.
// The history line and the chat card name their payment by a tag of its Stripe id, never the id itself: both people on the
// Order read them, and Stripe's ids are for the payment code and the admin only (as in the payment lines, schema v56).
// (check of 6 November: the lines carried the Stripe payment id)
export const payTag = (pi) => "pay_" + crypto.createHash("sha256").update(String(pi)).digest("hex").slice(0, 16);
async function already(id, s) {
  try {
    const u = await db.contract(id);
    if (!u) return "already";
    const md = s.metadata || {}, kind = md.kind === "topup" ? "topup" : "fund", ev = kind === "fund" ? "funded" : "topped_up";
    const amount = md.amount_cents != null ? Number(md.amount_cents) : centsOf(u), fee = md.fee_cents != null ? Number(md.fee_cents) : (Number.isInteger(u.fee_cents) ? u.fee_cents : 0);
    const connect = md.connect_cents != null ? Number(md.connect_cents) : 0;
    if (![amount, fee, connect].every(Number.isSafeInteger)) return "already";
    const tag = payTag(s.payment_intent);
    const had = (await db.select("order_events", `order_id=eq.${id}&event=eq.${ev}&select=data`)) || [];
    const mine = (d) => d.payment === tag || d.payment_intent === s.payment_intent || (d.payment == null && d.payment_intent == null && (kind === "fund" || d.amount_cents === amount));
    if (had.some(e => mine((e && e.data) || {}))) return "already";
    console.error("a recorded payment had no history line: written now", id, s.payment_intent);
    await orderEvent(u, ev, { amount_cents: amount, fee_cents: fee, connect_cents: connect, total_cents: amount + fee + connect, payment: tag }, u.client);
    // the chat card only when this payment has none yet: the delivery that recorded the payment may have saved its card
    // and lost only its history line (check of 6 November: the chat showed the payment twice)
    const cards = (await db.select("messages", `conversation_id=eq.${u.conversation_id}&kind=eq.contract&select=payload&order=created_at.desc&limit=200`)) || [];
    if (!cards.some(m => m && m.payload && m.payload.contract_id === id && m.payload.event === "funded" && m.payload.payment === tag))
      await contractEvent(u, "funded", u.client, { amount_cents: amount, payment: tag });
  } catch (e) { console.error("history line of a recorded payment", id, s && s.payment_intent, e && e.message); }
  return "already";
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
  if (c.stripe_payment_intent === s.payment_intent) return already(id, s);        // duplicate delivery of the first payment
  const dupTop = await db.one("order_payments", `order_id=eq.${id}&provider_ref=eq.${q(s.payment_intent)}&select=id`);
  if (dupTop) return already(id, s);
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
    const fr = await fundRows(c), gap = nz(c.funded_cents) - fr.reduce((a, f) => a + f.amount_cents, 0);
    if (claim && gap - await othersCountedUnlined(c, s.payment_intent, fr) >= amount) amountOk = true;
  }
  if (!amountOk || s.amount_total !== amount + fee + connect || String(s.currency).toLowerCase() !== String(c.currency || "EUR").toLowerCase() || c.payment_mode !== "escrow")
    return refundOrphan(s, `amount/currency mismatch ${s.amount_total} ${s.currency} vs ${expected}+${fee}+${connect}`);
  // The payment is recorded only while it is whole at Stripe: charged, for exactly this page's total, nothing of it given
  // back and no chargeback on it. A payment that went back to the card (a late payment, sent back but for the card fee)
  // was recorded as the Order's payment when the Order later waited for the same amount and the old page was delivered
  // again (audit of 31 October): the Order showed money that was not there. Stripe not answering fails this delivery
  // (it is sent again), so nothing is recorded on a guess.
  const pi = await stripe("GET", `/payment_intents/${s.payment_intent}`, { "expand[]": "latest_charge.balance_transaction" });
  const charge = pi && pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : null;
  // (Stripe always says both the status and what it received; each is checked as Stripe says it)
  if (!pi || (pi.status !== undefined && pi.status !== "succeeded")) return "unpaid";
  if (Number.isInteger(pi.amount_received) && pi.amount_received !== s.amount_total) return refundOrphan(s, `Stripe received ${pi.amount_received}, the page's total is ${s.amount_total}`);
  if (!charge || nz(charge.amount_refunded) > 0 || charge.refunded === true || charge.disputed === true)
    return refundOrphan(s, "the payment was given back or charged back before it was recorded");
  const bt = charge.balance_transaction && typeof charge.balance_transaction === "object" ? charge.balance_transaction : null;
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
      if (now && now.stripe_payment_intent === s.payment_intent) return already(id, s);   // concurrent duplicate delivery won the claim
      if (now && now.status === "accepted" && now.amount_cents !== amount) return refundOrphan(s, "the price changed while this payment came in");
      return refundOrphan(s, `order is ${now && now.status}`);                        // cancelled / already funded by another session
    }
  } else {
    // A top-up counts once. The same paid session is delivered twice at the same moment as a rule (Stripe's
    // webhook and the page's own check): the first to claim the payment records it, the other waits for that
    // record. Nothing here treats a payment as unwanted while the other delivery may be recording it.
    const ledgerRow = { order_id: id, provider: "stripe", status: "succeeded", kind: "fund", amount_cents: amount, fee_cents: fee, connect_cents: connect, provider_ref: s.payment_intent, charge_ref: charge && charge.id || null, provider_fee_cents: entryFee(bt), note: kind,
      ...(isPlan2(c) ? { entry_key: entryKey("fund", s.payment_intent) } : {}) };
    const topupRow = () => db.one("order_payments", `order_id=eq.${id}&provider_ref=eq.${q(s.payment_intent)}&select=id`);
    if (!(await claimScope(scope))) {
      for (let i = 0; i < 15; i++) { if (await topupRow()) return already(id, s); await sleep(400); }
      // Still no record. The holder of the claim is either slow or died. A claim older than the stale limit is taken
      // over, and the books decide what is left to do: a counter that already includes this amount without a ledger
      // line means it died between the two writes — only the line is missing. Otherwise nothing was recorded.
      const row = await db.one("money_keys", `scope=eq.${q(scope)}&select=created_at`);
      if (!row || !row.created_at || Date.now() - Date.parse(row.created_at) < LOCK_STALE_MS) return "pending";   // the webhook answers 500 → Stripe sends it again later
      const fresh = await db.contract(id);
      if (!fresh) return "pending";
      const fr = await fundRows(fresh);
      const counted = nz(fresh.funded_cents) - fr.reduce((a, f) => a + f.amount_cents, 0) - await othersCountedUnlined(fresh, s.payment_intent, fr);
      if (counted >= amount) {
        // only the ledger line is missing; one writer (a second claim decides), and never twice
        if (await claimScope(`ledger:${s.payment_intent}`)) { if (!(await topupRow())) await db.insert("order_payments", ledgerRow).catch(e => console.error("ledger", e.message)); }
        const mine = (n) => n.startsWith(`top-up ${s.payment_intent} `);           // this top-up's own note, never another one naming the payment
        if (hasNote(fresh.money_error, mine)) await putNote(id, n => dropNote(n, mine));
        return already(id, s);
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
    // the ledger line is the record other deliveries wait for: written right away, and a failure is not silent (the hourly
    // run adds it from Stripe's record, repairTopupLines). This top-up's own older note ("may not be recorded", from a
    // delivery whose write got no answer) is wrong from here on: it goes, or the newer note takes its place. It stayed,
    // and the admin was told to check by hand a payment that was fine (review of 2 November).
    const mine = (n) => n.startsWith(`top-up ${s.payment_intent} `);
    let lined = true;
    // (a save whose answer was lost may have landed: looked up first, so a line that is there is never called missing;
    // check of 6 November: the admin was told to check by hand a top-up whose line was fine)
    try { await db.insert("order_payments", ledgerRow); }
    catch (e) {
      lined = !!(await topupRow().catch(() => null));
      if (!lined) { console.error("ledger", e.message); await putNote(id, n => addNote(n, `top-up ${s.payment_intent} ${TOPUP_LINE_FAILED} — check by hand`, mine)); }
    }
    if (lined && hasNote(u.money_error, mine)) await putNote(id, n => dropNote(n, mine));
  }
  // the first payment's line: checked like a top-up's, never left out in silence (saveFirstLine)
  if (kind === "fund") await saveFirstLine(u, { order_id: id, provider: "stripe", status: "succeeded", kind: "fund", amount_cents: amount, fee_cents: fee, connect_cents: connect, provider_ref: s.payment_intent, charge_ref: charge && charge.id || null, provider_fee_cents: entryFee(bt), note: kind,
    ...(isPlan2(u) ? { entry_key: entryKey("fund", s.payment_intent) } : {}) });
  // (the history line names its payment, so a later delivery can tell whether it was written: already())
  await orderEvent(u, kind === "fund" ? "funded" : "topped_up", { amount_cents: amount, fee_cents: fee, connect_cents: connect, total_cents: amount + fee + connect, payment: payTag(s.payment_intent) }, c.client);
  if (heldApartAsked(s)) await noteHeldApart(u, s.payment_intent);
  await contractEvent(u, "funded", c.client, { amount_cents: amount, payment: payTag(s.payment_intent) });
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
// `once`: an object the hourly run keeps for one run, so Stripe's Fees report list is read once per run (feeReportType)
export async function settleFee(c, row, once = null) {
  if (!row || row.kind !== "fund" || row.status !== "succeeded" || !isPi(row.provider_ref)) return "ignored";
  if (isPlan2(c)) return recordFeeV2(c, row, once);
  if (Number.isInteger(row.fee_refund_cents)) return "already";
  const pi = row.provider_ref, collected = Number.isInteger(row.fee_cents) ? row.fee_cents : 0;
  // a stored 0 is no fee either: older code stored the 0 a standalone-billed payment shows (audit of 31 October)
  let actual = Number.isInteger(row.provider_fee_cents) && row.provider_fee_cents > 0 ? row.provider_fee_cents : null;
  if (actual == null) {
    const p = await stripe("GET", `/payment_intents/${pi}`, { "expand[]": "latest_charge.balance_transaction" });
    const ch = p && p.latest_charge && typeof p.latest_charge === "object" ? p.latest_charge : null;
    const bt = ch && ch.balance_transaction;
    if (!bt || typeof bt !== "object" || !Number.isInteger(bt.fee)) return "pending";
    if (bt.currency && String(bt.currency).toLowerCase() !== String(c.currency || "EUR").toLowerCase()) return "pending";   // settled in another currency: a person looks
    // standalone fees: the entry shows 0; the real fee is in Stripe's Fees report, days later (the hourly run comes back)
    actual = entryFee(bt) ?? await reportedFee(ch, c.currency || "EUR", once);
    if (!Number.isInteger(actual)) return "pending";
    await db.update("order_payments", `id=eq.${row.id}`, { provider_fee_cents: actual });
  }
  const surplus = collected - actual;
  const done = async (refunded, ref, extra) => {
    await db.update("order_payments", `id=eq.${row.id}`, { fee_refund_cents: refunded, fee_refund_ref: ref || null });
    await orderEvent(c, refunded > 0 ? "fee_refunded" : "fee_exact", { amount_cents: refunded, collected_cents: collected, provider_fee_cents: actual, ...(extra || {}) }, null);
    if (hasNote(c.money_error, feeUnknownNote(pi))) await putNote(c.id, n => dropNote(n, feeUnknownNote(pi)));   // settled after all: its note goes
  };
  if (surplus <= 0) { await done(0, null, surplus < 0 ? { shortfall_cents: -surplus } : {}); return surplus < 0 ? "shortfall" : "exact"; }
  // a refund made by an earlier, interrupted attempt is used, never made twice
  const prior = ((await stripe("GET", "/refunds", { payment_intent: pi, limit: 50 })).data || []).filter(r => FEE_REFUND(r) && r.status !== "failed" && r.status !== "canceled");
  let r = prior[0] || null;
  if (!r) r = await moneyPost(`feerefund:${pi}`, "/refunds", { payment_intent: pi, amount: surplus, metadata: { contract_id: c.id, kind: "fee_surplus" } });
  await done(prior.length ? prior.reduce((a, x) => a + x.amount, 0) : surplus, r.id);
  return "refunded";
}
// Today's prices: Stripe's fee on a payment still not known when its 96 hours are over (Stripe's Fees report has no row for
// it, or the fee is in another currency than the Order's). settleFee then waits for ever, and nothing told you that the
// client's card-fee surplus had not gone back (review of 2 November). The Order gets one note, once (not every hour, and not
// again after you marked it as handled); the hourly run keeps looking, and the note goes if the fee settles after all.
const feeUnknownNote = (pi) => (n) => n.startsWith(`card fee of payment ${pi} `);
export async function noteFeeUnknown(c, row) {
  if (!c || isPlan2(c) || !row || !isPi(row.provider_ref)) return false;
  const pi = row.provider_ref;
  if (hasNote(c.money_error, feeUnknownNote(pi)) || !(await claimScope(`fee_note:${row.id}`))) return false;
  const text = `card fee of payment ${pi} not settled: Stripe's fee on it is still not known after 4 days (no row for it in Stripe's Fees report, or the fee is in another currency), so the part of the card fee above Stripe's fee has not gone back to the client. Cuvori keeps asking Stripe (less often now); if this note stays for more than a week, ask for help. Do not refund it yourself at Stripe: Cuvori counts such a refund as Order money`;
  const u = await putNote(c.id, n => addNote(n, text, feeUnknownNote(pi)));
  if (!u || !hasNote(u.money_error, feeUnknownNote(pi))) { await dropKey(`fee_note:${row.id}`); return false; }     // not saved: the next run tries again
  console.error("Stripe's fee on a payment is still not known after 4 days: noted on the Order", c.id, pi);
  return true;
}
// The new prices: the client paid no card fee, so nothing goes back for card costs. Stripe's real fee is Cuvori's cost and
// is only recorded on the payment's line (provider_fee_cents), once, when it is known: from the payment's balance entry, or
// with standalone fees (the entry shows 0, which never means "no fee") from Stripe's Fees report, days later (the hourly run
// comes back for it). A payment that charged the client a card fee or a payout fee anyway (a page from before the Order
// took the new prices) gets that whole fee back to the card, written on its own line (fee_refund_cents with the refund's id,
// as the database allows once). Refunds of the Order's money never wait for any of this.
async function recordFeeV2(c, row, once = null) {
  let out = "already";
  if (!(Number.isInteger(row.provider_fee_cents) && row.provider_fee_cents > 0)) {
    const p = await stripe("GET", `/payment_intents/${row.provider_ref}`, { "expand[]": "latest_charge.balance_transaction" });
    const ch = p && p.latest_charge && typeof p.latest_charge === "object" ? p.latest_charge : null;
    const bt = ch && ch.balance_transaction && typeof ch.balance_transaction === "object" ? ch.balance_transaction : null;
    const sameCurrency = !!bt && (!bt.currency || String(bt.currency).toLowerCase() === String(c.currency || "EUR").toLowerCase());
    const fee = !bt || !sameCurrency ? null : (entryFee(bt) ?? await reportedFee(ch, c.currency || "EUR", once));
    if (Number.isInteger(fee) && fee > 0 && row.provider_fee_cents == null) {
      await db.update("order_payments", `id=eq.${row.id}&provider_fee_cents=is.null`, { provider_fee_cents: fee });
      out = "recorded";
    } else out = "pending";
  }
  const charged = nz(row.fee_cents) + nz(row.connect_cents);
  if (charged > 0 && !nz(row.fee_refund_cents) && !row.fee_refund_ref) {
    const prior = ((await stripe("GET", "/refunds", { payment_intent: row.provider_ref, limit: 50 })).data || []).filter(r => FEE_REFUND(r) && r.status !== "failed" && r.status !== "canceled");
    const r = prior[0] || await moneyPost(`feerefund:${row.provider_ref}`, "/refunds", { payment_intent: row.provider_ref, amount: charged, metadata: { contract_id: c.id, kind: "fee_surplus" } });
    await db.update("order_payments", `id=eq.${row.id}&fee_refund_ref=is.null`, { fee_refund_cents: Math.min(r.amount, charged), fee_refund_ref: r.id });
    await orderEvent(c, "fee_refunded", { amount_cents: Math.min(r.amount, charged), collected_cents: charged, provider_fee_cents: row.provider_fee_cents ?? null }, null);
    out = "refunded";
  }
  return out;
}
// the ledger row of a payment, for settleFee
export const fundRowOf = (c, pi) => db.one("order_payments", `order_id=eq.${c.id}&kind=eq.fund&provider_ref=eq.${q(pi)}&select=*`);

// ---- chargebacks: the bank pulls the money back on the client's word; Cuvori answers with the facts ----
const pendingReversal = (c) => String(c.money_error || "").startsWith("chargeback:");
const pendingRepay = (c) => String(c.money_error || "").startsWith("chargeback won");
// an error with no answer from the provider or the database: fail the webhook so Stripe sends the event again
const retryable = (e) => !!(e && (e.network || e.outcomeUnknown || e.shouldRetry || !e.status || e.status >= 500));
// The bank only asks about the payment (an inquiry, Stripe's "warning" statuses: mostly American Express and Discover).
// Stripe takes no money from Cuvori then, so nothing is frozen, pulled back or flagged: the Order's note asks you to answer
// the bank in Stripe's dashboard, and the Order goes on as normal. The note goes when the inquiry ends or becomes a
// chargeback; a chargeback runs the chargeback steps as usual — when Stripe takes the money (charge.dispute.funds_withdrawn,
// the same dispute) or, if that notice never came, when the bank's decision for the client arrives (onDisputeClosed).
const isInquiry = (o) => !!o && (o.status === "warning_needs_response" || o.status === "warning_under_review");
export const INQUIRY_HEAD = "the client's bank asked about payment ";
const inquiryNoteOf = (pi) => (n) => n.startsWith(`${INQUIRY_HEAD}${pi} `);
async function noteInquiry(c, o) {
  const amount = Number.isInteger(o.amount) ? `${(o.amount / 100).toFixed(2)} ${String(o.currency || c.currency || "").toUpperCase()}, ` : "";
  const text = `${INQUIRY_HEAD}${o.payment_intent} (${amount}inquiry ${o.id}): answer it in Stripe's dashboard under Disputes, with the Order's details. Nothing was taken from Cuvori and the Order goes on as normal (only the automatic release waits until the inquiry ends); if the bank turns it into a chargeback, Cuvori handles it as a chargeback`;
  const row = await putNote(c.id, n => addNote(n, text, inquiryNoteOf(o.payment_intent)));
  // the note is what stops the automatic release while the bank asks (inquiryOpen): one that could not be saved fails the
  // webhook, so Stripe sends the inquiry again
  if (!row || !hasNote(row.money_error, inquiryNoteOf(o.payment_intent))) { const e = new Error(`the note for inquiry ${o.id} could not be saved`); e.outcomeUnknown = true; throw e; }
  return "inquiry";
}
const dropInquiryNote = async (c, pi) => { if (c && hasNote(c.money_error, inquiryNoteOf(pi))) await putNote(c.id, n => dropNote(n, inquiryNoteOf(pi))); };
// The hourly run, for an Order whose automatic release waits for the bank's inquiry: Stripe is asked about the payment.
// An inquiry that ended without Cuvori hearing of it (its notice was lost) has its note removed, so the release goes on;
// the note is no longer one the admin can mark as handled (schema v56), so nothing else would ever remove it. While any
// dispute on the payment is still undecided (an inquiry, or a chargeback Cuvori has not recorded yet), the release waits.
// Stripe not answering: it waits too, until the next run.
const UNDECIDED = (d) => !!d && !["warning_closed", "won", "lost", "prevented", "charge_refunded"].includes(d.status);
export async function inquiryStillOpen(c) {
  if (!inquiryOpen(c)) return false;
  if (c.paid_mode && STRIPE_MODE && c.paid_mode !== STRIPE_MODE) return true;          // paid in the other mode: these keys can't see it
  const pis = [...new Set(notesOf(c.money_error).filter(n => n.startsWith(INQUIRY_HEAD)).map(n => n.slice(INQUIRY_HEAD.length).split(" ")[0]))];
  let open = false;
  for (const pi of pis) {
    if (!isPi(pi)) { open = true; continue; }
    let ds;
    try {
      ds = ((await stripe("GET", "/disputes", { payment_intent: pi, limit: 10 })).data) || [];
      // the inquiry the note names, asked for by its own id too (a list can leave it out)
      const id = (/ inquiry ((?:du|dp)_[A-Za-z0-9_]{1,200})\)/.exec(notesOf(c.money_error).find(n => n.startsWith(`${INQUIRY_HEAD}${pi} `)) || "") || [])[1];
      if (id && !ds.some(d => d && d.id === id)) { const d = await stripe("GET", `/disputes/${id}`).catch(e => (e && e.status === 404 ? null : Promise.reject(e))); if (d) ds.push(d); }
    }
    catch (e) { console.error("asking Stripe about an inquiry failed", c.id, pi, e && e.message); open = true; continue; }
    if (ds.some(UNDECIDED)) { open = true; continue; }
    console.error("the bank's inquiry ended without a notice: its note goes", c.id, pi);
    await dropInquiryNote(await db.contract(c.id), pi);
  }
  return open;
}
// Two chargebacks on one Order at once (clients often dispute the first payment and a price increase together): the Order
// records one chargeback at a time. Another one that comes while the recorded one is still open (or its re-payment to the
// freelancer is still owed) is never refused: refusing failed the webhook until Stripe gave up, and once the first was
// decided the admin could pay out money the bank had already taken. It is noted on the Order instead, and the note keeps
// every payout and refund stopped (chargebackOpen). Once the recorded one is done, Stripe is asked about the Order's
// payments (nextChargebackLocked): the next chargeback still open becomes the Order's chargeback, handled like a new one;
// one the bank decided for the client meanwhile is counted like a lost chargeback; one decided for Cuvori needs nothing.
const otherCbNote = (id) => (n) => n.startsWith(`chargeback ${id} also `);
const cbBusy = (c) => c.chargeback_status === "open" || (c.chargeback_status === "won" && pendingRepay(c));
// The Order's chargeback is one this step took over from a note and could not finish (recorded, then one database answer
// did not come): its note still names it. Nothing else finishes it, so the hourly run and a notice of the earlier chargeback
// sent again call the next-chargeback step for it (check of 6 November: the Order stayed frozen for good).
export const takeoverUnfinished = (c) => !!c && c.chargeback_status === "open" && !!c.chargeback_id && hasNote(c.money_error, n => (OTHER_CB.exec(n) || [])[1] === c.chargeback_id);
const decidedOrEnded = (d) => ["won", "lost", "warning_closed", "prevented", "charge_refunded"].includes(d.status);
async function noteOtherChargeback(c, o) {
  const pi = typeof o.payment_intent === "string" ? o.payment_intent : o.payment_intent?.id;
  const amount = Number.isInteger(o.amount) ? ` (${(o.amount / 100).toFixed(2)} ${String(o.currency || c.currency || "").toUpperCase()})` : "";
  const text = o.status === "lost"
    ? `chargeback ${o.id} also on payment ${pi}${amount}, decided for the client: Cuvori counts it once chargeback ${c.chargeback_id} is done; until then nothing on this Order is paid out or refunded`
    : `chargeback ${o.id} also open on payment ${pi}${amount}: Cuvori handles it once chargeback ${c.chargeback_id} is done; until then nothing on this Order is paid out or refunded`;
  const row = await putNote(c.id, n => addNote(n, text, otherCbNote(o.id)));
  // the note is what keeps the money still: one that could not be saved fails the webhook, so Stripe sends it again
  if (!row || !hasNote(row.money_error, otherCbNote(o.id))) { const e = new Error(`the note for chargeback ${o.id} could not be saved`); e.outcomeUnknown = true; throw e; }
  console.error("a second chargeback on an Order while another is open: noted", c.id, o.id, "recorded:", c.chargeback_id);
  return "noted";
}
const dropOtherCbNote = async (id, disputeId) => { const c = await db.contract(id); if (c && hasNote(c.money_error, otherCbNote(disputeId))) await putNote(id, n => dropNote(n, otherCbNote(disputeId))); };
// Called under the Order's lock once its recorded chargeback is decided (onDisputeClosed), and by the hourly run for an
// Order that still has another chargeback noted (Stripe could not be asked at the time, or the re-payment was owed first).
export async function nextChargeback(id) {
  const unlock = await lockOrder(id);
  try { return await nextChargebackLocked(id); } finally { await unlock(); }
}
async function nextChargebackLocked(id) {
  for (let round = 0; round < 5; round++) {
    const c = await db.contract(id);
    if (!c || pendingRepay(c)) return;                                   // the re-payment of the one just won comes first
    const named = new Set(notesOf(c.money_error).map(n => (OTHER_CB.exec(n) || [])[1]).filter(Boolean));
    // recorded and open, and not one this step took over without finishing: the bank decides it first
    if (c.chargeback_status === "open" && !named.has(c.chargeback_id)) return;
    const pis = [...new Set([c.stripe_payment_intent, ...(await savedFundRows(c)).map(r => r.provider_ref)].filter(isPi))];
    const ds = [];
    for (const pi of pis) ds.push(...(((await stripe("GET", "/disputes", { payment_intent: pi, limit: 10 })).data) || []).filter(d => d && isStripeId(d.id) && !isInquiry(d)));
    // counted already (a lost chargeback's result is stored once it is counted)
    const counted = async (d) => d.status === "lost" && !!(await db.one("money_keys", `scope=eq.${q(`chargeback_result:${c.id}:${d.id}`)}&select=scope`));
    // noted ones the bank decided for Cuvori (or that Stripe no longer lists as anything to do): their note goes
    for (const d of ds) if (named.has(d.id) && (d.status !== "lost" ? decidedOrEnded(d) : await counted(d))) { await dropOtherCbNote(c.id, d.id); named.delete(d.id); }
    let next = null;
    if (c.chargeback_status === "open") next = ds.find(d => d.id === c.chargeback_id) || null;      // taken over before, not finished
    else {
      const todo = [];
      for (const d of ds) if (d.id !== c.chargeback_id && (!decidedOrEnded(d) || (d.status === "lost" && named.has(d.id) && !(await counted(d))))) todo.push(d);
      next = todo.sort((a, b) => (a.created || 0) - (b.created || 0))[0] || null;
    }
    if (!next) return;
    console.error("taking over the next chargeback on an Order", c.id, next.id, next.status);
    await createDisputeLocked(c.id, next);                               // recorded like a new chargeback (or covered again)
    if (next.status === "lost" || next.status === "won") await closeDisputeLocked((await db.contract(c.id)) || c, next, next.status === "won", next.status === "lost");
    await dropOtherCbNote(c.id, next.id);
    if (!decidedOrEnded(next)) return;                                   // open: the bank decides it, its own notices close it
  }
}
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
  if (isInquiry(o)) {
    // Stripe sends a notice again when its first delivery failed, and not always in order: what the dispute is NOW decides.
    // An inquiry that has ended is not noted again (check of 7 November: its note stayed on the Order for good); one the bank
    // has turned into a chargeback since is handled as that chargeback right away (check of 7 November, re-check: ignored, it
    // left nothing holding the Order, and the hourly run paid the freelancer before the chargeback's own notice came).
    // Stripe not answering: noted as an inquiry (the hourly run asks again).
    const now = isStripeId(o.id) ? await stripe("GET", `/disputes/${o.id}`).catch(e => { console.error("asking Stripe about an inquiry failed", initial.id, o.id, e && e.message); return null; }) : null;
    if (!now || now.id !== o.id || isInquiry(now)) return noteInquiry(initial, o);                 // the bank only asks: nothing is frozen or pulled back
    if (!UNDECIDED(now)) { console.error("an inquiry's notice came after it ended: not noted", initial.id, o.id, now.status); return "ignored"; }
    o = { ...o, ...now, payment_intent: typeof now.payment_intent === "string" ? now.payment_intent : o.payment_intent };
    console.error("an inquiry's notice came after the bank turned it into a chargeback: handled as the chargeback", initial.id, o.id, now.status);
  }
  const unlock = await lockOrder(initial.id);
  try { return await createDisputeLocked(initial.id, o); }
  finally { await unlock(); }
}
async function createDisputeLocked(id, o) {
  const c0 = await db.contract(id);
  if (!c0) return "ignored";
  // A chargeback the bank already decided, and Cuvori already counted, is never recorded again when one of its notices comes
  // again after another chargeback became the Order's (Stripe sends a notice again when its first delivery failed, and not
  // always in order): recorded again, it froze the Order and its counted result could never be closed. A lost one's line is
  // written if it is still missing. Both price plans (check of 2 November: only plan 2 had this, and a plan 1 Order froze).
  if (c0.chargeback_id !== o.id && isStripeId(o.id)) {
    const counted = await db.one("money_keys", `scope=eq.${q(`chargeback_result:${c0.id}:${o.id}`)}&select=scope`);
    const won = !counted && ((await db.select("order_events", `order_id=eq.${c0.id}&event=eq.chargeback_won&select=data`)) || []).some(e => e && e.data && e.data.chargeback === o.id);
    if (counted) { await recordClosedChargeback(c0, o.id); return "already"; }
    if (won) return "already";
    // Stripe's record of the chargeback as it is now, not the notice: one the bank already decided for Cuvori (its "decided"
    // notice came first, and this one, sent again or late, after it) is never recorded. Recorded as open, it pulled the
    // freelancer's pay back and froze the Order for good: its decision had already come (check of 6 November).
    const now = await stripe("GET", `/disputes/${o.id}`);
    if (now && now.id === o.id && ["won", "warning_closed", "prevented"].includes(now.status)) {
      await dropInquiryNote(c0, o.payment_intent); await dropOtherCbNote(c0.id, o.id);
      console.error("a chargeback notice for one the bank already decided for Cuvori: nothing to record", c0.id, o.id, now.status);
      return "ignored";
    }
  }
  // another chargeback is recorded and not done yet: this one is noted, never refused (nextChargebackLocked takes it over)
  if (c0.chargeback_id !== o.id && cbBusy(c0)) return noteOtherChargeback(c0, o);
  const retry = c0.chargeback_id === o.id;                                // Stripe sends the event again when the first handling did not finish
  if (retry && c0.chargeback_status !== "open") return "already";        // decided meanwhile: nothing left to cover
  const cents = Number.isInteger(o.amount) ? o.amount : 0;
  // The chargeback this one takes the place of, decided for Cuvori: its "chargeback won" history line is written first, or
  // nothing is recorded (it is what says that chargeback was won once the Order records another; a re-payment for it is right
  // only then). Its own notice may have broken off before writing it, and the hourly run taken this one over before Stripe
  // sent that notice again: the line was then never written (check of 6 November, second round).
  if (!retry && c0.chargeback_status === "won" && isStripeId(c0.chargeback_id)) await wonEvent(c0, c0.chargeback_id);
  if (!retry) {
    // the facts first, before any money moves: the Order is frozen, the history and the chat say why, the client is flagged.
    // A bank chargeback is kept apart from the Order's own dispute (the client's or the freelancer's, which Cuvori decides):
    // it is recorded only as the chargeback. The Order keeps its status, its dispute (with its reason, who opened it and
    // when) and a decision or approval under way; nothing is paid out or refunded while it is open (chargebackOpen, and the
    // database's release_paused rule), and the review clocks stop and go on with the time they had left once the bank
    // decides for Cuvori (resumeClocks).
    const u = (await db.update("contracts", `id=eq.${c0.id}`, { chargeback_id: o.id, chargeback_status: "open", chargeback_cents: cents }))[0] || c0;
    await orderEvent(u, "chargeback", { chargeback: o.id, amount_cents: cents, reason: o.reason || "" }, null);
    await contractEvent(u, "dispute", c0.client, { amount_cents: cents, label: "chargeback" });
    const flagged = await db.one("user_flags", `user_id=eq.${c0.client}&contract_id=eq.${c0.id}&kind=eq.chargeback&select=id`);
    if (!flagged) await db.insert("user_flags", { user_id: c0.client, kind: "chargeback", reason: `Chargeback ${o.id} on "${cut(c0.title, 120)}" (order was ${c0.status})`, contract_id: c0.id }).catch(() => {});
    await dropInquiryNote(await db.contract(c0.id), o.payment_intent);           // the bank's inquiry became this chargeback: its note goes
    if (!decidedOrEnded(o)) await dropOtherCbNote(c0.id, o.id);                   // noted while another was open: it is the Order's chargeback now
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
  let payment = funds.find(f => f.provider_ref === pi);
  // a top-up the Order counted whose line could not be saved: added now from Stripe's record (under the Order's lock, as
  // the hourly run would), so its chargeback is covered at once
  if (!payment && pi !== c.stripe_payment_intent) payment = await addTopupLine(c, pi).catch(e => { console.error("top-up line at a chargeback", c.id, pi, e && e.message); return null; });
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
    // 0. every payout at Stripe the books don't show is counted first, the one under way included (countAllAtChargeback). It
    //    never stops the chargeback: what can't be counted is said on the Order, and the steps below go on with the books as
    //    they are (check of 8 November, re-check: the database refused the count for good, the bank's notice failed every
    //    time, and the chargeback stayed open for ever). Only what the database refuses for good goes on that way: anything
    //    else (Stripe or the database not answering for a moment) fails the notice, and Stripe sends it again (second
    //    re-check of 8 November: a passing error was taken for that, the chargeback closed on books without the payout,
    //    Stripe was told all was well, and nothing said what Cuvori lost)
    try { c = await countAllAtChargeback(c, disputeId); }
    catch (e) {
      console.error("counting the payouts at a chargeback", c.id, disputeId, e && e.message);
      if (!refusedForGood(e)) throw e;
      await mustNoteUncounted(c, e, `at chargeback ${disputeId}`);
      c = (await db.contract(c.id)) || c;
    }
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
      if (isPlan2(c)) {
        // Under the new prices a pull-back takes back at most what the freelancer received from this payment: the part of
        // it that was paid out, less the 5% Cuvori kept on it (the rest of what the bank takes is Cuvori's own loss, a
        // decision left to the owner: SETUP.md Part 20). While the Order still holds money, what it holds (before this
        // chargeback's own pull-backs came back into it) covers the payment first.
        const paidOut = holding ? Math.max(cents - Math.max(heldReal - already, 0), 0) : cents;
        const received = paidOut - pricingCommission(paidOut, c.commission_bps);
        need = Math.min(st.paid, Math.max(received - already, 0));
      } else need = Math.min(st.net, holding ? Math.max(cents - heldReal, 0) : Math.max(cents - already, 0));
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
  if (isPlan2(c)) return syncReversalsV2(c, disputeId);
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
  // The paid-out total counts every payout at Stripe now (it follows Stripe's net of all of them), so each one the books don't
  // show (its answer was lost before the chargeback came) gets its line, at its whole amount (its pull-back is on the lines),
  // and a part's payout marks the part paid out: nothing is ever paid for it again (check of 7 November: a part's payout
  // pulled back before it was counted was paid a second time, and the books of a whole Order charged back in full never
  // showed its payout). Also on a later run (a notice sent again) when a line could not be saved: one that can't be saved
  // fails this step, so Stripe sends its notice again.
  if (atStripe > 0 && delta >= 0 && (delta > 0 || nz(row.released_cents) === net)) {
    const rows = (await db.select("order_payments", `order_id=eq.${c.id}&kind=eq.release&select=kind,provider_ref`)) || [];
    let failed = 0;
    for (const t of ts.filter(t => !hasLine(rows, "release", t.id) && t.amount > 0)) {
      const mid = t.metadata.milestone_id || "";
      const ok = await db.insert("order_payments", { order_id: c.id, provider: "stripe", status: "succeeded", kind: "release", amount_cents: t.amount, provider_ref: t.id,
        ...(mid ? { milestone_id: mid } : {}), note: repayOf(t) ? "chargeback_won" : `payout counted at chargeback ${disputeId} (line added from Stripe's record)` }).then(() => true, e => { console.error("ledger", c.id, e.message); return false; });
      if (!ok) { failed++; continue; }
      if (mid && (t.metadata.purpose || "release") === "release") await partPaid(row, mid, t.id);
    }
    if (failed) { const e = new Error(`${failed} payout line(s) of order ${c.id} could not be saved`); e.outcomeUnknown = true; throw e; }
  }
  return { row, net, atStripe };
}
// The same under the new prices: one line per pull-back (its own Stripe reversal, trr_…, never the transfer), naming the
// chargeback it was made for (the reversal says which in its details), written FIRST; then the Order's paid-out total follows
// Stripe: every payout's full amount (with the 5%) less what was pulled back. net: that total; paid: what the freelancer
// still has of every transfer (what a pull-back can take at most). A pull-back made by hand in the Stripe dashboard names no
// chargeback: it gets no line (the database takes none without one) and is left out of the total (SETUP.md Part 20).
async function syncReversalsV2(c, disputeId) {
  const ts = await transfersOf(c);
  const rows = await linesOf(c);
  let added = 0, row = c;
  for (const t of ts.filter(t => nz(t.amount_reversed) > 0).sort(byCreated)) {
    const rs = ((await stripe("GET", `/transfers/${t.id}/reversals`, { limit: 100 })).data || []).filter(r => r && isStripeId(r.id)).sort(byCreated);
    for (const r of rs) {
      if (hasLine(rows, "reversal", r.id)) continue;
      const dispute = r.metadata && typeof r.metadata.reason === "string" && /^(dp|du)_[A-Za-z0-9_]{1,200}$/.test(r.metadata.reason) ? r.metadata.reason : null;
      if (!dispute) { console.error("a pull-back at Stripe names no chargeback: no ledger line (check by hand)", c.id, t.id, r.id); continue; }
      const line = { kind: "reversal", amount_cents: r.amount, provider_ref: r.id, entry_key: entryKey("reversal", r.id), note: `chargeback ${dispute}`, ...(stripeTime(r.created) ? { created_at: stripeTime(r.created) } : {}) };
      if (!(await ledger(c, line, byKey("reversal", r.id)))) throw new Error(`the pull-back line of ${r.id} could not be saved`);
      rows.push(line); added += r.amount;
    }
  }
  // what the books show pulled back (lines), against every payout's full amount: the paid-out total
  const pulledLines = sumKind(rows, "reversal");
  const net = ts.reduce((a, t) => a + grossOf(t), 0) - pulledLines;
  const paid = ts.reduce((a, t) => a + t.amount - nz(t.amount_reversed), 0);
  if (added > 0 || nz(c.released_cents) > net) {
    const ids = ts.filter(t => nz(t.amount_reversed) > 0).map(t => t.id).join(",").slice(0, 200);
    row = (await db.update("contracts", `id=eq.${c.id}`, { stripe_reversal_id: ids || null, released_cents: net }))[0] || c;
    // the total now counts every payout at Stripe: a part whose payout the books don't show yet (its answer was lost) is paid
    // out, and never paid again (its line follows from Stripe's record: repairPlan2Lines; check of 7 November)
    for (const t of ts.filter(t => (t.metadata.milestone_id || "") && (t.metadata.purpose || "release") === "release" && !hasLine(rows, "release", t.id) && payoutWhole(ts, t)))
      await partPaid(row, t.metadata.milestone_id, t.id);
  }
  return { row, net, paid, atStripe: ts.reduce((a, t) => a + nz(t.amount_reversed), 0) };
}
export async function onDisputeClosed(o) {
  let c0 = await contractByPi(o.payment_intent);
  if (!c0) return "ignored";
  if (c0.chargeback_id !== o.id) {
    // Not recorded as a chargeback: an inquiry Cuvori only noted. It ended (its note goes), or the bank turned it into a
    // chargeback Cuvori did not hear of: one decided for the client is recorded now and closed as the bank decided.
    // A second chargeback noted while the recorded one is open: decided for Cuvori, its note goes (nothing was counted
    // for it); decided for the client, its note says so and it is counted once the recorded one is done.
    if (o.status !== "lost") {
      await dropInquiryNote(c0, o.payment_intent); await dropOtherCbNote(c0.id, o.id);
      // a lost chargeback counted on this Order that the bank turned into a win for Cuvori (a later one is recorded now)
      if (o.status === "won" && await db.one("money_keys", `scope=eq.${q(`chargeback_result:${c0.id}:${o.id}`)}&select=scope`)) await noteLateWin(c0, o);
      // the chargeback recorded after this one, taken over from its note and not finished: finished now (a failure fails
      // this notice, so Stripe sends it again)
      if (takeoverUnfinished(await db.contract(c0.id))) await nextChargeback(c0.id);
      return "ignored";
    }
    await onDisputeCreated(o);
    c0 = await contractByPi(o.payment_intent);
    if (!c0 || c0.chargeback_id !== o.id) return "ignored";
  }
  // warning_closed on a recorded chargeback: an inquiry recorded as one before this version (Stripe took nothing): the
  // Order is unfrozen and what was pulled back is paid again, as when the bank sides with Cuvori
  const won = o.status === "won" || o.status === "warning_closed", lost = o.status === "lost";
  if (!won && !lost) return "ignored";
  const unlock = await lockOrder(c0.id);
  try {
    const r = await closeDisputeLocked(c0, o, won, lost);
    if (r === "ignored") return r;
    await dropOtherCbNote(c0.id, o.id);
    // the next chargeback on the Order's payments, if any: Stripe is asked now (a failure fails the webhook: Stripe sends
    // this notice again, and the noted one keeps the money still meanwhile)
    await nextChargebackLocked(c0.id);
    return r;
  }
  finally { await unlock(); }
}
async function closeDisputeLocked(c0, o, won, lost) {
  // the books follow Stripe before the outcome is applied (a pull-back that was still owed is made now when the bank sided with the client)
  await coverChargebackLocked(c0.id, o.id, 0, lost);
  let c = (await db.contract(c0.id)) || c0;
  if (c.chargeback_id !== o.id) return "ignored";
  if (c.chargeback_status !== "open") {
    if (won && c.chargeback_status === "won") await wonEvent(c, o.id);                                       // a retry saves it if the first try could not
    if ((won && c.chargeback_status === "won") || (lost && c.chargeback_status === "lost")) await resumeClocks(c, o);   // the same times again
    if (won && c.chargeback_status === "won" && pendingRepay(c)) { await repayWonLocked(c); return "won"; }   // the retry finishes the re-payment
    if (lost && c.chargeback_status === "lost") await recordClosedChargeback(c, o.id);
    if (o.status === "won" && c.chargeback_status === "lost") await noteLateWin(c, o);                     // the bank turned it around
    return "already";
  }
  const now = new Date().toISOString();
  if (won) {
    // the review clocks first (stored once, so a retry sets the same times), then the chargeback is closed
    await resumeClocks(c, o);
    const u = (await db.update("contracts", `id=eq.${c.id}&chargeback_id=eq.${q(o.id)}&chargeback_status=eq.open`, { chargeback_status: "won", money_error: addNote(c.money_error, "chargeback won; re-payment pending", isCbMark) }))[0];
    if (!u) return "already";
    // (the Order's own dispute, if a side opened one, is left as it is: Cuvori decides it as usual; what was pulled back
    // from the freelancer is paid back to them right away, also while the Order still holds money, and never divided)
    // the history line is what says this chargeback was won (a re-payment for it, now or in a later decision, is right only
    // then; a later chargeback replaces the Order's own record, and a notice of this one sent again is known by it): saved
    // every time, or the webhook fails. Both price plans (today's prices left it out when the database did not answer)
    await wonEvent(u, o.id);
    await contractEvent(u, "chargeback_won", c.client);
    await dropInquiryNote(await db.contract(c.id).catch(() => null), o.payment_intent).catch(e => console.error("inquiry note", c.id, e && e.message));   // the bank's inquiry on this payment is over too
    await repayWonLocked(u);
    return "won";
  }
  // A partial chargeback consumes only that payment's disputed principal. What the Order still holds goes on as before the
  // chargeback (the Order keeps its status, its own dispute if a side opened one, and its review clocks, which go on with
  // the time they had left); only a payout or decision that was under way, whose amounts no longer fit what is held, waits
  // for Cuvori's new decision.
  // Under the new prices a payout made at Stripe whose line the books don't show yet (its answer was lost) is written first,
  // so the 5% kept on it is counted before what could not be pulled back is worked out.
  if (isPlan2(c)) { await addCountedPayoutLines(c, await transfersOf(c)); c = (await db.contract(c.id)) || c; }
  let gone = await disputePrincipal(c, o);
  const principalLeft = gone;                       // 0: Cuvori had already given this payment back in full
  // what the client had already got back of this payment that the bank's chargeback takes as well (the whole payment
  // charged back after part of it went back): said on the Order (check of 7 November: nothing was said when only part of
  // the payment had gone back)
  const overlap = await chargedBackTwice(o, principalLeft);
  // what the bank took of the payment: under the new prices the chargeback's line says it whole, also when part of the
  // payment had already gone back to the client (the bank can take the whole payment then)
  const p2 = isPlan2(c), took = p2 ? bankTook(o, gone) : gone;
  const held = heldCents(c);
  let unrecovered = 0;
  if (gone > held) {
    // the bank took more than Cuvori still holds (the pull-back from the freelancer did not go through): close the
    // chargeback with what was held, and tell a person exactly what Cuvori lost. Failing for ever would keep the
    // order frozen with no way for an admin to act.
    unrecovered = gone - held; gone = held;
  }
  if (p2 && unrecovered > 0) {
    // under the new prices the 5% Cuvori kept on the payouts was never with the freelancer, so it is not pulled back (the
    // owner's decision, SETUP.md Part 20): only the freelancer's part of what is missing "could not be pulled back". What
    // was paid out of the payment the bank took is what came back from the freelancer for it plus what is missing; the 5%
    // of that (half up, as the payouts kept it; and the 5% that matches what came back, rounded up, if more) is Cuvori's,
    // never more than the Order kept; and never more is missing than the freelancer still has
    const pulled = ((await db.select("order_payments", `order_id=eq.${c.id}&kind=eq.reversal&note=eq.${q("chargeback " + o.id)}&select=amount_cents`)) || []).reduce((a, r) => a + r.amount_cents, 0);
    const bps = Number.isInteger(c.commission_bps) && c.commission_bps > 0 && c.commission_bps < 10000 ? c.commission_bps : 0;
    const kept = Math.min(nz(c.commission_cents), nz(c.released_cents));
    const fivePct = Math.min(kept, Math.max(pricingCommission(pulled + unrecovered, bps), Math.ceil(pulled * bps / (10000 - bps))));
    unrecovered = Math.min(Math.max(unrecovered - fivePct, 0), nz(c.released_cents) - kept);
  }
  // A durable plan bridges the non-transactional contract/ledger writes. If either
  // response is lost, the next webhook repairs the same ledger entry without recounting it.
  const scope = `chargeback_result:${c.id}:${o.id}`;
  const previous = await db.one("money_keys", `scope=eq.${q(scope)}&select=key`);
  let plan;
  if (previous) {
    plan = parseChargebackPlan(previous.key);
    // The chargeback is still open on the Order here, so nothing of this plan was applied (the Order's write is the first
    // step after it, and a write that landed closes the chargeback). A plan that no longer fits the books was made before
    // they changed (a pull-back from the freelancer refused then and made on a later try): it is made again from the books
    // as they are now (check of 7 November: the decided notice failed for good, and the Order stayed frozen with the
    // chargeback "open" though the bank had decided it).
    if (plan.before !== nz(c.refunded_cents) || plan.remaining + plan.amount !== held || plan.amount !== gone) {
      console.error("the chargeback's plan no longer fits the books (nothing of it was applied): made again", c.id, o.id, plan, { refunded: nz(c.refunded_cents), held, gone });
      await db.remove("money_keys", `scope=eq.${q(scope)}`);
      plan = null;
    }
  }
  if (!plan) {
    // (the new prices also keep what the bank took, for the chargeback's line: line >= amount)
    plan = { v: 1, amount: gone, before: nz(c.refunded_cents), after: nz(c.refunded_cents) + gone, remaining: held - gone, ...(p2 ? { line: took } : {}) };
    await db.insert("money_keys", { scope, key: JSON.stringify(plan) });
  }
  gone = plan.amount;
  const remaining = plan.remaining;
  const keepOpen = remaining > 0;
  // money is still held, but a payout or decision was under way for more than that: Cuvori decides again (the Order shows
  // it as a dispute, with no side named, so nobody is marked as having lost one)
  const redecide = keepOpen && ["releasing", "resolving"].includes(c.status);
  if (keepOpen && !redecide) await resumeClocks(c, o);
  // the freelancer still has something of the Order (under the new prices the paid-out total also holds the 5% Cuvori kept)
  const paidOut = p2 ? nz(c.released_cents) > nz(c.commission_cents) : nz(c.released_cents) > 0;
  const u = (await db.update("contracts", `id=eq.${c.id}&chargeback_id=eq.${q(o.id)}&chargeback_status=eq.open`, {
    chargeback_status: "lost",
    // under the new prices the Order's chargeback amount ends as what the bank took in the end (its line says the same)
    ...(p2 && plan.line !== undefined ? { chargeback_cents: plan.line } : {}),
    ...(!keepOpen ? { status: paidOut ? "completed" : "refunded", resolution: "chargeback", closed_at: now, resolved_at: now, completed_at: paidOut ? c.completed_at || now : null, auto_release_at: null }
      : redecide ? { status: "disputed", resolution: null, resolved_at: null, auto_release_at: null,
          dispute_reason: `${c.dispute_reason || ""}\nPartial chargeback lost while a ${c.status === "releasing" ? "payout" : "decision"} was under way. The remaining ${remaining} minor units need Cuvori's new decision.`.slice(-2000) }
      : {}),
    refunded_cents: plan.after,
    // the pull-back's note goes; what Cuvori covered is said for the admin; any other note stays
    // (an Order that closes: the notes of stopped steps and of a decision not on record go, closedNote)
    // (an Order sent back to a dispute: the stuck decision is gone, so its "decision not on record" note goes too; the dispute
    // asks for Cuvori's new decision. Check of 6 November, second round: the note said the old one "is then carried out")
    money_error: refundedTwice(o, principalLeft, overlap, unrecovered > 0 ? addNote(redecide ? dropNote(c.money_error, isDecisionNote) : keepOpen ? c.money_error : closedNote(c.money_error), `chargeback lost; ${(unrecovered / 100).toFixed(2)} could not be pulled back from the freelancer — Cuvori covered it, check by hand`, isCbMark)
      : dropNote(redecide ? dropNote(c.money_error, isDecisionNote) : keepOpen ? c.money_error : closedNote(c.money_error), isCbMark))
  }))[0];
  if (!u) return "already";
  await recordClosedChargeback(u, o.id);
  await orderEvent(u, "chargeback_lost", { chargeback: o.id, amount_cents: gone }, null);
  await contractEvent(u, "chargeback_lost", c.client, { amount_cents: gone });
  // the bank's inquiry on this payment is over too (never failing this step: the hourly run's inquiry list removes it then)
  await dropInquiryNote(await db.contract(c.id).catch(() => null), o.payment_intent).catch(e => console.error("inquiry note", c.id, e && e.message));
  return "lost";
}
// A chargeback decided for the client on a payment Cuvori had already given back in full (a cancel or a refund before the
// bank decided): the Order counts nothing for it, yet the bank may have taken the money from Cuvori a second time. Said on
// the Order, so a person checks it at Stripe (check of 6 November: nothing was said, and at today's prices not even a
// ledger line showed it). Its words never start like the notes the hourly run works from.
// The same when part of the payment had gone back (Cuvori's 'split', a refund in the dashboard, the card-fee refund) and the
// bank charged back more than was left of it: overlap is what the client had back already that the bank took as well.
function refundedTwice(o, principalLeft, overlap, note) {
  if (!(Number.isSafeInteger(o.amount) && o.amount > 0)) return note;
  const pi = typeof o.payment_intent === "string" ? o.payment_intent : o.payment_intent && o.payment_intent.id;
  const cur = String(o.currency || "").toUpperCase();
  if (principalLeft === 0)
    return addNote(note, `refunded payment charged back: chargeback ${o.id} on payment ${pi} was decided for the client, but Cuvori had already given this payment back in full. The bank may have taken ${(o.amount / 100).toFixed(2)} ${cur} from Cuvori a second time: check it in the Stripe dashboard under Disputes, and ask Stripe for it back if so`);
  if (!(overlap > 0)) return note;
  return addNote(note, `refunded payment charged back: chargeback ${o.id} on payment ${pi} was decided for the client, but Cuvori had already given ${(overlap / 100).toFixed(2)} ${cur} of this payment back. The bank may have taken that ${(overlap / 100).toFixed(2)} ${cur} from Cuvori a second time: check it in the Stripe dashboard under Disputes, and ask Stripe for it back if so`);
}
// what the bank's chargeback took beyond what was left of the payment (Stripe's record of the charge: its amount less what
// went back of the Order's money on it), or 0. The card-fee refund (today's prices) is left out: the client paid that fee on
// top, and noting its 1 or 2 euros on every chargeback would bury the notes that matter.
async function chargedBackTwice(o, principalLeft) {
  if (principalLeft === 0) return 0;
  const id = typeof o.charge === "string" ? o.charge : o.charge && o.charge.id;
  const pi = typeof o.payment_intent === "string" ? o.payment_intent : o.payment_intent && o.payment_intent.id;
  if (!isStripeId(id) || !isPi(pi) || !(Number.isSafeInteger(o.amount) && o.amount > 0)) return 0;
  try {
    const ch = await stripe("GET", `/charges/${id}`);
    if (!ch || !Number.isSafeInteger(ch.amount) || !Number.isSafeInteger(ch.amount_refunded)) return 0;
    const feeBack = (((await stripe("GET", "/refunds", { payment_intent: pi, limit: 100 })).data) || []).filter(r => r && FEE_REFUND(r) && r.status !== "failed" && r.status !== "canceled").reduce((a, r) => a + r.amount, 0);
    return Math.max(o.amount - (ch.amount - Math.max(ch.amount_refunded - feeBack, 0)), 0);
  } catch (e) { console.error("the charge of a chargeback could not be read", id, e && e.message); return 0; }
}
// A chargeback the bank decided for the client and Cuvori counted, which the bank later turned into a win for Cuvori after
// all (Stripe's "late win": the money comes back to Cuvori's Stripe balance). Nothing on the Order moves by itself: who the
// money belongs to now (the freelancer whose pay was pulled back, the client) is for a person to decide. Said on the Order
// once (check of 6 November: nothing was said at all); its words never start like the notes the hourly run works from,
// and no "chargeback won" history line is written (that would make a re-payment owed by itself).
const lateWinNote = (id) => (n) => n.startsWith(`late win on chargeback ${id}:`);
async function noteLateWin(c, o) {
  const scope = `late_win:${c.id}:${o.id}`;
  if (!(await claimScope(scope))) return;
  const amount = Number.isSafeInteger(o.amount) ? `${(o.amount / 100).toFixed(2)} ${String(o.currency || c.currency || "").toUpperCase()}` : "its amount";
  const row = await putNote(c.id, n => addNote(n, `late win on chargeback ${o.id}: the bank first decided it for the client (counted on this Order), then for Cuvori after all. Stripe gives ${amount} back to Cuvori's balance; nothing on this Order moved by itself. Decide by hand who it belongs to now (the Stripe dashboard shows it under Disputes), then mark this note as handled`, lateWinNote(o.id)));
  if (!row || !hasNote(row.money_error, lateWinNote(o.id))) { await dropKey(scope); return; }      // not written: the notice sent again writes it
  console.error("a lost chargeback the bank later decided for Cuvori (late win): noted", c.id, o.id);
}
// What the bank took in the end for a lost chargeback, from Stripe's own record of it (the dispute's balance
// transactions: what Stripe took from Cuvori's balance, less what it gave back, as when the client's bank charged back the
// whole payment and the refund already made was proven, which Stripe calls "partially won"; the dispute fee is separate).
// Without that record: the chargeback's amount. Never less than what the Order still counted of the payment, never more
// than the chargeback.
function bankTook(o, gone) {
  const amount = Number.isSafeInteger(o.amount) && o.amount > 0 ? o.amount : gone;
  const bts = Array.isArray(o.balance_transactions) ? o.balance_transactions : [];
  const cur = String(o.currency || "").toLowerCase();
  const usable = bts.length > 0 && bts.every(b => b && typeof b === "object" && Number.isSafeInteger(b.amount) && String(b.currency || "").toLowerCase() === cur);
  const net = usable ? -bts.reduce((a, b) => a + b.amount, 0) : amount;
  return Math.max(gone, Math.min(net, amount));
}
// The review clocks of an Order stop while a bank chargeback is open (nothing is paid out then: the hourly run sets the
// Order aside) and go on once the bank has decided and the Order still holds money, with the time they had left when the
// chargeback was opened; a clock that started during the chargeback (work handed in meanwhile) gets its whole review
// period. A clock is never moved earlier. Worked out once per chargeback and stored, so a retry sets the same times. When
// it was opened: Stripe's own time of the chargeback, else the Order's history line of it; not known: the clocks stay.
async function resumeClocks(c, o) {
  const scope = `chargeback_clock:${c.id}:${o.id}`;
  const stored = async () => { const r = await db.one("money_keys", `scope=eq.${q(scope)}&select=key`); try { return r ? JSON.parse(r.key) : null; } catch { return null; } };
  let plan = await stored();
  if (!plan) {
    let from = Number.isSafeInteger(o.created) && o.created > 0 ? o.created * 1000 : null;
    if (from === null) {
      const ev = ((await db.select("order_events", `order_id=eq.${c.id}&event=eq.chargeback&select=data,created_at`)) || []).find(e => e && e.data && e.data.chargeback === o.id);
      const t = ev ? Date.parse(ev.created_at) : NaN;
      if (Number.isFinite(t)) from = t;
    }
    if (from === null) return;
    const now = Date.now(), days = (Number.isInteger(c.auto_days) && c.auto_days > 0 ? c.auto_days : 7) * 864e5;
    const next = (at) => {
      const t = Date.parse(at || "");
      if (!Number.isFinite(t)) return null;
      const left = t - Math.max(from, t - days);                       // what the clock had left when the chargeback came
      return left > 0 && now + left > t ? new Date(now + left).toISOString() : null;
    };
    const parts = (await db.select("order_milestones", `order_id=eq.${c.id}&status=eq.submitted&select=id,auto_release_at`)) || [];
    plan = { v: 1, order: c.status === "delivered" ? next(c.auto_release_at) : null, ms: Object.fromEntries(parts.map(m => [m.id, next(m.auto_release_at)]).filter(([, at]) => at)) };
    try { await db.insert("money_keys", { scope, key: JSON.stringify(plan) }); }
    catch (e) { const again = await stored(); if (!again) throw e; plan = again; }
  }
  if (plan.order) await db.update("contracts", `id=eq.${c.id}&status=eq.delivered`, { auto_release_at: plan.order });
  for (const [id, at] of Object.entries(plan.ms || {})) if (isUuid(id)) await db.update("order_milestones", `id=eq.${id}&status=eq.submitted`, { auto_release_at: at });
}
function parseChargebackPlan(raw) {
  const p = JSON.parse(raw);
  if (p.v !== 1 || ![p.amount, p.before, p.after, p.remaining].every(n => Number.isSafeInteger(n) && n >= 0) || p.after !== p.before + p.amount)
    throw new Error("invalid chargeback accounting plan");
  if (p.line !== undefined && !(Number.isSafeInteger(p.line) && p.line >= p.amount)) throw new Error("invalid chargeback accounting plan");
  return p;
}
// The lost chargeback's line. Under the new prices it says what the bank took in full, and what of it the Order's refund
// total counts (what Cuvori still held: "chargeback_lost counted <cents>" when that is less). The database never lets an
// Order count more paid out and given back than paid in, so the total can't take the rest.
async function recordClosedChargeback(c, disputeId) {
  const stored = await db.one("money_keys", `scope=eq.${q(`chargeback_result:${c.id}:${disputeId}`)}&select=key`);
  // Old closures have no plan. Their historical counters cannot be reconstructed here.
  if (!stored) return;
  const plan = parseChargebackPlan(stored.key);
  if (nz(c.refunded_cents) < plan.after) throw new Error("chargeback counter is not recorded");
  const p2 = isPlan2(c), amount = p2 && plan.line !== undefined ? plan.line : plan.amount;
  if (!amount) return;
  const existing = await db.one("order_payments", `order_id=eq.${c.id}&kind=eq.chargeback&provider_ref=eq.${q(disputeId)}&select=amount_cents`);
  if (existing) {
    if (existing.amount_cents !== amount) throw new Error("chargeback ledger amount mismatch");
    return;
  }
  if (p2) {
    const line = { kind: "chargeback", amount_cents: amount, provider_ref: disputeId, entry_key: entryKey("chargeback", disputeId), note: amount === plan.amount ? "chargeback_lost" : `chargeback_lost counted ${plan.amount}` };
    if (!(await ledger(c, line, byKey("chargeback", disputeId)))) throw new Error(`the chargeback line of ${disputeId} could not be saved`);
    return;
  }
  await db.insert("order_payments", { order_id: c.id, provider: "stripe", status: "succeeded", kind: "chargeback", amount_cents: plan.amount, provider_ref: disputeId, note: "chargeback_lost" });
}
// "chargeback won" in the Order's history, once per chargeback; one that can't be saved fails the step (Stripe sends the
// notice again), never left out in silence
async function wonEvent(c, disputeId) {
  const there = ((await db.select("order_events", `order_id=eq.${c.id}&event=eq.chargeback_won&select=data`)) || []).some(e => e && e.data && e.data.chargeback === disputeId);
  if (there) return;
  await db.insert("order_events", { order_id: c.id, actor: null, event: "chargeback_won", data: { chargeback: disputeId } });
}
// The bank sided with Cuvori: money that was pulled back from the freelancer goes to them again — unless the
// Order is still holding, where it is part of the held amount and the dispute decision moves it. Safe to
// repeat: the transfer is looked up before it is made, and the ledger says what was already paid again.
// Called from the webhook, from its retries, and from the hourly job while `money_error` says it is owed.
export async function repayWon(c0) {
  const unlock = await lockOrder(c0.id);
  try { return await repayWonLocked(c0); } finally { await unlock(); }
}
// A re-payment after a won chargeback that the Order's note still says is owed (Stripe's answer was lost, the count after it
// was refused, or the freelancer's Stripe account was not ready): made or counted now, before the freelancer's cancel or
// Cuvori's decision works out what the Order holds, so what it records and answers is what moves (check of 6 November).
// Not done now (Stripe not answering): the settlement counts what Stripe made anyway, and the hourly run tries again.
export async function repayFirst(c) {
  if (!c || c.chargeback_status !== "won" || !pendingRepay(c)) return c;
  try { await repayWon(c); } catch (e) { console.error("the re-payment before a cancel or a decision", c.id, e && e.message); }
  return (await db.contract(c.id).catch(() => null)) || c;
}
// Every payout of the Order at Stripe that the books don't show, counted and written down the way a settlement counts it
// (under the Order's lock; a decision being carried out keeps its own payout for its settlement). The Order, as it is then.
// (a payout paid in pieces from money held apart that is not whole yet is left to its own step, which goes on with the
// pieces made and counts the payout once it is whole: counted here, a piece was counted twice; check of 7 November)
async function bookAllUnbooked(c, ev) {
  const ts = await transfersOf(c), rows = await linesOf(c);
  const todo = ts.filter(t => !isPart(t) || payoutWhole(ts, t));
  if (!todo.some(t => !hasLine(rows, "release", t.id))) return { c, ts, rows };
  if (isPlan2(c)) c = (await bookUnbookedV2(c, todo, ev, false)).c;
  else c = await countUnbookedP1(c, rows, todo, ev);
  return { c, ts, rows: await linesOf(c) };
}
// Every payout at Stripe the books don't show (a part's payout whose answer was lost, a re-payment after a won chargeback),
// counted before the freelancer's cancel or Cuvori's decision works out what the Order holds, the way a settlement counts
// them: what the cancel or the decision records and answers is then what really moves (check of 7 November: with a part's
// payout not counted yet, the cancel answered and recorded 100.00 given back where 40.00 went back, and a 'split' recorded
// 50.00/50.00 where 20.00/20.00 moved). A decision being carried out keeps its own payout for its settlement. Not done now
// (Stripe or the database not answering, or another step moving this Order's money at this moment): nothing is decided or
// cancelled, and the person tries again in a minute (check of 8 November: the cancel then went ahead with the books as they
// were, and its history said 100.00 went back where 40.00 did).
export async function countFirst(c) {
  if (!c) return c;
  try {
    const unlock = await lockOrder(c.id);
    try {
      const cur = await db.contract(c.id);
      if (cur && cur.payment_mode === "escrow" && !chargebackOpen(cur) && (!cur.paid_mode || cur.paid_mode === STRIPE_MODE))
        await bookAllUnbooked(cur, "payout counted before a cancel or a decision");
    } finally { await unlock(); }
  } catch (e) {
    console.error("counting the payouts before a cancel or a decision", c.id, e && e.message);
    if (e && e.expose) throw e;                                             // another step is moving this Order's money ("busy")
    // refused for good (the books can't take a payout Stripe made): never "try again"; the Order's note says what to check
    // (check of 8 November, re-check)
    if (refusedForGood(e)) {
      // (the note it points to, or "try again in a minute": never "see the Order's note" with no note there)
      if (!(await noteUncounted(c, e, "before a cancel or a decision"))) throw fail(PROVIDER_DOWN, 503, "provider_down");
      throw fail("This Order's books need a check by hand first: Stripe made payouts for it that its books can't take (see the Order's note). Nothing has moved.", 409, "under_review");
    }
    throw fail(PROVIDER_DOWN, 503, "provider_down");
  }
  return repayFirst((await db.contract(c.id).catch(() => null)) || c);
}
// What Stripe paid out of the Order that its paid-out total does not count yet (a part's payout whose answer was lost, a
// re-payment after a won chargeback). Read only, for the freelancer's cancel preview (it changes nothing): the cancel itself
// counts it first (countFirst).
export async function payoutsNotCounted(c) {
  if (!c) return 0;
  const attempt = c.status === "resolving" ? String(c.resolved_at || "") : "";
  const ts = (await transfersOf(c)).filter(t => !(attempt && (t.metadata.attempt || "") === attempt && !(t.metadata.milestone_id || "")));
  if (!ts.length) return 0;
  const rows = await linesOf(c);
  const missing = ts.filter(t => !hasLine(rows, "release", t.id)).reduce((a, t) => a + Math.max((isPlan2(c) ? grossOf(t) : t.amount) - nz(t.amount_reversed), 0), 0);
  const ahead = Math.max(nz(c.released_cents) - (sumKind(rows, "release") - sumKind(rows, "reversal")), 0);
  return Math.max(missing - ahead, 0);
}
// Said once per chargeback and amount (its key), so a note marked as handled never comes back; one that can't be saved
// fails the step (Stripe sends its notice again, the hourly run tries again: the re-payment waiting note stays meanwhile).
export const REPAY_SHORT_HEAD = "freelancer not paid back after chargeback ";
async function noteRepayShort(c, short) {
  if (!(short > 0)) return;
  const key = `repay_short:${c.id}:${c.chargeback_id}:${short}`;
  if (await db.one("money_keys", `scope=eq.${q(key)}&select=scope`)) return;
  const amount = `${(short / 100).toFixed(2)} ${String(c.currency || "EUR").toUpperCase()}`;
  const text = `${REPAY_SHORT_HEAD}${c.chargeback_id}: ${amount} pulled back from them for it was not paid to them again, as the Order has nothing left for it (money went out twice?). Check its payouts and refunds in the Stripe dashboard and decide whether to pay it to them by hand`.slice(0, 300);
  const row = await putNote(c.id, n => addNote(n, text, x => x.startsWith(`${REPAY_SHORT_HEAD}${c.chargeback_id}:`))).catch(() => null);
  if (!(row && hasNote(row.money_error, x => x === text))) { const e = new Error(`the note about the freelancer not paid back on order ${c.id} could not be saved`); e.outcomeUnknown = true; throw e; }
  await db.insert("money_keys", { scope: key, key: "noted" }).catch(() => {});
}
async function repayWonLocked(c0) {
  let c = (await db.contract(c0.id)) || c0;
  if (c.chargeback_status !== "won") return 0;
  // Only what THIS chargeback pulled back is paid again, less what was paid again for it already, and never more than the
  // client still has paid in that the freelancer doesn't have. Counting every pull-back on the Order paid the freelancer
  // again for a chargeback the bank decided for the client (the client had that money back): audit of 31 October.
  const ts = await transfersOf(c);
  const p2 = isPlan2(c);
  // A re-payment Stripe made whose count or line was lost (an earlier try broke off after the transfer) is counted and
  // written now, before anything is worked out from it (it would otherwise read as paid back and never be counted; check of
  // 2 November) — and with it every other payout the books don't show, the same way the settlement counts them, so a cancel
  // or a decision that runs this first works out what the Order holds as the settlement will (check of 6 November, second
  // round). The decision being carried out keeps its own payouts: its settlement counts them.
  // What the database refuses to take for good (paid out and given back would be more than was paid in: a refund in the
  // Stripe dashboard after a payout the books did not show) is said on the Order for a person, and the re-payment is worked
  // out with the books as they are: what is paid again comes from Stripe's own records (this chargeback's pull-backs, what
  // the Order still has), never from the count (fixes of 9 November: the refused count failed the bank's "won" notice every
  // time Stripe sent it, and the Order waited for a re-payment for ever). Anything else fails as before (Stripe sends the
  // notice again; the hourly run tries again).
  const before = nz(c.released_cents);
  try {
    if (p2) ({ c } = await bookUnbookedV2(c, ts, "chargeback_won", false));
    else c = await countUnbookedP1(c, (await db.select("order_payments", `order_id=eq.${c.id}&status=eq.succeeded&kind=in.(release,reversal)&select=kind,amount_cents,provider_ref`)) || [], ts, "payout counted from Stripe's record");
  } catch (e) {
    if (!refusedForGood(e)) throw e;
    await mustNoteUncounted(c, e, `at chargeback ${c.chargeback_id} won`);
    c = (await db.contract(c.id)) || c;
  }
  const counted = Math.max(nz(c.released_cents) - before, 0);
  const pulled = ((await db.select("order_payments", `order_id=eq.${c.id}&kind=eq.reversal&note=eq.${q("chargeback " + c.chargeback_id)}&select=amount_cents`)) || []).reduce((a, r) => a + r.amount_cents, 0);
  // (under the new prices a payout counts as paid out at its full amount, the 5% with it: what the Order still has is what
  // the client paid in less refunds and the payouts' full amounts, net of pull-backs)
  const netOut = (list) => list.reduce((a, t) => a + (p2 ? grossOf(t) : t.amount) - nz(t.amount_reversed), 0);
  const repaid = ts.filter(t => t.metadata.purpose === `retransfer_${c.chargeback_id}`).reduce((a, t) => a + t.amount, 0);   // (at its full amount: owedRepays)
  const stillIn = Math.max(nz(c.funded_cents) - nz(c.refunded_cents) - netOut(ts), 0);
  const back = Math.min(pulled - repaid, stillIn);
  // What this chargeback pulled back that can't be paid again (the Order has nothing left for it: money went out twice, a
  // refund in the Stripe dashboard after a payout, say) is said on the Order for a person, with the amount, before the
  // re-payment waiting note goes (re-check of 9 November: it went with nothing saying the freelancer was not paid back)
  await noteRepayShort(c, Math.max(pulled - repaid, 0) - Math.max(back, 0));
  const repayMark = (n) => n.startsWith("chargeback won");
  if (back <= 0) { if (pendingRepay(c)) await putNote(c.id, n => dropNote(n, repayMark)); return counted; }
  // Paid right away, also while the Order still holds money for its other parts (check of 2 November). Waiting for "the
  // next payout or decision" gave the freelancer's pay for an approved part to the client when the next step was a cancel
  // or a 'refund', and froze the Order for good when a second chargeback was noted meanwhile (it waits for this re-payment,
  // and its note stopped every payout and decision that would have made it). A cancel or a decision never divides what is
  // still owed here (owedBack); when it can't be paid now (the freelancer's Stripe account not ready), the note stays and
  // the hourly run tries again.
  try {
    const out = {};
    const t = await releaseToEditor(c, back, null, `retransfer_${c.chargeback_id}`, { out });
    const v0 = (await db.update("contracts", `id=eq.${c.id}`, { released_cents: nz(c.released_cents) + back }))[0];
    const v = (await putNote(c.id, n => dropNote(n, repayMark))) || v0;                  // paid again: the re-payment's note goes, any other stays
    // the line is what says the re-payment was made (what is still owed is worked out from it): checked, never left out in
    // silence. Under the new prices it keeps nothing again and names its chargeback ("chargeback_won <dispute id>").
    // (from money held apart: one line per part)
    const repParts = p2 ? (out.transfers || (out.transfer ? [out.transfer] : [])) : [];
    for (const x of repParts.length ? repParts : [null]) {
      const line = x ? payoutLine(x) : { kind: "release", amount_cents: back, provider_ref: t, note: "chargeback_won" }, ref = x ? x.id : t;
      if (!(await ledger(v || c, line, p2 ? byKey("release", ref) : `kind=eq.release&note=like.chargeback_won*&provider_ref=eq.${q(t)}`)))
        await putNote(c.id, n => addNote(n, `${REPAY_LINE_NOTE}${ref} (${back} paid again after chargeback ${c.chargeback_id}; the hourly run adds it from Stripe's record; if this note stays, check by hand)`));
    }
    return back;
  } catch (e) {
    console.error("re-pay after won chargeback", c.id, e.message);
    const text = ("chargeback won, re-payment failed: " + failNote(e, `paying again after chargeback ${c.chargeback_id}`)).slice(0, 300);
    await putNote(c.id, n => addNote(n, text, isCbMark));
    if (retryable(e)) throw e;                                             // no answer: the webhook fails and Stripe sends the event again
    return 0;                                                              // a plain no (account not ready, money settling): the hourly job tries again
  }
}
