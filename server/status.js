// Чтение источника правды (monitor.db) и сборка БЕЗОПАСНОГО снимка для карты.
// Наружу отдаём только то, что нужно заказчику: код точки, имя, ряд, статус,
// метрики, активные проблемы. НЕ отдаём ip, hostid и прочие внутренние детали.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { config } from './config.js';

// Открываем monitor.db только на чтение. Коллектор пишет его в WAL-режиме,
// так что параллельное чтение безопасно. Соединение открываем на каждый
// запрос статуса и закрываем — частота низкая (поллинг ~30 c), зато всегда
// видим свежие данные и не держим блокировок.
function openMonitorRead() {
  if (!existsSync(config.monitorDbPath)) return null;
  let db;
  try {
    db = new DatabaseSync(config.monitorDbPath, { readOnly: true });
  } catch {
    // На случай старого node:sqlite без readOnly — откроем обычно (только SELECT'ы).
    db = new DatabaseSync(config.monitorDbPath);
  }
  db.exec('PRAGMA busy_timeout=5000;');
  return db;
}

function statusFromIcmp(icmp) {
  if (icmp === null || icmp === undefined) return 'unknown';
  return icmp >= 1 ? 'up' : 'down';
}

export function buildStatus() {
  const generatedAt = new Date().toISOString();
  const db = openMonitorRead();
  if (!db) {
    return { generated_at: generatedAt, last_run: null, data_age_sec: null, stale: true, points: [] };
  }
  try {
    const hosts = db
      .prepare('SELECT hostid, name, row, code FROM hosts WHERE is_ap = 1')
      .all();
    const metrics = new Map(
      db.prepare('SELECT hostid, icmp, clients, traffic_in, traffic_out, temp, cpu, mem, updated_at FROM metrics').all()
        .map((m) => [m.hostid, m]),
    );
    const problemsByHost = new Map();
    for (const p of db.prepare('SELECT hostid, name, severity, clock FROM problems').all()) {
      if (!p.hostid) continue;
      if (!problemsByHost.has(p.hostid)) problemsByHost.set(p.hostid, []);
      problemsByHost.get(p.hostid).push({ name: p.name, severity: p.severity, since: p.clock });
    }
    const lastRun = (() => {
      const r = db.prepare("SELECT value FROM meta WHERE key = 'last_run'").get();
      return r ? r.value : null;
    })();

    const points = hosts.map((h) => {
      const m = metrics.get(h.hostid) ?? null;
      const probs = problemsByHost.get(h.hostid) ?? [];
      return {
        code: h.code,
        name: h.name,
        row: h.row,
        status: statusFromIcmp(m ? m.icmp : null),
        clients: m ? m.clients : null,
        traffic_in: m ? m.traffic_in : null,
        traffic_out: m ? m.traffic_out : null,
        temp: m ? m.temp : null,
        cpu: m ? m.cpu : null,
        mem: m ? m.mem : null,
        updated_at: m ? m.updated_at : null,
        problems: probs,
      };
    });

    const dataAgeSec = lastRun
      ? Math.max(0, Math.round((Date.now() - new Date(lastRun).getTime()) / 1000))
      : null;

    return {
      generated_at: generatedAt,
      last_run: lastRun,
      data_age_sec: dataAgeSec,
      stale: dataAgeSec === null || dataAgeSec > config.staleAfterSec,
      points,
    };
  } finally {
    db.close();
  }
}
