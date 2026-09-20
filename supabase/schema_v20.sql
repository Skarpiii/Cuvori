-- ============================================================
-- Cuvori — schema v20: jobs a freelancer can trust.
-- "Is this job real? Is the client serious? Is it still active? Do they hire?
--  Is payment secured?" — answered on the card, before anyone applies.
-- Job states, expiry and renewal, public client history, Report job, an
-- identity-verification state (provider-based, minimal), duplicate / repeat /
-- risk detection with an admin review queue and an append-only audit trail,
-- posting limits, and a plan table so paid posting can come later without a rewrite.
-- Run AFTER schema_v19.sql. Re-runnable.
-- ============================================================
create extension if not exists pg_trgm with schema extensions;

-- ---------- settings the admin can change without code ----------
create table if not exists public.site_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
alter table public.site_settings enable row level security;
drop policy if exists "settings are readable" on public.site_settings;
create policy "settings are readable" on public.site_settings for select to anon, authenticated using (true);
insert into public.site_settings (key, value) values
  ('posting_rules', '{"require_identity": false, "expiry_days": 30, "daily_limit_new": 3, "daily_limit_verified": 10, "active_limit_new": 3, "active_limit_verified": 15, "duplicate_cooldown_days": 7, "auto_hide_score": 5}'::jsonb)
on conflict (key) do nothing;
create or replace function public.setting(p_key text)
returns jsonb language sql stable security definer set search_path = public as $$
  select value from public.site_settings where key = p_key;
$$;
grant execute on function public.setting(text) to anon, authenticated;
create or replace function public.admin_set_setting(p_key text, p_value jsonb)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then return 'forbidden'; end if;
  if p_key !~ '^[a-z_]{1,40}$' or p_value is null or pg_column_size(p_value) > 5000 then return 'bad_input'; end if;
  insert into public.site_settings (key, value, updated_by) values (p_key, p_value, auth.uid())
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = auth.uid();
  return 'ok';
end $$;
grant execute on function public.admin_set_setting(text, jsonb) to authenticated;

-- ---------- posting plans: free today; limited / one-off / subscription later, same table ----------
create table if not exists public.posting_plans (
  key            text primary key,
  label          text not null,
  free_posts     int,                        -- null = unlimited
  active_limit   int,                        -- null = the rule table decides
  price_cents    int not null default 0,
  period         text not null default 'none' check (period in ('none','post','month','year')),
  active         boolean not null default true
);
alter table public.posting_plans enable row level security;
drop policy if exists "plans are readable" on public.posting_plans;
create policy "plans are readable" on public.posting_plans for select to anon, authenticated using (true);
insert into public.posting_plans (key, label, free_posts, active_limit, price_cents, period) values ('free', 'Free', null, null, 0, 'none') on conflict (key) do nothing;
alter table public.profiles add column if not exists posting_plan text not null default 'free' references public.posting_plans(key);

-- ---------- identity verification: only the state, never the documents ----------
create table if not exists public.identity_verifications (
  user_id      uuid primary key references public.profiles(id) on delete cascade,
  provider     text not null default 'stripe_identity',
  status       text not null default 'none' check (status in ('none','pending','verified','failed')),
  provider_ref text,                         -- the provider's session id; nothing sensitive
  checked_at   timestamptz,
  updated_at   timestamptz not null default now()
);
alter table public.identity_verifications enable row level security;
drop policy if exists "own verification state" on public.identity_verifications;
create policy "own verification state" on public.identity_verifications for select to authenticated using (auth.uid() = user_id or public.is_admin());
-- verified = the provider said so (Stripe Identity), or Stripe Connect already checked this person as a payee
create or replace function public.is_verified(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.identity_verifications v where v.user_id = uid and v.status = 'verified')
      or exists (select 1 from public.payout_details p where p.id = uid and p.stripe_payouts_enabled);
$$;
grant execute on function public.is_verified(uuid) to anon, authenticated;
create or replace function public.identity_state(uid uuid)
returns text language sql stable security definer set search_path = public as $$
  select case when public.is_verified(uid) then 'verified' else coalesce((select status from public.identity_verifications v where v.user_id = uid), 'none') end;
$$;
grant execute on function public.identity_state(uuid) to anon, authenticated;
-- written by the payment functions (service role) and by an admin who saw proof elsewhere
create or replace function public.admin_set_identity(p_user uuid, p_status text, p_note text default null)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then return 'forbidden'; end if;
  if p_status not in ('none','pending','verified','failed') then return 'bad_input'; end if;
  insert into public.identity_verifications (user_id, provider, status, checked_at, updated_at) values (p_user, 'admin', p_status, now(), now())
  on conflict (user_id) do update set status = excluded.status, provider = 'admin', checked_at = now(), updated_at = now();
  insert into public.moderation_actions (target_user, admin, action, reason) values (p_user, auth.uid(), 'identity_' || p_status, left(coalesce(p_note, ''), 500));
  return 'ok';
end $$;

-- ---------- jobs: states, expiry, a numeric budget, moderation fields ----------
alter table public.jobs drop constraint if exists jobs_status_check;
alter table public.jobs add constraint jobs_status_check check (status in ('open','filled','closed','expired','hidden','removed'));
alter table public.jobs add column if not exists expires_at     timestamptz;
alter table public.jobs add column if not exists renewed_count  int not null default 0;
alter table public.jobs add column if not exists last_renewed_at timestamptz;
alter table public.jobs add column if not exists closed_at      timestamptz;
alter table public.jobs add column if not exists budget_cents   int;
alter table public.jobs add column if not exists fingerprint    text;
alter table public.jobs add column if not exists links          text[] not null default '{}';
alter table public.jobs add column if not exists risk_score     int not null default 0;
alter table public.jobs add column if not exists risk_flags     jsonb not null default '[]'::jsonb;
alter table public.jobs add column if not exists hidden_reason  text;
alter table public.jobs add column if not exists report_count   int not null default 0;
alter table public.jobs add column if not exists updated_at     timestamptz not null default now();
create index if not exists jobs_owner_idx on public.jobs(owner, created_at desc);
create index if not exists jobs_fingerprint_idx on public.jobs(fingerprint);
create index if not exists jobs_title_trgm on public.jobs using gin (lower(title) extensions.gin_trgm_ops);
update public.jobs set expires_at = created_at + interval '30 days' where expires_at is null;

-- an expired job is not public any more (the owner still sees it, can renew it)
drop policy if exists "open jobs are readable" on public.jobs;
create policy "open jobs are readable"
  on public.jobs for select to anon, authenticated
  using ((status = 'open' and (expires_at is null or expires_at > now()) and public.is_listed(owner)) or auth.uid() = owner or public.is_admin());
-- the owner edits text, not the moderation or counter columns
drop policy if exists "users manage own jobs" on public.jobs;
create policy "users manage own jobs"
  on public.jobs for all to authenticated
  using (auth.uid() = owner) with check (auth.uid() = owner and not public.is_banned(auth.uid()));
revoke update on public.jobs from authenticated;
grant update (title, description, location, remote, pricing, budget, deadline, category, profession_slug, details, role_needed) on public.jobs to authenticated;

-- ---------- reports, flags, audit ----------
create table if not exists public.job_reports (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.jobs(id) on delete cascade,
  reporter    uuid not null references public.profiles(id) on delete cascade,
  reason      text not null check (reason in ('scam','fake','spam','duplicate','payment','inappropriate','other')),
  note        text not null default '',
  created_at  timestamptz not null default now(),
  unique (job_id, reporter)
);
alter table public.job_reports enable row level security;
drop policy if exists "reporter and admin read job reports" on public.job_reports;
create policy "reporter and admin read job reports" on public.job_reports for select to authenticated using (auth.uid() = reporter or public.is_admin());

create table if not exists public.job_flags (
  id          bigserial primary key,
  job_id      uuid not null references public.jobs(id) on delete cascade,
  kind        text not null check (kind in ('duplicate','near_duplicate','repeat_no_hire','risk_text','links','reports','rate','manual')),
  detail      jsonb not null default '{}'::jsonb,
  score       int not null default 1,
  status      text not null default 'open' check (status in ('open','resolved')),
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid
);
create index if not exists job_flags_open_idx on public.job_flags(status, created_at desc);
alter table public.job_flags enable row level security;
drop policy if exists "admin reads job flags" on public.job_flags;
create policy "admin reads job flags" on public.job_flags for select to authenticated using (public.is_admin());

create table if not exists public.moderation_actions (
  id          bigserial primary key,
  job_id      uuid references public.jobs(id) on delete set null,
  target_user uuid,
  admin       uuid,
  action      text not null,
  reason      text not null default '',
  created_at  timestamptz not null default now()
);
alter table public.moderation_actions enable row level security;
drop policy if exists "admin reads moderation" on public.moderation_actions;
create policy "admin reads moderation" on public.moderation_actions for select to authenticated using (public.is_admin());
drop trigger if exists moderation_actions_no_edit on public.moderation_actions;
create trigger moderation_actions_no_edit before update or delete on public.moderation_actions
  for each row execute function public.order_events_immutable();
grant execute on function public.admin_set_identity(uuid, text, text) to authenticated;

-- ---------- what a freelancer may know about a client: facts, not a score ----------
create or replace function public.client_stats(uid uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare posted int; hires int; done int; since timestamptz; open_jobs int; ident text; days int;
begin
  select count(*), count(*) filter (where status = 'open' and (expires_at is null or expires_at > now())) into posted, open_jobs from public.jobs where owner = uid and status <> 'removed';
  -- a hire = an Order this client accepted and paid for (money confirmed or secured), whether or not it came from a job post
  select count(*) into hires from public.contracts c where c.client = uid and c.status in ('paid','funded','delivered','disputed','releasing','resolving','completed');
  select count(*) into done from public.contracts c where c.client = uid and c.status = 'completed';
  select created_at into since from public.profiles where id = uid;
  days := extract(day from now() - coalesce(since, now()))::int;
  ident := public.identity_state(uid);
  return jsonb_build_object('jobs_posted', posted, 'jobs_open', open_jobs, 'hires', hires, 'completed_orders', done,
                            'hire_rate', case when posted >= 3 then round(100.0 * least(hires, posted) / posted) end,
                            'member_since', to_char(since, 'YYYY-MM'), 'account_days', days, 'identity', ident,
                            'is_new', hires = 0 and (posted <= 2 or days < 30),      -- new is not suspicious: it is simply "no history yet"
                            'repeat_no_hire', posted >= 5 and hires = 0 and days >= 30);
end $$;
grant execute on function public.client_stats(uuid) to anon, authenticated;

-- payment secured = a protected-payment Order tied to this job that the provider actually funded
create or replace function public.job_payment_secured(p_job uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.contracts c where c.job_id = p_job and c.payment_mode = 'escrow' and c.funded_cents > 0
                 and c.status in ('funded','delivered','disputed','releasing','resolving','completed'));
$$;
grant execute on function public.job_payment_secured(uuid) to anon, authenticated;

-- the Browse jobs feed: public jobs with the trust facts attached, one call
create or replace function public.browse_jobs(p_limit int default 200)
returns table (id uuid, owner uuid, title text, role_needed text, profession_slug text, category text, description text, location text, remote boolean,
               pricing text, budget text, budget_cents int, deadline date, status text, created_at timestamptz, expires_at timestamptz, details jsonb, links text[],
               owner_name text, client jsonb, payment_secured boolean)
language sql stable security definer set search_path = public as $$
  select j.id, j.owner, j.title, j.role_needed, j.profession_slug, j.category, j.description, j.location, j.remote,
         j.pricing, j.budget, j.budget_cents, j.deadline, j.status, j.created_at, j.expires_at, j.details, j.links,
         coalesce(p.first_name, ''), public.client_stats(j.owner), public.job_payment_secured(j.id)
  from public.jobs j join public.profiles p on p.id = j.owner
  where j.status = 'open' and (j.expires_at is null or j.expires_at > now()) and public.is_listed(j.owner)
  order by j.created_at desc
  limit least(greatest(coalesce(p_limit, 200), 1), 500);
$$;
grant execute on function public.browse_jobs(int) to anon, authenticated;

-- the owner's own list: every state, with the reason when moderation stepped in
create or replace function public.my_jobs()
returns table (id uuid, title text, status text, created_at timestamptz, expires_at timestamptz, renewed_count int, hidden_reason text, report_count int,
               budget text, profession_slug text, hires int, payment_secured boolean)
language sql stable security definer set search_path = public as $$
  select j.id, j.title, case when j.status = 'open' and j.expires_at < now() then 'expired' else j.status end, j.created_at, j.expires_at, j.renewed_count, j.hidden_reason, j.report_count, j.budget, j.profession_slug,
         (select count(*)::int from public.contracts c where c.job_id = j.id and c.status in ('paid','funded','delivered','disputed','releasing','resolving','completed')),
         public.job_payment_secured(j.id)
  from public.jobs j where j.owner = auth.uid() order by j.created_at desc;
$$;
grant execute on function public.my_jobs() to authenticated;

-- ---------- helpers for the checks ----------
create or replace function public.job_fingerprint(p_title text, p_desc text)
returns text language sql immutable as $$
  select md5(btrim(regexp_replace(lower(coalesce(p_title, '') || ' ' || coalesce(p_desc, '')), '[^a-z0-9]+', ' ', 'g')));
$$;
create or replace function public.job_links(p_text text)
returns text[] language sql immutable as $$
  select coalesce(array(select distinct lower(m[1]) from regexp_matches(coalesce(p_text, ''), '(https?://[^\s"''<>)]+|www\.[^\s"''<>)]+|t\.me/[^\s]+|wa\.me/[^\s]+)', 'gi') m limit 20), '{}');
$$;
create or replace function public.job_budget_cents(p_budget text)
returns int language plpgsql immutable as $$
declare m text; d text;
begin
  m := (regexp_match(coalesce(p_budget, ''), '([0-9][0-9 .,'']*[0-9]|[0-9])'))[1];
  if m is null then return null; end if;
  m := regexp_replace(m, '[ '']', '', 'g');
  if m ~ '[.,]' then
    d := right(regexp_replace(m, '[^.,]', '', 'g'), 1);                       -- the last separator used
    if m ~ '\.' and m ~ ',' then m := replace(m, case when d = '.' then ',' else '.' end, '');   -- 1,200.50 / 1.200,50
    elsif length(m) - length(replace(m, d, '')) > 1 then m := replace(m, d, '');                -- 1,200,000
    elsif m ~ ('\' || d || '[0-9]{3}$') then m := replace(m, d, '');                            -- 1,200 / 1.200 = thousands
    end if;
    m := replace(m, ',', '.');
  end if;
  return least(round(m::numeric * 100), 100000000)::int;
exception when others then return null;
end $$;
-- what makes a text look like a scam. Each hit is a reason the admin can read; the score decides what happens.
create or replace function public.job_risk(p_title text, p_desc text, p_budget text, p_links text[])
returns jsonb language plpgsql immutable as $$
declare txt text := lower(coalesce(p_title, '') || ' ' || coalesce(p_desc, '')); hits jsonb := '[]'::jsonb; l text; b int;
begin
  if txt ~ '(telegram|whatsapp|signal|viber|wechat)' and txt ~ '(contact|write|message|dm|text|reach)' then hits := hits || jsonb_build_object('k', 'external_channel', 's', 2); end if;
  if txt ~ '(crypto|bitcoin|btc|usdt|ethereum|binance|wallet address|blockchain investment)' then hits := hits || jsonb_build_object('k', 'crypto', 's', 2); end if;
  if txt ~ '(registration fee|activation fee|training fee|pay (a |the )?(fee|deposit)|deposit (first|before)|buy (the )?(kit|equipment|software) first|send money first)' then hits := hits || jsonb_build_object('k', 'pay_to_work', 's', 4); end if;
  if txt ~ '(passport|id card|social security|ssn|bank login|credit card number|copy of (your )?id)' then hits := hits || jsonb_build_object('k', 'sensitive_info', 's', 3); end if;
  if txt ~ '(western union|moneygram|gift ?card|steam card|itunes card)' then hits := hits || jsonb_build_object('k', 'odd_payment', 's', 3); end if;
  if txt ~ '(outside (of )?cuvori|off(-| )platform|avoid (the )?(fee|escrow|platform)|pay(ment)? directly to avoid)' then hits := hits || jsonb_build_object('k', 'bypass_platform', 's', 2); end if;
  if txt ~ '(no experience (needed|required|necessary)|earn \$?€?[0-9]{3,} (per|a) (day|hour)|guaranteed income|work from home and earn)' then hits := hits || jsonb_build_object('k', 'too_good', 's', 2); end if;
  b := public.job_budget_cents(p_budget);
  if b is not null and b >= 2000000 and txt ~ '(simple|easy|quick|no experience)' then hits := hits || jsonb_build_object('k', 'unrealistic_pay', 's', 2); end if;
  foreach l in array coalesce(p_links, '{}') loop
    if l ~ '(bit\.ly|tinyurl|t\.me/|wa\.me/|cutt\.ly|rb\.gy|goo\.gl|is\.gd|\.xyz(/|$)|\.top(/|$)|\.click(/|$)|\.icu(/|$))' then hits := hits || jsonb_build_object('k', 'link:' || left(l, 60), 's', 2); end if;
  end loop;
  if coalesce(array_length(p_links, 1), 0) >= 5 then hits := hits || jsonb_build_object('k', 'many_links', 's', 1); end if;
  return jsonb_build_object('score', coalesce((select sum((h->>'s')::int) from jsonb_array_elements(hits) h), 0), 'hits', hits);
end $$;

-- ---------- the guard: limits, duplicates, risk — every insert and edit goes through here ----------
create or replace function public.jobs_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare err text; rules jsonb := coalesce(public.setting('posting_rules'), '{}'::jsonb); verified boolean; daily int; active_now int; lim int; dup record; risk jsonb;
  posted int; hires int; days int; plan public.posting_plans%rowtype;
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then new.created_at := now(); end if;
    if auth.uid() is not null and not public.is_admin() then new.status := 'open'; end if;   -- a member always starts a job as open
  else
    new.created_at := old.created_at;
    new.owner := old.owner;
    -- the moderation columns are not the owner's to change
    if not public.is_admin() and coalesce(current_setting('cuvori.job_admin', true), '') <> '1' then
      new.status := old.status; new.hidden_reason := old.hidden_reason; new.risk_score := old.risk_score; new.risk_flags := old.risk_flags;
      new.report_count := old.report_count; new.expires_at := old.expires_at; new.renewed_count := old.renewed_count; new.last_renewed_at := old.last_renewed_at; new.closed_at := old.closed_at;
    end if;
  end if;
  if new.profession_slug is null then
    new.profession_slug := case new.role_needed when 'videographer' then 'videographer' when 'photographer' then 'photographer' else 'video-editor' end;
  end if;
  if not exists (select 1 from public.professions p where p.slug = new.profession_slug and (p.active or public.is_admin())) then raise exception 'profession_not_open'; end if;
  new.role_needed := case new.profession_slug when 'videographer' then 'videographer' when 'photographer' then 'photographer' else 'editor' end;
  new.details := coalesce(new.details, '{}'::jsonb);
  if pg_column_size(new.details) > 5000 then raise exception 'details_too_big'; end if;
  err := public.service_values_error(new.profession_slug, new.details);
  if err is not null then raise exception '%', err; end if;
  new.updated_at := now();
  new.fingerprint := public.job_fingerprint(new.title, new.description);
  new.links := public.job_links(new.description);
  new.budget_cents := public.job_budget_cents(new.budget);

  if tg_op = 'INSERT' and auth.uid() is not null and not public.is_admin() then
    verified := public.is_verified(new.owner);
    if coalesce((rules->>'require_identity')::boolean, false) and not verified then raise exception 'identity_required'; end if;
    select * into plan from public.posting_plans where key = coalesce((select posting_plan from public.profiles where id = new.owner), 'free');
    -- how many today, how many open right now
    select count(*) into daily from public.jobs where owner = new.owner and created_at > now() - interval '1 day';
    lim := coalesce(nullif(rules->>(case when verified then 'daily_limit_verified' else 'daily_limit_new' end), '')::int, 10);
    if daily >= lim then raise exception 'job_daily_limit'; end if;
    select count(*) into active_now from public.jobs where owner = new.owner and status = 'open' and (expires_at is null or expires_at > now());
    lim := coalesce(plan.active_limit, nullif(rules->>(case when verified then 'active_limit_verified' else 'active_limit_new' end), '')::int, 15);
    if active_now >= lim then raise exception 'job_active_limit'; end if;
    if plan.free_posts is not null then
      select count(*) into posted from public.jobs where owner = new.owner;
      if posted >= plan.free_posts then raise exception 'job_plan_limit'; end if;
    end if;
    -- the same job again within the cooldown: edit or renew the first one instead
    select id, created_at into dup from public.jobs where owner = new.owner and fingerprint = new.fingerprint and status in ('open','hidden')
      and created_at > now() - (coalesce(nullif(rules->>'duplicate_cooldown_days', '')::int, 7) || ' days')::interval limit 1;
    if dup.id is not null then raise exception 'duplicate_cooldown'; end if;
    perform public.rate_limit('job_day', 10, interval '1 day');
    new.expires_at := now() + (coalesce(nullif(rules->>'expiry_days', '')::int, 30) || ' days')::interval;
  end if;

  -- risk: text, links, repeats. Flags go to the review queue; a high score hides the job until an admin looks.
  if tg_op = 'INSERT' or new.title is distinct from old.title or new.description is distinct from old.description or new.budget is distinct from old.budget then
    risk := public.job_risk(new.title, new.description, new.budget, new.links);
    new.risk_score := (risk->>'score')::int; new.risk_flags := risk->'hits';
    if tg_op = 'INSERT' and not public.is_admin() then
      if new.risk_score >= coalesce(nullif(rules->>'auto_hide_score', '')::int, 5) then new.status := 'hidden'; new.hidden_reason := 'auto_review'; end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists jobs_guard on public.jobs;
create trigger jobs_guard before insert or update on public.jobs for each row execute procedure public.jobs_guard();

-- after the row exists: write the flags the admin queue shows (needs the id)
create or replace function public.jobs_after_write()
returns trigger language plpgsql security definer set search_path = public as $$
declare r record; n int; st jsonb;
begin
  if tg_op = 'UPDATE' and new.title is not distinct from old.title and new.description is not distinct from old.description and new.budget is not distinct from old.budget then return new; end if;
  delete from public.job_flags where job_id = new.id and status = 'open' and kind in ('duplicate','near_duplicate','risk_text','links','repeat_no_hire');
  if new.risk_score > 0 then
    insert into public.job_flags (job_id, kind, detail, score)
    select new.id, case when h->>'k' like 'link:%' then 'links' else 'risk_text' end, jsonb_build_object('hit', h->>'k'), (h->>'s')::int from jsonb_array_elements(new.risk_flags) h;
  end if;
  -- the same or nearly the same text as another job of this owner in the last 90 days
  for r in select j.id, j.title, j.created_at, j.status, (j.fingerprint = new.fingerprint) as exact,
                  extensions.similarity(lower(j.title), lower(new.title)) as ts
             from public.jobs j where j.owner = new.owner and j.id <> new.id and j.created_at > now() - interval '90 days' and j.status <> 'removed'
  loop
    if r.exact then insert into public.job_flags (job_id, kind, detail, score) values (new.id, 'duplicate', jsonb_build_object('other', r.id, 'title', r.title, 'at', r.created_at, 'other_status', r.status), 2);
    elsif r.ts >= 0.6 then insert into public.job_flags (job_id, kind, detail, score) values (new.id, 'near_duplicate', jsonb_build_object('other', r.id, 'title', r.title, 'at', r.created_at, 'similarity', round(r.ts::numeric, 2), 'other_status', r.status), 1);
    end if;
  end loop;
  -- many posts, never a hire: a signal, not a verdict (new clients are simply new)
  st := public.client_stats(new.owner);
  if (st->>'repeat_no_hire')::boolean then
    insert into public.job_flags (job_id, kind, detail, score) values (new.id, 'repeat_no_hire', jsonb_build_object('jobs_posted', st->'jobs_posted', 'hires', st->'hires', 'account_days', st->'account_days'), 2);
  end if;
  return new;
end $$;
drop trigger if exists jobs_after_write on public.jobs;
create trigger jobs_after_write after insert or update on public.jobs for each row execute procedure public.jobs_after_write();

-- ---------- what the owner can do: filled / closed / reopen / renew ----------
create or replace function public.set_job_status(p_job uuid, p_status text)
returns text language plpgsql security definer set search_path = public as $$
declare j public.jobs%rowtype;
begin
  if auth.uid() is null then return 'not_signed_in'; end if;
  select * into j from public.jobs where id = p_job and owner = auth.uid() for update;
  if not found then return 'not_found'; end if;
  if p_status not in ('filled','closed','open') then return 'bad_input'; end if;
  if j.status in ('hidden','removed') then return 'under_review'; end if;
  if p_status = 'open' and j.status not in ('filled','closed','expired') then return 'not_allowed'; end if;
  begin perform public.rate_limit('job_action', 60, interval '1 hour'); exception when others then return 'rate_limited'; end;
  perform set_config('cuvori.job_admin', '1', true);
  if p_status = 'open' then
    update public.jobs set status = 'open', closed_at = null, expires_at = now() + (coalesce(nullif(public.setting('posting_rules')->>'expiry_days', '')::int, 30) || ' days')::interval,
           renewed_count = renewed_count + 1, last_renewed_at = now() where id = p_job;
  else
    update public.jobs set status = p_status, closed_at = now() where id = p_job;
  end if;
  return 'ok';
end $$;
grant execute on function public.set_job_status(uuid, text) to authenticated;

create or replace function public.renew_job(p_job uuid)
returns text language plpgsql security definer set search_path = public as $$
declare j public.jobs%rowtype;
begin
  if auth.uid() is null then return 'not_signed_in'; end if;
  select * into j from public.jobs where id = p_job and owner = auth.uid() for update;
  if not found then return 'not_found'; end if;
  if j.status not in ('open','expired') then return 'not_allowed'; end if;
  if j.renewed_count >= 12 then return 'too_many_renewals'; end if;
  begin perform public.rate_limit('job_action', 60, interval '1 hour'); exception when others then return 'rate_limited'; end;
  perform set_config('cuvori.job_admin', '1', true);
  update public.jobs set status = 'open', expires_at = now() + (coalesce(nullif(public.setting('posting_rules')->>'expiry_days', '')::int, 30) || ' days')::interval,
         renewed_count = renewed_count + 1, last_renewed_at = now() where id = p_job;
  return 'ok';
end $$;
grant execute on function public.renew_job(uuid) to authenticated;

-- run now and then (the hourly payment function calls it; harmless to run by hand): open jobs past their date expire
create or replace function public.expire_jobs()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform set_config('cuvori.job_admin', '1', true);
  with x as (update public.jobs set status = 'expired' where status = 'open' and expires_at is not null and expires_at < now() returning 1) select count(*) into n from x;
  return n;
end $$;
revoke execute on function public.expire_jobs() from public, anon, authenticated;
grant execute on function public.expire_jobs() to service_role;

-- a hire made through a job post fills the job
create or replace function public.contracts_fill_job()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.job_id is not null and new.status in ('paid','funded') and (old.status is distinct from new.status) then
    perform set_config('cuvori.job_admin', '1', true);
    update public.jobs set status = 'filled', closed_at = now() where id = new.job_id and status = 'open';
  end if;
  return new;
end $$;
drop trigger if exists contracts_fill_job on public.contracts;
create trigger contracts_fill_job after update on public.contracts for each row execute procedure public.contracts_fill_job();

-- ---------- Report job ----------
create or replace function public.report_job(p_job uuid, p_reason text, p_note text default '')
returns text language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); j public.jobs%rowtype; n int;
begin
  if me is null then return 'not_signed_in'; end if;
  if public.is_banned(me) then return 'banned'; end if;
  if p_reason not in ('scam','fake','spam','duplicate','payment','inappropriate','other') then return 'bad_input'; end if;
  if length(coalesce(p_note, '')) > 1000 then return 'note_too_long'; end if;
  select * into j from public.jobs where id = p_job;
  if not found or j.owner = me then return 'not_found'; end if;
  begin perform public.rate_limit('job_report', 20, interval '1 day'); exception when others then return 'rate_limited'; end;
  insert into public.job_reports (job_id, reporter, reason, note) values (p_job, me, p_reason, coalesce(p_note, ''))
  on conflict (job_id, reporter) do update set reason = excluded.reason, note = excluded.note, created_at = now();
  select count(distinct reporter) into n from public.job_reports where job_id = p_job;
  perform set_config('cuvori.job_admin', '1', true);
  update public.jobs set report_count = n where id = p_job;
  -- one report is an opinion; three independent ones move the job up the review queue
  if not exists (select 1 from public.job_flags where job_id = p_job and kind = 'reports' and status = 'open') then
    insert into public.job_flags (job_id, kind, detail, score) values (p_job, 'reports', jsonb_build_object('reports', n), case when n >= 3 then 3 else 1 end);
  else
    update public.job_flags set detail = jsonb_build_object('reports', n), score = case when n >= 3 then 3 else 1 end where job_id = p_job and kind = 'reports' and status = 'open';
  end if;
  return 'ok';
end $$;
grant execute on function public.report_job(uuid, text, text) to authenticated;

-- ---------- the admin queue and its actions ----------
create or replace function public.admin_job_queue()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(row order by (row->>'score')::int desc, row->>'last_flag' desc), '[]'::jsonb) from (
    select jsonb_build_object('job', to_jsonb(j) - 'fingerprint', 'owner_name', p.first_name, 'owner_email', p.email, 'owner_banned', p.banned,
             'client', public.client_stats(j.owner),
             'flags', (select jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'detail', f.detail, 'score', f.score, 'at', f.created_at) order by f.created_at) from public.job_flags f where f.job_id = j.id and f.status = 'open'),
             'score', (select coalesce(sum(f.score), 0) from public.job_flags f where f.job_id = j.id and f.status = 'open'),
             'last_flag', (select max(f.created_at) from public.job_flags f where f.job_id = j.id and f.status = 'open'),
             'reports', (select jsonb_agg(jsonb_build_object('reason', r.reason, 'note', r.note, 'at', r.created_at, 'reporter', pr.first_name) order by r.created_at desc) from public.job_reports r join public.profiles pr on pr.id = r.reporter where r.job_id = j.id),
             'history', (select jsonb_agg(jsonb_build_object('id', o.id, 'title', o.title, 'status', o.status, 'at', o.created_at) order by o.created_at desc) from (select * from public.jobs o where o.owner = j.owner and o.id <> j.id order by o.created_at desc limit 10) o),
             'actions', (select jsonb_agg(jsonb_build_object('action', m.action, 'reason', m.reason, 'at', m.created_at) order by m.created_at desc) from public.moderation_actions m where m.job_id = j.id)) as row
    from public.jobs j join public.profiles p on p.id = j.owner
    where public.is_admin() and (exists (select 1 from public.job_flags f where f.job_id = j.id and f.status = 'open') or j.status = 'hidden')
  ) q;
$$;
grant execute on function public.admin_job_queue() to authenticated;

create or replace function public.admin_job_action(p_job uuid, p_action text, p_reason text default '')
returns text language plpgsql security definer set search_path = public as $$
declare j public.jobs%rowtype; adm uuid := auth.uid();
begin
  if not public.is_admin() then return 'forbidden'; end if;
  select * into j from public.jobs where id = p_job for update;
  if not found then return 'not_found'; end if;
  if p_action not in ('approve','hide','remove','warn','suspend','false_positive','unhide') then return 'bad_input'; end if;
  p_reason := left(coalesce(p_reason, ''), 1000);
  perform set_config('cuvori.job_admin', '1', true);
  if p_action in ('approve','false_positive') then
    update public.job_flags set status = 'resolved', resolved_at = now(), resolved_by = adm where job_id = p_job and status = 'open';
    if j.status = 'hidden' then update public.jobs set status = 'open', hidden_reason = null where id = p_job; end if;
  elsif p_action = 'hide' then
    if p_reason = '' then return 'reason_required'; end if;
    update public.jobs set status = 'hidden', hidden_reason = p_reason where id = p_job;
  elsif p_action = 'unhide' then
    update public.jobs set status = 'open', hidden_reason = null where id = p_job;
  elsif p_action = 'remove' then
    if p_reason = '' then return 'reason_required'; end if;
    update public.jobs set status = 'removed', hidden_reason = p_reason, closed_at = now() where id = p_job;
    update public.job_flags set status = 'resolved', resolved_at = now(), resolved_by = adm where job_id = p_job and status = 'open';
  elsif p_action = 'warn' then
    if p_reason = '' then return 'reason_required'; end if;
    perform public.admin_message_user(j.owner, 'About your job "' || left(j.title, 80) || '": ' || p_reason);
  elsif p_action = 'suspend' then
    if length(p_reason) < 5 then return 'reason_required'; end if;
    update public.profiles set banned = true, ban_reason = p_reason where id = j.owner;
    update public.jobs set status = 'hidden', hidden_reason = 'account_suspended' where owner = j.owner and status = 'open';
  end if;
  insert into public.moderation_actions (job_id, target_user, admin, action, reason) values (p_job, j.owner, adm, p_action, p_reason);
  return 'ok';
end $$;
grant execute on function public.admin_job_action(uuid, text, text) to authenticated;

-- a note from the administrator lands in the user's inbox like everything else
create or replace function public.admin_message_user(p_user uuid, p_text text)
returns text language plpgsql security definer set search_path = public as $$
declare adm uuid := auth.uid(); a uuid; b uuid; cid uuid;
begin
  if not public.is_admin() or p_user is null or p_user = adm then return 'forbidden'; end if;
  if adm < p_user then a := adm; b := p_user; else a := p_user; b := adm; end if;
  select id into cid from public.conversations where user_a = a and user_b = b;
  if cid is null then insert into public.conversations (user_a, user_b) values (a, b) returning id into cid; end if;
  insert into public.messages (conversation_id, sender, kind, body) values (cid, adm, 'text', left(coalesce(p_text, ''), 4000));
  update public.conversations set last_message_at = now() where id = cid;
  return 'ok';
end $$;
grant execute on function public.admin_message_user(uuid, text) to authenticated;

-- messages can carry a job-report card too (not used yet; keeps the check honest)
alter table public.messages drop constraint if exists messages_kind_check;
alter table public.messages add constraint messages_kind_check check (kind in ('text','report','change_request','contract'));

-- ---------- existing rows ----------
update public.jobs set fingerprint = public.job_fingerprint(title, description), links = public.job_links(description), budget_cents = public.job_budget_cents(budget) where fingerprint is null;
