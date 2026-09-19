// POST { contract_id } (freelancer) — give a funded Order back: everything still held goes back to the
// client. A client who wants out after funding asks the freelancer (or opens a dispute); money never
// moves on one side's say-so in the other direction.
import { escrowEnabled, db, userFromRequest, json, bad, settle, readJson, safe, heldCents, orderEvent } from "../lib/cuvori.mjs";

export default safe(async (req) => {
  if (req.method !== "POST") return bad("Method not allowed", 405);
  if (!escrowEnabled()) return bad("Protected payments are not configured yet", 503);
  const me = await userFromRequest(req);
  if (!me) return bad("Sign in first", 401);
  if (me.banned) return bad("Account suspended", 403);
  const { contract_id: id, note } = await readJson(req);
  const c = await db.contract(id);
  if (!c || c.editor !== me.id) return bad("Not your order", 403);
  if (c.payment_mode !== "escrow") return bad("This order is not holding money", 409);
  const held = heldCents(c);
  if (!held) return bad("This order is not holding money", 409);
  let row = c.status === "resolving" && c.resolution === "refund" && c.resolved_by === me.id ? c : null;   // resume
  if (!row) {
    const now = new Date().toISOString();
    row = await db.claim(id, ["funded", "delivered"], { status: "resolving", resolution: "refund", split_editor_cents: 0, refund_cents: held, resolved_by: me.id, resolved_at: now, auto_release_at: null });
    if (!row) return bad("This order cannot be cancelled right now", 409);
    await db.update("order_milestones", `order_id=eq.${c.id}&status=in.(pending,submitted)`, { auto_release_at: null }).catch(() => {});
    await orderEvent(row, "cancelled", { by: "freelancer", refund_cents: held, note: typeof note === "string" ? note.slice(0, 500) : "" }, me.id);
  }
  const u = await settle(row, me.id, "cancel_refund");
  return json(200, { ok: true, status: u && u.status, refunded: held });
});
