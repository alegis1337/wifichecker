// Конфиг веб-сервера. Загружает .env, но НЕ требует ZABBIX_* — веб-часть
// работает только с monitor.db (источник правды) и не обращается к Zabbix.
// Так Zabbix-токен не затягивается в код/логи веб-морды (хотя .env общий —
// машина одна, см. docs/plan-customer-map.md).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function loadEnvFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue;
    process.env[key] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

loadEnvFile(join(ROOT_DIR, '.env'));

export const config = {
  rootDir: ROOT_DIR,
  monitorDbPath: join(ROOT_DIR, 'state', 'monitor.db'),
  webDbPath: join(ROOT_DIR, 'state', 'web.db'),
  publicDir: join(ROOT_DIR, 'public'),
  web: {
    host: process.env.WEB_HOST || '0.0.0.0',
    port: Number(process.env.WEB_PORT || 8080),
    // TTL сессии в часах.
    sessionTtlHours: Number(process.env.WEB_SESSION_TTL_HOURS || 12),
    // Ставить true ТОЛЬКО когда сервер за HTTPS (домен/обратный прокси),
    // иначе cookie с флагом Secure не доедет по HTTP и логин не будет работать.
    secureCookie: String(process.env.WEB_SECURE_COOKIE || '') === 'true',
  },
  // Ключ Yandex Maps JS API. Виден в браузере (это норма для JS API),
  // но в репозитории не хардкодим — берём из .env и инжектим в /config.js.
  // Обязательно ограничить ключ по домену-referer в кабинете Яндекса.
  yandexApiKey: process.env.YANDEX_API_KEY || '',
  // Отображаемое имя объекта (специфика заказчика — из .env, не хардкодим).
  // Инжектится во фронт через /config.js. Дефолт — генерик.
  siteName: process.env.SITE_NAME || 'Мониторинг Wi-Fi',
  // Центр/зум карты по умолчанию (если points.json пуст). Координаты объекта —
  // специфика заказчика, поэтому из .env; дефолт нейтральный (центр РФ).
  mapCenter: [Number(process.env.MAP_CENTER_LAT || 55.751), Number(process.env.MAP_CENTER_LON || 37.618)],
  mapZoom: Number(process.env.MAP_ZOOM || 17),
  // Сколько секунд данные считаются свежими (collector ходит раз в ~5 мин).
  staleAfterSec: Number(process.env.WEB_STALE_AFTER_SEC || 720),
};
