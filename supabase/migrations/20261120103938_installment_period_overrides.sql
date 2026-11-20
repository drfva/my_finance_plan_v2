create table if not exists public.installment_period_overrides (
  account_id uuid not null references public.accounts(id) on delete cascade,
  period_id text not null,
  installment_id text not null,
  amount numeric not null check (amount>=0 and amount<>'NaN'::numeric and amount<>'Infinity'::numeric),
  primary key (account_id,period_id,installment_id),
  foreign key (account_id,period_id) references public.periods(account_id,id) on delete cascade,
  foreign key (account_id,installment_id) references public.installments(account_id,id) on delete cascade
);
create index if not exists installment_period_overrides_installment_idx on public.installment_period_overrides(account_id,installment_id);
alter table public.installment_period_overrides enable row level security;
drop policy if exists member_read on public.installment_period_overrides;
create policy member_read on public.installment_period_overrides for select to authenticated using (public.is_account_member(account_id));
drop policy if exists member_write on public.installment_period_overrides;
create policy member_write on public.installment_period_overrides for all to authenticated
  using (public.can_edit_account(account_id)) with check (public.can_edit_account(account_id));
grant select,insert,update,delete on public.installment_period_overrides to authenticated;
insert into public.api_domain_tables(table_name,domain,load_order,mode,stamp_col)
  values('installment_period_overrides','debts',60,'replace',null) on conflict(table_name) do nothing;
notify pgrst,'reload schema';
