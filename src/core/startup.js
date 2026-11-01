/* При новом входе открывается личный план, даже если ссылка сохранила семейный. */
export async function openPersonalPlan(store, client, requestedId = null) {
  const { account, accounts = [] } = store.state;
  const personal = accounts.filter(a => a.plan_kind !== 'family');
  const selected = personal.find(a => a.id === requestedId)
    ?? personal.find(a => a.id === account.id && a.role === 'owner')
    ?? personal.find(a => a.role === 'owner')
    ?? personal.find(a => a.id === account.id)
    ?? personal[0]
    ?? (account.plan_kind !== 'family' ? account : null);

  if (selected) {
    await store.switchAccount(selected.id);
    return;
  }
  // После удаления всех личных планов у участника может остаться только семья.
  const { data, error } = await client.rpc('create_account', { p_title: 'Мой план' });
  if (error) throw error;
  if (typeof data !== 'string' || !data) throw new Error('Не удалось создать личный план');
  await store.switchAccount(data);
}
