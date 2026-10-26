import { profileFixture } from './profile-fixture.ts'
import { spawn } from 'node:child_process'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { messaging } from '../openwrt/messaging.ts'
import { wwanManager } from '../openwrt/wwan-manager.ts'
import { speedSampler, speedSettings } from '../openwrt/speed-sampler.ts'
import { statusCollector } from '../openwrt/status-collector.ts'
import { compileApns } from '../shared/apn.ts'

// Execute generated ucode on the target with fake AT, UCI and ifup/down.
// All fixture/state paths are under one /tmp directory; no real network writes.
const root = '/tmp/cpe-services-check-' + process.pid
const fake = String.raw`#!/usr/bin/ucode
import {readfile,writefile} from 'fs';
let root=getenv('CPE_SERVICES_TEST'), args=ARGV, kind=args[0];
writefile(root+'/calls',(readfile(root+'/calls')||'')+join(' ',args)+'\n');
if(kind=='sms_tool') {
  let cmd=args[length(args)-1];
  if(cmd=='recv') {print(index(args,'SM')>=0 ? '{"msg":[]}' : readfile(root+'/messages.json'));exit(0);}
  if(index(args,'send')>=0) {print('sms sent successfully: 1\n');exit(0);}
  if(cmd=='AT+CGMM') print('RM500Q-GL\n');
  else if(cmd=='AT+CPIN?;+QCCID') print('+CPIN: READY\n+QCCID: 8985200123456789012\n');
  else if(cmd=='AT+CIMI') print('454001234567890\n');
  else if(cmd=='AT+CRSM=176,28589,0,0,4') print('+CRSM: 144,0,"00000002"\n');
  else if(cmd=='AT+CRSM=176,28478,0,0,1') print('+CRSM: 144,0,"FF"\n');
  else if(cmd=='AT+CRSM=176,28486,0,0,17') print('+CRSM: 144,0,"004C75636B7932FFFFFFFFFFFFFFFFFFFF"\n');
  else if(cmd=='AT+CFUN?') print('+CFUN: 1\n');
  else if(index(cmd,'AT+CPIN?;+CSQ')==0) print('+CPIN: READY\n+CSQ: 20,99\n+COPS: 0,2,"45400",7\n+CEREG: 2,1\n+C5GREG: 2,4\n+QSPN: "CSL","CSL","CSL",0,"45400"\n');
  else if(index(cmd,'AT+QENG="servingcell"')==0) print('+QENG: "servingcell","NOCONN","LTE","FDD",454,00,31E7C20,323,1400,3,5,5,452,-95,-13,-62,10,6,230,-\n');
  else if(cmd=='AT+QTEMP') print('+QTEMP: "tsens_tz_sensor1",38\n');
  else if(index(cmd,'AT+CGMI;')==0) print('Quectel\nRM500Q-GL\nRM500QGLABR13A03M4G\n123456789012345\n');
  else if(cmd=='AT+CNUM;+CSCA?') print('+CSCA: "+85212345678",145\n');
  else if(cmd=='AT+QNWPREFCFG="roam_pref"') print('+QNWPREFCFG: "roam_pref",255\n');
  else if(cmd=='AT+QNWPREFCFG="mode_pref"') print('+QNWPREFCFG: "mode_pref",LTE:NR5G\n');
  else print('ERROR\n');
} else if(kind=='uci') {
  let path=root+'/uci.json', state=json(readfile(path)), action=args[1];
  if(action=='-q') {let key=replace(args[3],'network.wwan.','');if(index(args[3],'network.wwan.')!=0)die('INTERFACE VIOLATION');print(state[key]||'');}
  else if(action=='set') {let pair=split(args[2],'='),key=replace(pair[0],'network.wwan.','');if(index(args[2],'network.wwan.')!=0)die('INTERFACE VIOLATION');state[key]=join('=',slice(pair,1));writefile(path,sprintf('%J',state));}
  else if(action!='commit'||args[2]!='network')die('Invalid UCI action');
} else if(kind=='ifup'||kind=='ifdown') {if(args[1]!='wwan')die('INTERFACE VIOLATION');}
else if(kind=='ubus') print('{"proto":"qmi","up":true}');
else if(kind=='gcom') print('Quectel\nOK\n');
`
let manager = wwanManager.replaceAll("'/etc/cpe-status", `'${root}/persistent`).replaceAll("'/usr/share/cpe-status/apns.json'", `'${root}/apns.json'`)
manager = manager.replace('!stat(port)', `!stat('${root}/modem-present')`).replace('  net(\'ifdown\');\n  let startup', '  /* Test only: preserve fixture between single ticks. */\n  let startup')
manager = manager.replace("  if (startup) { startup.configured = false; startup.checked = 0; save(directory + '/sim-identity.json', startup); }", '')
manager = manager.replace('while (true) { tick(); sleep(2000); }', 'tick();')
const files = { messaging, manager, speed: speedSampler, 'speed-settings': speedSettings, collector: statusCollector, fake }
const entries = compileApns(await readFile('data/apns-conf_8.xml', 'utf8'))
const script = [profileFixture(root),'set -eu', 'umask 077', `mkdir -p ${root}/bin ${root}/cache ${root}/persistent`,
  ...Object.entries(files).flatMap(([name, content], i) => [`cat > ${root}/${name} <<'CPE_SERVICE_${i}'`, content, `CPE_SERVICE_${i}`, `chmod 700 ${root}/${name}`, `ucode -c -o /dev/null ${root}/${name}`]),
  ...['sms_tool', 'uci', 'ifup', 'ifdown', 'gcom', 'ubus'].flatMap(name => [`printf '#!/bin/sh\nexec ${root}/fake ${name} "$@"\n' > ${root}/bin/${name}`, `chmod 700 ${root}/bin/${name}`]),
  `printf '%s' '{"apns":[]}' >${root}/persistent/apns.local.json`,
  `cat >${root}/apns.json <<'CPE_APNS'`, JSON.stringify(entries), 'CPE_APNS',
  `printf '%s' '{"proto":"qmi","apn":"old-apn","modes":"lte,5gnr"}' >${root}/uci.json`,
  `printf '%s' '{"device":"/dev/ttyUSB2","networkInterface":"wwan","smsStorage":"${root}/sms"}' >${root}/config.json`,
  `export CPE_STATUS_CACHE=${root}/cache CPE_STATUS_CONFIG=${root}/config.json CPE_SERVICES_TEST=${root}`,
  `export PATH=${root}/bin:"$PATH"`,
  `touch ${root}/modem-present`,
  `echo '>>> apn'; ${root}/manager; cat ${root}/cache/wwan-manager.json; echo`,
  `echo '>>> config'; cat ${root}/uci.json; echo`,
  `echo '>>> calls'; cat ${root}/calls`,
  `rm ${root}/cache/sim-identity.json`,
  `printf '%s' '{"proto":"qmi","apn":"internet","pdptype":"ipv4","auth":"none","auto":"0","modes":"lte,5gnr"}' >${root}/uci.json`,
  `cp ${root}/calls ${root}/calls-before-adopt`,
  `echo '>>> adopt'; ${root}/manager; cat ${root}/uci.json; echo`,
  `echo '>>> adoptcalls'; tail -n +$(($(wc -l < ${root}/calls-before-adopt)+1)) ${root}/calls`,
  `printf '%s' '{"device":"/dev/ttyUSB2","networkInterface":"wan"}' >${root}/config.json`,
  `echo '>>> confinement'; ${root}/manager || true; cat ${root}/cache/wwan-manager.json; echo`,
  `printf '%s' '{"device":"/dev/ttyUSB2","networkInterface":"wwan","smsStorage":"/etc/cpe-status/sms"}' >${root}/config.json`,
  // Test archive uses /root-style persistent path validation but rewrites just
  // the storagePath restriction in this isolated executable to allow /tmp.
  `sed -i 's/(tmp|var|proc|sys|dev|www|rom)/(var|proc|sys|dev|www|rom)/' ${root}/messaging`,
  `printf '%s' '{"device":"/dev/ttyUSB2","networkInterface":"wwan","smsStorage":"${root}/sms"}' >${root}/config.json`,
  `printf '%s' '{"msg":[{"index":1,"sender":"+85212345678","timestamp":"2026-10-26T00:00:00Z","content":"你好"}]}' >${root}/messages.json`,
  `echo '>>> sms'; ${root}/messaging list`,
  `echo '>>> cached'; ${root}/messaging list`,
  `echo '>>> path'; ${root}/messaging config ${root}/sms-new`,
  `echo '>>> moved'; ${root}/messaging list`,
  `echo '>>> badpath'; ${root}/messaging config /proc/unsafe`,
  `echo '>>> clear'; ${root}/messaging clear; ${root}/messaging sync`,
  `echo '>>> at'; ${root}/messaging at AT+CGMM`,
  `export CPE_STATUS_SCRIPT=${root}/collector`,
  `echo '>>> collector'; ${root}/collector --refresh`,
  `cp ${root}/calls ${root}/calls-before-cache`,
  `ucode -e 'import {readfile,writefile} from "fs";let p=getenv("CPE_STATUS_CACHE")+"/snapshot.json",s=json(readfile(p));s.host.time=0;s.sampled.status=time()-3;s.sampled.cells=time()-4;writefile(p,sprintf("%J",s));'`,
  `echo '>>> refresh'; ${root}/collector --refresh`,
  `echo '>>> querydelta'; tail -n +$(($(wc -l < ${root}/calls-before-cache)+1)) ${root}/calls`,
  `echo '>>> speed'; ${root}/speed-settings 1000; ${root}/speed & sampler=$!; sleep 2; kill "$sampler"; cat ${root}/cache/speed.json; echo`,
  `echo '>>> done'`,
].join('\n') + '\n'
const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts', 'root@192.168.6.248', 'sh -s'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
child.stdin.end(script)
let stdout = '', stderr = ''
child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
const timer = setTimeout(() => child.kill(), 90000)
const code = await new Promise(resolve => child.on('close', resolve)); clearTimeout(timer)
await mkdir('build/router-audit', { recursive: true }); await writeFile('build/router-audit/services-check.txt', stdout + '\n' + stderr)
assert.equal(code, 0, stderr + stdout)
const section = (name: string) => stdout.split('>>> ' + name + '\n')[1]?.split('>>> ')[0].trim()
const value = (name: string) => JSON.parse(section(name)!)
assert.equal(value('apn').status, 'ready', section('apn'))
assert.equal(value('config').apn, 'internet')
assert.equal(value('config').auto, '0')
assert.equal(value('config').modes, 'lte,5gnr')
assert.ok(section('calls')!.lastIndexOf('uci commit network') < section('calls')!.indexOf('ifup wwan'))
assert.equal(value('adopt').pdptype, 'ipv4')
assert.equal(value('adopt').auth, 'none')
assert.ok(!section('adoptcalls')?.includes('ifdown'))
assert.ok(!section('adoptcalls')?.includes('ifup'))
assert.equal(value('confinement').status, 'error')
assert.equal(value('sms').data[0].content, '你好')
assert.equal(value('cached').data.length, 1)
assert.equal(value('path').status, 'ok')
assert.equal(value('moved').data.length, 1)
assert.equal(value('badpath').status, 'error')
const cleared = section('clear')!.split('\n').map(line => JSON.parse(line)); assert.deepEqual(cleared[1].data, [])
assert.equal(value('at').status, 'ok')
assert.ok(value('at').data.includes('Quectel'))
assert.deepEqual(value('collector').warnings || {}, {})
for (const group of ['radio', 'identity', 'sim', 'roaming', 'mode']) assert.equal(value('collector').sampled[group], value('refresh').sampled[group], group)
assert.equal(value('refresh').sampled.cells, value('refresh').host.time - 4)
assert.ok(section('querydelta')?.includes('AT+CPIN?;+CSQ'))
assert.ok(!section('querydelta')?.includes('AT+QENG='))
assert.ok(!section('querydelta')?.includes('AT+CIMI'))
const speed = JSON.parse(section('speed')!.split('\n').slice(1).join('\n'))
assert.ok(speed.time - speed.previous_time >= 0.45 && speed.time - speed.previous_time < 0.8)
console.log('Router services: ucode compilation, APN ordering/confinement, durable SMS archive/dedup/migration/clear and 0.5s sampler passed.')
