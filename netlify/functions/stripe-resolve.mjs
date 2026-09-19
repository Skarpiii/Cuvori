// POST { contract_id, decision, editor_percent, note } — admin only. Hardened copy.
import { escrowEnabled, db, userFromRequest, json, bad, settle, readJson, safe, heldCents } from "../lib/cuvori.mjs";

export default safe(async (req) => {
  if (req.method !== "POST") return bad("Method not allowed", 405);
  if (!escrowEnabled()) return bad("Escrow payments are not configured yet", 503);
  const me = await userFromRequest(req);
  if (!me || !me.is_admin || me.banned) return bad("Admins only", 403);
  const body = await readJson(req);
  const decision = body.decision;
  if (!["release", "refund", "split"].includes(decision)) return bad("decision must be release, refund or split");
  const note = typeof body.note === "string" ? body.note.slice(0, 2000) : "";
  const c = await db.contract(body.contract_id);
  if (!c) return bad("Not found", 404);
  if (c.payment_mode !== "escrow") return bad("This order is not holding money", 409);
  const total = heldCents(c);                                            // what is still held: released milestones stay released
  if (!total) return bad("This order is not holding money", 409);

  let row;
  if (c.status === "resolving") {                                        // resume: the recorded decision wins
    if (c.resolution !== decision) return bad(`A '${c.resolution}' decision is already in progress for this order`, 409);
    row = c;
  } else {
    let editorCents;
    if (decision === "release") editorCents = total;
    else if (decision === "refund") editorCents = 0;
    else {
      const p = typeof body.editor_percent === "number" ? body.editor_percent : NaN;
      if (!Number.isFinite(p) || p <= 0 || p >= 100) return bad("editor_percent must be a number between 0 and 100 (exclusive) for a split");
      editorCents = Math.round(total * p / 100);
    }
    const refundCents = total - editorCents;
    const now = new Date().toISOString();
    row = await db.claim(c.id, ["funded", "delivered", "disputed"], { status: "resolving", resolution: decision, split_editor_cents: editorCents, refund_cents: refundCents, resolved_by: me.id, resolved_at: now, auto_release_at: null });
    if (!row) return bad("This order is not holding money", 409);
    row.was_disputed = c.status === "disputed";
  }
  const u = await settle(row, me.id, `resolved_${decision}`);
  if (row.disputed_at || row.was_disputed) {
    const loser = decision === "refund" ? c.editor : decision === "release" ? c.client : null;
    // a retried decision must not flag the same person twice for the same contract
    const already = loser ? await db.one("user_flags", `user_id=eq.${loser}&contract_id=eq.${c.id}&kind=eq.dispute_lost&select=id`) : null;
    if (loser && !already) await db.insert("user_flags", { user_id: loser, kind: "dispute_lost", reason: `Lost dispute on "${String(c.title).slice(0, 200)}"${note ? ": " + note : ""}`, contract_id: c.id, created_by: me.id });
  }
  if (note) await db.insert("messages", { conversation_id: c.conversation_id, sender: me.id, kind: "text", body: `Cuvori decision: ${note}` });
  return json(200, { ok: true, status: u && u.status, editorCents: row.split_editor_cents, refundCents: row.refund_cents });
});
