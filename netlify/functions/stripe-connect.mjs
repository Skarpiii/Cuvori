// POST /.netlify/functions/stripe-connect  (editor) → { url } to Stripe Express onboarding
// GET  /.netlify/functions/stripe-connect  (editor) → refreshes payouts_enabled and returns { connected, payouts_enabled }
import { escrowEnabled, stripe, db, userFromRequest, json, bad, SITE_URL } from "../lib/cuvori.mjs";

export default async (req) => {
  if (!escrowEnabled()) return bad("Escrow payments are not configured yet", 503);
  const me = await userFromRequest(req);
  if (!me) return bad("Sign in first", 401);
  if (me.role !== "editor") return bad("Only editors can receive payouts", 403);
  if (me.banned) return bad("Account suspended", 403);

  let payout = await db.one("payout_details", `id=eq.${me.id}&select=id,stripe_account_id,stripe_payouts_enabled`);

  if (req.method === "GET") {
    if (!payout || !payout.stripe_account_id) return json(200, { connected: false, payouts_enabled: false });
    const acct = await stripe("GET", `/accounts/${payout.stripe_account_id}`);
    const enabled = !!(acct.payouts_enabled && acct.charges_enabled);
    if (enabled !== payout.stripe_payouts_enabled) await db.update("payout_details", `id=eq.${me.id}`, { stripe_payouts_enabled: enabled });
    return json(200, { connected: true, payouts_enabled: enabled, requirements: acct.requirements && acct.requirements.currently_due || [] });
  }

  if (req.method !== "POST") return bad("Method not allowed", 405);
  let accountId = payout && payout.stripe_account_id;
  if (!accountId) {
    const acct = await stripe("POST", "/accounts", { type: "express", email: me.email, capabilities: { transfers: { requested: true } },
      business_type: "individual", metadata: { cuvori_user: me.id }, settings: { payouts: { schedule: { interval: "daily" } } } }, { idempotency: `acct_${me.id}` });
    accountId = acct.id;
    if (payout) await db.update("payout_details", `id=eq.${me.id}`, { stripe_account_id: accountId });
    else await db.insert("payout_details", { id: me.id, methods: [], note: "", stripe_account_id: accountId });
  }
  const link = await stripe("POST", "/account_links", { account: accountId, type: "account_onboarding",
    refresh_url: `${SITE_URL}/#settings?stripe=refresh`, return_url: `${SITE_URL}/#settings?stripe=return` });
  return json(200, { url: link.url });
};
