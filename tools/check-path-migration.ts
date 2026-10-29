// Real BusyBox shell, isolated fake root. Never calls the live init service.
import { execFileSync } from 'node:child_process'
import { pathMigration, pathMigrationPrepare, defaultStatusConfig, statusHelperNames } from '../openwrt/path-migration.ts'

const root = '/tmp/cpe-path-migration-' + Date.now()
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const old = '{"device":"/dev/ttyUSB3","autoApn":false,"smsStorage":"/mnt/sms","custom":"preserve"}'
const current = '{"device":"/dev/ttyUSB4","autoApn":false,"custom":"newer"}'
const script = [
  'set -eu', `test_root=${root}`, 'trap \'rm -rf "$test_root"\' EXIT', `mkdir -p ${root}`,
  `cat >${root}/prepare <<'CPE_MIGRATION_EOF'\n${pathMigrationPrepare}\nCPE_MIGRATION_EOF`,
  `cat >${root}/migrate <<'CPE_MIGRATION_EOF'\n${pathMigration}\nCPE_MIGRATION_EOF`,
  `printf '%s' ${quote(old)} >${root}/expected-old`, `printf '%s' ${quote(current)} >${root}/expected-current`,
  `printf '%s' ${quote(defaultStatusConfig)} >${root}/default`,
  String.raw`
checks=0
check() { "$@" || { echo "Migration check failed: $*" >&2; exit 1; }; checks=$((checks+1)); }
prepare() { IPKG_INSTROOT="$case_root" sh "$test_root/prepare"; }
migrate() { IPKG_INSTROOT="$case_root" sh "$test_root/migrate"; }
case_root="$test_root/upgrade"
mkdir -p "$case_root/etc/cpe-status/sms" "$case_root/etc/cpe-status/modem.d" "$case_root/usr/libexec/cpe-status" "$case_root/usr/share/cpe-status"
cp "$test_root/expected-old" "$case_root/etc/cpe-status.json"
for file in apns.local.json apn-overrides.json apn-database.json apn-database.json.managed euicc.json wwan-original.json modem.d/2c7c0800.conf sms/history.json; do
  printf '%s' "$file USER DATA" >"$case_root/etc/cpe-status/$file"
done
for name in __HELPERS__; do printf '%s' legacy >"$case_root/usr/libexec/cpe-status-$name"; done
printf '%s' unrelated >"$case_root/usr/libexec/cpe-status-unrelated"
printf '%s' old >"$case_root/usr/share/cpe-status/qos-collector.pl"
printf '%s' new >"$case_root/usr/libexec/cpe-status/qos-collector.pl"
prepare
check cmp -s "$test_root/expected-old" "$case_root/etc/cpe-status/.config-migration.json"
# Simulate APK removing the old file and extracting the package's new default.
rm "$case_root/etc/cpe-status.json"
cp "$test_root/default" "$case_root/etc/cpe-status/config.json"
migrate
check cmp -s "$test_root/expected-old" "$case_root/etc/cpe-status/config.json"
check cmp -s "$test_root/expected-old" "$case_root/etc/cpe-status/legacy/cpe-status.json"
check test "$(ls -l "$case_root/etc/cpe-status/config.json" | cut -d ' ' -f 1)" = -rw-------
check test ! -e "$case_root/etc/cpe-status/.config-migration.json"
for file in apns.local.json apn-overrides.json apn-database.json apn-database.json.managed euicc.json wwan-original.json modem.d/2c7c0800.conf sms/history.json; do
  check test "$(cat "$case_root/etc/cpe-status/$file")" = "$file USER DATA"
done
for name in __HELPERS__; do check test ! -e "$case_root/usr/libexec/cpe-status-$name"; done
check test -f "$case_root/usr/libexec/cpe-status-unrelated"
check test -f "$case_root/usr/libexec/cpe-status/qos-collector.pl"
check test ! -e "$case_root/usr/share/cpe-status/qos-collector.pl"
migrate
check cmp -s "$test_root/expected-old" "$case_root/etc/cpe-status/config.json"
# Both locations exist: preserve a newer custom destination and archive old.
cp "$test_root/expected-current" "$case_root/etc/cpe-status/config.json"
cp "$test_root/expected-old" "$case_root/etc/cpe-status.json"
prepare
migrate
check cmp -s "$test_root/expected-current" "$case_root/etc/cpe-status/config.json"
check test ! -e "$case_root/etc/cpe-status.json"
# A custom edit between failed extraction and retry wins over staged data.
cp "$test_root/expected-old" "$case_root/etc/cpe-status/.config-migration.json"
migrate
check cmp -s "$test_root/expected-current" "$case_root/etc/cpe-status/config.json"
check cmp -s "$test_root/expected-old" "$case_root/etc/cpe-status/legacy/.config-migration.json"
cp "$test_root/expected-current" "$case_root/etc/cpe-status.json.apk-save"
migrate
check cmp -s "$test_root/expected-current" "$case_root/etc/cpe-status/legacy/cpe-status.json.apk-save"
check cmp -s "$test_root/expected-old" "$case_root/etc/cpe-status/legacy/cpe-status.json"
case_root="$test_root/fresh"
mkdir -p "$case_root/etc/cpe-status"
cp "$test_root/default" "$case_root/etc/cpe-status/config.json"
prepare
migrate
check cmp -s "$test_root/default" "$case_root/etc/cpe-status/config.json"
printf '{"passed":%s,"config_migrated":true,"custom_files_preserved":true,"obsolete_helpers_removed":true,"idempotent":true,"no_live_service_calls":true}\n' "$checks"
`.replaceAll('__HELPERS__', statusHelperNames.join(' ')),
].join('\n') + '\n'
console.log(execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts', process.env.CPE_ROUTER || 'root@192.168.6.248', 'sh -s'], { input: script, encoding: 'utf8', windowsHide: true, timeout: 30_000 }))
