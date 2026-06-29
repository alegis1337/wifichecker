import { promises as dns } from 'node:dns';
import { config } from './config.js';
import { log } from './logger.js';

const SEVERITY = {
  0: 'not classified', 1: 'information', 2: 'warning',
  3: 'average', 4: 'high', 5: 'disaster',
};

export function smtpConfigured() {
  const s = config.smtp;
  return Boolean(s.host && s.from && s.to);
}

// Хелпдеск-канал: тот же SMTP, но адрес получателя — config.helpdeskTo.
export function helpdeskConfigured() {
  const s = config.smtp;
  return Boolean(s.host && s.from && config.helpdeskTo);
}

function formatProblem(p) {
  const when = new Date(p.clock * 1000).toISOString();
  const where = p.hostname ?? `hostid=${p.hostid ?? '?'}`;
  const sev = SEVERITY[p.severity] ?? `sev=${p.severity}`;
  const link = `${config.zabbix.url}/tr_events.php?triggerid=${p.objectid ?? ''}&eventid=${p.eventid}`;
  return {
    subject: `[${config.siteName}][${sev}] ${where}: ${p.name}`,
    text:
      `Узел: ${where}\n` +
      `Проблема: ${p.name}\n` +
      `Важность: ${sev}\n` +
      `Время: ${when}\n` +
      `Zabbix: ${link}\n`,
  };
}

async function getTransport() {
  const { default: nodemailer } = await import('nodemailer');
  const s = config.smtp;
  // На этой VM есть VPN-туннель со своим DNS, в который c-ares (его использует
  // nodemailer для резолва) упирается по таймауту (queryA ETIMEOUT), хотя
  // системный getaddrinfo резолвит нормально. Поэтому резолвим хост сами через
  // dns.lookup (getaddrinfo, IPv4) и подключаемся по IP, а TLS проверяем по
  // имени хоста (servername). При неудаче резолва — отдаём хост как есть.
  let host = s.host;
  let tls;
  try {
    const r = await dns.lookup(s.host, { family: 4 });
    host = r.address;
    tls = { servername: s.host };
  } catch {
    /* оставим хостнейм — пусть nodemailer резолвит сам */
  }
  return nodemailer.createTransport({
    host,
    port: s.port,
    secure: s.secure,
    auth: s.user ? { user: s.user, pass: s.pass } : undefined,
    tls,
  });
}

export async function notifyNewProblems(problems) {
  if (!problems.length) return;
  if (!smtpConfigured()) {
    for (const p of problems) {
      log.info(`[email отключён] оповестил бы: ${formatProblem(p).subject}`);
    }
    return;
  }
  const transport = await getTransport();
  for (const p of problems) {
    const m = formatProblem(p);
    try {
      await transport.sendMail({ from: config.smtp.from, to: config.smtp.to, subject: m.subject, text: m.text });
      log.info(`Email отправлен: ${m.subject}`);
    } catch (e) {
      log.error(`Не удалось отправить email (${m.subject}): ${e.message}`);
    }
  }
}

function fmtDowntime(sec) {
  if (sec === null || sec === undefined) return '?';
  if (sec < 90) return `${sec} с`;
  const m = Math.round(sec / 60);
  if (m < 90) return `${m} мин`;
  return `${Math.round(m / 60)} ч`;
}

// Оповещение хелпдеска о падении/восстановлении точек (req v0.6).
// Gated так же, как notifyNewProblems: без SMTP/адреса логируем «would notify».
// ДЕДУП «1 проблема = 1 письмо»: сюда приходят только ТРАНЗИТЫ из diffAvailability
// (up→down / down→up) относительно сохранённого host_state. Пока точка лежит,
// повторных писем нет; письмо о падении — одно, о восстановлении — одно. Состояние
// в monitor.db переживает перезапуски коллектора, так что дублей между прогонами нет.
export async function notifyApDown(downAps, recoveredAps) {
  const down = downAps ?? [];
  const recovered = recoveredAps ?? [];
  if (!down.length && !recovered.length) return;

  const lines = [];
  if (down.length) {
    lines.push(`Не отвечают точки (${down.length}):`);
    for (const a of down) lines.push(`  • ${a.hostname}`);
  }
  if (recovered.length) {
    lines.push(`Восстановлены (${recovered.length}):`);
    for (const a of recovered) lines.push(`  • ${a.hostname} (простой ~${fmtDowntime(a.downtime_sec)})`);
  }
  const subject = down.length
    ? `[${config.siteName}] Не отвечают точки Wi-Fi: ${down.length}`
    : `[${config.siteName}] Восстановлены точки Wi-Fi: ${recovered.length}`;
  const text = lines.join('\n') + '\n';

  if (!helpdeskConfigured()) {
    log.info(`[email отключён] хелпдеск оповестил бы: ${subject}`);
    return;
  }
  const transport = await getTransport();
  try {
    await transport.sendMail({ from: config.smtp.from, to: config.helpdeskTo, subject, text });
    log.info(`Хелпдеск-письмо отправлено: ${subject}`);
  } catch (e) {
    log.error(`Не удалось отправить хелпдеск-письмо (${subject}): ${e.message}`);
  }
}

export async function sendTest() {
  // Тест шлём на SMTP_TO, а если он не задан — на адрес хелпдеска (HELPDESK_TO).
  const to = config.smtp.to || config.helpdeskTo;
  if (!config.smtp.host || !config.smtp.from || !to) {
    log.error('SMTP не настроен (нужны SMTP_HOST / SMTP_FROM / SMTP_TO или HELPDESK_TO в .env) — тест невозможен');
    return false;
  }
  const transport = await getTransport();
  await transport.sendMail({
    from: config.smtp.from,
    to,
    subject: `[${config.siteName}] Тест оповещений`,
    text: 'Тестовое письмо от wifi-monitor. Если вы это видите — SMTP работает.',
  });
  log.info(`Тестовое письмо отправлено на ${to}`);
  return true;
}
