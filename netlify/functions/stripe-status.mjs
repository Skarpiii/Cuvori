// GET /.netlify/functions/stripe-status → { escrow: true|false, feePercent, feeFixedCents, autoReleaseDays }
import { escrowEnabled, FEE_PERCENT, FEE_FIXED_CENTS, AUTO_RELEASE_DAYS, json } from "../lib/cuvori.mjs";
export default async () => json(200, { escrow: escrowEnabled(), feePercent: FEE_PERCENT, feeFixedCents: FEE_FIXED_CENTS, autoReleaseDays: AUTO_RELEASE_DAYS });
