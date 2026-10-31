/* ---------------------------------------------------------------------
   security.js — аккаунт: пароль, почта и вход по Face ID / Touch ID.

   Всё это живёт в Supabase Auth, а не в плане, поэтому состояние держится
   здесь, а не в store: список ключей подгружается по требованию, результат
   действия возвращается сообщением для раздела «Безопасность».
--------------------------------------------------------------------- */

export function createSecurity(client, onChange = () => {}) {
  const state = { user: null, passkeys: null, loading: false, msg: null, deletion: null, deleting: false };

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

  async function prepareDeletion() {
    if(state.deleting)return;
    state.deletion={loading:true,preview:null,error:null,confirmation:''};onChange();
    try {
      const r=await client.rpc('account_deletion_preview');
      if(r.error)throw r.error;
      if(!Array.isArray(r.data?.plans)||!r.data.version)throw new Error('Не удалось проверить условия удаления');
      if(state.deletion)state.deletion={loading:false,preview:r.data,error:null,confirmation:''};
    } catch(e) {
      if(state.deletion)Object.assign(state.deletion,{loading:false,error:e.code==='PGRST202'
        ?'Удаление аккаунта пока недоступно. Попробуйте позже.':e.message||'Не удалось проверить условия удаления'});
    }
    onChange();
  }

  return {
    state,
    supported,
    load() { loadUser(); loadPasskeys(); },
    clearMessage() { state.msg = null; },
    prepareDeletion,
    closeDeletion() {if(!state.deleting){state.deletion=null;onChange();}},
    async assignOwner(account,user) {
      if(state.deleting||!state.deletion)return;
      state.deleting=true;state.deletion.error=null;onChange();
      try {
        const r=await client.rpc('account_assign_owner',{p_account:account,p_user:user});
        if(r.error)throw r.error;
        state.deleting=false;await prepareDeletion();
      }catch(e){state.deletion.error=e.message||'Не удалось назначить владельца';}
      finally{state.deleting=false;onChange();}
    },
    async deleteAccount(confirmation) {
      const deletion=state.deletion;
      if(state.deleting||!deletion?.preview)return false;
      if(String(confirmation).trim().toUpperCase()!=='УДАЛИТЬ') {
        deletion.error='Для подтверждения введите УДАЛИТЬ';onChange();return false;
      }
      if(deletion.preview.plans.some(p=>p.blocked))return false;
      state.deleting=true;deletion.error=null;onChange();
      try {
        const r=await client.rpc('delete_my_account',{p_confirmation:confirmation,p_version:deletion.preview.version});
        if(r.error){
          if(r.error.code==='PT409'){
            state.deleting=false;await prepareDeletion();
            if(state.deletion)state.deletion.error=r.error.message;
            return false;
          }
          throw r.error;
        }
        if(!r.data?.deleted)throw new Error('Сервер не подтвердил удаление');
        state.user=null;
        try {globalThis.localStorage?.removeItem('fin-recovery');}catch{/* Закрытое хранилище. */}
        // Запрашиваем локальный выход; следующая загрузка также проверяет Auth.
        try {await client.auth.signOut({scope:'local'});}catch{/* Следующая загрузка проверит пользователя через Auth. */}
        return true;
      }catch(e){deletion.error=e.message||'Не удалось подтвердить результат удаления. Проверьте подключение';return false;}
      finally{state.deleting=false;onChange();}
    },

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
