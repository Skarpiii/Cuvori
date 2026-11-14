// GET /.netlify/functions/stripe-status → { escrow: true|false, stripeKeyOk: true|false, databaseKeyOk: true|false, autoReleaseDays }
// (+ settingsNotes and heldApart for a signed-in admin)
// The processing cost is not here on purpose: the page asks the database (order_quote) for the exact amount.
// stripeKeyOk: whether the Stripe key in Netlify is a secret key at all (never the key itself), so the admin panel can say
// "ON, but paused" when it is not. databaseKeyOk: the same for the database key (SUPABASE_SECRET_KEY or the older
// SUPABASE_SERVICE_ROLE_KEY): whether it can be used, never the key. Both stay in the answer anyone gets: without a working
// database key nobody can be told apart as an admin, and that is exactly when the admin panel must say so.
// settingsNotes: a web-address setting in Netlify that had to be read loosely or replaced (SITE_URL, ALLOWED_ORIGINS,
// SUPABASE_URL), for the admin panel. Only the setting's name and the address Cuvori uses, never what was typed. Only an
// admin (the request carries their sign-in) gets them: anyone can call this, and how Cuvori's settings are set up is
// nobody else's business. A sign-in that can't be checked right now never stops the answer: the notes are then left out.
// heldApart: whether money is held apart at Stripe (STRIPE_FUNDS_SEGREGATION), where it is asked for (STRIPE_FS_WHERE: on
// Stripe's payment page, "checkout", or just before the card is charged, "capture") and with which Stripe preview version
// (STRIPE_PREVIEW_VERSION, or Cuvori's own), as the payment code reads them: for an admin only, like the notes (SETUP.md,
// Part 22; check of 18 November: before, only Netlify's settings page showed it).
import { escrowEnabled, STRIPE_MODE, SERVICE_KEY_OK, AUTO_RELEASE_DAYS, SETTINGS_NOTES, json, safe, userFromRequest, segregationOn, fsWhere, fsPreview } from "../lib/cuvori.mjs";
export default safe(async (req) => {
  const out = { escrow: escrowEnabled(), stripeKeyOk: !!STRIPE_MODE, databaseKeyOk: SERVICE_KEY_OK, autoReleaseDays: AUTO_RELEASE_DAYS };
  if (req && /^Bearer\s+\S+$/i.test(req.headers.get("authorization") || "")) {
    const me = await userFromRequest(req).catch(() => null);
    if (me && me.is_admin === true && me.banned !== true) { out.settingsNotes = SETTINGS_NOTES; out.heldApart = { on: segregationOn(), where: fsWhere(), version: fsPreview() }; }
  }
  return json(200, out);
});
