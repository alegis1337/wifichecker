# Обёртка для Планировщика задач: один прогон коллектора (collect → SQLite →
# diff → notify). Ставится на расписание каждые ~5 минут.
# Рабочая папка — корень репозитория (на два уровня выше этого файла).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
& node --disable-warning=ExperimentalWarning src/index.js
exit $LASTEXITCODE
