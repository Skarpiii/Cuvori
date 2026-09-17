// Shared helpers for Cuvori's Netlify functions. No npm dependencies:
// Stripe and Supabase are called through their plain HTTPS APIs.
import crypto from "node:crypto";

export const SUPABASE_URL = process.env.SUPABASE_URL || "https://tnxujwlfatcvxzevllfr.supabase.co";
export const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
export const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || "";
export const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
export const SITE_URL = (process.env.SITE_URL || process.env.URL || "https://cuvori.netlify.app").replace(/\/$/, "");
export const FEE_PERCENT = Number(process.env.FEE_PERCENT || 3);     // processing fee charged to the client on top
export const FEE_FIXED_CENTS = Number(process.env.FEE_FIXED_CENTS || 25);
export const AUTO_RELEASE_DAYS = Number(process.env.AUTO_RELEASE_DAYS || 7);

export function escrowEnabled(){ return !!(STRIPE_KEY && SERVICE_KEY); }
export function feeFor(amountCents){ return Math.round(amountCents * FEE_PERCENT / 100) + FEE_FIXED_CENTS; }

export const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
export const bad = (msg, status = 400) => json(status, { error: msg });

// ---- Stripe (form-encoded REST) ----
function encode(obj, prefix) {
  const out = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => { if (typeof item === "object") out.push(encode(item, `${key}[${i}]`)); else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`); });
    else if (typeof v === "object") out.push(encode(v, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.filter(Boolean).join("&");
}
export async function stripe(method, path, body, opts = {}) {
  const headers = { Authorization: `Bearer ${STRIPE_KEY}`, "Stripe-Version": "2024-06-20" };
  if (opts.idempotency) headers["Idempotency-Key"] = opts.idempotency;
  if (opts.account) headers["Stripe-Account"] = opts.account;
  let url = `https://api.stripe.com/v1${path}`;
  const init = { method, headers };
  if (method === "GET") { if (body) url += "?" + encode(body); }
  else { headers["content-type"] = "application/x-www-form-urlencoded"; init.body = encode(body || {}); }
  const r = await fetch(url, init);
  const data = await r.json();
  if (!r.ok) { const e = new Error((data.error && data.error.message) || "Stripe error"); e.stripe = data.error; e.status = r.status; throw e; }
  return data;
}

// Verify a Stripe webhook signature (Stripe-Signature: t=...,v1=...)
export function verifyWebhook(rawBody, sigHeader) {
  if (!WEBHOOK_SECRET) throw new Error("STRIPE_WEBHOOK_SECRET missing");
  const parts = Object.fromEntries((sigHeader || "").split(",").map(p => p.split("=")));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) throw new Error("bad signature header");
  const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(v1);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("signature mismatch");
  if (Math.abs(Date.now() / 1000 - Number(t)) > 600) throw new Error("timestamp too old");
  return JSON.parse(rawBody);
}

// ---- Supabase REST with the service role (bypasses RLS; only used server-side) ----
async function sbFetch(path, init = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, { ...init, headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json", Prefer: init.prefer || "return=representation", ...(init.headers || {}) } });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) { const e = new Error((data && data.message) || `Supabase ${r.status}`); e.status = r.status; throw e; }
  return data;
}
export const db = {
  select: (table, query) => sbFetch(`/${table}?${query}`),
  one: async (table, query) => { const rows = await sbFetch(`/${table}?${query}&limit=1`); return rows && rows[0] || null; },
  update: (table, query, patch) => sbFetch(`/${table}?${query}`, { method: "PATCH", body: JSON.stringify(patch) }),
  insert: (table, row) => sbFetch(`/${table}`, { method: "POST", body: JSON.stringify(row) }),
};

// Who is calling? Validates the user's Supabase access token.
export async function userFromRequest(req) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const u = await r.json();
  if (!u || !u.id) return null;
  const profile = await db.one("profiles", `id=eq.${u.id}&select=id,email,first_name,role,is_admin,banned`);
  return profile ? { ...profile } : null;
}

// Post a contract event card into the conversation (what contract_event() does in SQL)
export async function contractEvent(c, ev, sender) {
  await db.insert("messages", { conversation_id: c.conversation_id, sender: sender || c.editor, kind: "contract", body: c.title,
    payload: { contract_id: c.id, event: ev, title: c.title, price: c.price, currency: c.currency, pricing: c.pricing, status: c.status } });
}

// Release the held money to the editor (full amount or a split)
export async function releaseToEditor(c, editorCents, actor, ev) {
  const payout = await db.one("payout_details", `id=eq.${c.editor}&select=stripe_account_id,stripe_payouts_enabled`);
  if (!payout || !payout.stripe_account_id) throw new Error("editor has no Stripe account");
  const transfer = await stripe("POST", "/transfers", { amount: editorCents, currency: (c.currency || "EUR").toLowerCase(), destination: payout.stripe_account_id,
    transfer_group: `contract_${c.id}`, description: `Cuvori contract: ${c.title}`, metadata: { contract_id: c.id } }, { idempotency: `release_${c.id}_${editorCents}` });
  return transfer.id;
}
export async function refundToClient(c, cents) {
  const refund = await stripe("POST", "/refunds", { payment_intent: c.stripe_payment_intent, amount: cents, metadata: { contract_id: c.id } }, { idempotency: `refund_${c.id}_${cents}` });
  return refund.id;
}
