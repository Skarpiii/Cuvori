// GET /.netlify/functions/stripe-status → { escrow: true|false, autoReleaseDays }
// The processing cost is not here on purpose: the page asks the database (order_quote) for the exact amount.
import { escrowEnabled, AUTO_RELEASE_DAYS, json, safe } from "../lib/cuvori.mjs";
export default safe(async () => json(200, { escrow: escrowEnabled(), autoReleaseDays: AUTO_RELEASE_DAYS }));
