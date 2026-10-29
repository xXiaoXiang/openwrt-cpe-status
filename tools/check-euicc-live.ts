// Read-only verification: never invokes the eUICC control helper.
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'

const script = String.raw`ucode - <<'CPE_EUICC_READONLY_EOF'
import {popen,readfile} from 'fs';
function check(value,message) { if (!value) die(message); }
function read(params) {
  let request=sprintf('%J',{command:'/usr/libexec/cpe-status/euicc-read',params});
  let process=popen("ubus -S call file exec '"+request+"'",'r');
  let result=json(process.read('all')); process.close();
  check(result.code==0 && result.stdout,'file.exec failed'); return json(result.stdout);
}
function wait(kind) {
  let result=read([kind]), until=time()+80;
  while (result.status=='pending' && time()<until) { sleep(250); result=read(['result','euicc-'+kind,result.job_id]); }
  check(result.status=='ok' && result.available,kind+' failed: '+sprintf('%J',result)); return result;
}
wait('probe');
let result=wait('info'), data=result.data;
check(match(data.eid || '',/^[0-9]{32}$/) && type(data.profiles)=='array','Invalid chip/profile result');
let acl=json(readfile('/usr/share/rpcd/acl.d/luci-app-cpe-status.json'))['luci-app-cpe-status'];
check(acl.read.file['/usr/libexec/cpe-status/euicc-read'][0]=='exec','Missing read ACL');
check(!acl.read.file['/usr/libexec/cpe-status/euicc-control'] && acl.write.file['/usr/libexec/cpe-status/euicc-control'][0]=='exec','Write ACL not isolated');
let view=readfile('/www/luci-static/resources/view/modem/cpe-status.js');
check(view && index(view,"['短信', '/sms'], ['eUICC', '/euicc']")>=0,'LuCI tab missing or out of order');
print(sprintf('%J\n',{read_only:true,eid_suffix:substr(data.eid,-6),firmware:data.firmware_version,profiles:map(data.profiles,p=>({name:p.profileName || p.serviceProviderName,state:p.profileState})),acl_verified:true}));
CPE_EUICC_READONLY_EOF
`
const output = execFileSync('ssh', ['-o','BatchMode=yes','-o','ConnectTimeout=8','-o','UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts',process.env.CPE_ROUTER || 'root@192.168.2.248','sh -s'], { input:script, encoding:'utf8',windowsHide:true,timeout:90_000 })
await mkdir('build/router-audit',{recursive:true})
await writeFile('build/router-audit/euicc-readonly.json',output)
console.log(output)
