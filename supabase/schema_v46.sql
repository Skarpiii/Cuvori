-- Cuvori schema v46 — a person can't be removed by deleting their profile row by hand.
-- Run after schema_v45.sql, in the Supabase SQL editor.
--
-- Deleting an account properly (the person on Settings, an admin on the admin page, or Authentication -> Users -> Delete
-- user in Supabase) goes through purge_user_data(): the sign-in goes too, kept Orders stay (v35), and for someone who was
-- banned or flagged, their e-mail, bank and card details are copied to the list a new account is checked against.
-- Deleting the row in public.profiles by hand (the Table Editor's Delete row, or SQL) skipped all of that for someone with
-- no kept Orders (v39 already refuses it when they have one): the sign-in stayed, so the person could still sign in to a
-- broken account, and a banned person's details were wiped instead of kept, so a later sign-up with them was no longer
-- caught.
-- Now a profile row only goes through the proper deletion; by hand it is refused, with the way to do it. Emptying the
-- whole table (TRUNCATE) is refused the same way. The empty row left for a kept Order (the person already deleted
-- properly) can still be removed once its Orders are gone.
-- The result also counts sign-ins whose profile was already deleted by hand before this: each of those can be removed
-- with Authentication -> Users -> Delete user.

create or replace function public.profiles_need_proper_deletion()
returns trigger language plpgsql set search_path = public as $$
begin
  -- the proper deletion is running (purge_user_data): it removes the row itself
  if coalesce(current_setting('cuvori.purge', true), '') = '1' then
    if tg_op = 'DELETE' then return old; end if;
    return null;
  end if;
  if tg_op = 'DELETE' then
    -- already deleted properly: the empty row left for a kept Order, once that Order is gone
    if old.deleted_at is not null then return old; end if;
    raise exception 'Profile % can''t be deleted on its own: done this way the person''s sign-in stays, and a banned person''s details are wiped instead of kept against a new account. To delete a person, use Authentication -> Users -> Delete user, or the admin page. If their sign-in is already gone, run: select public.purge_user_data(''%'');', old.id, old.id;
  end if;
  if exists (select 1 from public.profiles where deleted_at is null) then
    raise exception 'The table profiles holds the people on Cuvori, so it can''t be emptied: each person is deleted with Authentication -> Users -> Delete user, or the admin page, so their sign-in goes too and a banned person''s details are kept against a new account.';
  end if;
  return null;
end $$;
revoke execute on function public.profiles_need_proper_deletion() from public, anon, authenticated;

drop trigger if exists profiles_need_proper_deletion on public.profiles;
create trigger profiles_need_proper_deletion before delete on public.profiles
  for each row execute function public.profiles_need_proper_deletion();
drop trigger if exists profiles_need_proper_deletion_truncate on public.profiles;
create trigger profiles_need_proper_deletion_truncate before truncate on public.profiles
  for each statement execute function public.profiles_need_proper_deletion();

-- Shows whether this ran: one row that says "v46 applied", and how many sign-ins have no profile left (from a profile
-- deleted by hand before v46; each can be removed with Authentication -> Users -> Delete user).
select case when exists (select 1 from pg_trigger where tgrelid = 'public.profiles'::regclass and tgname = 'profiles_need_proper_deletion' and tgenabled <> 'D')
             and exists (select 1 from pg_trigger where tgrelid = 'public.profiles'::regclass and tgname = 'profiles_need_proper_deletion_truncate' and tgenabled <> 'D')
            then 'v46 applied: a person is only removed through the proper deletion, never by deleting their profile row by hand. Sign-ins left without a profile: '
                 || (select count(*) from auth.users u where not exists (select 1 from public.profiles p where p.id = u.id)) || '.'
            else 'v46 NOT applied' end as result;
