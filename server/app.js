// Веб-сервер карты заказчика на встроенном node:http (без express).
// На этой же машине, что и коллектор: читает monitor.db напрямую (источник
// правды), наружу отдаёт только отфильтрованный статус под логином.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';
import { openWebDb } from './db.js';
import { login } from './auth.js';
import { buildStatus, buildPointDetail } from './status.js';

const webDb = openWebDb();
// Раз в час подчищаем протухшие сессии.
setInterval(() => {
  try { webDb.purgeExpiredSessions(); } catch (e) { log.warn(`purge сессий: ${e.message}`); }
}, 3600 * 1000).unref();

const COOKIE = 'rinok_sid';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(sid, maxAgeSec) {
  const attrs = [
    `${COOKIE}=${sid}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (config.web.secureCookie) attrs.push('Secure');
  return attrs.join('; ');
}

function clearCookie() {
  const attrs = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (config.web.secureCookie) attrs.push('Secure');
  return attrs.join('; ');
}

function currentUser(req) {
  const sid = parseCookies(req)[COOKIE];
  if (!sid) return null;
  const s = webDb.getSession(sid);
  return s ? { sid, username: s.username, role: s.role } : null;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

async function readBody(req, limit = 1 << 16) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('тело запроса слишком большое');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function serveStatic(res, urlPath) {
  // Защита от выхода за пределы public/.
  const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const filePath = join(config.publicDir, rel);
  if (!filePath.startsWith(config.publicDir)) return send(res, 403, 'Forbidden');
  try {
    const st = await stat(filePath);
    if (st.isDirectory()) return send(res, 403, 'Forbidden');
    const data = await readFile(filePath);
    const mime = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    send(res, 404, 'Not Found');
  }
}

async function serveFile(res, name, status = 200) {
  try {
    const data = await readFile(join(config.publicDir, name));
    const mime = MIME[extname(name).toLowerCase()] || 'application/octet-stream';
    res.writeHead(status, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    send(res, 500, 'Не найден файл интерфейса: ' + name);
  }
}

async function handleLogin(req, res) {
  const body = await readBody(req);
  const form = new URLSearchParams(body);
  const username = (form.get('username') || '').trim();
  const password = form.get('password') || '';
  const result = username && password ? login(webDb, username, password) : null;
  if (!result) {
    log.warn(`Неудачный вход: ${username || '(пусто)'}`);
    return send(res, 303, '', { Location: '/login?e=1' });
  }
  log.info(`Вход: ${result.username}`);
  send(res, 303, '', {
    'Set-Cookie': sessionCookie(result.sid, config.web.sessionTtlHours * 3600),
    Location: '/',
  });
}

function handleLogout(req, res) {
  const u = currentUser(req);
  if (u) { webDb.deleteSession(u.sid); log.info(`Выход: ${u.username}`); }
  send(res, 303, '', { 'Set-Cookie': clearCookie(), Location: '/login' });
}

function configJs() {
  // Инжектим публичный конфиг фронта: Yandex-ключ (и так виден в браузере),
  // имя объекта и центр/зум карты. Секретов тут нет.
  const front = {
    yandexApiKey: config.yandexApiKey,
    siteName: config.siteName,
    mapCenter: config.mapCenter,
    mapZoom: config.mapZoom,
  };
  return `window.APP_CONFIG = ${JSON.stringify(front)};\n`;
}

async function router(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;

  // --- публичные маршруты ---
  if (path === '/login' && method === 'GET') return serveFile(res, 'login.html');
  if (path === '/login' && method === 'POST') return handleLogin(req, res);
  if (path === '/logout' && method === 'POST') return handleLogout(req, res);
  if (path === '/healthz') return sendJson(res, 200, { ok: true });

  const user = currentUser(req);

  // --- API (требует сессию) ---
  if (path === '/api/status') {
    if (!user) return sendJson(res, 401, { error: 'требуется вход' });
    try {
      return sendJson(res, 200, buildStatus());
    } catch (e) {
      log.error(`status: ${e.message}`);
      return sendJson(res, 500, { error: 'ошибка чтения статуса' });
    }
  }

  // Кто я + роль — фронт по роли решает, показывать ли админ-панель.
  if (path === '/api/me') {
    if (!user) return sendJson(res, 401, { error: 'требуется вход' });
    return sendJson(res, 200, { username: user.username, role: user.role });
  }

  // Админ-карточка точки: расширенные метрики, история клиентов, история падений.
  // Только для роли admin; наружу не отдаёт ip/hostid (см. server/status.js).
  if (path === '/api/admin/point') {
    if (!user) return sendJson(res, 401, { error: 'требуется вход' });
    if (user.role !== 'admin') return sendJson(res, 403, { error: 'нужны права администратора' });
    const code = url.searchParams.get('code');
    if (!code) return sendJson(res, 400, { error: 'нужен параметр code' });
    const hours = Math.min(168, Math.max(1, Number(url.searchParams.get('hours') || 24)));
    const outageDays = Math.min(365, Math.max(1, Number(url.searchParams.get('days') || 30)));
    try {
      const detail = buildPointDetail(code, { hours, outageDays });
      if (!detail) return sendJson(res, 404, { error: 'точка не найдена' });
      return sendJson(res, 200, detail);
    } catch (e) {
      log.error(`admin/point: ${e.message}`);
      return sendJson(res, 500, { error: 'ошибка чтения карточки' });
    }
  }

  // --- страницы/статика (требуют сессию) ---
  if (!user) {
    if (path === '/' || path === '/index.html') {
      return send(res, 303, '', { Location: '/login' });
    }
    // Логин-страница без сессии должна тянуть свои css/js — но всё в public/.
    // Пускаем только явный набор ассетов, нужных странице логина.
    if (['/styles.css'].includes(path)) return serveStatic(res, path);
    return send(res, 303, '', { Location: '/login' });
  }

  if (path === '/' || path === '/index.html') return serveFile(res, 'index.html');
  if (path === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(configJs());
  }
  if (path === '/points.json') return serveStatic(res, '/points.json');
  if (method === 'GET') return serveStatic(res, path);

  send(res, 404, 'Not Found');
}

const server = createServer((req, res) => {
  router(req, res).catch((e) => {
    log.error(`Необработанная ошибка запроса ${req.method} ${req.url}: ${e.message}`);
    if (!res.headersSent) send(res, 500, 'Internal Server Error');
  });
});

server.listen(config.web.port, config.web.host, () => {
  log.info(`Веб-карта слушает http://${config.web.host}:${config.web.port}`);
  if (!config.yandexApiKey) log.warn('YANDEX_API_KEY не задан в .env — карта не загрузится');
  if (!webDb.listUsers().length) log.warn('Нет ни одной учётки — создайте: node server/add-user.js <логин> <пароль>');
});

function shutdown() {
  log.info('Остановка веб-сервера');
  server.close(() => { webDb.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
