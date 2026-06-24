// Карта доступности Wi-Fi точек рынка. Загружает Yandex Maps JS API 2.1
// («Гибрид» — спутник + подписи), расставляет маркеры по public/points.json,
// красит их по статусу из /api/status (поллинг). Карточка точки — в балуне.

const POLL_MS = 30_000;
const state = {
  map: null,
  points: [],            // из points.json: {id, codes[], lat, lon}
  placemarks: new Map(), // id точки → ymaps.Placemark
  byCode: new Map(),     // code(lower) → запись хоста из /api/status
};

function statusLabel(s) {
  return { up: 'работает', down: 'не отвечает', unknown: 'нет данных', partial: 'частично' }[s] || s;
}

// Цвет точки по статусам её радио-кодов (двухдиапазонная AP = несколько кодов).
function aggregateStatus(codes) {
  const st = codes.map((c) => state.byCode.get(c.toLowerCase())?.status ?? 'unknown');
  const known = st.filter((s) => s !== 'unknown');
  if (!known.length) return 'unknown';
  const ups = known.filter((s) => s === 'up').length;
  const downs = known.filter((s) => s === 'down').length;
  if (downs && ups) return 'partial';
  if (downs) return 'down';
  return 'up';
}

const PRESET = {
  up: 'islands#greenDotIcon',
  down: 'islands#redDotIcon',
  unknown: 'islands#grayDotIcon',
  partial: 'islands#orangeDotIcon',
};

function fmtRate(bps) {
  if (bps === null || bps === undefined) return '—';
  const u = ['бит/с', 'Кбит/с', 'Мбит/с', 'Гбит/с'];
  let v = bps, i = 0;
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

function fmtNum(v, suffix = '') {
  return v === null || v === undefined ? '—' : `${v}${suffix}`;
}

function fmtAge(sec) {
  if (sec === null || sec === undefined) return 'нет данных';
  if (sec < 90) return `${sec} с назад`;
  const m = Math.round(sec / 60);
  if (m < 90) return `${m} мин назад`;
  return `${Math.round(m / 60)} ч назад`;
}

function balloonHtml(point) {
  // Двухдиапазонные точки: в Zabbix обычно один хост на физическую AP (его код —
  // первый из пары). Показываем только коды, у которых есть хост; если хоста нет
  // ни у одного — одна строка «нет данных» (а не фантом на каждый код).
  const hosts = point.codes
    .map((code) => state.byCode.get(code.toLowerCase()))
    .filter(Boolean);
  let rows;
  if (!hosts.length) {
    rows = `<div class="radio"><div class="name"><span class="badge unknown">нет данных</span> ${escapeHtml(point.id)}</div></div>`;
  } else {
    rows = hosts.map((h) => {
      const probs = (h.problems || [])
        .map((p) => `<div class="prob">⚠ ${escapeHtml(p.name)}</div>`)
        .join('');
      return `<div class="radio">
        <div class="name"><span class="badge ${h.status}">${statusLabel(h.status)}</span> ${escapeHtml(h.name || h.code)}</div>
        <div class="metrics">
          <span>Клиенты: <b>${fmtNum(h.clients)}</b></span>
          <span>Темп.: <b>${fmtNum(h.temp, ' °C')}</b></span>
          <span>↓ <b>${fmtRate(h.traffic_in)}</b></span>
          <span>↑ <b>${fmtRate(h.traffic_out)}</b></span>
          <span>CPU: <b>${fmtNum(h.cpu, '%')}</b></span>
          <span>RAM: <b>${fmtNum(h.mem, '%')}</b></span>
        </div>
        ${probs}
      </div>`;
    }).join('');
  }
  const row = point.codes[0] && state.byCode.get(point.codes[0].toLowerCase())?.row;
  return `<div class="card">
    <h3>${escapeHtml(point.id)}</h3>
    <div class="row">${row ? 'Ряд ' + escapeHtml(row) : 'Точка доступа'}</div>
    ${rows}
  </div>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function refreshMarkers() {
  let up = 0, down = 0, unknown = 0;
  for (const point of state.points) {
    const status = aggregateStatus(point.codes);
    if (status === 'up') up++;
    else if (status === 'down' || status === 'partial') down++;
    else unknown++;
    const pm = state.placemarks.get(point.id);
    if (!pm) continue;
    pm.options.set('preset', PRESET[status]);
    pm.properties.set({
      balloonContent: balloonHtml(point),
      hintContent: `${point.id} — ${statusLabel(status)}`,
    });
  }
  document.getElementById('cnt-up').textContent = up;
  document.getElementById('cnt-down').textContent = down;
  document.getElementById('cnt-unknown').textContent = unknown;
}

async function poll() {
  try {
    const res = await fetch('/api/status', { headers: { Accept: 'application/json' } });
    if (res.status === 401) { location.href = '/login'; return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    state.byCode.clear();
    for (const h of data.points) {
      if (h.code) state.byCode.set(h.code.toLowerCase(), h);
    }
    refreshMarkers();
    const el = document.getElementById('updated');
    const age = fmtAge(data.data_age_sec);
    el.innerHTML = data.stale
      ? `<span class="stale">Данные устарели (${age})</span>`
      : `Обновлено: ${age}`;
  } catch (e) {
    document.getElementById('updated').textContent = 'ошибка обновления';
    console.error('poll:', e);
  }
}

function initMap() {
  // Центр — средняя точка по координатам; если точек нет, берём дефолт из конфига
  // (координаты объекта приходят с сервера, в коде не зашиты).
  const cfg = window.APP_CONFIG || {};
  let center = Array.isArray(cfg.mapCenter) ? cfg.mapCenter : [55.751, 37.618];
  if (state.points.length) {
    const la = state.points.reduce((s, p) => s + p.lat, 0) / state.points.length;
    const lo = state.points.reduce((s, p) => s + p.lon, 0) / state.points.length;
    center = [la, lo];
  }
  state.map = new ymaps.Map('map', {
    center,
    zoom: cfg.mapZoom || 17,
    type: 'yandex#hybrid',
    controls: ['zoomControl', 'fullscreenControl', 'typeSelector', 'geolocationControl'],
  });

  for (const point of state.points) {
    const pm = new ymaps.Placemark(
      [point.lat, point.lon],
      { hintContent: point.id },
      { preset: PRESET.unknown, balloonCloseButton: true },
    );
    state.placemarks.set(point.id, pm);
    state.map.geoObjects.add(pm);
  }
}

function loadYandex(apiKey) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://api-maps.yandex.ru/2.1/?apikey=${encodeURIComponent(apiKey)}&lang=ru_RU`;
    s.onload = () => ymaps.ready(resolve);
    s.onerror = () => reject(new Error('не удалось загрузить Yandex Maps'));
    document.head.appendChild(s);
  });
}

function applySiteName() {
  const name = (window.APP_CONFIG && window.APP_CONFIG.siteName) || 'Мониторинг Wi-Fi';
  document.title = `${name} — Wi-Fi`;
  const titleEl = document.querySelector('.topbar .title');
  if (titleEl) titleEl.textContent = `${name} — Wi-Fi`;
}

async function main() {
  applySiteName();
  const key = (window.APP_CONFIG && window.APP_CONFIG.yandexApiKey) || '';
  if (!key) {
    document.getElementById('map').innerHTML =
      '<div style="padding:24px;color:#93a1ad">YANDEX_API_KEY не задан в .env — карта недоступна.</div>';
    return;
  }
  try {
    const [pts] = await Promise.all([
      fetch('/points.json').then((r) => r.json()),
      loadYandex(key),
    ]);
    state.points = pts;
    initMap();
    await poll();
    setInterval(poll, POLL_MS);
  } catch (e) {
    console.error(e);
    document.getElementById('map').innerHTML =
      `<div style="padding:24px;color:#e5534b">Ошибка инициализации карты: ${escapeHtml(e.message)}</div>`;
  }
}

main();
