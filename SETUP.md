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

Open `cuvori-index.html` and find this line near the bottom (search for `CUVORI_CONFIG`):

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
