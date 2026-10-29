// Actual card verification is strictly chip info / profile list. Transport
// settings and caches are isolated; all reads share the production modem lock.
import { execFileSync } from 'node:child_process'
import { euiccBridge } from '../openwrt/euicc-bridge.ts'
const root = '/tmp/cpe-stdio-readonly-' + Date.now()
const verify = String.raw`#!/usr/bin/ucode
import {popen,writefile,readfile,unlink,mkdir} from 'fs';
const root=__ROOT__;
function check(value,message) { if (!value) die(message); }
function call(args) {
  let p=popen('/usr/libexec/cpe-status/euicc-read '+args,'r'), raw=p.read('all'); p.close(); return json(raw);
}
for (let apdu in ['uqmi','stdio']) {
  writefile(root+'/settings.json',sprintf('%J',{apdu,http:'stdio',at_device:'/dev/ttyUSB2',wdm_device:'/dev/cdc-wdm0',slot:1}));
  unlink(root+'/cache/euicc-probe.json'); unlink(root+'/cache/read-euicc-info.json');
  let result=call('info'), id=result.job_id, until=time()+80;
  while (result.status=='pending' && time()<until) { sleep(100); result=call('result euicc-info '+id); }
  check(result.status=='ok' && result.available && match(result.data?.eid || '',/^[0-9]{32}$/) && type(result.data.profiles)=='array',apdu+' STDIO read failed: '+sprintf('%J',result));
  print(sprintf('%J\n',{read_only:true,apdu,http:'stdio',eid_suffix:substr(result.data.eid,-6),profiles:map(result.data.profiles,p=>({name:p.profileName || p.serviceProviderName,state:p.profileState}))}));
}
// Public HTTPS GET only, no ES9+ session or profile operation.
mkdir(root+'/http',0700);
writefile(root+'/http.in',sprintf('%J\n',{type:'http',payload:{url:'https://example.com/',tx:'',headers:[]}}));
check(system('LPAC_HTTP=stdio LPAC_APDU=uqmi '+root+'/bridge '+root+'/http '+root+'/events <'+root+'/http.in >'+root+'/http.out')==0,'HTTPS bridge process failed');
let response=json(readfile(root+'/http.out'));
check(response.payload.rcode==200 && length(response.payload.rx)>0,'Verified HTTPS GET failed');
print(sprintf('%J\n',{read_only:true,https_bridge:true,status:response.payload.rcode}));
// This endpoint uses a Symantec RSP Test CA absent from the system CA bundle.
// GET / only: no activation code, ES9+ session, or profile download is sent.
writefile(root+'/http.in',sprintf('%J\n',{type:'http',payload:{url:'https://prod.smdp-plus.rsp.goog/',tx:'',headers:[]}}));
check(system('CPE_LPAC_TLS_VERIFY=1 LPAC_HTTP=stdio LPAC_APDU=uqmi '+root+'/bridge '+root+'/http '+root+'/events <'+root+'/http.in >'+root+'/http.out')==0,'Strict TLS relay failed to exit');
response=json(readfile(root+'/http.out'));
check(response.payload.rcode==0,'Untrusted test CA accepted without explicit opt-out');
check(system('CPE_LPAC_TLS_VERIFY=0 LPAC_HTTP=stdio LPAC_APDU=uqmi '+root+'/bridge '+root+'/http '+root+'/events <'+root+'/http.in >'+root+'/http.out')==0,'Test-server HTTPS relay process failed');
response=json(readfile(root+'/http.out'));
check(response.payload.rcode>=200 && response.payload.rcode<600,'Explicit test-server TLS setting failed');
print(sprintf('%J\n',{read_only:true,test_server_get:true,strict_tls_rejected:true,explicit_tls_opt_out_status:response.payload.rcode}));
`.replace('__ROOT__', JSON.stringify(root))
const script = ['set -eu', 'umask 077', `mkdir -p ${root}/cache`,
  `cat > ${root}/verify <<'CPE_STDIO_READ_EOF'\n${verify}\nCPE_STDIO_READ_EOF`,
  `cat > ${root}/bridge <<'CPE_STDIO_BRIDGE_EOF'\n${euiccBridge}\nCPE_STDIO_BRIDGE_EOF`, `chmod +x ${root}/bridge`,
  `export CPE_STATUS_EUICC_SETTINGS=${root}/settings.json CPE_STATUS_CACHE=${root}/cache CPE_STATUS_LOCK=/tmp/cpe-status/lock`,
  `export CPE_STATUS_EUICC_BRIDGE=${root}/bridge`,
  `ucode ${root}/verify`,
  `find ${root} -type f -exec rm -f {} \\;`, `find ${root} -depth -type d -exec rmdir {} \\;`,
].join('\n')
try { console.log(execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts', process.env.CPE_ROUTER || 'root@192.168.6.248', 'sh -s'], { input: script + '\n', encoding: 'utf8', windowsHide: true, timeout: 120_000 })) }
catch (error) { console.error('Read-only fixture retained at ' + root); throw error }
