// Stripe → Cuvori. Hardened copy.
// Platform endpoint events: checkout.session.completed, checkout.session.async_payment_succeeded,
//   charge.refunded, charge.dispute.created, charge.dispute.closed. Connect endpoint (separate secret): account.updated.
import { verifyWebhook, db, orderEvent, json, bad, stripe, isAcct, WEBHOOK_SECRET, applyPaidSession, contractByPi, onDisputeCreated, onDisputeClosed, heldCents, HOLDING } from "../lib/cuvori.mjs"; import crypto from "node:crypto";
const nz = (v) => (Number.isInteger(v) && v > 0 ? v : 0);

export default async (req) => {
  if (req.method !== "POST") return bad("Method not allowed", 405);
  const raw = await req.text();
  const sig = req.headers.get("stripe-signature");
  const CONNECT_SECRET = process.env.STRIPE_CONNECT_WEBHOOK_SECRET || "";
  let event = null, fromConnect = false;
  try { event = verifyWebhook(raw, sig, WEBHOOK_SECRET); } catch {}
  if (!event && CONNECT_SECRET) { try { event = verifyWebhook(raw, sig, CONNECT_SECRET); fromConnect = true; } catch {} }
  if (!event) { let dt = null; const dv = []; for (const p of String(sig || "").split(",")) { const di = p.indexOf("="); if (di < 0) continue; const dk = p.slice(0, di).trim(), dvv = p.slice(di + 1).trim(); if (dk === "t") dt = dvv; else if (dk === "v1") dv.push(dvv); } const ds = (process.env.STRIPE_WEBHOOK_SECRET || "").trim(); const dh = dt && ds ? crypto.createHmac("sha256", ds).update(dt + "." + raw).digest("hex") : null; return json(400, { error: "Invalid signature", diag: { sawHeader: !!sig, t: dt, skew: dt ? Math.round(Date.now() / 1000 - Number(dt)) : null, v1Count: dv.length, bytes: Buffer.byteLength(raw, "utf8"), secretLength: ds.length, computed: dh ? dh.slice(0, 12) : null, received: dv[0] ? dv[0].slice(0, 12) : null } }); }

  try {
    const o = event.data && event.data.object || {};
    if (!fromConnect && (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded")) {
      await applyPaidSession(o);
    } else if (event.type === "account.updated") {
      if (!isAcct(o.id)) return json(200, { ignored: true });
      const a = await stripe("GET", `/accounts/${o.id}`);                  // current state, not the (possibly stale / replayed) payload
      const enabled = !!(a.payouts_enabled && a.charges_enabled);
      await db.update("payout_details", `stripe_account_id=eq.${a.id}`, { stripe_payouts_enabled: enabled });
    } else if (!fromConnect && event.type === "charge.dispute.created") {
      await onDisputeCreated(o);
    } else if (!fromConnect && event.type === "charge.dispute.closed") {
      await onDisputeClosed(o);
    } else if (!fromConnect && event.type === "charge.refunded") {
      // a refund made in the Stripe dashboard (not by Cuvori): mirror it. Our own refunds are already in the ledger.
      const c = await contractByPi(o.payment_intent);
      if (c && o.amount_refunded > 0) {
        const ours = await db.select("order_payments", `order_id=eq.${c.id}&kind=eq.refund&select=id`);
        if (!ours || !ours.length) {
          if (o.refunded) {
            const gone = heldCents(c);
            const u = await db.claim(c.id, HOLDING, { status: "refunded", closed_at: new Date().toISOString(), resolution: "refund", auto_release_at: null, refunded_cents: nz(c.refunded_cents) + gone });
            if (u) { await db.insert("order_payments", { order_id: c.id, kind: "refund", amount_cents: Math.max(gone, 1), provider: "stripe", provider_ref: o.id, status: "succeeded", note: "dashboard_refund" }).catch(() => {}); await orderEvent(u, "refunded", { outside: true, amount_cents: o.amount_refunded }, null); }
          } else {
            await db.claim(c.id, ["funded", "delivered"], { status: "disputed", dispute_reason: `Partial refund ${o.amount_refunded} made outside Cuvori`, disputed_at: new Date().toISOString(), auto_release_at: null });
          }
        }
      }
    }
  } catch (e) {
    console.error("webhook handler", event.id, e && e.stack || e);
    return bad("Handler error", 500);                                       // Stripe retries
  }
  return json(200, { received: true });
};
