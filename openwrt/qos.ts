import { statusRuntime } from './status-collector.ts'

// Shared by every plugin-owned wwan dial path. Waiting for QoS itself here
// would deadlock: the bearer message may only be emitted after dialing.
export const qosDialRuntime = String.raw`
function prepareQosDial() {
  if (iface != 'wwan' || !profile?.diagQos || config.moduleQos === false || !profileEnabled('diagQos')) return;
  let helper = getenv('CPE_STATUS_QOS_SCRIPT') || '/usr/libexec/cpe-status-qos';
  if (!match(helper, /^\/[a-zA-Z0-9_./-]+$/)) return;
  bounded(helper + ' prepare', 8);
}
`

// LuCI reads the router cache only. The separate procd task owns ADB and never
// issues AT, toggles RF, changes UCI, or installs persistent module files.
export const qosHelper = statusRuntime + String.raw`
mkdir(directory, 0700);
const statePath = directory + '/qos-state.json', resultPath = directory + '/qos.json';
function reply(value) { print(sprintf('%J\n', value)); }
function available() { return config.moduleQos !== false && profile?.diagQos?.transport == 'adb-diag-socket' && profileEnabled('diagQos') && stat('/usr/bin/adb'); }
function serial() {
  let path = realpath('/sys/class/tty/' + substr(port,5) + '/device') || '';
  while (length(path) > 4) {
    if (lc(text(path + '/idVendor') + text(path + '/idProduct')) == usbId) {
      let value = text(path + '/serial');
      return match(value, /^[a-zA-Z0-9_.:-]{1,64}$/) ? value : '';
    }
    let end = rindex(path,'/'); if (end < 0) break; path=substr(path,0,end);
  }
  return '';
}
function remote(id, cmd, seconds) { return bounded('/usr/bin/adb -s ' + profileQuote(id) + ' shell ' + profileQuote(cmd) + ' 2>/dev/null', seconds || 3); }
function remoteJSON(id, path) { try { return json(remote(id, 'cat ' + path, 3)); } catch(e) { return null; } }
function state(status, extra) { save(statePath, { status, checked:time(), profile_key:profileKey, ...(extra || {}) }); }
function apn(value) { return replace(lc(value || ''), /\.mnc[0-9]+\.mcc[0-9]+\.gprs$/, ''); }
function readResult() {
  let value=readJSON(resultPath), current=readJSON(statePath), sim=readJSON(directory + '/sim-identity.json');
  if (!available()) return { status:'unsupported', message:'Not applicable', display:'-' };
  let target=trim(bounded('uci -q get network.wwan.apn',2));
  if (value?.profile_key == profileKey && value.serial == serial() && value.boot_id == current?.boot_id && (!value.iccid || !sim?.iccid || value.iccid == sim.iccid) && value.apn && apn(value.apn) == apn(target)) return { status:'ok', data:value.data, sampled_at:value.sampled_at, source:'module-nas-cache' };
  return { status:'ok', data:{qci:null,dl_speed:null,ul_speed:null}, pending:true };
}
if ((ARGV[0] || 'read') == 'read') { reply(readResult()); exit(0); }
function collecting(current) {
  return current?.status == 'collecting' && current.profile_key == profileKey && current.worker_pid && stat('/proc/' + current.worker_pid);
}
if (ARGV[0] == 'arm' || ARGV[0] == 'prepare') {
  if (available()) {
    let current=readJSON(statePath), requested=readJSON(directory + '/qos-request.json');
    // Reuse a running listener or an already queued request. Repeated dial
    // preparation must not queue another 90-second collection behind it.
    if (!collecting(current) && (!requested || requested.id == current?.request_id)) save(directory + '/qos-request.json', { id:time()+'-'+pid });
  }
  if (ARGV[0] == 'arm') { reply({ status:available()?'ok':'unsupported' }); exit(0); }
}
// Called only before a natural data activation. A late/unavailable ADB must
// never stop dialing; the wait is bounded and cached QoS never causes RF work.
if (ARGV[0] == 'wait' || ARGV[0] == 'prepare') {
  let requested=readJSON(directory + '/qos-request.json'), current=readJSON(statePath);
  let pending=requested && requested.id != current?.request_id;
  if (!available() || (!pending && current?.status != 'collecting' && readResult().data?.qci)) exit(0);
  let until=time()+6;
  while (time()<until) {
    let current=readJSON(statePath);
    if (collecting(current)) {
      let ready=null;
      try { ready=json(remote(current.serial,'cat /tmp/cpe-status-qos/status.json',min(2,max(1,until-time())))); } catch(e) {}
      if (ready?.boot_id == current.boot_id && ready.run_id == current.run_id && ready.status == 'listening') { reply({status:'ok'}); exit(0); }
    }
    if (time()<until) command('sleep 1');
  }
  reply({status:'deferred'}); exit(0);
}
if (ARGV[0] != 'tick') exit(1);
if (!available()) { state('unsupported'); exit(0); }
let id=serial();
if (!id) { unlink(resultPath); state('waiting'); exit(0); }
let previous=readJSON(statePath), requested=readJSON(directory + '/qos-request.json');
if (previous?.serial == id && previous.profile_key == profileKey && time()-previous.checked < 8 && (!requested || requested.id == previous.request_id)) exit(0);
let boot=trim(remote(id,'cat /proc/sys/kernel/random/boot_id',3));
if (!match(boot,/^[0-9a-f-]{36}$/)) {
  // ADB availability is not the lifetime of a data bearer. Keep the last
  // confirmed boot/cache while this same physical modem remains connected.
  if (previous?.serial == id && previous.profile_key == profileKey && previous.boot_id) {
    previous.checked=time(); previous.adb_available=false; save(statePath,previous);
  } else { unlink(resultPath); state('waiting',{serial:id}); }
  exit(0);
}
let wanted=requested && requested.id != previous?.request_id;
if (previous?.boot_id == boot && previous.serial == id && previous.profile_key == profileKey && !wanted) { previous.checked=time(); previous.adb_available=true; save(statePath,previous); exit(0); }
if (previous?.boot_id != boot || previous.serial != id) unlink(resultPath);
let timeout=profile.diagQos.timeoutSeconds;
if (type(timeout)!='int' || timeout<10 || timeout>90) timeout=90;
let started=time();
let request_id=requested?.id || '';
let run_id=started+'-'+pid;
state('collecting',{serial:id,boot_id:boot,started,request_id,run_id,worker_pid:pid});
let copied=bounded('/usr/bin/adb -s ' + profileQuote(id) + ' push /usr/share/cpe-status/qos-collector.pl /tmp/cpe-status-qos-collector.pl 2>&1 && echo CPE_QOS_PUSHED',5);
if (index(copied,'CPE_QOS_PUSHED')<0) { state('error',{serial:id,boot_id:boot,started,request_id}); exit(0); }
remote(id,'CPE_QOS_TIMEOUT=' + timeout + ' CPE_QOS_RUN_ID=' + run_id + ' perl /tmp/cpe-status-qos-collector.pl',timeout+10);
let captured=remoteJSON(id,'/tmp/cpe-status-qos/result.json'), cleanup=remoteJSON(id,'/tmp/cpe-status-qos/cleanup.json');
if (cleanup?.boot_id != boot || cleanup.run_id != run_id) cleanup=null;
let target=trim(bounded('uci -q get network.wwan.apn',2));
let rows=captured?.boot_id == boot && captured.run_id == run_id && captured.schema_version == 1 ? filter(captured.sessions || [], row => row.kind=='data' && apn(row.apn)==apn(target) && type(row.qci)=='int' && row.qci>=1 && row.qci<=255) : [];
if (length(rows)) {
  let row=rows[length(rows)-1], sim=readJSON(directory + '/sim-identity.json');
  let data={qci:row.qci,dl_speed:type(row.dl_speed)=='int' && row.dl_speed>=0 ? row.dl_speed : null,ul_speed:type(row.ul_speed)=='int' && row.ul_speed>=0 ? row.ul_speed : null};
  save(resultPath,{profile_key:profileKey,serial:id,boot_id:boot,iccid:sim?.iccid || '',apn:target,data,sampled_at:time()*1000});
  state('complete',{serial:id,boot_id:boot,started,request_id,mask_restored:cleanup?.mask_restored});
} else state('no-data',{serial:id,boot_id:boot,started,request_id,mask_restored:cleanup?.mask_restored});
`

export const qosWatch = String.raw`#!/bin/sh
umask 077
trap 'exit 0' TERM INT
while :; do
  /usr/libexec/cpe-status-qos tick >/dev/null 2>&1
  sleep 2
done
`

export const qosRead = '#!/bin/sh\nexec /usr/libexec/cpe-status-qos read\n'
