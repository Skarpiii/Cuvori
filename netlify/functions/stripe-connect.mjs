// POST (editor) → onboarding link; GET → status. Hardened copy.
// Each freelancer has one saved Stripe account per Stripe mode (test / live): the keys decide which one is used, and the
// other one is never read, changed or removed, so switching the keys (on launch day, or by mistake and back) loses
// nothing. The only thing that ever sets a saved account aside is Stripe confirming it is gone, and only in test mode;
// it then moves to the history, never deleted. A live account is never replaced automatically.
import { escrowEnabled, stripe, db, userFromRequest, json, bad, refuse, SITE_URL, safe, isAcct, acctCols, lookupAccount, limitTries, accountReady, moneyPost, dropKeyIf, idemBusy, idemMismatch, stripeFingerprint } from "../lib/cuvori.mjs";

const BROKEN = "Stripe connection is broken, contact support";
const CHANGED = "Your Stripe setup changed a moment ago. Reload the page and try again.";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Makes the freelancer's Stripe account under a retry key kept in the database (moneyPost), the way a payment page is made
// (stripe-checkout.mjs). The key's name says the account it replaces and the exact request, so a retry after Stripe's answer
// was lost gets the same account back, never a second one. After a definite answer from Stripe (an error, a 500 included)
// the key goes, so the next click is a fresh try. Before (check of 25 November) the key was the same text on every click:
// Stripe keeps the first answer for a key, errors and 500s included, and hands it back for at least 24 hours, so one error
// from Stripe made "Set up payouts with Stripe" fail on every click for a day, also once Stripe was fine again.
// - Two clicks at the same moment: Stripe is still making the first click's account and tells the second to wait. The second
//   waits a moment and asks again with the same key, and gets that very account (for up to about 4 seconds).
// - A failure Stripe hands back from its memory of the key (the key was kept after a lost answer, and that try had failed),
//   or Stripe saying the key belongs to a different request: that key is dropped (only that one) and one fresh try is made.
async function makeAccount(scope, params) {
  let waits = 0, fresh = false;
  for (;;) {
    try { return await moneyPost(scope, "/accounts", params); }
    catch (e) {
      if (idemBusy(e) && waits < 10) { waits++; await sleep(400); continue; }
      if (!fresh && (idemMismatch(e) || (e && e.replayed && e.status >= 400))) { fresh = true; await dropKeyIf(scope, e.idemKey); continue; }
      throw e;
    }
  }
}

export default safe(async (req) => {
  if (!["GET", "POST"].includes(req.method)) return bad("Method not allowed", 405);
  if (!escrowEnabled()) return refuse(503, "Escrow payments are not configured yet", "payments_paused");
  const me = await userFromRequest(req);
  if (!me) return refuse(401, "Sign in first", "signed_out");
  if (me.banned) return refuse(403, "Account suspended", "account_suspended");
  if (me.role !== "editor") return refuse(403, "Only professionals can receive payouts", "not_professional");
  // the Payout details box asks for the status each time it opens, so that one may be asked a little more often
  await limitTries(me, req.method === "GET" ? "pay_connect_status" : "pay_connect", req.method === "GET" ? 30 : 10, req.method === "GET" ? 100 : 50);

  const col = acctCols();
  const payout = await db.one("payout_details", `id=eq.${me.id}&select=id,${col.id},${col.ready},stripe_account_history`);
  const history = Array.isArray(payout && payout.stripe_account_history) ? [...payout.stripe_account_history] : [];
  const saved = (payout && payout[col.id]) || null;
  let acct = null;
  if (saved) {
    if (!isAcct(saved)) return refuse(409, BROKEN, "connect_check");
    const found = await lookupAccount(saved);          // null only when Stripe confirms the account is gone; anything else throws and changes nothing
    if (found) {
      // someone else's account is never treated as unfinished setup
      if (!found.metadata || found.metadata.cuvori_user !== me.id) { console.error("account owner mismatch", me.id); return refuse(409, BROKEN, "connect_check"); }
      acct = found;
      const enabled = accountReady(acct);                  // the one rule, the same as Fund and releases use
      if (enabled !== payout[col.ready]) await db.update("payout_details", `id=eq.${me.id}&${col.id}=eq.${saved}`, { [col.ready]: enabled });
    } else if (col.mode === "live") {
      // only Cuvori can remove a live account, or the keys belong to another Stripe account: a person decides, nothing is replaced
      console.error("saved live Stripe account not found for these keys", me.id, saved);
      return refuse(409, "Your Stripe connection needs a check by Cuvori support before you can be paid. Nothing was changed.", "connect_check");
    } else {
      // test mode, and Stripe confirms the account is gone: set aside in the history, and only while it is still the one saved
      const entry = { id: saved, mode: col.mode, why: "not found at Stripe", at: new Date().toISOString() };
      const rows = await db.update("payout_details", `id=eq.${me.id}&${col.id}=eq.${saved}`, { [col.id]: null, [col.ready]: false, stripe_account_history: [...history, entry].slice(-50) });
      if (!rows || !rows.length) return refuse(409, CHANGED, "setup_changed");
      history.push(entry);
    }
  }
  if (req.method === "GET") {
    if (!acct) return json(200, { connected: false, payouts_enabled: false });
    return json(200, { connected: true, payouts_enabled: accountReady(acct), requirements: acct.requirements && acct.requirements.currently_due || [] });
  }
  if (!acct) {
    // A new account. Its retry key names the account it replaces (or "first"): a retry of this attempt gets the same
    // account back, and a later, genuinely new attempt gets a new one, never the old account replayed. The key is kept in
    // the database and goes after a definite answer from Stripe (makeAccount). (Its name has no Order id after its first
    // ":", so the database's check of Orders at the new prices, schema v56, never takes it for an Order's money step.)
    const replaces = history.filter(h => h && h.mode === col.mode && isAcct(h.id)).map(h => h.id).pop() || "first";
    const params = { type: "express", email: me.email, capabilities: { transfers: { requested: true } },
      business_type: "individual", metadata: { cuvori_user: me.id }, settings: { payouts: { schedule: { interval: "daily" } } } };
    acct = await makeAccount(`acct3_${col.mode}_${me.id}_${replaces}:${stripeFingerprint("/accounts", params)}`, params);
    // saved only where no account of this mode is saved yet: a request running at the same time can neither overwrite it nor be overwritten
    const rows = payout
      ? await db.update("payout_details", `id=eq.${me.id}&${col.id}=is.null`, { [col.id]: acct.id, [col.ready]: false })
      : await db.insert("payout_details", { id: me.id, methods: [], note: "", [col.id]: acct.id }).catch(() => null);
    if (!rows || !rows.length) {
      const now = await db.one("payout_details", `id=eq.${me.id}&select=${col.id}`);
      if (!now || now[col.id] !== acct.id) return refuse(409, CHANGED, "setup_changed");
    }
  }
  const link = await stripe("POST", "/account_links", { account: acct.id, type: "account_onboarding",
    refresh_url: `${SITE_URL}/#settings?stripe=refresh`, return_url: `${SITE_URL}/#settings?stripe=return` });
  return json(200, { url: link.url });
});
