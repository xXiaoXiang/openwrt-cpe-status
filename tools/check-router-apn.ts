import { profileFixture, profileFingerprint } from './profile-fixture.ts'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { modemControl } from '../openwrt/modem-control.ts'
import { apnReader,apnRuntime } from '../openwrt/apn-control.ts'
import { statusRuntime } from '../openwrt/status-collector.ts'
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
  if(readfile(root+'/forbid-at')) die('APN deletion unexpectedly sent AT');
  let cmd=args[length(args)-1];
  if(cmd=='AT+CGMM') print('RM500Q-GL\n');
  else if(cmd=='AT+CPIN?;+QCCID') print(readfile(root+'/no-sim')?'+CME ERROR: 10\n':'+CPIN: READY\n+QCCID: '+(state.sim_iccid || '8985200123456789012')+'F\n');
  else if(cmd=='AT+CFUN?') print('+CFUN: 1\n');
  else if(cmd=='AT+CIMI') print((state.sim_imsi || '454001234567890')+'\n');
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
const control = modemControl.replaceAll("'/etc/cpe-status", `'${root}/persistent`)
const reader=apnReader.replaceAll("'/etc/cpe-status", `'${root}/persistent`)
const history=statusRuntime+apnRuntime+String.raw`
const target=__SETTINGS__, iccid='8985200123456789012', legacy='8985200987654321098';
apnRemember(iccid,target); apnRemember(iccid,{...target,apn:uc(target.apn)});
apnRemember(iccid,{...target,apn:'second.apn',pdptype:'ipv4'}); apnRemember(iccid,target);
let records=readJSON(apnOverridePath); records[legacy]=target; save(apnOverridePath,records);
apnRemember(legacy,{...target,apn:'legacy.new'});
print(sprintf('%J\n',{records:readJSON(apnOverridePath),catalog:apnCatalog()}));
`.replace('__SETTINGS__',JSON.stringify(settings))
const qos = '#!/usr/bin/ucode\nimport {open} from "fs"; let f=open("' + root + '/diag-called","a"); f.write("called\\n"); f.close(); print(\'{"status":"ok"}\\n\');\n'
const cachecheck=statusRuntime+apnRuntime+String.raw`
function check(value,message) {if(!value)die(message);}
const sim=readJSON(directory+'/sim-identity.json'), raw='+CGDCONT: 1,"IP","global.apn","0.0.0.0"\n+CGACT: 1,1\n';
let identity=apnActiveIdentity(); apnSaveActive(raw,identity);
check(apnCachedActive()?.active_apn=='global.apn','current APN result did not cache');
check(apnActive('+CGDCONT: 1,"IP","old.profile.apn","0.0.0.0"\n+CGACT: 1,1\n').active===false,'old single PDP context was labelled current');
save(directory+'/sim-identity.json',{...sim,iccid:'8985200999999999999'});
check(!apnCachedActive(),'old ICCID active APN leaked');
unlink(directory+'/apn-active.json'); apnSaveActive(raw,identity);
check(!stat(directory+'/apn-active.json'),'in-flight old SIM result republished');
save(directory+'/sim-identity.json',sim); apnSaveActive(raw,identity);
save(directory+'/sim-identity.json',{...sim,configured:false,profile_switch_pending:'8985200999999999999'});
check(apnIdentityPending() && !apnCachedActive(),'switch-pending reused old APN');
save(directory+'/sim-identity.json',sim);
let network=readJSON(getenv('CPE_APN_TEST')+'/state.json'); network.uci.pdptype='ipv4v6'; save(getenv('CPE_APN_TEST')+'/state.json',network);
check(!apnCachedActive(),'old PDP protocol reused');
network.uci.pdptype='ipv4'; network.uci.apn='other.apn'; save(getenv('CPE_APN_TEST')+'/state.json',network);
check(!apnCachedActive(),'old APN name reused');
print(sprintf('%J\n',{sim_bound_cache:true,pending_switch_hides_old_apn:true,stale_worker_rejected:true,protocol_bound_cache:true,apn_bound_cache:true,old_single_context_rejected:true}));
`
const reconnect=statusRuntime+apnRuntime+String.raw`
const path=getenv('CPE_APN_TEST')+'/state.json', network=readJSON(path), sim=readJSON(directory+'/sim-identity.json'), iccid='8985200999999999999';
network.sim_iccid=iccid; network.sim_imsi='454031234567890'; network.calls=[]; save(path,network);
sim.usb_token='previous-usb-session'; sim.checked=time(); sim.configured=true; save(directory+'/sim-identity.json',sim);
apnRemember(iccid,{apn:'new.sim.apn',pdptype:'ipv4',auth:'none',username:'',password:''});
save(readPath('apn'),{id:time()+'-'+pid,key:'apn',device:port,profile_key:profileKey,status:'pending',state:'queued',queued:readClock(),priority:0});
if (!manualReadPending()) die('test did not queue a manual read');
`
const deletecheck=statusRuntime+apnRuntime+String.raw`
const root=getenv('CPE_APN_TEST'), sim=readJSON(directory+'/sim-identity.json'), iccid=sim.iccid, other='8985200888888888888';
const first={apn:'personal.apn',pdptype:'ipv4',auth:'none',username:'',password:''}, second={...first,pdptype:'ipv4v6'};
function check(value,message) {if(!value)die(message);}
function call(id,target) {let p=popen(root+'/control apn-delete '+apnQuote(sprintf('%J',{iccid:id,settings:target})),'r'), raw=p.read('all');p.close();return json(raw);}
let original={[iccid]:{...first,custom_apn:[first,second]},[other]:{...first}};
save(apnOverridePath,original); writefile(root+'/forbid-at','yes');
let before=text(root+'/state.json'), database=text(root+'/apns.json'), active=text(directory+'/apn-active.json');
save(directory+'/qos.json',{iccid,data:{qci:9}}); let qos=text(directory+'/qos.json');
check(call(other,first).status=='error' && text(apnOverridePath)==sprintf('%J',original),'another SIM record was deleted');
check(call(iccid,{...first,apn:'database.apn'}).deleted===false,'database/nonpersonal APN treated as a custom record');
mkdir(directory+'/lock',0700);writefile(directory+'/lock/pid',''+pid);
check(call(iccid,first).status=='deferred','delete ignored shared write lock');unlink(directory+'/lock/pid');rmdir(directory+'/lock');
let removed=call(iccid,first), rows=readJSON(apnOverridePath);
check(removed.status=='ok' && removed.deleted && rows[iccid].pdptype=='ipv4v6' && length(rows[iccid].custom_apn)==1,'selected APN delete removed another protocol or failed to select remaining record');
check(rows[other].apn==first.apn,'another ICCID lost its personal APN');
check(call(iccid,first).deleted===false,'repeated deletion was not idempotent');
check(call(iccid,second).deleted && !readJSON(apnOverridePath)[iccid],'last custom record left a selected override');
check(!length(filter(call(iccid,second).data.choices,item=>item.source=='custom')),'deleted record remained in dropdown catalog');
save(directory+'/sim-identity.json',{...sim,iccid:other});check(call(other,first).deleted && !readJSON(apnOverridePath)[other],'legacy personal APN could not be deleted');
save(directory+'/sim-identity.json',sim);writefile(apnOverridePath,'invalid json');
check(call(iccid,first).status=='error' && text(apnOverridePath)=='invalid json','malformed custom file overwritten');
check(text(root+'/state.json')==before && text(root+'/apns.json')==database && text(directory+'/apn-active.json')==active && text(directory+'/qos.json')==qos,'delete changed dialing, database or APN/QCI cache');
check(!stat(directory+'/lock'),'delete leaked common lock');
print(sprintf('%J\n',{exact_parameters_deleted:true,other_sim_preserved:true,last_override_removed:true,legacy_record_supported:true,stale_sim_rejected:true,shared_lock_respected:true,idempotent:true,malformed_file_preserved:true,no_at_or_redial:true}));
`
const files = { control, reader, manager, fake, history, qos, cachecheck, reconnect, deletecheck }
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const script = [profileFixture(root),'set -eu', 'umask 077', `mkdir -p ${root}/cache ${root}/persistent ${root}/bin`,
  ...Object.entries(files).flatMap(([name, content], i) => [`cat >${root}/${name} <<'CPE_APN_${i}'`, content, `CPE_APN_${i}`, `chmod 700 ${root}/${name}`, `ucode -c -o /dev/null ${root}/${name}`]),
  ...['uci','sms_tool','ifup','ifdown','ubus','ip'].flatMap(name => [`printf '#!/bin/sh\nexec ${root}/fake ${name} "$@"\n' >${root}/bin/${name}`, `chmod 700 ${root}/bin/${name}`]),
  `export CPE_STATUS_CACHE=${root}/cache CPE_STATUS_CONFIG=${root}/config.json CPE_STATUS_APN_OVERRIDES=${root}/persistent/overrides.json CPE_APN_TEST=${root} CPE_STATUS_APN_SCRIPT=${root}/reader`,
  `export CPE_STATUS_APN_DB_ROOT=${root} CPE_STATUS_APN_DATABASE=${root}/persistent/database.json CPE_STATUS_APN_PROTOCOL=${root}/persistent/dualstack_toone.json`,
  `export CPE_STATUS_QOS_SCRIPT=${root}/qos`,
  `export PATH=${root}/bin:"$PATH"`,
  `echo '${JSON.stringify({ device: '/dev/ttyUSB2', networkInterface: 'wwan', moduleQos: true })}' >${root}/config.json`,
  `echo '${JSON.stringify({ up: true, calls: [], uci: { proto: 'qmi', apn: 'old-apn', pdptype: 'ipv4', auth: 'none', auto: '0', modes: 'lte,5gnr', plmn: '0' } })}' >${root}/state.json`,
  `printf '%s' '{"apns":[]}' >${root}/persistent/apns.local.json`,
  `echo '>>> initial'; ${root}/reader`,
  `echo '>>> invalid'; ${root}/control apn '{}'`,
  `now=$(date +%s); printf '%s' ${quote(JSON.stringify({ id: '1-1', profile_key: profileFingerprint(), device: '/dev/ttyUSB2', interface: 'wwan', kind: 'apn', target: settings, status: 'pending' }).replace(/}$/, ',"started":'))}"$now"'}' >${root}/cache/control-1-1.json`,
  `${root}/control --run 1-1`,
  `echo '>>> result'; cat ${root}/cache/control-1-1.json; echo`,
  `echo '>>> state'; cat ${root}/state.json; echo`,
  `echo '>>> override'; cat ${root}/persistent/overrides.json; echo`,
  `echo '>>> reader'; ${root}/reader`,
  `touch ${root}/present; echo '[]' >${root}/apns.json; ${root}/manager`,
  `echo '>>> restart'; cat ${root}/state.json; echo`,
  `echo '>>> history'; ucode ${root}/history`,
  `ucode -e ${quote(`import {readfile,writefile} from 'fs'; let path='${root}/cache/sim-identity.json', sim=json(readfile(path)); sim.profile_changed=true; sim.configured=false; sim.checked=0; sim.imsi=''; writefile(path,sprintf('%J',sim));`)}`,
  `${root}/manager`,
  `echo '>>> profile'; cat ${root}/state.json; echo`,
  `echo 1 >${root}/no-sim`,
  `now=$(date +%s); printf '%s' ${quote(JSON.stringify({ id: '1-2', profile_key: profileFingerprint(), device: '/dev/ttyUSB2', interface: 'wwan', kind: 'apn', target: { ...settings, apn: 'bad.apn' }, status: 'pending' }).replace(/}$/, ',"started":'))}"$now"'}' >${root}/cache/control-1-2.json`,
  `${root}/control --run 1-2`,
  `echo '>>> nosim'; cat ${root}/cache/control-1-2.json; echo; cat ${root}/state.json; echo`,
  `echo '{"device":"/dev/ttyUSB2","networkInterface":"wan"}' >${root}/config.json`,
  `echo '>>> confinement'; ${root}/reader`,
  `echo '${JSON.stringify({device:'/dev/ttyUSB2',networkInterface:'wwan',moduleQos:true})}' >${root}/config.json`,
  `rm -f ${root}/no-sim ${root}/cache/sim-identity.json`,
  `echo '{}' >${root}/persistent/overrides.json`,
  `echo '${JSON.stringify([{carrier:'Global fixture',mcc:'454',mnc:'00',apn:'global.apn',protocol:'IPV4V6',user:'global.user',password:'global.pass',authtype:'2'}])}' >${root}/apns.json`,
  `echo '${JSON.stringify({schema_version:1,rules:{'454-00-global.apn':{mcc:'454',mnc:'00',apn:'global.apn',pdptype:'ipv4'}}})}' >${root}/persistent/dualstack_toone.json`,
  `echo '${JSON.stringify({up:false,calls:[],uci:{proto:'qmi',apn:'previous.apn',pdptype:'ipv4v6',auth:'none',auto:'0',modes:'lte,5gnr',plmn:'0'}})}' >${root}/state.json`,
  `${root}/manager`,
  `echo '>>> persisted-protocol'; cat ${root}/state.json; echo`,
  `echo '>>> cache'; ${root}/cachecheck`,
  `${root}/reconnect; ${root}/manager`,
  `echo '>>> reconnect'; cat ${root}/state.json; echo; cat ${root}/cache/sim-identity.json; echo`,
  `echo '>>> delete'; ${root}/deletecheck`,
  `test ! -e ${root}/diag-called || { echo 'APN unexpectedly started DIAG'; exit 1; }`,
  `echo '>>> done'`,
  `find ${root} -type f -exec rm -f {} \\;`, `find ${root} -depth -type d -exec rmdir {} \\;`,
].join('\n') + '\n'
const child = spawn('ssh', ['-o','BatchMode=yes','-o','ConnectTimeout=8','-o','UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts','root@192.168.6.248','sh -s'], { windowsHide: true, stdio: ['pipe','pipe','pipe'] })
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
assert.deepEqual(value('override')['8985200123456789012'], {...settings,custom_apn:[settings]})
assert.deepEqual(value('state').calls, ['ifdown wwan','ifup wwan'])
assert.equal(value('state').uci.modes, 'lte,5gnr'); assert.equal(value('state').uci.plmn, '0')
assert.deepEqual(value('restart').uci, value('state').uci, 'automatic manager preserves manual per-SIM APN')
assert.deepEqual(value('restart').calls, value('state').calls, 'manager restart does not redial active valid connection')
const historyResult=value('history')
assert.equal(historyResult.records['8985200123456789012'].custom_apn.length,2,'duplicate save created another custom APN')
assert.equal(historyResult.records['8985200987654321098'].custom_apn.length,2,'legacy selected APN was not retained')
assert.equal(historyResult.catalog.preferred.apn,settings.apn,'selected custom APN lost priority')
assert.equal(historyResult.catalog.choices.filter((row:{source:string})=>row.source==='custom').length,2,'saved choices lost')
assert.ok(!historyResult.catalog.choices.some((row:{settings:{apn:string}})=>row.settings.apn==='legacy.new'),'another ICCID APN leaked')
assert.deepEqual(value('profile').calls, [...value('state').calls, 'ifdown wwan', 'ifup wwan'], 'profile change must renew wwan even when APN is unchanged')
assert.deepEqual(value('profile').uci, value('state').uci, 'profile renewal changed APN/network mode/operator configuration')
const noSim = section('nosim')!.split('\n').map(row => JSON.parse(row))
assert.equal(noSim[0].status, 'error'); assert.equal(noSim[1].uci.apn, settings.apn)
assert.equal(value('confinement').status, 'error')
assert.ok(value('reader').data.logs.some((line: string) => line.includes('连接成功')))
assert.ok(!JSON.stringify(value('reader').data.logs).includes(settings.password))
assert.equal(value('persisted-protocol').uci.pdptype,'ipv4','fresh manager did not apply persisted protocol before dialing')
assert.equal(value('persisted-protocol').uci.apn,'global.apn')
assert.equal(value('persisted-protocol').uci.auth,'chap')
assert.equal(value('persisted-protocol').uci.password,'global.pass','protocol correction changed global credentials')
assert.deepEqual(value('persisted-protocol').calls,['ifup wwan'],'boot-time protocol correction did not dial once')
assert.equal(value('cache').stale_worker_rejected,true)
const reconnection=section('reconnect')!.split('\n').map(row=>JSON.parse(row))
assert.equal(reconnection[0].uci.apn,'new.sim.apn','USB/SIM change did not bypass 30-second SIM cooldown and queued manual read')
assert.equal(reconnection[1].iccid,'8985200999999999999')
assert.notEqual(reconnection[1].usb_token,'previous-usb-session')
assert.deepEqual(reconnection[0].calls,['ifdown wwan','ifup wwan'])
assert.equal(value('delete').no_at_or_redial,true)
console.log('APN ucode: persistence, protocol correction, SIM-bound cache, precise personal-APN deletion, wwan confinement and no APN-triggered DIAG passed.')
