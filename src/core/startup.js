/* При новом входе открывается собственный личный план.
   Параметр plan в адресе мог остаться от предыдущего пользователя или сеанса. */
export async function openPersonalPlan(store, client) {
  const { account, accounts = [] } = store.state;
  const personal = accounts.filter(a => a.plan_kind !== 'family');
  const selected = personal.find(a => a.id === account?.id && a.role === 'owner')
    ?? personal.find(a => a.role === 'owner')
    ?? (account?.plan_kind !== 'family' && account?.role === 'owner' ? account : null);

  if (selected) {
    await store.switchAccount(selected.id);
    return;
  }
  // Общий доступ к чужому плану не заменяет пользователю собственный.
  const { data, error } = await client.rpc('create_account', { p_title: 'Мой план' });
  if (error) throw error;
  if (typeof data !== 'string' || !data) throw new Error('Не удалось создать личный план');
  await store.switchAccount(data);
}
