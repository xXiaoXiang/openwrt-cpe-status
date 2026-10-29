// Read-only switch/QoS diagnosis. Never invokes LPAC writes or changes RF/data.
import { execFileSync } from 'node:child_process'

const script = String.raw`ucode - <<'CPE_SWITCH_AUDIT_EOF'
import {readfile,popen} from 'fs';
const dir='/tmp/cpe-status';
function read(path) { try { return json(readfile(path)); } catch(e) { return null; } }
function suffix(value) { return value ? substr(value,-6) : null; }
let task=read(dir+'/read-euicc-write.json'), id=task?.id;
let job=id && match(id,/^[0-9]+-[0-9]+$/) ? read(dir+'/euicc-job-'+id+'.json') : null;
let raw=id ? readfile(dir+'/euicc-output-'+id) || '' : '', events=[];
for (let line in split(raw,'\n')) {
  try { let item=json(line); if (item?.type=='lpa') push(events,{code:item.payload?.code,message:item.payload?.message}); } catch(e) {}
}
let sim=read(dir+'/sim-identity.json'), qos=read(dir+'/qos.json'), state=read(dir+'/qos-state.json'), request=read(dir+'/qos-request.json');
let module=null;
if (!(task?.operation=='download' && task.status=='pending') && match(state?.serial || '',/^[a-zA-Z0-9_.:-]{1,64}$/)) {
  module={};
  for (let name in ['status','cleanup','result']) {
    let stream=popen('/usr/bin/adb -s '+state.serial+' shell cat /tmp/cpe-status-qos/'+name+'.json 2>/dev/null','r');
    try { module[name]=json(stream.read('all')); } catch(e) { module[name]=null; }
    stream.close();
  }
}
print(sprintf('%J\n',{
  job:{operation:task?.operation,status:job?.status,message:job?.message,phase:job?.phase,last_lpac:events},
  sim:{iccid_suffix:suffix(sim?.iccid),configured:sim?.configured,checked:sim?.checked,apn:sim?.apn},
  request:{id:request?.id,target_suffix:suffix(request?.target_iccid)},
  capture:{status:state?.status,run_id:state?.run_id,request_id:state?.request_id,target_suffix:suffix(state?.target_iccid),started:state?.started,checked:state?.checked,reason:state?.reason,frame_count:state?.frame_count,mask_restored:state?.mask_restored},
  cached:{iccid_suffix:suffix(qos?.iccid),run_id:qos?.run_id,sampled_at:qos?.sampled_at,apn:qos?.apn,data:qos?.data},module
}));
CPE_SWITCH_AUDIT_EOF
`
console.log(execFileSync('ssh', ['-o','BatchMode=yes','-o','ConnectTimeout=8','-o','UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts',process.env.CPE_ROUTER || 'root@192.168.6.248','sh -s'], {input:script,encoding:'utf8',windowsHide:true,timeout:20_000}))
