-- ============================================================
-- Cuvori — schema v15: professions as data.
-- Run AFTER schema_v14.sql, then run professions_seed.sql. Re-runnable.
--
-- Nothing here deletes or rewrites existing data. editor_profiles keeps working as
-- the common profile; a professional's per-profession offer (price, specialisms,
-- software …) lives in services, one row per profession. Existing editors are copied
-- into services by the migration at the bottom, and a copy of the touched tables is
-- kept inside the database first so the whole thing can be undone.
-- ============================================================

alter table public.profiles add column if not exists visibility text not null default 'public';

-- ---------- backup first (inside the database; drop these tables when you are sure) ----------
create table if not exists public.backup_v15_editor_profiles as select * from public.editor_profiles;
create table if not exists public.backup_v15_projects        as select * from public.projects;
create table if not exists public.backup_v15_jobs            as select * from public.jobs;
alter table public.backup_v15_editor_profiles enable row level security;
alter table public.backup_v15_projects        enable row level security;
alter table public.backup_v15_jobs            enable row level security;
revoke all on public.backup_v15_editor_profiles, public.backup_v15_projects, public.backup_v15_jobs from anon, authenticated;

-- ---------- configuration tables (readable by everyone, written only through admin RPCs) ----------
create table if not exists public.profession_groups (
  slug   text primary key,
  labels jsonb not null default '{}'::jsonb,            -- {"en":"Video & media","lt":…}
  sort_order int not null default 100
);
create table if not exists public.professions (
  slug           text primary key,                      -- 'video-editor': the stable id, never translated
  group_slug     text references public.profession_groups(slug) on delete set null,
  sort_order     int not null default 100,
  active         boolean not null default false,        -- open for professionals to join. Clients only see it once
                                                        -- at least one public professional offers it (computed, not a flag)
  invite_only    boolean not null default true,         -- kept per profession so it can be relaxed one at a time later
  pricing_units  text[] not null default '{hour,project,day}',
  portfolio_kind text not null default 'video' check (portfolio_kind in ('video','image','audio','link','mixed')),
  labels         jsonb not null default '{}'::jsonb,
  synonyms       text[] not null default '{}',          -- what people type into search
  created_at     timestamptz not null default now()
);
create table if not exists public.filters (
  key          text primary key,                        -- 'software', 'shoot_type' …
  kind         text not null check (kind in ('price','languages','location','availability','multi','single','bool','range','tags')),
  match        text not null default 'any' check (match in ('any','all')),
  options      jsonb not null default '[]'::jsonb,      -- [{"key":"davinci_resolve","labels":{"en":…}}]
  min_value    numeric, max_value numeric, unit text,
  labels       jsonb not null default '{}'::jsonb,
  admin_edited boolean not null default false,          -- once an admin touches options, the seed stops overwriting them
  sort_order   int not null default 100
);
create table if not exists public.profession_filters (
  profession_slug text not null references public.professions(slug) on delete cascade,
  filter_key      text not null references public.filters(key) on delete cascade,
  sort_order      int not null default 100,
  primary_filter  boolean not null default false,       -- in the chip row; the rest sit behind "View all filters"
  profile_field   boolean not null default true,        -- asked for in Edit profile
  primary key (profession_slug, filter_key)
);
create table if not exists public.price_units (
  key    text primary key,                              -- hour, day, project, session, word
  labels jsonb not null default '{}'::jsonb
);
alter table public.profession_groups  enable row level security;
alter table public.professions        enable row level security;
alter table public.filters            enable row level security;
alter table public.profession_filters enable row level security;
alter table public.price_units        enable row level security;
do $$ declare t text;
begin
  foreach t in array array['profession_groups','professions','filters','profession_filters','price_units'] loop
    execute format('drop policy if exists "config is readable" on public.%I', t);
    execute format('create policy "config is readable" on public.%I for select to anon, authenticated using (true)', t);
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', t);
  end loop;
end $$;
create index if not exists professions_active_idx on public.professions(active, sort_order);

-- ---------- what a professional offers ----------
create table if not exists public.services (
  id              uuid primary key default gen_random_uuid(),
  profile_id      uuid not null references public.profiles(id) on delete cascade,
  profession_slug text not null references public.professions(slug),
  rate_amount     numeric(10,2),
  rate_unit       text not null default 'hour',
  currency        text not null default 'EUR',
  headline        text not null default '',
  values          jsonb not null default '{}'::jsonb,   -- {"video_specialty":["catShorts"],"software":["davinci_resolve"],"turnaround_days":3}
  is_public       boolean not null default true,
  sort_order      int not null default 0,               -- 0 = the main service, whose price the old columns mirror
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (profile_id, profession_slug)
);
create index if not exists services_values_gin  on public.services using gin (values);
create index if not exists services_browse_idx  on public.services (profession_slug, rate_amount) where is_public;
create index if not exists services_profile_idx on public.services (profile_id, sort_order);
alter table public.services enable row level security;

drop policy if exists "public services are readable" on public.services;
create policy "public services are readable" on public.services for select to anon, authenticated
  using (is_public = true or auth.uid() = profile_id);
drop policy if exists "professionals insert own services" on public.services;
create policy "professionals insert own services" on public.services for insert to authenticated
  with check (auth.uid() = profile_id and public.is_editor(auth.uid()));
drop policy if exists "professionals update own services" on public.services;
create policy "professionals update own services" on public.services for update to authenticated
  using (auth.uid() = profile_id) with check (auth.uid() = profile_id and public.is_editor(auth.uid()));
drop policy if exists "professionals delete own services" on public.services;
create policy "professionals delete own services" on public.services for delete to authenticated
  using (auth.uid() = profile_id);
revoke insert, update on public.services from anon, authenticated;
grant insert (profile_id, profession_slug, rate_amount, rate_unit, headline, values, is_public, sort_order, updated_at) on public.services to authenticated;
grant update (rate_amount, rate_unit, headline, values, is_public, sort_order, updated_at) on public.services to authenticated;

-- the values a service may carry are exactly the profession's filters, with the right shape
create or replace function public.service_values_error(p_prof text, v jsonb)
returns text language plpgsql stable as $$
declare kv record; f public.filters%rowtype; n int; elem jsonb;
begin
  if v is null or jsonb_typeof(v) <> 'object' then return 'values_not_object'; end if;
  if pg_column_size(v) > 20000 then return 'values_too_big'; end if;
  for kv in select key, value from jsonb_each(v) loop
    select f2.* into f from public.filters f2
      join public.profession_filters pf on pf.filter_key = f2.key and pf.profession_slug = p_prof
     where f2.key = kv.key;
    if not found then return 'unknown_field:' || kv.key; end if;
    if f.kind in ('price','languages','location','availability') then return 'not_a_value:' || kv.key; end if;
    if f.kind in ('multi','tags') then
      if jsonb_typeof(kv.value) <> 'array' then return 'not_a_list:' || kv.key; end if;
      if jsonb_array_length(kv.value) > 30 then return 'too_many:' || kv.key; end if;
      for elem in select e from jsonb_array_elements(kv.value) e loop
        if jsonb_typeof(elem) <> 'string' then return 'bad_item:' || kv.key; end if;
        if f.kind = 'multi' and not exists (select 1 from jsonb_array_elements(f.options) o where o->>'key' = (elem #>> '{}')) then
          return 'unknown_option:' || kv.key || '=' || (elem #>> '{}');
        end if;
        if f.kind = 'tags' and (length(elem #>> '{}') > 40 or (elem #>> '{}') ~ '[<>]') then return 'bad_tag:' || kv.key; end if;
      end loop;
    elsif f.kind = 'single' then
      if jsonb_typeof(kv.value) <> 'string' then return 'not_text:' || kv.key; end if;
      if not exists (select 1 from jsonb_array_elements(f.options) o where o->>'key' = (kv.value #>> '{}')) then return 'unknown_option:' || kv.key; end if;
    elsif f.kind = 'bool' then
      if jsonb_typeof(kv.value) <> 'boolean' then return 'not_boolean:' || kv.key; end if;
    elsif f.kind = 'range' then
      if jsonb_typeof(kv.value) <> 'number' then return 'not_number:' || kv.key; end if;
      if (f.min_value is not null and (kv.value #>> '{}')::numeric < f.min_value)
         or (f.max_value is not null and (kv.value #>> '{}')::numeric > f.max_value) then return 'out_of_range:' || kv.key; end if;
    end if;
  end loop;
  return null;
end $$;

create or replace function public.services_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare p public.professions%rowtype; err text; legacy_role text;
begin
  select * into p from public.professions where slug = new.profession_slug;
  if not found then raise exception 'unknown_profession'; end if;
  if tg_op = 'INSERT' and not p.active and not public.is_admin() then raise exception 'profession_not_open'; end if;
  if not (new.rate_unit = any (p.pricing_units)) then raise exception 'bad_unit'; end if;
  if new.rate_amount is not null and (new.rate_amount < 0 or new.rate_amount > 100000) then raise exception 'bad_price'; end if;
  if length(new.headline) > 120 or new.headline ~ '[<>]' then raise exception 'bad_headline'; end if;
  if new.currency <> 'EUR' then raise exception 'bad_currency'; end if;
  err := public.service_values_error(new.profession_slug, new.values);
  if err is not null then raise exception '%', err; end if;
  new.updated_at := now();
  if tg_op = 'INSERT' then new.created_at := now(); end if;
  return new;
end $$;
drop trigger if exists services_guard on public.services;
create trigger services_guard before insert or update on public.services for each row execute procedure public.services_guard();

-- the old columns on editor_profiles keep mirroring the main service, so everything that
-- still reads rate_amount / specializations / tools / role_label (cards, contracts, admin lists)
-- keeps working while it is moved over
create or replace function public.services_mirror()
returns trigger language plpgsql security definer set search_path = public as $$
declare s public.services%rowtype; sw text[]; sk text[]; spec text[]; lr text; pid uuid;
begin
  pid := coalesce(new.profile_id, old.profile_id);
  select * into s from public.services where profile_id = pid order by sort_order, created_at limit 1;
  if not found then return null; end if;
  lr := case s.profession_slug when 'videographer' then 'videographer' when 'photographer' then 'photographer' else 'editor' end;
  select coalesce(array_agg(o->>'labels'), '{}') into sw from jsonb_array_elements(coalesce(s.values->'software','[]')) x
    join jsonb_array_elements((select options from public.filters where key = 'software')) o on o->>'key' = (x #>> '{}');
  sw := (select coalesce(array_agg((l::jsonb)->>'en'), '{}') from unnest(sw) l);
  select coalesce(array_agg(x #>> '{}'), '{}') into sk from jsonb_array_elements(coalesce(s.values->'skills','[]')) x;
  sk := (select coalesce(array_agg(o->'labels'->>'en'), '{}') from jsonb_array_elements(coalesce(s.values->'video_skills','[]')) x
           join jsonb_array_elements((select options from public.filters where key = 'video_skills')) o on o->>'key' = (x #>> '{}')) || sk;
  select coalesce(array_agg(x #>> '{}'), '{}') into spec from jsonb_array_elements(coalesce(s.values->'video_specialty','[]')) x
    where (x #>> '{}') = any (public.cat_keys());
  update public.editor_profiles set
    rate_amount = s.rate_amount,
    rate_unit   = case when s.rate_unit in ('hour','project','day') then s.rate_unit else rate_unit end,
    -- one service: the label follows it. Several (an old editor_photographer): the legacy label stays until the multi-service profile is proven
    role_label  = case when (select count(*) from public.services x where x.profile_id = pid) = 1 then lr else role_label end,
    specializations = case when spec = '{}' then specializations else spec end,
    tools       = case when (sw || sk) = '{}' then tools else (sw || sk)[1:60] end,
    turnaround_days = coalesce((s.values->>'turnaround_days')::int, turnaround_days),
    updated_at  = now()
  where id = pid;
  return null;
end $$;
drop trigger if exists services_mirror on public.services;
create trigger services_mirror after insert or update or delete on public.services for each row execute procedure public.services_mirror();

-- ---------- portfolio and jobs: the columns the next phases need, harmless now ----------
alter table public.projects add column if not exists kind text not null default 'video';
alter table public.projects drop constraint if exists projects_kind_check;
alter table public.projects add constraint projects_kind_check check (kind in ('video','image','audio','document','link','text'));
alter table public.jobs add column if not exists profession_slug text references public.professions(slug);
alter table public.jobs add column if not exists details jsonb not null default '{}'::jsonb;
create index if not exists jobs_profession_idx on public.jobs(profession_slug, status, created_at desc);

-- ---------- one call gives the page everything it needs to draw professions and filters ----------
-- professional_count = public professionals offering it; the public selector shows a profession
-- only when active and professional_count > 0. Admin and onboarding see the whole list.
create or replace function public.profession_config()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'groups', (select coalesce(jsonb_agg(jsonb_build_object('slug', g.slug, 'labels', g.labels, 'sort_order', g.sort_order) order by g.sort_order, g.slug), '[]'::jsonb) from public.profession_groups g),
    'professions', (select coalesce(jsonb_agg(jsonb_build_object(
        'slug', p.slug, 'group_slug', p.group_slug, 'sort_order', p.sort_order, 'active', p.active, 'invite_only', p.invite_only,
        'pricing_units', to_jsonb(p.pricing_units), 'portfolio_kind', p.portfolio_kind, 'labels', p.labels, 'synonyms', to_jsonb(p.synonyms),
        'professional_count', (select count(*) from public.services s join public.editor_profiles e on e.id = s.profile_id join public.profiles pr on pr.id = e.id
                               where s.profession_slug = p.slug and s.is_public and e.is_public and not pr.banned)
      ) order by p.sort_order, p.slug), '[]'::jsonb) from public.professions p),
    'filters', (select coalesce(jsonb_agg(jsonb_build_object('key', f.key, 'kind', f.kind, 'match', f.match, 'options', f.options,
        'min_value', f.min_value, 'max_value', f.max_value, 'unit', f.unit, 'labels', f.labels) order by f.sort_order, f.key), '[]'::jsonb) from public.filters f),
    'profession_filters', (select coalesce(jsonb_agg(jsonb_build_object('profession_slug', pf.profession_slug, 'filter_key', pf.filter_key,
        'sort_order', pf.sort_order, 'primary_filter', pf.primary_filter, 'profile_field', pf.profile_field) order by pf.profession_slug, pf.sort_order), '[]'::jsonb) from public.profession_filters pf),
    'units', (select coalesce(jsonb_object_agg(u.key, u.labels), '{}'::jsonb) from public.price_units u)
  );
$$;
grant execute on function public.profession_config() to anon, authenticated;

-- ---------- search: the filters are applied in the database, against structured values ----------
-- p_filters is {"price":{"min":20,"max":40,"unit":"hour"}, "languages":["English","German"],
--               "location":{"country":"Germany","city":""}, "availability":"open",
--               "video_specialty":["catShorts","catYoutubeLong"], "software":["davinci_resolve"], "turnaround_days":{"max":3}, "remote":true}
-- Within one multi filter a professional needs any of the chosen options (or all, when the filter says match=all);
-- across filters everything must hold. Nothing is ever dropped to make the list look fuller.
create or replace function public.search_professionals(p_profession text default null, p_filters jsonb default '{}'::jsonb, p_q text default '', p_limit int default 60, p_offset int default 0)
returns table (
  service_id uuid, profile_id uuid, profession_slug text, rate_amount numeric, rate_unit text, headline text, "values" jsonb,
  display_name text, role_label text, city text, country text, languages text[], bio text, tools text[], specializations text[], credentials jsonb,
  responds_hours int, turnaround_days int, revisions int, availability text, free_from date, availability_set_at timestamptz, last_active_on date,
  is_public boolean, created_at timestamptz, rating numeric, review_count bigint, total_count bigint
) language sql stable security definer set search_path = public as $$
  with f as (select coalesce(p_filters, '{}'::jsonb) as j),
  hits as (
    select s.id as service_id, s.profile_id, s.profession_slug, s.rate_amount, s.rate_unit, s.headline, s.values,
           e.display_name, e.role_label, e.city, e.country, e.languages, e.bio, e.tools, e.specializations, e.credentials,
           e.responds_hours, e.turnaround_days, e.revisions, e.availability, e.free_from, e.availability_set_at, e.last_active_on,
           e.is_public, e.created_at,
           (select round(avg(r.stars)::numeric, 1) from public.reviews r join public.profiles rc on rc.id = r.client where r.editor = e.id and not rc.banned and coalesce(rc.visibility,'public') = 'public') as rating,
           (select count(*) from public.reviews r join public.profiles rc on rc.id = r.client where r.editor = e.id and not rc.banned and coalesce(rc.visibility,'public') = 'public') as review_count
    from public.services s
    join public.editor_profiles e on e.id = s.profile_id
    join public.profiles pr on pr.id = e.id
    join public.professions p on p.slug = s.profession_slug
    cross join f
    where s.is_public and e.is_public and not pr.banned and coalesce(pr.visibility, 'public') = 'public' and p.active
      and (p_profession is null or s.profession_slug = p_profession)
      -- price
      and (f.j->'price'->>'min' is null or s.rate_amount >= (f.j->'price'->>'min')::numeric)
      and (f.j->'price'->>'max' is null or s.rate_amount <= (f.j->'price'->>'max')::numeric)
      and (coalesce(f.j->'price'->>'unit','') = '' or s.rate_unit = f.j->'price'->>'unit')
      -- languages: all of them
      and (f.j->'languages' is null or jsonb_array_length(f.j->'languages') = 0
           or e.languages @> (select coalesce(array_agg(x), '{}') from jsonb_array_elements_text(f.j->'languages') x))
      -- location
      and (coalesce(f.j->'location'->>'country','') = '' or e.country ilike '%' || (f.j->'location'->>'country') || '%')
      and (coalesce(f.j->'location'->>'city','') = '' or e.city ilike '%' || (f.j->'location'->>'city') || '%')
      -- availability
      and (f.j->>'availability' is distinct from 'open' or public.editor_is_open(e.availability, e.free_from, e.availability_set_at))
      -- every remaining key: matched by its filter definition; a filter the profession does not have simply cannot match
      and not exists (
        select 1 from jsonb_each(f.j) kv
        join public.filters fd on fd.key = kv.key
        where kv.key not in ('price','languages','location','availability')
          and not coalesce(case fd.kind
            when 'multi'  then case when jsonb_typeof(kv.value) <> 'array' or jsonb_array_length(kv.value) = 0 then true
                                    when fd.match = 'all' then coalesce(s.values->kv.key, '[]'::jsonb) @> kv.value
                                    else exists (select 1 from jsonb_array_elements_text(kv.value) v where coalesce(s.values->kv.key, '[]'::jsonb) ? v) end
            when 'single' then s.values->>kv.key = (kv.value #>> '{}')
            when 'bool'   then (kv.value #>> '{}') <> 'true' or coalesce((s.values->>kv.key)::boolean, false)
            when 'range'  then (s.values ? kv.key)
                               and (kv.value->>'min' is null or (s.values->>kv.key)::numeric >= (kv.value->>'min')::numeric)
                               and (kv.value->>'max' is null or (s.values->>kv.key)::numeric <= (kv.value->>'max')::numeric)
            when 'tags'   then exists (select 1 from jsonb_array_elements_text(kv.value) v, jsonb_array_elements_text(coalesce(s.values->kv.key, '[]'::jsonb)) t where t ilike '%' || v || '%')
            else true end, false)
      )
      -- free text, last
      and (coalesce(p_q, '') = '' or concat_ws(' ', e.display_name, e.city, e.country, array_to_string(e.languages, ' '), s.headline,
             array_to_string(e.tools, ' '), s.values::text, e.bio,
             (select string_agg(pj.title || ' ' || array_to_string(pj.tags, ' '), ' ') from public.projects pj where pj.owner = e.id)
           ) ilike '%' || p_q || '%')
  )
  select h.*, count(*) over() as total_count
  from hits h
  order by (case when public.editor_is_open(h.availability, h.free_from, h.availability_set_at) then 0 else 1 end),
           h.rating desc nulls last, h.review_count desc, h.created_at
  limit greatest(1, least(coalesce(p_limit, 60), 200)) offset greatest(0, coalesce(p_offset, 0));
$$;
grant execute on function public.search_professionals(text, jsonb, text, int, int) to anon, authenticated;

-- ---------- admin: professions and filters are managed as data, checked server-side ----------
create or replace function public.admin_set_profession(p_slug text, p_active boolean default null, p_invite_only boolean default null, p_sort int default null, p_labels jsonb default null)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then return 'not_allowed'; end if;
  if p_slug !~ '^[a-z0-9-]{2,40}$' then return 'bad_slug'; end if;
  insert into public.professions (slug, labels) values (p_slug, coalesce(p_labels, '{}'::jsonb)) on conflict (slug) do nothing;
  update public.professions set
    active = coalesce(p_active, active), invite_only = coalesce(p_invite_only, invite_only),
    sort_order = coalesce(p_sort, sort_order), labels = coalesce(p_labels, labels)
  where slug = p_slug;
  return 'ok';
end $$;
create or replace function public.admin_set_profession_filter(p_slug text, p_key text, p_attached boolean, p_primary boolean default null, p_sort int default null, p_profile boolean default null)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then return 'not_allowed'; end if;
  if not exists (select 1 from public.professions where slug = p_slug) then return 'unknown_profession'; end if;
  if not exists (select 1 from public.filters where key = p_key) then return 'unknown_filter'; end if;
  if not p_attached then delete from public.profession_filters where profession_slug = p_slug and filter_key = p_key; return 'ok'; end if;
  insert into public.profession_filters (profession_slug, filter_key, sort_order, primary_filter, profile_field)
  values (p_slug, p_key, coalesce(p_sort, 100), coalesce(p_primary, false), coalesce(p_profile, true))
  on conflict (profession_slug, filter_key) do update set
    sort_order = coalesce(p_sort, public.profession_filters.sort_order),
    primary_filter = coalesce(p_primary, public.profession_filters.primary_filter),
    profile_field = coalesce(p_profile, public.profession_filters.profile_field);
  return 'ok';
end $$;
create or replace function public.admin_upsert_filter(p_key text, p_kind text, p_labels jsonb, p_match text default 'any', p_min numeric default null, p_max numeric default null, p_unit text default null)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then return 'not_allowed'; end if;
  if p_key !~ '^[a-z0-9_]{2,40}$' then return 'bad_key'; end if;
  if p_kind not in ('multi','single','bool','range','tags') then return 'bad_kind'; end if;
  insert into public.filters (key, kind, match, labels, min_value, max_value, unit, admin_edited)
  values (p_key, p_kind, coalesce(p_match, 'any'), coalesce(p_labels, '{}'::jsonb), p_min, p_max, p_unit, true)
  on conflict (key) do update set labels = coalesce(p_labels, public.filters.labels), match = coalesce(p_match, public.filters.match),
    min_value = coalesce(p_min, public.filters.min_value), max_value = coalesce(p_max, public.filters.max_value), unit = coalesce(p_unit, public.filters.unit), admin_edited = true;
  return 'ok';
end $$;
create or replace function public.admin_set_filter_option(p_key text, p_option text, p_labels jsonb default null, p_remove boolean default false)
returns text language plpgsql security definer set search_path = public as $$
declare cur jsonb;
begin
  if not public.is_admin() then return 'not_allowed'; end if;
  if p_option !~ '^[A-Za-z0-9_]{1,40}$' then return 'bad_option'; end if;
  select options into cur from public.filters where key = p_key and kind in ('multi','single');
  if not found then return 'unknown_filter'; end if;
  if p_remove then
    if exists (select 1 from public.services s where s.values->p_key ? p_option or s.values->>p_key = p_option) then return 'option_in_use'; end if;
    cur := (select coalesce(jsonb_agg(o), '[]'::jsonb) from jsonb_array_elements(cur) o where o->>'key' <> p_option);
  elsif exists (select 1 from jsonb_array_elements(cur) o where o->>'key' = p_option) then
    cur := (select jsonb_agg(case when o->>'key' = p_option then jsonb_build_object('key', p_option, 'labels', coalesce(p_labels, o->'labels')) else o end) from jsonb_array_elements(cur) o);
  else
    if jsonb_array_length(cur) >= 200 then return 'too_many_options'; end if;
    cur := cur || jsonb_build_array(jsonb_build_object('key', p_option, 'labels', coalesce(p_labels, '{}'::jsonb)));
  end if;
  update public.filters set options = cur, admin_edited = true where key = p_key;
  return 'ok';
end $$;
revoke execute on function public.admin_set_profession(text, boolean, boolean, int, jsonb) from public, anon;
revoke execute on function public.admin_set_profession_filter(text, text, boolean, boolean, int, boolean) from public, anon;
revoke execute on function public.admin_upsert_filter(text, text, jsonb, text, numeric, numeric, text) from public, anon;
revoke execute on function public.admin_set_filter_option(text, text, jsonb, boolean) from public, anon;
grant execute on function public.admin_set_profession(text, boolean, boolean, int, jsonb) to authenticated;
grant execute on function public.admin_set_profession_filter(text, text, boolean, boolean, int, boolean) to authenticated;
grant execute on function public.admin_upsert_filter(text, text, jsonb, text, numeric, numeric, text) to authenticated;
grant execute on function public.admin_set_filter_option(text, text, jsonb, boolean) to authenticated;

-- ---------- jobs: the profession is a stable id, and the details are checked like service values ----------
create or replace function public.jobs_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare err text;
begin
  if tg_op = 'INSERT' then
    perform public.rate_limit('job_day', 10, interval '1 day');
    new.created_at := now();
  else
    new.created_at := old.created_at;
    new.owner := old.owner;
  end if;
  if new.profession_slug is null then                      -- an old-style post: derive it from the legacy role
    new.profession_slug := case new.role_needed when 'videographer' then 'videographer' when 'photographer' then 'photographer' else 'video-editor' end;
  end if;
  if not exists (select 1 from public.professions p where p.slug = new.profession_slug and (p.active or public.is_admin())) then raise exception 'profession_not_open'; end if;
  new.role_needed := case new.profession_slug when 'videographer' then 'videographer' when 'photographer' then 'photographer' else 'editor' end;
  new.details := coalesce(new.details, '{}'::jsonb);
  if pg_column_size(new.details) > 5000 then raise exception 'details_too_big'; end if;
  err := public.service_values_error(new.profession_slug, new.details);
  if err is not null then raise exception '%', err; end if;
  return new;
end $$;
drop trigger if exists jobs_guard on public.jobs;
create trigger jobs_guard before insert or update on public.jobs for each row execute procedure public.jobs_guard();
grant insert (owner, title, role_needed, profession_slug, category, description, location, remote, pricing, budget, deadline, status) on public.jobs to authenticated;
grant insert (details) on public.jobs to authenticated;
update public.jobs set profession_slug = case role_needed when 'videographer' then 'videographer' when 'photographer' then 'photographer' else 'video-editor' end where profession_slug is null;
