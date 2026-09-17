// POST /.netlify/functions/stripe-resolve { contract_id, decision: "release"|"refund"|"split", editor_percent, note }
// Admin only. Ends a disputed (or stuck) escrow contract.
import { escrowEnabled, db, userFromRequest, json, bad, releaseToEditor, refundToClient, contractEvent } from "../lib/cuvori.mjs";

export default async (req) => {
  if (req.method !== "POST") return bad("Method not allowed", 405);
  if (!escrowEnabled()) return bad("Escrow payments are not configured yet", 503);
  const me = await userFromRequest(req);
  if (!me || !me.is_admin) return bad("Admins only", 403);
  let body = {}; try { body = await req.json(); } catch {}
  const id = String(body.contract_id || "");
  if (!/^[0-9a-f-]{36}$/.test(id)) return bad("Bad contract id");
  const c = await db.one("contracts", `id=eq.${id}&select=*`);
  if (!c) return bad("Not found", 404);
  if (c.payment_mode !== "escrow" || !["funded", "delivered", "disputed"].includes(c.status)) return bad("This contract is not holding money", 409);

  const total = c.amount_cents || Math.round(Number(c.price) * 100);
  const decision = body.decision;
  let editorCents = 0, refundCents = 0;
  if (decision === "release") editorCents = total;
  else if (decision === "refund") refundCents = total;
  else if (decision === "split") { const p = Math.max(0, Math.min(100, Number(body.editor_percent))); editorCents = Math.round(total * p / 100); refundCents = total - editorCents; }
  else return bad("decision must be release, refund or split");

  let transferId = null, refundId = null;
  if (editorCents > 0) transferId = await releaseToEditor(c, editorCents);
  if (refundCents > 0) refundId = await refundToClient(c, refundCents);
  const now = new Date().toISOString();
  const status = editorCents > 0 ? "completed" : "refunded";
  const [u] = await db.update("contracts", `id=eq.${id}`, { status, resolution: decision, split_editor_cents: editorCents, resolved_at: now, resolved_by: me.id,
    stripe_transfer_id: transferId, stripe_refund_id: refundId, completed_at: editorCents > 0 ? now : null, closed_at: now, auto_release_at: null });
  await contractEvent(u, `resolved_${decision}`, me.id);
  // the side that lost a dispute goes on the watch list automatically
  if (c.status === "disputed") {
    const loser = decision === "refund" ? c.editor : decision === "release" ? c.client : null;
    if (loser) await db.insert("user_flags", { user_id: loser, kind: "dispute_lost", reason: `Lost dispute on "${c.title}"${body.note ? ": " + body.note : ""}`, contract_id: c.id, created_by: me.id });
  }
  if (body.note) await db.insert("messages", { conversation_id: c.conversation_id, sender: me.id, kind: "text", body: `Cuvori decision: ${body.note}` });
  return json(200, { ok: true, status, editorCents, refundCents });
};
