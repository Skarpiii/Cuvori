-- ============================================================
-- Cuvori — v15 migration: every existing professional becomes one or more services.
-- Run AFTER schema_v15.sql AND professions_seed.sql. Re-runnable: rows that exist are left alone.
-- editor -> video-editor · videographer -> videographer · photographer -> photographer
-- editor_photographer -> video-editor (main) + photographer: the first real multi-service accounts.
-- ============================================================

create or replace function public.v15_service_values(p_slug text, e public.editor_profiles)
returns jsonb language plpgsql stable as $$
declare sw jsonb; sk jsonb; spec jsonb; shoot jsonb; v jsonb := '{}'::jsonb; tools_left text[];
begin
  -- tools that are a known software option become software keys; the rest stay as free skills
  select coalesce(jsonb_agg(o->>'key'), '[]'::jsonb) into sw
    from unnest(e.tools) t join jsonb_array_elements((select options from public.filters where key = 'software')) o
      on lower(o->'labels'->>'en') = lower(t);
  select coalesce(array_agg(t), '{}') into tools_left from unnest(e.tools) t
    where not exists (select 1 from jsonb_array_elements((select options from public.filters where key = 'software')) o where lower(o->'labels'->>'en') = lower(t));
  -- known editing skills become video_skills keys
  select coalesce(jsonb_agg(o->>'key'), '[]'::jsonb) into sk
    from unnest(tools_left) t join jsonb_array_elements((select options from public.filters where key = 'video_skills')) o
      on lower(o->'labels'->>'en') = lower(t);
  select coalesce(array_agg(t), '{}') into tools_left from unnest(tools_left) t
    where not exists (select 1 from jsonb_array_elements((select options from public.filters where key = 'video_skills')) o where lower(o->'labels'->>'en') = lower(t));
  select coalesce(jsonb_agg(s), '[]'::jsonb) into spec from unnest(e.specializations) s where s = any (public.cat_keys());
  if p_slug in ('video-editor', 'videographer') then
    if jsonb_array_length(spec) > 0 then v := v || jsonb_build_object('video_specialty', spec); end if;
    if jsonb_array_length(sw) > 0 then v := v || jsonb_build_object('software', sw); end if;
    if jsonb_array_length(sk) > 0 then v := v || jsonb_build_object('video_skills', sk); end if;
    v := v || jsonb_build_object('turnaround_days', least(60, greatest(1, coalesce(e.turnaround_days, 7))));
  elsif p_slug = 'photographer' then
    select coalesce(jsonb_agg(m.shoot), '[]'::jsonb) into shoot
      from unnest(e.specializations) s
      join (values ('catWedding','wedding'), ('catRealEstate','real_estate'), ('catCorporate','corporate'), ('catTravel','travel'), ('catCommercial','product')) as m(cat, shoot) on m.cat = s;
    if jsonb_array_length(shoot) > 0 then v := v || jsonb_build_object('shoot_type', shoot); end if;
    v := v || jsonb_build_object('delivery_days', least(60, greatest(1, coalesce(e.turnaround_days, 7))));
  end if;
  if array_length(tools_left, 1) > 0 then
    v := v || jsonb_build_object('skills', (select jsonb_agg(left(t, 40)) from unnest(tools_left[1:30]) t where t !~ '[<>]'));
  end if;
  return v;
end $$;

insert into public.services (profile_id, profession_slug, rate_amount, rate_unit, headline, values, is_public, sort_order)
select e.id, m.slug, e.rate_amount,
       case when e.rate_unit = any (p.pricing_units) then e.rate_unit else p.pricing_units[1] end,
       '', public.v15_service_values(m.slug, e), true, m.ord
from public.editor_profiles e
join (values ('editor','video-editor',0), ('videographer','videographer',0), ('photographer','photographer',0),
             ('editor_photographer','video-editor',0), ('editor_photographer','photographer',1)) as m(role, slug, ord)
  on m.role = e.role_label
join public.professions p on p.slug = m.slug
on conflict (profile_id, profession_slug) do nothing;

drop function public.v15_service_values(text, public.editor_profiles);
