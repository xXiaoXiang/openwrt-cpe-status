// Isolated ucode integration: fake USB sysfs and ADB, no real modem or writes to UCI.
import { execFileSync } from 'node:child_process'
import { qosHelper } from '../openwrt/qos.ts'
import { rm500qProfile } from '../adapters/rm500q-profile.ts'

const router = process.env.CPE_ROUTER || 'root@192.168.6.248'
const root = '/tmp/cpe-qos-check-' + Date.now()
const ssh = (script: string) => execFileSync('ssh', ['-o','BatchMode=yes','-o','ConnectTimeout=8','-o','UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts',router,'sh -s'], {input:script+'\n',encoding:'utf8',windowsHide:true,timeout:60_000})
const apn = ssh('uci -q get network.wwan.apn').trim()
const fake = String.raw`#!/usr/bin/ucode
import {readfile,writefile,stat,open} from 'fs';
const root=__ROOT__;
function value(path) { try { return json(readfile(root+'/'+path)); } catch(e) { return null; } }
function save(path,v) { writefile(root+'/'+path,sprintf('%J',v)); }
function log(op) { let f=open(root+'/events','a'); f.write(op+'\n'); f.close(); }
const cmd=ARGV[3] || '', boot='11111111-2222-3333-4444-555555555555';
log('adb');
if (ARGV[2]=='wait-for-device') { while (!stat(root+'/online')) sleep(50); exit(0); }
if (ARGV[2]=='push') { log('push'); exit(0); }
if (ARGV[2]!='shell') die('Unexpected adb operation');
if (cmd=='cat /proc/sys/kernel/random/boot_id') { if (stat(root+'/online')) print(boot); exit(0); }
if (index(cmd,'--stop ')>=0) {
  log('stop'); let s=value('module-status'); if (s) { s.status='stopped'; save('module-status',s); } exit(0);
}
let run=match(cmd,/CPE_QOS_RUN_ID=([0-9]+-[0-9]+)/)?.[1];
if (run) {
  log('start'); save('module-status',{schema_version:1,boot_id:boot,run_id:run,status:'listening'});
  exit(0);
}
if (cmd=='cat /tmp/cpe-status-qos/status.json') {
  let s=value('module-status');
  if (s && s.status=='listening' && stat(root+'/finish')) { s.status='complete'; s.frame_count=8; s.reason='fixture bearer'; save('module-status',s); }
  if (s) print(sprintf('%J',s)); exit(0);
}
if (cmd=='cat /tmp/cpe-status-qos/result.json') {
  let s=value('module-status'); if (s && s.status=='complete') print(sprintf('%J',{schema_version:1,boot_id:boot,run_id:s.run_id,sessions:stat(root+'/no-bearer') ? [] : [{kind:'data',apn:__APN__,qci:9,dl_speed:100000,ul_speed:50000}]})); exit(0);
}
if (cmd=='cat /tmp/cpe-status-qos/cleanup.json') {
  let s=value('module-status'); if (s) print(sprintf('%J',{boot_id:boot,run_id:s.run_id,mask_restored:1})); exit(0);
}
die('Unexpected remote command: '+cmd);
`.replace('__ROOT__',JSON.stringify(root)).replace('__APN__',JSON.stringify(apn))
const verify = String.raw`#!/usr/bin/ucode
import {readfile,writefile,stat,unlink,readlink} from 'fs';
const root=__ROOT__, helper=root+'/qos', device=root+'/sys/devices/modem', started=+split(readfile('/proc/uptime'),' ')[0];
function value(path) { try { return json(readfile(root+'/'+path)); } catch(e) { return null; } }
function save(path,v) { writefile(root+'/'+path,sprintf('%J',v)); }
function check(v,m) { if (!v) die(m); }
function clock() { return +split(readfile('/proc/uptime'),' ')[0]; }
function call(args) { check(system(helper+' '+args+' >/dev/null')==0,'helper failed: '+args); }
function waitStatus(wanted) {
  let until=clock()+5;
  while (clock()<until) { let s=value('cache/qos-state.json'); if (s?.status==wanted) return s; sleep(50); }
  die('Did not reach '+wanted+': '+readfile(root+'/cache/qos-state.json')+' '+(readfile(root+'/cache/qos-worker.log') || ''));
}
function events(op) { return length(filter(split(readfile(root+'/events') || '','\n'),s=>s==op)); }
function readQos() { check(system(helper+' read >'+root+'/read-result')==0,'cannot read QoS'); return value('read-result'); }
let before=clock(); call('tick');
check(clock()-before<1,'cold tick blocked on unavailable ADB');
let first=waitStatus('waiting-adb');
save('cache/sim-identity.json',{profile_key:first.profile_key,present:true,iccid:'8985203000000000001',configured:true});
check(system('for i in $(seq 1 16); do '+helper+' tick >/dev/null & done; wait')==0,'concurrent ticks');
check(value('cache/qos-state.json').run_id==first.run_id,'duplicate ADB wait jobs');
first=value('cache/qos-state.json');
check(first.worker_pid && stat('/proc/'+first.worker_pid),'ADB wait worker was not claimed');
let ready=clock(); writefile(root+'/online','yes');
waitStatus('collecting');
while (!value('module-status') && clock()-ready<5) sleep(50);
let latency=clock()-ready;
check(value('module-status')?.status=='listening' && latency<3,'ADB readiness delayed');
check(events('start')==1 && events('push')==1,'duplicate collector');
call('cancel 99999999');
check(value('cache/qos-state.json').run_id==first.run_id && value('cache/qos-state.json').status=='collecting','old monitor cancelled new worker');
call('prepare');
check(value('cache/qos-state.json').run_id==first.run_id && events('start')==1,'dial preparation did not reuse listener');
before=clock(); call('tick');
check(clock()-before<1,'active capture blocked monitor');
// Remove and re-add without changing the module boot. The old router worker
// must not publish, and only the owned module collector may be stopped.
writefile(root+'/cache/qos.json','{"old":true}');
before=clock(); call('hotplug remove /devices/modem 001 001');
check(clock()-before<1 && value('cache/qos-state.json').status=='waiting','disconnect was blocked by capture');
check(!stat(root+'/cache/qos.json'),'disconnect did not invalidate cache');
writefile(device+'/devnum','2'); call('hotplug add /devices/modem 001 002');
let second=waitStatus('collecting'), until=clock()+5;
while (value('module-status')?.run_id!=second.run_id && clock()<until) sleep(50);
check(second.run_id!=first.run_id && events('start')==2 && events('stop')==1,'re-enumeration did not replace owned listener');
call('hotplug remove /devices/modem 001 001');
check(value('cache/qos-state.json').run_id==second.run_id,'late old remove cancelled new session');
writefile(root+'/finish','yes');
let complete=waitStatus('complete');
check(value('cache/qos.json').data.qci==9 && complete.usb_session=='1-2','fresh result missing');
sleep(500);
check(value('cache/qos-state.json').run_id==second.run_id,'old worker overwrote new state');
check(!stat('/proc/'+first.worker_pid),'old worker did not exit');
let sample=value('cache/qos.json'), stable=value('cache/qos-state.json');
stable.checked=0; stable.boot_checked=0; save('cache/qos-state.json',stable); unlink(root+'/online'); call('tick');
check(value('cache/qos.json').sampled_at==sample.sampled_at,'ADB outage cleared valid cache');
stable=value('cache/qos-state.json'); stable.checked=0; stable.boot_checked=0; save('cache/qos-state.json',stable);
writefile(root+'/online','yes'); call('tick');
check(events('start')==2 && value('cache/qos.json').sampled_at==sample.sampled_at,'ADB recovery repeated capture');
stable=value('cache/qos-state.json'); stable.checked=0; stable.boot_checked=0; save('cache/qos-state.json',stable);
save('cache/euicc-cli-download.json',{pid:+readlink('/proc/self'),until:time()+10});
let adbCalls=events('adb'); call('tick');
check(events('adb')==adbCalls,'QoS queried ADB during an eUICC download');
unlink(root+'/cache/euicc-cli-download.json'); call('tick');
check(events('adb')>adbCalls,'QoS did not resume after download completion');
call('arm'); let third=waitStatus('collecting');
check(third.run_id!=second.run_id,'natural redial did not rearm');
waitStatus('complete');
// A new subscription can miss NAS bearer setup during failed/repeated redials.
// The last confirmed result stays visible through capture and no-data results.
let confirmed=value('cache/qos.json');
writefile(root+'/no-bearer','yes'); unlink(root+'/finish'); call('arm');
let empty=waitStatus('collecting');
check(empty.run_id!=confirmed.run_id && readQos().data.qci==9 && readQos().sampled_at==confirmed.sampled_at,'new run ID hid the existing QoS cache');
writefile(root+'/finish','yes'); waitStatus('no-data');
for (let attempt=0; attempt<3; attempt++) {
  check(readQos().data.qci==9 && value('cache/qos.json').run_id==confirmed.run_id,'no-data retry discarded confirmed QoS');
  let launches=events('start'); call('tick');
  check(events('start')==launches,'completed no-data capture retried on its own');
  call('arm'); waitStatus('no-data');
}
check(readQos().sampled_at==confirmed.sampled_at,'failed captures changed confirmed sampling time');
save('cache/qos.json',{...confirmed,apn:'different.apn'});
check(readQos().data.qci==9,'APN change hid ICCID-matched QoS');
for (let key in ['iccid','boot_id','usb_session','serial']) {
  save('cache/qos.json',{...confirmed,[key]:'different-context'});
  check(readQos().pending==true,'cached QoS leaked across '+key);
}
save('cache/qos.json',confirmed); unlink(root+'/no-bearer');
// Service stop/restart must resume an interrupted initial capture when there
// is no valid result. A normal no-data completion must still remain quiescent.
unlink(root+'/finish'); call('arm');
let fourth=waitStatus('collecting'); until=clock()+5;
while (value('module-status')?.run_id!=fourth.run_id && clock()<until) sleep(50);
call('cancel');
check(value('cache/qos-state.json').status=='cancelled','service did not cancel owned worker');
unlink(root+'/cache/qos.json'); call('tick');
let fifth=waitStatus('collecting');
check(fifth.run_id!=fourth.run_id,'cancelled initial capture was not resumed');
writefile(root+'/finish','yes'); waitStatus('complete');
// A profile switch must replace an old listener and bind publication to the
// confirmed target ICCID/APN, even though USB and the module boot are unchanged.
unlink(root+'/finish'); call('arm');
let oldProfile=waitStatus('collecting'); until=clock()+5;
while (value('module-status')?.run_id!=oldProfile.run_id && clock()<until) sleep(50);
save('cache/sim-identity.json',{profile_key:oldProfile.profile_key,iccid:'8985203000000000001',configured:true});
call('prepare-profile 89852000000000000002');
let switched=waitStatus('collecting');
check(switched.run_id!=oldProfile.run_id && switched.target_iccid=='89852000000000000002','profile switch reused the old listener');
check(!stat(root+'/cache/qos.json'),'profile switch retained old QoS cache');
until=clock()+5;
while (value('module-status')?.run_id!=switched.run_id && clock()<until) sleep(50);
writefile(root+'/finish','yes'); waitStatus('waiting-profile');
check(!stat(root+'/cache/qos.json') && value('cache/qos-pending.json').target_iccid=='89852000000000000002','unconfirmed target published or discarded captured QoS');
let starts=events('start'); call('prepare'); call('tick');
check(events('start')==starts && value('cache/qos-state.json').status=='waiting-profile','APN preparation replaced the retained profile capture');
// APN changes do not discard an otherwise valid profile capture or rearm DIAG.
let retained=value('cache/qos-pending.json'); retained.sessions[0].apn='previous.fixture.apn'; save('cache/qos-pending.json',retained);
call('prepare'); call('tick');
check(value('cache/qos-state.json').run_id==switched.run_id && events('start')==starts,'APN mismatch restarted the existing capture');
let legacy=value('cache/qos-state.json'); legacy.status='no-data'; legacy.reason='Target eUICC profile/APN was not confirmed'; legacy.checked=0; legacy.boot_checked=0; legacy.profile_key='old-padding-rule';
save('cache/qos-state.json',legacy); unlink(root+'/cache/qos-pending.json'); call('tick');
check(value('cache/qos-state.json').status=='waiting-profile' && value('cache/qos-pending.json').run_id==switched.run_id,'upgrade did not recover the existing module capture');
save('cache/sim-identity.json',{profile_key:switched.profile_key,iccid:'89852000000000000002',configured:false});
call('tick');
waitStatus('complete');
check(value('cache/qos.json').iccid=='89852000000000000002' && value('cache/qos.json').run_id==switched.run_id && !stat(root+'/cache/qos-pending.json'),'confirmed ICCID QoS was lost while APN configuration was pending');
// The prior release discarded a completed capture solely on APN mismatch.
// Recover its existing module result without opening another DIAG collector.
let rejected=value('cache/qos-state.json'); rejected.status='no-data'; rejected.capture_status='complete'; delete rejected.qos_scope; delete rejected.recovery_checked; rejected.checked=0; rejected.boot_checked=0;
save('cache/qos-state.json',rejected); unlink(root+'/cache/qos.json');
let beforeRecovery=events('start'); call('tick'); waitStatus('complete');
check(value('cache/qos.json').data.qci==9 && events('start')==beforeRecovery,'previous APN-rejected capture was not recovered read-only');
// Unrelated removal and unavailable capability must never open another modem.
call('hotplug remove /devices/other 001 002');
check(value('cache/qos-state.json').status=='complete','unrelated USB removal affected modem');
writefile(device+'/devnum','3');
save('cache/sim-identity.json',{profile_key:switched.profile_key,iccid:'8985203000000000001',configured:true});
call('hotplug add /devices/modem 001 003'); waitStatus('complete');
check(value('cache/qos.json').iccid=='8985203000000000001' && !value('cache/qos-state.json').target_iccid,'new USB session inherited the old target profile');
check(system(helper+' read >'+root+'/read-result')==0 && value('read-result').data.qci==9,'new SIM QoS was hidden by an obsolete profile request');
let launches=events('start'), config=value('config.json'); config.moduleQos=false; save('config.json',config); call('tick');
check(value('cache/qos-state.json').status=='unsupported' && events('start')==launches,'disabled feature launched DIAG');
check(!stat(root+'/cache/qos-dispatch'),'dispatch lock leaked');
print(sprintf('%J\n',{concurrent_requests:16,collectors:events('start'),confirmed_cache_survives_repeated_empty_captures:true,cache_context_isolated:true,iccid_match_ignores_apn:true,apn_pending_does_not_hide_qos:true,apn_rejected_capture_recovered_without_diag:true,profile_switch_clears_old_qos:true,pending_profile_capture_retained:true,legacy_capture_recovered:true,new_sim_ignores_old_profile_request:true,download_pauses_adb:true,adb_online_to_listener_seconds:latency,profile_switch_rearmed:true,profile_identity_confirmed:true,old_worker_rejected:true,usb_generation_isolated:true,monitor_nonblocking:true,service_restart_recovered:true,seconds:clock()-started}));
`.replace('__ROOT__',JSON.stringify(root))
const files: Record<string,string> = {
  qos:qosHelper, 'bin/adb':fake, verify,
  'modem.d/2c7c0800.conf':JSON.stringify(rm500qProfile),
  'config.json':JSON.stringify({device:'/dev/ttyUSB2',networkInterface:'wwan'}),
  'sys/devices/modem/idVendor':'2c7c','sys/devices/modem/idProduct':'0800',
  'sys/devices/modem/serial':'fixture','sys/devices/modem/busnum':'1','sys/devices/modem/devnum':'1',
}
const script = [
  'set -eu','umask 077',
  'mkdir -p '+root+'/cache '+root+'/bin '+root+'/modem.d '+root+'/sys/devices/modem '+root+'/sys/class/tty/ttyUSB2',
  ...Object.entries(files).map(([name,contents]) => "cat > '"+root+'/'+name+"' <<'CPE_QOS_TEST_EOF'\n"+contents+'\nCPE_QOS_TEST_EOF'),
  'ln -s '+root+'/sys/devices/modem '+root+'/sys/class/tty/ttyUSB2/device',
  'chmod +x '+root+'/qos '+root+'/bin/adb',
  'ucode -c -o /dev/null '+root+'/qos',
  'export CPE_STATUS_CACHE='+root+'/cache CPE_STATUS_CONFIG='+root+'/config.json CPE_STATUS_SYSFS='+root+'/sys CPE_STATUS_MODEM_DIRECTORY='+root+'/modem.d',
  'export CPE_STATUS_QOS_SCRIPT='+root+'/qos CPE_STATUS_ADB='+root+'/bin/adb',
  'ucode '+root+'/verify',
  'find '+root+' -type f -exec rm -f {} \\;',
  'find '+root+' -type l -exec rm -f {} \\;',
  'find '+root+' -depth -type d -exec rmdir {} \\;',
].join('\n')
try { console.log(ssh(script)) } catch (error) { console.error('Fixture retained at '+root); throw error }
