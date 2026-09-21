/* ---------------------------------------------------------------------
   security.js — аккаунт: пароль, почта и вход по Face ID / Touch ID.

   Всё это живёт в Supabase Auth, а не в плане, поэтому состояние держится
   здесь, а не в store: список ключей подгружается по требованию, результат
   действия возвращается сообщением для раздела «Безопасность».
--------------------------------------------------------------------- */

export function createSecurity(client, onChange = () => {}) {
  const state = { user: null, passkeys: null, loading: false, msg: null };

  const say = (text, ok = false) => { state.msg = { text, ok }; onChange(); };
  const api = () => client?.auth?.passkey ?? null;

  const supported = () => Boolean(
    typeof window !== 'undefined' && window.PublicKeyCredential
    && api() && typeof api().list === 'function',
  );

  async function loadUser() {
    if (state.user || !client?.auth?.getUser) return;
    const r = await client.auth.getUser();
    state.user = r?.data?.user ?? null;
    onChange();
  }

  async function loadPasskeys() {
    if (!supported() || state.loading || state.passkeys !== null) return;
    state.loading = true;
    try {
      const r = await api().list();
      state.passkeys = r?.data ?? [];
    } catch (e) {
      state.passkeys = [];
    }
    state.loading = false;
    onChange();
  }

  return {
    state,
    supported,
    load() { loadUser(); loadPasskeys(); },
    clearMessage() { state.msg = null; },

    async changePassword(p1, p2) {
      if ((p1 ?? '').length < 6) return say('Пароль должен быть не короче 6 символов.');
      if (p1 !== p2) return say('Пароли не совпадают.');
      say('Сохраняем…', true);
      const r = await client.auth.updateUser({ password: p1 });
      say(r?.error ? 'Пароль не сохранился: ' + r.error.message : 'Пароль изменён.', !r?.error);
    },

    async changeEmail(email) {
      if (!email || !email.includes('@')) return say('Укажите новый адрес почты.');
      say('Отправляем письмо…', true);
      const r = await client.auth.updateUser({ email });
      say(r?.error ? 'Не получилось: ' + r.error.message
        : `На ${email} отправлено письмо. Пока не перейдёте по ссылке, вход остаётся по старому адресу.`, !r?.error);
    },

    async addPasskey(name) {
      if (!supported() || typeof api().enroll !== 'function') {
        return say('Эта версия библиотеки Supabase не умеет добавлять ключи.');
      }
      say('Ждём подтверждения на устройстве…', true);
      try {
        const r = await api().enroll({ friendlyName: name || 'Это устройство' });
        if (r?.error) return say('Не получилось добавить ключ: ' + r.error.message);
        state.passkeys = null;
        say('Ключ добавлен — теперь можно входить по Face ID или Touch ID.', true);
        loadPasskeys();
      } catch (e) {
        say('Не получилось добавить ключ: ' + (e?.message ?? e));
      }
    },

    async deletePasskey(id) {
      if (!supported() || typeof api().delete !== 'function') return say('Удаление ключей недоступно.');
      const r = await api().delete({ passkeyId: id });
      state.passkeys = null;
      say(r?.error ? 'Не получилось удалить: ' + r.error.message : 'Ключ удалён.', !r?.error);
      loadPasskeys();
    },
  };
}
