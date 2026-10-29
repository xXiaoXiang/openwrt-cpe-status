import { statusRuntime } from './status-collector.ts'

export const apnDatabaseUrl = 'https://darthanwalt.github.io/openwrt-apn-autoconfig/providers/providers.tsv'

// Downloaded databases are an overlay; package data and per-SIM settings survive.
export const apnDatabaseRuntime = String.raw`
const apnDbRoot=getenv('CPE_STATUS_APN_DB_ROOT') || '/usr/share/cpe-status';
const apnDbPath=getenv('CPE_STATUS_APN_DATABASE') || '/etc/cpe-status/apn-database.json';
const apnDbManaged=apnDbPath+'.managed';
function dbQuote(value) { return "'"+replace(value,/'/g,"'\\''")+"'"; }
function dbHash(path) { let hash=split(trim(bounded('sha256sum '+dbQuote(path)+' 2>/dev/null',3)),/[[:space:]]+/)[0]; return match(hash || '',/^[a-f0-9]{64}$/) ? hash : ''; }
function apnOfficialEntries() {
  if (stat(apnDbPath)) {
    let value=readJSON(apnDbPath);
    if (value?.schema_version!=1 || type(value.entries)!='array' || !length(value.entries)) die('APN 数据库格式无效，已保留原文件');
    return value.entries;
  }
  return readJSON(apnDbRoot+'/apns.json') || [];
}
function apnDatabaseInfo() {
  let value=readJSON(apnDbPath) || readJSON(apnDbRoot+'/apn-database-base.json') || {};
  return {version:value.version || '内置 AOSP',count:value.count || length(value.entries || []),source:value.source || 'AOSP'};
}
function apnDatabaseModified() {
  let base=readJSON(apnDbRoot+'/apn-database-base.json');
  if (!base?.files) return true;
  for (let name,hash in base.files) {
    if (index(['apns.json','apns-conf_8.xml'],name)<0 || dbHash(apnDbRoot+'/'+name)!=hash) return true;
  }
  return stat(apnDbPath) && (!text(apnDbManaged) || dbHash(apnDbPath)!=text(apnDbManaged));
}
function compileProviders(raw) {
  if (!match(raw,/# database-format: 2(\r?\n)/)) die('远程 APN 数据库格式不支持');
  let version=match(raw,/# database-version: ([0-9]{4}\.[0-9]{2}\.[0-9]{2})(\r?\n)/)?.[1];
  if (!version) die('远程 APN 数据库缺少版本');
  let entries=[];
  // ucode compiles regex literals when evaluated; keep them out of the row loop.
  const comment=/^\s*#/, control=/[[:cntrl:]]/, plmnRule=/^[0-9]{5,6}$/,
    imsiRule=/^[0-9xX]{5,16}$/, iccidRule=/^[0-9xX]{1,22}$/, gidRule=/^[a-fA-F0-9]+$/,
    apnRule=/^[A-Za-z0-9][A-Za-z0-9.-]{0,99}$/, priorityRule=/^[0-9]{1,6}$/, carriage=/\r$/;
  function optional(value) { return index(['','-','*'],value)>=0 ? '' : value; }
  for (let line in split(raw,'\n')) {
    line=replace(line,carriage,''); if (!length(trim(line)) || match(line,comment)) continue;
    let col=split(line,'\t');
    if (length(col)!=12 || length(filter(col,value => match(value,control)))) die('远程 APN 数据库包含无效行');
    let plmn=optional(col[0]), imsi=optional(col[1]), iccid=optional(col[2]), gid=optional(col[3]), spn=optional(col[4]);
    if ((plmn && !match(plmn,plmnRule)) || (imsi && !match(imsi,imsiRule)) || (iccid && !match(iccid,iccidRule)) || (gid && !match(gid,gidRule)) || (!plmn && !imsi && !iccid && !gid && !spn)) die('远程 APN 的 SIM 匹配规则无效');
    if (!match(col[6],apnRule) || !match(col[7],priorityRule) || length(col[5])>256 || length(col[8])>128 || length(col[9])>128) die('远程 APN 参数无效');
    let auth=optional(col[10]), protocol=optional(col[11]);
    if (index(['','none','pap','chap','pap-or-chap'],auth)<0 || index(['','ipv4','ipv6','ipv4v6'],protocol)<0) die('远程 APN 协议或认证方式无效');
    push(entries,{carrier:col[5],mcc:plmn ? substr(plmn,0,3) : '*',mnc:plmn ? substr(plmn,3) : '',apn:col[6],priority:+col[7],
      ...(imsi ? {imsi_pattern:imsi} : {}),...(iccid ? {iccid_pattern:iccid} : {}),...(gid ? {gid1:gid} : {}),...(spn ? {spn} : {}),
      ...(optional(col[8]) ? {user:col[8]} : {}),...(optional(col[9]) ? {password:col[9]} : {}),
      ...(auth ? {authtype:({'none':'0','pap':'1','chap':'2','pap-or-chap':'3'})[auth]} : {}),...(protocol ? {protocol:protocol=='ipv4' ? 'IP' : uc(protocol)} : {})});
  }
  if (length(entries)<500 || length(entries)>30000) die('远程 APN 数据库条目数量异常');
  return {schema_version:1,version,source:'GNOME MBPI + AOSP',count:length(entries),entries};
}
`

export const apnDatabaseUpdater = statusRuntime + apnDatabaseRuntime + String.raw`
mkdir(directory,0700);
const self=getenv('CPE_STATUS_APN_DB_SCRIPT') || '/usr/libexec/cpe-status/apn-database';
const jobPath=directory+'/apn-database-job.json', gate=directory+'/apn-database-lock';
function reply(value) { print(sprintf('%J\n',value)); }
function status() {
  let job=readJSON(jobPath);
  if (job?.status=='pending' && (time()-job.started>100 || (job.pid && !stat('/proc/'+job.pid)))) job={status:'error',message:'APN 数据库更新任务已结束，请重试'};
  return {...(job || {status:'ok'}),data:{...apnDatabaseInfo(),...(job?.data || {})}};
}
try {
  if (ARGV[0]=='status' && length(ARGV)==1) { reply(status()); exit(0); }
  if (!match(self,/^\/[a-zA-Z0-9_./-]+$/)) die('Invalid APN updater');
  if (ARGV[0]=='update' && length(ARGV)==1) {
    if (!mkdir(gate,0700)) {
      let owner=+text(gate+'/pid'), info=stat(gate);
      if (info && time()-info.mtime>2 && (!owner || !stat('/proc/'+owner))) { unlink(gate+'/pid'); rmdir(gate); }
      else { reply(status()); exit(0); }
      if (!mkdir(gate,0700)) die('APN 更新任务正在提交');
    }
    writefile(gate+'/pid',''+pid);
    let id=time()+'-'+pid;
    save(jobPath,{status:'pending',job_id:id,started:time(),message:'正在检测 APN 数据库更新'});
    system('/usr/bin/setsid '+self+' --run '+id+' </dev/null >'+directory+'/apn-database-update.log 2>&1 &');
    reply(status()); exit(0);
  }
  if (ARGV[0]!='--run' || length(ARGV)!=2 || !match(ARGV[1],/^[0-9]+-[0-9]+$/)) die('Invalid APN update request');
  let job=readJSON(jobPath);
  if (job?.job_id!=ARGV[1] || job.status!='pending') exit(0);
  writefile(gate+'/pid',''+pid); job.pid=pid; save(jobPath,job);
  let download=directory+'/apn-providers-'+job.job_id+'.tsv';
  try {
    if (apnDatabaseModified()) {
      job.status='protected'; job.message='APN 数据库已被手动修改，已保留原文件'; job.data={modified:true};
    } else {
      const url=getenv('CPE_STATUS_APN_DB_URL') || '__APN_URL__';
      if (!match(url,/^https:\/\/[a-zA-Z0-9./_%-]+$/)) die('Invalid APN database URL');
      let result=bounded('curl --fail --silent --show-error --location --max-redirs 3 --proto =https --proto-redir =https --connect-timeout 10 --max-time 35 --max-filesize 4194304 --output '+dbQuote(download)+' '+dbQuote(url)+' && echo CPE_APN_DOWNLOADED',40);
      if (index(result,'CPE_APN_DOWNLOADED')<0 || !stat(download) || stat(download).size>4194304) die('APN 数据库下载失败，请检查网络');
      let update=compileProviders(readfile(download)), current=readJSON(apnDbPath) || readJSON(apnDbRoot+'/apn-database-base.json'), hash=dbHash(download);
      if (match(current?.version || '',/^[0-9]{4}\.[0-9]{2}\.[0-9]{2}$/) && current.version>update.version) die('远程数据库版本早于当前版本，已保留原文件');
      // Recheck after the network wait so an intervening manual edit wins.
      if (apnDatabaseModified()) { job.status='protected'; job.message='APN 数据库已被手动修改，已保留原文件'; job.data={modified:true}; }
      else if (current?.upstream_sha256==hash) { job.status='ok'; job.message='APN 数据库已是最新'; job.data={updated:false}; }
      else {
        mkdir(substr(apnDbPath,0,rindex(apnDbPath,'/')),0700);
        save(apnDbPath,{...update,upstream_sha256:hash,updated_at:time()});
        let managed=apnDbManaged+'.'+pid; writefile(managed,dbHash(apnDbPath)+'\n'); chmod(managed,0600);
        if (!rename(managed,apnDbManaged)) die('APN 数据库校验记录保存失败');
        job.status='ok'; job.message='APN 数据库已更新'; job.data={updated:true};
      }
    }
  } catch(e) { job.status='error'; job.message=''+e; }
  unlink(download); delete job.pid; job.data={...apnDatabaseInfo(),...(job.data || {})}; save(jobPath,job);
  unlink(gate+'/pid'); rmdir(gate); reply(job);
} catch(e) { reply({status:'error',message:''+e,data:apnDatabaseInfo()}); }
`.replace('__APN_URL__',apnDatabaseUrl)
