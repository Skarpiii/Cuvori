-- ============================================================
-- Cuvori — schema v12: the site rules people agree to, and a working
-- report route. Run AFTER schema_v11.sql. Re-runnable.
-- ============================================================

-- ---------- which version of the rules each person accepted ----------
alter table public.profiles add column if not exists rules_version    text;
alter table public.profiles add column if not exists rules_accepted_at timestamptz;
alter table public.profiles add column if not exists banned_at        timestamptz;

-- a user may not write these columns directly: only accept_rules() sets them
create or replace function public.profiles_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and auth.uid() = old.id then
    new.email := old.email;
    new.created_at := old.created_at;
    new.banned_at := old.banned_at;
    -- only accept_rules() may record an acceptance; a direct write cannot
    if coalesce(current_setting('cuvori.accepting_rules', true), '') <> '1' then
      new.rules_version := old.rules_version;
      new.rules_accepted_at := old.rules_accepted_at;
    end if;
    if new.first_name is distinct from old.first_name and (length(new.first_name) > 80 or new.first_name ~ '[<>]') then
      raise exception 'bad_name';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before update on public.profiles for each row execute procedure public.profiles_guard();

-- the only way the acceptance is recorded. The version string is the date the
-- rules were published, so an old acceptance can never be passed off as a new one.
create or replace function public.accept_rules(v text)
returns text language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then return 'not_signed_in'; end if;
  if v is null or v !~ '^[0-9]{4}-[0-9]{2}$' then return 'bad_version'; end if;
  perform public.rate_limit('accept_rules', 20, interval '1 hour');
  perform set_config('cuvori.accepting_rules', '1', true);
  update public.profiles
     set rules_version = v, rules_accepted_at = now(), updated_at = now()
   where id = me;
  perform set_config('cuvori.accepting_rules', '0', true);
  return 'ok';
end $$;
revoke execute on function public.accept_rules(text) from public, anon;
grant   execute on function public.accept_rules(text) to authenticated;

-- ---------- reports: the notice-and-action route the rules promise ----------
create table if not exists public.reports (
  id          uuid primary key default gen_random_uuid(),
  reporter    uuid references public.profiles(id) on delete set null,
  kind        text not null,
  target_kind text not null default 'other',
  target_id   text default '',
  body        text not null,
  status      text not null default 'open',
  outcome     text,
  handled_by  uuid references public.profiles(id) on delete set null,
  handled_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists reports_status_idx   on public.reports(status, created_at desc);
create index if not exists reports_reporter_idx on public.reports(reporter, created_at desc);
alter table public.reports enable row level security;
revoke all on public.reports from anon, authenticated;

alter table public.reports drop constraint if exists reports_sane;
alter table public.reports add constraint reports_sane check (
      kind in ('illegal','rights','scam','abuse','fake','other')
  and target_kind in ('profile','job','review','message','contract','other')
  and length(body) between 10 and 4000
  and length(coalesce(target_id,'')) <= 200
  and status in ('open','actioned','rejected')
  and length(coalesce(outcome,'')) <= 2000
) not valid;

create or replace function public.submit_report(p_kind text, p_target_kind text, p_target_id text, p_body text)
returns text language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); new_id uuid;
begin
  if me is null then return 'not_signed_in'; end if;
  p_body := btrim(coalesce(p_body, ''));
  if length(p_body) < 10 or length(p_body) > 4000 then return 'bad_body'; end if;
  if p_kind is null or p_kind not in ('illegal','rights','scam','abuse','fake','other') then return 'bad_kind'; end if;
  if coalesce(p_target_kind,'other') not in ('profile','job','review','message','contract','other') then return 'bad_kind'; end if;
  if length(coalesce(p_target_id,'')) > 200 then return 'bad_target'; end if;
  perform public.rate_limit('report_day', 20, interval '1 day');
  insert into public.reports (reporter, kind, target_kind, target_id, body)
  values (me, p_kind, coalesce(p_target_kind,'other'), coalesce(p_target_id,''), p_body)
  returning id into new_id;
  return 'ok';
end $$;
revoke execute on function public.submit_report(text, text, text, text) from public, anon;
grant   execute on function public.submit_report(text, text, text, text) to authenticated;

-- what the reporter can see about their own reports (the "we told you what we did" promise)
create or replace function public.my_reports()
returns table (id uuid, kind text, target_kind text, body text, status text, outcome text, created_at timestamptz, handled_at timestamptz)
language sql stable security definer set search_path = public as $$
  select r.id, r.kind, r.target_kind, r.body, r.status, r.outcome, r.created_at, r.handled_at
  from public.reports r where r.reporter = auth.uid() order by r.created_at desc limit 100;
$$;
revoke execute on function public.my_reports() from public, anon;
grant   execute on function public.my_reports() to authenticated;

create or replace function public.admin_list_reports(p_status text default 'open')
returns table (id uuid, reporter uuid, reporter_email text, kind text, target_kind text, target_id text,
               body text, status text, outcome text, created_at timestamptz, handled_at timestamptz)
language sql stable security definer set search_path = public as $$
  select r.id, r.reporter, p.email, r.kind, r.target_kind, r.target_id,
         r.body, r.status, r.outcome, r.created_at, r.handled_at
  from public.reports r left join public.profiles p on p.id = r.reporter
  where public.is_admin() and (p_status = 'all' or r.status = p_status)
  order by r.created_at desc limit 500;
$$;
revoke execute on function public.admin_list_reports(text) from public, anon;
grant   execute on function public.admin_list_reports(text) to authenticated;

-- a decision always carries a reason: that reason is what the reporter and the
-- reported person are shown, and it is what a regulator would ask to see
create or replace function public.admin_resolve_report(p_id uuid, p_status text, p_outcome text)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then return 'not_allowed'; end if;
  if p_status not in ('actioned','rejected') then return 'bad_status'; end if;
  p_outcome := btrim(coalesce(p_outcome, ''));
  if length(p_outcome) < 5 or length(p_outcome) > 2000 then return 'bad_outcome'; end if;
  update public.reports set status = p_status, outcome = p_outcome, handled_by = auth.uid(), handled_at = now()
   where id = p_id;
  if not found then return 'not_found'; end if;
  return 'ok';
end $$;
revoke execute on function public.admin_resolve_report(uuid, text, text) from public, anon;
grant   execute on function public.admin_resolve_report(uuid, text, text) to authenticated;

-- ---------- a ban always has a reason, and is dated ----------
create or replace function public.admin_set_ban(target uuid, ban boolean, reason text default null)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then return 'not_allowed'; end if;
  if target = auth.uid() then return 'cannot_ban_self'; end if;
  if ban then
    reason := btrim(coalesce(reason, ''));
    if length(reason) < 5 or length(reason) > 500 then return 'bad_reason'; end if;
    update public.profiles set banned = true, ban_reason = reason, banned_at = now(), updated_at = now() where id = target;
  else
    update public.profiles set banned = false, ban_reason = null, banned_at = null, updated_at = now() where id = target;
  end if;
  if not found then return 'not_found'; end if;
  return 'ok';
end $$;
revoke execute on function public.admin_set_ban(uuid, boolean, text) from public, anon;
grant   execute on function public.admin_set_ban(uuid, boolean, text) to authenticated;

-- ---------- retention: the privacy notice promises 24 months for the bad-actor flags ----------
create or replace function public.purge_old_records()
returns text language plpgsql security definer set search_path = public as $$
declare n1 int; n2 int;
begin
  delete from public.deleted_user_identifiers where deleted_at < now() - interval '24 months';
  get diagnostics n1 = row_count;
  delete from public.reports where status <> 'open' and created_at < now() - interval '24 months';
  get diagnostics n2 = row_count;
  return 'identifiers:' || n1 || ' reports:' || n2;
end $$;
revoke execute on function public.purge_old_records() from public, anon, authenticated;

-- keep the constraint honest for rows added from now on
alter table public.reports validate constraint reports_sane;

-- ---------- "verified client" now means something ----------
-- the badge is only shown when the pair actually had a contract on Cuvori that
-- got past acceptance; a review from someone who only sent a message shows no badge
alter table public.reviews add column if not exists via_contract boolean not null default false;

create or replace function public.reviews_mark_contract()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.via_contract := exists (
    select 1 from public.contracts c
     where c.editor = new.editor and c.client = new.client
       and c.status in ('accepted','paid_marked','paid','funded','delivered','disputed','releasing','resolving','completed','refunded')
  );
  return new;
end $$;
drop trigger if exists reviews_mark_contract on public.reviews;
create trigger reviews_mark_contract before insert or update on public.reviews
  for each row execute procedure public.reviews_mark_contract();

-- backfill the rows that already exist
update public.reviews r set via_contract = exists (
  select 1 from public.contracts c
   where c.editor = r.editor and c.client = r.client
     and c.status in ('accepted','paid_marked','paid','funded','delivered','disputed','releasing','resolving','completed','refunded'));

-- a contract reaching acceptance later should light up an existing review too
create or replace function public.contracts_touch_reviews()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status
     and new.status in ('accepted','paid_marked','paid','funded','delivered','disputed','releasing','resolving','completed','refunded') then
    update public.reviews set via_contract = true where editor = new.editor and client = new.client and via_contract = false;
  end if;
  return new;
end $$;
drop trigger if exists contracts_touch_reviews on public.contracts;
create trigger contracts_touch_reviews after update on public.contracts
  for each row execute procedure public.contracts_touch_reviews();
