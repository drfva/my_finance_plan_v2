create table if not exists public.client_logs (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id    uuid,
  level      text not null check (level in ('error','warn','info')),
  message    text not null,
  context    jsonb not null default '{}'::jsonb,
  ua         text
);

create index if not exists client_logs_created_idx on public.client_logs (created_at);
create index if not exists client_logs_user_idx    on public.client_logs (user_id, created_at);

alter table public.client_logs enable row level security;
revoke all on public.client_logs from anon, authenticated;   -- напрямую таблица недоступна

create or replace function public.log_client_event(
  p_level text, p_message text, p_context jsonb default '{}', p_ua text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_level not in ('error','warn','info') then return; end if;
  if pg_column_size(coalesce(p_context,'{}'::jsonb)) > 4000 then return; end if;

  -- общий потолок: при спаме база не раздуется
  if (select count(*) from client_logs
       where created_at > now() - interval '1 minute') >= 200 then
    return;
  end if;
  -- лимит на пользователя (для невошедших он общий)
  if (select count(*) from client_logs
       where created_at > now() - interval '1 minute'
         and user_id is not distinct from auth.uid()) >= 30 then
    return;
  end if;

  insert into client_logs (user_id, level, message, context, ua)
  values (auth.uid(), p_level, left(coalesce(p_message,''), 500),
          coalesce(p_context,'{}'::jsonb), left(p_ua, 200));
end;
$$;

revoke execute on function public.log_client_event(text,text,jsonb,text) from public;
grant  execute on function public.log_client_event(text,text,jsonb,text) to anon, authenticated;

notify pgrst, 'reload schema';