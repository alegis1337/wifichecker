# Обёртка для Планировщика задач: долгоживущий веб-сервер карты.
# Ставится на запуск «при старте системы». Перезапуск при падении настраивается
# в самой задаче (см. deploy/README.md).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
& node --disable-warning=ExperimentalWarning server/app.js
exit $LASTEXITCODE
