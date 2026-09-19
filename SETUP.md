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
2. Run `supabase/schema_v10.sql` **only after the new page is live** (it hides other people's e-mails; the old page would lose its sign-in role). Then run `supabase/schema_v11.sql` (contract templates: types, governing law, clauses, counter-proposals).
3. The page has a Content-Security-Policy that allows only its own scripts, by fingerprint. **After any change to `index.html` run `python3 tools/csp.py index.html`**, otherwise the page will not start.
4. Contract clause texts live in `contracts-i18n/*.js` (English is the source; the others are translations) and are merged into `index.html` — edit them there and re-merge, never edit the page by hand. **Never change the wording of a clause that people have already accepted.** Accepted contracts store their own copy of the text (`contracts.terms_doc`), so old contracts keep what was signed, but for new wording bump `clauses_version` in `schema_v11.sql` and keep the old file for reference.
5. Two numbers must stay equal or contracts will say something the system does not do: `AUTO_RELEASE_DAYS` in Netlify, `auto_days` on the contracts table, and the `7 days` inside `contract_action()`.
6. The full test kit is stored as `tests/test-kit.tar.gz` (unpack it in the repo folder with `tar xzf tests/test-kit.tar.gz`). Then `tests/run-all.sh` runs every check: 248 database attacks, payment-function attacks, stored-XSS proofs, the browser policy test, the UI fuzz test (7 languages × 4 screen widths) and all site flows.

## Part 7 — Open questions for the contract templates (business decisions)

The clause texts were reviewed adversarially (how each clause could be abused, and where it may not hold up in EU / Lithuanian law) and fixed where wording alone could fix it. Four things need a decision from you, not from code:

1. **Holding other people's money.** Protected payments land in Cuvori's own Stripe balance before being paid out. Depending on how this grows, that can count as handling third-party funds and may need a payment-institution licence or an agent-of-payee arrangement. Ask Stripe (and, once there is revenue, an accountant) before switching escrow on for real money.
2. **The payment fee.** The client pays 3% + €0.25 on top of the price. The contract now says plainly that this fee covers card and payment handling and is not refunded if the money is later returned. Check that the percentage really covers Stripe's cost in your country, and never describe it as "no fees" in marketing.
3. **Cuvori's decision in a dispute.** With protected payments, both sides accept that Cuvori distributes the held money, while keeping the right to go to court afterwards. With direct payments Cuvori can only give a written opinion. Keep that difference visible — promising more than that in marketing would be a promise you cannot keep.
4. **A lawyer's read.** The templates are careful but they are not legal advice. Before serious volume, have a Lithuanian lawyer look at the Lithuanian and English versions, in particular the transfer of copyright, the consumer withdrawal clause and the dispute clause.

## Part 8 — The site rules, the privacy notice and the report route

Everyone who creates an account now has to tick a box agreeing to the rules and the privacy notice, and the version they agreed to is recorded against their account. Existing users are asked again whenever the version changes.

1. Run `supabase/schema_v12.sql` in the Supabase SQL editor. It adds the acceptance record, the `reports` table (with the admin queue), the requirement that a ban always carries a written reason, the "verified client" badge that only appears when a real contract backs the review, and a `purge_old_records()` cleanup for the 24-month retention the privacy notice promises.
2. Fill in **`window.CUVORI_LEGAL`** near the top of `index.html`: the legal name that runs Cuvori, the address, and a working e-mail. These three values appear in the rules, the privacy notice and the footer, and the law requires them to be real. Until there is a company, your own name and address are the honest answer.
3. The contact address is currently **egidijus.cuvori@gmail.com**, set in `window.CUVORI_LEGAL`. Every objection, report and data request in the rules points at it, so it has to keep working. To move to **hello@cuvori.io** later: Cloudflare → cuvori.io → **Email Routing** → enable → add a custom address `hello@cuvori.io` forwarding to the Gmail, confirm the verification mail, then change the one value in `window.CUVORI_LEGAL`. In Gmail, **Settings → Accounts → Send mail as** lets you reply as hello@cuvori.io so replies do not come from a personal-looking address.
4. Rules and privacy text live in `rules-i18n/*.js` (English is the source) and are merged into `index.html`. When you change them, bump `RULES_VERSION` in `index.html` **only if the change matters to people** — bumping it asks every user to agree again, which is right for a real change and annoying for a typo fix.
5. Reports arrive in **Admin panel → Reports**. Every one must be closed with a written reason: that reason is shown back to the person who reported it, and it is the record a regulator would ask for under the Digital Services Act. Answer within a few days.
6. `purge_old_records()` is not scheduled. Once a month, run `select public.purge_old_records();` in the SQL editor (or set up a Supabase cron job) so the retention promise in the privacy notice is true.

## Part 9 — Whether an editor is taking work

Editors set their own status, clients can filter by it, and it expires so it cannot quietly become a lie.

1. Run `supabase/schema_v13.sql` in the Supabase SQL editor.
2. The three states are **Available**, **Busy until a date** and **Not taking work**, set in Edit profile. A "busy until" date that has passed counts as available again on its own.
3. A status nobody has touched for **30 days** stops counting: the badge disappears, the card shows roughly when that editor was last active instead, and the editor gets a one-line nudge to update it. Only a deliberate answer restarts the 30 days — saving the bio does not.
4. **When a job finishes, the editor is asked whether they are free again, and the question cannot be clicked away.** That is what keeps the badge honest, because it asks at the moment the answer is actually known.
5. Browse results put editors who can take work first, and the "Available now" filter chip hides everyone else.
6. Editor profiles publish the day (never the time) they were last active. This is written into the privacy notice; if you ever remove it from the site, remove it from the notice too.

## Part 10 — Reports reach you as an administrator

1. Run `supabase/schema_v14.sql` in the Supabase SQL editor.
2. When anyone uses the **Report** button, three things happen: the report is filed in the queue, it is delivered to every administrator as a normal chat message (so it sits in Messages with everything else and you can reply to the person directly), and the bell shows **"Reports waiting: N"** which opens the queue when clicked.
3. The message is sent from the person who reported, starting with a line like `Report · scam · profile (…)`, so it is obvious what it is.
4. Ordinary users still cannot start a chat with you out of the blue — only a report opens that door. That is deliberate: it keeps your inbox usable while leaving the complaint route open.
5. **The first account that ever signed up is the administrator.** Check in Supabase → Table editor → `profiles` that `is_admin` is true on your own row and nobody else's.
6. This covers reports made on the site. Mail sent directly to the contact address still arrives in Gmail as normal — the site cannot read your mailbox.

## Part 11 — Professions as data (video editors were the first; the rest come without a rewrite)

Cuvori is no longer hard-wired around "editor". A profession is a row in `professions`, its filters are rows in `filters` and `profession_filters`, and what a person offers is a row per profession in `services` — with its own price and its own answers. Existing editors, videographers and photographers were copied into services by `migrate_v15.sql`; nothing was deleted, and `editor_profiles` still mirrors the main service's price and specialisms so everything old keeps working.

1. Run, in this order, in the Supabase SQL editor: `supabase/schema_v15.sql`, then `supabase/professions_seed.sql`, then `supabase/migrate_v15.sql`, then `supabase/schema_v16.sql`, then `supabase/schema_v17.sql`, then `supabase/professions_seed.sql` once more (v17 adds the "add your own" flag that the seed sets). The first one also keeps a copy of `editor_profiles`, `projects` and `jobs` inside the database as `backup_v15_*` tables — drop those once you are sure, not before.
2. **What clients see.** The home page has a profession selector, and the list under it is simply the search result (there is no "featured" list). Browse jobs has the same selector, with that profession's filters appearing under it. Languages are typed, not picked: "Lith" suggests Lithuanian and each pick becomes a tag. A profession is offered to clients only when it is *open* AND at least one real, public professional offers it. Choosing one changes the chip row and "View all filters" to that profession's set — video editors get specialities, software and turnaround; photographers get shoot types, studio/on-location, travel radius and editing-included; nothing from one ever appears on the other. Filtering happens in the database (`search_professionals()`), so it stays correct and fast as people arrive.
3. **What professionals see.** Edit profile has a Services block. A new professional picks their profession and only that profession's questions appear. "Add" offers a second profession with its own price; an old combined editor-photographer account simply shows two services. The lists of specialities, software and skills are not closed: under each there is an "Add your own…" field — type it, press Enter (or a comma), and it becomes a tag next to the standard picks. Up to 10 own entries per list, 40 characters each, no `<` or `>`; the database checks the same limits. Own entries show on the profile and on the card, and a client's free-text search finds them (typing "twitch" finds someone who wrote "Twitch stream highlights"). Only standard options become filter chips — an own entry is a word, not a filter. Admin panel → Professions has a per-list switch to allow or stop own entries.
4. **Admin panel → Professions.** Open or close a profession for joining, mark it invite-only, reorder, attach or detach filters, mark a filter primary (chip row) or secondary (behind "View all filters"), add options — all without touching code. Closed professions (Motion designer, Copywriter, Web developer are seeded closed) can be opened the moment you want to recruit into them; they stay invisible to clients until someone real is in them.
5. **Adding languages to something you added in the admin panel.** Admin-added names and options carry an English label; the other six languages fall back to English until you add them. Seeded content is fully translated. To translate admin-added labels properly, edit `professions/seed.js` (or the `tr-*.json` files beside it), run `node tools/gen-professions.js`, and re-run `professions_seed.sql` — it never overwrites options an admin has touched.
6. **Jobs** carry `profession_slug`; the Post-a-job form asks for the profession first and shows that profession's speciality list. Old jobs were given their profession from the legacy role.
7. Everything else — accounts, messaging, contracts, reviews, reports, invites — is shared across professions and was not changed.

## Part 12 — Real, demo and hidden accounts

Every account has a visibility: **Real / public**, **Demo / test**, or **Hidden**. Demo and hidden accounts keep working for their owner and for admins, but never appear in search, browse pages, profession counts, ratings or job lists, and a demo account can never make an empty profession look populated.

1. `schema_v16.sql` (run in Part 11) adds it. Existing accounts start as Real / public.
2. **Admin panel → Users** has the switch per account. Mark every account you created for testing as Demo / test.
3. The sample profiles that used to appear when the site had no professionals are gone from the live site: an empty marketplace now says so honestly and invites people to join. (Sample cards still appear only when the page runs without a database, for development.)
4. A review written from a demo account does not count towards anyone's public rating.
