# Working on Cuvori — rules for AI assistants

Read `PRODUCT_SPEC.md` before doing anything. It is the source of truth. Where old code, comments or notes conflict with it, follow the spec.

## Who you are working with

The owner is **not a programmer**. They make the product decisions; you handle the technical implementation.

- Explain anything they must do themselves as exact, practical steps: what to click, what to type, and why.
- Do not assume they understand Git commands, React internals, database syntax, terminal errors or API architecture.
- Do not overwhelm with theory when a practical instruction will do.
- Never lower backend security because the owner cannot code.

## How to work in this repo

Before changing existing code:

1. Inspect what already exists.
2. Understand the relevant flow.
3. Preserve working functionality.
4. Do not rebuild features just because they were not mentioned in the immediate prompt.
5. Do not silently remove functionality.
6. Prefer small, reversible changes.
7. Keep Git commits understandable.
8. Check desktop **and** mobile implications.
9. Test the feature after modifying it.
10. Tell the owner clearly what changed.

Do not casually redesign unrelated parts of the product. Do not rewrite simple Cuvori copy into corporate or AI-sounding language — simple wording is preferred.

## Product rules that override everything else

- **0% commission.** Cuvori never takes a percentage of what a professional earns.
- **Price first.** When browsing professionals, the card shows price before anything else: price → pricing model → specializations → name → location → work preview. Never revert to a work-first card.
- **One account.** There are no separate client and editor accounts. One account can hire, post jobs, message, and (if invited) offer services.
- **Invites are for professional profiles only.** Normal accounts register freely. Creating a professional/editor profile requires an invitation. Never require an invite just to use Cuvori as a client.
- **Admin is backend-authorized.** Hiding a button is not security. Invite generation is admin-only, enforced server-side. Never expose passwords, secrets or service keys in any interface.
- **"Message", not "Contact"** is the profile button.
- **Less hassle = better.** Async progress reports first; calls only when actually useful. Request Changes is a simple free-text field, never a questionnaire.
- **Specialization wording:** "Shorts / Reels / TikTok", "Podcasts", "Music videos". Not "Short form", "Interviews", "Music".
- **Lithuanian:** use *editorius* (or *videografas* where appropriate), never *montuotojas*. Preserve correct characters (ė, ų, š, ž…).
- **Design:** modern, clean, simple. The old Windows 7 nostalgia direction is dead — do not revive it.
- **Languages:** English, German, Russian, Lithuanian, Spanish, Polish, Ukrainian. Test localization carefully.
- **Video review:** inspired by Frame.io's *workflow* only. Do not copy their code, branding, icons, or visual design.

## The prototype

`cuvori-index.html` is the clickable design reference (light theme, price-first cards, messaging windows, report → review flow, custom video player with comment markers). Port its UI and interactions into the real app rather than redesigning from scratch. It contains a complete 7-language translation table (`const T = {...}`) — reuse those strings.

The prototype has **no backend**. Its invite check, accounts, jobs, contracts and notifications are demo-only. Do not mistake them for working systems.

## Build order

Follow the order in `README.md`. Do not start the Frame.io-style review system until accounts, invites/admin and messaging exist on the real backend.

## Security checklist (before any public launch)

- Users cannot read or edit another user's private data.
- Messaging is private to its participants.
- Admin routes and invite generation are authorized on the backend.
- Database access rules are enforced server-side (e.g. Supabase Row Level Security), not only in the frontend.
- Uploaded media has correct permissions.
- Error messages never leak secrets or private data.

## Reviews — decisions that are settled

Do not change any of these without asking Egidijus first:

- One overall rating, 1 to 5 stars. No sub-scores for quality, communication, delivery or anything else.
- Reviews are two-sided and belong to a completed Order. One per side per Order, never about yourself, never from someone who was not on the Order.
- Blind: a review is shown when both sides have written one, or when the review window ends. The window is the `review_window_days` setting, never a number in the code.
- 1-3 stars require a reason and a written explanation; 4-5 stars require nothing written.
- Both clients and freelancers build reputations, and the public number stays simple: `4.8 ★ · 37 reviews`.
- Reviews are never bought, boosted or invented, and the "Verified Cuvori Order" badge is only ever earned by a real Order.
- Moderation hides, it never rewrites: the text a person wrote is kept even when the review is hidden.
