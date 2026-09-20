// POST { contract_id } (client) → { status } — reconciliation. When the client comes back from Stripe the
// page asks here; the function looks the Checkout session up at Stripe itself and, if it is paid, funds the
// Order exactly as the webhook would. So a lost, late or misconfigured webhook can never leave a paid
// Order unfunded. Safe to call any number of times.
import { escrowEnabled, stripe, db, userFromRequest, json, bad, readJson, safe, applyPaidSession, isSession } from "../lib/cuvori.mjs";

export default safe(async (req) => {
  if (req.method !== "POST") return bad("Method not allowed", 405);
  if (!escrowEnabled()) return bad("Protected payments are not configured yet", 503);
  const me = await userFromRequest(req);
  if (!me) return bad("Sign in first", 401);
  const { contract_id: id } = await readJson(req);
  const c = await db.contract(id);
  if (!c || (c.client !== me.id && c.editor !== me.id)) return bad("Not your order", 403);
  if (c.payment_mode !== "escrow" || !c.stripe_checkout_id || !isSession(c.stripe_checkout_id)) return json(200, { status: c.status, funded_cents: c.funded_cents || 0, checked: false });
  let result = "unpaid";
  if (c.status === "accepted" || ["funded", "delivered"].includes(c.status)) {
    const s = await stripe("GET", `/checkout/sessions/${c.stripe_checkout_id}`);
    result = await applyPaidSession(s);
  }
  const now = await db.contract(id);
  return json(200, { status: now.status, funded_cents: now.funded_cents || 0, checked: true, result });
});
