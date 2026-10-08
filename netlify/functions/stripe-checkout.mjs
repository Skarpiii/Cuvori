// POST { contract_id, lang } (client) → { url, amount, fee, total }. Funds an accepted Order, or tops up an
// Order whose price grew through an accepted amendment. The client sees the same breakdown on the
// page before clicking (order_quote), and the Stripe page shows the same two lines.
import { escrowEnabled, stripe, db, userFromRequest, json, bad, SITE_URL, quoteFor, readJson, safe, orderPayoutAccount, accountReady, isBanned, limitTries, sameMode, centsOf, MIN_CENTS, MAX_CENTS, MIN_TOPUP_CENTS, cut, heldCents, chargebackOpen, isSession, moneyUnchanged, moneyPost, dropKeyIf, idemBusy, idemMismatch, stripeFingerprint, REPLAYED, IDEM_KEY, applyPaidSession, blankNote } from "../lib/cuvori.mjs";

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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const STRIPE_NAME_MAX = 250;                     // Stripe's limit for a product name, in characters
const GRAPHEMES = typeof Intl === "object" && typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu, TAGS = /[\u{E0000}-\u{E007F}]/gu;
// The Order's title as plain text for Stripe's page, at most `room` long as JavaScript counts (an emoji outside the basic
// range as two, so it fits Stripe's limit however Stripe counts). Titles come from the site's title box, but someone can
// paste odd characters into it, and a title made directly on the server can hold anything:
// - line breaks, tabs, control characters and every other kind of blank (the braille blank too) become one plain space;
// - codes that are never text (noncharacters) and the hidden marks that flip the direction of text are left out;
// - invisible characters (zero-width spaces, invisible direction marks, fillers, soft hyphens, …) are left out wherever
//   they stand on their own. Inside an emoji some of them hold it together (the joiner in a family, the mark that makes a
//   symbol colourful), so there they stay; the hidden letters that make England's or Scotland's flag stay only on the
//   black flag they belong to, anywhere else they are hidden text and are left out;
// - one character built from more than 16 pieces is a trick (a letter with hundreds of accents stacked on it, which would
//   push the rest of the title off the page); the longest real emoji has 10, so such a character keeps only its letter;
// - the whole title is shown when it fits; only when it doesn't is it cut by whole characters (never half an emoji, a
//   flag or a letter with its accent) and ends with "…", so a cut title shows that it was cut.
// Nothing visible left means no title (the caller then uses "Cuvori order" in the client's language).
function stripeTitle(raw, room) {
  const s = String(raw ?? "").replace(/\p{Noncharacter_Code_Point}/gu, "").replace(/[\u202A-\u202E\u2066-\u2069]/g, "").replace(/[\p{Cc}\p{Zl}\p{Zp}\u2800]/gu, " ");
  let out = "";
  for (const g of GRAPHEMES ? Array.from(GRAPHEMES.segment(s), x => x.segment) : Array.from(s)) {
    const piece = g.codePointAt(0) === 0x1F3F4 ? g : g.replace(TAGS, "");
    const seen = piece.replace(INVISIBLE, "");
    if (!seen) continue;                                             // nothing visible: left out
    if (/^\s+$/u.test(seen)) { out += " "; continue; }
    out += Array.from(piece).length > 16 ? Array.from(seen)[0] : piece;
  }
  out = out.replace(/\s+/gu, " ").trim();
  return out.length <= room ? out : cut(out, Infinity, room - 1).trimEnd() + "…";
}
// Makes the page under the request's stored key (moneyPost).
// - Two tabs clicking at the same moment: Stripe is still making the first tab's page and tells the second to wait. The
//   second waits a moment and asks again with the same key, and gets that very page (for up to about 4 seconds).
// - A failure Stripe repeats from its memory of the key (the database could not forget the key when that failure came,
//   or Stripe said "retry" with it: a repeat never changes, so the same key would only fail again for 24 hours),
//   or Stripe saying the key belongs to a different request: that key is dropped (only that one: never a newer key
//   another tab has just stored) and one fresh try is made, so the client never gets an old answer instead of a new try.
async function makePage(scope, params) {
  let waits = 0, fresh = false;
  for (;;) {
    try { return await moneyPost(scope, "/checkout/sessions", params); }
    catch (e) {
      if (idemBusy(e) && waits < 10) { waits++; await sleep(400); continue; }
      if (!fresh && (idemMismatch(e) || (e && e.replayed && e.status >= 400))) { fresh = true; await dropKeyIf(scope, e.idemKey); continue; }
      throw e;
    }
  }
}

// A refusal with a code: the page says it in the client's language (fnPlain in index.html) and that nothing was charged;
// the sentence here stays for the owner.
const refuse = (status, error, code) => json(status, { error, code });
// An Order whose payment record looks wrong is never paid until a person has looked at it. The owner sees it under "Needs a
// hand" in the admin panel: the note is written over an empty note or over this check's own older note, never over
// another, and only while the note still reads what this request read. It goes once the record checks out again.
// Both people on the Order can read its notes, so it says in plain words what looks wrong, nothing else.
const RECORD_NOTE = "Payment record needs checking: ";
const ownRecordNote = (c) => String(c.money_error || "").startsWith(RECORD_NOTE);
const noteFilter = (c) => (c.money_error == null ? "money_error=is.null" : `money_error=eq.${encodeURIComponent(c.money_error)}`);
async function needsCheck(c, why) {
  const text = (RECORD_NOTE + why).slice(0, 300);
  let noted = "already noted on the Order";
  if (c.money_error !== text) {
    if (blankNote(c) || ownRecordNote(c)) {
      const rows = await db.update("contracts", `id=eq.${c.id}&${noteFilter(c)}`, { money_error: text }).catch(() => null);
      noted = !rows ? "the note could not be saved: the database did not answer"
        : rows.length ? "noted on the Order"
        : "this click did not save the note: it changed at the same moment (another click may have just written it)";
    } else noted = "not noted: the Order already has another note";
  }
  // always in the Netlify log too (only the owner sees it), so the problem is on record even when no note could be written
  console.error("Payment record needs checking", "order", c.id, why, `(${noted})`);
  return refuse(409, "This order's payment record needs checking before another payment can be taken. Cuvori support has been told.", "needs_check");
}
const euro = (cents) => `€${(cents / 100).toFixed(2)}`;

export default safe(async (req) => {
  if (req.method !== "POST") return bad("Method not allowed", 405);
  if (!escrowEnabled()) return refuse(503, "Protected payments are not configured yet", "payments_paused");
  const me = await userFromRequest(req);
  if (!me) return refuse(401, "Sign in first", "signed_out");
  if (me.banned) return refuse(403, "Account suspended", "account_suspended");
  await limitTries(me, "pay_checkout");          // at most about 10 tries a minute and 50 a day: nobody can use up Stripe's limits for everyone
  const { contract_id: id, lang } = await readJson(req);
  const lng = typeof lang === "string" && Object.prototype.hasOwnProperty.call(STRIPE_TEXT, lang) ? lang : "en", L = STRIPE_TEXT[lng];
  const c = await db.contract(id);
  if (!c || c.client !== me.id) return refuse(403, "Not your order", "not_your_order");
  if (c.payment_mode !== "escrow") return refuse(409, "This order is paid directly, not through Cuvori", "paid_directly");
  const price = centsOf(c);
  if (!price || price < MIN_CENTS || price > MAX_CENTS) return refuse(409, "Amount out of range", "amount_out_of_range");
  // what still needs funding: the whole price on an accepted Order, or the part an amendment added
  let amount, kind;
  // what has been paid in. No guessing: an unpaid Order must show nothing paid, a paid one a real positive amount.
  // Anything else (missing, negative, a fraction) means the payment record needs checking by hand before more money moves.
  const fc = c.funded_cents;
  if (c.status === "accepted") {
    // a first payment only when nothing at all says money ever moved on this Order: no counters (paid in, paid out,
    // refunded, a refund or a split decided on its money), no payment time, no card payment or charge on the row, no
    // payout, refund or reversal at Stripe, no mark of the mode it was paid in, no ledger line. (A card chargeback is not
    // on this list: one can come for a late payment that was sent back without ever funding the Order; while it is open,
    // the check further down refuses, and once decided it says nothing about this Order's own money.)
    const zeroOrEmpty = (v) => v == null || v === 0;
    const shows = [
      [!zeroOrEmpty(fc), "money paid in"], [!zeroOrEmpty(c.released_cents), "money paid out"], [!zeroOrEmpty(c.refunded_cents), "money refunded"],
      [!zeroOrEmpty(c.refund_cents) || !zeroOrEmpty(c.split_editor_cents), "a decision on its money"], [!!c.funded_at, "a payment time"],
      [!!(c.stripe_payment_intent || c.stripe_charge_id), "a card payment"], [!!c.stripe_transfer_id, "a payout to the freelancer"],
      [!!c.stripe_refund_id, "a refund"], [!!c.stripe_reversal_id, "a reversal"], [!!c.paid_mode, "the mode it was paid in"],
    ].filter(([yes]) => yes).map(([, what]) => what);
    // the ledger: a payment into the Order, a payout to the freelancer or a reversal of one can only be there once money moved.
    // Refund and chargeback lines are not on this list: they can belong to a late payment that never went into the Order
    // (sent back from the Stripe dashboard, or disputed by the client's bank), and must never stop its first payment.
    if (!shows.length) {
      const rows = await db.select("order_payments", `order_id=eq.${c.id}&kind=in.(fund,release,reversal)&select=kind&limit=3`);
      const kinds = new Set((rows || []).map(r => r.kind));
      if (kinds.has("fund")) shows.push("a payment in its ledger");
      if (kinds.has("release")) shows.push("a payout in its ledger");
      if (kinds.has("reversal")) shows.push("a reversal in its ledger");
    }
    if (shows.length) return needsCheck(c, `this Order is waiting for its first payment, but its record shows ${shows.join(", ")}.`);
  }
  if (["funded", "delivered"].includes(c.status) && !(Number.isSafeInteger(fc) && fc > 0))
    return needsCheck(c, "this Order is paid, but the amount paid in is missing or not a whole number of cents.");
  // a price can't go down once money is in (an amendment that lowers it is refused), so more paid in than the price only
  // happens if the record was changed by hand
  if (["funded", "delivered"].includes(c.status) && fc > price)
    return needsCheck(c, `more was paid in (${euro(fc)}) than the Order's price (${euro(price)}).`);
  // the record checks out: a note this check wrote earlier goes. The steps below then know it is gone, so the check of the
  // freelancer's Stripe account can still note its own finding for you on this very click.
  if (ownRecordNote(c)) {
    const gone = await db.update("contracts", `id=eq.${c.id}&${noteFilter(c)}`, { money_error: null }).catch(() => null);
    if (gone && gone.length) c.money_error = null;
  }
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
  if (!Number.isSafeInteger(amount) || amount < minFor || amount > MAX_CENTS) return refuse(409, "Payment amount out of range", "amount_out_of_range");
  if (chargebackOpen(c)) return refuse(409, "A card chargeback is open on this order; nothing can be paid until the bank decides", "chargeback_open");
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
  // The first line on Stripe's page: the price — or, for a top-up, the price increase both sides agreed to — named after
  // the Order. The whole line, the fixed words in front included, fits Stripe's 250 characters (stripeTitle).
  const prefix = kind === "topup" ? L.increase : L.order;
  const title = stripeTitle(c.title, STRIPE_NAME_MAX - prefix.length) || L.untitled;
  const items = [{ quantity: 1, price_data: { currency, unit_amount: amount, product_data: { name: `${prefix}${title}` } } }];
  if (fee > 0) items.push({ quantity: 1, price_data: { currency, unit_amount: fee, product_data: { name: L.fee, description: L.feeDesc } } });
  // One Checkout page per half hour and request: a second identical click within it gets the same page back (the
  // stored key below). That needs the same request each time, so the expiry is a fixed point 60–90 min ahead rather
  // than "now + 30 min".
  // Hold first, charge after: the page only places a hold on the card (capture_method manual). The money is charged
  // a moment later by applyPaidSession, and only if the Order can still take it; otherwise the hold is released and
  // nothing is charged, so nobody pays a card fee on money that has to go back.
  const slot = Math.floor(Date.now() / 1800e3);
  const prev = c.stripe_checkout_id;
  const params = {
    mode: "payment",
    client_reference_id: c.id,
    customer_email: me.email,
    expires_at: (slot + 3) * 1800,
    payment_method_types: ["card"],
    locale: L.locale || undefined,
    // Stripe puts the id of the page that was paid into the return link (where its guide shows it: in the part before the
    // #), so the check on return looks at that very page
    success_url: `${SITE_URL}/?cs={CHECKOUT_SESSION_ID}#orders?paid=${c.id}`,
    cancel_url: `${SITE_URL}/#orders?cancelled=${c.id}`,
    line_items: items,
    payment_intent_data: { capture_method: "manual", transfer_group: `contract_${c.id}`, metadata: { contract_id: c.id, editor: c.editor, client: c.client, kind } },
    // the breakdown travels with the page (Stripe keeps up to 500 characters per value): when this page's payment is confirmed,
    // this breakdown — not the one from a page made later with a changed fee table — is the one saved on the Order
    metadata: { contract_id: c.id, amount_cents: String(amount), fee_cents: String(fee), kind, ...(kind === "fund" ? { quote: JSON.stringify(quote).slice(0, 500) } : {}) },
  };
  // One key per exact request, kept in the database like the keys of payouts and refunds. It is named after the exact
  // text Stripe receives, so the same request again (two tabs in one language, Back and Fund again, a retry after a slow
  // answer) gets the same page back, and anything different (another language, a fee table or a page text changed by a
  // new version, or a new version writing the request differently) is a new request with its own key, never one Stripe
  // refuses. After a definite failure at Stripe the key is dropped, so the next click is a fresh try instead of Stripe
  // repeating that failure for the rest of the half hour.
  const scope = `checkout:${c.id}:${stripeFingerprint("/checkout/sessions", params)}`;
  let session = await makePage(scope, params);
  // For a repeated key Stripe hands back its saved answer, even when that page has been closed or paid since (a page in
  // another language replaced it and the client switched back; or the client paid and clicked Fund again before the
  // payment was confirmed). Only such a page is looked up at Stripe: Stripe marks answers it hands back from its memory,
  // and a page made more than a minute ago is looked up too, in case that mark is ever missing. A page this very request
  // has just made is open, so a hiccup at Stripe in a second call never stops a first click.
  if (session[REPLAYED] || !(Number(session.created) >= Date.now() / 1000 - 60)) {
    const live = await stripe("GET", `/checkout/sessions/${session.id}`);
    if (live.status === "complete") {
      // paid already: confirmed right now, the same way as on the return from Stripe (a problem there is left to the
      // return and the webhook, which confirm it too). code: the page says the Order isn't waiting for a payment — it may
      // already be paid — and reloads it.
      await applyPaidSession(live).catch(e => console.error("confirming a paid page at Fund", c.id, e && e.message));
      return json(409, { error: "This order is not waiting for payment", code: "not_payable" });
    }
    if (live.status === "expired") {
      // a closed page is never handed out: its key is dropped (only that key, so a new page another tab has just made
      // under a newer key stays the one both tabs get) and one new page is made
      await dropKeyIf(scope, session[IDEM_KEY]);
      const renewed = await makePage(scope, params);
      // the database could not forget the key, so Stripe handed back the closed page again: never sent to the client
      if (renewed.id === session.id) throw new Error("the payment page's key could not be renewed");
      session = renewed;
    }
  }

  const patch = kind === "fund" ? { stripe_checkout_id: session.id, fee_cents: fee, quote } : { stripe_checkout_id: session.id };
  // Saved only if the Order is still exactly as this request read it: same status, same price, same money paid in, and the
  // same page on record. Two Fund requests at the same moment (two tabs) then cannot both save a page: the second finds
  // the first one's page on the Order and hands that page back, so one Order never has two pages that could both be paid.
  const rows = await db.update("contracts", `id=eq.${c.id}&status=eq.${c.status}&${moneyUnchanged(c)}&${prev ? `stripe_checkout_id=eq.${encodeURIComponent(prev)}` : "stripe_checkout_id=is.null"}`, patch);
  if (!rows || !rows.length) {
    const now = await db.contract(c.id);
    const same = !!now && now.status === c.status && now.amount_cents === c.amount_cents && (now.funded_cents ?? null) === (c.funded_cents ?? null);
    // Stripe handed this request the very page another request has just saved (the same request twice: two tabs in one
    // language): it is the Order's page, so this tab gets it too, and it is never closed here
    if (same && now.stripe_checkout_id === session.id) return json(200, { url: session.url, amount, fee, total, cuvori_fee: 0, kind, held: heldCents(c) });
    // a page of this request's own that the Order is not using is closed, so it can never be paid
    if (!now || now.stripe_checkout_id !== session.id) await stripe("POST", `/checkout/sessions/${session.id}/expire`).catch(() => {});
    if (same && now.stripe_checkout_id && now.stripe_checkout_id !== prev && isSession(now.stripe_checkout_id)) {
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
