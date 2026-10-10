// GET /.netlify/functions/stripe-status → { escrow: true|false, stripeKeyOk: true|false, autoReleaseDays }
// The processing cost is not here on purpose: the page asks the database (order_quote) for the exact amount.
// stripeKeyOk: whether the Stripe key in Netlify is a secret key at all (never the key itself), so the admin panel can say
// "ON, but paused" when it is not.
import { escrowEnabled, STRIPE_MODE, AUTO_RELEASE_DAYS, json, safe } from "../lib/cuvori.mjs";
export default safe(async () => json(200, { escrow: escrowEnabled(), stripeKeyOk: !!STRIPE_MODE, autoReleaseDays: AUTO_RELEASE_DAYS }));
