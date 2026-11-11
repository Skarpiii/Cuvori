// Check of 7 November, the database's part (schema v56): regression checks for what the full payment review proved.
// D1 the evidence (admin_order_evidence: the agreed text, the work, the history and the two sides' chat) stayed readable for
//    good once a dispute had ever been opened or a chargeback recorded: an admin could read what the two people wrote months
//    after Cuvori had decided. Now only while there is something to decide: a dispute or a decision under way, a chargeback
//    the bank has not decided (also a second one noted on the Order), or the bank's inquiry; never for a freelancer's own
//    cancel that stopped, which nobody disputed. The page's Evidence button follows the same rule.
// D2 the admin log can never be emptied, and it kept copies of what people wrote and who they are: deleting an account
//    copied its chat messages word for word and its e-mail address into the log for good; an admin's own private chats were
//    copied too, and so was every time an admin was seen online. Now a chat message's text and attachment are never written
//    (a short fingerprint shows a change), a deleted message, profile or conversation is written by its ids, and an admin's
//    "seen online" is not an admin change. What an admin does to someone else (a ban, a message to them) is still written.
//    D2b (the re-check of these fixes): deleting an account that keeps a completed Order still copied its reviews, its job
//    posts, its Orders' texts, the reasons it was flagged and its e-mail; an admin's own Order copied the other side's words.
//    D2c (the second re-check): removing a profession's filter or revoking an invite no longer said what was removed, and
//    lifting a ban wrote its reason as "erased"; an admin's own short texts and a report filed as a user kept their words.
// D3 the admin's list of Orders showed every Order at the new prices as "card cost not covered" (Stripe's whole fee) and
//    sorted it above every Order not in a dispute: Cuvori pays the card cost there, so it is never a shortfall.
// D4 an admin who is the client or the freelancer on an Order could mark its "check by hand" note as handled.
// D5 "Mark as handled" answered "ok" when part of the note stayed (the bank's inquiry, a second chargeback).
// Every check is rolled back.
// Run: node tests/attack-check-nov7-db.mjs   (needs the local Postgres of tests/db; it is started here). To check another copy
// of the code, copy this file into that copy's tests folder and run it there: the database is built from that copy.
import fs from "node:fs";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const PGDIR = process.env.PGDIR || "/tmp/cuvori-pgtest";
const PSQL = ["-h", PGDIR, "-p", "5499", "-U", "postgres", "-d", "cuvori", "-At", "-v", "ON_ERROR_STOP=1"];
// the database as the test runner builds it: the same files, in the same order
const runAll = fs.readFileSync(path.join(root, "tests/run-all.sh"), "utf8");
const EXTRA = (runAll.match(/EXTRA="([^"]+)"/) || [])[1] || "";
const MIGRATE = (runAll.match(/MIGRATE="([^"]+)"/) || [])[1] || "";
const SUPA = path.join(root, "supabase");
spawnSync("tar", ["--skip-old-files", "-xzf", "tests/test-kit.tar.gz"], { cwd: root });
execFileSync("bash", [path.join(root, "tests/db/start-pg.sh")], { stdio: "ignore" });
execFileSync("bash", [path.join(root, "tests/db/load.sh")], { env: { ...process.env, EXTRA, PGOPTIONS: "-c client_min_messages=warning" }, stdio: "ignore" });
for (const f of ["tests/db/10_harness.sql", "tests/db/20_seed.sql"].map(x => path.join(root, x)).concat(MIGRATE.split(/\s+/).filter(Boolean).map(m => path.join(SUPA, m)).filter(f => fs.existsSync(f))))
  execFileSync("psql", [...PSQL, "-q", "-f", f], { env: { ...process.env, PGOPTIONS: "-c client_min_messages=warning" }, stdio: "ignore" });

const env = { ...process.env, PGOPTIONS: "-c client_min_messages=warning" };
const run = (sql) => { const r = spawnSync("psql", [...PSQL], { input: sql, encoding: "utf8", env }); return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() }; };
const U = (n) => `t.u('${n}')`;
const as = (who) => `set local role authenticated; select set_config('request.jwt.claim.sub', ${U(who)}::text, true);`;
const owner = "reset role; select set_config('request.jwt.claim.sub', '', true);";
const O = "'30000000-0000-0000-0000-000000000003'";            // a paid Order: client 101, freelancer 202
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const pick = (r, label) => { const l = r.out.split("\n").find(x => x.startsWith(label + ": ")); return l ? l.slice(label.length + 2) : (r.ok ? "(nothing)" : "error: " + (r.err.split("\n").find(x => /ERROR/.test(x)) || r.err).replace(/^.*ERROR:\s*/, "").slice(0, 120)); };
const tx = (body) => run(`begin;\n${body}\nrollback;\n`);
{ const r = tx(`select 'setup: ' || count(*) from public.contracts where id = ${O};`); if (pick(r, "setup") !== "1") { console.log("the test's set-up failed: " + (r.err || r.out)); process.exit(1); } }

{ // D1 the evidence only while there is something to decide
  const EV = (label) => `${as("401")} select '${label}: ' || coalesce(public.admin_order_evidence(${O}) ->> 'error', 'read'); ${owner}`;
  const disputed = `${as("101")} select public.order_action(${O}, 'dispute', 'late delivery', null, null); ${owner}`;
  const decided = `update public.contracts set status = 'completed', resolution = 'release', completed_at = now(), closed_at = now(), resolved_at = now(), released_cents = funded_cents where id = ${O};`;
  const r = tx(`${disputed} ${EV("open")} ${decided} ${EV("decided")}
    update public.contracts set chargeback_status = 'open', chargeback_id = 'dp_D1' where id = ${O}; ${EV("cb_open")}
    update public.contracts set chargeback_status = 'lost' where id = ${O}; ${EV("cb_lost")}
    update public.contracts set money_error = 'the client''s bank asked about payment pi_D1 (10.00 EUR, inquiry du_D1): answer it in Stripe''s dashboard' where id = ${O}; ${EV("inquiry")}
    update public.contracts set chargeback_status = 'won', money_error = 'top-up pi_D0 may not be recorded — check by hand · Also: chargeback dp_D2 also open on payment pi_D2 (20.00 EUR)' where id = ${O}; ${EV("second")}`);
  const cancelStuck = tx(`update public.contracts set status = 'resolving', resolution = 'refund', resolved_by = editor, resolved_at = now(), disputed_at = null where id = ${O}; ${EV("cancel")}`);
  vuln(pick(r, "open") !== "read" || pick(r, "decided") !== "nothing_to_decide" || pick(r, "cb_open") !== "read" || pick(r, "cb_lost") !== "nothing_to_decide" || pick(r, "inquiry") !== "read" || pick(r, "second") !== "read" || pick(cancelStuck, "cancel") !== "nothing_to_decide",
    `D1 the evidence: a dispute open -> ${pick(r, "open")}; decided and closed -> ${pick(r, "decided")}; a chargeback open -> ${pick(r, "cb_open")}; decided by the bank -> ${pick(r, "cb_lost")}; the bank's inquiry noted -> ${pick(r, "inquiry")}; a second chargeback noted while the first is decided -> ${pick(r, "second")}; the freelancer's own cancel stopped at Stripe, nobody disputing -> ${pick(cancelStuck, "cancel")} (must be read, nothing_to_decide, read, nothing_to_decide, read, read, nothing_to_decide)`);
  const page = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const btn = (page.match(/\$\{([^`]*)\?`<button class="link-btn" data-evidence="1">Evidence<\/button>`/) || [])[1] || "";
  let rule = null; try { rule = new Function("r", `return (${btn});`); } catch {}
  const R = (x) => ({ status: "completed", chargeback_status: null, disputed_at: null, money_error: null, ...x });
  const cases = rule ? [rule(R({ status: "disputed" })), rule(R({ disputed_at: "2026-01-01" })), rule(R({ chargeback_status: "open" })), rule(R({ chargeback_status: "lost" })), rule(R({ money_error: "x · Also: the client's bank asked about payment pi_1 (1.00 EUR)" })),
    rule(R({ chargeback_status: "won", money_error: "chargeback dp_2 also open on payment pi_2 (20.00 EUR)" })), rule(R({ status: "resolving", resolution: "refund" })), rule(R({ status: "resolving", resolution: "split", disputed_at: "2026-01-01" }))].map(Boolean) : [];
  vuln(!rule || cases.join() !== "true,false,true,false,true,true,false,true",
    `D1b the page's Evidence button: disputed, decided long ago, chargeback open, chargeback decided, inquiry, a second chargeback noted, the freelancer's own cancel stopped, a decision under way -> ${rule ? cases.join(", ") : "rule not found"} (must be true, false, true, false, true, true, false, true)`);
}

{ // D2 the admin log never keeps what people wrote or who they are
  const del = tx(`insert into public.conversations (id, user_a, user_b) values ('10000000-0000-0000-0000-0000000000aa', ${U("105")}, ${U("203")});
    insert into public.messages (conversation_id, sender, kind, body) values ('10000000-0000-0000-0000-0000000000aa', ${U("105")}, 'text', 'SECRET-105: my phone is +49 170 1234567'),
      ('10000000-0000-0000-0000-0000000000aa', ${U("203")}, 'text', 'SECRET-203: the other person''s reply');
    ${as("401")} select 'r: ' || public.admin_delete_user(${U("105")}); ${owner}
    select 'copies: ' || count(*) from public.admin_audit where detail::text like '%SECRET-%' or detail::text like '%c5@t.com%';
    select 'lines: ' || count(*) from public.admin_audit where at >= now() and target_table in ('messages', 'profiles');`);
  const own = tx(`update public.profiles set last_seen_at = now() - interval '1 day' where id = ${U("401")};
    insert into public.conversations (id, user_a, user_b) values ('10000000-0000-0000-0000-0000000000bb', ${U("203")}, ${U("401")});
    ${as("401")} select 'touch: ' || coalesce(public.touch_activity()::text, 'done');
    insert into public.messages (conversation_id, sender, kind, body) values ('10000000-0000-0000-0000-0000000000bb', ${U("401")}, 'text', 'PRIVATE: my wedding is in Kaunas'); ${owner}
    select 'seen: ' || count(*) from public.admin_audit where at >= now() and target_table = 'profiles';
    select 'text: ' || count(*) from public.admin_audit where detail::text like '%PRIVATE%';
    select 'msg: ' || count(*) from public.admin_audit where at >= now() and target_table = 'messages' and action = 'insert';`);
  const ban = tx(`${as("401")} select 'r: ' || public.admin_set_ban(${U("501")}, true, 'spam links'); select 'm: ' || public.admin_message_user(${U("501")}, 'Please add a profile photo.'); ${owner}
    select 'd: ' || (detail -> 'banned' ->> 'from') || '>' || (detail -> 'banned' ->> 'to') from public.admin_audit where at >= now() and target_table = 'profiles';
    select 'msg: ' || count(*) from public.admin_audit where at >= now() and target_table = 'messages' and action = 'insert' and detail::text not like '%profile photo%';`);
  const kept = tx(`insert into public.conversations (id, user_a, user_b) values ('10000000-0000-0000-0000-0000000000ab', ${U("105")}, ${U("203")});
    insert into public.jobs (id, owner, title, description, status) values ('60000000-0000-0000-0000-0000000000ab', ${U("105")}, 'SECRET-JOB title', 'SECRET-JOB call me at +49 170 1234567', 'open');
    insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, description, price, currency, pricing, amount_cents, payment_mode, status, accepted_at, completed_at, closed_at)
    values ('30000000-0000-0000-0000-0000000000ab', '10000000-0000-0000-0000-0000000000ab', ${U("203")}, ${U("105")}, ${U("105")}, 'kept Order', 'x', 100, 'EUR', 'project', 10000, 'direct', 'completed', now(), now(), now()),
           ('30000000-0000-0000-0000-0000000000ac', '10000000-0000-0000-0000-0000000000ab', ${U("203")}, ${U("105")}, ${U("105")}, 'SECRET-ORDER title', 'SECRET-ORDER my address is Hauptstr. 1', 100, 'EUR', 'project', 10000, 'direct', 'proposed', null, null, null);
    insert into public.order_reviews (order_id, reviewer, reviewee, reviewer_role, rating, comment, low_reason, reveal_due) values
     ('30000000-0000-0000-0000-0000000000ab', ${U("203")}, ${U("105")}, 'freelancer', 2, 'SECRET-REVIEW-BY-203: rude client', 'poor_communication', now() + interval '14 days'),
     ('30000000-0000-0000-0000-0000000000ab', ${U("105")}, ${U("203")}, 'client', 1, 'SECRET-REVIEW-BY-105: never answered my calls', 'poor_communication', now() + interval '14 days');
    insert into public.user_flags (user_id, kind, reason) values (${U("105")}, 'scam', 'SECRET-FLAG reason');
    ${as("401")} select 'r: ' || public.admin_delete_user(${U("105")}); ${owner}
    select 'copies: ' || count(*) from public.admin_audit where at >= now() and (detail::text like '%SECRET-%' or detail::text like '%c5@t.com%');
    select 'erased: ' || count(*) from public.admin_audit where at >= now() and target_table = 'profiles' and detail -> 'email' ->> 'from' = '(erased)';`);
  const mineOrder = tx(`insert into public.conversations (id, user_a, user_b) values ('10000000-0000-0000-0000-0000000000ee', ${U("203")}, ${U("401")});
    update public.profiles set rules_version = '2026-10' where id in (${U("203")}, ${U("401")});
    insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, description, deliverables, price, currency, pricing, amount_cents, payment_mode, status, terms_version, freelancer_accepted_version)
    values ('30000000-0000-0000-0000-0000000000ee', '10000000-0000-0000-0000-0000000000ee', ${U("203")}, ${U("401")}, ${U("203")}, 'Wedding film', 'SECRET-DESC: the bride is Ona Petraite, Kaunas, 12 June', 'SECRET-DELIV: 10 min film', 100, 'EUR', 'project', 10000, 'direct', 'proposed', 1, 1);
    ${as("401")} select 'accept: ' || public.order_accept('30000000-0000-0000-0000-0000000000ee', (select terms_version from public.contracts where id = '30000000-0000-0000-0000-0000000000ee')); ${owner}
    select 'copies: ' || count(*) from public.admin_audit where at >= now() and detail::text like '%SECRET-%';
    select 'lines: ' || count(*) from public.admin_audit where at >= now() and target_table = 'contracts';`);
  vuln(pick(kept, "r") !== "ok" || pick(kept, "copies") !== "0" || pick(kept, "erased") !== "1" || pick(mineOrder, "copies") !== "0" || !(Number(pick(mineOrder, "lines")) >= 1),
    `D2b an admin deletes an account that keeps a completed Order, with reviews both ways, a job post, a proposal and a flag -> ${pick(kept, "r")}: copies of its words or e-mail in the log ${pick(kept, "copies")}, its profile's e-mail written as erased ${pick(kept, "erased")}; an admin accepts an Order made to them (their own use) -> ${pick(mineOrder, "accept")}: copies of the other side's words ${pick(mineOrder, "copies")}, lines ${pick(mineOrder, "lines")} (must be ok, 0, 1; 0, 1 or more)`);
  // (the second re-check: Cuvori's own settings removed by an admin are still written whole; a ban lifted shows what it was;
  // the admin's own short texts and a report the admin files as a user keep no words)
  const cfg = tx(`insert into public.invites (code_hash, note, label, created_by) values ('h_d2c', 'for the Berlin photographers', 'Berlin photo', ${U("401")});
    insert into public.professions (slug, labels) values ('d2c-prof', '{}') on conflict do nothing;
    insert into public.filters (key, kind, match) values ('d2c_filter', 'tags', 'any') on conflict do nothing;
    insert into public.profession_filters (profession_slug, filter_key) values ('d2c-prof', 'd2c_filter') on conflict do nothing;
    update public.profiles set banned = true, banned_at = now(), ban_reason = 'spam links' where id = ${U("501")};
    ${as("401")} select 'f: ' || public.admin_set_profession_filter('d2c-prof', 'd2c_filter', false); select 'i: ' || public.admin_delete_invite('h_d2c');
    select 'u: ' || public.admin_set_ban(${U("501")}, false, null); ${owner}
    select 'fd: ' || count(*) from public.admin_audit where at >= now() and target_table = 'profession_filters' and detail::text like '%d2c_filter%';
    select 'id: ' || count(*) from public.admin_audit where at >= now() and target_table = 'invites' and detail::text like '%Berlin photo%';
    select 'ud: ' || coalesce((select detail -> 'ban_reason' ->> 'from' from public.admin_audit where at >= now() and target_table = 'profiles' limit 1), '-');`);
  const ownShort = tx(`${as("401")} insert into public.jobs (owner, title, description, status) values (${U("401")}, 'Ona''s wedding, Kaunas', 'Call me: +370 612 34567', 'open');
    select 'rep: ' || public.submit_report('abuse', 'profile', ${U("202")}::text, 'SECRET-REPORT: he wrote to ona.p@gmail.com'); ${owner}
    select 'words: ' || count(*) from public.admin_audit where at >= now() and (detail::text like '%Kaunas%' or detail::text like '%+370%' or detail::text like '%SECRET-REPORT%' or detail::text like '%ona.p@%');
    select 'lines: ' || count(*) from public.admin_audit where at >= now() and target_table in ('jobs', 'reports');`);
  vuln(pick(cfg, "fd") !== "1" || pick(cfg, "id") !== "1" || pick(cfg, "ud") !== "spam links" || pick(ownShort, "words") !== "0" || !(Number(pick(ownShort, "lines")) >= 1),
    `D2c an admin removes a profession's filter -> its line names it ${pick(cfg, "fd")}; revokes an invite -> its line says what it was ${pick(cfg, "id")}; lifts a ban -> the reason it had: ${pick(cfg, "ud")}; the admin's own short job post and a report filed as a user -> their words in the log ${pick(ownShort, "words")}, lines ${pick(ownShort, "lines")} (must be 1, 1, spam links, 0, 1 or more)`);
  vuln(pick(del, "r") !== "ok" || pick(del, "copies") !== "0" || !(Number(pick(del, "lines")) >= 3) || pick(own, "seen") !== "0" || pick(own, "text") !== "0" || pick(own, "msg") !== "1"
       || pick(ban, "r") !== "ok" || pick(ban, "d") !== "false>true" || pick(ban, "msg") !== "1",
    `D2 an admin deletes an account -> ${pick(del, "r")}: copies of its messages or e-mail in the log ${pick(del, "copies")}, lines naming what was deleted ${pick(del, "lines")}; an admin seen online -> lines ${pick(own, "seen")}; an admin's own chat message -> logged ${pick(own, "msg")}, its text in the log ${pick(own, "text")}; a ban -> ${pick(ban, "d")}, a message to someone -> logged without its text ${pick(ban, "msg")} (must be ok, 0, 3 or more; 0; 1, 0; false>true, 1)`);
}

{ // D3 the admin's list at the new prices
  const r = tx(`update public.pricing_plans set rules_version = '2026-11' where version = 2;
    select 'switch: ' || public.pricing_switch_to(2, 'check');
    insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, description, price, currency, pricing, amount_cents, payment_mode, status, revisions, funded_cents, released_cents, refunded_cents, accepted_at, created_at)
    values ('30000000-0000-0000-0000-0000000000f2', '10000000-0000-0000-0000-000000000003', ${U("202")}, ${U("101")}, ${U("101")}, 'plan 2 order, finished long ago', 'x', 100, 'EUR', 'project', 10000, 'escrow', 'accepted', 1, 0, 0, 0, now(), now() - interval '300 days');
    select 'plan: ' || pricing_version from public.contracts where id = '30000000-0000-0000-0000-0000000000f2';
    set local role service_role; select set_config('request.headers', '{"x-cuvori-pricing":"2"}', true);
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key, provider_fee_cents)
    values ('30000000-0000-0000-0000-0000000000f2', 'fund', 10000, 'stripe', 'pi_D3', 'succeeded', 'fund:pi_D3', 175);
    reset role;
    update public.contracts set status = 'completed', funded_cents = 10000, released_cents = 10000 where id = '30000000-0000-0000-0000-0000000000f2';
    insert into public.order_payments (order_id, kind, amount_cents, fee_cents, provider, provider_ref, status, provider_fee_cents) values (${O}, 'fund', 10000, 100, 'stripe', 'pi_D3old', 'succeeded', 160);
    ${as("401")}
    select 'p2: ' || coalesce(fee_short_cents::text, '-') || ' row ' || n from (select id, fee_short_cents, row_number() over () as n from public.admin_list_contracts()) x where id = '30000000-0000-0000-0000-0000000000f2';
    select 'p1: ' || coalesce(fee_short_cents::text, '-') from public.admin_list_contracts() where id = ${O};
    ${owner}`);
  vuln(pick(r, "plan") !== "2" || !/^0 row /.test(pick(r, "p2")) || pick(r, "p2") === "0 row 1" || !(Number(pick(r, "p1")) >= 60),
    `D3 the admin's list: an Order at the new prices with Stripe's fee of 1.75 -> card cost not covered ${pick(r, "p2")}; an Order at today's prices whose client paid 1.00 of a 1.60 fee -> ${pick(r, "p1")} (must be 0 and not first; 60 or more)`);
}

{ // D4 / D5 marking a note as handled
  const mine = tx(`insert into public.conversations (id, user_a, user_b) values ('10000000-0000-0000-0000-0000000000cc', ${U("203")}, ${U("401")});
    insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, description, price, currency, pricing, amount_cents, payment_mode, status, revisions, funded_cents, released_cents, refunded_cents, accepted_at)
    values ('30000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-0000000000cc', ${U("203")}, ${U("401")}, ${U("401")}, 'admin hires', 'x', 100, 'EUR', 'project', 10000, 'escrow', 'accepted', 1, 0, 0, 0, now());
    update public.contracts set status = 'funded', funded_cents = 10000, money_error = 'top-up pi_9 may not be recorded — check by hand' where id = '30000000-0000-0000-0000-0000000000c1';
    ${as("401")} select 'r: ' || public.admin_clear_order_note('30000000-0000-0000-0000-0000000000c1', 'top-up pi_9 may not be recorded — check by hand'); ${owner}
    select 'note: ' || coalesce(money_error, '(none)') from public.contracts where id = '30000000-0000-0000-0000-0000000000c1';`);
  const both = "Stripe check failed: Stripe did not answer (Netlify log ref 1a2b3c4d) · Also: the client's bank asked about payment pi_123 (99.90 EUR): no automatic release until it ends";
  const part = tx(`update public.contracts set money_error = ${lit(both)} where id = ${O};
    ${as("401")} select 'r: ' || public.admin_clear_order_note(${O}, ${lit(both)}); ${owner}
    select 'note: ' || coalesce(money_error, '(none)') from public.contracts where id = ${O};`);
  const whole = tx(`update public.contracts set money_error = 'top-up pi_8 may not be recorded — check by hand' where id = ${O};
    ${as("401")} select 'r: ' || public.admin_clear_order_note(${O}, 'top-up pi_8 may not be recorded — check by hand'); ${owner}`);
  vuln(pick(mine, "r") !== "your_order" || pick(mine, "note") === "(none)",
    `D4 an admin who is the client on an Order marks its note as handled -> ${pick(mine, "r")}; the note: ${pick(mine, "note").slice(0, 50)} (must be your_order, kept)`);
  vuln(pick(part, "r") !== "partly" || !pick(part, "note").startsWith("the client's bank asked") || pick(whole, "r") !== "ok",
    `D5 a note with the bank's inquiry in it marked as handled -> ${pick(part, "r")} (the inquiry's part stays: ${pick(part, "note").slice(0, 40)}); a note with nothing kept -> ${pick(whole, "r")} (must be partly; ok)`);
  const page = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const toast = page.split("\n").find(l => l.includes("said={ ok:")) || "", around = page.slice(page.indexOf(toast) - 400, page.indexOf(toast) + toast.length + 900);
  vuln(!/partly:/.test(around) || !/your_order:/.test(around),
    `D5b the page's words after "Mark as handled": for a note partly kept ${/partly:/.test(around)}, for an admin's own Order ${/your_order:/.test(around)} (must be both there)`);
}

console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
