/* ---------------------------------------------------------------------
   security.js — аккаунт: пароль, почта и вход по Face ID / Touch ID.

   Всё это живёт в Supabase Auth, а не в плане, поэтому состояние держится
   здесь, а не в store: список ключей подгружается по требованию, результат
   действия возвращается сообщением для раздела «Безопасность».
--------------------------------------------------------------------- */

export function createSecurity(client, onChange = () => {}) {
  const state = { user: null, passkeys: null, loading: false, msg: null };

  const say = (text, ok = false) => { state.msg = { text, ok }; onChange(); };
  const auth = () => client?.auth ?? null;
  const api = () => auth()?.passkey ?? null;

  /* В разных версиях supabase-js ключи заводятся по-разному: auth.registerPasskey()
     или auth.passkey.enroll(). Берём то, что есть, иначе говорим об этом прямо. */
  const enrollFn = () => {
    const a = auth();
    if (!a) return null;
    if (typeof a.registerPasskey === 'function') return name => a.registerPasskey({ friendlyName: name });
    if (typeof api()?.enroll === 'function') return name => api().enroll({ friendlyName: name });
    if (typeof api()?.register === 'function') return name => api().register({ friendlyName: name });
    return null;
  };
  const deleteFn = () => {
    const a = auth();
    if (typeof api()?.delete === 'function') return id => api().delete({ passkeyId: id });
    if (typeof a?.unenrollPasskey === 'function') return id => a.unenrollPasskey({ passkeyId: id });
    return null;
  };
  const listFn = () => (typeof api()?.list === 'function' ? () => api().list() : null);

  const supported = () => Boolean(
    typeof window !== 'undefined' && window.PublicKeyCredential && auth()
    && (enrollFn() || listFn() || typeof auth().signInWithPasskey === 'function'),
  );

  async function loadUser() {
    if (state.user || !client?.auth?.getUser) return;
    const r = await client.auth.getUser();
    state.user = r?.data?.user ?? null;
    onChange();
  }

  async function loadPasskeys() {
    const list = listFn();
    if (!supported() || !list || state.loading || state.passkeys !== null) return;
    state.loading = true;
    try {
      const r = await list();
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

    canAdd: () => Boolean(enrollFn()),
    hasList: () => Boolean(listFn()),

    async addPasskey(name) {
      const enroll = enrollFn();
      if (!enroll) {
        return say('Эта версия библиотеки Supabase не умеет добавлять ключи: обновите supabase-js '
          + 'или включите passkey в настройках проекта Supabase.');
      }
      say('Подтвердите на устройстве…', true);
      try {
        const r = await enroll(name || 'Это устройство');
        if (r?.error) return say('Не получилось добавить ключ: ' + r.error.message);
        state.passkeys = null;
        say('Готово: теперь можно входить по Face ID или Touch ID.', true);
        loadPasskeys();
      } catch (e) {
        // отмена на устройстве прилетает как исключение — это не ошибка приложения
        const msg = e?.name === 'NotAllowedError' ? 'Подтверждение отменено.' : (e?.message ?? String(e));
        say('Не получилось добавить ключ: ' + msg);
      }
    },

    async deletePasskey(id) {
      const del = deleteFn();
      if (!del) return say('Эта версия библиотеки Supabase не умеет удалять ключи.');
      try {
        const r = await del(id);
        state.passkeys = null;
        say(r?.error ? 'Не получилось удалить: ' + r.error.message : 'Ключ удалён.', !r?.error);
        loadPasskeys();
      } catch (e) {
        say('Не получилось удалить: ' + (e?.message ?? e));
      }
    },
  };
}
