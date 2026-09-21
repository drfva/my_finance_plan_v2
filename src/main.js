/* ---------------------------------------------------------------------
   main.js — запуск приложения.

   1. Вход (core/auth.js). Вернулись по ссылке из письма — смена пароля.
   2. Загрузка плана: bootstrap_user создаёт план при первом входе.
   3. Оболочка с вкладками (ui/app.js).
--------------------------------------------------------------------- */

import { createStore } from './core/store.js';
import { ensureSignedIn, askNewPassword, recoveryPending, signOut } from './core/auth.js';
import { createApp } from './ui/app.js';
import { esc, byId } from './ui/dom.js';

const APP = window.APP_CONFIG || { env: 'prod', url: '', key: '' };

/* passkeys (Face ID / Touch ID) — экспериментальный API Supabase, включается явно */
const client = window.supabase.createClient(APP.url, APP.key, {
  auth: { experimental: { passkey: true } },
});

function showFatal(title, err) {
  byId('root').innerHTML = `
    <main><div class="card">
      <h2>${esc(title)}</h2>
      <p class="muted">${esc(err?.message ?? err)}</p>
      <div class="small-note">Проверьте, что в проекте Supabase выполнены 001_schema.sql и 002_api.sql,
        и что config.js указывает на нужную базу (${esc(APP.url)}).</div>
      <button class="small" id="retry" style="margin-top:12px;">Обновить</button>
    </div></main>`;
  byId('retry').addEventListener('click', () => location.reload());
}

async function boot() {
  await ensureSignedIn(client);
  if (recoveryPending()) await askNewPassword(client);

  const store = createStore({ client });
  try {
    await store.load();
  } catch (e) {
    console.error(e);
    showFatal('Не удалось загрузить план', e);
    return;
  }

  createApp({ store, env: APP.env, client, onSignOut: () => signOut(client) }).start();
}

boot();
