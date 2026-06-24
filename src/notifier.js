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
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    auth: s.user ? { user: s.user, pass: s.pass } : undefined,
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

export async function sendTest() {
  if (!smtpConfigured()) {
    log.error('SMTP не настроен (нужны SMTP_HOST / SMTP_FROM / SMTP_TO в .env) — тест невозможен');
    return false;
  }
  const transport = await getTransport();
  await transport.sendMail({
    from: config.smtp.from,
    to: config.smtp.to,
    subject: `[${config.siteName}] Тест оповещений`,
    text: 'Тестовое письмо от wifi-monitor. Если вы это видите — SMTP работает.',
  });
  log.info('Тестовое письмо отправлено');
  return true;
}
