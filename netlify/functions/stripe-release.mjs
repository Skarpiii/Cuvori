// POST { contract_id } (client) — approve and release. Hardened copy.
import { escrowEnabled, db, userFromRequest, json, bad, settle, readJson, safe, isBanned, centsOf, payoutAccount } from "../lib/cuvori.mjs";

export default safe(async (req) => {
  if (req.method !== "POST") return bad("Method not allowed", 405);
  if (!escrowEnabled()) return bad("Escrow payments are not configured yet", 503);
  const me = await userFromRequest(req);
  if (!me) return bad("Sign in first", 401);
  if (me.banned) return bad("Account suspended", 403);
  const { contract_id: id } = await readJson(req);
  const c = await db.contract(id);
  if (!c || c.client !== me.id) return bad("Not your contract", 403);
  if (c.payment_mode !== "escrow") return bad("Nothing to release right now", 409);
  const cents = centsOf(c);
  if (!cents) return bad("Contract amount missing", 409);
  let row = c.status === "releasing" && c.resolution === "release" ? c : null;          // resume an interrupted release
  if (!row) {
    if (await isBanned(c.editor)) return bad("This contract is under review by Cuvori", 409);
    const acct = await payoutAccount(c.editor);
    if (!acct || !acct.payouts_enabled) return bad("The editor's Stripe account is not ready yet", 409);
    const now = new Date().toISOString();
    row = await db.claim(id, ["funded", "delivered"], { status: "releasing", resolution: "release", split_editor_cents: cents, refund_cents: 0, resolved_by: me.id, resolved_at: now, auto_release_at: null });
    if (!row) return bad("Nothing to release right now", 409);
  }
  const u = await settle(row, me.id, "approve");
  return json(200, { ok: true, transfer: u && u.stripe_transfer_id });
});
