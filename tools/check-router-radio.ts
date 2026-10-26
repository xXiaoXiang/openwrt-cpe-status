import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { cellLockReader } from '../openwrt/radio-settings.ts'
import { modemControl, modemControlResult } from '../openwrt/modem-control.ts'
import { qmiNetworkModes } from '../shared/radio-settings.ts'
import { cellScanAt, cellScanReader } from '../openwrt/cell-scan.ts'
import { operatorAt, operatorReader } from '../openwrt/operators.ts'

// Real router ucode, isolated fake AT port. No live RF, WAN or lock changes.
const root = '/tmp/cpe-radio-check-' + process.pid
const fakeAt = String.raw`#!/usr/bin/ucode
import {readfile,writefile} from 'fs';
let dir=getenv('CPE_RADIO_TEST_DIR'), path=dir+'/state.json', cmd=ARGV[3], state=json(readfile(path));
writefile(dir+'/commands',(readfile(dir+'/commands')||'')+cmd+'\n');
let mode=match(cmd,/^AT\+QNWPREFCFG="mode_pref",([A-Z0-9:]+)$/);
let lock=match(cmd,/^AT\+QNWLOCK="common\/([45])g",([0-9,]+)$/);
if(cmd=='AT+CGMM') print('RM500Q-GL\n');
else if(cmd=='AT+COPS=?') {
  if(readfile(dir+'/reject-operator-scan')) print('+CME ERROR: 30\n');
  else print('+COPS: (1,"CUniq","CUniq","45403",7),(2,"UNICOM","UNICOM","45400",7),,(0-4),(0-2)\nOK\n');
}
else if(cmd=='AT+COPS?;+CEREG?;+C5GREG?;+QSPN') print('+COPS: '+(state.operatorMode||0)+',2,"'+(state.plmn||'45400')+'",7\n+CEREG: 2,'+(readfile(dir+'/unregistered')?'2':'5')+'\n+C5GREG: 2,4\n');
else if(cmd=='AT+COPS=0' || match(cmd,/^AT\+COPS=1,2,"[0-9]{5,6}"$/)) {
  if(readfile(dir+'/reject-operator')) print('+CME ERROR: 30\n');
  else {state.operatorMode=cmd=='AT+COPS=0'?0:1; state.plmn=cmd=='AT+COPS=0'?'45400':substr(cmd,13, length(cmd)-14); writefile(path,sprintf('%J',state)); print('OK\n');}
}
else if(cmd=='AT+CFUN?') print('+CFUN: 1\n');
else if(cmd=='AT+QSCAN=3,1') {
  if(readfile(dir+'/reject-scan')) print('+CME ERROR: 3\n');
  else print('+QSCAN: "LTE",454,00,1400,366,-95,-13,16,121,31E7C20,452,100,3\n+QSCAN: "NR5G",454,00,632352,41,-86,-10,33,1,31E7C20,452,273,78\nOK\n');
}
else if(cmd=='AT+QENG="servingcell"') print('+QENG: "servingcell","NOCONN"\n+QENG: "LTE","FDD",454,00,31E7C20,366,1400,3,5,5,452,-95,-13,-62,10,6,230,-\n');
else if(cmd=='AT+QNWPREFCFG="mode_pref"') {
  print('+QNWPREFCFG: "mode_pref",'+state.mode+'\n');
  if(state.next) { state.mode=state.next; delete state.next; writefile(path,sprintf('%J',state)); }
} else if(mode) {
  if(readfile(dir+'/reject-mode')) print('+CME ERROR: 4\n');
  else { if(readfile(dir+'/delay')) state.next=mode[1]; else state.mode=mode[1]; writefile(path,sprintf('%J',state)); print('OK\n'); }
} else if(cmd=='AT+QNWLOCK="common/4g"') print('+QNWLOCK: "common/4g",'+state.lte+'\n');
else if(cmd=='AT+QNWLOCK="common/5g"') print('+QNWLOCK: "common/5g",'+state.nr+'\n');
else if(lock) {
  if(lock[1]=='5' && readfile(dir+'/reject-nr')) print('+CME ERROR: 901\n');
  else { state[lock[1]=='4'?'lte':'nr']=lock[2]; writefile(path,sprintf('%J',state)); print('OK\n'); }
} else print('ERROR\n');
`
const host = String.raw`#!/usr/bin/ucode
import {readfile,writefile} from 'fs';
let dir=getenv('CPE_RADIO_TEST_DIR'), path=dir+'/state.json', state=json(readfile(path));
let kind=ARGV[0], args=slice(ARGV,1);
writefile(dir+'/host-commands',(readfile(dir+'/host-commands')||'')+kind+' '+join(' ',args)+'\n');
function store() {writefile(path,sprintf('%J',state));}
function dial() {
  state.up=true;
  state.mode='AUTO'; // Reproduce the real RM500Q network-register reset.
  for(let mode,value in __QMI_MODES__) if(value==state.loadedModes) state.mode=mode;
  store();
}
if(kind=='uci') {
  if(args[0]=='-q' && args[1]=='get') {
    if(args[2]=='network.wwan.proto') print('qmi\n');
    else if(args[2]=='network.wwan.plmn') print((state.uciPlmn||'0')+'\n');
    else if(args[2]=='network.wwan.modes') print((state.uciModes||'')+'\n');
    else exit(1);
  } else if(args[0]=='set' && index(args[1],'network.wwan.plmn=')==0) {state.uciPlmn=substr(args[1],length('network.wwan.plmn='));store();}
  else if(args[0]=='set' && index(args[1],'network.wwan.modes=')==0) {
    if(readfile(dir+'/reject-uci')) exit(1);
    state.uciModes=substr(args[1],length('network.wwan.modes='));store();
  } else if(args[0]!='commit' || args[1]!='network') exit(1);
} else if(kind=='ifup') {state.loadedModes=state.uciModes;dial();}
else if(kind=='ip') {if(state.up) print('9: wwan0 inet 192.0.2.2/26 scope global wwan0\n');}
else if(kind=='ubus') {
  if(args[3]=='dump') print(sprintf('%J',{interface:[{interface:'wwan',proto:'qmi',up:state.up,pending:false,l3_device:'wwan0'},{interface:'wwan_4',up:state.up,'ipv4-address':state.up?[{address:'192.0.2.2'}]:[]}]}));
  else if(args[3]=='up') dial();
  else if(args[3]=='down') {state.up=false;store();}
  else exit(1);
} else exit(1);
`.replace('__QMI_MODES__', JSON.stringify(qmiNetworkModes))
const script = [
  'set -eu', 'umask 077', `mkdir -p ${root}/bin ${root}/cache`,
  ...Object.entries({ locks: cellLockReader, control: modemControl, result: modemControlResult, 'bin/sms_tool': fakeAt, host, 'scan-result': cellScanReader, 'scan-shell': cellScanAt, 'operators': operatorReader, 'operator-shell': operatorAt,
    'scan-at': '#!/bin/sh\nsleep 7\nexec sms_tool -d /dev/ttyUSB2 at \'AT+QSCAN=3,1\'\n',
  }).flatMap(([file, content], index) => [`cat > ${root}/${file} <<'CPE_RADIO_${index}'`, content, `CPE_RADIO_${index}`]),
  `chmod 700 ${root}/locks ${root}/control ${root}/result ${root}/bin/sms_tool`,
  `chmod 700 ${root}/host`,
  `chmod 700 ${root}/scan-at ${root}/scan-result ${root}/operators`,
  `printf '#!/bin/sh\nif test -n \"$CPE_OPERATOR_COMMAND\"; then exec sms_tool -d /dev/ttyUSB2 at \"$CPE_OPERATOR_COMMAND\"; fi\nexec ${root}/scan-at\n' >${root}/bin/gcom`,
  `chmod 700 ${root}/bin/gcom`,
  ...['uci','ubus','ifup','ip'].flatMap(name => [`printf '#!/bin/sh\nexec ${root}/host ${name} "$@"\n' >${root}/bin/${name}`, `chmod 700 ${root}/bin/${name}`]),
  `printf '%s' '{"mode":"AUTO","up":true,"lte":"2,1400,366,1400,367","nr":"0"}' > ${root}/state.json`,
  `printf '%s' '{"device":"/dev/ttyUSB2","networkInterface":"wwan"}' > ${root}/config.json`,
  `export CPE_STATUS_CACHE=${root}/cache CPE_STATUS_CONFIG=${root}/config.json CPE_STATUS_CELL_SCRIPT=${root}/locks CPE_STATUS_CONTROL_SCRIPT=${root}/control CPE_RADIO_TEST_DIR=${root}`,
  `export PATH=${root}/bin:"$PATH"`,
  `export CPE_STATUS_SCAN_AT_SCRIPT=${root}/scan-at CPE_STATUS_OPERATOR_AT_SCRIPT=${root}/operator-shell CPE_STATUS_OPERATOR_SCRIPT=${root}/operators`,
  String.raw`
run() {
  echo ">>> $1"; shift
  "$CPE_STATUS_CONTROL_SCRIPT" "$@" > "$CPE_RADIO_TEST_DIR/start.json"
  id=$(ucode -e 'import {readfile} from "fs"; print(json(readfile(getenv("CPE_RADIO_TEST_DIR")+"/start.json")).job_id || "");')
  if test -z "$id"; then cat "$CPE_RADIO_TEST_DIR/start.json"; return; fi
  i=0
  while test "$i" -lt 65; do
    "$CPE_RADIO_TEST_DIR/result" "$id" > "$CPE_RADIO_TEST_DIR/result.json"
    pending=$(ucode -e 'import {readfile} from "fs"; print(json(readfile(getenv("CPE_RADIO_TEST_DIR")+"/result.json")).status=="pending" ? "yes":"no");')
    if test "$pending" != yes; then cat "$CPE_RADIO_TEST_DIR/result.json"; return; fi
    sleep 1; i=$((i+1))
  done
  cat "$CPE_STATUS_CACHE/control-worker.log"; exit 1
}
"$CPE_STATUS_CELL_SCRIPT" --refresh
echo '>>> initial'
"$CPE_STATUS_CELL_SCRIPT"
echo '>>> cached'
"$CPE_STATUS_CELL_SCRIPT"
cp "$CPE_RADIO_TEST_DIR/commands" "$CPE_RADIO_TEST_DIR/cache-commands"
echo yes > "$CPE_RADIO_TEST_DIR/delay"
run mode-delayed mode LTE:NR5G
rm "$CPE_RADIO_TEST_DIR/delay"
echo yes > "$CPE_RADIO_TEST_DIR/reject-mode"
run mode-rejected mode NR5G
rm "$CPE_RADIO_TEST_DIR/reject-mode"
run lock-lte cell lte lock 1400 366
run unlock-lte cell lte unlock
echo yes > "$CPE_RADIO_TEST_DIR/reject-nr"
run lock-nr-rejected cell nr lock 726432 570 79 30
rm "$CPE_RADIO_TEST_DIR/reject-nr"
run lock-nr cell nr lock 726432 570 79 30
run unlock-nr cell nr unlock
run invalid-scs cell nr lock 726432 570 79 60
run invalid-pci cell nr lock 726432 0 79 30
run injection mode 'LTE;AT+CFUN=0'
echo yes > "$CPE_RADIO_TEST_DIR/reject-uci"
run save-rejected mode LTE
rm "$CPE_RADIO_TEST_DIR/reject-uci"
run data-off data 0
run mode-while-off mode LTE
echo '>>> state-while-off'; cat "$CPE_RADIO_TEST_DIR/state.json"; echo
run data-on data 1
echo '>>> scan-empty'; "$CPE_RADIO_TEST_DIR/scan-result"
run scan-injection scan '3;AT+CFUN=0'
run scan-success scan
echo '>>> scan-file-only'; "$CPE_RADIO_TEST_DIR/scan-result"
echo '>>> scan-file-only-again'; "$CPE_RADIO_TEST_DIR/scan-result"
echo yes > "$CPE_RADIO_TEST_DIR/reject-scan"
run scan-rejected scan
echo '>>> scan-retained'; "$CPE_RADIO_TEST_DIR/scan-result"
run operator-injection operator '45400;AT+CFUN=0'
run operator-scan operator-scan
echo '>>> operator-scan-result'; "$CPE_RADIO_TEST_DIR/operators"
echo yes > "$CPE_RADIO_TEST_DIR/reject-operator-scan"
run operator-scan-rejected operator-scan
echo '>>> operator-scan-retained'; "$CPE_RADIO_TEST_DIR/operators"
echo '>>> operator-current-only'; "$CPE_RADIO_TEST_DIR/operators" state
rm "$CPE_RADIO_TEST_DIR/reject-operator-scan"
run operator-manual operator 45403
echo '>>> operator-manual-state'; cat "$CPE_RADIO_TEST_DIR/state.json"; echo
echo yes > "$CPE_RADIO_TEST_DIR/reject-operator"
run operator-rejected operator 45412
echo yes > "$CPE_RADIO_TEST_DIR/unregistered"
run operator-not-registered operator 45412
rm "$CPE_RADIO_TEST_DIR/unregistered" "$CPE_RADIO_TEST_DIR/reject-operator"
run operator-auto operator auto
echo '>>> final-state'; cat "$CPE_RADIO_TEST_DIR/state.json"; echo
echo '>>> cache-commands'; cat "$CPE_RADIO_TEST_DIR/cache-commands"
echo '>>> commands'; cat "$CPE_RADIO_TEST_DIR/commands"
echo '>>> done'
`,
].join('\n')
const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts', 'root@192.168.2.248', 'sh -s'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
child.stdin.end(script + '\n')
let stdout = '', stderr = ''
child.stdout.on('data', part => { stdout += part.toString() }); child.stderr.on('data', part => { stderr += part.toString() })
const timer = setTimeout(() => child.kill(), 90_000)
const code = await new Promise<number | null>((resolve, reject) => { child.on('close', resolve); child.on('error', reject) }); clearTimeout(timer)
await mkdir('build/router-audit', { recursive: true })
await writeFile('build/router-audit/radio-output.txt', stdout); await writeFile('build/router-audit/radio-errors.txt', stderr)
assert.equal(code, 0, stderr + '\n' + stdout.slice(-6000))
const results = Object.fromEntries(stdout.split('>>> cache-commands')[0].split(/>>> /).filter(Boolean).map(part => { const [name, ...lines] = part.trim().split('\n'); return [name, JSON.parse(lines.join('\n'))] }))
assert.deepEqual(results.initial, results.cached)
assert.equal(results.initial.data.lte.count, 2)
assert.equal(results['mode-delayed'].status, 'ok')
assert.deepEqual(results['mode-delayed'].data, { mode: 'LTE:NR5G' })
assert.ok(results['mode-delayed'].finished - results['mode-delayed'].started >= 2)
assert.equal(results['mode-rejected'].status, 'error'); assert.match(results['mode-rejected'].message, /CME ERROR: 4/)
assert.equal(results['mode-rejected'].data.mode, 'LTE:NR5G')
assert.equal(results['lock-lte'].data.lte.count, 1); assert.equal(results['unlock-lte'].data.lte.count, 0)
assert.equal(results['lock-nr-rejected'].status, 'error'); assert.match(results['lock-nr-rejected'].message, /CME ERROR: 901/)
assert.equal(results['lock-nr-rejected'].data.nr.count, 0)
assert.equal(results['lock-nr'].status, 'ok'); assert.equal(results['lock-nr'].at_command, 'AT+QNWLOCK="common/5g",570,726432,30,79')
assert.deepEqual(results['lock-nr'].data.nr.cells, [{ rat: 'nr', pci: 570, arfcn: 726432, scs_khz: 30, band: 79 }])
assert.equal(results['unlock-nr'].data.nr.count, 0)
assert.equal(results['save-rejected'].status, 'error')
assert.match(results['save-rejected'].message, /保存失败/)
assert.equal(results['mode-delayed'].qmi_mode, 'lte,5gnr')
assert.equal(results['state-while-off'].up, false, 'saving a mode must not enable data')
assert.equal(results['state-while-off'].uciModes, 'lte')
assert.equal(results['state-while-off'].loadedModes, 'lte,5gnr', 'inactive interface reload waits until data is enabled')
assert.equal(results['final-state'].mode, 'LTE', 'QMI registration reapplies the configured mode')
assert.equal(results['operator-injection'].status, 'error')
assert.equal(results['operator-scan'].status, 'ok')
assert.equal(results['operator-scan-rejected'].status, 'error')
assert.deepEqual(results['operator-scan-retained'].data, results['operator-scan-result'].data)
assert.equal(results['operator-current-only'].data, undefined)
assert.equal(results['operator-current-only'].message, '')
assert.equal(results['operator-current-only'].state.registered, true)
assert.equal(results['operator-manual'].status, 'ok')
assert.equal(results['operator-manual'].data.plmn, '45403')
assert.equal(results['operator-manual-state'].uciPlmn, '45403')
assert.equal(results['operator-rejected'].status, 'error')
assert.equal(results['operator-not-registered'].status, 'error')
assert.equal(results['operator-not-registered'].data.registered, false)
assert.equal(results['operator-auto'].status, 'ok')
assert.equal(results['final-state'].uciPlmn, '0')
assert.equal(results['scan-empty'].data, null)
assert.equal(results['scan-injection'].status, 'error')
assert.equal(results['scan-success'].status, 'ok')
assert.ok(results['scan-success'].finished - results['scan-success'].started >= 7, 'scan can exceed ordinary AT timeout')
assert.equal(results['scan-file-only'].data.raw, results['scan-success'].data.raw)
assert.deepEqual(results['scan-file-only-again'].data, results['scan-file-only'].data)
assert.equal(results['scan-rejected'].status, 'error')
assert.equal(results['scan-retained'].status, 'error')
assert.deepEqual(results['scan-retained'].data, results['scan-file-only'].data, 'failed scan preserves last successful result')
assert.equal(results['final-state'].loadedModes, 'lte')
assert.equal(results['data-on'].status, 'ok')
for (const name of ['invalid-scs', 'invalid-pci', 'injection']) assert.equal(results[name].status, 'error')
const reads = stdout.split('>>> cache-commands\n')[1].split('>>> commands')[0].trim().split('\n')
assert.equal(reads.length, 3, 'model plus two lock queries only once')
const commands = stdout.split('>>> commands\n')[1].split('>>> done')[0].trim().split('\n')
assert.equal(commands.some(line => line.includes('CFUN=')), false)
assert.deepEqual(commands.filter(line => line.startsWith('AT+QNWPREFCFG="mode_pref",')), ['AT+QNWPREFCFG="mode_pref",LTE:NR5G', 'AT+QNWPREFCFG="mode_pref",NR5G', 'AT+QNWPREFCFG="mode_pref",LTE'])
assert.equal(commands.filter(line => line.startsWith('AT+QNWLOCK="common/5g",570')).length, 2, 'NSA NR requests are sent, not blocked or silently converted to SA')
console.log(JSON.stringify({ tests: Object.keys(results).length, liveWanChanged: false, modeReadback: true, nsaNotBlocked: true, nrSyntax: 'pci,arfcn,scs_khz,band', cme901Preserved: true, cacheReused: true, root }))
