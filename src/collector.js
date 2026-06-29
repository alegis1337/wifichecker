import { ZabbixClient } from './zabbix-client.js';
import { collectMetrics } from './metrics.js';
import { config } from './config.js';
import { log } from './logger.js';

// Из имени хоста Zabbix достаём код точки (по префиксу HOST_CODE_PREFIX из .env) и ряд.
// Имя вида: "<Объект> - Ряд X AP01 (<PREFIX>3)". Коммутаторы/шлюз кода не имеют → не AP.
const CODE_RE = config.hostCodePrefix
  ? new RegExp(`${config.hostCodePrefix}[A-Za-z0-9]+`, 'i')
  : null;

function parseHostMeta(name) {
  const codeM = CODE_RE ? name.match(CODE_RE) : null;
  const rowM = name.match(/Ряд\s+([^\s()]+)/i);
  const code = codeM ? codeM[0] : null;
  return { code, row: rowM ? rowM[1] : null, isAp: code ? 1 : 0 };
}

export async function collect() {
  const client = new ZabbixClient();
  const groupids = [config.zabbix.groupId];

  const [hostsRaw, problems] = await Promise.all([
    client.call('host.get', {
      output: ['hostid', 'host', 'name', 'status'],
      groupids,
      selectInterfaces: ['ip', 'type', 'main'],
    }),
    client.call('problem.get', {
      output: 'extend',
      groupids,
      recent: false,
      sortfield: ['eventid'],
      sortorder: 'DESC',
    }),
  ]);
  log.info(`Хостов в группе: ${hostsRaw.length}`);
  log.info(`Активных проблем в группе: ${problems.length}`);

  const hosts = hostsRaw.map((h) => {
    const iface = h.interfaces?.find((i) => i.main === '1') ?? h.interfaces?.[0] ?? null;
    const meta = parseHostMeta(h.name || '');
    return {
      hostid: h.hostid,
      host: h.host,
      name: h.name,
      ip: iface?.ip ?? null,
      status: h.status,
      code: meta.code,
      row: meta.row,
      isAp: meta.isAp,
    };
  });
  const hostIds = new Set(hosts.map((h) => h.hostid));

  // problem.objectid = triggerid; хост получаем через trigger.get
  const triggerToHosts = new Map();
  const triggerIds = [...new Set(problems.map((p) => p.objectid).filter(Boolean))];
  if (triggerIds.length) {
    const triggers = await client.call('trigger.get', {
      output: ['triggerid'],
      triggerids: triggerIds,
      selectHosts: ['hostid', 'host', 'name'],
    });
    for (const t of triggers) triggerToHosts.set(t.triggerid, t.hosts);
  }

  const enrichedProblems = problems.map((p) => {
    const tHosts = triggerToHosts.get(p.objectid) ?? [];
    const primary = tHosts.find((h) => hostIds.has(h.hostid)) ?? null;
    return {
      eventid: p.eventid,
      name: p.name,
      severity: Number(p.severity),
      clock: Number(p.clock),
      objectid: p.objectid,
      hostid: primary?.hostid ?? null,
      hostname: primary?.name ?? primary?.host ?? null,
    };
  });

  // Богатые метрики только для AP-хостов (на карту идут только они).
  const apHostIds = hosts.filter((h) => h.isAp).map((h) => h.hostid);
  const { metrics, info } = await collectMetrics(client, apHostIds);

  return { hosts, problems: enrichedProblems, metrics, info };
}
