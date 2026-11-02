begin;
alter table public.plan_years add column if not exists salary_model text not null default 'worked_days' check(salary_model in ('worked_days','percentage'));
alter table public.payout_slots add column if not exists salary_percent numeric not null default 0 check(salary_percent>=0 and salary_percent<=100);
create or replace function api_private.check_salary_percent_total()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if (select coalesce(sum(salary_percent),0) from public.payout_slots where account_id=new.account_id and year=new.year)>100 then
    raise sqlstate 'PT400' using message='Сумма процентов всех выплат года не может превышать 100%';
  end if;
  return null;
end $$;
revoke all on function api_private.check_salary_percent_total() from public,anon,authenticated;
drop trigger if exists salary_percent_total on public.payout_slots;
create constraint trigger salary_percent_total after insert or update on public.payout_slots deferrable initially deferred for each row execute function api_private.check_salary_percent_total();
notify pgrst,'reload schema';
commit;
