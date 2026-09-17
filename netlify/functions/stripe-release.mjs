// POST /.netlify/functions/stripe-release { contract_id }  (client) — approve the delivery and
// release the held money to the editor. Also used by the client to "approve early" while funded.
import { escrowEnabled, db, userFromRequest, json, bad, releaseToEditor, contractEvent } from "../lib/cuvori.mjs";

export default async (req) => {
  if (req.method !== "POST") return bad("Method not allowed", 405);
  if (!escrowEnabled()) return bad("Escrow payments are not configured yet", 503);
  const me = await userFromRequest(req);
  if (!me) return bad("Sign in first", 401);
  let body = {}; try { body = await req.json(); } catch {}
  const id = String(body.contract_id || "");
  if (!/^[0-9a-f-]{36}$/.test(id)) return bad("Bad contract id");
  const c = await db.one("contracts", `id=eq.${id}&select=*`);
  if (!c || c.client !== me.id) return bad("Not your contract", 403);
  if (c.payment_mode !== "escrow" || !["funded", "delivered"].includes(c.status)) return bad("Nothing to release right now", 409);

  const cents = c.amount_cents || Math.round(Number(c.price) * 100);
  const transferId = await releaseToEditor(c, cents);
  const now = new Date().toISOString();
  const [u] = await db.update("contracts", `id=eq.${id}`, { status: "completed", completed_at: now, closed_at: now, resolution: "release", resolved_at: now, resolved_by: me.id, stripe_transfer_id: transferId, split_editor_cents: cents });
  await contractEvent(u, "approve", me.id);
  return json(200, { ok: true, transfer: transferId });
};
