import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { config } from './config.js';

const STATE_DIR = join(config.rootDir, 'state');
export const DB_PATH = join(STATE_DIR, 'monitor.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS hosts (
  hostid TEXT PRIMARY KEY, name TEXT, row TEXT, code TEXT, ip TEXT, is_ap INTEGER
);
CREATE TABLE IF NOT EXISTS problems (
  eventid TEXT PRIMARY KEY, hostid TEXT, hostname TEXT, name TEXT, severity INTEGER, clock INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, kind TEXT, eventid TEXT,
  hostid TEXT, hostname TEXT, name TEXT, severity INTEGER
);
CREATE TABLE IF NOT EXISTS metrics (
  hostid TEXT PRIMARY KEY, icmp INTEGER, clients INTEGER,
  traffic_in INTEGER, traffic_out INTEGER, temp REAL, cpu REAL, mem REAL, updated_at TEXT
);
`;

export function dbFileExists() {
  return existsSync(DB_PATH);
}

function tx(db, fn) {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function openDb() {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  // WAL — чтобы веб-сервер мог читать monitor.db параллельно с записью коллектора;
  // busy_timeout — короткое ожидание вместо ошибки при пересечении операций.
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);

  return {
    getMeta(key) {
      const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
      return r ? r.value : null;
    },
    setMeta(key, value) {
      db.prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(key, String(value));
    },
    upsertHosts(hosts) {
      const stmt = db.prepare(
        `INSERT INTO hosts (hostid, name, row, code, ip, is_ap) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(hostid) DO UPDATE SET
           name = excluded.name, row = excluded.row, code = excluded.code,
           ip = excluded.ip, is_ap = excluded.is_ap`,
      );
      tx(db, () => {
        for (const h of hosts) stmt.run(h.hostid, h.name, h.row, h.code, h.ip, h.isAp);
      });
    },
    readProblems() {
      return db
        .prepare('SELECT eventid, hostid, hostname, name, severity, clock FROM problems')
        .all();
    },
    writeProblems(problems) {
      const ins = db.prepare(
        'INSERT INTO problems (eventid, hostid, hostname, name, severity, clock) VALUES (?, ?, ?, ?, ?, ?)',
      );
      tx(db, () => {
        db.exec('DELETE FROM problems');
        for (const p of problems) {
          ins.run(p.eventid, p.hostid, p.hostname, p.name, p.severity, p.clock);
        }
      });
    },
    appendEvents(events) {
      const ins = db.prepare(
        'INSERT INTO events (ts, kind, eventid, hostid, hostname, name, severity) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      tx(db, () => {
        for (const e of events) {
          ins.run(e.ts, e.kind, e.eventid, e.hostid, e.hostname, e.name, e.severity);
        }
      });
    },
    upsertMetrics(metricsByHost) {
      const stmt = db.prepare(
        `INSERT INTO metrics (hostid, icmp, clients, traffic_in, traffic_out, temp, cpu, mem, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(hostid) DO UPDATE SET
           icmp = excluded.icmp, clients = excluded.clients,
           traffic_in = excluded.traffic_in, traffic_out = excluded.traffic_out,
           temp = excluded.temp, cpu = excluded.cpu, mem = excluded.mem,
           updated_at = excluded.updated_at`,
      );
      const now = new Date().toISOString();
      tx(db, () => {
        for (const [hostid, m] of metricsByHost) {
          stmt.run(hostid, m.icmp, m.clients, m.traffic_in, m.traffic_out, m.temp, m.cpu, m.mem, now);
        }
      });
    },
    close() {
      db.close();
    },
  };
}
