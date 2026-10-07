/* logger.js — клиентские логи в таблицу client_logs.
   Пишем только технические поля: код ошибки, тип операции, домен.
   Никаких сумм, названий, почты и кусков state. */

const QUEUE_KEY = 'fin-log-queue';
let client = null;

const readQueue = () => { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; } };
const writeQueue = q => { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-50))); } catch { /* не критично */ } };
const enqueue = rec => writeQueue([...readQueue(), rec]);

async function send(rec) {
  if (!client) { enqueue(rec); return; }
  try {
    const { error } = await client.rpc('log_client_event', rec);
    if (error) enqueue(rec);
  } catch { enqueue(rec); }
}

function record(level, message, context = {}) {
  send({
    p_level: level,
    p_message: String(message ?? '').slice(0, 500),
    p_context: { page: location.pathname, online: navigator.onLine, ...context },
    p_ua: navigator.userAgent.slice(0, 200),
  });
}

export const log = {
  error: (m, c) => record('error', m, c),
  warn:  (m, c) => record('warn', m, c),
  info:  (m, c) => record('info', m, c),
};

export function initLogger(c) {
  client = c;
  const pending = readQueue();
  if (pending.length) { writeQueue([]); pending.forEach(send); }

  window.addEventListener('error', ev =>
    log.error(ev.message, { file: (ev.filename || '').split('/').pop(), line: ev.lineno }));
  window.addEventListener('unhandledrejection', ev =>
    log.error('unhandledrejection: ' + (ev.reason?.message ?? ev.reason)));
}