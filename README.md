# Cuvori

**Marketplace for video editors, videographers and photographers — commission-free today (new prices: `PRODUCT_SPEC.md` section 3).**
Domain: `cuvori.io`

Core message today: **Cuvori does not take your money.** (dropped under the new prices, when Cuvori keeps 5% of what freelancers are paid through Cuvori)
Homepage headline today: **Find your freelancer — Commission-Free.** (under the new prices: "Find your freelancer.")

Audience: content creators, YouTubers, small brands and businesses — and the creative professionals who work for them. Creators can also be editors.

---

## Current status

This repository holds the real site: `index.html` (served at cuvori.io by GitHub Pages), its Supabase database scripts (`supabase/`) and the payment functions on Netlify (`netlify/`); `SETUP.md` explains how they run. The clickable prototype `cuvori-index.html` the design came from grew into `index.html`; an old copy is only inside `cuvori-repo-files.zip` (do not unzip it into the repository: it also holds old copies of these notes with the old prices). The stack and build order below are the original plan; the site was built as one page instead.

## Planned stack

| Layer | Choice | Why |
|---|---|---|
| Source code | GitHub (this repo, public: anyone can read it) | Own the code, keep it portable |
| Web hosting | Vercel | Deploys automatically from this repo; will serve cuvori.io |
| Backend | Supabase | Database, login/accounts, file storage (video), realtime messaging — all in one, free to start |
| Web app | Next.js (React) | Standard, well supported, works well with Vercel and Supabase; a future mobile app (React Native / Expo) can share the same backend |

Prices: see `PRODUCT_SPEC.md` section 3. Today Cuvori takes **0% commission**. The owner's final decision, live once the price switch is turned on (schema v56): clients pay only the agreed price (free job posts, no platform fees), freelancers pay 5% commission on projects paid through Cuvori (projects paid directly pay none, as Cuvori never holds that money; whether they stay is not decided yet), and Cuvori pays the card costs.

## Build order

Build in this order. Each step should be working and deployed before the next begins.

1. **Project skeleton** — Next.js app in this repo, deployed to Vercel, connected to Supabase.
2. **Accounts & login** — one Cuvori account type. Anyone can register (email, plus Google/Facebook sign-in). Everything below depends on this.
3. **Invites & admin** — professional (editor) profiles are invite-only. Small private admin area: invite-only mode on/off, generate/copy/revoke invite codes, see who used them, view/suspend users. **Authorization enforced on the backend.**
4. **Professional profiles & browse** — price-first cards, search and filters (languages, location, specializations, custom skills), portfolio/projects (media first, tags for search).
5. **Messaging** — Editors & clients contact list, movable chat windows, "Message" button on profiles, unread indicators.
6. **Jobs** — Post a job / Browse jobs, backed by real data.
7. **Progress reports & video review** — editor sends a report → chat card + notification → client opens it → video player with timestamped comments, timeline markers, replies, resolve, version history, Approve / Request changes (simple free-text).
8. **Notifications** — open the exact item they refer to.
9. **Contracts** — simple agreement template (scope, price, pricing method, timeline, deliverables, revisions).
10. **Security review before public launch** — see `PRODUCT_SPEC.md` section 30.

Later, not before launch: reputation/reviews, forum, AI features, native mobile apps.

## Launch approach

Seed the professional side first (roughly 10–20 good editors), then bring clients, then grow both sides gradually. The first goal is quality supply, not user counts.

## Documents

- `PRODUCT_SPEC.md` — the full product handoff. **Where older code or notes conflict with it, the spec wins.**
- `CLAUDE.md` — working rules for AI tools (Claude Code etc.) building in this repo.
