/* ---------------------------------------------------------------------
   auth.js — вход в приложение. Перенесено из старой версии без изменений
   поведения: пароль, вход по Face ID / Touch ID (passkey), сброс пароля
   по ссылке из письма и запасной путь с кодом.

   Разметка формы входа лежит в index.html (#login-screen).
--------------------------------------------------------------------- */

const byId = id => document.getElementById(id);

function showLogin() {
  byId('login-screen').style.display = 'block';
  byId('root').style.display = 'none';
}

function hideLogin() {
  byId('login-screen').style.display = 'none';
  byId('root').style.display = '';
}

/* Бесплатный тариф Supabase не даёт править шаблоны писем: в письме приходит только ссылка.
   Поэтому основной путь — переход по ссылке и смена пароля здесь же, а поле кода остаётся
   запасным (сработает, если к проекту подключат свой SMTP и в шаблон добавят {{ .Token }}).
   Адрес возврата — APP_RETURN_URL из config.js, иначе текущая страница. */
function appUrl() {
  if (window.APP_RETURN_URL) return window.APP_RETURN_URL;
  let path = location.pathname || '/';
  if (!/\.html$/.test(path) && path.slice(-1) !== '/') path += '/';
  return location.origin + path;
}

function markRecoveryPending(on) {
  try {
    if (on) localStorage.setItem('fin-recovery', '1');
    else localStorage.removeItem('fin-recovery');
  } catch (e) { /* приватный режим: просто не запоминаем */ }
}

export function recoveryPending() {
  try { if (localStorage.getItem('fin-recovery') === '1') return true; } catch (e) { /* нет доступа */ }
  return /type=recovery/.test(location.hash || '');
}

function cleanAuthUrl() {
  try { history.replaceState(null, '', appUrl()); } catch (e) { /* не критично */ }
}

function message(text, ok) {
  const err = byId('login-error');
  err.textContent = text || '';
  err.style.color = ok ? 'var(--good)' : 'var(--danger)';
}

function step(which) {
  byId('login-step').style.display = which === 'login' ? 'flex' : 'none';
  byId('reset-step-1').style.display = which === 'reset1' ? 'flex' : 'none';
  byId('reset-step-2').style.display = which === 'reset2' ? 'flex' : 'none';
  byId('recovery-step').style.display = which === 'recovery' ? 'flex' : 'none';
  message('');
}

function passkeysSupported(client) {
  return Boolean(window.PublicKeyCredential && client.auth && client.auth.signInWithPasskey);
}

/* Есть сессия — сразу true. Нет — показывает форму и ждёт входа. */
export async function ensureSignedIn(client) {
  const res = await client.auth.getSession();
  if (res.data.session) { hideLogin(); return true; }

  showLogin();
  step('login');

  return new Promise(resolve => {
    const done = () => { hideLogin(); resolve(true); };

    if (passkeysSupported(client)) byId('passkey-btn').style.display = '';

    byId('login-btn').addEventListener('click', async () => {
      message('Проверяем…', true);
      const r = await client.auth.signInWithPassword({
        email: byId('login-email').value.trim(),
        password: byId('login-password').value,
      });
      if (r.error) { message('Не получилось войти: ' + r.error.message); return; }
      done();
    });
    byId('login-password').addEventListener('keydown', ev => {
      if (ev.key === 'Enter') byId('login-btn').click();
    });

    byId('passkey-btn').addEventListener('click', async () => {
      message('Ждём подтверждения…', true);
      try {
        const r = await client.auth.signInWithPasskey();
        if (r.error) { message('Вход по биометрии не удался: ' + r.error.message); return; }
        done();
      } catch (e) {
        message('Вход по биометрии не удался: ' + (e && e.message ? e.message : e));
      }
    });

    byId('forgot-btn').addEventListener('click', () => {
      byId('reset-email').value = byId('login-email').value;
      step('reset1');
    });
    byId('reset-back-btn').addEventListener('click', () => step('login'));
    byId('reset-back-btn-2').addEventListener('click', () => step('login'));

    byId('reset-send-btn').addEventListener('click', async () => {
      const email = byId('reset-email').value.trim();
      if (!email) { message('Укажите почту.'); return; }
      message('Отправляем…', true);
      markRecoveryPending(true);
      const r = await client.auth.resetPasswordForEmail(email, { redirectTo: appUrl() });
      if (r.error) {
        markRecoveryPending(false);
        message('Не получилось отправить письмо: ' + r.error.message);
        return;
      }
      step('reset2');
      byId('reset-return-url').textContent = 'Ссылка вернёт вас на адрес: ' + appUrl()
        + ' — он должен быть в списке Redirect URLs в настройках Supabase.';
      message('Письмо отправлено на ' + email + '. Ссылка действует ограниченное время.', true);
    });

    byId('reset-save-btn').addEventListener('click', async () => {
      const email = byId('reset-email').value.trim();
      const code = byId('reset-code').value.trim();
      const p1 = byId('reset-password').value;
      const p2 = byId('reset-password2').value;
      if (code.length < 4) { message('Кода нет — перейдите по ссылке из письма, и страница сама предложит задать пароль.'); return; }
      if (p1.length < 6) { message('Пароль должен быть не короче 6 символов.'); return; }
      if (p1 !== p2) { message('Пароли не совпадают.'); return; }
      message('Проверяем код…', true);
      const r = await client.auth.verifyOtp({ email, token: code, type: 'recovery' });
      if (r.error) { message('Код не подошёл: ' + r.error.message); return; }
      const r2 = await client.auth.updateUser({ password: p1 });
      if (r2.error) { message('Пароль не сохранился: ' + r2.error.message); return; }
      done();
    });
  });
}

/* Вернулись по ссылке восстановления — просим задать новый пароль до входа в план */
export function askNewPassword(client) {
  showLogin();
  step('recovery');
  return new Promise(resolve => {
    const finish = () => { markRecoveryPending(false); cleanAuthUrl(); hideLogin(); resolve(true); };
    byId('rec-skip-btn').addEventListener('click', finish);
    byId('rec-save-btn').addEventListener('click', async () => {
      const p1 = byId('rec-password').value;
      const p2 = byId('rec-password2').value;
      if (p1.length < 6) { message('Пароль должен быть не короче 6 символов.'); return; }
      if (p1 !== p2) { message('Пароли не совпадают.'); return; }
      message('Сохраняем…', true);
      const r = await client.auth.updateUser({ password: p1 });
      if (r.error) { message('Не получилось: ' + r.error.message); return; }
      finish();
    });
  });
}

export async function signOut(client) {
  await client.auth.signOut();
  location.reload();
}
