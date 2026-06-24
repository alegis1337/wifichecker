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

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[config] Не задана обязательная переменная ${name} в .env`);
    process.exit(1);
  }
  return v;
}

export const config = {
  rootDir: ROOT_DIR,
  zabbix: {
    url: need('ZABBIX_URL').replace(/\/+$/, ''),
    token: need('ZABBIX_TOKEN'),
    groupId: need('ZABBIX_GROUP_ID'),
  },
  // SMTP — опционально. Если не задан, нотификатор логирует «would notify» и не падает.
  smtp: {
    host: process.env.SMTP_HOST || null,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '') === 'true',
    user: process.env.SMTP_USER || null,
    pass: process.env.SMTP_PASS || null,
    from: process.env.SMTP_FROM || process.env.SMTP_USER || null,
    to: process.env.SMTP_TO || null,
  },
  // Префикс кодов точек в имени хоста Zabbix (специфика объекта — задаётся в .env,
  // в репозиторий не хардкодим). Пусто = автоопределение кода не работает.
  hostCodePrefix: process.env.HOST_CODE_PREFIX || '',
  // Имя объекта для писем/темы (специфика заказчика — из .env). Дефолт — генерик.
  siteName: process.env.SITE_NAME || 'Мониторинг Wi-Fi',
  timeoutMs: 30_000,
  userAgent: 'wifi-monitor/0.5',
};
