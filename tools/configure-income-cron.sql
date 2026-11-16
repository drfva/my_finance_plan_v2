-- Run after the income migration and deployment of the updated family-worker.
-- Reuses the Vault secrets finance_family_worker_url and finance_family_cron_secret.
begin;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net;
do $$ begin
  if not exists(select 1 from vault.decrypted_secrets where name='finance_family_worker_url' and decrypted_secret like 'https://%/functions/v1/family-worker')
    or not exists(select 1 from vault.decrypted_secrets where name='finance_family_cron_secret' and length(decrypted_secret)>=32) then
    raise exception 'Добавьте в Vault finance_family_worker_url и finance_family_cron_secret';
  end if;
end $$;
select cron.unschedule(jobid) from cron.job where jobname='finance-income-hourly';
select cron.schedule('finance-income-hourly','5 * * * *',$job$
  with plans as (
    select id,row_number() over(order by id) as seq from expense_tracking.due_income_plans() as due(id)
  ), batches as (
    select jsonb_agg(id order by id) as ids from plans group by (seq-1)/10
  ) select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='finance_family_worker_url'),
    headers := jsonb_build_object('Content-Type','application/json','x-family-cron-secret',
      (select decrypted_secret from vault.decrypted_secrets where name='finance_family_cron_secret')),
    body := jsonb_build_object('income_plan_ids',ids),timeout_milliseconds := 30000
  ) from batches;
$job$);
commit;
