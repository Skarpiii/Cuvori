-- ============================================================
-- Cuvori — schema v17: professionals can add their own specialisations and skills.
-- Run AFTER schema_v16.sql, then re-run professions_seed.sql. Re-runnable.
--
-- A list filter marked allow_custom accepts a professional's own entries next to the
-- known options ("Anime AMV editing" beside "Shorts / Reels / TikTok"). Known options
-- drive the structured filters; custom entries show on the profile and are found by
-- the search box. Nothing else changes.
-- ============================================================
alter table public.filters add column if not exists allow_custom boolean not null default false;

create or replace function public.service_values_error(p_prof text, v jsonb)
returns text language plpgsql stable as $$
declare kv record; f public.filters%rowtype; elem jsonb; custom_n int;
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
      if jsonb_array_length(kv.value) > 40 then return 'too_many:' || kv.key; end if;
      custom_n := 0;
      for elem in select e from jsonb_array_elements(kv.value) e loop
        if jsonb_typeof(elem) <> 'string' then return 'bad_item:' || kv.key; end if;
        if f.kind = 'multi' and not exists (select 1 from jsonb_array_elements(f.options) o where o->>'key' = (elem #>> '{}')) then
          -- not a known option: allowed as the professional's own entry when the filter says so
          if not f.allow_custom then return 'unknown_option:' || kv.key || '=' || (elem #>> '{}'); end if;
          custom_n := custom_n + 1;
          if custom_n > 10 then return 'too_many_custom:' || kv.key; end if;
          if length(elem #>> '{}') > 40 or length(btrim(elem #>> '{}')) = 0 or (elem #>> '{}') ~ '[<>]' then return 'bad_custom:' || kv.key; end if;
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

-- the page needs to know which filters take custom entries
create or replace function public.profession_config()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'groups', (select coalesce(jsonb_agg(jsonb_build_object('slug', g.slug, 'labels', g.labels, 'sort_order', g.sort_order) order by g.sort_order, g.slug), '[]'::jsonb) from public.profession_groups g),
    'professions', (select coalesce(jsonb_agg(jsonb_build_object(
        'slug', p.slug, 'group_slug', p.group_slug, 'sort_order', p.sort_order, 'active', p.active, 'invite_only', p.invite_only,
        'pricing_units', to_jsonb(p.pricing_units), 'portfolio_kind', p.portfolio_kind, 'labels', p.labels, 'synonyms', to_jsonb(p.synonyms),
        'professional_count', (select count(*) from public.services s join public.editor_profiles e on e.id = s.profile_id
                               where s.profession_slug = p.slug and s.is_public and e.is_public and public.is_listed(e.id))
      ) order by p.sort_order, p.slug), '[]'::jsonb) from public.professions p),
    'filters', (select coalesce(jsonb_agg(jsonb_build_object('key', f.key, 'kind', f.kind, 'match', f.match, 'options', f.options,
        'min_value', f.min_value, 'max_value', f.max_value, 'unit', f.unit, 'labels', f.labels, 'allow_custom', f.allow_custom) order by f.sort_order, f.key), '[]'::jsonb) from public.filters f),
    'profession_filters', (select coalesce(jsonb_agg(jsonb_build_object('profession_slug', pf.profession_slug, 'filter_key', pf.filter_key,
        'sort_order', pf.sort_order, 'primary_filter', pf.primary_filter, 'profile_field', pf.profile_field) order by pf.profession_slug, pf.sort_order), '[]'::jsonb) from public.profession_filters pf),
    'units', (select coalesce(jsonb_object_agg(u.key, u.labels), '{}'::jsonb) from public.price_units u)
  );
$$;

-- admins can switch it per filter
create or replace function public.admin_set_filter_custom(p_key text, p_allow boolean)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then return 'not_allowed'; end if;
  update public.filters set allow_custom = p_allow, admin_edited = true where key = p_key and kind = 'multi';
  if not found then return 'unknown_filter'; end if;
  return 'ok';
end $$;
revoke execute on function public.admin_set_filter_custom(text, boolean) from public, anon;
grant   execute on function public.admin_set_filter_custom(text, boolean) to authenticated;
