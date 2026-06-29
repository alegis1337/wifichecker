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
-- v0.6 — данные для админ-панели:
-- Таймлайн метрик (по строке за прогон) — динамика клиентов/статуса/нагрузки.
CREATE TABLE IF NOT EXISTS metrics_history (
  hostid TEXT, ts TEXT, icmp INTEGER, clients INTEGER,
  traffic_in INTEGER, traffic_out INTEGER, temp REAL, cpu REAL, mem REAL
);
CREATE INDEX IF NOT EXISTS idx_metrics_history_host_ts ON metrics_history (hostid, ts);
-- Атрибуты устройства из item.get: модель/прошивка/SSID/диапазон + аптайм (сек).
-- Отдельная таблица (а не новые колонки в metrics) — чтобы не мигрировать боевую БД.
CREATE TABLE IF NOT EXISTS host_info (
  hostid TEXT PRIMARY KEY, model TEXT, firmware TEXT, ssid TEXT, band TEXT,
  uptime INTEGER, updated_at TEXT
);
-- Текущее состояние точки: «последний раз онлайн», начало текущего статуса,
-- последнее число клиентов — для диффа транзитов и детекта обвала клиентов.
CREATE TABLE IF NOT EXISTS host_state (
  hostid TEXT PRIMARY KEY, status TEXT, status_since TEXT, last_up_ts TEXT, last_clients INTEGER
);
-- Журнал транзитов доступности и массовых отключений: история падений точки.
CREATE TABLE IF NOT EXISTS status_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, hostid TEXT,
  kind TEXT, detail TEXT, downtime_sec INTEGER
);
CREATE INDEX IF NOT EXISTS idx_status_events_host_ts ON status_events (hostid, ts);
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
    // --- v0.6: история и состояние точек (для админ-панели) ---
    appendMetricsHistory(metricsByHost, ts) {
      const ins = db.prepare(
        `INSERT INTO metrics_history (hostid, ts, icmp, clients, traffic_in, traffic_out, temp, cpu, mem)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      tx(db, () => {
        for (const [hostid, m] of metricsByHost) {
          ins.run(hostid, ts, m.icmp, m.clients, m.traffic_in, m.traffic_out, m.temp, m.cpu, m.mem);
        }
      });
    },
    upsertHostInfo(infoByHost, ts) {
      const stmt = db.prepare(
        `INSERT INTO host_info (hostid, model, firmware, ssid, band, uptime, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(hostid) DO UPDATE SET
           model = excluded.model, firmware = excluded.firmware,
           ssid = excluded.ssid, band = excluded.band,
           uptime = excluded.uptime, updated_at = excluded.updated_at`,
      );
      tx(db, () => {
        for (const [hostid, i] of infoByHost) {
          stmt.run(hostid, i.model, i.firmware, i.ssid, i.band, i.uptime, ts);
        }
      });
    },
    readHostStateAll() {
      const rows = db
        .prepare('SELECT hostid, status, status_since, last_up_ts, last_clients FROM host_state')
        .all();
      return new Map(rows.map((r) => [r.hostid, r]));
    },
    updateHostState(states) {
      const stmt = db.prepare(
        `INSERT INTO host_state (hostid, status, status_since, last_up_ts, last_clients)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(hostid) DO UPDATE SET
           status = excluded.status, status_since = excluded.status_since,
           last_up_ts = excluded.last_up_ts, last_clients = excluded.last_clients`,
      );
      tx(db, () => {
        for (const s of states) {
          stmt.run(s.hostid, s.status, s.status_since, s.last_up_ts, s.last_clients);
        }
      });
    },
    appendStatusEvents(events) {
      const ins = db.prepare(
        'INSERT INTO status_events (ts, hostid, kind, detail, downtime_sec) VALUES (?, ?, ?, ?, ?)',
      );
      tx(db, () => {
        for (const e of events) ins.run(e.ts, e.hostid, e.kind, e.detail ?? null, e.downtime_sec ?? null);
      });
    },
    // Чистка истории старше N дней — чтобы БД не росла бесконечно.
    pruneHistory(days) {
      const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
      const a = db.prepare('DELETE FROM metrics_history WHERE ts < ?').run(cutoff);
      const b = db.prepare('DELETE FROM status_events WHERE ts < ?').run(cutoff);
      return a.changes + b.changes;
    },
    // --- чтение для админ-API ---
    readHostInfo(hostid) {
      return db
        .prepare('SELECT model, firmware, ssid, band, uptime, updated_at FROM host_info WHERE hostid = ?')
        .get(hostid) ?? null;
    },
    readHostState(hostid) {
      return db
        .prepare('SELECT status, status_since, last_up_ts, last_clients FROM host_state WHERE hostid = ?')
        .get(hostid) ?? null;
    },
    readMetricsHistory(hostid, sinceTs) {
      return db
        .prepare(
          `SELECT ts, icmp, clients, traffic_in, traffic_out, temp, cpu, mem
           FROM metrics_history WHERE hostid = ? AND ts >= ? ORDER BY ts ASC`,
        )
        .all(hostid, sinceTs);
    },
    readOutages(hostid, sinceTs) {
      return db
        .prepare(
          `SELECT ts, kind, detail, downtime_sec FROM status_events
           WHERE hostid = ? AND ts >= ? ORDER BY ts DESC`,
        )
        .all(hostid, sinceTs);
    },
    close() {
      db.close();
    },
  };
}
