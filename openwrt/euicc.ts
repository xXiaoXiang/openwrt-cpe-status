import { statusRuntime } from './status-collector.ts'
import { qosDialRuntime } from './qos.ts'

// Optional PATH lpac, explicit per-plugin transport settings and stdio relay.
const runtime = String.raw`
mkdir(directory,0700);
const lpac=getenv('CPE_STATUS_LPAC_COMMAND') || trim(command('command -v lpac'));
const probePath=directory+'/euicc-probe.json';
const settingsPath=getenv('CPE_STATUS_EUICC_SETTINGS') || '/etc/cpe-status/euicc.json';
const proto=ARGV[0]=='activity' ? '' : trim(bounded('uci -q get network.'+iface+'.proto',2));
const configuredDevice=ARGV[0]=='activity' ? '' : trim(bounded('uci -q get network.'+iface+'.device',2));
function validateSettings(value) {
  if (type(value)!='object' || index(['auto','at','at_csim','uqmi','qmi','mbim','stdio'],value.apdu)<0 || index(['auto','curl','stdio'],value.http)<0) die('无效的卡片通信模式');
  if (!match(value.at_device || '',/^\/dev\/tty[A-Za-z0-9_.-]+$/) || !match(value.wdm_device || '',/^\/dev\/[a-zA-Z0-9_.:-]{1,64}$/)) die('无效的卡片通信端口');
  if (type(value.slot)!='int' || value.slot<1 || value.slot>5) die('无效的SIM卡槽');
  if (value.tls_verify!=null && type(value.tls_verify)!='bool') die('无效的HTTPS证书设置');
  return {apdu:value.apdu,http:value.http,at_device:value.at_device,wdm_device:value.wdm_device,slot:value.slot,tls_verify:value.tls_verify!==false};
}
const settings=validateSettings(readJSON(settingsPath) || {apdu:'auto',http:'auto',at_device:port,wdm_device:match(configuredDevice,/^\/dev\/[a-zA-Z0-9_.:-]{1,64}$/) ? configuredDevice : '/dev/cdc-wdm0',slot:1});
const effectiveApdu=settings.apdu=='auto' ? proto=='qmi' ? 'uqmi' : proto=='mbim' ? 'mbim' : 'at' : settings.apdu;
const native=getenv('CPE_STATUS_LPAC_NATIVE') || '/usr/lib/lpac/lpac';
const executable=(lpac=='/usr/bin/lpac' || getenv('CPE_STATUS_LPAC_NATIVE')) && stat(native)?.type=='file' ? native : lpac;
const driverHome=executable==native ? substr(native,0,rindex(native,'/')) : '/usr/lib/lpac';
const stdioOnly=!(stat(driverHome+'/driver/driver_http_curl.so') || stat(driverHome+'/driver_http_curl.so')) && (stat(driverHome+'/driver/driver_http_stdio.so') || stat(driverHome+'/driver_http_stdio.so'));
const effectiveHttp=settings.http=='auto' ? stdioOnly ? 'stdio' : 'curl' : settings.http;
function installed() { return match(lpac,/^\/[a-zA-Z0-9_./-]+$/) && stat(lpac)?.type=='file'; }
function settingsReply() {
  return {status:'ok',installed:!!installed(),data:{...settings,effective_apdu:effectiveApdu,effective_http:effectiveHttp,
    ports:{at:uniq([port,'/dev/ttyUSB2',...glob('/dev/ttyUSB*'),...glob('/dev/ttyACM*')]),wdm:uniq(['/dev/cdc-wdm0',...glob('/dev/cdc-wdm*'),...glob('/dev/wwan*qmi*')])}}};
}
function uniq(values) { let result=[]; for (let v in values) if (index(result,v)<0) push(result,v); return result; }
// Expire private task intents/output, including activation codes from a
// submission interrupted before its worker could consume and erase them.
let maintenance=readJSON(directory+'/euicc-cleanup.json');
if (!maintenance || time()-maintenance.time>300) {
  for (let pattern in ['/euicc-job-*','/euicc-output-*']) for (let path in glob(directory+pattern)) if (time()-stat(path).mtime>3600) unlink(path);
  save(directory+'/euicc-cleanup.json',{time:time()});
}
function reply(value) { print(sprintf('%J\n',value)); }
function identity(chipOnly) {
  let root=getenv('CPE_STATUS_SYSFS') || '/sys', path=realpath(root+'/class/tty/'+substr(port,5)+'/device') || '';
  while (length(path)>length(root)) {
    if (stat(path+'/idVendor')) break;
    path=substr(path,0,rindex(path,'/'));
  }
  let sim=readJSON(directory+'/sim-identity.json');
  return profileKey+':'+(chipOnly ? '' : text(settingsPath) || sprintf('%J',settings))+':'+text(path+'/busnum')+':'+text(path+'/devnum')+':'+text(path+'/serial')+':'+(sim?.present === false ? 'absent' : sim?.iccid || 'unknown');
}
function supported() { return installed() && profile && stat(port) && stat('/usr/bin/setsid'); }
function connection() { let token=identity(); return substr(token,0,rindex(token,':')); }
let expectedConnection=null, deadline=0;
function cached(path) { let value=readJSON(path); return value?.identity == identity(path==probePath) ? value : null; }
function jobPath(id) { if (!match(id,/^[0-9]+-[0-9]+$/)) die('Invalid eUICC job'); return directory+'/euicc-job-'+id+'.json'; }
function outputPath(id) { return directory+'/euicc-output-'+id; }
function events(raw) {
  let result=[];
  for (let line in split(raw || '','\n')) {
    try { let event=json(trim(line)); if (index(['lpa','progress'],event?.type)>=0 && event.payload) push(result,event); } catch(e) {}
  }
  return result;
}
function invocation(output,trace) {
  if (!match(executable,/^\/[a-zA-Z0-9_./-]+$/)) die('Invalid LPAC executable');
  let device=index(['at','at_csim','stdio'],effectiveApdu)>=0 ? settings.at_device : settings.wdm_device;
  if (!stat(device)) die('卡片通信端口不存在');
  let environment={LPAC_APDU:effectiveApdu,LPAC_HTTP:effectiveHttp,CPE_LPAC_TRACE:trace ? '1' : '0',CPE_LPAC_TLS_VERIFY:settings.tls_verify ? '1' : '0',LPAC_APDU_AT_DEVICE:settings.at_device,
    LPAC_APDU_QMI_DEVICE:settings.wdm_device,LPAC_APDU_QMI_UIM_SLOT:''+settings.slot,
    LPAC_APDU_MBIM_DEVICE:settings.wdm_device,LPAC_APDU_MBIM_UIM_SLOT:''+settings.slot,LPAC_APDU_MBIM_USE_PROXY:'1',LPAC_APDU_MBIM_SKIP_SLOT_MAPPING:'1'};
  if (executable==native) environment.LPAC_DRIVER_HOME=driverHome;
  let bridge=effectiveApdu=='stdio' || effectiveHttp=='stdio', runner=getenv('CPE_STATUS_LPAC_RUNNER') || '/usr/libexec/cpe-status/lpac-run';
  if (bridge && (!match(runner,/^\/[a-zA-Z0-9_./-]+$/) || !stat(runner))) die('LPAC bridge未安装');
  if (bridge) environment.CPE_LPAC_OUTPUT=output;
  let result='env'; for (let k,v in environment) result+=' '+k+'='+profileQuote(v);
  return result+' '+(bridge ? profileQuote(runner)+' ' : '')+profileQuote(executable);
}
function run(args,seconds,id) {
  if (expectedConnection && connection()!=expectedConnection) die('USB连接已变化，未执行后续LPAC命令');
  if (deadline) { seconds=min(seconds,deadline-time()); if (seconds<=0) die('eUICC任务超时，请重新读取卡状态'); }
  let path=outputPath(id), expired=path+'.timeout'; unlink(expired);
  let trace=effectiveHttp=='stdio' && args[0]=='profile' && args[1]=='download';
  let cmd='/usr/bin/setsid '+invocation(path,trace)+' '+join(' ',map(args,profileQuote));
  // The packaged lpac may be a wrapper. A private process group makes timeout
  // kill its descendants too; the common AT lock remains held until cleanup.
  let rc=trim(command(cmd+' </dev/null >'+path+' 2>'+path+'.err & child=$!; (sleep '+seconds+'; touch '+expired+'; /bin/kill -TERM -"$child"; sleep 1; /bin/kill -KILL -"$child") >/dev/null 2>&1 & guard=$!; wait "$child"; rc=$?; /bin/kill -KILL -"$child" 2>/dev/null; kill "$guard" 2>/dev/null; wait "$guard" 2>/dev/null; echo "$rc"'));
  if (stat(expired)) { unlink(expired); die('LPAC 超时，子进程已结束'); }
  if ((stat(path)?.size || 0)>(trace ? 8388608 : 1048576) || (stat(path+'.err')?.size || 0)>65536) die('LPAC 输出过长');
  let list=filter(events(readfile(path)),event => event.type == 'lpa' && type(event.payload.code)=='int');
  let payload=length(list) ? list[length(list)-1].payload : null;
  if (rc != '0' || !payload || payload.code != 0) die(payload?.code==0 && rc!='0' ? 'LPAC退出异常（'+rc+'），请回读卡片状态' : payload?.message || 'LPAC 未返回成功结果');
  return payload;
}
function probe(id,force) {
  let value=cached(probePath);
  if (!force && value && time()-value.sampled_at<(value.available ? 86400 : 300)) return value;
  try {
    let before=identity();
    let info=run(['chip','info'],10,id).data;
    if (identity()!=before) die('SIM或USB连接已变化，请重新读取');
    if (!match(info?.eidValue || '',/^[0-9]{32}$/)) die('LPAC 未返回有效 EID');
    value={identity:identity(true),available:true,sampled_at:time(),data:{eid:info.eidValue,firmware_version:info.EUICCInfo2?.euiccFirmwareVer || null}};
    save(probePath,value); return value;
  } catch(e) {
    if (index(''+e,'euicc_init')<0) die(''+e);
    // A changed transport failing to initialise does not disprove the EID
    // already read on this same card. Keep settings reachable for correction.
    if (value?.available) die(''+e);
    value={identity:identity(true),available:false,sampled_at:time()}; save(probePath,value); return value;
  }
}
function profiles(id) {
  let rows=run(['profile','list'],20,id).data;
  if (type(rows)!='array') die('LPAC Profile 列表格式错误');
  for (let row in rows) if (!match(row.iccid || '',/^[0-9]{18,22}$/) || index(['enabled','disabled'],row.profileState)<0) die('LPAC Profile 数据无效');
  return rows;
}
function notifications(id) {
  let rows=run(['notification','list'],20,id).data;
  if (type(rows)!='array') die('LPAC 通知列表格式错误');
  for (let row in rows) if (type(row.seqNumber)!='int' || row.seqNumber<0 || row.seqNumber>2147483647) die('LPAC 通知序号无效');
  return rows;
}
function validate(action,body) {
  if (type(body)!='object') die('无效的 eUICC 请求');
  if (index(['enable','delete','nickname'],action)>=0 && !match(body.iccid || '',/^[0-9]{18,22}$/)) die('无效 ICCID');
  if (action=='nickname') {
    if (type(body.nickname)!='string' || match(body.nickname,/[[:cntrl:]]/) || length(body.nickname)>128) die('无效昵称');
    let count=0; for (let i=0;i<length(body.nickname);i++) if ((ord(substr(body.nickname,i,1)) & 192)!=128) count++;
    if (count>32) die('昵称最多32个字符');
  }
  if (action=='download') {
    for (let key in ['activation_code','smdp_address','matching_id','confirmation_code','imei']) if (body[key]!=null && (type(body[key])!='string' || length(body[key])>2048 || match(body[key],/[[:cntrl:]]/))) die('下载参数无效');
    if (!length(trim(body.activation_code || '')) && (!length(trim(body.smdp_address || '')) || !length(trim(body.matching_id || '')))) die('请提供激活码或 SM-DP+ 地址和匹配ID');
    if (body.imei && !match(body.imei,/^[0-9]{15}$/)) die('IMEI必须为15位数字');
  }
  if (index(['process','remove'],action)>=0 && !(body.all===true && body.seq_number==null) && !(body.all!==true && type(body.seq_number)=='int' && body.seq_number>=0 && body.seq_number<=2147483647)) die('请选择通知序号或全部通知');
  if (index(['enable','delete','nickname','download','process','remove'],action)<0) die('无效 eUICC 操作');
}
function jobReply(job,offset) {
  let value=readJSON(jobPath(job.id));
  if (!value || value.connection != connection()) return {status:'error',message:'USB连接已变化，请重新读取'};
  let queued=readJob('euicc-write');
  if (value.status=='pending' && queued?.id==job.id && queued.status=='error') return {status:'error',message:queued.message};
  let out=outputPath(job.id), raw=readfile(out) || '', stderr=readfile(out+'.err') || '';
  // The forced chip probe precedes the download and uses this same output
  // path. Do not expose it before the actual download opens its own log.
  if (value.action=='download' && value.status=='pending' && !value.output_started) { raw=''; stderr=''; }
  // Stderr may grow independently; append it only after the writer exits so
  // the stdout prefix and its byte offsets remain stable while polling.
  let output=raw+(value.status!='pending' && length(stderr) ? (length(raw) && substr(raw,-1)!='\n' ? '\n' : '')+stderr : '');
  let result={status:value.status,message:value.message,job_id:job.id,data:value.data,result:value.result,events:events(raw)};
  if (offset==null) return {...result,output:substr(output,0,65536)};
  // Bound each RPC response while allowing hex payloads to exceed 64 KiB.
  // Keep UTF-8 codepoints intact when a progress message crosses a chunk.
  let start=min(offset,length(output)), end=min(start+32768,length(output));
  while (end>start && end<length(output) && (ord(substr(output,end,1)) & 192)==128) end--;
  return {...result,output:substr(output,start,end-start),output_offset:end,output_more:end<length(output)};
}
function invalidateSim(iccid,confirmed) {
  let sim=readJSON(directory+'/sim-identity.json') || {};
  // The profile-list readback is authoritative. Clear the old IMSI so APN
  // management cannot reuse its home-network identity for this new ICCID.
  if (confirmed) {
    sim.profile_changed ||= sim.iccid != iccid;
    sim.present=true; sim.iccid=iccid; sim.imsi=''; delete sim.profile_switch_pending;
  } else sim.profile_switch_pending=iccid;
  sim.imsi_checked=0; sim.checked=0; sim.configured=false; save(directory+'/sim-identity.json',sim);
  unlink(directory+'/apn-active.json');
  let qos=readJSON(directory+'/qos.json');
  if (!confirmed || qos?.iccid!=iccid) unlink(directory+'/qos.json');
  let snapshot=readJSON(directory+'/snapshot.json');
  if (snapshot) { for (let key in ['sim','status','cells']) { snapshot.sampled[key]=0; if (snapshot.attempted) delete snapshot.attempted[key]; } save(directory+'/snapshot.json',snapshot); }
}
`;

function helper(writable: boolean) {
  return statusRuntime + qosDialRuntime + runtime + '\nconst writable=' + writable + String.raw`;
try {
  if (ARGV[0]=='activity' && !writable && length(ARGV)==1) { reply({status:'ok',data:downloadActivity()}); exit(0); }
  if (ARGV[0]=='settings') {
    if (!writable && length(ARGV)==1) { reply(settingsReply()); exit(0); }
    if (!writable || length(ARGV)!=2) die('Invalid settings request');
    let value=validateSettings(json(ARGV[1])), lock=getenv('CPE_STATUS_LOCK') || directory+'/lock';
    if (!mkdir(lock,0700)) { reply({status:'deferred',message:'卡片正在通信，请稍后保存'}); exit(0); }
    writefile(lock+'/pid',''+pid);
    try { mkdir('/etc/cpe-status',0700); save(settingsPath,value); if (cached(probePath)?.available!==true) unlink(probePath); }
    catch(e) { releaseReadLock(); die(''+e); }
    releaseReadLock(); reply({status:'ok',message:'OK',data:value}); exit(0);
  }
  // Check before cached results too: removing lpac must hide the tab even
  // when this USB session previously returned a valid EID.
  if (!installed()) { reply({status:'unsupported',available:false,installed:false,message:'lpac未安装'}); exit(0); }
  if (ARGV[0]=='job' && !writable && (length(ARGV)==2 || length(ARGV)==3)) {
    let offset=null;
    if (length(ARGV)==3) { if (!match(ARGV[2],/^[0-9]{1,8}$/) || +ARGV[2]>8454145) die('Invalid output offset'); offset=+ARGV[2]; }
    reply(jobReply({id:ARGV[1]},offset)); exit(0);
  }
  if (ARGV[0]=='result' && !writable && length(ARGV)==3) {
    let key=ARGV[1], job=readJob(key);
    if (index(['euicc-probe','euicc-info','euicc-notifications'],key)<0 || job?.id!=ARGV[2]) die('读取任务已变化，请重新读取');
    let value=cached(directory+'/'+key+'.json');
    reply(job.status=='pending' ? {status:'pending',job_id:job.id} : job.status=='error' ? {status:'error',message:job.message} : {status:'ok',data:value?.data,available:value?.available}); exit(0);
  }
  if (!supported()) { reply({status:'unsupported',available:false,message:'Not applicable'}); exit(0); }
  if (ARGV[0]=='--refresh') {
    let keys=writable ? ['euicc-write'] : ['euicc-probe','euicc-info','euicc-notifications'];
    let key=filter(keys,k => readJob(k)?.id==ARGV[1])[0];
    if (!key) exit(0);
    let job=beginRead(key,ARGV[1]); if (!job) exit(0);
    let before=identity(), request=null; expectedConnection=connection(); deadline=time()+180;
    try {
      if (!writable) {
        let chip=probe(job.id,false), data=null;
        if (chip.available) data=key=='euicc-info' ? {...chip.data,profiles:profiles(job.id)} : key=='euicc-notifications' ? notifications(job.id) : chip.data;
        if (identity()!=before) die('SIM或USB连接已变化，请重新读取');
        if (key!='euicc-probe') save(directory+'/'+key+'.json',{identity:before,available:chip.available,data});
      } else {
        // queueRead publishes the task before the short submitter writes its
        // intent; wait only for that local publication, never retry a write.
        for (let i=0;i<50;i++) { request=readJSON(jobPath(job.id)); if (request) break; sleep(10); }
        if (request?.identity!=before) die('SIM或USB连接已变化，未执行设置');
        let action=request.action, body=request.body; validate(action,body);
        delete request.body; save(jobPath(job.id),request);
        if (!probe(job.id,true).available) die('未检测到 eUICC');
        let data={}, payload=null;
        if (index(['enable','delete','nickname'],action)>=0) {
          let rows=profiles(job.id), target=filter(rows,row => row.iccid==body.iccid)[0];
          if (!target) die('Profile不存在，请重新读取');
          if (action=='delete' && target.profileState=='enabled') die('不能删除当前启用的Profile');
          if (identity()!=before) die('SIM已变化，未执行Profile写入');
          if (action=='enable') {
            // Arm DIAG before the single enable command. A SIM refresh can
            // invalidate LPAC's channel after the write has already succeeded.
            request.phase='preparing-diag'; request.target_iccid=body.iccid; save(jobPath(job.id),request);
            let capture=prepareQosProfile(body.iccid);
            invalidateSim(body.iccid,false);
            request.phase='switching'; request.qos_capture_ready=capture?.status=='ok'; save(jobPath(job.id),request);
            try { payload=run(['profile','enable',body.iccid,'1'],120,job.id); }
            catch(e) { request.command_error=''+e; }
            request.phase='confirming'; save(jobPath(job.id),request);
            let confirmed=false, readback=null;
            for (let i=0;i<4;i++) {
              sleep(2000);
              if (connection()!=expectedConnection) break;
              try {
                readback=profiles(job.id);
                if (length(filter(readback,row => row.iccid==body.iccid && row.profileState=='enabled'))) { confirmed=true; break; }
              } catch(e) { request.readback_error=''+e; }
            }
            if (!confirmed) {
              request.status='unconfirmed'; request.phase='finished'; request.submitted=true;
              request.message='判断Profile切换超时，请主动刷新页面';
              request.data={iccid:body.iccid,confirmed:false,...(readback ? {profiles:readback} : {})};
              request.result=payload; save(jobPath(job.id),request);
              unlink(directory+'/euicc-info.json'); unlink(directory+'/euicc-notifications.json');
              finishRead(job); exit(0);
            }
            data={iccid:body.iccid,profiles:readback,confirmed:true}; invalidateSim(body.iccid,true);
            if (!payload) payload={code:0,message:'profile_enabled_confirmed',data:{iccid:body.iccid}};
          } else {
            payload=run(['profile',action,body.iccid,...(action=='nickname' ? [body.nickname] : [])],120,job.id);
            rows=profiles(job.id);
            if (action=='nickname') { if (!length(filter(rows,row => row.iccid==body.iccid && (row.profileNickname || '')==body.nickname))) die('昵称回读未确认'); data={iccid:body.iccid,nickname:body.nickname}; }
            else { if (length(filter(rows,row => row.iccid==body.iccid))) die('删除回读未确认'); data={iccid:body.iccid}; }
          }
        } else if (action=='download') {
          let args=['profile','download'];
          if (length(trim(body.activation_code || ''))) push(args,'-a',trim(body.activation_code));
          else push(args,'-s',trim(body.smdp_address),'-m',trim(body.matching_id));
          for (let key,flag in {confirmation_code:'-c',imei:'-i'}) if (body[key]) push(args,flag,trim(body[key]));
          if (identity()!=before) die('SIM已变化，未执行下载');
          unlink(outputPath(job.id)); unlink(outputPath(job.id)+'.err');
          request.output_started=true; save(jobPath(job.id),request);
          payload=run(args,120,job.id); data=payload.data;
        } else {
          let rows=notifications(job.id), targets=filter(rows,row => body.all===true || row.seqNumber==body.seq_number), removed=[], failed=[], skipped=0;
          if (!body.all && !length(targets)) die('通知已不存在，请重新读取');
          for (let row in targets) {
            if (action=='remove' && index(['enable','disable'],row.profileManagementOperation)<0) {
              if (body.all) { skipped++; continue; }
              if (body.confirm_sensitive!==true) die('删除此通知需要再次确认');
            }
            try { if (identity()!=before) die('SIM已变化，未执行通知写入'); payload=run(['notification',action,''+row.seqNumber],20,job.id); if (action=='remove') push(removed,row.seqNumber); }
            catch(e) { if (action=='process') die(''+e); push(failed,{seqNumber:row.seqNumber,message:''+e}); }
          }
          data=action=='remove' ? {removed,failed,skipped} : {};
        }
        request.status='ok'; request.phase='finished'; request.message='OK'; request.data=data; request.result=payload; save(jobPath(job.id),request);
        unlink(directory+'/euicc-info.json'); unlink(directory+'/euicc-notifications.json');
      }
      finishRead(job);
    } catch(e) {
      if (request) { delete request.body; request.status='error'; request.message=''+e; save(jobPath(job.id),request); }
      finishRead(job,''+e);
    }
    exit(0);
  }
  if (!writable) {
    let action=ARGV[0] || 'probe';
    if (length(ARGV)>1 || index(['probe','info','notifications'],action)<0) die('Invalid eUICC read');
    let key='euicc-'+action, chip=cached(probePath);
    if (action=='probe' && chip && time()-chip.sampled_at<(chip.available ? 86400 : 300)) { reply({status:'ok',available:chip.available}); exit(0); }
    if (downloadActivity().active) {
      let value=cached(directory+'/'+key+'.json');
      reply(value ? {status:'ok',data:value.data,available:value.available,paused:true} : {...downloadDeferred(),available:chip?.available===true}); exit(0);
    }
    let job=queueRead(key,getenv('CPE_STATUS_EUICC_READ') || '/usr/libexec/cpe-status/euicc-read');
    let value=cached(directory+'/'+key+'.json');
    reply(job.status=='pending' ? {status:'pending',job_id:job.id,available:chip?.available===true} : job.status=='error' ? {status:'error',message:job.message,available:chip?.available===true} : {status:'ok',data:value?.data,available:value?.available});
  } else {
    if (length(ARGV)!=2) die('Invalid eUICC write');
    let action=ARGV[0], body=json(ARGV[1]); validate(action,body);
    const gate=directory+'/euicc-submit';
    if (!mkdir(gate,0700)) { let owner=+text(gate+'/pid'), info=stat(gate); if (info && time()-info.mtime>=2 && (!owner || !stat('/proc/'+owner))) { unlink(gate+'/pid'); rmdir(gate); } reply({status:'deferred',message:'eUICC操作正在提交，请稍后读取'}); exit(0); }
    writefile(gate+'/pid',''+pid);
    try {
      let current=readJob('euicc-write'), old=current ? readJSON(jobPath(current.id)) : null;
      if (current?.status=='pending') {
        if (old?.action==action && sprintf('%J',old.body)==sprintf('%J',body)) reply({status:'pending',job_id:current.id});
        else reply({status:'deferred',message:'已有eUICC操作在执行，请勿重复提交'});
      } else {
        if (downloadActivity().active) { reply(downloadDeferred()); unlink(gate+'/pid'); rmdir(gate); exit(0); }
        unlink(readPath('euicc-write'));
        let job=queueRead('euicc-write',getenv('CPE_STATUS_EUICC_CONTROL') || '/usr/libexec/cpe-status/euicc-control',action);
        save(jobPath(job.id),{identity:identity(),connection:connection(),action,body,status:'pending',id:job.id});
        reply({status:'pending',job_id:job.id});
      }
    } catch(e) { unlink(gate+'/pid'); rmdir(gate); die(''+e); }
    unlink(gate+'/pid'); rmdir(gate);
  }
} catch(e) { reply({status:'error',message:''+e}); }
`;
}

export const euiccRead = helper(false)
export const euiccControl = helper(true)
