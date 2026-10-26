import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { modemControl } from '../openwrt/modem-control.ts'
import { apnReader } from '../openwrt/apn-control.ts'
import { wwanManager } from '../openwrt/wwan-manager.ts'

// All UCI, AT and netifd commands are fixtures confined to this /tmp tree.
const root = '/tmp/cpe-apn-check-' + process.pid
const settings = { apn: 'custom.apn', pdptype: 'ipv4v6', auth: 'chap', username: "user'$(false)", password: "secret'$(false)" }
const fake = String.raw`#!/usr/bin/ucode
import {readfile,writefile} from 'fs';
let root=getenv('CPE_APN_TEST'), kind=ARGV[0], args=slice(ARGV,1), state=json(readfile(root+'/state.json'));
function store() {writefile(root+'/state.json',sprintf('%J',state));}
if(kind=='uci') {
  if(args[0]=='-q' && args[1]=='get') {if(index(args[2],'network.wwan.')!=0) die('INTERFACE VIOLATION'); print(state.uci[substr(args[2],13)]||'');}
  else if(args[0]=='set') {let pair=split(args[1],'=');if(index(pair[0],'network.wwan.')!=0)die('INTERFACE VIOLATION');state.uci[substr(pair[0],13)]=join('=',slice(pair,1));store();}
  else if(args[0]!='commit' || args[1]!='network')die('INVALID COMMIT');
} else if(kind=='sms_tool') {
  let cmd=args[length(args)-1];
  if(cmd=='AT+CPIN?;+QCCID') print(readfile(root+'/no-sim')?'+CME ERROR: 10\n':'+CPIN: READY\n+QCCID: 8985200123456789012\n');
  else if(cmd=='AT+CFUN?') print('+CFUN: 1\n');
  else if(cmd=='AT+CIMI') print('454001234567890\n');
  else if(index(cmd,'AT+CRSM=')==0) print('+CRSM: 144,0,"00000002"\n');
  else if(cmd=='AT+CGDCONT?;+CGACT?') print('+CGDCONT: 1,"IPV4V6","'+state.uci.apn+'","0.0.0.0"\n+CGACT: 1,'+(state.up?1:0)+'\n');
  else die('UNEXPECTED AT '+cmd);
} else if(kind=='ifup'||kind=='ifdown') {
  if(args[0]!='wwan')die('INTERFACE VIOLATION');
  state.up=kind=='ifup';push(state.calls,kind+' wwan');store();
} else if(kind=='ubus') {
  let net={interface:'wwan',proto:'qmi',up:state.up,pending:false,l3_device:'wwan0','ipv4-address':state.up?[{address:'192.0.2.2',mask:24}]:[]};
  print(sprintf('%J',index(args,'dump')>=0?{interface:[net]}:net));
} else if(kind=='ip') print(state.up?'2: wwan0 inet 192.0.2.2/24 scope global wwan0\n':'');
`
const manager = wwanManager.replaceAll("'/etc/cpe-status", `'${root}/persistent`)
  .replaceAll("'/usr/share/cpe-status/apns.json'", `'${root}/apns.json'`)
  .replace('!stat(port)', `!stat('${root}/present')`).replace('while (true) { tick(); sleep(2000); }', 'tick();')
const control = modemControl.replace("mkdir('/etc/cpe-status', 0700);", `mkdir('${root}/persistent', 0700);`)
const files = { control, reader: apnReader, manager, fake }
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const script = ['set -eu', 'umask 077', `mkdir -p ${root}/cache ${root}/persistent ${root}/bin`,
  ...Object.entries(files).flatMap(([name, content], i) => [`cat >${root}/${name} <<'CPE_APN_${i}'`, content, `CPE_APN_${i}`, `chmod 700 ${root}/${name}`, `ucode -c -o /dev/null ${root}/${name}`]),
  ...['uci','sms_tool','ifup','ifdown','ubus','ip'].flatMap(name => [`printf '#!/bin/sh\nexec ${root}/fake ${name} "$@"\n' >${root}/bin/${name}`, `chmod 700 ${root}/bin/${name}`]),
  `export CPE_STATUS_CACHE=${root}/cache CPE_STATUS_CONFIG=${root}/config.json CPE_STATUS_APN_OVERRIDES=${root}/persistent/overrides.json CPE_APN_TEST=${root} CPE_STATUS_APN_SCRIPT=${root}/reader`,
  `export PATH=${root}/bin:"$PATH"`,
  `echo '${JSON.stringify({ device: '/dev/ttyUSB2', networkInterface: 'wwan' })}' >${root}/config.json`,
  `echo '${JSON.stringify({ up: true, calls: [], uci: { proto: 'qmi', apn: 'old-apn', pdptype: 'ipv4', auth: 'none', auto: '0', modes: 'lte,5gnr', plmn: '0' } })}' >${root}/state.json`,
  `echo '>>> initial'; ${root}/reader`,
  `echo '>>> invalid'; ${root}/control apn '{}'`,
  `now=$(date +%s); printf '%s' ${quote(JSON.stringify({ id: '1-1', device: '/dev/ttyUSB2', interface: 'wwan', kind: 'apn', target: settings, status: 'pending' }).replace(/}$/, ',"started":'))}"$now"'}' >${root}/cache/control-1-1.json`,
  `${root}/control --run 1-1`,
  `echo '>>> result'; cat ${root}/cache/control-1-1.json; echo`,
  `echo '>>> state'; cat ${root}/state.json; echo`,
  `echo '>>> override'; cat ${root}/persistent/overrides.json; echo`,
  `echo '>>> reader'; ${root}/reader`,
  `touch ${root}/present; echo '[]' >${root}/apns.json; ${root}/manager`,
  `echo '>>> restart'; cat ${root}/state.json; echo`,
  `echo 1 >${root}/no-sim`,
  `now=$(date +%s); printf '%s' ${quote(JSON.stringify({ id: '1-2', device: '/dev/ttyUSB2', interface: 'wwan', kind: 'apn', target: { ...settings, apn: 'bad.apn' }, status: 'pending' }).replace(/}$/, ',"started":'))}"$now"'}' >${root}/cache/control-1-2.json`,
  `${root}/control --run 1-2`,
  `echo '>>> nosim'; cat ${root}/cache/control-1-2.json; echo; cat ${root}/state.json; echo`,
  `echo '{"device":"/dev/ttyUSB2","networkInterface":"wan"}' >${root}/config.json`,
  `echo '>>> confinement'; ${root}/reader`,
  `echo '>>> done'`,
].join('\n') + '\n'
const child = spawn('ssh', ['-o','BatchMode=yes','-o','ConnectTimeout=8','-o','UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts','root@192.168.2.248','sh -s'], { windowsHide: true, stdio: ['pipe','pipe','pipe'] })
child.stdin.end(script)
let output = '', errors = ''
child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { errors += data })
const timeout = setTimeout(() => child.kill(), 90000)
const code = await new Promise(resolve => child.on('close', resolve)); clearTimeout(timeout)
await mkdir('build/router-audit', { recursive: true }); await writeFile('build/router-audit/apn-check.txt', output + '\n' + errors)
assert.equal(code, 0, errors + output)
const section = (name: string) => output.split('>>> ' + name + '\n')[1]?.split('>>> ')[0].trim()
const value = (name: string) => JSON.parse(section(name)!)
assert.equal(value('invalid').status, 'error')
assert.equal(value('result').status, 'ok', section('result'))
assert.deepEqual(value('result').data.settings, settings)
assert.equal(value('reader').data.active_apn, settings.apn)
assert.deepEqual(value('override')['8985200123456789012'], settings)
assert.deepEqual(value('state').calls, ['ifdown wwan','ifup wwan'])
assert.equal(value('state').uci.modes, 'lte,5gnr'); assert.equal(value('state').uci.plmn, '0')
assert.deepEqual(value('restart').uci, value('state').uci, 'automatic manager preserves manual per-SIM APN')
assert.deepEqual(value('restart').calls, value('state').calls, 'manager restart does not redial active valid connection')
const noSim = section('nosim')!.split('\n').map(row => JSON.parse(row))
assert.equal(noSim[0].status, 'error'); assert.equal(noSim[1].uci.apn, settings.apn)
assert.equal(value('confinement').status, 'error')
assert.ok(value('reader').data.logs.some((line: string) => line.includes('连接成功')))
assert.ok(!JSON.stringify(value('reader').data.logs).includes(settings.password))
console.log('APN ucode: validation, quoted credentials, save/readback/redial, active PDP, logs, per-SIM persistence, no-SIM rejection and wwan confinement passed.')
