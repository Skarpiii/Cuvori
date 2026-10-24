// GET /.netlify/functions/stripe-status → { escrow: true|false, stripeKeyOk: true|false, databaseKeyOk: true|false, autoReleaseDays, settingsNotes }
// The processing cost is not here on purpose: the page asks the database (order_quote) for the exact amount.
// stripeKeyOk: whether the Stripe key in Netlify is a secret key at all (never the key itself), so the admin panel can say
// "ON, but paused" when it is not. databaseKeyOk: the same for the database key (SUPABASE_SECRET_KEY or the older
// SUPABASE_SERVICE_ROLE_KEY): whether it can be used, never the key.
// settingsNotes: a web-address setting in Netlify that had to be read loosely or replaced (SITE_URL, ALLOWED_ORIGINS,
// SUPABASE_URL), for the admin panel. Only the setting's name and the address Cuvori uses, never what was typed.
import { escrowEnabled, STRIPE_MODE, SERVICE_KEY_OK, AUTO_RELEASE_DAYS, SETTINGS_NOTES, json, safe } from "../lib/cuvori.mjs";
export default safe(async () => json(200, { escrow: escrowEnabled(), stripeKeyOk: !!STRIPE_MODE, databaseKeyOk: SERVICE_KEY_OK, autoReleaseDays: AUTO_RELEASE_DAYS, settingsNotes: SETTINGS_NOTES }));
