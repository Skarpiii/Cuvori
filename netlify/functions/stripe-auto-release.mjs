// Runs every hour (Netlify scheduled function). Releases money for contracts that were
// delivered and not approved, disputed or sent back within AUTO_RELEASE_DAYS.
import { escrowEnabled, db, releaseToEditor, contractEvent, json } from "../lib/cuvori.mjs";

export const config = { schedule: "@hourly" };

export default async () => {
  if (!escrowEnabled()) return json(200, { skipped: "escrow not configured" });
  const now = new Date().toISOString();
  const due = await db.select("contracts", `status=eq.delivered&payment_mode=eq.escrow&auto_release_at=lte.${encodeURIComponent(now)}&select=*`);
  const done = [];
  for (const c of due || []) {
    try {
      const cents = c.amount_cents || Math.round(Number(c.price) * 100);
      const transferId = await releaseToEditor(c, cents);
      const [u] = await db.update("contracts", `id=eq.${c.id}`, { status: "completed", completed_at: now, closed_at: now, resolution: "release", resolved_at: now, stripe_transfer_id: transferId, split_editor_cents: cents });
      await contractEvent(u, "auto_release", c.editor);
      done.push(c.id);
    } catch (e) { console.error("auto-release failed for", c.id, e.message); }
  }
  return json(200, { released: done });
};
