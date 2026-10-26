import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { roamingControl } from '../openwrt/roaming-control.ts'
import { r13Snapshot } from '../tests/fixtures/rm500q-r13.ts'

// Test the real ucode helper against an isolated fake sms_tool on the router.
const directory = '/tmp/cpe-roaming-check-' + process.pid
const mock = [
  '#!/bin/sh',
  'printf \'%s\\n\' "$4" >> "$CPE_ROAM_TEST_DIR/commands"',
  'case "$4" in',
  '  \'AT+QNWPREFCFG="roam_pref"\') printf \'\\n+QNWPREFCFG: "roam_pref",%s\\n\' "$(cat "$CPE_ROAM_TEST_DIR/preference")" ;;',
  '  \'AT+QNWPREFCFG="roam_pref",1\') if test -f "$CPE_ROAM_TEST_DIR/fail"; then echo ERROR; else echo 1 > "$CPE_ROAM_TEST_DIR/preference"; fi ;;',
  '  \'AT+QNWPREFCFG="roam_pref",255\') if test -f "$CPE_ROAM_TEST_DIR/fail"; then echo ERROR; else echo 255 > "$CPE_ROAM_TEST_DIR/preference"; fi ;;',
  '  *) echo ERROR; exit 1 ;;',
  'esac',
].join('\n')
const snapshot = structuredClone(r13Snapshot)
snapshot.raw.roaming = '+QNWPREFCFG: "roam_pref",1\n'
const script = [
  'set -eu', 'umask 077', 'mkdir -p ' + directory + '/bin ' + directory + '/cache',
  'cat > ' + directory + "/control.uc <<'CPE_CONTROL_EOF'", roamingControl, 'CPE_CONTROL_EOF',
  'cat > ' + directory + "/bin/sms_tool <<'CPE_MOCK_EOF'", mock, 'CPE_MOCK_EOF',
  'chmod 700 ' + directory + '/bin/sms_tool',
  "printf '%s' '" + JSON.stringify(snapshot) + "' > " + directory + '/cache/snapshot.json',
  "printf '%s' '" + JSON.stringify({ device: '/dev/ttyUSB2', networkInterface: 'wwan' }) + "' > " + directory + '/config.json',
  'echo 1 > ' + directory + '/preference',
  'export CPE_STATUS_CACHE=' + directory + '/cache',
  'export CPE_STATUS_CONFIG=' + directory + '/config.json',
  'export CPE_ROAM_TEST_DIR=' + directory,
  'export PATH=' + directory + '/bin:"$PATH"',
  'ucode ' + directory + '/control.uc 255',
  'ucode ' + directory + '/control.uc 255',
  'ucode ' + directory + '/control.uc 1',
  'ucode ' + directory + '/control.uc 3',
  'ucode ' + directory + "/control.uc '255;AT+CFUN=4'",
  'touch ' + directory + '/fail',
  'ucode ' + directory + '/control.uc 255',
  "printf '\\n>>> commands\\n'", 'cat ' + directory + '/commands',
  "printf '\\n>>> cache\\n'", 'cat ' + directory + '/cache/snapshot.json',
  "printf '\\n>>> live-query\\n'",
  "/usr/bin/sms_tool -d /dev/ttyUSB2 at 'AT+QNWPREFCFG=\"roam_pref\"'",
].join('\n')
const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts', 'root@192.168.2.248', 'sh -s'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
child.stdin.end(script + '\n')
let stdout = '', stderr = ''
child.stdout.on('data', part => { stdout += part.toString() })
child.stderr.on('data', part => { stderr += part.toString() })
const timer = setTimeout(() => child.kill(), 45000)
const code = await new Promise<number | null>((resolve, reject) => { child.on('close', resolve); child.on('error', reject) })
clearTimeout(timer)
await mkdir('build/router-audit', { recursive: true })
await writeFile('build/router-audit/roaming-check-output.txt', stdout)
await writeFile('build/router-audit/roaming-check-errors.txt', stderr)
assert.equal(code, 0, stderr)
const results = stdout.split('>>> commands')[0].trim().split('\n').map(line => JSON.parse(line))
assert.equal(results.length, 6)
assert.deepEqual(results.slice(0, 3).map(row => row.data.roam_pref), [255, 255, 1])
assert.deepEqual(results.slice(3).map(row => row.status), ['error', 'error', 'error'])
const commands = stdout.split('>>> commands\n')[1].split('>>> cache')[0].trim().split('\n')
assert.deepEqual(commands.filter(command => command.includes('",')), ['AT+QNWPREFCFG="roam_pref",255', 'AT+QNWPREFCFG="roam_pref",1', 'AT+QNWPREFCFG="roam_pref",255'])
assert.ok(!commands.some(command => command.includes('CFUN')))
const cached = JSON.parse(stdout.split('>>> cache\n')[1].split('>>> live-query')[0].trim())
for (const group of ['status', 'cells', 'identity', 'sim', 'temperature']) {
  assert.equal(cached.raw[group], snapshot.raw[group])
  assert.equal(cached.sampled[group], snapshot.sampled[group])
}
assert.equal(cached.sampled.roaming, 0)
assert.equal(cached.raw.roaming.trim(), '+QNWPREFCFG: "roam_pref",1')
assert.match(stdout.split('>>> live-query')[1], /"roam_pref",\s*255/)
console.log(JSON.stringify({ onOffConfirmed: true, idempotent: true, invalidValuesRejected: true, failedReadbackRejected: true, unrelatedCachePreserved: true, livePreference: 255, livePolicyChanged: false }))

