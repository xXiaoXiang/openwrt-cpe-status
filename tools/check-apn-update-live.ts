// Database updates never submit an APN save or a modem command.
import { execFileSync } from 'node:child_process'
import { mkdir,readFile,writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const router=process.env.CPE_ROUTER || 'root@192.168.6.248'
const ssh=(script:string)=>execFileSync('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=8','-o','UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts',router,'sh -s'],{input:script+'\n',encoding:'utf8',windowsHide:true,timeout:20_000})
const path='build/router-audit/apn-update-baseline.json'
const snapshot=()=>JSON.parse(ssh(String.raw`ucode - <<'CPE_APN_AUDIT'
import {readfile,popen} from 'fs';
function run(cmd) { let p=popen(cmd,'r'), out=trim(p.read('all') || '');p.close();return out; }
function read(path) {try{return json(readfile(path));}catch(e){return null;}}
let job=read('/tmp/cpe-status/read-euicc-write.json');
print(sprintf('%J\n',{wwan:run('uci show network.wwan | sha256sum'),
  custom:run('sha256sum /etc/cpe-status/apn-overrides.json 2>/dev/null'),
  local:run('sha256sum /etc/cpe-status/apns.local.json 2>/dev/null'),
  activity:json(run('/usr/libexec/cpe-status/euicc-read activity')).data,
  euicc_write_pending:job?.status=='pending',
  version:run('apk list --installed luci-app-cpe-status')}));
CPE_APN_AUDIT`)) as {wwan:string;custom:string;local:string;activity:{active:boolean};euicc_write_pending:boolean;version:string}
await mkdir('build/router-audit',{recursive:true})
if (process.argv[2]==='before') {
  const before=snapshot(); assert.equal(before.activity.active,false,'eUICC download active'); assert.equal(before.euicc_write_pending,false,'eUICC operation active')
  await writeFile(path,JSON.stringify(before,null,2)); console.log(JSON.stringify({baseline_recorded:true,version:before.version}));
} else {
  const before=JSON.parse(await readFile(path,'utf8')) as ReturnType<typeof snapshot>
  if (process.argv[2]==='update') {
    let result=JSON.parse(ssh('/usr/libexec/cpe-status/apn-database update'))
    const until=Date.now()+100_000
    while (result.status==='pending' && Date.now()<until) {await new Promise(done=>setTimeout(done,1000));result=JSON.parse(ssh('/usr/libexec/cpe-status/apn-database status'))}
    await writeFile('build/router-audit/apn-database-update.json',JSON.stringify(result,null,2))
    console.log(JSON.stringify({database:result}))
    assert.equal(result.status,'ok','live database update failed')
  }
  const after=snapshot()
  for (const key of ['wwan','custom','local'] as const) assert.equal(after[key],before[key],key+' unexpectedly changed during upgrade/database update')
  const status=JSON.parse(ssh('/usr/libexec/cpe-status/apn'))
  assert.ok(status.data && Array.isArray(status.data.choices),'APN catalog missing')
  assert.ok(status.data.choices.some((row:{source:string})=>row.source==='database'),'matching database APNs missing')
  console.log(JSON.stringify({version:after.version,current_apn:status.data.settings.apn,choices:status.data.choices.map((row:{source:string;settings:{apn:string;pdptype:string}})=>({source:row.source,apn:row.settings.apn,protocol:row.settings.pdptype})),database:status.data.database,wwan_unchanged:true,custom_history_unchanged:true,local_extensions_unchanged:true}))
}
