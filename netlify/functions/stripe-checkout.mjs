// POST { contract_id } (client) → { url, amount, fee, total }. Funds an accepted Order, or tops up an
// Order whose price grew through an accepted amendment. The client sees the same breakdown on the
// page before clicking (order_quote), and the Stripe page shows the same two lines.
import { escrowEnabled, stripe, db, userFromRequest, json, bad, SITE_URL, quoteFor, readJson, safe, payoutAccount, accountReady, isBanned, centsOf, MIN_CENTS, MAX_CENTS, heldCents, chargebackOpen, isSession } from "../lib/cuvori.mjs";

export default safe(async (req) => {
  if (req.method !== "POST") return bad("Method not allowed", 405);
  if (!escrowEnabled()) return bad("Protected payments are not configured yet", 503);
  const me = await userFromRequest(req);
  if (!me) return bad("Sign in first", 401);
  if (me.banned) return bad("Account suspended", 403);
  const { contract_id: id, country, customer } = await readJson(req);
  const c = await db.contract(id);
  if (!c || c.client !== me.id) return bad("Not your order", 403);
  if (c.payment_mode !== "escrow") return bad("This order is paid directly, not through Cuvori");
  const price = centsOf(c);
  if (!price || price < MIN_CENTS || price > MAX_CENTS) return bad("Amount out of range", 409);
  // what still needs funding: the whole price on an accepted Order, or the part an amendment added
  let amount, kind;
  if (c.status === "accepted") { amount = price; kind = "fund"; }
  else if (["funded", "delivered"].includes(c.status) && price > (c.funded_cents || 0)) { amount = price - (c.funded_cents || 0); kind = "topup"; }
  else return bad("This order is not waiting for payment", 409);
  if (chargebackOpen(c)) return bad("A card chargeback is open on this order; nothing can be paid until the bank decides", 409);
  if (await isBanned(c.editor)) return bad("This freelancer cannot receive payments", 409);
  const acct = await payoutAccount(c.editor);
  if (!accountReady(acct)) return bad("The freelancer has not finished setting up payouts yet. Ask them to connect Stripe in Settings → Payout details.", 409);

  const cc = typeof country === "string" && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : null;
  const kind_c = customer === "business" ? "business" : customer === "consumer" ? "consumer" : "any";
  const quote = await quoteFor(amount, c.currency || "EUR", cc, kind_c, "card");
  const fee = quote.processing_cents, total = quote.total_cents;
  const currency = (c.currency || "EUR").toLowerCase();
  const items = [{ quantity: 1, price_data: { currency, unit_amount: amount, product_data: { name: `Order: ${String(c.title || "").slice(0, 180) || "Cuvori order"}` } } }];
  if (fee > 0) items.push({ quantity: 1, price_data: { currency, unit_amount: fee, product_data: { name: "Payment processing (charged by the payment provider, not Cuvori)" } } });
  const session = await stripe("POST", "/checkout/sessions", {
    mode: "payment",
    client_reference_id: c.id,
    customer_email: me.email,
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    payment_method_types: ["card"],
    success_url: `${SITE_URL}/#orders?paid=${c.id}`,
    cancel_url: `${SITE_URL}/#orders?cancelled=${c.id}`,
    line_items: items,
    payment_intent_data: { transfer_group: `contract_${c.id}`, metadata: { contract_id: c.id, editor: c.editor, client: c.client, kind } },
    metadata: { contract_id: c.id, amount_cents: String(amount), fee_cents: String(fee), kind },
  }, { idempotency: `checkout_${c.id}_${kind}_${amount}_${fee}_${me.id}_${Math.floor(Date.now() / 1800e3)}` });

  const patch = kind === "fund" ? { stripe_checkout_id: session.id, fee_cents: fee, quote } : { stripe_checkout_id: session.id };
  const rows = await db.update("contracts", `id=eq.${c.id}&status=eq.${c.status}&amount_cents=eq.${price}`, patch);
  if (!rows || !rows.length) { await stripe("POST", `/checkout/sessions/${session.id}/expire`).catch(() => {}); return bad("The order changed, reload", 409); }
  // only one live Checkout per Order: the previous page (another tab, an old link) can no longer be paid
  if (c.stripe_checkout_id && c.stripe_checkout_id !== session.id && isSession(c.stripe_checkout_id)) await stripe("POST", `/checkout/sessions/${c.stripe_checkout_id}/expire`).catch(() => {});
  return json(200, { url: session.url, amount, fee, total, cuvori_fee: 0, kind, held: heldCents(c) });
});
