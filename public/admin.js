// Админ-панель карточки точки (видна только роли admin). Открывается по клику
// маркера вместо обычного балуна; тянет /api/admin/point по каждому коду точки.
// Без сторонних библиотек: спарклайн числа клиентов — инлайн-SVG.
// Наружу сервер не отдаёт ip/hostid (см. server/status.js) — здесь их и нет.

(function () {
  // --- мелкие форматтеры (независимы от map.js, чтобы файл был самодостаточным) ---
  function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function num(v, suffix = '') {
    return v === null || v === undefined ? '—' : `${v}${suffix}`;
  }
  function rate(bps) {
    if (bps === null || bps === undefined) return '—';
    const u = ['бит/с', 'Кбит/с', 'Мбит/с', 'Гбит/с'];
    let v = bps, i = 0;
    while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
  }
  function dt(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('ru-RU');
  }
  function ago(iso) {
    if (!iso) return 'нет данных';
    const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    return dur(sec) + ' назад';
  }
  function dur(sec) {
    if (sec === null || sec === undefined) return '?';
    if (sec < 90) return `${sec} с`;
    const m = Math.round(sec / 60);
    if (m < 90) return `${m} мин`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} ч`;
    return `${Math.round(h / 24)} дн`;
  }

  // --- спарклайн числа клиентов (SVG) ---
  // history: [{ts, clients, icmp}]. Красные полосы — периоды icmp<1 (точка не
  // отвечала). Красные точки — массовые отключения (clients >0 → 0).
  function sparkline(history) {
    const pts = history.filter((h) => h.clients !== null && h.clients !== undefined);
    if (history.length < 2) return '<div class="ad-empty">Недостаточно данных для графика (нужно ≥2 замера)</div>';
    const W = 320, H = 70, P = 6;
    const n = history.length;
    const maxC = Math.max(1, ...pts.map((h) => h.clients));
    const x = (i) => P + (i * (W - 2 * P)) / (n - 1);
    const y = (c) => H - P - ((c || 0) * (H - 2 * P)) / maxC;

    // полосы недоступности (icmp<1)
    let bands = '';
    for (let i = 0; i < n; i++) {
      const down = history[i].icmp !== null && history[i].icmp < 1;
      if (!down) continue;
      const x0 = i === 0 ? P : (x(i - 1) + x(i)) / 2;
      const x1 = i === n - 1 ? W - P : (x(i) + x(i + 1)) / 2;
      bands += `<rect x="${x0.toFixed(1)}" y="${P}" width="${Math.max(1, x1 - x0).toFixed(1)}" height="${H - 2 * P}" fill="var(--down)" opacity="0.18"/>`;
    }

    // линия клиентов
    const line = history.map((h, i) => `${x(i).toFixed(1)},${y(h.clients).toFixed(1)}`).join(' ');
    const area = `${P},${H - P} ${line} ${(W - P)},${H - P}`;

    // точки массового отключения
    let drops = '';
    for (let i = 1; i < n; i++) {
      const prev = history[i - 1].clients, cur = history[i].clients;
      if (prev !== null && prev > 0 && cur === 0) {
        drops += `<circle cx="${x(i).toFixed(1)}" cy="${y(0).toFixed(1)}" r="3.5" fill="var(--down)"/>`;
      }
    }

    return `<svg class="ad-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Динамика клиентов">
      ${bands}
      <polyline points="${area}" fill="var(--accent)" opacity="0.12" stroke="none"/>
      <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
      ${drops}
    </svg>
    <div class="ad-spark-axis"><span>${dt(history[0].ts)}</span><span>макс. ${maxC}</span><span>${dt(history[n - 1].ts)}</span></div>`;
  }

  function outagesHtml(outages) {
    if (!outages.length) return '<div class="ad-empty">Падений за период нет</div>';
    const label = { down: 'не отвечает', up: 'восстановлена', client_drop: 'массовое отключение' };
    const rows = outages.map((o) => {
      const extra = o.kind === 'up' && o.downtime_sec != null
        ? ` <span class="ad-mut">(простой ~${dur(o.downtime_sec)})</span>`
        : o.detail && o.kind === 'client_drop' ? ` <span class="ad-mut">(${esc(o.detail)})</span>` : '';
      return `<tr class="ad-ev ${o.kind}"><td>${dt(o.ts)}</td><td>${label[o.kind] || o.kind}${extra}</td></tr>`;
    }).join('');
    return `<table class="ad-table"><tbody>${rows}</tbody></table>`;
  }

  function radioSection(d) {
    const dev = d.device || {};
    const cur = d.current || {};
    const onlineLine = d.status === 'up'
      ? `<span class="badge up">работает</span> с ${dt(d.status_since)}`
      : d.status === 'down'
        ? `<span class="badge down">не отвечает</span> с ${dt(d.status_since)} · последний раз онлайн: ${d.last_up_ts ? ago(d.last_up_ts) : 'нет данных'}`
        : `<span class="badge unknown">нет данных</span>`;

    return `<section class="ad-radio">
      <h3>${esc(d.name || d.code)}</h3>
      <div class="ad-status">${onlineLine}</div>

      <div class="ad-grid">
        <div><span class="ad-k">Клиенты</span><span class="ad-v">${num(cur.clients)}</span></div>
        <div><span class="ad-k">SSID</span><span class="ad-v">${esc(dev.ssid || '—')}</span></div>
        <div><span class="ad-k">Диапазон</span><span class="ad-v">${esc(dev.band || '—')}</span></div>
        <div><span class="ad-k">Аптайм</span><span class="ad-v">${dur(dev.uptime)}</span></div>
        <div><span class="ad-k">Модель</span><span class="ad-v">${esc(dev.model || '—')}</span></div>
        <div><span class="ad-k">Прошивка</span><span class="ad-v">${esc(dev.firmware || '—')}</span></div>
        <div><span class="ad-k">Темп.</span><span class="ad-v">${num(cur.temp, ' °C')}</span></div>
        <div><span class="ad-k">CPU / RAM</span><span class="ad-v">${num(cur.cpu, '%')} / ${num(cur.mem == null ? null : Math.round(cur.mem), '%')}</span></div>
        <div><span class="ad-k">Трафик ↓ / ↑</span><span class="ad-v">${rate(cur.traffic_in)} / ${rate(cur.traffic_out)}</span></div>
        <div><span class="ad-k">Обновлено</span><span class="ad-v">${cur.updated_at ? ago(cur.updated_at) : '—'}</span></div>
      </div>

      <h4>Клиенты за ${d.window ? d.window.hours : 24} ч</h4>
      ${sparkline(d.history || [])}

      <h4>История падений (за ${d.window ? d.window.outage_days : 30} дн.)</h4>
      ${outagesHtml(d.outages || [])}
    </section>`;
  }

  // --- DOM панели (создаём один раз) ---
  let el = null;
  function ensure() {
    if (el) return el;
    el = document.createElement('div');
    el.id = 'admin-panel';
    el.hidden = true;
    el.innerHTML = `<div class="ad-backdrop"></div>
      <aside class="ad-drawer" role="dialog" aria-label="Карточка точки (админ)">
        <header class="ad-head"><span class="ad-title"></span><button class="ad-close" aria-label="Закрыть">×</button></header>
        <div class="ad-body"></div>
      </aside>`;
    document.body.appendChild(el);
    el.querySelector('.ad-backdrop').addEventListener('click', close);
    el.querySelector('.ad-close').addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    return el;
  }
  function close() { if (el) el.hidden = true; }

  async function open(point) {
    ensure();
    el.hidden = false;
    el.querySelector('.ad-title').textContent = point.id;
    const body = el.querySelector('.ad-body');
    body.innerHTML = '<div class="ad-empty">Загрузка…</div>';

    // У двухдиапазонной точки бывает несколько кодов, но в Zabbix хост заведён не
    // на каждый код (61 код ↔ 41 хост). Код без хоста (404) просто пропускаем —
    // как и балун обычного пользователя; «нет данных» показываем, только если у
    // точки вообще нет ни одного хоста. Реальные ошибки (не 404) — показываем.
    const sections = [];
    for (const code of point.codes) {
      try {
        const res = await fetch(`/api/admin/point?code=${encodeURIComponent(code)}`, { headers: { Accept: 'application/json' } });
        if (res.status === 401) { location.href = '/login'; return; }
        if (res.status === 404) continue;
        if (!res.ok) throw new Error('HTTP ' + res.status);
        sections.push(radioSection(await res.json()));
      } catch (e) {
        sections.push(`<section class="ad-radio"><h3>${esc(code)}</h3><div class="ad-empty">Ошибка: ${esc(e.message)}</div></section>`);
      }
    }
    body.innerHTML = sections.join('') || '<div class="ad-empty">Нет данных по этой точке (нет AP-хостов с такими кодами).</div>';
  }

  window.AdminPanel = { open };
})();
