import { profileFixture } from './profile-fixture.ts'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { modemControl, modemControlResult } from '../openwrt/modem-control.ts'
import { r13Snapshot } from '../tests/fixtures/rm500q-r13.ts'

// Real ucode, isolated fake AT/netifd: never disconnects the actual WAN.
const root = '/tmp/cpe-control-check-' + process.pid
const sms = String.raw`#!/bin/sh
echo "$4" >> "$CPE_CONTROL_TEST_DIR/commands"
case "$4" in
  'AT+CFUN?')
    if test -f "$CPE_CONTROL_TEST_DIR/radio.next"; then
      if test -f "$CPE_CONTROL_TEST_DIR/hold-probe"; then rm "$CPE_CONTROL_TEST_DIR/hold-probe"
      else mv "$CPE_CONTROL_TEST_DIR/radio.next" "$CPE_CONTROL_TEST_DIR/radio"; fi
    fi
    printf '+CFUN: %s\n' "$(cat "$CPE_CONTROL_TEST_DIR/radio")" ;;
  'AT+CFUN=4'|'AT+CFUN=1')
    if test -f "$CPE_CONTROL_TEST_DIR/reject"; then echo ERROR
    elif test -f "$CPE_CONTROL_TEST_DIR/delay"; then
      printf '%s' "$4" | sed 's/AT+CFUN=//' > "$CPE_CONTROL_TEST_DIR/radio.next"; touch "$CPE_CONTROL_TEST_DIR/hold-probe"
    else printf '%s' "$4" | sed 's/AT+CFUN=//' > "$CPE_CONTROL_TEST_DIR/radio"; fi ;;
  *) echo ERROR; exit 1 ;;
esac
`
const ubus = String.raw`#!/bin/sh
echo "ubus $*" >> "$CPE_CONTROL_TEST_DIR/commands"
case "$*" in
  '-S call network.interface dump')
    ucode -e 'import {readfile} from "fs"; let dir=getenv("CPE_CONTROL_TEST_DIR"), up=+readfile(dir+"/up")==1; let net={interface:"wwan",proto:"qmi",up,pending:false,l3_device:"wwan0",autostart:up}; print(sprintf("%J", {interface:[net,{interface:"wwan_4",up,l3_device:"wwan0","ipv4-address":up?[{address:"192.0.2.2",mask:26}]:[]}]}));' ;;
  '-S call network.interface up '*)
    if ! test -f "$CPE_CONTROL_TEST_DIR/network-fail"; then echo 1 > "$CPE_CONTROL_TEST_DIR/up"; fi
    echo '{}' ;;
  '-S call network.interface down '*) echo 0 > "$CPE_CONTROL_TEST_DIR/up"; echo '{}' ;;
  *) exit 1 ;;
esac
`
const ip = String.raw`#!/bin/sh
if test "$(cat "$CPE_CONTROL_TEST_DIR/up")" = 1; then echo '9: wwan0 inet 192.0.2.2/26 scope global wwan0'; fi
`
const script = [profileFixture(root),
  'set -eu', 'umask 077', 'mkdir -p ' + root + '/bin ' + root + '/cache',
  'cat > ' + root + "/control <<'CPE_CONTROL_EOF'", modemControl, 'CPE_CONTROL_EOF',
  'cat > ' + root + "/result <<'CPE_RESULT_EOF'", modemControlResult, 'CPE_RESULT_EOF',
  'cat > ' + root + "/bin/sms_tool <<'CPE_SMS_EOF'", sms, 'CPE_SMS_EOF',
  'cat > ' + root + "/bin/ubus <<'CPE_UBUS_EOF'", ubus, 'CPE_UBUS_EOF',
  'cat > ' + root + "/bin/ip <<'CPE_IP_EOF'", ip, 'CPE_IP_EOF',
  'chmod 700 ' + root + '/control ' + root + '/result ' + root + '/bin/*',
  "printf '%s' '" + JSON.stringify({ ...r13Snapshot, sampled: { ...r13Snapshot.sampled, identity: Math.floor(Date.now() / 1000) } }) + "' > " + root + '/cache/snapshot.json',
  "printf '%s' '" + JSON.stringify({ device: '/dev/ttyUSB2', networkInterface: 'wwan' }) + "' > " + root + '/config.json',
  'export CPE_STATUS_CACHE=' + root + '/cache',
  'export CPE_STATUS_CONFIG=' + root + '/config.json',
  'export CPE_STATUS_CONTROL_SCRIPT=' + root + '/control',
  'export CPE_CONTROL_TEST_DIR=' + root,
  'export PATH=' + root + '/bin:"$PATH"',
  'echo 1 > ' + root + '/radio', 'echo 1 > ' + root + '/up',
  String.raw`
run() {
  echo ">>> $1-$2"
  "$CPE_STATUS_CONTROL_SCRIPT" "$1" "$2" > "$CPE_CONTROL_TEST_DIR/start.json"
  id=$(ucode -e 'import {readfile} from "fs"; print(json(readfile(getenv("CPE_CONTROL_TEST_DIR")+"/start.json")).job_id || "");')
  test -n "$id" || { cat "$CPE_CONTROL_TEST_DIR/start.json"; exit 1; }
  if test -f "$CPE_CONTROL_TEST_DIR/delay"; then "$CPE_STATUS_CONTROL_SCRIPT" data 1 > "$CPE_CONTROL_TEST_DIR/concurrent.json"; fi
  i=0
  while test "$i" -lt 70; do
    "$CPE_CONTROL_TEST_DIR/result" "$id" > "$CPE_CONTROL_TEST_DIR/result.json"
    pending=$(ucode -e 'import {readfile} from "fs"; print(json(readfile(getenv("CPE_CONTROL_TEST_DIR")+"/result.json")).status=="pending" ? "yes":"no");')
    if test "$pending" != yes; then cat "$CPE_CONTROL_TEST_DIR/result.json"; return; fi
    sleep 1
    i=$((i+1))
  done
  cat "$CPE_CONTROL_TEST_DIR/cache/control-worker.log"
  exit 1
}
run data 0
run data 1
touch "$CPE_CONTROL_TEST_DIR/delay"
run airplane 1
rm "$CPE_CONTROL_TEST_DIR/delay"
run data 1
run airplane 0
run data 0
run airplane 1
run airplane 0
touch "$CPE_CONTROL_TEST_DIR/reject"
run airplane 1
rm "$CPE_CONTROL_TEST_DIR/reject"
run airplane 0
echo '>>> invalid'
"$CPE_STATUS_CONTROL_SCRIPT" data '1;AT+CFUN=4'
echo '>>> commands'
cat "$CPE_CONTROL_TEST_DIR/commands"
echo '>>> concurrent'
cat "$CPE_CONTROL_TEST_DIR/concurrent.json"
echo '>>> done'
`,
].join('\n')
const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts', 'root@192.168.6.248', 'sh -s'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
child.stdin.end(script + '\n')
let stdout = '', stderr = ''
child.stdout.on('data', part => { stdout += part.toString() })
child.stderr.on('data', part => { stderr += part.toString() })
const timer = setTimeout(() => child.kill(), 100_000)
const code = await new Promise<number | null>((resolve, reject) => { child.on('close', resolve); child.on('error', reject) })
clearTimeout(timer)
await mkdir('build/router-audit', { recursive: true })
await writeFile('build/router-audit/controls-output.txt', stdout)
await writeFile('build/router-audit/controls-errors.txt', stderr)
assert.equal(code, 0, stderr + '\n' + stdout.slice(-4000))
const results = stdout.split('>>> commands')[0].split(/>>> [^\n]+\n/).filter(Boolean).map(line => JSON.parse(line.trim()))
assert.equal(results.length, 11)
assert.deepEqual(results.map(row => row.status), ['ok', 'ok', 'ok', 'error', 'ok', 'ok', 'ok', 'ok', 'error', 'ok', 'error'])
assert.deepEqual(results.filter(row => row.status === 'ok' && row.kind === 'airplane').map(row => row.data.enabled), [true, false, true, false, false])
assert.equal(results[2].snapshot.host.net.up, false)
assert.equal(results[4].snapshot.host.net.up, true, 'restore data that was enabled before flight mode')
assert.equal(results[7].snapshot.host.net.up, false, 'do not enable data that was off before flight mode')
assert.equal(results[2].snapshot.sampled.cells, 0)
assert.match(results[2].snapshot.raw.radio, /\+CFUN:\s*4/)
for (const group of ['sim', 'identity', 'temperature', 'roaming']) assert.equal(results[2].snapshot.raw[group], r13Snapshot.raw[group])
assert.ok(results[2].finished - results[2].started >= 10, 'an unsuccessful first readback retries after 10s')
const concurrent = JSON.parse(stdout.split('>>> concurrent\n')[1].split('>>> done')[0])
assert.equal(concurrent.status, 'deferred')
assert.equal(concurrent.submitted, false)
const commands = stdout.split('>>> commands\n')[1].split('>>> concurrent')[0].trim().split('\n')
assert.deepEqual(commands.filter(row => /^AT\+CFUN=/.test(row)), ['AT+CFUN=4', 'AT+CFUN=1', 'AT+CFUN=4', 'AT+CFUN=1', 'AT+CFUN=4'])
const firstDown = commands.findIndex(row => row.startsWith('ubus -S call network.interface down '))
assert.ok(firstDown >= 0 && firstDown < commands.indexOf('AT+CFUN=4'))
console.log(JSON.stringify({ tests: 11, realWanChanged: false, readbackConfirmed: true, dataRestoredOnlyWhenPreviouslyEnabled: true, flightBlocksData: true, rejectedAtPreservesRealState: true, injectionRejected: true, root }))

