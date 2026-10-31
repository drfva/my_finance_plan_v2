/* ---------------------------------------------------------------------
   main.js — запуск приложения.

   1. Вход (core/auth.js). Вернулись по ссылке из письма — смена пароля.
   2. Загрузка плана: bootstrap_user создаёт план при первом входе.
   3. Оболочка с вкладками (ui/app.js).
--------------------------------------------------------------------- */

import { createStore } from './core/store.js';
import { ensureSignedIn, askNewPassword, recoveryPending, signOut } from './core/auth.js';
import { createApp } from './ui/app.js';
import { byId } from './ui/dom.js';
import { fatalPage } from './ui/fatal.js';
import { initLogger, log } from './core/logger.js';

import { applyTheme, readTheme } from './core/theme.js';

applyTheme(readTheme());
const APP = window.APP_CONFIG || { env: 'prod', url: '', key: '' };

/* passkeys (Face ID / Touch ID) — экспериментальный API Supabase, включается явно */
const client = window.supabase.createClient(APP.url, APP.key, {
  auth: { experimental: { passkey: true } },
});
initLogger(client);

function showFatal(stage) {
  byId('login-screen').style.display = 'none';
  byId('root').style.display = '';
  byId('root').innerHTML = fatalPage(stage);
  log.error('boot_failed', { stage });
  byId('retry').addEventListener('click', () => location.reload());
}

async function boot() {
  try {
    await ensureSignedIn(client);
    if (recoveryPending()) await askNewPassword(client);
  }catch(e){showFatal('auth');return;}

  const store = createStore({ client });
  try {
    await store.load();
    const selected = new URLSearchParams(location.search).get('plan');
    if (selected && store.state.accounts?.some(a => a.id === selected)) await store.switchAccount(selected);
  } catch (e) {
    showFatal('load');
    return;
  }

  createApp({ store, env: APP.env, client, onSignOut: () => signOut(client) }).start();
}

boot();
