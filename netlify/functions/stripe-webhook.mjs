// Stripe → Cuvori. Hardened copy.
// Platform endpoint events: checkout.session.completed, checkout.session.async_payment_succeeded,
//   charge.refunded, charge.dispute.created. Connect endpoint (separate secret): account.updated.
import { verifyWebhook, db, contractEvent, orderEvent, ledger, json, bad, stripe, isUuid, isAcct, centsOf, WEBHOOK_SECRET } from "../lib/cuvori.mjs";
const CONNECT_SECRET = process.env.STRIPE_CONNECT_WEBHOOK_SECRET || "";

async function refundOrphan(s, why) {
  console.error("refunding payment that cannot fund an order", s.id, why);
  await stripe("POST", "/refunds", { payment_intent: s.payment_intent, amount: s.amount_total, metadata: { contract_id: s.client_reference_id || "", reason: why } }, { idempotency: `orphan_${s.payment_intent}` });
}

async function onPaid(s) {
  if (s.mode !== undefined && s.mode !== "payment") return;
  if (s.payment_status !== "paid") return;                                   // async methods: wait for async_payment_succeeded
  const id = s.client_reference_id;
  if (!isUuid(id) || !s.payment_intent) return;
  const c = await db.contract(id);
  if (!c) return refundOrphan(s, "unknown order");
  const md = s.metadata || {};
  const kind = md.kind === "topup" ? "topup" : "fund";
  if (kind === "fund" && c.stripe_payment_intent === s.payment_intent) return;                  // duplicate delivery
  // sessions made before v18 carry no amounts in their metadata: the Order row has them
  const amount = md.amount_cents != null ? Number(md.amount_cents) : centsOf(c), fee = md.fee_cents != null ? Number(md.fee_cents) : (Number.isInteger(c.fee_cents) ? c.fee_cents : 0);
  const expectedAmount = kind === "fund" ? centsOf(c) : (centsOf(c) || 0) - (c.funded_cents || 0);
  if (!Number.isInteger(amount) || amount !== expectedAmount || s.amount_total !== amount + fee
      || String(s.currency).toLowerCase() !== String(c.currency || "EUR").toLowerCase() || c.payment_mode !== "escrow")
    return refundOrphan(s, `amount/currency mismatch ${s.amount_total} ${s.currency} vs ${expectedAmount}+${fee}`);
  let charge = null;
  try { const pi = await stripe("GET", `/payment_intents/${s.payment_intent}`, { "expand[]": "latest_charge" }); charge = pi.latest_charge; } catch (e) { console.error("pi fetch", e.message); }
  let u;
  if (kind === "fund") {
    u = await db.claim(id, ["accepted"], { status: "funded", funded_at: new Date().toISOString(), funded_cents: amount, stripe_payment_intent: s.payment_intent, stripe_checkout_id: s.id, stripe_charge_id: charge && charge.id || null });
    if (!u) {
      const now = await db.contract(id);
      if (now && now.stripe_payment_intent === s.payment_intent) return;       // concurrent duplicate delivery won the claim
      return refundOrphan(s, `order is ${now && now.status}`);                // cancelled / already funded by another session
    }
  } else {
    // a top-up after an accepted amendment: same PaymentIntent bookkeeping is not possible (a second charge), so
    // the ledger row carries the intent; the counters move only once per intent
    const dup = await db.one("order_payments", `order_id=eq.${id}&provider_ref=eq.${encodeURIComponent(s.payment_intent)}&select=id`);
    if (dup) return;
    const rows = await db.update("contracts", `id=eq.${id}&status=in.(funded,delivered)&funded_cents=eq.${c.funded_cents || 0}`, { funded_cents: (c.funded_cents || 0) + amount });
    u = rows && rows[0];
    if (!u) return refundOrphan(s, `top-up no longer applies (order is ${c.status})`);
  }
  await ledger(u, { kind: "fund", amount_cents: amount, fee_cents: fee, provider_ref: s.payment_intent, note: kind });
  await orderEvent(u, kind === "fund" ? "funded" : "topped_up", { amount_cents: amount, fee_cents: fee, total_cents: amount + fee }, c.client);
  await contractEvent(u, "funded", c.client, { amount_cents: amount });
  const card = charge && charge.payment_method_details && charge.payment_method_details.card;
  if (card && card.fingerprint) await db.rpc("record_card", { uid: c.client, fingerprint: card.fingerprint, label: `${card.brand || "card"} ••${card.last4 || "????"}` }).catch(e => console.error("card", e.message));
}

const byPi = (pi) => (typeof pi === "string" && /^pi_[A-Za-z0-9]+$/.test(pi) ? db.one("contracts", `stripe_payment_intent=eq.${pi}&select=*`) : null);

export default async (req) => {
  if (req.method !== "POST") return bad("Method not allowed", 405);
  const raw = await req.text();
  const sig = req.headers.get("stripe-signature");
  let event = null, fromConnect = false;
  try { event = verifyWebhook(raw, sig, WEBHOOK_SECRET); } catch {}
  if (!event && CONNECT_SECRET) { try { event = verifyWebhook(raw, sig, CONNECT_SECRET); fromConnect = true; } catch {} }
  if (!event) return bad("Invalid signature", 400);

  try {
    const o = event.data && event.data.object || {};
    if (!fromConnect && (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded")) {
      await onPaid(o);
    } else if (event.type === "account.updated") {
      if (!isAcct(o.id)) return json(200, { ignored: true });
      const a = await stripe("GET", `/accounts/${o.id}`);                  // current state, not the (possibly stale / replayed) payload
      const enabled = !!(a.payouts_enabled && a.charges_enabled);
      await db.update("payout_details", `stripe_account_id=eq.${a.id}`, { stripe_payouts_enabled: enabled });
    } else if (!fromConnect && event.type === "charge.dispute.created") {
      const c = await byPi(o.payment_intent);
      if (c) {
        const u = await db.claim(c.id, ["funded", "delivered"], { status: "disputed", dispute_reason: `Card chargeback ${o.id}`, disputed_at: new Date().toISOString(), auto_release_at: null });
        if (u) { await db.update("order_milestones", `order_id=eq.${c.id}`, { auto_release_at: null }).catch(() => {}); await orderEvent(u, "disputed", { chargeback: o.id }, null); await contractEvent(u, "dispute", c.client); }
        await db.insert("user_flags", { user_id: c.client, kind: "other", reason: `Chargeback ${o.id} on "${c.title}" (order status was ${c.status})`, contract_id: c.id });
      }
    } else if (!fromConnect && event.type === "charge.refunded") {
      const c = await byPi(o.payment_intent);
      if (c && o.amount_refunded > 0) {
        const holding = ["funded", "delivered", "disputed"];
        if (o.refunded) { const u = await db.claim(c.id, holding, { status: "refunded", closed_at: new Date().toISOString(), resolution: "refund", auto_release_at: null }); if (u) await orderEvent(u, "refunded", { outside: true, amount_cents: o.amount_refunded }, null); }
        else await db.claim(c.id, ["funded", "delivered"], { status: "disputed", dispute_reason: `Partial refund ${o.amount_refunded} made outside Cuvori`, disputed_at: new Date().toISOString(), auto_release_at: null });
      }
    }
  } catch (e) {
    console.error("webhook handler", event.id, e && e.stack || e);
    return bad("Handler error", 500);                                       // Stripe retries
  }
  return json(200, { received: true });
};
