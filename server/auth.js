// Аутентификация без нативных зависимостей: пароли — scrypt из node:crypto
// (bcrypt требует сборку, которой на машине нет). Сессии — случайный id в cookie,
// хранятся в web.db.
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

const SCRYPT_KEYLEN = 64;

// "scrypt$<saltHex>$<hashHex>"
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  let actual;
  try {
    actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  } catch {
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function newSessionId() {
  return randomBytes(32).toString('hex');
}

// Проверка логина/пароля и выдача сессии. Возвращает sid или null.
export function login(webDb, username, password) {
  const user = webDb.getUser(username);
  // Считаем хеш даже при отсутствии юзера — чтобы не палить существование по времени.
  const ref = user ? user.pass_hash : 'scrypt$00$00';
  const ok = verifyPassword(password, ref);
  if (!user || !ok) return null;
  const sid = newSessionId();
  webDb.createSession(sid, user.username, config.web.sessionTtlHours);
  return { sid, username: user.username, role: user.role };
}
