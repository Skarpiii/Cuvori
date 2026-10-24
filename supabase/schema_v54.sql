-- Cuvori schema v54 — Supabase's own "Delete user" works for people who joined with an invite or made invites.
-- Run after schema_v53.sql, in the Supabase SQL editor.
--
-- An invite remembers who used it (used_by) and who made it (created_by), both pointing at the person's sign-in row, and
-- the database refused to delete a sign-in row that an invite still pointed to. So Supabase's own button (Authentication →
-- Users → Delete user) failed with "Database error deleting user" for every freelancer (they all join with an invite) and
-- for the admin who made invites, even with no money on the way, and the "delete anyway" steps of v52 failed the same way.
-- The proper ways (Settings → delete account, the admin page → Delete) let go of used_by first and worked, except for an
-- admin who had made invites.
-- Now deleting a person empties those two fields on their invites instead. The invite stays on the list, and a used one
-- stays used (its used_at is kept), so the code can never be used again. v52's check still comes first: while money is
-- on the way on one of the person's Orders, the delete is refused as before. Nothing else changes. Safe to run more than once.

alter table public.invites drop constraint if exists invites_used_by_fkey,
  add constraint invites_used_by_fkey foreign key (used_by) references auth.users(id) on delete set null;
alter table public.invites drop constraint if exists invites_created_by_fkey,
  add constraint invites_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;

-- Shows whether this ran: one row that says "v54 applied".
select case when (select count(*) from pg_constraint
                   where conrelid = 'public.invites'::regclass and contype = 'f' and confrelid = 'auth.users'::regclass
                     and confdeltype = 'n' and conname in ('invites_used_by_fkey', 'invites_created_by_fkey')) = 2
            then 'v54 applied: Supabase''s own Delete user now works for people who joined with an invite or made invites.'
            else 'v54 NOT applied' end as result;
