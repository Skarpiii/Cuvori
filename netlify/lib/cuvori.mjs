// Shared helpers for Cuvori's Netlify functions (hardened copy).
// v18: the Order is the contract. The DB table is still `contracts`; every row is an Order.
import crypto from "node:crypto";

export const SUPABASE_URL = process.env.SUPABASE_URL || "https://tnxujwlfatcvxzevllfr.supabase.co";
export const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
export const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || "";
export const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
export const SITE_URL = (process.env.SITE_URL || process.env.URL || "https://cuvori.netlify.app").replace(/\/$/, "");
// the page may live on another host (GitHub Pages) and call these functions across origins
export const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || `${SITE_URL},https://cuvori.io,https://www.cuvori.io`).split(",").map(s => s.trim().replace(/\/$/, "")).filter(Boolean);
export const AUTO_RELEASE_DAYS = 7; // hard-coded in order_action() too
export const MIN_CENTS = 100, MAX_CENTS = 100000000;

export function escrowEnabled() { return !!(STRIPE_KEY && SERVICE_KEY); }

let corsOrigin = null;
export function setCors(req) { const o = (req && req.headers.get("origin") || "").replace(/\/$/, ""); corsOrigin = ALLOWED_ORIGINS.includes(o) ? o : null; }
const corsHeaders = () => corsOrigin ? { "access-control-allow-origin": corsOrigin, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS", "vary": "origin" } : {};
export const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...corsHeaders() } });
export const bad = (msg, status = 400) => json(status, { error: msg });
export const isUuid = (s) => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
export const isAcct = (s) => typeof s === "string" && /^acct_[A-Za-z0-9]{8,64}$/.test(s);
export const centsOf = (c) => (Number.isInteger(c.amount_cents) && c.amount_cents > 0 ? c.amount_cents : null);
const nz = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
// what the provider is holding for this Order right now (Orders from before v18 carry no counters)
export const heldCents = (c) => { const f = nz(c.funded_cents) || (["funded", "delivered", "disputed", "releasing", "resolving"].includes(c.status) ? centsOf(c) || 0 : 0); return Math.max(f - nz(c.released_cents) - nz(c.refunded_cents), 0); };
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
  const r = await fetch(url, init);
  let data; try { data = await r.json(); } catch { data = {}; }
  if (!r.ok) { const e = new Error((data.error && data.error.message) || "Stripe error"); e.stripe = data.error; e.status = r.status; throw e; }
  return data;
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
  rpc: (fn, args) => sbFetch(`/rpc/${fn}`, { method: "POST", body: JSON.stringify(args || {}) }),
  contract: (id) => { if (!isUuid(id)) throw fail("Bad order id", 400); return db.one("contracts", `id=eq.${id}&select=*`); },
  milestone: (id) => { if (!isUuid(id)) throw fail("Bad milestone id", 400); return db.one("order_milestones", `id=eq.${id}&select=*`); },
  // compare-and-set: only moves the row if it is still in one of `from`; returns the new row or null
  claim: async (id, from, patch) => { if (!isUuid(id)) throw fail("Bad order id", 400); const rows = await db.update("contracts", `id=eq.${id}&status=in.(${from.map(q).join(",")})`, patch); return rows && rows[0] || null; },
  claimMilestone: async (id, from, patch) => { if (!isUuid(id)) throw fail("Bad milestone id", 400); const rows = await db.update("order_milestones", `id=eq.${id}&status=in.(${from.map(q).join(",")})`, patch); return rows && rows[0] || null; },
};

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

// Editor's connected account, verified against Stripe (not just the DB row)
export async function payoutAccount(editorId) {
  const p = await db.one("payout_details", `id=eq.${editorId}&select=stripe_account_id`);
  if (!p || !isAcct(p.stripe_account_id)) return null;
  const acct = await stripe("GET", `/accounts/${p.stripe_account_id}`);
  if (!acct || !acct.metadata || acct.metadata.cuvori_user !== editorId) return null;
  return acct;
}

// Money movements. One idempotency key per Order (or per milestone) per direction, plus a Stripe-side
// lookup so a retry after the 24h key window still cannot pay twice.
export async function releaseToEditor(c, editorCents, milestoneId = null) {
  if (!Number.isInteger(editorCents) || editorCents <= 0 || editorCents > heldCents(c)) throw new Error("bad release amount");
  const existing = await stripe("GET", "/transfers", { transfer_group: `contract_${c.id}`, limit: 50 });
  const prior = (existing.data || []).find(t => t.metadata && t.metadata.contract_id === c.id && !t.reversed && (t.metadata.milestone_id || null) === (milestoneId || null));
  if (prior) { if (prior.amount !== editorCents) throw new Error(`transfer ${prior.id} exists with a different amount`); return prior.id; }
  const acct = await payoutAccount(c.editor);
  if (!acct || !acct.payouts_enabled) throw fail("The freelancer's Stripe account is not ready");
  const transfer = await stripe("POST", "/transfers", { amount: editorCents, currency: (c.currency || "EUR").toLowerCase(), destination: acct.id,
    source_transaction: c.stripe_charge_id || undefined, transfer_group: `contract_${c.id}`, description: `Cuvori order ${c.id}${milestoneId ? " milestone " + milestoneId : ""}`,
    metadata: { contract_id: c.id, milestone_id: milestoneId || "" } },
    { idempotency: milestoneId ? `transfer_${c.id}_${milestoneId}` : `transfer_${c.id}` });
  return transfer.id;
}
export async function refundToClient(c, cents) {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error("bad refund amount");
  if (!c.stripe_payment_intent) throw new Error("no payment intent");
  const existing = await stripe("GET", "/refunds", { payment_intent: c.stripe_payment_intent, limit: 10 });
  const prior = (existing.data || []).find(r => r.metadata && r.metadata.contract_id === c.id && r.status !== "failed" && r.status !== "canceled");
  if (prior) { if (prior.amount !== cents) throw new Error(`refund ${prior.id} exists with a different amount`); return prior.id; }
  const refund = await stripe("POST", "/refunds", { payment_intent: c.stripe_payment_intent, amount: cents, metadata: { contract_id: c.id } }, { idempotency: `refund_${c.id}` });
  return refund.id;
}

// Finish an Order that is in 'releasing' / 'resolving' using the amounts recorded when it was claimed.
// Whatever was already released for milestones stays where it is; this settles the remainder.
export async function settle(c, actor, ev) {
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
  if (u) {
    if (editorCents > 0) await ledger(u, { kind: "release", amount_cents: editorCents, provider_ref: transferId, note: ev });
    if (refundCents > 0) await ledger(u, { kind: "refund", amount_cents: refundCents, provider_ref: refundId, note: ev });
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
  if (m.amount_cents > heldCents(c)) throw fail("Not enough money is held for this milestone", 409);
  const claimed = await db.claimMilestone(m.id, ["submitted", "approved"], { status: "approved", approved_at: m.approved_at || new Date().toISOString(), auto_release_at: null });
  if (!claimed) throw fail("This milestone was just changed, reload", 409);
  let transferId;
  try { transferId = await releaseToEditor(c, m.amount_cents, m.id); }
  catch (e) { await db.update("contracts", `id=eq.${c.id}`, { money_error: String(e.message).slice(0, 300) }).catch(() => {}); throw e; }
  const now = new Date().toISOString();
  await db.update("order_milestones", `id=eq.${m.id}`, { status: "released", released_at: now, transfer_ref: transferId });
  const rows = await db.update("contracts", `id=eq.${c.id}&released_cents=eq.${nz(c.released_cents)}`, { released_cents: nz(c.released_cents) + m.amount_cents, money_error: null, changes_open: false });
  const u = rows && rows[0] || await db.contract(c.id);
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
