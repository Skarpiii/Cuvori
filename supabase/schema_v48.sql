-- Cuvori schema v48 — the agreed text of Orders accepted before v38 comes from the database too.
-- Run after schema_v47.sql, in the Supabase SQL editor.
--
-- Before v38 the text of an accepted Order (the clauses both people agreed to) was whatever the first browser sent
-- afterwards through store_contract_doc, so either person could have saved a made-up contract text, and the Order screen
-- and the printable copy show that text as the agreement. v38 made the database save the facts itself at acceptance
-- ("kind": "facts") and closed store_contract_doc, but left the copies saved before it as they were.
-- Now those copies are rebuilt from the database's own record of the Order (the same facts v38 saves, so the page builds
-- the clause wording from its templates), when the Order was not changed after it was agreed: then its record today is
-- what was agreed. The browser's text is kept next to it ("browser_copy") for the record, but is no longer what the page
-- shows. An Order changed after it was agreed (an accepted change) is left as it is and counted in the result, because its
-- values today are not what was agreed.

do $$
declare n int; m int;
begin
  with rebuilt as (
    update public.contracts c
       set terms_doc = public.order_terms_snapshot(c) || jsonb_build_object('rebuilt', 'v48', 'browser_copy', c.terms_doc)
     where c.terms_doc is not null and c.terms_doc->>'kind' is distinct from 'facts'
       and not exists (select 1 from public.order_amendments a where a.order_id = c.id and a.status = 'accepted')
    returning 1)
  select count(*) into n from rebuilt;
  select count(*) into m from public.contracts c where c.terms_doc is not null and c.terms_doc->>'kind' is distinct from 'facts';
  perform set_config('cuvori.v48_rebuilt', n::text, false);
  perform set_config('cuvori.v48_left', m::text, false);
end $$;

-- Shows whether this ran: one row that says "v48 applied", how many copies it rebuilt this time, and how many it left.
select 'v48 applied: agreed texts saved by a browser before v38, rebuilt from the database this time: ' || current_setting('cuvori.v48_rebuilt')
       || '. Left as they were (the Order was changed after it was agreed): ' || current_setting('cuvori.v48_left') || '.' as result;
