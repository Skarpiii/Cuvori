// POST { contract_id, lang } (client) → { url, amount, fee, total }. Funds an accepted Order, or tops up an
// Order whose price grew through an accepted amendment. The client sees the same breakdown on the
// page before clicking (order_quote), and the Stripe page shows the same two lines.
import { escrowEnabled, stripe, db, userFromRequest, json, bad, SITE_URL, quoteFor, readJson, safe, orderPayoutAccount, accountReady, isBanned, limitTries, sameMode, centsOf, MIN_CENTS, MAX_CENTS, MIN_TOPUP_CENTS, cut, heldCents, chargebackOpen, isSession, moneyUnchanged } from "../lib/cuvori.mjs";

// What Cuvori writes on Stripe's page, in the language the client uses on Cuvori. The page sends its language; anything
// else (missing, unknown, not text) means English. Only these fixed texts change — never an amount. `locale` shows
// Stripe's own page in the same language (Stripe has no Ukrainian page, so there it follows the browser).
const STRIPE_TEXT = {
  en: { locale: "en", order: "Order: ", increase: "Agreed price increase — ", untitled: "Cuvori order", fee: "Card fee",
        feeDesc: "Charged at a rate that covers even the most expensive cards. Anything above what your card really costs goes back to your card automatically after payment. Cuvori keeps none of it." },
  de: { locale: "de", order: "Auftrag: ", increase: "Vereinbarte Preiserhöhung — ", untitled: "Cuvori-Auftrag", fee: "Kartengebühr",
        feeDesc: "Berechnet zu einem Satz, der auch die teuersten Karten abdeckt. Alles, was über die tatsächlichen Kosten deiner Karte hinausgeht, geht nach der Zahlung automatisch auf deine Karte zurück. Cuvori behält nichts davon." },
  lt: { locale: "lt", order: "Užsakymas: ", increase: "Sutartas kainos padidinimas — ", untitled: "Cuvori užsakymas", fee: "Kortelės mokestis",
        feeDesc: "Taikomas tarifas, kuris padengia net brangiausias korteles. Viskas, kas viršija tikrąją jūsų kortelės kainą, po mokėjimo automatiškai grąžinama į jūsų kortelę. Cuvori iš to nieko nepasilieka." },
  pl: { locale: "pl", order: "Zlecenie: ", increase: "Uzgodniona podwyżka ceny — ", untitled: "Zlecenie Cuvori", fee: "Opłata za kartę",
        feeDesc: "Naliczana według stawki pokrywającej nawet najdroższe karty. Wszystko ponad rzeczywisty koszt Twojej karty wraca automatycznie na Twoją kartę po płatności. Cuvori nic z tego nie zatrzymuje." },
  ru: { locale: "ru", order: "Заказ: ", increase: "Согласованное повышение цены — ", untitled: "Заказ Cuvori", fee: "Комиссия за карту",
        feeDesc: "Взимается по ставке, покрывающей даже самые дорогие карты. Всё сверх реальной стоимости вашей карты автоматически возвращается на вашу карту после оплаты. Cuvori ничего из этого не оставляет себе." },
  uk: { locale: null, order: "Замовлення: ", increase: "Погоджене підвищення ціни — ", untitled: "Замовлення Cuvori", fee: "Комісія за картку",
        feeDesc: "Стягується за ставкою, що покриває навіть найдорожчі картки. Усе понад реальну вартість вашої картки автоматично повертається на вашу картку після оплати. Cuvori нічого з цього не залишає собі." },
  es: { locale: "es", order: "Pedido: ", increase: "Aumento de precio acordado — ", untitled: "Pedido de Cuvori", fee: "Comisión de tarjeta",
        feeDesc: "Se cobra con una tarifa que cubre incluso las tarjetas más caras. Todo lo que supere lo que realmente cuesta tu tarjeta vuelve a tu tarjeta automáticamente tras el pago. Cuvori no se queda con nada." },
};

export default safe(async (req) => {
  if (req.method !== "POST") return bad("Method not allowed", 405);
  if (!escrowEnabled()) return bad("Protected payments are not configured yet", 503);
  const me = await userFromRequest(req);
  if (!me) return bad("Sign in first", 401);
  if (me.banned) return bad("Account suspended", 403);
  await limitTries(me, "pay_checkout");          // at most about 10 tries a minute and 50 a day: nobody can use up Stripe's limits for everyone
  const { contract_id: id, lang } = await readJson(req);
  const lng = typeof lang === "string" && Object.prototype.hasOwnProperty.call(STRIPE_TEXT, lang) ? lang : "en", L = STRIPE_TEXT[lng];
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
  else return json(409, { error: "This order is not waiting for payment", code: "not_payable" });   // code: the page shows it in the client's language and reloads the Order
  // the amount being charged now (not just the price) must be a whole number of cents inside the limits:
  // a whole Order from €1, a top-up from €0.50, never above €950,000. The €0.50 is Cuvori's own floor for the
  // top-up amount, chosen so the charge (amount + fee) always clears Stripe's per-currency minimum for the whole
  // charge (€0.50 for euro). quoteFor checks the amount again and caps the fee-inclusive total; this is the early gate.
  // Only a price increase may be as small as €0.50: anything else (a first payment, or any kind of payment added
  // later) needs the €1, so the stricter minimum is what applies unless someone decides otherwise.
  const minFor = kind === "topup" ? MIN_TOPUP_CENTS : MIN_CENTS;
  if (!Number.isSafeInteger(amount) || amount < minFor || amount > MAX_CENTS) return bad("Payment amount out of range", 409);
  if (chargebackOpen(c)) return bad("A card chargeback is open on this order; nothing can be paid until the bank decides", 409);
  sameMode(c);                                   // an Order paid in test mode takes no real money, and the other way round
  // code: the page says it in the client's language (the Fund button shows even then: the page only knows whether the
  // freelancer finished their Stripe setup, not whether they were banned after the Order was accepted)
  if (await isBanned(c.editor)) return json(409, { error: "This freelancer cannot receive payments", code: "freelancer_unavailable" });
  const acct = await orderPayoutAccount(c);      // Stripe confirming the account is gone = not ready; a problem on Cuvori's side stops here, noted on the Order
  // code: the page says it in the client's language. The page shows the Fund button by the database's "ready" mark, which
  // the check above has just brought in line with Stripe, so after a reload the button is gone and the page says why.
  if (!accountReady(acct)) return json(409, { error: "The freelancer's Stripe account can't receive payments right now. Ask them to check Payout details under Settings on Cuvori.", code: "freelancer_not_ready" });

  // The card fee is charged at a rate that covers even the most expensive cards (the fee table's "unknown country" row), the same for everyone,
  // and the same number the page showed. Nothing the client declares can lower it. Once the payment is made,
  // whatever was collected above the provider's real fee is refunded to the card automatically (settleFee).
  const quote = await quoteFor(amount, c.currency || "EUR", null, "any", "card");
  const fee = quote.processing_cents, total = quote.total_cents;
  const currency = (c.currency || "EUR").toLowerCase();
  // The first line on Stripe's page: the price — or, for a top-up, the price increase both sides agreed to. The title is
  // cut by whole characters as people see them (cut): never half an emoji, which would stop the payment, and never part of
  // a flag or a family emoji, which would show as a stray symbol.
  const title = cut(c.title, 180).trim() || L.untitled;   // a title of nothing but spaces, tabs or line breaks counts as no title
  const items = [{ quantity: 1, price_data: { currency, unit_amount: amount, product_data: { name: kind === "topup" ? `${L.increase}${title}` : `${L.order}${title}` } } }];
  if (fee > 0) items.push({ quantity: 1, price_data: { currency, unit_amount: fee, product_data: { name: L.fee, description: L.feeDesc } } });
  // One Checkout page per half hour and amount: a second click within it gets the same page back (Stripe
  // replays the answer for the same idempotency key). That needs the same request each time, so the expiry
  // is a fixed point 60–90 min ahead rather than "now + 30 min".
  // Hold first, charge after: the page only places a hold on the card (capture_method manual). The money is charged
  // a moment later by applyPaidSession, and only if the Order can still take it; otherwise the hold is released and
  // nothing is charged, so nobody pays a card fee on money that has to go back.
  const slot = Math.floor(Date.now() / 1800e3);
  const session = await stripe("POST", "/checkout/sessions", {
    mode: "payment",
    client_reference_id: c.id,
    customer_email: me.email,
    expires_at: (slot + 3) * 1800,
    payment_method_types: ["card"],
    locale: L.locale || undefined,
    success_url: `${SITE_URL}/#orders?paid=${c.id}`,
    cancel_url: `${SITE_URL}/#orders?cancelled=${c.id}`,
    line_items: items,
    payment_intent_data: { capture_method: "manual", transfer_group: `contract_${c.id}`, metadata: { contract_id: c.id, editor: c.editor, client: c.client, kind } },
    // the breakdown travels with the page (Stripe keeps up to 500 characters per value): when this page's payment is confirmed,
    // this breakdown — not the one from a page made later with a changed fee table — is the one saved on the Order
    metadata: { contract_id: c.id, amount_cents: String(amount), fee_cents: String(fee), kind, ...(kind === "fund" ? { quote: JSON.stringify(quote).slice(0, 500) } : {}) },
  }, { idempotency: `checkout_hold_${c.id}_${kind}_${amount}_${fee}_${lng}_${me.id}_${slot}` });

  const patch = kind === "fund" ? { stripe_checkout_id: session.id, fee_cents: fee, quote } : { stripe_checkout_id: session.id };
  // Saved only if the Order is still exactly as this request read it: same status, same price, same money paid in, and the
  // same page on record. Two Fund requests at the same moment (two tabs) then cannot both save a page: the second finds
  // the first one's page on the Order and hands that page back, so one Order never has two pages that could both be paid.
  const prev = c.stripe_checkout_id;
  const rows = await db.update("contracts", `id=eq.${c.id}&status=eq.${c.status}&${moneyUnchanged(c)}&${prev ? `stripe_checkout_id=eq.${encodeURIComponent(prev)}` : "stripe_checkout_id=is.null"}`, patch);
  if (!rows || !rows.length) {
    await stripe("POST", `/checkout/sessions/${session.id}/expire`).catch(() => {});
    const now = await db.contract(c.id);
    if (now && now.status === c.status && now.amount_cents === c.amount_cents && (now.funded_cents ?? null) === (c.funded_cents ?? null) && now.stripe_checkout_id && now.stripe_checkout_id !== prev && isSession(now.stripe_checkout_id)) {
      const other = await stripe("GET", `/checkout/sessions/${now.stripe_checkout_id}`).catch(() => null);
      const om = other && other.metadata || {};
      if (other && other.status === "open" && other.url && other.client_reference_id === c.id && om.kind === kind && Number(om.amount_cents) === amount && Number.isSafeInteger(Number(om.fee_cents)))
        return json(200, { url: other.url, amount, fee: Number(om.fee_cents), total: amount + Number(om.fee_cents), cuvori_fee: 0, kind, held: heldCents(c) });
    }
    // code: the page says it in the client's language and reloads the Order, so they see the new details
    return json(409, { error: "The order changed, reload", code: "order_changed" });
  }
  // only one live Checkout per Order: the previous page (another tab, an old link) can no longer be paid
  if (prev && prev !== session.id && isSession(prev)) await stripe("POST", `/checkout/sessions/${prev}/expire`).catch(() => {});
  return json(200, { url: session.url, amount, fee, total, cuvori_fee: 0, kind, held: heldCents(c) });
});
