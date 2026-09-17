# Cuvori — turning on real accounts

Follow these steps once. About 20 minutes. Nothing here needs coding.

## Part 1 — Create the backend (Supabase)

1. Go to https://supabase.com and click **Start your project**. Sign up (GitHub login is easiest).
2. Click **New project**. Name: `Cuvori`. Choose a strong database password (save it somewhere, you will rarely need it). Region: **Frankfurt** (closest to Lithuania). Click **Create new project** and wait about a minute.
3. In the left menu click **SQL Editor** → **New query**. Open the file `supabase/schema.sql` from this repo, copy **everything**, paste it into the editor and click **Run**. You should see "Success". This creates the accounts table, the invite system and the security rules.
4. In the left menu click **Authentication** → **Providers** → **Email**. Turn **Confirm email OFF** for now (so people can sign in immediately without clicking an email link). Save. You can turn it back on later when you have a custom email sender.
5. In the left menu click **Project Settings** (gear icon) → **API**. Copy two values:
   - **Project URL** (looks like `https://abcdefgh.supabase.co`)
   - **anon public** key (a long text starting with `eyJ...`). This key is safe to put in the website — it only allows what the security rules allow.

## Part 2 — Put the keys into the site

Open `index.html` and find this line near the bottom (search for `CUVORI_CONFIG`):

```
window.CUVORI_CONFIG = { supabaseUrl: "", supabaseAnonKey: "" };
```

Paste the two values between the quotes, save, then commit and push in GitHub Desktop.
(Or paste the two values to Claude and it will do this for you.)

## Part 3 — Put the site online (Netlify)

1. Go to https://www.netlify.com and sign up with your GitHub account.
2. Click **Add new site** → **Import an existing project** → **GitHub**. Allow Netlify to see the `Cuvori` repository and pick it.
3. Leave the build settings as they are (the repo contains `netlify.toml`, which tells Netlify what to do). Click **Deploy**.
4. After a minute you get an address like `https://something-1234.netlify.app`. That is the real Cuvori. Every time you push to GitHub, Netlify updates the site automatically.
5. Later, to use **cuvori.io**: Netlify → **Domain management** → **Add a domain** and follow the instructions from your domain provider.

## Part 4 — Check it works

- Open the Netlify address. The yellow "Demo mode" strip at the top should be **gone**.
- Click **Create account**, sign up with your email. You should land on the Account page as a **Client**.
- Go to **Join as an editor** and enter `CUV-2026-EDIT`. Your account becomes an **Editor**. The same code will not work a second time.
- Sign out, sign in again — your role is remembered because it lives in the database, not in the browser.

## Making invite codes

In Supabase → SQL Editor, run for example:

```
select public.create_invite('CUV-JOHN-2026', 'for John');
```

Codes must look like `CUV-XXXX-XXXX` (letters/numbers). Each code works once. Nobody can read the codes from the website; only their scrambled versions are stored.

## What is real now, and what is still demo

Real: sign up, sign in, sign out, password reset by email, change password, first name, client/editor role, invite codes.

Still demo (next steps): the three example editors, jobs, messages, progress updates, contracts and portfolios are sample data shown to everyone and are not saved yet.

## Part 5 — Protected payments (Stripe escrow)

Money never touches Cuvori's bank account directly: Stripe holds it in Cuvori's Stripe balance until the client approves, Cuvori decides a dispute, or 7 days pass after delivery. Until this part is done the site uses **direct payments** (the client pays the editor's IBAN/PayPal and both confirm).

1. Create a Stripe account at https://stripe.com (country: Lithuania; individual is fine to start). Finish the identity and bank checks Stripe asks for.
2. Stripe dashboard → **Settings → Connect** → get started → choose **Express** accounts. Also set the platform name/branding ("Cuvori").
3. Stripe → **Developers → API keys**: copy the **Secret key** (starts with `sk_test_` in test mode, `sk_live_` later).
4. Stripe → **Developers → Webhooks → Add endpoint**: URL `https://cuvori.netlify.app/.netlify/functions/stripe-webhook`, events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `account.updated`, `charge.refunded`, `charge.dispute.created`. Copy the **Signing secret** (`whsec_...`). If Stripe puts `account.updated` on a separate "Connected accounts" endpoint, give that endpoint the same URL and add its signing secret as `STRIPE_CONNECT_WEBHOOK_SECRET`.
5. Supabase → **Project Settings → API**: copy the **service_role** key (secret! never put it in the page).
6. Netlify → site → **Site configuration → Environment variables** → add:
   - `STRIPE_SECRET_KEY` = sk_…
   - `STRIPE_WEBHOOK_SECRET` = whsec_…
   - `SUPABASE_SERVICE_ROLE_KEY` = the service_role key
   - optional: `FEE_PERCENT` (default 3), `FEE_FIXED_CENTS` (default 25), `AUTO_RELEASE_DAYS` (default 7)
   Then **Deploys → Trigger deploy**. From now on new contracts are "Protected payment".
7. Run `supabase/schema_v5.sql` … `schema_v9.sql` in the Supabase SQL editor, in order (already done for the live database).
8. Test in Stripe **test mode**: editor → Settings → Payout details → "Set up payouts with Stripe" (use Stripe's test data); client → contract → Pay now → card `4242 4242 4242 4242`, any future date, any CVC.
9. Go live: switch the two Stripe keys to live keys in Netlify and trigger a deploy.

How the money flows: client pays price + card fee → held → editor "Mark as delivered" → client "Approve & release" (or 7-day auto-release) → Stripe pays the editor's bank. Disputes (either side) stop the clock; you decide in Admin panel → Contracts & disputes: release, refund or split.

## Part 6 — Security checks (keep these working)

The database rules were attacked from every side (visitor, client, editor, banned user, admin) and hardened in `supabase/schema_v9.sql` and `schema_v10.sql`.

1. Run `supabase/schema_v9.sql` in the Supabase SQL editor, then `supabase/check_v9.sql` (it lists existing rows that break the new limits; they keep working but must be fixed before they can be saved again).
2. Run `supabase/schema_v10.sql` **only after the new page is live** (it hides other people's e-mails; the old page would lose its sign-in role).
3. The page has a Content-Security-Policy that allows only its own scripts, by fingerprint. **After any change to `index.html` run `python3 tools/csp.py index.html`**, otherwise the page will not start.
4. The full test kit is stored as `tests/test-kit.tar.gz` (unpack it in the repo folder with `tar xzf tests/test-kit.tar.gz`). Then `tests/run-all.sh` runs every check: 178 database attacks, payment-function attacks, stored-XSS proofs, the browser policy test, the UI fuzz test (7 languages × 4 screen widths) and all site flows.
