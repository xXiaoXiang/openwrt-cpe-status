import { statusRuntime } from './status-collector.ts'
import { apnDatabaseRuntime } from './apn-database.ts'
import { apnProtocolRuntime } from './apn-protocol.ts'

export const apnRuntime = apnDatabaseRuntime + String.raw`
const apnOverridePath = getenv('CPE_STATUS_APN_OVERRIDES') || '/etc/cpe-status/apn-overrides.json';
function apnQuote(value) { return "'" + replace(value, /'/g, "'\\''") + "'"; }
function apnUci(key) { return trim(bounded('uci -q get network.wwan.' + key, 3)); }
function apnValidate(value) {
  if (type(value) != 'object' || type(value.apn) != 'string' || length(value.apn) > 100 || !match(value.apn, /^[A-Za-z0-9][A-Za-z0-9.-]*$/)) die('APN 名称格式无效');
  if (index(['ipv4','ipv6','ipv4v6'], value.pdptype) < 0 || index(['none','pap','chap','both'], value.auth) < 0) die('IP 协议或认证方式无效');
  for (let key in ['username','password']) if (type(value[key]) != 'string' || length(value[key]) > 128 || match(value[key], /[[:cntrl:]]/)) die('用户名或密码格式无效');
  return { apn: value.apn, pdptype: value.pdptype, auth: value.auth, username: value.username, password: value.password };
}
function apnSettings() {
  if (iface != 'wwan' || index(['qmi','mbim'], apnUci('proto')) < 0) die('APN 配置仅允许管理已有的 wwan QMI/MBIM 接口');
  let pdptype = apnUci('pdptype');
  return { apn: apnUci('apn'), pdptype: pdptype == 'ip' ? 'ipv4' : pdptype || 'ipv4', auth: apnUci('auth') || 'none', username: apnUci('username'), password: apnUci('password') };
}
function apnUsbToken() {
  let root=getenv('CPE_STATUS_SYSFS') || '/sys', path=realpath(root+'/class/tty/'+substr(port,5)+'/device') || '';
  while (length(path)>length(root)) {
    if (stat(path+'/idVendor')) return (+text(path+'/busnum'))+':'+(+text(path+'/devnum'))+':'+text(path+'/serial');
    let end=rindex(path,'/'); if (end<0) break; path=substr(path,0,end);
  }
  return '';
}
function apnActiveIdentity() {
  let sim=readJSON(directory+'/sim-identity.json'), settings=apnSettings();
  return join('|',[profileKey,apnUsbToken(),sim?.present===false ? 'absent' : sim?.iccid || 'unknown',sim?.profile_switch_pending || '',lc(settings.apn),settings.pdptype]);
}
function apnIdentityPending() {
  let sim=readJSON(directory+'/sim-identity.json'), usb=apnUsbToken();
  return config.autoApn!==false && (sim?.present===false || sim?.profile_switch_pending || sim?.configured===false || (sim?.usb_token && usb && sim.usb_token!=usb));
}
function apnCachedActive() {
  let value=readJSON(directory+'/apn-active.json');
  return !apnIdentityPending() && value?.device==port && value.identity==apnActiveIdentity() ? value : null;
}
function apnEqual(a,b) { return a && b && lc(a.apn)==lc(b.apn) && a.pdptype==b.pdptype && a.auth==b.auth && a.username==b.username && a.password==b.password; }
function apnCustomRows(record) {
  let rows=[];
  for (let value in [...(record?.custom_apn || []),...(record?.apn ? [record] : [])]) {
    let settings=apnValidate(value);
    if (!length(filter(rows,row => apnEqual(row,settings)))) push(rows,settings);
  }
  return rows;
}
function apnRemember(iccid,target) {
  if (!match(iccid || '',/^[0-9]{18,22}$/)) die('无效 ICCID');
  let all=readJSON(apnOverridePath);
  if (stat(apnOverridePath) && type(all)!='object') die('自定义 APN 文件格式无效，已保留原文件');
  all ||= {};
  let rows=apnCustomRows(all[iccid]);
  if (!length(filter(rows,row => apnEqual(row,target)))) push(rows,target);
  all[iccid]={...target,custom_apn:rows}; save(apnOverridePath,all);
}
function apnForget(iccid,target) {
  if (!match(iccid || '',/^[0-9]{18,22}$/)) die('无效 ICCID');
  let all=readJSON(apnOverridePath);
  if (stat(apnOverridePath) && type(all)!='object') die('自定义 APN 文件格式无效，已保留原文件');
  let record=all ? all[iccid] : null;
  if (!record) return false;
  let previous=apnCustomRows(record), rows=filter(previous,row => !apnEqual(row,target));
  if (length(rows)==length(previous)) return false;
  if (!length(rows)) delete all[iccid];
  else all[iccid]={...record,...(apnEqual(record,target) ? rows[0] : apnValidate(record)),custom_apn:rows};
  save(apnOverridePath,all); return true;
}
function apnDigitMatch(value,pattern) {
  if (!value || length(value)<length(pattern)) return false;
  for (let i=0;i<length(pattern);i++) if (index(['x','X',substr(value,i,1)],substr(pattern,i,1))<0) return false;
  return true;
}
function apnSpecific(row) { return !!(row.mvno_type || row.imsi_pattern || row.iccid_pattern || row.gid1 || row.spn); }
function apnCandidates(entries,sim) {
  if (!match(sim?.imsi || '',/^[0-9]{14,16}$/)) return [];
  let result=[], lengths={};
  for (let row in entries) {
    if (row.mcc!='*' && (index(sim.imsi,row.mcc+row.mnc)!=0 || (sim.mncLength && length(row.mnc)!=sim.mncLength))) continue;
    if (row.mcc!='*') lengths[length(row.mnc)]=true;
    if (row.mcc=='*' && !apnSpecific(row)) continue;
    if (row.imsi_pattern && !apnDigitMatch(sim.imsi,row.imsi_pattern) || row.iccid_pattern && !apnDigitMatch(sim.iccid,row.iccid_pattern)) continue;
    if (row.gid1 && (!sim.gid || index(lc(sim.gid),lc(row.gid1))!=0) || row.spn && lc(sim.spn || '')!=lc(row.spn)) continue;
    let pattern=row.mvno_match_data || '', accepted=false;
    if (!row.mvno_type) accepted=true;
    else if (lc(row.mvno_type)=='imsi') accepted=length(pattern) && apnDigitMatch(sim.imsi,pattern);
    else if (lc(row.mvno_type)=='iccid') { for (let prefix in split(pattern,',')) if (length(prefix) && index(sim.iccid || '',prefix)==0) accepted=true; }
    else if (lc(row.mvno_type)=='gid') accepted=length(pattern) && sim.gid && index(lc(sim.gid),lc(pattern))==0;
    else if (lc(row.mvno_type)=='spn') accepted=length(pattern) && lc(sim.spn || '')==lc(pattern);
    if (accepted) push(result,row);
  }
  if (length(keys(lengths))>1) return [];
  return sort(result,(a,b) => (+apnSpecific(b))-(+apnSpecific(a)) || (a.priority ?? 100)-(b.priority ?? 100));
}
` + apnProtocolRuntime + String.raw`
function apnCatalog() {
  let sim=readJSON(directory+'/sim-identity.json'), current=apnSettings(), choices=[];
  function add(settings,source,carrier) {
    if (!length(filter(choices,item => apnEqual(item.settings,settings)))) push(choices,{id:source+':'+length(choices),source,carrier:carrier || '',settings});
  }
  let record=sim?.iccid ? (readJSON(apnOverridePath) || {})[sim.iccid] : null;
  for (let row in apnCustomRows(record)) add(row,'custom','自定义');
  let local=readJSON('/etc/cpe-status/apns.local.json');
  for (let source in ['local','database']) for (let row in apnCandidates(source=='local' ? local?.apns || [] : apnOfficialEntries(),sim)) {
    let protocol=uc(row.protocol || 'IP'), username=row.user || '', password=row.password || '';
    try { add(apnProtocolApply(apnValidate({apn:row.apn,pdptype:protocol=='IPV6' ? 'ipv6' : protocol=='IPV4V6' ? 'ipv4v6' : 'ipv4',
      auth:!length(username) && !length(password) ? 'none' : ({'1':'pap','2':'chap','3':'both'})[row.authtype] || 'none',username,password}),sim,false),source,row.carrier); } catch(e) {}
  }
  return {iccid:sim?.iccid || '',choices,preferred:record?.apn ? apnValidate(record) : current,database:apnDatabaseInfo(),protocol_fallback:apnProtocolInfo(sim,current)};
}
function apnActive(raw) {
  let preferred = apnUci('apn'), contexts = [];
  let active = {};
  for (let row in profileParse('contextsActive', raw)) if (row.active) active[row.cid] = true;
  // Firmware may retain an active CID with an empty CGDCONT APN after a
  // profile switch. It has no APN to report or match to the configured WWAN.
  for (let row in profileParse('contexts', raw)) if (active[row.cid] && row.apn) push(contexts, { active: true, active_apn: row.apn, active_protocol: row.protocol, sampled_at: time() });
  for (let context in contexts) if (lc(context.active_apn) == lc(preferred)) return context;
  if (!preferred && length(contexts) == 1) return contexts[0];
  return { active: false, sampled_at: time() };
}
function apnSaveActive(raw,identity) {
  if (!apnIdentityPending() && identity==apnActiveIdentity()) save(directory+'/apn-active.json',{device:port,identity,...apnActive(raw)});
}
`

// Reads UCI and a cached PDP snapshot; explicit refresh schedules one locked AT
// query. Job polling never sends another modem query or restarts an interface.
export const apnReader = statusRuntime + apnRuntime + String.raw`
mkdir(directory, 0700);
const self = getenv('CPE_STATUS_APN_SCRIPT') || '/usr/libexec/cpe-status/apn';
if (!match(self, /^\/[a-zA-Z0-9_./-]+$/)) die('Invalid APN executable');
if (length(ARGV) > 2 || (length(ARGV) && index(['refresh','--refresh'], ARGV[0]) < 0) || (length(ARGV) == 2 && ARGV[0] != '--refresh')) die('Invalid APN read arguments');
try {
  let settings = apnSettings();
  if (profile && (!profileHas('contexts') || !profileHas('contextsActive'))) {
    print(sprintf('%J\n', { status: 'ok', data: { settings, ...apnCatalog(), active_supported: false, logs: [], sampled_at: time() }, refreshing: false })); exit(0);
  }
  if (ARGV[0] == '--refresh') {
    let task = beginRead('apn', ARGV[1]);
    if (!task) exit(0);
    try {
      if (apnIdentityPending()) { finishRead(task); exit(0); }
      let identity=apnActiveIdentity();
      let raw = bounded('sms_tool -d ' + port + ' at ' + apnQuote(profileBatch(['contexts','contextsActive'])), 5);
      profileParse('contexts', raw); profileParse('contextsActive', raw);
      apnSaveActive(raw,identity);
      finishRead(task);
    } catch(e) { finishRead(task, '' + e); }
    exit(0);
  }
  let pending=apnIdentityPending(), cached=apnCachedActive();
  let task = !pending && (ARGV[0] == 'refresh' || !cached || (!cached.active && time()-cached.sampled_at>=5)) ? queueRead('apn', self) : readJob('apn');
  let job = readJSON(directory + '/apn-job.json');
  if (job?.device != port || job?.interface != iface) job = null;
  let progress=readProgress(task), net=null;
  if (!cached?.active) try { net=json(bounded('ubus -S call network.interface.wwan status 2>/dev/null',2)); } catch(e) {}
  print(sprintf('%J\n', { status: task?.status == 'error' && !pending ? 'error' : 'ok', message: pending ? '' : task?.message || '', data: { settings, ...apnCatalog(), ...(cached || { active: false }), logs: [...(job?.logs || []),...(readJSON(directory+'/apn-protocol-log.json')?.logs || [])] }, ...progress,refreshing:pending || progress.refreshing || (!cached?.active && net?.pending===true) }));
} catch(e) { print(sprintf('%J\n', { status: 'error', message: '' + e })); }
`
