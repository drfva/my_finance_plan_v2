-- Архив и видимость целей в Обзоре независимы от закрытия цели.
-- Выполнить после 006_goal_completion.sql перед обновлением приложения.
alter table public.goals
  add column if not exists archived boolean not null default false,
  add column if not exists hidden_overview boolean not null default false;

alter table public.goals alter column priority drop not null;
update public.goals set priority = null where completed;

comment on column public.goals.archived is 'Убрана в архив Копилок/Подушек; возврат из архива не открывает цель.';
comment on column public.goals.hidden_overview is 'Скрыта пользователем с Обзора; архив сам по себе не скрывает цель.';
comment on column public.goals.priority is 'Очередь активных целей своего типа; у закрытой цели NULL.';

notify pgrst, 'reload schema';
