-- Выполнить ПОСЛЕ миграции и развёртывания family-worker.
-- В Vault заранее сохранить:
--   finance_family_worker_url = https://PROJECT.supabase.co/functions/v1/family-worker
--   finance_family_cron_secret = тот же секрет (не менее 32 символов), что FAMILY_CRON_SECRET у функции.
-- Здесь нет секретных значений. Скрипт не меняет другие задания Cron.
begin;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net;

do $$ begin
  if not exists(select 1 from vault.decrypted_secrets where name='finance_family_worker_url' and decrypted_secret like 'https://%/functions/v1/family-worker')
    or not exists(select 1 from vault.decrypted_secrets where name='finance_family_cron_secret' and length(decrypted_secret)>=32) then
    raise exception 'Добавьте в Vault finance_family_worker_url и finance_family_cron_secret';
  end if;
end $$;
select cron.unschedule(jobid) from cron.job where jobname='finance-family-hourly';
select cron.schedule('finance-family-hourly','0 * * * *',$job$
  -- Отдельный запрос на каждые 10 источников: ни один участник не теряется
  -- из-за ограничения размера одной серверной задачи.
  with sources as (
    select m.id,row_number() over(order by m.id) as seq from public.family_members m
    join public.families f on f.id=m.family_id
    where m.active and m.user_id is not null and m.source_account_id is not null and f.deleted_at is null
      and exists(select 1 from public.family_contribution_rules r where r.member_id=m.id)
  ), batches as (
    select jsonb_agg(id order by id) as ids from sources group by (seq-1)/10
  ) select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='finance_family_worker_url'),
    headers := jsonb_build_object('Content-Type','application/json','x-family-cron-secret',
      (select decrypted_secret from vault.decrypted_secrets where name='finance_family_cron_secret')),
    body := jsonb_build_object('member_ids',ids),timeout_milliseconds := 10000
  ) from batches;

  -- Приглашения работают и в семьях, где источники ещё не настроены.
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='finance_family_worker_url'),
    headers := jsonb_build_object('Content-Type','application/json','x-family-cron-secret',
      (select decrypted_secret from vault.decrypted_secrets where name='finance_family_cron_secret')),
    body := jsonb_build_object('member_ids','[]'::jsonb),timeout_milliseconds := 10000
  ) where exists(select 1 from family_api.mail_outbox o join public.family_invitations i on i.id=o.invitation_id
    where i.status='pending' and i.expires_at>now() and
      (o.state in ('queued','error') and o.retry_at<=now() or o.state='sending' and o.lease_until<now()));
$job$);
commit;
