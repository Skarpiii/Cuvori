// Deleting an account under Supabase's file guard (schema v36). Since March 2026 Supabase refuses every DELETE made
// straight in its file tables unless it comes through its file service (a statement trigger on storage.objects,
// protect_objects_delete; a statement trigger runs even when nothing would be deleted). Cuvori's account deletion removed
// the person's portfolio files that way, so every deletion from Cuvori stopped with an error and nothing was deleted.
// Now the page removes the files through the file service first, and the database deletion answers 'files_left' while
// any are left, after the money check, so no file is removed for a deletion that has to wait anyway.
// This test puts an imitation of Supabase's guard on the local database (Supabase's exact wording is not public: the
// imitation refuses the same way, a statement trigger that lets a DELETE through only with storage.allow_delete_query =
// 'true', which the file service sets). Every check is rolled back.
// F1 a client with no files, F2–F3 a freelancer with files, F4 the money check comes first, F5–F6 an admin deleting a
// user, F7 nobody removes someone else's files, F8 a deletion from Supabase's dashboard, F9 the page's message.
// Run: node tests/attack-account-files.mjs   (needs the local Postgres of tests/db; it is started here)
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
spawnSync("tar", ["--skip-old-files", "-xzf", "tests/test-kit.tar.gz"], { cwd: root });
execFileSync("bash", [path.join(root, "tests/db/start-pg.sh")], { stdio: "ignore" });
execFileSync("bash", [path.join(root, "tests/db/load.sh")], { env: { ...process.env, EXTRA, PGOPTIONS: "-c client_min_messages=warning" }, stdio: "ignore" });
for (const f of ["tests/db/10_harness.sql", "tests/db/20_seed.sql", ...MIGRATE.split(/\s+/).filter(Boolean).map(m => `supabase/${m}`)])
  execFileSync("psql", [...PSQL, "-q", "-f", path.join(root, f)], { env: { ...process.env, PGOPTIONS: "-c client_min_messages=warning" }, stdio: "ignore" });

const run = (sql) => { const r = spawnSync("psql", [...PSQL, "-c", sql], { encoding: "utf8" }); return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() }; };
const U = (n) => `t.u('${n}')`;
const as = (who) => `set local role authenticated; select set_config('request.jwt.claim.sub', ${U(who)}::text, true);`;
const owner = "reset role; select set_config('request.jwt.claim.sub', '', true);";
// what the file service does when it removes a file: the same DELETE, as the signed-in person, with its flag set
const viaFileService = (who, where) => `${as(who)} select set_config('storage.allow_delete_query', 'true', true);
  with x as (delete from storage.objects where ${where} returning 1) select 'removed: ' || count(*) from x; select set_config('storage.allow_delete_query', '', true); ${owner}`;
// 811 client (no files), 812 freelancer with two portfolio files, 813 another freelancer with one file
const SETUP = `
  create or replace function storage.cuvori_test_guard() returns trigger language plpgsql as $g$
  begin
    if coalesce(current_setting('storage.allow_delete_query', true), '') <> 'true' then
      raise exception 'Direct deletion from storage tables is not allowed. Use the Storage API instead.';
    end if;
    return null;
  end $g$;
  create trigger protect_objects_delete before delete on storage.objects for each statement execute function storage.cuvori_test_guard();
  insert into auth.users (id, email, raw_user_meta_data) values (${U("811")}, 'dana811@t.com', '{"first_name":"Dana"}'), (${U("812")}, 'eli812@t.com', '{"first_name":"Eli"}'), (${U("813")}, 'fay813@t.com', '{"first_name":"Fay"}');
  update public.profiles set role = 'editor' where id in (${U("812")}, ${U("813")});
  insert into storage.objects (bucket_id, name, owner) values ('portfolio', ${U("812")} || '/video_1.mp4', ${U("812")}), ('portfolio', ${U("812")} || '/thumb_1.jpg', ${U("812")}),
                                                            ('portfolio', ${U("813")} || '/video_1.mp4', ${U("813")});
`;
const tx = (body) => run(`begin; ${SETUP} ${body}; rollback;`);
const pick = (r, label) => { const l = r.out.split("\n").find(x => x.startsWith(label + ": ")); return l ? l.slice(label.length + 2) : (r.ok ? "(nothing)" : "error: " + (r.err.split("\n").find(x => /^ERROR/.test(x)) || "").replace(/^ERROR:\s*/, "")); };
const del = (who) => `${as(who)} select 'answer: ' || public.delete_my_account(); ${owner}`;
const STATE = (n) => `select 'state: sign-in ' || (select count(*) from auth.users where id = ${U(n)}) || ', live profile ' || (select count(*) from public.profiles where id = ${U(n)} and deleted_at is null)
                        || ', files ' || (select count(*) from storage.objects where bucket_id = 'portfolio' and name like ${U(n)}::text || '/%');`;

{ // F1 a client who never uploaded anything deletes her account
  const r = tx(`${del("811")} ${STATE("811")}`);
  vuln(pick(r, "answer") !== "ok" || pick(r, "state") !== "sign-in 0, live profile 0, files 0",
    `F1 a client with no files deletes her account under Supabase's file guard -> ${pick(r, "answer")}; ${pick(r, "state")} (must be deleted: nothing in the file tables needs deleting)`);
}
{ // F2 a freelancer with portfolio files: the database leaves the files to the file service and says so
  const r = tx(`${del("812")} ${STATE("812")}`);
  vuln(pick(r, "answer") !== "files_left" || pick(r, "state") !== "sign-in 1, live profile 1, files 2",
    `F2 a freelancer with 2 portfolio files deletes his account -> ${pick(r, "answer")}; ${pick(r, "state")} (must answer files_left and change nothing: the page removes the files first)`);
  // F3 the page removed his files through the file service, then asks again
  const r2 = tx(`${viaFileService("812", `bucket_id = 'portfolio' and name like ${U("812")}::text || '/%'`)} ${del("812")} ${STATE("812")}`);
  vuln(pick(r2, "removed") !== "2" || pick(r2, "answer") !== "ok" || pick(r2, "state") !== "sign-in 0, live profile 0, files 0",
    `F3 the page removes his 2 files through the file service, then deletes again -> removed ${pick(r2, "removed")}; ${pick(r2, "answer")}; ${pick(r2, "state")} (must be deleted, files and all)`);
}
{ // F4 the money check comes before the file check: a deletion that has to wait never costs anyone their files
  const r = tx(`insert into public.conversations (id, user_a, user_b) values ('18000000-0000-0000-0000-000000000001', ${U("811")}, ${U("812")});
    insert into public.contracts (conversation_id, editor, client, proposed_by, title, price, status, payment_mode, amount_cents, funded_cents)
      values ('18000000-0000-0000-0000-000000000001', ${U("812")}, ${U("811")}, ${U("812")}, 'Held', 100, 'funded', 'escrow', 10000, 10000);
    ${del("812")} ${STATE("812")}`);
  vuln(pick(r, "answer") !== "active_payments" || pick(r, "state") !== "sign-in 1, live profile 1, files 2",
    `F4 the same freelancer while a client's €100 is held for him -> ${pick(r, "answer")}; ${pick(r, "state")} (must answer active_payments first, so the page never removes his files)`);
}
{ // F5 an admin deletes a freelancer who has files
  const r = tx(`${as("401")} select 'answer: ' || public.admin_delete_user(${U("812")}); ${owner} ${STATE("812")}`);
  vuln(pick(r, "answer") !== "files_left" || pick(r, "state") !== "sign-in 1, live profile 1, files 2",
    `F5 an admin deletes a freelancer with 2 files -> ${pick(r, "answer")}; ${pick(r, "state")} (must answer files_left and change nothing)`);
  // F6 the admin page removes them through the file service (an admin may remove a user's portfolio files), then asks again
  const r2 = tx(`${viaFileService("401", `bucket_id = 'portfolio' and name like ${U("812")}::text || '/%'`)} ${as("401")} select 'answer: ' || public.admin_delete_user(${U("812")}); ${owner} ${STATE("812")}`);
  vuln(pick(r2, "removed") !== "2" || pick(r2, "answer") !== "ok" || pick(r2, "state") !== "sign-in 0, live profile 0, files 0",
    `F6 the admin page removes his 2 files through the file service, then deletes again -> removed ${pick(r2, "removed")}; ${pick(r2, "answer")}; ${pick(r2, "state")} (must be deleted)`);
}
{ // F7 nobody else can remove a person's files, even through the file service
  for (const [who, label] of [["813", "another freelancer"], ["811", "a client"]]) {
    const r = tx(`${viaFileService(who, `bucket_id = 'portfolio' and name like ${U("812")}::text || '/%'`)} ${STATE("812")}`);
    vuln(pick(r, "removed") !== "0" || pick(r, "state") !== "sign-in 1, live profile 1, files 2",
      `F7 ${label} removes the freelancer's files through the file service -> removed ${pick(r, "removed")}; ${pick(r, "state")} (must remove nothing)`);
  }
}
{ // F8 a deletion in Supabase's dashboard still works under the guard (it never touched the files)
  const r = tx(`delete from auth.users where id = ${U("812")}; ${STATE("812")}`);
  vuln(pick(r, "state") !== "sign-in 0, live profile 0, files 2",
    `F8 the owner deletes the freelancer in Supabase's dashboard -> ${pick(r, "state")} (must go through; his files stay for the owner to remove under Storage)`);
}
{ // F9 the page: files are removed through the file service before asking again, and the message exists in every language
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const mapped = /files_left:"err_filesLeft"/.test(html);
  const langs = (html.match(/err_filesLeft:"[^"]+"/g) || []).length;
  const self = /rpc\("delete_my_account"\)[\s\S]{0,400}files_left[\s\S]{0,200}removePortfolioFiles\(myId\(\)\)[\s\S]{0,200}rpc\("delete_my_account"\)/.test(html);
  const admin = (html.match(/rpc\("admin_delete_user",\{ target:uid \}\)[\s\S]{0,300}files_left[\s\S]{0,200}removePortfolioFiles\(uid\)[\s\S]{0,200}rpc\("admin_delete_user",\{ target:uid \}\)/g) || []).length;
  vuln(!mapped || langs < 7 || !self || admin < 2, `F9 the page -> files_left mapped: ${mapped}; languages with a text: ${langs}; own deletion removes the files first and asks again: ${self}; admin deletions doing the same: ${admin} of 2`);
}

console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
