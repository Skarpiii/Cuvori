-- ============================================================
-- Cuvori — schema v10: hide other people's e-mail, admin and ban flags.
-- Run AFTER schema_v9.sql, and only once the NEW site (which reads your own
-- profile through my_profile()) is live — the old page reads profiles with
-- select("*") and would lose its sign-in role. Re-runnable.
-- ============================================================
revoke select, insert, update, delete on public.profiles from anon, authenticated;
grant select (id, first_name, role, created_at) on public.profiles to authenticated;
grant update (first_name, updated_at) on public.profiles to authenticated;
drop policy if exists "users update own profile" on public.profiles;
create policy "users update own profile" on public.profiles for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);
alter table public.profiles drop constraint if exists profiles_first_name_len;
alter table public.profiles add constraint profiles_first_name_len check (length(first_name) <= 80 and first_name !~ '[<>]') not valid;

