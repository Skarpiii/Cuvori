// POST /.netlify/functions/stripe-checkout { contract_id } (client) → { url } to Stripe Checkout.
// The client pays price + processing fee. Money lands in Cuvori's Stripe balance and is
// held there until release (approval, admin decision or auto-release).
import { escrowEnabled, stripe, db, userFromRequest, json, bad, SITE_URL, feeFor } from "../lib/cuvori.mjs";

export default async (req) => {
  if (req.method !== "POST") return bad("Method not allowed", 405);
  if (!escrowEnabled()) return bad("Escrow payments are not configured yet", 503);
  const me = await userFromRequest(req);
  if (!me) return bad("Sign in first", 401);
  if (me.banned) return bad("Account suspended", 403);
  let body = {}; try { body = await req.json(); } catch {}
  const id = String(body.contract_id || "");
  if (!/^[0-9a-f-]{36}$/.test(id)) return bad("Bad contract id");

  const c = await db.one("contracts", `id=eq.${id}&select=*`);
  if (!c || c.client !== me.id) return bad("Not your contract", 403);
  if (c.payment_mode !== "escrow") return bad("This contract is paid directly, not through Cuvori");
  if (c.status !== "accepted") return bad("The contract must be accepted before it can be paid");
  const payout = await db.one("payout_details", `id=eq.${c.editor}&select=stripe_account_id,stripe_payouts_enabled`);
  if (!payout || !payout.stripe_payouts_enabled) return bad("The editor has not finished setting up payouts yet. Ask them to connect Stripe in Settings → Payout details.", 409);

  const amount = c.amount_cents || Math.round(Number(c.price) * 100);
  const fee = feeFor(amount);
  const currency = (c.currency || "EUR").toLowerCase();
  const session = await stripe("POST", "/checkout/sessions", {
    mode: "payment",
    client_reference_id: c.id,
    customer_email: me.email,
    success_url: `${SITE_URL}/#contracts?paid=${c.id}`,
    cancel_url: `${SITE_URL}/#contracts?cancelled=${c.id}`,
    line_items: [
      { quantity: 1, price_data: { currency, unit_amount: amount, product_data: { name: c.title, description: "Held by Cuvori until you approve the delivery. The editor receives 100% of this amount." } } },
      { quantity: 1, price_data: { currency, unit_amount: fee, product_data: { name: "Payment processing", description: "Card processing costs (Stripe). Cuvori takes no commission." } } },
    ],
    payment_intent_data: { transfer_group: `contract_${c.id}`, description: `Cuvori contract: ${c.title}`, metadata: { contract_id: c.id, editor: c.editor, client: c.client } },
    metadata: { contract_id: c.id },
  }, { idempotency: `checkout_${c.id}_${amount}_${fee}` });

  await db.update("contracts", `id=eq.${c.id}`, { stripe_checkout_id: session.id, amount_cents: amount, fee_cents: fee });
  return json(200, { url: session.url, amount, fee });
};
