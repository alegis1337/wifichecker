// Лёгкий логгер веб-сервера: консоль + файл logs/web-YYYY-MM-DD.log.
// Самостоятельный (не тянет src/logger.js, чтобы не зависеть от ZABBIX-конфига).
// Секретов в веб-части нет (сессии — случайные id), но пароли/cookie не логируем.
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

const LOGS_DIR = join(config.rootDir, 'logs');
if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

function logFilePath() {
  const d = new Date().toISOString().slice(0, 10);
  return join(LOGS_DIR, `web-${d}.log`);
}

function write(level, msg) {
  const line = `[${new Date().toISOString()}] ${level} ${msg}`;
  if (level === 'ERROR' || level === 'WARN') console.error(line);
  else console.log(line);
  try {
    appendFileSync(logFilePath(), line + '\n', 'utf8');
  } catch (e) {
    console.error(`[web-logger] не удалось записать в файл: ${e.message}`);
  }
}

export const log = {
  info: (m) => write('INFO', m),
  warn: (m) => write('WARN', m),
  error: (m) => write('ERROR', m),
};
