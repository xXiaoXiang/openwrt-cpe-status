// Real target ucode, isolated fake sysfs and fake lpac only. No card writes.
import { execFileSync } from 'node:child_process'
import { euiccRead, euiccControl } from '../openwrt/euicc.ts'
import { rm500qProfile } from '../adapters/rm500q-profile.ts'
const router=process.env.CPE_ROUTER || 'root@192.168.6.248'
const root='/tmp/cpe-euicc-check-'+Date.now()
const ssh=(script:string)=>execFileSync('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=8','-o','UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts',router,'sh -s'],{input:script+'\n',encoding:'utf8',windowsHide:true,timeout:90_000})
const mock=String.raw`#!/usr/bin/ucode
import {readfile,writefile,open} from 'fs';
const root=__ROOT__, args=ARGV;
let f=open(root+'/commands','a'); f.write(sprintf('%J\n',args)); f.close();
f=open(root+'/transports','a'); f.write(sprintf('%J\n',{apdu:getenv('LPAC_APDU'),device:getenv('LPAC_APDU_QMI_DEVICE'),slot:getenv('LPAC_APDU_QMI_UIM_SLOT'),http:getenv('LPAC_HTTP'),trace:getenv('CPE_LPAC_TRACE'),tls_verify:getenv('CPE_LPAC_TLS_VERIFY')})); f.close();
let mode=trim(readfile(root+'/mode') || '');
if (mode=='hang' && args[0]=='chip') { system('sleep 60 & echo $! >'+root+'/hung-child; wait'); exit(1); }
let rows=json(readfile(root+'/profiles')), data={}, code=0, message='success';
if (args[0]=='chip') {
  if (mode=='absent') { code=-1; message='euicc_init'; }
  else data={eidValue:'89049032000001000000000000000000',EUICCInfo2:{euiccFirmwareVer:'test'}};
} else if (args[0]=='profile' && args[1]=='list') {
  data=rows;
  if (readfile(root+'/switch-written') && index(['enable-reinit','enable-unreadable'],mode)>=0) {
    let count=+(readfile(root+'/readback-count') || '0')+1; writefile(root+'/readback-count',''+count);
    if (mode=='enable-unreadable' || count<3) { code=-1; message='euicc_init'; data=null; }
  }
}
else if (args[0]=='profile' && args[1]=='nickname') { rows[0].profileNickname=args[3]; writefile(root+'/profiles',sprintf('%J',rows)); }
else if (args[0]=='profile' && args[1]=='enable') {
  if (trim(readfile(root+'/qos-prepare') || '')!='prepare-profile '+args[2]) die('DIAG was not armed before profile enable');
  writefile(root+'/switch-written','yes');
  if (mode!='enable-not-applied') { for (let row in rows) row.profileState=row.iccid==args[2] ? 'enabled' : 'disabled'; writefile(root+'/profiles',sprintf('%J',rows)); }
  if (mode=='enable-reinit') { code=-1; message='euicc_init'; }
}
else if (args[0]=='profile' && args[1]=='delete') { rows=filter(rows,row=>row.iccid!=args[2]); writefile(root+'/profiles',sprintf('%J',rows)); }
else if (args[0]=='notification' && args[1]=='list') data=[{seqNumber:1,iccid:rows[0].iccid,profileManagementOperation:'enable'},{seqNumber:2,iccid:rows[0].iccid,profileManagementOperation:'install'}];
else if (args[0]=='profile' && args[1]=='download') {
  let progress='{"type":"progress","payload":{"code":0,"message":"download","data":null}}\n'; print(progress);
  if (mode=='trace-download') {
    if (getenv('CPE_LPAC_TRACE')!='1') die('STDIO HTTP tracing disabled');
    let fill='x'; for (let i=0;i<15;i++) fill+=fill;
    print(substr(fill,0,32767-length(progress))+'测试\n');
    let rx='ab'; for (let i=0;i<16;i++) rx+=rx;
    print(sprintf('%J\n',{type:'http',direction:'request',payload:{url:'https://example.test/gsma/es9',tx:'7b7d',headers:['Content-Type: application/json']}}));
    print(sprintf('%J\n',{type:'http',direction:'response',payload:{rcode:200,rx}}));
  }
  if (mode=='slow-download') { writefile(root+'/downloading','yes'); sleep(2500); }
  if (mode=='download-error') { code=-1; message='fixture_download_failed'; }
}
else if (!(args[0]=='notification' && args[1]=='remove')) die('Unexpected fixture command');
print('WARNING: fixture warning is not JSON\n');
print(sprintf('%J\n',{type:'lpa',payload:{code,message,data}}));
`.replace('__ROOT__',JSON.stringify(root))
const uci=String.raw`#!/usr/bin/ucode
import {readfile} from 'fs';
const root=__ROOT__, key=ARGV[length(ARGV)-1];
if (key=='network.wwan.proto') print(trim(readfile(root+'/proto') || 'qmi'));
else if (key=='network.wwan.device') print('/dev/null');
else if (key=='lpac.uqmi.uim_slot') print('2');
else die('Unexpected UCI access: '+key);
`.replace('__ROOT__',JSON.stringify(root))
const qos=String.raw`#!/usr/bin/ucode
import {writefile} from 'fs';
writefile(__ROOT__+'/qos-prepare',join(' ',ARGV));
print('{"status":"ok"}\n');
`.replace('__ROOT__',JSON.stringify(root))
const verify=String.raw`#!/usr/bin/ucode
import {readfile,writefile,unlink,stat,popen} from 'fs';
const root=__ROOT__;
function check(v,m) { if (!v) die(m); }
function quote(v) { return "'"+replace(v,/'/g,"'\\''")+"'"; }
function call(write,args) {
  let p=popen(root+(write ? '/control ' : '/read ')+join(' ',map(args,quote)),'r');
  let raw=p.read('all'); p.close(); return json(raw);
}
function wait(key,id) {
  let end=time()+25, v={status:'pending'};
  while (v.status=='pending' && time()<end) { sleep(50); v=call(false,['result',key,id]); }
  return v;
}
function complete(v) {
  let end=time()+25;
  while (v.status=='pending' && time()<end) { sleep(50); v=call(false,['job',v.job_id]); }
  return v;
}
function commands() { return map(filter(split(trim(readfile(root+'/commands') || ''),'\n'),v=>length(v)),v=>json(v)); }
let initial=call(false,['probe']);
check(initial.status=='pending','cold probe must be async');
check(system('for i in $(seq 1 16); do '+root+'/read probe >/dev/null & done; wait')==0,'concurrent probes failed');
let probe=wait('euicc-probe',initial.job_id);
check(probe.status=='ok' && probe.available,'EID not detected');
check(length(filter(commands(),v=>v[0]=='chip'))==1,'duplicate chip query');
check(call(false,['probe']).available,'positive chip cache lost');
let info=call(false,['info']); info=info.status=='pending' ? wait('euicc-info',info.job_id) : info;
check(info.status=='ok' && length(info.data.profiles)==2 && info.data.eid=='89049032000001000000000000000000','info adapter failed');
check(length(filter(commands(),v=>v[0]=='chip'))==1,'profile read repeated chip query');
let transport=json(split(trim(readfile(root+'/transports')),'\n')[0]);
check(transport.apdu=='uqmi' && transport.device=='/dev/null' && transport.slot=='2' && transport.http=='curl','QMI did not override the wrapper default');
check(transport.tls_verify=='1','TLS verification not enabled by default');
check(transport.trace=='0','read-only chip query enabled transport tracing');
let invalid=call(false,['nickname','{}']);
check(invalid.status=='error','read helper accepts writes');
invalid=call(true,['nickname','{"iccid":"invalid","nickname":"x"}']);
check(invalid.status=='error','write validation failed');
let nickname="SIM'香港", body={iccid:'89852000000000000002',nickname};
let nick=complete(call(true,['nickname',sprintf('%J',body)]));
check(nick.status=='ok' && nick.data.nickname==nickname,'quoted UTF-8 nickname failed: '+sprintf('%J',nick));
let remove=complete(call(true,['remove','{"all":true}']));
check(remove.status=='ok' && remove.data.skipped==1 && remove.data.removed[0]==1,'critical notifications were not preserved');
check(!length(filter(commands(),v=>v[0]=='notification' && v[1]=='remove' && v[2]=='2')),'removed critical notification');
let download=complete(call(true,['download','{"activation_code":"LPA:1$example.test$fixture"}']));
check(download.status=='ok' && download.result.code==0 && length(download.events)>=2,'download progress/result missing');
let traceTransports=split(trim(readfile(root+'/transports')),'\n');
check(json(traceTransports[length(traceTransports)-1]).trace=='0','curl download enabled STDIO tracing');
// The submitter is already gone. A separate process polls file-only activity;
// all unrelated reads must keep cached results without executing fake LPAC.
let warm=call(false,['info']); if (warm.status=='pending') warm=wait('euicc-info',warm.job_id);
writefile(root+'/mode','slow-download');
let background=call(true,['download','{"activation_code":"LPA:1$example.test$detached"}']);
for (let i=0;i<100 && !readfile(root+'/downloading');i++) sleep(20);
check(readfile(root+'/downloading') && call(false,['activity']).data.active,'download activity not published');
let running=json(readfile(root+'/cache/read-euicc-write.json')), process=trim(readfile('/proc/'+running.worker+'/stat') || '');
check(+split(substr(process,rindex(process,')')+2),' ')[3]==running.worker,'download worker not detached into its own session');
let during=length(commands()), cachedInfo=call(false,['info']);
check(cachedInfo.status=='ok' && cachedInfo.paused && length(cachedInfo.data.profiles)==2,'download discarded cached profile result');
let blocked=call(false,['notifications']);
check(blocked.paused && length(commands())==during,'download allowed competing LPAC reads');
sleep(2700);
check(call(false,['job',background.job_id]).status=='ok' && !call(false,['activity']).data.active,'download depended on a live observer or leaked activity');
check(length(filter(commands(),v=>v[0]=='profile' && v[1]=='download'))==2,'background download executed more than once');
writefile(root+'/mode','download-error');
let failedDownload=complete(call(true,['download','{"activation_code":"LPA:1$example.test$failure"}']));
check(failedDownload.status=='error' && !call(false,['activity']).data.active && !stat(root+'/cache/lock'),'failed download leaked the refresh pause');
check(call(true,['settings',sprintf('%J',{apdu:'uqmi',http:'stdio',at_device:'/dev/ttyUSB2',wdm_device:'/dev/null',slot:2})]).status=='ok','STDIO fixture settings failed');
writefile(root+'/mode','trace-download');
let traced=complete(call(true,['download','{"activation_code":"LPA:1$example.test$trace"}']));
check(traced.status=='ok' && traced.result.code==0 && traced.events[length(traced.events)-1].type=='lpa','long trace lost final result');
let offset=0, collected='', part=null;
while (!part || part.output_more) {
  part=call(false,['job',traced.job_id,''+offset]);
  check(part.status=='ok' && length(part.output)<=32768 && part.output_offset>offset,'invalid log chunk');
  collected+=part.output; offset=part.output_offset;
}
check(length(collected)>65536 && collected==readfile(root+'/cache/euicc-output-'+traced.job_id),'log chunks repeated, truncated or corrupted UTF-8');
check(index(collected,'"direction": "request"')>=0 && index(collected,'"rx": "abab')>=0 && index(collected,'测试')>=0,'HTTP request/response trace missing');
check(call(false,['job',traced.job_id,'-1']).status=='error','invalid log offset accepted');
check(call(true,['settings',sprintf('%J',{apdu:'auto',http:'curl',at_device:'/dev/ttyUSB2',wdm_device:'/dev/null',slot:2})]).status=='ok','fixture settings restore failed');
writefile(root+'/mode','');
writefile(root+'/cache/qos.json','{"data":{"qci":7}}');
writefile(root+'/cache/apn-active.json','{"active":true,"active_apn":"old.profile.apn"}');
let enabled=complete(call(true,['enable','{"iccid":"89852000000000000002"}']));
check(enabled.status=='ok' && enabled.data.profiles[0].profileState=='enabled','enable did not confirm readback');
let sim=json(readfile(root+'/cache/sim-identity.json'));
check(sim.iccid=='89852000000000000002' && sim.imsi=='' && sim.configured===false && sim.checked==0,'profile identity/APN not invalidated');
check(!stat(root+'/cache/qos.json'),'old profile QoS was retained');
check(!stat(root+'/cache/apn-active.json'),'profile switch retained the old active APN');
let enables=length(filter(commands(),v=>v[0]=='profile' && v[1]=='enable'));
unlink(root+'/switch-written'); unlink(root+'/readback-count'); writefile(root+'/mode','enable-reinit');
let recovered=complete(call(true,['enable','{"iccid":"8985203000000000001"}']));
check(recovered.status=='ok' && recovered.data.confirmed && recovered.data.profiles[1].profileState=='enabled','transient init errors discarded a successful switch');
check(+readfile(root+'/readback-count')==3 && length(filter(commands(),v=>v[0]=='profile' && v[1]=='enable'))==enables+1,'switch was repeated or readback retries were skipped');
unlink(root+'/switch-written'); unlink(root+'/readback-count'); writefile(root+'/mode','enable-unreadable');
writefile(root+'/cache/qos.json','{"iccid":"8985203000000000001","data":{"qci":7}}');
let unconfirmed=complete(call(true,['enable','{"iccid":"89852000000000000002"}']));
check(unconfirmed.status=='unconfirmed' && unconfirmed.message=='判断Profile切换超时，请主动刷新页面' && unconfirmed.data.confirmed===false,'unreadable state was reported as a definite failure');
check(+readfile(root+'/readback-count')==4 && length(filter(commands(),v=>v[0]=='profile' && v[1]=='enable'))==enables+2,'unconfirmed switch did not use exactly four read attempts and one write');
sim=json(readfile(root+'/cache/sim-identity.json'));
check(!stat(root+'/cache/qos.json') && sim.checked==0 && sim.profile_switch_pending=='89852000000000000002','unconfirmed switch retained old QoS or fresh SIM cache');
unlink(root+'/switch-written'); writefile(root+'/mode','enable-not-applied');
let unchanged=complete(call(true,['enable','{"iccid":"8985203000000000001"}']));
check(unchanged.status=='unconfirmed' && unchanged.data.profiles[0].profileState=='enabled' && unchanged.data.profiles[1].profileState=='disabled','unconfirmed response lost the last real profile list');
check(length(filter(commands(),v=>v[0]=='profile' && v[1]=='enable'))==enables+3,'unchanged target caused a repeated write');
writefile(root+'/mode','');
let refused=complete(call(true,['delete','{"iccid":"89852000000000000002"}']));
check(refused.status=='error','enabled profile could be deleted');
unlink(root+'/cache/read-euicc-write.json');
let deleted=complete(call(true,['delete','{"iccid":"8985203000000000001"}']));
check(deleted.status=='ok' && deleted.data.iccid=='8985203000000000001','delete did not confirm readback');
// A different USB devnum invalidates a positive probe and old job results.
writefile(root+'/sys/class/tty/ttyUSB2/device/devnum','2'); writefile(root+'/mode','absent');
unlink(root+'/cache/read-euicc-probe.json');
let absent=call(false,['probe']); absent=wait('euicc-probe',absent.job_id);
check(absent.status=='ok' && absent.available===false,'ordinary SIM did not hide tab');
let count=length(commands()); for (let i=0;i<5;i++) check(call(false,['probe']).available===false,'negative cache missing');
check(length(commands())==count,'ordinary SIM repeatedly probed');
check(call(false,['job',download.job_id]).status=='error','old USB job reused');
writefile(root+'/proto','mbim'); writefile(root+'/mode',''); unlink(root+'/cache/euicc-probe.json'); unlink(root+'/cache/read-euicc-probe.json');
let other=call(false,['probe']); other=wait('euicc-probe',other.job_id);
let transports=split(trim(readfile(root+'/transports')),'\n');
check(other.status=='ok' && json(transports[length(transports)-1]).apdu=='mbim','automatic MBIM selection failed');
let p=popen('CPE_STATUS_LPAC_COMMAND=/missing/lpac '+root+'/read probe','r'), missing=json(p.read('all')); p.close();
check(missing.status=='unsupported' && missing.available===false && missing.installed===false,'cached EID showed tab without installed lpac');
let configured=call(false,['settings']); check(configured.data.apdu=='auto' && configured.data.slot==2,'settings read failed');
let saved=call(true,['settings',sprintf('%J',{apdu:'at',http:'curl',at_device:'/dev/ttyUSB2',wdm_device:'/dev/null',slot:1,tls_verify:false})]);
check(saved.status=='ok','settings save failed');
unlink(root+'/cache/read-euicc-probe.json');
unlink(root+'/cache/read-euicc-info.json');
let manual=call(false,['info']); manual=wait('euicc-info',manual.job_id);
transports=split(trim(readfile(root+'/transports')),'\n');
check(manual.status=='ok' && json(transports[length(transports)-1]).apdu=='at','user transport did not override automatic selection');
check(json(transports[length(transports)-1]).tls_verify=='0' && call(false,['settings']).data.tls_verify===false,'explicit TLS setting not applied or persisted');
check(call(true,['settings',sprintf('%J',{apdu:'at',http:'curl',at_device:'/dev/ttyUSB2',wdm_device:'/dev/null',slot:1,tls_verify:'false'})]).status=='error','invalid TLS setting accepted');
check(call(true,['settings',sprintf('%J',{apdu:'at',http:'curl',at_device:'/dev/ttyUSB2;false',wdm_device:'/dev/null',slot:1})]).status=='error','unsafe port accepted');
writefile(root+'/proto','qmi');
writefile(root+'/mode','hang'); unlink(root+'/cache/euicc-probe.json'); unlink(root+'/cache/read-euicc-probe.json');
let hung=call(false,['probe']); hung=wait('euicc-probe',hung.job_id);
check(hung.status=='error' && index(hung.message,'超时')>=0,'hung lpac was not bounded');
let child=trim(readfile(root+'/hung-child') || ''), ps=readfile('/proc/'+child+'/stat') || '';
check(!length(ps) || index(ps,') Z ')>=0,'lpac descendant survived timeout');
check(!stat(root+'/cache/lock'),'AT lock leaked');
print(sprintf('%J\n',{passed:50,concurrent_probes:16,switch_init_errors_retried:true,switch_four_readbacks_one_write:true,unconfirmed_switch_preserves_real_list:true,unconfirmed_switch_drops_old_qos:true,stdio_http_trace_chunking_verified:true,curl_and_reads_trace_disabled:true,detached_download_verified:true,download_pauses_other_reads:true,failed_download_resumes_reads:true,qmi_override_verified:true,manual_settings_verified:true,tls_setting_verified:true,missing_lpac_hidden:true,diag_precedes_profile_switch:true,profile_identity_invalidated:true,chip_reads_coalesced:true,ordinary_sim_hidden:true,write_paths_mocked_only:true,timeout_killed_descendants:true}));
`.replace('__ROOT__',JSON.stringify(root))
const files:Record<string,string>={read:euiccRead,control:euiccControl,'bin/lpac':'#!/bin/sh\nexport LPAC_APDU=at\nexec '+root+'/bin/lpac-real "$@"\n','bin/lpac-real':mock,'bin/uci':uci,runner:'#!/bin/sh\nexec "$@"\n',qos,verify,'settings.json':JSON.stringify({apdu:'auto',http:'curl',at_device:'/dev/ttyUSB2',wdm_device:'/dev/null',slot:2}),'modem.d/2c7c0800.conf':JSON.stringify(rm500qProfile),'config.json':JSON.stringify({device:'/dev/ttyUSB2'}),'profiles':JSON.stringify([{iccid:'89852000000000000002',profileState:'disabled',profileNickname:null},{iccid:'8985203000000000001',profileState:'enabled',profileNickname:null}]),'sys/class/tty/ttyUSB2/device/idVendor':'2c7c','sys/class/tty/ttyUSB2/device/idProduct':'0800','sys/class/tty/ttyUSB2/device/serial':'fake','sys/class/tty/ttyUSB2/device/busnum':'1','sys/class/tty/ttyUSB2/device/devnum':'1'}
const script=['set -eu','umask 077','mkdir -p '+root+'/cache '+root+'/bin '+root+'/modem.d '+root+'/sys/class/tty/ttyUSB2/device',
...Object.entries(files).map(([name,body])=>"cat > '"+root+'/'+name+"' <<'CPE_EUICC_FILE_EOF'\n"+body+'\nCPE_EUICC_FILE_EOF'),
'chmod +x '+root+'/read '+root+'/control '+root+'/bin/lpac '+root+'/bin/lpac-real '+root+'/bin/uci '+root+'/runner '+root+'/qos',
'ucode -c -o /dev/null '+root+'/read','ucode -c -o /dev/null '+root+'/control',
'export CPE_STATUS_CACHE='+root+'/cache CPE_STATUS_CONFIG='+root+'/config.json CPE_STATUS_SYSFS='+root+'/sys CPE_STATUS_MODEM_DIRECTORY='+root+'/modem.d',
'export CPE_STATUS_EUICC_READ='+root+'/read CPE_STATUS_EUICC_CONTROL='+root+'/control CPE_STATUS_LPAC_NATIVE='+root+'/bin/lpac-real CPE_STATUS_QOS_SCRIPT='+root+'/qos PATH='+root+'/bin:"$PATH"',
'export CPE_STATUS_EUICC_SETTINGS='+root+'/settings.json CPE_STATUS_LPAC_RUNNER='+root+'/runner',
'ucode '+root+'/verify',
'find '+root+' -type f -exec rm -f {} \\;','find '+root+' -depth -type d -exec rmdir {} \\;'].join('\n')
try { console.log(ssh(script)) } catch(e) { console.error('Fixture retained at '+root); throw e }
