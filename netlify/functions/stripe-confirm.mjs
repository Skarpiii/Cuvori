// POST { contract_id, session_id } (client) → { status } — reconciliation. When the client comes back from Stripe the
// page asks here; the function looks the Checkout session up at Stripe itself and, if it is paid, funds the
// Order exactly as the webhook would. So a lost, late or misconfigured webhook can never leave a paid
// Order unfunded. Safe to call any number of times.
import { escrowEnabled, stripe, db, userFromRequest, json, bad, refuse, readJson, safe, limitTries, applyPaidSession, isSession, isPi } from "../lib/cuvori.mjs";

export default safe(async (req) => {
  if (req.method !== "POST") return bad("Method not allowed", 405);
  if (!escrowEnabled()) return refuse(503, "Protected payments are not configured yet", "payments_paused");
  const me = await userFromRequest(req);
  if (!me) return refuse(401, "Sign in first", "signed_out");
  await limitTries(me, "pay_confirm");         // at most about 10 tries a minute and 50 a day: nobody can use up Stripe's limits for everyone
  const { contract_id: id, session_id: sid } = await readJson(req);
  const c = await db.contract(id);
  if (!c || (c.client !== me.id && c.editor !== me.id)) return refuse(403, "Not your order", "not_your_order");
  const unchecked = () => json(200, { status: c.status, funded_cents: c.funded_cents || 0, checked: false });
  if (c.payment_mode !== "escrow") return unchecked();
  // The page the client has just paid: Stripe puts its id into the return link. It can differ from the page now on the
  // Order (the client paid in one tab while another tab made a new page), and then the paid one is the one to confirm.
  // It is used only when Stripe says it belongs to this very Order and was completed, and nothing of its payment has gone
  // back to the card (an old page whose payment was sent back as a late payment is not this Order's money, whatever the
  // Order waits for now); no id, a made-up one, another Order's page or a page not paid means the Order's current page is
  // checked, as before.
  let s = null;
  if (typeof sid === "string" && isSession(sid) && sid !== c.stripe_checkout_id) {
    const paid = await stripe("GET", `/checkout/sessions/${sid}`).catch(e => { if (e && e.status === 404) return null; throw e; });
    if (paid && paid.client_reference_id === c.id && paid.status === "complete" && isPi(paid.payment_intent)) {
      // a payment already on the Order is its own (the card-fee surplus that went back to the card afterwards changes nothing)
      const onOrder = paid.payment_intent === c.stripe_payment_intent || !!(await db.one("order_payments", `order_id=eq.${c.id}&kind=eq.fund&provider_ref=eq.${encodeURIComponent(paid.payment_intent)}&select=id`));
      let sentBack = false;
      if (!onOrder) {
        const p = await stripe("GET", `/payment_intents/${paid.payment_intent}`, { "expand[]": "latest_charge" });
        const ch = p && p.latest_charge && typeof p.latest_charge === "object" ? p.latest_charge : null;
        // (a hold that was let go is not money sent back: nothing was charged, and the page is told the hold went)
        sentBack = !!ch && ch.captured !== false && (ch.refunded === true || (Number.isInteger(ch.amount_refunded) && ch.amount_refunded > 0));
      }
      if (!sentBack) s = paid;
    }
  }
  if (!s) {
    if (!c.stripe_checkout_id || !isSession(c.stripe_checkout_id)) return unchecked();
    s = await stripe("GET", `/checkout/sessions/${c.stripe_checkout_id}`);
  }
  // whatever the Order's state: a hold for an Order that can no longer take it is released right away (and the page says so)
  const result = await applyPaidSession(s);
  const now = await db.contract(id);
  return json(200, { status: now.status, funded_cents: now.funded_cents || 0, checked: true, result });
});
