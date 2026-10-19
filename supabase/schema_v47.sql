-- Cuvori schema v47 — at most 200 portfolio files per person, however they are sent.
-- Run after schema_v46.sql, in the Supabase SQL editor.
--
-- The upload rule on storage.objects ("editors upload to own folder", v9) counts a person's files and lets a new one in
-- while there are fewer than 200. The count is read once per command, before anything is saved, so:
--  * uploads sent at the same moment all saw the same old number: at 199 files, two uploads at once both got in;
--  * one command saving many files at once got all of them in;
--  * Supabase's file service checks the rule with a test write, then uploads the file, then saves the file's row as its
--    own admin role, which the rule never checks, so uploads in flight at the same time were never counted.
-- Each file is up to 50 MB, and Cuvori pays for the storage.
-- Now a check on the table itself counts again when the row is really saved, one new file at a time per person, and
-- refuses the 201st ("too_many_files"; the file service then removes the uploaded file). Replacing or renaming a file
-- that is already there still works, and other people and other buckets are not affected. The upload rule stays as the
-- first check, so a full portfolio is still refused before anything is uploaded.

create or replace function public.portfolio_keep_limit()
returns trigger language plpgsql security definer set search_path = public, storage as $$
declare who text := split_part(new.name, '/', 1);
begin
  if new.bucket_id is distinct from 'portfolio' then return new; end if;
  -- renaming a file inside the same person's portfolio folder adds nothing
  if tg_op = 'UPDATE' and old.bucket_id = 'portfolio' and split_part(old.name, '/', 1) = who then return new; end if;
  -- one new file at a time per person: uploads sent at the same moment wait for each other, so each counts the one before
  perform pg_advisory_xact_lock(hashtextextended('cuvori.portfolio.' || who, 0));
  -- saving again a file that is already there (replacing it) adds nothing
  if tg_op = 'INSERT' and exists (select 1 from storage.objects o where o.bucket_id = 'portfolio' and o.name = new.name) then return new; end if;
  if (select count(*) from storage.objects o where o.bucket_id = 'portfolio' and o.name like who || '/%') >= 200 then
    raise exception 'too_many_files' using hint = 'a portfolio keeps at most 200 files';
  end if;
  return new;
end $$;
revoke execute on function public.portfolio_keep_limit() from public, anon, authenticated;

drop trigger if exists cuvori_portfolio_limit on storage.objects;
create trigger cuvori_portfolio_limit before insert or update of bucket_id, name on storage.objects
  for each row execute function public.portfolio_keep_limit();

-- Shows whether this ran: one row that says "v47 applied", and the most portfolio files any one person has now.
select case when exists (select 1 from pg_trigger where tgrelid = 'storage.objects'::regclass and tgname = 'cuvori_portfolio_limit' and tgenabled <> 'D')
            then 'v47 applied: at most 200 portfolio files per person, also for uploads sent at the same moment. Most files one person has now: '
                 || (select coalesce(max(n), 0) from (select count(*) n from storage.objects where bucket_id = 'portfolio' group by split_part(name, '/', 1)) x) || '.'
            else 'v47 NOT applied' end as result;
