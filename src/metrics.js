import { log } from './logger.js';

// Какой ключ Zabbix к какой метрике относится (по подстроке в key_).
const MATCH = {
  icmp: (k) => k === 'icmpping',
  clients: (k) => k.includes('mtxrWlApClientCount'),
  trafficIn: (k) => k.includes('ifHCInOctets'),
  trafficOut: (k) => k.includes('ifHCOutOctets'),
  temp: (k) => k.includes('mtxrHlTemperature'),
  cpu: (k) => k.includes('hrProcessorLoad'),
  mem: (k) => k.includes('memoryUsedPercentage') || k.startsWith('vm.memory.util'),
};

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function blank() {
  return {
    icmp: null, clients: null, traffic_in: null, traffic_out: null,
    temp: null, cpu: null, mem: null, _cpuSum: 0, _cpuN: 0,
  };
}

// Одним item.get тянем все items AP-хостов и раскладываем по hostid (не 47 запросов).
// Трафик — сумма по интерфейсам (приблизительно; уточним на этапе карточки точки).
export async function collectMetrics(client, apHostIds) {
  if (apHostIds.length === 0) return new Map();

  const items = await client.call('item.get', {
    output: ['hostid', 'key_', 'lastvalue'],
    hostids: apHostIds,
  });

  const acc = new Map();
  for (const id of apHostIds) acc.set(id, blank());

  for (const it of items) {
    const m = acc.get(it.hostid);
    if (!m) continue;
    const k = it.key_;
    const v = num(it.lastvalue);
    if (MATCH.icmp(k)) m.icmp = v;
    else if (MATCH.clients(k)) m.clients = (m.clients ?? 0) + (v ?? 0);
    else if (MATCH.trafficIn(k)) m.traffic_in = (m.traffic_in ?? 0) + (v ?? 0);
    else if (MATCH.trafficOut(k)) m.traffic_out = (m.traffic_out ?? 0) + (v ?? 0);
    else if (MATCH.temp(k)) { if (v !== null) m.temp = v; }
    else if (MATCH.cpu(k)) { if (v !== null) { m._cpuSum += v; m._cpuN += 1; } }
    else if (MATCH.mem(k)) { if (v !== null) m.mem = v; }
  }

  for (const m of acc.values()) {
    m.cpu = m._cpuN ? Math.round((m._cpuSum / m._cpuN) * 10) / 10 : null;
    delete m._cpuSum;
    delete m._cpuN;
  }

  log.info(`Метрики собраны для ${acc.size} точек (item.get, 1 запрос, ${items.length} items)`);
  return acc;
}
