-- After schema_v9: which existing rows break the new limits? (they keep working, but can't be saved again until fixed)
create temp table if not exists v9_report (tbl text, rule text, bad_rows bigint);
truncate v9_report;
do $$ declare r record; n bigint; begin
  for r in select c.conrelid::regclass::text tbl, c.conname, pg_get_constraintdef(c.oid) def
           from pg_constraint c where c.contype = 'c' and not c.convalidated and c.connamespace = 'public'::regnamespace loop
    execute format('select count(*) from %s where not (%s)', r.tbl, regexp_replace(r.def, '^CHECK \((.*)\)( NOT VALID)?$', '\1')) into n;
    insert into v9_report values (r.tbl, r.conname, n);
  end loop;
end $$;
select * from v9_report order by bad_rows desc, tbl;
