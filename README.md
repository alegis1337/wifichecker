# wifi-monitor

Мониторинг доступности Wi-Fi точек доступа через **Zabbix API** (JSON-RPC) +
**веб-карта** с логином. Один продукт на одной машине: коллектор (статус,
метрики, проблемы → SQLite, email-оповещения о новых поломках) и веб-сервер,
который рисует точки на Яндекс-спутнике («Гибрид») и красит их по статусу.

Привязка к конкретному объекту (имя, координаты, префикс кодов точек) вынесена
в `.env` — в коде её нет.

## Стек

- Node.js ≥ 22.5 (нужен встроенный `node:sqlite`), ES modules.
- Единственная npm-зависимость — `nodemailer`. Остальное встроенное:
  `node:sqlite` (БД), `node:http` (веб-сервер), `node:crypto` (scrypt-пароли).
- Фронт без сборки: Яндекс Карты JS API 2.1.
- Конфиг/токен/SMTP/ключ Яндекса — в `.env` (не в гите).

## Установка

```powershell
Copy-Item .env.example .env   # ZABBIX_* (обяз.); SMTP_*, YANDEX_API_KEY, WEB_*, SITE_NAME — по нужде
npm install                   # ставит nodemailer
Copy-Item geo.txt.example geo.txt   # вписать координаты своих точек
npm run build-points          # geo.txt → public/points.json
npm run add-user -- <логин> <пароль> viewer   # учётка для входа на карту
```

## Конфигурация (`.env`)

| Переменная | Назначение |
|---|---|
| `ZABBIX_URL` / `ZABBIX_TOKEN` / `ZABBIX_GROUP_ID` | подключение к Zabbix (обяз.) |
| `HOST_CODE_PREFIX` | префикс кода точки в имени хоста Zabbix (отличает AP от свитчей) |
| `SITE_NAME` | имя объекта: тема писем + заголовок карты |
| `MAP_CENTER_LAT` / `MAP_CENTER_LON` / `MAP_ZOOM` | центр карты по умолчанию |
| `YANDEX_API_KEY` | ключ Yandex Maps JS API (ограничьте по домену-referer!) |
| `WEB_HOST` / `WEB_PORT` / `WEB_SESSION_TTL_HOURS` / `WEB_SECURE_COOKIE` | веб-сервер |
| `SMTP_*` | email-нотификатор (опционально; без него письма не шлются) |

Полный список с комментариями — в [.env.example](.env.example).

## Запуск

**Коллектор** (по расписанию):

| Команда | Что делает |
|---|---|
| `npm start` | Обычный прогон: collect → SQLite → diff → notify |
| `npm run once` | Диагностика: collect → diff, **без** записи БД и оповещений |
| `npm run debug` | Обычный прогон с расширенными (`DEBUG`) логами |
| `npm run test-email` | Тестовое письмо (нужен SMTP) и выход |

**Веб-карта** (постоянный процесс):

| Команда | Что делает |
|---|---|
| `npm run web` | Веб-сервер карты на `WEB_HOST:WEB_PORT` (по умолчанию `0.0.0.0:8080`) |
| `npm run build-points` | Пересобрать `public/points.json` из `geo.txt` |
| `npm run add-user -- …` | Управление учётками |

Напрямую: `node --disable-warning=ExperimentalWarning src/index.js [--once|--debug|--test]`
или `… server/app.js`. Флаг `--disable-warning` гасит ExperimentalWarning от `node:sqlite`.

Exit code коллектора: `0` — успех, `1` — фатальная ошибка.

## Безопасность

- Веб наружу отдаёт **только** отфильтрованный статус (`/api/status`): код, имя,
  ряд, статус, метрики, проблемы. Внутренние поля (`ip`, `hostid`) не выходят.
- Веб-сервер **не** обращается к Zabbix и не читает `ZABBIX_*` — из интернета
  пути к Zabbix нет. `monitor.db` открывается только на чтение.
- Пароли — scrypt-хеши в `state/web.db`; сессии — случайные id в cookie
  (`HttpOnly`, `SameSite=Lax`). Все SQL-запросы параметризованы.
- Перед публикацией наружу: HTTPS + `WEB_SECURE_COOKIE=true`, ключ Яндекса
  ограничить по домену, развернуть за обратным прокси.

## Структура

```
src/        коллектор: config, logger, zabbix-client, collector, metrics, db, detector, notifier, index
server/     веб-карта: config, logger, db (web.db), auth, status, app, add-user
public/     фронт без сборки: index.html, map.js, styles.css, login.html (+ points.json — генерится)
tools/      build-points.js (geo.txt → points.json)
deploy/     run-collector.ps1, run-web.ps1, README.md (Планировщик задач, домен)
state/      monitor.db (источник правды) + web.db (gitignored)
logs/       YYYY-MM-DD.log, web-YYYY-MM-DD.log (gitignored)
.env(.example), geo.txt(.example)
```
