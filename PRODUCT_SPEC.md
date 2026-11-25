# Cuvori — Product Specification (current direction)

This document is the source of truth. Where older code or notes conflict with it, follow this document.

Owner: not a programmer. Makes product decisions; AI handles implementation. Preserve working functionality, avoid casual redesigns of unrelated parts, explain owner steps simply.

---

## 1. What Cuvori is

A marketplace for **video editors, videographers and photographers**.
Audience: content creators, small brands/businesses, and creative professionals looking for clients. Creators can also be professionals.

Core message today: **Cuvori does not take your money.** Headline today: **Find your freelancer — Commission-Free.**
Under the new prices (section 3) the homepage drops both claims: the headline reads "Find your freelancer." and the pricing block says, under "For clients": "Free job posts. No platform fees."; under "For freelancers": "5% commission. We cover the card processing fees."; and below both: "Free to join and browse. No subscriptions. No hidden platform fees." The homepage block, the headline, the line under it, step 4, the footer and the proposal note switch by themselves when the price switch is turned on. Every other "no commission" text (How it works, its questions and its "0%" badge, which stays since clients pay 0%, Contracts, Join, Create account, Post a job, the sign-up pop-up, the note on every profile's price card, the price hint of the new-Order form, the "Payout details" note, the Order screen's payment box and notes with the card-fee line and "Cuvori fee: €0", and the late-payment line in the Order history) has its new-price version (done 1 November 2026; on the Order screen by each Order's own price plan: a proposal made under the new prices already shows them, and an Order agreed before keeps today's). The contract clauses still need theirs: a new contract version for plan 2 Orders. The site rules instead get a new version, published before the switch: both sides must have accepted it before they can agree an Order at the new prices. The page description that Google shows, and the old claims built into the page (the headline among them), change right after the switch, never before (SETUP.md, Part 20, steps 3 and 6 of "Turning the new prices on").

Keep copy simple. Don't rewrite it into corporate or AI-sounding language.

**Approved wording (owner, November 2026), under the new prices:** for clients "Free job posts. No platform fees."; for freelancers "5% commission. We cover the card processing fees."; for both "Free to join and browse. No subscriptions. No hidden platform fees." Protected payments: "Protected payments. Work with confidence."; for clients "Your money stays protected until the work is delivered."; for freelancers "The project is funded before you start." The 14-day review and the dispute protection are explained as they work (a valid delivery starts 14 days; approval pays out at once; no dispute, paid out automatically; a dispute stops the payout until Cuvori decides). Cuvori never calls itself an escrow service or a bank, and a protection claim shows only while protected payments are on. Funds segregation at Stripe is never described as working until Stripe has enabled it and it has passed testing (SETUP.md Part 22).

**Funds segregation (owner's decision, 2 November 2026): a must-do after launch.** Clients' payments are to be held apart at Stripe from Cuvori's own money (Stripe's funds segregation, SETUP.md Part 22), turned on in Part 22's order once the new prices are live and Stripe has enabled it. It is not described to clients as a legal protection or as escrow until a lawyer has said what it is; until it is on and tested, no page text may say payments are held apart.

## 2. Price first (supersedes older work-first designs)

When a client browses professionals, **price is seen first**. Card hierarchy:

1. Price
2. Pricing model (per project / hourly / daily / starting from)
3. Specializations
4. Name
5. Location
6. Work/portfolio preview

The client should know roughly what a person costs before spending time on their work. Work becomes prominent inside the profile.

Current card design (prototype): black price badge at the top of a white card ("From €35 / hour"), then name + location + availability, video preview with a counter (1 / 3), blue category tags, short bio, tools, and a **Message** button. Clicking the card opens the profile; Message opens the conversation.

## 3. Business model

**The prices (owner's final decisions, October 2026).** They take effect when the owner turns the price switch on in Supabase (`schema_v56.sql`, SETUP.md Part 20). Until then today's prices stay: no commission, and the client pays the card fee and Stripe's payout fee on top.

- **Clients pay only the agreed project price.** Posting jobs is free. Personal help with searching and matching freelancers is free. No client fee, no subscription, no hidden platform fees. Client fees may be looked at again later, after client feedback — not now.
- **Freelancers pay 5% commission on projects paid through Cuvori** (protected payments): 5% of every amount paid out to them, rounded half up to the cent on the running total. A re-payment after a won chargeback only pays back what was pulled back and keeps nothing again. A top-up pays the same 5%, nothing more. **Cuvori pays the card processing costs.**
- A project paid through Cuvori costs at least €2 (today €1; €2 comes from the earlier plan, and the owner has not decided on it yet: it must be decided before the switch). Projects paid directly between client and freelancer, outside Cuvori, pay no commission: Cuvori never holds that money. Whether direct payments stay under the new prices is not decided yet (SETUP.md Part 20).
- **Protected payments, 14 days:** the client pays before work starts; the freelancer delivers; the 14 days start with a valid delivery (a link to the work). The client approves → paid out at once. No dispute within 14 days → paid out automatically. A dispute opened before the payout stops it: Cuvori looks at the agreement, the messages, the delivered work and both sides' evidence, and decides to pay out, refund or divide, under its dispute policy. When it divides, the 5% comes out of the freelancer's share, never out of the client's refund (€100 divided 60/40: the freelancer receives €57, Cuvori keeps €3, the client gets €40 back). Nothing is paid out automatically while a dispute is open.
- Free to join and browse. No subscriptions.
- Orders agreed before the switch keep what was agreed (today's prices and 7 days). Financial records are never changed afterwards.
- Free projects (a later feature) stay separate from the payment system.

## 4. Account model

**One account.** It can hire, post jobs, message professionals, and — if authorized — create a professional profile.

- Normal users/clients register **without** an invitation.
- Creating a **professional/editor profile requires an invitation**.
- Existing users can receive an invite and unlock their professional profile.

## 5. Admin / invitations

Simple private admin area:

- Invite-only mode on/off
- Generate invitations (unique codes/links), copy them
- Invite status: pending / used / revoked; who used it; revoke unused
- View registered users; suspend/unsuspend

**Authorization enforced on the backend.** Hiding a button is not security. Never expose passwords, secrets or service keys. Keep it small.

## 6. Pages / features

Homepage, Create account, Join as an editor, How it works, Browse jobs, Post a job, Contracts, Account, Settings, Notifications, professional profiles, search/filtering, portfolio/projects, messaging, progress reports, video review.

## 7. Homepage

Headline + support line as above. Search is central (placeholder: **Search**; supports name, skill, specialty). Filter chips under the search ("Add filters:" Commercial, Documentary, Shorts / Reels / TikTok, Podcasts, Music videos, "View all filters +"). Then the price-first profile cards, a **Start your project** panel (Post a job / Browse jobs), and a dark **How it works** block with four steps and "View full guide →".

## 8. Header

Browse jobs · Post a job · How it works · Join as an editor · **Create account** (dark pill) · messages icon · notifications bell · Account · language selector.

- Browse jobs and Post a job sit together. Join as an editor sits left of Create account. Create account stays right.
- Notifications and Messages stay available on normal pages.
- Language selector: current language + two common ones as flags, plus a control that opens the full list. Never remove access to the full list.
- On small screens the nav collapses into a hamburger menu that also contains the language list.

## 9. Notifications

Bell shows new activity noticeably (glow / "!"). Used for messages, progress reports, account and job activity. A notification opens the **exact item** it refers to (e.g. the specific report), never just the homepage.

## 10. Messaging

Familiar and easy (Messenger-like usability, original visual design).

- Messages icon shows unread state.
- **Editors & clients** contact list: searchable by name; docked/persistent on desktop, overlay on small screens.
- Clicking a person opens a small chat window near the bottom; windows are draggable and remember their position.
- Profile button is **Message** (not "Contact"); it opens the conversation.
- In the chat window: message input + **Send**, and a separate **Send update** button below it (never labelled "Report" — that reads like reporting a person).

## 11. Less hassle principle

A good professional removes work from the client. Encourage efficient async communication, progress reports, self-sufficiency, sourcing licensed assets, asking only when needed. **Async first; call when a call is actually useful.** The same applies in reverse: make it easy for professionals to work with clients too.

## 12. Reports and messaging

Full reports are not dumped into chat.
Editor creates a progress report → a small clickable card appears in the chat → a notification is generated → client clicks → the report opens → client reviews → **Approve** or **Request changes**.

## 13. Video review (Frame.io-inspired workflow, original interface)

Copy the workflow, not their code, branding, icons or visual design.

Inside a report:

- Real video player with Cuvori's own controls (play/pause, time, seekable progress bar).
- **Comment markers sit directly on the progress bar.** Clicking a marker or a timestamp in the list jumps the video to that exact moment and pauses. Markers give press feedback (squish + pulse).
- Comments panel on the **right** of the video (stacked on mobile), scrollable.
- Adding a comment stamps it with the **current video time**. Pausing on a moment highlights the matching comment and shows it as a caption on the video.
- The **editor uses the same tool** before sending (optional). Their comments travel with the report. Authorship shows as the person's name / "You" — never a fixed role tag.
- Editors can load a video file into the review.
- Version history (Version 1, 2, 3…), replies, mark resolved, Approve / Request changes.

Later: time-range comments, drawing/pinning on a frame, side-by-side version comparison. Build the basics first.

## 14. Request changes

Approve or Request changes. Request changes opens one free-text field ("What would you like changed?"). No questionnaires or categories. Timestamp comments carry the detail; this field is the optional summary.

## 15. Reputation (later)

Reward professionals who are easy to work with: quality, communication, delivery, ease of working together.

## 16. Discovery / search

Filters: languages (multiple, flexible), location (searchable), specializations (multiple), skills (free-text, written by the professional). "View all filters" exposes everything. "Other" appears at the end where useful.

## 17. Specialization wording

Use: **Shorts / Reels / TikTok**, **Podcasts**, **Music videos**. Avoid "Short form", "Interviews", "Music". Multiple specializations allowed.

## 18. Professional profile / portfolio

Once opened, the portfolio is the focus. Projects are media-first: video, optional thumbnail, search tags (tags are internal, not shown on the public card). No mandatory project titles/descriptions.

## 19. Video gallery

Clicking a video opens a larger viewer. Arrows move only within that professional's videos: first video → Next only; middle → both; last → Previous only; no looping. Swipe on touch.

## 20. Video + thumbnail carousels

One wide video row, a thumbnail row beneath; a thumbnail can be linked to a video so they move together. Professionals can add, delete and reorder projects (first/last, up/down). Keep it simple.

## 21. Professional onboarding

Two parts: Profile (bio, country, languages, skills, photo) and Projects/Portfolio. Remember: browse shows price before work.

## 22. Create account

Simple language. CTA: **Start your project**. Google/Facebook sign-in available. No invite needed for a normal account; the invite matters when unlocking a professional profile.

## 23. Jobs

Browse jobs (placeholder: **Search for a job**). Post a job (client function). Both already exist in the prototype — preserve, don't rebuild.

## 24. How it works page

Client side and Editor side, shown side by side with Clients / Editors controls. Key line: **One account lets you hire creative professionals or offer your own services.** Four homepage steps; step 4 is Contracts. No redundant bottom buttons.

## 25. Contracts

Before work starts: scope, price, pricing method (hourly / project), timeframe, deliverables, revisions. Cuvori provides a simple template/workflow. Prices as in section 3.

## 26. Settings / account

Settings: change password, messaging settings, language, help & support — collapsible sections. Account area to be audited later (profile editing, password, email, logout, deletion, privacy, professional-profile status).

## 27. Languages

English, German, Russian, Lithuanian, Spanish, Polish, Ukrainian. `index.html` contains the full translation tables. Test localization carefully.

**Lithuanian:** use *editorius* (or *videografas*), never *montuotojas*. Preserve ė, ų, š, ž etc.

## 28. Design

Modern, clean, simple, light theme. White cards, light grey background, dark text, blue accent (#1a7ae0), dark blocks for price badges and the How-it-works section. The Windows 7 direction is abandoned. Less hassle = better; before adding complexity, ask whether it makes the client's or professional's job easier.

## 29. Mobile / responsive

Must work on desktop, tablet and mobile. Nothing may depend on hover to be visible or clickable. Messaging, filters, portfolios, cards and admin must be checked responsively.

## 30. Security (before public launch)

- Users cannot edit or read another user's private data
- Messaging private to participants
- Admin and invite generation backend-authorized
- Database rules enforced server-side, not frontend-only
- Upload permissions correct
- No secrets in the UI; error states don't leak data

## 31. Launch approach

**Client-first (owner, November 2026).** Cuvori first attracts clients and genuine job posts. Cuvori then personally searches for suitable freelancers for those jobs and invites them (professional profiles stay invite-only). This sourcing help is free for the client. Quality over user counts; grow gradually. Don't keep adding features forever before users see it.

## 32. Differentiation

Clear prices (under the new prices of section 3: clients pay no fees, and freelancers a small, clear 5% on projects paid through Cuvori, card costs covered; today no commission at all), good search, strong portfolios, direct communication, jobs, easy workflow, progress reports, video review, less hassle, simple contracts, later reputation. Not "another Fiverr".

## 33. Later (not before launch)

Forum/community. AI-assisted editing alongside human professionals. Native mobile apps (React Native/Expo) sharing the same backend — no separate ecosystem for accounts, messages, jobs, profiles, notifications, reports.

## 34. Technical plan

GitHub (a public repository: everything in it can be read by anyone) → GitHub Pages for the page (cuvori.io) and Netlify for the payment functions → Supabase (database, auth, storage, realtime). Own the code, keep it portable. The first plan (Vercel, Next.js and the build order in `README.md`) was not followed: the site is one page, `index.html`. The video-review system is built on the real backend, not in a temporary builder.

## 35. How AI should work here

See `CLAUDE.md`.
