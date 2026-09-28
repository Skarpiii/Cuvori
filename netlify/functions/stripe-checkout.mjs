// POST { contract_id } (client) → { url, amount, fee, total }. Funds an accepted Order, or tops up an
// Order whose price grew through an accepted amendment. The client sees the same breakdown on the
// page before clicking (order_quote), and the Stripe page shows the same two lines.
import { escrowEnabled, stripe, db, userFromRequest, json, bad, SITE_URL, quoteFor, readJson, safe, payoutAccount, accountReady, isBanned, centsOf, MIN_CENTS, MAX_CENTS, MIN_TOPUP_CENTS, cut, heldCents, chargebackOpen, isSession } from "../lib/cuvori.mjs";

export default safe(async (req) => {
  if (req.method !== "POST") return bad("Method not allowed", 405);
  if (!escrowEnabled()) return bad("Protected payments are not configured yet", 503);
  const me = await userFromRequest(req);
  if (!me) return bad("Sign in first", 401);
  if (me.banned) return bad("Account suspended", 403);
  const { contract_id: id } = await readJson(req);
  const c = await db.contract(id);
  if (!c || c.client !== me.id) return bad("Not your order", 403);
  if (c.payment_mode !== "escrow") return bad("This order is paid directly, not through Cuvori", 409);
  const price = centsOf(c);
  if (!price || price < MIN_CENTS || price > MAX_CENTS) return bad("Amount out of range", 409);
  // what still needs funding: the whole price on an accepted Order, or the part an amendment added
  let amount, kind;
  // what has been paid in. No guessing: an unpaid Order must show nothing paid, a paid one a real positive amount.
  // Anything else (missing, negative, a fraction) means the payment record needs checking by hand before more money moves.
  const fc = c.funded_cents;
  const RECONCILE = "This order's payment record needs checking before another payment can be taken. Please contact Cuvori support.";
  if (c.status === "accepted") {
    // a first payment only when nothing at all says this Order was paid: no counters (paid in, paid out, refunded),
    // no payment time, no payment or charge on the row, no ledger line
    const zeroOrEmpty = (v) => v == null || v === 0;
    if (!zeroOrEmpty(fc) || !zeroOrEmpty(c.released_cents) || !zeroOrEmpty(c.refunded_cents) || c.funded_at || c.stripe_payment_intent || c.stripe_charge_id) return bad(RECONCILE, 409);
    const paidRows = await db.select("order_payments", `order_id=eq.${c.id}&kind=eq.fund&select=id&limit=1`);
    if (paidRows && paidRows.length) return bad(RECONCILE, 409);
  }
  if (["funded", "delivered"].includes(c.status) && !(Number.isSafeInteger(fc) && fc > 0)) return bad(RECONCILE, 409);
  const paidIn = c.status === "accepted" ? 0 : fc;
  if (c.status === "accepted") { amount = price; kind = "fund"; }
  else if (["funded", "delivered"].includes(c.status) && price > paidIn) { amount = price - paidIn; kind = "topup"; }
  else return bad("This order is not waiting for payment", 409);
  // the amount being charged now (not just the price) must be a whole number of cents inside the limits:
  // a whole Order from €1, a top-up from €0.50, never above €950,000. The €0.50 is Cuvori's own floor for the
  // top-up amount, chosen so the charge (amount + fee) always clears Stripe's per-currency minimum for the whole
  // charge (€0.50 for euro). quoteFor checks the amount again and caps the fee-inclusive total; this is the early gate.
  const minFor = kind === "fund" ? MIN_CENTS : MIN_TOPUP_CENTS;
  if (!Number.isSafeInteger(amount) || amount < minFor || amount > MAX_CENTS) return bad("Payment amount out of range", 409);
  if (chargebackOpen(c)) return bad("A card chargeback is open on this order; nothing can be paid until the bank decides", 409);
  if (await isBanned(c.editor)) return bad("This freelancer cannot receive payments", 409);
  const acct = await payoutAccount(c.editor);
  if (!accountReady(acct)) return bad("The freelancer's Stripe account can't receive payments right now. Ask them to finish or update their Stripe setup under Account → Payout details.", 409);

  // The card fee is charged at a rate that covers even the most expensive cards (the fee table's "unknown country" row), the same for everyone,
  // and the same number the page showed. Nothing the client declares can lower it. Once the payment is made,
  // whatever was collected above the provider's real fee is refunded to the card automatically (settleFee).
  const quote = await quoteFor(amount, c.currency || "EUR", null, "any", "card");
  const fee = quote.processing_cents, total = quote.total_cents;
  const currency = (c.currency || "EUR").toLowerCase();
  // The first line on Stripe's page: the price — or, for a top-up, the price increase both sides agreed to. The title is
  // cut by whole characters as people see them (cut): never half an emoji, which would stop the payment, and never part of
  // a flag or a family emoji, which would show as a stray symbol.
  const title = cut(c.title, 180) || "Cuvori order";
  const items = [{ quantity: 1, price_data: { currency, unit_amount: amount, product_data: { name: kind === "topup" ? `Agreed price increase — ${title}` : `Order: ${title}` } } }];
  if (fee > 0) items.push({ quantity: 1, price_data: { currency, unit_amount: fee, product_data: { name: "Card fee", description: "Charged at a rate that covers even the most expensive cards. Anything above what your card really costs goes back to your card automatically after payment. Cuvori keeps none of it." } } });
  // One Checkout page per half hour and amount: a second click within it gets the same page back (Stripe
  // replays the answer for the same idempotency key). That needs the same request each time, so the expiry
  // is a fixed point 60–90 min ahead rather than "now + 30 min".
  const slot = Math.floor(Date.now() / 1800e3);
  const session = await stripe("POST", "/checkout/sessions", {
    mode: "payment",
    client_reference_id: c.id,
    customer_email: me.email,
    expires_at: (slot + 3) * 1800,
    payment_method_types: ["card"],
    success_url: `${SITE_URL}/#orders?paid=${c.id}`,
    cancel_url: `${SITE_URL}/#orders?cancelled=${c.id}`,
    line_items: items,
    payment_intent_data: { transfer_group: `contract_${c.id}`, metadata: { contract_id: c.id, editor: c.editor, client: c.client, kind } },
    metadata: { contract_id: c.id, amount_cents: String(amount), fee_cents: String(fee), kind },
  }, { idempotency: `checkout_${c.id}_${kind}_${amount}_${fee}_${me.id}_${slot}` });

  const patch = kind === "fund" ? { stripe_checkout_id: session.id, fee_cents: fee, quote } : { stripe_checkout_id: session.id };
  const rows = await db.update("contracts", `id=eq.${c.id}&status=eq.${c.status}&amount_cents=eq.${price}`, patch);
  if (!rows || !rows.length) { await stripe("POST", `/checkout/sessions/${session.id}/expire`).catch(() => {}); return bad("The order changed, reload", 409); }
  // only one live Checkout per Order: the previous page (another tab, an old link) can no longer be paid
  if (c.stripe_checkout_id && c.stripe_checkout_id !== session.id && isSession(c.stripe_checkout_id)) await stripe("POST", `/checkout/sessions/${c.stripe_checkout_id}/expire`).catch(() => {});
  return json(200, { url: session.url, amount, fee, total, cuvori_fee: 0, kind, held: heldCents(c) });
});
