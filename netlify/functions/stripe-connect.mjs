// POST (editor) → onboarding link; GET → status. Hardened copy.
import { escrowEnabled, stripe, db, userFromRequest, json, bad, SITE_URL, safe, isAcct } from "../lib/cuvori.mjs";

export default safe(async (req) => {
  if (!["GET", "POST"].includes(req.method)) return bad("Method not allowed", 405);
  if (!escrowEnabled()) return bad("Escrow payments are not configured yet", 503);
  const me = await userFromRequest(req);
  if (!me) return bad("Sign in first", 401);
  if (me.banned) return bad("Account suspended", 403);
  if (me.role !== "editor") return bad("Only professionals can receive payouts", 403);

  const payout = await db.one("payout_details", `id=eq.${me.id}&select=id,stripe_account_id,stripe_payouts_enabled`);
  let acct = null;
  if (payout && payout.stripe_account_id) {
    if (!isAcct(payout.stripe_account_id)) return bad("Stripe connection is broken, contact support", 409);
    acct = await stripe("GET", `/accounts/${payout.stripe_account_id}`);
    if (!acct.metadata || acct.metadata.cuvori_user !== me.id) { console.error("account owner mismatch", me.id); return bad("Stripe connection is broken, contact support", 409); }
    const enabled = !!(acct.payouts_enabled && acct.charges_enabled);
    if (enabled !== payout.stripe_payouts_enabled) await db.update("payout_details", `id=eq.${me.id}`, { stripe_payouts_enabled: enabled });
  }
  if (req.method === "GET") {
    if (!acct) return json(200, { connected: false, payouts_enabled: false });
    return json(200, { connected: true, payouts_enabled: !!(acct.payouts_enabled && acct.charges_enabled), requirements: acct.requirements && acct.requirements.currently_due || [] });
  }
  if (!acct) {
    acct = await stripe("POST", "/accounts", { type: "express", email: me.email, capabilities: { transfers: { requested: true } },
      business_type: "individual", metadata: { cuvori_user: me.id }, settings: { payouts: { schedule: { interval: "daily" } } } }, { idempotency: `acct_${me.id}` });
    if (payout) await db.update("payout_details", `id=eq.${me.id}`, { stripe_account_id: acct.id });
    else await db.insert("payout_details", { id: me.id, methods: [], note: "", stripe_account_id: acct.id });
  }
  const link = await stripe("POST", "/account_links", { account: acct.id, type: "account_onboarding",
    refresh_url: `${SITE_URL}/#settings?stripe=refresh`, return_url: `${SITE_URL}/#settings?stripe=return` });
  return json(200, { url: link.url });
});
