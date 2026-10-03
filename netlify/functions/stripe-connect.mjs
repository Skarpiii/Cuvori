// POST (editor) → onboarding link; GET → status. Hardened copy.
// Each freelancer has one saved Stripe account per Stripe mode (test / live): the keys decide which one is used, and the
// other one is never read, changed or removed, so switching the keys (on launch day, or by mistake and back) loses
// nothing. The only thing that ever sets a saved account aside is Stripe confirming it is gone, and only in test mode;
// it then moves to the history, never deleted. A live account is never replaced automatically.
import { escrowEnabled, stripe, db, userFromRequest, json, bad, SITE_URL, safe, isAcct, acctCols, lookupAccount, limitTries, accountReady } from "../lib/cuvori.mjs";

const BROKEN = "Stripe connection is broken, contact support";
const CHANGED = "Your Stripe setup changed a moment ago. Reload the page and try again.";

export default safe(async (req) => {
  if (!["GET", "POST"].includes(req.method)) return bad("Method not allowed", 405);
  if (!escrowEnabled()) return bad("Escrow payments are not configured yet", 503);
  const me = await userFromRequest(req);
  if (!me) return bad("Sign in first", 401);
  if (me.banned) return bad("Account suspended", 403);
  if (me.role !== "editor") return bad("Only professionals can receive payouts", 403);
  // the Payout details box asks for the status each time it opens, so that one may be asked a little more often
  await limitTries(me, req.method === "GET" ? "pay_connect_status" : "pay_connect", req.method === "GET" ? 30 : 10, req.method === "GET" ? 100 : 50);

  const col = acctCols();
  const payout = await db.one("payout_details", `id=eq.${me.id}&select=id,${col.id},${col.ready},stripe_account_history`);
  const history = Array.isArray(payout && payout.stripe_account_history) ? [...payout.stripe_account_history] : [];
  const saved = (payout && payout[col.id]) || null;
  let acct = null;
  if (saved) {
    if (!isAcct(saved)) return bad(BROKEN, 409);
    const found = await lookupAccount(saved);          // null only when Stripe confirms the account is gone; anything else throws and changes nothing
    if (found) {
      // someone else's account is never treated as unfinished setup
      if (!found.metadata || found.metadata.cuvori_user !== me.id) { console.error("account owner mismatch", me.id); return bad(BROKEN, 409); }
      acct = found;
      const enabled = accountReady(acct);                  // the one rule, the same as Fund and releases use
      if (enabled !== payout[col.ready]) await db.update("payout_details", `id=eq.${me.id}&${col.id}=eq.${saved}`, { [col.ready]: enabled });
    } else if (col.mode === "live") {
      // only Cuvori can remove a live account, or the keys belong to another Stripe account: a person decides, nothing is replaced
      console.error("saved live Stripe account not found for these keys", me.id, saved);
      return bad("Your Stripe connection needs a check by Cuvori support before you can be paid. Nothing was changed.", 409);
    } else {
      // test mode, and Stripe confirms the account is gone: set aside in the history, and only while it is still the one saved
      const entry = { id: saved, mode: col.mode, why: "not found at Stripe", at: new Date().toISOString() };
      const rows = await db.update("payout_details", `id=eq.${me.id}&${col.id}=eq.${saved}`, { [col.id]: null, [col.ready]: false, stripe_account_history: [...history, entry].slice(-50) });
      if (!rows || !rows.length) return bad(CHANGED, 409);
      history.push(entry);
    }
  }
  if (req.method === "GET") {
    if (!acct) return json(200, { connected: false, payouts_enabled: false });
    return json(200, { connected: true, payouts_enabled: accountReady(acct), requirements: acct.requirements && acct.requirements.currently_due || [] });
  }
  if (!acct) {
    // A new account. Its retry key names the account it replaces (or "first"): a retry of this attempt gets the same
    // account back, and a later, genuinely new attempt gets a new one, never the old account replayed.
    const replaces = history.filter(h => h && h.mode === col.mode && isAcct(h.id)).map(h => h.id).pop() || "first";
    acct = await stripe("POST", "/accounts", { type: "express", email: me.email, capabilities: { transfers: { requested: true } },
      business_type: "individual", metadata: { cuvori_user: me.id }, settings: { payouts: { schedule: { interval: "daily" } } } }, { idempotency: `acct3_${col.mode}_${me.id}_${replaces}` });
    // saved only where no account of this mode is saved yet: a request running at the same time can neither overwrite it nor be overwritten
    const rows = payout
      ? await db.update("payout_details", `id=eq.${me.id}&${col.id}=is.null`, { [col.id]: acct.id, [col.ready]: false })
      : await db.insert("payout_details", { id: me.id, methods: [], note: "", [col.id]: acct.id }).catch(() => null);
    if (!rows || !rows.length) {
      const now = await db.one("payout_details", `id=eq.${me.id}&select=${col.id}`);
      if (!now || now[col.id] !== acct.id) return bad(CHANGED, 409);
    }
  }
  const link = await stripe("POST", "/account_links", { account: acct.id, type: "account_onboarding",
    refresh_url: `${SITE_URL}/#settings?stripe=refresh`, return_url: `${SITE_URL}/#settings?stripe=return` });
  return json(200, { url: link.url });
});
