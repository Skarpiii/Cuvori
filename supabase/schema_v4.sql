-- ============================================================
-- Cuvori — schema v4: contracts + direct payments (0% commission)
-- Money never goes through Cuvori. A contract records what both sides
-- agreed; the client pays the editor directly (bank, PayPal, …) and both
-- confirm it inside the contract. Run AFTER schema_v3.sql. Re-runnable.
-- ============================================================

-- ---------- how an editor wants to be paid ----------
create table if not exists public.payout_details (
  id          uuid primary key references public.profiles(id) on delete cascade,
  methods     jsonb not null default '[]',   -- [{type:'bank'|'paypal'|'revolut'|'wise'|'other', label, details}]
  note        text default '',
  updated_at  timestamptz not null default now()
);
alter table public.payout_details enable row level security;

drop policy if exists "owner manages payout details" on public.payout_details;
create policy "owner manages payout details"
  on public.payout_details for all to authenticated
  using (auth.uid() = id) with check (auth.uid() = id and public.is_editor(auth.uid()));

-- a client may read an editor's payout details only when they have a conversation together
create or replace function public.payout_info(ed uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case
    when auth.uid() is null then null
    when auth.uid() = ed or exists (select 1 from public.conversations c
         where (c.user_a = auth.uid() and c.user_b = ed) or (c.user_b = auth.uid() and c.user_a = ed))
      then (select jsonb_build_object('methods', p.methods, 'note', p.note) from public.payout_details p where p.id = ed)
    else null end;
$$;
grant execute on function public.payout_info(uuid) to authenticated;

-- ---------- contracts ----------
create table if not exists public.contracts (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  editor           uuid not null references public.profiles(id) on delete cascade,
  client           uuid not null references public.profiles(id) on delete cascade,
  proposed_by      uuid not null references public.profiles(id) on delete cascade,
  title            text not null,
  description      text default '',
  price            numeric(10,2) not null check (price >= 0),
  currency         text not null default 'EUR',
  pricing          text not null default 'project' check (pricing in ('project','hour','day')),
  deadline         date,
  revisions        int not null default 2,
  status           text not null default 'proposed'
                   check (status in ('proposed','accepted','paid_marked','paid','completed','declined','cancelled')),
  created_at       timestamptz not null default now(),
  accepted_at      timestamptz,
  paid_marked_at   timestamptz,
  paid_at          timestamptz,
  completed_at     timestamptz,
  closed_at        timestamptz
);
create index if not exists contracts_conv_idx on public.contracts(conversation_id, created_at desc);
alter table public.contracts enable row level security;

drop policy if exists "participants read contracts" on public.contracts;
create policy "participants read contracts"
  on public.contracts for select to authenticated
  using (auth.uid() in (editor, client) or public.is_admin());
-- no insert/update policies: everything goes through the functions below

-- messages can now carry a contract event
alter table public.messages drop constraint if exists messages_kind_check;
alter table public.messages add constraint messages_kind_check
  check (kind in ('text','report','change_request','contract'));

create or replace function public.contract_event(c public.contracts, ev text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.messages (conversation_id, sender, kind, body, payload)
  values (c.conversation_id, auth.uid(), 'contract', c.title,
          jsonb_build_object('contract_id', c.id, 'event', ev, 'title', c.title, 'price', c.price,
                             'currency', c.currency, 'pricing', c.pricing, 'status', c.status));
end $$;
revoke execute on function public.contract_event(public.contracts, text) from public, anon, authenticated;

-- propose a contract inside a conversation (either side can)
create or replace function public.propose_contract(conv uuid, title text, description text, price numeric, pricing text, deadline date, revisions int)
returns uuid language plpgsql security definer set search_path = public as $$
declare cv public.conversations%rowtype; ed uuid; cl uuid; c public.contracts%rowtype;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if public.is_banned(auth.uid()) then raise exception 'banned'; end if;
  select * into cv from public.conversations where id = conv and auth.uid() in (user_a, user_b);
  if not found then raise exception 'not your conversation'; end if;
  if public.is_editor(cv.user_a) and not public.is_editor(cv.user_b) then ed := cv.user_a; cl := cv.user_b;
  elsif public.is_editor(cv.user_b) and not public.is_editor(cv.user_a) then ed := cv.user_b; cl := cv.user_a;
  elsif public.is_editor(cv.user_a) and public.is_editor(cv.user_b) then
    -- two editors: the one proposing is the client (hiring the other)
    if auth.uid() = cv.user_a then cl := cv.user_a; ed := cv.user_b; else cl := cv.user_b; ed := cv.user_a; end if;
  else raise exception 'no editor in this conversation'; end if;
  if exists (select 1 from public.contracts x where x.conversation_id = conv and x.status in ('proposed','accepted','paid_marked','paid')) then
    raise exception 'active_contract_exists';
  end if;
  insert into public.contracts (conversation_id, editor, client, proposed_by, title, description, price, pricing, deadline, revisions)
  values (conv, ed, cl, auth.uid(), title, coalesce(description,''), price, coalesce(pricing,'project'), deadline, coalesce(revisions,2))
  returning * into c;
  perform public.contract_event(c, 'proposed');
  return c.id;
end $$;
grant execute on function public.propose_contract(uuid, text, text, numeric, text, date, int) to authenticated;

-- move a contract forward: accept / decline / cancel / mark_paid / confirm_paid / complete
create or replace function public.contract_action(cid uuid, action text)
returns text language plpgsql security definer set search_path = public as $$
declare c public.contracts%rowtype; me uuid := auth.uid();
begin
  if me is null then return 'not_signed_in'; end if;
  select * into c from public.contracts where id = cid and me in (editor, client);
  if not found then return 'not_found'; end if;
  if action = 'accept' then
    if c.status <> 'proposed' or c.proposed_by = me then return 'not_allowed'; end if;
    update public.contracts set status = 'accepted', accepted_at = now() where id = cid returning * into c;
  elsif action = 'decline' then
    if c.status <> 'proposed' or c.proposed_by = me then return 'not_allowed'; end if;
    update public.contracts set status = 'declined', closed_at = now() where id = cid returning * into c;
  elsif action = 'cancel' then
    if c.status not in ('proposed','accepted') then return 'not_allowed'; end if;
    update public.contracts set status = 'cancelled', closed_at = now() where id = cid returning * into c;
  elsif action = 'mark_paid' then
    if c.status <> 'accepted' or me <> c.client then return 'not_allowed'; end if;
    update public.contracts set status = 'paid_marked', paid_marked_at = now() where id = cid returning * into c;
  elsif action = 'confirm_paid' then
    if c.status not in ('accepted','paid_marked') or me <> c.editor then return 'not_allowed'; end if;
    update public.contracts set status = 'paid', paid_at = now(), paid_marked_at = coalesce(paid_marked_at, now()) where id = cid returning * into c;
  elsif action = 'complete' then
    if c.status <> 'paid' then return 'not_allowed'; end if;
    update public.contracts set status = 'completed', completed_at = now(), closed_at = now() where id = cid returning * into c;
  else return 'bad_action'; end if;
  perform public.contract_event(c, action);
  return 'ok';
end $$;
grant execute on function public.contract_action(uuid, text) to authenticated;

-- admin overview
create or replace function public.admin_list_contracts()
returns table (id uuid, title text, price numeric, currency text, pricing text, status text, created_at timestamptz,
               editor_name text, editor_email text, client_name text, client_email text)
language sql stable security definer set search_path = public as $$
  select c.id, c.title, c.price, c.currency, c.pricing, c.status, c.created_at,
         coalesce(e.display_name, pe.first_name), pe.email, pc.first_name, pc.email
  from public.contracts c
  left join public.editor_profiles e on e.id = c.editor
  left join public.profiles pe on pe.id = c.editor
  left join public.profiles pc on pc.id = c.client
  where public.is_admin()
  order by c.created_at desc;
$$;
grant execute on function public.admin_list_contracts() to authenticated;

-- purge_user also removes contracts and payout details
create or replace function public.purge_user(target uuid)
returns void language plpgsql security definer set search_path = public, storage as $$
begin
  delete from storage.objects where bucket_id = 'portfolio' and name like target::text || '/%';
  delete from public.contracts where editor = target or client = target;
  delete from public.payout_details where id = target;
  delete from public.reviews where client = target or editor = target;
  delete from public.messages where sender = target;
  delete from public.conversations where user_a = target or user_b = target;
  delete from public.jobs where owner = target;
  delete from public.projects where owner = target;
  delete from public.editor_profiles where id = target;
  update public.invites set used_by = null, note = coalesce(note,'') || ' [user deleted]' where used_by = target;
  delete from public.profiles where id = target;
  delete from auth.users where id = target;
end $$;
revoke execute on function public.purge_user(uuid) from public, anon, authenticated;
