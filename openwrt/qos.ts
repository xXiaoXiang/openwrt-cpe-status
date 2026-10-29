import { statusRuntime } from './status-collector.ts'

export const qosDialRuntime = String.raw`
function prepareQosCapture(action) {
  if (iface != 'wwan' || !profile?.diagQos || config.moduleQos === false || !profileEnabled('diagQos')) return {status:'unsupported'};
  let helper=getenv('CPE_STATUS_QOS_SCRIPT') || '/usr/libexec/cpe-status/qos';
  if (match(helper,/^\/[a-zA-Z0-9_./-]+$/)) {
    let raw=bounded(helper+' '+action,index(action,'prepare-profile ')==0 ? 24 : 8);
    try { return json(raw); } catch(e) {}
  }
  return {status:'deferred'};
}
function prepareQosDial() { prepareQosCapture('prepare'); }
function prepareQosProfile(iccid) {
  if (!match(iccid || '',/^[0-9]{18,22}$/)) die('Invalid QoS profile identity');
  return prepareQosCapture('prepare-profile '+iccid);
}
`

// Short dispatcher and detached worker share no AT lock. USB monitoring stays
// responsive throughout ADB readiness and the 90-second DIAG capture.
export const qosHelper = statusRuntime + String.raw`
mkdir(directory,0700);
const statePath=directory+'/qos-state.json', resultPath=directory+'/qos.json', pendingPath=directory+'/qos-pending.json';
const self=getenv('CPE_STATUS_QOS_SCRIPT') || '/usr/libexec/cpe-status/qos';
const adb=getenv('CPE_STATUS_ADB') || '/usr/bin/adb';
if (!match(self,/^\/[a-zA-Z0-9_./-]+$/) || !match(adb,/^\/[a-zA-Z0-9_./-]+$/)) die('Invalid QoS executable');
function reply(value) { print(sprintf('%J\n',value)); }
function available() { return config.moduleQos !== false && profile?.diagQos?.transport == 'adb-diag-socket' && profileEnabled('diagQos') && stat(adb); }
function device() {
  let root=getenv('CPE_STATUS_SYSFS') || '/sys';
  let path=realpath(root+'/class/tty/'+substr(port,5)+'/device') || '';
  while (length(path)>length(root)) {
    if (lc(text(path+'/idVendor')+text(path+'/idProduct')) == usbId) {
      let id=text(path+'/serial'), bus=text(path+'/busnum'), number=text(path+'/devnum');
      if (!match(id,/^[a-zA-Z0-9_.:-]{1,64}$/) || !match(bus,/^[0-9]+$/) || !match(number,/^[0-9]+$/)) return null;
      return {serial:id,usb_path:path,usb_session:(+bus)+'-'+(+number)};
    }
    let end=rindex(path,'/'); if (end<0) break; path=substr(path,0,end);
  }
  return null;
}
function pauseForDownload() { while (downloadActivity().active) sleep(250); }
function remote(id, cmd, seconds) { pauseForDownload(); return bounded(adb+' -s '+profileQuote(id)+' shell '+profileQuote(cmd)+' 2>/dev/null',seconds || 3); }
function remoteJSON(id,path) { try { return json(remote(id,'cat '+path,2)); } catch(e) { return null; } }
function state(status,extra) { save(statePath,{...(extra || {}),status,checked:time(),profile_key:profileKey}); }
function dataBearers(sessions) { return filter(sessions || [],row => row.kind=='data' && type(row.qci)=='int' && row.qci>=1 && row.qci<=255); }
function same(current,dev) { return dev && current?.profile_key == profileKey && current.serial == dev.serial && current.usb_session == dev.usb_session; }
function simSession(sim,dev) { return dev && (!sim?.usb_token || sim.usb_token==join(':',split(dev.usb_session,'-'))+':'+dev.serial); }
function active(current) {
  return index(['waiting-adb','collecting'],current?.status)>=0
    && (current.worker_pid ? !!stat('/proc/'+current.worker_pid) : time()-current.started<5);
}
function readResult() {
  let value=readJSON(resultPath), current=readJSON(statePath), sim=readJSON(directory+'/sim-identity.json'), requested=readJSON(directory+'/qos-request.json');
  if (!available()) return {status:'unsupported',message:'Not applicable',display:'-'};
  let dev=device(), expected=current?.target_iccid;
  if (requested && requested.id!=current?.request_id && requested.serial==dev?.serial && requested.usb_session==dev?.usb_session) expected=requested.target_iccid;
  let profileMatches=simSession(sim,dev) && sim?.present!==false && !sim?.profile_switch_pending && value?.iccid && value.iccid==sim?.iccid && (!expected || value.iccid==expected);
  // A later subscription may finish without a new bearer. Its run ID must not
  // hide a confirmed result for this same USB session, module boot and ICCID.
  // Worker publication still requires an exact run ID in currentJob().
  if (profileMatches && same(value,dev) && value.boot_id == current?.boot_id) return {status:'ok',data:value.data,sampled_at:value.sampled_at,source:'module-nas-cache'};
  return {status:'ok',data:{qci:null,dl_speed:null,ul_speed:null},pending:true};
}
// Keep a completed NAS capture on the router while LPAC/SIM confirmation
// catches up. It must survive the collector stopping and temporary init errors.
function settlePending(current,dev) {
  let value=readJSON(pendingPath), sim=readJSON(directory+'/sim-identity.json');
  if (!same(value,dev) || value.run_id != current.run_id || value.boot_id != current.boot_id || value.request_id != current.request_id) return false;
  if (!simSession(sim,dev) || sim?.present===false || sim?.profile_switch_pending || !match(sim?.iccid || '',/^[0-9]{18,22}$/) || (value.target_iccid && sim.iccid!=value.target_iccid)) return false;
  let rows=dataBearers(value.sessions);
  if (length(rows)) {
    let row=rows[length(rows)-1];
    let data={qci:row.qci,dl_speed:type(row.dl_speed)=='int' && row.dl_speed>=0 ? row.dl_speed : null,ul_speed:type(row.ul_speed)=='int' && row.ul_speed>=0 ? row.ul_speed : null};
    save(resultPath,{profile_key:profileKey,...dev,boot_id:value.boot_id,run_id:value.run_id,request_id:value.request_id,iccid:sim.iccid,apn:row.apn,data,sampled_at:value.sampled_at});
    state('complete',{...current,...value.outcome});
  } else state(value.outcome?.capture_status=='error' ? 'error' : 'no-data',{...current,...value.outcome});
  unlink(pendingPath); return true;
}
if ((ARGV[0] || 'read') == 'read') { reply(readResult()); exit(0); }
// Only state transitions hold this gate, never wait-for-device or DIAG.
const gate=directory+'/qos-dispatch';
function enter() {
  for (let i=0; i<50; i++) {
    if (mkdir(gate,0700)) { writefile(gate+'/pid',''+pid); return true; }
    let owner=+text(gate+'/pid'), info=stat(gate);
    if (info && time()-info.mtime>=2 && (!owner || !stat('/proc/'+owner))) { unlink(gate+'/pid'); rmdir(gate); }
    sleep(10);
  }
  return false;
}
function leave() { if (+text(gate+'/pid') == pid) { unlink(gate+'/pid'); rmdir(gate); } }
function schedule() {
  if (downloadActivity().active) return;
  if (!enter()) return;
  try {
    let dev=device(), previous=readJSON(statePath), requested=readJSON(directory+'/qos-request.json');
    // The ICCID-padding rule fix changes the adapter fingerprint. Preserve
    // only this known, recoverable raw NAS capture after checking the same
    // physical USB session and module boot; ordinary old caches stay invalid.
    if (dev && available() && previous?.profile_key!=profileKey && previous?.serial==dev.serial && previous?.usb_session==dev.usb_session
        && previous.status=='no-data' && previous.reason=='Target eUICC profile/APN was not confirmed' && previous.target_iccid && requested?.id==previous.request_id) {
      let boot=trim(remote(dev.serial,'cat /proc/sys/kernel/random/boot_id',1));
      if (boot && boot==previous.boot_id) {
        previous.profile_key=profileKey; previous.checked=0; previous.boot_checked=0; save(statePath,previous); unlink(resultPath);
      }
    }
    if (!dev) {
      unlink(resultPath); unlink(pendingPath);
      if (previous?.status != 'waiting') state('waiting');
    } else if (!available()) state('unsupported',dev);
    else if (!(same(previous,dev) && active(previous))) {
      let wanted=requested && requested.id != previous?.request_id;
      let waiting=same(previous,dev) && previous.status=='waiting-profile' && !wanted;
      let retry=same(previous,dev) && previous.status == 'error' && previous.attempts<3 && time()-previous.checked>=2;
      let interrupted=same(previous,dev) && (index(['waiting-adb','collecting'],previous?.status)>=0 || retry
        || (previous.status == 'cancelled' && !same(readJSON(resultPath),dev)));
      // New USB sessions and pending requests bypass the stable boot-check TTL.
      let recent=same(previous,dev) && previous.boot_id && time()-(previous.boot_checked || previous.checked)<8;
      if (!recent || wanted || interrupted || waiting) {
        let checkBoot=!recent || wanted || interrupted;
        let boot=same(previous,dev) && previous.boot_id ? checkBoot ? trim(remote(dev.serial,'cat /proc/sys/kernel/random/boot_id',1)) : previous.boot_id : '';
        if (boot && boot == previous?.boot_id && !wanted && !interrupted) {
          previous.checked=time(); if (checkBoot) previous.boot_checked=time(); previous.adb_available=true; save(statePath,previous);
          // Upgrade recovery: older workers discarded a valid module capture
          // solely because SIM confirmation had not finished within 30 seconds.
          if (previous.status=='no-data' && previous.target_iccid && !previous.recovery_checked
              && (previous.reason=='Target eUICC profile/APN was not confirmed' || (previous.capture_status=='complete' && previous.qos_scope!='iccid'))) {
            previous.recovery_checked=true; save(statePath,previous);
            let captured=remoteJSON(dev.serial,'/tmp/cpe-status-qos/result.json'), cleanup=remoteJSON(dev.serial,'/tmp/cpe-status-qos/cleanup.json');
            if (captured?.boot_id==boot && captured.run_id==previous.run_id && captured.schema_version==1) {
              save(pendingPath,{...previous,sessions:captured.sessions || [],sampled_at:previous.checked*1000,outcome:{reason:'Recovered cached profile bearer',mask_restored:cleanup?.boot_id==boot && cleanup.run_id==previous.run_id ? cleanup.mask_restored : null}});
              previous.status='waiting-profile'; save(statePath,previous); waiting=true;
            }
          }
          if (waiting) settlePending(previous,dev);
        } else if (!boot && same(previous,dev) && previous.boot_id && !wanted && !interrupted) {
          previous.checked=time(); previous.adb_available=false; save(statePath,previous);
        } else {
          if (!same(previous,dev) || (boot && boot != previous?.boot_id)) unlink(resultPath);
          unlink(pendingPath);
          let run_id=time()+'-'+pid;
          state('waiting-adb',{...dev,run_id,started:time(),request_id:requested?.id || '',worker_pid:null,
            target_iccid:wanted && requested?.usb_session == dev.usb_session && requested?.serial == dev.serial ? requested.target_iccid : interrupted ? previous.target_iccid : null,qos_scope:'iccid',
            boot_id:boot || (same(previous,dev) ? previous.boot_id : null),boot_checked:boot ? time() : null,attempts:retry ? previous.attempts+1 : 1,
            monitor_pid:+text(directory+'/qos-monitor.pid')});
          system(self+' capture '+run_id+' </dev/null >'+directory+'/qos-worker.log 2>&1 &');
        }
      }
    }
  } catch(e) { leave(); die(e); }
  leave();
}
if (ARGV[0] == 'hotplug') {
  let root=getenv('CPE_STATUS_SYSFS') || '/sys', action=ARGV[1], path=root+(ARGV[2] || '');
  if (length(ARGV)!=5 || index(['add','remove'],action)<0 || !match(ARGV[2],/^\/devices\/[a-zA-Z0-9_./:-]+$/) || index(path,'..')>=0 || !match(ARGV[3],/^[0-9]+$/) || !match(ARGV[4],/^[0-9]+$/)) exit(1);
  let session=(+ARGV[3])+'-'+(+ARGV[4]);
  if (action == 'remove') {
    if (enter()) {
      let current=readJSON(statePath);
      // A delayed remove for an old devnum cannot cancel a newer connection.
      if (current?.usb_path == path && current.usb_session == session) { unlink(resultPath); unlink(pendingPath); state('waiting'); }
      leave();
    }
  } else {
    // usb_device add precedes tty creation. This bounded bootstrap is detached
    // from hotplug and ignores devices unrelated to the configured AT port.
    for (let i=0; i<50 && stat(path); i++) {
      refreshProfile(); let dev=device();
      if (dev?.usb_path == path && dev.usb_session == session) { schedule(); break; }
      sleep(100);
    }
  }
  exit(0);
}
if (ARGV[0] == 'cancel') {
  if (length(ARGV)>2 || (ARGV[1] && !match(ARGV[1],/^[1-9][0-9]*$/))) exit(1);
  let current=null;
  if (enter()) {
    current=readJSON(statePath);
    // A late shutdown trap from an old procd instance must not cancel the
    // replacement instance's worker or remove its monitor PID marker.
    if (ARGV[1] && +text(directory+'/qos-monitor.pid') != +ARGV[1]) { leave(); exit(0); }
    if (active(current)) state('cancelled',{...current,status:'cancelled'});
    leave();
  }
  if (same(current,device()) && current.run_id && current.boot_id && match(current.run_id,/^[0-9]+-[0-9]+$/)) remote(current.serial,'perl /tmp/cpe-status-qos-collector.pl --stop '+current.run_id,7);
  exit(0);
}
let profilePrepare=ARGV[0] == 'prepare-profile';
if (profilePrepare && (length(ARGV)!=2 || !match(ARGV[1],/^[0-9]{18,22}$/))) exit(1);
if (ARGV[0] == 'arm' || ARGV[0] == 'prepare' || profilePrepare) {
  if (available() && enter()) {
    let current=readJSON(statePath), requested=readJSON(directory+'/qos-request.json'), dev=device();
    let waiting=same(current,dev) && current.status=='waiting-profile', retained=waiting ? readJSON(pendingPath) : null;
    // A retained capture belongs to the confirmed ICCID regardless of APN.
    // APN configuration and protocol recovery never call this entry point.
    let reuse=waiting && same(retained,dev) && retained.run_id==current.run_id && retained.request_id==current.request_id
      && retained.boot_id==current.boot_id && length(dataBearers(retained.sessions));
    if (profilePrepare && dev) {
      unlink(resultPath);
      // A listener from the old profile must not complete this request. The
      // new worker stops only our previous module collector before subscribing.
      if (!(same(current,dev) && active(current) && current.target_iccid == ARGV[1])) {
        if (same(current,dev) && active(current)) state('superseded',current);
        save(directory+'/qos-request.json',{id:time()+'-'+pid,...dev,target_iccid:ARGV[1]});
      }
    } else if (!(same(current,dev) && (active(current) || reuse)) && (!requested || requested.id == current?.request_id)) save(directory+'/qos-request.json',{id:time()+'-'+pid,...(waiting ? {...dev,target_iccid:current.target_iccid} : {})});
    leave();
  }
  schedule();
  if (ARGV[0] == 'arm') { reply({status:available()?'ok':'unsupported'}); exit(0); }
}
if (ARGV[0] == 'wait' || ARGV[0] == 'prepare' || profilePrepare) {
  let requested=readJSON(directory+'/qos-request.json'), current=readJSON(statePath);
  let pending=requested && requested.id != current?.request_id;
  if (!profilePrepare && !pending && current?.status=='waiting-profile') { reply({status:'ok',captured:true}); exit(0); }
  if (!available() || (!pending && !active(current) && readResult().data?.qci)) exit(0);
  let until=time()+(profilePrepare ? 20 : 6);
  while (time()<until) {
    current=readJSON(statePath);
    if (same(current,device()) && active(current) && current.status == 'collecting') {
      let ready=null;
      try { ready=json(remote(current.serial,'cat /tmp/cpe-status-qos/status.json',min(2,max(1,until-time())))); } catch(e) {}
      if (ready?.boot_id == current.boot_id && ready.run_id == current.run_id && ready.status == 'listening') { reply({status:'ok'}); exit(0); }
    }
    sleep(100);
  }
  reply({status:'deferred'}); exit(0);
}
if (ARGV[0] == 'tick') { schedule(); exit(0); }
if (ARGV[0] != 'capture' || length(ARGV)!=2 || !match(ARGV[1],/^[0-9]+-[0-9]+$/)) exit(1);
let job=null;
if (!enter()) exit(0);
job=readJSON(statePath);
if (job?.run_id != ARGV[1] || job.status != 'waiting-adb' || (job.worker_pid && stat('/proc/'+job.worker_pid))) { leave(); exit(0); }
job.worker_pid=pid; save(statePath,job); leave();
function currentJob() {
  let current=readJSON(statePath);
  return same(job,device()) && current?.run_id == job.run_id && current.worker_pid == pid && index(['waiting-adb','collecting'],current.status)>=0;
}
function publish(status,extra) {
  if (!enter()) return;
  if (currentJob()) state(status,{...job,...(extra || {}),status});
  leave();
}
try {
  let boot='', until=time()+90;
  while (currentJob() && time()<until) {
    pauseForDownload();
    bounded(adb+' -s '+profileQuote(job.serial)+' wait-for-device 2>/dev/null',2);
    if (!currentJob()) exit(0);
    boot=trim(remote(job.serial,'cat /proc/sys/kernel/random/boot_id',1));
    if (match(boot,/^[0-9a-f-]{36}$/)) break;
    sleep(100);
  }
  if (!currentJob()) exit(0);
  if (!match(boot,/^[0-9a-f-]{36}$/)) { publish('waiting',{reason:'ADB did not become ready'}); exit(0); }
  job.boot_id=boot; job.boot_checked=time(); publish('collecting');
  pauseForDownload();
  let copied=bounded(adb+' -s '+profileQuote(job.serial)+' push /usr/libexec/cpe-status/qos-collector.pl /tmp/cpe-status-qos-collector.pl 2>&1 && echo CPE_QOS_PUSHED',5);
  if (!currentJob()) exit(0);
  if (index(copied,'CPE_QOS_PUSHED')<0) die('Cannot copy DIAG collector');
  let old=remoteJSON(job.serial,'/tmp/cpe-status-qos/status.json');
  // Re-enumeration need not reboot the module. Let only our previous collector
  // restore its mask before replacing its diagnostic subscription.
  if (old?.boot_id == boot && old.run_id != job.run_id && index(['starting','listening'],old.status)>=0 && match(old.run_id,/^[0-9]+-[0-9]+$/)) remote(job.serial,'perl /tmp/cpe-status-qos-collector.pl --stop '+old.run_id,7);
  if (!currentJob()) exit(0);
  let timeout=profile.diagQos.timeoutSeconds;
  if (type(timeout)!='int' || timeout<10 || timeout>90) timeout=90;
  remote(job.serial,'(trap "" HUP; CPE_QOS_TIMEOUT='+timeout+' CPE_QOS_RUN_ID='+job.run_id+' perl /tmp/cpe-status-qos-collector.pl </dev/null >/tmp/cpe-status-qos-collector.log 2>&1 &)',3);
  until=time()+timeout+15;
  let status=null;
  while (currentJob() && time()<until) {
    status=remoteJSON(job.serial,'/tmp/cpe-status-qos/status.json');
    if (status?.boot_id == boot && status.run_id == job.run_id && index(['complete','timeout','error','stopped'],status.status)>=0) break;
    sleep(250);
  }
  if (!currentJob()) exit(0);
  let captured=remoteJSON(job.serial,'/tmp/cpe-status-qos/result.json'), cleanup=remoteJSON(job.serial,'/tmp/cpe-status-qos/cleanup.json');
  if (cleanup?.boot_id != boot || cleanup.run_id != job.run_id) cleanup=null;
  let sessions=captured?.boot_id == boot && captured.run_id == job.run_id && captured.schema_version == 1 ? captured.sessions || [] : [];
  if (enter()) {
    if (currentJob()) {
      let outcome={mask_restored:cleanup?.mask_restored,capture_status:status?.run_id == job.run_id ? status.status : 'error',reason:status?.run_id == job.run_id ? status.reason : 'Collector did not complete',frame_count:status?.run_id == job.run_id ? status.frame_count : 0};
      save(pendingPath,{...job,sessions,sampled_at:time()*1000,outcome});
      state('waiting-profile',{...job,...outcome});
      settlePending(readJSON(statePath),device());
    }
    leave();
  }
} catch(e) { publish('error',{reason:''+e}); }
`

export const qosWatch = String.raw`#!/bin/sh
umask 077
mkdir -p /tmp/cpe-status
echo $$ > /tmp/cpe-status/qos-monitor.pid
trap '/usr/libexec/cpe-status/qos cancel "$$" >/dev/null 2>&1; [ "$(cat /tmp/cpe-status/qos-monitor.pid 2>/dev/null)" != "$$" ] || rm -f /tmp/cpe-status/qos-monitor.pid; exit 0' TERM INT
while :; do
  /usr/libexec/cpe-status/qos tick >/dev/null 2>&1
  sleep 2
done
`

// Never hold OpenWrt hotplug while waiting for ADB or DIAG.
export const qosHotplug = String.raw`#!/bin/sh
[ "$DEVTYPE" = usb_device ] || exit 0
case "$ACTION" in add|remove) ;; *) exit 0 ;; esac
monitor=$(cat /tmp/cpe-status/qos-monitor.pid 2>/dev/null)
case "$monitor" in ''|*[!0-9]*) exit 0 ;; esac
kill -0 "$monitor" 2>/dev/null || exit 0
case "$(tr '\000' ' ' </proc/$monitor/cmdline 2>/dev/null)" in
  *'/usr/libexec/cpe-status/qos-watch'*) ;; *) exit 0 ;;
esac
/usr/libexec/cpe-status/qos hotplug "$ACTION" "$DEVPATH" "$BUSNUM" "$DEVNUM" </dev/null >/dev/null 2>&1 &
`

export const qosRead = '#!/bin/sh\nexec /usr/libexec/cpe-status/qos read\n'
