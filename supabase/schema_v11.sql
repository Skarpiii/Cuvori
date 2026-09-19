-- ============================================================
-- Cuvori — schema v11: contract templates (types, governing law, clauses,
-- counter-proposals, versions). Run AFTER schema_v10.sql. Re-runnable.
-- ============================================================

alter table public.contracts add column if not exists contract_type text not null default 'fixed';
alter table public.contracts add column if not exists law_country  text not null default 'XX';
alter table public.contracts add column if not exists language     text not null default 'en';
alter table public.contracts add column if not exists terms        jsonb not null default '{}'::jsonb;
alter table public.contracts add column if not exists terms_version int not null default 1;
alter table public.contracts add column if not exists terms_changed_by uuid;
alter table public.contracts add column if not exists changes_used  int not null default 0;
-- the review window is also hard-coded in contract_action(); keep AUTO_RELEASE_DAYS in Netlify equal to it
alter table public.contracts add column if not exists auto_days     int not null default 7;
alter table public.contracts add column if not exists clauses_version text not null default 'v1-2026-09';
-- the clause text both sides actually accepted, frozen at acceptance so later edits to the
-- templates can never rewrite an existing contract
alter table public.contracts add column if not exists terms_doc     jsonb;

alter table public.contracts drop constraint if exists contracts_pricing_check;
alter table public.contracts add constraint contracts_pricing_check check (pricing in ('project','hour','day','month'));
alter table public.contracts drop constraint if exists contracts_type_check;
alter table public.contracts add constraint contracts_type_check check (contract_type in ('fixed','hourly','retainer','quick'));
alter table public.contracts drop constraint if exists contracts_lang_check;
alter table public.contracts add constraint contracts_lang_check check (language in ('en','de','ru','lt','es','pl','uk'));
alter table public.contracts drop constraint if exists contracts_law_check;
alter table public.contracts add constraint contracts_law_check check (law_country ~ '^[A-Z]{2}$');

-- the adjustable part of a contract: which clauses are on, their numbers, and free text
create or replace function public.terms_ok(t jsonb)
returns boolean language sql immutable as $$
  select t is not null and jsonb_typeof(t) = 'object' and pg_column_size(t) <= 20000
     and (not t ? 'custom'   or (jsonb_typeof(t->'custom') = 'string' and length(t->>'custom') <= 5000))
     and (not t ? 'included' or (jsonb_typeof(t->'included') = 'string' and length(t->>'included') <= 1000))
     and (not t ? 'on' or (jsonb_typeof(t->'on') = 'object'
          and not exists (select 1 from jsonb_each(t->'on') e where jsonb_typeof(e.value) <> 'boolean'
                                                                 or e.key !~ '^[a-z_]{1,30}$')))
     and (not t ? 'cancel_days' or (jsonb_typeof(t->'cancel_days') = 'number' and (t->>'cancel_days')::numeric between 3 and 365))
     and (not t ? 'late_pct'    or (jsonb_typeof(t->'late_pct')    = 'number' and (t->>'late_pct')::numeric    between 0 and 5))
     and (not t ? 'grace_days'  or (jsonb_typeof(t->'grace_days')  = 'number' and (t->>'grace_days')::numeric  between 3 and 60))
     and (not t ? 'deposit_pct' or (jsonb_typeof(t->'deposit_pct') = 'number' and (t->>'deposit_pct')::numeric between 0 and 50))
     and (not t ? 'pay_days'    or (jsonb_typeof(t->'pay_days')    = 'number' and (t->>'pay_days')::numeric    between 0 and 90))
     and (not t ? 'hours'       or (jsonb_typeof(t->'hours')       = 'number' and (t->>'hours')::numeric       between 0 and 10000))
     and (not t ? 'cap'         or (jsonb_typeof(t->'cap')         = 'number' and (t->>'cap')::numeric         between 0 and 10000))
     and (not t ? 'months'      or (jsonb_typeof(t->'months')      = 'number' and (t->>'months')::numeric      between 1 and 24))
     and not exists (select 1 from jsonb_object_keys(t) k where k not in ('on','custom','included','cancel_days','late_pct','pay_days','hours','cap','months','grace_days','deposit_pct'));
$$;

alter table public.contracts drop constraint if exists contracts_terms_ok;
alter table public.contracts add constraint contracts_terms_ok check (public.terms_ok(terms)) not valid;

-- shared validation for propose / adjust
create or replace function public.contract_input_ok(title text, description text, price numeric, pricing text, deadline date, revisions int,
                                                     mode text, ctype text, law text, lang text, terms jsonb)
returns void language plpgsql immutable as $$
begin
  if length(coalesce(title, '')) < 1 or length(title) > 200 then raise exception 'bad_title'; end if;
  if length(coalesce(description, '')) > 5000 then raise exception 'description_too_long'; end if;
  if price is null or price < 0 or price > 1000000 then raise exception 'bad_price'; end if;
  if pricing not in ('project','hour','day','month') then raise exception 'bad_pricing'; end if;
  if ctype not in ('fixed','hourly','retainer','quick') then raise exception 'bad_type'; end if;
  if (ctype in ('fixed','quick') and pricing <> 'project') or (ctype = 'hourly' and pricing not in ('hour','day')) or (ctype = 'retainer' and pricing <> 'month') then
    raise exception 'bad_pricing';
  end if;
  if revisions is not null and (revisions < 0 or revisions > 50) then raise exception 'bad_revisions'; end if;
  if deadline is not null and deadline < current_date then raise exception 'deadline_in_past'; end if;
  if mode = 'escrow' and pricing <> 'project' then raise exception 'escrow_fixed_price_only'; end if;
  if mode = 'escrow' and price < 1 then raise exception 'escrow_minimum'; end if;
  if law !~ '^[A-Z]{2}$' then raise exception 'bad_country'; end if;
  if lang not in ('en','de','ru','lt','es','pl','uk') then raise exception 'bad_language'; end if;
  if not public.terms_ok(terms) then raise exception 'bad_terms'; end if;
end $$;

drop function if exists public.propose_contract(uuid, text, text, numeric, text, date, int, text);
create or replace function public.propose_contract(conv uuid, title text, description text, price numeric, pricing text, deadline date, revisions int,
                                                   mode text default 'direct', ctype text default 'fixed', law text default 'XX',
                                                   lang text default 'en', terms jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare cv public.conversations%rowtype; ed uuid; cl uuid; c public.contracts%rowtype;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if public.is_banned(auth.uid()) then raise exception 'banned'; end if;
  select * into cv from public.conversations where id = conv and auth.uid() in (user_a, user_b) for update;
  if not found then raise exception 'not your conversation'; end if;
  if public.is_banned(cv.user_a) or public.is_banned(cv.user_b) then raise exception 'not_available'; end if;
  title := btrim(coalesce(title, ''));
  pricing := coalesce(pricing, 'project'); ctype := coalesce(ctype, 'fixed'); law := upper(coalesce(law, 'XX')); lang := coalesce(lang, 'en'); terms := coalesce(terms, '{}'::jsonb);
  mode := case when mode = 'escrow' then 'escrow' else 'direct' end;
  perform public.contract_input_ok(title, description, price, pricing, deadline, revisions, mode, ctype, law, lang, terms);
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
  insert into public.contracts (conversation_id, editor, client, proposed_by, title, description, price, pricing, deadline, revisions, payment_mode, amount_cents,
                                contract_type, law_country, language, terms, terms_version, terms_changed_by)
  values (conv, ed, cl, auth.uid(), title, coalesce(description, ''), price, pricing, deadline, coalesce(revisions, 2), mode, round(price * 100)::int,
          ctype, law, lang, terms, 1, auth.uid())
  returning * into c;
  perform public.contract_event(c, 'proposed');
  return c.id;
end $$;

-- either side changes the terms while the contract is still only proposed; the other side then has to accept
create or replace function public.adjust_contract(cid uuid, title text, description text, price numeric, pricing text, deadline date, revisions int,
                                                  ctype text, law text, lang text, terms jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare c public.contracts%rowtype; me uuid := auth.uid();
begin
  if me is null then return 'not_signed_in'; end if;
  select * into c from public.contracts where id = cid and me in (editor, client) for update;
  if not found then return 'not_found'; end if;
  if public.is_banned(me) or public.is_banned(c.editor) or public.is_banned(c.client) then return 'banned'; end if;
  if c.status <> 'proposed' then return 'not_allowed'; end if;
  if c.terms_version >= 50 then return 'too_many_changes'; end if;
  title := btrim(coalesce(title, ''));
  pricing := coalesce(pricing, c.pricing); ctype := coalesce(ctype, c.contract_type); law := upper(coalesce(law, c.law_country)); lang := coalesce(lang, c.language); terms := coalesce(terms, '{}'::jsonb);
  perform public.contract_input_ok(title, description, price, pricing, deadline, revisions, c.payment_mode, ctype, law, lang, terms);
  begin
    perform public.rate_limit('contract_action', 60, interval '1 hour');
  exception when others then return 'rate_limited';
  end;
  update public.contracts set title = adjust_contract.title, description = coalesce(adjust_contract.description, ''), price = adjust_contract.price,
         pricing = adjust_contract.pricing, deadline = adjust_contract.deadline, revisions = coalesce(adjust_contract.revisions, 2),
         amount_cents = round(adjust_contract.price * 100)::int, contract_type = ctype, law_country = law, language = lang,
         terms = adjust_contract.terms, terms_version = c.terms_version + 1, terms_changed_by = me, proposed_by = me
   where id = cid returning * into c;
  perform public.contract_event(c, 'terms_changed');
  return 'ok';
end $$;

-- ---------- the client cannot freeze held money with endless change requests ----------
-- Within the revision rounds that were paid for, "Request changes" sends the work back and stops
-- the automatic release. After those rounds the contract stays 'delivered', so the review clock keeps
-- running and the money is released unless a dispute is opened.
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
           auto_release_at = now() + (coalesce(c.auto_days, 7) || ' days')::interval where id = cid returning * into c;
  elsif action = 'request_changes' then
    if c.payment_mode <> 'escrow' or c.status <> 'delivered' or me <> c.client then return 'not_allowed'; end if;
    if c.changes_used < coalesce(c.revisions, 0) then
      update public.contracts set status = 'funded', changes_used = c.changes_used + 1, auto_release_at = null where id = cid returning * into c;
    else
      update public.contracts set changes_used = c.changes_used + 1 where id = cid returning * into c;   -- clock keeps running
    end if;
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

-- ---------- freeze the accepted clause text ----------
create or replace function public.store_contract_doc(cid uuid, doc jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare c public.contracts%rowtype; me uuid := auth.uid();
begin
  if me is null then return 'not_signed_in'; end if;
  select * into c from public.contracts where id = cid and me in (editor, client) for update;
  if not found then return 'not_found'; end if;
  if c.terms_doc is not null then return 'ok'; end if;                       -- written once, never rewritten
  if c.status in ('proposed','declined','cancelled') then return 'not_allowed'; end if;
  if doc is null or jsonb_typeof(doc) <> 'object' or pg_column_size(doc) > 200000 then return 'bad_terms'; end if;
  update public.contracts set terms_doc = doc where id = cid;
  return 'ok';
end $$;
