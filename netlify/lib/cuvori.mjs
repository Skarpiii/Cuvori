// Shared helpers for Cuvori's Netlify functions (hardened copy).
// v18: the Order is the contract. The DB table is still `contracts`; every row is an Order.
// v21: money that survives the real world — several payments per Order (top-ups), transfers tied to
// their charge, refunds spread over the payments they came from, chargebacks before and after a
// release, retries that never pay twice (fresh idempotency keys after a definite failure, the same
// key after an unknown outcome), and a reconciliation path when a webhook never arrives.
import crypto from "node:crypto";

export const SUPABASE_URL = process.env.SUPABASE_URL || "https://tnxujwlfatcvxzevllfr.supabase.co";
// Supabase's dashboard now calls this the "secret key"; accept either name so a sensible copy-paste works
export const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
export const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || "";
export const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
export const SITE_URL = (process.env.SITE_URL || process.env.URL || "https://cuvori.netlify.app").replace(/\/$/, "");
// the page may live on another host (GitHub Pages) and call these functions across origins
export const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || `${SITE_URL},https://cuvori.io,https://www.cuvori.io`).split(",").map(s => s.trim().replace(/\/$/, "")).filter(Boolean);
export const AUTO_RELEASE_DAYS = 7; // hard-coded in order_action() too
export const MIN_CENTS = 100, MAX_CENTS = 100000000;
export const HOLDING = ["funded", "delivered", "disputed"];

export function escrowEnabled() { return !!(STRIPE_KEY && SERVICE_KEY); }

let corsOrigin = null;
export function setCors(req) { const o = (req && req.headers.get("origin") || "").replace(/\/$/, ""); corsOrigin = ALLOWED_ORIGINS.includes(o) ? o : null; }
const corsHeaders = () => corsOrigin ? { "access-control-allow-origin": corsOrigin, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS", "vary": "origin" } : {};
export const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...corsHeaders() } });
export const bad = (msg, status = 400) => json(status, { error: msg });
export const isUuid = (s) => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
export const isAcct = (s) => typeof s === "string" && /^acct_[A-Za-z0-9]{8,64}$/.test(s);
export const isPi = (s) => typeof s === "string" && /^pi_[A-Za-z0-9_]{4,80}$/.test(s);
export const isStripeId = (s) => typeof s === "string" && /^[a-z]{2,4}_[A-Za-z0-9_]{4,80}$/.test(s);
export const isSession = (s) => typeof s === "string" && /^cs_[A-Za-z0-9_]{4,120}$/.test(s);
export const centsOf = (c) => (Number.isInteger(c.amount_cents) && c.amount_cents > 0 ? c.amount_cents : null);
const nz = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
// what the provider is holding for this Order right now (Orders from before v18 carry no counters)
export const heldCents = (c) => { const f = nz(c.funded_cents) || (["funded", "delivered", "disputed", "releasing", "resolving"].includes(c.status) ? centsOf(c) || 0 : 0); return Math.max(f - nz(c.released_cents) - nz(c.refunded_cents), 0); };
export const chargebackOpen = (c) => !!c && c.chargeback_status === "open";
export async function readJson(req) { try { const b = await req.json(); return b && typeof b === "object" && !Array.isArray(b) ? b : {}; } catch { return {}; } }
// Never let an exception (Stripe/Supabase message, stack) reach the browser
export const safe = (fn) => async (req, ctx) => {
  setCors(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  try { return await fn(req, ctx); }
  catch (e) {
    if (e && e.expose) return bad(e.message, e.status || 409);
    const ref = crypto.randomUUID().slice(0, 8); console.error("fn error", ref, e && e.stack || e);
    return bad(`Something went wrong (ref ${ref})`, 500);
  }
};
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
  let data; try { data = await r.json(); } catch { data = {}; }
  if (!r.ok) { const e = new Error((data.error && data.error.message) || "Stripe error"); e.stripe = data.error || {}; e.status = r.status; throw e; }
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
async function sbFetch(path, init = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, { ...init, signal: AbortSignal.timeout(8000), headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json", Prefer: init.prefer || "return=representation", ...(init.headers || {}) } });
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
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${m[1]}` }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const u = await r.json();
  if (!u || !isUuid(u.id)) return null;
  return db.one("profiles", `id=eq.${u.id}&select=id,email,first_name,role,is_admin,banned`);
}
export const isBanned = async (uid) => { const p = await db.one("profiles", `id=eq.${uid}&select=banned`); return !p || !!p.banned; };

// ---- the price the client pays: from the fee table in the database, never a number in code ----
export async function quoteFor(priceCents, currency = "EUR", country = null, customer = "any", method = "any") {
  const qte = await db.rpc("order_quote", { p_price_cents: priceCents, p_currency: currency, p_country: country, p_customer: customer, p_method: method });
  if (!qte || !Number.isInteger(qte.total_cents) || qte.total_cents < priceCents) throw new Error("bad quote");
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
// Stripe replays the first result of a key for 24 h, errors included. So: one key per attempt-scope, kept
// while the outcome is unknown (network trouble, another request in flight), thrown away after a definite
// failure so the next attempt is a real attempt. A Stripe-side lookup before every money call is the
// second guard: a transfer or refund that already exists is never made twice, whatever the key.
export async function moneyKey(scope) {
  const row = await db.one("money_keys", `scope=eq.${q(scope)}&select=key`);
  if (row && row.key) return row.key;
  const key = `${scope}:${crypto.randomUUID().slice(0, 12)}`;
  try { await db.insert("money_keys", { scope, key }); return key; }
  catch (e) { const again = await db.one("money_keys", `scope=eq.${q(scope)}&select=key`); if (again && again.key) return again.key; throw e; }
}
export const dropKey = (scope) => db.remove("money_keys", `scope=eq.${q(scope)}`).catch(() => {});
async function moneyPost(scope, path, body) {
  const key = await moneyKey(scope);
  try { return await stripe("POST", path, body, { idempotency: key }); }
  catch (e) { if (e.status && !isIdemInFlight(e)) await dropKey(scope); throw e; }   // a definite no: next time a fresh key
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
export const accountReady = (a) => !!(a && a.payouts_enabled && (a.capabilities ? a.capabilities.transfers === "active" : true));

// ---- money movements ----
export async function transfersOf(c) { const r = await stripe("GET", "/transfers", { transfer_group: `contract_${c.id}`, limit: 100 }); return (r.data || []).filter(t => t.metadata && t.metadata.contract_id === c.id); }

// Pay the freelancer. `purpose` separates a normal release from paying again after a chargeback was won.
export async function releaseToEditor(c, editorCents, milestoneId = null, purpose = "release") {
  if (!Number.isInteger(editorCents) || editorCents <= 0) throw new Error("bad release amount");
  if (purpose === "release" && editorCents > heldCents(c)) throw new Error("bad release amount");
  if (chargebackOpen(c)) throw fail(CHARGEBACK);
  const existing = await transfersOf(c);
  const prior = existing.find(t => !t.reversed && (t.metadata.milestone_id || "") === (milestoneId || "") && (t.metadata.purpose || "release") === purpose);
  if (prior) { if (prior.amount !== editorCents) throw new Error(`transfer ${prior.id} exists with a different amount`); return prior.id; }
  const acct = await payoutAccount(c.editor);
  if (!accountReady(acct)) throw fail(NOT_READY);
  // tie the transfer to the card charge when there is exactly one: Stripe then allows it before the money
  // has settled. Several charges (top-ups) or a re-payment draw on the balance instead.
  const funds = await fundRows(c);
  const charges = [...new Set(funds.map(f => f.charge_ref).filter(isStripeId))]; if (!charges.length && isStripeId(c.stripe_charge_id)) charges.push(c.stripe_charge_id);
  const fundedFrom = funds.length ? funds.length : (c.stripe_payment_intent ? 1 : 0);
  const source = purpose === "release" && charges.length === 1 && fundedFrom <= 1 ? charges[0] : undefined;
  const scope = `transfer:${c.id}:${milestoneId || ""}:${purpose}`;
  const body = { amount: editorCents, currency: (c.currency || "EUR").toLowerCase(), destination: acct.id, transfer_group: `contract_${c.id}`,
    description: `Cuvori order ${c.id}${milestoneId ? " milestone " + milestoneId : ""}`, metadata: { contract_id: c.id, milestone_id: milestoneId || "", purpose } };
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
// as far as that payment still allows. Returns the refund ids.
export async function refundToClient(c, cents) {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error("bad refund amount");
  if (chargebackOpen(c)) throw fail(CHARGEBACK);
  const funds = await fundRows(c);
  const sources = funds.length ? funds.map(f => ({ pi: f.provider_ref, amount: f.amount_cents })).reverse() : (c.stripe_payment_intent ? [{ pi: c.stripe_payment_intent, amount: nz(c.funded_cents) || centsOf(c) || 0 }] : []);
  if (!sources.length) throw new Error("no payment to refund");
  // what each payment should have given back once this refund is complete (deterministic, so a retry lands on the same plan)
  let left = cents; const plan = [];
  for (const s of sources) { if (left <= 0) break; if (!isPi(s.pi)) continue; const part = Math.min(left, s.amount); plan.push({ pi: s.pi, cents: part }); left -= part; }
  if (left > 0) throw new Error("refund exceeds what was paid");
  const ids = [];
  try {
    for (const p of plan) {
      const existing = await stripe("GET", "/refunds", { payment_intent: p.pi, limit: 50 });
      const ours = (existing.data || []).filter(r => r.metadata && r.metadata.contract_id === c.id && !r.metadata.reason && r.status !== "failed" && r.status !== "canceled");
      const done = ours.reduce((a, r) => a + r.amount, 0);
      if (done >= p.cents) { ids.push(...ours.map(r => r.id)); continue; }
      const r = await moneyPost(`refund:${c.id}:${p.pi}:${done}`, "/refunds", { payment_intent: p.pi, amount: p.cents - done, metadata: { contract_id: c.id } });
      ids.push(...ours.map(x => x.id), r.id);
    }
  } catch (e) {
    if (stripeCode(e) === "balance_insufficient" || /insufficient funds/i.test(e.message)) throw fail("The payment provider cannot pay this refund yet (balance still settling). Cuvori retries every hour.");
    if (stripeCode(e) === "charge_disputed" || /charged back/i.test(e.message)) throw fail(CHARGEBACK);
    if (e.network) throw fail("The payment provider did not answer. Nothing was lost — please try again in a minute.", 503);
    throw e;
  }
  return ids.join(",");
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
export async function settle(c, actor, ev) {
  if (chargebackOpen(c)) throw fail(CHARGEBACK);
  const editorCents = c.split_editor_cents || 0, refundCents = c.refund_cents || 0;
  if (editorCents + refundCents > heldCents(c)) throw new Error("settlement exceeds held amount");
  let transferId = c.stripe_transfer_id, refundId = c.stripe_refund_id;
  try {
    if (editorCents > 0 && !transferId) { transferId = await releaseToEditor(c, editorCents); await db.update("contracts", `id=eq.${c.id}&status=eq.${c.status}`, { stripe_transfer_id: transferId }); }
    if (refundCents > 0 && !refundId) { refundId = await refundToClient(c, refundCents); await db.update("contracts", `id=eq.${c.id}&status=eq.${c.status}`, { stripe_refund_id: refundId }); }
  } catch (e) {
    await db.update("contracts", `id=eq.${c.id}`, { money_error: String(e.message).slice(0, 300) }).catch(() => {});
    throw e;
  }
  const now = new Date().toISOString();
  const u = (await db.update("contracts", `id=eq.${c.id}&status=eq.${c.status}`, { status: editorCents > 0 ? "completed" : "refunded",
    completed_at: editorCents > 0 ? now : null, closed_at: now, resolved_at: now, money_error: null, auto_release_at: null,
    released_cents: nz(c.released_cents) + editorCents, refunded_cents: nz(c.refunded_cents) + refundCents,
    funded_cents: nz(c.funded_cents) || centsOf(c) || 0 }))[0];
  if (!u) { await db.update("contracts", `id=eq.${c.id}`, { money_error: `settled at the provider (${transferId || ""} ${refundId || ""}) but the order changed meanwhile — check by hand` }).catch(() => {}); throw new Error("order changed during settlement"); }
  if (u) {
    if (editorCents > 0) await ledger(u, { kind: "release", amount_cents: editorCents, provider_ref: transferId, note: ev });
    if (refundCents > 0) await ledger(u, { kind: "refund", amount_cents: refundCents, provider_ref: String(refundId).slice(0, 200), note: ev });
    await orderEvent(u, ev === "approve" ? "released" : ev === "auto_release" ? "auto_released" : ev.startsWith("resolved") ? "resolved" : ev, { editor_cents: editorCents, refund_cents: refundCents, decision: u.resolution }, actor);
    await contractEvent(u, ev, actor, { amount_cents: editorCents || refundCents });
  }
  return u;
}

// Release one milestone: transfer its amount, mark it released, add it to the Order's counters.
// When it was the last one the Order is complete.
export async function releaseMilestone(c, m, actor, ev) {
  if (!m || m.order_id !== c.id) throw fail("Milestone does not belong to this order", 409);
  if (!["submitted", "approved"].includes(m.status)) throw fail("This milestone is not waiting for approval", 409);
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
  const amountOk = Number.isInteger(amount) && amount > 0 && (kind === "fund" ? amount === expected : amount <= expected);   // a top-up may be part of what is owed
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
    const rows = await db.update("contracts", `id=eq.${id}&status=in.(funded,delivered)&funded_cents=eq.${nz(c.funded_cents)}`, { funded_cents: nz(c.funded_cents) + amount });
    u = rows && rows[0];
    if (!u) {
      const again = await db.one("order_payments", `order_id=eq.${id}&provider_ref=eq.${q(s.payment_intent)}&select=id`);
      if (again) return "already";
      return refundOrphan(s, `top-up no longer applies (order is ${c.status})`);
    }
  }
  await ledger(u, { kind: "fund", amount_cents: amount, fee_cents: fee, provider_ref: s.payment_intent, charge_ref: charge && charge.id || null, provider_fee_cents: bt && Number.isInteger(bt.fee) ? bt.fee : null, note: kind });
  await orderEvent(u, kind === "fund" ? "funded" : "topped_up", { amount_cents: amount, fee_cents: fee, total_cents: amount + fee }, c.client);
  await contractEvent(u, "funded", c.client, { amount_cents: amount });
  const card = charge && charge.payment_method_details && charge.payment_method_details.card;
  if (card && card.fingerprint) await db.rpc("record_card", { uid: c.client, fingerprint: card.fingerprint, label: `${card.brand || "card"} ••${card.last4 || "????"}` }).catch(e => console.error("card", e.message));
  return "funded";
}

// ---- chargebacks: the bank pulls the money back on the client's word; Cuvori answers with the facts ----
export async function onDisputeCreated(o) {
  const c = await contractByPi(o.payment_intent);
  if (!c) return "ignored";
  if (c.chargeback_id === o.id) return "already";
  const cents = Number.isInteger(o.amount) ? o.amount : 0;
  const base = { chargeback_id: o.id, chargeback_status: "open", chargeback_cents: cents, auto_release_at: null };
  await db.update("order_milestones", `order_id=eq.${c.id}`, { auto_release_at: null }).catch(() => {});
  let u = null;
  if (HOLDING.includes(c.status) || c.status === "releasing" || c.status === "resolving") {
    u = (await db.update("contracts", `id=eq.${c.id}`, { ...base, status: "disputed", dispute_reason: `Card chargeback ${o.id} (${o.reason || "no reason given"})`, disputed_at: c.disputed_at || new Date().toISOString(), dispute_by: c.dispute_by || c.client }))[0];
  } else {
    // the money already went to the freelancer: pull it back so the dispute is covered, then follow the outcome
    u = (await db.update("contracts", `id=eq.${c.id}`, base))[0];
    const toReverse = Math.min(nz(c.released_cents), cents || nz(c.released_cents));
    if (toReverse > 0) {
      try {
        const r = await reverseTransfers(c, toReverse, o.id);
        if (r.reversed > 0) {
          u = (await db.update("contracts", `id=eq.${c.id}`, { stripe_reversal_id: r.ids.slice(0, 200), released_cents: nz(c.released_cents) - r.reversed }))[0];
          await ledger(u, { kind: "reversal", amount_cents: r.reversed, provider_ref: r.ids.slice(0, 200), note: `chargeback ${o.id}` });
        }
      } catch (e) { console.error("reversal", c.id, e.message); await db.update("contracts", `id=eq.${c.id}`, { money_error: ("chargeback: " + e.message).slice(0, 300) }).catch(() => {}); }
    }
  }
  await orderEvent(u || c, "chargeback", { chargeback: o.id, amount_cents: cents, reason: o.reason || "" }, null);
  await contractEvent(u || c, "dispute", c.client, { amount_cents: cents, label: "chargeback" });
  const flagged = await db.one("user_flags", `user_id=eq.${c.client}&contract_id=eq.${c.id}&kind=eq.chargeback&select=id`);
  if (!flagged) await db.insert("user_flags", { user_id: c.client, kind: "chargeback", reason: `Chargeback ${o.id} on "${String(c.title).slice(0, 120)}" (order was ${c.status})`, contract_id: c.id }).catch(() => {});
  return "recorded";
}
export async function onDisputeClosed(o) {
  const c = await contractByPi(o.payment_intent);
  if (!c || c.chargeback_id !== o.id) return "ignored";
  const won = o.status === "won", lost = o.status === "lost";
  if (!won && !lost) return "ignored";
  if (c.chargeback_status !== "open") return "already";
  const now = new Date().toISOString();
  if (won) {
    const u = (await db.update("contracts", `id=eq.${c.id}&chargeback_status=eq.open`, { chargeback_status: "won", money_error: null }))[0];
    if (!u) return "already";
    if (u.status === "disputed") await db.update("contracts", `id=eq.${c.id}`, { dispute_reason: `${u.dispute_reason || ""}\nThe bank sided with Cuvori. Decide the dispute as usual.`.slice(0, 2000) });
    // money that was pulled back from the freelancer goes to them again
    const back = (await db.select("order_payments", `order_id=eq.${c.id}&kind=eq.reversal&select=amount_cents`) || []).reduce((a, r) => a + r.amount_cents, 0) - (await db.select("order_payments", `order_id=eq.${c.id}&kind=eq.release&note=eq.chargeback_won&select=amount_cents`) || []).reduce((a, r) => a + r.amount_cents, 0);
    if (back > 0 && !HOLDING.includes(u.status)) {
      try {
        const t = await releaseToEditor(u, back, null, `retransfer_${o.id}`);
        const v = (await db.update("contracts", `id=eq.${c.id}`, { released_cents: nz(u.released_cents) + back, money_error: null }))[0];
        await ledger(v, { kind: "release", amount_cents: back, provider_ref: t, note: "chargeback_won" });
      } catch (e) { console.error("re-pay after won chargeback", c.id, e.message); await db.update("contracts", `id=eq.${c.id}`, { money_error: ("chargeback won, re-payment failed: " + e.message).slice(0, 300) }).catch(() => {}); }
    }
    await orderEvent(u, "chargeback_won", { chargeback: o.id }, null);
    await contractEvent(u, "chargeback_won", c.client);
    return "won";
  }
  // lost: the bank gave the client the money. What Cuvori held (or pulled back) is gone; nothing else moves.
  const gone = HOLDING.includes(c.status) ? heldCents(c) : (await db.select("order_payments", `order_id=eq.${c.id}&kind=eq.reversal&select=amount_cents`) || []).reduce((a, r) => a + r.amount_cents, 0);
  const u = (await db.update("contracts", `id=eq.${c.id}&chargeback_status=eq.open`, { chargeback_status: "lost", status: "refunded", resolution: "chargeback", closed_at: now, resolved_at: now, auto_release_at: null, refunded_cents: nz(c.refunded_cents) + gone, money_error: gone === 0 && nz(c.released_cents) > 0 ? "chargeback lost; the transfer could not be pulled back — settle by hand" : null }))[0];
  if (!u) return "already";
  if (gone > 0) await ledger(u, { kind: "chargeback", amount_cents: gone, provider_ref: o.id, note: "chargeback_lost" });
  await orderEvent(u, "chargeback_lost", { chargeback: o.id, amount_cents: gone }, null);
  await contractEvent(u, "chargeback_lost", c.client, { amount_cents: gone });
  return "lost";
}
