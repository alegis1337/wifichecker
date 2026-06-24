import { log, enableDebug } from './logger.js';
import { collect } from './collector.js';
import { openDb, dbFileExists } from './db.js';
import { diffProblems } from './detector.js';
import { notifyNewProblems, sendTest } from './notifier.js';

const SEV = {
  0: 'not classified', 1: 'information', 2: 'warning',
  3: 'average', 4: 'high', 5: 'disaster',
};

function parseArgs(argv) {
  const a = { once: false, debug: false, test: false };
  for (const x of argv.slice(2)) {
    if (x === '--once') a.once = true;
    else if (x === '--debug') a.debug = true;
    else if (x === '--test') a.test = true;
    else if (x === '--help' || x === '-h') { printHelp(); process.exit(0); }
    else { console.error(`Неизвестный флаг: ${x}`); printHelp(); process.exit(2); }
  }
  return a;
}

function printHelp() {
  console.log([
    'rinok-wifi-monitor — сбор статуса/метрик точек рынка из Zabbix',
    '',
    'Использование:',
    '  node src/index.js            обычный прогон (collect → БД → diff → notify)',
    '  node src/index.js --once     без записи БД и без оповещений (диагностика)',
    '  node src/index.js --debug    DEBUG-логи',
    '  node src/index.js --test     отправить тестовое письмо и выйти',
  ].join('\n'));
}

function describeProblem(p) {
  const when = new Date(p.clock * 1000).toISOString();
  const where = p.hostname ?? `hostid=${p.hostid}`;
  return `[${SEV[p.severity] ?? p.severity}] ${where}: '${p.name}' @ ${when}`;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.debug) enableDebug();

  if (args.test) {
    const ok = await sendTest();
    process.exit(ok ? 0 : 1);
  }

  const started = Date.now();
  log.info(`Старт прогона${args.once ? ' (--once)' : ''}`);

  let raw;
  try {
    raw = await collect();
  } catch (e) {
    log.error(`Сбор Zabbix провалился: ${e.message}`);
    process.exit(1);
  }

  // Сводка up/down по AP-точкам (из icmpping).
  let up = 0, down = 0, unknown = 0;
  for (const h of raw.hosts) {
    if (!h.isAp) continue;
    const m = raw.metrics.get(h.hostid);
    if (!m || m.icmp === null) unknown++;
    else if (m.icmp >= 1) up++;
    else down++;
  }
  log.info(`Точки (AP): up=${up}, down=${down}, unknown=${unknown}`);

  // Diff проблем относительно предыдущего прогона (из БД).
  const willPersist = !args.once;
  let db = null;
  let prev = [];
  if (willPersist || dbFileExists()) {
    db = openDb();
    prev = db.readProblems();
  }
  const baseline = db ? db.getMeta('last_run') === null : true;
  const { newProblems, resolvedProblems } = diffProblems(raw.problems, prev);

  if (baseline) {
    log.info(`Baseline-прогон — ${raw.problems.length} активных проблем зафиксировано, оповещения не считаются`);
  } else if (!newProblems.length && !resolvedProblems.length) {
    log.info('Новых/решённых проблем нет — состояние стабильно');
  } else {
    log.info(`Новых проблем: ${newProblems.length}; решённых: ${resolvedProblems.length}`);
    for (const p of newProblems) log.warn(`[НОВАЯ] ${describeProblem(p)}`);
    for (const p of resolvedProblems) log.info(`[РЕШЕНА] ${describeProblem(p)}`);
  }

  if (!willPersist) {
    log.info('--once: БД не пишется, оповещения не шлются');
    if (db) db.close();
    log.info(`Готово за ${Date.now() - started} мс`);
    process.exit(0);
  }

  try {
    db.upsertHosts(raw.hosts);
    db.upsertMetrics(raw.metrics);
    if (!baseline) {
      const ts = new Date().toISOString();
      const events = [
        ...newProblems.map((p) => ({ ts, kind: 'new', eventid: p.eventid, hostid: p.hostid, hostname: p.hostname, name: p.name, severity: p.severity })),
        ...resolvedProblems.map((p) => ({ ts, kind: 'resolved', eventid: p.eventid, hostid: p.hostid, hostname: p.hostname, name: p.name, severity: p.severity })),
      ];
      if (events.length) db.appendEvents(events);
    }
    db.writeProblems(raw.problems);
    db.setMeta('last_run', new Date().toISOString());
  } catch (e) {
    log.error(`Запись в БД провалилась: ${e.message}`);
    if (db) db.close();
    process.exit(1);
  }

  if (!baseline && newProblems.length) {
    try {
      await notifyNewProblems(newProblems);
    } catch (e) {
      log.error(`Оповещение упало: ${e.message}`);
    }
  }

  db.close();
  log.info(`Готово за ${Date.now() - started} мс`);
  process.exit(0);
}

main().catch((e) => {
  console.error(`Необработанная ошибка: ${e?.stack ?? e?.message ?? e}`);
  process.exit(1);
});
