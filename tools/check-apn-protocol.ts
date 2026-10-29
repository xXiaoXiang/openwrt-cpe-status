// Runs real ucode with private UCI/netifd/log fixtures. No live modem writes.
import { execFileSync } from 'node:child_process'
import { statusRuntime } from '../openwrt/status-collector.ts'
import { apnRuntime } from '../openwrt/apn-control.ts'
import { apnRecoveryRuntime } from '../openwrt/apn-protocol.ts'
import { profileFixture } from './profile-fixture.ts'

const root = '/tmp/cpe-protocol-check-' + Date.now()
const fake = String.raw`#!/usr/bin/ucode
import {readfile,writefile} from 'fs';
const root=getenv('CPE_PROTOCOL_TEST'), path=root+'/network.json', kind=ARGV[0], args=slice(ARGV,1);
let state=json(readfile(path));
function store() {writefile(path,sprintf('%J',state));}
if (kind=='uci') {
  if (args[0]=='-q' && args[1]=='get') {if(index(args[2],'network.wwan.')!=0)die('INTERFACE VIOLATION');print(state.uci[substr(args[2],13)] || '');}
  else if(args[0]=='set') {let pair=split(args[1],'=');if(index(pair[0],'network.wwan.')!=0)die('INTERFACE VIOLATION');state.uci[substr(pair[0],13)]=join('=',slice(pair,1));store();}
  else if(args[0]!='commit' || args[1]!='network') die('INVALID COMMIT');
} else if(kind=='ubus') {
  if(index(args,'log')>=0) {if(state.log_unavailable)exit(1); print(sprintf('%J',{log:state.logs}));}
  else {
    let net={interface:'wwan',proto:'qmi',up:state.up,pending:state.pending,l3_device:'wwan0'};
    print(sprintf('%J',index(args,'dump')>=0 ? {interface:[net,{interface:'wwan_4',up:state.up,'ipv4-address':state.ipv4 ? [{address:state.ipv4,mask:24}] : []}]} : net));
  }
} else if(kind=='ifup' || kind=='ifdown') {
  if(args[0]!='wwan')die('INTERFACE VIOLATION');
  state.up=false; state.pending=kind=='ifup'; push(state.calls,kind+' wwan'); store();
} else if(kind=='sms_tool') {if(args[length(args)-1]!='AT+CGMM')die('UNEXPECTED AT');print('RM500Q-GL\n');}
else die('UNEXPECTED COMMAND');
`
const verify = statusRuntime + apnRuntime + String.raw`
const root=getenv('CPE_PROTOCOL_TEST');
function quote(value) {return apnQuote(value);}
function report(status,message,extra) {save(directory+'/report.json',{status,message,...(extra || {})});}
function net(action) {bounded(action+' wwan',3);}
` + apnRecoveryRuntime + String.raw`
const sim={present:true,configured:true,checked:time(),iccid:'8985203130000000001',imsi:'454031234567890',mncLength:2};
const target={apn:'mobile.lte.three.com.hk',pdptype:'ipv4v6',auth:'chap',username:'fixture-user',password:'fixture-secret'};
function check(value,message) {if(!value)die(message);}
function state() {return readJSON(root+'/network.json');}
function store(value) {save(root+'/network.json',value);}
function reset() {
  store({uci:{proto:'qmi',...target,auto:'0',modes:'lte,5gnr',plmn:'0'},up:false,pending:true,calls:[],logs:[{id:1,time:(time()-20)*1000,msg:'netifd: wwan (123): Unable to connect IPv6'}]});
  save(apnOverridePath,{});save(apnProtocolPath,{schema_version:1,rules:{}});
  save(directory+'/sim-identity.json',sim);unlink(apnRecoveryWatch);unlink(directory+'/user-data.json');
  apnRecoveryTick(sim);
}
function log(message,age) {let s=state();push(s.logs,{id:length(s.logs)+1,time:(time()-(age || 0))*1000,msg:message});store(s);}
function failure() {log('netifd: wwan (456): Unable to connect IPv6');}
function checkDialed() {check(sprintf('%J',state().calls)==sprintf('%J',['ifdown wwan','ifup wwan']),'trial not dialed exactly once');}
if (ARGV[0]=='persisted') {
  print(sprintf('%J',apnProtocolApply(target,{...sim,iccid:'8985203130000000002',mcc:'460',mnc:'00'},false)));exit(0);
}
reset();apnRecoveryTick(sim);
check(state().uci.pdptype=='ipv4v6' && !length(state().calls),'historical log triggered fallback');
log('netifd: wan (456): Unable to connect IPv6'); log('netifd: wwan_6 (456): Unable to connect IPv6');
log('netifd: wwan (456): Unable to connect IPv4'); log('netifd: wwan (456): Unable to connect IPv6',120);
apnRecoveryTick(sim);check(!length(state().calls),'unrelated or stale log triggered fallback');
failure();mkdir(directory+'/lock',0700);writefile(directory+'/lock/pid',''+pid);
apnRecoveryTick(sim);check(!length(state().calls),'busy control lock ignored');unlink(directory+'/lock/pid');rmdir(directory+'/lock');
apnRecoveryTick(sim);checkDialed();
check(state().uci.pdptype=='ipv4' && state().uci.apn==target.apn && state().uci.auth==target.auth && state().uci.password==target.password,'fallback changed non-protocol settings');
check(state().uci.modes=='lte,5gnr' && state().uci.plmn=='0','network mode/operator changed');
check(!length(keys(apnProtocolStore().rules)) && apnProtocolStore().trial,'unverified rule was published');
apnRecoveryTick(sim);checkDialed();check(!length(keys(readJSON(apnOverridePath))),'fallback wrote user custom settings');
let s=state();s.up=true;s.pending=false;s.ipv4='10.0.0.2';s.log_unavailable=true;store(s);
apnRecoveryTick(sim);
let rules=apnProtocolStore();
check(rules.rules['454-03-mobile.lte.three.com.hk']?.pdptype=='ipv4' && !rules.trial,'successful IPv4 trial not confirmed');
check(index(sprintf('%J',rules.rules),sim.iccid)<0 && index(sprintf('%J',rules),'fixture-secret')<0,'shared rule contains subscriber credentials');
let p=popen(root+'/verify persisted','r'), persisted=json(p.read('all'));p.close();
check(persisted.pdptype=='ipv4' && persisted.auth==target.auth && persisted.password==target.password,'persisted rule not reused by another process/SIM');
check(apnProtocolApply(target,sim,true).pdptype=='ipv4v6','custom protocol lost highest priority');
check(apnProtocolApply({...target,apn:'another.apn'},sim,false).pdptype=='ipv4v6','another APN was changed');
check(apnProtocolApply(target,{...sim,imsi:'454001234567890'},false).pdptype=='ipv4v6','another home operator was changed');
check(apnProtocolApply(target,{...sim,mncLength:null},false).pdptype=='ipv4v6','ambiguous MNC was guessed');

reset();save(apnOverridePath,{[sim.iccid]:target});failure();apnRecoveryTick(sim);
check(!length(state().calls) && !apnProtocolStore().trial,'custom APN auto-downgraded');
check(readJSON(apnOverridePath)[sim.iccid].pdptype=='ipv4v6','custom protocol overwritten');
reset();save(directory+'/user-data.json',{enabled:false});failure();apnRecoveryTick(sim);
check(!length(state().calls),'disabled data was dialed');
reset();failure();s=state();s.up=true;s.pending=false;store(s);apnRecoveryTick(sim);
check(!length(state().calls),'working connection was downgraded');
s=state();s.up=false;s.pending=true;store(s);apnRecoveryTick(sim);check(!length(state().calls),'old IPv6 error reused after working connection');

reset();failure();apnRecoveryTick(sim);checkDialed();
rules=apnProtocolStore();rules.trial.started_at=time()-91;save(apnProtocolPath,rules);
apnRecoveryTick(sim);
check(state().uci.pdptype=='ipv4v6' && !length(keys(apnProtocolStore().rules)) && !apnProtocolStore().trial,'failed IPv4 trial was not rolled back');
check(length(state().calls)==4,'rollback did not redial only wwan');
failure();apnRecoveryTick(sim);check(length(state().calls)==4,'rollback backoff was lost when protocol context changed');

reset();failure();apnRecoveryTick(sim);rules=apnProtocolStore();rules.trial.boot_id='previous-boot';rules.trial.started_at=1;save(apnProtocolPath,rules);
apnRecoveryTick(sim);check(state().uci.pdptype=='ipv4' && apnProtocolStore().trial.started_at>1,'reboot did not resume pending trial');
save(apnOverridePath,{[sim.iccid]:target});apnRecoveryTick(sim);check(!apnProtocolStore().trial,'pending trial not cancelled by user override');
check(readJSON(apnOverridePath)[sim.iccid].pdptype=='ipv4v6','trial cancellation changed user setting');
check(index(readfile(directory+'/apn-protocol-log.json') || '',target.password)<0,'protocol log exposed password');
print(sprintf('%J\n',{stale_logs_ignored:true,wwan_only:true,control_lock_respected:true,ipv4_confirmed_before_rule:true,shared_across_sims_and_processes:true,custom_highest_priority:true,only_protocol_changed:true,rollback_and_backoff:true,pending_trial_resumes_after_reboot:true,protocol_recovery_has_no_diag_dependency:true,no_live_network_changes:true}));
`
const files: Record<string, string> = { fake, verify, 'config.json': JSON.stringify({ device: '/dev/ttyUSB2', networkInterface: 'wwan' }) }
const script = [
  'set -eu', `test_root=${root}`, 'trap \'rm -rf "$test_root"\' EXIT', profileFixture(root),
  `mkdir -p ${root}/cache ${root}/persistent ${root}/bin`,
  ...Object.entries(files).map(([name, content]) => `cat >${root}/${name} <<'CPE_PROTOCOL_EOF'\n${content}\nCPE_PROTOCOL_EOF`),
  ...['uci', 'ubus', 'ifup', 'ifdown', 'sms_tool'].map(name => `printf '#!/bin/sh\nexec ${root}/fake ${name} "$@"\n' >${root}/bin/${name}`),
  `chmod 700 ${root}/fake ${root}/verify ${root}/bin/*`,
  `export CPE_PROTOCOL_TEST=${root} CPE_STATUS_CONFIG=${root}/config.json CPE_STATUS_CACHE=${root}/cache CPE_STATUS_APN_OVERRIDES=${root}/persistent/overrides.json CPE_STATUS_APN_PROTOCOL=${root}/persistent/dualstack_toone.json PATH=${root}/bin:"$PATH"`,
  `ucode -c -o /dev/null ${root}/verify`, `${root}/verify`,
].join('\n') + '\n'
console.log(execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts', process.env.CPE_ROUTER || 'root@192.168.6.248', 'sh -s'], { input: script, encoding: 'utf8', windowsHide: true, timeout: 45_000 }))
