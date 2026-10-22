-- Финансы v2: прогресс вручную закрытой цели на дату её закрытия.
-- Для уже установленной v2 выполните этот файл в Supabase SQL Editor.
-- state_get / state_save работают с колонками динамически: менять API не нужно.

alter table public.goals
  add column if not exists completion_snapshot jsonb;

comment on column public.goals.completion_snapshot is
  'Снимок ручного закрытия: дата, прогресс, состояние текущего этапа и даты накопленных этапов. Движения после закрытия меняют баланс, но не прогресс. При возврате в работу снимок очищается.';

notify pgrst, 'reload schema';
