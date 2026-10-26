import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { bandReader } from '../openwrt/band-control.ts'
import { modemControl, modemControlResult } from '../openwrt/modem-control.ts'

// Execute generated ucode against an isolated fake sms_tool, never the real WAN.
const root = '/tmp/cpe-bands-check-' + process.pid
const fakeAt = String.raw`#!/usr/bin/ucode
import { readfile, writefile } from 'fs';
let dir = getenv('CPE_BANDS_TEST_DIR'), cmd = ARGV[3], path = dir + '/state.json';
writefile(dir + '/commands', (readfile(dir + '/commands') || '') + cmd + '\n');
let state = json(readfile(path));
function rows(values) { for (let key, bands in values) print('+QNWPREFCFG: "' + key + '",' + join(':', bands) + '\n'); }
if (cmd == 'AT+CGMM;+QNWPREFCFG="ue_capability_band"') {
  print(readfile(dir + '/wrong-model') ? 'OTHER-MODEM\n' : 'RM500Q-GL\n'); rows(state.supported);
} else if (cmd == 'AT+QNWPREFCFG="lte_band";+QNWPREFCFG="nr5g_band";+QNWPREFCFG="nsa_nr5g_band"') {
  if (readfile(dir + '/bad-read')) print('ERROR\n'); else rows(state.enabled);
} else {
  let found = match(cmd, /^AT\+QNWPREFCFG="(lte_band|nr5g_band|nsa_nr5g_band)",([0-9:]+)$/);
  if (!found || (readfile(dir + '/reject') && found[1] == 'nr5g_band')) print('ERROR\n');
  else {
    if (!readfile(dir + '/ignore-write')) {
      state.enabled[found[1]] = map(split(found[2], ':'), x => +x);
      writefile(path, sprintf('%J', state));
    }
    print('OK\n');
  }
}
`
const supported = { lte_band: [1, 3, 7], nr5g_band: [41, 78, 79], nsa_nr5g_band: [41, 78, 79] }
const script = [
  'set -eu', 'umask 077', `mkdir -p ${root}/bin ${root}/cache`,
  ...Object.entries({ bands: bandReader, control: modemControl, result: modemControlResult, 'bin/sms_tool': fakeAt }).flatMap(([file, content], index) => [`cat > ${root}/${file} <<'CPE_FILE_${index}'`, content, `CPE_FILE_${index}`]),
  `chmod 700 ${root}/bands ${root}/control ${root}/result ${root}/bin/sms_tool`,
  `printf '%s' '${JSON.stringify({ supported, enabled: supported })}' > ${root}/state.json`,
  `printf '%s' '{"device":"/dev/ttyUSB2","networkInterface":"wwan"}' > ${root}/config.json`,
  `export CPE_STATUS_CACHE=${root}/cache CPE_STATUS_CONFIG=${root}/config.json CPE_STATUS_BAND_SCRIPT=${root}/bands CPE_STATUS_CONTROL_SCRIPT=${root}/control CPE_BANDS_TEST_DIR=${root}`,
  `export PATH=${root}/bin:"$PATH"`,
  String.raw`
run() {
  echo ">>> $1"
  shift
  "$CPE_STATUS_CONTROL_SCRIPT" bands "$@" > "$CPE_BANDS_TEST_DIR/start.json"
  id=$(ucode -e 'import {readfile} from "fs"; print(json(readfile(getenv("CPE_BANDS_TEST_DIR")+"/start.json")).job_id || "");')
  if test -z "$id"; then cat "$CPE_BANDS_TEST_DIR/start.json"; return; fi
  i=0
  while test "$i" -lt 60; do
    "$CPE_BANDS_TEST_DIR/result" "$id" > "$CPE_BANDS_TEST_DIR/result.json"
    pending=$(ucode -e 'import {readfile} from "fs"; print(json(readfile(getenv("CPE_BANDS_TEST_DIR")+"/result.json")).status=="pending" ? "yes":"no");')
    if test "$pending" != yes; then cat "$CPE_BANDS_TEST_DIR/result.json"; return; fi
    sleep 1; i=$((i+1))
  done
  cat "$CPE_STATUS_CACHE/control-worker.log"; exit 1
}
echo '>>> cold'
"$CPE_STATUS_BAND_SCRIPT"
i=0
while ! test -f "$CPE_STATUS_CACHE/bands.json"; do
  sleep 1; i=$((i+1)); if test "$i" -gt 15; then cat "$CPE_STATUS_CACHE/band-reader.log"; cat "$CPE_STATUS_CACHE/band-failure.json"; exit 1; fi
done
echo '>>> cached'
"$CPE_STATUS_BAND_SCRIPT"
echo '>>> cached-again'
"$CPE_STATUS_BAND_SCRIPT"
cp "$CPE_BANDS_TEST_DIR/commands" "$CPE_BANDS_TEST_DIR/cache-commands"
run changed 3:7 78 78:79
run unsupported 3:7 78 777
run invalid '3;AT+CFUN=4' 78 78
run unchanged 3:7 78 78:79
echo yes > "$CPE_BANDS_TEST_DIR/reject"
run partial 1 41 41
rm "$CPE_BANDS_TEST_DIR/reject"
echo yes > "$CPE_BANDS_TEST_DIR/ignore-write"
run unconfirmed 3 78 78
rm "$CPE_BANDS_TEST_DIR/ignore-write"
echo yes > "$CPE_BANDS_TEST_DIR/bad-read"
"$CPE_STATUS_BAND_SCRIPT" --refresh
echo '>>> failed-refresh'
"$CPE_STATUS_BAND_SCRIPT"
rm "$CPE_BANDS_TEST_DIR/bad-read"
rm "$CPE_STATUS_CACHE/band-capabilities.json"
echo yes > "$CPE_BANDS_TEST_DIR/wrong-model"
run unsupported-model 3 78 78
echo '>>> cache-commands'
cat "$CPE_BANDS_TEST_DIR/cache-commands"
echo '>>> commands'
cat "$CPE_BANDS_TEST_DIR/commands"
echo '>>> done'
`,
].join('\n')
const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts', 'root@192.168.2.248', 'sh -s'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
child.stdin.end(script + '\n')
let stdout = '', stderr = ''
child.stdout.on('data', part => { stdout += part.toString() })
child.stderr.on('data', part => { stderr += part.toString() })
const timer = setTimeout(() => child.kill(), 100_000)
const code = await new Promise<number | null>((resolve, reject) => { child.on('close', resolve); child.on('error', reject) })
clearTimeout(timer)
await mkdir('build/router-audit', { recursive: true })
await writeFile('build/router-audit/bands-output.txt', stdout)
await writeFile('build/router-audit/bands-errors.txt', stderr)
assert.equal(code, 0, stderr + '\n' + stdout.slice(-5000))
const results = Object.fromEntries(stdout.split('>>> cache-commands')[0].split(/>>> /).filter(Boolean).map(part => { const [name, ...lines] = part.trim().split('\n'); return [name, JSON.parse(lines.join('\n'))] }))
assert.equal(results.cold.status, 'deferred')
assert.deepEqual(results.cached, results['cached-again'])
assert.equal(results.changed.status, 'ok')
assert.deepEqual(results.changed.data.enabled, { lte: [3, 7], sa: [78], nsa: [78, 79] })
assert.equal(results.unsupported.status, 'error')
assert.equal(results.invalid.status, 'error')
assert.equal(results.unchanged.status, 'ok')
assert.deepEqual(results.unchanged.applied, [])
assert.equal(results.partial.status, 'error')
assert.deepEqual(results.partial.applied, ['lte'])
assert.deepEqual(results.partial.data.enabled, { lte: [1], sa: [78], nsa: [78, 79] })
assert.match(results.partial.message, /部分设置可能已生效/)
assert.equal(results.unconfirmed.status, 'error')
assert.deepEqual(results.unconfirmed.data.enabled.lte, [1])
assert.equal(results['failed-refresh'].status, 'ok', 'failed read retains previous result')
assert.equal(results['unsupported-model'].status, 'error')
const cacheCommands = stdout.split('>>> cache-commands\n')[1].split('>>> commands')[0].trim().split('\n')
assert.equal(cacheCommands.length, 2, 'capability and current preferences once; repeated GETs use cache')
const commands = stdout.split('>>> commands\n')[1].split('>>> done')[0].trim().split('\n')
assert.equal(commands.filter(line => /^AT\+QNWPREFCFG="[^" ]+",/.test(line)).length, 6)
assert.equal(commands.some(line => /CFUN|ubus/.test(line)), false)
console.log(JSON.stringify({ tests: Object.keys(results).length, cachedReads: true, exactReadback: true, unsupportedRejected: true, partialWritesReported: true, realWanChanged: false, root }))

if (process.argv.includes('--live-read')) {
  // Temporary read-only helper uses the installed collector's real AT lock.
  const temporary = '/tmp/cpe-bands-readcheck-' + process.pid
  const liveScript = [
    'set -eu', 'umask 077', `cat > ${temporary} <<'CPE_BAND_READ_EOF'`, bandReader, 'CPE_BAND_READ_EOF',
    `chmod 700 ${temporary}`, `export CPE_STATUS_BAND_SCRIPT=${temporary}`,
    `${temporary} >/dev/null`,
    'i=0', 'while test "$i" -lt 20; do', `output=$(${temporary})`,
    `if printf '%s' "$output" | grep -qE '"status"[[:space:]]*:[[:space:]]*"ok"'; then printf '%s\\n' "$output"; exit 0; fi`,
    'sleep 1; i=$((i+1))', 'done', 'printf "%s\\n" "$output"', 'exit 1',
  ].join('\n')
  const live = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts', 'root@192.168.2.248', 'sh -s'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let result = '', errors = ''
  live.stdout.on('data', part => { result += part.toString() })
  live.stderr.on('data', part => { errors += part.toString() })
  live.stdin.end(liveScript + '\n')
  const status = await new Promise<number | null>((resolve, reject) => { live.on('close', resolve); live.on('error', reject) })
  await writeFile('build/router-audit/bands-live.json', result)
  assert.equal(status, 0, result + errors)
  const state = JSON.parse(result)
  assert.equal(state.status, 'ok'); assert.equal(state.data.model, 'RM500Q-GL')
  assert.ok(state.data.supported.lte.length && state.data.supported.sa.length && state.data.supported.nsa.length)
  console.log(JSON.stringify({ liveRead: true, supported: state.data.supported, enabled: state.data.enabled, modemWrites: 0 }))
}
