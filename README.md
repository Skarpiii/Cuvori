# Cuvori

**Commission-free marketplace for video editors, videographers and photographers.**
Domain: `cuvori.io`

Core message: **Cuvori does not take your money.**
Homepage headline: **Find Your Editor, Videographer, Photographer — Commission-Free.**

Audience: content creators, YouTubers, small brands and businesses — and the creative professionals who work for them. Creators can also be editors.

---

## Current status

This repository currently contains a **clickable prototype**, not the real application.

- `cuvori-index.html` — a single self-contained web page. Open it in any browser. It shows the intended design and every interaction (search, filters, 7 languages, messaging windows, progress reports, the video-review player with timestamped comments).
- It runs on **demo data only**. There are no real accounts, nothing is saved, and the invite check accepts any code. It is the **design reference** for the real build, not a backend.

## Planned stack

| Layer | Choice | Why |
|---|---|---|
| Source code | GitHub (this repo, private) | Own the code, keep it portable |
| Web hosting | Vercel | Deploys automatically from this repo; will serve cuvori.io |
| Backend | Supabase | Database, login/accounts, file storage (video), realtime messaging — all in one, free to start |
| Web app | Next.js (React) | Standard, well supported, works well with Vercel and Supabase; a future mobile app (React Native / Expo) can share the same backend |

Cuvori itself takes **0% commission**. Payment processing, if added later, goes through a third-party provider — Cuvori still takes nothing.

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
10. **Security review before public launch** — see `PRODUCT_SPEC.md` section 32.

Later, not before launch: reputation/reviews, forum, AI features, native mobile apps.

## Launch approach

Seed the professional side first (roughly 10–20 good editors), then bring clients, then grow both sides gradually. The first goal is quality supply, not user counts.

## Documents

- `PRODUCT_SPEC.md` — the full product handoff. **Where older code or notes conflict with it, the spec wins.**
- `CLAUDE.md` — working rules for AI tools (Claude Code etc.) building in this repo.
