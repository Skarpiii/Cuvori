# Cuvori — turning on real accounts

Follow these steps once. About 20 minutes. Nothing here needs coding.

## Part 1 — Create the backend (Supabase)

1. Go to https://supabase.com and click **Start your project**. Sign up (GitHub login is easiest).
2. Click **New project**. Name: `Cuvori`. Choose a strong database password (save it somewhere, you will rarely need it). Region: **Frankfurt** (closest to Schwabach). Click **Create new project** and wait about a minute.
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
6. **If the page itself lives on GitHub Pages (cuvori.io does today)**, the payment functions still need Netlify. Deploy the repository to Netlify as above (only the functions matter there), then add one value to `window.CUVORI_CONFIG` in `index.html`: `functionsUrl: "https://<your-site>.netlify.app"`. The page calls the functions there; they accept calls from `https://cuvori.io` (see `ALLOWED_ORIGINS` in `netlify/lib/cuvori.mjs` to add another address).

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

Money never touches Cuvori's bank account directly: Stripe holds it in Cuvori's Stripe balance until the client approves, Cuvori decides a dispute, or 7 days pass after delivery. Until this part is done the site uses **direct payments** (the client pays the freelancer's IBAN/PayPal and both confirm in the Order, which says plainly that nothing is secured).

1. Create a Stripe account at https://stripe.com (country: Germany; individual is fine to start). Finish the identity and bank checks Stripe asks for.
2. Stripe dashboard → **Settings → Connect** → get started → choose **Express** accounts. Also set the platform name/branding ("Cuvori").
3. Stripe → **Developers → API keys**: copy the **Secret key** (starts with `sk_test_` in test mode, `sk_live_` later).
4. Stripe → **Developers → Webhooks → Add endpoint**: URL `https://cuvori.netlify.app/.netlify/functions/stripe-webhook`, events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `account.updated`, `charge.refunded`, `charge.dispute.created`. Copy the **Signing secret** (`whsec_...`). If Stripe puts `account.updated` on a separate "Connected accounts" endpoint, give that endpoint the same URL and add its signing secret as `STRIPE_CONNECT_WEBHOOK_SECRET`.
5. Supabase → **Project Settings → API**: copy the **service_role** key (secret! never put it in the page).
6. Netlify → site → **Site configuration → Environment variables** → add:
   - `STRIPE_SECRET_KEY` = sk_…
   - `STRIPE_WEBHOOK_SECRET` = whsec_…
   - `SUPABASE_SERVICE_ROLE_KEY` = the service_role key
   - optional: `ALLOWED_ORIGINS` (comma-separated page addresses allowed to call the functions; defaults to the site URL plus https://cuvori.io)
   There is no fee setting here any more: the processing cost comes from the **fee_schedules** table (Admin panel → Payment costs), see Part 13.
   Then **Deploys → Trigger deploy**. From now on new Orders are "Protected payment".
7. Run `supabase/schema_v5.sql` … `schema_v9.sql` in the Supabase SQL editor, in order (already done for the live database).
8. Test in Stripe **test mode**: freelancer → Settings → Payout details → "Set up payouts with Stripe" (use Stripe's test data); client → Order → Fund → card `4242 4242 4242 4242`, any future date, any CVC.
9. Go live: switch the two Stripe keys to live keys in Netlify and trigger a deploy.

How the money flows: client funds the Order price + the provider's processing cost → held → freelancer "Deliver for approval" (or submits a milestone) → client "Approve work & release €X" (or 7-day auto-release) → Stripe pays the freelancer's bank. Milestones are released one by one from the same funded amount. Disputes (either side) stop the clock; you decide in Admin panel → Orders & disputes: release, refund or split of what is still held.

## Part 6 — Security checks (keep these working)

The database rules were attacked from every side (visitor, client, editor, banned user, admin) and hardened in `supabase/schema_v9.sql` and `schema_v10.sql`.

1. Run `supabase/schema_v9.sql` in the Supabase SQL editor, then `supabase/check_v9.sql` (it lists existing rows that break the new limits; they keep working but must be fixed before they can be saved again).
2. Run `supabase/schema_v10.sql` **only after the new page is live** (it hides other people's e-mails; the old page would lose its sign-in role). Then run `supabase/schema_v11.sql` (contract templates: types, governing law, clauses, counter-proposals).
3. The page has a Content-Security-Policy that allows only its own scripts, by fingerprint. **After any change to `index.html` run `python3 tools/csp.py index.html`**, otherwise the page will not start.
4. The standard terms every Order carries live in `contracts-i18n/*.js` (English is the source; the others are translations) and are merged into `index.html` — edit them there and re-merge, never edit the page by hand. **Never change the wording of a clause that people have already accepted.** Accepted Orders store their own copy of the text (`contracts.terms_doc`), so old Orders keep what was agreed, but for new wording bump `clauses_version` in `schema_v11.sql` and keep the old file for reference.
5. Two numbers must stay equal or Orders will say something the system does not do: `AUTO_RELEASE_DAYS` in Netlify, `auto_days` on the contracts table, and the `7 days` inside `order_action()` / `order_milestone_action()`.
6. The full test kit is stored as `tests/test-kit.tar.gz` (unpack it in the repo folder with `tar xzf tests/test-kit.tar.gz`). Then `tests/run-all.sh` runs every check: 248 database attacks, payment-function attacks, stored-XSS proofs, the browser policy test, the UI fuzz test (7 languages × 4 screen widths) and all site flows.

## Part 7 — Open questions for the contract templates (business decisions)

The clause texts were reviewed adversarially (how each clause could be abused, and where it may not hold up in EU / German law) and fixed where wording alone could fix it. Four things need a decision from you, not from code:

1. **Holding other people's money.** Protected payments land in Cuvori's own Stripe balance before being paid out. Depending on how this grows, that can count as handling third-party funds and may need a payment-institution licence or an agent-of-payee arrangement. Ask Stripe (and, once there is revenue, an accountant) before switching escrow on for real money.
2. **The processing cost.** The client pays the payment provider's processing cost on top of the Order price, shown as an exact amount before paying (Part 13). Check the numbers against your Stripe pricing, decide who carries it for European consumers (a lawyer should confirm what is allowed; the table can make Cuvori absorb it), and never describe Cuvori as "no fees" in marketing — say "no commission".
3. **Cuvori's decision in a dispute.** With protected payments, both sides accept that Cuvori distributes the held money, while keeping the right to go to court afterwards. With direct payments Cuvori can only give a written opinion. Keep that difference visible — promising more than that in marketing would be a promise you cannot keep.
4. **A lawyer's read.** The templates are careful but they are not legal advice. Before serious volume, have a German lawyer look at the German and English versions (and a Lithuanian one at the Lithuanian version if most of your professionals are there), in particular the transfer of copyright, the consumer withdrawal clause and the dispute clause.

## Part 8 — The site rules, the privacy notice and the report route

Everyone who creates an account now has to tick a box agreeing to the rules and the privacy notice, and the version they agreed to is recorded against their account. Existing users are asked again whenever the version changes.

1. Run `supabase/schema_v12.sql` in the Supabase SQL editor. It adds the acceptance record, the `reports` table (with the admin queue), the requirement that a ban always carries a written reason, the "verified client" badge that only appears when a real contract backs the review, and a `purge_old_records()` cleanup for the 24-month retention the privacy notice promises.
2. **`window.CUVORI_LEGAL`** near the top of `index.html` holds the name that runs Cuvori, the address and a working e-mail. These three values appear in the rules, the privacy notice and the footer, and German law (§ 5 DDG, the *Impressum* rule) requires them to be real and easy to find. The address is set to Dr.-Haas-Straße 1A, 91126 Schwabach. Until there is a registered company, `company` must be your own full name (e.g. `"Egidijus Surname (Cuvori)"`) — a trade name alone is not enough for a sole trader. The rules say German law applies, that Cuvori does not take part in consumer arbitration (the standard § 36 VSBG statement, allowed for a business with 10 or fewer staff — change it if you ever choose to take part), and the privacy notice names the Bavarian data-protection authority (BayLDA). The old EU online-dispute platform is not mentioned because it closed in July 2025.
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

## Part 13 — The Order is the contract

There is no separate contract to draft, download or sign. In a chat either side presses **Order** and fills in the title, profession, scope of work, deliverables, deadline, revision rounds, the two sides' responsibilities, rights to the work and the price — optionally split into milestones. Once client and freelancer have accepted the same version, that Order is their agreement; the standard terms (cancellation, refunds, rights, disputes, law) are attached to every Order and shown before accepting. A printable copy exists, but it is a copy of the accepted Order, not a second agreement.

1. Run `supabase/schema_v18.sql` in the Supabase SQL editor (after v17). It adds the structured fields and explicit acceptance to the `contracts` table (the table keeps its old name; every row is an Order), plus `order_milestones`, `order_amendments`, `order_events` (append-only history — nothing there can be edited or deleted, not even by an admin), `order_payments` (the money ledger: every funding, release and refund) and `fee_schedules`.
2. **Acceptance.** Whoever creates or edits an Order has accepted that version; the other side presses **Accept Order**. Any edit before acceptance makes a new version and wipes the other side's acceptance. After acceptance nothing is silently editable: changes go through an **amendment** (extra money, new deadline, added scope or deliverables, extra revision rounds, a new milestone) that both sides accept; the original stays in the history. If an amendment adds money to a funded Order, the client is asked to fund the extra amount.
3. **Money.** Before funding, the client sees four lines: Order price, payment processing, Cuvori fee (€0) and the total. The processing cost is computed by `order_quote()` from the `fee_schedules` table — grossed up so the freelancer receives exactly the Order price — never from a number in the code. Rows can be per region (EEA / non-EEA / any), country, consumer or business, and payment method; the most specific active row wins. Setting a row's payer to **platform** makes Cuvori absorb the cost (the client pays exactly the price) — a lawyer should tell you which is allowed for European consumers before real money moves. Admin panel → **Payment costs** edits the table and shows a worked example. The freelancer's amount, the processing cost, the secured balance, releases and refunds are always kept apart.
4. **Milestones.** The client funds the whole amount up front; each milestone is submitted by the freelancer and approved with **Approve milestone & release €X**; the rest stays secured. A submitted milestone the client ignores is released automatically after the review window, like a whole delivery.
5. **Reports.** A progress report can be the delivery: the freelancer ticks "this is the delivery" (or picks the milestone it delivers). The client opens it from the chat or the bell and sees **Approve & release €X** or **Request changes** — a button that moves money always says so. Requesting changes through the report counts a revision round on the Order and stops the release clock inside the paid rounds.
6. **Cancellation and disputes.** Before funding either side can cancel. After funding the freelancer can cancel and refund everything still held; the client's route is a dispute, which stops every automatic release until you decide in Admin panel → Orders & disputes (release, refund or split of what is still held — money already released for approved milestones stays released). Card chargebacks and refunds made outside Cuvori also put the Order into dispute.
7. **Where things are.** Orders page: `#orders` (the old `#contracts` address still works). Code: `orders-ui.js` (screens), `orders-i18n.js` (7 languages), `netlify/functions/stripe-*.mjs` (`stripe-cancel.mjs` is new; `stripe-release.mjs` takes a `milestone_id`), `supabase/schema_v18.sql`. Tests: `tests/db/30_attacks.sql` (v18 section runs the fixed-price, milestone and direct flows end to end), `realtest.js` (every scenario from the brief in the browser), `tests/xss/proof5.js`, `tests/attack-functions.mjs`.

## Part 14 — Sign in with Google or Facebook

Visitors who press **Message** or **Request quote** on a profile see one pop-up: continue with Google, continue with Facebook, or sign up with e-mail. The buttons already call Supabase; they work the moment the providers are switched on there. Until then a click says “Google sign-in is not switched on yet — please use e-mail”.

1. Run `supabase/schema_v19.sql` (after v18): accounts created by Google/Facebook get their first name from what the provider sends.
2. **Google.** Google Cloud Console → APIs & Services → OAuth consent screen (External, app name Cuvori, your e-mail) → Credentials → **Create credentials → OAuth client ID → Web application**. Authorised JavaScript origins: `https://cuvori.io`. Authorised redirect URI: `https://tnxujwlfatcvxzevllfr.supabase.co/auth/v1/callback`. Copy the client ID and secret.
3. **Facebook.** developers.facebook.com → My Apps → Create app (Consumer) → add **Facebook Login** → Settings → Valid OAuth redirect URIs: the same Supabase callback address. Copy the App ID and App secret. The app has to be switched to Live mode (Meta may ask for a privacy-policy link: `https://cuvori.io/#privacy`).
4. Supabase → **Authentication → Providers** → Google: paste client ID + secret, enable. Facebook: paste App ID + secret, enable. Then **Authentication → URL configuration**: Site URL `https://cuvori.io`, add `https://cuvori.io/*` to the redirect list.
5. New accounts made this way are clients; they are asked to agree to the rules on first sign-in, like everyone else. Nothing else changes: an invite still turns an account into a professional.

## Part 15 — Switching protected payments on (checklist)

Everything in the code is ready and tested; what is left needs your accounts and keys, which nobody else should touch. In this order:

1. **Stripe account** (stripe.com, country Germany, individual is fine). Finish identity and bank checks. Settings → Connect → get started → **Express**. Developers → API keys: copy the **secret key** (`sk_test_…` while testing).
2. **Netlify site** for the payment functions (Part 3; the page can stay on GitHub Pages). Site configuration → Environment variables: `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (Supabase → Project settings → API), `SITE_URL` = `https://cuvori.io`. Trigger a deploy.
3. **Webhook.** Stripe → Developers → Webhooks → Add endpoint: `https://<your-site>.netlify.app/.netlify/functions/stripe-webhook`, events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `account.updated`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`. Copy the signing secret into Netlify as `STRIPE_WEBHOOK_SECRET`; deploy again. (If you later add a separate *Connect* webhook endpoint for `account.updated`, its secret goes in `STRIPE_CONNECT_WEBHOOK_SECRET`.)
4. **Point the page at the functions:** in `index.html`, `window.CUVORI_CONFIG` gets `functionsUrl: "https://<your-site>.netlify.app"`. Admin panel → Payment costs then shows “Protected payments: ON”.
5. **Test in test mode**: a professional connects Stripe in Settings → Payout details (Stripe's test data), a client funds an Order with card 4242 4242 4242 4242, delivers, approves — watch the transfer in the Stripe dashboard. Then swap the two Stripe keys for live ones and deploy once more.
6. Before real money: a lawyer's word on Part 7, items 1 and 2 (holding funds; who carries the processing cost for EU consumers).


## Part 16 — Jobs a freelancer can trust (schema v20)

Run `supabase/schema_v20.sql` in the SQL editor (after v19). What it adds, in plain words:

- **Every job has a state**: active, filled, closed, expired, under review, removed. Active jobs expire after 30 days unless the owner renews them (the number is a setting, see below). The feed only ever shows active jobs; the owner sees all of theirs under **My jobs** on the Browse jobs page, with the reason whenever Cuvori stepped in and an “Ask for a review” button.
- **The card shows facts, not a score**: when it was posted, whether the client's identity is verified, whether the payment is secured (only when a protected-payment Order tied to the job was really funded by Stripe), how many hires the client has and their hire rate — or simply “New client”, which is not a warning. Freelancers can sort (newest, budget, deadline) and filter (identity verified only, payment secured only, posted within 24 h / 7 / 30 days).
- **Report job** on every job: one of seven reasons and an optional note. One report is a signal; three independent reporters move the job up your queue. Nobody is ever banned by a rule alone.
- **Limits that do not punish good clients**: a new client can post 3 jobs a day and keep 3 active; a verified one 10 a day and 15 active; the same job again within 7 days is refused with a plain sentence (“edit or renew that one instead”). All numbers are in Admin panel → Job review → Posting rules, including a switch to require identity verification before posting (off by default).
- **Risk check on the text**: fees before work, “write me on Telegram”, gift cards, passport copies, shortened links and the like add up to a score you never show anyone. At 5 or more the job is held for your review before it goes live and the owner is told so. A normal link (Drive, YouTube, a website) is never a problem; a shortener is only flagged.
- **Your review queue** (Admin panel → Job review): each job with why it was flagged, the client's history and verification, the reports and who sent them, and the actions taken before. Approve, false positive, hide, unhide, remove, warn (a message in their inbox) and suspend — every action lands in an append-only log with your reason. You can also mark a client verified after seeing proof (a video call with an ID); the note stays in the log.
- **Identity verification is provider-based**: a client is “verified” when Stripe has checked them (payouts enabled after Connect onboarding) or when a provider such as Stripe Identity says so — the table only keeps the state and the provider's reference, never a document. Stripe Identity itself is not wired yet; when you want it, it is one Netlify function that starts a verification session and one webhook event (`identity.verification_session.verified`) that writes `verified` into `identity_verifications`.
- **Paid posting later, no rewrite**: `posting_plans` holds free / limited / one-off / monthly plans and every profile points at one (`free` today). A plan can cap total posts or active posts; nothing in it can buy ranking.
- The hourly Netlify function (`stripe-auto-release`) also expires stale jobs. Without Netlify, expired jobs still never show in the feed (the read rule checks the date); only the stored state stays “open” until the sweep runs.

## Part 17 — When money goes wrong (schema v21): what Cuvori does on its own

Run `supabase/schema_v21.sql` after v20. The payment functions were rebuilt so that the awkward cases are handled without anyone touching the database:

- **The webhook never arrives** (Stripe gave up, a typo in the secret, Netlify was down): when the client comes back from the Stripe page, the site asks `stripe-confirm`, which looks the payment up at Stripe itself and funds the Order exactly as the webhook would. A paid Order can no longer sit unfunded.
- **The card money has not settled yet** when the client approves (banks take days): a release tied to its own card payment is allowed by Stripe straight away, so the normal case is instant. An Order paid in several parts (a top-up after an amendment) is paid from the balance instead; if that balance is still settling, the client sees “the payment provider is still settling… Cuvori retries every hour” and the hourly job finishes it. Nothing is stuck, nothing is paid twice.
- **The freelancer's Stripe account is not ready** (or closed) when money should go out: the release waits, the hourly job retries, and you can turn a release that has no transfer yet into a refund from Admin panel → Orders & disputes.
- **Retries never pay twice.** Every transfer, refund and reversal first looks at Stripe for one that already exists, and uses an idempotency key that is kept while the outcome is unknown and replaced after a definite failure (Stripe would otherwise replay the failure for 24 hours).
- **Top-ups** (an amendment made the Order more expensive): each payment is remembered with its card charge; refunds go back to the payments they came from, newest first; a top-up paid after the price grew again is kept and the rest is asked for, not refunded.
- **Chargebacks** (the client asks their bank for the money back). While the money is still held: the Order becomes a dispute, nothing can move, you answer the chargeback in the Stripe dashboard with the Order history, the delivery and the chat; if the bank sides with Cuvori the dispute goes back to you to decide, if it sides with the client the Order ends as refunded by the bank. After the money was already released: Cuvori pulls it back from the freelancer's Stripe account so the chargeback is covered; won → the freelancer is paid again; lost → the Order is marked refunded and the client is flagged. If the freelancer's account cannot give it back, the Order is marked “needs a hand” for you.
- **Two Checkout pages open** (two tabs, an old link): opening a new one retires the old one; if both were somehow paid, the second payment is refunded automatically, fee included.
- **A refund made in the Stripe dashboard** is mirrored into the Order (full refund → refunded; partial → dispute for you to decide).
- **The freelancer is paid, but the bank is slow**: after a release the money is in their Stripe account; Stripe pays it out to their bank on its own schedule — a few days, up to 7 for a brand-new account. The Order page tells both sides so.

Everything on the list is covered by `tests/attack-money.mjs` (60 checks against a fake Stripe that enforces Stripe's real rules) and `tests/attack-functions.mjs`.
