# Развёртывание на внутренней машине (Windows, одна VM)

Коллектор и веб-карта живут на **одной** машине рядом с источником правды
(`state/monitor.db`). Коллектор ходит в Zabbix и пишет БД; веб-сервер читает ту
же БД (read-only, WAL) и отдаёт заказчику отфильтрованный статус под логином.

```
Zabbix (внутренняя сеть)
  └─ Планировщик задач, раз в 5 мин ─▶ коллектор (src/index.js) ─▶ state/monitor.db
                                                                        │ (read-only)
                                          веб-сервер (server/app.js) ◀──┘
                                                  │ логин + /api/status
                                          браузер заказчика (Яндекс «Гибрид»)
```

## 1. Подготовка

1. Установить Node.js ≥ 22.5 (на машине стоит v24 — ок).
2. В корне репозитория: `npm install` (ставит `nodemailer`; SQLite встроен).
3. Скопировать `.env.example` → `.env`, заполнить `ZABBIX_*`, при наличии
   `SMTP_*`, и `YANDEX_API_KEY` (ключ ограничить по домену-referer в кабинете Яндекса).
4. Сгенерировать координаты точек: `npm run build-points` (из `geo.txt`).
5. Создать учётку заказчику: `npm run add-user -- <логин> <пароль> viewer`
   (роль `admin` — на будущее; пароль из аргументов виден в истории shell — для
   боевой учётки потом смените и почистите историю).

> На этой VM обе задачи **уже зарегистрированы** (v0.5) под учёткой `SYSTEM` —
> работают независимо от того, залогинен ли кто-то. Команды ниже — для
> воспроизведения/переустановки. Запускать из PowerShell **от администратора**.
> `node` должен быть в системном PATH (`C:\Program Files\nodejs` — ок для SYSTEM).

## 2. Коллектор по расписанию (раз в 5 минут)

```powershell
$repo = 'C:\Users\<your_user>\Desktop\rinok'   # путь к репозиторию на этой машине
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$repo\deploy\run-collector.ps1`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date)
# Бесконечная повторяемость каждые 5 мин (через .Repetition — иначе ограничится сутками):
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)).Repetition
$set = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 4)
Register-ScheduledTask -TaskName 'RinokCollector' -Action $action -Trigger $trigger `
  -Principal $principal -Settings $set -Description 'Сбор статуса Wi-Fi точек рынка из Zabbix' -Force
Start-ScheduledTask -TaskName 'RinokCollector'   # выполнить сразу
```

Интервал сбора и порог «устаревания» связаны: `WEB_STALE_AFTER_SEC` в `.env`
должен быть больше интервала (иначе баннер «данные устарели» будет моргать между
прогонами). При 5-мин коллекторе нормально 420–660 c (7–11 мин). Чтобы порог был
меньше — уменьшить и интервал (`-Minutes` в триггере).

## 3. Веб-сервер (постоянно, старт при загрузке)

```powershell
$repo = 'C:\Users\<your_user>\Desktop\rinok'   # путь к репозиторию на этой машине
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$repo\deploy\run-web.ps1`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$set = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'RinokWeb' -Action $action -Trigger $trigger `
  -Principal $principal -Settings $set -Description 'Веб-карта Wi-Fi точек рынка' -Force
Start-ScheduledTask -TaskName 'RinokWeb'   # запустить сейчас, не дожидаясь перезагрузки
```

Управление: `Get-ScheduledTaskInfo RinokCollector` (последний результат/запуск),
`Stop-ScheduledTask RinokWeb` / `Start-ScheduledTask RinokWeb`,
`Unregister-ScheduledTask RinokWeb -Confirm:$false` (удалить).

Проверка: открыть `http://<ip-машины>:8080/` в браузере (или телефоне в той же
сети) → форма логина → после входа карта «Гибрид» с маркерами.

## 4. Домен и HTTPS (когда дадут)

Сейчас сервер слушает HTTP на `WEB_PORT`. Для публикации под доменом:

1. Поставить обратный прокси с авто-HTTPS (Caddy под Windows — самый простой;
   `caddy reverse-proxy --from example.ru --to 127.0.0.1:8080`, либо Caddyfile).
2. В `.env` выставить `WEB_SECURE_COOKIE=true` (cookie только по HTTPS) и при
   желании `WEB_HOST=127.0.0.1` (наружу смотрит только прокси).
3. В кабинете Яндекса добавить домен в список разрешённых для JS API ключа.

## Управление учётками

```powershell
npm run add-user -- <логин> <пароль> [viewer|admin]   # создать/сменить пароль
npm run add-user -- --list                            # список
npm run add-user -- --delete <логин>                  # удалить
```

## Почта (SMTP, оповещение хелпдеска)

- Креды SMTP — в `.env` (`SMTP_HOST/PORT/SECURE/USER/PASS/FROM`). Для домена на
  Яндекс 360: `smtp.yandex.ru:465`, `SMTP_SECURE=true`, логин = полный адрес,
  пароль — **пароль приложения** Яндекса (не основной пароль аккаунта).
- `HELPDESK_TO` — адрес для писем о падении/восстановлении точек. `SMTP_TO`
  оставляем пустым: тогда шлётся только дедуплицированный канал падений точек
  (1 проблема = 1 письмо), а канал всех Zabbix-проблем не дублирует хелпдеск.
- Проверка: `npm run test-email` (шлёт тест на `SMTP_TO` или, если он пуст, на
  `HELPDESK_TO`).
- Изменения в `.env`/`src/` подхватываются коллектором автоматически (он
  стартует заново каждые 5 мин). Перезапуск нужен только веб-серверу (`RinokWeb`).
- На этой VM активен VPN-туннель со своим DNS; коллектор резолвит SMTP-хост
  системным `getaddrinfo` и коннектится по IP с TLS `servername` (иначе c-ares
  внутри nodemailer падает `queryA ETIMEOUT`). Это уже в коде, действий не требует.

## Заметки

- Сессии хранятся в `state/web.db` и переживают перезапуск сервера; подписи
  cookie секретом не требуется (id сессии — случайные 32 байта).
- `monitor.db` открыт коллектором в режиме WAL — веб читает его параллельно
  без блокировок. Веб-сервер в источник правды не пишет.
- Логи: `logs/YYYY-MM-DD.log` (коллектор), `logs/web-YYYY-MM-DD.log` (сервер).
