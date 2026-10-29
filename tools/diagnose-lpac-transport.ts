// Real-card probes are limited to chip info and profile list; no profile writes.
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'

const backend = process.argv[2] || 'at_csim'
if (!['at', 'at_csim', 'uqmi'].includes(backend)) throw new Error('Unsupported diagnostic backend')
const script = String.raw`set -eu
lock=/tmp/cpe-status/lock
mkdir -p /tmp/cpe-status
acquired=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if mkdir "$lock" 2>/dev/null; then acquired=1; break; fi
  sleep 1
done
test "$acquired" = 1 || { echo 'Modem lock busy'; exit 1; }
echo "$$" > "$lock/pid"
trap 'test "$(cat "$lock/pid" 2>/dev/null)" != "$$" || { rm -f "$lock/pid"; rmdir "$lock"; }' EXIT
if pidof lpac >/dev/null; then echo 'LPAC busy'; exit 1; fi
umask 077
out=$(mktemp -d /tmp/lpac-readonly.XXXXXX)
before=$(uci export network | sha256sum)
printf 'TRANSPORT=__BACKEND__\n'
printf 'WWAN_BEFORE='; ubus call network.interface.wwan status | jsonfilter -e '@.up'
command -v uqmi || true
command -v qmi-proxy || true
if test '__BACKEND__' = uqmi; then
  uqmi --help > "$out/uqmi-help" 2>&1 || true
  for required in uim-slot uim-channel-open uim-apdu-send; do
    grep -q -- "--$required" "$out/uqmi-help" || { echo "UQMI missing $required"; exit 1; }
  done
fi
probe() {
  label="$1"; shift
  /usr/bin/setsid env LPAC_DRIVER_HOME=/usr/lib/lpac LPAC_APDU=__BACKEND__ LPAC_APDU_AT_DEVICE=/dev/ttyUSB2 LPAC_APDU_QMI_DEVICE=/dev/cdc-wdm0 LPAC_APDU_QMI_UIM_SLOT=1 LPAC_HTTP=curl /usr/lib/lpac/lpac "$@" </dev/null > "$out/$label.json" 2> "$out/$label.stderr" & child=$!
  (sleep 20; /bin/kill -TERM -"$child"; sleep 1; /bin/kill -KILL -"$child") >/dev/null 2>&1 & guard=$!
  rc=0; wait "$child" || rc=$?
  /bin/kill -KILL -"$child" 2>/dev/null || true
  kill "$guard" 2>/dev/null || true
  wait "$guard" 2>/dev/null || true
  printf 'READ_%s_RC=%s\n' "$label" "$rc"
  cat "$out/$label.json"
  cat "$out/$label.stderr" >&2
  probe_rc="$rc"
}
probe chip chip info
if test "$probe_rc" = 0; then probe profiles profile list; fi
printf 'WWAN_AFTER='; ubus call network.interface.wwan status | jsonfilter -e '@.up'
after=$(uci export network | sha256sum)
test "$before" = "$after" || { echo 'Network configuration changed'; exit 1; }
printf 'NETWORK_CONFIG_UNCHANGED=yes\n'
rm -f "$out/chip.json" "$out/chip.stderr" "$out/profiles.json" "$out/profiles.stderr" "$out/uqmi-help"
rmdir "$out"
`.replaceAll('__BACKEND__', backend)
const output = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts', process.env.CPE_ROUTER || 'root@192.168.2.248', 'sh -s'], { input: script + '\n', encoding: 'utf8', windowsHide: true, timeout: 65_000 })
const masked = output.replace(/\b\d{18,32}\b/g, value => `***${value.slice(-6)}`)
await mkdir('build/router-audit', { recursive: true })
await writeFile(`build/router-audit/lpac-${backend}-readonly.txt`, masked)
console.log(masked)
