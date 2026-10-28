#!/bin/bash
set -euo pipefail
unset NODE_OPTIONS NODE_PATH || true
ore_root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
# BEGIN GENERATED MACOS HELPERS
ore_message() {
  case "$1:$ore_language" in
    heading:en) printf '%s' 'ORE';;
    heading:ru) printf '%s' 'ORE';;
    firstSetup:en) printf '%s' 'First-time setup may take a few minutes.';;
    firstSetup:ru) printf '%s' 'Первоначальная настройка может занять несколько минут.';;
    checkingUpdates:en) printf '%s' 'Checking for updates...';;
    checkingUpdates:ru) printf '%s' 'Проверка обновлений...';;
    downloadingVersion:en) printf '%s' 'Downloading new version...';;
    downloadingVersion:ru) printf '%s' 'Загрузка новой версии...';;
    downloadingToolkit:en) printf '%s' 'Downloading private toolkit...';;
    downloadingToolkit:ru) printf '%s' 'Загрузка встроенного набора инструментов...';;
    preparingVersion:en) printf '%s' 'Preparing new version...';;
    preparingVersion:ru) printf '%s' 'Подготовка новой версии...';;
    buildingVersion:en) printf '%s' 'Building new version...';;
    buildingVersion:ru) printf '%s' 'Сборка новой версии...';;
    checkingVersion:en) printf '%s' 'Checking new version...';;
    checkingVersion:ru) printf '%s' 'Проверка новой версии...';;
    activatingVersion:en) printf '%s' 'Activating new version...';;
    activatingVersion:ru) printf '%s' 'Активация новой версии...';;
    upToDate:en) printf '%s' 'ORE is up to date.';;
    upToDate:ru) printf '%s' 'Установлена актуальная версия ORE.';;
    starting:en) printf '%s' 'Starting ORE...';;
    starting:ru) printf '%s' 'Запуск ORE...';;
    openingBrowser:en) printf '%s' 'Opening your browser...';;
    openingBrowser:ru) printf '%s' 'Открытие браузера...';;
    stopping:en) printf '%s' 'Stopping ORE...';;
    stopping:ru) printf '%s' 'Завершение работы ORE...';;
    stopped:en) printf '%s' 'ORE stopped.';;
    stopped:ru) printf '%s' 'Работа ORE завершена.';;
    cancelled:en) printf '%s' 'Cancelled. Run the launcher again to retry.';;
    cancelled:ru) printf '%s' 'Отменено. Для повторной попытки запустите ORE-launcher ещё раз.';;
    ready:en) printf '%s' 'ORE is ready.';;
    ready:ru) printf '%s' 'ORE запущен.';;
    openUrl:en) printf '%s' 'Open: {url}';;
    openUrl:ru) printf '%s' 'Откройте: {url}';;
    keepWindow:en) printf '%s' 'Keep this window open while using ORE.';;
    keepWindow:ru) printf '%s' 'Не закрывайте это окно во время работы с ORE.';;
    stopHint:en) printf '%s' 'Press Ctrl+C to stop ORE.';;
    stopHint:ru) printf '%s' 'Чтобы завершить работу ORE, нажмите Ctrl+C.';;
    browserFailed:en) printf '%s' 'Your browser couldn'\''t be opened automatically.';;
    browserFailed:ru) printf '%s' 'Не удалось автоматически открыть браузер.';;
    logFile:en) printf '%s' 'Log file: {absolutePath}';;
    logFile:ru) printf '%s' 'Файл журнала: {absolutePath}';;
    assistance:en) printf '%s' 'For technical assistance, share this log file:';;
    assistance:ru) printf '%s' 'Для получения технической помощи отправьте этот файл журнала:';;
    checkFallback:en) printf '%s' 'Couldn'\''t check for updates. Starting the installed version.';;
    checkFallback:ru) printf '%s' 'Не удалось проверить обновления. Запускается установленная версия.';;
    updateFallback:en) printf '%s' 'Couldn'\''t finish the update. Starting the installed version.';;
    updateFallback:ru) printf '%s' 'Не удалось завершить обновление. Запускается установленная версия.';;
    updatesPaused:en) printf '%s' 'Updates are paused. Starting the installed version.';;
    updatesPaused:ru) printf '%s' 'Обновления приостановлены. Запускается установленная версия.';;
    downloadFailed:en) printf '%s' 'ORE couldn'\''t finish downloading. Check your internet connection and try again.';;
    downloadFailed:ru) printf '%s' 'Не удалось завершить загрузку ORE. Проверьте подключение к интернету и повторите попытку.';;
    verificationFailed:en) printf '%s' 'A downloaded file couldn'\''t be verified. Run the launcher again to retry.';;
    verificationFailed:ru) printf '%s' 'Не удалось проверить загруженный файл. Для повторной попытки запустите ORE-launcher ещё раз.';;
    buildFailed:en) printf '%s' 'ORE couldn'\''t build the application.';;
    buildFailed:ru) printf '%s' 'Не удалось собрать приложение ORE.';;
    activationFailed:en) printf '%s' 'ORE couldn'\''t activate the new version.';;
    activationFailed:ru) printf '%s' 'Не удалось активировать новую версию ORE.';;
    startupFailed:en) printf '%s' 'ORE couldn'\''t start.';;
    startupFailed:ru) printf '%s' 'Не удалось запустить ORE.';;
    folderCollision:en) printf '%s' 'The folder "{folder}" already exists and isn'\''t an ORE installation. Move the launcher to another folder and try again.';;
    folderCollision:ru) printf '%s' 'Папка "{folder}" уже существует и не является папкой установки ORE. Переместите ORE-launcher в другую папку и повторите попытку.';;
    notWritable:en) printf '%s' 'ORE can'\''t write to its installation folder. Check the folder'\''s permissions and try again.';;
    notWritable:ru) printf '%s' 'ORE не может записывать файлы в папку установки. Проверьте права доступа к папке и повторите попытку.';;
    unsupportedSystem:en) printf '%s' 'This operating system or processor isn'\''t supported.';;
    unsupportedSystem:ru) printf '%s' 'Эта операционная система или процессор не поддерживается.';;
    invalidEnv:en) printf '%s' 'There'\''s a problem in .env at line {line}.';;
    invalidEnv:ru) printf '%s' 'В файле .env обнаружена ошибка в строке {line}.';;
    installationLocked:en) printf '%s' 'ORE'\''s installation is locked. Another launcher may still be working. Check the log before retrying.';;
    installationLocked:ru) printf '%s' 'Установка ORE заблокирована. Возможно, другой экземпляр ORE-launcher ещё работает. Перед повторной попыткой проверьте журнал.';;
    alreadyRunning:en) printf '%s' 'ORE is already running.';;
    alreadyRunning:ru) printf '%s' 'ORE уже запущен.';;
    portConflict:en) printf '%s' 'ORE'\''s port is already in use. Check the log for details.';;
    portConflict:ru) printf '%s' 'Порт ORE уже занят. Подробности указаны в журнале.';;
    setupFailed:en) printf '%s' 'ORE couldn'\''t finish setting up.';;
    setupFailed:ru) printf '%s' 'Не удалось завершить настройку ORE.';;
    logFailed:en) printf '%s' 'ORE couldn'\''t create its log file. Check the installation folder'\''s permissions and try again.';;
    logFailed:ru) printf '%s' 'Не удалось создать файл журнала ORE. Проверьте права доступа к папке установки и повторите попытку.';;
    *) return 1;;
  esac
}
# Shared by generated entry points. Incomplete helpers may use recovery;
# unsafe paths and unknown protocols must fail closed instead.
ore_helper_status() {
  local tools="$1" root="$2" path="$1"
  while [ "$path" != "$root" ]; do
    [ ! -L "$path" ] || return 2
    case "$path" in "$root"/*) path=$(dirname -- "$path");; *) return 2;; esac
  done
  [ ! -L "$root" ] && [ ! -L "$tools/macos-launcher-protocol" ] && [ ! -L "$tools/macos-launcher.sh" ] || return 2
  [ -f "$tools/macos-launcher-protocol" ] && [ -r "$tools/macos-launcher-protocol" ] || return 1
  [ "$(cat "$tools/macos-launcher-protocol" 2>/dev/null)" = 1 ] || return 3
  [ -f "$tools/macos-launcher.sh" ] && [ -r "$tools/macos-launcher.sh" ] && [ -s "$tools/macos-launcher.sh" ] || return 1
  /bin/bash -n "$tools/macos-launcher.sh" 2>/dev/null || return 1
}
# END GENERATED MACOS HELPERS
if [ -e "$ore_root/.ore-installation" ] || [ -L "$ore_root/.ore-installation" ]; then
  ore_language=$(defaults export NSGlobalDomain - 2>/dev/null | plutil -extract AppleLanguages.0 raw -expect string -o - - 2>/dev/null) || ore_language=en
  if [[ "$ore_language" =~ ^ru([-_][a-zA-Z0-9]{2,8})*$ ]]; then ore_language=ru; else ore_language=en; fi
  ore_internal_fail() {
    local value
    value=$(ore_message "$1")
    value=${value//\{folder\}/ORE-internal}
    printf '%s\n' "$value"
    exit 1
  }
  [ ! -L "$ore_root/.ore-installation" ] || ore_internal_fail folderCollision
  for ore_pointer in current recovery/current; do
    [ ! -L "$ore_root/$ore_pointer" ] || ore_internal_fail setupFailed
    [ -f "$ore_root/$ore_pointer" ] && [ -r "$ore_root/$ore_pointer" ] || continue
    ore_release=$(sed -n '1p' "$ore_root/$ore_pointer" 2>/dev/null) || continue
    [[ "$ore_release" =~ ^(release|dev)-[a-z0-9-]+$ ]] || ore_internal_fail setupFailed
    if [ "$ore_pointer" = current ]; then ore_tools="$ore_root/app/$ore_release/scripts/release";
    else ore_tools="$ore_root/recovery/$ore_release"; fi
    ore_helper_result=0
    ore_helper_status "$ore_tools" "$ore_root" || ore_helper_result=$?
    case "$ore_helper_result" in
      0) exec /bin/bash "$ore_tools/macos-launcher.sh" "$ore_root" "$(pwd -P)" "$ore_language";;
      2) ore_internal_fail folderCollision;;
      3) ore_internal_fail setupFailed;;
    esac
  done
  ore_internal_fail setupFailed
fi
[ -f "$ore_root/current" ] || { echo 'ORE has no installed application. Use the source launcher to install it.' >&2; exit 1; }
ore_release=$(sed -n '1p' "$ore_root/current")
case "$ore_release" in ''|.|..|*[!a-zA-Z0-9._-]*) echo 'Invalid ORE current release pointer.' >&2; exit 1;; esac
ore_application="$ore_root/app/$ore_release"
if [ -f "$ore_application/scripts/release/load-env.sh" ]; then
  . "$ore_application/scripts/release/load-env.sh"
  ore_load_env "$ore_root/.env"
  unset NODE_OPTIONS NODE_PATH || true
fi
if [ -f "$ore_application/scripts/release/update-and-start.sh" ] && [ -f "$ore_application/scripts/release/launcher-protocol" ] && [ "$(cat "$ore_application/scripts/release/launcher-protocol")" = 2 ]; then
  exec /bin/bash "$ore_application/scripts/release/update-and-start.sh" "$ore_root"
fi
if [ -f "$ore_root/recovery/current" ]; then
  ore_tool=$(sed -n '1p' "$ore_root/recovery/current")
  case "$ore_tool" in ''|.|..|*[!a-zA-Z0-9._-]*) echo 'Invalid recovery toolkit pointer.' >&2; exit 1;; esac
  exec /bin/bash "$ore_root/recovery/$ore_tool/update-and-start.sh" "$ore_root"
fi
# The root launcher may be replaced before the atomic pointer switch. Retain
# compatibility with the previous release if activation is interrupted there.
echo 'Launcher update was not activated. Starting the previous application; use the source launcher to finish updating.' >&2
ore_runtime=$(sed -n '2p' "$ore_root/current")
case "$ore_runtime" in node-v[0-9]*-darwin-arm64|node-v[0-9]*-darwin-x64|node-v[0-9]*-linux-arm64|node-v[0-9]*-linux-x64) ;; *) echo 'Invalid ORE runtime pointer.' >&2; exit 1;; esac
case "$ore_runtime" in *[!a-zA-Z0-9._-]*) echo 'Invalid ORE runtime pointer.' >&2; exit 1;; esac
exec "$ore_root/runtime/$ore_runtime/bin/node" "$ore_application/scripts/release/portable-launch.mjs" "$ore_root"
