// Diff активных проблем по eventid между текущим прогоном и предыдущим (из БД).
export function diffProblems(currentProblems, previousProblems) {
  const prevIds = new Set(previousProblems.map((p) => p.eventid));
  const currIds = new Set(currentProblems.map((p) => p.eventid));
  return {
    newProblems: currentProblems.filter((p) => !prevIds.has(p.eventid)),
    resolvedProblems: previousProblems.filter((p) => !currIds.has(p.eventid)),
  };
}

// Статус AP по результату icmpping: up (отвечает) / down (молчит) / unknown (нет данных).
export function statusFromIcmp(icmp) {
  if (icmp === null || icmp === undefined) return 'unknown';
  return icmp >= 1 ? 'up' : 'down';
}

// Дифф доступности точек относительно прошлого прогона (host_state из БД):
// — транзиты up↔down (история падений, last-online, длительность простоя);
// — «массовое отключение»: число клиентов было >= порога и стало ровно 0
//   (признак проблемы самой точки, а не естественного ухода людей).
// unknown (нет данных по icmp) транзитами не считаем.
export function diffAvailability(apHosts, metricsByHost, prevState, now, dropThreshold) {
  const states = [];
  const events = [];
  const downAps = [];
  const recoveredAps = [];
  const drops = [];

  for (const h of apHosts) {
    const m = metricsByHost.get(h.hostid) ?? null;
    const status = statusFromIcmp(m ? m.icmp : null);
    const clients = m && m.clients !== null && m.clients !== undefined ? m.clients : null;
    const prev = prevState.get(h.hostid) ?? null;

    const statusChanged = !prev || prev.status !== status;
    const status_since = statusChanged ? now : prev.status_since;
    const last_up_ts = status === 'up' ? now : prev?.last_up_ts ?? null;
    // last_clients не затираем null'ом (бывает «нет item») — храним последнее известное.
    const last_clients = clients !== null ? clients : prev?.last_clients ?? null;
    states.push({ hostid: h.hostid, status, status_since, last_up_ts, last_clients });

    if (prev && prev.status === 'up' && status === 'down') {
      events.push({ ts: now, hostid: h.hostid, kind: 'down', detail: h.name, downtime_sec: null });
      downAps.push({ hostid: h.hostid, hostname: h.name, since: now });
    } else if (prev && prev.status === 'down' && status === 'up') {
      const downtime_sec = prev.status_since
        ? Math.max(0, Math.round((Date.parse(now) - Date.parse(prev.status_since)) / 1000))
        : null;
      events.push({ ts: now, hostid: h.hostid, kind: 'up', detail: h.name, downtime_sec });
      recoveredAps.push({ hostid: h.hostid, hostname: h.name, downtime_sec });
    }

    if (prev && prev.last_clients !== null && prev.last_clients >= dropThreshold && clients === 0) {
      const detail = `клиентов было ${prev.last_clients} → 0`;
      events.push({ ts: now, hostid: h.hostid, kind: 'client_drop', detail, downtime_sec: null });
      drops.push({ hostid: h.hostid, hostname: h.name, prev: prev.last_clients });
    }
  }

  return { states, events, downAps, recoveredAps, drops };
}
