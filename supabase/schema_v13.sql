-- ============================================================
-- Cuvori — schema v13: whether an editor is actually taking work.
-- Run AFTER schema_v12.sql. Re-runnable.
-- ============================================================

-- 'open'   = taking new projects
-- 'busy'   = working, free again from free_from
-- 'closed' = not taking work at the moment
alter table public.editor_profiles add column if not exists availability        text not null default 'open';
alter table public.editor_profiles add column if not exists free_from           date;
-- when the editor last touched the status. The badge stops counting as "available"
-- 30 days after this, so an abandoned profile cannot keep telling clients it is free.
alter table public.editor_profiles add column if not exists availability_set_at timestamptz not null default now();
-- day precision only: enough for "active this week", not a log of when someone is at their desk
alter table public.editor_profiles add column if not exists last_active_on      date;
alter table public.profiles        add column if not exists last_seen_at        timestamptz;

alter table public.editor_profiles drop constraint if exists editor_profiles_availability_check;
alter table public.editor_profiles add constraint editor_profiles_availability_check
  check (availability in ('open','busy','closed'));

-- the editor may set the status; the clock on it is not theirs to set
create or replace function public.editor_status_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.availability <> 'busy' then new.free_from := null; end if;
  new.available := (new.availability = 'open');   -- keep the old boolean column in step
  if new.free_from is not null and (new.free_from > current_date + 365 or new.free_from < current_date - 1) then
    raise exception 'bad_date';
  end if;
  if coalesce(current_setting('cuvori.setting_availability', true), '') = '1' then
    new.availability_set_at := now();      -- the editor said so on purpose, even if the answer is the same
    new.last_active_on := current_date;
  elsif tg_op = 'UPDATE' and auth.uid() is not null and auth.uid() = old.id then
    new.last_active_on := old.last_active_on;                    -- written by touch_activity() only
    if new.availability is distinct from old.availability or new.free_from is distinct from old.free_from then
      new.availability_set_at := now();                          -- a real change restarts the 30 days
    else
      new.availability_set_at := old.availability_set_at;        -- saving the bio does not
    end if;
  elsif tg_op = 'INSERT' then
    new.availability_set_at := now();
    new.last_active_on := current_date;
  end if;
  return new;
end $$;
drop trigger if exists editor_status_guard on public.editor_profiles;
create trigger editor_status_guard before insert or update on public.editor_profiles
  for each row execute procedure public.editor_status_guard();

-- called once an hour at most while someone uses the site
create or replace function public.touch_activity()
returns text language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then return 'not_signed_in'; end if;
  update public.profiles set last_seen_at = now()
   where id = me and (last_seen_at is null or last_seen_at < now() - interval '1 hour');
  update public.editor_profiles set last_active_on = current_date
   where id = me and (last_active_on is distinct from current_date);
  return 'ok';
end $$;
revoke execute on function public.touch_activity() from public, anon;
grant   execute on function public.touch_activity() to authenticated;

-- a busy date that has passed means the editor is free again, whatever the row still says
create or replace function public.editor_is_open(p_availability text, p_free_from date, p_set_at timestamptz)
returns boolean language sql stable as $$
  select p_set_at > now() - interval '30 days'
     and (p_availability = 'open'
          or (p_availability = 'busy' and p_free_from is not null and p_free_from <= current_date));
$$;

-- existing profiles start with a status set now, so nobody is marked stale on day one
update public.editor_profiles set availability_set_at = now() where availability_set_at is null;
update public.editor_profiles set last_active_on = current_date where last_active_on is null;

-- confirming the status counts as an answer even when the answer has not changed:
-- that is what the nudge and the after-a-job question ask for
create or replace function public.set_availability(p_status text, p_free_from date default null)
returns text language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then return 'not_signed_in'; end if;
  if p_status not in ('open','busy','closed') then return 'bad_status'; end if;
  if p_status <> 'busy' then p_free_from := null; end if;
  if p_free_from is not null and (p_free_from > current_date + 365 or p_free_from <= current_date) then return 'bad_date'; end if;
  perform public.rate_limit('set_availability', 60, interval '1 hour');
  perform set_config('cuvori.setting_availability', '1', true);
  update public.editor_profiles set availability = p_status, free_from = p_free_from, updated_at = now() where id = me;
  perform set_config('cuvori.setting_availability', '0', true);
  if not found then return 'no_profile'; end if;
  return 'ok';
end $$;
revoke execute on function public.set_availability(text, date) from public, anon;
grant   execute on function public.set_availability(text, date) to authenticated;
