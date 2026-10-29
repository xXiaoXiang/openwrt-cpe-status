import { createHash } from 'node:crypto'

export const defaultStatusConfig = JSON.stringify({ device: '/dev/ttyUSB2', networkInterface: 'wwan', autoApn: true, smsStorage: '/etc/cpe-status/sms' }, null, 2)
export const statusHelperNames = [
  'snapshot', 'speed', 'speed-settings', 'messaging', 'apn', 'apn-database', 'wwan', 'sms-poll',
  'qos', 'qos-watch', 'qos-read', 'euicc-read', 'euicc-control', 'lpac-run', 'lpac-test',
  'esim-apdu-bridge', 'service-status', 'service-control', 'roaming', 'control', 'control-result',
  'bands', 'cell-locks', 'scan-at', 'scan-result', 'operators', 'operator-at',
]

// Backups stay in the persistent directory. Failed/interrupted upgrades can retry.
const migrationCommon = String.raw`
set -eu
umask 077
root="__ENV__{IPKG_INSTROOT:-}"
data="$root/etc/cpe-status"
legacy="$root/etc/cpe-status.json"
staged="$data/.config-migration.json"
mkdir -p "$data"
chmod 700 "$data"
archive_legacy() {
  mkdir -p "$data/legacy"
  chmod 700 "$data/legacy"
  archive="$data/legacy/$(basename "$1")"
  if [ -e "$archive" ] && ! cmp -s "$1" "$archive"; then
    archive=$(mktemp "$archive.XXXXXX")
    cp -p "$1" "$archive"
  elif [ ! -e "$archive" ]; then
    cp -p "$1" "$archive"
  fi
  cmp -s "$1" "$archive"
  chmod 600 "$archive"
}
`.replaceAll('__ENV__', '$')

// Stage before APK removes the old package-owned config. The new config is
// installed by APK first, then replaced with this preserved user configuration.
export const pathMigrationPrepare = migrationCommon + String.raw`
if [ -f "$legacy" ]; then
  archive_legacy "$legacy"
  if [ ! -e "$data/config.json" ] && [ ! -e "$staged" ]; then
    cp -p "$legacy" "$staged.tmp"
    chmod 600 "$staged.tmp"
    mv "$staged.tmp" "$staged"
  fi
fi
if [ -z "$root" ] && [ -x /etc/init.d/cpe-status ]; then
  /etc/init.d/cpe-status stop || true
fi
`

const defaultHash = createHash('sha256').update(defaultStatusConfig).digest('hex')
export const pathMigration = '#!/bin/sh\n' + migrationCommon + String.raw`
is_default() {
  [ -f "$data/config.json" ] || return 0
  [ "$(sha256sum "$data/config.json" | cut -d ' ' -f 1)" = '__DEFAULT_HASH__' ]
}
if [ -f "$staged" ]; then
  if is_default; then
    mv "$staged" "$data/config.json"
  else
    # A newer custom destination wins, but retain the staged source as a backup.
    archive_legacy "$staged"
    rm -f "$staged"
  fi
elif [ -f "$legacy" ] && is_default; then
  cp -p "$legacy" "$data/config.json.tmp"
  mv "$data/config.json.tmp" "$data/config.json"
fi
if [ -f "$data/config.json" ]; then chmod 600 "$data/config.json"; fi
for previous in "$legacy" "$legacy.apk-new" "$legacy.apk-save"; do
  if [ -f "$previous" ]; then
    archive_legacy "$previous"
    rm -f "$previous"
  fi
done
# Exact package-owned names only; unrelated libexec programs are untouched.
for name in __HELPER_NAMES__; do
  rm -f "$root/usr/libexec/cpe-status-$name"
done
rm -f "$root/usr/share/cpe-status/qos-collector.pl"
`.replace('__DEFAULT_HASH__', defaultHash).replace('__HELPER_NAMES__', statusHelperNames.join(' '))
