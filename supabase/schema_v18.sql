-- ============================================================
-- Cuvori — schema v18: the Order is the contract.
-- Once client and freelancer accept the same version of an Order it is
-- their project agreement; the client funds it; work, review, approval and
-- release all hang off that one record. There is no separate contract to
-- sign. Run AFTER schema_v17.sql. Re-runnable.
--
-- The table is still called `contracts` (v4) so nothing that already works
-- breaks; everything user-facing calls it an Order.
-- ============================================================

-- ---------- the Order itself: structured terms, explicit acceptance, money counters ----------
alter table public.contracts add column if not exists profession_slug   text references public.professions(slug) on delete set null;
alter table public.contracts add column if not exists service_id        uuid references public.services(id) on delete set null;
alter table public.contracts add column if not exists job_id            uuid references public.jobs(id) on delete set null;
alter table public.contracts add column if not exists deliverables      text not null default '';
alter table public.contracts add column if not exists client_duties     text not null default '';
alter table public.contracts add column if not exists freelancer_duties text not null default '';
alter table public.contracts add column if not exists rights            text not null default 'full';
alter table public.contracts add column if not exists client_accepted_version     int;
alter table public.contracts add column if not exists client_accepted_at          timestamptz;
alter table public.contracts add column if not exists freelancer_accepted_version int;
alter table public.contracts add column if not exists freelancer_accepted_at      timestamptz;
alter table public.contracts add column if not exists accepted_version  int;
alter table public.contracts add column if not exists quote             jsonb;        -- the price breakdown the client saw and paid
alter table public.contracts add column if not exists funded_cents      int not null default 0;
alter table public.contracts add column if not exists released_cents    int not null default 0;
alter table public.contracts add column if not exists refunded_cents    int not null default 0;
alter table public.contracts add column if not exists has_milestones    boolean not null default false;
alter table public.contracts add column if not exists changes_open      boolean not null default false;
alter table public.contracts add column if not exists amendments        int not null default 0;
alter table public.contracts add column if not exists refund_cents      int;
alter table public.contracts add column if not exists money_error       text;
alter table public.contracts add column if not exists stripe_charge_id  text;

alter table public.contracts drop constraint if exists contracts_rights_check;
alter table public.contracts add constraint contracts_rights_check check (rights in ('full','license')) not valid;
alter table public.contracts drop constraint if exists contracts_deliverables_len;
alter table public.contracts add constraint contracts_deliverables_len check (length(deliverables) <= 3000 and length(client_duties) <= 2000 and length(freelancer_duties) <= 2000) not valid;
alter table public.contracts drop constraint if exists contracts_money_sane;
alter table public.contracts add constraint contracts_money_sane check (funded_cents >= 0 and released_cents >= 0 and refunded_cents >= 0 and released_cents + refunded_cents <= greatest(funded_cents, 0)) not valid;

-- ---------- milestones: parts of one Order, each with its own amount ----------
create table if not exists public.order_milestones (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.contracts(id) on delete cascade,
  position        int not null default 1,
  title           text not null,
  amount_cents    int not null check (amount_cents > 0),
  due             date,
  status          text not null default 'pending' check (status in ('pending','submitted','approved','released')),
  submitted_at    timestamptz,
  approved_at     timestamptz,
  released_at     timestamptz,
  auto_release_at timestamptz,
  delivery_note   text,
  delivery_url    text,
  transfer_ref    text,
  created_at      timestamptz not null default now()
);
create index if not exists order_milestones_order_idx on public.order_milestones(order_id, position);
alter table public.order_milestones enable row level security;
drop policy if exists "participants read milestones" on public.order_milestones;
create policy "participants read milestones" on public.order_milestones for select to authenticated
  using (exists (select 1 from public.contracts c where c.id = order_id and (auth.uid() in (c.editor, c.client) or public.is_admin())));

-- ---------- amendments: changes after acceptance, accepted by both ----------
create table if not exists public.order_amendments (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references public.contracts(id) on delete cascade,
  proposed_by       uuid not null references public.profiles(id) on delete cascade,
  note              text not null default '',
  price_delta_cents int not null default 0,
  new_deadline      date,
  scope_add         text not null default '',
  deliverables_add  text not null default '',
  revisions_add     int not null default 0,
  milestones        jsonb not null default '[]'::jsonb,     -- [{title, amount_cents, due}]
  status            text not null default 'proposed' check (status in ('proposed','accepted','declined','withdrawn')),
  created_at        timestamptz not null default now(),
  decided_at        timestamptz,
  decided_by        uuid
);
create index if not exists order_amendments_order_idx on public.order_amendments(order_id, created_at);
alter table public.order_amendments enable row level security;
drop policy if exists "participants read amendments" on public.order_amendments;
create policy "participants read amendments" on public.order_amendments for select to authenticated
  using (exists (select 1 from public.contracts c where c.id = order_id and (auth.uid() in (c.editor, c.client) or public.is_admin())));

-- ---------- history: what happened to an Order, in order, and it cannot be edited away ----------
create table if not exists public.order_events (
  id          bigserial primary key,
  order_id    uuid not null references public.contracts(id) on delete cascade,
  actor       uuid,                                          -- null = the system (payment provider, timer)
  event       text not null,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists order_events_order_idx on public.order_events(order_id, id);
alter table public.order_events enable row level security;
drop policy if exists "participants read order events" on public.order_events;
create policy "participants read order events" on public.order_events for select to authenticated
  using (exists (select 1 from public.contracts c where c.id = order_id and (auth.uid() in (c.editor, c.client) or public.is_admin())));
create or replace function public.order_events_immutable()
returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('cuvori.purge', true), '') = '1' then return coalesce(new, old); end if;
  -- the Order itself is being deleted (an account was removed): its history goes with it
  if tg_op = 'DELETE' and not exists (select 1 from public.contracts where id = old.order_id) then return old; end if;
  raise exception 'order history is append-only';
end $$;
drop trigger if exists order_events_no_edit on public.order_events;
create trigger order_events_no_edit before update or delete on public.order_events
  for each row execute function public.order_events_immutable();

-- ---------- the money ledger: every funding, release and refund, whoever made it ----------
create table if not exists public.order_payments (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.contracts(id) on delete cascade,
  milestone_id  uuid references public.order_milestones(id) on delete set null,
  kind          text not null check (kind in ('fund','release','refund')),
  amount_cents  int not null check (amount_cents > 0),      -- the Order money that moved
  fee_cents     int not null default 0,                     -- processing cost paid on top (funding only)
  provider      text not null default 'stripe',             -- 'stripe' | 'direct' (paid outside Cuvori, confirmed by both)
  provider_ref  text,
  status        text not null default 'succeeded' check (status in ('pending','succeeded','failed')),
  note          text not null default '',
  created_at    timestamptz not null default now()
);
create index if not exists order_payments_order_idx on public.order_payments(order_id, created_at);
alter table public.order_payments enable row level security;
drop policy if exists "participants read order payments" on public.order_payments;
create policy "participants read order payments" on public.order_payments for select to authenticated
  using (exists (select 1 from public.contracts c where c.id = order_id and (auth.uid() in (c.editor, c.client) or public.is_admin())));
drop trigger if exists order_payments_no_edit on public.order_payments;
create trigger order_payments_no_edit before delete on public.order_payments
  for each row execute function public.order_events_immutable();

-- ---------- processing cost: configurable, never a hard-coded "3%" ----------
-- One row per situation. The most specific active row wins: country > region > ANY,
-- then an exact customer kind / payment method over 'any'. `payer` says who carries the cost:
-- 'client' = added on top of the Order price (grossed up so the freelancer gets the exact price),
-- 'platform' = Cuvori absorbs it and the client pays exactly the Order price.
create table if not exists public.fee_schedules (
  id            serial primary key,
  provider      text not null default 'stripe',
  region        text not null default 'ANY' check (region in ('ANY','EEA','INTL')),
  country       text check (country is null or country ~ '^[A-Z]{2}$'),
  customer_kind text not null default 'any' check (customer_kind in ('any','consumer','business')),
  method        text not null default 'any' check (method ~ '^[a-z_]{1,20}$'),
  percent       numeric(7,4) not null default 0 check (percent >= 0 and percent < 50),
  fixed_cents   int not null default 0 check (fixed_cents >= 0 and fixed_cents <= 10000),
  currency      text not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  payer         text not null default 'client' check (payer in ('client','platform')),
  active        boolean not null default true,
  note          text not null default '',
  updated_at    timestamptz not null default now(),
  updated_by    uuid
);
create unique index if not exists fee_schedules_key on public.fee_schedules(provider, region, coalesce(country, ''), customer_kind, method, currency);
alter table public.fee_schedules enable row level security;
drop policy if exists "fee schedules are readable" on public.fee_schedules;
create policy "fee schedules are readable" on public.fee_schedules for select to anon, authenticated using (true);
-- starting values = Stripe's published European rates. Check them against your own Stripe pricing page.
insert into public.fee_schedules (provider, region, customer_kind, method, percent, fixed_cents, currency, payer, note) values
  ('stripe', 'EEA',  'any', 'any', 1.5,  25, 'EUR', 'client', 'Stripe: standard European cards, 1.5% + €0.25'),
  ('stripe', 'INTL', 'any', 'any', 3.25, 25, 'EUR', 'client', 'Stripe: non-European cards, 3.25% + €0.25'),
  ('stripe', 'ANY',  'any', 'any', 1.5,  25, 'EUR', 'client', 'Used when the client country is unknown')
on conflict do nothing;

create or replace function public.is_eea(p_country text)
returns boolean language sql immutable as $$
  select upper(coalesce(p_country, '')) in ('AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','IS','LI','NO');
$$;

-- What the client will actually pay for an Order price. Integer maths in minor units; the
-- provider takes its percentage of the amount charged, so the total is grossed up:
--   total = ceil((price + fixed) / (1 - percent))   → freelancer gets exactly `price`
create or replace function public.order_quote(p_price_cents int, p_currency text default 'EUR', p_country text default null,
                                              p_customer text default 'any', p_method text default 'any')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.fee_schedules%rowtype; reg text; total int; cur text := upper(coalesce(p_currency, 'EUR'));
begin
  if p_price_cents is null or p_price_cents < 0 or p_price_cents > 100000000 then raise exception 'bad_price'; end if;
  reg := case when p_country is null or p_country = '' then 'ANY' when public.is_eea(p_country) then 'EEA' else 'INTL' end;
  select * into s from public.fee_schedules f
   where f.active and f.currency = cur
     and (f.country = upper(p_country) or (f.country is null and f.region in (reg, 'ANY')))
     and f.customer_kind in (coalesce(p_customer, 'any'), 'any')
     and f.method in (coalesce(p_method, 'any'), 'any')
   order by (f.country is not null) desc, (f.region = reg) desc, (f.customer_kind <> 'any') desc, (f.method <> 'any') desc, f.id
   limit 1;
  if not found then
    return jsonb_build_object('price_cents', p_price_cents, 'processing_cents', 0, 'cuvori_cents', 0, 'total_cents', p_price_cents,
                              'currency', cur, 'payer', 'platform', 'percent', 0, 'fixed_cents', 0, 'schedule_id', null, 'region', reg);
  end if;
  if s.payer = 'platform' or p_price_cents = 0 then total := p_price_cents;
  else total := ceil((p_price_cents + s.fixed_cents)::numeric / (1 - s.percent / 100))::int; end if;
  return jsonb_build_object('price_cents', p_price_cents, 'processing_cents', total - p_price_cents, 'cuvori_cents', 0, 'total_cents', total,
                            'currency', cur, 'payer', s.payer, 'percent', s.percent, 'fixed_cents', s.fixed_cents, 'schedule_id', s.id, 'region', reg, 'provider', s.provider);
end $$;
grant execute on function public.order_quote(int, text, text, text, text) to anon, authenticated, service_role;

create or replace function public.admin_fee_schedules()
returns setof public.fee_schedules language sql stable security definer set search_path = public as $$
  select * from public.fee_schedules where public.is_admin() order by active desc, region, customer_kind, method, id;
$$;
grant execute on function public.admin_fee_schedules() to authenticated;

create or replace function public.admin_set_fee_schedule(p jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare v_id int := nullif(p->>'id', '')::int;
begin
  if not public.is_admin() then return 'forbidden'; end if;
  if v_id is null then
    insert into public.fee_schedules (provider, region, country, customer_kind, method, percent, fixed_cents, currency, payer, active, note, updated_by)
    values (coalesce(p->>'provider', 'stripe'), coalesce(p->>'region', 'ANY'), nullif(upper(p->>'country'), ''), coalesce(p->>'customer_kind', 'any'), coalesce(p->>'method', 'any'),
            coalesce((p->>'percent')::numeric, 0), coalesce((p->>'fixed_cents')::int, 0), upper(coalesce(p->>'currency', 'EUR')), coalesce(p->>'payer', 'client'),
            coalesce((p->>'active')::boolean, true), left(coalesce(p->>'note', ''), 300), auth.uid());
  else
    update public.fee_schedules set percent = coalesce((p->>'percent')::numeric, percent), fixed_cents = coalesce((p->>'fixed_cents')::int, fixed_cents),
           payer = coalesce(p->>'payer', payer), active = coalesce((p->>'active')::boolean, active), note = left(coalesce(p->>'note', note), 300),
           customer_kind = coalesce(p->>'customer_kind', customer_kind), method = coalesce(p->>'method', method), region = coalesce(p->>'region', region),
           country = case when p ? 'country' then nullif(upper(p->>'country'), '') else country end,
           updated_at = now(), updated_by = auth.uid()
     where id = v_id;
    if not found then return 'not_found'; end if;
  end if;
  return 'ok';
end $$;
grant execute on function public.admin_set_fee_schedule(jsonb) to authenticated;

-- ---------- helpers ----------
create or replace function public.order_log(p_order uuid, p_event text, p_data jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.order_events (order_id, actor, event, data) values (p_order, auth.uid(), p_event, coalesce(p_data, '{}'::jsonb));
$$;
revoke execute on function public.order_log(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.order_log(uuid, text, jsonb) to service_role;

-- the chat card. Short: title, amount, what happened. Clicking it opens the Order.
create or replace function public.contract_event(c public.contracts, ev text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.messages (conversation_id, sender, kind, body, payload)
  values (c.conversation_id, coalesce(auth.uid(), c.editor), 'contract', c.title,
          jsonb_build_object('contract_id', c.id, 'event', ev, 'title', c.title, 'price', c.price, 'currency', c.currency, 'pricing', c.pricing,
                             'status', c.status, 'amount_cents', c.amount_cents));
end $$;

create or replace function public.order_amount_event(c public.contracts, ev text, p_cents int, p_label text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.messages (conversation_id, sender, kind, body, payload)
  values (c.conversation_id, coalesce(auth.uid(), c.editor), 'contract', c.title,
          jsonb_build_object('contract_id', c.id, 'event', ev, 'title', c.title, 'price', c.price, 'currency', c.currency, 'pricing', c.pricing,
                             'status', c.status, 'amount_cents', p_cents, 'label', left(coalesce(p_label, ''), 120)));
end $$;
revoke execute on function public.order_amount_event(public.contracts, text, int, text) from public, anon, authenticated;

create or replace function public.order_party(cv public.conversations, me uuid, out freelancer uuid, out client uuid)
language plpgsql stable security definer set search_path = public as $$
begin
  if public.is_editor(cv.user_a) and not public.is_editor(cv.user_b) then freelancer := cv.user_a; client := cv.user_b;
  elsif public.is_editor(cv.user_b) and not public.is_editor(cv.user_a) then freelancer := cv.user_b; client := cv.user_a;
  elsif public.is_editor(cv.user_a) and public.is_editor(cv.user_b) then
    -- two professionals: whoever creates the Order is hiring the other
    if me = cv.user_a then client := cv.user_a; freelancer := cv.user_b; else client := cv.user_b; freelancer := cv.user_a; end if;
  else raise exception 'no_professional'; end if;
end $$;
revoke execute on function public.order_party(public.conversations, uuid) from public, anon, authenticated;

-- milestones from json: [{title, amount_cents, due}] — at most 20, each > 0, summing to the Order price
create or replace function public.order_milestones_ok(p jsonb, p_price_cents int)
returns void language plpgsql stable as $$
declare m jsonb; n int := 0; total bigint := 0;
begin
  if p is null or jsonb_typeof(p) <> 'array' then return; end if;
  for m in select * from jsonb_array_elements(p) loop
    n := n + 1;
    if jsonb_typeof(m) <> 'object' then raise exception 'bad_milestones'; end if;
    if length(btrim(coalesce(m->>'title', ''))) < 1 or length(m->>'title') > 120 then raise exception 'bad_milestones'; end if;
    if (m->>'amount_cents') is null or (m->>'amount_cents') !~ '^[0-9]{1,9}$' or (m->>'amount_cents')::int <= 0 then raise exception 'bad_milestones'; end if;
    if nullif(m->>'due', '') is not null and (m->>'due')::date < current_date then raise exception 'deadline_in_past'; end if;
    total := total + (m->>'amount_cents')::int;
  end loop;
  if n > 20 then raise exception 'too_many_milestones'; end if;
  if n = 1 then raise exception 'bad_milestones'; end if;       -- one milestone is just the whole Order
  if n > 0 and total <> p_price_cents then raise exception 'milestones_sum'; end if;
end $$;

create or replace function public.order_input_ok(p jsonb, p_mode text)
returns void language plpgsql stable as $$
declare price int; rev int; dl date;
begin
  if p is null or jsonb_typeof(p) <> 'object' or pg_column_size(p) > 60000 then raise exception 'bad_terms'; end if;
  if length(btrim(coalesce(p->>'title', ''))) < 1 or length(p->>'title') > 200 then raise exception 'bad_title'; end if;
  if length(coalesce(p->>'scope', '')) > 5000 then raise exception 'description_too_long'; end if;
  if length(coalesce(p->>'deliverables', '')) > 3000 or length(coalesce(p->>'client_duties', '')) > 2000 or length(coalesce(p->>'freelancer_duties', '')) > 2000
     or length(coalesce(p->>'custom', '')) > 5000 then raise exception 'description_too_long'; end if;
  if (p->>'price_cents') is null or (p->>'price_cents') !~ '^[0-9]{1,9}$' then raise exception 'bad_price'; end if;
  price := (p->>'price_cents')::int;
  if price < 100 or price > 100000000 then raise exception 'bad_price'; end if;            -- €1 … €1,000,000
  rev := coalesce(nullif(p->>'revisions', '')::int, 2);
  if rev < 0 or rev > 50 then raise exception 'bad_revisions'; end if;
  dl := nullif(p->>'deadline', '')::date;
  if dl is not null and dl < current_date then raise exception 'deadline_in_past'; end if;
  if coalesce(p->>'rights', 'full') not in ('full', 'license') then raise exception 'bad_rights'; end if;
  if coalesce(p->>'currency', 'EUR') <> 'EUR' then raise exception 'bad_currency'; end if;
  if coalesce(p->>'language', 'en') not in ('en','de','ru','lt','es','pl','uk') then raise exception 'bad_language'; end if;
  if upper(coalesce(p->>'law', 'XX')) !~ '^[A-Z]{2}$' then raise exception 'bad_country'; end if;
  if nullif(p->>'profession_slug', '') is not null and not exists (select 1 from public.professions where slug = p->>'profession_slug') then raise exception 'bad_profession'; end if;
  perform public.order_milestones_ok(p->'milestones', price);
end $$;

create or replace function public.order_write_milestones(p_order uuid, p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare m jsonb; i int := 0;
begin
  delete from public.order_milestones where order_id = p_order and status = 'pending';
  if p is null or jsonb_typeof(p) <> 'array' then return; end if;
  for m in select * from jsonb_array_elements(p) loop
    i := i + 1;
    insert into public.order_milestones (order_id, position, title, amount_cents, due)
    values (p_order, i, btrim(m->>'title'), (m->>'amount_cents')::int, nullif(m->>'due', '')::date);
  end loop;
end $$;
revoke execute on function public.order_write_milestones(uuid, jsonb) from public, anon, authenticated;

-- the adjustable clause switches the standard terms engine reads (kept from v11 so the
-- accepted wording can still be frozen and printed)
create or replace function public.order_terms_json(p jsonb)
returns jsonb language sql immutable as $$
  select jsonb_build_object('on', jsonb_build_object('usage', coalesce(p->>'rights', 'full') = 'full', 'cancel', true, 'liability', true, 'force', true, 'vat', true, 'materials', true, 'credit', true),
                            'custom', left(coalesce(p->>'custom', ''), 5000), 'cancel_days', 7, 'grace_days', 7);
$$;

-- ---------- create an Order inside a conversation (either side can) ----------
create or replace function public.order_create(p_conv uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare cv public.conversations%rowtype; fl uuid; cl uuid; c public.contracts%rowtype; me uuid := auth.uid(); mode text; price int;
begin
  if me is null then raise exception 'not_signed_in'; end if;
  if public.is_banned(me) then raise exception 'banned'; end if;
  select * into cv from public.conversations where id = p_conv and me in (user_a, user_b) for update;
  if not found then raise exception 'not_your_conversation'; end if;
  if public.is_banned(cv.user_a) or public.is_banned(cv.user_b) then raise exception 'not_available'; end if;
  mode := case when p->>'mode' = 'escrow' then 'escrow' else 'direct' end;
  perform public.order_input_ok(p, mode);
  select * into fl, cl from public.order_party(cv, me);
  if exists (select 1 from public.contracts x where x.conversation_id = p_conv
             and x.status in ('proposed','accepted','paid_marked','paid','funded','delivered','disputed','releasing','resolving')) then
    raise exception 'active_contract_exists';
  end if;
  perform public.rate_limit('contract_hour', 20, interval '1 hour');
  price := (p->>'price_cents')::int;
  insert into public.contracts (conversation_id, editor, client, proposed_by, title, description, price, pricing, deadline, revisions, payment_mode, amount_cents,
                                contract_type, law_country, language, terms, terms_version, terms_changed_by,
                                profession_slug, service_id, job_id, deliverables, client_duties, freelancer_duties, rights, has_milestones,
                                client_accepted_version, client_accepted_at, freelancer_accepted_version, freelancer_accepted_at)
  values (p_conv, fl, cl, me, btrim(p->>'title'), coalesce(p->>'scope', ''), price / 100.0, 'project', nullif(p->>'deadline', '')::date, coalesce(nullif(p->>'revisions', '')::int, 2), mode, price,
          'fixed', upper(coalesce(p->>'law', 'XX')), coalesce(p->>'language', 'en'), public.order_terms_json(p), 1, me,
          nullif(p->>'profession_slug', ''), nullif(p->>'service_id', '')::uuid, nullif(p->>'job_id', '')::uuid,
          coalesce(p->>'deliverables', ''), coalesce(p->>'client_duties', ''), coalesce(p->>'freelancer_duties', ''), coalesce(p->>'rights', 'full'),
          coalesce(jsonb_typeof(p->'milestones') = 'array' and jsonb_array_length(p->'milestones') > 0, false),
          case when me = cl then 1 end, case when me = cl then now() end, case when me = fl then 1 end, case when me = fl then now() end)
  returning * into c;
  perform public.order_write_milestones(c.id, p->'milestones');
  perform public.order_log(c.id, 'created', jsonb_build_object('version', 1, 'price_cents', price, 'milestones', coalesce(p->'milestones', '[]'::jsonb)));
  perform public.order_log(c.id, case when me = cl then 'client_accepted' else 'freelancer_accepted' end, jsonb_build_object('version', 1));
  perform public.contract_event(c, 'proposed');
  return c.id;
end $$;
grant execute on function public.order_create(uuid, jsonb) to authenticated;

-- ---------- change an Order that is not yet accepted by both: the other side must accept again ----------
create or replace function public.order_update(p_order uuid, p jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare c public.contracts%rowtype; me uuid := auth.uid(); v_price int; v int;
begin
  if me is null then return 'not_signed_in'; end if;
  select * into c from public.contracts where id = p_order and me in (editor, client) for update;
  if not found then return 'not_found'; end if;
  if public.is_banned(me) or public.is_banned(c.editor) or public.is_banned(c.client) then return 'banned'; end if;
  if c.status <> 'proposed' then return 'not_allowed'; end if;
  if c.terms_version >= 50 then return 'too_many_changes'; end if;
  perform public.order_input_ok(p, c.payment_mode);
  begin perform public.rate_limit('contract_action', 60, interval '1 hour'); exception when others then return 'rate_limited'; end;
  v_price := (p->>'price_cents')::int; v := c.terms_version + 1;
  update public.contracts set title = btrim(p->>'title'), description = coalesce(p->>'scope', ''), price = v_price / 100.0, amount_cents = v_price,
         deadline = nullif(p->>'deadline', '')::date, revisions = coalesce(nullif(p->>'revisions', '')::int, 2),
         law_country = upper(coalesce(p->>'law', c.law_country)), language = coalesce(p->>'language', c.language), terms = public.order_terms_json(p),
         profession_slug = coalesce(nullif(p->>'profession_slug', ''), c.profession_slug), service_id = coalesce(nullif(p->>'service_id', '')::uuid, c.service_id),
         deliverables = coalesce(p->>'deliverables', ''), client_duties = coalesce(p->>'client_duties', ''), freelancer_duties = coalesce(p->>'freelancer_duties', ''),
         rights = coalesce(p->>'rights', 'full'), has_milestones = coalesce(jsonb_typeof(p->'milestones') = 'array' and jsonb_array_length(p->'milestones') > 0, false),
         terms_version = v, terms_changed_by = me, proposed_by = me,
         -- the old acceptance is gone: only the person who made the change has accepted this version
         client_accepted_version = case when me = c.client then v end, client_accepted_at = case when me = c.client then now() end,
         freelancer_accepted_version = case when me = c.editor then v end, freelancer_accepted_at = case when me = c.editor then now() end
   where id = p_order returning * into c;
  perform public.order_write_milestones(c.id, p->'milestones');
  perform public.order_log(c.id, 'updated', jsonb_build_object('version', v, 'price_cents', v_price, 'title', c.title, 'deadline', c.deadline, 'milestones', coalesce(p->'milestones', '[]'::jsonb)));
  perform public.order_log(c.id, case when me = c.client then 'client_accepted' else 'freelancer_accepted' end, jsonb_build_object('version', v));
  perform public.contract_event(c, 'terms_changed');
  return 'ok';
end $$;
grant execute on function public.order_update(uuid, jsonb) to authenticated;

-- ---------- accept the current version; when both have, the Order is the agreement ----------
create or replace function public.order_accept(p_order uuid)
returns text language plpgsql security definer set search_path = public as $$
declare c public.contracts%rowtype; me uuid := auth.uid();
begin
  if me is null then return 'not_signed_in'; end if;
  select * into c from public.contracts where id = p_order and me in (editor, client) for update;
  if not found then return 'not_found'; end if;
  if public.is_banned(me) or public.is_banned(c.editor) or public.is_banned(c.client) then return 'banned'; end if;
  if c.status <> 'proposed' then return 'not_allowed'; end if;
  begin perform public.rate_limit('contract_action', 60, interval '1 hour'); exception when others then return 'rate_limited'; end;
  -- Orders made before v18 carry no acceptance columns: whoever proposed had accepted their own draft
  if c.client_accepted_version is null and c.freelancer_accepted_version is null then
    if c.proposed_by = c.client then c.client_accepted_version := c.terms_version; else c.freelancer_accepted_version := c.terms_version; end if;
  end if;
  if me = c.client then
    if c.client_accepted_version = c.terms_version then return 'already_accepted'; end if;
    c.client_accepted_version := c.terms_version; c.client_accepted_at := now();
    perform public.order_log(c.id, 'client_accepted', jsonb_build_object('version', c.terms_version));
  else
    if c.freelancer_accepted_version = c.terms_version then return 'already_accepted'; end if;
    c.freelancer_accepted_version := c.terms_version; c.freelancer_accepted_at := now();
    perform public.order_log(c.id, 'freelancer_accepted', jsonb_build_object('version', c.terms_version));
  end if;
  if c.client_accepted_version = c.terms_version and c.freelancer_accepted_version = c.terms_version then
    update public.contracts set client_accepted_version = c.client_accepted_version, client_accepted_at = c.client_accepted_at,
           freelancer_accepted_version = c.freelancer_accepted_version, freelancer_accepted_at = c.freelancer_accepted_at,
           status = 'accepted', accepted_at = now(), accepted_version = c.terms_version where id = c.id returning * into c;
    perform public.order_log(c.id, 'accepted', jsonb_build_object('version', c.terms_version, 'price_cents', c.amount_cents));
    perform public.contract_event(c, 'accept');
  else
    update public.contracts set client_accepted_version = c.client_accepted_version, client_accepted_at = c.client_accepted_at,
           freelancer_accepted_version = c.freelancer_accepted_version, freelancer_accepted_at = c.freelancer_accepted_at where id = c.id returning * into c;
    perform public.contract_event(c, case when me = c.client then 'client_accepted' else 'freelancer_accepted' end);
  end if;
  return 'ok';
end $$;
grant execute on function public.order_accept(uuid) to authenticated;

-- ---------- everything else that moves an Order forward ----------
-- decline | cancel | mark_paid | confirm_paid | complete (direct payments) | deliver | request_changes | dispute
create or replace function public.order_action(p_order uuid, p_action text, p_note text default null, p_link text default null)
returns text language plpgsql security definer set search_path = public as $$
declare c public.contracts%rowtype; me uuid := auth.uid(); ev text := p_action;
begin
  if me is null then return 'not_signed_in'; end if;
  select * into c from public.contracts where id = p_order and me in (editor, client) for update;
  if not found then return 'not_found'; end if;
  if public.is_banned(me) then return 'banned'; end if;
  p_note := nullif(btrim(coalesce(p_note, '')), ''); p_link := nullif(btrim(coalesce(p_link, '')), '');
  if length(coalesce(p_note, '')) > 2000 then return 'note_too_long'; end if;
  if p_link is not null and not public.is_safe_url(p_link) then return 'bad_link'; end if;
  begin perform public.rate_limit('contract_action', 60, interval '1 hour'); exception when others then return 'rate_limited'; end;
  if p_action = 'accept' then return public.order_accept(p_order);
  elsif p_action = 'decline' then
    if c.status <> 'proposed' or c.proposed_by = me then return 'not_allowed'; end if;
    update public.contracts set status = 'declined', closed_at = now() where id = c.id returning * into c;
    perform public.order_log(c.id, 'declined', jsonb_build_object('note', p_note));
  elsif p_action = 'cancel' then
    -- before money is held either side can walk away; a funded Order ends only by approval, refund or Cuvori's decision
    if c.status in ('proposed','accepted') then null;
    elsif c.payment_mode = 'direct' and c.status in ('paid_marked') then null;
    else return 'not_allowed'; end if;
    update public.contracts set status = 'cancelled', closed_at = now() where id = c.id returning * into c;
    perform public.order_log(c.id, 'cancelled', jsonb_build_object('note', p_note));
  elsif p_action = 'mark_paid' then
    if c.payment_mode <> 'direct' or c.status <> 'accepted' or me <> c.client then return 'not_allowed'; end if;
    update public.contracts set status = 'paid_marked', paid_marked_at = now() where id = c.id returning * into c;
    perform public.order_log(c.id, 'paid_marked', '{}'::jsonb);
  elsif p_action = 'confirm_paid' then
    if c.payment_mode <> 'direct' or c.status not in ('accepted','paid_marked') or me <> c.editor then return 'not_allowed'; end if;
    update public.contracts set status = 'paid', paid_at = now(), paid_marked_at = coalesce(paid_marked_at, now()), funded_cents = amount_cents where id = c.id returning * into c;
    insert into public.order_payments (order_id, kind, amount_cents, provider, note) values (c.id, 'fund', c.amount_cents, 'direct', 'confirmed by the freelancer');
    perform public.order_log(c.id, 'paid_confirmed', jsonb_build_object('amount_cents', c.amount_cents));
  elsif p_action = 'complete' then
    if c.payment_mode <> 'direct' or c.status <> 'paid' or me <> c.client then return 'not_allowed'; end if;
    update public.contracts set status = 'completed', completed_at = now(), closed_at = now(), released_cents = funded_cents where id = c.id returning * into c;
    insert into public.order_payments (order_id, kind, amount_cents, provider, note) values (c.id, 'release', c.amount_cents, 'direct', 'work approved by the client');
    perform public.order_log(c.id, 'completed', '{}'::jsonb);
  elsif p_action = 'deliver' then
    if c.status not in ('funded','paid') or me <> c.editor or c.has_milestones then return 'not_allowed'; end if;
    if c.payment_mode = 'escrow' then
      update public.contracts set status = 'delivered', delivered_at = now(), delivery_note = p_note, delivery_url = p_link, changes_open = false,
             auto_release_at = now() + (coalesce(c.auto_days, 7) || ' days')::interval where id = c.id returning * into c;
    else
      update public.contracts set delivered_at = now(), delivery_note = p_note, delivery_url = p_link, changes_open = false where id = c.id returning * into c;
    end if;
    perform public.order_log(c.id, 'delivered', jsonb_build_object('note', p_note, 'link', p_link));
  elsif p_action = 'request_changes' then
    if me <> c.client then return 'not_allowed'; end if;
    if c.payment_mode = 'escrow' then
      if c.status <> 'delivered' then return 'not_allowed'; end if;
      -- within the paid revision rounds the review clock stops; after them it keeps running (a dispute is the route then)
      if c.changes_used < coalesce(c.revisions, 0) then
        update public.contracts set status = 'funded', changes_used = c.changes_used + 1, changes_open = true, auto_release_at = null where id = c.id returning * into c;
      else
        update public.contracts set changes_used = c.changes_used + 1, changes_open = true where id = c.id returning * into c;
      end if;
    else
      if c.status not in ('paid','paid_marked','accepted') or c.delivered_at is null then return 'not_allowed'; end if;
      update public.contracts set changes_used = c.changes_used + 1, changes_open = true where id = c.id returning * into c;
    end if;
    if p_note is not null then insert into public.messages (conversation_id, sender, kind, body) values (c.conversation_id, me, 'change_request', p_note); end if;
    perform public.order_log(c.id, 'changes_requested', jsonb_build_object('note', p_note, 'round', c.changes_used));
  elsif p_action = 'dispute' then
    if c.payment_mode <> 'escrow' or c.status not in ('funded','delivered') then return 'not_allowed'; end if;
    update public.contracts set status = 'disputed', dispute_by = me, dispute_reason = p_note, disputed_at = now(), auto_release_at = null where id = c.id returning * into c;
    update public.order_milestones set auto_release_at = null where order_id = c.id;
    perform public.order_log(c.id, 'disputed', jsonb_build_object('note', p_note));
  else return 'bad_action'; end if;
  perform public.contract_event(c, ev);
  return 'ok';
end $$;
grant execute on function public.order_action(uuid, text, text, text) to authenticated;

-- the v5/v11 name keeps working for anything that still calls it
create or replace function public.contract_action(cid uuid, action text, note text default null, link text default null)
returns text language sql security definer set search_path = public as $$
  select public.order_action(cid, action, note, link);
$$;

-- ---------- milestones: submit / send back / approve (direct payments) ----------
-- With protected payments the approval that moves money is stripe-release with a milestone id.
create or replace function public.order_milestone_action(p_ms uuid, p_action text, p_note text default null, p_link text default null)
returns text language plpgsql security definer set search_path = public as $$
declare m public.order_milestones%rowtype; c public.contracts%rowtype; me uuid := auth.uid(); left_open int;
begin
  if me is null then return 'not_signed_in'; end if;
  select * into m from public.order_milestones where id = p_ms for update;
  if not found then return 'not_found'; end if;
  select * into c from public.contracts where id = m.order_id and me in (editor, client) for update;
  if not found then return 'not_found'; end if;
  if public.is_banned(me) then return 'banned'; end if;
  p_note := nullif(btrim(coalesce(p_note, '')), ''); p_link := nullif(btrim(coalesce(p_link, '')), '');
  if length(coalesce(p_note, '')) > 2000 then return 'note_too_long'; end if;
  if p_link is not null and not public.is_safe_url(p_link) then return 'bad_link'; end if;
  begin perform public.rate_limit('contract_action', 60, interval '1 hour'); exception when others then return 'rate_limited'; end;
  if p_action = 'submit' then
    if me <> c.editor or c.status not in ('funded','paid') or m.status <> 'pending' then return 'not_allowed'; end if;
    update public.order_milestones set status = 'submitted', submitted_at = now(), delivery_note = p_note, delivery_url = p_link,
           auto_release_at = case when c.payment_mode = 'escrow' then now() + (coalesce(c.auto_days, 7) || ' days')::interval end where id = m.id returning * into m;
    update public.contracts set changes_open = false where id = c.id returning * into c;
    perform public.order_log(c.id, 'milestone_submitted', jsonb_build_object('milestone', m.id, 'title', m.title, 'amount_cents', m.amount_cents, 'note', p_note, 'link', p_link));
    perform public.order_amount_event(c, 'milestone_submitted', m.amount_cents, m.title);
  elsif p_action = 'request_changes' then
    if me <> c.client or m.status <> 'submitted' then return 'not_allowed'; end if;
    if c.changes_used < coalesce(c.revisions, 0) then
      update public.order_milestones set status = 'pending', auto_release_at = null where id = m.id returning * into m;
      update public.contracts set changes_used = c.changes_used + 1, changes_open = true where id = c.id returning * into c;
    else
      update public.contracts set changes_used = c.changes_used + 1, changes_open = true where id = c.id returning * into c;   -- clock keeps running
    end if;
    if p_note is not null then insert into public.messages (conversation_id, sender, kind, body) values (c.conversation_id, me, 'change_request', p_note); end if;
    perform public.order_log(c.id, 'milestone_changes_requested', jsonb_build_object('milestone', m.id, 'title', m.title, 'note', p_note, 'round', c.changes_used));
    perform public.order_amount_event(c, 'request_changes', m.amount_cents, m.title);
  elsif p_action = 'approve' then
    -- direct payments only: approval records agreement, the money moved outside Cuvori
    if me <> c.client or c.payment_mode <> 'direct' or m.status <> 'submitted' then return 'not_allowed'; end if;
    update public.order_milestones set status = 'approved', approved_at = now() where id = m.id returning * into m;
    perform public.order_log(c.id, 'milestone_approved', jsonb_build_object('milestone', m.id, 'title', m.title, 'amount_cents', m.amount_cents));
    perform public.order_amount_event(c, 'milestone_approved', m.amount_cents, m.title);
    select count(*) into left_open from public.order_milestones where order_id = c.id and status not in ('approved','released');
    if left_open = 0 then update public.contracts set delivered_at = now() where id = c.id; end if;
  else return 'bad_action'; end if;
  return 'ok';
end $$;
grant execute on function public.order_milestone_action(uuid, text, text, text) to authenticated;

-- ---------- amendments: change an accepted Order only with both signatures ----------
create or replace function public.order_amend(p_order uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare c public.contracts%rowtype; me uuid := auth.uid(); a public.order_amendments%rowtype; delta int; new_total int; m jsonb; ms_total bigint := 0;
begin
  if me is null then raise exception 'not_signed_in'; end if;
  select * into c from public.contracts where id = p_order and me in (editor, client) for update;
  if not found then raise exception 'not_found'; end if;
  if public.is_banned(me) or public.is_banned(c.editor) or public.is_banned(c.client) then raise exception 'banned'; end if;
  if c.status not in ('accepted','paid_marked','paid','funded','delivered') then raise exception 'not_allowed'; end if;
  if exists (select 1 from public.order_amendments where order_id = c.id and status = 'proposed') then raise exception 'amendment_open'; end if;
  if p is null or jsonb_typeof(p) <> 'object' or pg_column_size(p) > 20000 then raise exception 'bad_terms'; end if;
  if length(coalesce(p->>'note', '')) > 2000 or length(coalesce(p->>'scope_add', '')) > 3000 or length(coalesce(p->>'deliverables_add', '')) > 2000 then raise exception 'description_too_long'; end if;
  delta := coalesce(nullif(p->>'price_delta_cents', '')::int, 0);
  if delta < -c.amount_cents or delta > 100000000 then raise exception 'bad_price'; end if;
  new_total := c.amount_cents + delta;
  if new_total < 100 then raise exception 'bad_price'; end if;
  if delta < 0 and (c.has_milestones or c.status in ('funded','delivered')) then raise exception 'bad_price'; end if;   -- money already held cannot be talked down
  if nullif(p->>'new_deadline', '') is not null and (p->>'new_deadline')::date < current_date then raise exception 'deadline_in_past'; end if;
  if coalesce(nullif(p->>'revisions_add', '')::int, 0) < 0 or coalesce(nullif(p->>'revisions_add', '')::int, 0) > 50 then raise exception 'bad_revisions'; end if;
  if jsonb_typeof(p->'milestones') = 'array' and jsonb_array_length(p->'milestones') > 0 then
    if not c.has_milestones then raise exception 'bad_milestones'; end if;
    for m in select * from jsonb_array_elements(p->'milestones') loop
      if length(btrim(coalesce(m->>'title', ''))) < 1 or length(m->>'title') > 120 or (m->>'amount_cents') !~ '^[0-9]{1,9}$' or (m->>'amount_cents')::int <= 0 then raise exception 'bad_milestones'; end if;
      ms_total := ms_total + (m->>'amount_cents')::int;
    end loop;
    if ms_total <> delta then raise exception 'milestones_sum'; end if;   -- new milestones are exactly the extra money
    if (select count(*) from public.order_milestones where order_id = c.id) + jsonb_array_length(p->'milestones') > 20 then raise exception 'too_many_milestones'; end if;
  elsif c.has_milestones and delta > 0 then raise exception 'milestones_sum'; end if;
  if length(coalesce(p->>'note', '')) < 1 and delta = 0 and nullif(p->>'new_deadline', '') is null and coalesce(p->>'scope_add', '') = '' and coalesce(p->>'deliverables_add', '') = '' and coalesce(nullif(p->>'revisions_add', '')::int, 0) = 0 then
    raise exception 'bad_terms';
  end if;
  begin perform public.rate_limit('contract_action', 60, interval '1 hour'); exception when others then raise exception 'rate_limited'; end;
  insert into public.order_amendments (order_id, proposed_by, note, price_delta_cents, new_deadline, scope_add, deliverables_add, revisions_add, milestones)
  values (c.id, me, coalesce(p->>'note', ''), delta, nullif(p->>'new_deadline', '')::date, coalesce(p->>'scope_add', ''), coalesce(p->>'deliverables_add', ''),
          coalesce(nullif(p->>'revisions_add', '')::int, 0), coalesce(p->'milestones', '[]'::jsonb))
  returning * into a;
  perform public.order_log(c.id, 'amendment_proposed', jsonb_build_object('amendment', a.id, 'price_delta_cents', delta, 'new_deadline', a.new_deadline, 'note', a.note));
  perform public.order_amount_event(c, 'amendment_proposed', delta, a.note);
  return a.id;
end $$;
grant execute on function public.order_amend(uuid, jsonb) to authenticated;

create or replace function public.order_amendment_decide(p_amend uuid, p_accept boolean)
returns text language plpgsql security definer set search_path = public as $$
declare a public.order_amendments%rowtype; c public.contracts%rowtype; me uuid := auth.uid(); m jsonb; i int; n int;
begin
  if me is null then return 'not_signed_in'; end if;
  select * into a from public.order_amendments where id = p_amend for update;
  if not found then return 'not_found'; end if;
  select * into c from public.contracts where id = a.order_id and me in (editor, client) for update;
  if not found then return 'not_found'; end if;
  if public.is_banned(me) then return 'banned'; end if;
  if a.status <> 'proposed' then return 'not_allowed'; end if;
  begin perform public.rate_limit('contract_action', 60, interval '1 hour'); exception when others then return 'rate_limited'; end;
  if a.proposed_by = me then
    if p_accept then return 'not_allowed'; end if;
    update public.order_amendments set status = 'withdrawn', decided_at = now(), decided_by = me where id = a.id;
    perform public.order_log(c.id, 'amendment_withdrawn', jsonb_build_object('amendment', a.id));
    return 'ok';
  end if;
  if not p_accept then
    update public.order_amendments set status = 'declined', decided_at = now(), decided_by = me where id = a.id;
    perform public.order_log(c.id, 'amendment_declined', jsonb_build_object('amendment', a.id));
    perform public.order_amount_event(c, 'amendment_declined', a.price_delta_cents, a.note);
    return 'ok';
  end if;
  if c.status not in ('accepted','paid_marked','paid','funded','delivered') then return 'not_allowed'; end if;
  n := c.amendments + 1;
  update public.contracts set amount_cents = amount_cents + a.price_delta_cents, price = (amount_cents + a.price_delta_cents) / 100.0,
         deadline = coalesce(a.new_deadline, deadline), revisions = revisions + a.revisions_add,
         description = case when a.scope_add <> '' then description || E'\n\n' || 'Amendment ' || n || ': ' || a.scope_add else description end,
         deliverables = case when a.deliverables_add <> '' then deliverables || E'\n' || a.deliverables_add else deliverables end,
         amendments = n
   where id = c.id returning * into c;
  if jsonb_typeof(a.milestones) = 'array' and jsonb_array_length(a.milestones) > 0 then
    select coalesce(max(position), 0) into i from public.order_milestones where order_id = c.id;
    for m in select * from jsonb_array_elements(a.milestones) loop
      i := i + 1;
      insert into public.order_milestones (order_id, position, title, amount_cents, due) values (c.id, i, btrim(m->>'title'), (m->>'amount_cents')::int, nullif(m->>'due', '')::date);
    end loop;
  end if;
  update public.order_amendments set status = 'accepted', decided_at = now(), decided_by = me where id = a.id;
  perform public.order_log(c.id, 'amendment_accepted', jsonb_build_object('amendment', a.id, 'price_delta_cents', a.price_delta_cents, 'price_cents', c.amount_cents, 'deadline', c.deadline, 'n', n));
  perform public.order_amount_event(c, 'amendment_accepted', a.price_delta_cents, a.note);
  return 'ok';
end $$;
grant execute on function public.order_amendment_decide(uuid, boolean) to authenticated;

-- ---------- one call that returns everything the Order screen needs ----------
create or replace function public.order_bundle(p_order uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'order', to_jsonb(c),
    'milestones', coalesce((select jsonb_agg(to_jsonb(m) order by m.position) from public.order_milestones m where m.order_id = c.id), '[]'::jsonb),
    'amendments', coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at) from public.order_amendments a where a.order_id = c.id), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'actor', e.actor, 'event', e.event, 'data', e.data, 'at', e.created_at) order by e.id) from public.order_events e where e.order_id = c.id), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at) from public.order_payments p where p.order_id = c.id), '[]'::jsonb),
    'client_name', (select coalesce(pc.first_name, '') from public.profiles pc where pc.id = c.client),
    'freelancer_name', (select coalesce(e.display_name, pe.first_name, '') from public.profiles pe left join public.editor_profiles e on e.id = pe.id where pe.id = c.editor))
  from public.contracts c where c.id = p_order and (auth.uid() in (c.editor, c.client) or public.is_admin());
$$;
grant execute on function public.order_bundle(uuid) to authenticated;

-- ---------- what is held right now (used by the site, the functions and the admin panel) ----------
create or replace function public.order_held_cents(c public.contracts)
returns int language sql immutable as $$
  select greatest(coalesce(c.funded_cents, 0) - coalesce(c.released_cents, 0) - coalesce(c.refunded_cents, 0), 0);
$$;

-- admin overview gains the counters and the profession
drop function if exists public.admin_list_contracts();
create or replace function public.admin_list_contracts()
returns table (id uuid, title text, price numeric, currency text, pricing text, status text, payment_mode text, created_at timestamptz,
               delivered_at timestamptz, disputed_at timestamptz, dispute_by uuid, dispute_reason text, delivery_note text, delivery_url text,
               auto_release_at timestamptz, resolution text, conversation_id uuid,
               editor uuid, editor_name text, editor_email text, client uuid, client_name text, client_email text,
               profession_slug text, amount_cents int, funded_cents int, released_cents int, refunded_cents int, has_milestones boolean, amendments int)
language sql stable security definer set search_path = public as $$
  select c.id, c.title, c.price, c.currency, c.pricing, c.status, c.payment_mode, c.created_at,
         c.delivered_at, c.disputed_at, c.dispute_by, c.dispute_reason, c.delivery_note, c.delivery_url, c.auto_release_at, c.resolution, c.conversation_id,
         c.editor, coalesce(e.display_name, pe.first_name), pe.email, c.client, pc.first_name, pc.email,
         c.profession_slug, c.amount_cents, c.funded_cents, c.released_cents, c.refunded_cents, c.has_milestones, c.amendments
  from public.contracts c
  left join public.editor_profiles e on e.id = c.editor
  left join public.profiles pe on pe.id = c.editor
  left join public.profiles pc on pc.id = c.client
  where public.is_admin()
  order by (c.status = 'disputed') desc, c.created_at desc;
$$;
grant execute on function public.admin_list_contracts() to authenticated;

-- an accepted Order can be frozen (printed copy) — v11 rule stays: written once
-- (store_contract_doc unchanged)

-- ---------- existing rows: fill the counters so the sums add up ----------
update public.contracts set funded_cents = amount_cents where payment_mode = 'escrow' and status in ('funded','delivered','disputed','releasing','resolving') and funded_cents = 0 and amount_cents > 0;
update public.contracts set funded_cents = amount_cents, released_cents = amount_cents where status = 'completed' and funded_cents = 0 and amount_cents > 0;
update public.contracts set funded_cents = amount_cents, refunded_cents = amount_cents where status = 'refunded' and funded_cents = 0 and amount_cents > 0;
update public.contracts set accepted_version = terms_version where accepted_at is not null and accepted_version is null;
