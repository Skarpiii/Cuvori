// Stripe → Cuvori. Configure in Stripe: Developers → Webhooks → endpoint
// https://cuvori.netlify.app/.netlify/functions/stripe-webhook
// events: checkout.session.completed, account.updated, charge.refunded
import { verifyWebhook, db, contractEvent, json, bad, stripe } from "../lib/cuvori.mjs";

export default async (req) => {
  if (req.method !== "POST") return bad("Method not allowed", 405);
  const raw = await req.text();
  let event;
  try { event = verifyWebhook(raw, req.headers.get("stripe-signature")); }
  catch (e) { return bad("Invalid signature: " + e.message, 400); }

  try {
    if (event.type === "checkout.session.completed") {
      const s = event.data.object;
      const id = s.client_reference_id || (s.metadata && s.metadata.contract_id);
      if (id && s.payment_status === "paid") {
        const c = await db.one("contracts", `id=eq.${id}&select=*`);
        if (c && c.status === "accepted") {
          const [u] = await db.update("contracts", `id=eq.${id}`, { status: "funded", funded_at: new Date().toISOString(), stripe_payment_intent: s.payment_intent, stripe_checkout_id: s.id });
          await contractEvent(u, "funded", c.client);
          // remember which card paid (fingerprint only), so a flagged person is recognised on a new account
          try {
            const pi = await stripe("GET", `/payment_intents/${s.payment_intent}`, { "expand[]": "latest_charge" });
            const card = pi.latest_charge && pi.latest_charge.payment_method_details && pi.latest_charge.payment_method_details.card;
            if (card && card.fingerprint) await db.rpc("record_card", { uid: c.client, fingerprint: card.fingerprint, label: `${card.brand || "card"} ••${card.last4 || "????"}` });
          } catch (e) { console.error("card fingerprint", e.message); }
        }
      }
    } else if (event.type === "account.updated") {
      const a = event.data.object;
      const enabled = !!(a.payouts_enabled && a.charges_enabled);
      await db.update("payout_details", `stripe_account_id=eq.${a.id}`, { stripe_payouts_enabled: enabled });
    } else if (event.type === "charge.refunded") {
      const ch = event.data.object;
      const id = ch.metadata && ch.metadata.contract_id;
      if (id) { const c = await db.one("contracts", `id=eq.${id}&select=*`); if (c && c.status !== "refunded" && c.status !== "completed" && ch.refunded) { /* full external refund */ await db.update("contracts", `id=eq.${id}`, { status: "refunded", closed_at: new Date().toISOString(), resolution: "refund" }); } }
    }
  } catch (e) {
    return bad("Handler error: " + e.message, 500);
  }
  return json(200, { received: true });
};
