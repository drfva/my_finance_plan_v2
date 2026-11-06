-- Старые движения остаются обычными тратами. Покупка для цели выбирается явно.
begin;
set local lock_timeout='5s';
alter table public.goal_transactions add column if not exists purpose text not null default 'other';
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.goal_transactions'::regclass and conname='goal_transaction_purpose_check') then
  alter table public.goal_transactions add constraint goal_transaction_purpose_check
    check (purpose in ('other','goal') and (purpose <> 'goal' or kind = 'spend'));
 end if;
end $$;
create index if not exists goal_transactions_purpose_stage_idx
  on public.goal_transactions(account_id,goal_id,milestone_id) where purpose='goal';

-- Проверка отложена до конца транзакции: state_save меняет этапы и движения
-- одним патчем, поэтому временное отсутствие родителя при сохранении допустимо.
create or replace function api_private.check_goal_purchase_stage()
returns trigger language plpgsql security invoker set search_path=public as $$
declare accs uuid[]; gids text[]; tid text;
begin
  if tg_op='DELETE' then accs:=array[old.account_id]; gids:=array[old.goal_id];
  else accs:=array[new.account_id]; gids:=array[new.goal_id];
    if tg_op='UPDATE' then gids:=array_append(gids,old.goal_id); accs:=array_append(accs,old.account_id); end if;
    if tg_table_name='goal_transactions' then tid:=new.id; end if;
  end if;
  if exists (
    select 1 from public.goal_transactions t
    where t.account_id=any(accs) and t.goal_id=any(gids) and t.purpose='goal'
      and (tid is null or t.id=tid)
      and ((t.milestone_id is not null and not exists (
        select 1 from public.goal_milestones m where m.account_id=t.account_id and m.goal_id=t.goal_id and m.id=t.milestone_id))
        or (t.milestone_id is null and exists (
          select 1 from public.goal_milestones m where m.account_id=t.account_id and m.goal_id=t.goal_id)))
  ) then raise exception using errcode='23514', message='Для покупки выберите этап этой же копилки'; end if;
  return null;
end;
$$;
revoke all on function api_private.check_goal_purchase_stage() from public,anon;
grant execute on function api_private.check_goal_purchase_stage() to authenticated;
drop trigger if exists goal_purchase_stage_tx on public.goal_transactions;
create constraint trigger goal_purchase_stage_tx after insert or update on public.goal_transactions
  deferrable initially deferred for each row execute function api_private.check_goal_purchase_stage();
drop trigger if exists goal_purchase_stage_ms on public.goal_milestones;
create constraint trigger goal_purchase_stage_ms after insert or update or delete on public.goal_milestones
  deferrable initially deferred for each row execute function api_private.check_goal_purchase_stage();
notify pgrst, 'reload schema';
commit;
