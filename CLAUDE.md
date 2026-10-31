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

## When the owner reviews code

The owner reviews the code by pasting lines into the chat. This applies every time, to every line pasted, without being reminded:

- **Check every line properly, and everything it touches:** the functions it calls, the database, the page, the tests and every other copy of the same rule. Never answer from an earlier check of the same lines, and never stop at the first thing found.
- **Prove it where you can** with a test or a live check, and say plainly when something was only read, not tested. If an earlier answer turns out to be wrong, say so.
- **"check it", or lines pasted with no words, means report only.** Change nothing. Only "fix it" changes code.
- **On "fix it":** write a test, show it failing on the code that is on GitHub now, make the fix, run every test suite, then upload through the GitHub upload page (the owner clicks Commit changes; while an update waits on its own branch, such as `pricing-v2`, its files go to that branch, not `main`; an urgent fix to the live site goes to `main`, and the same change to the waiting branch too) and confirm each file arrived exactly as tested.
- **Every report starts with a "Checked this time" list:** each place the pasted lines are used, by file and line, and next to each one "tested" or "read", all done in this answer. A place that is not on the list was not checked, so the owner can see a skip before trusting the answer. Never leave the list out, never shorten it to "all callers", and never fill it from an earlier check.
- **Then report in plain words:** what is right, then each problem with what it means for a client, a freelancer or the owner, and one clear recommendation.

## Product rules that override everything else

- **Prices (final, owner's decision; `PRODUCT_SPEC.md` section 3).** Clients pay only the agreed price: free job posts, free matching help, no client fee, no subscription, no hidden fees. Freelancers pay 5% commission on projects paid through Cuvori (top-ups included); Cuvori pays the card costs. Projects paid directly between client and freelancer pay none, as Cuvori never holds that money; whether direct payments stay under the new prices is not decided yet (SETUP.md Part 20). Protected payments are paid out at once when the client approves, or 14 days after a valid delivery unless disputed; during a dispute nothing is paid out automatically; when Cuvori divides the money in a dispute, the 5% comes out of the freelancer's share, never out of the client's refund. These take effect only with the price switch (schema v56); until then today's prices (no commission, 7 days) apply, and Orders agreed before the switch keep them for good. Three rules start as soon as v56 runs (SETUP.md Part 20): nothing is paid out for a part of an Order while it is in dispute (or no longer being worked on) or a chargeback is open, though Cuvori's own decision on a dispute still goes through; a payment line's Order, kind, amounts, status and Stripe reference can never be changed (Stripe's fee and the card-fee refund are still added, as today); and an Order agreed after v56 can never be set back to a proposal. Never add fees, surcharges or subscriptions, and never disguise card costs, without asking Egidijus.
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

`cuvori-index.html`, the clickable prototype the design came from (light theme, price-first cards, messaging windows, report → review flow, custom video player with comment markers), grew into the real site, `index.html`; an old copy is only inside `cuvori-repo-files.zip` (do not unzip it into the repository: it also holds old copies of README.md, CLAUDE.md and PRODUCT_SPEC.md with the old prices). Build on the design that is there rather than redesigning from scratch. The 7-language texts are in `index.html` (`const T = {...}` and the other `T_…` tables merged into it): reuse those strings.

That old copy has **no backend**: its invite check, accounts, jobs, contracts and notifications are demo-only. Do not mistake them for the real site's working systems.

## Build order

`README.md` has the original build order (the site was then built as one page, `index.html`, not as planned there). What still holds: do not start the Frame.io-style review system until accounts, invites/admin and messaging exist on the real backend.

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
