-- ============================================================
-- Cuvori — schema v9: security hardening (found by attacking the site as a
-- visitor, client, editor, banned user and admin). Run AFTER schema_v8.sql.
-- Re-runnable. New limits use NOT VALID so existing rows are not rejected;
-- they apply to every new or changed row.
-- ============================================================

-- ---------- helpers ----------
create or replace function public.is_safe_url(u text)
returns boolean language sql immutable as $$
  select u is not null and length(u) <= 2000
     and u ~ '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?([/?#][^[:space:]"''<>\\`]*)?$';
$$;

create or replace function public.text_array_ok(arr text[], max_items int, max_len int)
returns boolean language sql immutable as $$
  select arr is null or (coalesce(array_length(arr, 1), 0) <= max_items
    and not exists (select 1 from unnest(arr) x where x is null or length(x) > max_len or x ~ '[<>]'));
$$;

create or replace function public.cat_keys()
returns text[] language sql immutable as $$
  select array['catCommercial','catYoutubeLong','catShorts','catDocumentary','catPodcasts','catMusic','catWedding','catCorporate',
               'catRealEstate','catGaming','catEducation','catMotion','catColor','catTravel','catOther'];
$$;

create or replace function public.credentials_ok(c jsonb)
returns boolean language sql immutable as $$
  select c is not null and jsonb_typeof(c) = 'array' and jsonb_array_length(c) <= 20 and pg_column_size(c) <= 20000
     and not exists (
       select 1 from jsonb_array_elements(c) e
       where jsonb_typeof(e) <> 'object'
          or coalesce(e->>'kind', 'course') not in ('course','school','certificate','mentor')
          or length(coalesce(e->>'title', '')) > 150
          or length(coalesce(e->>'by', '')) > 150
          or (e ? 'year' and e->'year' <> 'null'::jsonb and (jsonb_typeof(e->'year') <> 'number' or (e->>'year')::numeric not between 1950 and 2100))
          or (coalesce(e->>'link', '') <> '' and not public.is_safe_url(e->>'link'))
          or (coalesce(e->>'project_id', '') <> '' and (e->>'project_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'));
$$;

-- ---------- rate limits (per signed-in user; server jobs are not limited) ----------
create table if not exists public.rate_events (
  user_id uuid not null,
  kind    text not null,
  at      timestamptz not null default now()
);
create index if not exists rate_events_idx on public.rate_events (user_id, kind, at);
alter table public.rate_events enable row level security;   -- no policies
revoke all on public.rate_events from anon, authenticated;

create or replace function public.rate_limit(p_kind text, p_max int, p_window interval)
returns void language plpgsql security definer set search_path = public as $$
declare n int; uid uuid := auth.uid();
begin
  if uid is null then return; end if;
  delete from public.rate_events where user_id = uid and kind = p_kind and at < now() - p_window;
  select count(*) into n from public.rate_events where user_id = uid and kind = p_kind;
  if n >= p_max then raise exception 'rate_limited' using hint = p_kind; end if;
  insert into public.rate_events (user_id, kind) values (uid, p_kind);
end $$;
revoke execute on function public.rate_limit(text, int, interval) from public, anon, authenticated;

-- ---------- profiles: a user can never change the stored e-mail, and names carry no HTML ----------
create or replace function public.profiles_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and auth.uid() = old.id then
    new.email := old.email;
    new.created_at := old.created_at;
    if new.first_name is distinct from old.first_name and (length(new.first_name) > 80 or new.first_name ~ '[<>]') then
      raise exception 'bad_name';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before update on public.profiles for each row execute procedure public.profiles_guard();

-- the signed-in user's own full row (e-mail, admin, ban reason)
create or replace function public.my_profile()
returns setof public.profiles language sql stable security definer set search_path = public as $$
  select * from public.profiles where id = auth.uid();
$$;
revoke execute on function public.my_profile() from public, anon;
grant execute on function public.my_profile() to authenticated;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into public.profiles (id, email, first_name)
  values (new.id, new.email, left(regexp_replace(coalesce(new.raw_user_meta_data->>'first_name', ''), '[[:cntrl:]<>]', '', 'g'), 80))
  on conflict (id) do nothing;
  return new;
end $$;

-- ---------- editor profiles ----------
alter table public.editor_profiles drop constraint if exists editor_profiles_sane;
alter table public.editor_profiles add constraint editor_profiles_sane check (
      length(display_name) <= 80 and length(coalesce(city, '')) <= 80 and length(coalesce(country, '')) <= 80
  and length(coalesce(bio, '')) <= 3000
  and public.text_array_ok(languages, 30, 40) and public.text_array_ok(tools, 60, 60)
  and specializations <@ public.cat_keys()
  and (rate_amount is null or rate_amount between 0 and 100000)
  and responds_hours between 1 and 720 and turnaround_days between 1 and 365 and revisions between 0 and 50
  and currency = 'EUR'
  and public.credentials_ok(credentials)
) not valid;

-- ---------- portfolio projects ----------
alter table public.projects drop constraint if exists projects_sane;
alter table public.projects add constraint projects_sane check (
      length(coalesce(title, '')) <= 200 and category = any (public.cat_keys())
  and (video_url is null or video_url = '' or public.is_safe_url(video_url))
  and (thumb_url is null or thumb_url = '' or public.is_safe_url(thumb_url))
  and length(coalesce(length_label, '')) <= 20 and public.text_array_ok(tags, 30, 40)
  and position between 0 and 10000
) not valid;

create or replace function public.projects_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and (select count(*) from public.projects where owner = new.owner) >= 100 then
    raise exception 'too_many_projects';
  end if;
  new.created_at := now();
  return new;
end $$;
drop trigger if exists projects_guard on public.projects;
create trigger projects_guard before insert on public.projects for each row execute procedure public.projects_guard();

-- ---------- jobs ----------
alter table public.jobs drop constraint if exists jobs_sane;
alter table public.jobs add constraint jobs_sane check (
      length(title) between 1 and 150 and length(coalesce(description, '')) <= 5000
  and length(coalesce(location, '')) <= 100 and length(coalesce(budget, '')) <= 60
  and category = any (public.cat_keys())
) not valid;

create or replace function public.jobs_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.rate_limit('job_day', 10, interval '1 day');
    new.created_at := now();
  else
    new.created_at := old.created_at;
    new.owner := old.owner;
  end if;
  return new;
end $$;
drop trigger if exists jobs_guard on public.jobs;
create trigger jobs_guard before insert or update on public.jobs for each row execute procedure public.jobs_guard();

-- ---------- conversations: only with someone you have a reason to contact ----------
create or replace function public.open_conversation(other uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare a uuid; b uuid; cid uuid; me uuid := auth.uid();
begin
  if me is null then raise exception 'not signed in'; end if;
  if other is null or other = me then raise exception 'cannot message yourself'; end if;
  if public.is_banned(me) then raise exception 'banned'; end if;
  if me < other then a := me; b := other; else a := other; b := me; end if;
  select id into cid from public.conversations where user_a = a and user_b = b;
  if cid is not null then return cid; end if;
  if not exists (select 1 from public.profiles where id = other and not banned) then raise exception 'not_available'; end if;
  if not (public.is_admin()
          or exists (select 1 from public.editor_profiles e where e.id = other and e.is_public)
          or exists (select 1 from public.jobs j where j.owner = other and j.status = 'open')) then
    raise exception 'not_available';
  end if;
  perform public.rate_limit('conversation_hour', 30, interval '1 hour');
  insert into public.conversations (user_a, user_b) values (a, b) returning id into cid;
  return cid;
end $$;

-- ---------- messages ----------
revoke insert, update, delete on public.messages from anon, authenticated;
grant insert (conversation_id, sender, kind, body, payload) on public.messages to authenticated;
grant update (payload) on public.messages to authenticated;

drop policy if exists "participants send messages" on public.messages;
create policy "participants send messages" on public.messages for insert to authenticated
  with check (sender = auth.uid() and kind in ('text','report','change_request') and not public.is_banned(auth.uid())
    and exists (select 1 from public.conversations c where c.id = conversation_id and auth.uid() in (c.user_a, c.user_b)));

drop policy if exists "sender updates own report" on public.messages;
drop policy if exists "participants update report payload" on public.messages;
create policy "participants update report payload" on public.messages for update to authenticated
  using (kind = 'report' and not public.is_banned(auth.uid())
    and exists (select 1 from public.conversations c where c.id = conversation_id and auth.uid() in (c.user_a, c.user_b)))
  with check (kind = 'report');

create or replace function public.messages_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare v text;
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    perform public.rate_limit('msg_minute', 30, interval '1 minute');
    perform public.rate_limit('msg_hour', 400, interval '1 hour');
  elsif auth.uid() is not null then
    if new.conversation_id <> old.conversation_id or new.sender <> old.sender or new.kind <> old.kind
       or new.body is distinct from old.body or new.created_at <> old.created_at
       or (coalesce(new.payload, '{}') - 'status' - 'comments') is distinct from (coalesce(old.payload, '{}') - 'status' - 'comments') then
      raise exception 'only the review status and comments of a report can change';
    end if;
  end if;
  if length(coalesce(new.body, '')) > 5000 then raise exception 'message_too_long'; end if;
  if new.payload is not null then
    if pg_column_size(new.payload) > 30000 then raise exception 'message_too_long'; end if;
    v := new.payload->>'video_url';
    if coalesce(v, '') <> '' and not public.is_safe_url(v) then raise exception 'bad_link'; end if;
    if jsonb_typeof(new.payload->'comments') = 'array' and jsonb_array_length(new.payload->'comments') > 300 then raise exception 'too_many_comments'; end if;
  end if;
  return new;
end $$;
drop trigger if exists messages_guard on public.messages;
create trigger messages_guard before insert or update on public.messages for each row execute procedure public.messages_guard();

-- ---------- reviews ----------
alter table public.reviews drop constraint if exists reviews_body_len;
alter table public.reviews add constraint reviews_body_len check (length(body) <= 2000) not valid;

-- a review needs a real exchange: both people have written in the conversation
create or replace function public.can_review(ed uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and auth.uid() <> ed
     and public.is_editor(ed)
     and not public.is_banned(auth.uid())
     and exists (select 1 from public.conversations c
                 where ((c.user_a = auth.uid() and c.user_b = ed) or (c.user_b = auth.uid() and c.user_a = ed))
                   and exists (select 1 from public.messages m where m.conversation_id = c.id and m.sender = auth.uid())
                   and exists (select 1 from public.messages m where m.conversation_id = c.id and m.sender = ed));
$$;

drop policy if exists "clients update own review" on public.reviews;
create policy "clients update own review" on public.reviews for update to authenticated
  using (client = auth.uid()) with check (client = auth.uid() and public.can_review(editor));

create or replace function public.reviews_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then new.created_at := now(); else new.created_at := old.created_at; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists reviews_guard on public.reviews;
create trigger reviews_guard before insert or update on public.reviews for each row execute procedure public.reviews_guard();

-- ---------- payout details: users edit only their manual methods; Stripe fields are server-only ----------
drop policy if exists "owner manages payout details" on public.payout_details;
drop policy if exists "owner reads payout details" on public.payout_details;
drop policy if exists "owner inserts payout details" on public.payout_details;
drop policy if exists "owner updates payout details" on public.payout_details;
create policy "owner reads payout details" on public.payout_details for select to authenticated using (auth.uid() = id);
create policy "owner inserts payout details" on public.payout_details for insert to authenticated
  with check (auth.uid() = id and public.is_editor(auth.uid()) and not public.is_banned(auth.uid()));
create policy "owner updates payout details" on public.payout_details for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id and public.is_editor(auth.uid()) and not public.is_banned(auth.uid()));
revoke insert, update, delete on public.payout_details from anon, authenticated;
grant insert (id, methods, note, updated_at) on public.payout_details to authenticated;
grant update (id, methods, note, updated_at) on public.payout_details to authenticated;

alter table public.payout_details drop constraint if exists payout_details_sane;
alter table public.payout_details add constraint payout_details_sane check (
      jsonb_typeof(methods) = 'array' and jsonb_array_length(methods) <= 10 and pg_column_size(methods) <= 5000
  and length(coalesce(note, '')) <= 500
  and (stripe_account_id is null or stripe_account_id ~ '^acct_[A-Za-z0-9]{8,64}$')
) not valid;

-- bank details are shown only to the client of an accepted direct-payment contract
create or replace function public.payout_info(ed uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case
    when auth.uid() is null then null
    when auth.uid() = ed or exists (select 1 from public.contracts k
         where k.editor = ed and k.client = auth.uid() and k.payment_mode = 'direct'
           and k.status in ('accepted','paid_marked','paid','completed'))
      then (select jsonb_build_object('methods', p.methods, 'note', p.note) from public.payout_details p where p.id = ed)
    else null end;
$$;

-- ---------- contracts ----------
alter table public.contracts drop constraint if exists contracts_status_check;
alter table public.contracts add constraint contracts_status_check
  check (status in ('proposed','accepted','paid_marked','paid','funded','delivered','disputed','releasing','resolving','completed','refunded','declined','cancelled'));
alter table public.contracts add column if not exists stripe_charge_id text;
alter table public.contracts add column if not exists refund_cents int;
alter table public.contracts add column if not exists money_error text;
alter table public.contracts drop constraint if exists contracts_sane;
alter table public.contracts add constraint contracts_sane check (
      length(title) between 1 and 200 and length(coalesce(description, '')) <= 5000
  and price between 0 and 1000000 and revisions between 0 and 50 and currency = 'EUR'
  and (amount_cents is null or amount_cents between 0 and 100000000)
  and (delivery_url is null or delivery_url = '' or public.is_safe_url(delivery_url))
  and length(coalesce(delivery_note, '')) <= 2000 and length(coalesce(dispute_reason, '')) <= 2000
  and (payment_mode = 'direct' or (pricing = 'project' and price >= 1))
) not valid;
create unique index if not exists contracts_pi_uniq on public.contracts (stripe_payment_intent) where stripe_payment_intent is not null;

create or replace function public.propose_contract(conv uuid, title text, description text, price numeric, pricing text, deadline date, revisions int, mode text default 'direct')
returns uuid language plpgsql security definer set search_path = public as $$
declare cv public.conversations%rowtype; ed uuid; cl uuid; c public.contracts%rowtype;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if public.is_banned(auth.uid()) then raise exception 'banned'; end if;
  select * into cv from public.conversations where id = conv and auth.uid() in (user_a, user_b) for update;
  if not found then raise exception 'not your conversation'; end if;
  if public.is_banned(cv.user_a) or public.is_banned(cv.user_b) then raise exception 'not_available'; end if;
  title := btrim(coalesce(title, ''));
  pricing := coalesce(pricing, 'project');
  mode := case when mode = 'escrow' then 'escrow' else 'direct' end;
  if length(title) < 1 or length(title) > 200 then raise exception 'bad_title'; end if;
  if length(coalesce(description, '')) > 5000 then raise exception 'description_too_long'; end if;
  if price is null or price < 0 or price > 1000000 then raise exception 'bad_price'; end if;
  if pricing not in ('project','hour','day') then raise exception 'bad_pricing'; end if;
  if revisions is not null and (revisions < 0 or revisions > 50) then raise exception 'bad_revisions'; end if;
  if deadline is not null and deadline < current_date then raise exception 'deadline_in_past'; end if;
  if mode = 'escrow' and pricing <> 'project' then raise exception 'escrow_fixed_price_only'; end if;
  if mode = 'escrow' and price < 1 then raise exception 'escrow_minimum'; end if;
  if public.is_editor(cv.user_a) and not public.is_editor(cv.user_b) then ed := cv.user_a; cl := cv.user_b;
  elsif public.is_editor(cv.user_b) and not public.is_editor(cv.user_a) then ed := cv.user_b; cl := cv.user_a;
  elsif public.is_editor(cv.user_a) and public.is_editor(cv.user_b) then
    if auth.uid() = cv.user_a then cl := cv.user_a; ed := cv.user_b; else cl := cv.user_b; ed := cv.user_a; end if;
  else raise exception 'no editor in this conversation'; end if;
  if exists (select 1 from public.contracts x where x.conversation_id = conv
             and x.status in ('proposed','accepted','paid_marked','paid','funded','delivered','disputed','releasing','resolving')) then
    raise exception 'active_contract_exists';
  end if;
  perform public.rate_limit('contract_hour', 20, interval '1 hour');
  insert into public.contracts (conversation_id, editor, client, proposed_by, title, description, price, pricing, deadline, revisions, payment_mode, amount_cents)
  values (conv, ed, cl, auth.uid(), title, coalesce(description, ''), price, pricing, deadline, coalesce(revisions, 2), mode, round(price * 100)::int)
  returning * into c;
  perform public.contract_event(c, 'proposed');
  return c.id;
end $$;

create or replace function public.contract_action(cid uuid, action text, note text default null, link text default null)
returns text language plpgsql security definer set search_path = public as $$
declare c public.contracts%rowtype; me uuid := auth.uid();
begin
  if me is null then return 'not_signed_in'; end if;
  select * into c from public.contracts where id = cid and me in (editor, client) for update;
  if not found then return 'not_found'; end if;
  if public.is_banned(me) then return 'banned'; end if;
  note := nullif(btrim(coalesce(note, '')), '');
  link := nullif(btrim(coalesce(link, '')), '');
  if length(coalesce(note, '')) > 2000 then return 'note_too_long'; end if;
  if link is not null and not public.is_safe_url(link) then return 'bad_link'; end if;
  begin
    perform public.rate_limit('contract_action', 60, interval '1 hour');
  exception when others then return 'rate_limited';
  end;
  if action = 'accept' then
    if c.status <> 'proposed' or c.proposed_by = me then return 'not_allowed'; end if;
    if public.is_banned(c.editor) or public.is_banned(c.client) then return 'not_allowed'; end if;
    update public.contracts set status = 'accepted', accepted_at = now() where id = cid returning * into c;
  elsif action = 'decline' then
    if c.status <> 'proposed' or c.proposed_by = me then return 'not_allowed'; end if;
    update public.contracts set status = 'declined', closed_at = now() where id = cid returning * into c;
  elsif action = 'cancel' then
    -- once money is held, a contract can only end by approval, refund or Cuvori's decision
    if c.status not in ('proposed','accepted') then return 'not_allowed'; end if;
    update public.contracts set status = 'cancelled', closed_at = now() where id = cid returning * into c;
  elsif action = 'mark_paid' then
    if c.payment_mode <> 'direct' or c.status <> 'accepted' or me <> c.client then return 'not_allowed'; end if;
    update public.contracts set status = 'paid_marked', paid_marked_at = now() where id = cid returning * into c;
  elsif action = 'confirm_paid' then
    if c.payment_mode <> 'direct' or c.status not in ('accepted','paid_marked') or me <> c.editor then return 'not_allowed'; end if;
    update public.contracts set status = 'paid', paid_at = now(), paid_marked_at = coalesce(paid_marked_at, now()) where id = cid returning * into c;
  elsif action = 'complete' then
    if c.payment_mode <> 'direct' or c.status <> 'paid' then return 'not_allowed'; end if;
    update public.contracts set status = 'completed', completed_at = now(), closed_at = now() where id = cid returning * into c;
  elsif action = 'deliver' then
    if c.payment_mode <> 'escrow' or c.status <> 'funded' or me <> c.editor then return 'not_allowed'; end if;
    update public.contracts set status = 'delivered', delivered_at = now(), delivery_note = note, delivery_url = link,
           auto_release_at = now() + interval '7 days' where id = cid returning * into c;
  elsif action = 'request_changes' then
    if c.payment_mode <> 'escrow' or c.status <> 'delivered' or me <> c.client then return 'not_allowed'; end if;
    update public.contracts set status = 'funded', auto_release_at = null where id = cid returning * into c;
    if note is not null then
      insert into public.messages (conversation_id, sender, kind, body) values (c.conversation_id, me, 'change_request', note);
    end if;
  elsif action = 'dispute' then
    if c.payment_mode <> 'escrow' or c.status not in ('funded','delivered') then return 'not_allowed'; end if;
    update public.contracts set status = 'disputed', dispute_by = me, dispute_reason = note, disputed_at = now(), auto_release_at = null
      where id = cid returning * into c;
  else return 'bad_action'; end if;
  perform public.contract_event(c, action);
  return 'ok';
end $$;

-- ---------- accounts cannot disappear while someone's money is held ----------
create or replace function public.has_money_held(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.contracts c where target in (c.editor, c.client)
                 and c.status in ('funded','delivered','disputed','releasing','resolving'));
$$;
revoke execute on function public.has_money_held(uuid) from public, anon, authenticated;

create or replace function public.delete_my_account()
returns text language plpgsql security definer set search_path = public, storage as $$
begin
  if auth.uid() is null then return 'not_signed_in'; end if;
  if public.has_money_held(auth.uid()) then return 'active_payments'; end if;
  perform public.purge_user(auth.uid());
  return 'ok';
end $$;

create or replace function public.admin_delete_user(target uuid)
returns text language plpgsql security definer set search_path = public, storage as $$
begin
  if not public.is_admin() then return 'forbidden'; end if;
  if target = auth.uid() then return 'cannot_delete_self'; end if;
  if public.has_money_held(target) then return 'active_payments'; end if;
  perform public.purge_user(target);
  return 'ok';
end $$;

-- ---------- invites ----------
delete from public.invites where note = 'starter' and used_by is null and used_at is null;   -- these codes are public in the repo

create or replace function public.redeem_invite(code text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  normalized text := upper(regexp_replace(coalesce(code, ''), '\s', '', 'g'));
  h text := encode(digest(normalized, 'sha256'), 'hex');
  inv public.invites%rowtype;
begin
  if auth.uid() is null then return 'not_signed_in'; end if;
  if public.is_banned(auth.uid()) then return 'banned'; end if;
  begin
    perform public.rate_limit('invite_hour', 10, interval '1 hour');
  exception when others then return 'too_many_attempts';
  end;
  if normalized !~ '^CUV-[A-Z0-9]{4}-[A-Z0-9]{4}$' then return 'bad_format'; end if;
  select * into inv from public.invites where code_hash = h for update;
  if not found then return 'invalid'; end if;
  if inv.used_at is not null or inv.used_by is not null then return 'used'; end if;
  update public.invites set used_by = auth.uid(), used_at = now() where code_hash = h;
  update public.profiles set role = 'editor', updated_at = now() where id = auth.uid();
  return 'ok';
end $$;

create or replace function public.admin_create_invite(note text default null)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   -- 32 symbols: every random byte maps evenly
  b bytea := gen_random_bytes(8);
  code text := 'CUV-';
  i int;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  for i in 0..7 loop
    code := code || substr(alphabet, 1 + (get_byte(b, i) % 32), 1);
    if i = 3 then code := code || '-'; end if;
  end loop;
  insert into public.invites (code_hash, note, label, created_by)
  values (encode(digest(code, 'sha256'), 'hex'), left(note, 200), left(code, 8) || '****', auth.uid());
  return code;
end $$;

-- ---------- storage: only videos / images, 50 MB each, 200 files per editor ----------
create or replace function public.portfolio_file_count(uid uuid)
returns int language sql stable security definer set search_path = public, storage as $$
  select count(*)::int from storage.objects where bucket_id = 'portfolio' and name like uid::text || '/%';
$$;
update storage.buckets set file_size_limit = 52428800,
  allowed_mime_types = array['video/mp4','video/quicktime','video/webm','video/x-m4v','video/x-matroska','video/mpeg',
                             'image/jpeg','image/png','image/webp','image/gif']
where id = 'portfolio';

drop policy if exists "editors upload to own folder" on storage.objects;
create policy "editors upload to own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'portfolio' and (storage.foldername(name))[1] = auth.uid()::text
    and public.is_editor(auth.uid()) and not public.is_banned(auth.uid())
    and public.portfolio_file_count(auth.uid()) < 200);

-- ---------- partner courses ----------
alter table public.partner_courses drop constraint if exists partner_courses_sane;
alter table public.partner_courses add constraint partner_courses_sane check (
      length(name) between 1 and 150 and length(coalesce(author, '')) <= 150
  and (coalesce(url, '') = '' or public.is_safe_url(url))
  and (coalesce(referral_url, '') = '' or public.is_safe_url(referral_url))
) not valid;
