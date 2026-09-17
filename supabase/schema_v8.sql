-- ============================================================
-- Cuvori — schema v8: training & credentials on editor profiles
-- (courses/tutorials, schools, certificates, mentorships) so a new
-- editor can show what they learned and link the project they made.
-- Later: partner courses / referral tracking can hang off these entries.
-- Run AFTER schema_v7.sql. Re-runnable.
-- ============================================================
alter table public.editor_profiles add column if not exists credentials jsonb not null default '[]'::jsonb;
-- each entry: {"kind":"course|school|certificate|mentor","title":"…","by":"Casey Faris","year":2025,"link":"https://…","project_id":"<projects.id>"}

-- partner courses / schools we collaborate with (referral programme). Admin-managed; public read.
create table if not exists public.partner_courses (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  author      text default '',
  url         text default '',
  referral_url text default '',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
alter table public.partner_courses enable row level security;
drop policy if exists "partner courses readable" on public.partner_courses;
create policy "partner courses readable" on public.partner_courses for select to anon, authenticated using (active);
drop policy if exists "admin manages partner courses" on public.partner_courses;
create policy "admin manages partner courses" on public.partner_courses for all to authenticated using (public.is_admin()) with check (public.is_admin());
