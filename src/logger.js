import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
let minLevel = LEVELS.INFO;

export function enableDebug() {
  minLevel = LEVELS.DEBUG;
}

const LOGS_DIR = join(config.rootDir, 'logs');
if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

const RE_BEARER = /(Authorization\s*:\s*Bearer\s+)\S+/gi;
const RE_HEX64 = /\b[0-9a-f]{64}\b/gi;
const TOKEN = config.zabbix.token;
const SMTP_PASS = config.smtp.pass;

function logFilePath() {
  const d = new Date().toISOString().slice(0, 10);
  return join(LOGS_DIR, `${d}.log`);
}

function maskSecrets(s) {
  if (typeof s !== 'string') return String(s);
  let out = s.replace(RE_BEARER, '$1***').replace(RE_HEX64, '***');
  if (TOKEN) out = out.split(TOKEN).join('***');
  if (SMTP_PASS) out = out.split(SMTP_PASS).join('***');
  return out;
}

function write(level, msg) {
  if (LEVELS[level] < minLevel) return;
  const line = `[${new Date().toISOString()}] ${level} ${maskSecrets(msg)}`;
  if (level === 'ERROR' || level === 'WARN') console.error(line);
  else console.log(line);
  try {
    appendFileSync(logFilePath(), line + '\n', 'utf8');
  } catch (e) {
    console.error(`[logger] не удалось записать в файл: ${e.message}`);
  }
}

export const log = {
  debug: (m) => write('DEBUG', m),
  info: (m) => write('INFO', m),
  warn: (m) => write('WARN', m),
  error: (m) => write('ERROR', m),
};
