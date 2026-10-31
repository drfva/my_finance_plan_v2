/* Экран запуска: технические ответы сервера и данные конфигурации сюда не попадают. */
export function fatalPage(stage = 'load') {
  const title = stage === 'auth' ? 'Не удалось проверить вход' : 'Не удалось загрузить план';
  return `<main class="fatal-page"><div class="card" role="alert">
    <h2>${title}</h2>
    <p class="muted">Проверьте подключение к интернету и попробуйте ещё раз.</p>
    <button class="small" id="retry">Повторить</button>
  </div></main>`;
}
