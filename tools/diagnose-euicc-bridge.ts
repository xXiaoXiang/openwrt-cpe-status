// Read-only process and lock diagnosis; never submits an eUICC write.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { euiccBridge, euiccBridgeRunner, euiccBridgeCli, euiccRspRootCa } from '../openwrt/euicc-bridge.ts'
import { euiccRead, euiccControl } from '../openwrt/euicc.ts'

let script = String.raw`
ls -ld /tmp/cpe-status/lock /tmp/cpe-status/lpac-bridge.* 2>/dev/null || true
cat /tmp/cpe-status/lock/pid 2>/dev/null || true
owner=$(cat /tmp/cpe-status/lock/pid 2>/dev/null)
[ -z "$owner" ] || { printf '\nLock owner: '; tr '\0' ' ' < /proc/$owner/cmdline; printf '\n'; }
ps w | grep -E 'lpac|esim|sh -s' | grep -v grep || true
for p in /proc/[0-9]*; do
  line=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null) || continue
  case "$line" in
    *lpac*|*cpe-status/esim*|*invalid-stdio*|*stdio-test*) printf '%s %s\n' "$p" "$line"; cat "$p/stat";;
  esac
done
`
if (process.argv.includes('--clear-stale-lock')) script += String.raw`
owner=$(cat /tmp/cpe-status/lock/pid 2>/dev/null)
case "$owner" in ''|*[!0-9]*) exit 1;; esac
test "$(tr '\0' ' ' < /proc/$owner/cmdline)" = '-ash ' || exit 1
if ps w | grep -E '[/]usr/lib/lpac/lpac|[{]cpe-status-lpac|[{]cpe-status-esim|[/]usr/libexec/cpe-status/(lpac|esim)' >/dev/null; then
  echo 'LPAC remains active; lock retained'; exit 1
fi
test "$(cat /tmp/cpe-status/lock/pid)" = "$owner" || exit 1
rm /tmp/cpe-status/lock/pid
rmdir /tmp/cpe-status/lock
echo 'STALE_CLI_LOCK_REMOVED'
`
if (process.argv.includes('--verify-installed')) {
  script += 'set -eu\n'
  for (const [path, contents] of Object.entries({ '/usr/libexec/cpe-status/lpac-run': euiccBridgeRunner, '/usr/libexec/cpe-status/esim-apdu-bridge': euiccBridge, '/usr/libexec/cpe-status/lpac-test': euiccBridgeCli, '/usr/share/cpe-status/certs/gsma-ci.pem': euiccRspRootCa, '/usr/libexec/cpe-status/euicc-read': euiccRead, '/usr/libexec/cpe-status/euicc-control': euiccControl })) {
    script += `echo '${createHash('sha256').update(contents).digest('hex')}  ${path}' | sha256sum -c -\n`
  }
  script += String.raw`
rc=0
/usr/libexec/cpe-status/lpac-test download >/dev/null 2>&1 || rc=$?
test "$rc" = 64
out=$(mktemp /tmp/cpe-status/cli-readonly.XXXXXX)
trap 'rm -f "$out"' EXIT
/usr/libexec/cpe-status/lpac-test profile list > "$out"
grep -q '"message":"success"' "$out"
if grep -q '输出日志：' "$out"; then exit 1; fi
/usr/libexec/cpe-status/lpac-test --log "$out.log" profile list > "$out"
test ! -s "$out"
grep -q '"message":"success"' "$out.log"
rm "$out.log"
/usr/libexec/cpe-status/euicc-read activity
echo 'INSTALLED_CLI_READ_ONLY_PROFILE_LIST_OK'
`
}
console.log(execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts', process.env.CPE_ROUTER || 'root@192.168.6.248', 'sh -s'], { input: script, encoding: 'utf8', windowsHide: true, timeout: 20_000 }))
