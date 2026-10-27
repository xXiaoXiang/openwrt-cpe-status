import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { statusCollector } from '../openwrt/status-collector.ts'
import { modemControl, modemControlResult } from '../openwrt/modem-control.ts'
import { bandReader } from '../openwrt/band-control.ts'
import { cellLockReader } from '../openwrt/radio-settings.ts'
import { roamingControl } from '../openwrt/roaming-control.ts'
import { wwanManager } from '../openwrt/wwan-manager.ts'
import { lteOnlyProfile } from '../tests/fixtures/lte-only-profile.ts'
import { r13Snapshot } from '../tests/fixtures/rm500q-r13.ts'
import { snapshotRoutes, type StatusSnapshot } from '../shared/status-snapshot.ts'

// Generated ucode on the router, but every AT/netifd command is isolated in /tmp.
const root = '/tmp/cpe-availability-' + process.pid
const profile = lteOnlyProfile()
const replies: Record<string, string> = {}
for (const [key, group] of Object.entries(profile.groups)) for (const name of group.names) replies[profile.commands[name].command] = r13Snapshot.raw[key] || r13Snapshot.raw.status
replies[profile.commands.bandCapabilities.command] = '+QNWPREFCFG: "lte_band",1:3:7\n'
replies[profile.commands.lteCellLock.command] = '+QNWLOCK: "common/4g",0\n'
const fakeAt = String.raw`#!/usr/bin/ucode
import {readfile,writefile} from 'fs';
let dir=getenv('CPE_AVAILABILITY_TEST'), cmd=ARGV[3], replies=json(readfile(dir+'/replies.json'));
writefile(dir+'/commands',(readfile(dir+'/commands')||'')+cmd+'\n');
let state=json(readfile(dir+'/state.json'));
if(match(cmd,/^AT\+QNWPREFCFG="mode_pref",/)) {state.mode=split(cmd,',')[1];writefile(dir+'/state.json',sprintf('%J',state));print('OK\n');}
else if(match(cmd,/^AT\+QNWPREFCFG="lte_band",/)) {state.bands=split(cmd,',')[1];writefile(dir+'/state.json',sprintf('%J',state));print('OK\n');}
else for(let part in split(cmd,';')) {
  let query=index(part,'AT')==0?part:'AT'+part;
  if(query=='AT+QNWPREFCFG="mode_pref"') print('+QNWPREFCFG: "mode_pref",'+state.mode+'\n');
  else if(query=='AT+QNWPREFCFG="lte_band"') print('+QNWPREFCFG: "lte_band",'+state.bands+'\n');
  else print(replies[query]||'ERROR\n');
}
`
const files = { snapshot: statusCollector, control: modemControl, result: modemControlResult, bands: bandReader, locks: cellLockReader, roaming: roamingControl, manager: wwanManager,
  'bin/sms_tool': fakeAt, 'bin/ubus': '#!/bin/sh\necho \'{"interface":[{"interface":"wwan","proto":"mbim","up":false,"pending":false}]}\'\n', 'bin/ip': '#!/bin/sh\nexit 0\n' }
const script = [
  'set -eu', 'umask 077', `mkdir -p ${root}/bin ${root}/cache ${root}/modem.d`,
  ...Object.entries(files).flatMap(([name, content], i) => [`cat >${root}/${name} <<'CPE_AVAILABLE_${i}'`, content, `CPE_AVAILABLE_${i}`, `chmod 700 ${root}/${name}`]),
  `cat >${root}/modem.d/2c7c0800.conf <<'CPE_AVAILABLE_PROFILE'`, JSON.stringify(profile), 'CPE_AVAILABLE_PROFILE',
  `cat >${root}/replies.json <<'CPE_AVAILABLE_REPLIES'`, JSON.stringify(replies), 'CPE_AVAILABLE_REPLIES',
  `echo '{"mode":"AUTO","bands":"1:3:7"}' >${root}/state.json`,
  `echo '{"device":"/dev/ttyUSB2","networkInterface":"wwan"}' >${root}/config.json`,
  `export PATH=${root}/bin:"$PATH" CPE_AVAILABILITY_TEST=${root} CPE_STATUS_CONFIG=${root}/config.json CPE_STATUS_CACHE=${root}/cache CPE_STATUS_MODEM_DIRECTORY=${root}/modem.d`,
  `export CPE_STATUS_SCRIPT=${root}/snapshot CPE_STATUS_CONTROL_SCRIPT=${root}/control CPE_STATUS_BAND_SCRIPT=${root}/bands CPE_STATUS_CELL_SCRIPT=${root}/locks`,
  String.raw`
run() {
  label=$1; shift
  echo ">>> $label"
  "$CPE_STATUS_CONTROL_SCRIPT" "$@" >"$CPE_AVAILABILITY_TEST/start.json"
  id=$(ucode -e 'import {readfile} from "fs"; print(json(readfile(getenv("CPE_AVAILABILITY_TEST")+"/start.json")).job_id||"");')
  if test -z "$id"; then cat "$CPE_AVAILABILITY_TEST/start.json"; return; fi
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    "$CPE_AVAILABILITY_TEST/result" "$id" >"$CPE_AVAILABILITY_TEST/result.json"
    if ! grep -q '"status": "pending"' "$CPE_AVAILABILITY_TEST/result.json"; then cat "$CPE_AVAILABILITY_TEST/result.json"; return; fi
    sleep 1
  done
  cat "$CPE_STATUS_CACHE/control-worker.log" >&2; exit 1
}
echo '>>> snapshot'
"$CPE_STATUS_SCRIPT" --refresh
echo '>>> locks'
"$CPE_STATUS_CELL_SCRIPT" --refresh
"$CPE_STATUS_CELL_SCRIPT"
"$CPE_STATUS_BAND_SCRIPT" --refresh
echo '>>> bands'
"$CPE_STATUS_BAND_SCRIPT"
cp "$CPE_AVAILABILITY_TEST/commands" "$CPE_AVAILABILITY_TEST/read-commands"
run nr-mode mode NR5G
run nsa-mode mode LTE:NR5G
run nr-lock cell nr lock 632352 41 78 30
run nr-unlock cell nr unlock
run nr-bands bands 1:3:7 78 ''
run flight airplane 1
run scan scan
echo '>>> roaming'
"$CPE_AVAILABILITY_TEST/roaming" 255
cmp "$CPE_AVAILABILITY_TEST/commands" "$CPE_AVAILABILITY_TEST/read-commands"
run lte-mode mode LTE
run lte-bands bands 3:7 '' ''
echo '>>> after-lte-bands'
"$CPE_STATUS_BAND_SCRIPT"
echo '>>> commands'
cat "$CPE_AVAILABILITY_TEST/commands"
ucode -e 'import {readfile,writefile} from "fs"; let path=getenv("CPE_STATUS_MODEM_DIRECTORY")+"/2c7c0800.conf", profile=json(readfile(path)); for(let group in values(profile.groups)) for(let name in group.names) profile.unsupportedOperations[name]="No telemetry"; writefile(path,sprintf("%J",profile));'
cp "$CPE_AVAILABILITY_TEST/commands" "$CPE_AVAILABILITY_TEST/before-empty"
echo '>>> empty-groups'
"$CPE_STATUS_SCRIPT" --refresh
cmp "$CPE_AVAILABILITY_TEST/commands" "$CPE_AVAILABILITY_TEST/before-empty"
ucode -e 'import {readfile,writefile} from "fs"; let path=getenv("CPE_STATUS_MODEM_DIRECTORY")+"/2c7c0800.conf", profile=json(readfile(path)); profile.unsupportedOperations.autoApn="No automatic APN management"; writefile(path,sprintf("%J",profile));'
echo '>>> unsupported-manager'
"$CPE_AVAILABILITY_TEST/manager" --prepare
cat "$CPE_STATUS_CACHE/wwan-manager.json"
echo
cmp "$CPE_AVAILABILITY_TEST/commands" "$CPE_AVAILABILITY_TEST/before-empty"
echo '>>> done'
`,
].join('\n')
const output = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts', process.env.CPE_ROUTER || 'root@192.168.6.248', 'sh -s'], { input: script + '\n', encoding: 'utf8', timeout: 60000, windowsHide: true })
await mkdir('build/availability-audit', { recursive: true })
await writeFile('build/availability-audit/output.txt', output)
const section = (name: string) => output.split('>>> ' + name + '\n')[1]?.split('>>> ')[0].trim()
for (const name of ['nr-mode', 'nsa-mode', 'nr-lock', 'nr-unlock', 'nr-bands', 'flight', 'scan', 'roaming']) {
  const result = JSON.parse(section(name)!)
  assert.equal(result.status, 'unsupported', name)
  assert.equal(result.message, 'Not applicable', name)
  assert.equal(result.display, '-', name)
  assert.equal(result.submitted, false, name)
}
const bands = JSON.parse(section('bands')!).data
assert.deepEqual(bands.enabled, { lte: [1, 3, 7], sa: [], nsa: [] })
assert.deepEqual(bands.unavailable, { sa: '-', nsa: '-' })
assert.equal(JSON.parse(section('locks')!).data.nr.status, 'unsupported')
assert.equal(JSON.parse(section('lte-mode')!).data.mode, 'LTE')
assert.equal(JSON.parse(section('lte-bands')!).status, 'ok')
assert.deepEqual(JSON.parse(section('after-lte-bands')!).data.enabled, { lte: [3, 7], sa: [], nsa: [] })
const snapshot = JSON.parse(section('snapshot')!) as StatusSnapshot
assert.deepEqual(snapshot.warnings ?? {}, {})
assert.equal(snapshotRoutes(snapshot)['/api/roaming'].status, 'unsupported')
const commands = section('commands')!
for (const name of Object.keys(profile.unsupportedOperations!)) if (profile.commands[name]) assert.equal(commands.includes(profile.commands[name].command), false, name)
assert.equal(commands.includes('AT+QNWPREFCFG="mode_pref",NR5G'), false)
assert.deepEqual(JSON.parse(section('empty-groups')!).warnings ?? {}, {})
assert.equal(JSON.parse(section('unsupported-manager')!).status, 'unsupported')
console.log(JSON.stringify({ rejectedWritesWithoutAnyAt: 8, partialBandsAndLocks: true, lteWritesStillWork: true, unsupportedQueriesSkipped: true, emptyGroupsNeverQuery: true, unsupportedManagerNeverQueries: true, realNetworkChanged: false }))
