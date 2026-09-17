-- ============================================================
-- Cuvori — schema v2: editor profiles, portfolios, jobs, messaging, storage
-- Run AFTER schema.sql. Safe to run more than once.
-- ============================================================

-- ---------- helpers ----------
create or replace function public.is_editor(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = uid and role = 'editor');
$$;

-- ---------- editor profiles (public listing data) ----------
create table if not exists public.editor_profiles (
  id               uuid primary key references public.profiles(id) on delete cascade,
  display_name     text not null default '',
  role_label       text not null default 'editor' check (role_label in ('editor','videographer','photographer','editor_photographer')),
  city             text default '',
  country          text default '',
  languages        text[] not null default '{}',
  specializations  text[] not null default '{}',   -- category keys: catCommercial, catDocumentary, catShorts, catPodcasts, catMusic, catOther
  tools            text[] not null default '{}',
  bio              text default '',
  rate_amount      numeric(10,2),
  rate_unit        text not null default 'hour' check (rate_unit in ('hour','project','day')),
  currency         text not null default 'EUR',
  available        boolean not null default true,
  responds_hours   int not null default 24,
  turnaround_days  int not null default 7,
  revisions        int not null default 2,
  is_public        boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
alter table public.editor_profiles enable row level security;

drop policy if exists "public editor profiles are readable" on public.editor_profiles;
create policy "public editor profiles are readable"
  on public.editor_profiles for select to anon, authenticated
  using (is_public = true or auth.uid() = id);

drop policy if exists "editors insert own profile" on public.editor_profiles;
create policy "editors insert own profile"
  on public.editor_profiles for insert to authenticated
  with check (auth.uid() = id and public.is_editor(auth.uid()));

drop policy if exists "editors update own profile" on public.editor_profiles;
create policy "editors update own profile"
  on public.editor_profiles for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id and public.is_editor(auth.uid()));

-- ---------- portfolio projects ----------
create table if not exists public.projects (
  id            uuid primary key default gen_random_uuid(),
  owner         uuid not null references public.profiles(id) on delete cascade,
  title         text default '',
  category      text not null default 'catOther',
  video_url     text,          -- YouTube/Vimeo link, direct file, or storage URL
  thumb_url     text,          -- optional custom thumbnail
  length_label  text default '',
  tags          text[] not null default '{}',   -- hidden search tags
  pinned        boolean not null default false,
  position      int not null default 0,
  created_at    timestamptz not null default now()
);
create index if not exists projects_owner_idx on public.projects(owner, position);
alter table public.projects enable row level security;

drop policy if exists "projects of public editors are readable" on public.projects;
create policy "projects of public editors are readable"
  on public.projects for select to anon, authenticated
  using (auth.uid() = owner or exists (select 1 from public.editor_profiles e where e.id = owner and e.is_public));

drop policy if exists "editors manage own projects" on public.projects;
create policy "editors manage own projects"
  on public.projects for all to authenticated
  using (auth.uid() = owner) with check (auth.uid() = owner and public.is_editor(auth.uid()));

-- ---------- jobs ----------
create table if not exists public.jobs (
  id            uuid primary key default gen_random_uuid(),
  owner         uuid not null references public.profiles(id) on delete cascade,
  title         text not null,
  role_needed   text not null default 'editor' check (role_needed in ('editor','videographer','photographer')),
  category      text not null default 'catOther',
  description   text default '',
  location      text default '',
  remote        boolean not null default true,
  pricing       text not null default 'project' check (pricing in ('project','hourly')),
  budget        text default '',
  deadline      date,
  status        text not null default 'open' check (status in ('open','closed')),
  created_at    timestamptz not null default now()
);
create index if not exists jobs_created_idx on public.jobs(created_at desc);
alter table public.jobs enable row level security;

drop policy if exists "open jobs are readable" on public.jobs;
create policy "open jobs are readable"
  on public.jobs for select to anon, authenticated using (status = 'open' or auth.uid() = owner);

drop policy if exists "users manage own jobs" on public.jobs;
create policy "users manage own jobs"
  on public.jobs for all to authenticated using (auth.uid() = owner) with check (auth.uid() = owner);

-- ---------- messaging ----------
create table if not exists public.conversations (
  id            uuid primary key default gen_random_uuid(),
  user_a        uuid not null references public.profiles(id) on delete cascade,
  user_b        uuid not null references public.profiles(id) on delete cascade,
  created_at    timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  constraint conversations_pair unique (user_a, user_b),
  constraint conversations_order check (user_a < user_b)
);
alter table public.conversations enable row level security;

create table if not exists public.messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  sender           uuid not null references public.profiles(id) on delete cascade,
  kind             text not null default 'text' check (kind in ('text','report','change_request')),
  body             text default '',
  payload          jsonb,        -- for reports: {title, message, video_url, comments:[{seconds,text}], status}
  created_at       timestamptz not null default now()
);
create index if not exists messages_conv_idx on public.messages(conversation_id, created_at);
alter table public.messages enable row level security;

drop policy if exists "participants read conversations" on public.conversations;
create policy "participants read conversations"
  on public.conversations for select to authenticated using (auth.uid() in (user_a, user_b));

drop policy if exists "participants read messages" on public.messages;
create policy "participants read messages"
  on public.messages for select to authenticated
  using (exists (select 1 from public.conversations c where c.id = conversation_id and auth.uid() in (c.user_a, c.user_b)));

drop policy if exists "participants send messages" on public.messages;
create policy "participants send messages"
  on public.messages for insert to authenticated
  with check (sender = auth.uid() and exists (select 1 from public.conversations c where c.id = conversation_id and auth.uid() in (c.user_a, c.user_b)));

drop policy if exists "sender updates own report" on public.messages;
create policy "sender updates own report"
  on public.messages for update to authenticated
  using (exists (select 1 from public.conversations c where c.id = conversation_id and auth.uid() in (c.user_a, c.user_b)))
  with check (true);

-- get-or-create a conversation with another user (never exposes other users' conversations)
create or replace function public.open_conversation(other uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare a uuid; b uuid; cid uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if other = auth.uid() then raise exception 'cannot message yourself'; end if;
  if auth.uid() < other then a := auth.uid(); b := other; else a := other; b := auth.uid(); end if;
  select id into cid from public.conversations where user_a = a and user_b = b;
  if cid is null then insert into public.conversations (user_a, user_b) values (a, b) returning id into cid; end if;
  return cid;
end $$;
grant execute on function public.open_conversation(uuid) to authenticated;

-- bump last_message_at
create or replace function public.touch_conversation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.conversations set last_message_at = now() where id = new.conversation_id;
  return new;
end $$;
drop trigger if exists on_message_insert on public.messages;
create trigger on_message_insert after insert on public.messages for each row execute procedure public.touch_conversation();

-- realtime for messages
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'messages') then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;

-- ---------- storage bucket for portfolio media ----------
insert into storage.buckets (id, name, public) values ('portfolio', 'portfolio', true)
on conflict (id) do nothing;

drop policy if exists "portfolio files are public" on storage.objects;
create policy "portfolio files are public"
  on storage.objects for select to anon, authenticated using (bucket_id = 'portfolio');

drop policy if exists "editors upload to own folder" on storage.objects;
create policy "editors upload to own folder"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'portfolio' and (storage.foldername(name))[1] = auth.uid()::text and public.is_editor(auth.uid()));

drop policy if exists "editors delete own files" on storage.objects;
create policy "editors delete own files"
  on storage.objects for delete to authenticated
  using (bucket_id = 'portfolio' and (storage.foldername(name))[1] = auth.uid()::text);
