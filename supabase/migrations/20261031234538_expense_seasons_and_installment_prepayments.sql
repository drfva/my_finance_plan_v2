begin;

alter table public.expense_categories add column if not exists amount_seasons jsonb not null default '[]';
alter table public.expense_items add column if not exists amount_seasons jsonb not null default '[]';
alter table public.periods add column if not exists installment_snapshot jsonb;

create or replace function api_private.valid_amount_seasons(seasons jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare s jsonb; first_day integer; last_day integer; d integer;
  used boolean[] := array_fill(false,array[366]); first_date date; last_date date;
begin
  if jsonb_typeof(seasons) is distinct from 'array' or jsonb_array_length(seasons) > 366 then return false; end if;
  for s in select value from jsonb_array_elements(seasons) loop
    if jsonb_typeof(s) is distinct from 'object' or jsonb_typeof(s->'amount') is distinct from 'number'
      or (s->>'amount')::numeric < 0 or coalesce(s->>'from','') !~ '^\d{2}-\d{2}$' or coalesce(s->>'to','') !~ '^\d{2}-\d{2}$' then return false; end if;
    first_date := make_date(2000,split_part(s->>'from','-',1)::int,split_part(s->>'from','-',2)::int);
    last_date := make_date(2000,split_part(s->>'to','-',1)::int,split_part(s->>'to','-',2)::int);
    first_day := first_date - date '2000-01-01' + 1; last_day := last_date - date '2000-01-01' + 1;
    d := first_day;
    loop
      if used[d] then return false; end if;
      used[d] := true;
      exit when d = last_day;
      d := d % 366 + 1;
    end loop;
  end loop;
  return true;
exception when others then return false;
end $$;

create or replace function api_private.valid_installment_snapshot(snapshot jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare s jsonb; seen text[] := '{}';
begin
  if snapshot is null then return true; end if;
  if jsonb_typeof(snapshot) is distinct from 'array' then return false; end if;
  for s in select value from jsonb_array_elements(snapshot) loop
    if jsonb_typeof(s) is distinct from 'object' or jsonb_typeof(s->'payment_id') is distinct from 'string'
      or jsonb_typeof(s->'installment_id') is distinct from 'string' or jsonb_typeof(s->'date') is distinct from 'string'
      or jsonb_typeof(s->'early') is distinct from 'boolean' or jsonb_typeof(s->'amount') is distinct from 'number'
      or (s->>'amount')::numeric < 0 or s->>'payment_id' = any(seen) then return false; end if;
    if s->>'date' !~ '^\d{4}-\d{2}-\d{2}$' then return false; end if;
    perform (s->>'date')::date;
    seen := array_append(seen,s->>'payment_id');
  end loop;
  return true;
exception when others then return false;
end $$;

revoke all on function api_private.valid_amount_seasons(jsonb), api_private.valid_installment_snapshot(jsonb) from public;
grant execute on function api_private.valid_amount_seasons(jsonb), api_private.valid_installment_snapshot(jsonb) to authenticated,service_role;

do $$ begin
  if not exists(select 1 from pg_constraint where conname='expense_categories_amount_seasons_check' and conrelid='public.expense_categories'::regclass) then
    alter table public.expense_categories add constraint expense_categories_amount_seasons_check check(api_private.valid_amount_seasons(amount_seasons));
  end if;
  if not exists(select 1 from pg_constraint where conname='expense_items_amount_seasons_check' and conrelid='public.expense_items'::regclass) then
    alter table public.expense_items add constraint expense_items_amount_seasons_check check(api_private.valid_amount_seasons(amount_seasons));
  end if;
  if not exists(select 1 from pg_constraint where conname='periods_installment_snapshot_check' and conrelid='public.periods'::regclass) then
    alter table public.periods add constraint periods_installment_snapshot_check check(api_private.valid_installment_snapshot(installment_snapshot));
  end if;
end $$;

-- Закрепляем старые платежи рассрочек до включения досрочного погашения.
-- Как в движке: последняя выплата не позже даты части, при совпадении дат — по id.
-- ALTER TABLE удерживает блокировку до COMMIT: другие записи ждут. Защита
-- семейных выплат отключается только внутри этой транзакции для backfill;
-- при любой ошибке её состояние откатится вместе с данными.
alter table public.periods disable trigger protect_family_period;
update public.periods p set installment_snapshot = coalesce((
  select jsonb_agg(jsonb_build_object('payment_id',ip.id,'installment_id',ip.installment_id,
    'date',ip.pay_date,'amount',ip.amount,'early',false) order by ip.pay_date,ip.id)
  from public.installment_payments ip
  where ip.account_id=p.account_id and ip.pay_date is not null and ip.amount>0
    and (select q.id from public.periods q where q.account_id=p.account_id and q.pay_date<=ip.pay_date order by q.pay_date desc,q.id desc limit 1)=p.id
    and not exists(select 1 from public.allocation_rules ar where ar.account_id=p.account_id and ar.stage_code='installments' and not ar.enabled)
), '[]'::jsonb) where p.locked and p.installment_snapshot is null;
alter table public.periods enable trigger protect_family_period;

comment on column public.expense_items.amount_seasons is 'Ежегодные непересекающиеся интервалы from/to (ММ-ДД), amount. Вне интервалов действует amount статьи; season_from/to по-прежнему ограничивают её применимость.';
comment on column public.expense_categories.amount_seasons is 'Сезонные суммы категории без статей. При наличии статей сумма складывается из них.';
comment on column public.periods.installment_snapshot is 'Проведённые части рассрочек: payment_id, installment_id, date, amount, early. NULL — снимка нет, [] — платежей не было.';
notify pgrst, 'reload schema';
commit;
