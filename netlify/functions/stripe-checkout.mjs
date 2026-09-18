// POST { contract_id } (client) → { url }. Hardened copy.
import { escrowEnabled, stripe, db, userFromRequest, json, bad, SITE_URL, feeFor, readJson, safe, payoutAccount, isBanned, centsOf, MIN_CENTS, MAX_CENTS } from "../lib/cuvori.mjs";

export default safe(async (req) => {
  if (req.method !== "POST") return bad("Method not allowed", 405);
  if (!escrowEnabled()) return bad("Escrow payments are not configured yet", 503);
  const me = await userFromRequest(req);
  if (!me) return bad("Sign in first", 401);
  if (me.banned) return bad("Account suspended", 403);
  const { contract_id: id } = await readJson(req);
  const c = await db.contract(id);
  if (!c || c.client !== me.id) return bad("Not your contract", 403);
  if (c.payment_mode !== "escrow") return bad("This contract is paid directly, not through Cuvori");
  if (c.status !== "accepted") return bad("The contract must be accepted before it can be paid");
  if (c.pricing && c.pricing !== "project") return bad("Escrow is only available for fixed-price contracts", 409);
  const amount = centsOf(c);
  if (!amount || amount < MIN_CENTS || amount > MAX_CENTS) return bad("Amount out of range", 409);
  if (await isBanned(c.editor)) return bad("This editor cannot receive payments", 409);
  const acct = await payoutAccount(c.editor);
  if (!acct || !acct.payouts_enabled) return bad("The editor has not finished setting up payouts yet. Ask them to connect Stripe in Settings → Payout details.", 409);

  const fee = feeFor(amount);
  const currency = (c.currency || "EUR").toLowerCase();
  const session = await stripe("POST", "/checkout/sessions", {
    mode: "payment",
    client_reference_id: c.id,
    customer_email: me.email,
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    payment_method_types: ["card"],
    success_url: `${SITE_URL}/#contracts?paid=${c.id}`,
    cancel_url: `${SITE_URL}/#contracts?cancelled=${c.id}`,
    line_items: [
      { quantity: 1, price_data: { currency, unit_amount: amount, product_data: { name: String(c.title || "Contract").slice(0, 200) || "Contract" } } },
      { quantity: 1, price_data: { currency, unit_amount: fee, product_data: { name: "Cuvori protected payment fee" } } },
    ],
    payment_intent_data: { transfer_group: `contract_${c.id}`, metadata: { contract_id: c.id, editor: c.editor, client: c.client } },
    metadata: { contract_id: c.id, amount_cents: String(amount), fee_cents: String(fee) },
  }, { idempotency: `checkout_${c.id}_${amount}_${fee}_${me.id}_${Math.floor(Date.now() / 1800e3)}` });

  const rows = await db.update("contracts", `id=eq.${c.id}&status=eq.accepted`, { stripe_checkout_id: session.id, fee_cents: fee });
  if (!rows || !rows.length) { await stripe("POST", `/checkout/sessions/${session.id}/expire`).catch(() => {}); return bad("The contract changed, reload", 409); }
  return json(200, { url: session.url, amount, fee });
});
