-- ============================================================
-- Cuvori — schema v5: escrow payments through Stripe
-- The client pays into Cuvori's Stripe balance; the money is released to
-- the editor when the client approves the delivery, when Cuvori resolves a
-- dispute, or automatically 7 days after delivery. Run AFTER schema_v4.sql.
-- ============================================================

-- ---------- contracts: escrow fields ----------
alter table public.contracts add column if not exists payment_mode text not null default 'direct';
alter table public.contracts add column if not exists amount_cents int;          -- price in cents (what the editor receives)
alter table public.contracts add column if not exists fee_cents int default 0;   -- processing fee paid by the client on top
alter table public.contracts add column if not exists stripe_checkout_id text;
alter table public.contracts add column if not exists stripe_payment_intent text;
alter table public.contracts add column if not exists stripe_transfer_id text;
alter table public.contracts add column if not exists stripe_refund_id text;
alter table public.contracts add column if not exists funded_at timestamptz;
alter table public.contracts add column if not exists delivered_at timestamptz;
alter table public.contracts add column if not exists delivery_note text;
alter table public.contracts add column if not exists delivery_url text;
alter table public.contracts add column if not exists auto_release_at timestamptz;
alter table public.contracts add column if not exists dispute_by uuid;
alter table public.contracts add column if not exists dispute_reason text;
alter table public.contracts add column if not exists disputed_at timestamptz;
alter table public.contracts add column if not exists resolution text;           -- release | refund | split
alter table public.contracts add column if not exists split_editor_cents int;
alter table public.contracts add column if not exists resolved_at timestamptz;
alter table public.contracts add column if not exists resolved_by uuid;

alter table public.contracts drop constraint if exists contracts_status_check;
alter table public.contracts add constraint contracts_status_check
  check (status in ('proposed','accepted','paid_marked','paid','funded','delivered','disputed','completed','refunded','declined','cancelled'));
alter table public.contracts drop constraint if exists contracts_payment_mode_check;
alter table public.contracts add constraint contracts_payment_mode_check check (payment_mode in ('direct','escrow'));

-- ---------- payout_details: Stripe Connect ----------
alter table public.payout_details add column if not exists stripe_account_id text;
alter table public.payout_details add column if not exists stripe_payouts_enabled boolean not null default false;

-- clients may check whether an editor can receive escrow payments (no account id exposed)
create or replace function public.editor_can_receive(ed uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select stripe_payouts_enabled from public.payout_details where id = ed), false);
$$;
grant execute on function public.editor_can_receive(uuid) to anon, authenticated;

-- ---------- propose_contract: choose the payment mode ----------
create or replace function public.propose_contract(conv uuid, title text, description text, price numeric, pricing text, deadline date, revisions int, mode text default 'direct')
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
    if auth.uid() = cv.user_a then cl := cv.user_a; ed := cv.user_b; else cl := cv.user_b; ed := cv.user_a; end if;
  else raise exception 'no editor in this conversation'; end if;
  if exists (select 1 from public.contracts x where x.conversation_id = conv and x.status in ('proposed','accepted','paid_marked','paid','funded','delivered','disputed')) then
    raise exception 'active_contract_exists';
  end if;
  insert into public.contracts (conversation_id, editor, client, proposed_by, title, description, price, pricing, deadline, revisions, payment_mode, amount_cents)
  values (conv, ed, cl, auth.uid(), title, coalesce(description,''), price, coalesce(pricing,'project'), deadline, coalesce(revisions,2),
          case when mode = 'escrow' then 'escrow' else 'direct' end, round(price * 100)::int)
  returning * into c;
  perform public.contract_event(c, 'proposed');
  return c.id;
end $$;
grant execute on function public.propose_contract(uuid, text, text, numeric, text, date, int, text) to authenticated;
drop function if exists public.propose_contract(uuid, text, text, numeric, text, date, int);

-- ---------- contract_action: adds deliver / request_changes / dispute / approve-for-direct ----------
create or replace function public.contract_action(cid uuid, action text, note text default null, link text default null)
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
    if note is not null and note <> '' then
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
grant execute on function public.contract_action(uuid, text, text, text) to authenticated;
drop function if exists public.contract_action(uuid, text);

-- ---------- admin overview (adds escrow columns + disputes) ----------
drop function if exists public.admin_list_contracts();
create or replace function public.admin_list_contracts()
returns table (id uuid, title text, price numeric, currency text, pricing text, status text, payment_mode text, created_at timestamptz,
               delivered_at timestamptz, disputed_at timestamptz, dispute_by uuid, dispute_reason text, delivery_note text, delivery_url text,
               auto_release_at timestamptz, resolution text, conversation_id uuid,
               editor uuid, editor_name text, editor_email text, client uuid, client_name text, client_email text)
language sql stable security definer set search_path = public as $$
  select c.id, c.title, c.price, c.currency, c.pricing, c.status, c.payment_mode, c.created_at,
         c.delivered_at, c.disputed_at, c.dispute_by, c.dispute_reason, c.delivery_note, c.delivery_url, c.auto_release_at, c.resolution, c.conversation_id,
         c.editor, coalesce(e.display_name, pe.first_name), pe.email, c.client, pc.first_name, pc.email
  from public.contracts c
  left join public.editor_profiles e on e.id = c.editor
  left join public.profiles pe on pe.id = c.editor
  left join public.profiles pc on pc.id = c.client
  where public.is_admin()
  order by (c.status = 'disputed') desc, c.created_at desc;
$$;
grant execute on function public.admin_list_contracts() to authenticated;
