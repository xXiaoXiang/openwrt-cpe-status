// Real ucode, isolated database/files/downloader. Never queries AT or netifd.
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { apnDatabaseUpdater } from '../openwrt/apn-database.ts'
import { bundledApnDatabase } from '../data/apn-database.ts'
import { compileProviderDatabase } from '../shared/apn-database.ts'
import assert from 'node:assert/strict'
import { profileFixture } from './profile-fixture.ts'

const root='/tmp/cpe-apn-db-check-'+Date.now()
const raw=await readFile('build/apn-research/providers.tsv','utf8')
const {upstream_sha256,...bundled}=bundledApnDatabase
assert.deepEqual(compileProviderDatabase(raw),bundled)
const defaults='[{"carrier":"fixture","mcc":"454","mnc":"03","apn":"mobile.three.com.hk"}]', xml='<apns/>'
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
assert.equal(hash(raw),upstream_sha256)
const bundledJson=JSON.stringify(bundled.entries)+'\n'
const fake=String.raw`#!/usr/bin/ucode
import {readfile,writefile,stat,open} from 'fs';
const root=__ROOT__;
let f=open(root+'/fetches','a'); f.write('fetch\n'); f.close(); sleep(300);
let at=index(ARGV,'--output');
if (at<0 || !ARGV[at+1] || stat(root+'/fail')) exit(1);
writefile(ARGV[at+1],readfile(root+'/remote.tsv'));
if (stat(root+'/tamper')) writefile(root+'/persistent/database.json','user changed during download');
`.replace('__ROOT__',JSON.stringify(root))
const verify=String.raw`#!/usr/bin/ucode
import {readfile,writefile,stat,unlink,popen,glob} from 'fs';
const root=__ROOT__, helper=root+'/updater';
function value(path) { return json(readfile(root+'/'+path)); }
function call(action) { let p=popen(helper+' '+action,'r'), out=p.read('all'); p.close(); return json(out); }
function check(ok,message) { if (!ok) die(message); }
function finish() { let until=time()+25, r=call('status'); while (r.status=='pending' && time()<until) { sleep(250); r=call('status'); } check(r.status!='pending','worker did not finish'); return r; }
function fetches() { return length(split(trim(readfile(root+'/fetches') || ''),'\n')); }
check(call('status').data.source=='AOSP','bundled metadata unavailable');
let first=call('update'), repeated=call('update');
check(first.status=='pending' && first.job_id==repeated.job_id,'concurrent checks duplicated update');
let result=finish(), current=readfile(root+'/persistent/database.json');
check(result.status=='ok' && result.data.updated && result.data.count>500,'valid source not installed: '+sprintf('%J',result));
let db=value('persistent/database.json'), hk=filter(db.entries,row=>row.mcc=='454' && row.mnc=='03');
check(sprintf('%J',db.entries)==sprintf('%J',value('expected.json').entries),'build-time and runtime APN parsers differ');
check(length(hk)>1 && length(filter(hk,row=>row.apn=='mobile.three.com.hk'))>0,'multiple home APNs lost');
check(readfile(root+'/persistent/overrides.json')=='PRESERVE_CUSTOM' && readfile(root+'/base/apns.json')=='__DEFAULTS__\n','update changed custom or package data');
call('update'); result=finish(); check(result.status=='ok' && !result.data.updated && readfile(root+'/persistent/database.json')==current,'same source rewrote database');
writefile(root+'/remote.tsv','<html>failed download</html>'); call('update'); result=finish();
check(result.status=='error' && readfile(root+'/persistent/database.json')==current,'malformed download replaced database');
writefile(root+'/remote.tsv',readfile(root+'/valid.tsv')); writefile(root+'/fail','1'); call('update'); result=finish();
check(result.status=='error' && readfile(root+'/persistent/database.json')==current,'failed download replaced database'); unlink(root+'/fail');
writefile(root+'/remote.tsv',replace(readfile(root+'/valid.tsv'),/# database-version: [0-9.]+/,'# database-version: 2000.01.01'));
call('update'); result=finish(); check(result.status=='error' && readfile(root+'/persistent/database.json')==current,'database silently downgraded');
writefile(root+'/remote.tsv',readfile(root+'/valid.tsv')); writefile(root+'/persistent/database.json',current+' '); let before=fetches();
call('update'); result=finish(); check(result.status=='protected' && fetches()==before && readfile(root+'/persistent/database.json')==current+' ','edited installed database overwritten');
writefile(root+'/persistent/database.json',current); writefile(root+'/base/apns.json','[]'); before=fetches();
call('update'); result=finish(); check(result.status=='protected' && fetches()==before,'edited bundled database overwritten');
writefile(root+'/base/apns.json','__DEFAULTS__\n'); writefile(root+'/tamper','1'); call('update'); result=finish();
check(result.status=='protected' && readfile(root+'/persistent/database.json')=='user changed during download','download race overwrote user edit');
unlink(root+'/tamper'); unlink(root+'/persistent/database.json'); unlink(root+'/persistent/database.json.managed');
writefile(root+'/base/apns.json',readfile(root+'/bundled.json'));
writefile(root+'/base/apn-database-base.json',readfile(root+'/bundled-base.json'));
call('update'); result=finish();
check(result.status=='ok' && !result.data.updated && !stat(root+'/persistent/database.json') && result.data.count==db.count,'fresh package did not recognize its current bundled database');
writefile(root+'/remote.tsv',replace(readfile(root+'/valid.tsv'),/# database-version: [0-9.]+/,'# database-version: 2000.01.01'));
call('update'); result=finish(); check(result.status=='error' && !stat(root+'/persistent/database.json'),'bundled database silently downgraded');
check(!stat(root+'/cache/apn-database-lock') && !length(glob(root+'/cache/apn-providers-*')),'update lock or download leaked');
print(sprintf('%J\n',{passed:16,entries:db.count,version:db.version,build_runtime_parser_parity:true,current_bundle_recognized:true,duplicate_requests_coalesced:true,custom_and_package_preserved:true,edited_database_protected:true,failed_download_retained:true,downgrade_rejected:true,manual_edit_during_download_preserved:true,no_modem_operations:true}));
`.replace('__ROOT__',JSON.stringify(root)).replaceAll('__DEFAULTS__',defaults.replaceAll("'","\\'"))
// The heredoc appends one newline; preserve the upstream TSV's exact bytes/hash.
assert.ok(raw.endsWith('\n'))
const files:Record<string,string>={updater:apnDatabaseUpdater,'bin/curl':fake,verify,'valid.tsv':raw.slice(0,-1),'remote.tsv':raw.slice(0,-1),
  'expected.json':JSON.stringify(bundled),'bundled.json':bundledJson.trimEnd(),
  'bundled-base.json':JSON.stringify({...bundled,entries:undefined,upstream_sha256,files:{'apns.json':hash(bundledJson),'apns-conf_8.xml':hash(xml+'\n')}}),
  'base/apns.json':defaults,'base/apns-conf_8.xml':xml,'base/apn-database-base.json':JSON.stringify({version:'fixture',source:'AOSP',count:1,files:{'apns.json':hash(defaults),'apns-conf_8.xml':hash(xml)}}),
  'persistent/overrides.json':'PRESERVE_CUSTOM','config.json':'{"device":"/dev/ttyUSB2","networkInterface":"wwan"}'}
const script=[profileFixture(root),'set -eu',`mkdir -p ${root}/base ${root}/persistent ${root}/cache ${root}/bin`,
  ...Object.entries(files).map(([name,content])=>`cat >${root}/${name} <<'CPE_APN_DB_EOF'\n${content}\nCPE_APN_DB_EOF`),
  // Hashes refer to the exact bytes including the heredoc newline.
  `ucode -e 'import {readfile,writefile,popen} from "fs"; let b=json(readfile("${root}/base/apn-database-base.json")); for (let name in ["apns.json","apns-conf_8.xml"]) {let p=popen("sha256sum ${root}/base/"+name,"r"); b.files[name]=split(p.read("all")," ")[0];p.close();}writefile("${root}/base/apn-database-base.json",sprintf("%J",b));'`,
  `chmod 700 ${root}/updater ${root}/bin/curl`, `ucode -c -o /dev/null ${root}/updater`,
  `export CPE_STATUS_CACHE=${root}/cache CPE_STATUS_CONFIG=${root}/config.json CPE_STATUS_APN_DB_ROOT=${root}/base CPE_STATUS_APN_DATABASE=${root}/persistent/database.json CPE_STATUS_APN_DB_SCRIPT=${root}/updater PATH=${root}/bin:"$PATH"`,
  // Remove the fixture newline once; all integrity checks use these bytes.
  `ucode -e 'import {readfile,writefile} from "fs";writefile("${root}/persistent/overrides.json","PRESERVE_CUSTOM");'`,
  `ucode ${root}/verify`,
  `find ${root} -type f -exec rm -f {} \\;`, `find ${root} -depth -type d -exec rmdir {} \\;`,
].join('\n')+'\n'
try { console.log(execFileSync('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=8','-o','UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts',process.env.CPE_ROUTER || 'root@192.168.6.248','sh -s'],{input:script,encoding:'utf8',windowsHide:true,timeout:90_000})) }
catch(error) { console.error('Isolated fixture retained at '+root); throw error }
