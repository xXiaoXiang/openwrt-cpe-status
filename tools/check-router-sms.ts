import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { messaging } from '../openwrt/messaging.ts'
import { profileFixture, profileFingerprint } from './profile-fixture.ts'

// All commands, including deletion, use /tmp fixtures. Never real serial I/O.
const root = '/tmp/cpe-sms-check-' + process.pid
const first = { index:0,sender:'#Notice',timestamp:'2026-10-26T12:53:44Z',content:'notification' }
const part = { index:1,sender:'#Service',timestamp:'2026-10-27T13:28:50Z',content:'first',reference:28,part:1,total:2 }
const second = { ...part,index:2,content:'second',part:2 }
const rows = [
  ...['8985000000000000001','unknown','8985000000000000002'].map(sim=>({msg:first,sim})),
  {msg:part,sim:'8985000000000000002'},{msg:second,sim:'8985000000000000002'},
  {msg:first,sim:'8985000000000000003'},{msg:part,sim:'8985000000000000003'},{msg:second,sim:'8985000000000000003'},
].map(({msg,sim},index)=>({id:index+1,key:sim+':ME:'+msg.index+':'+msg.sender+':'+msg.timestamp+':'+msg.content,direction:'incoming',phone_number:msg.sender,timestamp:msg.timestamp,content:msg.content,status:'received',sim,...('reference' in msg && 'part' in msg && 'total' in msg ? {reference:msg.reference,part:msg.part,total:msg.total} : {})}))
const legacy = {next:9,records:rows,seen:rows.map(row=>row.key)}
const fake = String.raw`#!/usr/bin/ucode
import {readfile,writefile} from 'fs';
let root=getenv('CPE_SMS_FIXTURE'),file=root+'/state.json',s=json(readfile(file)),kind=ARGV[0],args=slice(ARGV,1);
let cmd=kind=='gcom' ? getenv('CPE_OPERATOR_COMMAND') : args[length(args)-1];
push(s.calls,{kind,cmd});
function done(value) {writefile(file,sprintf('%J',s));print(value);exit(0);}
if (kind=='sms_tool') {
  if(cmd=='recv') {let i=index(args,'-s');s.selected=args[i+1];done(sprintf('%J',{msg:s.memories[s.selected]}));}
  if(cmd=='AT+QCCID') done('+QCCID: '+s.iccid+'\n');
  if(cmd=='AT+CGMM') done('RM500Q-GL\n');
} else if(kind=='gcom') {
  let select=match(cmd,/^AT\+CPMS="(ME|SM)"$/),del=match(cmd,/^AT\+CMGD=([0-9]+),0$/);
  if(select) {s.selected=select[1];done('+CPMS: 3,255,0,255,0,255\nOK\n');}
  if(del) {
    if(s.fail_delete) done('+CMS ERROR: 500\n');
    s.memories[s.selected]=filter(s.memories[s.selected],row=>row.index!=+del[1]);done('OK\n');
  }
}
die('Unexpected fixture command: '+kind+' '+cmd);
`
const state = { iccid:'8985000000000000003',memories:{ME:[first,part,second],SM:[]},selected:'ME',calls:[] }
const executable = messaging.replace('!stat(port)',`!stat('${root}/present')`).replace('(tmp|var|proc|sys|dev|www|rom)','(var|proc|sys|dev|www|rom)')
const edit = (source: string) => `ucode -e 'import {readfile,writefile} from "fs";let f="${root}/state.json",s=json(readfile(f));${source};writefile(f,sprintf("%J",s));'`
const sim = (iccid: string) => `printf '%s' '${JSON.stringify({present:true,iccid,profile_key:profileFingerprint()})}' >${root}/cache/sim-identity.json`
const cached = `printf '%s' '${JSON.stringify({time:Math.floor(Date.now()/1000),profile_key:profileFingerprint()})}' >${root}/cache/sms-sync.json`
const cleanup = (name: string) => [
  `echo '>>> ${name}-start'; ${root}/messaging cleanup-start`,
  `for n in $(seq 1 100); do test -f ${root}/cache/sms-cleanup.json && ! grep -q 'pending' ${root}/cache/sms-cleanup.json && break; ucode -e 'sleep(100);'; done`,
  `echo '>>> ${name}'; ${root}/messaging cleanup-status`,
]
const script = [profileFixture(root),'set -eu',`mkdir -p ${root}/bin ${root}/cache ${root}/sms; touch ${root}/present`,
  ...Object.entries({messaging:executable,fake}).flatMap(([name,content],i)=>[`cat >${root}/${name} <<'CPE_SMS_${i}'`,content,`CPE_SMS_${i}`,`chmod 700 ${root}/${name}`,`ucode -c -o /dev/null ${root}/${name}`]),
  ...['sms_tool','gcom'].flatMap(name=>[`printf '#!/bin/sh\nexec ${root}/fake ${name} "$@"\n' >${root}/bin/${name}`,`chmod 700 ${root}/bin/${name}`]),
  `export CPE_SMS_FIXTURE=${root} CPE_STATUS_CACHE=${root}/cache CPE_STATUS_CONFIG=${root}/config.json CPE_STATUS_MESSAGING_SCRIPT=${root}/messaging`,
  `export PATH=${root}/bin:"$PATH"`,
  `printf '%s' '${JSON.stringify(state)}' >${root}/state.json`,
  `printf '%s' '${JSON.stringify({device:'/dev/ttyUSB2',smsStorage:root+'/sms'})}' >${root}/config.json`,
  `printf '%s' '${JSON.stringify(legacy)}' >${root}/sms/cpe-sms-history.json`,sim(state.iccid),cached,
  `echo '>>> migrated'; ${root}/messaging list`,
  `echo '>>> backup'; cat ${root}/sms/cpe-sms-history.pre-v2.json; echo`,
  edit('for(let row in s.memories.ME) row.index+=10'),sim('8985000000000000004'),
  `echo '>>> reinsert'; ${root}/messaging sync`,
  edit('s.iccid='+JSON.stringify('8985000000000000004')),
  ...cleanup('unread'),
  `echo '>>> read'; ${root}/messaging read '[1,4,5]'`,
  edit(`push(s.memories.ME,${JSON.stringify({...first,index:99,timestamp:'2026-10-28T12:53:44Z'})})`),
  `echo '>>> new'; ${root}/messaging sync`,
  `echo '>>> invalid-ids'; ${root}/messaging read '[-1]'`,
  `echo '>>> storage'; ${root}/messaging storage-check`,
  edit('s.iccid='+JSON.stringify('8985000000000000004')),
  ...cleanup('cleaned'),
  `echo '>>> retained'; ${root}/messaging list`,
  `echo '>>> modem'; cat ${root}/state.json; echo`,
  sim('8985000000000000009'),...cleanup('sim-changed'),
  sim('8985000000000000004'),
  edit('s.memories.SM='+JSON.stringify([{index:1,sender:'#SIM',timestamp:'2026-10-28T00:00:00Z',content:'sim-only'}])),
  `echo '>>> sm-first'; ${root}/messaging sync`,
  edit('s.memories.SM[0].index=9'),
  `echo '>>> sm-reindex'; ${root}/messaging sync`,
  sim('8985000000000000005'),`echo '>>> sm-other-sim'; ${root}/messaging sync`,
  `echo '>>> clear'; ${root}/messaging clear`,
  `echo '>>> cleared-resync'; ${root}/messaging sync`,
  `echo '>>> done'`,
].join('\n')+'\n'
const output = execFileSync('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=8','-o','UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts',process.env.CPE_ROUTER || 'root@192.168.6.248','sh -s'],{input:script,encoding:'utf8',timeout:90000,windowsHide:true})
await mkdir('build/sms-check',{recursive:true}); await writeFile('build/sms-check/router-fixture.txt',output)
const section = (name: string) => output.split('>>> '+name+'\n')[1]?.split('>>> ')[0].trim()
const result = (name: string) => JSON.parse(section(name)!)
assert.equal(result('migrated').data.length,3)
assert.deepEqual(result('backup'),legacy,'original archive backup')
assert.equal(result('reinsert').data.length,3,'SIM/slot changes duplicated ME SMS')
assert.equal(result('unread').data.deleted,0,'deleted unread SMS')
assert.equal(result('read').data.filter((row:{status:string})=>row.status==='read').length,3)
assert.equal(result('new').data.length,4,'same content with a different timestamp was lost')
assert.equal(result('invalid-ids').status,'error')
assert.equal(result('storage').data.unread,1)
assert.equal(result('cleaned').status,'ok',section('cleaned'))
assert.equal(result('cleaned').data.deleted,3)
assert.equal(result('retained').data.length,4,'cleanup removed router history')
assert.equal(result('modem').memories.ME.length,1,'cleanup deleted an unread record')
assert.equal(result('modem').calls.filter((row:{cmd:string})=>row.cmd.startsWith('AT+CMGD=')).length,3)
assert.equal(result('sim-changed').status,'error')
assert.equal(result('sm-first').data.length,5)
assert.equal(result('sm-reindex').data.length,5)
assert.equal(result('sm-other-sim').data.length,6,'distinct SIM-owned messages were merged')
assert.equal(result('cleared-resync').data.length,0,'cleared history reappeared')
console.log('SMS fixture passed: legacy backup/dedup, reinsertion/reindex, read flags, SM isolation, indexed cleanup, live SIM guard and retained history. Real SMS untouched.')
